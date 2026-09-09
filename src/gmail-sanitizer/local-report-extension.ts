/**
 * Local report extension — install-specific, loaded automatically by
 * server.ts's local-report extension hook (see its module comment). Wires
 * Idan's bespoke monthly poetry-slam report engine (monthly-report.ts) as
 * two extra HTTP routes, using the same generic helpers (report-source.ts)
 * every other route uses. This file is the ONLY place that knows those
 * routes exist — server.ts has no reference to monthly-report.ts at all.
 */
import path from 'path';
import type http from 'http';

import { applyFilenameOverride, updateDriveFileBytes, uploadAttachmentToDrive } from './drive-client.js';
import { createDraft } from './gmail-client.js';
import {
  applyMonthlyReportChangesToBytes,
  MonthlyReportStructureError,
  MonthlyReportValidationError,
  readArtistPaymentRowsFromBytes,
  readMonthlyReportFromBytes,
  type MonthlyReportChanges,
} from './monthly-report.js';
import { loadArtistPaymentTemplate, renderArtistPaymentDrafts } from './artist-payment-drafts.js';
import {
  ensureXlsxExtension,
  readJsonBody,
  resolveExcelSourceBytes,
  sendJson,
  type ExcelSource,
  type LocalRoute,
} from './report-source.js';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Idan-editable, not code — see groups/jarvis/templates/README.md.
const ARTIST_PAYMENT_TEMPLATE_PATH = path.resolve(process.cwd(), 'groups/jarvis/templates/artist-payment-email.md');

/** Maps monthly-report.ts's error types to their HTTP shape. Anything else is rethrown for the top-level catch (502). */
function sendMonthlyReportError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof MonthlyReportStructureError) {
    sendJson(res, 422, { error: err.message });
    return;
  }
  if (err instanceof MonthlyReportValidationError) {
    sendJson(res, 400, { error: err.message });
    return;
  }
  throw err;
}

async function handleMonthlyReportRead(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as ExcelSource;
  let bytes: Buffer;
  try {
    ({ bytes } = await resolveExcelSourceBytes(body));
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    sendJson(res, 200, await readMonthlyReportFromBytes(bytes));
  } catch (err) {
    sendMonthlyReportError(res, err);
  }
}

async function handleMonthlyReportApply(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as ExcelSource & MonthlyReportChanges & { filename?: string };
  let bytes: Buffer;
  let originalFilename: string | undefined;
  try {
    ({ bytes, originalFilename } = await resolveExcelSourceBytes(body));
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  let newBytes: Buffer;
  try {
    newBytes = await applyMonthlyReportChangesToBytes(bytes, {
      artists: body.artists,
      eventRows: body.eventRows,
      eventSheetEdits: body.eventSheetEdits,
    });
  } catch (err) {
    sendMonthlyReportError(res, err);
    return;
  }

  // A driveFileId source is the canonical working file — update it in place so repeated
  // edits across a month don't pile up as new Drive copies. A fresh Gmail attachment has no
  // existing Drive file yet, so its first save still has to create one.
  if (body.driveFileId) {
    sendJson(res, 200, await updateDriveFileBytes(body.driveFileId, XLSX_MIME_TYPE, newBytes));
    return;
  }
  const filename = originalFilename
    ? ensureXlsxExtension(applyFilenameOverride(originalFilename, body.filename))
    : body.filename
      ? ensureXlsxExtension(body.filename)
      : undefined;
  if (!filename) {
    sendJson(res, 400, { error: 'filename is required when saving a fresh attachment for the first time' });
    return;
  }
  sendJson(res, 200, await uploadAttachmentToDrive(filename, XLSX_MIME_TYPE, newBytes));
}

/**
 * Deterministic mail-merge: renders one draft per artist row from the fixed template file and
 * (unless dryRun) creates it in Gmail. Never returns an email address, a rendered subject, or a
 * rendered body — those never need to leave this process. See artist-payment-drafts.ts's header
 * comment for why this whole pipeline is scripted rather than agent-composed.
 */
async function handleCreateArtistPaymentDrafts(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as ExcelSource & { dryRun?: boolean; onlyArtist?: string };
  let bytes: Buffer;
  try {
    ({ bytes } = await resolveExcelSourceBytes(body));
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  let rows: Awaited<ReturnType<typeof readArtistPaymentRowsFromBytes>>;
  try {
    rows = await readArtistPaymentRowsFromBytes(bytes);
  } catch (err) {
    sendMonthlyReportError(res, err);
    return;
  }

  let template: Awaited<ReturnType<typeof loadArtistPaymentTemplate>>;
  try {
    template = await loadArtistPaymentTemplate(ARTIST_PAYMENT_TEMPLATE_PATH);
  } catch (err) {
    sendJson(res, 500, {
      error: `Failed to load the artist payment template at ${ARTIST_PAYMENT_TEMPLATE_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const dryRun = body.dryRun ?? true;
  const { rendered, skipped } = renderArtistPaymentDrafts(rows, template, new Date(), body.onlyArtist);

  const results: { name: string; amount: string; draftId?: string }[] = [];
  for (const draft of rendered) {
    if (dryRun) {
      results.push({ name: draft.name, amount: draft.amount });
      continue;
    }
    const created = await createDraft({ to: draft.to, subject: draft.subject, body: draft.body });
    results.push({ name: draft.name, amount: draft.amount, draftId: created.draftId });
  }

  sendJson(res, 200, { dryRun, results, skipped });
}

export const routes: LocalRoute[] = [
  { method: 'POST', pathname: '/monthly-report/read', handle: handleMonthlyReportRead },
  { method: 'POST', pathname: '/monthly-report/apply', handle: handleMonthlyReportApply },
  { method: 'POST', pathname: '/monthly-report/create-artist-payment-drafts', handle: handleCreateArtistPaymentDrafts },
];
