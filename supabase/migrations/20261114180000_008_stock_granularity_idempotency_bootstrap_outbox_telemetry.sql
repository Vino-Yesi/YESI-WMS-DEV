-- =============================================================================
-- Migration 008 (P0/P1/P2 hardening):
--   A. Multi-dimensional stock granularity: stock_status + serial_number,
--      strict non-negative / reservation invariants, append-only ledger.
--   B. Strict command idempotency for the full fulfillment lifecycle
--      (receive -> qc -> putaway -> allocate -> pick -> pack -> ship -> return)
--      behind a single audited dispatcher `wms_execute_command`.
--   C. Secure first-run administrator bootstrap + credential rotation, and
--      removal of the legacy "password == username" demo account posture.
--   D. Leased, observable transactional outbox (FOR UPDATE SKIP LOCKED) with
--      retry backoff, delivered-endpoint tracking and a dead-letter queue.
--   E. Operational telemetry + upgraded `v_wms_kpi_summary`
--      (shipped_today, outbox_dead_letter, allocation_conflicts, avg_sync_latency_ms).
--
-- Every statement is idempotent: this migration is safe to re-run.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- A. MULTI-DIMENSIONAL STOCK GRANULARITY
-- =============================================================================

ALTER TABLE public.wms_inventory_balances
  ADD COLUMN IF NOT EXISTS stock_status TEXT NOT NULL DEFAULT 'AVAILABLE',
  ADD COLUMN IF NOT EXISTS serial_number TEXT,
  ADD COLUMN IF NOT EXISTS damaged_qty INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hold_qty INTEGER NOT NULL DEFAULT 0;

-- Normalise legacy rows before tightening constraints.
UPDATE public.wms_inventory_balances
SET stock_status = COALESCE(NULLIF(UPPER(TRIM(stock_status)), ''), 'AVAILABLE')
WHERE stock_status IS DISTINCT FROM COALESCE(NULLIF(UPPER(TRIM(stock_status)), ''), 'AVAILABLE');

UPDATE public.wms_inventory_balances
SET on_hand_qty = GREATEST(on_hand_qty, 0),
    reserved_qty = GREATEST(reserved_qty, 0),
    quarantine_qty = GREATEST(quarantine_qty, 0),
    damaged_qty = GREATEST(damaged_qty, 0),
    hold_qty = GREATEST(hold_qty, 0);

