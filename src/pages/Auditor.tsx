import { useMemo, useState, useCallback, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import * as XLSX from 'xlsx';
import { readWorkbookFile, describeSpreadsheetError } from '@/lib/spreadsheet';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import {
  Scale, Zap, AlertTriangle, CheckCircle, FileCheck, Upload,
  FileDown, Filter, Pencil, Save, X, Maximize2, ArrowUpDown,
  ArrowUp, ArrowDown, Search, Columns3, GripVertical,
} from 'lucide-react';
import { logAction } from '@/lib/db';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';

type MatchStatus =
  | 'EXACT_MATCH'
  | 'FUZZY_MATCH'
  | 'MISMATCH'
  | 'MISSING_ACTUAL'
  | 'MISSING_EXPECTED';

interface OrderLine {
  orderId: string;
  product: string;
  quantity: number;
  remarks?: string;
}

interface DiscrepancyResult {
  orderId: string;
  expectedProduct: string;
  expectedQty: number;
  actualProduct: string;
  actualQty: number;
  status: MatchStatus;
  matchScore: number;
  remarks: string;
  discrepancyNotes: string;
  note?: string;
}

type SortKey =
  | 'orderId'
  | 'status'
  | 'matchScore'
  | 'expectedProduct'
  | 'actualProduct'
  | 'expectedQty'
  | 'actualQty';

type StatusFilter = 'all' | MatchStatus | 'problems';

interface ColumnDef {
  key: SortKey | 'notes' | 'edit';
  label: string;
  width: number;
  sortable: boolean;
  visible: boolean;
  minWidth?: number;
}

const DEFAULT_COLUMNS: ColumnDef[] = [
  { key: 'status', label: 'Status', width: 130, sortable: true, visible: true, minWidth: 90 },
  { key: 'orderId', label: 'Order ID', width: 140, sortable: true, visible: true, minWidth: 100 },
  { key: 'expectedProduct', label: 'Expected', width: 220, sortable: true, visible: true, minWidth: 120 },
  { key: 'expectedQty', label: 'Exp qty', width: 80, sortable: true, visible: true, minWidth: 60 },
  { key: 'actualProduct', label: 'Actual', width: 220, sortable: true, visible: true, minWidth: 120 },
  { key: 'actualQty', label: 'Act qty', width: 80, sortable: true, visible: true, minWidth: 60 },
  { key: 'matchScore', label: 'Score', width: 70, sortable: true, visible: true, minWidth: 50 },
  { key: 'notes', label: 'Notes', width: 160, sortable: false, visible: true, minWidth: 80 },
  { key: 'edit', label: 'Edit', width: 60, sortable: false, visible: true, minWidth: 50 },
];

// ─── Product normalization & fuzzy match (from auditor_enhanced) ─────────────

function normalizeProductName(product: string): string {
  if (!product) return '';
  let n = product.replace(/\s+/g, ' ').trim();
  n = n.replace(/\bгб\b/gi, 'GB').replace(/\bГБ\b/g, 'GB').replace(/\bgb\b/gi, 'GB');
  n = n.replace(/\bтб\b/gi, 'TB').replace(/\bТБ\b/g, 'TB');
  n = n.replace(/\bmb\b/gi, 'MB').replace(/\bМБ\b/g, 'MB');
  n = n.replace(/[^\w\s\-]/g, '');
  n = n.replace(/\bsamsung\b/gi, 'Samsung');
  n = n.replace(/\bapple\b/gi, 'Apple');
  n = n.replace(/\bgalaxy\b/gi, 'Galaxy');
  n = n.replace(/\bairpods\b/gi, 'AirPods');
  return n;
}

function fuzzyMatchProduct(expected: string, actual: string): number {
  if (!expected || !actual) return 0;
  const en = normalizeProductName(expected);
  const an = normalizeProductName(actual);
  if (en === an) return 1;
  if (en.includes(an) || an.includes(en)) return 0.8;
  const et = new Set(en.toLowerCase().split(/\s+/).filter(Boolean));
  const at = new Set(an.toLowerCase().split(/\s+/).filter(Boolean));
  if (!et.size || !at.size) return 0;
  let inter = 0;
  for (const t of et) if (at.has(t)) inter++;
  const union = new Set([...et, ...at]).size;
  let jaccard = inter / union;
  const keyTokens = new Set(['samsung', 'apple', 'galaxy', 'airpods', 'watch', 'buds', 'iphone', 'ipad', 'xiaomi', 'redmi']);
  let keyMatch = 0;
  for (const t of et) if (at.has(t) && keyTokens.has(t)) keyMatch++;
  if (keyMatch >= 1) jaccard = Math.min(1, jaccard + 0.2);
  return jaccard;
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

function robustParseMultiline(textData: string): Map<string, OrderLine> {
  const ID_RE = /\b\d{6,15}-?\d{0,6}-?\d{0,4}\b/g;
  const map = new Map<string, OrderLine>();
  let currentId: string | null = null;

  for (const line of textData.trim().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const matches = trimmed.match(ID_RE);
    if (matches?.length) {
      currentId = matches[0];
      const desc = trimmed.replace(currentId, '').replace(/\|/g, '').trim();
      const existing = map.get(currentId);
      if (existing) {
        if (desc) existing.product = existing.product ? `${existing.product} | ${desc}` : desc;
        existing.quantity += 1;
      } else {
        map.set(currentId, { orderId: currentId, product: desc || '', quantity: 1 });
      }
    } else if (currentId) {
      const existing = map.get(currentId);
      if (existing) {
        existing.product = existing.product ? `${existing.product} | ${trimmed}` : trimmed;
      }
    } else {
      // "ID rest of line" fallback
      const parts = trimmed.split(/\s+/, 2);
      if (parts[0] && parts[0].length >= 6) {
        map.set(parts[0], {
          orderId: parts[0],
          product: parts[1] || '',
          quantity: 1,
        });
      }
    }
  }
  return map;
}

function cleanOrderRows(json: unknown[][]): OrderLine[] {
  if (!json.length) return [];
  const norm = (h: unknown) =>
    String(h ?? '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, ' ');

  let headerIdx = -1;
  for (let i = 0; i < Math.min(15, json.length); i++) {
    const row = (json[i] || []).map(norm);
    if (
      row.some(
        (c) =>
          c.includes('order id') ||
          c.includes('order_id') ||
          c.includes('shipment') ||
          c.includes('tracking') ||
          c === 'id' ||
          c.includes('product')
      )
    ) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) headerIdx = 0;

  const headers = (json[headerIdx] || []).map(norm);
  const findCol = (preds: ((h: string) => boolean)[]) => {
    for (const pred of preds) {
      const i = headers.findIndex(pred);
      if (i >= 0) return i;
    }
    return -1;
  };

  const iId = findCol([
    (h) => h.includes('order id'),
    (h) => h === 'order_id',
    (h) => h.includes('shipment number'),
    (h) => h.includes('shipment'),
    (h) => h.includes('tracking'),
    (h) => h === 'id',
  ]);
  const iProduct = findCol([
    (h) => h.includes('product name'),
    (h) => h === 'products' || h === 'product',
    (h) => h.includes('description'),
    (h) => h.includes('title'),
    (h) => h.includes('name'),
  ]);
  const iQty = findCol([(h) => h === 'qty' || h.includes('quantity')]);
  const iRemarks = findCol([
    (h) => h.includes('clients and remarks'),
    (h) => h.includes('remarks'),
    (h) => h.includes('results'),
    (h) => h.includes('status'),
    (h) => h.includes('note'),
  ]);

  const out: OrderLine[] = [];
  for (let r = headerIdx + 1; r < json.length; r++) {
    const row = json[r] || [];
    const orderId = String(row[iId >= 0 ? iId : 0] ?? '').trim();
    if (!orderId || orderId.toLowerCase() === 'nan') continue;
    const product = String(row[iProduct >= 0 ? iProduct : 1] ?? '').trim();
    const quantity = Math.max(1, Number(row[iQty >= 0 ? iQty : -1]) || 1);
    const remarks = iRemarks >= 0 ? String(row[iRemarks] ?? '').trim() : '';
    out.push({ orderId, product, quantity, remarks });
  }
  return out;
}

function ordersToMap(lines: OrderLine[]): Map<string, OrderLine> {
  const map = new Map<string, OrderLine>();
  for (const line of lines) {
    const id = line.orderId.trim();
    if (!id) continue;
    const prev = map.get(id);
    if (prev) {
      prev.quantity += line.quantity;
      if (line.product && line.product !== prev.product) {
        prev.product = `${prev.product} | ${line.product}`;
      }
    } else {
      map.set(id, { ...line });
    }
  }
  return map;
}

function runDiscrepancyTest(
  expected: Map<string, OrderLine>,
  actual: Map<string, OrderLine>
): DiscrepancyResult[] {
  const allIds = new Set([...expected.keys(), ...actual.keys()]);
  const results: DiscrepancyResult[] = [];

  for (const orderId of [...allIds].sort()) {
    const exp = expected.get(orderId);
    const act = actual.get(orderId);
    const base: DiscrepancyResult = {
      orderId,
      expectedProduct: exp?.product || 'MISSING',
      expectedQty: exp?.quantity ?? 0,
      actualProduct: act?.product || 'MISSING',
      actualQty: act?.quantity ?? 0,
      status: 'MISMATCH',
      matchScore: 0,
      remarks: '',
      discrepancyNotes: '',
    };

    if (exp && act) {
      const score = fuzzyMatchProduct(exp.product, act.product);
      const qtyMatch = exp.quantity === act.quantity;
      base.matchScore = score;
      if (score >= 0.9 && qtyMatch) {
        base.status = 'EXACT_MATCH';
      } else if (score >= 0.7) {
        base.status = 'FUZZY_MATCH';
        base.discrepancyNotes = `Product similarity: ${(score * 100).toFixed(0)}%`;
        if (!qtyMatch) {
          base.discrepancyNotes += `; Qty mismatch: expected ${exp.quantity}, actual ${act.quantity}`;
        }
      } else {
        base.status = 'MISMATCH';
        base.discrepancyNotes = `Product mismatch (score: ${(score * 100).toFixed(0)}%)`;
        if (!qtyMatch) {
          base.discrepancyNotes += `; Qty mismatch: expected ${exp.quantity}, actual ${act.quantity}`;
        }
      }
      const parts: string[] = [];
      if (exp.remarks) parts.push(`Expected: ${exp.remarks}`);
      if (act.remarks) parts.push(`Actual: ${act.remarks}`);
      base.remarks = parts.join(' | ');
    } else if (exp && !act) {
      base.status = 'MISSING_ACTUAL';
      base.discrepancyNotes = 'Present in Expected but not in Actual';
      if (exp.remarks) base.remarks = `Expected: ${exp.remarks}`;
    } else if (!exp && act) {
      base.status = 'MISSING_EXPECTED';
      base.discrepancyNotes = 'Present in Actual but not in Expected';
      if (act.remarks) base.remarks = `Actual: ${act.remarks}`;
    }

    results.push(base);
  }
  return results;
}

function statusLabel(s: MatchStatus): string {
  switch (s) {
    case 'EXACT_MATCH':
      return 'Exact match';
    case 'FUZZY_MATCH':
      return 'Fuzzy match';
    case 'MISMATCH':
      return 'Mismatch';
    case 'MISSING_ACTUAL':
      return 'Missing in actual';
    case 'MISSING_EXPECTED':
      return 'Missing in expected';
  }
}

function statusRowClass(s: MatchStatus): string {
  if (s === 'EXACT_MATCH') return 'bg-emerald-500/[0.06]';
  if (s === 'FUZZY_MATCH') return 'bg-amber-500/[0.07]';
  return 'bg-rose-500/[0.06]';
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Auditor() {
  const { user } = useAuth();
  const operator = user?.displayName || user?.username || 'Operator';

  const [masterIn, setMasterIn] = useState('');
  const [scanIn, setScanIn] = useState('');
  const [results, setResults] = useState<DiscrepancyResult[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('status');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<DiscrepancyResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [columns, setColumns] = useState<ColumnDef[]>(DEFAULT_COLUMNS);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const resizeRef = useRef<{ key: string; startX: number; startW: number } | null>(null);
  const dragColRef = useRef<string | null>(null);

  const summary = useMemo(() => {
    const s = {
      total: results.length,
      exact: 0,
      fuzzy: 0,
      mismatch: 0,
      missingActual: 0,
      missingExpected: 0,
    };
    for (const r of results) {
      if (r.status === 'EXACT_MATCH') s.exact++;
      else if (r.status === 'FUZZY_MATCH') s.fuzzy++;
      else if (r.status === 'MISMATCH') s.mismatch++;
      else if (r.status === 'MISSING_ACTUAL') s.missingActual++;
      else if (r.status === 'MISSING_EXPECTED') s.missingExpected++;
    }
    const matches = s.exact + s.fuzzy;
    const accuracy = s.total ? Math.round((matches / s.total) * 1000) / 10 : 0;
    return { ...s, matches, accuracy };
  }, [results]);

  const filtered = useMemo(() => {
    let rows = results;
    if (statusFilter === 'problems') {
      rows = rows.filter((r) => r.status !== 'EXACT_MATCH');
    } else if (statusFilter !== 'all') {
      rows = rows.filter((r) => r.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.orderId.toLowerCase().includes(q) ||
          r.expectedProduct.toLowerCase().includes(q) ||
          r.actualProduct.toLowerCase().includes(q) ||
          (r.note || '').toLowerCase().includes(q) ||
          r.discrepancyNotes.toLowerCase().includes(q)
      );
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const statusOrder: Record<MatchStatus, number> = {
        MISSING_ACTUAL: 0,
        MISSING_EXPECTED: 1,
        MISMATCH: 2,
        FUZZY_MATCH: 3,
        EXACT_MATCH: 4,
      };
      let cmp = 0;
      switch (sortKey) {
        case 'status':
          cmp = statusOrder[a.status] - statusOrder[b.status];
          break;
        case 'matchScore':
          cmp = a.matchScore - b.matchScore;
          break;
        case 'expectedQty':
        case 'actualQty':
          cmp = a[sortKey] - b[sortKey];
          break;
        default:
          cmp = String(a[sortKey]).localeCompare(String(b[sortKey]));
      }
      return cmp * dir;
    });
    return rows;
  }, [results, statusFilter, search, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const visibleColumns = useMemo(() => columns.filter((c) => c.visible), [columns]);

  const toggleColumnVisibility = (key: string) => {
    setColumns((prev) =>
      prev.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c))
    );
  };

  const onResizeStart = (key: string, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const col = columns.find((c) => c.key === key);
    if (!col) return;
    resizeRef.current = { key, startX: e.clientX, startW: col.width };
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = ev.clientX - resizeRef.current.startX;
      const minW = col.minWidth ?? 50;
      const newW = Math.max(minW, resizeRef.current.startW + delta);
      setColumns((prev) =>
        prev.map((c) => (c.key === resizeRef.current!.key ? { ...c, width: newW } : c))
      );
    };
    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onColDragStart = (key: string) => {
    dragColRef.current = key;
  };

  const onColDrop = (targetKey: string) => {
    const fromKey = dragColRef.current;
    dragColRef.current = null;
    if (!fromKey || fromKey === targetKey) return;
    setColumns((prev) => {
      const next = [...prev];
      const fromIdx = next.findIndex((c) => c.key === fromKey);
      const toIdx = next.findIndex((c) => c.key === targetKey);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };

  const handleAnalyze = () => {
    if (!masterIn.trim() || !scanIn.trim()) {
      setMessage('Paste Expected (MASTER) and Actual (SCAN) data first.');
      return;
    }
    setMessage(null);
    const exp = robustParseMultiline(masterIn);
    const act = robustParseMultiline(scanIn);
    const rows = runDiscrepancyTest(exp, act);
    setResults(rows);
    const matches = rows.filter((r) => r.status === 'EXACT_MATCH' || r.status === 'FUZZY_MATCH').length;
    logAction(
      'AUDITOR_ANALYZE',
      `total=${rows.length} matches=${matches}`,
      operator
    );
  };

  const loadWorkbook = async (file: File) => {
    try {
      // Parsed through the hardened boundary: size/type guards first, and no
      // cell value from an untrusted file reaches business logic un-coerced.
      const wb = await readWorkbookFile(file, { cellDates: true });
      setSheetNames(wb.sheetNames);

      const sheets: Record<string, OrderLine[]> = {};
      for (const sheet of wb.sheets) {
        sheets[sheet.name] = cleanOrderRows(sheet.rows as unknown[][]);
      }

      // Auto-detect expected vs actual by sheet name
      let expectedLines: OrderLine[] = [];
      let actualLines: OrderLine[] = [];
      for (const [name, lines] of Object.entries(sheets)) {
        const n = name.toLowerCase();
        if (n.includes('expected') || n.includes('master') || n.includes('plan')) {
          expectedLines = lines;
        } else if (n.includes('actual') || n.includes('atual') || n.includes('scan') || n.includes('progress')) {
          actualLines = lines;
        }
      }
      // Fallback: first two sheets
      if (!expectedLines.length && !actualLines.length && wb.sheetNames.length >= 2) {
        expectedLines = sheets[wb.sheetNames[0]] || [];
        actualLines = sheets[wb.sheetNames[1]] || [];
      } else if (!expectedLines.length && wb.sheetNames.length === 1) {
        // Single sheet — put in expected, user can paste actual
        expectedLines = sheets[wb.sheetNames[0]] || [];
      }

      const toPaste = (lines: OrderLine[]) =>
        lines.map((l) => `${l.orderId}\t${l.product}\t${l.quantity}`).join('\n');

      if (expectedLines.length) setMasterIn(toPaste(expectedLines));
      if (actualLines.length) setScanIn(toPaste(actualLines));

      if (expectedLines.length && actualLines.length) {
        const rows = runDiscrepancyTest(ordersToMap(expectedLines), ordersToMap(actualLines));
        setResults(rows);
        setMessage(
          `Workbook “${file.name}” · sheets: ${wb.sheetNames.join(', ')} · ${rows.length} order IDs compared`
        );
        logAction('AUDITOR_EXCEL', `${file.name} rows=${rows.length}`, operator);
      } else {
        setMessage(
          `Loaded “${file.name}” (${wb.sheetNames.join(', ')}). Map data into Expected/Actual paste fields, then Run analysis.`
        );
      }
    } catch (e) {
      setMessage(`XLSX parse failed: ${describeSpreadsheetError(e)}`);
    }
  };

  const loadSideXlsx = async (file: File, side: 'master' | 'scan') => {
    try {
      const wb = await readWorkbookFile(file, { cellDates: true });
      const lines = cleanOrderRows((wb.sheets[0]?.rows ?? []) as unknown[][]);
      const text = lines.map((l) => `${l.orderId}\t${l.product}\t${l.quantity}`).join('\n');
      if (side === 'master') setMasterIn(text);
      else setScanIn(text);
      setMessage(`Loaded ${file.name} → ${side === 'master' ? 'Expected' : 'Actual'} (${lines.length} rows)`);
    } catch (e) {
      setMessage(`XLSX parse failed: ${describeSpreadsheetError(e)}`);
    }
  };

  const startEdit = (r: DiscrepancyResult) => {
    setEditingId(r.orderId);
    setEditDraft({ ...r });
  };

  const saveEdit = () => {
    if (!editDraft || !editingId) return;
    const score =
      editDraft.expectedProduct !== 'MISSING' && editDraft.actualProduct !== 'MISSING'
        ? fuzzyMatchProduct(editDraft.expectedProduct, editDraft.actualProduct)
        : 0;
    const qtyMatch = editDraft.expectedQty === editDraft.actualQty;
    let status: MatchStatus = editDraft.status;
    if (editDraft.expectedProduct === 'MISSING') status = 'MISSING_EXPECTED';
    else if (editDraft.actualProduct === 'MISSING') status = 'MISSING_ACTUAL';
    else if (score >= 0.9 && qtyMatch) status = 'EXACT_MATCH';
    else if (score >= 0.7) status = 'FUZZY_MATCH';
    else status = 'MISMATCH';

    const updated: DiscrepancyResult = {
      ...editDraft,
      matchScore: score,
      status,
    };
    setResults((prev) => prev.map((r) => (r.orderId === editingId ? updated : r)));
    setEditingId(null);
    setEditDraft(null);
  };

  const exportReport = useCallback(() => {
    const header = [
      'Status',
      'Order ID',
      'Expected Product',
      'Expected Qty',
      'Actual Product',
      'Actual Qty',
      'Match Score',
      'Discrepancy Notes',
      'Remarks',
      'Note',
    ];
    const body = results.map((r) => [
      statusLabel(r.status),
      r.orderId,
      r.expectedProduct,
      r.expectedQty,
      r.actualProduct,
      r.actualQty,
      Math.round(r.matchScore * 100) / 100,
      r.discrepancyNotes,
      r.remarks,
      r.note || '',
    ]);
    const totals = [
      [],
      ['SUMMARY'],
      ['Total orders', summary.total],
      ['Exact matches', summary.exact],
      ['Fuzzy matches', summary.fuzzy],
      ['Mismatches', summary.mismatch],
      ['Missing in actual', summary.missingActual],
      ['Missing in expected', summary.missingExpected],
      ['Accuracy %', summary.accuracy],
    ];
    const ws = XLSX.utils.aoa_to_sheet([header, ...body, ...totals]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Discrepancy Results');
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Metric', 'Value'],
        ['Total orders', summary.total],
        ['Exact matches', summary.exact],
        ['Fuzzy matches', summary.fuzzy],
        ['Mismatches', summary.mismatch],
        ['Missing in actual', summary.missingActual],
        ['Missing in expected', summary.missingExpected],
        ['Accuracy %', summary.accuracy],
      ]),
      'Summary'
    );
    XLSX.writeFile(wb, `discrepancy_results_${new Date().toISOString().slice(0, 10)}.xlsx`);
    logAction(
      'AUDITOR_EXPORT',
      `total=${summary.total} accuracy=${summary.accuracy}`,
      operator
    );
  }, [results, summary, operator]);

  // Rendered as a plain function (NOT a nested component) on purpose:
  // defining it as an inner component makes React remount the whole table on
  // every Auditor re-render, which swallows in-progress clicks and kills the
  // sort-reorder animations.
  const renderResultsTable = (compact = false) => {
    const cols = visibleColumns.filter((c) => {
      if (compact && (c.key === 'notes' || c.key === 'expectedQty' || c.key === 'actualQty' || c.key === 'matchScore')) return false;
      return true;
    });

    const renderCell = (r: DiscrepancyResult, col: ColumnDef) => {
      const editing = editingId === r.orderId && editDraft;
      switch (col.key) {
        case 'status':
          return (
            <span className="whitespace-nowrap">
              {r.status === 'EXACT_MATCH' && <CheckCircle className="w-3.5 h-3.5 text-emerald-400 inline mr-1" />}
              {(r.status === 'FUZZY_MATCH' || r.status === 'MISMATCH') && (
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 inline mr-1" />
              )}
              {(r.status === 'MISSING_ACTUAL' || r.status === 'MISSING_EXPECTED') && (
                <AlertTriangle className="w-3.5 h-3.5 text-rose-400 inline mr-1" />
              )}
              {statusLabel(r.status)}
            </span>
          );
        case 'orderId':
          return <span className="font-mono text-accent-sky">{r.orderId}</span>;
        case 'expectedProduct':
          return editing ? (
            <input
              className="w-full bg-white/[0.05] border border-white/10 rounded px-1 py-0.5 text-text-primary"
              value={editDraft!.expectedProduct}
              onChange={(e) => setEditDraft({ ...editDraft!, expectedProduct: e.target.value })}
            />
          ) : (
            <span
              className="truncate block cursor-text hover:bg-white/[0.04] rounded px-0.5 -mx-0.5"
              title={r.expectedProduct + ' (double-click to edit)'}
              onDoubleClick={(e) => { e.stopPropagation(); startEdit(r); }}
            >{r.expectedProduct}</span>
          );
        case 'expectedQty':
          return editing ? (
            <input
              type="number"
              className="w-full bg-white/[0.05] border border-white/10 rounded px-1 py-0.5 text-text-primary text-right"
              value={editDraft!.expectedQty}
              onChange={(e) => setEditDraft({ ...editDraft!, expectedQty: Number(e.target.value) || 0 })}
            />
          ) : (
            <span className="tabular-nums text-right block">{r.expectedQty}</span>
          );
        case 'actualProduct':
          return editing ? (
            <input
              className="w-full bg-white/[0.05] border border-white/10 rounded px-1 py-0.5 text-text-primary"
              value={editDraft!.actualProduct}
              onChange={(e) => setEditDraft({ ...editDraft!, actualProduct: e.target.value })}
            />
          ) : (
            <span
              className="truncate block cursor-text hover:bg-white/[0.04] rounded px-0.5 -mx-0.5"
              title={r.actualProduct + ' (double-click to edit)'}
              onDoubleClick={(e) => { e.stopPropagation(); startEdit(r); }}
            >{r.actualProduct}</span>
          );
        case 'actualQty':
          return editing ? (
            <input
              type="number"
              className="w-full bg-white/[0.05] border border-white/10 rounded px-1 py-0.5 text-text-primary text-right"
              value={editDraft!.actualQty}
              onChange={(e) => setEditDraft({ ...editDraft!, actualQty: Number(e.target.value) || 0 })}
            />
          ) : (
            <span className="tabular-nums text-right block">{r.actualQty}</span>
          );
        case 'matchScore':
          return (
            <span className="tabular-nums">
              {r.matchScore >= 0.99 ? '1.00' : r.matchScore.toFixed(2)}
            </span>
          );
        case 'notes':
          return editing ? (
            <input
              className="w-full bg-white/[0.05] border border-white/10 rounded px-1 py-0.5 text-text-primary"
              value={editDraft!.note || ''}
              onChange={(e) => setEditDraft({ ...editDraft!, note: e.target.value })}
              placeholder="Note"
            />
          ) : (
            <span title={r.discrepancyNotes || r.remarks}>{r.note || r.discrepancyNotes || r.remarks || '—'}</span>
          );
        case 'edit':
          return editing ? (
            <span className="inline-flex gap-1 justify-end w-full">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); saveEdit(); }}
                className="p-1.5 text-accent-green hover:bg-white/10 rounded"
                title="Save changes"
              >
                <Save className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setEditingId(null); setEditDraft(null); }}
                className="p-1.5 text-text-secondary hover:bg-white/10 rounded"
                title="Cancel"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); startEdit(r); }}
              className="p-1.5 text-text-secondary hover:text-accent-sky hover:bg-white/10 rounded"
              title="Edit this row"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          );
        default:
          return null;
      }
    };

    return (
      <div className="w-full overflow-x-auto">
        <LayoutGroup>
        <table className="text-xs border-collapse" style={{ tableLayout: 'fixed', width: cols.reduce((s, c) => s + c.width, 0) }}>
          <thead className="sticky top-0 bg-void/95 z-10">
            <tr className="text-text-secondary uppercase tracking-wider border-b border-white/10">
              {cols.map((col) => (
                <motion.th
                  key={col.key}
                  layout
                  transition={{ layout: { type: 'spring', stiffness: 550, damping: 42 } }}
                  className="text-left py-2 px-2 relative select-none group"
                  style={{ width: col.width, minWidth: col.minWidth }}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                  onDrop={(e) => { e.preventDefault(); onColDrop(col.key); }}
                >
                  <div className="flex items-center gap-1 min-w-0">
                    {col.key !== 'edit' && (
                      <span
                        draggable
                        onDragStart={(e) => {
                          e.stopPropagation();
                          onColDragStart(col.key);
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', col.key);
                        }}
                        className="opacity-0 group-hover:opacity-50 shrink-0 cursor-grab active:cursor-grabbing p-0.5 -ml-1"
                        title="Drag to reorder column"
                      >
                        <GripVertical className="w-3 h-3" />
                      </span>
                    )}
                    {col.sortable ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSort(col.key as SortKey);
                        }}
                        className="inline-flex items-center gap-1 hover:text-accent-sky font-semibold truncate"
                      >
                        {col.label}
                        {sortKey === col.key ? (
                          sortDir === 'asc' ? (
                            <ArrowUp className="w-3 h-3 text-accent-sky shrink-0" />
                          ) : (
                            <ArrowDown className="w-3 h-3 text-accent-sky shrink-0" />
                          )
                        ) : (
                          <ArrowUpDown className="w-3 h-3 opacity-40 shrink-0" />
                        )}
                      </button>
                    ) : (
                      <span className="font-semibold truncate">{col.label}</span>
                    )}
                  </div>
                  {/* Resize handle — only right edge */}
                  <div
                    className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent-sky/60 active:bg-accent-sky z-10"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      onResizeStart(col.key, e);
                    }}
                    title="Drag to resize column"
                  />
                </motion.th>
              ))}
            </tr>
          </thead>
          <tbody>
            <AnimatePresence initial={false}>
            {filtered.map((r) => {
              const editing = editingId === r.orderId && editDraft;
              return (
                <motion.tr
                  key={r.orderId}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{
                    layout: { type: 'spring', stiffness: 550, damping: 42 },
                    opacity: { duration: 0.18 },
                  }}
                  className={`border-b border-white/[0.04] ${statusRowClass(r.status)} ${editing ? 'bg-white/[0.04]' : ''}`}
                >
                  {cols.map((col) => (
                    <td
                      key={col.key}
                      className={`py-1.5 px-2 ${col.key === 'edit' ? 'text-right' : ''} ${col.key === 'expectedQty' || col.key === 'actualQty' || col.key === 'matchScore' ? 'text-right' : ''}`}
                      style={{ width: col.width }}
                    >
                      {renderCell(r, col)}
                    </td>
                  ))}
                </motion.tr>
              );
            })}
            </AnimatePresence>
            {!filtered.length && (
              <tr>
                <td colSpan={cols.length} className="py-8 text-center text-text-secondary">
                  No rows match filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </LayoutGroup>
      </div>
    );
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 max-w-6xl mx-auto">
      <div className="shrink-0">
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
          <Scale className="w-6 h-6 text-accent-sky" />
          Enhanced Discrepancy Auditor
        </h1>
        <p className="text-sm text-text-secondary mt-1">
          Paste Expected vs Actual, or upload Excel (Expected / Actual sheets). Fuzzy product match · filters · sort ASC/DESC · resize & reorder columns · edit rows · full-screen review.
        </p>
      </div>

      {message && (
        <div className="shrink-0 text-xs rounded-md px-3 py-2 border border-white/10 bg-white/[0.03] text-text-secondary">
          {message}
          {sheetNames.length > 0 && (
            <span className="ml-2 text-white/40">Sheets: {sheetNames.join(', ')}</span>
          )}
        </div>
      )}

      {/* Workbook upload */}
      <div className="shrink-0 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-white/15 cursor-pointer hover:border-accent-sky/40 text-xs text-text-secondary">
          <Upload className="w-4 h-4" />
          Upload workbook (Expected + Actual sheets)
          <input
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) loadWorkbook(f);
            }}
          />
        </label>
      </div>

      <div className="shrink-0 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="glass-panel rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <FileCheck className="w-4 h-4 text-accent-green" />
              <h3 className="text-sm font-semibold text-text-primary">EXPECTED (Master)</h3>
            </div>
            <label className="flex items-center gap-1 text-[10px] text-text-secondary cursor-pointer hover:text-accent-sky">
              <Upload className="w-3 h-3" /> XLSX
              <input
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) loadSideXlsx(f, 'master');
                }}
              />
            </label>
          </div>
          <textarea
            value={masterIn}
            onChange={(e) => setMasterIn(e.target.value)}
            className="w-full h-40 bg-transparent border border-white/[0.08] rounded-md p-3 text-xs text-text-primary font-mono resize-none focus:outline-none focus:border-accent-green"
            placeholder="Paste expected order IDs + products (or upload XLSX)…"
          />
        </div>

        <div className="glass-panel rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-accent-yellow" />
              <h3 className="text-sm font-semibold text-text-primary">ACTUAL (Scan)</h3>
            </div>
            <label className="flex items-center gap-1 text-[10px] text-text-secondary cursor-pointer hover:text-accent-sky">
              <Upload className="w-3 h-3" /> XLSX
              <input
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) loadSideXlsx(f, 'scan');
                }}
              />
            </label>
          </div>
          <textarea
            value={scanIn}
            onChange={(e) => setScanIn(e.target.value)}
            className="w-full h-40 bg-transparent border border-white/[0.08] rounded-md p-3 text-xs text-text-primary font-mono resize-none focus:outline-none focus:border-accent-yellow"
            placeholder="Paste actual order IDs + products (or upload XLSX)…"
          />
        </div>
      </div>

      <div className="shrink-0 flex flex-wrap items-center gap-3">
        <motion.button
          onClick={handleAnalyze}
          whileTap={{ scale: 0.98 }}
          className="flex items-center gap-2 px-5 py-2.5 bg-accent-sky text-void font-semibold text-sm rounded-md hover:bg-accent-sky/90"
        >
          <Zap className="w-4 h-4" />
          Run discrepancy analysis
        </motion.button>
        {results.length > 0 && (
          <>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={exportReport}>
              <FileDown className="w-3.5 h-3.5" /> Export Excel
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setFullscreen(true)}>
              <Maximize2 className="w-3.5 h-3.5" /> Full screen
            </Button>
            <div className="relative">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => setShowColumnPicker((v) => !v)}
              >
                <Columns3 className="w-3.5 h-3.5" /> Columns
              </Button>
              {showColumnPicker && (
                <div className="absolute left-0 top-full mt-1 z-50 w-52 rounded-md border border-white/10 bg-void shadow-xl p-2 text-xs">
                  <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-1.5 px-1">
                    Toggle columns
                  </div>
                  {columns
                    .filter((c) => c.key !== 'edit')
                    .map((c) => (
                      <label
                        key={c.key}
                        className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/5 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={c.visible}
                          onChange={() => toggleColumnVisibility(c.key)}
                          className="rounded border-white/20"
                        />
                        <span className="text-text-primary">{c.label}</span>
                      </label>
                    ))}
                  <button
                    type="button"
                    className="mt-1 w-full text-left px-2 py-1 text-accent-sky hover:bg-white/5 rounded"
                    onClick={() => {
                      setColumns(DEFAULT_COLUMNS);
                      setShowColumnPicker(false);
                    }}
                  >
                    Reset columns
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {results.length > 0 && (
        <>
          <div className="shrink-0 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {[
              ['Total', summary.total, 'text-white'],
              ['Exact', summary.exact, 'text-emerald-400'],
              ['Fuzzy', summary.fuzzy, 'text-amber-400'],
              ['Mismatch', summary.mismatch, 'text-rose-400'],
              ['Missing', summary.missingActual + summary.missingExpected, 'text-rose-400'],
              ['Accuracy', `${summary.accuracy}%`, 'text-accent-sky'],
            ].map(([label, val, color]) => (
              <div key={String(label)} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                <div className="text-[10px] uppercase tracking-wider text-text-secondary">{label}</div>
                <div className={`text-xl font-semibold tabular-nums mt-0.5 ${color}`}>{val}</div>
              </div>
            ))}
          </div>

          <div className="glass-panel rounded-lg p-4 flex-1 min-h-0 flex flex-col">
            <div className="flex flex-wrap items-center gap-2 mb-3 shrink-0">
              <Filter className="w-3.5 h-3.5 text-text-secondary" />
              {(
                [
                  ['all', 'All'],
                  ['problems', 'Problems only'],
                  ['EXACT_MATCH', 'Exact'],
                  ['FUZZY_MATCH', 'Fuzzy'],
                  ['MISMATCH', 'Mismatch'],
                  ['MISSING_ACTUAL', 'Missing actual'],
                  ['MISSING_EXPECTED', 'Missing expected'],
                ] as [StatusFilter, string][]
              ).map(([f, label]) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setStatusFilter(f)}
                  className={`text-[10px] px-2 py-1 rounded border ${
                    statusFilter === f
                      ? 'border-accent-sky/40 bg-accent-sky/15 text-accent-sky'
                      : 'border-white/10 text-text-secondary'
                  }`}
                >
                  {label}
                </button>
              ))}
              <div className="ml-auto flex items-center gap-1">
                <Search className="w-3.5 h-3.5 text-text-secondary" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search id / product…"
                  className="bg-white/[0.03] border border-white/[0.08] rounded-md px-2 py-1 text-xs text-text-primary w-44 focus:outline-none focus:border-accent-sky"
                />
              </div>
            </div>
            <div className="overflow-auto flex-1 min-h-0 max-h-[48vh]">
              {renderResultsTable()}
            </div>
          </div>
        </>
      )}

      {/* Full-screen review */}
      <AnimatePresence>
        {fullscreen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[80] bg-black flex flex-col"
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10 shrink-0">
              <Scale className="w-5 h-5 text-accent-sky" />
              <div>
                <h2 className="text-sm font-semibold text-white">Discrepancy full-screen review</h2>
                <p className="text-[11px] text-text-secondary">
                  {filtered.length} of {results.length} rows · accuracy {summary.accuracy}%
                </p>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {(
                  [
                    ['all', 'All'],
                    ['problems', 'Problems'],
                    ['EXACT_MATCH', 'Exact'],
                    ['FUZZY_MATCH', 'Fuzzy'],
                    ['MISMATCH', 'Mismatch'],
                    ['MISSING_ACTUAL', 'Miss act'],
                    ['MISSING_EXPECTED', 'Miss exp'],
                  ] as [StatusFilter, string][]
                ).map(([f, label]) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setStatusFilter(f)}
                    className={`text-[10px] px-2 py-1 rounded border ${
                      statusFilter === f
                        ? 'border-accent-sky/40 bg-accent-sky/15 text-accent-sky'
                        : 'border-white/10 text-text-secondary'
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search…"
                  className="bg-white/[0.05] border border-white/10 rounded px-2 py-1 text-xs text-white w-36"
                />
                <Button size="sm" variant="outline" className="gap-1" onClick={exportReport}>
                  <FileDown className="w-3.5 h-3.5" /> Export
                </Button>
                <button
                  type="button"
                  onClick={() => setFullscreen(false)}
                  className="p-2 rounded-md hover:bg-white/10 text-text-secondary"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-3">
              {renderResultsTable()}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
