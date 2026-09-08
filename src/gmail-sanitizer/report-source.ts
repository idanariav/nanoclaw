/**
 * Small helpers shared by every report-editing route in server.ts, and by
 * any local report extension wired through server.ts's local-report
 * extension hook (see server.ts's module comment) — resolving a workbook's
 * bytes from either a fresh Gmail attachment or a previously-saved Drive
 * file, and generic JSON-over-HTTP request/response helpers. Pulled out of
 * server.ts specifically so a local extension can reuse them without a
 * circular import back into server.ts.
 */
import http from 'http';

import { getAttachmentBytes, resolveAttachmentByPartId } from './gmail-client.js';
import { downloadDriveFileBytes } from './drive-client.js';

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data);
}

export async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export interface ExcelSource {
  emailId?: string;
  partId?: string;
  driveFileId?: string;
}

/** Fetch a source workbook's bytes from either a fresh Gmail attachment or a previously-saved Drive file. */
export async function resolveExcelSourceBytes(
  source: ExcelSource,
): Promise<{ bytes: Buffer; originalFilename?: string }> {
  if (source.emailId && source.partId) {
    const attachment = await resolveAttachmentByPartId(source.emailId, source.partId);
    if (!attachment) throw new Error(`Attachment part ${source.partId} not found on message ${source.emailId}`);
    const bytes = await getAttachmentBytes(source.emailId, attachment.attachmentId);
    return { bytes, originalFilename: attachment.filename };
  }
  if (source.driveFileId) {
    return { bytes: await downloadDriveFileBytes(source.driveFileId) };
  }
  throw new Error('Provide either (emailId and partId) or driveFileId');
}

export function ensureXlsxExtension(name: string): string {
  return name.toLowerCase().endsWith('.xlsx') ? name : `${name}.xlsx`;
}

/** One extra HTTP route contributed by a local report extension (see server.ts). */
export interface LocalRoute {
  method: string;
  pathname: string;
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
}

/** What a local report extension module (./local-report-extension.js) exports. */
export interface LocalReportExtension {
  routes: LocalRoute[];
}
