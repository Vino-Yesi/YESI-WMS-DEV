# YESI-WMS v3.0 Enterprise — Hybrid Cloud + Offline-First Fulfillment Platform

**YESI-WMS** (`yesi-wms-enterprise`) is a warehouse management system built across **12 standardized WMS domains**, powered by **Supabase PostgreSQL 17** (53 RLS-protected tables, 2 reporting views, 29 stored functions, 122 indexes) and an **offline-first Dexie/IndexedDB edge tier** with a **leased transactional outbox**. Scans are answered from local dimensional stock, then replayed to the cloud with idempotency keys, so RF scanners, tablets and desktop stations keep working through Wi-Fi dropouts.

Two invariants drive the design:

1. **One warehouse at a time.** Every operational row is stamped with `tenant_code` + `warehouse_code` and every read is filtered by them. Switching sites cannot post stock against another site's balances.
2. **No invented numbers.** Anything the UI reports — availability, shipped-today counts, sync throughput, carrier tracking — comes from a real ledger row, a real dispatch timestamp or a real gateway response. Where a fact is not available, the UI says so.

---

## Architecture

### Cloud (Supabase PostgreSQL 17)

| Domain | Contents |
|---|---|
| `core` | Tenants (`YESI-FZCO`), companies, warehouses (`DXB-FC1`, `SHJ-HUB2`), roles, users (`pgcrypto` bcrypt), sessions, configurations |
| `master` | UOMs, categories, suppliers, customers, products, SKUs, barcodes (GS1/EAN/UPC/QR), packaging levels |
| `location` | Zones, aisles, racks, levels, bins (`PHONE-A-01-01`), pick sequence, putaway strategies |
| `inbound` | Purchase orders, dock appointments, GRNs, inbound lines, QC inspections, directed putaway tasks |
| `inventory` | Multi-dimensional balances (bin × lot × status × serial), append-only ledger, lots/expiry, serials/IMEI, reservations, cycle counts |
| `outbound` | Sales orders, waves, allocations, pick lists, pick tasks, pack stations, cartons, box types |
| `replenish` | Min/max forward-pick rules, replenishment tasks, transfers |
| `transport` | Carriers, shipments, manifests, posting records (POD media), dock doors |
| `returns` | RMA headers/lines, inspection grading, dispositions (`RESTOCK`, `QUARANTINE`, `SCRAP`, `RTV`) |
| `integration` | **`wms_event_outbox`** (leased, retry-counted, dead-lettered), webhook inbox, integration endpoints, connected devices, command idempotency |
| `audit` | Immutable audit log, system events, operational telemetry |
| `reporting` | `v_wms_kpi_summary` (22 columns), `v_wms_users_safe`, `wms_system_metrics` |

Schema history lives in `supabase/migrations/` as `001`…`008`; `008` (`20261114180000`) introduced the dimensional stock model, the leased outbox, command idempotency, the bootstrap/rotation RPCs and the telemetry table.

**Lifecycle RPCs** (`SECURITY DEFINER`, `FOR UPDATE` row locks, strictly idempotent):

- `wms_authenticate_user_v2` — bcrypt verification scoped to tenant **and** warehouse, device binding, lockout, `LOGIN_SUCCESS` audit, 8-hour hashed session token, `must_change_password` flag.
- `wms_get_bootstrap_status` / `wms_bootstrap_first_admin` / `wms_rotate_operator_password` — first-run admin creation and credential rotation, with `wms_validate_password_strength` enforced server-side.
- `wms_receive_inbound_grn` (14 args) — atomic GRN + lot + QC hold **or** directed putaway task. Receiving never increments allocatable stock; putaway does.
- `wms_complete_putaway_task` — blocked unless QC is `passed`/`released` (`QC_CHECKPOINT_BLOCKED`).
- `wms_allocate_order_fefo` — `FOR UPDATE` FEFO reservation across bins/lots/expiry (`expiry ASC NULLS LAST, pick_sequence ASC NULLS LAST`); a shortfall raises `ALLOCATION_CONFLICT` and reserves nothing.
- `wms_confirm_pick_task` / `wms_confirm_order_packed` — scan-verified picking and carton/weight confirmation.
- `wms_dispatch_order` — atomic deduction, shipment/manifest creation, outbox event emission.
- `wms_process_return_rma`, `wms_release_qc_hold` (supervisor/admin only).
- `wms_execute_command` — the single server-authoritative entry point the client uses; 9 commands routed through `wms_command_idempotency` so a replayed request is deduplicated instead of double-posted.
- Reliability: `wms_claim_outbox_batch`, `wms_complete_outbox_event`, `wms_get_outbox_metrics`, `wms_record_telemetry`, `wms_purge_telemetry`, `wms_purge_expired_idempotency`, `wms_ingest_webhook`, `wms_guard_ledger_immutability` (ledger rows are `REVOKE`d from update/delete).

### Edge Function gateway (`supabase/functions/wms-api`, v3.0.0)

`GET` → `health`, `metrics`, `bootstrap_status` · `POST` → `bootstrap_admin`, `rotate_password`, `command`, `telemetry`, `outbox_metrics`, `flush_outbox`, `webhook_order`.

The gateway enforces an origin allowlist (`WMS_ALLOWED_ORIGINS`; unset ⇒ all browser origins rejected), requires a bearer token for `metrics` (`WMS_METRICS_TOKEN`), verifies an HMAC signature on `webhook_order` (`WMS_WEBHOOK_SECRET`), and returns a machine-readable `INVALID_JSON_PAYLOAD` 400 rather than a stack trace. `health` reports its own security posture so the client can display what is actually configured.

