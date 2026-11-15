# YESI-WMS — Build, Develop & Deploy SOP (including secure drop-file builds)

> Step-by-step operating procedures for **developing**, **building**, **deploying** and
> **drop-file shipping** YESI-WMS. Companion documents:
> `docs/WORKFLOW-AND-DEVELOPER-CATALOG.md` (architecture + milestone catalog),
> `docs/ARCHITECTURE-AND-OPERATIONS.md` (cloud gateway, outbox, accepted risks),
> `README.md` (overview + known limitations).
>
> Every command below is meant to be copy-pasted. Paths are relative to the repo root.

---

## 0. The two operating modes (read this first)

| | **Offline-Edge** | **Cloud-connected** |
| :-- | :-- | :-- |
| Trigger | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` absent or invalid | both set to a real project |
| Storage | IndexedDB (Dexie v10) only | IndexedDB + Supabase PostgreSQL via the `wms-api` Edge Function |
| Writes | applied locally, queued in the transactional outbox | applied locally **and** replayed to the cloud with idempotency keys |
| First run | local bootstrap on the sign-in screen | `wms_bootstrap_first_admin` (server-side, audited) |
| Use for | demos, floor tablets with no connectivity, CI smoke tests | production |

There are **no default credentials in either mode**. The first administrator is
created through the bootstrap form on the sign-in screen, and every account can be
forced through credential rotation (`must_change_password`).

### The two banners you may see on the sign-in screen

1. **"Cloud sync environment variables are not set … DEMO DATASET ACTIVE …"** —
   expected when you run a dev build with no cloud env and the demo flag on.
   Fix: set the variables in `.env` (see §1.3), and/or set
   `VITE_WMS_ENABLE_DEMO_SEED=false`. A production `vite build` never seeds demo
   data unless that flag is explicitly `true`.
2. **"Local edge database degraded (Cannot read properties of undefined (reading
   'importKey'))"** — this raw TypeError means the page is **not in a secure
   context**: browsers withhold `crypto.subtle` on plain-HTTP origins, so password
   hashing and the encrypted session envelope cannot run. Current builds replace
   that message with `INSECURE_CONTEXT: …`, which says exactly this.
   Fix: serve over **HTTPS** (or `localhost` during development). The nginx config
   and the drop-file headers both assume TLS; HSTS is inert over plain HTTP by
   design. The app keeps running in resilient mode so you are never locked out of
   diagnosing it — but do not run a warehouse on it.

---

## 1. DEVELOP

### 1.1 Prerequisites

```bash
node --version   # v20 LTS or v22+
npm --version    # 10+
git --version
# optional: Docker 24+ & Compose v2 (ops stack), Rust + Tauri CLI v2 (desktop),
#           Supabase project with PostgreSQL 17+ and pgcrypto (cloud mode)
```

### 1.2 Install and run

```bash
git clone https://github.com/Vino-Yesi/YESI-WMS.git
cd YESI-WMS
npm install --legacy-peer-deps          # required: React 19 / Router 7 peer graph
npm run dev -- --host 0.0.0.0 --port 3000
# open http://localhost:3000  (localhost counts as a secure context — Web Crypto works)
```

### 1.3 Environment (`.env`, gitignored)

```bash
cp .env.example .env
```

| Variable | Purpose | Safe in Git? |
| :-- | :-- | :-- |
| `VITE_SUPABASE_URL` | project URL; omit for Offline-Edge | yes (publishable) |
| `VITE_SUPABASE_ANON_KEY` | publishable key; omit for Offline-Edge | yes (publishable) |
| `VITE_WMS_TENANT_CODE` | tenancy stamp on every operational row (`YESI-FZCO`) | yes |
| `VITE_WMS_DEFAULT_WAREHOUSE` | default facility scope (`DXB-FC1`) | yes |
| `VITE_WMS_ENABLE_DEMO_SEED` | `true` seeds the sample wave + throwaway logins | yes (keep empty/`false`) |

Never put `SUPABASE_SERVICE_ROLE_KEY`, `WMS_METRICS_TOKEN` or `WMS_WEBHOOK_SECRET`
in `.env`: `src/lib/config.ts` rejects privileged keys at runtime and
`scripts/security-check.mjs` fails the build/CI if one is committed.

### 1.4 First run in the browser

- Empty database → the sign-in screen shows **First-Run Setup**. Create the first
  administrator (username `3–32` chars; password ≥10 chars with ≥3 of lowercase,
  uppercase, digit, symbol; ≠ username; not a common password). Bootstrap runs once
  and then closes permanently.
- With `VITE_WMS_ENABLE_DEMO_SEED=true` you instead get the seeded sign-in mode and
  banner 1 above. Use it only for evaluation.
- Pick the warehouse scope from the selector; every screen afterwards is bound to
  exactly that facility.

### 1.5 Daily loop and quality gates

```bash
npm run check:security        # 1. secret/credential leak gate over tracked files
npx tsc -b --pretty false     # 2. typecheck (also part of npm run build)
npm test                      # 3. vitest: 101 tests / 5 files (src/__tests__)
npx eslint .                  # 4. must report 0 errors (warnings tolerated)
npm run build                 # 5. security gate + typecheck + prod bundle + PWA
npm run preview -- --host 0.0.0.0 --port 3000   # smoke the built bundle
```

Before opening or updating a PR also run the browser suite (needs Chromium):

```bash
npx playwright install --with-deps chromium
npm run test:e2e              # boots dist/ via preview and drives first-run → routes
```

`npm test` never collects `e2e/` (the `test` block in `vite.config.ts` restricts
Vitest to `src/__tests__`); the reverse is also true.

### 1.6 Cloud-connected development

Point `.env` at a **scratch** Supabase project, apply §3.5 steps 1–3 there, and keep
the live project untouched. Idempotency makes replays safe: every cloud command
carries a deterministic key and `wms_execute_command` deduplicates server-side.

---

## 2. BUILD

### 2.1 Offline-Edge production bundle

```bash
VITE_SUPABASE_URL="" VITE_SUPABASE_ANON_KEY="" npm run build
```

### 2.2 Cloud-configured production bundle

```bash
export VITE_SUPABASE_URL="https://<ref>.supabase.co"
export VITE_SUPABASE_ANON_KEY="<publishable-key>"
export VITE_WMS_TENANT_CODE="YESI-FZCO"
export VITE_WMS_DEFAULT_WAREHOUSE="DXB-FC1"
npm run build
```

`VITE_*` values are **inlined at build time**. A bundle is therefore
environment-specific: do not reuse a cloud bundle for another project, and never
ship a bundle that was built with secrets you consider sensitive — the publishable
key is public by design, the service-role key never enters the bundle at all.

### 2.3 What `dist/` contains

- `index.html`, hashed `assets/` chunks (immutable-cacheable), PWA service worker
  (`sw.js` + Workbox runtime, precache of the app shell), manifest and icons.
- `_headers` and `_redirects` — the security header set (CSP, `X-Frame-Options`,
  `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS) and the SPA fallback,
  copied from `public/`. These are what make a drop-file deploy as hardened as the
  nginx config; keep them in sync with `ops/nginx.conf`.

