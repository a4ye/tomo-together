// Byte-level Express 4 response compatibility.
//
// Everything in here exists because the contract suite pins Express's exact
// output: `application/json; charset=utf-8` (lower case, unlike Hono's default),
// the weak ETag the `etag` package produces, `X-Powered-By: Express`, the
// finalhandler 404 page and its two hardening headers, and `res.sendStatus`'s
// habit of ETagging a 204.

const encoder = new TextEncoder();

export const POWERED_BY = 'Express';

/** `etag` package, weak mode: W/"<byteLength hex>-<base64(sha1)[0..27]>". */
export async function weakEtag(body: Uint8Array | string): Promise<string> {
  const bytes = typeof body === 'string' ? encoder.encode(body) : body;
  if (bytes.length === 0) {
    // etag's documented empty-entity shortcut.
    return 'W/"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"';
  }
  const digest = await crypto.subtle.digest('SHA-1', bytes as BufferSource);
  let binary = '';
  const view = new Uint8Array(digest);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  const base64 = btoa(binary).slice(0, 27);
  return `W/"${bytes.length.toString(16)}-${base64}"`;
}

/** serve-static / send: W/"<size hex>-<mtime ms hex>". */
export function statEtag(size: number, mtimeMs: number): string {
  return `W/"${size.toString(16)}-${mtimeMs.toString(16)}"`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

/** RFC 1123, the format Node's res.setHeader('Last-Modified', …) emits. */
export function httpDate(ms: number): string {
  const d = new Date(ms);
  return (
    `${DAYS[d.getUTCDay()]}, ${two(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} GMT`
  );
}

/**
 * The `fresh` package, as Express calls it from res.send(). Returns true when
 * the client's validators still match, i.e. the response should become a 304.
 * `Cache-Control: no-cache` on the request always wins (a shift-reload must get
 * a 200), which is the behaviour a naive If-None-Match comparison gets wrong.
 */
export function isFresh(
  reqHeaders: Headers,
  resValidators: { etag?: string | null; lastModified?: string | null },
): boolean {
  const noneMatch = reqHeaders.get('if-none-match');
  const modifiedSince = reqHeaders.get('if-modified-since');
  if (!noneMatch && !modifiedSince) return false;

  const cacheControl = reqHeaders.get('cache-control');
  if (cacheControl && /(?:^|,)\s*?no-cache\s*?(?:,|$)/.test(cacheControl)) return false;

  if (noneMatch) {
    if (noneMatch === '*') return true;
    const etag = resValidators.etag;
    if (!etag) return false;
    const matches = noneMatch.split(',').map((s) => s.trim());
    const stripped = etag.startsWith('W/') ? etag.slice(2) : etag;
    const hit = matches.some((m) => m === etag || m === stripped || `W/${m}` === etag);
    if (!hit) return false;
  }
  if (modifiedSince) {
    const lastModified = resValidators.lastModified;
    if (!lastModified) return false;
    const since = Date.parse(modifiedSince);
    const modified = Date.parse(lastModified);
    if (!(Number.isFinite(since) && Number.isFinite(modified) && modified <= since)) return false;
  }
  return true;
}

export interface AppResponseInit {
  status?: number;
  headers?: Record<string, string>;
}

/**
 * res.json(): compact JSON.stringify, lower-case charset, weak ETag, and a 304
 * when the request validators are still fresh.
 */
export async function json(
  reqHeaders: Headers,
  method: string,
  value: unknown,
  init: AppResponseInit = {},
): Promise<Response> {
  const body = JSON.stringify(value);
  return sendBody(reqHeaders, method, body, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers ?? {}) },
  });
}

/** res.send() for an in-memory entity: adds ETag/Content-Length and honours 304. */
export async function sendBody(
  reqHeaders: Headers,
  method: string,
  body: string | Uint8Array,
  init: AppResponseInit = {},
): Promise<Response> {
  const bytes = typeof body === 'string' ? encoder.encode(body) : body;
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? {});
  headers.set('x-powered-by', POWERED_BY);

  // Express only generates an ETag for a body it produced; it does so even for
  // 204/304-eligible responses, which is why an OPTIONS 204 carries one.
  const etag = await weakEtag(bytes);
  headers.set('etag', etag);

  if ((method === 'GET' || method === 'HEAD') && status >= 200 && status < 300) {
    if (isFresh(reqHeaders, { etag })) {
      headers.delete('content-type');
      headers.delete('content-length');
      return new Response(null, { status: 304, headers });
    }
  }

  if (status === 204 || status === 304) return new Response(null, { status, headers });
  headers.set('content-length', String(bytes.length));
  return new Response(method === 'HEAD' ? null : bytes, { status, headers });
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** finalhandler's 404 page, byte-for-byte (verified against live Azure). */
export function notFoundHtml(method: string, originalUrl: string): string {
  return (
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<title>Error</title>\n</head>\n<body>\n' +
    `<pre>Cannot ${escapeHtml(method)} ${escapeHtml(originalUrl)}</pre>\n` +
    '</body>\n</html>\n'
  );
}

export function notFoundResponse(method: string, path: string): Response {
  const body = notFoundHtml(method, path);
  const bytes = encoder.encode(body);
  return new Response(method === 'HEAD' ? null : bytes, {
    status: 404,
    headers: {
      'x-powered-by': POWERED_BY,
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff',
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(bytes.length),
    },
  });
}