UPDATE public.wms_inventory_balances
SET reserved_qty = LEAST(reserved_qty, on_hand_qty),
    quarantine_qty = LEAST(quarantine_qty, GREATEST(on_hand_qty - reserved_qty, 0));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wms_balances_stock_status_chk'
  ) THEN
    ALTER TABLE public.wms_inventory_balances
      ADD CONSTRAINT wms_balances_stock_status_chk
      CHECK (stock_status IN ('AVAILABLE', 'RESERVED', 'QUARANTINE', 'DAMAGED', 'HOLD'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wms_balances_reservation_invariant'
  ) THEN
    ALTER TABLE public.wms_inventory_balances
      ADD CONSTRAINT wms_balances_reservation_invariant
      CHECK (reserved_qty + quarantine_qty <= on_hand_qty);
  END IF;
END;
$$;

-- Replace the SKU/bin/lot uniqueness with the full stock-dimension key.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.wms_inventory_balances'::regclass
      AND contype = 'u'
      AND conname <> 'wms_balances_stock_dimensions_key'
  LOOP
    EXECUTE format('ALTER TABLE public.wms_inventory_balances DROP CONSTRAINT %I;', c.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wms_balances_stock_dimensions_key'
  ) THEN
    ALTER TABLE public.wms_inventory_balances
      ADD CONSTRAINT wms_balances_stock_dimensions_key
      UNIQUE (warehouse_id, sku_code, location_code, lot_number, stock_status);
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_balances_serial
  ON public.wms_inventory_balances (warehouse_id, sku_code, serial_number)
  WHERE serial_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wms_balances_fefo
  ON public.wms_inventory_balances (warehouse_id, sku_code, stock_status, expiry_date ASC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_wms_balances_location
  ON public.wms_inventory_balances (warehouse_id, location_code);
CREATE INDEX IF NOT EXISTS idx_wms_balances_updated
  ON public.wms_inventory_balances (updated_at DESC);

-- Append-only (immutable) inventory ledger -----------------------------------
CREATE OR REPLACE FUNCTION public.wms_guard_ledger_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  -- Explicit, audited escape hatch for DBA repairs only:
  --   SET LOCAL wms.allow_ledger_mutation = 'on';
  IF COALESCE(current_setting('wms.allow_ledger_mutation', TRUE), 'off') = 'on' THEN
    INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, operator_name, action, entity_type, entity_id, details)
    VALUES (
      COALESCE(OLD.tenant_id, (SELECT id FROM public.wms_tenants LIMIT 1)),
      OLD.warehouse_id,
      COALESCE(current_setting('request.jwt.claim.sub', TRUE), 'dba'),
      'LEDGER_MUTATION_OVERRIDE',
      'wms_inventory_ledger',
      OLD.id::text,
      TG_OP || ' permitted via wms.allow_ledger_mutation'
    );
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION 'LEDGER_IMMUTABLE: wms_inventory_ledger is append-only (attempted % on %)', TG_OP, OLD.id;
END;
$$;

DROP TRIGGER IF EXISTS trg_wms_ledger_append_only ON public.wms_inventory_ledger;
CREATE TRIGGER trg_wms_ledger_append_only
  BEFORE UPDATE OR DELETE ON public.wms_inventory_ledger
  FOR EACH ROW EXECUTE FUNCTION public.wms_guard_ledger_immutability();

REVOKE UPDATE, DELETE ON public.wms_inventory_ledger FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_wms_ledger_wh_sku_created
  ON public.wms_inventory_ledger (warehouse_id, sku_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wms_ledger_reference
  ON public.wms_inventory_ledger (reference_type, reference_id);

-- =============================================================================
-- A2. Stock movement RPC v2 (stock_status + serial aware, tenant/session scoped)
--     The first 11 parameters keep their historic names, order and defaults so
--     every existing caller (migration 004/006/007 functions) keeps resolving.
-- =============================================================================
DROP FUNCTION IF EXISTS public.wms_record_stock_movement(TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);

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
  p_warehouse_code TEXT DEFAULT 'DXB-FC1',
  p_stock_status TEXT DEFAULT 'AVAILABLE',
  p_serial_number TEXT DEFAULT NULL,
  p_tenant_code TEXT DEFAULT NULL,
  p_expiry_date DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_wh RECORD;
  v_sku RECORD;
  v_loc_id UUID;
  v_bal RECORD;
  v_before INTEGER := 0;
  v_after INTEGER := 0;
  v_ledger_id UUID;
  v_status TEXT;
  v_lot TEXT;
BEGIN
  v_status := COALESCE(NULLIF(UPPER(TRIM(p_stock_status)), ''), 'AVAILABLE');
  IF v_status NOT IN ('AVAILABLE', 'RESERVED', 'QUARANTINE', 'DAMAGED', 'HOLD') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STOCK_STATUS: ' || v_status);
  END IF;
  v_lot := COALESCE(NULLIF(TRIM(p_lot_number), ''), 'DEFAULT');

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

  SELECT id, tenant_id INTO v_wh FROM public.wms_warehouses WHERE code = p_warehouse_code AND status = 'active' LIMIT 1;
  IF NOT FOUND THEN
    SELECT id, tenant_id INTO v_wh FROM public.wms_warehouses WHERE is_default = true AND status = 'active' LIMIT 1;
  END IF;
  IF p_tenant_code IS NOT NULL AND TRIM(p_tenant_code) <> '' THEN
    IF NOT EXISTS (SELECT 1 FROM public.wms_tenants t WHERE t.id = v_wh.tenant_id AND t.code = TRIM(p_tenant_code)) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'TENANT_MISMATCH: warehouse ' || p_warehouse_code || ' does not belong to tenant ' || p_tenant_code);
    END IF;
  END IF;

  SELECT id, sku_code, name INTO v_sku FROM public.wms_skus WHERE tenant_id = v_wh.tenant_id AND sku_code = TRIM(p_sku_code) LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO public.wms_skus (tenant_id, sku_code, name, default_location_code)
    VALUES (v_wh.tenant_id, TRIM(p_sku_code), TRIM(p_sku_code), p_location_code)
    RETURNING id, sku_code, name INTO v_sku;
  END IF;

  SELECT id INTO v_loc_id FROM public.wms_locations WHERE warehouse_id = v_wh.id AND location_code = p_location_code LIMIT 1;

  -- Lock the exact (warehouse, sku, bin, lot, stock_status[, serial]) balance row
  SELECT * INTO v_bal
  FROM public.wms_inventory_balances
  WHERE warehouse_id = v_wh.id
    AND sku_code = TRIM(p_sku_code)
    AND location_code = p_location_code
    AND lot_number = v_lot
    AND stock_status = v_status
    AND (p_serial_number IS NULL OR serial_number = p_serial_number)
  ORDER BY expiry_date ASC NULLS LAST
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    v_before := 0;
    v_after := GREATEST(0, p_qty_delta);
    IF p_qty_delta < 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_STOCK: no ' || v_status || ' balance for ' || p_sku_code || ' at ' || p_location_code || '/' || v_lot);
    END IF;
    INSERT INTO public.wms_inventory_balances (
      tenant_id, warehouse_id, sku_id, location_id, sku_code, location_code, lot_number,
      on_hand_qty, stock_status, serial_number, expiry_date, version
    ) VALUES (
      v_wh.tenant_id, v_wh.id, v_sku.id, v_loc_id, TRIM(p_sku_code), p_location_code, v_lot,
      v_after, v_status, NULLIF(TRIM(p_serial_number), ''), p_expiry_date, 1
    );
  ELSE
    v_before := v_bal.on_hand_qty;
    v_after := v_before + p_qty_delta;
    IF v_after < 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Insufficient on-hand stock for ' || p_sku_code || ' (have ' || v_before || ', delta ' || p_qty_delta || ')');
    END IF;
    IF v_bal.reserved_qty + v_bal.quarantine_qty > v_after THEN
      RETURN jsonb_build_object('ok', false, 'error', 'RESERVATION_INVARIANT: cannot reduce ' || p_sku_code || ' below reserved+quarantine (' || (v_bal.reserved_qty + v_bal.quarantine_qty) || ')');
    END IF;
    UPDATE public.wms_inventory_balances
    SET on_hand_qty = v_after,
        expiry_date = COALESCE(p_expiry_date, expiry_date),
        version = version + 1,
        updated_at = NOW()
    WHERE id = v_bal.id;
  END IF;

  INSERT INTO public.wms_inventory_ledger (
    tenant_id, warehouse_id, sku_id, sku_code, transaction_type, qty_delta,
    balance_before, balance_after,
    from_location_code, to_location_code, lot_number, serial_number,
    reference_type, reference_id, idempotency_key, operator_name, note
  ) VALUES (
    v_wh.tenant_id, v_wh.id, v_sku.id, TRIM(p_sku_code), p_transaction_type, p_qty_delta,
    v_before, v_after,
    CASE WHEN p_qty_delta < 0 THEN p_location_code ELSE NULL END,
    CASE WHEN p_qty_delta >= 0 THEN p_location_code ELSE NULL END,
    v_lot, NULLIF(TRIM(p_serial_number), ''),
    p_reference_type, p_reference_id, p_idempotency_key, p_operator, p_note
  ) RETURNING id INTO v_ledger_id;

  INSERT INTO public.wms_event_outbox (
    tenant_id, warehouse_id, aggregate_type, aggregate_id, event_type, idempotency_key, payload
  ) VALUES (
    v_wh.tenant_id, v_wh.id, 'inventory', TRIM(p_sku_code), 'INVENTORY_' || UPPER(p_transaction_type),
    CASE WHEN p_idempotency_key IS NOT NULL THEN 'outbox:' || p_idempotency_key ELSE NULL END,
    jsonb_build_object(
      'sku', TRIM(p_sku_code), 'delta', p_qty_delta, 'balance_after', v_after,
      'location', p_location_code, 'lot', v_lot, 'stock_status', v_status,
      'serial', NULLIF(TRIM(p_serial_number), ''), 'operator', p_operator
    )
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object(
    'ok', true, 'ledger_id', v_ledger_id, 'balance_before', v_before, 'balance_after', v_after,
    'stock_status', v_status, 'location_code', p_location_code, 'lot_number', v_lot
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_record_stock_movement(TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DATE) TO anon, authenticated;

-- =============================================================================
-- A3. Strict multi-bin / multi-lot FEFO allocation (replaces the 004 version)
-- =============================================================================
DROP FUNCTION IF EXISTS public.wms_allocate_order_fefo(TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.wms_allocate_order_fefo(
  p_order_number TEXT,
  p_operator TEXT DEFAULT 'System',
  p_warehouse_code TEXT DEFAULT NULL,
  p_tenant_code TEXT DEFAULT 'YESI-FZCO',
  p_session_token TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_ctx RECORD;
  v_order RECORD;
  v_line JSONB;
  v_line_sku TEXT;
  v_line_qty INTEGER;
  v_bal RECORD;
  v_remaining INTEGER;
  v_take INTEGER;
  v_res_num TEXT;
  v_task_num TEXT;
  v_res_id UUID;
  v_allocated_count INTEGER := 0;
  v_allocations JSONB := '[]'::jsonb;
BEGIN
  SELECT * INTO v_ctx FROM public.wms_assert_context(
    p_tenant_code, p_warehouse_code, p_session_token, ARRAY['admin', 'supervisor', 'operator']
  );

  SELECT * INTO v_order
  FROM public.wms_sales_orders
  WHERE warehouse_id = v_ctx.warehouse_id AND order_number = TRIM(p_order_number)
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Order not found in warehouse ' || p_warehouse_code || ': ' || p_order_number);
  END IF;

  IF v_order.status <> 'Pending' THEN
    RETURN jsonb_build_object('ok', true, 'deduplicated', true, 'already_allocated', true, 'order_number', p_order_number, 'status', v_order.status);
  END IF;

  -- Order lines drive allocation; fall back to the legacy comma separated SKU list.
  IF jsonb_typeof(v_order.lines) = 'array' AND jsonb_array_length(v_order.lines) > 0 THEN
    FOR v_line IN SELECT * FROM jsonb_array_elements(v_order.lines)
    LOOP
      v_line_sku := TRIM(COALESCE(v_line->>'sku', v_line->>'sku_code', v_line->>'product', ''));
      v_line_qty := GREATEST(1, COALESCE((v_line->>'qty')::integer, (v_line->>'quantity')::integer, 1));
      IF v_line_sku = '' THEN CONTINUE; END IF;
      v_remaining := v_line_qty;

      -- FEFO across every bin / lot / expiry, only sellable stock statuses
      WHILE v_remaining > 0 LOOP
        SELECT b.*, l.pick_sequence AS bin_pick_sequence INTO v_bal
        FROM public.wms_inventory_balances b
        LEFT JOIN public.wms_locations l
               ON l.warehouse_id = b.warehouse_id AND l.location_code = b.location_code
        WHERE b.warehouse_id = v_ctx.warehouse_id
          AND b.sku_code = v_line_sku
          AND b.stock_status = 'AVAILABLE'
          AND (b.on_hand_qty - b.reserved_qty - b.quarantine_qty) > 0
          AND (b.expiry_date IS NULL OR b.expiry_date >= CURRENT_DATE)
        ORDER BY b.expiry_date ASC NULLS LAST,
                 l.pick_sequence ASC NULLS LAST,
                 (b.on_hand_qty - b.reserved_qty - b.quarantine_qty) DESC
        LIMIT 1
        FOR UPDATE OF b;

        IF NOT FOUND THEN
          INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, details)
          VALUES (v_ctx.tenant_id, v_ctx.warehouse_id, v_ctx.user_id, p_operator, 'ALLOCATION_CONFLICT', 'wms_sales_orders', p_order_number,
                  'FEFO allocation shortfall for ' || v_line_sku || ' (remaining ' || v_remaining || ')');
          RETURN jsonb_build_object(
            'ok', false,
            'code', 'INSUFFICIENT_STOCK',
            'error', 'Insufficient available stock for SKU ' || v_line_sku,
            'allocated_units', v_allocated_count
          );
        END IF;

        v_take := LEAST(v_remaining, v_bal.on_hand_qty - v_bal.reserved_qty - v_bal.quarantine_qty);

        UPDATE public.wms_inventory_balances
        SET reserved_qty = reserved_qty + v_take, version = version + 1, updated_at = NOW()
        WHERE id = v_bal.id;

        v_res_num := 'RES-' || SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 10);
        INSERT INTO public.wms_reservations (
          tenant_id, warehouse_id, reservation_number, order_number, sku_id, sku_code,
          location_code, lot_number, quantity, fefo_priority, status, operator_name
        ) VALUES (
          v_ctx.tenant_id, v_ctx.warehouse_id, v_res_num, p_order_number, v_bal.sku_id, v_line_sku,
          v_bal.location_code, v_bal.lot_number, v_take,
          COALESCE((SELECT s.fefo_priority FROM public.wms_skus s WHERE s.id = v_bal.sku_id), 50), 'allocated', p_operator
        ) RETURNING id INTO v_res_id;

        v_task_num := 'PICK-' || SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 10);
        INSERT INTO public.wms_pick_tasks (
          tenant_id, warehouse_id, task_number, order_id, order_number, reservation_id, sku_id, sku_code,
          from_location_code, to_staging_code, lot_number, required_qty, pick_sequence, priority, status, assigned_to
        ) VALUES (
          v_ctx.tenant_id, v_ctx.warehouse_id, v_task_num, v_order.id, p_order_number, v_res_id, v_bal.sku_id, v_line_sku,
          v_bal.location_code, 'PACK-STAGE-01', v_bal.lot_number, v_take,
          COALESCE(v_bal.bin_pick_sequence, 100),
          v_order.priority, 'pending', v_order.assigned_to
        );

        INSERT INTO public.wms_inventory_ledger (
          tenant_id, warehouse_id, sku_id, sku_code, transaction_type, qty_delta,
          balance_before, balance_after, from_location_code, lot_number,
          reference_type, reference_id, idempotency_key, operator_name, note
        ) VALUES (
          v_ctx.tenant_id, v_ctx.warehouse_id, v_bal.sku_id, v_line_sku, 'allocation', 0,
          v_bal.on_hand_qty, v_bal.on_hand_qty, v_bal.location_code, v_bal.lot_number,
          'RESERVATION', v_res_num,
          COALESCE(p_idempotency_key || ':' || v_res_num, 'alloc:' || v_res_num),
          p_operator, 'FEFO reserved ' || v_take || 'x ' || v_line_sku || ' for ' || p_order_number
        );

        v_allocations := v_allocations || jsonb_build_object(
          'sku', v_line_sku, 'qty', v_take, 'location', v_bal.location_code,
          'lot', v_bal.lot_number, 'expiry', v_bal.expiry_date, 'reservation', v_res_num, 'pick_task', v_task_num
        );
        v_allocated_count := v_allocated_count + v_take;
        v_remaining := v_remaining - v_take;
      END LOOP;
    END LOOP;
  ELSE
    RETURN jsonb_build_object('ok', false, 'code', 'NO_ORDER_LINES', 'error', 'Order ' || p_order_number || ' has no allocatable lines');
  END IF;

  UPDATE public.wms_sales_orders SET status = 'Allocated', updated_at = NOW() WHERE id = v_order.id;

  INSERT INTO public.wms_event_outbox (
    tenant_id, warehouse_id, aggregate_type, aggregate_id, event_type, idempotency_key, payload
  ) VALUES (
    v_ctx.tenant_id, v_ctx.warehouse_id, 'order', p_order_number, 'ORDER_ALLOCATED',
    COALESCE(p_idempotency_key, 'alloc:' || p_order_number),
    jsonb_build_object('order_number', p_order_number, 'allocated_units', v_allocated_count, 'allocations', v_allocations)
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, details)
  VALUES (v_ctx.tenant_id, v_ctx.warehouse_id, v_ctx.user_id, p_operator, 'ORDER_ALLOCATED', 'wms_sales_orders', p_order_number,
          'FEFO allocated ' || v_allocated_count || ' units across bins/lots');

  RETURN jsonb_build_object(
    'ok', true, 'order_number', p_order_number, 'allocated_units', v_allocated_count,
    'status', 'Allocated', 'allocations', v_allocations
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_allocate_order_fefo(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- Remove the ambiguous legacy overloads (PostgREST cannot disambiguate two
-- candidates that accept the same named arguments).
DROP FUNCTION IF EXISTS public.wms_receive_inbound_grn(TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.wms_dispatch_order(TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.wms_dispatch_order(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN);

-- =============================================================================
-- A4. Scan-verified pick confirmation (new lifecycle checkpoint)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.wms_confirm_pick_task(
  p_task_number TEXT,
  p_scanned_code TEXT DEFAULT NULL,
  p_picked_qty INTEGER DEFAULT NULL,
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
  v_wh RECORD;
  v_task RECORD;
  v_order RECORD;
  v_picked INTEGER;
  v_scan_ok BOOLEAN := FALSE;
  v_new_status TEXT;
  v_open_tasks INTEGER;
BEGIN
  SELECT * INTO v_ctx FROM public.wms_assert_context(
    p_tenant_code, p_warehouse_code, p_session_token, ARRAY['admin', 'supervisor', 'operator']
  );

  SELECT * INTO v_wh FROM public.wms_warehouses WHERE id = v_ctx.warehouse_id;

  SELECT * INTO v_task
  FROM public.wms_pick_tasks
  WHERE warehouse_id = v_ctx.warehouse_id AND task_number = TRIM(p_task_number)
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TASK_NOT_FOUND', 'error', 'Pick task not found: ' || p_task_number);
  END IF;

  IF v_task.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'deduplicated', true, 'task_number', v_task.task_number, 'picked_qty', v_task.picked_qty);
  END IF;

  -- Scan verification (warehouse policy driven)
  IF COALESCE((v_wh.operating_config->>'require_scan_verify')::boolean, TRUE) THEN
    IF p_scanned_code IS NULL OR TRIM(p_scanned_code) = '' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'SCAN_REQUIRED', 'error', 'Scan verification is mandatory for warehouse ' || v_wh.code);
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.wms_barcodes bc
      JOIN public.wms_skus s ON s.id = bc.sku_id
      WHERE s.tenant_id = v_ctx.tenant_id AND s.sku_code = v_task.sku_code
        AND bc.barcode = TRIM(p_scanned_code)
    ) OR EXISTS (
      SELECT 1 FROM public.wms_skus s
      WHERE s.tenant_id = v_ctx.tenant_id AND s.sku_code = v_task.sku_code
        AND (s.primary_barcode = TRIM(p_scanned_code) OR s.sku_code = TRIM(p_scanned_code) OR s.article_code = TRIM(p_scanned_code))
    ) OR EXISTS (
      SELECT 1 FROM public.wms_serial_numbers sn
      WHERE sn.tenant_id = v_ctx.tenant_id AND sn.sku_code = v_task.sku_code
        AND (sn.serial_number = TRIM(p_scanned_code) OR sn.imei1 = TRIM(p_scanned_code))
    ) INTO v_scan_ok;

    IF NOT v_scan_ok THEN
      INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, details)
      VALUES (v_ctx.tenant_id, v_ctx.warehouse_id, v_ctx.user_id, p_operator, 'PICK_SCAN_MISMATCH', 'wms_pick_tasks', v_task.task_number,
              'Scanned ' || COALESCE(p_scanned_code, '') || ' does not match SKU ' || v_task.sku_code);
      RETURN jsonb_build_object('ok', false, 'code', 'SCAN_MISMATCH',
        'error', 'Scanned code ' || COALESCE(p_scanned_code, '') || ' does not belong to ' || v_task.sku_code);
    END IF;
  END IF;

  v_picked := LEAST(v_task.required_qty, GREATEST(0, COALESCE(p_picked_qty, v_task.required_qty)));
  v_new_status := CASE WHEN v_picked >= v_task.required_qty THEN 'completed' ELSE 'short_pick' END;

  UPDATE public.wms_pick_tasks
  SET status = v_new_status,
      picked_qty = v_picked,
      scanned_barcode = NULLIF(TRIM(p_scanned_code), ''),
      started_at = COALESCE(started_at, NOW()),
      completed_at = NOW(),
      assigned_to = COALESCE(assigned_to, p_operator),
      updated_at = NOW()
  WHERE id = v_task.id;

  IF v_task.reservation_id IS NOT NULL THEN
    UPDATE public.wms_reservations SET status = 'picked' WHERE id = v_task.reservation_id AND status IN ('reserved', 'allocated');
  END IF;

  -- Immutable audit trail for the physical pick (net stock unchanged until dispatch)
  INSERT INTO public.wms_inventory_ledger (
    tenant_id, warehouse_id, sku_id, sku_code, transaction_type, qty_delta,
    balance_before, balance_after, from_location_code, to_location_code, lot_number,
    reference_type, reference_id, idempotency_key, operator_name, note
  )
  SELECT
    v_ctx.tenant_id, v_ctx.warehouse_id, b.sku_id, b.sku_code, 'pick', 0,
    b.on_hand_qty, b.on_hand_qty, b.location_code, 'PACK-STAGE-01', b.lot_number,
    'PICK_TASK', v_task.task_number,
    COALESCE(p_idempotency_key, 'pick:' || v_task.task_number),
    p_operator, 'Picked ' || v_picked || 'x ' || b.sku_code || ' from ' || b.location_code
  FROM public.wms_inventory_balances b
  WHERE b.warehouse_id = v_ctx.warehouse_id
    AND b.sku_code = v_task.sku_code
    AND b.location_code = v_task.from_location_code
    AND b.lot_number = COALESCE(v_task.lot_number, b.lot_number)
  ORDER BY b.expiry_date ASC NULLS LAST
  LIMIT 1
  ON CONFLICT (idempotency_key) DO NOTHING;

  SELECT * INTO v_order FROM public.wms_sales_orders WHERE id = v_task.order_id FOR UPDATE;
  SELECT COUNT(*) INTO v_open_tasks
  FROM public.wms_pick_tasks
  WHERE warehouse_id = v_ctx.warehouse_id AND order_number = v_task.order_number
    AND status NOT IN ('completed', 'short_pick', 'cancelled');

  IF v_order.id IS NOT NULL AND v_order.status IN ('Allocated', 'Picking') THEN
    UPDATE public.wms_sales_orders
    SET status = CASE WHEN v_open_tasks = 0 THEN 'ReadyToShip' ELSE 'Picking' END,
        updated_at = NOW()
    WHERE id = v_order.id;
  END IF;

  INSERT INTO public.wms_event_outbox (
    tenant_id, warehouse_id, aggregate_type, aggregate_id, event_type, idempotency_key, payload
  ) VALUES (
    v_ctx.tenant_id, v_ctx.warehouse_id, 'pick_task', v_task.task_number, 'PICK_CONFIRMED',
    COALESCE(p_idempotency_key, 'pick:' || v_task.task_number),
    jsonb_build_object('task_number', v_task.task_number, 'order_number', v_task.order_number,
                       'sku', v_task.sku_code, 'picked_qty', v_picked, 'status', v_new_status)
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, details)
  VALUES (v_ctx.tenant_id, v_ctx.warehouse_id, v_ctx.user_id, p_operator, 'PICK_CONFIRMED', 'wms_pick_tasks', v_task.task_number,
          'Picked ' || v_picked || '/' || v_task.required_qty || 'x ' || v_task.sku_code || ' from ' || v_task.from_location_code);

  RETURN jsonb_build_object('ok', true, 'task_number', v_task.task_number, 'picked_qty', v_picked,
                            'status', v_new_status, 'order_number', v_task.order_number, 'open_tasks', v_open_tasks);
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_confirm_pick_task(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- =============================================================================
-- A5. Reservation-accurate dispatch (deducts the exact bin/lot that was reserved)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.wms_dispatch_order(
  p_order_number TEXT,
  p_carrier_name TEXT DEFAULT 'GBS Express',
  p_tracking_number TEXT DEFAULT NULL,
  p_operator TEXT DEFAULT 'Operator',
  p_warehouse_code TEXT DEFAULT NULL,
  p_tenant_code TEXT DEFAULT 'YESI-FZCO',
  p_session_token TEXT DEFAULT NULL,
  p_allow_direct_override BOOLEAN DEFAULT FALSE,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_ctx RECORD;
  v_order RECORD;
  v_res RECORD;
  v_bal RECORD;
  v_line JSONB;
  v_line_sku TEXT;
  v_line_qty INTEGER;
  v_ship_num TEXT;
  v_tracking TEXT;
  v_shipped_units INTEGER := 0;
BEGIN
  SELECT * INTO v_ctx FROM public.wms_assert_context(
    p_tenant_code, p_warehouse_code, p_session_token, ARRAY['admin', 'supervisor', 'operator']
  );

  SELECT * INTO v_order
  FROM public.wms_sales_orders
  WHERE warehouse_id = v_ctx.warehouse_id AND order_number = TRIM(p_order_number)
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Order not found in warehouse ' || p_warehouse_code || ': ' || p_order_number);
  END IF;

  IF v_order.status = 'Shipped' THEN
    RETURN jsonb_build_object('ok', true, 'deduplicated', true, 'already_shipped', true,
                              'order_number', p_order_number, 'tracking_number', v_order.tracking_number);
  END IF;

  IF NOT p_allow_direct_override AND v_order.status NOT IN ('Packed', 'ReadyToShip', 'Allocated', 'Picking') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LIFECYCLE_VIOLATION',
      'error', 'LIFECYCLE_VIOLATION: Order ' || p_order_number || ' must be Packed/ReadyToShip before Carrier Dispatch (current: ' || v_order.status || ')');
  END IF;

  v_tracking := COALESCE(NULLIF(TRIM(p_tracking_number), ''), v_order.tracking_number, p_order_number);
  v_ship_num := 'SHP-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 6);

  -- 1) Consume the exact reserved bin/lot rows (multi-bin / multi-lot accurate)
  FOR v_res IN
    SELECT * FROM public.wms_reservations
    WHERE warehouse_id = v_ctx.warehouse_id
      AND order_number = p_order_number
      AND status IN ('reserved', 'allocated', 'picked')
    ORDER BY created_at
    FOR UPDATE
  LOOP
    SELECT * INTO v_bal
    FROM public.wms_inventory_balances
    WHERE warehouse_id = v_ctx.warehouse_id
      AND sku_code = v_res.sku_code
      AND location_code = COALESCE(v_res.location_code, 'PHONE-A-01')
      AND lot_number = COALESCE(v_res.lot_number, 'DEFAULT')
      AND stock_status = 'AVAILABLE'
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND OR v_bal.on_hand_qty < v_res.quantity THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_STOCK',
        'error', 'INSUFFICIENT_STOCK: cannot dispatch ' || p_order_number || '; ' || v_res.sku_code ||
                 ' bin ' || COALESCE(v_res.location_code, '?') || ' lot ' || COALESCE(v_res.lot_number, '?') || ' is short');
    END IF;

    UPDATE public.wms_inventory_balances
    SET on_hand_qty = on_hand_qty - v_res.quantity,
        reserved_qty = GREATEST(0, reserved_qty - v_res.quantity),
        version = version + 1,
        updated_at = NOW()
    WHERE id = v_bal.id;

    INSERT INTO public.wms_inventory_ledger (
      tenant_id, warehouse_id, sku_id, sku_code, transaction_type, qty_delta,
      balance_before, balance_after, from_location_code, lot_number,
      reference_type, reference_id, idempotency_key, operator_name, note
    ) VALUES (
      v_ctx.tenant_id, v_ctx.warehouse_id, v_bal.sku_id, v_res.sku_code, 'outbound', -v_res.quantity,
      v_bal.on_hand_qty, v_bal.on_hand_qty - v_res.quantity, v_bal.location_code, v_bal.lot_number,
      'SHIPMENT', v_ship_num,
      COALESCE(p_idempotency_key, 'ship') || ':' || p_order_number || ':' || v_res.id,
      p_operator, 'Dispatched ' || v_res.quantity || 'x ' || v_res.sku_code || ' for order ' || p_order_number
    ) ON CONFLICT (idempotency_key) DO NOTHING;

    UPDATE public.wms_reservations SET status = 'picked' WHERE id = v_res.id;
    v_shipped_units := v_shipped_units + v_res.quantity;
  END LOOP;

  -- 2) Legacy fallback: orders dispatched without reservations deduct FEFO stock directly
  IF v_shipped_units = 0 AND jsonb_typeof(v_order.lines) = 'array' THEN
    FOR v_line IN SELECT * FROM jsonb_array_elements(v_order.lines)
    LOOP
      v_line_sku := TRIM(COALESCE(v_line->>'sku', v_line->>'sku_code', v_line->>'product', ''));
      v_line_qty := GREATEST(1, COALESCE((v_line->>'qty')::integer, (v_line->>'quantity')::integer, 1));
      IF v_line_sku = '' THEN CONTINUE; END IF;

      WHILE v_line_qty > 0 LOOP
        SELECT * INTO v_bal
        FROM public.wms_inventory_balances
        WHERE warehouse_id = v_ctx.warehouse_id AND sku_code = v_line_sku
          AND stock_status = 'AVAILABLE' AND on_hand_qty > 0
        ORDER BY expiry_date ASC NULLS LAST, on_hand_qty DESC
        LIMIT 1
        FOR UPDATE;

        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_STOCK',
            'error', 'INSUFFICIENT_STOCK: Cannot dispatch ' || p_order_number || '; SKU ' || v_line_sku || ' has 0 on-hand');
        END IF;

        DECLARE
          v_take INTEGER := LEAST(v_line_qty, v_bal.on_hand_qty - v_bal.reserved_qty);
        BEGIN
          IF v_take <= 0 THEN
            RETURN jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_STOCK',
              'error', 'INSUFFICIENT_STOCK: ' || v_line_sku || ' is fully reserved');
          END IF;

          UPDATE public.wms_inventory_balances
          SET on_hand_qty = on_hand_qty - v_take,
              reserved_qty = GREATEST(0, reserved_qty - v_take),
              version = version + 1,
              updated_at = NOW()
          WHERE id = v_bal.id;

          INSERT INTO public.wms_inventory_ledger (
            tenant_id, warehouse_id, sku_id, sku_code, transaction_type, qty_delta,
            balance_before, balance_after, from_location_code, lot_number,
            reference_type, reference_id, idempotency_key, operator_name, note
          ) VALUES (
            v_ctx.tenant_id, v_ctx.warehouse_id, v_bal.sku_id, v_line_sku, 'outbound', -v_take,
            v_bal.on_hand_qty, v_bal.on_hand_qty - v_take, v_bal.location_code, v_bal.lot_number,
            'SHIPMENT', v_ship_num,
            COALESCE(p_idempotency_key, 'ship') || ':' || p_order_number || ':' || v_bal.id,
            p_operator, 'Dispatched order ' || p_order_number
          ) ON CONFLICT (idempotency_key) DO NOTHING;

          v_shipped_units := v_shipped_units + v_take;
          v_line_qty := v_line_qty - v_take;
        END;
      END LOOP;
    END LOOP;
  END IF;

  UPDATE public.wms_pick_tasks
  SET status = 'completed', picked_qty = required_qty, completed_at = COALESCE(completed_at, NOW())
  WHERE warehouse_id = v_ctx.warehouse_id AND order_number = p_order_number AND status NOT IN ('completed', 'cancelled');

  UPDATE public.wms_sales_orders
  SET status = 'Shipped', carrier_name = p_carrier_name, tracking_number = v_tracking,
      shipped_at = NOW(), updated_at = NOW()
  WHERE id = v_order.id;

  INSERT INTO public.wms_shipments (
    tenant_id, warehouse_id, shipment_number, order_id, order_number, carrier_name,
    service_level, tracking_number, status, dispatched_at, operator_name
  ) VALUES (
    v_ctx.tenant_id, v_ctx.warehouse_id, v_ship_num, v_order.id, p_order_number, p_carrier_name,
    COALESCE(v_order.service_level, 'Ozon Global'), v_tracking, 'dispatched', NOW(), p_operator
  );

  INSERT INTO public.wms_event_outbox (
    tenant_id, warehouse_id, aggregate_type, aggregate_id, event_type, idempotency_key, payload
  ) VALUES (
    v_ctx.tenant_id, v_ctx.warehouse_id, 'order', p_order_number, 'ORDER_SHIPPED',
    COALESCE(p_idempotency_key, 'ship:' || p_order_number),
    jsonb_build_object('order_number', p_order_number, 'shipment_number', v_ship_num,
                       'tracking_number', v_tracking, 'carrier', p_carrier_name, 'units', v_shipped_units)
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, details)
  VALUES (v_ctx.tenant_id, v_ctx.warehouse_id, v_ctx.user_id, p_operator, 'ORDER_DISPATCHED', 'wms_shipments', v_ship_num,
          'Shipped ' || p_order_number || ' (' || v_shipped_units || ' units) via ' || p_carrier_name);

  RETURN jsonb_build_object('ok', true, 'shipment_number', v_ship_num, 'tracking_number', v_tracking,
                            'order_number', p_order_number, 'units', v_shipped_units, 'status', 'Shipped');
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_dispatch_order(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) TO anon, authenticated;