### Edge tier (browser / Tauri)

- **Dexie v10** (`src/lib/db.ts`): `stockBalances`, `outboxEvents`, `telemetryEvents` plus the operational tables, with compound tenancy indexes (`[tenantCode+warehouseCode+…]`).
- **`src/lib/stockBalances.ts`** — the dimensional FEFO stock engine. Every local mutation goes through `upsertDimension` / `transferDimension` / `commitAllocationPlan` / `consumeReservationUnits`, so availability, the rollup and the ledger can never disagree.
- **`src/lib/lifecycle.ts`** — the 8 transactional steps (GRN → QC → putaway → allocate → pick → pack → dispatch → RMA), each in one Dexie transaction with a deterministic idempotency key.
- **`src/lib/supabaseSync.ts`** — leased outbox drain under a Web Lock, cloud snapshot pull, telemetry batching, dead-letter queue with retry/discard.
- **`src/lib/spreadsheet.ts`** — hardened ingestion boundary for untrusted uploads (size/type guards, prototype-pollution key filtering, primitive coercion).

---

## First run and credentials

**There are no default credentials, and none are seeded.** The first user is created through the login screen's bootstrap mode:

1. If the tenant has no active users, the login screen switches to **Bootstrap first admin** (cloud: `wms_get_bootstrap_status` → `wms_bootstrap_first_admin`; offline: `requiresBootstrap()` → `bootstrapInitialAdmin()`).
2. The password is validated in the browser *and* server-side: ≥10 characters, ≥3 of 4 character classes, not equal to the username, not on the common-password list.
3. Operators created later (or migrated from a legacy build) are flagged `must_change_password` and are routed into **Rotate credential** mode at sign-in.

Development only: setting `VITE_WMS_ENABLE_DEMO_SEED=true` seeds a sample Ozon wave (SKUs, balances, orders). Demo accounts are created with `mustChangePassword: true`, and a production build never seeds demo data unless that flag is explicitly `true`. The active posture is surfaced on the boot screen.

---

## Quick start

```bash
# 1. Install dependencies (peer ranges require the legacy resolver)
npm install --legacy-peer-deps

# 2. Configure environment (.env.example documents every variable)
cp .env.example .env

# 3. Development server (binds 0.0.0.0:3000)
npm run dev

# 4. Verification
npm run check:security   # secret + hardcoding gate (blocks the build)
npm test                 # vitest unit suites
npm run lint             # eslint
npm run build            # security gate + tsc -b + vite build (+ PWA)
npm run test:e2e         # Playwright smoke suite (CI installs Chromium)
```

Leaving `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` empty is supported: the app boots into **Offline-Edge mode**, queues every lifecycle command in the local outbox and replays it (with idempotency keys) once a cloud scope is configured.

---

## Deployment & observability

Full architecture, SOPs and runbooks: [`docs/ARCHITECTURE-AND-OPERATIONS.md`](docs/ARCHITECTURE-AND-OPERATIONS.md). Module-by-module workflow catalog: [`docs/WORKFLOW-AND-DEVELOPER-CATALOG.md`](docs/WORKFLOW-AND-DEVELOPER-CATALOG.md). Step-by-step build / develop / deploy procedures — including the secure drop-file (drag-and-drop) release flow: [`docs/BUILD-DEVELOP-DEPLOY-SOP.md`](docs/BUILD-DEVELOP-DEPLOY-SOP.md).

```bash
docker compose up -d --build
```

| Service | Endpoint | Purpose |
|---|---|---|
| WMS web app (Nginx 1.27) | `http://localhost:8080` (`/healthz`) | SPA + PWA; serves CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS (see `ops/nginx.conf`) |
| Supabase Edge API | `/functions/v1/wms-api` | Health, Prometheus metrics, command execution, outbox flush, order webhooks |
| Prometheus | `http://localhost:9090` | Scrapes `wms-api?action=metrics` every 30 s (bearer token required) |
| Grafana | `http://localhost:3001` | Throughput, outbox depth and dead-letter dashboards |

Operational health is visible in-app at **Cloud Monitor** (`#/cloud-monitor`): live `v_wms_kpi_summary` for the active warehouse, the immutable ledger tail, outbox status counts with lease/retry/error detail, the dead-letter queue, and the gateway's reported security posture.

---

## Known limitations

These are deliberate, documented gaps rather than silent ones:

- **`xlsx` 0.18.5** is the last release published to npm and carries two advisories (prototype pollution CVE-2023-30533, ReDoS CVE-2024-22363). Patched builds are distributed only from `cdn.sheetjs.com`, which is outside this project's allowed registries. All spreadsheet parsing is therefore funnelled through `src/lib/spreadsheet.ts`, which caps upload size, rejects unsupported types and strips pollution keys before any parsed value reaches business logic. Upgrading the dependency is tracked in `docs/ARCHITECTURE-AND-OPERATIONS.md` → *Accepted dependency risk*.
- **No live carrier tracking feed.** The tracking view reconstructs a trail from this WMS's own dispatch ledger and states that no in-transit status is inferred.
- **HSTS is inert on the container's plain-HTTP listener** and takes effect once TLS is terminated in front of it. `preload` is intentionally not enabled.
