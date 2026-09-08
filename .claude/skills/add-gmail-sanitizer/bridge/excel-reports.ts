/**
 * Read and edit Excel (.xlsx) report attachments, with column-level
 * anonymization. Sensitive columns are never detected from content —
 * they're named explicitly, once, per report template in
 * data/gmail-excel-reports.json. A file that doesn't match any configured
 * template's sheet names + header rows exactly is "unrecognized" and
 * nothing about its data is returned — no best-effort partial exposure.
 *
 * Edits are targeted cell values and row-appends only: no new columns, no
 * formula/formatting changes, no deletions. Only `cell.value` is ever
 * touched, which leaves the rest of the workbook (styles, merges, other
 * formulas) exactly as exceljs read it.
 */
import fs from 'fs';
import path from 'path';

// exceljs is CommonJS with no statically-analyzable named exports — Node's
// real ESM loader can only give us the default (whole module.exports)
// import, not `import { Workbook } from 'exceljs'` (that only appears to
// work under vitest's more lenient transform, not under plain `node`).
import ExcelJS, { type Worksheet } from 'exceljs';

import { AnonymizationStore, anonymizeCellValue, deanonymizeText } from './anonymize.js';

const REPORTS_CONFIG_PATH = path.resolve(process.cwd(), 'data', 'gmail-excel-reports.json');

// Real reports run 600-700KB; this is a generous backstop, not a tight cap.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_ROWS = 5000;

export interface ReportSheetTemplate {
  sheetName: string;
  headerRow: number;
  expectedHeaders: string[];
  sensitiveColumns: string[];
  keyColumn?: string;
}

export interface ReportTemplate {
  id: string;
  description?: string;
  sheets: ReportSheetTemplate[];
}

export class ReportTooLargeError extends Error {}

export class UnrecognizedReportError extends Error {
  constructor(
    public readonly sheetsFound: string[],
    public readonly headersBySheet: Record<string, string[]>,
  ) {
    super('This spreadsheet does not match any configured report template.');
  }
}

export class RowVerificationError extends Error {}

/** Exported (with an overridable path) so tests can point it at a fixture file instead of the real data/ directory. */
export function loadReportTemplates(configPath: string = REPORTS_CONFIG_PATH): ReportTemplate[] {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return []; // no config yet — every report is "unrecognized" until one is added
  }
  try {
    const parsed = JSON.parse(raw) as { reports?: ReportTemplate[] };
    return parsed.reports ?? [];
  } catch {
    return []; // corrupt config — fail safe (unrecognized), never crash the service
  }
}

function assertWithinSizeCap(bytes: Buffer): void {
  if (bytes.length > MAX_FILE_BYTES) {
    throw new ReportTooLargeError(`File is ${bytes.length} bytes, exceeding the ${MAX_FILE_BYTES}-byte limit.`);
  }
}

async function loadWorkbook(bytes: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  // exceljs's own .d.ts redeclares an ambient `Buffer extends ArrayBuffer`
  // that doesn't structurally match @types/node's real Buffer — `as any`
  // at this one boundary rather than let the mismatch leak into the rest
  // of the file (skipLibCheck doesn't cover this, it's our call site).
  await wb.xlsx.load(bytes as any); // eslint-disable-line @typescript-eslint/no-explicit-any
  return wb;
}

function readHeaderRow(sheet: Worksheet, headerRowNum: number): string[] {
  const row = sheet.getRow(headerRowNum);
  const headers: string[] = [];
  for (let c = 1; c <= row.cellCount; c++) {
    headers.push(row.getCell(c).text.trim());
  }
  while (headers.length > 0 && headers[headers.length - 1] === '') headers.pop();
  return headers;
}

function headersMatch(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((h, i) => h.toLowerCase() === expected[i].trim().toLowerCase());
}

type MatchOutcome =
  | { matched: true; template: ReportTemplate }
  | { matched: false; sheetsFound: string[]; headersBySheet: Record<string, string[]> };

function matchTemplate(wb: ExcelJS.Workbook, templates: ReportTemplate[]): MatchOutcome {
  for (const template of templates) {
    const allSheetsMatch = template.sheets.every((sheetTemplate) => {
      const sheet = wb.getWorksheet(sheetTemplate.sheetName);
      if (!sheet) return false;
      return headersMatch(readHeaderRow(sheet, sheetTemplate.headerRow), sheetTemplate.expectedHeaders);
    });
    if (allSheetsMatch) return { matched: true, template };
  }

  const sheetsFound = wb.worksheets.map((s) => s.name);
  const headersBySheet: Record<string, string[]> = {};
  for (const sheet of wb.worksheets) headersBySheet[sheet.name] = readHeaderRow(sheet, 1);
  return { matched: false, sheetsFound, headersBySheet };
}

function getSheetOrThrow(wb: ExcelJS.Workbook, sheetName: string): Worksheet {
  const sheet = wb.getWorksheet(sheetName);
  if (!sheet) throw new RowVerificationError(`Sheet "${sheetName}" not found.`);
  return sheet;
}

export interface ReadResult {
  reportId: string;
  sheets: {
    sheetName: string;
    headers: string[];
    sensitiveColumns: string[];
    keyColumn?: string;
    rows: { row: number; values: Record<string, string> }[];
  }[];
}