-- =============================================================================
-- B. STRICT COMMAND IDEMPOTENCY (timeout / retry / duplicate-request safe)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.wms_command_idempotency (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID REFERENCES public.wms_warehouses(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  command_name TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_payload JSONB,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
  actor_name TEXT,
  device_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_wms_idempotency_expires ON public.wms_command_idempotency(expires_at);
CREATE INDEX IF NOT EXISTS idx_wms_idempotency_command ON public.wms_command_idempotency(tenant_id, command_name, created_at DESC);

ALTER TABLE public.wms_command_idempotency ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wms_command_idempotency_service_only ON public.wms_command_idempotency;
CREATE POLICY wms_command_idempotency_service_only ON public.wms_command_idempotency
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON public.wms_command_idempotency FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.wms_purge_expired_idempotency(p_retention_days INTEGER DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.wms_command_idempotency
  WHERE expires_at < NOW() - make_interval(days => GREATEST(0, COALESCE(p_retention_days, 30)));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'purged', v_deleted);
END;
$$;

REVOKE ALL ON FUNCTION public.wms_purge_expired_idempotency(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wms_purge_expired_idempotency(INTEGER) TO service_role;

-- Single audited entry point for the whole fulfillment lifecycle.
-- The idempotency record and the command effect commit in the SAME transaction,
-- so a client retry after a timeout can never double-apply a movement.
CREATE OR REPLACE FUNCTION public.wms_execute_command(
  p_command TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_idempotency_key TEXT DEFAULT NULL,
  p_tenant_code TEXT DEFAULT 'YESI-FZCO',
  p_warehouse_code TEXT DEFAULT NULL,
  p_session_token TEXT DEFAULT NULL,
  p_device_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_cmd TEXT := LOWER(TRIM(COALESCE(p_command, '')));
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_key TEXT;
  v_hash TEXT;
  v_ctx RECORD;
  v_existing RECORD;
  v_roles TEXT[];
  v_response JSONB;
BEGIN
  IF v_cmd = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'COMMAND_REQUIRED', 'error', 'p_command is required');
  END IF;

  v_roles := CASE
    WHEN v_cmd IN ('release_qc_hold') THEN ARRAY['admin', 'supervisor']
    ELSE ARRAY['admin', 'supervisor', 'operator']
  END;

  SELECT * INTO v_ctx FROM public.wms_assert_context(p_tenant_code, p_warehouse_code, p_session_token, v_roles);

  v_hash := encode(digest(v_payload::text || '|' || COALESCE(p_warehouse_code, '') || '|' || COALESCE(p_tenant_code, ''), 'sha256'), 'hex');
  v_key := COALESCE(NULLIF(TRIM(p_idempotency_key), ''), v_cmd || ':' || v_hash);

  SELECT * INTO v_existing
  FROM public.wms_command_idempotency
  WHERE tenant_id = v_ctx.tenant_id AND idempotency_key = v_key
  FOR UPDATE;

  IF FOUND THEN
    RETURN COALESCE(v_existing.response_payload, jsonb_build_object('ok', true))
           || jsonb_build_object('deduplicated', true, 'idempotency_key', v_key, 'replayed_at', v_existing.created_at);
  END IF;

  CASE v_cmd
    WHEN 'receive_inbound_grn' THEN
      v_response := public.wms_receive_inbound_grn(
        v_payload->>'sku_code',
        COALESCE((v_payload->>'qty')::integer, 0),
        v_payload->>'description',
        v_payload->>'po_number',
        COALESCE(v_payload->>'supplier_name', 'Direct Supplier'),
        COALESCE(v_payload->>'receiving_bin', 'RECV-DOCK-01'),
        COALESCE(v_payload->>'lot_number', 'DEFAULT'),
        COALESCE(v_payload->>'qc_status', 'pending'),
        COALESCE(v_payload->>'operator', v_ctx.username),
        p_warehouse_code, p_tenant_code, v_key, p_session_token
      );
    WHEN 'release_qc_hold' THEN
      v_response := public.wms_release_qc_hold(
        v_payload->>'sku_code',
        COALESCE((v_payload->>'quantity')::integer, 0),
        COALESCE(v_payload->>'disposition', 'release'),
        v_payload->>'reason',
        COALESCE(v_payload->>'inspector', v_ctx.username),
        p_warehouse_code, p_tenant_code,
        COALESCE(v_payload->>'lot_number', 'DEFAULT'), v_key, p_session_token
      );
    WHEN 'complete_putaway_task' THEN
      v_response := public.wms_complete_putaway_task(
        v_payload->>'task_number',
        v_payload->>'actual_location',
        COALESCE(v_payload->>'operator', v_ctx.username),
        p_warehouse_code, p_tenant_code, v_key, p_session_token
      );
    WHEN 'allocate_order_fefo' THEN
      v_response := public.wms_allocate_order_fefo(
        v_payload->>'order_number',
        COALESCE(v_payload->>'operator', v_ctx.username),
        p_warehouse_code, p_tenant_code, p_session_token, v_key
      );
    WHEN 'confirm_pick_task' THEN
      v_response := public.wms_confirm_pick_task(
        v_payload->>'task_number',
        v_payload->>'scanned_code',
        (v_payload->>'picked_qty')::integer,
        COALESCE(v_payload->>'operator', v_ctx.username),
        p_warehouse_code, p_tenant_code, v_key, p_session_token
      );
    WHEN 'confirm_order_packed' THEN
      v_response := public.wms_confirm_order_packed(
        v_payload->>'order_number',
        v_payload->>'box_name',
        (v_payload->>'weight_kg')::numeric,
        COALESCE(v_payload->>'operator', v_ctx.username),
        p_warehouse_code, p_tenant_code, p_session_token
      );
    WHEN 'dispatch_order' THEN
      v_response := public.wms_dispatch_order(
        v_payload->>'order_number',
        COALESCE(v_payload->>'carrier_name', 'GBS Express'),
        v_payload->>'tracking_number',
        COALESCE(v_payload->>'operator', v_ctx.username),
        p_warehouse_code, p_tenant_code, p_session_token,
        COALESCE((v_payload->>'allow_direct_override')::boolean, FALSE), v_key
      );
    WHEN 'process_return_rma' THEN
      v_response := public.wms_process_return_rma(
        v_payload->>'order_number',
        v_payload->>'sku_code',
        COALESCE((v_payload->>'quantity')::integer, 1),
        v_payload->>'reason',
        COALESCE(v_payload->>'disposition', 'restock'),
        COALESCE(v_payload->>'operator', v_ctx.username),
        p_warehouse_code, p_tenant_code, v_key, p_session_token
      );
    WHEN 'record_stock_movement' THEN
      v_response := public.wms_record_stock_movement(
        v_payload->>'sku_code',
        COALESCE((v_payload->>'qty_delta')::integer, 0),
        COALESCE(v_payload->>'transaction_type', 'adjustment'),
        COALESCE(v_payload->>'location_code', 'PHONE-A-01'),
        COALESCE(v_payload->>'lot_number', 'DEFAULT'),
        v_payload->>'reference_type',
        v_payload->>'reference_id',
        COALESCE(v_payload->>'operator', v_ctx.username),
        v_payload->>'note',
        v_key,
        p_warehouse_code,
        COALESCE(v_payload->>'stock_status', 'AVAILABLE'),
        v_payload->>'serial_number',
        p_tenant_code,
        CASE WHEN v_payload->>'expiry_date' IS NULL THEN NULL ELSE (v_payload->>'expiry_date')::date END
      );
    ELSE
      RETURN jsonb_build_object('ok', false, 'code', 'UNKNOWN_COMMAND',
        'error', 'Unsupported command: ' || v_cmd);
  END CASE;

  INSERT INTO public.wms_command_idempotency (
    tenant_id, warehouse_id, idempotency_key, command_name, request_hash,
    response_payload, status, actor_name, device_id
  ) VALUES (
    v_ctx.tenant_id, v_ctx.warehouse_id, v_key, v_cmd, v_hash,
    v_response,
    CASE WHEN COALESCE((v_response->>'ok')::boolean, FALSE) THEN 'completed' ELSE 'failed' END,
    COALESCE(v_ctx.username, 'edge-sync'), p_device_id
  )
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;

  RETURN v_response || jsonb_build_object('idempotency_key', v_key, 'command', v_cmd);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'code', 'COMMAND_FAILED', 'command', v_cmd, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_execute_command(TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- =============================================================================
-- C. SECURE FIRST-RUN BOOTSTRAP, PASSWORD ROTATION & DEMO ACCOUNT SANITISATION
-- =============================================================================
ALTER TABLE public.wms_users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_by TEXT;

-- Legacy default was scoped to a warehouse code that does not exist (MSK-HUB2).
ALTER TABLE public.wms_users
  ALTER COLUMN allowed_warehouses SET DEFAULT ARRAY['DXB-FC1', 'SHJ-HUB2']::TEXT[];

CREATE TABLE IF NOT EXISTS public.wms_bootstrap_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  first_admin_user_id UUID REFERENCES public.wms_users(id) ON DELETE SET NULL,
  first_admin_username TEXT,
  bootstrapped_at TIMESTAMPTZ,
  bootstrap_device_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.wms_bootstrap_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wms_bootstrap_state_service_only ON public.wms_bootstrap_state;
CREATE POLICY wms_bootstrap_state_service_only ON public.wms_bootstrap_state
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON public.wms_bootstrap_state FROM anon, authenticated;

-- Shared password strength policy ------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_validate_password_strength(p_password TEXT, p_username TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_pwd TEXT := COALESCE(p_password, '');
  v_classes INTEGER := 0;
BEGIN
  IF LENGTH(v_pwd) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PASSWORD_TOO_SHORT', 'error', 'Password must be at least 10 characters');
  END IF;
  IF LENGTH(v_pwd) > 128 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PASSWORD_TOO_LONG', 'error', 'Password must be at most 128 characters');
  END IF;
  IF v_pwd ~ '[a-z]' THEN v_classes := v_classes + 1; END IF;
  IF v_pwd ~ '[A-Z]' THEN v_classes := v_classes + 1; END IF;
  IF v_pwd ~ '[0-9]' THEN v_classes := v_classes + 1; END IF;
  IF v_pwd ~ '[^A-Za-z0-9]' THEN v_classes := v_classes + 1; END IF;
  IF v_classes < 3 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PASSWORD_TOO_SIMPLE',
      'error', 'Password must combine at least 3 of: lowercase, uppercase, digit, symbol');
  END IF;
  IF p_username IS NOT NULL AND LOWER(v_pwd) = LOWER(TRIM(p_username)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PASSWORD_EQUALS_USERNAME', 'error', 'Password must not equal the username');
  END IF;
  IF LOWER(v_pwd) IN ('password', 'password123', 'qwertyuiop', '1234567890', 'adminadmin', 'changeme123', 'yesi-wms-2026') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PASSWORD_COMMON', 'error', 'Password is too common');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.wms_validate_password_strength(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_validate_password_strength(TEXT, TEXT) TO service_role;

-- Bootstrap status probe (returns counts/flags only - never usernames or hashes) --
CREATE OR REPLACE FUNCTION public.wms_get_bootstrap_status(p_tenant_code TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_tenant RECORD;
  v_users INTEGER := 0;
  v_active_admins INTEGER := 0;
  v_state RECORD;
BEGIN
  SELECT id, code, status INTO v_tenant
  FROM public.wms_tenants
  WHERE code = COALESCE(NULLIF(TRIM(p_tenant_code), ''), 'YESI-FZCO')
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'tenant_exists', false, 'bootstrap_required', false,
      'error', 'Tenant not provisioned. Run migrations 001-005 first.');
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE role = 'admin' AND is_active)
  INTO v_users, v_active_admins
  FROM public.wms_users
  WHERE tenant_id = v_tenant.id;

  SELECT * INTO v_state FROM public.wms_bootstrap_state WHERE tenant_id = v_tenant.id;

  RETURN jsonb_build_object(
    'ok', true,
    'tenant_exists', true,
    'tenant_code', v_tenant.code,
    'tenant_status', v_tenant.status,
    'user_count', v_users,
    'active_admin_count', v_active_admins,
    'bootstrap_required', (v_active_admins = 0),
    'bootstrap_completed', COALESCE(v_state.status = 'completed', FALSE),
    'bootstrapped_at', v_state.bootstrapped_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_get_bootstrap_status(TEXT) TO anon, authenticated;

-- One-time first administrator bootstrap ---------------------------------------
CREATE OR REPLACE FUNCTION public.wms_bootstrap_first_admin(
  p_username TEXT,
  p_password TEXT,
  p_tenant_code TEXT DEFAULT 'YESI-FZCO',
  p_display_name TEXT DEFAULT NULL,
  p_email TEXT DEFAULT NULL,
  p_warehouse_code TEXT DEFAULT NULL,
  p_device_id TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_tenant RECORD;
  v_existing INTEGER := 0;
  v_strength JSONB;
  v_wh RECORD;
  v_all_codes TEXT[];
  v_user_id UUID;
  v_username TEXT := TRIM(COALESCE(p_username, ''));
  v_session JSONB;
BEGIN
  IF v_username !~ '^[A-Za-z0-9._-]{3,32}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_USERNAME',
      'error', 'Username must be 3-32 characters using letters, digits, dot, dash or underscore');
  END IF;

  SELECT id, code, status INTO v_tenant FROM public.wms_tenants WHERE code = TRIM(COALESCE(p_tenant_code, 'YESI-FZCO')) LIMIT 1;
  IF NOT FOUND OR v_tenant.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TENANT_INVALID', 'error', 'Tenant is not provisioned or not active');
  END IF;

  SELECT COUNT(*) INTO v_existing FROM public.wms_users WHERE tenant_id = v_tenant.id;
  IF v_existing > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BOOTSTRAP_ALREADY_COMPLETED',
      'error', 'Bootstrap is closed: this tenant already has ' || v_existing || ' operator account(s). An administrator must create additional users.');
  END IF;

  SELECT * INTO v_strength FROM public.wms_validate_password_strength(p_password, v_username);
  IF NOT COALESCE((v_strength->>'ok')::boolean, FALSE) THEN
    RETURN jsonb_build_object('ok', false, 'code', v_strength->>'code', 'error', v_strength->>'error');
  END IF;

  SELECT id, code INTO v_wh
  FROM public.wms_warehouses
  WHERE tenant_id = v_tenant.id
    AND code = COALESCE(NULLIF(TRIM(p_warehouse_code), ''), (SELECT code FROM public.wms_warehouses WHERE tenant_id = v_tenant.id AND is_default LIMIT 1))
    AND status = 'active'
  LIMIT 1;

  SELECT COALESCE(array_agg(code ORDER BY code), ARRAY[]::TEXT[]) INTO v_all_codes
  FROM public.wms_warehouses WHERE tenant_id = v_tenant.id AND status = 'active';

  INSERT INTO public.wms_users (
    tenant_id, default_warehouse_id, username, email, display_name, password_hash, role,
    is_active, allowed_warehouses, must_change_password, password_changed_at, created_by
  ) VALUES (
    v_tenant.id, v_wh.id, v_username, NULLIF(TRIM(p_email), ''),
    COALESCE(NULLIF(TRIM(p_display_name), ''), v_username),
    crypt(p_password, gen_salt('bf', 12)), 'admin',
    TRUE, v_all_codes, FALSE, NOW(), 'wms_bootstrap_first_admin'
  ) RETURNING id INTO v_user_id;

  INSERT INTO public.wms_bootstrap_state (tenant_id, status, first_admin_user_id, first_admin_username, bootstrapped_at, bootstrap_device_id)
  VALUES (v_tenant.id, 'completed', v_user_id, v_username, NOW(), p_device_id)
  ON CONFLICT (tenant_id) DO UPDATE
    SET status = 'completed', first_admin_user_id = v_user_id, first_admin_username = v_username,
        bootstrapped_at = NOW(), bootstrap_device_id = EXCLUDED.bootstrap_device_id;

  INSERT INTO public.wms_operator_stats (tenant_id, username) VALUES (v_tenant.id, v_username)
  ON CONFLICT (tenant_id, username) DO NOTHING;

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, device_id, details)
  VALUES (v_tenant.id, v_wh.id, v_user_id, v_username, 'ADMIN_BOOTSTRAPPED', 'wms_users', v_user_id::text, p_device_id,
          'First-run administrator bootstrap completed for tenant ' || v_tenant.code);

  SELECT public.wms_authenticate_user_v2(v_username, p_password, v_tenant.code, v_wh.code, p_device_id, p_user_agent) INTO v_session;

  RETURN v_session || jsonb_build_object('bootstrapped', true, 'must_change_password', false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_bootstrap_first_admin(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- Credential rotation (self service, or admin/supervisor assisted reset) ---------
CREATE OR REPLACE FUNCTION public.wms_rotate_operator_password(
  p_session_token TEXT,
  p_tenant_code TEXT,
  p_target_username TEXT,
  p_new_password TEXT,
  p_current_password TEXT DEFAULT NULL,
  p_device_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_ctx RECORD;
  v_target RECORD;
  v_strength JSONB;
  v_self BOOLEAN;
  v_revoked INTEGER := 0;
BEGIN
  SELECT * INTO v_ctx FROM public.wms_assert_context(p_tenant_code, NULL, p_session_token, NULL);

  SELECT id, username, password_hash, role, is_active INTO v_target
  FROM public.wms_users
  WHERE tenant_id = v_ctx.tenant_id AND LOWER(username) = LOWER(TRIM(COALESCE(p_target_username, '')))
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'USER_NOT_FOUND', 'error', 'Operator not found: ' || p_target_username);
  END IF;

  v_self := (v_ctx.user_id IS NOT NULL AND v_ctx.user_id = v_target.id);

  IF NOT v_self THEN
    IF v_ctx.user_role NOT IN ('admin', 'supervisor') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PERMISSION_DENIED', 'error', 'Only the account owner, a supervisor or an admin may rotate this password');
    END IF;
  ELSE
    IF p_current_password IS NULL OR v_target.password_hash <> crypt(p_current_password, v_target.password_hash) THEN
      INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, device_id, details)
      VALUES (v_ctx.tenant_id, NULL, v_target.id, v_target.username, 'PASSWORD_ROTATION_FAILED', 'wms_users', v_target.id::text, p_device_id,
              'Current password did not verify during rotation');
      RETURN jsonb_build_object('ok', false, 'code', 'CURRENT_PASSWORD_INVALID', 'error', 'Current password is incorrect');
    END IF;
  END IF;

  SELECT * INTO v_strength FROM public.wms_validate_password_strength(p_new_password, v_target.username);
  IF NOT COALESCE((v_strength->>'ok')::boolean, FALSE) THEN
    RETURN jsonb_build_object('ok', false, 'code', v_strength->>'code', 'error', v_strength->>'error');
  END IF;

  UPDATE public.wms_users
  SET password_hash = crypt(p_new_password, gen_salt('bf', 12)),
      must_change_password = FALSE,
      password_changed_at = NOW(),
      failed_login_attempts = 0,
      locked_until = NULL,
      updated_at = NOW()
  WHERE id = v_target.id;

  UPDATE public.wms_user_sessions
  SET revoked_at = NOW()
  WHERE user_id = v_target.id AND revoked_at IS NULL
    AND (p_device_id IS NULL OR device_id IS DISTINCT FROM p_device_id);
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, device_id, details)
  VALUES (v_ctx.tenant_id, NULL, v_ctx.user_id, COALESCE(v_ctx.username, 'system'), 'PASSWORD_ROTATED', 'wms_users', v_target.id::text, p_device_id,
          CASE WHEN v_self THEN 'Self-service password rotation' ELSE 'Assisted reset by ' || COALESCE(v_ctx.username, 'admin') END ||
          '; revoked ' || v_revoked || ' other session(s)');

  RETURN jsonb_build_object('ok', true, 'username', v_target.username, 'revoked_sessions', v_revoked, 'must_change_password', false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_rotate_operator_password(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- Surface the rotation flag through the hardened authentication RPC --------------
CREATE OR REPLACE FUNCTION public.wms_authenticate_user_v2(
  p_username TEXT,
  p_password TEXT,
  p_tenant_code TEXT,
  p_warehouse_code TEXT DEFAULT NULL,
  p_device_id TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_user RECORD;
  v_wh RECORD;
  v_raw_token TEXT;
  v_token_hash TEXT;
  v_expires_at TIMESTAMPTZ;
  v_attempts INTEGER;
  v_lock_minutes INTEGER;
BEGIN
  IF p_tenant_code IS NULL OR TRIM(p_tenant_code) = '' THEN
    RETURN jsonb_build_object('authenticated', false, 'code', 'TENANT_REQUIRED', 'error', 'Tenant code is required');
  END IF;

  SELECT
    u.id, u.tenant_id, u.default_warehouse_id, u.username, u.email, u.display_name, u.role,
    u.skill_level, u.current_zone, u.password_hash, u.is_active, u.failed_login_attempts,
    u.locked_until, u.allowed_warehouses, u.must_change_password, u.password_changed_at,
    t.code AS tenant_code
  INTO v_user
  FROM public.wms_users u
  JOIN public.wms_tenants t ON t.id = u.tenant_id
  WHERE LOWER(u.username) = LOWER(TRIM(p_username))
    AND t.code = TRIM(p_tenant_code)
    AND t.status = 'active'
  FOR UPDATE OF u;

  IF NOT FOUND OR NOT v_user.is_active THEN
    RETURN jsonb_build_object('authenticated', false, 'code', 'INVALID_CREDENTIALS', 'error', 'Invalid credentials or inactive account');
  END IF;

  IF v_user.locked_until IS NOT NULL AND v_user.locked_until > NOW() THEN
    INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, device_id, details)
    VALUES (v_user.tenant_id, v_user.default_warehouse_id, v_user.id, v_user.username, 'LOGIN_LOCKED_BLOCKED', 'wms_users', v_user.id::text, p_device_id, 'Blocked login during active lockout window');
    RETURN jsonb_build_object('authenticated', false, 'code', 'ACCOUNT_LOCKED', 'locked_until', v_user.locked_until,
      'error', 'Account temporarily locked due to repeated failed attempts');
  END IF;

  IF v_user.password_hash <> crypt(p_password, v_user.password_hash) THEN
    v_attempts := COALESCE(v_user.failed_login_attempts, 0) + 1;
    IF v_attempts >= 5 THEN
      v_lock_minutes := LEAST(60, 5 * (v_attempts - 4));
      UPDATE public.wms_users
      SET failed_login_attempts = v_attempts, locked_until = NOW() + (v_lock_minutes || ' minutes')::INTERVAL, updated_at = NOW()
      WHERE id = v_user.id;
    ELSE
      UPDATE public.wms_users SET failed_login_attempts = v_attempts, updated_at = NOW() WHERE id = v_user.id;
    END IF;

    INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, device_id, details)
    VALUES (v_user.tenant_id, v_user.default_warehouse_id, v_user.id, v_user.username, 'LOGIN_FAILED', 'wms_users', v_user.id::text, p_device_id,
            'Failed password verification (attempt ' || v_attempts || ')');

    RETURN jsonb_build_object(
      'authenticated', false,
      'code', CASE WHEN v_attempts >= 5 THEN 'ACCOUNT_LOCKED' ELSE 'INVALID_CREDENTIALS' END,
      'remaining_attempts', GREATEST(0, 5 - v_attempts),
      'error', CASE WHEN v_attempts >= 5 THEN 'Account locked after 5 failed attempts' ELSE 'Invalid credentials' END
    );
  END IF;

  IF p_warehouse_code IS NOT NULL AND TRIM(p_warehouse_code) <> '' THEN
    SELECT id, code, name INTO v_wh FROM public.wms_warehouses
    WHERE tenant_id = v_user.tenant_id AND code = TRIM(p_warehouse_code) AND status = 'active' LIMIT 1;
  ELSE
    SELECT id, code, name INTO v_wh FROM public.wms_warehouses
    WHERE id = v_user.default_warehouse_id AND status = 'active' LIMIT 1;
    IF NOT FOUND THEN
      SELECT id, code, name INTO v_wh FROM public.wms_warehouses
      WHERE tenant_id = v_user.tenant_id AND is_default = true AND status = 'active' LIMIT 1;
    END IF;
  END IF;

  IF v_wh.id IS NULL THEN
    RETURN jsonb_build_object('authenticated', false, 'code', 'WAREHOUSE_INVALID', 'error', 'Requested warehouse is invalid or inactive');
  END IF;

  IF v_user.role <> 'admin' AND NOT (v_wh.code = ANY(v_user.allowed_warehouses)) THEN
    INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, device_id, details)
    VALUES (v_user.tenant_id, v_wh.id, v_user.id, v_user.username, 'WAREHOUSE_SCOPE_DENIED', 'wms_warehouses', v_wh.code, p_device_id,
            'User attempted login to unauthorized warehouse ' || v_wh.code);
    RETURN jsonb_build_object('authenticated', false, 'code', 'WAREHOUSE_FORBIDDEN', 'error', 'User is not authorized for warehouse ' || v_wh.code);
  END IF;

  v_raw_token := 'wms_sess_' || encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_raw_token, 'sha256'), 'hex');
  v_expires_at := NOW() + INTERVAL '8 hours';

  UPDATE public.wms_users
  SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW()
  WHERE id = v_user.id;

  INSERT INTO public.wms_user_sessions (tenant_id, user_id, warehouse_id, token_hash, device_id, user_agent, expires_at)
  VALUES (v_user.tenant_id, v_user.id, v_wh.id, v_token_hash, p_device_id, p_user_agent, v_expires_at);

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, device_id, details)
  VALUES (v_user.tenant_id, v_wh.id, v_user.id, v_user.display_name, 'LOGIN_SUCCESS', 'wms_users', v_user.id::text, p_device_id,
          'Issued signed session for warehouse ' || v_wh.code);

  RETURN jsonb_build_object(
    'authenticated', true,
    'session_token', v_raw_token,
    'expires_at', v_expires_at,
    'must_change_password', COALESCE(v_user.must_change_password, FALSE),
    'user', jsonb_build_object(
      'id', v_user.id,
      'tenantId', v_user.tenant_id,
      'tenantCode', v_user.tenant_code,
      'warehouseId', v_wh.id,
      'warehouseCode', v_wh.code,
      'warehouseName', v_wh.name,
      'allowedWarehouses', v_user.allowed_warehouses,
      'username', v_user.username,
      'email', v_user.email,
      'displayName', v_user.display_name,
      'role', v_user.role,
      'skillLevel', v_user.skill_level,
      'currentZone', v_user.current_zone,
      'mustChangePassword', COALESCE(v_user.must_change_password, FALSE),
      'passwordChangedAt', v_user.password_changed_at
    )
  );
