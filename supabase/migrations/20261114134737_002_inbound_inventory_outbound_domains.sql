-- =============================================================================
-- YESI-WMS Modern Fulfillment WMS Schema
-- Migration 002: Domains 04 (Inbound), 05 (Inventory), 06 (Outbound)
-- =============================================================================

-- =============================================================================
-- 04. INBOUND DOMAIN: Purchase Orders, ASN, Dock Appointments, Receipts/GRN, QC, Putaway
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wms_purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES public.wms_suppliers(id) ON DELETE SET NULL,
  po_number TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  asn_number TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('draft', 'open', 'asn_received', 'partial', 'received', 'closed', 'cancelled')),
  expected_delivery DATE,
  currency TEXT NOT NULL DEFAULT 'USD',
  total_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, po_number)
);

CREATE TABLE IF NOT EXISTS public.wms_dock_appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  appointment_number TEXT NOT NULL,
  po_id UUID REFERENCES public.wms_purchase_orders(id) ON DELETE SET NULL,
  po_number TEXT,
  asn_number TEXT,
  supplier_name TEXT NOT NULL,
  carrier_name TEXT,
  trailer_number TEXT,
  dock_door TEXT NOT NULL DEFAULT 'DOCK-01',
  scheduled_date DATE NOT NULL,
  scheduled_time TEXT NOT NULL DEFAULT '09:00',
  estimated_duration_min INTEGER NOT NULL DEFAULT 60,
  pallet_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'checked_in', 'unloading', 'completed', 'no_show', 'cancelled')),
  checked_in_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  operator_name TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_id, appointment_number)
);

CREATE TABLE IF NOT EXISTS public.wms_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  grn_number TEXT NOT NULL,
  po_id UUID REFERENCES public.wms_purchase_orders(id) ON DELETE SET NULL,
  po_number TEXT,
  supplier_name TEXT,
  sku_id UUID REFERENCES public.wms_skus(id) ON DELETE SET NULL,
  sku_code TEXT NOT NULL,
  description TEXT,
  expected_qty INTEGER,
  received_qty INTEGER NOT NULL CHECK (received_qty > 0),
  variance_qty INTEGER GENERATED ALWAYS AS (received_qty - COALESCE(expected_qty, received_qty)) STORED,
  receiving_bin TEXT NOT NULL DEFAULT 'RECV-DOCK-01',
  putaway_location TEXT,
  lot_number TEXT,
  serial_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
  expiry_date DATE,
  qc_status TEXT NOT NULL DEFAULT 'passed' CHECK (qc_status IN ('pending', 'passed', 'failed', 'quarantine')),
  cross_dock_order_number TEXT,
  operator_name TEXT NOT NULL DEFAULT 'System',
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_id, grn_number)
);

CREATE TABLE IF NOT EXISTS public.wms_qc_inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  receipt_id UUID REFERENCES public.wms_receipts(id) ON DELETE SET NULL,
  sku_id UUID REFERENCES public.wms_skus(id) ON DELETE SET NULL,
  sku_code TEXT NOT NULL,
  lot_number TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'hold' CHECK (status IN ('hold', 'released', 'rejected', 'scrapped')),
  disposition TEXT,
  inspector_name TEXT NOT NULL DEFAULT 'System',
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.wms_putaway_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  task_number TEXT NOT NULL,
  receipt_id UUID REFERENCES public.wms_receipts(id) ON DELETE SET NULL,
  sku_id UUID REFERENCES public.wms_skus(id) ON DELETE SET NULL,
  sku_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  lot_number TEXT,
  source_location TEXT NOT NULL DEFAULT 'RECV-DOCK-01',
  source_type TEXT NOT NULL DEFAULT 'receiving' CHECK (source_type IN ('receiving', 'returns', 'transfer', 'qc_release', 'cross_dock')),
  suggested_location TEXT NOT NULL,
  actual_location TEXT,
  destination_zone TEXT NOT NULL,
  putaway_method TEXT NOT NULL DEFAULT 'direct' CHECK (putaway_method IN ('direct', 'zone', 'cross_dock', 'consolidation')),
  qc_status TEXT NOT NULL DEFAULT 'passed' CHECK (qc_status IN ('pending', 'passed', 'released', 'failed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'in_progress', 'completed', 'cancelled')),
  assigned_to TEXT,
  estimated_minutes INTEGER DEFAULT 5,
  actual_minutes INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  operator_name TEXT NOT NULL DEFAULT 'System',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_id, task_number)
);

-- =============================================================================
-- 05. INVENTORY DOMAIN: Balances, Immutable Ledger, Lots, Serials/IMEI, Reservations, Cycle Counts
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wms_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  sku_id UUID NOT NULL REFERENCES public.wms_skus(id) ON DELETE CASCADE,
  sku_code TEXT NOT NULL,
  lot_number TEXT NOT NULL,
  batch_number TEXT,
  manufacturing_date DATE,
  expiry_date DATE,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'quarantine', 'expired', 'recalled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, sku_code, lot_number)
);

