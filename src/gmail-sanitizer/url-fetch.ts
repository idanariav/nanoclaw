/**
 * Server-side fetch for gmail_save_url_to_drive (e.g. an invoice-download
 * link found in an email body, not a real Gmail attachment). This fetches
 * an agent-supplied URL directly — not through the OneCLI proxy, since the
 * target is an arbitrary external site, not a Google API — so it guards
 * against SSRF: only public https hosts, capped size, capped redirects.
 */
import dns from 'dns/promises';
import net from 'net';
import { fetch } from 'undici';

const MAX_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

function isPrivateOrLoopback(address: string): boolean {
  if (net.isIPv6(address)) {
    return address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80');
  }
  const octets = address.split('.').map(Number);
  const [a, b] = octets;
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

async function assertPublicHttpsUrl(url: URL): Promise<void> {
  if (url.protocol !== 'https:') {
    throw new Error('Only https:// URLs are allowed');
  }
  const addresses = await dns.lookup(url.hostname, { all: true });
  for (const { address } of addresses) {
    if (isPrivateOrLoopback(address)) {
      throw new Error(`Refusing to fetch ${url.hostname} — resolves to a private/loopback address`);
    }
  }
}

export interface FetchedUrl {
  bytes: Buffer;
  mimeType: string;
  filename: string;
}

/** Best-effort filename from a Content-Disposition header or the URL path. */
function inferFilename(url: URL, contentDisposition: string | null): string {
  const match = contentDisposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (match) return decodeURIComponent(match[1]);
  const last = url.pathname.split('/').filter(Boolean).pop();
  return last && last.includes('.') ? last : 'download';
}

export async function fetchUrlToBuffer(rawUrl: string): Promise<FetchedUrl> {
  const url = new URL(rawUrl);
  await assertPublicHttpsUrl(url);

  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }
  // Redirects can land on a different, unvalidated host — re-check.
  const finalUrl = new URL(res.url);
  await assertPublicHttpsUrl(finalUrl);

  const contentLength = res.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_BYTES) {
    throw new Error(`File too large (${contentLength} bytes, max ${MAX_BYTES})`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    throw new Error(`File too large (${buf.length} bytes, max ${MAX_BYTES})`);
  }

  return {
    bytes: buf,
    mimeType: res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
    filename: inferFilename(finalUrl, res.headers.get('content-disposition')),
  };
}