END;
$$;

-- Sanitise any legacy "password == username" demo accounts that survived an upgrade.
DO $$
DECLARE
  v_tenant RECORD;
  v_demo TEXT[] := ARRAY['admin', 'operator', 'supervisor', 'viewer', 'auditor', 'VINOVJ', 'demo', 'test'];
  v_flagged INTEGER := 0;
  v_disabled INTEGER := 0;
BEGIN
  FOR v_tenant IN SELECT id, code FROM public.wms_tenants LOOP
    -- Every account is scoped to the warehouses that actually exist for its tenant.
    UPDATE public.wms_users u
    SET allowed_warehouses = COALESCE(
          (SELECT array_agg(w.code ORDER BY w.code) FROM public.wms_warehouses w WHERE w.tenant_id = u.tenant_id AND w.status = 'active'),
          ARRAY['DXB-FC1']::TEXT[]
        )
    WHERE u.tenant_id = v_tenant.id;

    UPDATE public.wms_users
    SET must_change_password = TRUE, updated_at = NOW()
    WHERE tenant_id = v_tenant.id
      AND (username = ANY(v_demo) OR LOWER(username) = ANY(ARRAY['admin', 'operator', 'supervisor', 'vinovj', 'demo', 'test']))
      AND must_change_password = FALSE;
    GET DIAGNOSTICS v_flagged = ROW_COUNT;

    -- Never-used demo accounts are deactivated outright: they can only be
    -- re-enabled by an administrator who also rotates the credential.
    UPDATE public.wms_users
    SET is_active = FALSE, must_change_password = TRUE, updated_at = NOW()
    WHERE tenant_id = v_tenant.id
      AND last_login_at IS NULL
      AND (username = ANY(v_demo) OR LOWER(username) = ANY(ARRAY['admin', 'operator', 'supervisor', 'vinovj', 'demo', 'test']));
    GET DIAGNOSTICS v_disabled = ROW_COUNT;

    IF v_flagged > 0 OR v_disabled > 0 THEN
      INSERT INTO public.wms_audit_logs (tenant_id, operator_name, action, entity_type, details)
      VALUES (v_tenant.id, 'Migration 008', 'DEMO_CREDENTIALS_SANITISED', 'wms_users',
              'Flagged ' || v_flagged || ' legacy demo account(s) for mandatory rotation; deactivated ' || v_disabled || ' never-used demo account(s)');
    END IF;
  END LOOP;