### 2.4 Container image

```bash
docker compose up -d --build
# app      http://localhost:8080   (probe: /healthz)
# prometheus http://localhost:9090   (scrapes wms-api?action=metrics)
# grafana  http://localhost:3001
```

The image is a multi-stage Node 20 Alpine build serving `dist/` through the
hardened nginx in `ops/nginx.conf`.

### 2.5 Drop-ready bundle from CI (recommended "drop file" source)

```text
GitHub → Actions → "Drop-Ready Release Bundle" (workflow_dispatch, or any v* tag)
        → yesi-wms-drop-offline-<sha7>.zip (+ .sha256)
        → yesi-wms-drop-cloud-<sha7>.zip   (+ .sha256)   only if the repo has the
                                                          VITE_SUPABASE_* secrets
```

Run it from **Actions → Drop-Ready Release Bundle → Run workflow**, or tag a
commit (`git tag v1.4.0 && git push origin v1.4.0`) to also publish a GitHub
Release carrying the bundles. Then download and verify:

```bash
sha256sum -c yesi-wms-drop-offline-<sha7>.zip.sha256
```

Building in CI — rather than on a laptop — is the security property that matters:
the zip you drop is byte-for-byte what the gates (secret scan, gitleaks range scan,
eslint, 101 unit tests, dual-mode build) just verified.

