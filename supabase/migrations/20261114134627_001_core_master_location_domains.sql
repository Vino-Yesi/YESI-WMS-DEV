-- =============================================================================
-- YESI-WMS Modern Fulfillment WMS Schema (PostgreSQL / Supabase)
-- Migration 001: Domains 01 (Core), 02 (Master), 03 (Location)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Helper function for updated_at triggers
CREATE OR REPLACE FUNCTION public.wms_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- =============================================================================
-- 01. CORE DOMAIN: Tenants, Companies, Warehouses, Roles, Permissions, Users
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wms_tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'enterprise' CHECK (plan IN ('starter', 'growth', 'enterprise')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.wms_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  tax_id TEXT,
  country_code TEXT NOT NULL DEFAULT 'AE',
  currency TEXT NOT NULL DEFAULT 'USD',
  timezone TEXT NOT NULL DEFAULT 'Asia/Dubai',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS public.wms_warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.wms_companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  warehouse_type TEXT NOT NULL DEFAULT 'fulfillment' CHECK (warehouse_type IN ('fulfillment', 'distribution', 'cross_dock', 'returns', 'bonded')),
  address_line1 TEXT,
  city TEXT DEFAULT 'Dubai',
  region TEXT DEFAULT 'Dubai',
  country_code TEXT NOT NULL DEFAULT 'AE',
  dock_count INTEGER NOT NULL DEFAULT 4,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'closed')),
  operating_config JSONB NOT NULL DEFAULT '{"fefo_enabled": true, "require_scan_verify": true}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS public.wms_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE CHECK (code IN ('admin', 'supervisor', 'operator', 'auditor', 'viewer')),
  name TEXT NOT NULL,
  description TEXT,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.wms_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID UNIQUE,
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  default_warehouse_id UUID REFERENCES public.wms_warehouses(id) ON DELETE SET NULL,
  username TEXT NOT NULL,
  email TEXT,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'supervisor', 'operator', 'auditor', 'viewer')),
  skill_level INTEGER NOT NULL DEFAULT 3 CHECK (skill_level BETWEEN 1 AND 5),
  current_zone TEXT,
  preferred_tasks JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, username)
);

CREATE TABLE IF NOT EXISTS public.wms_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  config_key TEXT NOT NULL,
  config_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, config_key)
);

-- =============================================================================
-- 02. MASTER DOMAIN: UOM, Products, SKUs, Barcodes, Suppliers, Customers, Carriers
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wms_uoms (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_multiplier NUMERIC(12, 4) NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS public.wms_suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  country_code TEXT DEFAULT 'AE',
  lead_time_days INTEGER NOT NULL DEFAULT 5,
  rating NUMERIC(3, 2) DEFAULT 5.00,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS public.wms_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'marketplace' CHECK (channel IN ('marketplace', 'b2b', 'd2c', 'retail', 'wholesale')),
  email TEXT,
  phone TEXT,
  city TEXT,
  country_code TEXT DEFAULT 'RU',
  shipping_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS public.wms_carriers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  service_type TEXT NOT NULL DEFAULT 'express',
  tracking_url_template TEXT,
  rate_card JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code, service_type)
);

CREATE TABLE IF NOT EXISTS public.wms_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  product_code TEXT NOT NULL,
  name TEXT NOT NULL,
  brand TEXT,
  category TEXT NOT NULL DEFAULT 'General',
  description TEXT,
  uom_code TEXT NOT NULL DEFAULT 'EA' REFERENCES public.wms_uoms(code),
  serializable BOOLEAN NOT NULL DEFAULT FALSE,
  lot_tracked BOOLEAN NOT NULL DEFAULT FALSE,
  expiry_tracked BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, product_code)
);

