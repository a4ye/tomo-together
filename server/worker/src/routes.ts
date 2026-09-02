// Route table, transcribed from server/index.js in registration order.
//
// It doubles as the input to canonicalizePath(): Express's router defaults to
// `caseSensitive: false`, so `/Health` resolves to `/health` while a `:param`
// keeps its original case. Hono's matcher is case-sensitive, so an incoming
// path is rewritten to the canonical spelling of the literal segments before it
// reaches the router, and left untouched when nothing matches (which then falls
// through to the finalhandler 404, exactly like Express).
export const ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['POST', '/auth/register'],
  ['POST', '/auth/login'],
  ['GET', '/me'],
  ['PUT', '/me/interests'],
  ['PUT', '/me/avatar'],
  ['GET', '/catalog'],
  ['GET', '/users/search'],
  ['GET', '/friends'],
  ['GET', '/friends/:username'],
  ['POST', '/friends/request'],
  ['POST', '/friends/accept'],
  ['GET', '/friends/:username/card'],
  ['GET', '/activities/ranked'],
  ['POST', '/duels'],
  ['GET', '/suggestions'],
  ['POST', '/hangouts'],
  ['POST', '/hangouts/:id/stake'],
  ['GET', '/hangouts'],
  ['GET', '/hangouts/:id'],
  ['POST', '/hangouts/:id/photo'],
  ['POST', '/hangouts/:id/end'],
  ['GET', '/hangouts/:id/nfc-token'],
  ['POST', '/hangouts/:id/confirm'],
  ['GET', '/memories'],
  ['GET', '/leaderboard'],
  ['POST', '/shop/buy'],
  ['POST', '/secret/acorns'],
  ['GET', '/wallet'],
  ['POST', '/wallet/add-funds'],
  ['POST', '/wallet/refresh'],
  ['POST', '/wallet/withdraw'],
  ['GET', '/health'],
  ['POST', '/world/ws-ticket'],
  ['GET', '/apk'],
  ['GET', '/apk/version'],
];

function canonicalizeOne(method: string, path: string): string | null {
  const wanted = method === 'HEAD' ? 'GET' : method;
  const segments = path.split('/');
  for (const [routeMethod, pattern] of ROUTES) {
    if (routeMethod !== wanted) continue;
    const patternSegments = pattern.split('/');
    if (patternSegments.length !== segments.length) continue;
    const out = segments.slice();
    let ok = true;
    for (let i = 1; i < patternSegments.length; i += 1) {
      const p = patternSegments[i];
      if (p.startsWith(':')) {
        if (segments[i] === '') {
          ok = false;
          break;
        }
        continue;
      }
      let decoded = segments[i];
      try {
        decoded = decodeURIComponent(segments[i]);
      } catch {
        /* Express would 400 here; leave it unmatched instead of guessing. */
      }
      if (p.toLowerCase() !== decoded.toLowerCase()) {
        ok = false;
        break;
      }
      out[i] = p;
    }
    if (ok) return out.join('/');
  }
  return null;
}

/** Rewrites literal segments to their registered spelling, honouring `strict: false`. */
export function canonicalizePath(method: string, path: string): string {
  const direct = canonicalizeOne(method, path);
  if (direct !== null) return direct;
  if (path.length > 1 && path.endsWith('/')) {
    const trimmed = canonicalizeOne(method, path.slice(0, -1));
    if (trimmed !== null) return trimmed;
  }
  return path;
}
