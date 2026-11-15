import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { readWorkbookFile, describeSpreadsheetError } from '@/lib/spreadsheet';
import {
  Upload, Package, PackageCheck, Truck, ClipboardList, Layers,
  FileSpreadsheet, CheckCircle2, ArrowRight, AlertTriangle,
  FileDown, ScanBarcode, BarChart3, Camera, X, Route, Sparkles, ShieldAlert,
  Brain, CloudUpload, CloudDownload, Loader2,
} from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';
import {
  validateScan,
  buildSummary,
  extractTrackingId,
  normalizeTracking,
  type ScanEvent,
  type ExpectedLine,
} from '@/lib/scanValidation';
import { db, logAction } from '@/lib/wms-db';
import { useAuth } from '@/lib/wms-auth';
import waveData from '@/data/ozon-wave.json';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  loadWorkflowSession,
  saveWorkflowSession,
  clearWorkflowSession,
  subscribeSessionChannel,
  formatSavedAgo,
  getTabId,
  type WorkflowSession,
} from '@/lib/workflowSession';
import { awardXp } from '@/lib/operatorStatsStore';
import { routeOptimizer, sentinel, oracle, type AnomalyAlert, type RoutePoint } from '@/lib/neuralOps';
import {
  calculateAdaptation,
  waveAdaptationSuggestions,
  type AdaptationState,
  type AdaptationSuggestion,
} from '@/lib/adaptation';
import { workerOptimizeRoute, workerForecast, type ForecastMsg } from '@/lib/computeClient';
import {
  buildDeepOptimizeJob,
  downloadDeepOptimizeJob,
  persistDeepOptimizeJob,
  parseDeepOptimizeResult,
  persistDeepOptimizeResult,
  applyDeepOptimizeOrder,
  submitDeepOptimizeToHpc,
} from '@/lib/deepOptimize';

/** Row from posting XLSX (Tracking id · products · qty) */
export type PostingRow = {
  trackingId: string;
  product: string;
  qty: number;
  sku?: string;
};

type StepId = 1 | 2 | 3 | 4 | 5;

type AuditStatus = 'EXACT' | 'FUZZY' | 'MISMATCH' | 'MISSING_ACTUAL' | 'MISSING_EXPECTED';

type AuditRow = {
  trackingId: string;
  expectedProduct: string;
  expectedQty: number;
  actualProduct: string;
  actualQty: number;
  status: AuditStatus;
  score: number;
};

const STEPS: { id: StepId; title: string; desc: string; icon: typeof Upload }[] = [
  { id: 1, title: 'Receive posting', desc: 'Upload XLSX (tracking · product · qty)', icon: Upload },
  { id: 2, title: 'Assemble & sequence', desc: 'Order wave by tracking numbers', icon: ScanBarcode },
  { id: 3, title: 'Audit assembly', desc: 'Expected vs actual scans', icon: AlertTriangle },
  { id: 4, title: 'Dispatch & report', desc: 'Ship by client batch', icon: Truck },
  { id: 5, title: 'Daily summary', desc: 'Auto workflow report', icon: BarChart3 },
];

function normHeader(h: unknown): string {
  return String(h ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, ' ');
}

function parsePostingSheet(json: unknown[][]): PostingRow[] {
  if (!json.length) return [];
  let headerIdx = 0;
  for (let i = 0; i < Math.min(12, json.length); i++) {
    const joined = (json[i] || []).map(normHeader).join("|");
    if (
      joined.includes("tracking") ||
      joined.includes("shipment") ||
      joined.includes("product") ||
      joined.includes("sku") ||
      joined.includes("отправлен") ||
      joined.includes("заказ") ||
      joined.includes("товар") ||
      joined.includes("артикул")
    ) {
      headerIdx = i;
      break;
    }
  }
  const headers = (json[headerIdx] || []).map(normHeader);
  const col = (names: string[], fallback = -1) => {
    for (const n of names) {
      const i = headers.findIndex((h) => h === n || h.includes(n));
      if (i >= 0) return i;
    }
    return fallback;
  };
  const iTrack = col(
    ["номер отправления", "отправления", "tracking id", "tracking", "shipment number", "shipment", "posting"],
    -1,
  );
  const iOrder = col(["номер заказа", "order id", "order"], -1);
  const iProduct = col(["название товара", "название", "products", "product name", "product", "title", "name"], 1);
  const iQty = col(["количество", "qty", "quantity"], 2);
  const iSku = col(["артикул", "sku", "offer id", "offer"], -1);
  const trackCol = iTrack >= 0 ? iTrack : iOrder >= 0 ? iOrder : 0;

  const out: PostingRow[] = [];
  for (let r = headerIdx + 1; r < json.length; r++) {
    const row = json[r] || [];
    const trackingId = String(row[trackCol] ?? "").trim();
    const product = String(row[iProduct >= 0 ? iProduct : 1] ?? "").trim();
    const qty = Math.max(1, Number(row[iQty >= 0 ? iQty : 2]) || 1);
    const sku = iSku >= 0 ? String(row[iSku] ?? "").trim() : "";
    if (!trackingId) continue;
    out.push({ trackingId, product, qty, sku: sku || undefined });
  }
  return out;
}

function normalizeProduct(p: string): string {
  return p
    .replace(/\s+/g, ' ')
    .replace(/\bгб\b/gi, 'GB')
    .replace(/\bГБ\b/g, 'GB')
    .replace(/[^\w\s\-]/g, '')
    .trim()
    .toLowerCase();
}

