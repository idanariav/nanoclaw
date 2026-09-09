/**
 * Local report MCP tools — install-specific, loaded automatically by
 * gmail-mcp-stdio.ts's local report tool hook (see its module comment).
 * Mirrors src/gmail-sanitizer/local-report-extension.ts's routes as
 * agent-facing tools; this file is the only place that knows they exist.
 *
 * The agent only ever sees CSVs — this file is the translation boundary.
 * `gmail_read_monthly_report` fetches the host's JSON snapshot and writes it
 * out as CSVs (via monthly-report-csv.ts) for the agent to read/edit with
 * its normal file tools; `gmail_apply_monthly_report_changes` reads those
 * CSVs back, converts them to the host's JSON changes shape, and applies
 * them. The host's own write path (src/gmail-sanitizer/monthly-report.ts)
 * now auto-renames/reorders event sheets and re-syncs הוצאות on every
 * apply, so this layer never needs to think about sheet identity either.
 *
 * `gmail_create_artist_payment_drafts` is different in kind: it triggers a
 * fully scripted mail-merge that runs entirely on the host (see
 * artist-payment-drafts.ts) — this tool passes through no email content and
 * gets none back, only a per-artist name/amount/status summary. Nothing
 * about wording is ever composed by the agent.
 */
import fs from 'fs/promises';
import path from 'path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { GMAIL_SANITIZER_URL, log, sanitizerFetch } from './gmail-sanitizer-client.js';
import { csvFilesToChanges, snapshotToCsvFiles, type MonthlyReportSnapshot } from './monthly-report-csv.js';

const CSV_DIR = '/workspace/agent/monthly-report';
const CSV_FILENAMES = ['events.csv', 'participants.csv', 'artists.csv', 'ticket_summary.csv', 'venue_payment.csv'];

const sourceSchema = {
  emailId: z.string().optional().describe('The email id, if reading a fresh Gmail attachment (with partId)'),
  partId: z.string().optional().describe("The attachment's part id, if reading a fresh Gmail attachment (with emailId)"),
  driveFileId: z.string().optional().describe('The Drive file id of the canonical working copy'),
};

async function readSnapshot(source: { emailId?: string; partId?: string; driveFileId?: string }): Promise<
  { ok: true; snapshot: MonthlyReportSnapshot } | { ok: false; status: number; text: string }
> {
  const res = await sanitizerFetch('/monthly-report/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(source),
  });
  if (!res.ok) return { ok: false, status: res.status, text: await res.text() };
  return { ok: true, snapshot: (await res.json()) as MonthlyReportSnapshot };
}

