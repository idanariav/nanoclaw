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
  'gmail_list_drive_folder',
  'List the files inside the Drive folder Jarvis has been granted scoped access to — including files uploaded manually or by other apps, not just ones saved here via gmail_save_attachment_to_drive. Returns each file\'s Drive id, name, mime type, size, last-modified time, and view link. Use the returned id with gmail_read_excel_attachment, gmail_edit_excel_attachment, or gmail_create_draft\'s attachments to work with a file you did not save yourself. Only works if a scoped Drive folder has been configured (GMAIL_SANITIZER_DRIVE_FOLDER_ID) — a clear error is returned otherwise.',
  {},
  async () => {
    log('Listing scoped Drive folder');
    try {
      const res = await sanitizerFetch('/drive/folder');
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `gmail-sanitizer error: ${res.status} ${await res.text()}` }],
          isError: true,
        };
      }
      const files = (await res.json()) as unknown[];
      return { content: [{ type: 'text' as const, text: JSON.stringify(files, null, 2) }] };
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
  'gmail_copy_drive_file',
  'Copy a file in the scoped Drive folder to a new file with a new name (server-side; the original is untouched). Use this to create a new period file from a template, e.g. copy the monthly report template to the new month name, then edit the copy. Returns the new driveFileId, webViewLink and filename.',
  {
    driveFileId: z.string().describe('Drive file id (from gmail_list_drive_folder or an earlier save/edit result)'),
    newName: z.string().describe('Name for the new file (the original extension is kept if you omit it)'),
  },
  async ({ driveFileId, newName }) => {
    log(`Copy Drive file ${driveFileId} -> ${newName}`);
    try {
      const res = await sanitizerFetch('/drive/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driveFileId, newName }),
      });
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `gmail-sanitizer error: ${res.status} ${await res.text()}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(await res.json(), null, 2) }] };
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
  'gmail_rename_drive_file',
  'Rename a file in the scoped Drive folder in place (same id and link). Returns the driveFileId, webViewLink and final filename.',
  {
    driveFileId: z.string().describe('Drive file id (from gmail_list_drive_folder or an earlier save/edit result)'),
    newName: z.string().describe('New name for the file (the original extension is kept if you omit it)'),
  },
  async ({ driveFileId, newName }) => {
    log(`Rename Drive file ${driveFileId} -> ${newName}`);
    try {
      const res = await sanitizerFetch('/drive/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driveFileId, newName }),
      });
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `gmail-sanitizer error: ${res.status} ${await res.text()}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(await res.json(), null, 2) }] };
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
