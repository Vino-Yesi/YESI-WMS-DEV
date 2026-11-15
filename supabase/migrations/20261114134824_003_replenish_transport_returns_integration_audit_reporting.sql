-- =============================================================================
-- YESI-WMS Modern Fulfillment WMS Schema
-- Migration 003: Domains 07 (Replenishment), 08 (Transport), 09 (Returns),
--                10 (Integration), 11 (Audit), 12 (Reporting)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wms_replenishment_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  sku_id UUID REFERENCES public.wms_skus(id) ON DELETE CASCADE,
  sku_code TEXT NOT NULL,
  pick_location_code TEXT NOT NULL,
  reserve_zone_code TEXT NOT NULL DEFAULT 'RESERVE-Z',
  min_qty INTEGER NOT NULL DEFAULT 5,
  max_qty INTEGER NOT NULL DEFAULT 30,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_id, sku_code, pick_location_code)
);

CREATE TABLE IF NOT EXISTS public.wms_replenishment_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  sku_id UUID REFERENCES public.wms_skus(id) ON DELETE SET NULL,
  sku_code TEXT NOT NULL,
  from_location_code TEXT NOT NULL,
  to_location_code TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  triggered_by TEXT NOT NULL DEFAULT 'auto' CHECK (triggered_by IN ('auto', 'manual', 'low_stock', 'wave_demand')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  assigned_to TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.wms_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  transfer_number TEXT NOT NULL,
  source_warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  destination_warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_transit', 'received', 'cancelled')),
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  shipped_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  operator_name TEXT NOT NULL DEFAULT 'System',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, transfer_number)
);

CREATE TABLE IF NOT EXISTS public.wms_shipments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  shipment_number TEXT NOT NULL,
  order_id UUID REFERENCES public.wms_sales_orders(id) ON DELETE SET NULL,
  order_number TEXT NOT NULL,
  carton_id UUID REFERENCES public.wms_cartons(id) ON DELETE SET NULL,
  carrier_name TEXT NOT NULL DEFAULT 'GBS Express',
  service_level TEXT NOT NULL DEFAULT 'Ozon Global',
  tracking_number TEXT NOT NULL,
  label_url TEXT,
  weight_kg NUMERIC(10, 3) DEFAULT 0.400,
  shipping_cost NUMERIC(10, 2) DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'label_printed', 'dispatched', 'in_transit', 'delivered', 'exception', 'voided')),
  dispatched_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  pod_signature TEXT,
  pod_photo_url TEXT,
  operator_name TEXT NOT NULL DEFAULT 'System',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_id, shipment_number)
);

CREATE TABLE IF NOT EXISTS public.wms_posting_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  posting_number TEXT NOT NULL,
  order_number TEXT,
  tracking_number TEXT,
  carrier_name TEXT DEFAULT 'Ozon / GBS Express',
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'assembled', 'audited', 'in_transit', 'delivered', 'posted', 'exception')),
  city TEXT DEFAULT 'Dubai',
  geolocation TEXT,
  folder TEXT,
  note TEXT,
  photo_url TEXT,
  operator_name TEXT NOT NULL DEFAULT 'System',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_id, posting_number)
);

CREATE TABLE IF NOT EXISTS public.wms_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  rma_number TEXT NOT NULL,
  order_number TEXT NOT NULL,
  sku_id UUID REFERENCES public.wms_skus(id) ON DELETE SET NULL,
  sku_code TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  reason TEXT NOT NULL,
  condition_grade TEXT NOT NULL DEFAULT 'A' CHECK (condition_grade IN ('A', 'B', 'C', 'defective')),
  disposition TEXT NOT NULL DEFAULT 'restock' CHECK (disposition IN ('pending_inspection', 'restock', 'qc_hold', 'quarantine', 'refurbish', 'return_to_vendor', 'scrap')),
  restocked BOOLEAN NOT NULL DEFAULT FALSE,
  restock_location_code TEXT,
  operator_name TEXT NOT NULL DEFAULT 'System',
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_id, rma_number)
);

CREATE TABLE IF NOT EXISTS public.wms_integration_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  endpoint_type TEXT NOT NULL CHECK (endpoint_type IN ('erp', 'oms', 'tms', 'wms', 'marketplace', 'carrier', 'sheets', 'custom')),
  provider TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'error', 'syncing')),
  sync_interval_min INTEGER NOT NULL DEFAULT 15,
  records_synced INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.wms_event_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'published', 'failed', 'dead_letter')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  source_device_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.wms_webhook_inbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  processed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, source, event_id)
);

CREATE TABLE IF NOT EXISTS public.wms_connected_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID REFERENCES public.wms_warehouses(id) ON DELETE SET NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'web',
  user_agent TEXT,
  operator_name TEXT NOT NULL DEFAULT 'Unknown',
  is_online BOOLEAN NOT NULL DEFAULT TRUE,
  active_workflows INTEGER NOT NULL DEFAULT 0,
  pending_sync_events INTEGER NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, device_id)
);

CREATE TABLE IF NOT EXISTS public.wms_gsheet_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  operating_day DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_orders INTEGER NOT NULL DEFAULT 0,
  expected_qty INTEGER NOT NULL DEFAULT 0,
  packed_orders INTEGER NOT NULL DEFAULT 0,
  packed_qty INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  operator_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.wms_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  raw_text TEXT NOT NULL,
  standard_sku TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, raw_text)
);

CREATE TABLE IF NOT EXISTS public.wms_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID REFERENCES public.wms_warehouses(id) ON DELETE SET NULL,
  actor_user_id UUID,
  operator_name TEXT NOT NULL DEFAULT 'System',
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB,
  device_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.wms_worker_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL CHECK (task_type IN ('pick', 'pack', 'receive', 'putaway', 'cycle_count', 'replenish', 'ship', 'label', 'audit')),
  order_number TEXT,
  sku_code TEXT,
  from_location_code TEXT,
  to_location_code TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  assigned_to TEXT NOT NULL,
  estimated_minutes NUMERIC(8, 2) DEFAULT 5,
  actual_minutes NUMERIC(8, 2),
  distance_meters NUMERIC(10, 2) DEFAULT 0,
  note TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.wms_operator_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  picks INTEGER NOT NULL DEFAULT 0,
  audits INTEGER NOT NULL DEFAULT 0,
  scans INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  accuracy NUMERIC(5, 2) NOT NULL DEFAULT 100.00,
  badges JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, username)
);

CREATE TABLE IF NOT EXISTS public.wms_system_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID REFERENCES public.wms_warehouses(id) ON DELETE SET NULL,
  metric_name TEXT NOT NULL,
  metric_value NUMERIC(14, 4) NOT NULL,
  metric_unit TEXT NOT NULL DEFAULT 'count',
  labels JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
  COALESCE((SELECT COUNT(*) FROM public.wms_event_outbox e WHERE e.tenant_id = w.tenant_id AND e.status = 'pending'), 0) AS outbox_pending
FROM public.wms_warehouses w;

CREATE INDEX IF NOT EXISTS idx_wms_audit_logs_tenant_created ON public.wms_audit_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wms_outbox_status ON public.wms_event_outbox(status, created_at);
CREATE INDEX IF NOT EXISTS idx_wms_metrics_recorded ON public.wms_system_metrics(tenant_id, recorded_at DESC);
