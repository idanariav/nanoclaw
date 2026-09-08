/**
 * Gmail MCP server for NanoClaw — thin client over the gmail-sanitizer
 * host service (src/gmail-sanitizer/, outside this container). All PII
 * anonymization and Gmail/Drive credential handling happen on the other
 * side of this HTTP call; this file never sees a raw Gmail credential and
 * never receives attachment bytes. PII values (phone numbers, bank
 * accounts, ID numbers) never reach this file either — only numbered
 * tokens like `[PHONE_1]`, which gmail_create_draft resolves back to the
 * real value server-side.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const GMAIL_SANITIZER_URL = process.env.GMAIL_SANITIZER_URL || 'http://host.docker.internal:8799';
const GMAIL_SANITIZER_TOKEN = process.env.GMAIL_SANITIZER_TOKEN || '';

function log(msg: string): void {
  console.error(`[GMAIL] ${msg}`);
}

async function sanitizerFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${GMAIL_SANITIZER_URL}${path}`, {
    ...options,
    headers: { ...options?.headers, Authorization: `Bearer ${GMAIL_SANITIZER_TOKEN}` },
  });
}

const server = new McpServer({ name: 'gmail', version: '1.0.0' });

server.tool(
  'gmail_search_emails',
  'Search Gmail. Returns anonymized subject/snippet — bank account numbers, phone numbers, and ID numbers are replaced with numbered tokens like [PHONE_1]. The same real value always gets the same token, so repeats are recognizable without ever exposing the value to you. To reuse a value (e.g. forwarding a phone number in a reply), copy the token itself into gmail_create_draft — it is resolved back to the real value there, outside your context. Use standard Gmail search syntax for the query (e.g. "from:someone@example.com", "is:unread", "after:2026/01/01").',
  {
    query: z.string().describe('Gmail search query, e.g. "from:bank is:unread"'),
    maxResults: z.number().optional().describe('Max results to return (default 10, max 50)'),
  },
  async (args) => {
    log(`Searching: ${args.query}`);
    try {
      const res = await sanitizerFetch(
        `/emails?q=${encodeURIComponent(args.query)}&maxResults=${args.maxResults ?? 10}`,
      );
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `gmail-sanitizer error: ${res.status} ${await res.text()}` }],
          isError: true,
        };
      }
      const emails = (await res.json()) as unknown[];
      return { content: [{ type: 'text' as const, text: JSON.stringify(emails, null, 2) }] };
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
  'gmail_read_email',
  'Read one email by id (from gmail_search_emails). Returns the anonymized subject and body (PII replaced with numbered tokens like [PHONE_1] — see gmail_search_emails) plus attachment metadata (filename, mime type, size) — attachment CONTENT is never returned. Use gmail_save_attachment_to_drive to move an attachment without opening it.',
  {
    id: z.string().describe('The email id, as returned by gmail_search_emails'),
  },
  async (args) => {
    log(`Reading email ${args.id}`);
    try {
      const res = await sanitizerFetch(`/emails/${encodeURIComponent(args.id)}`);
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `gmail-sanitizer error: ${res.status} ${await res.text()}` }],
          isError: true,
        };
      }
      const email = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(email, null, 2) }] };
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
  'gmail_save_attachment_to_drive',
  'Save an email attachment directly to Drive without ever opening/reading its content. The attachment bytes never pass through you — this downloads and re-uploads server-side and returns only the resulting Drive file id/link. Pass `filename` to rename the file on save (e.g. per a naming convention) — give it without an extension; the original file extension is kept automatically.',
  {
    emailId: z.string().describe('The email id (from gmail_search_emails or gmail_read_email)'),
    attachmentId: z.string().describe('The attachment id (from gmail_read_email\'s attachments list)'),
    filename: z.string().optional().describe('Optional new filename (without extension) to save the file as, instead of its original name'),
  },
  async (args) => {
    log(`Saving attachment ${args.attachmentId} from email ${args.emailId} to Drive`);
    try {
      const res = await sanitizerFetch(
        `/emails/${encodeURIComponent(args.emailId)}/attachments/${encodeURIComponent(args.attachmentId)}/save-to-drive`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: args.filename }),
        },
      );
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
  'gmail_save_url_to_drive',
  'Save a file from a URL directly to Drive — for cases like an invoice-download link found in an email body, which is not a real Gmail attachment. The URL is fetched and uploaded server-side; you never see its content, only the resulting filename/size/Drive link. Only public https:// URLs are allowed. Pass `filename` to rename the file on save (e.g. per a naming convention) — give it without an extension; the original file extension is kept automatically.',
  {
    url: z.string().describe('The https:// URL to download and save to Drive'),
    filename: z.string().optional().describe('Optional new filename (without extension) to save the file as, instead of the name inferred from the URL'),
  },
  async (args) => {
    log(`Saving URL to Drive: ${args.url}`);
    try {
      const res = await sanitizerFetch('/save-url-to-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: args.url, filename: args.filename }),
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
  'gmail_archive_and_label',
  'Mark an email as read, archive it (remove from inbox), and apply a label — one action, for cleaning up an email after you\'ve saved what you needed from it. The label is created if it doesn\'t already exist.',
  {
    id: z.string().describe('The email id (from gmail_search_emails or gmail_read_email)'),
    label: z.string().describe('The Gmail label to apply, e.g. "Artists"'),
  },
  async (args) => {
    log(`Archiving and labeling email ${args.id} as "${args.label}"`);
    try {
      const res = await sanitizerFetch(`/emails/${encodeURIComponent(args.id)}/archive-and-label`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: args.label }),
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
  'gmail_create_draft',
  'Create a Gmail draft — this NEVER sends anything, it only saves to Drafts for the user to review and send themselves. Pass `emailId` (from gmail_search_emails or gmail_read_email) to thread the draft as a reply under that email\'s thread; omit it for a standalone new draft. `to`, `cc`, `subject`, and `body` may contain anonymization tokens copied from a read email (e.g. [PHONE_1]) — each is resolved back to its real value before the draft is created, so you can relay a value like a phone number without ever seeing it yourself.',
  {
    to: z.string().describe('Recipient address(es), comma-separated for multiple'),
    cc: z.string().optional().describe('Cc address(es), comma-separated'),
    subject: z.string().describe('Subject line (Hebrew supported)'),
    body: z.string().describe('Plain-text body (Hebrew supported)'),
    emailId: z
      .string()
      .optional()
      .describe('The email id to thread this draft as a reply under (from gmail_search_emails or gmail_read_email)'),
  },
  async (args) => {
    log(`Creating draft to ${args.to}${args.emailId ? ` (reply to ${args.emailId})` : ''}`);
    try {
      const res = await sanitizerFetch('/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: args.to,
          cc: args.cc,
          subject: args.subject,
          body: args.body,
          emailId: args.emailId,
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

server.tool(
  'gmail_read_excel_attachment',
  'Read an Excel (.xlsx) attachment from an email, or a file already saved to Drive, as structured row/column data. Provide either (emailId + attachmentId) for a fresh attachment, or driveFileId for a previously-saved one. Columns the report\'s owner has marked sensitive (e.g. account numbers, names) come back as numbered tokens like [CELL_1] — same rule as other PII tokens: the same real value always gets the same token, and you can paste a token into gmail_edit_excel_attachment to write that sensitive value back unchanged without ever seeing it. Only files matching a known, pre-configured report template (an exact sheet name + header row match) can be read — an unrecognized file returns an error naming the sheets/headers it found, rather than exposing unreviewed data; ask the user to add a template for it if that happens. Row numbers in the result are how you address rows in an edit.',
  {
    emailId: z.string().optional().describe('The email id (from gmail_search_emails or gmail_read_email)'),
    attachmentId: z.string().optional().describe('The attachment id (from gmail_read_email\'s attachments list)'),
    driveFileId: z.string().optional().describe('A Drive file id, for a file already saved to Drive instead of a fresh Gmail attachment'),
  },
  async (args) => {
    log(`Reading Excel attachment${args.attachmentId ? ` ${args.attachmentId}` : ''}${args.driveFileId ? ` (drive:${args.driveFileId})` : ''}`);
    try {
      const res = await sanitizerFetch('/excel/read', {
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
  'gmail_edit_excel_attachment',
  'Apply targeted cell edits and/or append rows to an Excel report previously read with gmail_read_excel_attachment, saving the result as a NEW file in Drive — this never modifies the original attachment and never creates a Gmail draft. Only cell-value changes and row appends are supported: no new columns, no formula or formatting changes, no row/column deletion. Address edits by the row number and column (header name) returned from gmail_read_excel_attachment. If a sheet has a key column, pass `keyColumnValue` with the value you read in that row\'s key column — the edit is verified against the live file and rejected (with nothing written) if the row no longer matches, which catches the file having changed since you read it. If a value you\'re writing is a token like [CELL_1] copied from a read, it resolves to the real value here, server-side — you never need to see or type the real value. Returns the new file\'s Drive id/link; mention it in your reply, it is not attached to anything automatically.',
  {
    emailId: z.string().optional().describe('The email id, if editing a fresh Gmail attachment (with attachmentId)'),
    attachmentId: z.string().optional().describe('The attachment id, if editing a fresh Gmail attachment (with emailId)'),
    driveFileId: z.string().optional().describe('A Drive file id, if editing a file already saved to Drive'),
    cellEdits: z
      .array(
        z.object({
          sheetName: z.string().describe('Sheet name, as returned by gmail_read_excel_attachment'),
          row: z.number().describe('Row number, as returned by gmail_read_excel_attachment'),
          column: z.string().describe('Column header name'),
          value: z.string().describe('New value — a plain value, or an anonymization token copied from a read'),
          keyColumnValue: z
            .string()
            .optional()
            .describe('The value read in this row\'s key column, if the sheet has one — verified before writing'),
        }),
      )
      .optional()
      .describe('Targeted cell changes to apply'),
    appendRows: z
      .array(
        z.object({
          sheetName: z.string().describe('Sheet name to append to'),
          values: z.record(z.string(), z.string()).describe('Column header name -> new value, for every column to fill in'),
        }),
      )
      .optional()
      .describe('New rows to append after the last row of data'),
    filename: z
      .string()
      .optional()
      .describe('Filename for the saved file (with or without .xlsx). Defaults to the original attachment\'s filename; required when editing a driveFileId with no known original name.'),
  },
  async (args) => {
    log(`Editing Excel attachment${args.attachmentId ? ` ${args.attachmentId}` : ''}${args.driveFileId ? ` (drive:${args.driveFileId})` : ''}`);
    try {
      const res = await sanitizerFetch('/excel/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailId: args.emailId,
          attachmentId: args.attachmentId,
          driveFileId: args.driveFileId,
          cellEdits: args.cellEdits,
          appendRows: args.appendRows,
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

const transport = new StdioServerTransport();
await server.connect(transport);
