/**
 * Bespoke read/edit engine for Idan's one monthly poetry-slam report
 * workbook — not a config-driven template like excel-reports.ts, because
 * this file has real structure the generic engine can't express: a fixed
 * driving table that feeds 30 template sheets by row position, sheets that
 * get renamed/reordered every month, and three small pieces of VBA
 * (`Sheetsplace`/`Nameing`/`Depeople`/`Byname`, called together as `Que`)
 * that keep הוצאות in sync with whatever's in the event sheets.
 *
 * There is no headless way to run that VBA here (no Excel, no LibreOffice
 * in the container), so `runSync` below re-implements those four routines
 * directly against the exceljs workbook instead of invoking them. Their
 * logic was recovered by decompiling xl/vbaProject.bin with oletools
 * (olevba) against the real template — see the function-level comments for
 * the corresponding VBA sub. `Xternal` (the destructive month-end
 * finalize macro — deletes unused sheets/columns, bakes formulas to
 * values, has its own "are you sure you're finished" prompt) is
 * deliberately NOT replicated: that stays a manual, human-run step in
 * Excel.
 *
 * Because this module fully replicates Que's automation in code, the
 * workbook no longer needs to carry VBA at all — read/edit here goes
 * through plain exceljs (same as excel-reports.ts), which silently drops
 * `vbaProject.bin` on write. That's intentional, not a bug: the file is
 * expected to live on as a working .xlsx, not stay a macro-enabled .xlsm.
 *
 * exceljs's own load→write round trip is NOT safe to trust wholesale on this workbook — confirmed
 * against a real finalized report, a bare round trip with ZERO edits already:
 *  - truncates Excel Tables' `tableColumns` (8→3, 17→7 on this file) while leaving their `ref`
 *    range unchanged, an internally-inconsistent table Excel can't open without "repairing" by
 *    deleting the Table/AutoFilter outright (root cause: its table-column parser chokes on
 *    structured-reference `calculatedColumnFormula` entries);
 *  - silently drops cfRule children from `conditionalFormatting` blocks, and drops `hyperlinks`
 *    blocks almost entirely, on most sheets;
 *  - freely reorders/rebuilds `xl/sharedStrings.xml` and `xl/styles.xml` on every write, so a
 *    cell's `t="s"`/`s=` index only means the same thing within the SAME write's tables — reusing
 *    an index across two different writes silently points at the wrong string/style.
 * `reconcileWorkbookOutput` (below `applyMonthlyReportChangesToBytes`) is the fix: it makes the
 * pre-edit bytes the source of truth everywhere this module didn't itself change something —
 * restoring `xl/tables/*.xml` and `xl/styles.xml` verbatim (never touched by this module's
 * writes, except runSync's Byname step — a known, narrower residual risk not yet covered here),
 * restoring any untouched worksheet verbatim (sidestepping the conditionalFormatting/hyperlinks
 * bugs on it for free), and remapping touched worksheets' shared-string cell references back onto
 * the original `sharedStrings.xml` table (extended with anything genuinely new) so that table,
 * too, can stay the original rather than exceljs's rebuilt one.
 */
import ExcelJS, { type Workbook, type Worksheet } from 'exceljs';
import JSZip from 'jszip';

import { AnonymizationStore, anonymizeCellValue, deanonymizeText } from './anonymize.js';

const SHEET = {
  INCOME: 'הכנסות',
  EXPENSE: 'הוצאות',
  SUMMARY: 'סיכום חודשי',
  ARTISTS: 'פרטי_אמנים',
  MONTHLIES: 'תשלומים חודשיים',
} as const;

// Fixed sheets, in required tab order. Everything after these is an event
// sheet (placeholder "אירוע1".."אירוע30", or renamed to a "d.mm" date) —
// membership is by tab position, exactly like the VBA's `Worksheet.Index`
// checks, not by name pattern.
const FIXED_SHEET_NAMES = [SHEET.INCOME, SHEET.EXPENSE, SHEET.SUMMARY, SHEET.ARTISTS, SHEET.MONTHLIES];
const NUM_EVENT_SLOTS = 30;

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class MonthlyReportStructureError extends Error {
  constructor(detail: string) {
    super(`This file doesn't match the expected monthly report structure: ${detail}`);
  }
}

export class MonthlyReportValidationError extends Error {}

function assertWithinSizeCap(bytes: Buffer): void {
  if (bytes.length > MAX_FILE_BYTES) {
    throw new MonthlyReportValidationError(
      `File is ${bytes.length} bytes, exceeding the ${MAX_FILE_BYTES}-byte limit.`,
    );
  }
}

async function loadWorkbook(bytes: Buffer): Promise<Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as any); // eslint-disable-line @typescript-eslint/no-explicit-any
  return wb;
}

function parseXmlAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

/** Maps each worksheet's stable `sheetId` (survives rename/reorder — unlike its file name or tab position) to its `xl/worksheets/sheetN.xml` path within one zip. */
async function sheetIdToWorksheetPath(zip: JSZip): Promise<Map<number, string>> {
  const workbookXml = await zip.file('xl/workbook.xml')!.async('string');
  const relsXml = (await zip.file('xl/_rels/workbook.xml.rels')?.async('string')) ?? '';
  const relIdToTarget = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\s+([^>]*)\/>/g)) {
    const attrs = parseXmlAttrs(m[1]);
    if (attrs.Id && attrs.Target) relIdToTarget.set(attrs.Id, attrs.Target);
  }
  const result = new Map<number, string>();
  for (const m of workbookXml.matchAll(/<sheet\s+([^>]*)\/>/g)) {
    const attrs = parseXmlAttrs(m[1]);
    const sheetId = attrs.sheetId ? Number(attrs.sheetId) : undefined;
    const target = attrs['r:id'] ? relIdToTarget.get(attrs['r:id']) : undefined;
    if (sheetId !== undefined && target) result.set(sheetId, `xl/${target}`);
  }
  return result;
}

/** Each `<si>`'s raw inner XML, in table order — used as an exact-match key (identical inner XML, plain or rich text, means the same string). */
function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => m[1]);
}

/** Generic append-only "intern by exact content" table — same technique used for shared strings, fonts, fills, borders, and (via `remapXf`) cellXfs below: two entries with identical raw XML are the same resource, existing entries/indices never move, a genuinely new one is appended. */
interface ContentTable {
  entries: string[];
  indexByContent: Map<string, number>;
}

function buildContentTable(entries: string[]): ContentTable {
  const indexByContent = new Map<string, number>();
  entries.forEach((entry, i) => {
    if (!indexByContent.has(entry)) indexByContent.set(entry, i);
  });
  return { entries: [...entries], indexByContent };
}

function internContent(table: ContentTable, content: string): number {
  const existing = table.indexByContent.get(content);
  if (existing !== undefined) return existing;
  const index = table.entries.length;
  table.entries.push(content);
  table.indexByContent.set(content, index);
  return index;
}

// Matches a shared-string cell (`t="s"`) up through its `<v>` index, non-greedy so an optional
// `<f>...</f>` (a formula cell whose cached result is a shared string) in between is left alone —
// only the `<v>` index itself gets rewritten.
const SHARED_STRING_CELL_RE = /(<c\b[^>]*\bt="s"[^>]*>(?:(?!<\/c>)[\s\S])*?<v>)(\d+)(<\/v>)/g;

/** Rewrites a worksheet's shared-string cell references from `sourceEntries`' index space into `targetTable`'s, interning any string `targetTable` doesn't already have (appended, never reordering existing entries). */
function remapSharedStringCells(sheetXml: string, sourceEntries: string[], targetTable: ContentTable): string {
  return sheetXml.replace(SHARED_STRING_CELL_RE, (_match, prefix, indexStr, suffix) => {
    const newIndex = internContent(targetTable, sourceEntries[Number(indexStr)] ?? '');
    return `${prefix}${newIndex}${suffix}`;
  });
}

function countSharedStringRefs(sheetXml: string): number {
  return [...sheetXml.matchAll(SHARED_STRING_CELL_RE)].length;
}

function serializeSharedStrings(table: ContentTable, totalCount: number): string {
  const body = table.entries.map((entry) => `<si>${entry}</si>`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${totalCount}" uniqueCount="${table.entries.length}">${body}</sst>`
  );
}

