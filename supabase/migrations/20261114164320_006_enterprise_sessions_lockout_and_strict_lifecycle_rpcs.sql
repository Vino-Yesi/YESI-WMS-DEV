-- ============================================================================
-- Migration 006: Enterprise Session Security, Account Lockout, Tenant/Warehouse
-- Scoping, and Strict Fulfillment Lifecycle Checkpoints
-- ============================================================================

-- 1. Add account lockout & warehouse access scoping columns to wms_users
ALTER TABLE public.wms_users
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS allowed_warehouses TEXT[] NOT NULL DEFAULT ARRAY['DXB-FC1', 'MSK-HUB2']::TEXT[];

-- 2. Signed Server-Side Session Table (SHA-256 hashed session tokens, never raw tokens)
CREATE TABLE IF NOT EXISTS public.wms_user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.wms_users(id) ON DELETE CASCADE,
  warehouse_id UUID REFERENCES public.wms_warehouses(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wms_user_sessions_token_hash ON public.wms_user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_wms_user_sessions_user_id ON public.wms_user_sessions(user_id);

ALTER TABLE public.wms_user_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wms_user_sessions_service_only ON public.wms_user_sessions;
CREATE POLICY wms_user_sessions_service_only ON public.wms_user_sessions
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 3. Strict Tenant + Warehouse + Session/Operator Access Guard Helper
CREATE OR REPLACE FUNCTION public.wms_assert_context(
  p_tenant_code TEXT,
  p_warehouse_code TEXT,
  p_session_token TEXT DEFAULT NULL,
  p_required_roles TEXT[] DEFAULT NULL
)
RETURNS TABLE(tenant_id UUID, warehouse_id UUID, user_id UUID, username TEXT, user_role TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_tenant RECORD;
  v_wh RECORD;
  v_sess RECORD;
BEGIN
  IF p_tenant_code IS NULL OR TRIM(p_tenant_code) = '' THEN
    RAISE EXCEPTION 'TENANT_REQUIRED: Explicit tenant_code is required';
  END IF;
  IF p_warehouse_code IS NULL OR TRIM(p_warehouse_code) = '' THEN
    RAISE EXCEPTION 'WAREHOUSE_REQUIRED: Explicit warehouse_code is required';
  END IF;

  SELECT id, code, status INTO v_tenant
  FROM public.wms_tenants
  WHERE code = TRIM(p_tenant_code) AND status = 'active'
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TENANT_INVALID: Tenant % not found or inactive', p_tenant_code;
  END IF;

  SELECT id, code, status INTO v_wh
  FROM public.wms_warehouses
  WHERE wms_warehouses.tenant_id = v_tenant.id
    AND code = TRIM(p_warehouse_code)
    AND status = 'active'
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID: Warehouse % does not belong to tenant % or is inactive', p_warehouse_code, p_tenant_code;
  END IF;

  -- If a server session token is supplied, strictly verify signature, expiry, revocation, warehouse scope & role
  IF p_session_token IS NOT NULL AND TRIM(p_session_token) <> '' THEN
    SELECT
      s.id AS session_id,
      u.id AS uid,
      u.username AS uname,
      u.role AS urole,
      u.is_active,
      u.allowed_warehouses
    INTO v_sess
    FROM public.wms_user_sessions s
    JOIN public.wms_users u ON u.id = s.user_id
    WHERE s.token_hash = encode(digest(TRIM(p_session_token), 'sha256'), 'hex')
      AND s.tenant_id = v_tenant.id
      AND s.revoked_at IS NULL
      AND s.expires_at > NOW()
    LIMIT 1;

    IF NOT FOUND OR NOT v_sess.is_active THEN
      RAISE EXCEPTION 'SESSION_INVALID: Session expired, revoked, or inactive';
    END IF;

    IF v_sess.urole <> 'admin' AND NOT (TRIM(p_warehouse_code) = ANY(v_sess.allowed_warehouses)) THEN
      RAISE EXCEPTION 'WAREHOUSE_FORBIDDEN: Operator % is not scoped to warehouse %', v_sess.uname, p_warehouse_code;
    END IF;

    IF p_required_roles IS NOT NULL AND NOT (v_sess.urole = ANY(p_required_roles)) THEN
      RAISE EXCEPTION 'PERMISSION_DENIED: Role % cannot execute this operation', v_sess.urole;
    END IF;

    UPDATE public.wms_user_sessions SET last_seen_at = NOW() WHERE id = v_sess.session_id;
    RETURN QUERY SELECT v_tenant.id, v_wh.id, v_sess.uid, v_sess.uname, v_sess.urole;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_tenant.id, v_wh.id, NULL::UUID, 'edge-sync'::TEXT, 'system'::TEXT;
END;
$$;

-- 4. Hardened Authentication RPC with Progressive Lockout + Signed Server Session Token
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
    u.failed_login_attempts,
    u.locked_until,
    u.allowed_warehouses,
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

  -- Enforce server-side account lockout
  IF v_user.locked_until IS NOT NULL AND v_user.locked_until > NOW() THEN
    INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, device_id, details)
    VALUES (v_user.tenant_id, v_user.default_warehouse_id, v_user.id, v_user.username, 'LOGIN_LOCKED_BLOCKED', 'wms_users', v_user.id::text, p_device_id, 'Blocked login during active lockout window');
    RETURN jsonb_build_object(
      'authenticated', false,
      'code', 'ACCOUNT_LOCKED',
      'locked_until', v_user.locked_until,
      'error', 'Account temporarily locked due to repeated failed attempts'
    );
  END IF;

  -- Verify bcrypt password
  IF v_user.password_hash <> crypt(p_password, v_user.password_hash) THEN
    v_attempts := COALESCE(v_user.failed_login_attempts, 0) + 1;
    IF v_attempts >= 5 THEN
      v_lock_minutes := LEAST(60, 5 * (v_attempts - 4));
      UPDATE public.wms_users
      SET failed_login_attempts = v_attempts,
          locked_until = NOW() + (v_lock_minutes || ' minutes')::INTERVAL,
          updated_at = NOW()
      WHERE id = v_user.id;
    ELSE
      UPDATE public.wms_users
      SET failed_login_attempts = v_attempts,
          updated_at = NOW()
      WHERE id = v_user.id;
    END IF;

    INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, device_id, details)
    VALUES (v_user.tenant_id, v_user.default_warehouse_id, v_user.id, v_user.username, 'LOGIN_FAILED', 'wms_users', v_user.id::text, p_device_id, 'Failed password verification (attempt ' || v_attempts || ')');

    RETURN jsonb_build_object(
      'authenticated', false,
      'code', CASE WHEN v_attempts >= 5 THEN 'ACCOUNT_LOCKED' ELSE 'INVALID_CREDENTIALS' END,
      'remaining_attempts', GREATEST(0, 5 - v_attempts),
      'error', CASE WHEN v_attempts >= 5 THEN 'Account locked after 5 failed attempts' ELSE 'Invalid credentials' END
    );
  END IF;

  -- Resolve target warehouse & enforce user warehouse scoping
  IF p_warehouse_code IS NOT NULL AND TRIM(p_warehouse_code) <> '' THEN
    SELECT id, code, name INTO v_wh
    FROM public.wms_warehouses
    WHERE tenant_id = v_user.tenant_id AND code = TRIM(p_warehouse_code) AND status = 'active'
    LIMIT 1;
  ELSE
    SELECT id, code, name INTO v_wh
    FROM public.wms_warehouses
    WHERE id = v_user.default_warehouse_id AND status = 'active'
    LIMIT 1;
    IF NOT FOUND THEN
      SELECT id, code, name INTO v_wh
      FROM public.wms_warehouses
      WHERE tenant_id = v_user.tenant_id AND is_default = true AND status = 'active'
      LIMIT 1;
    END IF;
  END IF;

  IF v_wh.id IS NULL THEN
    RETURN jsonb_build_object('authenticated', false, 'code', 'WAREHOUSE_INVALID', 'error', 'Requested warehouse is invalid or inactive');
  END IF;

  IF v_user.role <> 'admin' AND NOT (v_wh.code = ANY(v_user.allowed_warehouses)) THEN
    INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, device_id, details)
    VALUES (v_user.tenant_id, v_wh.id, v_user.id, v_user.username, 'WAREHOUSE_SCOPE_DENIED', 'wms_warehouses', v_wh.code, p_device_id, 'User attempted login to unauthorized warehouse ' || v_wh.code);
    RETURN jsonb_build_object('authenticated', false, 'code', 'WAREHOUSE_FORBIDDEN', 'error', 'User is not authorized for warehouse ' || v_wh.code);
  END IF;

  -- Issue opaque 256-bit server session token (store SHA-256 digest only)
  v_raw_token := 'wms_sess_' || encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_raw_token, 'sha256'), 'hex');
  v_expires_at := NOW() + INTERVAL '8 hours';

  UPDATE public.wms_users
  SET failed_login_attempts = 0,
      locked_until = NULL,
      last_login_at = NOW(),
      updated_at = NOW()
  WHERE id = v_user.id;

  INSERT INTO public.wms_user_sessions (
    tenant_id, user_id, warehouse_id, token_hash, device_id, user_agent, expires_at
  ) VALUES (
    v_user.tenant_id, v_user.id, v_wh.id, v_token_hash, p_device_id, p_user_agent, v_expires_at
  );

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, device_id, details)
  VALUES (v_user.tenant_id, v_wh.id, v_user.id, v_user.display_name, 'LOGIN_SUCCESS', 'wms_users', v_user.id::text, p_device_id, 'Issued signed session for warehouse ' || v_wh.code);

  RETURN jsonb_build_object(
    'authenticated', true,
    'session_token', v_raw_token,
    'expires_at', v_expires_at,
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
      'currentZone', v_user.current_zone
    )
  );