CREATE TABLE IF NOT EXISTS public.wms_inventory_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  sku_id UUID NOT NULL REFERENCES public.wms_skus(id) ON DELETE CASCADE,
  location_id UUID REFERENCES public.wms_locations(id) ON DELETE SET NULL,
  sku_code TEXT NOT NULL,
  location_code TEXT NOT NULL,
  lot_number TEXT NOT NULL DEFAULT 'DEFAULT',
  on_hand_qty INTEGER NOT NULL DEFAULT 0 CHECK (on_hand_qty >= 0),
  reserved_qty INTEGER NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  quarantine_qty INTEGER NOT NULL DEFAULT 0 CHECK (quarantine_qty >= 0),
  available_qty INTEGER GENERATED ALWAYS AS (GREATEST(on_hand_qty - reserved_qty - quarantine_qty, 0)) STORED,
  expiry_date DATE,
  last_counted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_id, sku_code, location_code, lot_number)
);

CREATE TABLE IF NOT EXISTS public.wms_inventory_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  sku_id UUID REFERENCES public.wms_skus(id) ON DELETE SET NULL,
  sku_code TEXT NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN (
    'opening_balance', 'inbound', 'putaway', 'allocation', 'release',
    'pick', 'pack', 'outbound', 'return', 'adjustment', 'transfer', 'cycle_count', 'qc_hold', 'qc_release'
  )),
  qty_delta INTEGER NOT NULL,
  balance_before INTEGER NOT NULL DEFAULT 0,
  balance_after INTEGER NOT NULL DEFAULT 0,
  from_location_code TEXT,
  to_location_code TEXT,
  lot_number TEXT,
  serial_number TEXT,
  reference_type TEXT,
  reference_id TEXT,
  idempotency_key TEXT UNIQUE,
  operator_name TEXT NOT NULL DEFAULT 'System',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.wms_serial_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  sku_id UUID REFERENCES public.wms_skus(id) ON DELETE SET NULL,
  sku_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  imei1 TEXT,
  imei2 TEXT,
  tac_prefix TEXT,
  lot_number TEXT,
  batch_number TEXT,
  color TEXT,
  storage_spec TEXT,
  status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'reserved', 'picked', 'shipped', 'returned', 'defective', 'quarantine')),
  location_code TEXT NOT NULL DEFAULT 'PHONE-A-01',
  order_number TEXT,
  received_at TIMESTAMPTZ DEFAULT NOW(),
  shipped_at TIMESTAMPTZ,
  returned_at TIMESTAMPTZ,
  warranty_start DATE,
  warranty_end DATE,
  operator_name TEXT NOT NULL DEFAULT 'System',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, serial_number)
);

CREATE TABLE IF NOT EXISTS public.wms_sim_tac_db (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  tac_prefix TEXT NOT NULL,
  expected_offset INTEGER NOT NULL DEFAULT 0,
  model_series TEXT NOT NULL,
  device_type TEXT NOT NULL DEFAULT 'Smartphone',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, tac_prefix)
);

CREATE TABLE IF NOT EXISTS public.wms_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  reservation_number TEXT NOT NULL,
  order_number TEXT NOT NULL,
  sku_id UUID REFERENCES public.wms_skus(id) ON DELETE SET NULL,
  sku_code TEXT NOT NULL,
  location_code TEXT,
  lot_number TEXT,
  serial_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  fefo_priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'allocated', 'picked', 'released', 'expired')),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '4 hours'),
  operator_name TEXT NOT NULL DEFAULT 'System',
  UNIQUE (warehouse_id, reservation_number)
);

CREATE TABLE IF NOT EXISTS public.wms_cycle_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  sku_id UUID REFERENCES public.wms_skus(id) ON DELETE SET NULL,
  sku_code TEXT NOT NULL,
  location_code TEXT NOT NULL,
  abc_class TEXT DEFAULT 'B' CHECK (abc_class IN ('A', 'B', 'C')),
  expected_qty INTEGER NOT NULL,
  actual_qty INTEGER NOT NULL,
  variance_qty INTEGER GENERATED ALWAYS AS (actual_qty - expected_qty) STORED,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'approved', 'rejected')),
  count_frequency TEXT DEFAULT 'weekly' CHECK (count_frequency IN ('daily', 'weekly', 'monthly', 'quarterly')),
  operator_name TEXT NOT NULL DEFAULT 'System',
  approved_by TEXT,
  note TEXT,
  counted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 06. OUTBOUND DOMAIN: Sales Orders, Waves, Allocations, Pick Tasks, Cartons, Pack Lines
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wms_waves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  wave_number TEXT NOT NULL,
  name TEXT NOT NULL,
  picking_method TEXT NOT NULL DEFAULT 'wave' CHECK (picking_method IN ('single', 'batch', 'zone', 'wave', 'cluster')),
  zone_profile TEXT DEFAULT 'ALL',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('planned', 'open', 'picking', 'packed', 'completed', 'cancelled')),
  order_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
  pick_path JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_orders INTEGER NOT NULL DEFAULT 0,
  total_units INTEGER NOT NULL DEFAULT 0,
  estimated_minutes INTEGER DEFAULT 15,
  actual_minutes INTEGER,
  assigned_picker TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_id, wave_number)
);

