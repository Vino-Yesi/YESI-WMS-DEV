# YESI-WMS — Enterprise Fulfillment Architecture & Operations Guide

> Verified against the live Supabase project (`xtbbnnwthhngapmxqyis`, PostgreSQL 17.11, `ap-south-1`) on 2026-11-14:
> **53** `public.wms_*` tables · **2** views · **29** `wms_*` functions · **122** indexes · **103** RLS policies · **0** tables with RLS disabled.

---

## 1. System blueprint

| Layer | Technology | Responsibility |
|---|---|---|
| **Core database** | Supabase PostgreSQL 17 | 12-domain relational schema, `FOR UPDATE` stock locks, append-only ledger, FEFO allocation, command idempotency |
| **Security & auth** | `pgcrypto` bcrypt + RLS + hashed session tokens | No plaintext credentials anywhere; row-level security on all 53 `wms_*` tables; 5 roles (`admin`, `supervisor`, `operator`, `auditor`, `viewer`) |
| **API & edge compute** | Edge Function `wms-api` v3.0.0 | Health, Prometheus metrics, server-authoritative command execution, leased outbox flush, HMAC webhook ingestion, bootstrap/rotation |
| **Realtime bus** | Supabase Realtime | Multi-terminal floor updates for balances, orders, pick tasks, putaway, QC holds, shipments |
| **Object storage** | Supabase Storage | `wms-labels` (carrier PDFs/PNGs), `wms-pod-media` (proof of dispatch), `wms-documents` (ASN/GRN/XLSX) |
| **Warehouse edge** | Dexie v10 (IndexedDB) + leased outbox | Offline-first scanning; deterministic idempotency keys make replay safe |
| **Clients** | React 19 + TypeScript + Vite 7 + PWA + Tauri v2 | Control tower UI, camera/HID/GS1 scanning, Windows desktop, iOS/Android PWA |
| **Delivery & monitoring** | Docker + Nginx + GitHub Actions + Prometheus + Grafana | Hardened SPA delivery, CI gates (security, lint, types, unit, build, E2E) |

### The two invariants

1. **Single-warehouse scope.** Every operational row carries `tenant_code` + `warehouse_code`; every read filters on both. Cloud RPCs assert context (`wms_assert_context`), the edge engine resolves scope once per operation (`resolveScope()` → `getStockScope()`), and the UI labels which site it is showing.
2. **No invented numbers.** Availability comes from dimensional balances, "shipped today" from real `shippedAt` timestamps, sync throughput from real drain/publish counts, and carrier tracking from this system's own dispatch ledger. Where a fact does not exist, the UI reports that instead of simulating it.

---

## 2. Schema: the 12 domains

Migrations are versioned in `supabase/migrations/` as `001`…`008` and recorded in `supabase_migrations.schema_migrations` (latest: `20261114180000`).

1. **Core** — `wms_tenants`, `wms_companies`, `wms_warehouses`, `wms_roles`, `wms_users`, `wms_user_sessions`, `wms_configurations`. Multi-tenant, multi-warehouse (`DXB-FC1` Dubai Silicon Oasis, `SHJ-HUB2` Sharjah Hub); per-user `allowed_warehouses[]`.
2. **Master** — `wms_uoms`, `wms_categories`, `wms_products`, `wms_skus`, `wms_barcodes`, `wms_suppliers`, `wms_customers`, `wms_carriers`, `wms_packaging_levels`. ABC/velocity class, `fefo_priority` (on `wms_skus`), dimensions, reorder points.
3. **Location** — `wms_zones`, `wms_locations`. Zone → aisle → rack → shelf → bin, temperature zone, `pick_sequence`, weight/unit capacity.
4. **Inbound** — `wms_purchase_orders`, `wms_dock_appointments`, `wms_receipts`, `wms_receipt_lines`, `wms_qc_inspections`, `wms_putaway_tasks`. GRN generation, quarantine holds, directed putaway.
5. **Inventory** — `wms_inventory_balances`, `wms_inventory_ledger`, `wms_lots`, `wms_serial_numbers`, `wms_sim_tac_db`, `wms_reservations`, `wms_cycle_counts`, `wms_stock_adjustments`, `wms_transfers`. **Balances are dimensional**: one row per (warehouse, bin, SKU, lot, `stock_status`, serial) with `on_hand_qty`, `reserved_qty`, `quarantine_qty`, generated `available_qty`, optimistic `version`, and the unique key `wms_balances_stock_dimensions_key`. The ledger is append-only — `UPDATE`/`DELETE` are `REVOKE`d and `wms_guard_ledger_immutability()` blocks any attempt.
6. **Outbound** — `wms_sales_orders`, `wms_order_lines`, `wms_waves`, `wms_pick_tasks`, `wms_box_types`, `wms_cartons`, `wms_pack_lines`. FEFO allocation, wave picking, cartonization.
7. **Replenishment** — `wms_replenishment_rules`, `wms_replenishment_tasks`. Min/max forward-pick.
8. **Transport** — `wms_shipments`, `wms_posting_records`. Rate shopping, labels, tracking numbers, POD media.
9. **Returns** — `wms_returns`. RMA authorization, A/B/C/defective grading, restock vs. quarantine vs. scrap vs. RTV.
10. **Integration** — `wms_integration_endpoints`, **`wms_event_outbox`**, `wms_webhook_inbox`, `wms_connected_devices`, `wms_command_idempotency`, `wms_gsheet_links`, `wms_templates`. The outbox is leased (`lease_owner`, `lease_expires_at`), retry-counted and dead-lettered; `wms_command_idempotency` makes every client command replay-safe.
11. **Audit & labor** — `wms_audit_logs`, `wms_worker_tasks`, `wms_operator_stats`, `wms_operational_telemetry`.
12. **Reporting** — `v_wms_kpi_summary`, `v_wms_users_safe`, `wms_system_metrics`.

