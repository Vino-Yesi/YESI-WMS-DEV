# YESI-WMS v2.1 Enterprise — Master Workflow, Progress & Developer Operations Catalog

> **Document Purpose**: Unified operational, architectural, workflow, build, testing, and deployment catalog for **YESI-WMS Enterprise v2.1** (`Vino-Yesi/YESI-WMS`). Covers end-to-end warehouse fulfillment workflows, project progress & completed hardening milestones, performance engineering, and step-by-step developer SOPs for local development, quality gates, database/Edge deployment, desktop/mobile builds, and production operations.

---

## Part I — Project Progress & Milestone Catalog

| Phase | Domain | Status | Key Deliverables & Files |
| :--- | :--- | :---: | :--- |
| **Phase 1** | **12-Domain Relational Core & RLS** | Completed | `53` PostgreSQL `wms_*` tables across 12 domains (`supabase/migrations/001..008`), 29 `wms_*` RPCs, 122 indexes, `0` tables without RLS, `0` `SECURITY DEFINER` RPCs without pinned `search_path`. |
| **Phase 2** | **Zero-Secret Config & Session Security** | Completed | Strict runtime validator (`src/lib/config.ts`), client secret leak blocker (`scripts/security-check.mjs`), non-extractable Web Crypto `AES-256-GCM` session envelope (`src/lib/security.ts`), `PBKDF2-SHA256` offline auth + `pgcrypto` cloud auth (`src/lib/auth.tsx`), progressive brute-force lockout (5 attempts, then 5→60 min exponential), and warehouse-scoped RBAC (`DXB-FC1`, `SHJ-HUB2`). |
| **Phase 3** | **Atomic 8-Stage Fulfillment Lifecycle** | Completed | Transactional Dexie + PostgreSQL RPC engine (`src/lib/lifecycle.ts`, `src/lib/allocation.ts`) spanning **Inbound GRN → QC Hold/Release → Directed Putaway → All-or-Nothing FEFO Allocation → Pick → Pack → Carrier Dispatch → Returns/RMA**, backed by immutable double-entry stock ledger entries. |
| **Phase 4** | **Hybrid Outbox Sync & Conflict Resolution** | Completed | Idempotent outbox queue (`src/lib/supabaseSync.ts`) with payload schema validation, exponential backoff + jitter, Dead-Letter Queue (DLQ) retry/inspection, stage-monotonic conflict resolution, and throttled Realtime sync. |
| **Phase 5** | **Cross-Origin Iframe & Floor Performance Hardening** | Completed | Non-throwing storage adapter (`src/lib/safeStorage.ts`) preventing `DOMException: SecurityError` crashes in cross-origin preview iframes / Safari ITP / kiosk modes; isolated `<LiveClock />` and `useRef` inactivity tracking eliminating 1 Hz / pointer-event TopBar & AuthContext re-renders; windowed virtualization (`InventoryHub.tsx`) and parallel indexed queries (`Dashboard.tsx`). |
| **Phase 6** | **CI/CD, Multi-Platform Build & Observability** | Completed | GitHub Actions secret/lint/unit/dual-mode build pipeline (`.github/workflows/ci-cd.yml`), Supabase Edge Function `wms-api` (health, Prometheus metrics, webhook inbox, outbox flush), Docker + Nginx + Prometheus + Grafana stack, PWA offline service worker, and Tauri v2 desktop/mobile build targets. |
| **Phase 7** | **Dimensional Stock Granularity, Cloud Idempotency & Zero-Default-Credential First Run** | Completed | `supabase/migrations/20261114180000_008_*.sql`: `wms_inventory_balances` becomes dimensional (bin × lot × status × serial, unique key, generated `available_qty`, optimistic `version`); append-only ledger guard; leased `wms_event_outbox` with retry + DLQ; `wms_command_idempotency` / `wms_execute_command`; bootstrap, rotation and telemetry RPCs; `wms_authenticate_user_v2` (hashed 8 h sessions, `must_change_password`). Edge: `src/lib/stockBalances.ts` (single stock mutator), `src/lib/spreadsheet.ts` (hardened untrusted-upload boundary), Dexie v10, gateway v3.0.0 with strict CORS allowlist, token-gated metrics, HMAC webhooks, real leased outbox delivery and SSRF guard on webhook targets. |

---

## Part II — End-to-End Warehouse Workflow Catalog

