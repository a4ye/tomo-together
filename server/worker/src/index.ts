// Worker entry point.
//
// Two things sit outside the Hono app because they sat outside Express too:
//
//  * the WebSocket upgrade. Node delivers `upgrade` events to a server-level
//    listener that never reaches the express app, which is why an upgrade to a
//    path that is not /ws still answers a bare 401 with no CORS headers, no
//    X-Powered-By and an empty body. That is reproduced here, first, before
//    anything else runs.
//  * the CORS middleware, which Express registered before everything and which
//    therefore decorates every response including the finalhandler 404 and the
//    500 envelope. Here it wraps the app's response instead.
import { app } from './app';
import { canonicalizePath } from './routes';
import type { Env } from './env';
import { POWERED_BY, weakEtag } from './http/express';

export { WorldDO } from './do/WorldDO';
export { CryptoReadinessDO } from './do/CryptoReadinessDO';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'Content-Type,Authorization,Idempotency-Key',
};

/**
 * server.on('upgrade'): reject anything that is not /ws with exactly one valid
 * `ticket` parameter. The response is deliberately generic and never echoes the
 * URL, the ticket or any other credential-shaped input.
 */
async function handleUpgrade(request: Request, env: Env): Promise<Response> {
  const reject = () => new Response(null, { status: 401 });
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return reject();
  }
  if (url.pathname !== '/ws') return reject();
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'ticket' || url.searchParams.getAll('ticket').length !== 1) {
    return reject();
  }
  const stub = env.WORLD.get(env.WORLD.idFromName('world'));
  const response = await stub.fetch(
    `https://world/connect?ticket=${encodeURIComponent(url.searchParams.get('ticket') ?? '')}`,
    request,
  );
  if (response.status !== 101) return reject();
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if ((request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') {
      return handleUpgrade(request, env);
    }

    // The CORS middleware answers OPTIONS itself with res.sendStatus(204), which
    // Express still ETags (from the discarded "No Content" body).
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS,
          'x-powered-by': POWERED_BY,
          etag: await weakEtag('No Content'),
        },
      });
    }

    // Express's router is case-insensitive and non-strict; Hono's is neither.
    const url = new URL(request.url);
    // Azure's ingress collapses runs of slashes before Node ever sees the path
    // (`//health` and `/px//avatar/cat_0.png` both resolve there); Cloudflare
    // passes them through, so the app has to do it to answer the same way.
    const collapsed = url.pathname.replace(/\/{2,}/g, '/');
    const canonical = canonicalizePath(request.method, collapsed);
    let forwarded = request;
    if (canonical !== url.pathname) {
      url.pathname = canonical;
      forwarded = new Request(url.toString(), request);
    }

    const response = await app.fetch(forwarded, env, ctx);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    if (!headers.has('content-encoding') && response.status !== 101 && response.status !== 204) {
      headers.set('content-encoding', 'identity');
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