END;
$$;

-- =============================================================================
-- D. LEASED, OBSERVABLE TRANSACTIONAL OUTBOX
-- =============================================================================
ALTER TABLE public.wms_event_outbox
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_endpoints TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  ADD COLUMN IF NOT EXISTS target_endpoint_id UUID,
  ADD COLUMN IF NOT EXISTS response_code INTEGER;

CREATE INDEX IF NOT EXISTS idx_wms_outbox_claimable
  ON public.wms_event_outbox (status, next_retry_at, lease_until, created_at);
CREATE INDEX IF NOT EXISTS idx_wms_outbox_dead_letter
  ON public.wms_event_outbox (tenant_id, status) WHERE status IN ('failed', 'dead_letter');

-- Atomic lease claiming: concurrent Edge invocations / browser tabs never
-- process the same event twice (FOR UPDATE SKIP LOCKED + bounded lease time).
CREATE OR REPLACE FUNCTION public.wms_claim_outbox_batch(
  p_owner TEXT,
  p_batch_limit INTEGER DEFAULT 25,
  p_lease_seconds INTEGER DEFAULT 60,
  p_tenant_code TEXT DEFAULT NULL,
  p_event_types TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_owner TEXT := COALESCE(NULLIF(TRIM(p_owner), ''), 'edge-' || encode(gen_random_bytes(6), 'hex'));
  v_limit INTEGER := LEAST(200, GREATEST(1, COALESCE(p_batch_limit, 25)));
  v_lease INTEGER := LEAST(600, GREATEST(5, COALESCE(p_lease_seconds, 60)));
  v_tenant_id UUID;
  v_rows JSONB;
  v_count INTEGER;
BEGIN
  IF p_tenant_code IS NOT NULL AND TRIM(p_tenant_code) <> '' THEN
    SELECT id INTO v_tenant_id FROM public.wms_tenants WHERE code = TRIM(p_tenant_code) LIMIT 1;
    IF v_tenant_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TENANT_INVALID', 'error', 'Tenant not found: ' || p_tenant_code);
    END IF;
  END IF;

  WITH claimable AS (
    SELECT e.id
    FROM public.wms_event_outbox e
    WHERE e.status IN ('pending', 'processing')
      AND (e.lease_until IS NULL OR e.lease_until < NOW())
      AND (e.next_retry_at IS NULL OR e.next_retry_at <= NOW())
      AND (v_tenant_id IS NULL OR e.tenant_id = v_tenant_id)
      AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
    ORDER BY e.created_at ASC
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.wms_event_outbox e
    SET status = 'processing',
        lease_owner = v_owner,
        lease_until = NOW() + make_interval(secs => v_lease),
        last_attempt_at = NOW()
    FROM claimable c
    WHERE e.id = c.id
    RETURNING e.id, e.tenant_id, e.warehouse_id, e.aggregate_type, e.aggregate_id,
              e.event_type, e.payload, e.idempotency_key, e.retry_count, e.created_at,
              e.lease_owner, e.lease_until
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', c.id,
      'tenant_id', c.tenant_id,
      'warehouse_id', c.warehouse_id,
      'aggregate_type', c.aggregate_type,
      'aggregate_id', c.aggregate_id,
      'event_type', c.event_type,
      'payload', c.payload,
      'idempotency_key', c.idempotency_key,
      'retry_count', c.retry_count,
      'created_at', c.created_at,
      'lease_owner', c.lease_owner,
      'lease_until', c.lease_until
    ) ORDER BY c.created_at), '[]'::jsonb),
    COUNT(*)
  INTO v_rows, v_count
  FROM claimed c;

  RETURN jsonb_build_object('ok', true, 'owner', v_owner, 'lease_seconds', v_lease,
                            'claimed', COALESCE(v_count, 0), 'events', COALESCE(v_rows, '[]'::jsonb));