### 1. 8-Stage Transactional Fulfillment Pipeline

```text
[Stage 1: Dock & Inbound GRN] ──► [Stage 2: QC Inspection] ──► [Stage 3: Directed Putaway]
          (/dock, /inbound)                 (/qc)                       (/putaway)
                                                                            │
                                                                            ▼
[Stage 6: Pack & Weight Audit] ◄── [Stage 5: Wave / Floor Pick] ◄── [Stage 4: FEFO Allocation]
     (/pick-pack, /auditor)          (/pick-pack, /batch-pick)        (allocation.ts / RPC)
                │
                ▼
[Stage 7: Carrier Dispatch & POD] ──► [Stage 8: RMA & Returns Disposition]
      (/shipping, /posting)                        (/returns)
```

| Stage | Route(s) | Required RBAC Permission | Core Engine / RPC | Operational Workflow & Invariants |
| :--- | :--- | :--- | :--- | :--- |
| **1. Dock & Inbound Receiving** | `/dock`, `/inbound` | `dock.view`, `inbound.execute` | `receiveInboundTransactional` / `wms_receive_inbound_grn` | Schedule ASN/trailer at dock, scan supplier SKU/PO or upload an Excel manifest (parsed only through `src/lib/spreadsheet.ts`), record GRN receipt into `receivingBin` (default `RECV-DOCK-01`) with a **mandatory lot number** and ISO `expiryDate`, log immutable ledger deltas, and auto-route to a `QUARANTINE` hold dimension (failed/pending QC) or the putaway queue. A GRN never inflates sellable stock: units only become allocatable after putaway. |
| **2. Quality Control (QC)** | `/qc` | `qc.inspect`, `qc.release` *(Supervisor/Admin)* | `createQcHoldTransactional` + `dispositionQcHoldTransactional` / `wms_release_qc_hold` | Flagged or defective lots enter a `QCHold` **and** a real `QUARANTINE` dimension at the named bin (default `QC-HOLD-AREA`), so blocked units are counted and physically visible while remaining unallocatable. Only roles holding `qc.release` (supervisor/admin) can **Release** (moves the units to a `HOLD` dimension and queues a directed putaway task) or **Scrap** (decrements the quarantine dimension and closes the hold as `rejected`). |
| **3. Directed Putaway** | `/putaway` | `putaway.execute` | `completePutawayTransactional` / `wms_complete_putaway_task` | Scores optimal destination bin (`PHONE-A-01`, `WEAR-B-01`, `AUDIO-C-01`) by SKU velocity, category, and zone capacity. Blocks putaway unless QC is `passed`/`released` (`QC_CHECKPOINT_BLOCKED`), accepts a scanned destination bin and rejects a mismatch (`PUTAWAY_SCAN_MISMATCH`), transfers the dimension from the staging bin to the active bin, and releases any staging `HOLD`. |
| **4. All-or-Nothing FEFO Allocation** | `/pick-pack`, `/batch-pick`, `/ozon-sheets` | `outbound.execute` | `allocateOrder` (`src/lib/allocation.ts`) → `planFefoAllocation` + `commitAllocationPlan` / `wms_allocate_order_fefo` | Sorts candidate dimensions by earliest `expiryDate` (`FEFO`), then `fefo_priority`, then pick sequence, then deepest bin — identical ordering in TypeScript and SQL. Enforces **all-or-nothing** reservation: if any SKU line is short, zero partial reservations leak and an `ALLOCATION_CONFLICT` is audited. The hold against a dimension is `max(reserved_qty, active local promises)` — never their sum, which would double-count the same promise. |
| **5. Wave, Batch & Instant Pick** | `/daily`, `/batch-pick`, `/pick-pack` | `daily.execute`, `outbound.execute` | `routeOptimizer` (`compute.worker.ts`) | Nearest-neighbor + 2-Opt **Quantum Route** pathing across warehouse zones; supports single-order, batch, zone, and 5-step Daily Instant Wave fulfillment. |
| **6. Pack & Barcode/Weight Audit** | `/pick-pack`, `/auditor` | `outbound.pack` | `confirmPickAndPackTransactional` / `verifyPickScan` | Carton recommendation (`BoxSize`), scan-by-scan verification (`VALID`, `PARTIAL`, `QTY_EXCEEDED`, `UNKNOWN_ORDER`), transitions order `Picking → Packed`, consumes units from the **exact** reserved dimension, and awards operator XP. Scans resolve serial → barcode/RFID → SKU → lot, duplicate scans are rejected, and a wrong-bin scan hard-fails with `PICK_SCAN_MISMATCH`. |
| **7. Carrier Dispatch & POD** | `/shipping`, `/posting` | `outbound.ship` | `dispatchShipmentTransactional` / `wms_dispatch_order` | Accepts the carrier and tracking number supplied by the operator (the system does **not** fabricate tracking numbers or simulate carrier events), prints the `ShippingLabel`, ships units from the bins already picked for the order — re-allocating by strict FEFO only for anything unpicked — writes `outbound` ledger deltas, closes reservations as `picked`, marks the order `Shipped` with a real `shippedAt`, and captures photo/video Proof-of-Dispatch (`PostingTracker`). Tracking reports only what we know: `dispatched` / `awaiting_dispatch` / `returned`, the carrier, and the last bin. |
| **8. Returns & RMA Grading** | `/returns` | `returns.execute` | `processReturnTransactional` / `wms_process_return_rma` | Grades returned items at a named receiving bin (default `RETURNS-DOCK`) with its own lot: **Restockable (Grade A)** posts an allocatable dimension + creates a `returns` putaway task; **Damaged/Defective** posts a single `QUARANTINE` dimension and a matching `qcHolds` row so the units are counted but never sellable; **Scrap** requires `returns.manage`. |

