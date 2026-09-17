/**
 * Gmail MCP server for NanoClaw — thin client over the gmail-sanitizer
 * host service (src/gmail-sanitizer/, outside this container). All PII
 * anonymization and Gmail/Drive credential handling happen on the other
 * side of this HTTP call; this file never sees a raw Gmail credential and
 * never receives attachment bytes. PII values (phone numbers, bank
 * accounts, ID numbers) never reach this file either — only numbered
 * tokens like `[PHONE_1]`, which gmail_create_draft resolves back to the
 * real value server-side.
 *
 * Local report tools: every tool below is generic. A bespoke report that
 * needs its own tools (matching a local server.ts route extension — see
 * that file's module comment) can be added without touching this file: drop
 * a module at ./local-monthly-report-mcp.js exporting `registerTools(server)`
 * and it's loaded and called automatically, before the transport connects.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { GMAIL_SANITIZER_URL, log, sanitizerFetch, type LocalMcpExtension } from './gmail-sanitizer-client.js';

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
    partId: z.string().describe('The attachment\'s part id (from gmail_read_email\'s attachments list)'),
    filename: z.string().optional().describe('Optional new filename (without extension) to save the file as, instead of its original name'),
  },
  async (args) => {
    log(`Saving attachment ${args.partId} from email ${args.emailId} to Drive`);
    try {
      const res = await sanitizerFetch(
        `/emails/${encodeURIComponent(args.emailId)}/attachments/${encodeURIComponent(args.partId)}/save-to-drive`,
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
  'gmail_archive',
  'Mark an email as read and archive it (remove from inbox) — for cleaning up an email after you\'ve saved what you needed from it. Combine with gmail_add_label if you also want to tag it (e.g. label "Artists" for a processed invoice).',
  {
    id: z.string().describe('The email id (from gmail_search_emails or gmail_read_email)'),
  },
  async (args) => {
    log(`Archiving email ${args.id}`);
    try {
      const res = await sanitizerFetch(`/emails/${encodeURIComponent(args.id)}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
  'gmail_add_label',
  'Apply a Gmail label to an email without archiving it or changing its read status — the label is created if it doesn\'t already exist. Use this (not gmail_archive) when the email should stay visible in the inbox, e.g. labeling "Waiting" after a draft reply asks a question that\'s awaiting the recipient\'s answer. Combine with gmail_archive if you want both (e.g. label "Artists" and archive a processed invoice).',
  {
    id: z.string().describe('The email id (from gmail_search_emails or gmail_read_email)'),
    label: z.string().describe('The Gmail label to apply, e.g. "Waiting"'),
  },
  async (args) => {
    log(`Labeling email ${args.id} as "${args.label}"`);
    try {
      const res = await sanitizerFetch(`/emails/${encodeURIComponent(args.id)}/label`, {
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
  'Create a Gmail draft — this NEVER sends anything, it only saves to Drafts for the user to review and send themselves. Pass `emailId` (from gmail_search_emails or gmail_read_email) to thread the draft as a reply under that email\'s thread; omit it for a standalone new draft. `to`, `cc`, `subject`, and `body` may contain anonymization tokens copied from a read email (e.g. [PHONE_1]) — each is resolved back to its real value before the draft is created, so you can relay a value like a phone number without ever seeing it yourself. Pass `attachments` to attach one or more files already saved to Drive (e.g. via gmail_save_attachment_to_drive, gmail_save_url_to_drive, or gmail_edit_excel_attachment) — each is fetched from Drive and attached to the draft under its own filename; the bytes never pass through you.',
  {
    to: z.string().describe('Recipient address(es), comma-separated for multiple'),
    cc: z.string().optional().describe('Cc address(es), comma-separated'),
    subject: z.string().describe('Subject line (Hebrew supported)'),
    body: z.string().describe('Plain-text body (Hebrew supported — rendered right-to-left automatically when the body contains Hebrew/Arabic text)'),
    emailId: z
      .string()
      .optional()
      .describe('The email id to thread this draft as a reply under (from gmail_search_emails or gmail_read_email)'),
    attachments: z
      .array(z.string())
      .optional()
      .describe('Drive file ids to attach (from gmail_save_attachment_to_drive, gmail_save_url_to_drive, or gmail_edit_excel_attachment)'),
  },
  async (args) => {
    log(`Creating draft to ${args.to}${args.emailId ? ` (reply to ${args.emailId})` : ''}${args.attachments?.length ? ` with ${args.attachments.length} attachment(s)` : ''}`);
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
          attachments: args.attachments,
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
  'gmail_list_drafts',
  'List existing Gmail drafts — recipient/subject/snippet are anonymized like gmail_search_emails, plus the draftId needed for gmail_update_draft and gmail_delete_draft. Use this to find a draft made in an earlier session or turn, since a draft id is otherwise only known from gmail_create_draft\'s own response. Optional `query` uses standard Gmail search syntax (e.g. "to:someone@example.com", "subject:invoice"), scoped to drafts.',
  {
    query: z.string().optional().describe('Optional Gmail search query to filter drafts, e.g. "to:someone@example.com"'),
    maxResults: z.number().optional().describe('Max results to return (default 10, max 50)'),
  },
  async (args) => {
    log(`Listing drafts${args.query ? `: ${args.query}` : ''}`);
    try {
      const res = await sanitizerFetch(
        `/drafts?q=${encodeURIComponent(args.query ?? '')}&maxResults=${args.maxResults ?? 10}`,
      );
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `gmail-sanitizer error: ${res.status} ${await res.text()}` }],
          isError: true,
        };
      }
      const drafts = (await res.json()) as unknown[];
      return { content: [{ type: 'text' as const, text: JSON.stringify(drafts, null, 2) }] };
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
  'gmail_update_draft',
  'Update an existing Gmail draft in place (same draft id) — replaces its recipients/subject/body/attachments. Never sends anything. Pass `draftId` (from gmail_create_draft or gmail_list_drafts). Threading is preserved automatically unless you pass `emailId` to re-thread it under a different email. `to`, `cc`, `subject`, and `body` may contain anonymization tokens (e.g. [PHONE_1]) — resolved back to their real value before the draft is updated. `attachments` fully replaces the draft\'s current attachment set (omit it to end up with none).',
  {
    draftId: z.string().describe('The draft id to update (from gmail_create_draft or gmail_list_drafts)'),
    to: z.string().describe('Recipient address(es), comma-separated for multiple'),
    cc: z.string().optional().describe('Cc address(es), comma-separated'),
    subject: z.string().describe('Subject line (Hebrew supported)'),
    body: z.string().describe('Plain-text body (Hebrew supported — rendered right-to-left automatically when the body contains Hebrew/Arabic text)'),
    emailId: z
      .string()
      .optional()
      .describe('Re-thread this draft as a reply under a different email\'s thread; omit to keep its current threading'),
    attachments: z
      .array(z.string())
      .optional()
      .describe('Drive file ids to attach (from gmail_save_attachment_to_drive, gmail_save_url_to_drive, or gmail_edit_excel_attachment) — replaces the draft\'s current attachments entirely'),
  },
  async (args) => {
    log(`Updating draft ${args.draftId}${args.emailId ? ` (re-threading under ${args.emailId})` : ''}${args.attachments?.length ? ` with ${args.attachments.length} attachment(s)` : ''}`);
    try {
      const res = await sanitizerFetch(`/drafts/${encodeURIComponent(args.draftId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: args.to,
          cc: args.cc,
          subject: args.subject,
          body: args.body,
          emailId: args.emailId,
          attachments: args.attachments,
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
  'gmail_delete_draft',
  'Permanently delete a Gmail draft — cannot be undone. Use when a draft is no longer needed (e.g. superseded by a new one, or the user decided not to send it).',
  {
    draftId: z.string().describe('The draft id to delete (from gmail_create_draft or gmail_list_drafts)'),
  },
  async (args) => {
    log(`Deleting draft ${args.draftId}`);
    try {
      const res = await sanitizerFetch(`/drafts/${encodeURIComponent(args.draftId)}`, { method: 'DELETE' });
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
  'Read an Excel (.xlsx) attachment from an email, or a file already saved to Drive, as structured row/column data. Provide either (emailId + partId) for a fresh attachment, or driveFileId for a previously-saved one. Columns the report\'s owner has marked sensitive (e.g. account numbers, names) come back as numbered tokens like [CELL_1] — same rule as other PII tokens: the same real value always gets the same token, and you can paste a token into gmail_edit_excel_attachment to write that sensitive value back unchanged without ever seeing it. Only files matching a known, pre-configured report template (an exact sheet name + header row match) get this anonymized treatment — an unrecognized file returns an error naming the sheets/headers it found, rather than exposing unreviewed data. From there you have two options: ask the user to add a template for it (durable, keeps future reads anonymized), or — for a genuine one-off file you don\'t expect to see again — ask the user directly (e.g. via ask_user_question) whether you may read it anyway UNREDACTED, and if they say yes, retry the same call with `readUnrecognized: true`. Never set that flag without asking first; the result it returns has `anonymized: false` and no sensitive-column protection at all, so treat any PII in it with care. Row numbers in the result are how you address rows in an edit (edits still require a registered template — reading unrecognized is read-only).',
  {
    emailId: z.string().optional().describe('The email id (from gmail_search_emails or gmail_read_email)'),
    partId: z.string().optional().describe('The attachment\'s part id (from gmail_read_email\'s attachments list)'),
    driveFileId: z.string().optional().describe('A Drive file id, for a file already saved to Drive instead of a fresh Gmail attachment'),
    readUnrecognized: z
      .boolean()
      .optional()
      .describe('Only after the user has explicitly approved reading this specific file unredacted — read it even though it matches no registered template. Never set true without asking the user first.'),
  },
  async (args) => {
    log(`Reading Excel attachment${args.partId ? ` ${args.partId}` : ''}${args.driveFileId ? ` (drive:${args.driveFileId})` : ''}${args.readUnrecognized ? ' [unredacted, user-approved]' : ''}`);
    try {
      const res = await sanitizerFetch('/excel/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailId: args.emailId,
          partId: args.partId,
          driveFileId: args.driveFileId,
          readUnrecognized: args.readUnrecognized,
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
  'gmail_edit_excel_attachment',
  'Apply targeted cell edits and/or append rows to an Excel report previously read with gmail_read_excel_attachment, saving the result as a NEW file in Drive — this never modifies the original attachment and never creates a Gmail draft. Only cell-value changes and row appends are supported: no new columns, no formula or formatting changes, no row/column deletion. Address edits by the row number and column (header name) returned from gmail_read_excel_attachment. If a sheet has a key column, pass `keyColumnValue` with the value you read in that row\'s key column — the edit is verified against the live file and rejected (with nothing written) if the row no longer matches, which catches the file having changed since you read it. If a value you\'re writing is a token like [CELL_1] copied from a read, it resolves to the real value here, server-side — you never need to see or type the real value. Returns the new file\'s Drive id/link; mention it in your reply, it is not attached to anything automatically.',
  {
    emailId: z.string().optional().describe('The email id, if editing a fresh Gmail attachment (with partId)'),
    partId: z.string().optional().describe('The attachment\'s part id, if editing a fresh Gmail attachment (with emailId)'),
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
    log(`Editing Excel attachment${args.partId ? ` ${args.partId}` : ''}${args.driveFileId ? ` (drive:${args.driveFileId})` : ''}`);
    try {
      const res = await sanitizerFetch('/excel/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailId: args.emailId,
          partId: args.partId,
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

/**
 * Load a local report tool extension if one is installed. Not found is the
 * normal, expected case (no local extension) — anything else is a real bug
 * in the extension and should surface, not be swallowed.
 */
async function loadLocalTools(): Promise<void> {
  try {
    const ext: LocalMcpExtension = await import('./local-monthly-report-mcp.js');
    ext.registerTools(server);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  }
}
await loadLocalTools();

const transport = new StdioServerTransport();
await server.connect(transport);