/** Every `<entryTag>` inside a styles.xml `<sectionTag>...</sectionTag>` block, as raw XML (self-closing or with children — e.g. `<xf ...><alignment .../></xf>`). Empty/absent section → []. */
function parseStyleSection(styleSheetXml: string, sectionTag: string, entryTag: string): string[] {
  const section = new RegExp(`<${sectionTag}\\b[^>]*>([\\s\\S]*?)</${sectionTag}>`).exec(styleSheetXml)?.[1];
  if (!section) return [];
  const entryRe = new RegExp(`<${entryTag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${entryTag}>)`, 'g');
  return section.match(entryRe) ?? [];
}

/** `numFmtId -> formatCode` for every CUSTOM number format declared in this styles.xml (built-ins, id 0-163, are never declared and need no remapping — they mean the same thing everywhere). */
function parseCustomNumFmts(styleSheetXml: string): Map<number, string> {
  const result = new Map<number, string>();
  for (const raw of parseStyleSection(styleSheetXml, 'numFmts', 'numFmt')) {
    const attrs = parseXmlAttrs(raw);
    if (attrs.numFmtId) result.set(Number(attrs.numFmtId), attrs.formatCode ?? '');
  }
  return result;
}

/** Interns a formatCode into the canonical custom-numFmts table, assigning a fresh id (164+, past both tables' existing ids) the first time a given formatCode is seen. */
function internNumFmt(canonical: Map<string, number>, nextId: { value: number }, formatCode: string): number {
  const existing = canonical.get(formatCode);
  if (existing !== undefined) return existing;
  const id = nextId.value++;
  canonical.set(formatCode, id);
  return id;
}

/**
 * Rewrites one written cellXfs `<xf>` entry's numFmtId/fontId/fillId/borderId from the written
 * styles.xml's index spaces into the canonical (original-based) ones, then interns the
 * fully-remapped entry into `canonicalXfs` — the same append-only pattern as everything else
 * here, just applied to a structured entry instead of an opaque string.
 */
function remapXf(
  rawXf: string,
  writtenCustomNumFmts: Map<number, string>,
  canonicalNumFmtIdByFormatCode: Map<string, number>,
  nextCustomNumFmtId: { value: number },
  writtenFonts: string[],
  canonicalFonts: ContentTable,
  writtenFills: string[],
  canonicalFills: ContentTable,
  writtenBorders: string[],
  canonicalBorders: ContentTable,
): string {
  const openTag = /^<xf\b([^>]*?)(\/)?>/.exec(rawXf)!;
  const attrs = parseXmlAttrs(openTag[1]);
  const rest = openTag[2] ? '' : rawXf.slice(openTag[0].length, -'</xf>'.length);

  if (attrs.numFmtId !== undefined) {
    const formatCode = writtenCustomNumFmts.get(Number(attrs.numFmtId));
    if (formatCode !== undefined) {
      attrs.numFmtId = String(internNumFmt(canonicalNumFmtIdByFormatCode, nextCustomNumFmtId, formatCode));
    }
  }
  if (attrs.fontId !== undefined) {
    attrs.fontId = String(internContent(canonicalFonts, writtenFonts[Number(attrs.fontId)] ?? ''));
  }
  if (attrs.fillId !== undefined) {
    attrs.fillId = String(internContent(canonicalFills, writtenFills[Number(attrs.fillId)] ?? ''));
  }
  if (attrs.borderId !== undefined) {
    attrs.borderId = String(internContent(canonicalBorders, writtenBorders[Number(attrs.borderId)] ?? ''));
  }

  const attrStr = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  return rest ? `<xf ${attrStr}>${rest}</xf>` : `<xf ${attrStr}/>`;
}

// Matches any cell's `s="N"` style index (order-agnostic w.r.t. the cell's other attributes).
const CELL_STYLE_RE = /(<c\b[^>]*\bs=")(\d+)("[^>]*>)/g;

/**
 * Remaps a touched worksheet's cell style (`s=`) indices the same way `remapSharedStringCells`
 * remaps `t="s"` value indices — from the written styles.xml's cellXfs index space into the
 * canonical (original-based) one, extended with anything genuinely new. See this file's header
 * comment: this is what makes it safe to restore `xl/styles.xml` to the original wholesale even
 * though a touched sheet can legitimately need a style the original never had (e.g. a date-typed
 * cell that was previously blank).
 */
function remapCellStyles(
  sheetXml: string,
  writtenXfs: string[],
  canonicalXfs: ContentTable,
  writtenCustomNumFmts: Map<number, string>,
  canonicalNumFmtIdByFormatCode: Map<string, number>,
  nextCustomNumFmtId: { value: number },
  writtenFonts: string[],
  canonicalFonts: ContentTable,
  writtenFills: string[],
  canonicalFills: ContentTable,
  writtenBorders: string[],
  canonicalBorders: ContentTable,
): string {
  return sheetXml.replace(CELL_STYLE_RE, (_match, prefix, indexStr, suffix) => {
    const rawXf = writtenXfs[Number(indexStr)];
    if (rawXf === undefined) return `${prefix}${indexStr}${suffix}`;
    const remapped = remapXf(
      rawXf,
      writtenCustomNumFmts,
      canonicalNumFmtIdByFormatCode,
      nextCustomNumFmtId,
      writtenFonts,
      canonicalFonts,
      writtenFills,
      canonicalFills,
      writtenBorders,
      canonicalBorders,
    );
    return `${prefix}${internContent(canonicalXfs, remapped)}${suffix}`;
  });
}

function serializeStyleSheet(
  originalStyleSheetXml: string,
  canonicalNumFmtIdByFormatCode: Map<string, number>,
  canonicalFonts: ContentTable,
  canonicalFills: ContentTable,
  canonicalBorders: ContentTable,
  canonicalXfs: ContentTable,
): string {
  const numFmtsXml =
    canonicalNumFmtIdByFormatCode.size === 0
      ? ''
      : `<numFmts count="${canonicalNumFmtIdByFormatCode.size}">${[...canonicalNumFmtIdByFormatCode]
          .map(([formatCode, id]) => `<numFmt numFmtId="${id}" formatCode="${formatCode}"/>`)
          .join('')}</numFmts>`;
  // Fonts/fills/borders entries are captured (and stored) as their own full <font>/<fill>/<border>
  // tag — see parseStyleSection — so they're joined directly, not re-wrapped.
  const fontsXml = `<fonts count="${canonicalFonts.entries.length}">${canonicalFonts.entries.join('')}</fonts>`;
  const fillsXml = `<fills count="${canonicalFills.entries.length}">${canonicalFills.entries.join('')}</fills>`;
  const bordersXml = `<borders count="${canonicalBorders.entries.length}">${canonicalBorders.entries.join('')}</borders>`;
  const cellXfsXml = `<cellXfs count="${canonicalXfs.entries.length}">${canonicalXfs.entries.join('')}</cellXfs>`;

  let result = originalStyleSheetXml;
  result = /<numFmts\b[^>]*>[\s\S]*?<\/numFmts>/.test(result)
    ? result.replace(/<numFmts\b[^>]*>[\s\S]*?<\/numFmts>/, numFmtsXml)
    : numFmtsXml
      ? result.replace(/(<styleSheet\b[^>]*>)/, `$1${numFmtsXml}`)
      : result;
  result = result.replace(/<fonts\b[^>]*>[\s\S]*?<\/fonts>/, fontsXml);
  result = result.replace(/<fills\b[^>]*>[\s\S]*?<\/fills>/, fillsXml);
  result = result.replace(/<borders\b[^>]*>[\s\S]*?<\/borders>/, bordersXml);
  result = result.replace(/<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/, cellXfsXml);
  return result;
}

function nextAvailableRelId(relsXml: string): string {
  const used = new Set([...relsXml.matchAll(/\bId="rId(\d+)"/g)].map((m) => Number(m[1])));
  let n = 1;
  while (used.has(n)) n++;
  return `rId${n}`;
}

/**
 * exceljs's writer drops `xl/metadata.xml` (and its `[Content_Types].xml`/`workbook.xml.rels`
 * registrations) entirely on write — but leaves the `cm="N"` cell-metadata attribute in place on
 * every array-formula cell that referenced it. Confirmed against a real report: הכנסות/הוצאות's
 * structured-Table calculated columns carry `cm="1"` on ~940 cells between them; with the part
 * gone, Excel treats every one of those as a dangling reference and repairs ("Cell information")
 * both sheets. This module never touches cell metadata, so restore the part verbatim and re-wire
 * it in — same technique as the table/worksheet restores above, just for a workbook-level part
 * instead of a per-sheet one.
 */
