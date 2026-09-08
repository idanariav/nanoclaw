/**
 * Shared HTTP client for talking to the gmail-sanitizer host service, used
 * by every gmail_* MCP tool (gmail-mcp-stdio.ts) and by any local report
 * extension tool module (see gmail-mcp-stdio.ts's module comment) — pulled
 * out so a local extension can reuse it without a circular import back into
 * gmail-mcp-stdio.ts.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const GMAIL_SANITIZER_URL = process.env.GMAIL_SANITIZER_URL || 'http://host.docker.internal:8799';
const GMAIL_SANITIZER_TOKEN = process.env.GMAIL_SANITIZER_TOKEN || '';

export function log(msg: string): void {
  console.error(`[GMAIL] ${msg}`);
}

export async function sanitizerFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${GMAIL_SANITIZER_URL}${path}`, {
    ...options,
    headers: { ...options?.headers, Authorization: `Bearer ${GMAIL_SANITIZER_TOKEN}` },
  });
}

/** What a local report tool module (./local-monthly-report-mcp.js) exports. */
export interface LocalMcpExtension {
  registerTools: (server: McpServer) => void;
}