---

### 2. Complete Application Module & Route Directory (33 Modules)

| Domain | Module | Route | Permission Gate | Primary Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **01. Control** | Control Tower Dashboard | `/` or `/dashboard` | `dashboard.view` | Live KPIs, stockout forecasts, low-stock alerts, recent movements |
| **01. Control** | Daily Instant Manual | `/daily` | `daily.execute` | 5-step Ozon/marketplace wave receive → sequence → audit → ship → summary |
| **01. Control** | Workflow Blueprint | `/workflow` | `workflow.view` | Visual interactive map of warehouse stages & live bottlenecks |
| **01. Control** | Guardian Ops Center | `/guardian` | `guardian.view` | Pressure scenarios, dynamic operational adaptation, DB cleanup |
| **01. Control** | Cloud Core & Telemetry | `/cloud` | `cloud.view` | Supabase Edge health, warehouse switcher, SQL ledger & outbox monitor |
| **04. Inbound** | Dock Scheduling & ASN | `/dock` | `dock.view` | Yard/trailer appointments, check-in, dock door status |
| **04. Inbound** | Inbound Receiving & GRN | `/inbound` | `inbound.execute` | Manual RF scan, XLSX manifest import, PO line reconciliation |
| **04. Inbound** | Quality Inspection | `/qc` | `qc.inspect` | Quarantine holds, defect inspection, supervisor release/scrap |
| **04. Inbound** | Directed Putaway | `/putaway` | `putaway.execute` | Slotting-scored putaway queue & bin confirmation |
| **05. Inventory** | Inventory Hub & Oracle | `/inventory` | `inventory.view` | Virtualized master SKU table, ABC classes, 7-day Oracle forecast, Sentinel |
| **05. Inventory** | Serial & IMEI Tracking | `/serial-tracking` | `serial.track` | End-to-end IMEI1/IMEI2/serial lifecycle & warranty chain |
| **05. Inventory** | ABC Cycle Counting | `/cycle-count` | `cycle_count.execute` | Blind/guided bin counts & variance reconciliation |
| **07. Replenish** | Min/Max Replenishment | `/replenishment` | `replenishment.execute` | Forward-pick bin auto-replenishment tasks |
| **06. Outbound** | Pick & Pack Station | `/pick-pack` | `outbound.execute` | Order FEFO allocation, pick confirmation, box sizing, pack sign-off |
| **06. Outbound** | Wave & Batch Pick Center | `/batch-pick` | `outbound.execute` | Multi-order wave grouping & Quantum 2-Opt pick pathing |
| **08. Transport** | Carrier Dispatch & Manifest | `/shipping` | `outbound.ship` | Rate shopping, thermal label print, atomic dispatch |
| **08. Transport** | POD Tracker | `/posting` | `outbound.ship` | Camera photo/video + geolocation Proof-of-Dispatch |
| **09. Returns** | RMA & Returns | `/returns` | `returns.execute` | Return grading, restock vs. quarantine disposition |
| **10. Floor Tools** | PDF Label Sequencer | `/pdf-sequencer` | `tools.use` | Ozon/WB thermal PDF page reordering to match pick sequence |
| **10. Floor Tools** | Pack & Weight Auditor | `/auditor` | `outbound.pack` | High-speed barcode & carton verification station |
| **10. Floor Tools** | RF / Camera Scanner | `/barcode-scanner` | `tools.use` | Hardware wedge / mobile camera QR & 1D barcode scanner |
| **10. Floor Tools** | Location & SKU Barcodes | `/barcode-generator` | `tools.use` | Batch PNG/ZIP/Sheet generator for bin, EAN-13, and IMEI labels |
| **10. Floor Tools** | SIM / IMEI TAC Registry | `/sim-manager` | `tools.use` | GSMA TAC prefix lookup & device model registry |
| **10. Floor Tools** | Ozon Live Sheet Pipeline | `/ozon-sheets` | `tools.use` | Automated Google Sheets → WMS order ingestion & FEFO auto-allocation |
| **10. Floor Tools** | Daily G-Sheet Tracker | `/gsheet` | `tools.use` | Client expected vs. packed quantity sheet tracker |
| **10. Floor Tools** | SKU Mapping Templates | `/templates` | `tools.use` | Raw marketplace title → canonical warehouse SKU mapper |
| **10. Floor Tools** | Bulk Data Converter | `/bulk-convert` | `tools.use` | Batch CSV/TSV/XLSX normalization utility |
| **11/12. Admin** | ERP / OMS Integration Hub | `/integrations` | `integrations.manage` | Webhook/API connectors & sync telemetry *(Supervisor+)* |
| **11/12. Admin** | Labor & UPH Management | `/labor` | `labor.manage` | Worker task assignment, Units-Per-Hour (UPH), accuracy *(Supervisor+)* |
| **11/12. Admin** | Operational Analytics | `/analytics` | `reports.view` | Throughput, SLA, carrier cost, and ABC value charts |
| **11/12. Admin** | Warehouse Rules & Memory | `/memory` | `memory.manage` | Aliases, slotting preferences, and automation rules *(Supervisor+)* |
| **11/12. Admin** | RBAC User & Audit Mgmt | `/users` | `users.manage` | Operator provisioning, role assignment, immutable audit log *(Admin)* |
| **11/12. Admin** | System Settings | `/settings` | `dashboard.view` | UI density (`compact`/`comfortable`), JSON backup/restore, diagnostics |