---

## 3. DEPLOY

### 3.0 Before any deploy (checklist)

1. **TLS terminates in front of the app.** Plain HTTP breaks Web Crypto
   (`INSECURE_CONTEXT`) and makes HSTS inert. Use the host's certificate or your
   own; the nginx config is written for TLS.
2. The origin you will serve from is listed in the Edge Function secret
   `WMS_ALLOWED_ORIGINS` (cloud mode). The gateway rejects browser origins that
   are not on the allowlist, fail-closed.
3. No `.env`, no private keys, no service-role material anywhere in `dist/`
   (the build refuses privileged `VITE_*` values, and the secret gate scans Git).
4. Headers travel with the bundle (`dist/_headers`). After deploying, verify:
   `curl -sI https://<host>/ | grep -iE 'content-security|x-frame|x-content'`.

### 3.1 Path A — drop-file deploy (no CLI, no repo access)

1. Obtain the bundle: §2.5 (CI, preferred) or §2.1/§2.2 locally.
2. `sha256sum -c <bundle>.zip.sha256` — refuse to deploy on mismatch.
3. **Netlify Drop**: open `https://app.netlify.com/drop`, drag the zip (or the
   extracted folder) onto the page. Netlify reads `_headers` and `_redirects` from
   the bundle, so CSP and the SPA fallback apply immediately.
   **Cloudflare Pages**: dashboard → Workers & Pages → Create → Pages →
   *Direct upload* → upload the **extracted** folder (or
   `npx wrangler pages deploy dist --project-name=<name>`).
4. Attach your domain and let the host issue a certificate **before** sharing the
   URL (checklist item 1).
5. Verify §3.6.

Limits of this path: env is baked in at build time (choose the right bundle), and
there is no server side — which is fine, because all server logic lives in the
Supabase Edge Function, not in the host.

### 3.2 Path B — self-hosted (warehouse server)

```bash
export VITE_SUPABASE_URL=... VITE_SUPABASE_ANON_KEY=... \
       VITE_WMS_TENANT_CODE=YESI-FZCO VITE_WMS_DEFAULT_WAREHOUSE=DXB-FC1
docker compose up -d --build
curl -fsS http://localhost:8080/healthz
```

Put TLS in front (the compose stack serves plain HTTP on 8080 by design; terminate
at your edge or extend `ops/nginx.conf` with `listen 443 ssl`).

### 3.3 Path C — git-connected static host

Netlify: import the repo; `netlify.toml` already sets `npm run build` + `dist`.
Set the four `VITE_*` variables in the host dashboard (publishable values only).
Vercel/Cloudflare git integrations: same build command, publish `dist`, add a
`/* → /index.html (200)` rewrite.

### 3.4 Path D — desktop & floor devices

```bash
npm run tauri:build     # Windows .msi/.nsis in src-tauri/target/release/bundle/
```

Floor scanners: install the PWA over HTTPS (iOS: Share → Add to Home Screen;
Android/Zebra: install banner). Workbox precaches the shell for offline startup.

### 3.5 Cloud backend provisioning (once per project)

```bash
# 1. migrations, in order — 008 must NEVER be re-applied to a database that
#    already records 20261114180000 in supabase_migrations.schema_migrations
npx supabase link --project-ref <ref> && npx supabase db push

# 2. gateway secrets (all three; each fails closed when unset)
npx supabase secrets set WMS_ALLOWED_ORIGINS="https://your-origin"
npx supabase secrets set WMS_METRICS_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
npx supabase secrets set WMS_WEBHOOK_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"

# 3. deploy the gateway (it authenticates its own sessions; no Supabase JWT layer)
npx supabase functions deploy wms-api --no-verify-jwt

# 4. verify posture + RLS posture
curl -s "https://<ref>.supabase.co/functions/v1/wms-api?action=health&warehouse=DXB-FC1" -H "apikey: <anon>"
```

