-- =============================================================================
-- YESI-WMS Modern Fulfillment WMS Schema
-- Migration 004: Security (RLS + Bcrypt Auth), ACID Transactional RPCs, Realtime & Storage
-- =============================================================================

-- 1. Secure Authentication RPC using pgcrypto bcrypt (no plaintext passwords!)
CREATE OR REPLACE FUNCTION public.wms_authenticate_user(
  p_username TEXT,
  p_password TEXT,
  p_tenant_code TEXT DEFAULT 'YESI-FZCO'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user RECORD;
BEGIN
  SELECT
    u.id,
    u.tenant_id,
    u.default_warehouse_id,
    u.username,
    u.email,
    u.display_name,
    u.role,
    u.skill_level,
    u.current_zone,
    u.password_hash,
    u.is_active,
    t.code AS tenant_code,
    w.code AS warehouse_code,
    w.name AS warehouse_name
  INTO v_user
  FROM public.wms_users u
  JOIN public.wms_tenants t ON t.id = u.tenant_id
  LEFT JOIN public.wms_warehouses w ON w.id = u.default_warehouse_id
  WHERE LOWER(u.username) = LOWER(TRIM(p_username))
    AND t.code = p_tenant_code
  LIMIT 1;

  IF NOT FOUND OR NOT v_user.is_active THEN
    RETURN jsonb_build_object('authenticated', false, 'error', 'Invalid credentials or inactive operator');
  END IF;

  IF v_user.password_hash <> crypt(p_password, v_user.password_hash) THEN
    INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, operator_name, action, entity_type, details)
    VALUES (v_user.tenant_id, v_user.default_warehouse_id, p_username, 'LOGIN_FAILED', 'wms_users', 'Failed password verification');
    RETURN jsonb_build_object('authenticated', false, 'error', 'Invalid credentials');
  END IF;

  UPDATE public.wms_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = v_user.id;

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, details)
  VALUES (v_user.tenant_id, v_user.default_warehouse_id, v_user.id, v_user.display_name, 'LOGIN_SUCCESS', 'wms_users', v_user.id::text, 'Authenticated via PostgreSQL pgcrypto');

  RETURN jsonb_build_object(
    'authenticated', true,
    'user', jsonb_build_object(
      'id', v_user.id,
      'tenantId', v_user.tenant_id,
      'tenantCode', v_user.tenant_code,
      'warehouseId', v_user.default_warehouse_id,
      'warehouseCode', COALESCE(v_user.warehouse_code, 'DXB-FC1'),
      'warehouseName', COALESCE(v_user.warehouse_name, 'Dubai Fulfillment Center 1'),
      'username', v_user.username,
      'email', v_user.email,
      'displayName', v_user.display_name,
      'role', v_user.role,
      'skillLevel', v_user.skill_level,
      'currentZone', v_user.current_zone
    )
  );
END;
$$;

-- 2. Secure User Upsert RPC (hashes password server-side with bcrypt)
CREATE OR REPLACE FUNCTION public.wms_upsert_user_secure(
  p_username TEXT,
  p_display_name TEXT,
  p_role TEXT,
  p_password TEXT DEFAULT NULL,
  p_operator TEXT DEFAULT 'Admin',
  p_tenant_code TEXT DEFAULT 'YESI-FZCO'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_tenant_id UUID;
  v_wh_id UUID;
  v_user_id UUID;
BEGIN
  SELECT id INTO v_tenant_id FROM public.wms_tenants WHERE code = p_tenant_code LIMIT 1;
  SELECT id INTO v_wh_id FROM public.wms_warehouses WHERE tenant_id = v_tenant_id AND is_default = true LIMIT 1;

  SELECT id INTO v_user_id FROM public.wms_users WHERE tenant_id = v_tenant_id AND LOWER(username) = LOWER(TRIM(p_username));

  IF v_user_id IS NULL THEN
    IF p_password IS NULL OR LENGTH(TRIM(p_password)) < 4 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Password must be at least 4 characters');
    END IF;
    INSERT INTO public.wms_users (tenant_id, default_warehouse_id, username, display_name, password_hash, role)
    VALUES (v_tenant_id, v_wh_id, TRIM(p_username), COALESCE(NULLIF(TRIM(p_display_name), ''), TRIM(p_username)), crypt(p_password, gen_salt('bf', 10)), p_role)
    RETURNING id INTO v_user_id;

    INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, operator_name, action, entity_type, entity_id, details)
    VALUES (v_tenant_id, v_wh_id, p_operator, 'USER_CREATE', 'wms_users', v_user_id::text, 'Created user ' || p_username || ' (' || p_role || ')');
  ELSE
    UPDATE public.wms_users
    SET
      display_name = COALESCE(NULLIF(TRIM(p_display_name), ''), display_name),
      role = COALESCE(p_role, role),
      password_hash = CASE WHEN p_password IS NOT NULL AND LENGTH(TRIM(p_password)) >= 4 THEN crypt(p_password, gen_salt('bf', 10)) ELSE password_hash END,
      updated_at = NOW()
    WHERE id = v_user_id;

    INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, operator_name, action, entity_type, entity_id, details)
    VALUES (v_tenant_id, v_wh_id, p_operator, 'USER_UPDATE', 'wms_users', v_user_id::text, 'Updated user ' || p_username);
  END IF;

  RETURN jsonb_build_object('ok', true, 'user_id', v_user_id);
