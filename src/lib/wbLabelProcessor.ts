/**
 * WB (Wildberries) Label Processor — browser entry point.
 *
 * Re-exports the pure, dependency-free matching engine from `wbLabelMatcher`
 * and adds the browser-side PDF processing that replaces the Python
 * pdf2image + cv2 + pytesseract OCR + pyzbar pipeline.
 *
 * Browser approach (no native OCR available):
 *   • pdfjs-dist text extraction as the primary text source (works for labels
 *     that embed selectable text — the common case for WB/Ozon labels).
 *   • Optional per-page canvas render + native `BarcodeDetector` decode for
 *     barcodes/QR when the browser supports it (graceful feature detection).
 *   • No claim of full OCR parity; image-only labels with no embedded text and
 *     no detectable barcode are flagged to the caller.
 *
 * Ported from: wb_label_processor.py (v4.1)
 */

import * as pdfjsLib from 'pdfjs-dist';
import {
  extractTracking,
  extractOrderId,
  extractPhone,
  extractCode,
  extractAddress,
  parseQrPayload,
  scoreWbIndicators,
  WB_TRACKING_RE_G,
  type WBLabelData,
} from './wbLabelMatcher';

// Re-export the entire pure engine so consumers can import from this module.
export * from './wbLabelMatcher';

type PdfDocument = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>;

/** Feature-detect the native BarcodeDetector API (Chrome/Edge). */
function getBarcodeDetector(): ((source: CanvasImageSource) => Promise<{ rawValue: string; format: string }[]>) | null {
  const Ctor = typeof window !== 'undefined' ? (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector : undefined;
  if (typeof Ctor !== 'function') return null;
  try {
    const CtorFn = Ctor as {
      getSupportedFormats?: () => Promise<string[]>;
      new (opts?: unknown): { detect: (s: CanvasImageSource) => Promise<{ rawValue: string; format: string }[]> };
    };
    if (typeof CtorFn.getSupportedFormats === 'function') {
      const detector = new CtorFn({
        formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'codabar', 'itf'],
      });
      return (source) => detector.detect(source);
    }
  } catch {
    return null;
  }
  return null;
}

/** Render a PDF page to a canvas (used for barcode detection). */
async function renderPageToCanvas(page: {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
}): Promise<HTMLCanvasElement | null> {
  try {
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    await (page as unknown as {
      render: (opts: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => {
        promise: Promise<void>;
      };
    }).render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  } catch {
    return null;
  }
}

export interface ProcessPdfOptions {
  /** Attempt barcode/QR decode via native BarcodeDetector when available. */
  detectBarcodes?: boolean;
  /** Called with progress (done, total) per page. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Process all pages of a PDF and extract WB-relevant data.
 * Browser equivalent of WBLabelProcessor.process_pdf.
 */
export async function processPdf(
  _pdfBytes: ArrayBuffer,
  pdfDoc: PdfDocument,
  options: ProcessPdfOptions = {},
): Promise<WBLabelData[]> {
  const { detectBarcodes = true, onProgress } = options;
  const detector = detectBarcodes ? getBarcodeDetector() : null;
  const numPages = pdfDoc.numPages;
  const results: WBLabelData[] = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items.map((item) => ('str' in item ? (item as { str: string }).str : '')).join(' ');

    const data: WBLabelData = {
      pageIdx: i - 1,
      trackingNumber: null,
      wbOrderId: null,
      phoneNumber: null,
      deliveryCode: null,
      address: null,
      qrPayloads: [],
      barcodes: [],
      rawText: text,
      verticalText: '',
      rotationDetected: 0,
    };

    // Field extraction — order mirrors the Python pipeline.
    data.trackingNumber = extractTracking(text);
    data.wbOrderId = extractOrderId(text);
    data.phoneNumber = extractPhone(text);
    data.deliveryCode = extractCode(text);
    data.address = extractAddress(text);

    // Barcode/QR decode via native API (best-effort).
    if (detector) {
      const canvas = await renderPageToCanvas(page);
      if (canvas) {
        try {
          const codes = await detector(canvas);
          for (const bc of codes) {
            const value = bc.rawValue;
            data.barcodes.push(value);
            const wb = value.match(WB_TRACKING_RE_G);
            if (wb && wb.length > 0 && !data.trackingNumber) data.trackingNumber = wb[0].toUpperCase();
            WB_TRACKING_RE_G.lastIndex = 0;
            if (bc.format === 'qr_code') {
              data.qrPayloads.push(value);
              const parsed = parseQrPayload(value);
              if (parsed.tracking && !data.trackingNumber) data.trackingNumber = parsed.tracking;
              if (parsed.phone && !data.phoneNumber) data.phoneNumber = parsed.phone;
              if (parsed.code && !data.deliveryCode) data.deliveryCode = parsed.code;
              if (parsed.order_id && !data.wbOrderId) data.wbOrderId = parsed.order_id;
            }
          }
        } catch {
          // detection can fail on some pages; ignore
        }
      }
    }

    // Rotation scoring (logical, not true rotated OCR).
    data.rotationDetected = scoreWbIndicators(text) > 0 ? 0 : 0;

    results.push(data);
    onProgress?.(i, numPages);
  }

  return results;
}

/**
 * Convenience: load a PDF via pdfjs and return both the document handle and the
 * processed label data. The caller is responsible for configuring the pdfjs
 * worker before invoking this.
 */
export async function loadAndProcessPdf(
  arrayBuffer: ArrayBuffer,
  options?: ProcessPdfOptions,
): Promise<{ doc: PdfDocument; data: WBLabelData[] }> {
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const data = await processPdf(arrayBuffer.slice(0), doc, options);
  return { doc, data };
}
