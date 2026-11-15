import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';

import {
  MAX_UPLOAD_BYTES,
  SpreadsheetError,
  describeSpreadsheetError,
  readWorkbookFile,
  sheetToKeyedRows,
  type ParsedSheet,
} from '@/lib/spreadsheet';

/** Builds a real .xlsx in memory so the guard tests exercise the actual parser. */
function workbookFile(
  sheets: Array<{ name: string; rows: unknown[][] }>,
  fileName = 'upload.xlsx',
): File {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  }
  const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([buffer], fileName, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

function sheet(rows: unknown[][]): ParsedSheet {
  return { name: 'Sheet1', rows: rows as never };
}

describe('spreadsheet ingestion boundary: pre-parse guards', () => {
  it('rejects an unsupported extension before the parser is invoked', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'payload.exe', { type: 'application/octet-stream' });
    await expect(readWorkbookFile(file)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
  });

  it('rejects an oversized file with an actionable message', async () => {
    const big = new File([new Uint8Array(1024)], 'huge.xlsx');
    Object.defineProperty(big, 'size', { value: MAX_UPLOAD_BYTES + 1 });
    const err = await readWorkbookFile(big).catch((e) => e);
    expect(err).toBeInstanceOf(SpreadsheetError);
    expect(err.code).toBe('FILE_TOO_LARGE');
    expect(err.message).toMatch(/limit is 12 MB/);
  });

  it('reports a corrupt file as PARSE_FAILED rather than throwing raw parser output', async () => {
    const corrupt = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], 'broken.xlsx');
    const err = await readWorkbookFile(corrupt).catch((e) => e);
    expect(err).toBeInstanceOf(SpreadsheetError);
    expect(err.code).toBe('PARSE_FAILED');
  });

  it('reads a valid workbook and coerces every cell to a primitive', async () => {
    const file = workbookFile([
      { name: 'GRN', rows: [['SKU', 'QTY'], ['A17Black256', 12], ['WATCH-7', '']], },
    ]);
    const wb = await readWorkbookFile(file);
    expect(wb.sheetNames).toEqual(['GRN']);
    expect(wb.bytes).toBeGreaterThan(0);
    // Blank cells come back as the parser's `defval` (''), numbers stay numbers,
    // and no cell is ever an object.
    expect(wb.sheets[0].rows).toEqual([
      ['SKU', 'QTY'],
      ['A17Black256', 12],
      ['WATCH-7', ''],
    ]);
    expect(wb.sheets[0].rows.flat().every((c) => c === null || ['string', 'number', 'boolean'].includes(typeof c))).toBe(true);
  });

  it('keeps multi-sheet workbooks in order and drops nothing', async () => {
    const file = workbookFile([
      { name: 'Expected', rows: [['a']] },
      { name: 'Actual', rows: [['b']] },
    ]);
    const wb = await readWorkbookFile(file);
    expect(wb.sheets.map((s) => s.name)).toEqual(['Expected', 'Actual']);
  });

  it('describeSpreadsheetError keeps the typed message and tames anything else', () => {
    expect(describeSpreadsheetError(new SpreadsheetError('EMPTY_WORKBOOK', 'no worksheets'))).toBe('no worksheets');
    expect(describeSpreadsheetError(new Error('boom'))).toBe('boom');
    expect(describeSpreadsheetError('boom')).toBe('Spreadsheet could not be read');
  });
});

describe('sheetToKeyedRows: prototype pollution and header hygiene', () => {
  it('drops __proto__, constructor and prototype header keys', () => {
    const { headers, rows, droppedHeaders } = sheetToKeyedRows(
      sheet([
        ['SKU', '__proto__', 'constructor', 'prototype', 'QTY'],
        ['A17', 'polluted', 'evil', 'evil', 5],
      ]),
    );

    expect(headers).toEqual(['SKU', 'QTY']);
    expect(droppedHeaders).toEqual(['__proto__', 'constructor', 'prototype']);
    expect(rows[0]).toEqual({ SKU: 'A17', QTY: 5 });
    // The real guarantee: nothing leaked onto Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('builds rows with a null prototype so inherited keys can never be read back', () => {
    const { rows } = sheetToKeyedRows(sheet([['SKU'], ['A17']]));
    expect(Object.getPrototypeOf(rows[0])).toBeNull();
    expect(rows[0].toString).toBeUndefined();
    expect(rows[0].hasOwnProperty).toBeUndefined();
  });

  it('collapses duplicate headers, first column wins', () => {
    const { headers, rows, droppedHeaders } = sheetToKeyedRows(
      sheet([
        ['QTY', 'SKU', 'QTY'],
        [3, 'A17', 99],
      ]),
    );
    expect(headers).toEqual(['QTY', 'SKU']);
    expect(droppedHeaders).toEqual(['QTY (duplicate)']);
    expect(rows[0].QTY).toBe(3);
  });

  it('skips fully empty rows and normalises blanks to null', () => {
    const { rows } = sheetToKeyedRows(
      sheet([
        ['SKU', 'QTY'],
        ['A17', 4],
        ['', ''],
        ['WATCH-7', ''],
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ SKU: 'WATCH-7', QTY: null });
  });

  it('coerces exotic cell values to primitives instead of passing objects through', () => {
    const { rows } = sheetToKeyedRows(
      sheet([
        ['SKU', 'OBJ', 'NAN', 'BOOL'],
        ['A17', { nested: true }, Number.NaN, true],
      ]),
    );
    expect(typeof rows[0].OBJ).toBe('string');
    expect(rows[0].NAN).toBeNull();
    expect(rows[0].BOOL).toBe(true);
  });

  it('honours a custom header row and a row cap', () => {
    const grid: unknown[][] = [
      ['Ozon posting sheet'],
      ['SKU', 'QTY'],
      ['A17', 1],
      ['A18', 2],
      ['A19', 3],
    ];
    const { headers, rows } = sheetToKeyedRows(sheet(grid), { headerRow: 1, maxRows: 2 });
    expect(headers).toEqual(['SKU', 'QTY']);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.SKU)).toEqual(['A17', 'A18']);
  });

  it('returns no rows for an empty sheet instead of throwing', () => {
    const { headers, rows } = sheetToKeyedRows(sheet([]));
    expect(headers).toEqual([]);
    expect(rows).toEqual([]);
  });
});