async function restoreDroppedMetadataPart(originalZip: JSZip, writtenZip: JSZip): Promise<void> {
  const partPath = 'xl/metadata.xml';
  const originalFile = originalZip.file(partPath);
  if (!originalFile || writtenZip.file(partPath)) return; // nothing to restore, or already present

  writtenZip.file(partPath, await originalFile.async('nodebuffer'));

  const contentTypesPath = '[Content_Types].xml';
  const originalContentTypes = await originalZip.file(contentTypesPath)?.async('string');
  const overrideMatch =
    originalContentTypes && /<Override PartName="\/xl\/metadata\.xml"[^>]*?\/>/.exec(originalContentTypes);
  const writtenContentTypes = await writtenZip.file(contentTypesPath)?.async('string');
  if (overrideMatch && writtenContentTypes && !writtenContentTypes.includes(overrideMatch[0])) {
    writtenZip.file(contentTypesPath, writtenContentTypes.replace('</Types>', `${overrideMatch[0]}</Types>`));
  }

  const workbookRelsPath = 'xl/_rels/workbook.xml.rels';
  const originalRels = await originalZip.file(workbookRelsPath)?.async('string');
  const relMatch = originalRels && /<Relationship\b[^>]*\bTarget="metadata\.xml"[^>]*\/>/.exec(originalRels);
  const writtenRels = await writtenZip.file(workbookRelsPath)?.async('string');
  if (relMatch && writtenRels && !/\bTarget="metadata\.xml"/.test(writtenRels)) {
    const type = /\bType="([^"]*)"/.exec(relMatch[0])?.[1] ?? '';
    const newRel = `<Relationship Id="${nextAvailableRelId(writtenRels)}" Type="${type}" Target="metadata.xml"/>`;
    writtenZip.file(workbookRelsPath, writtenRels.replace('</Relationships>', `${newRel}</Relationships>`));
  }
}

/**
 * A defined name whose value is (or contains) `#REF!` points at a deleted sheet/range and can
 * never resolve — dead weight, not something any of this module's edits could produce or fix.
 * Confirmed on a real report: 21 of its 73 names (`LINKA10`..`LINKA30`, template artifacts from
 * slots that were never used) were already dead in the *original* file. exceljs's writer happens
 * to drop them anyway, but relying on that undocumented side effect meant Excel's own repair
 * dialog was still the one "cleaning up" on open — do it ourselves, explicitly, instead.
 */
function stripDeadNamedRanges(workbookXml: string): string {
  return workbookXml.replace(/<definedName\b[^>]*>[^<]*<\/definedName>/g, (tag) => (tag.includes('#REF!') ? '' : tag));
}