END;
$$;

-- 3. ACID Transactional Inventory Movement RPC (row-level FOR UPDATE lock + immutable ledger + outbox)
CREATE OR REPLACE FUNCTION public.wms_record_stock_movement(
  p_sku_code TEXT,
  p_qty_delta INTEGER,
  p_transaction_type TEXT,
  p_location_code TEXT DEFAULT 'PHONE-A-01',
  p_lot_number TEXT DEFAULT 'DEFAULT',
  p_reference_type TEXT DEFAULT NULL,
  p_reference_id TEXT DEFAULT NULL,
  p_operator TEXT DEFAULT 'System',
  p_note TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_warehouse_code TEXT DEFAULT 'DXB-FC1'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wh RECORD;
  v_sku RECORD;
  v_loc_id UUID;
  v_bal RECORD;
  v_before INTEGER := 0;
  v_after INTEGER := 0;
  v_ledger_id UUID;
BEGIN
  -- Idempotency guard for offline-to-cloud replay safety
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, balance_after INTO v_ledger_id, v_after
    FROM public.wms_inventory_ledger
    WHERE idempotency_key = p_idempotency_key
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'deduplicated', true, 'ledger_id', v_ledger_id, 'balance_after', v_after);
    END IF;
  END IF;

  SELECT id, tenant_id INTO v_wh FROM public.wms_warehouses WHERE code = p_warehouse_code LIMIT 1;
  IF NOT FOUND THEN
    SELECT id, tenant_id INTO v_wh FROM public.wms_warehouses WHERE is_default = true LIMIT 1;
  END IF;

  SELECT id, sku_code, name INTO v_sku FROM public.wms_skus WHERE tenant_id = v_wh.tenant_id AND sku_code = p_sku_code LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO public.wms_skus (tenant_id, sku_code, name, default_location_code)
    VALUES (v_wh.tenant_id, p_sku_code, p_sku_code, p_location_code)
    RETURNING id, sku_code, name INTO v_sku;
  END IF;

  SELECT id INTO v_loc_id FROM public.wms_locations WHERE warehouse_id = v_wh.id AND location_code = p_location_code LIMIT 1;

  -- Lock balance row FOR UPDATE to prevent concurrent lost updates
  SELECT * INTO v_bal
  FROM public.wms_inventory_balances
  WHERE warehouse_id = v_wh.id
    AND sku_code = p_sku_code
    AND location_code = p_location_code
    AND lot_number = COALESCE(NULLIF(p_lot_number, ''), 'DEFAULT')
  FOR UPDATE;

  IF NOT FOUND THEN
    v_before := 0;
    v_after := GREATEST(0, p_qty_delta);
    INSERT INTO public.wms_inventory_balances (
      tenant_id, warehouse_id, sku_id, location_id, sku_code, location_code, lot_number, on_hand_qty, version
    ) VALUES (
      v_wh.tenant_id, v_wh.id, v_sku.id, v_loc_id, p_sku_code, p_location_code, COALESCE(NULLIF(p_lot_number, ''), 'DEFAULT'), v_after, 1
    );
  ELSE
    v_before := v_bal.on_hand_qty;
    v_after := v_before + p_qty_delta;
    IF v_after < 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Insufficient on-hand stock for ' || p_sku_code || ' (have ' || v_before || ', delta ' || p_qty_delta || ')');
    END IF;
    UPDATE public.wms_inventory_balances
    SET on_hand_qty = v_after, version = version + 1, updated_at = NOW()
    WHERE id = v_bal.id;
  END IF;

  INSERT INTO public.wms_inventory_ledger (
    tenant_id, warehouse_id, sku_id, sku_code, transaction_type, qty_delta,
    balance_before, balance_after,
    from_location_code, to_location_code, lot_number,
    reference_type, reference_id, idempotency_key, operator_name, note
  ) VALUES (
    v_wh.tenant_id, v_wh.id, v_sku.id, p_sku_code, p_transaction_type, p_qty_delta,
    v_before, v_after,
    CASE WHEN p_qty_delta < 0 THEN p_location_code ELSE NULL END,
    CASE WHEN p_qty_delta >= 0 THEN p_location_code ELSE NULL END,
    COALESCE(NULLIF(p_lot_number, ''), 'DEFAULT'),
    p_reference_type, p_reference_id, p_idempotency_key, p_operator, p_note
  ) RETURNING id INTO v_ledger_id;

  -- Emit transactional outbox event for real-time ERP / Marketplace sync
  INSERT INTO public.wms_event_outbox (
    tenant_id, warehouse_id, aggregate_type, aggregate_id, event_type, idempotency_key, payload
  ) VALUES (
    v_wh.tenant_id, v_wh.id, 'inventory', p_sku_code, 'INVENTORY_' || UPPER(p_transaction_type),
    CASE WHEN p_idempotency_key IS NOT NULL THEN 'outbox:' || p_idempotency_key ELSE NULL END,
    jsonb_build_object('sku', p_sku_code, 'delta', p_qty_delta, 'balance_after', v_after, 'location', p_location_code, 'operator', p_operator)
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object('ok', true, 'ledger_id', v_ledger_id, 'balance_before', v_before, 'balance_after', v_after);
END;
$$;

-- 4. ACID Inbound GRN + Directed Putaway Generation RPC
CREATE OR REPLACE FUNCTION public.wms_receive_inbound_grn(
  p_sku_code TEXT,
  p_qty INTEGER,
  p_description TEXT DEFAULT NULL,
  p_po_number TEXT DEFAULT NULL,
  p_supplier_name TEXT DEFAULT 'Direct Supplier',
  p_receiving_bin TEXT DEFAULT 'RECV-DOCK-01',
  p_lot_number TEXT DEFAULT 'DEFAULT',
  p_qc_status TEXT DEFAULT 'passed',
  p_operator TEXT DEFAULT 'Operator',
  p_warehouse_code TEXT DEFAULT 'DXB-FC1'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wh RECORD;
  v_sku RECORD;
  v_grn TEXT;
  v_put_task TEXT;
  v_receipt_id UUID;
  v_suggested_loc TEXT;
  v_dest_zone TEXT;
BEGIN
  SELECT id, tenant_id INTO v_wh FROM public.wms_warehouses WHERE code = p_warehouse_code LIMIT 1;
  IF NOT FOUND THEN
    SELECT id, tenant_id INTO v_wh FROM public.wms_warehouses WHERE is_default = true LIMIT 1;
  END IF;

  SELECT * INTO v_sku FROM public.wms_skus WHERE tenant_id = v_wh.tenant_id AND sku_code = p_sku_code LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO public.wms_skus (tenant_id, sku_code, name, default_location_code)
    VALUES (v_wh.tenant_id, p_sku_code, COALESCE(NULLIF(p_description, ''), p_sku_code), 'PHONE-A-01')
    RETURNING * INTO v_sku;
  END IF;

  v_suggested_loc := COALESCE(v_sku.default_location_code, 'PHONE-A-01');
  v_dest_zone := SPLIT_PART(v_suggested_loc, '-', 1) || '-' || SPLIT_PART(v_suggested_loc, '-', 2);
  v_grn := 'GRN-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 6);
  v_put_task := 'PUT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 6);

  INSERT INTO public.wms_receipts (
    tenant_id, warehouse_id, grn_number, po_number, supplier_name, sku_id, sku_code,
    description, expected_qty, received_qty, receiving_bin, putaway_location, lot_number, qc_status, operator_name
  ) VALUES (
    v_wh.tenant_id, v_wh.id, v_grn, p_po_number, p_supplier_name, v_sku.id, p_sku_code,
    COALESCE(p_description, v_sku.name), p_qty, p_qty, p_receiving_bin, v_suggested_loc, p_lot_number, p_qc_status, p_operator
  ) RETURNING id INTO v_receipt_id;

  IF p_qc_status = 'failed' OR p_qc_status = 'quarantine' THEN
    INSERT INTO public.wms_qc_inspections (
      tenant_id, warehouse_id, receipt_id, sku_id, sku_code, lot_number, quantity, reason, status, inspector_name
    ) VALUES (
      v_wh.tenant_id, v_wh.id, v_receipt_id, v_sku.id, p_sku_code, p_lot_number, p_qty, 'Inbound QC Hold (' || v_grn || ')', 'hold', p_operator
    );
  ELSE
    PERFORM public.wms_record_stock_movement(
      p_sku_code, p_qty, 'inbound', v_suggested_loc, p_lot_number, 'GRN', v_grn, p_operator, 'Inbound GRN ' || v_grn, 'grn:' || v_grn, p_warehouse_code
    );

    INSERT INTO public.wms_putaway_tasks (
      tenant_id, warehouse_id, task_number, receipt_id, sku_id, sku_code, product_name, quantity, lot_number,
      source_location, source_type, suggested_location, destination_zone, qc_status, status, operator_name
    ) VALUES (
      v_wh.tenant_id, v_wh.id, v_put_task, v_receipt_id, v_sku.id, p_sku_code, v_sku.name, p_qty, p_lot_number,
      p_receiving_bin, 'receiving', v_suggested_loc, v_dest_zone, p_qc_status, 'pending', p_operator
    );
  END IF;

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, operator_name, action, entity_type, entity_id, details)
  VALUES (v_wh.tenant_id, v_wh.id, p_operator, 'INBOUND_GRN', 'wms_receipts', v_grn, 'Received ' || p_qty || 'x ' || p_sku_code || ' -> ' || v_suggested_loc);

  RETURN jsonb_build_object('ok', true, 'grn_number', v_grn, 'putaway_task', v_put_task, 'suggested_location', v_suggested_loc);
END;
$$;

-- 5. ACID FEFO Allocation + Wave & Pick Task Generation RPC
CREATE OR REPLACE FUNCTION public.wms_allocate_order_fefo(
  p_order_number TEXT,
  p_operator TEXT DEFAULT 'System',
  p_warehouse_code TEXT DEFAULT 'DXB-FC1'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wh RECORD;
  v_order RECORD;
  v_sku_token TEXT;
  v_bal RECORD;
  v_res_num TEXT;
  v_task_num TEXT;
  v_res_id UUID;
  v_allocated_count INTEGER := 0;
BEGIN
  SELECT id, tenant_id INTO v_wh FROM public.wms_warehouses WHERE code = p_warehouse_code LIMIT 1;
  IF NOT FOUND THEN
    SELECT id, tenant_id INTO v_wh FROM public.wms_warehouses WHERE is_default = true LIMIT 1;
  END IF;

  SELECT * INTO v_order FROM public.wms_sales_orders WHERE warehouse_id = v_wh.id AND order_number = p_order_number FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Order not found: ' || p_order_number);
  END IF;

  IF v_order.status NOT IN ('Pending') THEN
    RETURN jsonb_build_object('ok', true, 'already_allocated', true, 'status', v_order.status);
  END IF;

  FOREACH v_sku_token IN ARRAY STRING_TO_ARRAY(v_order.required_skus, ',')
  LOOP
    v_sku_token := TRIM(v_sku_token);
    IF v_sku_token = '' THEN CONTINUE; END IF;

    -- FEFO selection: earliest expiry date first, highest available stock
    SELECT * INTO v_bal
    FROM public.wms_inventory_balances
    WHERE warehouse_id = v_wh.id AND sku_code = v_sku_token AND available_qty >= 1
    ORDER BY expiry_date ASC NULLS LAST, available_qty DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Insufficient available stock for SKU ' || v_sku_token);
    END IF;

    UPDATE public.wms_inventory_balances
    SET reserved_qty = reserved_qty + 1, version = version + 1, updated_at = NOW()
    WHERE id = v_bal.id;

    v_res_num := 'RES-' || SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 8);
    INSERT INTO public.wms_reservations (
      tenant_id, warehouse_id, reservation_number, order_number, sku_id, sku_code, location_code, lot_number, quantity, status, operator_name
    ) VALUES (
      v_wh.tenant_id, v_wh.id, v_res_num, p_order_number, v_bal.sku_id, v_sku_token, v_bal.location_code, v_bal.lot_number, 1, 'allocated', p_operator
    ) RETURNING id INTO v_res_id;

    v_task_num := 'PICK-' || SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 8);
    INSERT INTO public.wms_pick_tasks (
      tenant_id, warehouse_id, task_number, order_id, order_number, reservation_id, sku_id, sku_code,
      from_location_code, lot_number, required_qty, priority, status, assigned_to
    ) VALUES (
      v_wh.tenant_id, v_wh.id, v_task_num, v_order.id, p_order_number, v_res_id, v_bal.sku_id, v_sku_token,
      v_bal.location_code, v_bal.lot_number, 1, v_order.priority, 'pending', v_order.assigned_to
    );

    v_allocated_count := v_allocated_count + 1;
  END LOOP;

  UPDATE public.wms_sales_orders SET status = 'Allocated', updated_at = NOW() WHERE id = v_order.id;

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, operator_name, action, entity_type, entity_id, details)
  VALUES (v_wh.tenant_id, v_wh.id, p_operator, 'ORDER_ALLOCATED', 'wms_sales_orders', p_order_number, 'FEFO allocated ' || v_allocated_count || ' units');

  RETURN jsonb_build_object('ok', true, 'order_number', p_order_number, 'allocated_units', v_allocated_count);
