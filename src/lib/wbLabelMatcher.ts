/**
 * WB Label Matcher — pure, dependency-free matching engine.
 *
 * This module contains the platform-agnostic logic ported from
 * wb_label_processor.py (v4.1): types, regex extractors, QR-payload parsing,
 * rotation/indicator scoring, target-list parsing, and multi-criteria matching
 * with confidence scores. It has no runtime or PDF dependencies so it can be
 * unit-tested in isolation and consumed by the browser `wbLabelProcessor.ts`
 * (which adds the pdfjs-based `processPdf`).
 */

export interface WBLabelData {
  pageIdx: number;
  trackingNumber: string | null;
  wbOrderId: string | null;
  phoneNumber: string | null;
  deliveryCode: string | null;
  address: string | null;
  qrPayloads: string[];
  barcodes: string[];
  rawText: string;
  verticalText: string;
  rotationDetected: number; // degrees
}

export type WBMatchType =
  | 'exact'
  | 'tracking'
  | 'phone_code'
  | 'phone_only'
  | 'order_id'
  | 'qr_data'
  | 'qr_phone'
  | 'fuzzy'
  | 'none';

export interface WBLabelMatch {
  pageIdx: number;
  targetIdx: number;
  targetRaw: string;
  matchType: WBMatchType;
  confidence: number; // 0.0 - 1.0
  matchedFields: Record<string, string>;
  debugInfo: Partial<WBLabelData>;
}

export interface WBTarget {
  raw: string;
  tracking?: string;
  phone?: string;
  code?: string;
  orderId?: string;
}

// Regex constants — identical to the Python module.
const WB_TRACKING_RE = /WB[A-Z0-9]{10,20}/i;
const WB_TRACKING_RE_G = /WB[A-Z0-9]{10,20}/gi;
const WB_ORDER_RE = /\b\d{9,15}\b/g;
const PHONE_RE = /\b\d{7}\b/g;
const CODE_RE = /\b\d{4}\b/g;
const VERTICAL_WB_RE = /W\s*B|WB/i;

export function extractTracking(text: string): string | null {
  const m = text.match(WB_TRACKING_RE);
  return m ? m[0].toUpperCase() : null;
}

export function extractOrderId(text: string): string | null {
  const candidates = text.match(WB_ORDER_RE) || [];
  if (candidates.length === 0) return null;
  const first = candidates[0];
  if (!first) return null;
  // WB order IDs are usually 9-15 digits; prefer longer ones (matches Python).
  return candidates.reduce<string>((best, c) => (c.length > best.length ? c : best), first);
}

export function extractPhone(text: string): string | null {
  const matches = text.match(PHONE_RE);
  return matches && matches.length > 0 ? matches[0] : null;
}

export function extractCode(text: string): string | null {
  const matches = text.match(CODE_RE);
  // The delivery code is typically the last 4-digit match on the page.
  return matches && matches.length > 0 ? matches[matches.length - 1] : null;
}

const ADDRESS_KEYWORDS = ['улица', 'ул.', 'г.', 'город', 'проспект', 'переулок'];

export function extractAddress(text: string): string | null {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const lower = line.toLowerCase();
    if (ADDRESS_KEYWORDS.some((kw) => lower.includes(kw))) return line;
  }
  return null;
}

/**
 * Parse structured data from QR code payloads.
 * WB QR codes often contain JSON or pipe-delimited data.
 * Ported from WBLabelProcessor._parse_qr_payload.
 */
export function parseQrPayload(payload: string): Record<string, string> {
  const result: Record<string, string> = {};

  // Try JSON
  try {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    const getStr = (keys: string[]): string => {
      for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string' || typeof v === 'number') return String(v);
      }
      return '';
    };
    const tracking = getStr(['tracking', 'track']);
    const phoneRaw = getStr(['phone']);
    const code = getStr(['code', 'pin']);
    const orderId = getStr(['order_id', 'orderId']);
    if (tracking) result.tracking = tracking;
    if (phoneRaw) result.phone = phoneRaw.slice(-7);
    if (code) result.code = code;
    if (orderId) result.order_id = orderId;
  } catch {
    // not JSON — fall through
  }

  // Try pipe-delimited: tracking|phone|code
  if (payload.includes('|')) {
    const parts = payload.split('|');
    if (parts.length >= 3) {
      if (!result.tracking) result.tracking = parts[0];
      if (!result.phone) result.phone = parts[1].length >= 7 ? parts[1].slice(-7) : parts[1];
      if (!result.code) result.code = parts[2];
    }
  }

  // Fallback: regex extraction from raw payload
  if (!result.tracking) {
    const m = payload.match(WB_TRACKING_RE);
    if (m) result.tracking = m[0].toUpperCase();
  }

  return result;
}

/**
 * Score text against WB label indicators. Ported from _find_best_rotation; in
 * the browser we have no true rotated OCR, so this scores extracted text +
 * decoded payloads so the value stays meaningful.
 */
export function scoreWbIndicators(text: string): number {
  let score = 0;
  if (WB_TRACKING_RE.test(text)) score += 3;
  if (PHONE_RE.test(text)) score += 2;
  if (CODE_RE.test(text)) score += 2;
  if (VERTICAL_WB_RE.test(text)) score += 1;
  if (/wildberries/i.test(text) || /\bwb\b/i.test(text)) score += 1;
  // reset lastIndex for stateful global regexes so reuse is safe
  WB_TRACKING_RE.lastIndex = 0;
  return score;
}

