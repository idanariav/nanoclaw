/**
 * Deterministic mail-merge for Idan's artist-payment drafts. Reads the report's raw artist rows
 * (readArtistPaymentRowsFromBytes in monthly-report.ts) and a Handlebars template file at
 * groups/jarvis/templates/artist-payment-email.md, and renders one subject/body per artist. No
 * LLM is involved anywhere in this — rendering is pure string substitution against data this
 * process already holds unredacted. Callers (local-report-extension.ts) must never return a
 * RenderedArtistDraft's `to`/`subject`/`body` outside this process — only `name`/`amount`, which
 * are already non-sensitive elsewhere in this report (see monthly-report.ts's ARTISTS.sensitiveCols).
 */
import fs from 'fs/promises';

import Handlebars from 'handlebars';

import type { ArtistPaymentRow } from './monthly-report.js';

const handlebars = Handlebars.create();
handlebars.registerHelper('eq', (a: unknown, b: unknown) => Number(a) === Number(b));
handlebars.registerHelper('ne', (a: unknown, b: unknown) => Number(a) !== Number(b));
handlebars.registerHelper('gt', (a: unknown, b: unknown) => Number(a) > Number(b));
handlebars.registerHelper('gte', (a: unknown, b: unknown) => Number(a) >= Number(b));
handlebars.registerHelper('lt', (a: unknown, b: unknown) => Number(a) < Number(b));
handlebars.registerHelper('lte', (a: unknown, b: unknown) => Number(a) <= Number(b));

export class ArtistPaymentTemplateError extends Error {}

export interface ArtistPaymentTemplate {
  subject: string;
  body: string;
}

/** Parses "Subject: ...\n\n<body>" — the one convention the template file follows. */
export function parseArtistPaymentTemplate(raw: string): ArtistPaymentTemplate {
  const match = /^Subject:[ \t]*(.*)\r?\n\r?\n([\s\S]*)$/.exec(raw);
  if (!match) {
    throw new ArtistPaymentTemplateError(
      'Template must start with "Subject: ..." followed by a blank line, then the body.',
    );
  }
  return { subject: match[1].trim(), body: match[2] };
}

export async function loadArtistPaymentTemplate(templatePath: string): Promise<ArtistPaymentTemplate> {
  const raw = await fs.readFile(templatePath, 'utf8');
  return parseArtistPaymentTemplate(raw);
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** The 7th of the month after `referenceDate`, formatted dd/mm/yyyy — matches monthly-report.ts's own date formatting convention. */
export function computeInvoiceDeadline(referenceDate: Date): string {
  const deadline = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() + 1, 7));
  return `${pad2(deadline.getUTCDate())}/${pad2(deadline.getUTCMonth() + 1)}/${deadline.getUTCFullYear()}`;
}

export interface RenderedArtistDraft {
  name: string;
  amount: string;
  to: string;
  subject: string;
  body: string;
}

export interface SkippedArtistRow {
  name: string;
  reason: string;
}

export interface ArtistPaymentDraftsResult {
  rendered: RenderedArtistDraft[];
  skipped: SkippedArtistRow[];
}

/** The payee's email if given (the usual case — payment goes to whoever's listed as payee), falling back to the artist's own email. */
function resolveRecipient(row: ArtistPaymentRow): string | undefined {
  return row.payeeEmail || row.email || undefined;
}

export function renderArtistPaymentDrafts(
  rows: ArtistPaymentRow[],
  template: ArtistPaymentTemplate,
  referenceDate: Date,
  onlyArtist?: string,
): ArtistPaymentDraftsResult {
  const subjectTemplate = handlebars.compile(template.subject);
  const bodyTemplate = handlebars.compile(template.body);
  const invoiceDeadline = computeInvoiceDeadline(referenceDate);

  const rendered: RenderedArtistDraft[] = [];
  const skipped: SkippedArtistRow[] = [];

  for (const row of rows) {
    if (onlyArtist && row.name !== onlyArtist) continue;

    const amount = Number(row.amount);
    if (!row.amount || !Number.isFinite(amount) || amount <= 0) {
      skipped.push({ name: row.name, reason: 'amount is blank or not greater than zero' });
      continue;
    }

    const to = resolveRecipient(row);
    if (!to) {
      skipped.push({ name: row.name, reason: 'no email address on file' });
      continue;
    }

    const fields = { name: row.name, firstName: firstName(row.name), amount: row.amount, invoiceDeadline };
    rendered.push({
      name: row.name,
      amount: row.amount,
      to,
      subject: subjectTemplate(fields),
      body: bodyTemplate(fields),
    });
  }

  return { rendered, skipped };
}