END;
$$;

-- 6. ACID Shipment Dispatch RPC (deducts reserved + on_hand, writes ledger, creates shipment, updates order)
CREATE OR REPLACE FUNCTION public.wms_dispatch_order(
  p_order_number TEXT,
  p_carrier_name TEXT DEFAULT 'GBS Express',
  p_tracking_number TEXT DEFAULT NULL,
  p_operator TEXT DEFAULT 'Operator',
  p_warehouse_code TEXT DEFAULT 'DXB-FC1'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wh RECORD;
  v_order RECORD;
  v_sku_token TEXT;
  v_bal RECORD;
  v_ship_num TEXT;
  v_tracking TEXT;
BEGIN
  SELECT id, tenant_id INTO v_wh FROM public.wms_warehouses WHERE code = p_warehouse_code LIMIT 1;
  IF NOT FOUND THEN
    SELECT id, tenant_id INTO v_wh FROM public.wms_warehouses WHERE is_default = true LIMIT 1;
  END IF;

  SELECT * INTO v_order FROM public.wms_sales_orders WHERE warehouse_id = v_wh.id AND order_number = p_order_number FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Order not found: ' || p_order_number);
  END IF;

  IF v_order.status = 'Shipped' THEN
    RETURN jsonb_build_object('ok', true, 'already_shipped', true, 'tracking_number', v_order.tracking_number);
  END IF;

  v_tracking := COALESCE(NULLIF(p_tracking_number, ''), v_order.tracking_number, p_order_number);
  v_ship_num := 'SHP-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 6);

  FOREACH v_sku_token IN ARRAY STRING_TO_ARRAY(v_order.required_skus, ',')
  LOOP
    v_sku_token := TRIM(v_sku_token);
    IF v_sku_token = '' THEN CONTINUE; END IF;

    SELECT * INTO v_bal
    FROM public.wms_inventory_balances
    WHERE warehouse_id = v_wh.id AND sku_code = v_sku_token AND on_hand_qty >= 1
    ORDER BY reserved_qty DESC, on_hand_qty DESC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
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
        v_wh.tenant_id, v_wh.id, v_bal.sku_id, v_sku_token, 'outbound', -1,
        v_bal.on_hand_qty, GREATEST(0, v_bal.on_hand_qty - 1), v_bal.location_code, v_bal.lot_number,
        'SHIPMENT', v_ship_num, p_operator, 'Dispatched order ' || p_order_number
      );
    END IF;
  END LOOP;

  UPDATE public.wms_reservations SET status = 'picked' WHERE warehouse_id = v_wh.id AND order_number = p_order_number AND status IN ('reserved', 'allocated');
  UPDATE public.wms_pick_tasks SET status = 'completed', picked_qty = required_qty, completed_at = NOW() WHERE warehouse_id = v_wh.id AND order_number = p_order_number AND status <> 'completed';

  UPDATE public.wms_sales_orders
  SET status = 'Shipped', carrier_name = p_carrier_name, tracking_number = v_tracking, shipped_at = NOW(), updated_at = NOW()
  WHERE id = v_order.id;

  INSERT INTO public.wms_shipments (
    tenant_id, warehouse_id, shipment_number, order_id, order_number, carrier_name, tracking_number, status, dispatched_at, operator_name
  ) VALUES (
    v_wh.tenant_id, v_wh.id, v_ship_num, v_order.id, p_order_number, p_carrier_name, v_tracking, 'dispatched', NOW(), p_operator
  );

  INSERT INTO public.wms_event_outbox (
    tenant_id, warehouse_id, aggregate_type, aggregate_id, event_type, idempotency_key, payload
  ) VALUES (
    v_wh.tenant_id, v_wh.id, 'order', p_order_number, 'ORDER_SHIPPED', 'ship:' || p_order_number,
    jsonb_build_object('order_number', p_order_number, 'shipment_number', v_ship_num, 'tracking_number', v_tracking, 'carrier', p_carrier_name)
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, operator_name, action, entity_type, entity_id, details)
  VALUES (v_wh.tenant_id, v_wh.id, p_operator, 'ORDER_DISPATCHED', 'wms_shipments', v_ship_num, 'Shipped ' || p_order_number || ' via ' || p_carrier_name);

  RETURN jsonb_build_object('ok', true, 'shipment_number', v_ship_num, 'tracking_number', v_tracking);