/**
 * Parse a pasted target list into structured entries.
 * Supports WB tracking numbers, phone+code pairs, order IDs, and mixed lines.
 * Ported from parse_target_list.
 */
export function parseTargetList(text: string): WBTarget[] {
  const entries: WBTarget[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const entry: WBTarget = { raw: line };
    const digits = line.match(/\d+/g) || [];

    const wbMatch = line.match(WB_TRACKING_RE);
    if (wbMatch) entry.tracking = wbMatch[0].toUpperCase();

    const phone = digits.find((d) => d.length === 7);
    const code = digits.find((d) => d.length === 4);
    if (phone) entry.phone = phone;
    if (code) entry.code = code;

    const longDigits = digits.filter((d) => d.length >= 9 && d.length <= 15);
    if (longDigits.length > 0 && !entry.tracking) entry.orderId = longDigits[0];

    entries.push(entry);
  }
  return entries;
}

function ldToDebug(ld: WBLabelData): Partial<WBLabelData> {
  return {
    pageIdx: ld.pageIdx,
    trackingNumber: ld.trackingNumber,
    wbOrderId: ld.wbOrderId,
    phoneNumber: ld.phoneNumber,
    deliveryCode: ld.deliveryCode,
    qrPayloads: ld.qrPayloads,
    barcodes: ld.barcodes,
    rotationDetected: ld.rotationDetected,
  };
}

/**
 * Match target entries against extracted label data using multiple criteria
 * with confidence scores. Ported from WBLabelProcessor.match_targets.
 * Preserves the greedy "one target -> one unused page" behaviour.
 */
export function matchTargets(targets: WBTarget[], labelData: WBLabelData[]): WBLabelMatch[] {
  const matches: WBLabelMatch[] = [];
  const usedPages = new Set<number>();

  for (let tIdx = 0; tIdx < targets.length; tIdx++) {
    const target = targets[tIdx];
    let bestMatch: WBLabelMatch | null = null;
    let bestConfidence = 0;

    const targetTracking = target.tracking || '';
    const targetPhone = target.phone || '';
    const targetCode = target.code || '';
    const targetOrder = target.orderId || '';
    const targetRaw = target.raw;

    for (const ld of labelData) {
      if (usedPages.has(ld.pageIdx)) continue;

      let confidence = 0;
      const matchedFields: Record<string, string> = {};
      let matchType: WBMatchType = 'none';

      // Criteria 1: exact tracking number (highest confidence)
      if (targetTracking && ld.trackingNumber) {
        if (targetTracking.toUpperCase() === ld.trackingNumber.toUpperCase()) {
          confidence = 1.0;
          matchType = 'exact';
          matchedFields.tracking = ld.trackingNumber;
        }
      }

      // Criteria 2: phone + code pair
      if (confidence < 0.9 && targetPhone && targetCode) {
        const phoneMatch = ld.phoneNumber
          ? targetPhone === ld.phoneNumber || ld.phoneNumber.includes(targetPhone)
          : false;
        const codeMatch = ld.deliveryCode
          ? targetCode === ld.deliveryCode || ld.deliveryCode.includes(targetCode)
          : false;
        if (phoneMatch && codeMatch) {
          confidence = 0.95;
          matchType = 'phone_code';
          matchedFields.phone = ld.phoneNumber || '';
          matchedFields.code = ld.deliveryCode || '';
        } else if (phoneMatch) {
          if (confidence < 0.6) confidence = 0.6;
          matchType = 'phone_only';
          matchedFields.phone = ld.phoneNumber || '';
        }
      }

      // Criteria 3: order ID match
      if (confidence < 0.9 && targetOrder && ld.wbOrderId) {
        if (targetOrder === ld.wbOrderId) {
          confidence = 0.9;
          matchType = 'order_id';
          matchedFields.order_id = ld.wbOrderId;
        }
      }

      // Criteria 4: QR payload contains target data
      if (confidence < 0.8) {
        for (const payload of ld.qrPayloads) {
          if (targetTracking && payload.includes(targetTracking)) {
            confidence = 0.85;
            matchType = 'qr_data';
            matchedFields.qr_tracking = targetTracking;
            break;
          }
          if (targetPhone && payload.includes(targetPhone)) {
            if (confidence < 0.7) confidence = 0.7;
            matchType = 'qr_phone';
            matchedFields.qr_phone = targetPhone;
            break;
          }
        }
      }

      // Criteria 5: fuzzy raw-text digit overlap
      if (confidence < 0.5 && targetRaw) {
        const targetDigits = new Set(targetRaw.match(/\d+/g) || []);
        const labelDigits = new Set((ld.rawText + ' ' + ld.verticalText).match(/\d+/g) || []);
        if (targetDigits.size > 0 && labelDigits.size > 0) {
          let overlap = 0;
          targetDigits.forEach((d) => {
            if (labelDigits.has(d)) overlap += 1;
          });
          const ratio = overlap / targetDigits.size;
          if (ratio > 0.5) {
            confidence = ratio * 0.5;
            matchType = 'fuzzy';
          }
        }
      }

      if (confidence > bestConfidence && confidence >= 0.5) {
        bestConfidence = confidence;
        bestMatch = {
          pageIdx: ld.pageIdx,
          targetIdx: tIdx,
          targetRaw,
          matchType,
          confidence,
          matchedFields,
          debugInfo: ldToDebug(ld),
        };
      }
    }

    if (bestMatch) {
      usedPages.add(bestMatch.pageIdx);
      matches.push(bestMatch);
    }
  }

  return matches;
}

export { WB_TRACKING_RE, WB_TRACKING_RE_G };
