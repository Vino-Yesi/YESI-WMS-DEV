/**
 * Hardened spreadsheet ingestion boundary.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every spreadsheet the WMS accepts is *untrusted input*: it comes from a
 * customer portal, a supplier, or a floor operator's laptop. The parser in use
 * (`xlsx` 0.18.5, the last release published to npm) carries two public
 * advisories:
 *
 *   - Prototype Pollution (CVE-2023-30533) - a crafted sheet can make the
 *     parser write `__proto__` / `constructor` keys into the objects it hands
 *     back, poisoning `Object.prototype` for the whole tab.
 *   - ReDoS (CVE-2024-22363) - a crafted file can burn CPU inside the parser's
 *     regular expressions.
 *
 * The vendor publishes patched builds only from `https://cdn.sheetjs.com`,
 * which is outside this project's allowed registries, so the dependency itself
 * cannot be upgraded from here yet (tracked in
 * docs/ARCHITECTURE-AND-OPERATIONS.md -> "Accepted dependency risk"). What we
 * CAN control is the blast radius, and this module is the single choke point
 * that does it:
 *
 *   1. A hard byte cap is enforced *before* the parser ever sees the file.
 *   2. Parsing is wrapped so a thrown or degenerate parse becomes a typed error
 *      instead of a half-built workbook.
 *   3. Nothing the parser returns is trusted: prototype-pollution keys are
 *      dropped, cell values are coerced to primitives, and header names are
 *      normalised before they are ever used as object keys.
 *
 * Do NOT call `XLSX.read` / `sheet_to_json` directly from a page - go through
 * `readWorkbookFile` (+ `sheetToKeyedRows`) so every upload gets the same
 * guards.
 */
import * as XLSX from 'xlsx';

/** Reject anything larger than this before parsing (12 MB). */
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/** Extensions we are willing to hand to the parser at all. */
const ACCEPTED_EXTENSIONS = ['.xlsx', '.xlsm', '.xls', '.xlsb', '.csv', '.txt'];

/** Keys that must never become properties on an object we build. */
const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type SpreadsheetErrorCode =
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'EMPTY_WORKBOOK'
  | 'PARSE_FAILED';

export class SpreadsheetError extends Error {
  readonly code: SpreadsheetErrorCode;

  constructor(code: SpreadsheetErrorCode, message: string) {
    super(message);
    this.name = 'SpreadsheetError';
    this.code = code;
  }
}

export type CellValue = string | number | boolean | Date | null;

export interface ParsedSheet {
  name: string;
  /** Raw grid, row-major. Cells are primitives only - see `coerceCell`. */
  rows: CellValue[][];
}

export interface ParsedWorkbook {
  fileName: string;
  sheetNames: string[];
  sheets: ParsedSheet[];
  /** Byte size actually parsed, for audit trails. */
  bytes: number;
}

function coerceCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  switch (typeof value) {
    case 'string':
      return (value as string).slice(0, 4096);
    case 'number':
      return Number.isFinite(value as number) ? (value as number) : null;
    case 'boolean':
      return value as boolean;
    default:
      // Objects/arrays are never legitimate cell content; stringify defensively
      // rather than letting a nested structure reach business logic.
      return String(value).slice(0, 4096);
  }
}

function coerceGrid(raw: unknown): CellValue[][] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => (Array.isArray(row) ? row.map(coerceCell) : []));
}

/**
 * Reads an operator-supplied workbook with the size/type guards applied.
 *
 * Throws `SpreadsheetError` with a stable `code` so callers can show an
 * actionable message instead of a parser stack trace.
 */