### `v_wms_kpi_summary` (22 columns)

Legacy throughput columns plus the v3 reliability columns added by migration `008`:

| Column | Meaning |
|---|---|
| `shipped_today` | Orders with a real `shipped_at` since local midnight — not "all shipped orders" |
| `outbox_dead_letter` | Commands quarantined after exhausting retries |
| `allocation_conflicts` | `ALLOCATION_CONFLICT` / `PICK_SCAN_MISMATCH` events in the last 24 h |
| `avg_sync_latency_ms` | Mean edge→cloud sync latency (`NULL` when nothing has synced) |
| `quarantine_units` | Units physically blocked in `QUARANTINE`/`DAMAGED`/`HOLD` |
| `active_bins` | Distinct bins holding stock right now |

---

## 3. Stored procedures

**Authentication & identity**

- `wms_authenticate_user_v2(p_username, p_password, p_tenant_code, p_warehouse_code, p_device_id, p_user_agent)` — bcrypt verification scoped to tenant *and* warehouse. Failure codes: `TENANT_REQUIRED`, `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED` (+ `locked_until`), `WAREHOUSE_FORBIDDEN`. Success issues `wms_sess_<64hex>` (stored hashed, 8 h TTL), writes a `LOGIN_SUCCESS` audit row and returns `must_change_password` plus the safe user projection. `wms_authenticate_user` (v1) is retained for compatibility only — new callers must use v2.
- `wms_get_bootstrap_status(p_tenant_code)` → `{bootstrap_required, tenant_code, active_users, users_requiring_rotation, bootstrap_completed_at}`.
- `wms_bootstrap_first_admin(...)` — creates the first admin only when the tenant has none; otherwise `BOOTSTRAP_ALREADY_COMPLETED`.
- `wms_rotate_operator_password(p_session_token, p_tenant_code, p_target_username, p_new_password, p_current_password, p_device_id)` — clears the rotation flag and audits `PASSWORD_ROTATED`.
- `wms_validate_password_strength(p_password, p_username)` — ≥10 and ≤128 chars, ≥3 of 4 character classes, not equal to the username, not a common password. Enforced server-side *and* in the browser.
- `wms_upsert_user_secure(...)`, `wms_validate_session(...)`, `wms_revoke_session(...)`, `wms_assert_context(...)`.

**Lifecycle (all idempotent via `p_idempotency_key`)**

- `wms_record_stock_movement(...)` (15 args) — `FOR UPDATE` on the exact dimensional balance, non-negative enforcement, ledger append, outbox emission.
- `wms_receive_inbound_grn(...)` (14 args) — auto-creates the SKU master row, writes `GRN-YYYYMMDD-<6hex>`, raises a QC hold when `qc_status IN ('pending','failed','quarantine')`, otherwise queues `wms_putaway_tasks`. **Receiving does not increment allocatable stock** — putaway does, so un-inspected goods can never be sold.
- `wms_complete_putaway_task(...)` — refuses unless QC is `passed`/`released` (`QC_CHECKPOINT_BLOCKED`).
- `wms_allocate_order_fefo(p_order_number, p_operator, p_warehouse_code, p_tenant_code, p_session_token, p_idempotency_key)` — locks the order, selects `AVAILABLE` balances with `expiry IS NULL OR expiry >= CURRENT_DATE` ordered `expiry ASC NULLS LAST, pick_sequence ASC NULLS LAST, available DESC FOR UPDATE OF b`. Any shortfall ⇒ `ALLOCATION_CONFLICT` / `{ok:false, code:'INSUFFICIENT_STOCK'}` and nothing is reserved. Success raises `reserved_qty` + `version`, writes `wms_reservations` and `wms_pick_tasks` (`to_staging_code = 'PACK-STAGE-01'`) plus a zero-delta ledger row.
- `wms_confirm_pick_task(...)` — requires `p_scanned_code`; a mismatch is a hard failure, not a warning.
- `wms_confirm_order_packed(...)`, `wms_dispatch_order(...)` (9 args, incl. `p_allow_direct_override`), `wms_process_return_rma(...)`, `wms_release_qc_hold(...)` (supervisor/admin only).

