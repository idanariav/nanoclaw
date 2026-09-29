/**
 * Contacts MCP server for NanoClaw — thin client over the gmail-sanitizer
 * host service (src/gmail-sanitizer/, outside this container). Wired as its
 * own MCP server, separate from gmail-mcp-stdio.ts, so Contacts access can
 * be granted to an agent group independently of Gmail/Drive access — both
 * still route through the same bridge process and OneCLI identity.
 *
 * The bridge reduces every Google People API response to presence-only
 * booleans before it ever reaches this file: no email address or phone
 * number value is ever returned here, only whether one exists.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { GMAIL_SANITIZER_URL, log, sanitizerFetch } from './gmail-sanitizer-client.js';

const server = new McpServer({ name: 'contacts', version: '1.0.0' });

server.tool(
  'contacts_lookup',
  'Check whether a Google Contact exists for a given full name, and whether it has an email address and/or phone number saved — without ever revealing the email address or phone number itself. Matches on an exact (case-insensitive) display name; a near-miss spelling will come back as not found. Returns {exists, has_email, has_phone}.',
  {
    name: z.string().describe('Full contact name to look up, e.g. "Moshe Cohen"'),
  },
  async (args) => {
    log(`Looking up contact: ${args.name}`);
    try {
      const res = await sanitizerFetch(`/contacts/lookup?name=${encodeURIComponent(args.name)}`);
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
