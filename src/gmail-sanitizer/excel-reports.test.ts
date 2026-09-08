import fs from 'fs';
import os from 'os';
import path from 'path';

import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AnonymizationStore, deanonymizeText } from './anonymize.js';
import {
  applyEditsToBytes,
  loadReportTemplates,
  readRawWorkbook,
  readReportFromBytes,
  ReportTooLargeError,
  RowVerificationError,
  UnrecognizedReportError,
  type ReportTemplate,
} from './excel-reports.js';

let store: AnonymizationStore;
let dir: string;
let templatesPath: string;

const SINGLE_SHEET_TEMPLATE: ReportTemplate = {
  id: 'acme-monthly',
  sheets: [
    {
      sheetName: 'Detail',
      headerRow: 1,
      expectedHeaders: ['Date', 'Payee Name', 'Account Number', 'Amount', 'Status'],
      sensitiveColumns: ['Payee Name', 'Account Number'],
      keyColumn: 'Date',
    },
  ],
};

const MULTI_SHEET_TEMPLATE: ReportTemplate = {
  id: 'acme-multi',
  sheets: [
    { sheetName: 'Summary', headerRow: 1, expectedHeaders: ['Month', 'Total'], sensitiveColumns: [] },
    {
      sheetName: 'Detail',
      headerRow: 1,
      expectedHeaders: ['Date', 'Payee Name', 'Amount'],
      sensitiveColumns: ['Payee Name'],
      keyColumn: 'Date',
    },
  ],
};

beforeEach(() => {
  store = new AnonymizationStore();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-reports-test-'));
  templatesPath = path.join(dir, 'gmail-excel-reports.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeTemplates(templates: ReportTemplate[]): void {
  fs.writeFileSync(templatesPath, JSON.stringify({ reports: templates }));
}

async function buildSingleSheetWorkbook(rows: [string, string, string, number, string][] = []): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Detail');
  sheet.addRow(['Date', 'Payee Name', 'Account Number', 'Amount', 'Status']);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function buildMultiSheetWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const summary = wb.addWorksheet('Summary');
  summary.addRow(['Month', 'Total']);
  summary.addRow(['August', 2300]);
  const detail = wb.addWorksheet('Detail');
  detail.addRow(['Date', 'Payee Name', 'Amount']);
  detail.addRow(['2026-08-01', 'Alice Cohen', 100]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('loadReportTemplates', () => {
  it('reads templates from a real file on disk', () => {
    writeTemplates([SINGLE_SHEET_TEMPLATE]);
    expect(loadReportTemplates(templatesPath)).toEqual([SINGLE_SHEET_TEMPLATE]);
  });

  it('returns an empty list when the file is missing', () => {
    expect(loadReportTemplates(path.join(dir, 'does-not-exist.json'))).toEqual([]);
  });

  it('returns an empty list when the file is corrupt, rather than throwing', () => {
    fs.writeFileSync(templatesPath, '{not valid json');
    expect(loadReportTemplates(templatesPath)).toEqual([]);
  });
});

describe('readReportFromBytes', () => {
  it('matches a template and tokenizes only the listed sensitive columns', async () => {
    writeTemplates([SINGLE_SHEET_TEMPLATE]);
    const bytes = await buildSingleSheetWorkbook([['2026-08-01', 'Alice Cohen', '12-345-123456', 100, 'Pending']]);

    const result = await readReportFromBytes(bytes, store, templatesPath);

    expect(result.reportId).toBe('acme-monthly');
    expect(result.sheets).toHaveLength(1);
    const [sheet] = result.sheets;
    expect(sheet.rows).toHaveLength(1);
    const values = sheet.rows[0].values;
    expect(values.Date).toBe('2026-08-01');
    expect(values.Amount).toBe('100');
    expect(values.Status).toBe('Pending');
    expect(values['Payee Name']).toMatch(/^\[CELL_\d+\]$/);
    expect(values['Account Number']).toMatch(/^\[CELL_\d+\]$/);
    expect(deanonymizeText(values['Payee Name'], store)).toBe('Alice Cohen');
    expect(deanonymizeText(values['Account Number'], store)).toBe('12-345-123456');
  });

  it('rejects a file with a missing sheet, reporting what was found', async () => {
    writeTemplates([MULTI_SHEET_TEMPLATE]);
    const bytes = await buildSingleSheetWorkbook(); // only has a "Detail" sheet, no "Summary"

    await expect(readReportFromBytes(bytes, store, templatesPath)).rejects.toThrow(UnrecognizedReportError);
    try {
      await readReportFromBytes(bytes, store, templatesPath);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnrecognizedReportError);
      const unrecognized = err as UnrecognizedReportError;
      expect(unrecognized.sheetsFound).toEqual(['Detail']);
      expect(unrecognized.headersBySheet.Detail).toEqual(['Date', 'Payee Name', 'Account Number', 'Amount', 'Status']);
    }
  });

  it('rejects a file with an extra column in the header row', async () => {
    writeTemplates([SINGLE_SHEET_TEMPLATE]);
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Detail');
    sheet.addRow(['Date', 'Payee Name', 'Account Number', 'Amount', 'Status', 'Extra Column']);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());

    await expect(readReportFromBytes(bytes, store, templatesPath)).rejects.toThrow(UnrecognizedReportError);
  });

  it('rejects a file with reordered headers', async () => {
    writeTemplates([SINGLE_SHEET_TEMPLATE]);
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Detail');
    sheet.addRow(['Date', 'Account Number', 'Payee Name', 'Amount', 'Status']); // swapped
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());

    await expect(readReportFromBytes(bytes, store, templatesPath)).rejects.toThrow(UnrecognizedReportError);
  });

  it('reads a multi-sheet template across both sheets', async () => {
    writeTemplates([MULTI_SHEET_TEMPLATE]);
    const bytes = await buildMultiSheetWorkbook();

    const result = await readReportFromBytes(bytes, store, templatesPath);

    expect(result.sheets.map((s) => s.sheetName)).toEqual(['Summary', 'Detail']);
    expect(result.sheets[0].rows[0].values.Total).toBe('2300');
    expect(result.sheets[1].rows[0].values['Payee Name']).toMatch(/^\[CELL_\d+\]$/);
  });

  it('rejects a file larger than the size cap', async () => {
    writeTemplates([SINGLE_SHEET_TEMPLATE]);
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1);
    await expect(readReportFromBytes(oversized, store, templatesPath)).rejects.toThrow(ReportTooLargeError);
  });

  it('rejects a report with more than the row-count cap', async () => {
    writeTemplates([SINGLE_SHEET_TEMPLATE]);
    const rows: [string, string, string, number, string][] = [];
    for (let i = 0; i < 5001; i++) {
      rows.push([`2026-08-${(i % 28) + 1}`, 'Someone', '12-345-123456', i, 'Pending']);
    }
    const bytes = await buildSingleSheetWorkbook(rows);
    await expect(readReportFromBytes(bytes, store, templatesPath)).rejects.toThrow(ReportTooLargeError);
  });
});

