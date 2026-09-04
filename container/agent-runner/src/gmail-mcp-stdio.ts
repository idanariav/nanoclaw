/**
 * Gmail MCP server for NanoClaw — thin client over the gmail-sanitizer
 * host service (src/gmail-sanitizer/, outside this container). All PII
 * redaction and Gmail/Drive credential handling happen on the other side
 * of this HTTP call; this file never sees a raw Gmail credential and never
 * receives attachment bytes.
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
  'Search Gmail. Returns redacted subject/snippet — bank account numbers, phone numbers, and ID numbers are already stripped and replaced with tags like [PHONE_REDACTED]. Use standard Gmail search syntax for the query (e.g. "from:someone@example.com", "is:unread", "after:2026/01/01").',
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
  'Read one email by id (from gmail_search_emails). Returns the redacted subject and body plus attachment metadata (filename, mime type, size) — attachment CONTENT is never returned. Use gmail_save_attachment_to_drive to move an attachment without opening it.',
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

const transport = new StdioServerTransport();
await server.connect(transport);