**Gateway plumbing**

- `wms_execute_command(p_command, p_payload jsonb, p_idempotency_key, p_tenant_code, p_warehouse_code, p_session_token, p_device_id)` — the single server-authoritative entry point. 9 commands: `record_stock_movement`, `receive_inbound_grn`, `release_qc_hold`, `complete_putaway_task`, `allocate_order_fefo`, `confirm_pick_task`, `confirm_order_packed`, `dispatch_order`, `process_return_rma`. Returns `{ok, deduplicated}`; deduplication happens in `wms_command_idempotency`, so a replayed command can never double-post.
- `wms_claim_outbox_batch(p_owner, p_batch_limit, p_lease_seconds, p_tenant_code, p_event_types[])`, `wms_complete_outbox_event(p_event_id, p_status, p_owner, p_error, p_endpoint, p_response_code)`, `wms_get_outbox_metrics(p_tenant_code)`.
- `wms_ingest_webhook(...)`, `wms_record_telemetry(...)`, `wms_purge_telemetry(...)`, `wms_purge_expired_idempotency(...)`, `wms_guard_ledger_immutability()`, `wms_set_updated_at()`.

---

## 4. Edge Function gateway (`wms-api` v3.0.0)

| Verb | `action` | Notes |
|---|---|---|
| GET | `health` | DB reachability, warehouse KPIs, latency, and the **security posture actually configured** (`cors_mode`, `metrics_auth`, `webhook_auth`) |
| GET | `metrics` | Prometheus OpenMetrics; requires `Authorization: Bearer $WMS_METRICS_TOKEN` |
| GET | `bootstrap_status` | Unauthenticated by design — the login screen must be able to ask before anyone can sign in |
| POST | `bootstrap_admin`, `rotate_password` | First-run admin creation and credential rotation |
| POST | `command` | Runs one `wms_execute_command` invocation |
| POST | `telemetry` | Batches client telemetry into `wms_operational_telemetry` |
| POST | `outbox_metrics` | Counters + the dead-letter queue |
| POST | `flush_outbox` | Claims a leased batch and delivers to configured HTTP subscribers (HMAC-signed), reporting `claimed`/`delivered`/`broadcast`/`failed`/`dead_lettered` |
| POST | `webhook_order` | Marketplace/ERP ingestion; requires `x-yesi-signature` (HMAC-SHA256 of the raw body) or `x-webhook-secret` (raw secret) |

Secrets (set with `supabase secrets set`, never in `.env`): `WMS_ALLOWED_ORIGINS`, `WMS_METRICS_TOKEN`, `WMS_WEBHOOK_SECRET`. With `WMS_ALLOWED_ORIGINS` unset the gateway **denies all browser origins** — server-to-server calls still work. Malformed JSON returns `{ok:false, error:'INVALID_JSON_PAYLOAD'}` with HTTP 400 rather than a parser stack trace.

---

## 5. Edge tier (browser / desktop)

