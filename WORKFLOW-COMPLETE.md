# YESI Lite WMS — Instant Fulfillment Workflow (Priority Integration Build)

## Implemented priority roadmap

### P0 — Session hardening
- **Versioned session** (`v: 1`) in `src/lib/workflowSession.ts`
- **Operator-scoped keys**: `daily_manual:{username}`
- **Legacy migration** from global `daily_manual_session`
- **Always JSON-string values** in Dexie preferences (type-safe boundary)
- **Last saved** live label (“Saved 12s ago”)
- **Multi-tab awareness** via `BroadcastChannel` (conflict notice if another tab saves)

### P0 / P1 — Operator progression
- `src/lib/operatorStatsStore.ts` — persist XP / level / badges per operator
- **TopBar XP badge** — level, progress bar, picks/audits/scans, badges popover
- XP awarded on Daily Manual **assemble** (pick) and **audit**

### P1 — AnomalySentinel + Oracle
- **Inventory Hub** — auto panel: Oracle 7d forecast + AnomalySentinel alerts
- **Daily Manual** — **Neural scan** button runs sentinel + oracle on wave inventory

### P2 — QuantumRouteOptimizer
- **Daily Manual step 2** — **Quantum route** button (TSP + 2-opt), zone chip preview, reorders wave
- **Batch Pick** — **Quantum route** alongside classic Preview Path

### P2 — NeuralCommandInterface
- Wired into **AI Assistant** (`processUserMessage`): FIND_SKU, LOW_STOCK, ORDER_STATUS, FORECAST, OPTIMIZE_ROUTE, MOVE_STOCK, VISION_SCAN
- **Command Palette** — Neural Ops group (Daily Manual route, Inventory oracle, Batch Pick, Ask AI)

### Compute / adaptation (v1.2+)
- **Adaptation panel** on Daily Manual (mode + wave suggestions + Apply)
- **Web Worker** Quantum route + forecast (`src/workers/compute.worker.ts`)
- **Deep optimize** export/import JSON hook for future HPC (`src/lib/deepOptimize.ts`)

### P3 — Deferred
Dedicated Neural Ops dashboard (heatmap SVG, eco, full vision) remains logic-only; surfaces above cover day-to-day value without a new page.

## 5-step Instant Fulfillment (Daily Manual)

1. **Receive posting** — XLSX / paste / sample wave  
2. **Assemble & sequence** — Smart group · Quantum route · bulk mark · PDF Seq  
3. **Audit assembly** — scan / paste / checkboxes (+ XP)  
4. **Dispatch & report** — ship by client batch  
5. **Daily summary** — export  

Session auto-saves continuously; resume after refresh.

## Run

```bash
cd WMS-Lite-Enhanced
npm install
npm run dev
```

Login: `VINOVJ` / `VINOVJ` (or admin/admin)
