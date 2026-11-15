/** Automatic scan validation against expected posting lines */

export type ScanVerdict =
  | 'VALID'
  | 'DUPLICATE'
  | 'UNKNOWN_ORDER'
  | 'QTY_EXCEEDED'
  | 'PARTIAL'
  | 'INVALID_FORMAT';

export interface ExpectedLine {
  trackingId: string;
  product: string;
  qty: number;
}

export interface ScanEvent {
  raw: string;
  trackingId: string;
  at: string;
  verdict: ScanVerdict;
  remark: string;
  expectedProduct?: string;
  expectedQty?: number;
  scannedCount: number;
}

export interface ValidationSummary {
  expectedCount: number;
  uniqueScanned: number;
  valid: number;
  duplicates: number;
  unknown: number;
  missing: string[]; // tracking IDs expected but never scanned
  events: ScanEvent[];
}

const TRACKING_RE = /\b\d{6,15}-?\d{0,6}-?\d{0,4}\b/;

export function extractTrackingId(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const m = t.match(TRACKING_RE);
  if (m) return m[0];
  // bare numeric / alphanumeric codes ≥ 8
  const compact = t.replace(/\s+/g, '');
  if (/^[\dA-Za-z-]{8,32}$/.test(compact)) return compact;
  return null;
}

export function normalizeTracking(id: string): string {
  return id.replace(/\s/g, '').toLowerCase();
}

/**
 * Validate a single scan against expected lines and prior scan counts.
 * scannedCounts: map of normalized tracking → times scanned so far (before this scan)
 */
export function validateScan(
  raw: string,
  expected: ExpectedLine[],
  scannedCounts: Map<string, number>
): ScanEvent {
  const at = new Date().toISOString();
  const trackingId = extractTrackingId(raw);

  if (!trackingId) {
    return {
      raw,
      trackingId: raw.trim().slice(0, 40) || '(empty)',
      at,
      verdict: 'INVALID_FORMAT',
      remark: 'Could not parse tracking / barcode value',
      scannedCount: 0,
    };
  }

  const key = normalizeTracking(trackingId);
  const exp =
    expected.find((e) => normalizeTracking(e.trackingId) === key) ||
    expected.find((e) => normalizeTracking(e.trackingId).includes(key) || key.includes(normalizeTracking(e.trackingId)));

  const prev = scannedCounts.get(key) || 0;
  const next = prev + 1;

  if (!exp) {
    return {
      raw,
      trackingId,
      at,
      verdict: 'UNKNOWN_ORDER',
      remark: 'Tracking not found in posting / expected list — possible wrong wave or mis-scan',
      scannedCount: next,
    };
  }

  if (next > exp.qty) {
    return {
      raw,
      trackingId: exp.trackingId,
      at,
      verdict: 'QTY_EXCEEDED',
      remark: `Scanned ${next}× but expected qty is ${exp.qty}`,
      expectedProduct: exp.product,
      expectedQty: exp.qty,
      scannedCount: next,
    };
  }

  if (prev >= 1 && exp.qty === 1) {
    return {
      raw,
      trackingId: exp.trackingId,
      at,
      verdict: 'DUPLICATE',
      remark: 'Already scanned for this unit (expected qty 1)',
      expectedProduct: exp.product,
      expectedQty: exp.qty,
      scannedCount: next,
    };
  }

  if (next < exp.qty) {
    return {
      raw,
      trackingId: exp.trackingId,
      at,
      verdict: 'PARTIAL',
      remark: `Partial: ${next} of ${exp.qty} scanned`,
      expectedProduct: exp.product,
      expectedQty: exp.qty,
      scannedCount: next,
    };
  }

  return {
    raw,
    trackingId: exp.trackingId,
    at,
    verdict: 'VALID',
    remark: exp.product ? `OK — ${exp.product}` : 'OK — matches expected',
    expectedProduct: exp.product,
    expectedQty: exp.qty,
    scannedCount: next,
  };
}

export function buildSummary(
  expected: ExpectedLine[],
  events: ScanEvent[]
): ValidationSummary {
  const counts = new Map<string, number>();
  let valid = 0;
  let duplicates = 0;
  let unknown = 0;

  for (const ev of events) {
    const key = normalizeTracking(ev.trackingId);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (ev.verdict === 'VALID' || ev.verdict === 'PARTIAL') valid++;
    if (ev.verdict === 'DUPLICATE' || ev.verdict === 'QTY_EXCEEDED') duplicates++;
    if (ev.verdict === 'UNKNOWN_ORDER' || ev.verdict === 'INVALID_FORMAT') unknown++;
  }

  const missing: string[] = [];
  for (const e of expected) {
    const key = normalizeTracking(e.trackingId);
    const n = counts.get(key) || 0;
    if (n < e.qty) missing.push(e.trackingId);
  }

  return {
    expectedCount: expected.length,
    uniqueScanned: counts.size,
    valid,
    duplicates,
    unknown,
    missing,
    events,
  };
}
