/**
 * Clarity MCP server for NanoClaw — thin client over the clarity-bridge host
 * service (src/clarity-bridge/, outside this container). That service is the
 * only thing that has a signed-in Clarity CLI session; this file just
 * forwards {command, positional, flags, stdin} over HTTP and returns the
 * result. Every command is validated on the other side of that HTTP call,
 * not here.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const CLARITY_BRIDGE_URL = process.env.CLARITY_BRIDGE_URL || 'http://host.docker.internal:8802';
const CLARITY_BRIDGE_TOKEN = process.env.CLARITY_BRIDGE_TOKEN || '';

function log(msg: string): void {
  console.error(`[CLARITY] ${msg}`);
}

const server = new McpServer({ name: 'clarity', version: '1.0.0' });

server.tool(
  'clarity_run',
  `Run a command against Idan's Clarity task manager (boards, projects, tags, milestones, habits, packing templates), through the host bridge — only a fixed allowlist of commands is reachable.

Always call "workspace" first to learn valid board/column/project/tag/milestone names and the CQL filter syntax before querying or creating tasks.

Commands (dashes, not spaces — e.g. "task-create" not "task create"): workspace, tools, view-run, task-query, task-get, task-create, task-update, task-complete, task-delete, task-bulk-create, task-bulk-update, task-bulk-delete, milestone-create, tag-create, tag-update, tag-delete, project-create, project-update, project-delete, checklist-add, checklist-set-done, checklist-rename, checklist-delete, habit-list, habit-complete, habit-set-day, packing-list, packing-create-template, packing-create-instance, packing-update-item.

positional: ordered positional args (e.g. ["Buy milk"] for task-create's <title>, ["<id>"] for task-get/update/complete/delete).
flags: named flags as key/value (e.g. { priority: 2, tags: "errand" }); a boolean true becomes a bare flag.
stdin: JSON payload string, only for task-bulk-create/bulk-update/bulk-delete (the {defaults, items} / {ids|cql, set} / {ids|cql} payload documented by "tools"). Use flags: { "dry-run": true } to preview a bulk write first.

Delete-class commands (task-delete, task-bulk-delete, tag-delete, project-delete, checklist-delete) are refused unless flags.confirm is true — set it only once you're sure.`,
  {
    command: z.string().describe('The clarity command, e.g. "workspace", "task-query", "task-create"'),
    positional: z.array(z.string()).optional().describe('Ordered positional arguments, e.g. ["Buy milk"]'),
    flags: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe('Named flags as key/value, e.g. { priority: 2, tags: "errand" }. Boolean true: bare flag.'),
    stdin: z.string().optional().describe('JSON payload for bulk-create/bulk-update/bulk-delete only.'),
  },
  async (args) => {
    log(`Running: ${args.command} ${JSON.stringify({ positional: args.positional, flags: args.flags })}`);
    try {
      const res = await fetch(`${CLARITY_BRIDGE_URL}/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CLARITY_BRIDGE_TOKEN}`,
        },
        body: JSON.stringify({
          command: args.command,
          positional: args.positional ?? [],
          flags: args.flags ?? {},
          stdin: args.stdin,
        }),
      });
      const result = await res.json();
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `clarity-bridge error: ${res.status} ${JSON.stringify(result)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to reach clarity-bridge at ${CLARITY_BRIDGE_URL}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