/** See this file's header comment. */
async function reconcileWorkbookOutput(
  originalBytes: Buffer,
  writtenBytes: Buffer,
  touchedSheetIds: ReadonlySet<number>,
): Promise<Buffer> {
  const originalZip = await JSZip.loadAsync(originalBytes);
  const writtenZip = await JSZip.loadAsync(writtenBytes);

  // Tables — never touched by this module's writes, always safe to restore verbatim.
  for (const path of Object.keys(originalZip.files)) {
    if (!/^xl\/tables\/.*\.xml$/.test(path) || !writtenZip.file(path)) continue;
    writtenZip.file(path, await originalZip.file(path)!.async('nodebuffer'));
  }
  await restoreDroppedMetadataPart(originalZip, writtenZip);

  // Shared strings: the original table is the base (its existing entries/indices never move),
  // extended with anything genuinely new a touched sheet introduces.
  const sharedTable = buildContentTable(
    parseSharedStrings(await originalZip.file('xl/sharedStrings.xml')?.async('string')),
  );
  const writtenStringEntries = parseSharedStrings(await writtenZip.file('xl/sharedStrings.xml')?.async('string'));

  // Styles: same "original is the base, touched sheets get remapped onto it" strategy — a
  // touched sheet can legitimately need a style the original never had (e.g. a date-typed cell
  // that was previously blank), so cellXfs/fonts/fills/borders/custom-numFmts are all
  // canonicalized here too, not just restored blindly. xfId (named cell styles, cellStyleXfs) is
  // NOT remapped — this module never applies one, and every plain-value write's xf keeps
  // xfId="0" (the universal default), so that's a narrower, currently-unexercised residual gap.
  const originalStylesXml = (await originalZip.file('xl/styles.xml')?.async('string')) ?? '';
  const writtenStylesXml = (await writtenZip.file('xl/styles.xml')?.async('string')) ?? '';
  const canonicalNumFmtIdByFormatCode = new Map<string, number>();
  for (const [id, formatCode] of parseCustomNumFmts(originalStylesXml))
    canonicalNumFmtIdByFormatCode.set(formatCode, id);
  const nextCustomNumFmtId = { value: Math.max(164, ...canonicalNumFmtIdByFormatCode.values()) + 1 };
  const writtenCustomNumFmts = parseCustomNumFmts(writtenStylesXml);
  const canonicalFonts = buildContentTable(parseStyleSection(originalStylesXml, 'fonts', 'font'));
  const writtenFonts = parseStyleSection(writtenStylesXml, 'fonts', 'font');
  const canonicalFills = buildContentTable(parseStyleSection(originalStylesXml, 'fills', 'fill'));
  const writtenFills = parseStyleSection(writtenStylesXml, 'fills', 'fill');
  const canonicalBorders = buildContentTable(parseStyleSection(originalStylesXml, 'borders', 'border'));
  const writtenBorders = parseStyleSection(writtenStylesXml, 'borders', 'border');
  const canonicalXfs = buildContentTable(parseStyleSection(originalStylesXml, 'cellXfs', 'xf'));
  const writtenXfs = parseStyleSection(writtenStylesXml, 'cellXfs', 'xf');

  const originalPaths = await sheetIdToWorksheetPath(originalZip);
  const writtenPaths = await sheetIdToWorksheetPath(writtenZip);

  for (const [sheetId, originalPath] of originalPaths) {
    const writtenPath = writtenPaths.get(sheetId);
    if (!writtenPath) continue; // sheet no longer exists in the output — nothing to reconcile

    if (touchedSheetIds.has(sheetId)) {
      let sheetXml = await writtenZip.file(writtenPath)!.async('string');
      sheetXml = remapSharedStringCells(sheetXml, writtenStringEntries, sharedTable);
      sheetXml = remapCellStyles(
        sheetXml,
        writtenXfs,
        canonicalXfs,
        writtenCustomNumFmts,
        canonicalNumFmtIdByFormatCode,
        nextCustomNumFmtId,
        writtenFonts,
        canonicalFonts,
        writtenFills,
        canonicalFills,
        writtenBorders,
        canonicalBorders,
      );
      writtenZip.file(writtenPath, sheetXml);
      continue;
    }

    // Untouched — restore verbatim (content + its own _rels, since hyperlink/table relationship
    // ids are scoped to it), sidestepping every one of the round-trip bugs above on this sheet.
    const originalFile = originalZip.file(originalPath);
    if (!originalFile) continue;
    writtenZip.file(writtenPath, await originalFile.async('nodebuffer'));

    const originalRelsPath = originalPath.replace(/^xl\/worksheets\//, 'xl/worksheets/_rels/') + '.rels';
    const writtenRelsPath = writtenPath.replace(/^xl\/worksheets\//, 'xl/worksheets/_rels/') + '.rels';
    const originalRelsFile = originalZip.file(originalRelsPath);
    if (originalRelsFile) {
      writtenZip.file(writtenRelsPath, await originalRelsFile.async('nodebuffer'));
    } else {
      writtenZip.remove(writtenRelsPath); // original sheet had no rels — don't leave a stale written one behind
    }
  }

  if (sharedTable.entries.length > 0) {
    let totalRefs = 0;
    for (const path of writtenPaths.values()) {
      const file = writtenZip.file(path);
      if (file) totalRefs += countSharedStringRefs(await file.async('string'));
    }
    writtenZip.file('xl/sharedStrings.xml', serializeSharedStrings(sharedTable, totalRefs));
  }

  if (originalStylesXml && writtenZip.file('xl/styles.xml')) {
    writtenZip.file(
      'xl/styles.xml',
      serializeStyleSheet(
        originalStylesXml,
        canonicalNumFmtIdByFormatCode,
        canonicalFonts,
        canonicalFills,
        canonicalBorders,
        canonicalXfs,
      ),
    );
  }

  const workbookXml = await writtenZip.file('xl/workbook.xml')?.async('string');
  if (workbookXml) {
    const cleaned = stripDeadNamedRanges(workbookXml);
    if (cleaned !== workbookXml) writtenZip.file('xl/workbook.xml', cleaned);
  }

  return writtenZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function requireSheet(wb: Workbook, name: string): Worksheet {
  const sheet = wb.getWorksheet(name);
  if (!sheet) throw new MonthlyReportStructureError(`sheet "${name}" not found`);
  return sheet;
}

/**
 * Safe replacement for `cell.text` — exceljs's own `MergeValue.toString()` unconditionally does
 * `this.value.toString()` with no null check, so reading `.text` off a merged-but-blank cell
 * throws `Cannot read properties of null`. Confirmed crashing against the real finished report's
 * ticket-summary area. Every cell-text read in this module should go through this instead.
 */
function safeCellText(cell: ExcelJS.Cell): string {
  if (cell.isMerged && cell.master.value === null) return '';
  return cell.text;
}

function rowTexts(sheet: Worksheet, row: number, startCol: number, endCol: number): string[] {
  const r = sheet.getRow(row);
  const out: string[] = [];
  for (let c = startCol; c <= endCol; c++) out.push(safeCellText(r.getCell(c)).trim());
  return out;
}

function headersEqual(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((h, i) => h === expected[i]);
}

/** The 5 fixed sheets exist, in order, with the header rows this module hard-codes column offsets against. Event sheets (position 6+) are recognized by position alone, never by name. */
function validateStructure(wb: Workbook): void {
  const names = wb.worksheets.map((s) => s.name);
  for (let i = 0; i < FIXED_SHEET_NAMES.length; i++) {
    if (names[i] !== FIXED_SHEET_NAMES[i]) {
      throw new MonthlyReportStructureError(
        `expected sheet ${i + 1} to be "${FIXED_SHEET_NAMES[i]}", found "${names[i] ?? '(none)'}"`,
      );
    }
  }
  const expenseHeaders = rowTexts(requireSheet(wb, SHEET.EXPENSE), EXPENSE.headerRow, 1, EXPENSE.headers.length);
  if (!headersEqual(expenseHeaders, EXPENSE.headers)) {
    throw new MonthlyReportStructureError(`${SHEET.EXPENSE} row ${EXPENSE.headerRow} headers changed`);
  }
  const artistHeaders = rowTexts(requireSheet(wb, SHEET.ARTISTS), ARTISTS.headerRow, 1, ARTISTS.headers.length);
  if (!headersEqual(artistHeaders, ARTISTS.headers)) {
    throw new MonthlyReportStructureError(`${SHEET.ARTISTS} row ${ARTISTS.headerRow} headers changed`);
  }
  const monthlyHeaders = rowTexts(requireSheet(wb, SHEET.MONTHLIES), MONTHLIES.headerRow, 1, MONTHLIES.headers.length);
  if (!headersEqual(monthlyHeaders, MONTHLIES.headers)) {
    throw new MonthlyReportStructureError(`${SHEET.MONTHLIES} row ${MONTHLIES.headerRow} headers changed`);
  }
  const summaryHeaders = rowTexts(
    requireSheet(wb, SHEET.SUMMARY),
    SUMMARY_TABLE.headerRow,
    SUMMARY_TABLE.firstCol,
    SUMMARY_TABLE.firstCol + SUMMARY_TABLE.columns.length - 1,
  );
  if (!headersEqual(summaryHeaders, SUMMARY_TABLE.columns)) {
    throw new MonthlyReportStructureError(
      `${SHEET.SUMMARY} driving table headers (row ${SUMMARY_TABLE.headerRow}) changed`,
    );
  }
}

function eventSheets(wb: Workbook): Worksheet[] {
  return wb.worksheets.slice(FIXED_SHEET_NAMES.length);
}

// A sheet's slot (which row of the driving table feeds it) is baked into its own B3 formula
// at template-creation time and never changes — NOT its current tab position. Confirmed against
// a real filled-and-reordered report: after Idan reorders event tabs into chronological order,
// tab position no longer lines up with slot at all (e.g. the sheet renamed "2.08" ended up 1st
// in tab order but still reads row 49 = slot 3; "11.08" ended up 3rd but reads row 47 = slot 1).
// Recover the true slot by parsing the row number back out of that same formula.
const SLOT_ANCHOR_CELL = 'B3';
const SLOT_ANCHOR_FORMULA_RE = new RegExp(`'${SHEET.SUMMARY}'!D(\\d+)`);

function detectSlot(sheet: Worksheet): number | undefined {
  const cellValue = sheet.getCell(SLOT_ANCHOR_CELL).value;
  const formula =
    cellValue && typeof cellValue === 'object' && 'formula' in cellValue
      ? (cellValue as { formula: string }).formula
      : undefined;
  const row = formula ? Number(SLOT_ANCHOR_FORMULA_RE.exec(formula)?.[1]) : NaN;
  const slot = row - SUMMARY_TABLE.firstDataRow + 1;
  return Number.isInteger(slot) && slot >= 1 && slot <= NUM_EVENT_SLOTS ? slot : undefined;
}

/**
 * Xternal (Excel's month-end finalize macro, not replicated here — see this
 * file's header comment) bakes every event sheet's B3 anchor formula down to
 * its evaluated date. Confirmed against a real "סופי" (finalized) report: B3
 * was a plain Date on every event sheet, so `detectSlot`'s formula parse
 * found nothing at all. Recover the slot by matching that baked date back to
 * the driving table's own תאריך column, which Xternal leaves untouched.
 * Ambiguous (two rows/sheets sharing a date) or unmatched dates return
 * undefined rather than guessing.
 */
function detectSlotFromBakedDate(wb: Workbook, sheet: Worksheet): number | undefined {
  const cellValue = sheet.getCell(SLOT_ANCHOR_CELL).value;
  if (!(cellValue instanceof Date)) return undefined;
  const summary = requireSheet(wb, SHEET.SUMMARY);
  let match: number | undefined;
  for (let slot = 1; slot <= NUM_EVENT_SLOTS; slot++) {
    const rowDate = summary.getRow(SUMMARY_TABLE.firstDataRow + slot - 1).getCell(SUMMARY_TABLE.firstCol).value;
    if (rowDate instanceof Date && rowDate.getTime() === cellValue.getTime()) {
      if (match !== undefined) return undefined;
      match = slot;
    }
  }
  return match;
}

function detectSlotForSheet(wb: Workbook, sheet: Worksheet): number | undefined {
  return detectSlot(sheet) ?? detectSlotFromBakedDate(wb, sheet);
}

/** Find the physical event sheet that currently owns a slot — by formula (or, for a finalized report, by baked date), not by name/position, so this keeps working after renaming/reordering. */
function resolveEventSheetForSlot(wb: Workbook, slot: number): Worksheet {
  const sheet = eventSheets(wb).find((s) => detectSlotForSheet(wb, s) === slot);
  if (!sheet) throw new MonthlyReportValidationError(`no event sheet currently resolves to slot ${slot}`);
  return sheet;
}

// ---------------------------------------------------------------------------
// סיכום חודשי — the manual driving table (B46:AI76 on the real template).
// Column B ("Column1") and C ("שם גיליון") are pre-filled scaffolding
// (row-index labels, e.g. "LinkA7" / "7") that nothing reads — every real
// formula pulls from D onward. Row 46+N feeds event sheet slot N via fixed
// cell references baked into that slot's own formulas at template-creation
// time — feeding is by ROW POSITION, permanently, regardless of what the
// Nth event sheet is later renamed to. So "slot" here always means "row
// 46+slot in this table", which is also "the sheet that is currently the
// Nth sheet after the 5 fixed ones" ONLY on a fresh copy of the template
// (before any of this month's renames/reorders) — write eventRows before
// renaming, using the sheet's still-original "אירוע<slot>" identity.
// ---------------------------------------------------------------------------
const SUMMARY_TABLE = {
  headerRow: 46,
  firstDataRow: 47,
  firstCol: 4, // D
  columns: [
    'תאריך',
    'יישוב',
    'מקום',
    'מפיק',
    'הצגה',
    'גורם מזמין',
    'קהל',
    'שעה',
    'סך דרישה',
    'עבור',
    'כתובת',
    'מייל',
    'איש קשר',
    'טלפון',
    ...Array.from({ length: 18 }, (_, i) => `משתתף ${i + 1}`),
  ],
};

// Every other summary-table column stays text on write — see writeEventRow.
const NUMERIC_SUMMARY_COLUMNS = new Set(['קהל', 'סך דרישה']);
// תאריך/שעה are the only date/time-typed columns — everything else round-trips as plain
// strings. Confirmed against a real filled report: exceljs's cell.text does NOT apply numFmt
// to a Date-valued cell, it falls back to the JS Date's own (locale/historical-timezone-quirky)
// toString() — e.g. a plain 20:30 שעה cell reads back as "Sat Dec 30 1899 22:50:40 GMT+0220
// (Israel Standard Time)" verbatim. Format/parse these two by hand instead of trusting .text.
const DATE_COLUMN = 'תאריך';
const TIME_COLUMN = 'שעה';
// Excel (and exceljs) store a time-only value as a fraction of a day added onto this same
// epoch date — a cell legitimately meaning "this business happened on 30 Dec 1899" doesn't
// occur in this report, so landing exactly on this date/UTC-midnight combination reliably
// means "time-only, ignore the date part."
const EXCEL_TIME_ONLY_EPOCH = { year: 1899, month: 11, date: 30 };

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** תאריך/שעה-aware replacement for `cell.text` — see DATE_COLUMN/TIME_COLUMN above. */
function formatSummaryCellText(header: string, cell: ExcelJS.Cell): string {
  if ((header === DATE_COLUMN || header === TIME_COLUMN) && cell.value instanceof Date) {
    const d = cell.value;
    const isTimeOnly =
      d.getUTCFullYear() === EXCEL_TIME_ONLY_EPOCH.year &&
      d.getUTCMonth() === EXCEL_TIME_ONLY_EPOCH.month &&
      d.getUTCDate() === EXCEL_TIME_ONLY_EPOCH.date;
    if (isTimeOnly || header === TIME_COLUMN) return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  }
  return safeCellText(cell).trim();
}

/** Parses a "dd/mm/yyyy" (תאריך) or "HH:mm" (שעה) string into the same Date shape Excel itself would store, so the workbook's own date/time formatting keeps working. Falls back to writing the raw string for anything that doesn't parse — better a visibly-wrong cell than a silently-dropped value. */
function parseSummaryCellValue(header: string, value: string): string | Date {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (header === DATE_COLUMN) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
    if (m) return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  }
  if (header === TIME_COLUMN) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (m) {
      return new Date(
        Date.UTC(
          EXCEL_TIME_ONLY_EPOCH.year,
          EXCEL_TIME_ONLY_EPOCH.month,
          EXCEL_TIME_ONLY_EPOCH.date,
          Number(m[1]),
          Number(m[2]),
        ),
      );
    }
  }
  return value;
}

const EXPENSE = {
  headerRow: 3,
  headers: ['מספר', 'artist_name', 'אישורי מס', 'סטטוס', 'אחוז ניכוי', 'תאריך', 'פואטרי סלאם חודשי'],
  artistNameCol: 2, // B
  sensitiveCols: { taxId: 3, status: 4 }, // C, D — INDEX/MATCH off ARTISTS, never written directly
  firstEventCol: 8, // H
  lastDataRow: 82, // matches the VBA's `expesnseArtists = "B4:B82"` constant
};

const ARTISTS = {
  headerRow: 1,
  headers: ['משתתף', 'ת.ז.', 'מעמד', 'אימייל', '', 'מקבלי תשלום', 'Name', 'Type', 'Email', 'Amount'],
  nameCol: 1, // A
  sensitiveCols: { id: 2, status: 3, email: 4 }, // B, C, D — the only manually-authored columns
};

const MONTHLIES = {
  headerRow: 3,
  headers: ['משתתפים', 'תפקיד', 'תשלום', 'פירוט', 'ת.ז', 'סטטוס', 'שכר'],
  nameCol: 1,
  sensitiveCols: { id: 5, status: 6 }, // E, F — formulas off EXPENSE, read-only here
  firstDataRow: 4,
  lastDataRow: 29, // matches the VBA's `monthlyPaymentSheet` scan bound (counter2 = 4 To 29)
};

// --- Per-event-sheet manual regions. Everything else on an event sheet is fed by formula from
// the driving table (see writeEventRow) and must never be written directly. These three regions
// are the actual manual-entry surface: A33 (freeform note), B54:E79 (ticket sales), D34:G40
// (venue-payment override). Confirmed against two real filled event sheets: A33 is genuinely
// blank by default and is exactly where Idan puts ad-hoc notes ("please quote PO #...", "this
// continues June's report"), and B34 was manually retitled from the template's default
// "דרישת תשלום" to "סיכום הכנסות" in one of them. D34:G40 was blank in both real examples (the
// payment-TO-the-venue direction is the uncommon case — most events only need the auto-filled
// A34:B40 "money owed to Idan" block, which stays formula-driven and is never written here) —
// its exact real-world shape is inferred from the blank template's layout only, not yet
// validated against a filled example.
const EVENT_NOTE_CELL = 'A33';

const TICKET_PRICE_COL = 3; // C
const TICKET_QUANTITY_COL = 4; // D
const TICKET_SECTIONS = {
  cash: { label: 'מזומן קופה', rows: [58, 59, 60] },
  dayOfCredit: { label: 'אשראי קופה', rows: [62, 63, 64] },
  presaleViaVenue: { label: 'מקום - אשראי מכירה מוקדמת', rows: [66, 67, 68] },
  presale: { label: 'מכירה מוקדמת', rows: [72, 73, 74] },
} as const;
const TICKET_COMMISSION_TOTAL_CELL = 'E76'; // "סה"כ עמלות" — entered directly, not price*quantity
const TICKET_COMPLIMENTARY_ROW = 78; // "מוזמנים" (comp/invited) — C/D, revenue always shows 0 regardless per the template's own formula

const VENUE_PAYMENT = {
  firstRow: 35,
  lastRow: 40, // על סך / עבור / כתובת / מייל / איש קשר / טלפון
  firstCol: 4, // D
  lastCol: 7, // G
};

function coerceNumericIfPossible(value: string): string | number {
  const n = Number(value);
  return value.trim() !== '' && Number.isFinite(n) ? n : value;
}

export interface MonthlyReportSnapshot {
  /** slot is null only if this sheet's row-anchor formula was itself edited/removed — a structural anomaly worth flagging, not something to guess past. */
  eventSheets: { slot: number | null; name: string }[];
  summaryRows: { slot: number; values: Record<string, string> }[];
  artists: {
    row: number;
    name: string;
    id: string;
    status: string;
    email: string;
    payeeName: string;
    payeeType: string;
    payeeEmail: string;
    amount: string;
  }[];
  monthlies: {
    row: number;
    name: string;
    role: string;
    paymentType: string;
    detail: string;
    idNumber: string;
    status: string;
    salary: string;
  }[];
  /** One entry per used slot (matching summaryRows) — the manual regions of that slot's event sheet. None of this is sensitive. */
  eventDetails: {
    slot: number;
    note: string;
    ticketSummary: Record<keyof typeof TICKET_SECTIONS, { price: string; quantity: string }[]>;
    commissionTotal: string;
    complimentary: { price: string; quantity: string };
    venuePaymentTitle: string;
    /** Rows 35-40 (על סך/עבור/כתובת/מייל/איש קשר/טלפון), columns D-G, as raw text — blank in both real examples seen so far, see VENUE_PAYMENT comment. */
    venuePaymentRows: string[][];
  }[];
}

/** Read the workbook's current state, anonymizing every sensitive column. Never touches הכנסות. */
function readEventDetails(sheet: Worksheet): Omit<MonthlyReportSnapshot['eventDetails'][number], 'slot'> {
  const ticketSummary = Object.fromEntries(
    (Object.keys(TICKET_SECTIONS) as (keyof typeof TICKET_SECTIONS)[]).map((key) => [
      key,
      TICKET_SECTIONS[key].rows.map((r) => ({
        price: safeCellText(sheet.getRow(r).getCell(TICKET_PRICE_COL)).trim(),
        quantity: safeCellText(sheet.getRow(r).getCell(TICKET_QUANTITY_COL)).trim(),
      })),
    ]),
  ) as Record<keyof typeof TICKET_SECTIONS, { price: string; quantity: string }[]>;

  const venuePaymentRows: string[][] = [];
  for (let r = VENUE_PAYMENT.firstRow; r <= VENUE_PAYMENT.lastRow; r++) {
    const row: string[] = [];
    for (let c = VENUE_PAYMENT.firstCol; c <= VENUE_PAYMENT.lastCol; c++)
      row.push(safeCellText(sheet.getRow(r).getCell(c)).trim());
    venuePaymentRows.push(row);
  }

  return {
    note: safeCellText(sheet.getCell(EVENT_NOTE_CELL)).trim(),
    ticketSummary,
    commissionTotal: safeCellText(sheet.getCell(TICKET_COMMISSION_TOTAL_CELL)).trim(),
    complimentary: {
      price: safeCellText(sheet.getRow(TICKET_COMPLIMENTARY_ROW).getCell(TICKET_PRICE_COL)).trim(),
      quantity: safeCellText(sheet.getRow(TICKET_COMPLIMENTARY_ROW).getCell(TICKET_QUANTITY_COL)).trim(),
    },
    venuePaymentTitle: safeCellText(sheet.getCell('A34')).trim(),
    venuePaymentRows,
  };
}

/** Every slot with at least one non-empty driving-table field — the single source of truth for "used", shared by the read snapshot and by autoFinalize's rename/reorder pass below. */
function getUsedSummaryRows(wb: Workbook): MonthlyReportSnapshot['summaryRows'] {
  const summary = requireSheet(wb, SHEET.SUMMARY);
  const summaryRows: MonthlyReportSnapshot['summaryRows'] = [];
  for (let slot = 1; slot <= NUM_EVENT_SLOTS; slot++) {
    const row = summary.getRow(SUMMARY_TABLE.firstDataRow + slot - 1);
    const values: Record<string, string> = {};
    let hasValue = false;
    SUMMARY_TABLE.columns.forEach((header, idx) => {
      const text = formatSummaryCellText(header, row.getCell(SUMMARY_TABLE.firstCol + idx));
      if (text) hasValue = true;
      values[header] = text;
    });
    if (hasValue) summaryRows.push({ slot, values });
  }
  return summaryRows;
}

export async function readMonthlyReportFromBytes(
  bytes: Buffer,
  store?: AnonymizationStore,
): Promise<MonthlyReportSnapshot> {
  assertWithinSizeCap(bytes);
  const wb = await loadWorkbook(bytes);
  validateStructure(wb);

  const slots = eventSheets(wb).map((sheet) => ({ slot: detectSlotForSheet(wb, sheet) ?? null, name: sheet.name }));
  const summaryRows = getUsedSummaryRows(wb);

  const artistsSheet = requireSheet(wb, SHEET.ARTISTS);
  const artists: MonthlyReportSnapshot['artists'] = [];
  for (let r = ARTISTS.headerRow + 1; r <= artistsSheet.rowCount; r++) {
    const row = artistsSheet.getRow(r);
    const name = safeCellText(row.getCell(ARTISTS.nameCol)).trim();
    if (!name) continue;
    artists.push({
      row: r,
      name,
      id: anonymizeCellValue(safeCellText(row.getCell(ARTISTS.sensitiveCols.id)), store),
      status: anonymizeCellValue(safeCellText(row.getCell(ARTISTS.sensitiveCols.status)), store),
      email: anonymizeCellValue(safeCellText(row.getCell(ARTISTS.sensitiveCols.email)), store),
      payeeName: safeCellText(row.getCell(7)).trim(),
      payeeType: anonymizeCellValue(safeCellText(row.getCell(8)), store),
      payeeEmail: anonymizeCellValue(safeCellText(row.getCell(9)), store),
      amount: safeCellText(row.getCell(10)).trim(),
    });
  }

  const monthliesSheet = requireSheet(wb, SHEET.MONTHLIES);
  const monthlies: MonthlyReportSnapshot['monthlies'] = [];
  for (let r = MONTHLIES.firstDataRow; r <= MONTHLIES.lastDataRow; r++) {
    const row = monthliesSheet.getRow(r);
    const name = safeCellText(row.getCell(MONTHLIES.nameCol)).trim();
    if (!name) continue;
    monthlies.push({
      row: r,
      name,
      role: safeCellText(row.getCell(2)).trim(),
      paymentType: safeCellText(row.getCell(3)).trim(),
      detail: safeCellText(row.getCell(4)).trim(),
      idNumber: anonymizeCellValue(safeCellText(row.getCell(MONTHLIES.sensitiveCols.id)), store),
      status: anonymizeCellValue(safeCellText(row.getCell(MONTHLIES.sensitiveCols.status)), store),
      salary: safeCellText(row.getCell(7)).trim(),
    });
  }

  const eventDetails: MonthlyReportSnapshot['eventDetails'] = summaryRows.map(({ slot }) => ({
    slot,
    ...readEventDetails(resolveEventSheetForSlot(wb, slot)),
  }));

  return { eventSheets: slots, summaryRows, artists, monthlies, eventDetails };
}

export interface ArtistPaymentRow {
  name: string;
  email: string;
  payeeName: string;
  payeeEmail: string;
  amount: string;
}

/**
 * Raw (never anonymized) artist rows, for the artist-payment-drafts mail-merge pipeline only —
 * that pipeline runs entirely inside this process and creates Gmail drafts directly, so it needs
 * real email addresses, unlike readMonthlyReportFromBytes above (whose output is meant for the
 * agent's eyes and anonymizes email/id/status columns). Do not reuse this for anything that
 * returns to the container.
 */
export async function readArtistPaymentRowsFromBytes(bytes: Buffer): Promise<ArtistPaymentRow[]> {
  assertWithinSizeCap(bytes);
  const wb = await loadWorkbook(bytes);
  validateStructure(wb);

  const artistsSheet = requireSheet(wb, SHEET.ARTISTS);
  const rows: ArtistPaymentRow[] = [];
  for (let r = ARTISTS.headerRow + 1; r <= artistsSheet.rowCount; r++) {
    const row = artistsSheet.getRow(r);
    const name = safeCellText(row.getCell(ARTISTS.nameCol)).trim();
    if (!name) continue;
    rows.push({
      name,
      email: safeCellText(row.getCell(ARTISTS.sensitiveCols.email)).trim(),
      payeeName: safeCellText(row.getCell(7)).trim(),
      payeeEmail: safeCellText(row.getCell(9)).trim(),
      amount: safeCellText(row.getCell(10)).trim(),
    });
  }
  return rows;
}

export interface EventRowInput {
  /** 1..30 — row 46+slot in סיכום חודשי, and (before any renaming this session) the sheet currently named `אירוע<slot>`. */
  slot: number;
  /** Exactly 32 values, in SUMMARY_TABLE.columns order (תאריך.. then משתתף 1..18). */
  values: string[];
}

export interface ArtistUpsert {
  name: string;
  id?: string;
  status?: string;
  email?: string;
}

export interface TicketLineInput {
  price?: string;
  quantity?: string;
}

export interface TicketSummaryInput {
  /** Up to 3 lines each — matches the template's fixed 3-row layout per channel. Only the fields/lines given are written; anything omitted is left as-is (never cleared). */
  cash?: TicketLineInput[];
  dayOfCredit?: TicketLineInput[];
  presaleViaVenue?: TicketLineInput[];
  presale?: TicketLineInput[];
  /** "סה"כ עמלות" — entered directly, not price*quantity. */
  commissionTotal?: string;
  /** "מוזמנים" (comp/invited tickets) — revenue always shows 0 regardless, per the template's own formula. */
  complimentary?: TicketLineInput;
}

export interface VenuePaymentInput {
  /** Sets both A34 and B34 — the section title, default "דרישת תשלום". */
  title?: string;
  /** Rows 35-40 (על סך/עבור/כתובת/מייל/איש קשר/טלפון), each up to 4 cells (columns D-G). Omit a row, or a cell within a row, to leave it untouched. */
  rows?: (string | undefined)[][];
}

export interface EventSheetEdit {
  /** Which event this targets — resolved by the sheet's own row-anchor formula, so this keeps working after the sheet has been renamed/reordered. */
  slot: number;
  ticketSummary?: TicketSummaryInput;
  venuePayment?: VenuePaymentInput;
  /** Freeform text (A33) — the one place notes like "please quote PO #..." actually go on this template. */
  note?: string;
}

export interface MonthlyReportChanges {
  artists?: ArtistUpsert[];
  eventRows?: EventRowInput[];
  eventSheetEdits?: EventSheetEdit[];
}

function upsertArtist(wb: Workbook, entry: ArtistUpsert, store?: AnonymizationStore): void {
  const sheet = requireSheet(wb, SHEET.ARTISTS);
  const name = entry.name.trim();
  if (!name) throw new MonthlyReportValidationError('artist name is required');

  let targetRow: number | undefined;
  for (let r = ARTISTS.headerRow + 1; r <= sheet.rowCount; r++) {
    if (safeCellText(sheet.getRow(r).getCell(ARTISTS.nameCol)).trim() === name) {
      targetRow = r;
      break;
    }
  }
  if (targetRow === undefined) {
    targetRow = sheet.rowCount + 1;
    sheet.getRow(targetRow).getCell(ARTISTS.nameCol).value = name;
  }

  const row = sheet.getRow(targetRow);
  if (entry.id !== undefined) row.getCell(ARTISTS.sensitiveCols.id).value = deanonymizeText(entry.id, store);
  if (entry.status !== undefined)
    row.getCell(ARTISTS.sensitiveCols.status).value = deanonymizeText(entry.status, store);
  if (entry.email !== undefined) row.getCell(ARTISTS.sensitiveCols.email).value = deanonymizeText(entry.email, store);
}

function writeEventRow(wb: Workbook, input: EventRowInput): void {
  if (!Number.isInteger(input.slot) || input.slot < 1 || input.slot > NUM_EVENT_SLOTS) {
    throw new MonthlyReportValidationError(`slot ${input.slot} is out of range (1-${NUM_EVENT_SLOTS})`);
  }
  if (input.values.length !== SUMMARY_TABLE.columns.length) {
    throw new MonthlyReportValidationError(
      `event row for slot ${input.slot} has ${input.values.length} values, expected ${SUMMARY_TABLE.columns.length}`,
    );
  }
  const sheet = requireSheet(wb, SHEET.SUMMARY);
  const row = sheet.getRow(SUMMARY_TABLE.firstDataRow + input.slot - 1);
  input.values.forEach((value, idx) => {
    const col = SUMMARY_TABLE.firstCol + idx;
    // Only קהל (audience count) and סך דרישה (amount) are meant to be numeric — the
    // downstream ">0" formulas on the event sheets need real numbers there. Everything else
    // (טלפון especially) must stay text: a phone number's leading zero must never silently
    // become a number, the same rule excel-reports.ts applies to its sensitive columns.
    const header = SUMMARY_TABLE.columns[idx];
    if (NUMERIC_SUMMARY_COLUMNS.has(header)) {
      row.getCell(col).value = coerceNumericIfPossible(value);
    } else if (header === DATE_COLUMN || header === TIME_COLUMN) {
      row.getCell(col).value = parseSummaryCellValue(header, value);
    } else {
      row.getCell(col).value = value;
    }
  });
}

function writeTicketSummary(sheet: Worksheet, input: TicketSummaryInput): void {
  (Object.keys(TICKET_SECTIONS) as (keyof typeof TICKET_SECTIONS)[]).forEach((key) => {
    const lines = input[key];
    if (!lines) return;
    const rows = TICKET_SECTIONS[key].rows;
    if (lines.length > rows.length) {
      throw new MonthlyReportValidationError(
        `ticketSummary.${key} accepts at most ${rows.length} lines, got ${lines.length}`,
      );
    }
    lines.forEach((line, i) => {
      const row = sheet.getRow(rows[i]);
      if (line.price !== undefined) row.getCell(TICKET_PRICE_COL).value = coerceNumericIfPossible(line.price);
      if (line.quantity !== undefined) row.getCell(TICKET_QUANTITY_COL).value = coerceNumericIfPossible(line.quantity);
    });
  });
  if (input.commissionTotal !== undefined) {
    sheet.getCell(TICKET_COMMISSION_TOTAL_CELL).value = coerceNumericIfPossible(input.commissionTotal);
  }
  if (input.complimentary) {
    const row = sheet.getRow(TICKET_COMPLIMENTARY_ROW);
    if (input.complimentary.price !== undefined)
      row.getCell(TICKET_PRICE_COL).value = coerceNumericIfPossible(input.complimentary.price);
    if (input.complimentary.quantity !== undefined) {
      row.getCell(TICKET_QUANTITY_COL).value = coerceNumericIfPossible(input.complimentary.quantity);
    }
  }
}

function writeVenuePayment(sheet: Worksheet, input: VenuePaymentInput): void {
  if (input.title !== undefined) {
    sheet.getCell('A34').value = input.title;
    sheet.getCell('B34').value = input.title;
  }
  const maxRows = VENUE_PAYMENT.lastRow - VENUE_PAYMENT.firstRow + 1;
  const maxCols = VENUE_PAYMENT.lastCol - VENUE_PAYMENT.firstCol + 1;
  if (input.rows) {
    if (input.rows.length > maxRows) {
      throw new MonthlyReportValidationError(
        `venuePayment.rows accepts at most ${maxRows} rows, got ${input.rows.length}`,
      );
    }
    input.rows.forEach((cells, i) => {
      if (cells.length > maxCols) {
        throw new MonthlyReportValidationError(
          `venuePayment.rows[${i}] accepts at most ${maxCols} columns, got ${cells.length}`,
        );
      }
      const row = sheet.getRow(VENUE_PAYMENT.firstRow + i);
      cells.forEach((value, j) => {
        if (value !== undefined) row.getCell(VENUE_PAYMENT.firstCol + j).value = value;
      });
    });
  }
}

function writeEventSheetEdit(wb: Workbook, edit: EventSheetEdit): void {
  const sheet = resolveEventSheetForSlot(wb, edit.slot);
  if (edit.ticketSummary) writeTicketSummary(sheet, edit.ticketSummary);
  if (edit.venuePayment) writeVenuePayment(sheet, edit.venuePayment);
  if (edit.note !== undefined) sheet.getCell(EVENT_NOTE_CELL).value = edit.note;
}

function reorderEventSheets(wb: Workbook, desiredOrder: string[]): void {
  const allSheets = wb.worksheets;
  const fixed = allSheets.slice(0, FIXED_SHEET_NAMES.length);
  const events = allSheets.slice(FIXED_SHEET_NAMES.length);
  const byName = new Map(events.map((s) => [s.name, s]));

  const seen = new Set<string>();
  for (const name of desiredOrder) {
    if (seen.has(name)) throw new MonthlyReportValidationError(`"${name}" appears twice in reorderSheets`);
    seen.add(name);
    if (!byName.has(name)) throw new MonthlyReportValidationError(`"${name}" is not a current event sheet`);
  }

  const remaining = events.filter((s) => !seen.has(s.name));
  const newOrder = [...fixed, ...desiredOrder.map((n) => byName.get(n)!), ...remaining];
  // exceljs's own .d.ts omits `orderNo` even though workbook.model reads it directly off each
  // worksheet to decide xlsx tab order (lib/doc/workbook.js) — cast at this one boundary.
  newOrder.forEach((sheet, i) => {
    (sheet as unknown as { orderNo: number }).orderNo = i;
  });
}

function cellNumericResult(cell: ExcelJS.Cell): number | undefined {
  const v = cell.value;
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'result' in v && typeof (v as { result?: unknown }).result === 'number') {
    return (v as { result: number }).result;
  }
  return undefined;
}