END;
$$;

-- Report the delivery outcome of a single leased event (publish / retry / DLQ).
CREATE OR REPLACE FUNCTION public.wms_complete_outbox_event(
  p_event_id UUID,
  p_status TEXT,
  p_owner TEXT DEFAULT NULL,
  p_error TEXT DEFAULT NULL,
  p_endpoint TEXT DEFAULT NULL,
  p_response_code INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_event RECORD;
  v_status TEXT := LOWER(TRIM(COALESCE(p_status, 'published')));
  v_retry INTEGER;
  v_backoff INTERVAL;
BEGIN
  IF v_status NOT IN ('published', 'pending', 'failed', 'dead_letter') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATUS', 'error', 'Status must be published, pending, failed or dead_letter');
  END IF;

  SELECT * INTO v_event FROM public.wms_event_outbox WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EVENT_NOT_FOUND', 'error', 'Outbox event not found');
  END IF;

  -- A stale lease may only be finalised by its owner (or after the lease expired).
  IF v_event.lease_owner IS NOT NULL AND p_owner IS NOT NULL
     AND v_event.lease_owner <> p_owner AND v_event.lease_until > NOW() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LEASE_CONFLICT', 'error', 'Event is leased by another worker');
  END IF;

  IF v_status = 'published' THEN
    UPDATE public.wms_event_outbox
    SET status = 'published',
        published_at = NOW(),
        lease_owner = NULL,
        lease_until = NULL,
        next_retry_at = NULL,
        error_message = NULL,
        response_code = COALESCE(p_response_code, response_code),
        delivered_endpoints = CASE
          WHEN p_endpoint IS NULL THEN delivered_endpoints
          WHEN p_endpoint = ANY(delivered_endpoints) THEN delivered_endpoints
          ELSE array_append(delivered_endpoints, p_endpoint)
        END
    WHERE id = p_event_id;
    RETURN jsonb_build_object('ok', true, 'event_id', p_event_id, 'status', 'published');
  END IF;

  v_retry := v_event.retry_count + 1;

  IF v_status = 'dead_letter' OR v_retry >= 8 THEN
    UPDATE public.wms_event_outbox
    SET status = 'dead_letter',
        lease_owner = NULL,
        lease_until = NULL,
        next_retry_at = NULL,
        retry_count = v_retry,
        response_code = COALESCE(p_response_code, response_code),
        error_message = LEFT(COALESCE(p_error, 'Max retry budget exhausted'), 1000)
    WHERE id = p_event_id;

    INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, operator_name, action, entity_type, entity_id, details)
    VALUES (v_event.tenant_id, v_event.warehouse_id, 'outbox-worker', 'OUTBOX_DEAD_LETTER', 'wms_event_outbox', v_event.id::text,
            v_event.event_type || ' ' || COALESCE(v_event.aggregate_id, '') || ' moved to DLQ after ' || v_retry || ' attempts');

    RETURN jsonb_build_object('ok', true, 'event_id', p_event_id, 'status', 'dead_letter', 'retry_count', v_retry);
  END IF;

  -- Exponential backoff with jitter: 5s, 10s, 20s ... capped at 5 minutes
  v_backoff := make_interval(secs => LEAST(300, 5 * power(2, GREATEST(0, v_retry - 1))::int));
  UPDATE public.wms_event_outbox
  SET status = 'failed',
      lease_owner = NULL,
      lease_until = NULL,
      retry_count = v_retry,
      next_retry_at = NOW() + v_backoff,
      response_code = COALESCE(p_response_code, response_code),
      error_message = LEFT(COALESCE(p_error, 'delivery failed'), 1000)
  WHERE id = p_event_id;

  RETURN jsonb_build_object('ok', true, 'event_id', p_event_id, 'status', 'failed',
                            'retry_count', v_retry, 'next_retry_in_seconds', EXTRACT(EPOCH FROM v_backoff));
