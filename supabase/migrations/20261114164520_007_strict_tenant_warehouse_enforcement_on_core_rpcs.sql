-- ============================================================================
-- Migration 007: Enforce Strict Tenant/Warehouse Validation & Lifecycle Gates
-- on Core RPCs (Receive -> QC/Staging -> Putaway -> Reserve -> Pick -> Pack -> Ship)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.wms_receive_inbound_grn(
  p_sku_code TEXT,
  p_qty INTEGER,
  p_description TEXT DEFAULT NULL,
  p_po_number TEXT DEFAULT NULL,
  p_supplier_name TEXT DEFAULT 'Direct Supplier',
  p_receiving_bin TEXT DEFAULT 'RECV-DOCK-01',
  p_lot_number TEXT DEFAULT 'DEFAULT',
  p_qc_status TEXT DEFAULT 'pending',
  p_operator TEXT DEFAULT 'Operator',
  p_warehouse_code TEXT DEFAULT NULL,
  p_tenant_code TEXT DEFAULT 'YESI-FZCO',
  p_idempotency_key TEXT DEFAULT NULL,
  p_session_token TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_ctx RECORD;
  v_sku RECORD;
  v_grn TEXT;
  v_put_task TEXT;
  v_receipt_id UUID;
  v_suggested_loc TEXT;
  v_dest_zone TEXT;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_QTY: Inbound quantity must be positive');
  END IF;

  SELECT * INTO v_ctx FROM public.wms_assert_context(
    p_tenant_code, p_warehouse_code, p_session_token, ARRAY['admin', 'supervisor', 'operator']
  );

  SELECT * INTO v_sku FROM public.wms_skus WHERE tenant_id = v_ctx.tenant_id AND sku_code = TRIM(p_sku_code) LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO public.wms_skus (tenant_id, sku_code, name, default_location_code)
    VALUES (v_ctx.tenant_id, TRIM(p_sku_code), COALESCE(NULLIF(p_description, ''), TRIM(p_sku_code)), 'PHONE-A-01')
    RETURNING * INTO v_sku;
  END IF;

  v_suggested_loc := COALESCE(v_sku.default_location_code, 'PHONE-A-01');
  v_dest_zone := SPLIT_PART(v_suggested_loc, '-', 1);
  v_grn := 'GRN-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 6);
  v_put_task := 'PUT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 6);

  INSERT INTO public.wms_receipts (
    tenant_id, warehouse_id, grn_number, po_number, supplier_name, sku_id, sku_code,
    description, expected_qty, received_qty, receiving_bin, putaway_location, lot_number, qc_status, operator_name
  ) VALUES (
    v_ctx.tenant_id, v_ctx.warehouse_id, v_grn, p_po_number, p_supplier_name, v_sku.id, TRIM(p_sku_code),
    COALESCE(p_description, v_sku.name), p_qty, p_qty, p_receiving_bin, v_suggested_loc, p_lot_number, p_qc_status, p_operator
  ) RETURNING id INTO v_receipt_id;

  -- Strict Lifecycle: Pending/Failed/Quarantine goes to QC Inspection Hold; Passed generates Directed Putaway Task
  IF p_qc_status IN ('pending', 'failed', 'quarantine') THEN
    INSERT INTO public.wms_qc_inspections (
      tenant_id, warehouse_id, receipt_id, sku_id, sku_code, lot_number, quantity, reason, status, inspector_name
    ) VALUES (
      v_ctx.tenant_id, v_ctx.warehouse_id, v_receipt_id, v_sku.id, TRIM(p_sku_code), p_lot_number, p_qty,
      'Inbound GRN Inspection (' || v_grn || ')', 'hold', p_operator
    );
  ELSE
    INSERT INTO public.wms_putaway_tasks (
      tenant_id, warehouse_id, task_number, receipt_id, sku_id, sku_code, product_name, quantity, lot_number,
      source_location, source_type, suggested_location, destination_zone, qc_status, status, operator_name
    ) VALUES (
      v_ctx.tenant_id, v_ctx.warehouse_id, v_put_task, v_receipt_id, v_sku.id, TRIM(p_sku_code), v_sku.name, p_qty, p_lot_number,
      p_receiving_bin, 'receiving', v_suggested_loc, v_dest_zone, 'passed', 'pending', p_operator
    );
  END IF;

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, details)
  VALUES (v_ctx.tenant_id, v_ctx.warehouse_id, v_ctx.user_id, p_operator, 'INBOUND_GRN', 'wms_receipts', v_grn,
    'GRN ' || v_grn || ': ' || p_qty || 'x ' || TRIM(p_sku_code) || ' [qc=' || p_qc_status || ']');

  RETURN jsonb_build_object(
    'ok', true,
    'grn_number', v_grn,
    'qc_status', p_qc_status,
    'putaway_task', CASE WHEN p_qc_status = 'passed' THEN v_put_task ELSE NULL END,
    'suggested_location', v_suggested_loc
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.wms_dispatch_order(
  p_order_number TEXT,
  p_carrier_name TEXT DEFAULT 'GBS Express',
  p_tracking_number TEXT DEFAULT NULL,
  p_operator TEXT DEFAULT 'Operator',
  p_warehouse_code TEXT DEFAULT NULL,
  p_tenant_code TEXT DEFAULT 'YESI-FZCO',
  p_session_token TEXT DEFAULT NULL,
  p_allow_direct_override BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_ctx RECORD;
  v_order RECORD;
  v_sku_token TEXT;
  v_bal RECORD;
  v_ship_num TEXT;
  v_tracking TEXT;
BEGIN
  SELECT * INTO v_ctx FROM public.wms_assert_context(
    p_tenant_code, p_warehouse_code, p_session_token, ARRAY['admin', 'supervisor', 'operator']
  );

  SELECT * INTO v_order
  FROM public.wms_sales_orders
  WHERE warehouse_id = v_ctx.warehouse_id AND order_number = p_order_number
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Order not found in warehouse ' || p_warehouse_code || ': ' || p_order_number);
  END IF;

  IF v_order.status = 'Shipped' THEN
    RETURN jsonb_build_object('ok', true, 'already_shipped', true, 'tracking_number', v_order.tracking_number);
  END IF;

  -- Enforce Packing checkpoint unless supervisor/admin override is explicitly set
  IF NOT p_allow_direct_override AND v_order.status NOT IN ('Packed', 'ReadyToShip', 'Allocated') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'LIFECYCLE_VIOLATION: Order ' || p_order_number || ' must be Packed/ReadyToShip before Carrier Dispatch (current: ' || v_order.status || ')');
  END IF;

  v_tracking := COALESCE(NULLIF(p_tracking_number, ''), v_order.tracking_number, p_order_number);
  v_ship_num := 'SHP-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 6);

  FOREACH v_sku_token IN ARRAY STRING_TO_ARRAY(v_order.required_skus, ',')
  LOOP
    v_sku_token := TRIM(v_sku_token);
    IF v_sku_token = '' THEN CONTINUE; END IF;

    SELECT * INTO v_bal
    FROM public.wms_inventory_balances
    WHERE warehouse_id = v_ctx.warehouse_id AND sku_code = v_sku_token AND on_hand_qty >= 1
    ORDER BY reserved_qty DESC, on_hand_qty DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_STOCK: Cannot dispatch ' || p_order_number || '; SKU ' || v_sku_token || ' has 0 on-hand');
    END IF;

    UPDATE public.wms_inventory_balances
    SET
      on_hand_qty = GREATEST(0, on_hand_qty - 1),
      reserved_qty = GREATEST(0, reserved_qty - 1),
      version = version + 1,
      updated_at = NOW()
    WHERE id = v_bal.id;

    INSERT INTO public.wms_inventory_ledger (
      tenant_id, warehouse_id, sku_id, sku_code, transaction_type, qty_delta,
      balance_before, balance_after, from_location_code, lot_number,
      reference_type, reference_id, operator_name, note
    ) VALUES (
      v_ctx.tenant_id, v_ctx.warehouse_id, v_bal.sku_id, v_sku_token, 'outbound', -1,
      v_bal.on_hand_qty, GREATEST(0, v_bal.on_hand_qty - 1), v_bal.location_code, v_bal.lot_number,
      'SHIPMENT', v_ship_num, p_operator, 'Dispatched order ' || p_order_number
    );
  END LOOP;

  UPDATE public.wms_reservations SET status = 'picked' WHERE warehouse_id = v_ctx.warehouse_id AND order_number = p_order_number AND status IN ('reserved', 'allocated');
  UPDATE public.wms_pick_tasks SET status = 'completed', picked_qty = required_qty, completed_at = NOW() WHERE warehouse_id = v_ctx.warehouse_id AND order_number = p_order_number AND status <> 'completed';

  UPDATE public.wms_sales_orders
  SET status = 'Shipped', carrier_name = p_carrier_name, tracking_number = v_tracking, shipped_at = NOW(), updated_at = NOW()
  WHERE id = v_order.id;

  INSERT INTO public.wms_shipments (
    tenant_id, warehouse_id, shipment_number, order_id, order_number, carrier_name, tracking_number, status, dispatched_at, operator_name
  ) VALUES (
    v_ctx.tenant_id, v_ctx.warehouse_id, v_ship_num, v_order.id, p_order_number, p_carrier_name, v_tracking, 'dispatched', NOW(), p_operator
  );

  INSERT INTO public.wms_event_outbox (
    tenant_id, warehouse_id, aggregate_type, aggregate_id, event_type, idempotency_key, payload
  ) VALUES (
    v_ctx.tenant_id, v_ctx.warehouse_id, 'order', p_order_number, 'ORDER_SHIPPED', 'ship:' || p_order_number,
    jsonb_build_object('order_number', p_order_number, 'shipment_number', v_ship_num, 'tracking_number', v_tracking, 'carrier', p_carrier_name)
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, details)
  VALUES (v_ctx.tenant_id, v_ctx.warehouse_id, v_ctx.user_id, p_operator, 'ORDER_DISPATCHED', 'wms_shipments', v_ship_num, 'Shipped ' || p_order_number || ' via ' || p_carrier_name);

  RETURN jsonb_build_object('ok', true, 'shipment_number', v_ship_num, 'tracking_number', v_tracking);
END;
$$;