export async function readWorkbookFile(
  file: File,
  opts: { maxBytes?: number; cellDates?: boolean } = {},
): Promise<ParsedWorkbook> {
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  const name = file.name || 'upload';
  const dotIndex = name.lastIndexOf('.');
  const ext = dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : '';

  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    throw new SpreadsheetError(
      'UNSUPPORTED_FILE_TYPE',
      `"${ext || name}" is not a supported spreadsheet type (accepted: ${ACCEPTED_EXTENSIONS.join(', ')})`,
    );
  }
  if (file.size > maxBytes) {
    throw new SpreadsheetError(
      'FILE_TOO_LARGE',
      `${name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${(maxBytes / 1024 / 1024).toFixed(0)} MB. Split the file and re-upload.`,
    );
  }

  let buf: ArrayBuffer;
  try {
    buf = await file.arrayBuffer();
  } catch (err) {
    throw new SpreadsheetError(
      'PARSE_FAILED',
      `Could not read ${name}: ${err instanceof Error ? err.message : 'unknown read error'}`,
    );
  }

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: 'array', cellDates: opts.cellDates ?? false });
  } catch (err) {
    throw new SpreadsheetError(
      'PARSE_FAILED',
      `${name} is not a readable spreadsheet: ${err instanceof Error ? err.message : 'parser error'}`,
    );
  }

  const sheetNames = Array.isArray(wb.SheetNames) ? wb.SheetNames.filter((n): n is string => typeof n === 'string') : [];
  if (sheetNames.length === 0) {
    throw new SpreadsheetError('EMPTY_WORKBOOK', `${name} contains no worksheets`);
  }

  const sheets: ParsedSheet[] = sheetNames.map((sheetName) => {
    const sheet = wb.Sheets[sheetName];
    const raw = sheet
      ? (XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false }) as unknown)
      : [];
    return { name: sheetName, rows: coerceGrid(raw) };
  });

  return { fileName: name, sheetNames, sheets, bytes: buf.byteLength };
}

/** True when a header cell would create an unsafe object key. */
function isUnsafeKey(key: string): boolean {
  return key === '' || POLLUTION_KEYS.has(key) || key.includes('__proto__');
}

/**
 * Turns a sheet into `{ headers, rows }` where each row is a plain object.
 *
 * Header cells become keys only after normalisation, and any key that could
 * pollute a prototype is dropped outright - that is the CVE-2023-30533 vector.
 * Rows that are entirely empty are skipped.
 */
export function sheetToKeyedRows(
  sheet: ParsedSheet,
  opts: { headerRow?: number; maxRows?: number } = {},
): { headers: string[]; rows: Array<Record<string, CellValue>>; droppedHeaders: string[] } {
  const headerRowIndex = opts.headerRow ?? 0;
  const headerCells = sheet.rows[headerRowIndex] ?? [];
  const headers: string[] = [];
  const safeIndexes: number[] = [];
  const droppedHeaders: string[] = [];

  headerCells.forEach((cell, index) => {
    const key = String(cell ?? '').trim().slice(0, 128);
    if (isUnsafeKey(key)) {
      if (key) droppedHeaders.push(key);
      return;
    }
    // Duplicate header names are collapsed: the first occurrence wins so a
    // second `qty` column can never overwrite the first silently.
    if (headers.includes(key)) {
      droppedHeaders.push(`${key} (duplicate)`);
      return;
    }
    headers.push(key);
    safeIndexes.push(index);
  });

  const body = sheet.rows.slice(headerRowIndex + 1);
  const capped = typeof opts.maxRows === 'number' ? body.slice(0, opts.maxRows) : body;

  const rows = capped
    .map((row) => {
      const record: Record<string, CellValue> = Object.create(null) as Record<string, CellValue>;
      safeIndexes.forEach((sourceIndex, i) => {
        const value = row?.[sourceIndex];
        record[headers[i]] = value === undefined || value === '' ? null : coerceCell(value);
      });
      return record;
    })
    .filter((record) => Object.values(record).some((v) => v !== null));

  return { headers, rows, droppedHeaders };
}

/** Human-readable message for a typed spreadsheet failure. */
export function describeSpreadsheetError(err: unknown): string {
  if (err instanceof SpreadsheetError) return err.message;
  return err instanceof Error ? err.message : 'Spreadsheet could not be read';
}