---

## Part III — Performance & Reliability Architecture

1. **Sandboxed Storage Resilience (`src/lib/safeStorage.ts`)**:
   - Wraps `localStorage`, `sessionStorage`, `matchMedia`, and `crypto.randomUUID` with non-throwing adapters + in-memory mirrors. Prevents `DOMException: SecurityError` crashes in cross-origin preview iframes, Safari ITP, private browsing, and quota-full warehouse tablets.
2. **Zero-Jank Render Isolation**:
   - `TopBar.tsx` isolates the 1-second clock inside `<LiveClock />` so notifications, XP popovers, and `SyncStatus` never re-render on clock ticks.
   - `auth.tsx` tracks rolling 45-minute inactivity via `lastActivityRef` instead of React state, avoiding full-app context re-renders on `scroll`/`mousedown`/`keydown`.
   - `CommandPalette.tsx` only mutates store state on `Escape` when the palette is open.
3. **High-Density Floor Virtualization & Parallel Queries**:
   - `InventoryHub.tsx` uses windowed viewport slicing (`ROW_HEIGHT = 44px` + overscan) to sustain 60 FPS with 10,000+ SKUs.
   - `Dashboard.tsx` executes 9 parallel indexed Dexie count/limit queries via `Promise.all`.
   - Heavy TSP 2-Opt route optimization and 7-day demand forecasting run off the main thread in `src/workers/compute.worker.ts`.
4. **Vendor Chunk Splitting (`vite.config.ts`)**:
   - Splits `vendor-pdf`, `vendor-scanner`, `vendor-supabase`, `vendor-ui`, and `vendor-react` (with `resolve.dedupe` for React 19 / React Router 7) while lazy-loading all 29 route pages.

---

## Part IV — Developer Guide: Build, Develop & Deployment Procedures