| Module | Role |
|---|---|
| `src/lib/db.ts` | Dexie **v10** schema. Adds `stockBalances`, `outboxEvents`, `telemetryEvents`; tenancy + dimension fields on the operational tables; bootstrap/rotation helpers (`requiresBootstrap`, `bootstrapInitialAdmin`, `rotateLocalPassword`, `validatePasswordStrength`); demo-seed gate (`DEMO_SEED_ENABLED`) |
| `src/lib/stockBalances.ts` | The dimensional FEFO engine: `getStockScope`, `allocatableDimensions`, `planFefoAllocation`, `commitAllocationPlan`, `consumeReservationUnits`, `releaseReservationUnits`, `upsertDimension`, `transferDimension`, `verifyPickScan`, `refreshInventoryRollup`, `expireStaleReservations`. Every local mutation goes through it |
| `src/lib/lifecycle.ts` | The 8 transactional steps (GRN → QC → putaway → allocate → pick → pack → dispatch → RMA), each inside one Dexie transaction with a deterministic idempotency key |
| `src/lib/allocation.ts` | Offline all-or-nothing multi-bin FEFO allocation + scan-verified pick confirmation |
| `src/lib/supabaseSync.ts` | Leased outbox drain under a Web Lock (`yesi-wms:outbox-drain`), cloud snapshot pull (`yesi-wms:cloud-pull`), telemetry batching, dead-letter retry/discard, `getSyncState`/`subscribeSyncState` |
| `src/lib/spreadsheet.ts` | Hardened boundary for untrusted uploads (see *Accepted dependency risk*) |
| `src/lib/auth.tsx` | Session handling plus `getBootstrapStatus`, `bootstrapFirstAdmin`, `rotatePassword`, `mustChangePassword` |
| `src/lib/security.ts` | PBKDF2-SHA256 local hashing, AES-GCM session envelope, RBAC permission matrix, route/warehouse guards |

**FEFO ordering (identical in SQL and TypeScript):** soonest usable expiry → bin `pick_sequence` → deepest bin first on a tie. Expired lots are excluded from allocation, not merely flagged.

**Outbox states:** `pending` → `processing` (leased) → `published`, or `failed` (retried with backoff, max 8 attempts) → `dead_letter`. Dead-lettered events are never silently dropped: they stay listed in Integration Hub and Cloud Monitor with their last error, and can be re-queued (same idempotency key) or discarded (audited).

**Pull contract:** one balance row per (warehouse, bin, SKU, lot, status, serial); the warehouse-scoped set is deleted and re-inserted atomically. `inventory` is a *derived* rollup (`stock`, `availableStock`, `reservedStock`, `quarantineStock`, `binCount`, `lotNumbers[]`, `earliestExpiry`) — never an independent source of truth.

---

## 6. Fulfillment SOPs

1. **Inbound** (`/dock` → `/inbound` → `/qc` → `/putaway`)
   - Schedule and check in the trailer at a dock appointment.
   - Receive in **Inbound GRN**: SKU, quantity, **lot (mandatory)**, expiry (ISO `yyyy-mm-dd` when perishable), receiving bin, PO/supplier. A lot-less receipt is rejected at the form, because it can never be FEFO-allocated or traced later.
   - Anything not `passed` becomes a QC hold naming the bin the units physically occupy.
   - **QC**: release (supervisor/admin) moves the blocked dimension out of `QUARANTINE` and raises a directed putaway task; scrap decrements the blocked dimension. Holds report how many units were actually blocked versus not found in that bin.
   - **Putaway**: confirm against a scanned destination bin. An unscanned confirmation posts to the suggested bin; a scanned bin that disagrees fails with `PUTAWAY_SCAN_MISMATCH`. Stock becomes allocatable only here.
2. **Inventory** (`/inventory`, `/serial-tracking`, `/replenishment`, `/cycle-count`)
   - The Inventory Hub shows one warehouse: per-SKU rollup plus every physical dimension (bin, lot, status, expiry, serial, sellable vs. on hand).
   - Adjustments must name bin + lot + status; the rollup is then recomputed, never written directly. Low-stock pressure uses **sellable** stock, so reserved and quarantined units cannot mask a shortage.
   - Serial/IMEI capture and TAC validation; ABC cycle counts; min/max replenishment.
3. **Outbound** (`/daily` → `/pick-pack` → `/batch-pick` → `/auditor` → `/shipping` → `/posting`)
   - Allocate with FEFO; a shortfall reserves nothing and reports the exact gap.
   - Pick & Pack resolves scans in the order serial → barcode/RFID → SKU → lot, rejects duplicates, checks availability **per bin**, and replays the scan with the FEFO bin/lot on confirmation. The confirmation message lists the bins and lots actually consumed.
   - Dispatch is reservation-accurate, sets `shippedAt`, and refuses a warehouse mismatch.
   - Tracking reconstructs the trail from the local movement ledger and states plainly that no live carrier feed is connected.
4. **Returns** (`/returns`) — receiving bin and lot are captured so returned units land in their own dimension; defective returns route to a QC hold, saleable returns to the directed putaway queue.

---

## 7. Build, deploy, monitor

### Local development

```bash
cp .env.example .env          # every variable documented inline
npm install --legacy-peer-deps
npm run dev                   # Vite on 0.0.0.0:3000
npm run check:security        # secret + hardcoding gate (also runs in build/CI)
npm test                      # vitest unit suites (schema/bootstrap, core, stock engine, spreadsheet boundary)
npm run lint                  # ESLint
npm run build                 # security gate + tsc -b + vite build + PWA
npm run test:e2e              # Playwright smoke suite (CI installs Chromium)
```

