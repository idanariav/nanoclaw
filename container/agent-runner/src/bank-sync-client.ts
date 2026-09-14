/**
 * Shared HTTP client for talking to the bank-sync host service, used by
 * every bank_sync_* MCP tool (bank-sync-mcp-stdio.ts) and by any local
 * extension tool module (see bank-sync-mcp-stdio.ts's module comment) —
 * pulled out so a local extension can reuse it without a circular import
 * back into bank-sync-mcp-stdio.ts.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const BANK_SYNC_URL = process.env.BANK_SYNC_URL || 'http://host.docker.internal:8801';
const BANK_SYNC_TOKEN = process.env.BANK_SYNC_TOKEN || '';

export function log(msg: string): void {
  console.error(`[BANK_SYNC] ${msg}`);
}

export async function bankSyncFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${BANK_SYNC_URL}${path}`, {
    ...options,
    headers: { ...options?.headers, Authorization: `Bearer ${BANK_SYNC_TOKEN}` },
  });
}

/** What a local bank-sync tool module (./local-*-mcp.js) exports. */
export interface LocalMcpExtension {
  registerTools: (server: McpServer) => void;
}