> The copy-paste, step-by-step version of everything in this part — including the
> CI-built drop-file (drag-and-drop) release flow, the post-deploy verification
> runbook and the secure-context (`INSECURE_CONTEXT`) troubleshooting notes — lives
> in [`docs/BUILD-DEVELOP-DEPLOY-SOP.md`](BUILD-DEVELOP-DEPLOY-SOP.md). This part
> stays the architecture-flavoured reference; the SOP is what you follow at a
> terminal.

### 1. Prerequisites
- **Node.js**: `v20 LTS` or `v22+` (`npm 10+`)
- **Optional (Desktop / Native Mobile)**: Rust stable toolchain (`rustup`), Tauri CLI v2 (`@tauri-apps/cli`), Windows WebView2 / MSVC or Xcode / Android SDK
- **Optional (Containerized Ops Stack)**: Docker Engine `24+` & Docker Compose `v2`
- **Optional (Cloud Mode)**: Supabase project (`PostgreSQL 17+` with `pgcrypto` enabled)

---

### 2. Local Environment Setup & Operating Modes

YESI-WMS supports two deterministic operating modes controlled strictly via environment variables:

#### Mode A — Offline-Edge Mode (Zero Cloud Dependencies)
Runs 100% locally on IndexedDB (`Dexie`) + Web Crypto `PBKDF2-SHA256` + `AES-256-GCM`.
```bash
git clone https://github.com/Vino-Yesi/YESI-WMS.git
cd YESI-WMS
npm install --legacy-peer-deps
npm run dev -- --host 0.0.0.0 --port 3000
```
- **There are no default credentials, and none are seeded.** On an empty database the login screen switches to **Bootstrap first admin** (`requiresBootstrap()` → `bootstrapInitialAdmin()` offline; `wms_get_bootstrap_status` → `wms_bootstrap_first_admin` in cloud mode). The chosen password is validated by `wms_validate_password_strength` — ≥10 and ≤128 characters, at least 3 of 4 character classes, not equal to the username, not a common password — and every seeded account is flagged `mustChangePassword`, which the login flow forces through `rotate_password` before the app opens.
- **Optional demo dataset**: set `VITE_WMS_ENABLE_DEMO_SEED=true` to seed the sample Ozon wave (SKUs, dimensional balances, orders) plus four throwaway accounts for local evaluation only. A production `vite build` never seeds it, and the flag is off by default in `.env.example`. The credentials are deliberately **not documented here** — read them from `seedDemoWaveData()` / `seedDatabase()` in `src/lib/db.ts` on a build where you turned the flag on, and never enable the flag on a warehouse that touches real stock.

#### Mode B — Hybrid Cloud-Connected Mode (Supabase PostgreSQL + Edge + Realtime)
1. Copy `.env.example` to `.env` (gitignored):
   ```bash
   cp .env.example .env
   ```
2. Populate `.env` with **publishable** client configuration only:
   ```dotenv
   VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=<your-publishable-anon-key>
   VITE_WMS_TENANT_CODE=YESI-FZCO
   VITE_WMS_DEFAULT_WAREHOUSE=DXB-FC1
   VITE_WMS_ENABLE_DEMO_SEED=
   ```
   Omitting `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (or setting them invalid) boots the app in Offline-Edge mode: every lifecycle write stays in IndexedDB and queues in the transactional outbox until a cloud scope exists. See `docs/ARCHITECTURE-AND-OPERATIONS.md` for the full variable list.
   > **Security Rule**: Never place `SUPABASE_SERVICE_ROLE_KEY` or `sb_secret_*` keys in `.env` or any `VITE_*` variable. Both `src/lib/config.ts` (at runtime) and `scripts/security-check.mjs` (at build/CI time) actively block privileged keys.

---

### 3. Daily Developer Commands & Quality Gates

Run all five verification gates before opening or updating any pull request:

```bash
# 1. Secret & Credential Leak Gate (scans all git-tracked files)
npm run check:security

# 2. Unit & Invariant Suite (Vitest + fake-indexeddb + happy-dom — 101 tests / 5 files)
#    wms-schema-and-bootstrap (8) · wms-core (14) · wms-stock-engine (37)
#    wms-lifecycle (29) · wms-spreadsheet-boundary (13)
npm test