/** Read and column-anonymize a workbook's matched-template sheets from raw bytes. */
export async function readReportFromBytes(
  bytes: Buffer,
  store?: AnonymizationStore,
  templatesPath?: string,
): Promise<ReadResult> {
  assertWithinSizeCap(bytes);
  const wb = await loadWorkbook(bytes);
  const templates = loadReportTemplates(templatesPath);
  const outcome = matchTemplate(wb, templates);
  if (!outcome.matched) throw new UnrecognizedReportError(outcome.sheetsFound, outcome.headersBySheet);

  let totalRows = 0;
  const sheets: ReadResult['sheets'] = [];
  for (const sheetTemplate of outcome.template.sheets) {
    const sheet = getSheetOrThrow(wb, sheetTemplate.sheetName);
    const rows: { row: number; values: Record<string, string> }[] = [];
    for (let r = sheetTemplate.headerRow + 1; r <= sheet.rowCount; r++) {
      const rowObj = sheet.getRow(r);
      if (!rowObj.hasValues) continue;

      totalRows += 1;
      if (totalRows > MAX_TOTAL_ROWS) {
        throw new ReportTooLargeError(`Report has more than ${MAX_TOTAL_ROWS} data rows.`);
      }

      const values: Record<string, string> = {};
      sheetTemplate.expectedHeaders.forEach((header, idx) => {
        const raw = rowObj.getCell(idx + 1).text;
        values[header] = sheetTemplate.sensitiveColumns.includes(header) ? anonymizeCellValue(raw, store) : raw;
      });
      rows.push({ row: r, values });
    }
    sheets.push({
      sheetName: sheetTemplate.sheetName,
      headers: sheetTemplate.expectedHeaders,
      sensitiveColumns: sheetTemplate.sensitiveColumns,
      keyColumn: sheetTemplate.keyColumn,
      rows,
    });
  }
  return { reportId: outcome.template.id, sheets };
}

export interface CellEdit {
  sheetName: string;
  row: number;
  column: string;
  value: string;
  /** The value read in this row's key column, if the sheet has one — verified against the live file before writing. */
  keyColumnValue?: string;
}

export interface AppendRow {
  sheetName: string;
  values: Record<string, string>;
}

/** Non-sensitive values coerce to a number when they look like one; sensitive values are always written as text (a leading-zero account/ID number must never silently become a number). */
function coerceForWrite(value: string, isSensitive: boolean): string | number {
  if (isSensitive) return value;
  if (value.trim() === '') return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

/** Apply targeted cell edits and/or appended rows to a report's bytes, deanonymizing any token values first, and return the new xlsx bytes. */
export async function applyEditsToBytes(
  bytes: Buffer,
  edits: { cellEdits?: CellEdit[]; appendRows?: AppendRow[] },
  store?: AnonymizationStore,
  templatesPath?: string,
): Promise<Buffer> {
  assertWithinSizeCap(bytes);
  const wb = await loadWorkbook(bytes);
  const templates = loadReportTemplates(templatesPath);
  const outcome = matchTemplate(wb, templates);
  if (!outcome.matched) throw new UnrecognizedReportError(outcome.sheetsFound, outcome.headersBySheet);

  const sheetTemplateByName = new Map(outcome.template.sheets.map((s) => [s.sheetName, s]));
  const cellEdits = edits.cellEdits ?? [];
  const appendRows = edits.appendRows ?? [];

  // Verify every edit's target sheet/column/key-column BEFORE writing anything, so a bad edit never partially applies.
  for (const edit of cellEdits) {
    const sheetTemplate = sheetTemplateByName.get(edit.sheetName);
    if (!sheetTemplate)
      throw new RowVerificationError(`Sheet "${edit.sheetName}" is not part of this report template.`);
    if (!sheetTemplate.expectedHeaders.includes(edit.column)) {
      throw new RowVerificationError(`Column "${edit.column}" is not part of sheet "${edit.sheetName}".`);
    }
    if (edit.keyColumnValue !== undefined && sheetTemplate.keyColumn) {
      const sheet = getSheetOrThrow(wb, edit.sheetName);
      const keyColIdx = sheetTemplate.expectedHeaders.indexOf(sheetTemplate.keyColumn) + 1;
      const actual = sheet.getRow(edit.row).getCell(keyColIdx).text.trim();
      if (actual !== edit.keyColumnValue.trim()) {
        throw new RowVerificationError(
          `Row ${edit.row} in sheet "${edit.sheetName}": expected ${sheetTemplate.keyColumn}="${edit.keyColumnValue}" but found "${actual}" — the file may have changed since it was read. Re-read the report and try again.`,
        );
      }
    }
  }
  for (const append of appendRows) {
    if (!sheetTemplateByName.has(append.sheetName)) {
      throw new RowVerificationError(`Sheet "${append.sheetName}" is not part of this report template.`);
    }
  }

  for (const edit of cellEdits) {
    const sheetTemplate = sheetTemplateByName.get(edit.sheetName)!;
    const sheet = getSheetOrThrow(wb, edit.sheetName);
    const colIdx = sheetTemplate.expectedHeaders.indexOf(edit.column) + 1;
    const resolved = deanonymizeText(edit.value, store);
    sheet.getRow(edit.row).getCell(colIdx).value = coerceForWrite(
      resolved,
      sheetTemplate.sensitiveColumns.includes(edit.column),
    );
  }

  for (const append of appendRows) {
    const sheetTemplate = sheetTemplateByName.get(append.sheetName)!;
    const sheet = getSheetOrThrow(wb, append.sheetName);
    const rowValues = sheetTemplate.expectedHeaders.map((header) => {
      const raw = append.values[header];
      if (raw === undefined) return '';
      const resolved = deanonymizeText(raw, store);
      return coerceForWrite(resolved, sheetTemplate.sensitiveColumns.includes(header));
    });
    sheet.addRow(rowValues);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
