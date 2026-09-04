/**
 * Standalone entrypoint. Runs as its own process (own service unit — see
 * scripts/setup-gmail-sanitizer-service.ts), independent of the main
 * NanoClaw host process and of any agent group's container. Binds to
 * localhost only; containers reach it via host.docker.internal.
 *
 * Every response here has already been through redact.ts (email content)
 * or has never carried raw bytes at all (attachment / URL save-to-drive)
 * — that's the boundary this whole service exists to enforce.
 */
import http from 'http';

import { archiveAndLabel, createDraft, getAttachmentBytes, getEmail, listEmails } from './gmail-client.js';
import { applyFilenameOverride, uploadAttachmentToDrive } from './drive-client.js';
import { fetchUrlToBuffer } from './url-fetch.js';
import { redactHtml, redactText } from './redact.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

const envConfig = readEnvFile(['GMAIL_SANITIZER_PORT', 'GMAIL_SANITIZER_TOKEN']);
const PORT = parseInt(envConfig.GMAIL_SANITIZER_PORT || '8799', 10);
const TOKEN = envConfig.GMAIL_SANITIZER_TOKEN;

if (!TOKEN) {
  log.fatal('GMAIL_SANITIZER_TOKEN is not set — refusing to start with no shared-secret auth');
  process.exit(1);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data);
}

function redactedBody(email: Awaited<ReturnType<typeof getEmail>>): string {
  if (email.bodyText) return redactText(email.bodyText);
  if (email.bodyHtml) return redactHtml(email.bodyHtml);
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
      subject: redactText(e.subject),
      date: e.date,
      snippet: redactText(e.snippet),
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
    subject: redactText(email.subject),
    date: email.date,
    body: redactedBody(email),
    attachments: email.attachments.map((a) => ({
      attachmentId: a.attachmentId,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
    })),
  });
}

async function handleSaveAttachment(
  messageId: string,
  attachmentId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const email = await getEmail(messageId);
  const attachment = email.attachments.find((a) => a.attachmentId === attachmentId);
  if (!attachment) {
    sendJson(res, 404, { error: `Attachment ${attachmentId} not found on message ${messageId}` });
    return;
  }
  const body = (await readJsonBody(req)) as { filename?: string };
  const filename = applyFilenameOverride(attachment.filename, body.filename);
  const bytes = await getAttachmentBytes(messageId, attachmentId);
  const result = await uploadAttachmentToDrive(filename, attachment.mimeType, bytes);
  sendJson(res, 200, result);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
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
  };
  if (!body.to || !body.subject || !body.body) {
    sendJson(res, 400, { error: 'to, subject, and body are required' });
    return;
  }
  const result = await createDraft({
    to: body.to,
    cc: body.cc,
    subject: body.subject,
    body: body.body,
    emailId: body.emailId,
  });
  sendJson(res, 200, result);
}

async function handleArchiveAndLabel(
  messageId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as { label?: string };
  if (!body.label) {
    sendJson(res, 400, { error: 'label is required' });
    return;
  }
  await archiveAndLabel(messageId, body.label);
  sendJson(res, 200, { messageId, label: body.label, markedRead: true, archived: true });
}

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

    const archiveMatch = url.pathname.match(/^\/emails\/([^/]+)\/archive-and-label$/);
    if (req.method === 'POST' && archiveMatch) {
      await handleArchiveAndLabel(decodeURIComponent(archiveMatch[1]), req, res);
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