# 3. Static Analysis (ESLint 9 + TypeScript-ESLint — must report 0 errors;
#    pre-existing warnings in untouched utility pages are tolerated, but any file
#    you edit must be lint-clean: npx eslint src/lib/<file>.ts src/pages/<Page>.tsx)
npm run lint

# 4. Production Typecheck + Bundle + PWA Build (Cloud + Offline-Edge verification)
npm run build
VITE_SUPABASE_URL="" VITE_SUPABASE_ANON_KEY="" npm run build

# 5. Preview Production Bundle Locally on Port 3000
npm run preview -- --host 0.0.0.0 --port 3000
```

`vite.config.ts` carries an explicit `test` block that restricts Vitest to
`src/__tests__`, so the Playwright specs under `e2e/` are never collected by
`npm test`. Run them separately:

```bash
npx playwright install --with-deps chromium
npm run test:e2e
```

The Playwright smoke test drives the **real first-run path**: it boots a fresh
browser profile with no seeded logins, expects the login screen to report that no
administrator exists, creates one through the bootstrap form, then walks the ten
core lifecycle routes and asserts the encrypted session survives a reload. It
hard-codes no credentials — the password is generated per run.

#### Secret scanning in CI

Two independent scanners run, and they answer different questions:

| Scanner | Scope | Blocks? |
| :--- | :--- | :--- |
| `npm run check:security` (`scripts/security-check.mjs`) | Every git-tracked file in the working tree: client secret keys, service-role JWTs, insecure session writes | Yes, on every push and PR |
| `scripts/gitleaks-ci.sh <version> range` | Only the commits introduced by the event (`base..HEAD`, or the tip commit when a branch is brand new) | Yes, on every push and PR |
| `scripts/gitleaks-ci.sh <version> history` | **Every commit ever made** | Advisory: nightly + `workflow_dispatch`, `continue-on-error: true`, JSON report uploaded as an artifact |

The pinned gitleaks CLI is used instead of `gitleaks/gitleaks-action@v2`. That
action decides whether it may run by asking the GitHub API for the repository
owner's type and, if the call fails for any reason, falls back to "licence
required" and exits 1 **without scanning anything** — which made the step fail
intermittently on this personal-account repository, where no licence is needed.
It also floats on a mutable tag and adds third-party JS to the pipeline. The
script pins the version and verifies the archive's SHA-256 against the checksums
published with the same release, so the scan either runs the exact binary we asked
for or fails loudly. `GITLEAKS_BIN` is an escape hatch for air-gapped runners; CI
does not set it.

Findings are rendered into the job summary (rule, file, line, commit, author,
entropy — the secret itself is masked by `--redact=100`) and uploaded as a JSON
artifact, because an advisory scan whose results only exist in a red log is
worthless. The upload step carries `if: always()`, which is precisely the case it
exists for.

A historical finding needs credential rotation and possibly a history rewrite, so
it must never block an unrelated pull request — hence the advisory nightly job.
If it reports something: judge whether the value was ever actually secret, rotate
it if it was, and only then consider a rewrite. Vetted exceptions go in
`.gitleaksignore` using the **commit-scoped** form
(`commit:file:rule-id:start-line`); the global form (`file:rule-id:start-line`)
would also silence the same file and line in future commits, which is exactly
where the next real secret would appear.

The two entries currently in `.gitleaksignore` were accepted on 2026-11-15: the
Supabase **publishable** (anon) key committed in `70405ba` at `.env.example:3` and
`src/lib/supabase.ts:4`. A publishable key ships inside every browser bundle and
grants nothing beyond what RLS allows — it was never a secret — and both lines are
gone from the current tree (`.env.example` ships empty values; `supabase.ts` has no
hard-coded fallback and drops into Offline-Edge mode without one). Rotating it in
the Supabase dashboard is still recommended if you want the historical value dead.

---

### 4. Database Migration & Supabase Edge Function Deployment SOP

When provisioning a new Supabase environment or promoting schema changes:

1. **Apply SQL Migrations in Order**:
   Apply the eight migrations under `supabase/migrations/` sequentially (`20261114134627_001_core_master_location_domains.sql` through `20261114180000_008_stock_granularity_idempotency_bootstrap_outbox_telemetry.sql`) via the Supabase CLI or SQL Editor:
   ```bash
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```
   Two caveats: `005` here is a sanitized rewrite (reference data only — no demo
   users) and intentionally diverges from the `005` already applied to the pilot
   project; legacy remediation for that project lives in `008` §C. And `008` is
   destructive to pre-dimensional balances, so never re-apply it to a database
   whose `supabase_migrations.schema_migrations` already records `20261114180000`.
2. **Verify RLS & Security Definer Hardening**:
   Run this verification query in Supabase SQL Editor — both counts **must** equal `0`:
   ```sql
   SELECT
     (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'wms_%' AND NOT rowsecurity) AS tables_without_rls,
     (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'wms_%' AND p.prosecdef AND p.proconfig IS NULL) AS secdef_without_search_path;
   ```
   Reference values for the pilot project after `008`: 53 `wms_*` tables, 2 views
   (`v_wms_kpi_summary`, `v_wms_users_safe`), 29 `wms_*` functions, 122 indexes,
   103 RLS policies, and `0` RLS gaps. Also confirm the ledger is append-only:
   `REVOKE UPDATE, DELETE ON wms_inventory_ledger FROM authenticated, anon` plus the
   `wms_guard_ledger_immutability()` trigger.
3. **Configure Edge Function Secrets & Deploy `wms-api`**:
   ```bash
   npx supabase secrets set WMS_ALLOWED_ORIGINS="https://your-production-domain.com"
   npx supabase secrets set WMS_METRICS_TOKEN="<strong-random-prometheus-bearer-token>"
   npx supabase secrets set WMS_WEBHOOK_SECRET="<strong-random-hmac-secret>"
   npx supabase functions deploy wms-api --no-verify-jwt
   ```
   All three are mandatory for gateway v3.0.0 to be fully functional, and each
   fails **closed** when unset: with no `WMS_ALLOWED_ORIGINS` every browser origin
   is rejected (server-to-server calls without an `Origin` header still work),
   `?action=metrics` returns `METRICS_DISABLED`, and `?action=webhook_order`
   returns `WEBHOOK_UNAUTHORIZED`. Generate both tokens with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
   Inbound webhooks authenticate with `x-webhook-secret` (raw shared secret) or
   `x-yesi-signature` (HMAC-SHA256 hex of the raw body). Deploy with
   `--no-verify-jwt` because the gateway authenticates its own `wms_sess_<64hex>`
   session tokens and validates the metrics/webhook secrets itself; requiring a
   Supabase JWT on top would only lock out the bootstrap and metrics callers.
4. **Verify Edge Gateway Health**:
   ```bash
   curl -s "https://<your-project-ref>.supabase.co/functions/v1/wms-api?action=health&warehouse=DXB-FC1" \
     -H "apikey: <your-anon-key>"
   ```
   The response reports the gateway `version`, the warehouse KPIs from
   `v_wms_kpi_summary`, and a `security` posture block (`cors_mode`,
   `allowed_origin_count`, `metrics_auth`, `webhook_auth`) that `CloudMonitor.tsx`
   renders verbatim. Malformed JSON returns `INVALID_JSON_PAYLOAD` (400) and an
   unlisted browser origin returns `ORIGIN_NOT_ALLOWED` (403) without echoing it.

---

### 5. Production Deployment Procedures

#### Option A — Docker + Nginx + Prometheus + Grafana (Recommended Self-Hosted / Warehouse Server)
`Dockerfile` performs a multi-stage Node 20 Alpine build and serves `dist/` via hardened Nginx (`8080`) with SPA fallback and `/healthz` probes.
```bash
# Export build-time public variables (or pass via CI secrets)
export VITE_SUPABASE_URL="https://<your-project-ref>.supabase.co"
export VITE_SUPABASE_ANON_KEY="<your-publishable-anon-key>"
export VITE_WMS_TENANT_CODE="YESI-FZCO"
export VITE_WMS_DEFAULT_WAREHOUSE="DXB-FC1"

