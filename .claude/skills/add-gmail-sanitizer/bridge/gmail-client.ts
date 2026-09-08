/**
 * Raw Gmail REST access. Everything here returns UNREDACTED data — callers
 * (server.ts) must run it through anonymize.ts before it leaves this process.
 * Plain REST calls rather than the `googleapis` SDK: two endpoints don't
 * warrant pulling in a client covering every Google API.
 */
import { fetch } from 'undici';

import { getGmailSanitizerDispatcher } from './identity.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function gmailFetch(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const dispatcher = await getGmailSanitizerDispatcher();
  const res = await fetch(`${GMAIL_API}${path}`, {
    dispatcher,
    method: init?.method,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Gmail API ${path} -> ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res.json();
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  payload?: GmailPart;
}

export interface RawEmailSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface RawAttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface RawEmail {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  bodyText: string;
  bodyHtml: string;
  attachments: RawAttachmentMeta[];
  messageIdHeader: string;
}

function header(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/** Walk the MIME tree, collecting the first text/plain and text/html bodies, and all attachment metadata. */
function walkParts(part: GmailPart, acc: { text?: string; html?: string; attachments: RawAttachmentMeta[] }): void {
  if (part.filename && part.body?.attachmentId) {
    acc.attachments.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType ?? 'application/octet-stream',
      size: part.body.size ?? 0,
    });
    return;
  }
  if (part.mimeType === 'text/plain' && part.body?.data && acc.text === undefined) {
    acc.text = decodeBase64Url(part.body.data);
  }
  if (part.mimeType === 'text/html' && part.body?.data && acc.html === undefined) {
    acc.html = decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    walkParts(child, acc);
  }
}

export async function listEmails(query: string, maxResults: number): Promise<RawEmailSummary[]> {
  const listResult = (await gmailFetch(`/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`)) as {
    messages?: { id: string }[];
  };
  const ids = listResult.messages ?? [];

  const summaries: RawEmailSummary[] = [];
  for (const { id } of ids) {
    const msg = (await gmailFetch(
      `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    )) as GmailMessage;
    const headers = msg.payload?.headers;
    summaries.push({
      id: msg.id,
      threadId: msg.threadId,
      from: header(headers, 'From'),
      subject: header(headers, 'Subject'),
      date: header(headers, 'Date'),
      snippet: msg.snippet ?? '',
    });
  }
  return summaries;
}

export async function getEmail(id: string): Promise<RawEmail> {
  const msg = (await gmailFetch(`/messages/${id}?format=full`)) as GmailMessage;
  const headers = msg.payload?.headers;
  const acc: { text?: string; html?: string; attachments: RawAttachmentMeta[] } = { attachments: [] };
  if (msg.payload) walkParts(msg.payload, acc);

  return {
    id: msg.id,
    threadId: msg.threadId,
    from: header(headers, 'From'),
    to: header(headers, 'To'),
    subject: header(headers, 'Subject'),
    date: header(headers, 'Date'),
    bodyText: acc.text ?? '',
    bodyHtml: acc.html ?? '',
    attachments: acc.attachments,
    messageIdHeader: header(headers, 'Message-ID'),
  };
}

export async function getAttachmentBytes(messageId: string, attachmentId: string): Promise<Buffer> {
  const result = (await gmailFetch(`/messages/${messageId}/attachments/${attachmentId}`)) as { data: string };
  return Buffer.from(result.data, 'base64url');
}

async function getOrCreateLabelId(name: string): Promise<string> {
  const { labels } = (await gmailFetch('/labels')) as { labels?: { id: string; name: string }[] };
  const existing = labels?.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;

  const created = (await gmailFetch('/labels', {
    method: 'POST',
    body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  })) as { id: string };
  return created.id;
}

/** Mark read, archive (remove from inbox), and apply a label — one Gmail API call. */
export async function archiveAndLabel(messageId: string, labelName: string): Promise<void> {
  const labelId = await getOrCreateLabelId(labelName);
  await gmailFetch(`/messages/${messageId}/modify`, {
    method: 'POST',
    body: { removeLabelIds: ['UNREAD', 'INBOX'], addLabelIds: [labelId] },
  });
}

/** RFC 2047 encoded-word, needed for a non-ASCII (e.g. Hebrew) subject line. */
function encodeSubjectHeader(subject: string): string {
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

function buildRawMessage(opts: { to: string; cc?: string; subject: string; body: string; inReplyTo?: string }): string {
  const headers = [
    `To: ${opts.to}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    `Subject: ${encodeSubjectHeader(opts.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`);
  }
  const encodedBody = Buffer.from(opts.body, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  const message = `${headers.join('\r\n')}\r\n\r\n${encodedBody}`;
  return Buffer.from(message, 'utf8').toString('base64url');
}

export interface DraftResult {
  draftId: string;
  messageId: string;
  threadId: string;
}

/**
 * Create a Gmail draft — never sends. Pass `emailId` to thread it as a reply
 * under an existing message (sets threadId + In-Reply-To/References from that
 * message), or omit it for a standalone draft.
 */
export async function createDraft(opts: {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  emailId?: string;
}): Promise<DraftResult> {
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  if (opts.emailId) {
    const original = await getEmail(opts.emailId);
    threadId = original.threadId;
    inReplyTo = original.messageIdHeader || undefined;
  }
  const raw = buildRawMessage({ to: opts.to, cc: opts.cc, subject: opts.subject, body: opts.body, inReplyTo });
  const created = (await gmailFetch('/drafts', {
    method: 'POST',
    body: { message: { raw, ...(threadId ? { threadId } : {}) } },
  })) as { id: string; message: { id: string; threadId: string } };
  return { draftId: created.id, messageId: created.message.id, threadId: created.message.threadId };
}