Both counts in the catalog's RLS verification query must be `0`. Then complete the
first-run bootstrap from the app (or `wms_bootstrap_first_admin`), and rotate any
account still flagged `must_change_password`.

### 3.6 Post-deploy verification runbook

```bash
curl -sI  https://<host>/                     # headers from dist/_headers present
curl -s   https://<host>/pick-pack            # 200 + index.html (SPA fallback)
curl -s   https://<host>/sw.js -I             # Cache-Control: no-store
curl -s   "https://<ref>.supabase.co/functions/v1/wms-api?action=health" -H "apikey: <anon>"   # security posture block
curl -s   "https://<ref>.supabase.co/functions/v1/wms-api?action=bootstrap_status&tenant=YESI-FZCO" -H "apikey: <anon>"
```

In the app: sign in (or bootstrap), confirm the top bar shows the intended
warehouse, `/cloud` reports gateway posture and outbox counts, and `/` KPI tiles
show real numbers (they never fabricate fallbacks).

---

## 4. Secure file-drop **into** the app (spreadsheet ingestion)

Dropping supplier/marketplace workbooks into the UI is supported and contained by
`src/lib/spreadsheet.ts` — the single choke point for untrusted spreadsheet data:

1. Size and type are checked **before** parsing: 12 MiB cap, extension allowlist
   (`.xlsx .xlsm .xls .xlsb .csv .txt`).
2. Parse errors surface as typed messages (`FILE_TOO_LARGE`,
   `UNSUPPORTED_FILE_TYPE`, `EMPTY_WORKBOOK`, `PARSE_FAILED`), never stack traces.
3. Cells are coerced to primitives; strings capped at 4096 chars.
4. Header keys drop `__proto__` / `constructor` / `prototype`, empties and
   duplicates; rows are built on a null prototype, so a hostile sheet cannot inject
   object keys.
5. Inbound manifests cap at 20,000 rows; a **lot number is mandatory** on manual
   receipt and expiry must be ISO-8601.

Entry points: `/inbound` (GRN manifest), `/daily` (wave tracker), `/auditor`
(pack verification). Export paths write sheets and never parse uploads.

Known accepted risk: `xlsx@0.18.5` is the last release reachable from the allowed
registries and carries CVE-2023-30533 / CVE-2024-22363; containment above plus the
documented remediation path (`docs/ARCHITECTURE-AND-OPERATIONS.md` §8) is the
mitigation.

---

## 5. Troubleshooting quick reference

| Symptom | First check |
| :-- | :-- |
| `INSECURE_CONTEXT` banner | origin is plain HTTP → serve TLS (§0 banner 2) |
| "Cloud sync environment variables are not set" | expected offline; set `.env` (§0 banner 1) |
| `DEMO DATASET ACTIVE` banner | `VITE_WMS_ENABLE_DEMO_SEED` — set `false` and rebuild |
| `BOOTSTRAP_REQUIRED` | no active users → use First-Run Setup; it closes after one account |
| `PASSWORD_CHANGE_REQUIRED` | finish the forced rotation before floor access |
| `ACCOUNT_LOCKED` | 5 failed attempts → progressive 5→60 min lockout; admin can clear in `/users` |
| `ORIGIN_NOT_ALLOWED` (403 from gateway) | add the exact origin to `WMS_ALLOWED_ORIGINS` |
| `INSUFFICIENT_STOCK` / `ALLOCATION_CONFLICT` | drill the SKU by bin × lot × status in `/inventory`; fix the physical cause |
| Outbox `DLQ (N)` in the top bar | `/cloud` → inspect, Retry or Discard per event |
| Carrier shows no live events | by design: only `dispatched/awaiting_dispatch/returned` + carrier + last bin |

Full incident tables live in `docs/WORKFLOW-AND-DEVELOPER-CATALOG.md` §6.
