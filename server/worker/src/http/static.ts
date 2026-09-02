// R2 replacement for `express.static` / `res.sendFile` / `res.download`.
//
// The Express build served four disk trees: DATA_DIR/uploads, DATA_DIR/apk,
// DATA_DIR/webapp and server/public. All four now live in one R2 bucket under
// those prefixes. The headers `send` emits are reproduced: Accept-Ranges,
// Cache-Control: public, max-age=0, Last-Modified, the W/"<size>-<mtime>" ETag,
// byte ranges and conditional requests.
//
// One documented difference: Last-Modified / ETag are derived from the object's
// R2 upload time rather than the file's mtime on the App Service. The values
// differ, the format does not, and no contract test pins either value — only
// their presence.
import { POWERED_BY, httpDate, isFresh, statEtag } from './express';

export interface ServeOptions {
  /** res.download(): adds Content-Disposition: attachment. */
  downloadName?: string;
  /** Overrides the stored content type (res.type()). */
  contentType?: string;
}

/**
 * `range-parser` + the way `send` consumes it, transcribed. Verified against
 * live Azure for every branch:
 *   foo=0-1        -> ignore (200)      nonsense   -> ignore (200)
 *   bytes=0-1,3-4  -> ignore (200)      bytes=-10  -> 206 suffix
 *   bytes=abc-def  -> unsatisfiable     bytes=-0   -> unsatisfiable
 *   bytes=5-2      -> unsatisfiable     bytes=0-99999999 -> clamped 206
 */
function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  const index = header.indexOf('=');
  if (index === -1) return null;
  if (header.slice(0, index).trim() !== 'bytes') return null;

  const ranges: Array<{ start: number; end: number }> = [];
  for (const part of header.slice(index + 1).split(',')) {
    const halves = part.split('-');
    let start = parseInt(halves[0], 10);
    let end = parseInt(halves[1], 10);
    if (Number.isNaN(start)) {
      // -nnn: the last nnn bytes.
      start = size - end;
      end = size - 1;
    } else if (Number.isNaN(end)) {
      end = size - 1;
    }
    if (end > size - 1) end = size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0) continue;
    ranges.push({ start, end });
  }
  if (ranges.length < 1) return 'unsatisfiable';
  // `send` serves a single range only; multiple ranges fall back to a full 200.
  if (ranges.length !== 1) return null;
  return ranges[0];
}

/** Express's res.send() appends/overrides the charset on an existing type. */
function withUtf8Charset(contentType: string): string {
  return `${contentType.split(';')[0].trim()}; charset=utf-8`;
}

/**
 * Serves one R2 object, or returns null when it does not exist so the caller
 * can fall through to the next middleware exactly as express.static does.
 *
 * R2 keys are capped at 1024 bytes and head()/get() throw above that. A path
 * that long cannot name an object, just as it could not name a file — serve-
 * static got ENAMETOOLONG and called next(), which ended in the 404 page. Return
 * "not found" so the caller falls through the same way instead of erroring.
 */
const R2_MAX_KEY_BYTES = 1024;
const keyIsAddressable = (key: string) => new TextEncoder().encode(key).length <= R2_MAX_KEY_BYTES;