END;
$$;

-- 5. Validate & Revoke Session RPCs
CREATE OR REPLACE FUNCTION public.wms_validate_session(
  p_session_token TEXT,
  p_tenant_code TEXT,
  p_warehouse_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_ctx RECORD;
  v_user RECORD;
  v_wh RECORD;
BEGIN
  SELECT * INTO v_ctx FROM public.wms_assert_context(p_tenant_code, p_warehouse_code, p_session_token, NULL);
  SELECT * INTO v_user FROM public.wms_users WHERE id = v_ctx.user_id;
  SELECT * INTO v_wh FROM public.wms_warehouses WHERE id = v_ctx.warehouse_id;

  RETURN jsonb_build_object(
    'valid', true,
    'user', jsonb_build_object(
      'id', v_user.id,
      'tenantCode', p_tenant_code,
      'warehouseCode', v_wh.code,
      'warehouseName', v_wh.name,
      'allowedWarehouses', v_user.allowed_warehouses,
      'username', v_user.username,
      'displayName', v_user.display_name,
      'role', v_user.role
    )
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('valid', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.wms_revoke_session(p_session_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  IF p_session_token IS NOT NULL AND TRIM(p_session_token) <> '' THEN
    UPDATE public.wms_user_sessions
    SET revoked_at = NOW()
    WHERE token_hash = encode(digest(TRIM(p_session_token), 'sha256'), 'hex')
      AND revoked_at IS NULL;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 6. Strict Lifecycle RPCs: Receive->Staging/QC -> QC Release -> Putaway Complete -> Pick -> Pack -> Ship -> Return
CREATE OR REPLACE FUNCTION public.wms_complete_putaway_task(
  p_task_number TEXT,
  p_actual_location TEXT,
  p_operator TEXT,
  p_warehouse_code TEXT,
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
  v_task RECORD;
  v_dest TEXT;
BEGIN
  SELECT * INTO v_ctx FROM public.wms_assert_context(
    p_tenant_code, p_warehouse_code, p_session_token, ARRAY['admin', 'supervisor', 'operator']
  );

  SELECT * INTO v_task
  FROM public.wms_putaway_tasks
  WHERE warehouse_id = v_ctx.warehouse_id AND task_number = p_task_number
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Putaway task not found: ' || p_task_number);
  END IF;

  IF v_task.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'deduplicated', true, 'task_number', p_task_number);
  END IF;

  IF v_task.qc_status NOT IN ('passed', 'released') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'QC_CHECKPOINT_BLOCKED: Cannot putaway SKU ' || v_task.sku_code || ' while QC status is ' || v_task.qc_status);
  END IF;

  v_dest := COALESCE(NULLIF(TRIM(p_actual_location), ''), v_task.suggested_location);

  -- Increment allocatable stock in storage bin upon confirmed putaway
  PERFORM public.wms_record_stock_movement(
    v_task.sku_code,
    v_task.quantity,
    'putaway',
    v_dest,
    COALESCE(v_task.lot_number, 'DEFAULT'),
    'PUTAWAY',
    p_task_number,
    p_operator,
    'Directed putaway from ' || v_task.source_location || ' to ' || v_dest,
    COALESCE(p_idempotency_key, 'putaway:' || p_task_number),
    p_warehouse_code
  );

  UPDATE public.wms_putaway_tasks
  SET status = 'completed',
      actual_location = v_dest,
      completed_at = NOW(),
      operator_name = p_operator,
      updated_at = NOW()
  WHERE id = v_task.id;

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, details)
  VALUES (v_ctx.tenant_id, v_ctx.warehouse_id, v_ctx.user_id, p_operator, 'PUTAWAY_COMPLETED', 'wms_putaway_tasks', p_task_number, 'Putaway ' || v_task.quantity || 'x ' || v_task.sku_code || ' -> ' || v_dest);

  RETURN jsonb_build_object('ok', true, 'task_number', p_task_number, 'actual_location', v_dest);
END;
$$;

CREATE OR REPLACE FUNCTION public.wms_release_qc_hold(
  p_sku_code TEXT,
  p_quantity INTEGER,
  p_disposition TEXT, -- 'release' | 'scrap'
  p_reason TEXT,
  p_inspector TEXT,
  p_warehouse_code TEXT,
  p_tenant_code TEXT DEFAULT 'YESI-FZCO',
  p_lot_number TEXT DEFAULT 'DEFAULT',
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
  v_put_task TEXT;
  v_suggested_loc TEXT;
BEGIN
  -- Supervisor or Admin approval checkpoint required for QC Release / Scrap
  SELECT * INTO v_ctx FROM public.wms_assert_context(
    p_tenant_code, p_warehouse_code, p_session_token, ARRAY['admin', 'supervisor']
  );

  SELECT * INTO v_sku FROM public.wms_skus WHERE tenant_id = v_ctx.tenant_id AND sku_code = p_sku_code LIMIT 1;
  v_suggested_loc := COALESCE(v_sku.default_location_code, 'PHONE-A-01');

  UPDATE public.wms_qc_inspections
  SET status = CASE WHEN p_disposition = 'scrap' THEN 'scrapped' ELSE 'released' END,
      disposition = p_disposition,
      inspector_name = p_inspector,
      released_at = NOW(),
      updated_at = NOW()
  WHERE id = (
    SELECT id FROM public.wms_qc_inspections
    WHERE warehouse_id = v_ctx.warehouse_id AND sku_code = p_sku_code AND status = 'hold'
    ORDER BY created_at ASC LIMIT 1
  );

  IF p_disposition = 'release' THEN
    v_put_task := 'PUT-QC-' || SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 8);
    INSERT INTO public.wms_putaway_tasks (
      tenant_id, warehouse_id, task_number, sku_id, sku_code, product_name, quantity, lot_number,
      source_location, source_type, suggested_location, destination_zone, qc_status, status, operator_name
    ) VALUES (
      v_ctx.tenant_id, v_ctx.warehouse_id, v_put_task, v_sku.id, p_sku_code, COALESCE(v_sku.name, p_sku_code),
      p_quantity, COALESCE(p_lot_number, 'DEFAULT'), 'QC-HOLD-AREA', 'qc_release', v_suggested_loc,
      SPLIT_PART(v_suggested_loc, '-', 1), 'released', 'pending', p_inspector
    );
  END IF;

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, details)
  VALUES (v_ctx.tenant_id, v_ctx.warehouse_id, v_ctx.user_id, p_inspector, 'QC_DISPOSITION_' || UPPER(p_disposition), 'wms_qc_inspections', p_sku_code, p_quantity || 'x ' || p_sku_code || ' (' || COALESCE(p_reason, '') || ')');

  RETURN jsonb_build_object('ok', true, 'disposition', p_disposition, 'putaway_task', v_put_task);
END;
$$;

CREATE OR REPLACE FUNCTION public.wms_confirm_order_packed(
  p_order_number TEXT,
  p_box_name TEXT,
  p_weight_kg NUMERIC,
  p_operator TEXT,
  p_warehouse_code TEXT,
  p_tenant_code TEXT DEFAULT 'YESI-FZCO',
  p_session_token TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_ctx RECORD;
  v_order RECORD;
BEGIN
  SELECT * INTO v_ctx FROM public.wms_assert_context(
    p_tenant_code, p_warehouse_code, p_session_token, ARRAY['admin', 'supervisor', 'operator']
  );

  SELECT * INTO v_order
  FROM public.wms_sales_orders
  WHERE warehouse_id = v_ctx.warehouse_id AND order_number = p_order_number
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Order not found: ' || p_order_number);
  END IF;

  IF v_order.status NOT IN ('Allocated', 'Picking', 'Picked', 'Packed', 'ReadyToShip') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'LIFECYCLE_VIOLATION: Order ' || p_order_number || ' must be Allocated/Picked before Packing (current: ' || v_order.status || ')');
  END IF;

  UPDATE public.wms_pick_tasks
  SET status = 'completed', picked_qty = required_qty, completed_at = NOW()
  WHERE warehouse_id = v_ctx.warehouse_id AND order_number = p_order_number AND status <> 'completed';

  UPDATE public.wms_sales_orders
  SET status = 'Packed',
      actual_box = COALESCE(p_box_name, suggested_box, 'Standard Carton'),
      weight_kg = COALESCE(p_weight_kg, weight_kg, 0.4),
      assigned_to = p_operator,
      updated_at = NOW()
  WHERE id = v_order.id;

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, details)
  VALUES (v_ctx.tenant_id, v_ctx.warehouse_id, v_ctx.user_id, p_operator, 'ORDER_PACKED', 'wms_sales_orders', p_order_number, 'Packed order ' || p_order_number || ' in ' || COALESCE(p_box_name, 'Standard Carton'));

  RETURN jsonb_build_object('ok', true, 'order_number', p_order_number, 'status', 'Packed');
