/**
 * Standalone entrypoint. Runs as its own process (own service unit — see
 * scripts/setup-gmail-sanitizer-service.ts), independent of the main
 * NanoClaw host process and of any agent group's container. Binds to
 * localhost only; containers reach it via host.docker.internal.
 *
 * Every response here has already been through anonymize.ts (email
 * content) or has never carried raw bytes at all (attachment / URL
 * save-to-drive) — that's the boundary this whole service exists to
 * enforce. Draft creation runs the reverse direction: any anonymization
 * token in the agent-supplied text (e.g. `[PHONE_1]`) is swapped back to
 * the real value here, right before it reaches Gmail — the agent's
 * context never holds the real value, only the token.
 *
 * Local report extension: everything in this file is generic (any report's
 * structure goes through excel-reports.ts's config-driven templates). A
 * bespoke report that needs real code — not just a template entry — can be
 * wired in without touching this file: drop a module at
 * ./local-report-extension.ts exporting `routes: LocalRoute[]` (see
 * report-source.ts), and it's loaded and served automatically. Nothing here
 * knows or needs to know what such an extension actually does.
 */
import http from 'http';

import {
  addLabel,
  archiveEmail,
  createDraft,
  getAttachmentBytes,
  getEmail,
  listEmails,
  resolveAttachmentByPartId,
} from './gmail-client.js';
import {
  applyFilenameOverride,
  downloadDriveFileBytes,
  getDriveFileMetadata,
  uploadAttachmentToDrive,
} from './drive-client.js';
import { fetchUrlToBuffer } from './url-fetch.js';
import { anonymizeHtml, anonymizeText, deanonymizeText } from './anonymize.js';
import {
  applyEditsToBytes,
  readRawWorkbook,
  readReportFromBytes,
  ReportTooLargeError,
  RowVerificationError,
  UnrecognizedReportError,
  type AppendRow,
  type CellEdit,
} from './excel-reports.js';
import {
  ensureXlsxExtension,
  readJsonBody,
  resolveExcelSourceBytes,
  sendJson,
  type ExcelSource,
  type LocalReportExtension,
  type LocalRoute,
} from './report-source.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const envConfig = readEnvFile(['GMAIL_SANITIZER_PORT', 'GMAIL_SANITIZER_TOKEN']);
const PORT = parseInt(envConfig.GMAIL_SANITIZER_PORT || '8799', 10);
const TOKEN = envConfig.GMAIL_SANITIZER_TOKEN;

if (!TOKEN) {
  log.fatal('GMAIL_SANITIZER_TOKEN is not set — refusing to start with no shared-secret auth');
  process.exit(1);
}

function anonymizedBody(email: Awaited<ReturnType<typeof getEmail>>): string {
  if (email.bodyText) return anonymizeText(email.bodyText);
  if (email.bodyHtml) return anonymizeHtml(email.bodyHtml);
  return '';
}

async function handleListEmails(url: URL, res: http.ServerResponse): Promise<void> {
  const q = url.searchParams.get('q') ?? '';
  const maxResults = Math.min(Number(url.searchParams.get('maxResults') ?? '10') || 10, 50);
  const emails = await listEmails(q, maxResults);
  sendJson(
    res,
    200,
    emails.map((e) => ({
      id: e.id,
      threadId: e.threadId,
      from: e.from,
      subject: anonymizeText(e.subject),
      date: e.date,
      snippet: anonymizeText(e.snippet),
    })),
  );
}

async function handleGetEmail(id: string, res: http.ServerResponse): Promise<void> {
  const email = await getEmail(id);
  sendJson(res, 200, {
    id: email.id,
    threadId: email.threadId,
    from: email.from,
    to: email.to,
    subject: anonymizeText(email.subject),
    date: email.date,
    body: anonymizedBody(email),
    attachments: email.attachments.map((a) => ({
      partId: a.partId,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
    })),
  });
}

async function handleSaveAttachment(
  messageId: string,
  partId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const attachment = await resolveAttachmentByPartId(messageId, partId);
  if (!attachment) {
    sendJson(res, 404, { error: `Attachment part ${partId} not found on message ${messageId}` });
    return;
  }
  const body = (await readJsonBody(req)) as { filename?: string };
  const filename = applyFilenameOverride(attachment.filename, body.filename);
  const bytes = await getAttachmentBytes(messageId, attachment.attachmentId);
  const result = await uploadAttachmentToDrive(filename, attachment.mimeType, bytes);
  sendJson(res, 200, result);
}

async function handleSaveUrlToDrive(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as { url?: string; filename?: string };
  if (!body.url) {
    sendJson(res, 400, { error: 'url is required' });
    return;
  }
  const fetched = await fetchUrlToBuffer(body.url);
  const filename = applyFilenameOverride(fetched.filename, body.filename);
  const result = await uploadAttachmentToDrive(filename, fetched.mimeType, fetched.bytes);
  sendJson(res, 200, result);
}