END;
$$;

-- Observability snapshot consumed by /wms-api?action=metrics and the Cloud page.
CREATE OR REPLACE FUNCTION public.wms_get_outbox_metrics(p_tenant_code TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_tenant_id UUID;
  v_out JSONB;
BEGIN
  IF p_tenant_code IS NOT NULL AND TRIM(p_tenant_code) <> '' THEN
    SELECT id INTO v_tenant_id FROM public.wms_tenants WHERE code = TRIM(p_tenant_code) LIMIT 1;
  END IF;

  SELECT jsonb_build_object(
    'pending',      COUNT(*) FILTER (WHERE status = 'pending'),
    'processing',   COUNT(*) FILTER (WHERE status = 'processing'),
    'published',    COUNT(*) FILTER (WHERE status = 'published'),
    'failed',       COUNT(*) FILTER (WHERE status = 'failed'),
    'dead_letter',  COUNT(*) FILTER (WHERE status = 'dead_letter'),
    'leased',       COUNT(*) FILTER (WHERE lease_until IS NOT NULL AND lease_until > NOW()),
    'stale_leases', COUNT(*) FILTER (WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until < NOW()),
    'due_for_retry',COUNT(*) FILTER (WHERE status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW()),
    'oldest_pending_seconds', COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status IN ('pending','processing'))))::bigint, 0)
  ) INTO v_out
  FROM public.wms_event_outbox
  WHERE v_tenant_id IS NULL OR tenant_id = v_tenant_id;

  RETURN COALESCE(v_out, '{}'::jsonb) || jsonb_build_object('ok', true, 'generated_at', NOW());
END;
$$;