describe('readRawWorkbook', () => {
  it('reads every sheet with no template and no anonymization', async () => {
    const bytes = await buildMultiSheetWorkbook(); // not registered under any template in this test's empty templatesPath

    const result = await readRawWorkbook(bytes);

    expect(result.anonymized).toBe(false);
    expect(result.sheets.map((s) => s.sheetName)).toEqual(['Summary', 'Detail']);
    expect(result.sheets[0].rows[0].values.Total).toBe('2300');
    expect(result.sheets[1].rows[0].values['Payee Name']).toBe('Alice Cohen'); // raw, not tokenized
  });

  it('rejects a file larger than the size cap', async () => {
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1);
    await expect(readRawWorkbook(oversized)).rejects.toThrow(ReportTooLargeError);
  });

  it('rejects a workbook with more than the row-count cap', async () => {
    const rows: [string, string, string, number, string][] = [];
    for (let i = 0; i < 5001; i++) {
      rows.push([`2026-08-${(i % 28) + 1}`, 'Someone', '12-345-123456', i, 'Pending']);
    }
    const bytes = await buildSingleSheetWorkbook(rows);
    await expect(readRawWorkbook(bytes)).rejects.toThrow(ReportTooLargeError);
  });
});

describe('applyEditsToBytes', () => {
  it('writes a plain value into a target cell and preserves an untouched cell and its formatting', async () => {
    writeTemplates([SINGLE_SHEET_TEMPLATE]);
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Detail');
    sheet.addRow(['Date', 'Payee Name', 'Account Number', 'Amount', 'Status']);
    const dataRow = sheet.addRow(['2026-08-01', 'Alice Cohen', '12-345-123456', 100, 'Pending']);
    dataRow.getCell(5).font = { bold: true };
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());

    const newBytes = await applyEditsToBytes(
      bytes,
      { cellEdits: [{ sheetName: 'Detail', row: 2, column: 'Status', value: 'Paid' }] },
      store,
      templatesPath,
    );

    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(newBytes as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    const sheet2 = wb2.getWorksheet('Detail')!;
    expect(sheet2.getRow(2).getCell(5).value).toBe('Paid');
    expect(sheet2.getRow(2).getCell(5).font?.bold).toBe(true); // formatting preserved
    expect(sheet2.getRow(2).getCell(2).value).toBe('Alice Cohen'); // untouched cell preserved
  });

  it('deanonymizes a token value before writing it back', async () => {
    writeTemplates([SINGLE_SHEET_TEMPLATE]);
    const bytes = await buildSingleSheetWorkbook([['2026-08-01', 'Alice Cohen', '12-345-123456', 100, 'Pending']]);
    const read = await readReportFromBytes(bytes, store, templatesPath);
    const accountToken = read.sheets[0].rows[0].values['Account Number'];

    const newBytes = await applyEditsToBytes(
      bytes,
      { cellEdits: [{ sheetName: 'Detail', row: 2, column: 'Account Number', value: accountToken }] },
      store,
      templatesPath,
    );

    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(newBytes as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(wb2.getWorksheet('Detail')!.getRow(2).getCell(3).value).toBe('12-345-123456');
  });

  it('rejects the whole batch when a keyColumnValue no longer matches the live file', async () => {
    writeTemplates([SINGLE_SHEET_TEMPLATE]);
    const bytes = await buildSingleSheetWorkbook([['2026-08-01', 'Alice Cohen', '12-345-123456', 100, 'Pending']]);

    await expect(
      applyEditsToBytes(
        bytes,
        {
          cellEdits: [
            { sheetName: 'Detail', row: 2, column: 'Status', value: 'Paid', keyColumnValue: '2026-08-02' /* wrong */ },
          ],
        },
        store,
        templatesPath,
      ),
    ).rejects.toThrow(RowVerificationError);
  });

  it('accepts the edit when keyColumnValue matches the live file', async () => {
    writeTemplates([SINGLE_SHEET_TEMPLATE]);
    const bytes = await buildSingleSheetWorkbook([['2026-08-01', 'Alice Cohen', '12-345-123456', 100, 'Pending']]);

    const newBytes = await applyEditsToBytes(
      bytes,
      {
        cellEdits: [{ sheetName: 'Detail', row: 2, column: 'Status', value: 'Paid', keyColumnValue: '2026-08-01' }],
      },
      store,
      templatesPath,
    );
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(newBytes as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(wb2.getWorksheet('Detail')!.getRow(2).getCell(5).value).toBe('Paid');
  });

  it('coerces a non-sensitive numeric-looking value to a number, but always writes a sensitive column as text', async () => {
    writeTemplates([SINGLE_SHEET_TEMPLATE]);
    const bytes = await buildSingleSheetWorkbook([['2026-08-01', 'Alice Cohen', '007-000-001', 100, 'Pending']]);

    const newBytes = await applyEditsToBytes(
      bytes,
      {
        cellEdits: [
          { sheetName: 'Detail', row: 2, column: 'Amount', value: '250' },
          { sheetName: 'Detail', row: 2, column: 'Account Number', value: '007-000-002' },
        ],
      },
      store,
      templatesPath,
    );

    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(newBytes as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    const row = wb2.getWorksheet('Detail')!.getRow(2);
    expect(row.getCell(4).value).toBe(250); // Amount: coerced to a number
    expect(row.getCell(3).value).toBe('007-000-002'); // Account Number: always text, leading zero preserved
  });

  it('appends a new row under the right columns', async () => {
    writeTemplates([SINGLE_SHEET_TEMPLATE]);
    const bytes = await buildSingleSheetWorkbook([['2026-08-01', 'Alice Cohen', '12-345-123456', 100, 'Pending']]);

    const newBytes = await applyEditsToBytes(
      bytes,
      {
        appendRows: [
          {
            sheetName: 'Detail',
            values: {
              Date: '2026-08-02',
              'Payee Name': 'Bob Levi',
              'Account Number': '99-999-999999',
              Amount: '50',
              Status: 'Pending',
            },
          },
        ],
      },
      store,
      templatesPath,
    );

    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(newBytes as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    const sheet2 = wb2.getWorksheet('Detail')!;
    expect(sheet2.rowCount).toBe(3); // header + original row + appended row
    const appended = sheet2.getRow(3);
    expect(appended.getCell(1).value).toBe('2026-08-02');
    expect(appended.getCell(2).value).toBe('Bob Levi');
    expect(appended.getCell(5).value).toBe('Pending');
  });

  it('rejects an edit against a report that no longer matches the template', async () => {
    writeTemplates([SINGLE_SHEET_TEMPLATE]);
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Detail');
    sheet.addRow(['Date', 'Payee Name', 'Account Number', 'Amount']); // missing "Status" column now
    sheet.addRow(['2026-08-01', 'Alice Cohen', '12-345-123456', 100]);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());

    await expect(
      applyEditsToBytes(
        bytes,
        { cellEdits: [{ sheetName: 'Detail', row: 2, column: 'Amount', value: '200' }] },
        store,
        templatesPath,
      ),
    ).rejects.toThrow(UnrecognizedReportError);
  });
});
