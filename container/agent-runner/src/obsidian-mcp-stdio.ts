/**
 * Obsidian MCP server for NanoClaw — thin client over the obsidian-bridge
 * host service (src/obsidian-bridge/, outside this container). That service
 * is the only thing that can actually talk to the live Obsidian app (a
 * macOS Mach-O binary over a local Unix socket); this file just forwards
 * {command, args} over HTTP and returns the result. Every command and path
 * is validated on the other side of that HTTP call, not here.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const OBSIDIAN_BRIDGE_URL = process.env.OBSIDIAN_BRIDGE_URL || 'http://host.docker.internal:8800';
const OBSIDIAN_BRIDGE_TOKEN = process.env.OBSIDIAN_BRIDGE_TOKEN || '';

function log(msg: string): void {
  console.error(`[OBSIDIAN] ${msg}`);
}

const server = new McpServer({ name: 'obsidian', version: '1.0.0' });

server.tool(
  'obsidian_run',
  `Run an obsidian-cli command against the live Obsidian vault, through the host bridge. Only a fixed allowlist of note/vault commands is reachable — anything else (eval, dev:*, plugin/theme install, restart, sync toggle, etc.) is refused by the bridge. Any command that targets a file/folder needs an explicit vault-relative 'path=' (or 'folder=') argument under Scaffolding/, Sources/, or Content/ — 'file=<name>' fuzzy lookup is not permitted, since it can silently resolve to a same-named note outside those folders.

Common commands: read (path=), create (path=, content=), append/prepend (path=, content=), delete (path=), move (path=, to=), rename (path=, name=), properties/tags/tasks/links/backlinks/outline/history (path=), property:read/set/remove (path=, name=, value=), files/folders/random (folder=), base:query/base:create (path=), vault/vaults/version/plugins/themes/hotkeys/commands (no location needed).

Pass boolean flags (e.g. verbose, total) as args with value true.`,
  {
    command: z.string().describe('The obsidian-cli command, e.g. "read", "create", "properties"'),
    args: z
      .record(z.string(), z.union([z.string(), z.boolean()]))
      .optional()
      .describe('Command arguments as key=value pairs, e.g. { path: "Content/Claims/foo.md", content: "..." }. Boolean flags: true.'),
  },
  async (args) => {
    log(`Running: ${args.command} ${JSON.stringify(args.args ?? {})}`);
    try {
      const res = await fetch(`${OBSIDIAN_BRIDGE_URL}/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OBSIDIAN_BRIDGE_TOKEN}`,
        },
        body: JSON.stringify({ command: args.command, args: args.args ?? {} }),
      });
      const result = await res.json();
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `obsidian-bridge error: ${res.status} ${JSON.stringify(result)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to reach obsidian-bridge at ${OBSIDIAN_BRIDGE_URL}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