async function readCsvFile(name: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(CSV_DIR, name), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export function registerTools(server: McpServer): void {
  server.tool(
    'gmail_read_monthly_report',
    "Read Idan's one monthly poetry-slam report workbook and write it out as CSV files for you to edit directly — a bespoke tool for that one specific report, separate from gmail_read_excel_attachment. Provide either (emailId + partId) for a fresh attachment, or driveFileId for the canonical working copy already saved to Drive (the usual case — ask Idan for the link/id once, then reuse it all month). Writes events.csv, participants.csv, artists.csv, ticket_summary.csv, venue_payment.csv, monthlies.csv, and README.md to /workspace/agent/monthly-report/ — read README.md first, it explains each file and which are editable. Sensitive artist/registry fields (ת.ז./מעמד/אימייל) come back as [CELL_n] tokens in artists.csv, same rule as gmail_read_excel_attachment — copy them through as-is if you're not changing them. An unrecognized file (structure doesn't match the known template) returns a 422 naming what differed — don't try to force it, tell Idan.",
    sourceSchema,
    async (args) => {
      log(`Reading monthly report${args.driveFileId ? ` (drive:${args.driveFileId})` : ''}`);
      try {
        const result = await readSnapshot(args);
        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: `gmail-sanitizer error: ${result.status} ${result.text}` }], isError: true };
        }
        const files = snapshotToCsvFiles(result.snapshot);
        await fs.mkdir(CSV_DIR, { recursive: true });
        await Promise.all(
          Object.entries(files).map(([name, content]) => fs.writeFile(path.join(CSV_DIR, name), content, 'utf8')),
        );
        const summary = Object.keys(files)
          .map((name) => `  ${CSV_DIR}/${name}`)
          .join('\n');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Wrote the current report state to:\n${summary}\n\nRead README.md first. Edit the CSVs directly, then call gmail_apply_monthly_report_changes with the same source to apply.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to reach gmail-sanitizer at ${GMAIL_SANITIZER_URL}: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'gmail_apply_monthly_report_changes',
    'Apply the CSVs at /workspace/agent/monthly-report/ (written and edited via gmail_read_monthly_report) to Idan\'s monthly poetry-slam report and save the result. If `driveFileId` was given, this UPDATES that same Drive file in place (same id/link) — it does not create a new copy every time, unlike gmail_edit_excel_attachment. A fresh (emailId+partId) source still creates the first Drive copy; use its returned driveFileId for every change after that. A blank or placeholder `slot` in events.csv (e.g. "NEW1") is assigned the next free slot automatically — the same token in participants.csv/ticket_summary.csv/venue_payment.csv resolves to the same assigned slot. Renaming/reordering event sheets to match their dates and re-syncing הוצאות now happen automatically — nothing to request here beyond the data itself.',
    {
      ...sourceSchema,
      filename: z.string().optional().describe('Filename for the first save of a fresh attachment (with or without .xlsx) — ignored once driveFileId is used'),
    },
    async (args) => {
      log(`Applying monthly report changes${args.driveFileId ? ` (drive:${args.driveFileId})` : ''}`);
      try {
        const fresh = await readSnapshot(args);
        if (!fresh.ok) {
          return { content: [{ type: 'text' as const, text: `gmail-sanitizer error reading current state: ${fresh.status} ${fresh.text}` }], isError: true };
        }
        const usedSlots = fresh.snapshot.summaryRows.map((r) => r.slot);

        const files: Record<string, string> = {};
        for (const name of CSV_FILENAMES) {
          const content = await readCsvFile(name);
          if (content !== undefined) files[name] = content;
        }
        if (!files['events.csv'] && !files['artists.csv']) {
          return {
            content: [{ type: 'text' as const, text: `No CSV files found in ${CSV_DIR} — run gmail_read_monthly_report first.` }],
            isError: true,
          };
        }

        const { changes, slotAssignments } = csvFilesToChanges(files, usedSlots);

        const res = await sanitizerFetch('/monthly-report/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...args, ...changes }),
        });
        if (!res.ok) {
          return { content: [{ type: 'text' as const, text: `gmail-sanitizer error: ${res.status} ${await res.text()}` }], isError: true };
        }
        const result = await res.json();
        const assignmentsText = Object.keys(slotAssignments).length
          ? `\n\nNew events assigned:\n${Object.entries(slotAssignments)
              .map(([token, slot]) => `  ${token} -> slot ${slot}`)
              .join('\n')}`
          : '';
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) + assignmentsText }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to reach gmail-sanitizer at ${GMAIL_SANITIZER_URL}: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'gmail_create_artist_payment_drafts',
    "Bulk-create one Gmail draft per artist for their monthly payment, using Idan's report and his editable template at groups/jarvis/templates/artist-payment-email.md — NEVER sends anything, only saves to Drafts. This is a fully scripted mail-merge: you never see or write any part of the email's subject/body, and this tool never returns one either — only a per-artist name/amount/status list, so no email content or address ever passes through you. Skips (and reports, with a reason) any artist with a blank/zero amount or no email on file. `dryRun` defaults to true — run it that way first and read back the list of who would get a draft and for how much before setting `dryRun: false` to actually create them; use `onlyArtist` to test a single artist end-to-end first. If Idan wants the wording changed, tell him to edit the template file directly — that's not something you do for him.",
    {
      ...sourceSchema,
      dryRun: z
        .boolean()
        .optional()
        .default(true)
        .describe('Preview only (default true) — no drafts are created. Pass false to actually create them.'),
      onlyArtist: z.string().optional().describe('Limit to one artist by their exact name in the report, for testing before running the full batch'),
    },
    async (args) => {
      log(`Creating artist payment drafts${args.driveFileId ? ` (drive:${args.driveFileId})` : ''}${args.dryRun ? ' [dry run]' : ''}${args.onlyArtist ? ` [only: ${args.onlyArtist}]` : ''}`);
      try {
        const res = await sanitizerFetch('/monthly-report/create-artist-payment-drafts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        });
        if (!res.ok) {
          return { content: [{ type: 'text' as const, text: `gmail-sanitizer error: ${res.status} ${await res.text()}` }], isError: true };
        }
        const result = await res.json();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to reach gmail-sanitizer at ${GMAIL_SANITIZER_URL}: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
