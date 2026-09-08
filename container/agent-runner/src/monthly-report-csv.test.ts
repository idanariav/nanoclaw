import { describe, expect, it } from 'bun:test';
import {
  EVENT_SUMMARY_HEADERS,
  csvFilesToChanges,
  snapshotToCsvFiles,
  type MonthlyReportSnapshot,
} from './monthly-report-csv.js';

function emptyTicketSummary() {
  return { cash: [], dayOfCredit: [], presaleViaVenue: [], presale: [] };
}

function baseSnapshot(): MonthlyReportSnapshot {
  return {
    eventSheets: [{ slot: 1, name: '11.08' }],
    summaryRows: [
      {
        slot: 1,
        values: {
          תאריך: '11/08/2026',
          יישוב: 'ירושלים',
          מקום: 'מוזיאון הכנסת',
          מפיק: 'נעמה גרינשטיין',
          הצגה: "סלאם ג'אם",
          'גורם מזמין': '',
          קהל: '80',
          שעה: '20:30',
          'סך דרישה': '3000',
          עבור: '',
          כתובת: '',
          מייל: 'museum@example.com',
          'איש קשר': '',
          טלפון: '',
          'משתתף 1': 'דנה כהן+500,מנחה',
          'משתתף 2': 'יוסי לוי+0,משורר',
          ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`משתתף ${i + 3}`, ''])),
        },
      },
    ],
    artists: [
      {
        row: 2,
        name: 'דנה כהן',
        id: '123456782',
        status: 'עצמאי',
        email: 'dana@example.com',
        payeeName: '',
        payeeType: '',
        payeeEmail: '',
        amount: '',
      },
    ],
    monthlies: [],
    eventDetails: [
      {
        slot: 1,
        note: 'הערה לדוגמה',
        ticketSummary: { ...emptyTicketSummary(), cash: [{ price: '30', quantity: '12' }] },
        commissionTotal: '150',
        complimentary: { price: '0', quantity: '5' },
        venuePaymentTitle: '',
        venuePaymentRows: [],
      },
    ],
  };
}

describe('snapshotToCsvFiles / csvFilesToChanges round trip', () => {
  it('round-trips an existing event: summary fields, participants, artists, ticket summary', () => {
    const snapshot = baseSnapshot();
    const files = snapshotToCsvFiles(snapshot);
    expect(files['events.csv']).toContain('museum@example.com');
    expect(files['participants.csv']).toContain('דנה כהן');

    const { changes, slotAssignments } = csvFilesToChanges(files, [1]);
    expect(slotAssignments).toEqual({});

    const eventRow = changes.eventRows!.find((r) => r.slot === 1)!;
    expect(eventRow.values).toHaveLength(32);
    EVENT_SUMMARY_HEADERS.forEach((h, i) => {
      expect(eventRow.values[i]).toBe(snapshot.summaryRows[0].values[h]);
    });
    expect(eventRow.values[EVENT_SUMMARY_HEADERS.length]).toBe('דנה כהן+500,מנחה');
    expect(eventRow.values[EVENT_SUMMARY_HEADERS.length + 1]).toBe('יוסי לוי+0,משורר');

    const edit = changes.eventSheetEdits!.find((e) => e.slot === 1)!;
    expect(edit.note).toBe('הערה לדוגמה');
    expect(edit.ticketSummary!.cash).toEqual([{ price: '30', quantity: '12' }]);
    expect(edit.ticketSummary!.commissionTotal).toBe('150');
    expect(edit.ticketSummary!.complimentary).toEqual({ price: '0', quantity: '5' });

    expect(changes.artists).toEqual([{ name: 'דנה כהן', id: '123456782', status: 'עצמאי', email: 'dana@example.com' }]);
  });

  it('assigns a free slot to a new event row with a blank slot, avoiding used slots', () => {
    const files = {
      'events.csv': 'slot,תאריך,יישוב,מקום,מפיק,הצגה,גורם מזמין,קהל,שעה,סך דרישה,עבור,כתובת,מייל,איש קשר,טלפון,note,commission_total,complimentary_price,complimentary_qty,venue_payment_title\n' +
        ',05/09/2026,תל אביב,,,,,,,,,,,,,,,,,\n',
    };
    const { changes, slotAssignments } = csvFilesToChanges(files, [1, 2, 3]);
    expect(changes.eventRows).toHaveLength(1);
    expect(changes.eventRows![0].slot).toBe(4);
    expect(Object.values(slotAssignments)).toEqual([4]);
  });

  it('resolves two new events in one call to different slots, and correlates a placeholder token across events.csv and participants.csv', () => {
    const files = {
      'events.csv':
        'slot,תאריך,יישוב,מקום,מפיק,הצגה,גורם מזמין,קהל,שעה,סך דרישה,עבור,כתובת,מייל,איש קשר,טלפון,note,commission_total,complimentary_price,complimentary_qty,venue_payment_title\n' +
        'NEW1,05/09/2026,תל אביב,,,,,,,,,,,,,,,,,\n' +
        'NEW2,06/09/2026,חיפה,,,,,,,,,,,,,,,,,\n',
      'participants.csv': 'slot,index,name,fee,role\nNEW1,1,דנה כהן,500,מנחה\n',
    };
    const { changes, slotAssignments } = csvFilesToChanges(files, [1]);
    expect(new Set(changes.eventRows!.map((r) => r.slot)).size).toBe(2);
    expect(slotAssignments.NEW1).not.toBe(slotAssignments.NEW2);
    expect(slotAssignments.NEW1).not.toBe(1); // slot 1 already used

    const new1Row = changes.eventRows!.find((r) => r.slot === slotAssignments.NEW1)!;
    expect(new1Row.values[EVENT_SUMMARY_HEADERS.length]).toBe('דנה כהן+500,מנחה');
  });

  it('skips a participant row whose slot events.csv never declared, rather than guessing', () => {
    const files = {
      'events.csv':
        'slot,תאריך,יישוב,מקום,מפיק,הצגה,גורם מזמין,קהל,שעה,סך דרישה,עבור,כתובת,מייל,איש קשר,טלפון,note,commission_total,complimentary_price,complimentary_qty,venue_payment_title\n' +
        '1,05/09/2026,,,,,,,,,,,,,,,,,,\n',
      'participants.csv': 'slot,index,name,fee,role\n2,1,דנה כהן,500,מנחה\n',
    };
    const { changes } = csvFilesToChanges(files, [1, 2]);
    expect(changes.eventRows).toHaveLength(1);
  });

  it('leaves an empty ticket_summary/venue_payment/participants file producing no eventSheetEdits', () => {
    const snapshot = baseSnapshot();
    snapshot.eventDetails[0].ticketSummary = emptyTicketSummary();
    snapshot.eventDetails[0].commissionTotal = '';
    snapshot.eventDetails[0].complimentary = { price: '', quantity: '' };
    snapshot.eventDetails[0].note = '';
    const files = snapshotToCsvFiles(snapshot);
    const { changes } = csvFilesToChanges(files, [1]);
    expect(changes.eventSheetEdits).toBeUndefined();
  });
});