CREATE TABLE IF NOT EXISTS public.wms_sales_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES public.wms_customers(id) ON DELETE SET NULL,
  wave_id UUID REFERENCES public.wms_waves(id) ON DELETE SET NULL,
  order_number TEXT NOT NULL,
  external_order_id TEXT,
  posting_number TEXT,
  channel TEXT NOT NULL DEFAULT 'ozon' CHECK (channel IN ('ozon', 'wildberries', 'shopify', 'amazon', 'noon', 'b2b', 'manual')),
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN (
    'Pending', 'Allocated', 'Picking', 'Packed', 'ReadyToShip', 'Shipped', 'Delivered', 'Returned', 'Cancelled', 'QCHold', 'CrossDock'
  )),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'urgent')),
  required_skus TEXT NOT NULL,
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  carrier_name TEXT DEFAULT 'GBS Express',
  service_level TEXT DEFAULT 'Ozon Global',
  tracking_number TEXT,
  shipping_cost NUMERIC(10, 2) DEFAULT 0,
  weight_kg NUMERIC(10, 3) DEFAULT 0.400,
  suggested_box TEXT,
  actual_box TEXT,
  assigned_to TEXT,
  ship_by_at TIMESTAMPTZ,
  shipped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_id, order_number)
);

CREATE TABLE IF NOT EXISTS public.wms_pick_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  task_number TEXT NOT NULL,
  wave_id UUID REFERENCES public.wms_waves(id) ON DELETE SET NULL,
  order_id UUID REFERENCES public.wms_sales_orders(id) ON DELETE CASCADE,
  order_number TEXT NOT NULL,
  reservation_id UUID REFERENCES public.wms_reservations(id) ON DELETE SET NULL,
  sku_id UUID REFERENCES public.wms_skus(id) ON DELETE SET NULL,
  sku_code TEXT NOT NULL,
  from_location_code TEXT NOT NULL,
  to_staging_code TEXT NOT NULL DEFAULT 'PACK-STAGE-01',
  lot_number TEXT,
  required_qty INTEGER NOT NULL CHECK (required_qty > 0),
  picked_qty INTEGER NOT NULL DEFAULT 0 CHECK (picked_qty >= 0),
  pick_sequence INTEGER NOT NULL DEFAULT 100,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'short_pick', 'cancelled')),
  assigned_to TEXT,
  scanned_barcode TEXT,
  scanned_serial TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_id, task_number)
);

CREATE TABLE IF NOT EXISTS public.wms_box_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  length_cm NUMERIC(8, 2) NOT NULL,
  width_cm NUMERIC(8, 2) NOT NULL,
  height_cm NUMERIC(8, 2) NOT NULL,
  max_weight_kg NUMERIC(8, 2) NOT NULL,
  unit_cost NUMERIC(8, 2) NOT NULL DEFAULT 0.35,
  material TEXT NOT NULL DEFAULT 'corrugated',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS public.wms_cartons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  carton_number TEXT NOT NULL,
  order_id UUID REFERENCES public.wms_sales_orders(id) ON DELETE CASCADE,
  order_number TEXT NOT NULL,
  box_type_code TEXT,
  weight_kg NUMERIC(10, 3) DEFAULT 0.400,
  tracking_number TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'packed', 'sealed', 'manifested', 'shipped')),
  packed_by TEXT,
  sealed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_id, carton_number)
);

CREATE TABLE IF NOT EXISTS public.wms_pack_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  carton_id UUID NOT NULL REFERENCES public.wms_cartons(id) ON DELETE CASCADE,
  pick_task_id UUID REFERENCES public.wms_pick_tasks(id) ON DELETE SET NULL,
  sku_code TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  serial_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
  packed_by TEXT,
  packed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wms_balances_wh_sku ON public.wms_inventory_balances(warehouse_id, sku_code);
CREATE INDEX IF NOT EXISTS idx_wms_ledger_wh_created ON public.wms_inventory_ledger(warehouse_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wms_ledger_sku ON public.wms_inventory_ledger(sku_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wms_orders_wh_status ON public.wms_sales_orders(warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_wms_pick_tasks_wh_status ON public.wms_pick_tasks(warehouse_id, status);