CREATE TABLE IF NOT EXISTS public.wms_skus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.wms_products(id) ON DELETE SET NULL,
  sku_code TEXT NOT NULL,
  article_code TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  color TEXT,
  primary_barcode TEXT,
  rfid_tag TEXT,
  uom_code TEXT NOT NULL DEFAULT 'EA' REFERENCES public.wms_uoms(code),
  velocity_class TEXT NOT NULL DEFAULT 'medium' CHECK (velocity_class IN ('high', 'medium', 'low')),
  abc_class TEXT NOT NULL DEFAULT 'B' CHECK (abc_class IN ('A', 'B', 'C')),
  weight_kg NUMERIC(10, 3) NOT NULL DEFAULT 0.400,
  length_cm NUMERIC(10, 2) DEFAULT 18.0,
  width_cm NUMERIC(10, 2) DEFAULT 10.0,
  height_cm NUMERIC(10, 2) DEFAULT 5.0,
  unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
  unit_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  reorder_point INTEGER NOT NULL DEFAULT 5,
  reorder_qty INTEGER NOT NULL DEFAULT 15,
  max_stock_level INTEGER NOT NULL DEFAULT 200,
  serializable BOOLEAN NOT NULL DEFAULT FALSE,
  fefo_priority INTEGER NOT NULL DEFAULT 50,
  default_location_code TEXT DEFAULT 'PHONE-A-01',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, sku_code)
);

CREATE TABLE IF NOT EXISTS public.wms_barcodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  sku_id UUID NOT NULL REFERENCES public.wms_skus(id) ON DELETE CASCADE,
  barcode TEXT NOT NULL,
  barcode_type TEXT NOT NULL DEFAULT 'EAN13' CHECK (barcode_type IN ('EAN13', 'CODE128', 'QR', 'UPC', 'OZON_SKU', 'WB_BARCODE', 'INTERNAL')),
  uom_code TEXT NOT NULL DEFAULT 'EA',
  pack_qty INTEGER NOT NULL DEFAULT 1,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, barcode)
);

-- =============================================================================
-- 03. LOCATION DOMAIN: Zones, Aisles, Racks, Shelves, Bins & Capacities
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wms_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  zone_code TEXT NOT NULL,
  name TEXT NOT NULL,
  zone_type TEXT NOT NULL DEFAULT 'pick' CHECK (zone_type IN ('receiving', 'quarantine', 'reserve', 'pick', 'packing', 'staging', 'shipping', 'returns')),
  category_target TEXT,
  velocity_target TEXT DEFAULT 'high' CHECK (velocity_target IN ('high', 'medium', 'low')),
  temperature_zone TEXT NOT NULL DEFAULT 'ambient' CHECK (temperature_zone IN ('ambient', 'chilled', 'frozen', 'climate_controlled')),
  max_capacity INTEGER NOT NULL DEFAULT 500,
  current_utilization INTEGER NOT NULL DEFAULT 0,
  putaway_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_id, zone_code)
);

CREATE TABLE IF NOT EXISTS public.wms_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.wms_warehouses(id) ON DELETE CASCADE,
  zone_id UUID REFERENCES public.wms_zones(id) ON DELETE SET NULL,
  location_code TEXT NOT NULL,
  zone_code TEXT NOT NULL,
  aisle TEXT NOT NULL DEFAULT '01',
  rack TEXT NOT NULL DEFAULT '01',
  shelf TEXT NOT NULL DEFAULT '01',
  bin TEXT NOT NULL DEFAULT '01',
  bin_type TEXT NOT NULL DEFAULT 'shelf' CHECK (bin_type IN ('pallet', 'carton', 'shelf', 'floor', 'dock', 'staging', 'cold', 'quarantine')),
  pick_sequence INTEGER NOT NULL DEFAULT 100,
  max_units INTEGER NOT NULL DEFAULT 100,
  current_units INTEGER NOT NULL DEFAULT 0,
  max_weight_kg NUMERIC(10, 2) NOT NULL DEFAULT 250.00,
  is_pickable BOOLEAN NOT NULL DEFAULT TRUE,
  is_receivable BOOLEAN NOT NULL DEFAULT TRUE,
  is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_id, location_code)
);

CREATE INDEX IF NOT EXISTS idx_wms_skus_tenant_sku ON public.wms_skus(tenant_id, sku_code);
CREATE INDEX IF NOT EXISTS idx_wms_skus_barcode ON public.wms_skus(primary_barcode);
CREATE INDEX IF NOT EXISTS idx_wms_locations_wh_code ON public.wms_locations(warehouse_id, location_code);
CREATE INDEX IF NOT EXISTS idx_wms_locations_pick_seq ON public.wms_locations(warehouse_id, pick_sequence);
