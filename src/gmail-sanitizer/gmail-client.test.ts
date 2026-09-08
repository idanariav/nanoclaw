import { describe, expect, it } from 'vitest';

import { buildRawMessage } from './gmail-client.js';

/** Decodes a base64url raw RFC 2822 message and pulls out its headers and the text/html body (base64-decoding it, stripping the RFC 2045 76-char line wrapping first). Works for both the single-part and multipart/mixed shapes buildRawMessage produces. */
function decode(raw: string): { headers: string; body: string } {
  const message = Buffer.from(raw, 'base64url').toString('utf8');
  const headers = message.split('\r\n\r\n')[0];
  const match =
    /Content-Type: text\/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)(?:\r\n\r\n--|$)/.exec(
      message,
    );
  const body = Buffer.from((match?.[1] ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8');
  return { headers, body };
}

describe('buildRawMessage', () => {
  it('sends a Hebrew body as HTML wrapped dir="rtl", right-aligned', () => {
    const raw = buildRawMessage({ to: 'a@example.com', subject: 'שלום', body: 'שלום עולם' });
    const { headers, body } = decode(raw);
    expect(headers).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(body).toBe('<div dir="rtl" style="text-align:right">שלום עולם</div>');
  });

  it('sends an English body as HTML wrapped dir="ltr", left-aligned', () => {
    const raw = buildRawMessage({ to: 'a@example.com', subject: 'Hi', body: 'hello world' });
    const { body } = decode(raw);
    expect(body).toBe('<div dir="ltr" style="text-align:left">hello world</div>');
  });

  it('treats a body as RTL as soon as it contains any Hebrew, even mixed with Latin/numbers', () => {
    const raw = buildRawMessage({ to: 'a@example.com', subject: 'x', body: 'Invoice #4502754930 — דרישת תשלום' });
    const { body } = decode(raw);
    expect(body).toContain('dir="rtl"');
  });

  it('escapes HTML special characters and converts newlines to <br>', () => {
    const raw = buildRawMessage({ to: 'a@example.com', subject: 'x', body: 'שורה 1 <3 & תודה\nשורה 2' });
    const { body } = decode(raw);
    expect(body).toBe('<div dir="rtl" style="text-align:right">שורה 1 &lt;3 &amp; תודה<br>\r\nשורה 2</div>');
  });

  it('still sends the body as RTL-aware HTML when attachments are present', () => {
    const raw = buildRawMessage({
      to: 'a@example.com',
      subject: 'x',
      body: 'שלום',
      attachments: [{ filename: 'f.xlsx', mimeType: 'application/octet-stream', bytes: Buffer.from('x') }],
    });
    const { headers, body } = decode(raw);
    expect(headers).toContain('Content-Type: multipart/mixed');
    expect(body).toBe('<div dir="rtl" style="text-align:right">שלום</div>');
  });
});