function productScore(a: string, b: string): number {
  if (!a || !b) return 0;
  const na = normalizeProduct(a);
  const nb = normalizeProduct(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const ta = new Set(na.split(/\s+/).filter(Boolean));
  const tb = new Set(nb.split(/\s+/).filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / new Set([...ta, ...tb]).size;
}

function clientBatchKey(trackingId: string): string {
  const parts = trackingId.split('-');
  return parts.length >= 2 ? parts.slice(0, -1).join('-') : trackingId;
}

export default function DailyManual() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const operator = user?.displayName || user?.username || 'Operator';
  const username = user?.username || operator;

  const [step, setStep] = useState<StepId>(1);
  const [rows, setRows] = useState<PostingRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [message, setMessage] = useState<{ type: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [assembled, setAssembled] = useState<Set<string>>(new Set());
  const [actualPaste, setActualPaste] = useState('');
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [scanEvents, setScanEvents] = useState<ScanEvent[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [orderRemarks, setOrderRemarks] = useState<Record<string, string>>({});
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const scanRegionId = 'daily-manual-scan-region';
  const [shippedBatches, setShippedBatches] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [receivedAt, setReceivedAt] = useState<string | null>(null);
  /** Paste buffer: tracking · product · qty (tab / comma / pipe) */
  const [pasteText, setPasteText] = useState('');
  /** Product column sort — 'group' clusters identical products for faster assembly */
  const [productSort, setProductSort] = useState<'none' | 'asc' | 'desc' | 'group'>('none');
  const [sessionRestored, setSessionRestored] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [savedAgoLabel, setSavedAgoLabel] = useState('Not saved');
  const [tabConflict, setTabConflict] = useState<string | null>(null);
  const [anomalyAlerts, setAnomalyAlerts] = useState<AnomalyAlert[]>([]);
  const [quantumRoute, setQuantumRoute] = useState<RoutePoint[] | null>(null);
  const [adaptation, setAdaptation] = useState<AdaptationState | null>(null);
  const [waveSuggestions, setWaveSuggestions] = useState<AdaptationSuggestion[]>([]);
  const [workerBusy, setWorkerBusy] = useState(false);
  const [workerForecastResult, setWorkerForecastResult] = useState<ForecastMsg | null>(null);
  const [workerMs, setWorkerMs] = useState<number | null>(null);
  const deepImportRef = useRef<HTMLInputElement | null>(null);
  const tabIdRef = useRef(getTabId());

  // ── Session restore (versioned, operator-scoped) ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await loadWorkflowSession(username);
        if (!data?.rows?.length || cancelled) {
          setSessionRestored(true);
          return;
        }
        setRows(data.rows as PostingRow[]);
        setFileName(data.fileName || '');
        setAssembled(new Set(data.assembled || []));
        setActualPaste(data.actualPaste || '');
        setAuditRows((data.auditRows || []) as AuditRow[]);
        setScanEvents((data.scanEvents || []) as ScanEvent[]);
        setShippedBatches(new Set(data.shippedBatches || []));
        setOrderRemarks(data.orderRemarks || {});
        setReceivedAt(data.receivedAt);
        setProductSort(data.productSort || 'none');
        setStep((data.step || 1) as StepId);
        setLastSavedAt(data.savedAt);
        setMessage({
          type: 'info',
          text: `Resumed session · ${data.rows.length} postings · ${formatSavedAgo(data.savedAt)}`,
        });
      } catch {
        /* ignore corrupt session */
      } finally {
        if (!cancelled) setSessionRestored(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [username]);

  // ── Persist session (debounced) + multi-tab awareness ──
  useEffect(() => {
    if (!sessionRestored || !rows.length) return;
    const t = setTimeout(async () => {
      const payload: WorkflowSession = {
        v: 1,
        operator: username,
        step,
        rows,
        fileName,
        assembled: [...assembled],
        actualPaste,
        auditRows,
        scanEvents: scanEvents.slice(0, 200),
        shippedBatches: [...shippedBatches],
        orderRemarks,
        receivedAt,
        productSort,
        savedAt: new Date().toISOString(),
        tabId: tabIdRef.current,
      };
      await saveWorkflowSession(payload);
      setLastSavedAt(payload.savedAt);
      setTabConflict(null);
    }, 600);
    return () => clearTimeout(t);
  }, [
    sessionRestored,
    step,
    rows,
    fileName,
    assembled,
    actualPaste,
    auditRows,
    scanEvents,
    shippedBatches,
    orderRemarks,
    receivedAt,
    productSort,
    username,
  ]);

  // Live "Saved Xs ago" label
  useEffect(() => {
    const tick = () => setSavedAgoLabel(formatSavedAgo(lastSavedAt));
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [lastSavedAt]);

  // Multi-tab: warn if another tab saved the same operator session
  useEffect(() => {
    return subscribeSessionChannel(username, (ev) => {
      if (ev.type === 'session-saved' && ev.tabId !== tabIdRef.current) {
        setTabConflict(`Another tab saved this wave at ${new Date(ev.savedAt).toLocaleTimeString()}`);
      }
      if (ev.type === 'session-cleared') {
        setTabConflict('Session cleared in another tab');
      }
    });
  }, [username]);

  const sortedRows = useMemo(() => {
    if (productSort === 'none') return rows;
    const copy = [...rows];
    if (productSort === 'group') {
      // Cluster identical products, order clusters by total qty desc → faster pick runs
      const groups = new Map<string, PostingRow[]>();
      for (const r of copy) {
        const k = normalizeProduct(r.product);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(r);
      }
      const ordered = [...groups.entries()].sort((a, b) => {
        const qa = a[1].reduce((s, x) => s + x.qty, 0);
        const qb = b[1].reduce((s, x) => s + x.qty, 0);
        return qb - qa || a[0].localeCompare(b[0]);
      });
      return ordered.flatMap(([, items]) => items);
    }
    copy.sort((a, b) => {
      const cmp = a.product.localeCompare(b.product, 'ru', { sensitivity: 'base' });
      return productSort === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [rows, productSort]);

  const sequence = useMemo(() => sortedRows.map((r) => r.trackingId), [sortedRows]);

  const batches = useMemo(() => {
    const map = new Map<string, PostingRow[]>();
    for (const r of rows) {
      const key = clientBatchKey(r.trackingId);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return [...map.entries()].map(([id, items]) => ({
      id,
      items,
      qty: items.reduce((s, x) => s + x.qty, 0),
    }));
  }, [rows]);

  const productTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(r.product, (map.get(r.product) || 0) + r.qty);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  // ── Live KPIs & step readiness (streamlined progress) ──
  const assembledCount = assembled.size;
  const totalLines = rows.length;
  const exactAudit = auditRows.filter((a) => a.status === 'EXACT').length;
  const fuzzyAudit = auditRows.filter((a) => a.status === 'FUZZY').length;
  const mismatchAudit = auditRows.filter(
    (a) => a.status === 'MISMATCH' || a.status === 'MISSING_ACTUAL' || a.status === 'MISSING_EXPECTED',
  ).length;
  const accuracyPct = auditRows.length
    ? Math.round(((exactAudit + fuzzyAudit * 0.7) / auditRows.length) * 100)
    : totalLines && assembledCount
      ? Math.round((assembledCount / totalLines) * 100)
      : 0;
  const shippedCount = shippedBatches.size;
  const progressPct = useMemo(() => {
    if (!totalLines) return 0;
    const weights = [0, 15, 40, 65, 85, 100]; // cumulative by completed step
    let base = weights[step - 1] ?? 0;
    if (step === 2 && totalLines) base += Math.round((assembledCount / totalLines) * 25);
    if (step === 3 && auditRows.length) base += Math.round((exactAudit / Math.max(1, auditRows.length)) * 15);
    if (step === 4 && batches.length) base += Math.round((shippedCount / batches.length) * 10);
    return Math.min(100, base);
  }, [step, totalLines, assembledCount, auditRows.length, exactAudit, batches.length, shippedCount]);

  const stepReady: Record<StepId, boolean> = {
    1: true,
    2: totalLines > 0,
    3: totalLines > 0 && (assembledCount > 0 || scanEvents.length > 0 || actualPaste.trim().length > 0),
    4: auditRows.length > 0 || assembledCount === totalLines,
    5: shippedCount > 0 || (auditRows.length > 0 && mismatchAudit === 0),
  };

  const clearSession = async () => {
    setRows([]);
    setFileName('');
    setAssembled(new Set());
    setAuditRows([]);
    setShippedBatches(new Set());
    setActualPaste('');
    setScanEvents([]);
    setOrderRemarks({});
    setProductSort('none');
    setReceivedAt(null);
    setStep(1);
    setLastSavedAt(null);
    setQuantumRoute(null);
    setAnomalyAlerts([]);
    setTabConflict(null);
    setWorkerForecastResult(null);
    setWorkerMs(null);
    setWaveSuggestions([]);
    setMessage({ type: 'info', text: 'Session cleared' });
    await clearWorkflowSession(username);
  };

  const markProductAssembled = (product: string) => {
    setAssembled((prev) => {
      const next = new Set(prev);
      for (const r of rows) {
        if (r.product === product) next.add(r.trackingId);
      }
      return next;
    });
  };

  // Adaptation engine + wave-scoped suggestions
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const state = await calculateAdaptation();
        if (!cancelled) setAdaptation(state);
      } catch {
        /* pressure calc may fail on empty DB */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rows.length, assembledCount, auditRows.length]);

  useEffect(() => {
    if (!rows.length) {
      setWaveSuggestions([]);
      return;
    }
    const variety = new Set(rows.map((r) => r.product)).size;
    setWaveSuggestions(
      waveAdaptationSuggestions({
        lineCount: rows.length,
        assembledCount,
        accuracyPct,
        mismatchCount: mismatchAudit,
        productVariety: variety,
        mode: adaptation?.mode,
      }),
    );
  }, [rows, assembledCount, accuracyPct, mismatchAudit, adaptation?.mode]);

  const applyRouteOrder = (route: { sku: string; zone: string; x: number; y: number }[]) => {
    setQuantumRoute(route as RoutePoint[]);
    const orderMap = new Map(route.map((p, i) => [p.sku, i]));
    const reordered = [...rows].sort((a, b) => {
      const ka = a.sku || a.product || a.trackingId;
      const kb = b.sku || b.product || b.trackingId;
      return (orderMap.get(ka) ?? 9999) - (orderMap.get(kb) ?? 9999);
    });
    setRows(reordered);
    setProductSort('none');
  };

  /** Quantum route via Web Worker (fallback to main-thread neuralOps) */
  const runQuantumOptimize = async () => {
    if (!rows.length) return;
    const skuList = sortedRows.map((r) => r.sku || r.product || r.trackingId);
    setWorkerBusy(true);
    try {
      const { route, ms } = await workerOptimizeRoute(skuList);
      applyRouteOrder(route);
      setWorkerMs(ms);
      // Optional forecast for top product on worker
      const top = productTotals[0];
      if (top) {
        try {
          const { result } = await workerForecast(top[0], top[1], 7);
          setWorkerForecastResult(result);
        } catch {
          /* forecast optional */
        }
      }
      setMessage({
        type: 'ok',
        text: `Quantum route (worker ${ms}ms) · ${route.length} stops · zones ${[...new Set(route.map((r) => r.zone))].slice(0, 6).join(', ')}`,
      });
    } catch {
      const route = routeOptimizer.optimizeRoute(skuList);
      applyRouteOrder(route);
      setWorkerMs(null);
      setMessage({
        type: 'ok',
        text: `Quantum route (main thread) · ${route.length} stops · zones ${[...new Set(route.map((r) => r.zone))].slice(0, 6).join(', ')}`,
      });
    } finally {
      setWorkerBusy(false);
    }
  };

  const exportDeepOptimize = async () => {
    if (!rows.length) return;
    const job = buildDeepOptimizeJob(
      rows.map((r) => ({
        trackingId: r.trackingId,
        product: r.product,
        qty: r.qty,
        sku: r.sku,
      })),
      username,
      fileName || 'daily-wave',
      'Exported from Daily Manual for HPC / quantum-cloud deep optimize',
    );
    await persistDeepOptimizeJob(job, username);
    downloadDeepOptimizeJob(job);
    const hpc = await submitDeepOptimizeToHpc(job);
    setMessage({
      type: 'info',
      text: hpc.accepted
        ? `Deep optimize job ${job.jobId} submitted`
        : `Deep optimize job exported (${job.jobId}). ${hpc.reason}`,
    });
  };

  const onDeepOptimizeFile = async (file: File) => {
    try {
      const text = await file.text();
      const result = parseDeepOptimizeResult(text);
      await persistDeepOptimizeResult(result, username);
      const reordered = applyDeepOptimizeOrder(rows, result.orderedKeys);
      setRows(reordered);
      setProductSort('none');
      setQuantumRoute(null);
      setMessage({
        type: 'ok',
        text: `Deep optimize imported · ${result.engine} · ${result.orderedKeys.length} keys · job ${result.jobId}`,
      });
    } catch (e) {
      setMessage({
        type: 'err',
        text: `Deep optimize import failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const applySuggestion = (s: AdaptationSuggestion) => {
    if (s.id === 'wave-smart-group' || s.id.includes('smart-group')) {
      setProductSort('group');
      setMessage({ type: 'ok', text: 'Applied: Smart group sort' });
      return;
    }
    if (s.id === 'wave-large-quantum' || s.id.includes('quantum')) {
      void runQuantumOptimize();
      return;
    }
    if (s.id === 'wave-ready-dispatch') {
      setStep(4);
      setMessage({ type: 'info', text: 'Moved to dispatch step' });
      return;
    }
    setMessage({ type: 'info', text: `Suggestion noted: ${s.message}` });
  };

  /** Run AnomalySentinel + light Oracle on current wave inventory seed */
  const runNeuralScan = async () => {
    try {
      const invRows = await db.inventory.toArray();
      const mapped = invRows.map((i) => ({ sku: i.sku || i.product, stock: i.stock ?? 0 }));
      // Seed wave products if inventory empty for them
      for (const r of rows) {
        const key = r.sku || r.product;
        if (!mapped.some((m) => m.sku === key)) {
          mapped.push({ sku: key, stock: r.qty });
        }
      }
      const orders = (await db.orders.limit(200).toArray()).map((o) => ({ status: o.status }));
      const alerts = sentinel.scan(mapped, orders);
      setAnomalyAlerts(alerts.slice(0, 12));
      // Oracle sample on top product
      if (mapped[0]) {
        oracle.seedFromInventory(mapped[0].stock);
        const forecast = oracle.forecast(7);
        if (forecast?.stockoutRisk === 'HIGH') {
          setMessage({
            type: 'err',
            text: `Oracle: HIGH stockout risk on ${mapped[0].sku} · ${alerts.length} anomaly alert(s)`,
          });
        } else if (alerts.length) {
          setMessage({
            type: 'info',
            text: `Neural scan · ${alerts.length} alert(s) · Oracle trend ${forecast?.trend ?? 'n/a'}`,
          });
        } else {
          setMessage({ type: 'ok', text: 'Neural scan clear · no critical anomalies' });
        }
      }
    } catch (e) {
      setMessage({ type: 'err', text: `Neural scan failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const applyRows = async (parsed: PostingRow[], name: string) => {
    setRows(parsed);
    setFileName(name);
    setAssembled(new Set());
    setAuditRows([]);
    setShippedBatches(new Set());
    setActualPaste("");
    setProductSort('none');
    setScanEvents([]);
    setScanError(null);
    setFileError(null);
    setOrderRemarks({});
    setReceivedAt(new Date().toISOString());
    setStep(2);
    try {
      sessionStorage.setItem("wms-sequence", parsed.map((r) => r.trackingId).join("\n"));
    } catch {
      /* ignore */
    }
    await logAction("DAILY_RECEIVE_POSTING", `${name}: ${parsed.length} lines`, operator);
    setMessage({ type: "ok", text: `Received ${parsed.length} lines from ${name}` });
  };

  const loadBuiltInWave = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const parsed: PostingRow[] = waveData.postings.map((p) => ({
        trackingId: p.postingId,
        product: p.product,
        qty: p.qty,
        sku: p.article || p.sku,
      }));
      await applyRows(parsed, "Ozon Global · postings-31-2.xlsx");
    } finally {
      setBusy(false);
    }
  };

  const onUpload = async (file: File) => {
    setBusy(true);
    setMessage(null);
    try {
      // Hardened boundary: an Ozon posting sheet is third-party input.
      const wb = await readWorkbookFile(file);
      const json = (wb.sheets[0]?.rows ?? []) as unknown[][];
      const parsed = parsePostingSheet(json);
      if (!parsed.length) {
        setMessage({
          type: "err",
          text: "No rows found. Need Tracking / Номер отправления, product / Название товара, qty / Количество.",
        });
        return;
      }
      await applyRows(parsed, file.name);
    } catch (e) {
      const msg = describeSpreadsheetError(e);
      setFileError(msg);
      setMessage({ type: 'err', text: `File error: ${msg}. Check the file is a valid .xlsx/.xls with Tracking id, products, qty.` });
    } finally {
      setBusy(false);
    }
  };


  /** Parse pasted lines: tracking[TAB|,]product[TAB|,]qty */
  const parsePasteText = (raw: string): PostingRow[] => {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const out: PostingRow[] = [];
    for (const line of lines) {
      // skip header-like lines
      const low = line.toLowerCase();
      if (low.includes('tracking') || low.includes('отправлен') || low.includes('товар') && low.includes('кол')) continue;
      const parts = line.split(/[\t|,;]+/).map((x) => x.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      const trackingId = parts[0];
      const product = parts.length >= 3 ? parts.slice(1, -1).join(' ') : parts[1];
      const qtyRaw = parts.length >= 3 ? parts[parts.length - 1] : '1';
      const qty = Math.max(1, parseInt(qtyRaw.replace(/[^0-9]/g, ''), 10) || 1);
      if (!trackingId) continue;
      out.push({ trackingId, product: product || trackingId, qty });
    }
    return out;
  };

  const onPasteApply = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const parsed = parsePasteText(pasteText);
      if (!parsed.length) {
        setMessage({
          type: 'err',
          text: 'No rows parsed. Paste lines as: Tracking ID [TAB] Product [TAB] Qty',
        });
        return;
      }
      await applyRows(parsed, 'pasted-postings');
      setPasteText('');
    } finally {
      setBusy(false);
    }
  };

  const confirmAssembly = async () => {
    setAssembled(new Set(rows.map((r) => r.trackingId)));
    // Seed inventory lightly for the wave
    for (const r of rows) {
      const sku = r.trackingId; // use tracking as key for wave line if no SKU column
      // Prefer product name stock aggregation
    }
    const byProduct = new Map<string, number>();
    for (const r of rows) byProduct.set(r.product, (byProduct.get(r.product) || 0) + r.qty);
    for (const [product, qty] of byProduct) {
      const existing = await db.inventory.filter((i) => i.product === product).first();
      if (existing?.id != null) {
        await db.inventory.update(existing.id, {
          stock: (existing.stock || 0) + qty,
          updatedAt: new Date().toISOString(),
        });
      } else {
        await db.inventory.add({
          sku: product.slice(0, 40),
          product,
          stock: qty,
          location: 'WAVE',
          category: 'Daily',
          velocity: 'high',
          updatedAt: new Date().toISOString(),
        } as any);
      }
    }
    await logAction('DAILY_ASSEMBLE_SEQUENCE', `${rows.length} tracking sequenced`, operator);
    try {
      await awardXp(username, Math.min(50, 5 + rows.length), 'pick');
    } catch {
      /* ignore */
    }
    setStep(3);
    setMessage({ type: 'ok', text: `Assembly sequence locked: ${rows.length} tracking IDs · XP awarded` });
  };


  const expectedLines: ExpectedLine[] = useMemo(
    () => rows.map((r) => ({ trackingId: r.trackingId, product: r.product, qty: r.qty })),
    [rows]
  );

  const scanCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const ev of scanEvents) {
      if (ev.verdict === 'INVALID_FORMAT') continue;
      const k = normalizeTracking(ev.trackingId);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }, [scanEvents]);

  const validationSummary = useMemo(
    () => buildSummary(expectedLines, scanEvents),
    [expectedLines, scanEvents]
  );

  const applyScan = useCallback(
    (raw: string) => {
      const counts = new Map<string, number>();
      for (const ev of scanEvents) {
        if (ev.verdict === 'INVALID_FORMAT') continue;
        const k = normalizeTracking(ev.trackingId);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      const event = validateScan(raw, expectedLines, counts);
      setScanEvents((prev) => [event, ...prev].slice(0, 500));
      // Append to actual paste for audit pipeline
      const id = event.trackingId;
      setActualPaste((prev) => {
        const lines = prev.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        lines.push(id);
        return lines.join('\n');
      });
      if (event.verdict === 'UNKNOWN_ORDER' || event.verdict === 'INVALID_FORMAT') {
        setScanError(event.remark);
      } else if (event.verdict === 'DUPLICATE' || event.verdict === 'QTY_EXCEEDED') {
        setScanError(event.remark);
      } else {
        setScanError(null);
        setAssembled((prev) => new Set(prev).add(event.trackingId));
      }
      return event;
    },
    [scanEvents, expectedLines]
  );

  const startScanner = async () => {
    setScanError(null);
    if (!rows.length) {
      setScanError('Upload posting XLSX first — scanner needs expected tracking list for validation.');
      return;
    }
    try {
      if (scannerRef.current) {
        try {
          await scannerRef.current.stop();
          scannerRef.current.clear();
        } catch {
          /* ignore */
        }
        scannerRef.current = null;
      }
      const html5 = new Html5Qrcode(scanRegionId);
      scannerRef.current = html5;
      setScanning(true);
      await html5.start(
        { facingMode: 'environment' },
        { fps: 8, qrbox: { width: 240, height: 140 }, aspectRatio: 1.5 },
        (decoded) => {
          const now = Date.now();
          // debounce identical codes 1.2s
          const last = (window as any).__lastDailyScan as { v: string; t: number } | undefined;
          if (last && last.v === decoded && now - last.t < 1200) return;
          (window as any).__lastDailyScan = { v: decoded, t: now };
          applyScan(decoded);
        },
        () => {
          /* ignore frame miss */
        }
      );
    } catch (e: any) {
      setScanning(false);
      scannerRef.current = null;
      const msg = e?.message || String(e);
      setScanError(
        msg.includes('NotFoundError') || msg.includes('Requested device')
          ? 'No camera found. Use manual paste or allow camera permission.'
          : `Scanner error: ${msg}`
      );
    }
  };

  const stopScanner = async () => {
    try {
      if (scannerRef.current) {
        await scannerRef.current.stop();
        scannerRef.current.clear();
      }
    } catch {
      /* ignore */
    }
    scannerRef.current = null;
    setScanning(false);
  };

  useEffect(() => {
    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop().catch(() => undefined);
        try {
          scannerRef.current.clear();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  
  const runAudit = () => {
    // Parse actual scans: tracking + optional product/qty per line
    const actualMap = new Map<string, { product: string; qty: number }>();
    for (const line of actualPaste.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const idMatch = t.match(/\b\d{6,15}-?\d{0,6}-?\d{0,4}\b/);
      const trackingId = idMatch ? idMatch[0] : t.split(/\s+|\t/)[0];
      const rest = t.replace(trackingId, '').trim();
      const qtyMatch = rest.match(/\b(\d+)\s*$/);
      const qty = qtyMatch ? Number(qtyMatch[1]) : 1;
      const product = rest.replace(/\b\d+\s*$/, '').trim();
      const prev = actualMap.get(trackingId);
      if (prev) {
        prev.qty += qty;
        if (product) prev.product = product;
      } else {
        actualMap.set(trackingId, { product, qty });
      }
    }

    // If no actual pasted, treat assembly checkboxes as scanned = expected (self-check)
    if (!actualMap.size && assembled.size) {
      for (const r of rows) {
        if (assembled.has(r.trackingId)) {
          actualMap.set(r.trackingId, { product: r.product, qty: r.qty });
        }
      }
    }

    const expectedMap = new Map(rows.map((r) => [r.trackingId, r]));
    const allIds = new Set([...expectedMap.keys(), ...actualMap.keys()]);
    const audits: AuditRow[] = [];

    for (const id of [...allIds].sort()) {
      const exp = expectedMap.get(id);
      const act = actualMap.get(id);
      if (exp && act) {
        const score = productScore(exp.product, act.product || exp.product);
        const qtyOk = act.qty === exp.qty;
        let status: AuditStatus = 'MISMATCH';
        if (score >= 0.9 && qtyOk) status = 'EXACT';
        else if (score >= 0.7) status = 'FUZZY';
        audits.push({
          trackingId: id,
          expectedProduct: exp.product,
          expectedQty: exp.qty,
          actualProduct: act.product || exp.product,
          actualQty: act.qty,
          status,
          score,
        });
      } else if (exp && !act) {
        audits.push({
          trackingId: id,
          expectedProduct: exp.product,
          expectedQty: exp.qty,
          actualProduct: '—',
          actualQty: 0,
          status: 'MISSING_ACTUAL',
          score: 0,
        });
      } else if (!exp && act) {
        audits.push({
          trackingId: id,
          expectedProduct: '—',
          expectedQty: 0,
          actualProduct: act.product,
          actualQty: act.qty,
          status: 'MISSING_EXPECTED',
          score: 0,
        });
      }
    }
    setAuditRows(audits);
    const ok = audits.filter((a) => a.status === 'EXACT' || a.status === 'FUZZY').length;
    logAction('DAILY_AUDIT', `matched=${ok}/${audits.length}`, operator);
    const acc = audits.length ? Math.round((ok / audits.length) * 1000) / 10 : 100;
    awardXp(username, Math.min(40, 8 + ok), 'audit', acc).catch(() => undefined);
    setMessage({ type: 'ok', text: `Audit complete: ${ok}/${audits.length} matched · XP awarded` });
  };

  const markDispatched = async () => {
    setShippedBatches(new Set(batches.map((b) => b.id)));
    // decrement wave stock
    const byProduct = new Map<string, number>();
    for (const r of rows) byProduct.set(r.product, (byProduct.get(r.product) || 0) + r.qty);
    for (const [product, qty] of byProduct) {
      const existing = await db.inventory.filter((i) => i.product === product).first();
      if (existing?.id != null) {
        await db.inventory.update(existing.id, {
          stock: Math.max(0, (existing.stock || 0) - qty),
          updatedAt: new Date().toISOString(),
        });
      }
    }
    await logAction('DAILY_DISPATCH', `${batches.length} client batches`, operator);
    setStep(5);
    setMessage({ type: 'ok', text: `Dispatched ${batches.length} client batch(es)` });
  };

  const exportDailySummary = () => {
    const header = ['Section', 'Metric', 'Value'];
    const body: (string | number)[][] = [
      ['Receive', 'File', fileName || '—'],
      ['Receive', 'Received at', receivedAt || '—'],
      ['Receive', 'Lines', rows.length],
      ['Receive', 'Unique tracking', new Set(rows.map((r) => r.trackingId)).size],
      ['Receive', 'Total qty', rows.reduce((s, r) => s + r.qty, 0)],
      ['Assemble', 'Sequenced', assembled.size],
      ['Audit', 'Rows', auditRows.length],
      ['Audit', 'Exact', auditRows.filter((a) => a.status === 'EXACT').length],
      ['Audit', 'Fuzzy', auditRows.filter((a) => a.status === 'FUZZY').length],
      ['Audit', 'Mismatch', auditRows.filter((a) => a.status === 'MISMATCH').length],
      ['Audit', 'Missing actual', auditRows.filter((a) => a.status === 'MISSING_ACTUAL').length],
      ['Audit', 'Missing expected', auditRows.filter((a) => a.status === 'MISSING_EXPECTED').length],
      ['Dispatch', 'Client batches', batches.length],
      ['Dispatch', 'Batches shipped', shippedBatches.size],
      ['Dispatch', 'Total qty shipped', rows.reduce((s, r) => s + r.qty, 0)],
    ];
    const detailHeader = ['Tracking id', 'Product', 'Qty', 'Client batch', 'Assembled', 'Audit', 'Shipped', 'Remark'];
    const detail = rows.map((r) => {
      const batch = clientBatchKey(r.trackingId);
      const audit = auditRows.find((a) => a.trackingId === r.trackingId);
      return [
        r.trackingId,
        r.product,
        r.qty,
        batch,
        assembled.has(r.trackingId) ? 'Y' : 'N',
        audit?.status || '—',
        shippedBatches.has(batch) ? 'Y' : 'N',
        orderRemarks[r.trackingId] || (audit?.status === 'MISSING_ACTUAL' ? 'Not scanned' : ''),
      ];
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...body]), 'Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([detailHeader, ...detail]), 'Lines');
    if (auditRows.length) {
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
          ['Tracking', 'Exp product', 'Exp qty', 'Act product', 'Act qty', 'Status', 'Score', 'Remark'],
          ...auditRows.map((a) => [
            a.trackingId,
            a.expectedProduct,
            a.expectedQty,
            a.actualProduct,
            a.actualQty,
            a.status,
            a.score,
            orderRemarks[a.trackingId] || '',
          ]),
        ]),
        'Audit'
      );
    }
    if (scanEvents.length) {
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
          ['Time', 'Tracking', 'Verdict', 'Remark', 'Count'],
          ...scanEvents.map((e) => [e.at, e.trackingId, e.verdict, e.remark, e.scannedCount]),
        ]),
        'Scans'
      );
    }
    if (validationSummary.missing.length) {
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
          ['Missing tracking', 'Remark'],
          ...validationSummary.missing.map((id) => [id, orderRemarks[id] || 'Not scanned']),
        ]),
        'Missing'
      );
    }
    XLSX.writeFile(wb, `daily_workflow_summary_${new Date().toISOString().slice(0, 10)}.xlsx`);
    logAction('DAILY_SUMMARY_EXPORT', `lines=${rows.length}`, operator);
  };

  const copySequence = async () => {
    const text = sequence.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setMessage({ type: 'info', text: 'Tracking sequence copied — paste into PDF Sequencer Target Sequence' });
    } catch {
      setMessage({ type: 'info', text: 'Copy failed — select sequence list manually' });
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-3 sm:gap-4 max-w-6xl mx-auto w-full pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <div className="shrink-0 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg sm:text-xl font-semibold text-white flex items-center gap-2 leading-tight">
            <ClipboardList className="w-5 h-5 text-accent-sky shrink-0" />
            Instant fulfillment workflow
          </h1>
          <p className="text-xs sm:text-sm text-text-secondary mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span>Posting → Smart assemble → Audit → Dispatch → Summary</span>
            <span className="text-white/30">·</span>
            <span className="tabular-nums text-accent-sky/90">{savedAgoLabel}</span>
            {tabConflict && (
              <span className="text-amber-400 text-xs">· {tabConflict}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {rows.length > 0 && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-8 border-white/10 gap-1"
                onClick={runNeuralScan}
                title="AnomalySentinel + Oracle scan"
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                Neural scan
              </Button>
              <Button variant="outline" size="sm" className="text-xs h-8 border-white/10" onClick={clearSession}>
                Clear session
              </Button>
            </>
          )}
          {step < 5 && stepReady[step] && (
            <Button
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setStep((s) => Math.min(5, (s + 1) as StepId) as StepId)}
            >
              Continue
              <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </div>

      {anomalyAlerts.length > 0 && (
        <div className="shrink-0 rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5 space-y-1 max-h-28 overflow-auto">
          <div className="text-[10px] uppercase tracking-wider text-amber-400/90 font-semibold flex items-center gap-1.5">
            <ShieldAlert className="w-3 h-3" /> AnomalySentinel · {anomalyAlerts.length} alert(s)
          </div>
          {anomalyAlerts.slice(0, 6).map((a, i) => (
            <div key={`${a.sku}-${i}`} className="text-[11px] flex gap-2">
              <Badge
                variant="outline"
                className={
                  a.severity === 'CRITICAL'
                    ? 'border-rose-500/40 text-rose-400'
                    : a.severity === 'HIGH'
                      ? 'border-amber-500/40 text-amber-400'
                      : 'border-white/15 text-text-secondary'
                }
              >
                {a.severity}
              </Badge>
              <span className="text-white/80 truncate">
                <span className="font-mono text-accent-sky">{a.sku}</span> — {a.message}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Adaptation suggestions */}
      {(adaptation || waveSuggestions.length > 0) && (
        <div className="shrink-0 rounded-lg border border-accent-sky/20 bg-accent-sky/5 p-2.5 space-y-2">
          <div className="flex flex-wrap items-center gap-2 justify-between">
            <div className="text-[10px] uppercase tracking-wider text-accent-sky font-semibold flex items-center gap-1.5">
              <Brain className="w-3 h-3" />
              Adaptation
              {adaptation && (
                <Badge variant="outline" className="border-accent-sky/30 text-accent-sky capitalize text-[10px]">
                  {adaptation.mode}
                </Badge>
              )}
              {adaptation && (
                <span className="text-text-secondary font-normal normal-case tracking-normal">
                  · batch ~{adaptation.recommendedBatchSize} · pick {adaptation.recommendedPickingMethod}
                </span>
              )}
            </div>
            {workerForecastResult && (
              <span className="text-[10px] text-text-secondary">
                Worker forecast {workerForecastResult.sku}: {workerForecastResult.trend} /{' '}
                <span
                  className={
                    workerForecastResult.stockoutRisk === 'HIGH'
                      ? 'text-rose-400'
                      : workerForecastResult.stockoutRisk === 'MEDIUM'
                        ? 'text-amber-400'
                        : 'text-emerald-400'
                  }
                >
                  {workerForecastResult.stockoutRisk}
                </span>
                {workerMs != null && ` · ${workerMs}ms`}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1.5 max-h-28 overflow-auto">
            {[...waveSuggestions, ...(adaptation?.suggestions || [])]
              .filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i)
              .slice(0, 6)
              .map((s) => (
                <div key={s.id} className="flex items-start gap-2 text-[11px]">
                  <Badge
                    variant="outline"
                    className={
                      s.impact === 'high'
                        ? 'border-rose-500/30 text-rose-400 shrink-0'
                        : s.impact === 'medium'
                          ? 'border-amber-500/30 text-amber-400 shrink-0'
                          : 'border-white/15 text-text-secondary shrink-0'
                    }
                  >
                    {s.impact}
                  </Badge>
                  <span className="text-white/85 flex-1 min-w-0">{s.message}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 text-[10px] px-2 border-white/10 shrink-0"
                    onClick={() => applySuggestion(s)}
                  >
                    Apply
                  </Button>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Live KPI strip */}
      {totalLines > 0 && (
        <div className="shrink-0 grid grid-cols-2 sm:grid-cols-5 gap-1.5 sm:gap-2">
          {[
            ['Postings', totalLines, 'text-white'],
            ['Assembled', `${assembledCount}/${totalLines}`, assembledCount === totalLines ? 'text-emerald-400' : 'text-accent-sky'],
            ['Accuracy', `${accuracyPct}%`, accuracyPct >= 95 ? 'text-emerald-400' : accuracyPct >= 80 ? 'text-amber-400' : 'text-rose-400'],
            ['Shipped', `${shippedCount}/${batches.length || 0}`, 'text-white'],
            ['Progress', `${progressPct}%`, 'text-accent-sky'],
          ].map(([label, val, color]) => (
            <div key={String(label)} className="rounded-lg border border-white/5 bg-white/[0.03] px-2.5 sm:px-3 py-1.5 sm:py-2">
              <div className="text-[9px] sm:text-[10px] uppercase tracking-wider text-text-secondary">{label}</div>
              <div className={`text-base sm:text-lg font-semibold tabular-nums ${color}`}>{val}</div>
            </div>
          ))}
        </div>
      )}

      <div className="shrink-0 grid grid-cols-2 sm:grid-cols-5 gap-1.5 sm:gap-2">
        {STEPS.map((s) => {
          const Icon = s.icon;
          const active = step === s.id;
          const done = step > s.id;
          const ready = stepReady[s.id];
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setStep(s.id)}
              className={`text-left rounded-lg border p-2.5 sm:p-2.5 min-h-[3.25rem] sm:min-h-0 transition-colors active:scale-[0.98] ${
                active
                  ? 'border-accent-sky/50 bg-accent-sky/10'
                  : done
                    ? 'border-emerald-500/30 bg-emerald-500/5'
                    : ready
                      ? 'border-white/10 bg-white/[0.03] hover:bg-white/[0.05]'
                      : 'border-white/5 bg-white/[0.02] hover:bg-white/[0.04] opacity-70'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <Icon
                  className={`w-3.5 h-3.5 ${active ? 'text-accent-sky' : done ? 'text-emerald-400' : 'text-text-secondary'}`}
                />
                <span className="text-[10px] font-mono text-white/30">{String(s.id).padStart(2, '0')}</span>
                {done && <CheckCircle2 className="w-3 h-3 text-emerald-400 ml-auto" />}
              </div>
              <div className="text-xs font-medium text-white leading-tight">{s.title}</div>
              <div className="text-[10px] text-text-secondary mt-0.5 hidden sm:block">{s.desc}</div>
            </button>
          );
        })}
      </div>

      {message && (
        <div
          className={`shrink-0 text-xs rounded-md px-3 py-2 border ${
            message.type === 'ok'
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
              : message.type === 'err'
                ? 'bg-rose-500/10 border-rose-500/20 text-rose-400'
                : 'bg-white/[0.03] border-white/10 text-text-secondary'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {/* 1 Receive */}
        {step === 1 && (
          <Card className="bg-surface/40 border-white/5">
            <CardHeader className="pb-2 px-3 sm:px-6 pt-3 sm:pt-6">
              <CardTitle className="text-sm sm:text-base flex items-center gap-2 leading-snug">
                <FileSpreadsheet className="w-4 h-4 text-accent-sky shrink-0" />
                1 · Instant receiving — posting XLSX
              </CardTitle>
              <CardDescription className="text-xs sm:text-sm leading-relaxed">
                Ozon posting sheet (Номер отправления · Название товара · Количество) or any tracking / product / qty XLSX.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 sm:space-y-4 px-3 sm:px-6 pb-4 sm:pb-6">
              <button
                type="button"
                disabled={busy}
                onClick={loadBuiltInWave}
                className="w-full flex items-center justify-between gap-3 rounded-xl border border-accent-sky/30 bg-accent-sky/10 px-4 py-3 text-left hover:bg-accent-sky/15 transition-colors"
              >
                <span>
                  <span className="block text-sm font-medium text-white">Load Ozon wave · 31 May</span>
                  <span className="block text-[11px] text-text-secondary mt-0.5">
                    60 GBS Express postings · Sharjah → Russia · already in this workspace
                  </span>
                </span>
                <Package className="w-5 h-5 text-accent-sky shrink-0" />
              </button>
              <label className="flex flex-col items-center justify-center gap-2 min-h-[6.5rem] sm:h-28 border-2 border-dashed border-white/10 rounded-xl cursor-pointer hover:border-accent-sky/40 px-3 py-4">
                <Upload className="w-7 h-7 text-text-secondary" />
                <span className="text-sm text-text-secondary text-center">{busy ? 'Reading…' : 'Tap to upload posting .xlsx'}</span>
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onUpload(f);
                  }}
                />
              </label>


              <div className="space-y-2">
                <p className="text-xs text-text-secondary">Or paste rows (Tracking · Product · Qty — tab / comma / pipe separated)</p>
                <textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={"78954582-0287-1\tSamsung Galaxy A17 Blue\t1\n56848324-0106-1\tWatch 8 Graphite\t1"}
                  className="w-full min-h-[96px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-accent-sky/40"
                  disabled={busy}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || !pasteText.trim()}
                  onClick={onPasteApply}
                  className="gap-1.5"
                >
                  <ClipboardList className="w-3.5 h-3.5" /> Apply paste
                </Button>
              </div>

              {fileName && (
                <p className="text-xs text-text-secondary">
                  Loaded: <span className="text-white">{fileName}</span> · {rows.length} lines · qty{' '}
                  {rows.reduce((s, r) => s + r.qty, 0)}
                </p>
              )}
              {rows.length > 0 && (
                <Button onClick={() => setStep(2)} className="gap-1.5">
                  Continue to assemble <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* 2 Assemble & sequence */}
        {step === 2 && (
          <Card className="bg-surface/40 border-white/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">2 · Assemble & sequence by tracking</CardTitle>
              <CardDescription>
                Work the posting wave in tracking order. Copy sequence into PDF Sequencer when sorting labels.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {rows.length === 0 ? (
                <p className="text-sm text-text-secondary">Upload a posting file first.</p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={copySequence}>
                      Copy tracking sequence
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => navigate('/pdf-sequencer')}>
                      Open PDF Sequencer
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setAssembled(new Set(rows.map((r) => r.trackingId)))}
                    >
                      Mark all assembled
                    </Button>
                    <Button
                      size="sm"
                      variant={quantumRoute ? 'default' : 'outline'}
                      onClick={() => void runQuantumOptimize()}
                      disabled={workerBusy}
                      title="TSP + 2-opt on Web Worker (falls back to main thread)"
                      className="gap-1"
                    >
                      {workerBusy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Route className="w-3.5 h-3.5" />
                      )}
                      Quantum route
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void exportDeepOptimize()}
                      title="Export wave JSON for future HPC / quantum-cloud deep optimize"
                      className="gap-1"
                    >
                      <CloudUpload className="w-3.5 h-3.5" />
                      Deep export
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => deepImportRef.current?.click()}
                      title="Import deep optimize result (orderedKeys JSON)"
                      className="gap-1"
                    >
                      <CloudDownload className="w-3.5 h-3.5" />
                      Deep import
                    </Button>
                    <input
                      ref={deepImportRef}
                      type="file"
                      accept="application/json,.json"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void onDeepOptimizeFile(f);
                        e.target.value = '';
                      }}
                    />
                    <Button
                      size="sm"
                      variant={productSort === 'group' ? 'default' : 'outline'}
                      onClick={() => setProductSort((s) => (s === 'group' ? 'none' : 'group'))}
                      title="Cluster same products together (highest qty first) for faster picking"
                    >
                      Smart group
                    </Button>
                    <Button
                      size="sm"
                      variant={productSort === 'asc' ? 'default' : 'outline'}
                      onClick={() => setProductSort((s) => (s === 'asc' ? 'none' : 'asc'))}
                      title="Sort by product A→Z"
                    >
                      Product A→Z
                    </Button>
                    <Button
                      size="sm"
                      variant={productSort === 'desc' ? 'default' : 'outline'}
                      onClick={() => setProductSort((s) => (s === 'desc' ? 'none' : 'desc'))}
                      title="Sort by product Z→A"
                    >
                      Product Z→A
                    </Button>
                  </div>
                  {productSort === 'group' && productTotals.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      <span className="text-[10px] text-text-secondary self-center mr-1">Bulk mark by product:</span>
                      {productTotals.slice(0, 12).map(([name, qty]) => (
                        <Button
                          key={name}
                          size="sm"
                          variant="outline"
                          className="h-7 text-[10px] px-2 border-white/10"
                          onClick={() => markProductAssembled(name)}
                          title={`Mark all ${qty} of this product assembled`}
                        >
                          {name.length > 28 ? name.slice(0, 26) + '…' : name} · {qty}
                        </Button>
                      ))}
                    </div>
                  )}
                  {quantumRoute && quantumRoute.length > 0 && (
                    <div className="rounded-lg border border-accent-sky/20 bg-accent-sky/5 p-2.5">
                      <div className="text-[10px] uppercase tracking-wider text-accent-sky font-semibold mb-1.5 flex items-center gap-1">
                        <Sparkles className="w-3 h-3" /> Quantum route · {quantumRoute.length} stops
                      </div>
                      <div className="flex flex-wrap gap-1 max-h-16 overflow-auto">
                        {quantumRoute.slice(0, 24).map((p, i) => (
                          <span
                            key={`${p.sku}-${i}`}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/10 font-mono"
                          >
                            {i + 1}. {p.zone}
                          </span>
                        ))}
                        {quantumRoute.length > 24 && (
                          <span className="text-[10px] text-text-secondary">+{quantumRoute.length - 24} more</span>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="overflow-auto max-h-[50vh] rounded-md border border-white/5">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-void/95">
                        <tr className="text-text-secondary uppercase tracking-wider border-b border-white/10">
                          <th className="text-left py-2 px-2">#</th>
                          <th className="text-left py-2 px-2">Tracking id</th>
                          <th className="text-left py-2 px-2">Product</th>
                          <th className="text-right py-2 px-2">Qty</th>
                          <th className="text-center py-2 px-2">Done</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedRows.map((r, i) => (
                          <tr key={`${r.trackingId}-${i}`} className="border-b border-white/[0.04]">
                            <td className="py-1.5 px-2 text-text-secondary tabular-nums">{i + 1}</td>
                            <td className="py-1.5 px-2 font-mono text-accent-sky">{r.trackingId}</td>
                            <td className="py-1.5 px-2 text-white/80 truncate max-w-[16rem]">{r.product}</td>
                            <td className="py-1.5 px-2 text-right tabular-nums">{r.qty}</td>
                            <td className="py-1.5 px-2 text-center">
                              <input
                                type="checkbox"
                                className="accent-sky-500"
                                checked={assembled.has(r.trackingId)}
                                onChange={() => {
                                  setAssembled((prev) => {
                                    const n = new Set(prev);
                                    if (n.has(r.trackingId)) n.delete(r.trackingId);
                                    else n.add(r.trackingId);
                                    return n;
                                  });
                                }}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={confirmAssembly} disabled={!rows.length}>
                      Lock sequence & continue to audit
                    </Button>
                    <Button variant="outline" onClick={() => setStep(3)}>
                      Skip to audit
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* 3 Audit */}
        {step === 3 && (
          <Card className="bg-surface/40 border-white/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                3 · Scan validation & audit
              </CardTitle>
              <CardDescription>
                Live barcode scan auto-validates against posting list. Missing orders get remarks; file/camera errors surface immediately.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {(fileError || scanError) && (
                <div className="text-xs rounded-md px-3 py-2 border border-rose-500/30 bg-rose-500/10 text-rose-300 space-y-1">
                  {fileError && <p><strong>File:</strong> {fileError}</p>}
                  {scanError && <p><strong>Scan:</strong> {scanError}</p>}
                </div>
              )}

              <div className="grid md:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {!scanning ? (
                      <Button size="sm" className="gap-1.5" onClick={startScanner} disabled={!rows.length}>
                        <Camera className="w-3.5 h-3.5" /> Start barcode scanner
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" className="gap-1.5" onClick={stopScanner}>
                        <X className="w-3.5 h-3.5" /> Stop scanner
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={runAudit} disabled={!rows.length}>
                      Run full audit
                    </Button>
                  </div>
                  <div
                    id={scanRegionId}
                    className={`rounded-lg overflow-hidden border border-white/10 bg-black/40 ${scanning ? 'min-h-[180px]' : 'min-h-0'}`}
                  />
                  {!rows.length && (
                    <p className="text-[11px] text-amber-400">Upload posting XLSX in step 1 before scanning — expected orders are required for validation.</p>
                  )}
                  <textarea
                    value={actualPaste}
                    onChange={(e) => setActualPaste(e.target.value)}
                    rows={4}
                    placeholder="Or paste / type tracking IDs (one per line)…"
                    className="w-full text-xs font-mono rounded-md border border-white/10 bg-white/[0.03] px-2 py-1.5 text-white resize-y focus:outline-none focus:border-accent-sky"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const last = actualPaste.trim().split(/\r?\n/).filter(Boolean).pop();
                        if (last) applyScan(last);
                        else setScanError('Nothing to validate — paste a tracking ID first.');
                      }}
                    >
                      Validate last line
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => navigate('/auditor')}>
                      Open full Auditor
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      ['Scans', scanEvents.length],
                      ['Valid', validationSummary.valid],
                      ['Duplicates', validationSummary.duplicates],
                      ['Unknown', validationSummary.unknown],
                      ['Missing orders', validationSummary.missing.length],
                      ['Expected', validationSummary.expectedCount],
                    ].map(([l, v]) => (
                      <div key={String(l)} className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1.5">
                        <div className="text-[10px] text-text-secondary uppercase">{l}</div>
                        <div className="text-sm font-semibold tabular-nums text-white">{v}</div>
                      </div>
                    ))}
                  </div>
                  {validationSummary.missing.length > 0 && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 max-h-28 overflow-auto">
                      <p className="text-[10px] font-semibold text-amber-300 mb-1">Missing orders (not scanned)</p>
                      {validationSummary.missing.slice(0, 40).map((id) => (
                        <div key={id} className="flex items-start gap-2 text-[10px] mb-1">
                          <span className="font-mono text-amber-200 shrink-0">{id}</span>
                          <input
                            value={orderRemarks[id] || ''}
                            onChange={(e) =>
                              setOrderRemarks((prev) => ({ ...prev, [id]: e.target.value }))
                            }
                            placeholder="Remark…"
                            className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded px-1 py-0.5 text-white"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {scanEvents.length > 0 && (
                <div className="overflow-auto max-h-36 rounded-md border border-white/5">
                  <table className="w-full text-[10px]">
                    <thead className="sticky top-0 bg-void/95">
                      <tr className="text-text-secondary border-b border-white/10">
                        <th className="text-left py-1 px-2">Verdict</th>
                        <th className="text-left py-1 px-2">Tracking</th>
                        <th className="text-left py-1 px-2">Remark</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scanEvents.slice(0, 30).map((ev, i) => (
                        <tr key={`${ev.at}-${i}`} className="border-b border-white/[0.04]">
                          <td className="py-1 px-2 whitespace-nowrap">{ev.verdict}</td>
                          <td className="py-1 px-2 font-mono text-accent-sky">{ev.trackingId}</td>
                          <td className="py-1 px-2 text-text-secondary">{ev.remark}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {auditRows.length > 0 && (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    {[
                      ['Exact', auditRows.filter((a) => a.status === 'EXACT').length, 'text-emerald-400'],
                      ['Fuzzy', auditRows.filter((a) => a.status === 'FUZZY').length, 'text-amber-400'],
                      ['Mismatch', auditRows.filter((a) => a.status === 'MISMATCH').length, 'text-rose-400'],
                      ['Miss actual', auditRows.filter((a) => a.status === 'MISSING_ACTUAL').length, 'text-rose-400'],
                      ['Miss expected', auditRows.filter((a) => a.status === 'MISSING_EXPECTED').length, 'text-rose-400'],
                    ].map(([l, v, c]) => (
                      <div key={String(l)} className="rounded-lg border border-white/10 bg-white/[0.03] p-2">
                        <div className="text-[10px] text-text-secondary uppercase">{l}</div>
                        <div className={`text-lg font-semibold tabular-nums ${c}`}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div className="overflow-auto max-h-[28vh] rounded-md border border-white/5">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-void/95">
                        <tr className="text-text-secondary uppercase tracking-wider border-b border-white/10">
                          <th className="text-left py-2 px-2">Status</th>
                          <th className="text-left py-2 px-2">Tracking</th>
                          <th className="text-left py-2 px-2">Expected</th>
                          <th className="text-right py-2 px-2">Exp</th>
                          <th className="text-left py-2 px-2">Actual</th>
                          <th className="text-right py-2 px-2">Act</th>
                          <th className="text-left py-2 px-2">Remark</th>
                        </tr>
                      </thead>
                      <tbody>
                        {auditRows.map((a) => (
                          <tr key={a.trackingId} className="border-b border-white/[0.04]">
                            <td className="py-1.5 px-2">{a.status}</td>
                            <td className="py-1.5 px-2 font-mono text-accent-sky">{a.trackingId}</td>
                            <td className="py-1.5 px-2 truncate max-w-[8rem]">{a.expectedProduct}</td>
                            <td className="py-1.5 px-2 text-right">{a.expectedQty}</td>
                            <td className="py-1.5 px-2 truncate max-w-[8rem]">{a.actualProduct}</td>
                            <td className="py-1.5 px-2 text-right">{a.actualQty}</td>
                            <td className="py-1.5 px-2 text-[10px] text-text-secondary">
                              {orderRemarks[a.trackingId] ||
                                (a.status === 'MISSING_ACTUAL'
                                  ? 'Not scanned'
                                  : a.status === 'MISSING_EXPECTED'
                                    ? 'Not in posting file'
                                    : '—')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setStep(4)} disabled={!rows.length}>
                  Continue to dispatch
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

{step === 4 && (
          <Card className="bg-surface/40 border-white/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Layers className="w-4 h-4 text-accent-sky" />
                4 · Dispatch by client batch & report
              </CardTitle>
              <CardDescription>
                Client batch = tracking family prefix (e.g. 51288840-0100). Confirm after physical hand-off.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2 max-h-[50vh] overflow-auto">
                {batches.map((b) => (
                  <div
                    key={b.id}
                    className={`rounded-lg border p-3 ${
                      shippedBatches.has(b.id) ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-white/5 bg-white/[0.02]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-white font-mono">{b.id}</div>
                        <div className="text-[11px] text-text-secondary">
                          {b.items.length} line(s) · qty {b.qty}
                        </div>
                      </div>
                      <Badge variant="outline" className="border-white/10">
                        {shippedBatches.has(b.id) ? 'Dispatched' : 'Pending'}
                      </Badge>
                    </div>
                  </div>
                ))}
                {!batches.length && <p className="text-sm text-text-secondary">No batches — receive posting first.</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={markDispatched} disabled={!batches.length}>
                  Mark all batches dispatched
                </Button>
                <Button variant="outline" onClick={() => navigate('/shipping')}>
                  Open Shipping
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* 5 Summary */}
        {step === 5 && (
          <Card className="bg-surface/40 border-white/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-accent-sky" />
                5 · Daily workflow summary
              </CardTitle>
              <CardDescription>Automatic roll-up of today’s instant fulfillment wave.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {[
                  ['Posting lines', rows.length],
                  ['Total qty', rows.reduce((s, r) => s + r.qty, 0)],
                  ['Assembled', assembled.size],
                  ['Audit rows', auditRows.length],
                  ['Client batches', batches.length],
                  ['Dispatched', shippedBatches.size],
                ].map(([label, val]) => (
                  <div key={String(label)} className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                    <div className="text-[10px] uppercase tracking-wider text-text-secondary">{label}</div>
                    <div className="text-xl font-semibold text-white tabular-nums mt-0.5">{val}</div>
                  </div>
                ))}
              </div>
              {productTotals.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">
                    Top products (qty)
                  </h3>
                  <div className="space-y-1 max-h-40 overflow-auto">
                    {productTotals.slice(0, 12).map(([name, qty]) => (
                      <div key={name} className="flex justify-between text-xs gap-2 border-b border-white/[0.04] py-1">
                        <span className="text-white/80 truncate">{name}</span>
                        <span className="tabular-nums text-accent-sky shrink-0">{qty}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button className="gap-1.5" onClick={exportDailySummary} disabled={!rows.length}>
                  <FileDown className="w-3.5 h-3.5" />
                  Export daily summary XLSX
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setStep(1);
                    setMessage(null);
                  }}
                >
                  New wave
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