async function handleCreateDraft(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as {
    to?: string;
    cc?: string;
    subject?: string;
    body?: string;
    emailId?: string;
    attachments?: string[];
  };
  if (!body.to || !body.subject || !body.body) {
    sendJson(res, 400, { error: 'to, subject, and body are required' });
    return;
  }
  const attachments = body.attachments?.length
    ? await Promise.all(
        body.attachments.map(async (driveFileId) => {
          const [meta, bytes] = await Promise.all([
            getDriveFileMetadata(driveFileId),
            downloadDriveFileBytes(driveFileId),
          ]);
          return { filename: meta.name, mimeType: meta.mimeType, bytes };
        }),
      )
    : undefined;
  const result = await createDraft({
    to: deanonymizeText(body.to),
    cc: body.cc ? deanonymizeText(body.cc) : undefined,
    subject: deanonymizeText(body.subject),
    body: deanonymizeText(body.body),
    emailId: body.emailId,
    attachments,
  });
  sendJson(res, 200, result);
}

async function handleArchive(messageId: string, res: http.ServerResponse): Promise<void> {
  await archiveEmail(messageId);
  sendJson(res, 200, { messageId, markedRead: true, archived: true });
}

async function handleAddLabel(messageId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as { label?: string };
  if (!body.label) {
    sendJson(res, 400, { error: 'label is required' });
    return;
  }
  await addLabel(messageId, body.label);
  sendJson(res, 200, { messageId, label: body.label });
}

/** Maps the excel-reports.ts error types to their HTTP shape. Anything else is rethrown for the top-level catch (502). */
function sendExcelError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof UnrecognizedReportError) {
    sendJson(res, 422, { error: err.message, sheetsFound: err.sheetsFound, headersBySheet: err.headersBySheet });
    return;
  }
  if (err instanceof ReportTooLargeError) {
    sendJson(res, 413, { error: err.message });
    return;
  }
  if (err instanceof RowVerificationError) {
    sendJson(res, 409, { error: err.message });
    return;
  }
  throw err;
}

async function handleExcelRead(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as ExcelSource & { readUnrecognized?: boolean };
  let bytes: Buffer;
  try {
    ({ bytes } = await resolveExcelSourceBytes(body));
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    sendJson(res, 200, await readReportFromBytes(bytes));
  } catch (err) {
    if (err instanceof UnrecognizedReportError && body.readUnrecognized) {
      sendJson(res, 200, await readRawWorkbook(bytes));
      return;
    }
    sendExcelError(res, err);
  }
}

async function handleExcelEdit(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as ExcelSource & {
    cellEdits?: CellEdit[];
    appendRows?: AppendRow[];
    filename?: string;
  };
  let bytes: Buffer;
  let originalFilename: string | undefined;
  try {
    ({ bytes, originalFilename } = await resolveExcelSourceBytes(body));
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const filename = originalFilename
    ? applyFilenameOverride(originalFilename, body.filename)
    : body.filename
      ? ensureXlsxExtension(body.filename)
      : undefined;
  if (!filename) {
    sendJson(res, 400, { error: 'filename is required when editing a file identified only by driveFileId' });
    return;
  }

  let newBytes: Buffer;
  try {
    newBytes = await applyEditsToBytes(bytes, { cellEdits: body.cellEdits, appendRows: body.appendRows });
  } catch (err) {
    sendExcelError(res, err);
    return;
  }
  sendJson(res, 200, await uploadAttachmentToDrive(filename, XLSX_MIME_TYPE, newBytes));
}

/**
 * Load a local report extension if one is installed. Not found is the
 * normal, expected case (no local extension) — anything else is a real bug
 * in the extension and should surface, not be swallowed.
 */
async function loadLocalRoutes(): Promise<LocalRoute[]> {
  try {
    const ext: LocalReportExtension = await import('./local-report-extension.js');
    log.info('gmail-sanitizer: loaded local report extension', { routes: ext.routes.map((r) => r.pathname) });
    return ext.routes;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ERR_MODULE_NOT_FOUND') return [];
    throw err;
  }
}

const localRoutes = await loadLocalRoutes();

const server = http.createServer(async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${TOKEN}`) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');

  try {
    if (req.method === 'GET' && url.pathname === '/emails') {
      await handleListEmails(url, res);
      return;
    }

    const emailMatch = url.pathname.match(/^\/emails\/([^/]+)$/);
    if (req.method === 'GET' && emailMatch) {
      await handleGetEmail(decodeURIComponent(emailMatch[1]), res);
      return;
    }

    const saveMatch = url.pathname.match(/^\/emails\/([^/]+)\/attachments\/([^/]+)\/save-to-drive$/);
    if (req.method === 'POST' && saveMatch) {
      await handleSaveAttachment(decodeURIComponent(saveMatch[1]), decodeURIComponent(saveMatch[2]), req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/save-url-to-drive') {
      await handleSaveUrlToDrive(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/drafts') {
      await handleCreateDraft(req, res);
      return;
    }

    const archiveMatch = url.pathname.match(/^\/emails\/([^/]+)\/archive$/);
    if (req.method === 'POST' && archiveMatch) {
      await handleArchive(decodeURIComponent(archiveMatch[1]), res);
      return;
    }

    const labelMatch = url.pathname.match(/^\/emails\/([^/]+)\/label$/);
    if (req.method === 'POST' && labelMatch) {
      await handleAddLabel(decodeURIComponent(labelMatch[1]), req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/excel/read') {
      await handleExcelRead(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/excel/edit') {
      await handleExcelEdit(req, res);
      return;
    }

    const localRoute = localRoutes.find((r) => r.method === req.method && r.pathname === url.pathname);
    if (localRoute) {
      await localRoute.handle(req, res);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    log.error('gmail-sanitizer request failed', { url: req.url, err });
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log.info('gmail-sanitizer service started', { port: PORT });
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
