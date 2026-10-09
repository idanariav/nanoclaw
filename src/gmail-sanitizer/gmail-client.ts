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
  if (res.status === 204) return undefined;
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
  /** The MIME part id (e.g. "2") — stable across separate messages.get calls, unlike attachmentId below. Use this to re-address the attachment later. */
  partId: string;
  /** Gmail mints a new attachmentId on every messages.get call for the same message — only valid for immediate use, never store or compare it across requests. */
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
      partId: part.partId ?? '',
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

export interface RawDraftSummary {
  draftId: string;
  messageId: string;
  threadId: string;
  to: string;
  subject: string;
  snippet: string;
}

/** List drafts, optionally filtered by Gmail search syntax scoped to drafts (e.g. "to:someone@example.com"). */
export async function listDrafts(query: string, maxResults: number): Promise<RawDraftSummary[]> {
  const listResult = (await gmailFetch(
    `/drafts?maxResults=${maxResults}${query ? `&q=${encodeURIComponent(query)}` : ''}`,
  )) as { drafts?: { id: string; message: { id: string; threadId: string } }[] };
  const drafts = listResult.drafts ?? [];

  const summaries: RawDraftSummary[] = [];
  for (const d of drafts) {
    const msg = (await gmailFetch(
      `/messages/${d.message.id}?format=metadata&metadataHeaders=To&metadataHeaders=Subject`,
    )) as GmailMessage;
    const headers = msg.payload?.headers;
    summaries.push({
      draftId: d.id,
      messageId: d.message.id,
      threadId: d.message.threadId,
      to: header(headers, 'To'),
      subject: header(headers, 'Subject'),
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

/**
 * Re-fetch the message and find an attachment by its stable partId, returning
 * its current (freshly-minted, immediately-usable) attachmentId. Callers must
 * never reuse an attachmentId from an earlier fetch — see RawAttachmentMeta.
 */
export async function resolveAttachmentByPartId(
  messageId: string,
  partId: string,
): Promise<RawAttachmentMeta | undefined> {
  const email = await getEmail(messageId);
  return email.attachments.find((a) => a.partId === partId);
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

/** Mark read and archive (remove from inbox). Combine with addLabel below if a label is also wanted. */
export async function archiveEmail(messageId: string): Promise<void> {
  await gmailFetch(`/messages/${messageId}/modify`, {
    method: 'POST',
    body: { removeLabelIds: ['UNREAD', 'INBOX'] },
  });
}

/** Apply a label without archiving or changing read status — for tracking (e.g. "Waiting") rather than processing. */
export async function addLabel(messageId: string, labelName: string): Promise<void> {
  const labelId = await getOrCreateLabelId(labelName);
  await gmailFetch(`/messages/${messageId}/modify`, {
    method: 'POST',
    body: { addLabelIds: [labelId] },
  });
}

/** RFC 2047 encoded-word, needed for a non-ASCII (e.g. Hebrew) subject line. */
function encodeSubjectHeader(subject: string): string {
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

function encodeBase64Body(bytes: Buffer): string {
  return bytes.toString('base64').replace(/(.{76})/g, '$1\r\n');
}

// Gmail's plain-text renderer picks LTR/RTL per line via its own (imperfect) bidi heuristic, so a
// Hebrew/Arabic body sent as text/plain can render left-aligned even though every word is RTL.
// Sending HTML with an explicit `dir` instead makes the direction deterministic. Detected from the
// body itself (rather than assumed) so this stays correct for any language, not just Hebrew.
const RTL_CHAR_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function textToHtmlBody(text: string): string {
  const dir = RTL_CHAR_RE.test(text) ? 'rtl' : 'ltr';
  const html = escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>\r\n');
  return `<div dir="${dir}" style="text-align:${dir === 'rtl' ? 'right' : 'left'}">${html}</div>`;
}

export interface ForwardedMessage {
  from: string;
  to: string;
  subject: string;
  date: string;
  bodyHtml: string;
  bodyText: string;
}

/** Gmail-style "Forwarded message" block wrapping the original's HTML untouched, so its layout, links and images survive. */
function forwardedHtml(f: ForwardedMessage): string {
  const dir = RTL_CHAR_RE.test(f.bodyText + f.subject) ? 'rtl' : 'ltr';
  const original = f.bodyHtml || `<div>${escapeHtml(f.bodyText).replace(/\r\n|\r|\n/g, '<br>')}</div>`;
  const line = (label: string, value: string) => (value ? `${label}: ${escapeHtml(value)}<br>` : '');
  return (
    `<div class="gmail_quote" dir="${dir}">` +
    `<div style="text-align:${dir === 'rtl' ? 'right' : 'left'}">---------- Forwarded message ---------<br>` +
    `${line('From', f.from)}${line('Date', f.date)}${line('Subject', f.subject)}${line('To', f.to)}</div><br>` +
    `${original}</div>`
  );
}

/** Exported for unit testing — pure function, no network I/O. */
export function buildRawMessage(opts: {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  attachments?: OutgoingAttachment[];
  forwarded?: ForwardedMessage;
}): string {
  const htmlBody =
    (opts.body ? textToHtmlBody(opts.body) + (opts.forwarded ? '<br>' : '') : '') +
    (opts.forwarded ? forwardedHtml(opts.forwarded) : '');
  const headers = [
    `To: ${opts.to}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    `Subject: ${encodeSubjectHeader(opts.subject)}`,
    'MIME-Version: 1.0',
  ];
  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`);
  }

  if (!opts.attachments || opts.attachments.length === 0) {
    headers.push('Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64');
    const encodedBody = encodeBase64Body(Buffer.from(htmlBody, 'utf8'));
    const message = `${headers.join('\r\n')}\r\n\r\n${encodedBody}`;
    return Buffer.from(message, 'utf8').toString('base64url');
  }

  const boundary = `nanoclaw-draft-${Date.now()}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    `--${boundary}\r\nContent-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodeBase64Body(Buffer.from(htmlBody, 'utf8'))}`,
    ...opts.attachments.map(
      (a) =>
        `--${boundary}\r\nContent-Type: ${a.mimeType}\r\nContent-Disposition: attachment; filename="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodeBase64Body(a.bytes)}`,
    ),
    `--${boundary}--`,
  ];
  const message = `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n\r\n')}`;
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
  forwardEmailId?: string;
  attachments?: OutgoingAttachment[];
}): Promise<DraftResult> {
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  if (opts.emailId) {
    const original = await getEmail(opts.emailId);
    threadId = original.threadId;
    inReplyTo = original.messageIdHeader || undefined;
  }
  const raw = buildRawMessage({
    to: opts.to,
    cc: opts.cc,
    subject: opts.subject,
    body: opts.body,
    inReplyTo,
    attachments: opts.attachments,
    forwarded: opts.forwardEmailId ? await getEmail(opts.forwardEmailId) : undefined,
  });
  const created = (await gmailFetch('/drafts', {
    method: 'POST',
    body: { message: { raw, ...(threadId ? { threadId } : {}) } },
  })) as { id: string; message: { id: string; threadId: string } };
  return { draftId: created.id, messageId: created.message.id, threadId: created.message.threadId };
}

/** Existing thread context for a draft, used by updateDraft to preserve threading when the caller doesn't pass a new `emailId` to re-thread under. */
async function getDraftThreadContext(draftId: string): Promise<{ threadId: string; inReplyTo?: string }> {
  const draft = (await gmailFetch(`/drafts/${draftId}`)) as { message: { id: string } };
  const msg = (await gmailFetch(
    `/messages/${draft.message.id}?format=metadata&metadataHeaders=In-Reply-To`,
  )) as GmailMessage;
  return { threadId: msg.threadId, inReplyTo: header(msg.payload?.headers, 'In-Reply-To') || undefined };
}

/**
 * Update an existing Gmail draft in place (same draft id) — never sends.
 * Fully replaces the draft's content and attachment set. Threading is
 * preserved automatically unless `emailId` is passed to re-thread it under a
 * different message.
 */
export async function updateDraft(opts: {
  draftId: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  emailId?: string;
  forwardEmailId?: string;
  attachments?: OutgoingAttachment[];
}): Promise<DraftResult> {
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  if (opts.emailId) {
    const original = await getEmail(opts.emailId);
    threadId = original.threadId;
    inReplyTo = original.messageIdHeader || undefined;
  } else {
    const existing = await getDraftThreadContext(opts.draftId);
    threadId = existing.threadId;
    inReplyTo = existing.inReplyTo;
  }
  const raw = buildRawMessage({
    to: opts.to,
    cc: opts.cc,
    subject: opts.subject,
    body: opts.body,
    inReplyTo,
    attachments: opts.attachments,
    forwarded: opts.forwardEmailId ? await getEmail(opts.forwardEmailId) : undefined,
  });
  const updated = (await gmailFetch(`/drafts/${opts.draftId}`, {
    method: 'PUT',
    body: { message: { raw, ...(threadId ? { threadId } : {}) } },
  })) as { id: string; message: { id: string; threadId: string } };
  return { draftId: updated.id, messageId: updated.message.id, threadId: updated.message.threadId };
}

/** Permanently delete a draft. Cannot be undone. */
export async function deleteDraft(draftId: string): Promise<void> {
  await gmailFetch(`/drafts/${draftId}`, { method: 'DELETE' });
}