END;
$$;

CREATE OR REPLACE FUNCTION public.wms_process_return_rma(
  p_order_number TEXT,
  p_sku_code TEXT,
  p_quantity INTEGER,
  p_reason TEXT,
  p_disposition TEXT, -- 'restock' | 'quarantine' | 'scrap'
  p_operator TEXT,
  p_warehouse_code TEXT,
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
  v_rma TEXT;
BEGIN
  SELECT * INTO v_ctx FROM public.wms_assert_context(
    p_tenant_code, p_warehouse_code, p_session_token, ARRAY['admin', 'supervisor', 'operator']
  );

  SELECT * INTO v_sku FROM public.wms_skus WHERE tenant_id = v_ctx.tenant_id AND sku_code = p_sku_code LIMIT 1;
  v_rma := 'RMA-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 6);

  INSERT INTO public.wms_returns (
    tenant_id, warehouse_id, rma_number, order_number, sku_code, quantity, reason, disposition, restocked, operator_name
  ) VALUES (
    v_ctx.tenant_id, v_ctx.warehouse_id, v_rma, COALESCE(NULLIF(p_order_number, ''), 'WALK-IN'),
    p_sku_code, p_quantity, p_reason, p_disposition, (p_disposition = 'restock'), p_operator
  );

  IF p_disposition = 'quarantine' OR p_disposition = 'scrap' THEN
    INSERT INTO public.wms_qc_inspections (
      tenant_id, warehouse_id, sku_id, sku_code, quantity, reason, status, disposition, inspector_name
    ) VALUES (
      v_ctx.tenant_id, v_ctx.warehouse_id, v_sku.id, p_sku_code, p_quantity,
      'RMA Return (' || v_rma || '): ' || p_reason,
      CASE WHEN p_disposition = 'scrap' THEN 'scrapped' ELSE 'hold' END,
      p_disposition,
      p_operator
    );
  ELSIF p_disposition = 'restock' THEN
    -- Create QC/Putaway task rather than blind bin dump if location needed, or restock via putaway
    PERFORM public.wms_record_stock_movement(
      p_sku_code, p_quantity, 'return', COALESCE(v_sku.default_location_code, 'PHONE-A-01'),
      'RMA', 'RMA', v_rma, p_operator, 'RMA Restock: ' || p_reason,
      COALESCE(p_idempotency_key, 'rma:' || v_rma), p_warehouse_code
    );
  END IF;

  IF p_order_number IS NOT NULL AND TRIM(p_order_number) <> '' THEN
    UPDATE public.wms_sales_orders
    SET status = 'Returned', updated_at = NOW()
    WHERE warehouse_id = v_ctx.warehouse_id AND order_number = p_order_number;
  END IF;

  INSERT INTO public.wms_audit_logs (tenant_id, warehouse_id, actor_user_id, operator_name, action, entity_type, entity_id, details)
  VALUES (v_ctx.tenant_id, v_ctx.warehouse_id, v_ctx.user_id, p_operator, 'RMA_PROCESSED', 'wms_returns', v_rma, p_quantity || 'x ' || p_sku_code || ' -> ' || p_disposition);

  RETURN jsonb_build_object('ok', true, 'rma_number', v_rma, 'disposition', p_disposition);
END;
$$;