/**
 * Ports the VBA `Que` macro (Module2: Sheetsplace + Nameing + Depeople +
 * Byname, in that order) into plain workbook edits — no VBA execution
 * needed. Run this after eventRows / renameSheets / reorderSheets so
 * הוצאות stays consistent with whatever the event sheets now say.
 */
function runQueSync(wb: Workbook): void {
  const income = requireSheet(wb, SHEET.INCOME);
  const expense = requireSheet(wb, SHEET.EXPENSE);
  const monthlies = requireSheet(wb, SHEET.MONTHLIES);
  const events = eventSheets(wb);

  // --- Sheetsplace: הוצאות!row2 (H2:AK2) = current event sheet names, in current tab order.
  events.forEach((sheet, i) => {
    expense.getRow(2).getCell(EXPENSE.firstEventCol + i).value = sheet.name;
  });

  // --- Nameing: relabel הוצאות!row3 headers to "<show> <place>" from הכנסות, skipping any
  // column already reading "totals". Faithfully mirrors the VBA's own loop bound (events
  // 1-29 only — event 30's header is never relabeled by Que in the original workbook either).
  for (let i = 0; i < Math.min(events.length, 29); i++) {
    const col = EXPENSE.firstEventCol + i;
    const current = safeCellText(expense.getRow(3).getCell(col)).trim();
    if (current === 'totals') continue;
    const show = safeCellText(income.getRow(2 + i).getCell(3)).trim();
    const place = safeCellText(income.getRow(2 + i).getCell(5)).trim();
    expense.getRow(3).getCell(col).value = `${show} ${place}`;
  }

  // --- Depeople: any artist paid in an event sheet (A11:E28: name/role/id/status/fee) or in
  // תשלומים חודשיים (name/../../../id/status/fee) who isn't already an expense artist_name row
  // gets appended. "Already resolved" (id column is numeric) means Excel already matched them —
  // Depeople only adds names that don't resolve yet.
  const existingNames = new Set<string>();
  let nextFreeRow = EXPENSE.headerRow;
  for (let r = EXPENSE.headerRow + 1; r <= EXPENSE.lastDataRow; r++) {
    const name = safeCellText(expense.getRow(r).getCell(EXPENSE.artistNameCol)).trim();
    if (name) {
      existingNames.add(name);
      nextFreeRow = r;
    }
  }
  nextFreeRow += 1;

  function maybeAddArtist(name: string): void {
    const trimmed = name.trim();
    if (!trimmed || existingNames.has(trimmed)) return;
    expense.getRow(nextFreeRow).getCell(EXPENSE.artistNameCol).value = trimmed;
    existingNames.add(trimmed);
    nextFreeRow += 1;
  }

  for (const sheet of events) {
    for (let r = 11; r <= 28; r++) {
      const row = sheet.getRow(r);
      const name = safeCellText(row.getCell(1)).trim();
      const idResolved = cellNumericResult(row.getCell(3)) !== undefined;
      const fee = cellNumericResult(row.getCell(5));
      if (name && !idResolved && fee !== undefined && fee > 0) maybeAddArtist(name);
    }
  }
  for (let r = MONTHLIES.firstDataRow; r <= MONTHLIES.lastDataRow; r++) {
    const row = monthlies.getRow(r);
    const name = safeCellText(row.getCell(MONTHLIES.nameCol)).trim();
    const idResolved = cellNumericResult(row.getCell(MONTHLIES.sensitiveCols.id)) !== undefined;
    const salary = cellNumericResult(row.getCell(7));
    if (name && !idResolved && salary !== undefined && salary > 0) maybeAddArtist(name);
  }

  // --- Byname: sort the expense table by artist_name. `artist_name` (column B) is the only
  // manually-authored cell in each row — every other column is a structured-reference formula
  // ("expense[[#This Row],[artist_name]]") that already follows whichever name sits in its own
  // row, so sorting is just reordering the names themselves, nothing else needs to move.
  const names: string[] = [];
  for (let r = EXPENSE.headerRow + 1; r <= EXPENSE.lastDataRow; r++) {
    const name = safeCellText(expense.getRow(r).getCell(EXPENSE.artistNameCol)).trim();
    if (name) names.push(name);
  }
  names.sort((a, b) => a.localeCompare(b, 'he'));
  names.forEach((name, i) => {
    const cell = expense.getRow(EXPENSE.headerRow + 1 + i).getCell(EXPENSE.artistNameCol);
    cell.value = name;
    cell.font = { ...cell.font, bold: true };
  });
}