export async function serveObject(
  bucket: R2Bucket,
  key: string,
  request: Request,
  options: ServeOptions = {},
): Promise<Response | null> {
  if (!keyIsAddressable(key)) return null;
  const head = await bucket.head(key);
  if (!head) return null;

  const size = head.size;
  const mtimeMs = head.uploaded.getTime();
  const etag = statEtag(size, mtimeMs);
  const lastModified = httpDate(mtimeMs);
  const contentType =
    options.contentType ?? head.httpMetadata?.contentType ?? 'application/octet-stream';

  const headers = new Headers({
    'x-powered-by': POWERED_BY,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=0',
    'last-modified': lastModified,
    etag,
    'content-type': contentType,
  });
  if (options.downloadName) {
    headers.set('content-disposition', `attachment; filename="${options.downloadName}"`);
  }

  const method = request.method.toUpperCase();
  if (isFresh(request.headers, { etag, lastModified })) {
    headers.delete('content-type');
    return new Response(null, { status: 304, headers });
  }

  const rangeHeader = request.headers.get('range');
  const ifRange = request.headers.get('if-range');
  const rangeApplies =
    rangeHeader !== null && (ifRange === null || ifRange === etag || ifRange === lastModified);

  if (rangeApplies) {
    const parsed = parseRange(rangeHeader!, size);
    if (parsed === 'unsatisfiable') {
      // `send` sets Content-Range and then errors; because this app's error
      // handler special-cases only 401/403, the 416 falls through to the generic
      // 500 envelope — written over the headers `send` had already set. Verified
      // live: 500, Content-Range present, the file's own ETag/Last-Modified kept,
      // and the content type carrying an appended `; charset=utf-8`.
      headers.set('content-range', `bytes */${size}`);
      headers.set('content-type', withUtf8Charset(contentType));
      const body = new TextEncoder().encode(
        JSON.stringify({ error: 'server_error', message: 'Internal server error' }),
      );
      headers.set('content-length', String(body.length));
      return new Response(method === 'HEAD' ? null : body, { status: 500, headers });
    }
    if (parsed) {
      const length = parsed.end - parsed.start + 1;
      headers.set('content-range', `bytes ${parsed.start}-${parsed.end}/${size}`);
      headers.set('content-length', String(length));
      if (method === 'HEAD') return new Response(null, { status: 206, headers });
      const object = await bucket.get(key, { range: { offset: parsed.start, length } });
      if (!object) return null;
      return new Response(object.body, { status: 206, headers });
    }
  }

  headers.set('content-length', String(size));
  if (method === 'HEAD') return new Response(null, { status: 200, headers });
  const object = await bucket.get(key);
  if (!object) return null;
  // A *streamed* text/html body makes Cloudflare's edge switch the response to
  // chunked transfer and drop both Content-Length and ETag, which Azure sent.
  // Buffering the entity keeps them. Only HTML needs this; the 107 MB APK and
  // the images stream as before.
  if (/^text\/html\b/i.test(contentType)) {
    return new Response(await object.arrayBuffer(), { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

/** serve-static's `redirect: true` for a directory reached without a trailing slash. */
export function directoryRedirect(request: Request): Response {
  const url = new URL(request.url);
  const location = `${url.pathname}/${url.search}`;
  const body =
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<title>Redirecting</title>\n</head>\n<body>\n' +
    `<pre>Redirecting to ${location}</pre>\n</body>\n</html>\n`;
  const bytes = new TextEncoder().encode(body);
  return new Response(request.method === 'HEAD' ? null : bytes, {
    status: 301,
    headers: {
      'x-powered-by': POWERED_BY,
      location,
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff',
      'content-type': 'text/html; charset=UTF-8',
      'content-length': String(bytes.length),
    },
  });
}

/**
 * `express.static(root)` over an R2 prefix: index.html for directories, a 301 to
 * the trailing-slash form when a directory is addressed without one, and null
 * (i.e. next()) when nothing matches.
 */
export async function serveStatic(
  bucket: R2Bucket,
  prefix: string,
  pathname: string,
  request: Request,
  options: ServeOptions = {},
): Promise<Response | null> {
  const base = `${prefix}${pathname}`;
  if (pathname.endsWith('/')) {
    return serveObject(bucket, `${base}index.html`, request, options);
  }
  const direct = await serveObject(bucket, base, request, options);
  if (direct) return direct;
  if (!keyIsAddressable(base)) return null;
  // R2 has no directories; a key under `<base>/` is what "is a directory" means.
  const listing = await bucket.list({ prefix: `${base}/`, limit: 1 });
  if (listing.objects.length > 0) return directoryRedirect(request);
  return null;
}
