# YESI Lite WMS — Enhanced Instant Order Processing

Focused, day-to-day Warehouse Management System for **manual / same-day / instant marketplace orders**.

**Enhanced build highlights**
- **iOS / mobile PWA** — Add to Home Screen on iPhone & iPad (Safari), safe-area layout, offline shell
- Session auto-save (IndexedDB + sessionStorage) — resume after refresh or crash
- Live KPI strip: Postings · Assembled · Accuracy % · Shipped · Progress %
- Smart group sequencing (cluster same products, highest qty first)
- Bulk mark-by-product during assembly
- Step readiness indicators + one-click **Continue**
- Clear session control

Built from the full YESI-FULFILLMENT (VortexWMS) codebase, stripped to the modules operators need every shift.

## Included workflow tabs (Lite)

| Tab | Route | Purpose |
|-----|-------|---------|
| **Daily Manual** | `/` | 5-step Instant Fulfillment (receive → assemble → audit → dispatch → summary) |
| Batch Pick | `/batch-pick` | Wave / batch pick |
| Shipping | `/shipping` | Labels & hand-off |
| Inventory Hub | `/inventory` | Stock levels, locations, adjustments |
| Serial Tracking | `/serial-tracking` | IMEI / S/N capture & verification |
| Analytics | `/analytics` | KPIs and operational charts |
| Barcode Generator | `/barcode-generator` | Location & product barcodes |
| PDF Sequencer | `/pdf-sequencer` | Label page ordering |
| Templates | `/templates` | Product name standardization |
| Bulk Converter | `/bulk-convert` | Format transforms |
| Auditor | `/auditor` | Expected vs actual checks |
| SIM / IMEI | `/sim-manager` | Device / SIM tools |
| Settings | `/settings` | App preferences |

## Recommended daily flow (Instant)

1. **Daily Manual · Receive** — XLSX / paste / sample wave  
2. **Assemble & sequence** — Smart group → mark assembled → copy sequence → PDF Sequencer  
3. **Audit** — scan or paste actuals  
4. **Dispatch** — ship by client batch  
5. **Summary** — export report  

## Run

```bash
npm install
npm run dev      # http://localhost:5173 (or Vite default)
npm run build    # production → dist/
```

Login: `VINOVJ` / `VINOVJ` (or admin/admin)

See `WORKFLOW-COMPLETE.md` and `BUILD-LITE.md` for packaging (Tauri) and technical notes.


## iOS / iPhone install

1. `npm run build` and host `dist/` on **HTTPS**
2. Open the URL in **Safari** on the iPhone/iPad
3. Share → **Add to Home Screen** → Add
4. Launch **YESI Lite** from the home screen (standalone, offline-capable)

See **IOS-INSTALL.md** for LAN testing, limits, and troubleshooting.
