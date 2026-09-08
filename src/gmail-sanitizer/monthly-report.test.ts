import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { AnonymizationStore, anonymizeCellValue, deanonymizeText } from './anonymize.js';
import {
  applyMonthlyReportChangesToBytes,
  MonthlyReportStructureError,
  MonthlyReportValidationError,
  readMonthlyReportFromBytes,
} from './monthly-report.js';

const EXPENSE_HEADERS = ['מספר', 'artist_name', 'אישורי מס', 'סטטוס', 'אחוז ניכוי', 'תאריך', 'פואטרי סלאם חודשי'];
const ARTIST_HEADERS = ['משתתף', 'ת.ז.', 'מעמד', 'אימייל', '', 'מקבלי תשלום', 'Name', 'Type', 'Email', 'Amount'];
const MONTHLY_HEADERS = ['משתתפים', 'תפקיד', 'תשלום', 'פירוט', 'ת.ז', 'סטטוס', 'שכר'];
const SUMMARY_HEADERS = [
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
];

interface BuildOptions {
  numEventSheets?: number;
  expenseHeaders?: string[];
  existingArtists?: [string, string, string, string][];
  monthlyRows?: [string, string, string, string, string, string, number][];
}

async function buildWorkbook(opts: BuildOptions = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('הכנסות');

  const expense = wb.addWorksheet('הוצאות');
  (opts.expenseHeaders ?? EXPENSE_HEADERS).forEach((h, i) => (expense.getRow(3).getCell(1 + i).value = h));
  expense.getRow(4).getCell(2).value = 'זיו הרמלין-שדר';
  expense.getRow(5).getCell(2).value = 'סטודיו';

  const summary = wb.addWorksheet('סיכום חודשי');
  SUMMARY_HEADERS.forEach((h, i) => (summary.getRow(46).getCell(4 + i).value = h));

  const artists = wb.addWorksheet('פרטי_אמנים');
  ARTIST_HEADERS.forEach((h, i) => (artists.getRow(1).getCell(1 + i).value = h));
  (opts.existingArtists ?? [['זיו הרמלין-שדר', '', '', '']]).forEach(([name, id, status, email], i) => {
    const row = artists.getRow(2 + i);
    row.getCell(1).value = name;
    row.getCell(2).value = id;
    row.getCell(3).value = status;
    row.getCell(4).value = email;
  });

  const monthlies = wb.addWorksheet('תשלומים חודשיים');
  MONTHLY_HEADERS.forEach((h, i) => (monthlies.getRow(3).getCell(1 + i).value = h));
  (opts.monthlyRows ?? []).forEach(([name, role, type, detail, id, status, salary], i) => {
    const row = monthlies.getRow(4 + i);
    row.getCell(1).value = name;
    row.getCell(2).value = role;
    row.getCell(3).value = type;
    row.getCell(4).value = detail;
    row.getCell(5).value = id;
    row.getCell(6).value = status;
    row.getCell(7).value = salary;
  });

  const numEvents = opts.numEventSheets ?? 2;
  for (let i = 1; i <= numEvents; i++) {
    const eventSheet = wb.addWorksheet(`אירוע${i}`);
    // B3's formula is what actually ties a physical sheet to its row-position slot (46+i),
    // permanently, independent of the sheet's current name or tab order — see detectSlot.
    eventSheet.getCell('B3').value = { formula: `IF('סיכום חודשי'!D${46 + i}="","",'סיכום חודשי'!D${46 + i})` };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('readMonthlyReportFromBytes', () => {
  it('rejects a workbook whose הוצאות headers have drifted', async () => {
    const bytes = await buildWorkbook({ expenseHeaders: ['wrong', 'headers'] });
    await expect(readMonthlyReportFromBytes(bytes)).rejects.toThrow(MonthlyReportStructureError);
  });

  it("lists event sheets in tab order, with slot derived from each sheet's own row-anchor formula", async () => {
    const bytes = await buildWorkbook({ numEventSheets: 3 });
    const snap = await readMonthlyReportFromBytes(bytes);
    expect(snap.eventSheets).toEqual([
      { slot: 1, name: 'אירוע1' },
      { slot: 2, name: 'אירוע2' },
      { slot: 3, name: 'אירוע3' },
    ]);
  });

  it('reports the correct slot per sheet even after tabs have been reordered — regression test: slot must never be inferred from tab position once reordering has happened, because it stops matching (found by cross-checking against a real Idan-filled-and-reordered report)', async () => {
    const bytes = await buildWorkbook({ numEventSheets: 3 });
    const renamed = await applyMonthlyReportChangesToBytes(bytes, {
      renameSheets: [
        { from: 'אירוע1', to: '20.08' },
        { from: 'אירוע2', to: '5.08' },
      ],
    });
    // Reorder puts slot-2 sheet ("5.08") before slot-1 sheet ("20.08") in tab order.
    const out = await applyMonthlyReportChangesToBytes(renamed, { reorderSheets: ['5.08', '20.08'] });
    const snap = await readMonthlyReportFromBytes(out);
    expect(snap.eventSheets).toEqual([
      { slot: 2, name: '5.08' },
      { slot: 1, name: '20.08' },
      { slot: 3, name: 'אירוע3' },
    ]);
  });

  it('anonymizes artist ת.ז/מעמד/אימייל but leaves the name in the clear', async () => {
    const bytes = await buildWorkbook({
      existingArtists: [['זיו הרמלין-שדר', '123456782', 'עצמאי', 'ziv@example.com']],
    });
    const snap = await readMonthlyReportFromBytes(bytes);
    const artist = snap.artists.find((a) => a.name === 'זיו הרמלין-שדר')!;
    expect(artist.id).toMatch(/^\[CELL_\d+\]$/);
    expect(artist.status).toMatch(/^\[CELL_\d+\]$/);
    expect(artist.email).toMatch(/^\[CELL_\d+\]$/);
  });

  it('anonymizes תשלומים חודשיים ת.ז/סטטוס only', async () => {
    const bytes = await buildWorkbook({
      monthlyRows: [['עידן אריאב', 'הפקה', 'קבוע', '', '123456782', 'עצמאי', 3000]],
    });
    const snap = await readMonthlyReportFromBytes(bytes);
    expect(snap.monthlies[0].idNumber).toMatch(/^\[CELL_\d+\]$/);
    expect(snap.monthlies[0].status).toMatch(/^\[CELL_\d+\]$/);
    expect(snap.monthlies[0].salary).toBe('3000');
  });
});

describe('applyMonthlyReportChangesToBytes — eventRows', () => {
  it('writes a full row into the right slot and never number-coerces non-numeric columns', async () => {
    const bytes = await buildWorkbook();
    const values = SUMMARY_HEADERS.map(() => '');
    values[SUMMARY_HEADERS.indexOf('טלפון')] = '0500000000';
    values[SUMMARY_HEADERS.indexOf('קהל')] = '50';

    const out = await applyMonthlyReportChangesToBytes(bytes, { eventRows: [{ slot: 1, values }] });
    const snap = await readMonthlyReportFromBytes(out);
    expect(snap.summaryRows[0].values['טלפון']).toBe('0500000000'); // leading zero preserved
    expect(snap.summaryRows[0].values['קהל']).toBe('50');
  });

  it('round-trips תאריך/שעה as real Excel date/time values, not text — regression test: exceljs\'s cell.text does not apply numFmt to a Date cell, so a naive read produced garbage like "Sat Dec 30 1899 22:50:40 GMT+0220" for a 20:30 שעה value (found by reading a real filled report)', async () => {
    const bytes = await buildWorkbook();
    const values = SUMMARY_HEADERS.map(() => '');
    values[SUMMARY_HEADERS.indexOf('תאריך')] = '11/08/2026';
    values[SUMMARY_HEADERS.indexOf('שעה')] = '20:30';

    const out = await applyMonthlyReportChangesToBytes(bytes, { eventRows: [{ slot: 1, values }] });
    const snap = await readMonthlyReportFromBytes(out);
    expect(snap.summaryRows[0].values['תאריך']).toBe('11/08/2026');
    expect(snap.summaryRows[0].values['שעה']).toBe('20:30');

    // and it must actually be a real Date cell underneath, matching what typing it into Excel would produce
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    const dateCell = wb.getWorksheet('סיכום חודשי')!.getRow(47).getCell(4);
    expect(dateCell.value).toBeInstanceOf(Date);
  });

  it('rejects an out-of-range slot', async () => {
    const bytes = await buildWorkbook();
    const values = SUMMARY_HEADERS.map(() => '');
    await expect(applyMonthlyReportChangesToBytes(bytes, { eventRows: [{ slot: 31, values }] })).rejects.toThrow(
      MonthlyReportValidationError,
    );
  });

  it('rejects a row with the wrong number of values', async () => {
    const bytes = await buildWorkbook();
    await expect(
      applyMonthlyReportChangesToBytes(bytes, { eventRows: [{ slot: 1, values: ['too', 'few'] }] }),
    ).rejects.toThrow(MonthlyReportValidationError);
  });
});

describe('applyMonthlyReportChangesToBytes — artists', () => {
  it('updates an existing artist by name match', async () => {
    const bytes = await buildWorkbook({ existingArtists: [['זיו הרמלין-שדר', '', '', '']] });
    const out = await applyMonthlyReportChangesToBytes(bytes, {
      artists: [{ name: 'זיו הרמלין-שדר', id: '123456782', status: 'עצמאי', email: 'ziv@example.com' }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    const row2 = wb.getWorksheet('פרטי_אמנים')!.getRow(2);
    expect(row2.getCell(2).text).toBe('123456782');
    expect(row2.getCell(3).text).toBe('עצמאי');
    expect(row2.getCell(4).text).toBe('ziv@example.com');
  });

  it('appends a new artist row when the name is not found', async () => {
    const bytes = await buildWorkbook({ existingArtists: [['זיו הרמלין-שדר', '', '', '']] });
    const out = await applyMonthlyReportChangesToBytes(bytes, {
      artists: [{ name: 'אמן חדש', id: '000000018', status: 'שכיר', email: 'new@example.com' }],
    });
    const snap = await readMonthlyReportFromBytes(out);
    expect(snap.artists.some((a) => a.name === 'אמן חדש')).toBe(true);
  });

  it('deanonymizes a token copied from a prior read before writing it back', async () => {
    const store = new AnonymizationStore();
    const bytes = await buildWorkbook({ existingArtists: [['זיו הרמלין-שדר', '', '', '']] });
    const token = anonymizeCellValue('123456782', store);

    const out = await applyMonthlyReportChangesToBytes(
      bytes,
      { artists: [{ name: 'זיו הרמלין-שדר', id: token }] },
      store,
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(wb.getWorksheet('פרטי_אמנים')!.getRow(2).getCell(2).text).toBe(deanonymizeText(token, store));
    expect(wb.getWorksheet('פרטי_אמנים')!.getRow(2).getCell(2).text).toBe('123456782');
  });
});

describe('applyMonthlyReportChangesToBytes — renameSheets / reorderSheets', () => {
  it('renames an event sheet and keeps it recognized by position', async () => {
    const bytes = await buildWorkbook({ numEventSheets: 2 });
    const out = await applyMonthlyReportChangesToBytes(bytes, { renameSheets: [{ from: 'אירוע1', to: '6.08' }] });
    const snap = await readMonthlyReportFromBytes(out);
    expect(snap.eventSheets).toEqual([
      { slot: 1, name: '6.08' },
      { slot: 2, name: 'אירוע2' },
    ]);
  });

  it('rejects renaming a sheet that is not a current event sheet', async () => {
    const bytes = await buildWorkbook();
    await expect(
      applyMonthlyReportChangesToBytes(bytes, { renameSheets: [{ from: 'סיכום חודשי', to: 'x' }] }),
    ).rejects.toThrow(MonthlyReportValidationError);
  });

  it('rejects renaming into a reserved fixed sheet name', async () => {
    const bytes = await buildWorkbook();
    await expect(
      applyMonthlyReportChangesToBytes(bytes, { renameSheets: [{ from: 'אירוע1', to: 'הכנסות' }] }),
    ).rejects.toThrow(MonthlyReportValidationError);
  });

  it('reorders a subset of event sheets, appending the rest afterward in their existing order', async () => {
    const bytes = await buildWorkbook({ numEventSheets: 3 });
    const renamed = await applyMonthlyReportChangesToBytes(bytes, {
      renameSheets: [
        { from: 'אירוע1', to: '20.08' },
        { from: 'אירוע2', to: '5.08' },
      ],
    });
    const out = await applyMonthlyReportChangesToBytes(renamed, { reorderSheets: ['5.08', '20.08'] });
    const snap = await readMonthlyReportFromBytes(out);
    expect(snap.eventSheets.map((s) => s.name)).toEqual(['5.08', '20.08', 'אירוע3']);
  });

  it('rejects reordering a sheet name that does not currently exist', async () => {
    const bytes = await buildWorkbook({ numEventSheets: 2 });
    await expect(applyMonthlyReportChangesToBytes(bytes, { reorderSheets: ['not-a-sheet'] })).rejects.toThrow(
      MonthlyReportValidationError,
    );
  });
});

describe('applyMonthlyReportChangesToBytes — runSync (Que port)', () => {
  it('Sheetsplace: syncs הוצאות row2 to current event sheet names in tab order', async () => {
    const bytes = await buildWorkbook({ numEventSheets: 2 });
    const renamed = await applyMonthlyReportChangesToBytes(bytes, {
      renameSheets: [{ from: 'אירוע1', to: '6.08' }],
      runSync: true,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(renamed as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    const expenseRow2 = wb.getWorksheet('הוצאות')!.getRow(2);
    expect(expenseRow2.getCell(8).text).toBe('6.08'); // H
    expect(expenseRow2.getCell(9).text).toBe('אירוע2'); // I
  });

  it('Depeople: adds a paid participant from an event sheet who is not yet an expense artist', async () => {
    const bytes = await buildWorkbook({ numEventSheets: 1 });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    const eventSheet = wb.getWorksheet('אירוע1')!;
    eventSheet.getRow(11).getCell(1).value = 'אמן לא רשום'; // A: name
    eventSheet.getRow(11).getCell(3).value = ''; // C: ת.ז — blank/non-numeric = not yet resolved
    eventSheet.getRow(11).getCell(5).value = 500; // E: fee > 0
    const withEvent = Buffer.from(await wb.xlsx.writeBuffer());

    const out = await applyMonthlyReportChangesToBytes(withEvent, { runSync: true });
    const snap = await readMonthlyReportFromBytes(out);
    expect(snap.artists.some((a) => a.name === 'אמן לא רשום')).toBe(false); // added to הוצאות, not פרטי_אמנים
    const outWb = new ExcelJS.Workbook();
    await outWb.xlsx.load(out as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    const names: string[] = [];
    for (let r = 4; r <= 10; r++) {
      const n = outWb.getWorksheet('הוצאות')!.getRow(r).getCell(2).text.trim();
      if (n) names.push(n);
    }
    expect(names).toContain('אמן לא רשום');
  });

  it('Depeople: does not add a participant whose fee cannot be confirmed positive', async () => {
    const bytes = await buildWorkbook({ numEventSheets: 1 });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    const eventSheet = wb.getWorksheet('אירוע1')!;
    eventSheet.getRow(11).getCell(1).value = 'ללא תשלום';
    eventSheet.getRow(11).getCell(3).value = '';
    eventSheet.getRow(11).getCell(5).value = 0; // fee not > 0
    const withEvent = Buffer.from(await wb.xlsx.writeBuffer());

    const out = await applyMonthlyReportChangesToBytes(withEvent, { runSync: true });
    const outWb = new ExcelJS.Workbook();
    await outWb.xlsx.load(out as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    const names: string[] = [];
    for (let r = 4; r <= 10; r++) {
      const n = outWb.getWorksheet('הוצאות')!.getRow(r).getCell(2).text.trim();
      if (n) names.push(n);
    }
    expect(names).not.toContain('ללא תשלום');
  });

  it('Byname: sorts the expense artist_name column', async () => {
    const bytes = await buildWorkbook(); // 'זיו הרמלין-שדר', 'סטודיו' pre-seeded, out of order
    const out = await applyMonthlyReportChangesToBytes(bytes, { runSync: true });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    const names = [
      wb.getWorksheet('הוצאות')!.getRow(4).getCell(2).text,
      wb.getWorksheet('הוצאות')!.getRow(5).getCell(2).text,
    ];
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'he')));
  });
});

describe('applyMonthlyReportChangesToBytes — eventSheetEdits (ticket summary / venue payment / note)', () => {
  async function buildWorkbookWithUsedSlot1(): Promise<Buffer> {
    const bytes = await buildWorkbook();
    const values = SUMMARY_HEADERS.map(() => '');
    values[0] = '11/08/2026'; // תאריך — needed for the row to count as "used" (summaryRows gates eventDetails)
    return applyMonthlyReportChangesToBytes(bytes, { eventRows: [{ slot: 1, values }] });
  }

  it('writes ticket summary lines as numbers, leaving omitted lines/fields untouched', async () => {
    const bytes = await buildWorkbookWithUsedSlot1();
    const out = await applyMonthlyReportChangesToBytes(bytes, {
      eventSheetEdits: [
        {
          slot: 1,
          ticketSummary: {
            cash: [{ price: '30', quantity: '12' }],
            commissionTotal: '150',
            complimentary: { price: '0', quantity: '5' },
          },
        },
      ],
    });
    const snap = await readMonthlyReportFromBytes(out);
    const details = snap.eventDetails.find((d) => d.slot === 1)!;
    expect(details.ticketSummary.cash[0]).toEqual({ price: '30', quantity: '12' });
    expect(details.ticketSummary.cash[1]).toEqual({ price: '', quantity: '' }); // untouched, not cleared
    expect(details.commissionTotal).toBe('150');
    expect(details.complimentary).toEqual({ price: '0', quantity: '5' });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    const priceCell = wb.getWorksheet('אירוע1')!.getRow(58).getCell(3);
    expect(typeof priceCell.value).toBe('number'); // real number, not text, matches the template's own sample values
  });

  it('rejects more ticket lines than a channel has rows for', async () => {
    const bytes = await buildWorkbookWithUsedSlot1();
    await expect(
      applyMonthlyReportChangesToBytes(bytes, {
        eventSheetEdits: [
          { slot: 1, ticketSummary: { cash: [{ price: '1' }, { price: '2' }, { price: '3' }, { price: '4' }] } },
        ],
      }),
    ).rejects.toThrow(MonthlyReportValidationError);
  });

  it('writes a venue payment override title and rows without touching the auto-filled A34:B40 block', async () => {
    const bytes = await buildWorkbookWithUsedSlot1();
    const out = await applyMonthlyReportChangesToBytes(bytes, {
      eventSheetEdits: [
        {
          slot: 1,
          venuePayment: {
            title: 'סיכום הכנסות',
            rows: [['9500'], ['עבור המופע']], // row35 (על סך), row36 (עבור) — only D column given
          },
        },
      ],
    });
    const snap = await readMonthlyReportFromBytes(out);
    const details = snap.eventDetails.find((d) => d.slot === 1)!;
    expect(details.venuePaymentTitle).toBe('סיכום הכנסות');
    expect(details.venuePaymentRows[0][0]).toBe('9500');
    expect(details.venuePaymentRows[1][0]).toBe('עבור המופע');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    // title sets both A34 and B34, matching the real template's own A34/B34 pair.
    expect(wb.getWorksheet('אירוע1')!.getRow(34).getCell(1).text).toBe('סיכום הכנסות');
    expect(wb.getWorksheet('אירוע1')!.getRow(34).getCell(2).text).toBe('סיכום הכנסות');
  });

  it('rejects more venuePayment rows/columns than the block has', async () => {
    const bytes = await buildWorkbookWithUsedSlot1();
    await expect(
      applyMonthlyReportChangesToBytes(bytes, {
        eventSheetEdits: [{ slot: 1, venuePayment: { rows: [[], [], [], [], [], [], []] } }], // 7 rows, block only has 6
      }),
    ).rejects.toThrow(MonthlyReportValidationError);
  });

  it('writes a freeform note to A33', async () => {
    const bytes = await buildWorkbookWithUsedSlot1();
    const out = await applyMonthlyReportChangesToBytes(bytes, {
      eventSheetEdits: [{ slot: 1, note: "נא לציין מס' הזמנת רכש 4502754930" }],
    });
    const snap = await readMonthlyReportFromBytes(out);
    expect(snap.eventDetails.find((d) => d.slot === 1)!.note).toBe("נא לציין מס' הזמנת רכש 4502754930");
  });

  it('targets the right physical sheet by slot even after it has been renamed', async () => {
    const bytes = await buildWorkbookWithUsedSlot1();
    const renamed = await applyMonthlyReportChangesToBytes(bytes, { renameSheets: [{ from: 'אירוע1', to: '11.08' }] });
    const out = await applyMonthlyReportChangesToBytes(renamed, {
      eventSheetEdits: [{ slot: 1, note: 'after rename' }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(wb.getWorksheet('11.08')!.getCell('A33').text).toBe('after rename');
  });

  it('rejects a slot with no resolvable event sheet before writing anything else in the same call', async () => {
    const bytes = await buildWorkbookWithUsedSlot1();
    await expect(
      applyMonthlyReportChangesToBytes(bytes, {
        artists: [{ name: 'should not be applied', id: '000000018' }],
        eventSheetEdits: [{ slot: 99, note: 'unreachable' }],
      }),
    ).rejects.toThrow(MonthlyReportValidationError);
  });
});