/** This workbook's own event-sheet naming convention — day unpadded, month zero-padded (matches every real sheet seen: "2.08", "11.08", "23.08"). */
function dateToSheetName(date: Date): string {
  return `${date.getUTCDate()}.${pad2(date.getUTCMonth() + 1)}`;
}

/** Appends " (2)", " (3)", ... until `base` doesn't collide with a different sheet — two events landing on the same date is rare but not impossible. */
function uniqueSheetName(wb: Workbook, base: string, sheet: Worksheet): string {
  let candidate = base;
  for (let n = 2; wb.getWorksheet(candidate) && wb.getWorksheet(candidate) !== sheet; n++) {
    candidate = `${base} (${n})`;
  }
  return candidate;
}

/**
 * Replaces the old agent-driven renameSheets/reorderSheets/runSync trio — called unconditionally
 * at the end of every apply, so the agent never has to sequence these itself. For every used slot
 * with a parseable תאריך, renames its event sheet to match (skipping slots with no date yet —
 * they keep their placeholder "אירוע<slot>" name) and reorders all dated event sheets
 * chronologically (undated/unused ones keep their existing relative order, appended after — see
 * reorderEventSheets). Always re-syncs הוצאות via runQueSync afterward.
 */
function autoFinalize(wb: Workbook): void {
  const dated: { name: string; date: Date }[] = [];

  for (const { slot, values } of getUsedSummaryRows(wb)) {
    const parsed = parseSummaryCellValue(DATE_COLUMN, values[DATE_COLUMN]);
    if (!(parsed instanceof Date)) continue; // no parseable date yet — leave this slot's sheet name alone
    const sheet = resolveEventSheetForSlot(wb, slot);
    const targetName = dateToSheetName(parsed);
    if (sheet.name !== targetName) sheet.name = uniqueSheetName(wb, targetName, sheet);
    dated.push({ name: sheet.name, date: parsed });
  }

  dated.sort((a, b) => a.date.getTime() - b.date.getTime());
  reorderEventSheets(
    wb,
    dated.map((d) => d.name),
  );
  runQueSync(wb);
}

