/**
 * Local report MCP tools — install-specific, loaded automatically by
 * gmail-mcp-stdio.ts's local report tool hook (see its module comment).
 * Mirrors src/gmail-sanitizer/local-report-extension.ts's two routes as
 * agent-facing tools; this file is the only place that knows they exist.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { GMAIL_SANITIZER_URL, log, sanitizerFetch } from './gmail-sanitizer-client.js';

export function registerTools(server: McpServer): void {
  server.tool(
    'gmail_read_monthly_report',
    'Read the current state of Idan\'s one monthly poetry-slam report workbook — a bespoke tool for that one specific report, separate from gmail_read_excel_attachment. Provide either (emailId + attachmentId) for a fresh attachment, or driveFileId for the canonical working copy already saved to Drive (the usual case — ask Idan for the link/id once, then reuse it all month). Returns: the current event sheets in tab order (slot 1 = row 47 of the driving table, slot 2 = row 48, etc. — this mapping is permanent per physical sheet regardless of renaming, see gmail_apply_monthly_report_changes), any already-filled driving-table rows, the artist registry (sensitive ת.ז./מעמד/אימייל come back as [CELL_n] tokens, same rule as gmail_read_excel_attachment), and the recurring-payments sheet (ת.ז/סטטוס tokenized). הכנסות is intentionally never touched or exposed — it is fully formula-driven off other sheets. An unrecognized file (structure doesn\'t match the known template) returns a 422 naming what differed — don\'t try to force it, tell Idan.',
    {
      emailId: z.string().optional().describe('The email id, if reading a fresh Gmail attachment (with attachmentId)'),
      attachmentId: z.string().optional().describe('The attachment id, if reading a fresh Gmail attachment (with emailId)'),
      driveFileId: z.string().optional().describe('The Drive file id of the canonical working copy'),
    },
    async (args) => {
      log(`Reading monthly report${args.driveFileId ? ` (drive:${args.driveFileId})` : ''}`);
      try {
        const res = await sanitizerFetch('/monthly-report/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emailId: args.emailId, attachmentId: args.attachmentId, driveFileId: args.driveFileId }),
        });
        if (!res.ok) {
          return {
            content: [{ type: 'text' as const, text: `gmail-sanitizer error: ${res.status} ${await res.text()}` }],
            isError: true,
          };
        }
        const result = await res.json();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to reach gmail-sanitizer at ${GMAIL_SANITIZER_URL}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
  
  server.tool(
    'gmail_apply_monthly_report_changes',
    'Apply a batch of changes to Idan\'s monthly poetry-slam report and save the result. If `driveFileId` was given, this UPDATES that same Drive file in place (same id/link) — it does not create a new copy every time, unlike gmail_edit_excel_attachment. A fresh (emailId+attachmentId) source still creates the first Drive copy; use its returned driveFileId for every change after that. All parts of this call are optional and applied in a fixed order: artists -> eventRows -> eventSheetEdits -> renameSheets -> reorderSheets -> runSync.\n\n' +
      '`artists`: upsert into the artist registry by exact name match (adds a new row if the name isn\'t found) — id/status/email may be plain values or [CELL_n] tokens copied from a read, resolved back to the real value here.\n\n' +
      '`eventRows`: write one event into the driving table. `slot` is 1-30 and must match the row you read it at (row 47 = slot 1, row 48 = slot 2, ...) — get slots from gmail_read_monthly_report\'s eventSheets list, using the FIRST unused slot(s) for new events this month. `values` must have exactly 32 entries in this order: תאריך, יישוב, מקום, מפיק, הצגה, גורם מזמין, קהל, שעה, סך דרישה, עבור, כתובת, מייל, איש קשר, טלפון, then משתתף 1..18 (each participant field formatted `<Full Name>+<fee>,<role>`, role one of מנחה/חימום/מוזיקאי/משורר/משוררת — see the monthly-report-generation skill for the exact field rules). Writing an eventRow automatically populates most of that slot\'s event sheet (D46+slot is read live by that sheet\'s own formulas) — never try to edit those auto-filled cells directly.\n\n' +
      '`eventSheetEdits`: the three genuinely manual regions of an event sheet that eventRows does NOT reach — `slot` targets the same event as eventRows and keeps resolving to the right physical sheet even after it\'s been renamed/reordered. `ticketSummary` (box-office reconciliation, up to 3 price/quantity lines each for `cash`/`dayOfCredit`/`presaleViaVenue`/`presale`, plus `commissionTotal` and `complimentary` — omitted lines/fields are left untouched, never cleared). `venuePayment` (the D34:G40 block — the uncommon case where Idan owes the venue rather than the reverse; leave this alone unless asked to fill it, most events never need it — optional `title` retitles A34/B34, `rows` is up to 6 rows x 4 columns for columns D-G). `note` — freeform text (A33), the one place ad-hoc notes like "please quote PO #..." or "continues last month\'s report" actually go on this template.\n\n' +
      '`renameSheets`: rename event sheets FROM their current name (right after writing their eventRows, before reordering — a fresh slot is still literally named "אירוע<slot>") TO the event\'s date in d.mm form (e.g. "6.08", "23.11"). Only affects sheets after the 5 fixed ones; renaming into a fixed sheet name is rejected.\n\n' +
      '`reorderSheets`: the desired left-to-right tab order for however many event sheets you want to place (by their current — i.e. already renamed — name); normally all of this month\'s used sheets, chronological. Any event sheets not listed keep their existing relative order, appended after.\n\n' +
      '`runSync: true` re-syncs הוצאות after any of the above (mirrors the workbook\'s own "Que" macro, replicated here since there is no way to run real Excel macros from this environment — see the tool\'s module comment for why): resyncs its sheet-name row to the current tab names/order, relabels its header row from הכנסות, adds any newly-paid participant who doesn\'t already have an artist_name row, and re-sorts that column. Always pass true after a rename/reorder/eventRows batch that\'s meant to be "final" for this call. Never attempt to replicate or ask about the workbook\'s "Xternal" finalize macro — that\'s a destructive, human-only month-end step done directly in Excel.',
    {
      emailId: z.string().optional().describe('The email id, if editing a fresh Gmail attachment (with attachmentId)'),
      attachmentId: z.string().optional().describe('The attachment id, if editing a fresh Gmail attachment (with emailId)'),
      driveFileId: z.string().optional().describe('The Drive file id of the canonical working copy — updated in place'),
      artists: z
        .array(
          z.object({
            name: z.string().describe('Exact artist name to match or create'),
            id: z.string().optional().describe('ת.ז. — plain value or a [CELL_n] token copied from a read'),
            status: z.string().optional().describe('מעמד — plain value or a [CELL_n] token copied from a read'),
            email: z.string().optional().describe('אימייל — plain value or a [CELL_n] token copied from a read'),
          }),
        )
        .optional()
        .describe('Artist registry upserts, by exact name match'),
      eventRows: z
        .array(
          z.object({
            slot: z.number().describe('1-30, the driving-table row (46+slot) and target event sheet'),
            values: z.array(z.string()).length(32).describe('Exactly 32 values — see tool description for the column order'),
          }),
        )
        .optional()
        .describe('Rows to write into the driving table, one per event'),
      eventSheetEdits: z
        .array(
          z.object({
            slot: z.number().describe('1-30 — same slot as its eventRows entry, resolved by the sheet\'s own formula so renaming/reordering never breaks this'),
            ticketSummary: z
              .object({
                cash: z.array(z.object({ price: z.string().optional(), quantity: z.string().optional() })).max(3).optional(),
                dayOfCredit: z.array(z.object({ price: z.string().optional(), quantity: z.string().optional() })).max(3).optional(),
                presaleViaVenue: z.array(z.object({ price: z.string().optional(), quantity: z.string().optional() })).max(3).optional(),
                presale: z.array(z.object({ price: z.string().optional(), quantity: z.string().optional() })).max(3).optional(),
                commissionTotal: z.string().optional().describe('"סה"כ עמלות" — entered directly, not price*quantity'),
                complimentary: z.object({ price: z.string().optional(), quantity: z.string().optional() }).optional().describe('"מוזמנים" (comp/invited)'),
              })
              .optional(),
            venuePayment: z
              .object({
                title: z.string().optional().describe('Sets A34/B34 — default "דרישת תשלום"'),
                rows: z.array(z.array(z.string().optional())).max(6).optional().describe('Rows 35-40 (על סך/עבור/כתובת/מייל/איש קשר/טלפון), up to 4 columns (D-G) each'),
              })
              .optional()
              .describe('The D34:G40 payment-TO-the-venue override — leave unset for the normal case'),
            note: z.string().optional().describe('Freeform text written to A33'),
          }),
        )
        .optional()
        .describe('Ticket summary / venue payment override / freeform note for specific events — see tool description'),
      renameSheets: z
        .array(z.object({ from: z.string().describe('Current sheet name'), to: z.string().describe('New name, d.mm date form') }))
        .optional()
        .describe('Event sheet renames'),
      reorderSheets: z
        .array(z.string())
        .optional()
        .describe('Desired left-to-right order (by current name) for a subset of event sheets'),
      runSync: z.boolean().optional().describe('Re-run the הוצאות sync after the above changes'),
      filename: z
        .string()
        .optional()
        .describe('Filename for the first save of a fresh attachment (with or without .xlsx) — ignored once driveFileId is used'),
    },
    async (args) => {
      log(`Applying monthly report changes${args.driveFileId ? ` (drive:${args.driveFileId})` : ''}`);
      try {
        const res = await sanitizerFetch('/monthly-report/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            emailId: args.emailId,
            attachmentId: args.attachmentId,
            driveFileId: args.driveFileId,
            artists: args.artists,
            eventRows: args.eventRows,
            eventSheetEdits: args.eventSheetEdits,
            renameSheets: args.renameSheets,
            reorderSheets: args.reorderSheets,
            runSync: args.runSync,
            filename: args.filename,
          }),
        });
        if (!res.ok) {
          return {
            content: [{ type: 'text' as const, text: `gmail-sanitizer error: ${res.status} ${await res.text()}` }],
            isError: true,
          };
        }
        const result = await res.json();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to reach gmail-sanitizer at ${GMAIL_SANITIZER_URL}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