docker compose up -d --build
```
- **WMS Web Application**: `http://localhost:8080` (Health probe: `http://localhost:8080/healthz`)
- **Prometheus Metrics UI**: `http://localhost:9090` (scrapes `wms-api?action=metrics`)
- **Grafana Operations Dashboards**: `http://localhost:3001`

#### Option B — Cloud Static / Edge Hosting (Vercel / Netlify / Cloudflare Pages)
- **Build Command**: `npm run build`
- **Publish Directory**: `dist`
- **Node Version**: `20`
- **SPA Rewrite Rule**: Rewrite all non-asset routes (`/*`) to `/index.html` (`200`), already configured in `netlify.toml`.
- **Environment Variables**: Configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_WMS_TENANT_CODE`, and `VITE_WMS_DEFAULT_WAREHOUSE` in the hosting dashboard.

#### Option C — Native Desktop (`.exe` / `.msi`) & Mobile PWA
- **Windows Desktop (Tauri v2)**:
  ```bash
  npm run tauri:build
  # Artifacts generated in src-tauri/target/release/bundle/{msi,nsis}/
  ```
- **iOS / Android Floor Scanners (Installable PWA)**:
  - Deploy over HTTPS.
  - On iOS Safari: tap **Share → Add to Home Screen** (guided automatically by `InstallPrompt.tsx`).
  - On Android Chrome / Zebra RF Browser: tap **Install YESI Lite WMS** banner; Workbox caches all 64+ shell chunks for instant offline floor startup.

---

### 6. Incident Triage & Operational Runbook

| Symptom | Root Cause Check | Resolution Procedure |
| :--- | :--- | :--- |
| **`Application Error` screen on page** | Inspect `<pre>` diagnostic banner (now prints exact `DOMException` / chunk / component stack). | Click **Retry** (auto-reloads stale Vite/PWA chunks). Storage restrictions in cross-origin iframes are handled automatically by `safeStorage.ts`. |
| **`BOOTSTRAP_REQUIRED` on the login screen** | The tenant has no active users yet (fresh database, or all users deactivated). | Use the **Bootstrap first admin** mode: `wms_bootstrap_first_admin` rejects the call with `BOOTSTRAP_ALREADY_COMPLETED` as soon as any active user exists, so only the very first account can be self-created. |
| **`PASSWORD_CHANGE_REQUIRED` after sign-in** | The account is flagged `must_change_password` (bootstrap, rotation, or seeded demo login). | Complete the forced rotation before the app opens; the new password is validated by `wms_validate_password_strength` (≥10 and ≤128 chars, ≥3 of 4 character classes, ≠ username, not a common password). |
| **Account Locked (`ACCOUNT_LOCKED`)** | 5+ consecutive failed password attempts triggered progressive lockout (5 min, then 10, 15… capped at 60 min), tracked both locally and in `wms_user_sessions`. | Wait for cooldown expiry, or have an `admin` clear the lock / rotate the credential in `/users`. Cloud sessions are signed `wms_sess_<64hex>` tokens stored hashed with an 8 h lifetime; `wms_revoke_session` invalidates one immediately. |
| **`INSUFFICIENT_STOCK` / `ALLOCATION_CONFLICT`** | No dimension in the **active warehouse** can cover the line after FEFO: units are expired, quarantined, or already promised to another order. | Drill into the SKU in `/inventory` by bin × lot × status. Fix the physical cause (release the QC hold, adjust the wrong bin, or re-date the lot) — never by lowering the requested quantity. Availability is `max(reserved_qty, active promises)` per dimension, so a stale local promise is released by `expireStaleReservations`. |
| **`PICK_SCAN_MISMATCH` / `PUTAWAY_SCAN_MISMATCH`** | The scanned code does not resolve to the SKU/lot/bin the task expects. | These are hard failures by design and the whole step rolls back — but the rejection is still audited, so check `/auditor` and `/users` audit log for the operator, the scanned string and the expected dimension. |
| **`QC_CHECKPOINT_BLOCKED` on Putaway** | Operator attempted to put away a lot whose QC state is still `pending` or `failed`. | Have a role with `qc.release` (supervisor/admin) **Release** the hold in `/qc` first; the release moves the units to a `HOLD` dimension and queues the directed putaway task. |
| **Stock looks right but the cloud disagrees** | The outbox is backed up, or an event hit the DLQ after max retries. | Open `/cloud`: the outbox panel shows real `pending` / `processing` / `failed` / `dead_letter` counts and lease/retry detail, with **Retry** and **Discard** per dead-lettered event. `POST ?action=flush_outbox` performs real leased delivery, but publishes nothing while no `wms_integration_endpoints` subscriber is active. |
| **Carrier tracking shows no live events** | There is no live carrier feed — by design. | `/shipping` reports only `dispatched` / `awaiting_dispatch` / `returned`, the carrier we recorded at dispatch, and the last known bin. Nothing is simulated; integrate a carrier API and extend the tracking provider if live events are required. |
