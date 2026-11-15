-- =============================================================================
-- Migration 005: YESI Pilot Warehouse Seed Data & Opening Inventory
--
-- SECURITY NOTE (v2.2 hardening):
--   Earlier revisions of this migration seeded demo operator accounts whose
--   password equalled the username (`admin`/`admin`, `VINOVJ`/`VINOVJ`,
--   `operator`/`operator`, `supervisor`/`supervisor`). Those credentials are a
--   critical production risk and are NO LONGER seeded here.
--
--   A clean deployment now contains reference/master data only. The first
--   administrator is created exclusively through the audited, one-time
--   `public.wms_bootstrap_first_admin(...)` RPC introduced in migration 008,
--   which requires a strong operator-supplied password and records
--   `wms_bootstrap_state`. Legacy demo accounts that already exist in an
--   upgraded database are flagged `must_change_password = TRUE` (and deactivated
--   when they have never been used) by migration 008.
--
-- This migration is fully idempotent: re-running it never duplicates rows.
-- =============================================================================

DO $$
DECLARE
  v_tenant_id UUID;
  v_company_id UUID;
  v_dxb_id UUID;
  v_shj_id UUID;
  v_customer_id UUID;
  v_supplier_samsung UUID;
  v_supplier_apple UUID;
BEGIN
  -- -------------------------------------------------------------------------
  -- 01. CORE: Tenant, Company, Warehouses
  -- -------------------------------------------------------------------------
  INSERT INTO public.wms_tenants (code, name, plan, status)
  VALUES ('YESI-FZCO', 'YESI Fulfillment FZCO', 'enterprise', 'active')
  ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, plan = EXCLUDED.plan, status = EXCLUDED.status
  RETURNING id INTO v_tenant_id;

  INSERT INTO public.wms_companies (tenant_id, code, legal_name, country_code, currency, timezone)
  VALUES (v_tenant_id, 'YESI-AE', 'YESI Global Fulfillment FZCO', 'AE', 'USD', 'Asia/Dubai')
  ON CONFLICT (tenant_id, code) DO UPDATE SET legal_name = EXCLUDED.legal_name
  RETURNING id INTO v_company_id;

  INSERT INTO public.wms_warehouses (
    tenant_id, company_id, code, name, warehouse_type, city, region, country_code, dock_count, is_default, status
  ) VALUES (
    v_tenant_id, v_company_id, 'DXB-FC1', 'Dubai Silicon Oasis Fulfillment Center 1',
    'fulfillment', 'Dubai', 'Dubai', 'AE', 4, TRUE, 'active'
  )
  ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, is_default = TRUE, status = 'active'
  RETURNING id INTO v_dxb_id;

  INSERT INTO public.wms_warehouses (
    tenant_id, company_id, code, name, warehouse_type, city, region, country_code, dock_count, is_default, status
  ) VALUES (
    v_tenant_id, v_company_id, 'SHJ-HUB2', 'Sharjah Cross-Border Consolidation Hub',
    'cross_dock', 'Sharjah', 'Sharjah', 'AE', 2, FALSE, 'active'
  )
  ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, status = 'active'
  RETURNING id INTO v_shj_id;

  -- -------------------------------------------------------------------------
  -- 01b. CORE: Roles & permission matrix
  -- -------------------------------------------------------------------------
  INSERT INTO public.wms_roles (code, name, description, permissions) VALUES
    ('admin',      'Warehouse Administrator', 'Full tenant-wide administration',            '["*"]'::jsonb),
    ('supervisor', 'Shift Supervisor',        'Inbound, inventory, outbound, QC, reporting', '["inbound.*","inventory.*","outbound.*","qc.*","reports.*"]'::jsonb),
    ('operator',   'Fulfillment Operator',    'Scan, putaway, pick, pack, ship',             '["inbound.scan","putaway.execute","pick.execute","pack.execute","ship.execute"]'::jsonb),
    ('auditor',    'Inventory Auditor',       'Read inventory, run cycle counts, read audit','["inventory.read","cycle_count.*","audit.read"]'::jsonb),
    ('viewer',     'Read-Only Viewer',        'Reporting read only',                         '["reports.read"]'::jsonb)
  ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, permissions = EXCLUDED.permissions;

  -- -------------------------------------------------------------------------
  -- 02. MASTER: UOMs, Suppliers, Customers, Carriers, Box types, SIM/TAC DB
  -- -------------------------------------------------------------------------
  INSERT INTO public.wms_uoms (code, name, base_multiplier) VALUES
    ('EA',  'Each / Unit',    1),
    ('BOX', 'Inner Box',     10),
    ('CTN', 'Master Carton', 50),
    ('PLT', 'Pallet',       500)
  ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, base_multiplier = EXCLUDED.base_multiplier;

  INSERT INTO public.wms_suppliers (tenant_id, code, name, country_code, lead_time_days) VALUES
    (v_tenant_id, 'SUP-SAMSUNG-MENA', 'Samsung Gulf Electronics FZE',            'AE', 3),
    (v_tenant_id, 'SUP-APPLE-DIST',   'Apple Authorized FZCO Distribution',      'AE', 4)
  ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name;

  SELECT id INTO v_supplier_samsung FROM public.wms_suppliers WHERE tenant_id = v_tenant_id AND code = 'SUP-SAMSUNG-MENA';
  SELECT id INTO v_supplier_apple   FROM public.wms_suppliers WHERE tenant_id = v_tenant_id AND code = 'SUP-APPLE-DIST';

  INSERT INTO public.wms_customers (tenant_id, code, name, channel, country_code) VALUES
    (v_tenant_id, 'CUST-OZON-GLOBAL', 'Ozon Global Cross-Border Marketplace', 'marketplace', 'RU')
  ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_customer_id;

  INSERT INTO public.wms_carriers (tenant_id, code, name, service_type) VALUES
    (v_tenant_id, 'GBS',   'GBS Express',        'Ozon Global'),
    (v_tenant_id, 'CDEK',  'CDEK Cross-Border',  'Express Air'),
    (v_tenant_id, 'ARAMEX','Aramex GCC',         'Priority Parcel')
  ON CONFLICT (tenant_id, code, service_type) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO public.wms_box_types (tenant_id, code, name, length_cm, width_cm, height_cm, max_weight_kg, unit_cost, material) VALUES
    (v_tenant_id, 'PHONE-S',  'Phone Mailer S',  18, 10, 4, 0.5, 0.35, 'corrugated'),
    (v_tenant_id, 'PHONE-M',  'Phone Mailer M',  20, 12, 5, 0.8, 0.45, 'corrugated'),
    (v_tenant_id, 'WATCH-S',  'Smartwatch Cube', 14, 12, 8, 0.5, 0.40, 'corrugated'),
    (v_tenant_id, 'AUDIO-XS', 'TWS Audio Box',   12, 10, 6, 0.3, 0.30, 'corrugated')
  ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO public.wms_sim_tac_db (tenant_id, tac_prefix, expected_offset, model_series, device_type) VALUES
    (v_tenant_id, '35891204', 1, 'Samsung Galaxy A17 Series', 'Smartphone'),
    (v_tenant_id, '35210948', 1, 'Samsung Galaxy A36 5G',     'Smartphone'),
    (v_tenant_id, '35482910', 1, 'Samsung Galaxy S26 5G',     'Smartphone'),
    (v_tenant_id, '35904412', 0, 'Apple Watch Series 11',     'Wearable')
  ON CONFLICT (tenant_id, tac_prefix) DO UPDATE SET model_series = EXCLUDED.model_series;

  -- -------------------------------------------------------------------------
  -- 02b. MASTER: SKU catalogue (Ozon Global pilot assortment)
  -- -------------------------------------------------------------------------
  INSERT INTO public.wms_skus (
    tenant_id, sku_code, name, category, color, primary_barcode, velocity_class, abc_class,
    weight_kg, unit_price, reorder_point, reorder_qty, max_stock_level, serializable, fefo_priority, default_location_code
  ) VALUES
    (v_tenant_id, 'A17Black256',         'Samsung Galaxy A17 8/256GB Black',                 'Phones',    'Black',      '2980133461', 'high',   'A', 0.400, 215, 6, 20, 200, TRUE, 50, 'PHONE-A-01'),
    (v_tenant_id, 'A17Black128',         'Samsung Galaxy A17 6/128GB Black',                 'Phones',    'Black',      '2980127274', 'medium', 'B', 0.400, 186, 4, 12, 200, TRUE, 50, 'PHONE-A-02'),
    (v_tenant_id, 'A17Grey128',          'Samsung Galaxy A17 6/128GB Grey',                  'Phones',    'Grey',       '2980079969', 'medium', 'B', 0.400, 186, 5, 15, 200, TRUE, 50, 'PHONE-A-02'),
    (v_tenant_id, 'A17Blue128',          'Samsung Galaxy A17 6/128GB Blue',                  'Phones',    'Blue',       '2980131308', 'low',    'C', 0.400, 185, 4, 10, 200, TRUE, 50, 'PHONE-A-03'),
    (v_tenant_id, 'A17Blue256',          'Samsung Galaxy A17 8/256GB Blue',                  'Phones',    'Blue',       '3045158395', 'low',    'C', 0.400, 215, 4, 10, 200, TRUE, 50, 'PHONE-A-03'),
    (v_tenant_id, 'A076128black',        'Samsung Galaxy A07 Global 6/128GB Black',          'Phones',    'Black',      '3462168645', 'high',   'A', 0.400, 135, 6, 20, 200, TRUE, 50, 'PHONE-A-01'),
    (v_tenant_id, 'A076128Green',        'Samsung Galaxy A07 6/128GB Green',                 'Phones',    'Green',      '3462172265', 'low',    'C', 0.400, 135, 4, 10, 200, TRUE, 50, 'PHONE-A-03'),
    (v_tenant_id, 'A36black',            'Samsung Galaxy A36 5G 8/256GB Awesome Black',      'Phones',    'Black',      '2011505146', 'low',    'A', 0.400, 325, 4, 10, 200, TRUE, 50, 'PHONE-A-03'),
    (v_tenant_id, 'sS25FEWhite',         'Samsung Galaxy S25 FE 256GB White',                'Phones',    'White',      '3424142476', 'low',    'A', 0.400, 580, 3,  8, 200, TRUE, 50, 'PHONE-A-03'),
    (v_tenant_id, 'S26Cobalt Violet256', 'Samsung Galaxy S26 5G 12/256GB Cobalt Violet',     'Phones',    'Violet',     '3560099642', 'low',    'A', 0.400, 850, 3,  8, 200, TRUE, 50, 'PHONE-A-03'),
    (v_tenant_id, 'Watch8Graphite40',    'Samsung Galaxy Watch 8 (SM-L320) 40mm Graphite',   'Wearables', 'Graphite',   '2747570541', 'high',   'A', 0.400, 240, 5, 15, 200, TRUE, 50, 'WEAR-B-01'),
    (v_tenant_id, 'Watch8SILVER44',      'Samsung Galaxy Watch 8 (SM-L330) 44mm Silver',     'Wearables', 'Silver',     '2747636284', 'medium', 'B', 0.400, 250, 4, 12, 200, TRUE, 50, 'WEAR-B-01'),
    (v_tenant_id, 'watch8Silver40mm',    'Samsung Galaxy Watch 8 (SM-L320) 40mm Silver',     'Wearables', 'Silver',     '2524697911', 'medium', 'B', 0.400, 250, 4, 10, 200, TRUE, 50, 'WEAR-B-02'),
    (v_tenant_id, 'MEQW4 S/M',           'Apple Watch Series 11 42mm Space Gray S/M',        'Wearables', 'Space Gray', '3458127361', 'low',    'A', 0.400, 370, 4, 10, 200, TRUE, 50, 'WEAR-B-02'),
    (v_tenant_id, 'Buds3ProSilver',      'Samsung Galaxy Buds3 Pro Silver',                  'Audio',     'Silver',     '2015591774', 'medium', 'B', 0.400, 148, 5, 15, 200, TRUE, 50, 'AUDIO-C-01'),
    (v_tenant_id, 'buds4prosilver',      'Samsung Galaxy Buds4 Pro Black',                   'Audio',     'Black',      '3563245495', 'low',    'B', 0.400, 220, 4, 10, 200, TRUE, 50, 'AUDIO-C-01')
  ON CONFLICT (tenant_id, sku_code) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    color = EXCLUDED.color,
    primary_barcode = EXCLUDED.primary_barcode,
    velocity_class = EXCLUDED.velocity_class,
    abc_class = EXCLUDED.abc_class,
    unit_price = EXCLUDED.unit_price,
    reorder_point = EXCLUDED.reorder_point,
    reorder_qty = EXCLUDED.reorder_qty,
    default_location_code = EXCLUDED.default_location_code;

  -- Marketplace (Ozon SKU) barcodes — one primary barcode per SKU
  INSERT INTO public.wms_barcodes (tenant_id, sku_id, barcode, barcode_type, is_primary)
  SELECT v_tenant_id, s.id, s.primary_barcode, 'OZON_SKU', TRUE
  FROM public.wms_skus s
  WHERE s.tenant_id = v_tenant_id AND s.primary_barcode IS NOT NULL
  ON CONFLICT (tenant_id, barcode) DO NOTHING;

  -- -------------------------------------------------------------------------
  -- 03. LOCATION: Zones & bins for the DXB-FC1 pilot floor
  -- -------------------------------------------------------------------------
  INSERT INTO public.wms_zones (tenant_id, warehouse_id, zone_code, name, zone_type, category_target, velocity_target, max_capacity) VALUES
    (v_tenant_id, v_dxb_id, 'RECV-DOCK', 'Inbound Receiving & QC Inspection Dock',   'receiving', 'Inbound',  'high',   250),
    (v_tenant_id, v_dxb_id, 'PHONE-A',   'High-Value Smartphones Pick Zone',         'pick',      'Phones',   'high',   400),
    (v_tenant_id, v_dxb_id, 'WEAR-B',    'Smartwatches & Wearables Zone',            'pick',      'Wearables','high',   200),
    (v_tenant_id, v_dxb_id, 'AUDIO-C',   'TWS Audio & Accessories Zone',             'pick',      'Audio',    'medium', 150),
    (v_tenant_id, v_dxb_id, 'WAVE',      'Pack & Outbound Consolidation Staging',    'packing',   'Staging',  'high',   120)
  ON CONFLICT (warehouse_id, zone_code) DO UPDATE SET name = EXCLUDED.name, zone_type = EXCLUDED.zone_type;

  INSERT INTO public.wms_locations (
    tenant_id, warehouse_id, location_code, zone_code, aisle, rack, shelf, bin, bin_type, pick_sequence, max_units
  ) VALUES
    (v_tenant_id, v_dxb_id, 'RECV-DOCK-01',  'RECV-DOCK', 'DOCK', '01', '01', '01', 'dock',     1, 500),
    (v_tenant_id, v_dxb_id, 'PHONE-A-01',    'PHONE-A',   'A',    '01', '01', '01', 'shelf',   10, 150),
    (v_tenant_id, v_dxb_id, 'PHONE-A-02',    'PHONE-A',   'A',    '01', '02', '01', 'shelf',   12, 150),
    (v_tenant_id, v_dxb_id, 'PHONE-A-03',    'PHONE-A',   'A',    '02', '01', '01', 'shelf',   14, 150),
    (v_tenant_id, v_dxb_id, 'WEAR-B-01',     'WEAR-B',    'B',    '01', '01', '01', 'shelf',   25, 120),
    (v_tenant_id, v_dxb_id, 'WEAR-B-02',     'WEAR-B',    'B',    '01', '02', '01', 'shelf',   27, 120),
    (v_tenant_id, v_dxb_id, 'AUDIO-C-01',    'AUDIO-C',   'C',    '01', '01', '01', 'shelf',   40, 120),
    (v_tenant_id, v_dxb_id, 'PACK-STAGE-01', 'WAVE',      'PACK', '01', '01', '01', 'staging', 90, 200)
  ON CONFLICT (warehouse_id, location_code) DO UPDATE SET zone_code = EXCLUDED.zone_code, pick_sequence = EXCLUDED.pick_sequence;

  -- -------------------------------------------------------------------------
  -- 05. INVENTORY: Opening balances (multi-lot, per-bin) + immutable ledger
  -- -------------------------------------------------------------------------
  INSERT INTO public.wms_inventory_balances (
    tenant_id, warehouse_id, sku_id, location_id, sku_code, location_code, lot_number, on_hand_qty
  )
  SELECT
    v_tenant_id,
    v_dxb_id,
    s.id,
    l.id,
    o.sku_code,
    o.location_code,
    o.lot_number,
    o.qty
  FROM (VALUES
    ('A17Black256',         'PHONE-A-01', 'LOT-2026-11',  39),
    ('A17Black256',         'PHONE-A-01', 'LOT-2026-11B',  5),
    ('A17Black128',         'PHONE-A-02', 'LOT-2026-11',  12),
    ('A17Grey128',          'PHONE-A-02', 'LOT-2026-11',  15),
    ('A17Blue128',          'PHONE-A-03', 'LOT-2026-11',   7),
    ('A17Blue256',          'PHONE-A-03', 'LOT-2026-11',   8),
    ('A076128black',        'PHONE-A-01', 'LOT-2026-11',  21),
    ('A076128Green',        'PHONE-A-03', 'LOT-2026-11',   8),
    ('A36black',            'PHONE-A-03', 'LOT-2026-11',   8),
    ('sS25FEWhite',         'PHONE-A-03', 'LOT-2026-11',   8),
    ('S26Cobalt Violet256', 'PHONE-A-03', 'LOT-2026-11',   8),
    ('Watch8Graphite40',    'WEAR-B-01',  'LOT-2026-11',  21),
    ('Watch8SILVER44',      'WEAR-B-01',  'LOT-2026-11',  12),
    ('watch8Silver40mm',    'WEAR-B-02',  'LOT-2026-11',   9),
    ('MEQW4 S/M',           'WEAR-B-02',  'LOT-2026-11',   8),
    ('Buds3ProSilver',      'AUDIO-C-01', 'LOT-2026-11',  15),
    ('buds4prosilver',      'AUDIO-C-01', 'LOT-2026-11',   8)
  ) AS o(sku_code, location_code, lot_number, qty)
  JOIN public.wms_skus s      ON s.tenant_id = v_tenant_id AND s.sku_code = o.sku_code
  LEFT JOIN public.wms_locations l ON l.warehouse_id = v_dxb_id AND l.location_code = o.location_code
  ON CONFLICT (warehouse_id, sku_code, location_code, lot_number) DO NOTHING;

  INSERT INTO public.wms_inventory_ledger (
    tenant_id, warehouse_id, sku_id, sku_code, transaction_type, qty_delta,
    balance_before, balance_after, to_location_code, lot_number,
    reference_type, reference_id, idempotency_key, operator_name, note
  )
  SELECT
    b.tenant_id, b.warehouse_id, b.sku_id, b.sku_code, 'opening_balance', b.on_hand_qty,
    0, b.on_hand_qty, b.location_code, b.lot_number,
    'MIGRATION', '005_opening_inventory',
    'seed:opening:' || b.warehouse_id || ':' || b.sku_code || ':' || b.location_code || ':' || b.lot_number,
    'Migration 005', 'Pilot opening inventory'
  FROM public.wms_inventory_balances b
  WHERE b.warehouse_id = v_dxb_id
  ON CONFLICT (idempotency_key) DO NOTHING;

  -- -------------------------------------------------------------------------
  -- 04. INBOUND: Pilot purchase orders & dock appointments
  -- -------------------------------------------------------------------------
  INSERT INTO public.wms_purchase_orders (
    tenant_id, warehouse_id, supplier_id, po_number, supplier_name, status, expected_delivery, currency, total_value, lines, created_by
  ) VALUES
    (v_tenant_id, v_dxb_id, v_supplier_samsung, 'PO-2026-1101', 'Samsung Gulf Electronics FZE', 'open', DATE '2026-11-15', 'USD', 8550,
     '[{"sku":"A17Black256","qty":30,"expected":30,"received":0},{"sku":"Watch8Graphite40","qty":15,"expected":15,"received":0}]'::jsonb, 'Migration 005'),
    (v_tenant_id, v_dxb_id, v_supplier_apple, 'PO-2026-1102', 'Apple Authorized FZCO Distribution', 'open', DATE '2026-11-16', 'USD', 7400,
     '[{"sku":"MEQW4 S/M","qty":20,"expected":20,"received":0}]'::jsonb, 'Migration 005')
  ON CONFLICT (tenant_id, po_number) DO NOTHING;

  INSERT INTO public.wms_dock_appointments (
    tenant_id, warehouse_id, appointment_number, po_number, supplier_name, dock_door,
    scheduled_date, scheduled_time, pallet_count, status
  ) VALUES
    (v_tenant_id, v_dxb_id, 'DOCK-9901', 'PO-2026-1101', 'Samsung Gulf Electronics FZE',       'DOCK-01', DATE '2026-11-14', '10:30', 4, 'scheduled'),
    (v_tenant_id, v_dxb_id, 'DOCK-9902', 'PO-2026-1102', 'Apple Authorized FZCO Distribution', 'DOCK-02', DATE '2026-11-15', '14:00', 2, 'scheduled')
  ON CONFLICT (warehouse_id, appointment_number) DO NOTHING;

  -- -------------------------------------------------------------------------
  -- 06. OUTBOUND: Pilot Ozon Global marketplace orders
  -- -------------------------------------------------------------------------
  INSERT INTO public.wms_sales_orders (
    tenant_id, warehouse_id, customer_id, order_number, channel, status, priority,
    required_skus, lines, total_amount, currency, carrier_name, service_level, weight_kg, suggested_box
  )
  SELECT
    v_tenant_id, v_dxb_id, v_customer_id, o.order_number, 'ozon', o.status, o.priority,
    o.sku_code,
    jsonb_build_array(jsonb_build_object('sku', o.sku_code, 'qty', 1, 'price', s.unit_price)),
    s.unit_price, 'USD', 'GBS Express', 'Ozon Global', s.weight_kg,
    CASE WHEN s.category = 'Wearables' THEN 'WATCH-S' WHEN s.category = 'Audio' THEN 'AUDIO-XS' ELSE 'PHONE-S' END
  FROM (VALUES
    ('76957616-0129-1', 'S26Cobalt Violet256', 'urgent'),
    ('59501258-0361-1', 'sS25FEWhite',         'high'),
    ('44965553-0002-1', 'MEQW4 S/M',           'high'),
    ('0139453138-0035-1','A17Black256',        'normal'),
    ('42721081-0100-3', 'A076128black',        'normal'),
    ('56848324-0106-1', 'Watch8Graphite40',    'normal'),
    ('62641446-0460-1', 'Buds3ProSilver',      'normal'),
    ('78954582-0287-1', 'A17Blue128',          'normal')
  ) AS o(order_number, sku_code, priority)
  JOIN public.wms_skus s ON s.tenant_id = v_tenant_id AND s.sku_code = o.sku_code
  ON CONFLICT (warehouse_id, order_number) DO NOTHING;

  -- -------------------------------------------------------------------------
  -- 10. INTEGRATION: Provider endpoints (credentials live in Edge secrets, never here)
  -- -------------------------------------------------------------------------
  INSERT INTO public.wms_integration_endpoints (
    tenant_id, name, endpoint_type, provider, config, status, sync_interval_min
  ) VALUES
    (v_tenant_id, 'Ozon Seller Cross-Border API',   'marketplace', 'Ozon Global',      '{"region":"CIS","mode":"realtime_webhook"}'::jsonb, 'active',  5),
    (v_tenant_id, 'Wildberries FBS Label Pipeline', 'marketplace', 'Wildberries',      '{"pdf_sequencer":true}'::jsonb,                    'active', 15),
    (v_tenant_id, 'Google Sheets Floor Live Sync',  'sheets',      'Google Workspace', '{"bidirectional":true}'::jsonb,                    'active',  5),
    (v_tenant_id, 'GBS Express Carrier Manifest',   'carrier',     'GBS Broker',       '{"hub":"DXB"}'::jsonb,                             'active', 10)
  ON CONFLICT DO NOTHING;

  -- -------------------------------------------------------------------------
  -- 12. REPORTING: bootstrap-required configuration marker
  -- -------------------------------------------------------------------------
  INSERT INTO public.wms_configurations (tenant_id, warehouse_id, config_key, config_value, updated_by)
  VALUES (
    v_tenant_id, v_dxb_id, 'security.bootstrap_required',
    '{"reason":"No operator accounts are seeded by migration 005. Create the first administrator with public.wms_bootstrap_first_admin().","seeded_users":false}'::jsonb,
    'Migration 005'
  )
  ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value;
END;
$$;