Leaving the Supabase variables empty is a supported mode: the app boots into **Offline-Edge**, queues commands locally and replays them idempotently once configured.

### Applying migrations

```bash
supabase db push            # or, per file:
supabase db execute --file supabase/migrations/<version>_<name>.sql
```

Migration `005` in this repository is a **sanitized rewrite** (reference data only, no demo users) and intentionally diverges from the `005` already applied to the live project; legacy remediation for that project lives in `008` §C. Do not re-apply `008` to a database that already has it — it drops and rebuilds the balance uniqueness constraints.

### Production stack

```bash
docker compose up -d --build
```

- **Web (Nginx)** `http://localhost:8080` — SPA/PWA with CSP, `X-Frame-Options: SAMEORIGIN`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` (camera self only) and HSTS. Headers are repeated per-location because Nginx `add_header` inheritance is cancelled by any location-level header; `/sw.js` is served `no-store`. HSTS is inert over plain HTTP and takes effect once TLS terminates in front of the container.
- **Prometheus** `http://localhost:9090` — scrapes `wms-api?action=metrics` every 30 s with the bearer token.
- **Grafana** `http://localhost:3001`.
- **In-app telemetry** — Cloud Monitor (`#/cloud-monitor`) shows the live KPI view for the active warehouse, the ledger tail, outbox counts with lease/retry/error detail, the dead-letter queue, and the gateway's reported security posture. Integration Hub (`#/integration`) exposes endpoint configuration plus the transactional outbox with per-event retry/discard.

### First-run operations

1. Deploy, then open the app. With no active users the login screen offers **Bootstrap first admin** — create it with a strong password (validated client- and server-side).
2. Any operator migrated from a legacy build is flagged `must_change_password` and is routed into rotation at sign-in. `bootstrap_status` reports how many credentials are still pending rotation.
3. Set `WMS_ALLOWED_ORIGINS` to the exact origins that will call the gateway, `WMS_METRICS_TOKEN` for Prometheus, and `WMS_WEBHOOK_SECRET` for marketplace ingestion.

---

## 8. Accepted dependency risk

**`xlsx` 0.18.5** — the last version published to npm — carries two public advisories: prototype pollution (CVE-2023-30533) and ReDoS (CVE-2024-22363). SheetJS distributes patched builds only from `https://cdn.sheetjs.com`, which is outside this project's allowed registries, so the dependency cannot be upgraded from the current build environment. `npm audit fix --force` is **not** an option: it downgrades `vite-plugin-pwa` and `typescript-eslint` to incompatible versions.

Mitigation in force:

- All spreadsheet parsing goes through `src/lib/spreadsheet.ts`. It enforces a 12 MB cap and an extension allowlist **before** the parser runs, converts parser failures into typed `SpreadsheetError` codes, coerces every cell to a primitive, and drops `__proto__` / `constructor` / `prototype` and duplicate header keys before they are used as object keys (rows are built on a `null` prototype).
- `XLSX.write*` (exports generated by this app from its own data) remains the only other use of the library.
- The boundary is unit-tested (`src/__tests__/wms-spreadsheet-boundary.test.ts`).

**Remediation when a patched build is reachable:** replace the npm dependency with the vendor tarball (`npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`) or migrate the four call sites (`InboundReceiving`, `DailyManual`, `Auditor`, plus export paths) to a maintained alternative, then re-run `npm audit`.

Remaining transitive advisories (`deepmerge`, `glob`, `minimatch` via `workbox-build`, and `typescript-eslint`) are dev/build-time only, are not reachable from the shipped bundle, and have no compatible upgrade path without breaking the toolchain.

---

## 9. Known limitations

- **No live carrier tracking feed.** Tracking is reconstructed from this WMS's dispatch ledger; no in-transit status is inferred.
- **Outbox flush with no subscribers publishes nothing.** `flush_outbox` reports `claimed/delivered/broadcast` honestly; configure at least one HTTP subscriber in `wms_integration_endpoints` for fan-out.
- **ReDoS is bounded, not eliminated.** The size cap limits exposure but a crafted sub-limit file can still consume CPU during parse.
- **`wms_authenticate_user` (v1)** still exists for backward compatibility; it is tenant-scoped only and must not be used by new callers.
- **Demo dataset** is development-only, gated behind `VITE_WMS_ENABLE_DEMO_SEED=true`, never seeded in a production build without that flag, and always created with `mustChangePassword: true`. The active posture is shown on the boot screen.
