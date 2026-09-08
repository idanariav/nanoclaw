/**
 * Local report extension — install-specific, loaded automatically by
 * server.ts's local-report extension hook (see its module comment). Wires
 * Idan's bespoke monthly poetry-slam report engine (monthly-report.ts) as
 * two extra HTTP routes, using the same generic helpers (report-source.ts)
 * every other route uses. This file is the ONLY place that knows those
 * routes exist — server.ts has no reference to monthly-report.ts at all.
 */
import type http from 'http';

import { applyFilenameOverride, updateDriveFileBytes, uploadAttachmentToDrive } from './drive-client.js';
import {
  applyMonthlyReportChangesToBytes,
  MonthlyReportStructureError,
  MonthlyReportValidationError,
  readMonthlyReportFromBytes,
  type MonthlyReportChanges,
} from './monthly-report.js';
import {
  ensureXlsxExtension,
  readJsonBody,
  resolveExcelSourceBytes,
  sendJson,
  type ExcelSource,
  type LocalRoute,
} from './report-source.js';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

export const routes: LocalRoute[] = [
  { method: 'POST', pathname: '/monthly-report/read', handle: handleMonthlyReportRead },
  { method: 'POST', pathname: '/monthly-report/apply', handle: handleMonthlyReportApply },
];