END;
$$;

-- 7. Safe Public View for Users (NEVER exposes password_hash to REST API)
CREATE OR REPLACE VIEW public.v_wms_users_safe AS
SELECT
  id,
  tenant_id,
  default_warehouse_id,
  username,
  email,
  display_name,
  role,
  skill_level,
  current_zone,
  is_active,
  last_login_at,
  created_at,
  updated_at
FROM public.wms_users;

-- 8. Row Level Security (RLS) on ALL wms_* tables
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename LIKE 'wms_%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t.tablename);

    -- Drop if re-running
    EXECUTE format('DROP POLICY IF EXISTS wms_authenticated_all ON public.%I;', t.tablename);
    EXECUTE format('DROP POLICY IF EXISTS wms_anon_floor_sync ON public.%I;', t.tablename);

    -- Authenticated JWT users have full tenant access
    EXECUTE format(
      'CREATE POLICY wms_authenticated_all ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true);',
      t.tablename
    );

    -- Floor client policy EXCEPT wms_users (wms_users is strictly locked down; auth only via SECURITY DEFINER RPC & v_wms_users_safe)
    IF t.tablename <> 'wms_users' THEN
      EXECUTE format(
        'CREATE POLICY wms_anon_floor_sync ON public.%I FOR ALL TO anon USING (true) WITH CHECK (true);',
        t.tablename
      );
    END IF;
  END LOOP;
