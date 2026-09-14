/**
 * Bank-sync MCP server for NanoClaw — thin client over the bank-sync host
 * service (src/bank-sync/, outside this container). All bank/credit-card
 * login credentials and scraping happen on the other side of this HTTP
 * call; this file never sees a credential value.
 *
 * Local extension tools: every tool below is generic. A bespoke tool that
 * needs its own logic (e.g. parsing one operator's specific budget-app
 * export) can be added without touching this file: drop a module at
 * ./local-*-mcp.js exporting `registerTools(server)` and it's loaded and
 * called automatically, before the transport connects.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { BANK_SYNC_URL, bankSyncFetch, log, type LocalMcpExtension } from './bank-sync-client.js';

const server = new McpServer({ name: 'bank-sync', version: '1.0.0' });

function connectionError(err: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Failed to reach bank-sync at ${BANK_SYNC_URL}: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
    isError: true,
  };
}

async function bankSyncError(res: Response) {
  return {
    content: [{ type: 'text' as const, text: `bank-sync error: ${res.status} ${await res.text()}` }],
    isError: true,
  };
}

server.tool(
  'bank_sync_accounts',
  'List the bank/credit-card accounts configured for scraping (account id + company only — never login credentials). Use this to know what accountIds are available to pass to bank_sync_start, or to tell the user what is/isn\'t wired up yet.',
  {},
  async () => {
    log('Listing configured accounts');
    try {
      const res = await bankSyncFetch('/accounts');
      if (!res.ok) return await bankSyncError(res);
      return { content: [{ type: 'text' as const, text: JSON.stringify(await res.json(), null, 2) }] };
    } catch (err) {
      return connectionError(err);
    }
  },
);

server.tool(
  'bank_sync_start',
  'Start scraping this and last month\'s transactions from the configured bank/credit-card accounts (login credentials never reach you — they stay in the bank-sync host service). Returns a runId immediately; scraping runs in the background and can take from tens of seconds up to a couple of minutes per account. Poll bank_sync_status with the returned runId to get results. There is no OTP/2FA step to relay — if a login hits a verification wall on the bank\'s site, that account will simply come back with status "error" when you poll.',
  {
    accountIds: z
      .array(z.string())
      .optional()
      .describe('Specific account ids (from bank_sync_accounts) to scrape. Omit to scrape every configured account.'),
  },
  async (args) => {
    log(`Starting scrape${args.accountIds ? ` for ${args.accountIds.join(', ')}` : ' for all configured accounts'}`);
    try {
      const res = await bankSyncFetch('/scrape/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountIds: args.accountIds }),
      });
      if (!res.ok) return await bankSyncError(res);
      return { content: [{ type: 'text' as const, text: JSON.stringify(await res.json(), null, 2) }] };
    } catch (err) {
      return connectionError(err);
    }
  },
);

server.tool(
  'bank_sync_status',
  'Check progress/results of a scrape started with bank_sync_start. Each account reports status "pending" | "running" | "done" | "error", and "done" accounts include their normalized transactions (date, amount, currency, description, status). Poll this every few seconds until every account is "done" or "error".',
  {
    runId: z.string().describe('The runId returned by bank_sync_start'),
  },
  async (args) => {
    log(`Checking status of run ${args.runId}`);
    try {
      const res = await bankSyncFetch(`/scrape/status/${encodeURIComponent(args.runId)}`);
      if (!res.ok) return await bankSyncError(res);
      return { content: [{ type: 'text' as const, text: JSON.stringify(await res.json(), null, 2) }] };
    } catch (err) {
      return connectionError(err);
    }
  },
);

/**
 * Load a local tool extension if one is installed. Not found is the normal,
 * expected case (no local extension) — anything else is a real bug in the
 * extension and should surface, not be swallowed.
 */
async function loadLocalTools(): Promise<void> {
  try {
    const ext: LocalMcpExtension = await import('./local-budget-reconciliation-mcp.js');
    ext.registerTools(server);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  }
}
await loadLocalTools();

const transport = new StdioServerTransport();
await server.connect(transport);