/** Apply a batch of changes and return the new workbook bytes. Verifies everything before writing anything, same discipline as excel-reports.ts. */
export async function applyMonthlyReportChangesToBytes(
  bytes: Buffer,
  changes: MonthlyReportChanges,
  store?: AnonymizationStore,
): Promise<Buffer> {
  assertWithinSizeCap(bytes);
  const wb = await loadWorkbook(bytes);
  validateStructure(wb);

  for (const input of changes.eventRows ?? []) {
    if (!Number.isInteger(input.slot) || input.slot < 1 || input.slot > NUM_EVENT_SLOTS) {
      throw new MonthlyReportValidationError(`slot ${input.slot} is out of range (1-${NUM_EVENT_SLOTS})`);
    }
    if (input.values.length !== SUMMARY_TABLE.columns.length) {
      throw new MonthlyReportValidationError(
        `event row for slot ${input.slot} has ${input.values.length} values, expected ${SUMMARY_TABLE.columns.length}`,
      );
    }
  }
  for (const entry of changes.artists ?? []) {
    if (!entry.name.trim()) throw new MonthlyReportValidationError('artist name is required');
  }
  // Resolving up front (rather than discarding the result) both keeps the "verify everything
  // before writing anything" invariant — a bad slot in a later edit must never leave an earlier
  // one half-applied — and doubles as the touched-sheet tracking restoreUntouchedWorksheets needs.
  const touchedSheetIds = new Set<number>();
  for (const edit of changes.eventSheetEdits ?? []) touchedSheetIds.add(resolveEventSheetForSlot(wb, edit.slot).id);
  if (changes.artists?.length) touchedSheetIds.add(requireSheet(wb, SHEET.ARTISTS).id);
  if (changes.eventRows?.length) touchedSheetIds.add(requireSheet(wb, SHEET.SUMMARY).id);
  touchedSheetIds.add(requireSheet(wb, SHEET.EXPENSE).id); // autoFinalize always re-syncs it below

  for (const entry of changes.artists ?? []) upsertArtist(wb, entry, store);
  for (const input of changes.eventRows ?? []) writeEventRow(wb, input);
  for (const edit of changes.eventSheetEdits ?? []) writeEventSheetEdit(wb, edit);
  autoFinalize(wb);

  const written = Buffer.from(await wb.xlsx.writeBuffer());
  return reconcileWorkbookOutput(bytes, written, touchedSheetIds);
}