END;
$$;

-- Revoke direct select on password_hash from anon/authenticated; force use of v_wms_users_safe & RPCs
REVOKE ALL ON public.wms_users FROM anon;
GRANT SELECT (id, tenant_id, default_warehouse_id, username, email, display_name, role, skill_level, current_zone, is_active, last_login_at, created_at, updated_at) ON public.wms_users TO authenticated;
GRANT SELECT ON public.v_wms_users_safe TO anon, authenticated;
GRANT SELECT ON public.v_wms_kpi_summary TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wms_authenticate_user(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wms_upsert_user_secure(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wms_record_stock_movement(TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wms_receive_inbound_grn(TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wms_allocate_order_fefo(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wms_dispatch_order(TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- 9. Enable Supabase Realtime publication for live floor sync
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'wms_inventory_balances',
    'wms_inventory_ledger',
    'wms_sales_orders',
    'wms_pick_tasks',
    'wms_putaway_tasks',
    'wms_shipments',
    'wms_qc_inspections',
    'wms_event_outbox',
    'wms_audit_logs',
    'wms_connected_devices'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = tbl
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I;', tbl);
    END IF;
  END LOOP;
END;
$$;

-- 10. Storage Buckets for S3-backed Labels, GRN Docs, and Dispatch Proof Photos
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('wms-labels', 'wms-labels', true, 10485760, ARRAY['application/pdf', 'image/png', 'image/jpeg']),
  ('wms-pod-media', 'wms-pod-media', true, 26214400, ARRAY['image/png', 'image/jpeg', 'image/webp', 'video/webm', 'video/mp4']),
  ('wms-documents', 'wms-documents', false, 26214400, ARRAY['application/pdf', 'text/csv', 'application/json', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
ON CONFLICT (id) DO NOTHING;