-- Idempotent marketplace webhook ingestion (duplicate event_id -> deduplicated) ---
CREATE OR REPLACE FUNCTION public.wms_ingest_webhook(
  p_source TEXT,
  p_event_id TEXT,
  p_event_type TEXT,
  p_payload JSONB,
  p_tenant_code TEXT DEFAULT 'YESI-FZCO',
  p_warehouse_code TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_tenant_id UUID;
  v_wh_id UUID;
  v_existing RECORD;
  v_row_id UUID;
BEGIN
  IF COALESCE(TRIM(p_event_id), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EVENT_ID_REQUIRED', 'error', 'A provider event_id is required for deduplication');
  END IF;

  SELECT id INTO v_tenant_id FROM public.wms_tenants WHERE code = TRIM(COALESCE(p_tenant_code, 'YESI-FZCO')) LIMIT 1;
  IF v_tenant_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TENANT_INVALID', 'error', 'Tenant not found');
  END IF;

  SELECT id INTO v_existing FROM public.wms_webhook_inbox
  WHERE tenant_id = v_tenant_id AND source = TRIM(COALESCE(p_source, 'unknown')) AND event_id = TRIM(p_event_id)
  FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'deduplicated', true, 'event_id', TRIM(p_event_id),
      'message', 'Event already ingested; no side effects applied');
  END IF;

  IF p_warehouse_code IS NOT NULL AND TRIM(p_warehouse_code) <> '' THEN
    SELECT id INTO v_wh_id FROM public.wms_warehouses
    WHERE tenant_id = v_tenant_id AND code = TRIM(p_warehouse_code) AND status = 'active' LIMIT 1;
  END IF;
  IF v_wh_id IS NULL THEN
    SELECT id INTO v_wh_id FROM public.wms_warehouses WHERE tenant_id = v_tenant_id AND is_default = true LIMIT 1;
  END IF;

  INSERT INTO public.wms_webhook_inbox (tenant_id, source, event_id, event_type, payload, status)
  VALUES (v_tenant_id, TRIM(COALESCE(p_source, 'unknown')), TRIM(p_event_id),
          TRIM(COALESCE(p_event_type, 'unknown')), COALESCE(p_payload, '{}'::jsonb), 'received')
  RETURNING id INTO v_row_id;

  INSERT INTO public.wms_event_outbox (tenant_id, warehouse_id, aggregate_type, aggregate_id, event_type, idempotency_key, payload)
  VALUES (v_tenant_id, v_wh_id, 'webhook', TRIM(p_event_id), 'WEBHOOK_' || UPPER(TRIM(COALESCE(p_event_type, 'unknown'))),
          'webhook:' || TRIM(COALESCE(p_source, 'unknown')) || ':' || TRIM(p_event_id),
          COALESCE(p_payload, '{}'::jsonb))
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object('ok', true, 'deduplicated', false, 'inbox_id', v_row_id, 'event_id', TRIM(p_event_id));
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_claim_outbox_batch(TEXT, INTEGER, INTEGER, TEXT, TEXT[]) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wms_complete_outbox_event(UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wms_get_outbox_metrics(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wms_ingest_webhook(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT) TO anon, authenticated, service_role;

-- =============================================================================
-- E. OPERATIONAL TELEMETRY
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.wms_operational_telemetry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID REFERENCES public.wms_warehouses(id) ON DELETE SET NULL,
  device_id TEXT,
  session_id TEXT,
  metric_name TEXT NOT NULL,
  metric_value NUMERIC(16, 4) NOT NULL,
  metric_unit TEXT NOT NULL DEFAULT 'count',
  labels JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_ts TIMESTAMPTZ,
  server_ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wms_telemetry_metric ON public.wms_operational_telemetry(tenant_id, metric_name, server_ts DESC);
CREATE INDEX IF NOT EXISTS idx_wms_telemetry_wh ON public.wms_operational_telemetry(warehouse_id, server_ts DESC);

ALTER TABLE public.wms_operational_telemetry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wms_telemetry_floor_write ON public.wms_operational_telemetry;
CREATE POLICY wms_telemetry_floor_write ON public.wms_operational_telemetry
  FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS wms_telemetry_floor_read ON public.wms_operational_telemetry;
CREATE POLICY wms_telemetry_floor_read ON public.wms_operational_telemetry
  FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS wms_telemetry_service_all ON public.wms_operational_telemetry;
CREATE POLICY wms_telemetry_service_all ON public.wms_operational_telemetry
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION public.wms_record_telemetry(
  p_batch JSONB,
  p_tenant_code TEXT DEFAULT 'YESI-FZCO',
  p_warehouse_code TEXT DEFAULT NULL,
  p_device_id TEXT DEFAULT NULL,
  p_session_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_tenant_id UUID;
  v_wh_id UUID;
  v_rows JSONB;
  v_inserted INTEGER := 0;
BEGIN
  SELECT id INTO v_tenant_id FROM public.wms_tenants WHERE code = TRIM(COALESCE(p_tenant_code, 'YESI-FZCO')) LIMIT 1;
  IF v_tenant_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TENANT_INVALID', 'error', 'Tenant not found');
  END IF;

  IF p_warehouse_code IS NOT NULL AND TRIM(p_warehouse_code) <> '' THEN
    SELECT id INTO v_wh_id FROM public.wms_warehouses
    WHERE tenant_id = v_tenant_id AND code = TRIM(p_warehouse_code) LIMIT 1;
  END IF;

  v_rows := CASE WHEN jsonb_typeof(p_batch) = 'array' THEN p_batch ELSE jsonb_build_array(p_batch) END;

  INSERT INTO public.wms_operational_telemetry (
    tenant_id, warehouse_id, device_id, session_id, metric_name, metric_value, metric_unit, labels, client_ts
  )
  SELECT
    v_tenant_id,
    COALESCE(
      (SELECT w.id FROM public.wms_warehouses w
        WHERE w.tenant_id = v_tenant_id
          AND w.code = NULLIF(TRIM(r->>'warehouse_code'), '')
        LIMIT 1),
      v_wh_id
    ),
    COALESCE(NULLIF(TRIM(r->>'device_id'), ''), p_device_id),
    COALESCE(NULLIF(TRIM(r->>'session_id'), ''), p_session_id),
    LEFT(TRIM(COALESCE(r->>'metric', r->>'metric_name', 'unknown')), 120),
    COALESCE((r->>'value')::numeric, (r->>'metric_value')::numeric, 0),
    COALESCE(NULLIF(TRIM(r->>'unit'), ''), 'count'),
    COALESCE(r->'labels', '{}'::jsonb),
    CASE WHEN r->>'ts' IS NULL THEN NOW() ELSE to_timestamp((r->>'ts')::double precision / 1000.0) END
  FROM jsonb_array_elements(v_rows) AS r
  WHERE COALESCE(r->>'metric', r->>'metric_name', '') <> '';

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'inserted', v_inserted);
END;
$$;

CREATE OR REPLACE FUNCTION public.wms_purge_telemetry(p_retention_days INTEGER DEFAULT 14)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.wms_operational_telemetry
  WHERE server_ts < NOW() - make_interval(days => GREATEST(1, COALESCE(p_retention_days, 14)));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'purged', v_deleted);
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_record_telemetry(JSONB, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.wms_purge_telemetry(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wms_purge_telemetry(INTEGER) TO service_role;

-- =============================================================================
-- E2. Upgraded KPI view (existing columns preserved, operational KPIs appended)
-- =============================================================================
CREATE OR REPLACE VIEW public.v_wms_kpi_summary AS
SELECT
  w.tenant_id,
  w.id AS warehouse_id,
  w.code AS warehouse_code,
  w.name AS warehouse_name,
  COALESCE((SELECT COUNT(*) FROM public.wms_skus s WHERE s.tenant_id = w.tenant_id AND s.is_active), 0) AS active_skus,
  COALESCE((SELECT SUM(b.on_hand_qty) FROM public.wms_inventory_balances b WHERE b.warehouse_id = w.id), 0) AS total_on_hand,
  COALESCE((SELECT SUM(b.reserved_qty) FROM public.wms_inventory_balances b WHERE b.warehouse_id = w.id), 0) AS total_reserved,
  COALESCE((SELECT SUM(b.available_qty) FROM public.wms_inventory_balances b WHERE b.warehouse_id = w.id), 0) AS total_available,
  COALESCE((
    SELECT COUNT(*)
    FROM public.wms_skus s
    LEFT JOIN (
      SELECT sku_code, SUM(available_qty) AS avail
      FROM public.wms_inventory_balances
      WHERE warehouse_id = w.id
      GROUP BY sku_code
    ) sb ON sb.sku_code = s.sku_code
    WHERE s.tenant_id = w.tenant_id AND COALESCE(sb.avail, 0) <= s.reorder_point
  ), 0) AS low_stock_skus,
  COALESCE((SELECT COUNT(*) FROM public.wms_sales_orders o WHERE o.warehouse_id = w.id AND o.status IN ('Pending', 'Allocated', 'Picking', 'Packed', 'ReadyToShip')), 0) AS open_orders,
  COALESCE((SELECT COUNT(*) FROM public.wms_sales_orders o WHERE o.warehouse_id = w.id AND o.status IN ('Shipped', 'Delivered')), 0) AS shipped_orders,
  COALESCE((SELECT COUNT(*) FROM public.wms_pick_tasks p WHERE p.warehouse_id = w.id AND p.status IN ('pending', 'in_progress')), 0) AS open_pick_tasks,
  COALESCE((SELECT COUNT(*) FROM public.wms_putaway_tasks pt WHERE pt.warehouse_id = w.id AND pt.status IN ('pending', 'assigned', 'in_progress')), 0) AS open_putaway_tasks,
  COALESCE((SELECT COUNT(*) FROM public.wms_qc_inspections q WHERE q.warehouse_id = w.id AND q.status = 'hold'), 0) AS active_qc_holds,
  COALESCE((SELECT COUNT(*) FROM public.wms_returns r WHERE r.warehouse_id = w.id), 0) AS total_returns,
  COALESCE((SELECT COUNT(*) FROM public.wms_event_outbox e WHERE e.tenant_id = w.tenant_id AND e.status = 'pending'), 0) AS outbox_pending,
  -- Strict "today" boundary in the operating company's timezone (never all-time shipped)
  COALESCE((
    SELECT COUNT(*)
    FROM public.wms_sales_orders o
    WHERE o.warehouse_id = w.id
      AND o.shipped_at IS NOT NULL
      AND (o.shipped_at AT TIME ZONE COALESCE(c.timezone, 'UTC'))::date = (NOW() AT TIME ZONE COALESCE(c.timezone, 'UTC'))::date
  ), 0) AS shipped_today,
  COALESCE((SELECT COUNT(*) FROM public.wms_event_outbox e WHERE e.tenant_id = w.tenant_id AND e.status = 'dead_letter'), 0) AS outbox_dead_letter,
  COALESCE((
    SELECT COUNT(*)
    FROM public.wms_audit_logs a
    WHERE a.warehouse_id = w.id
      AND a.action IN ('ALLOCATION_CONFLICT', 'PICK_SCAN_MISMATCH')
      AND a.created_at >= NOW() - INTERVAL '24 hours'
  ), 0) AS allocation_conflicts,
  COALESCE((
    SELECT ROUND(AVG(t.metric_value), 2)
    FROM public.wms_operational_telemetry t
    WHERE t.warehouse_id = w.id
      AND t.metric_name IN ('sync.latency_ms', 'rpc.latency_ms')
      AND t.server_ts >= NOW() - INTERVAL '1 hour'
  ), 0) AS avg_sync_latency_ms,
  COALESCE((SELECT SUM(b.on_hand_qty) FROM public.wms_inventory_balances b WHERE b.warehouse_id = w.id AND b.stock_status = 'QUARANTINE'), 0) AS quarantine_units,
  COALESCE((SELECT COUNT(DISTINCT b.location_code) FROM public.wms_inventory_balances b WHERE b.warehouse_id = w.id AND b.on_hand_qty > 0), 0) AS active_bins
FROM public.wms_warehouses w
LEFT JOIN public.wms_companies c ON c.id = w.company_id;

GRANT SELECT ON public.v_wms_kpi_summary TO anon, authenticated, service_role;

-- =============================================================================
-- F. Second-warehouse topology (warehouse isolation must be physically real)
-- =============================================================================
DO $$
DECLARE
  v_tenant_id UUID;
  v_shj_id UUID;
BEGIN
  SELECT id INTO v_tenant_id FROM public.wms_tenants WHERE code = 'YESI-FZCO' LIMIT 1;
  SELECT id INTO v_shj_id FROM public.wms_warehouses WHERE code = 'SHJ-HUB2' AND tenant_id = v_tenant_id LIMIT 1;
  IF v_tenant_id IS NULL OR v_shj_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.wms_zones (tenant_id, warehouse_id, zone_code, name, zone_type, category_target, velocity_target, max_capacity) VALUES
    (v_tenant_id, v_shj_id, 'SHJ-RECV',   'Sharjah Inbound Cross-Dock Dock',      'receiving', 'Inbound',   'high',   200),
    (v_tenant_id, v_shj_id, 'SHJ-PICK-A', 'Sharjah Consolidation Pick Zone A',    'pick',      'Phones',    'high',   250),
    (v_tenant_id, v_shj_id, 'SHJ-PICK-B', 'Sharjah Consolidation Pick Zone B',    'pick',      'Wearables', 'medium', 200),
    (v_tenant_id, v_shj_id, 'SHJ-STAGE',  'Sharjah Outbound Staging & Manifest',  'staging',   'Staging',   'high',   150)
  ON CONFLICT (warehouse_id, zone_code) DO NOTHING;

  INSERT INTO public.wms_locations (tenant_id, warehouse_id, location_code, zone_code, aisle, rack, shelf, bin, bin_type, pick_sequence, max_units) VALUES
    (v_tenant_id, v_shj_id, 'SHJ-RECV-01',   'SHJ-RECV',   'DOCK', '01', '01', '01', 'dock',     1, 400),
    (v_tenant_id, v_shj_id, 'SHJ-A-01-01-01','SHJ-PICK-A', 'A',    '01', '01', '01', 'shelf',   10, 150),
    (v_tenant_id, v_shj_id, 'SHJ-A-01-02-01','SHJ-PICK-A', 'A',    '01', '02', '01', 'shelf',   12, 150),
    (v_tenant_id, v_shj_id, 'SHJ-A-02-01-01','SHJ-PICK-A', 'A',    '02', '01', '01', 'shelf',   14, 150),
    (v_tenant_id, v_shj_id, 'SHJ-B-01-01-01','SHJ-PICK-B', 'B',    '01', '01', '01', 'shelf',   25, 120),
    (v_tenant_id, v_shj_id, 'SHJ-B-01-02-01','SHJ-PICK-B', 'B',    '01', '02', '01', 'shelf',   27, 120),
    (v_tenant_id, v_shj_id, 'SHJ-STAGE-01',  'SHJ-STAGE',  'STG',  '01', '01', '01', 'staging', 90, 200)
  ON CONFLICT (warehouse_id, location_code) DO NOTHING;

  INSERT INTO public.wms_locations (tenant_id, warehouse_id, location_code, zone_code, aisle, rack, shelf, bin, bin_type, pick_sequence, max_units)
  SELECT v_tenant_id, v_shj_id, 'PACK-STAGE-01', 'SHJ-STAGE', 'STG', '01', '01', '02', 'staging', 92, 200
  WHERE NOT EXISTS (SELECT 1 FROM public.wms_locations WHERE warehouse_id = v_shj_id AND location_code = 'PACK-STAGE-01')
  ON CONFLICT (warehouse_id, location_code) DO NOTHING;
END;
$$;

-- =============================================================================
-- G. Realtime publication for the new operational tables
-- =============================================================================
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['wms_command_idempotency', 'wms_bootstrap_state', 'wms_reservations']
  LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = tbl
    ) THEN
      BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I;', tbl);
      EXCEPTION WHEN OTHERS THEN
        NULL; -- publication membership is best-effort on managed platforms
      END;
    END IF;
  END LOOP;
END;
$$;

GRANT SELECT ON public.wms_operational_telemetry TO anon, authenticated;
GRANT INSERT ON public.wms_operational_telemetry TO anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
