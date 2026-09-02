// Contract tests for the Tomo Together app service (Azure Web App
// `ht6-tomoyard`; target Worker `tomo-together-api`).
//
//   BASE_URL=https://ht6-tomoyard.azurewebsites.net node --test app.contract.test.mjs
//
// Black-box HTTP only. PRODUCTION-SAFE: every request here is either a read or
// an input that is rejected by validation before any write happens. Nothing in
// this file creates, mutates or deletes a row, and nothing reaches the custody
// service (registration would provision a custody wallet, so the happy-path
// register/login flow is deliberately NOT exercised here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { req, upgradeHandshake, APP_CORS } from './helpers.mjs';

// sha256 of GET /catalog's response body. The catalog is a pure constant table
// (ACTIVITIES / ITEMS / HOLIDAYS) so this pins the payload byte-for-byte,
// including key order and JSON serialization.
const CATALOG_SHA256 = 'a415d8e53965ad53d6d0955da6ed6447ddac827e57cea601324f531a9154ee58';
// sha256 of GET / — the marketing homepage served from server/public/index.html.
const HOMEPAGE_SHA256 = '8d0cdd0db80f62c83d245de350cbd6f71551df4fc31436d642af6715d2bf90d2';

function assertAppCors(r) {
  for (const [k, v] of Object.entries(APP_CORS)) {
    assert.equal(r.headers[k], v, `CORS header ${k}`);
  }
  assert.equal(r.headers['access-control-allow-credentials'], undefined,
    'the app must never send Access-Control-Allow-Credentials');
}

// ---------------------------------------------------------------- liveness --

test('GET /health returns the exact service identity payload', async () => {
  const r = await req('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.text, '{"ok":true,"name":"tomo-yard"}');
  assertAppCors(r);
});

test('GET /health ignores an unknown query string', async () => {
  const r = await req('GET', '/health?x=1');
  assert.equal(r.status, 200);
  assert.equal(r.text, '{"ok":true,"name":"tomo-yard"}');
});

test('Express routing defaults: paths are case-insensitive and non-strict', async () => {
  assert.equal((await req('GET', '/Health')).status, 200, '/Health must resolve to /health');
  assert.equal((await req('GET', '/catalog/')).status, 200, '/catalog/ must resolve to /catalog');
});

test('a method with no matching route 404s even on a known path', async () => {
  const r = await req('DELETE', '/health');
  assert.equal(r.status, 404);
});

// -------------------------------------------------------------------- CORS --

test('every response carries the three CORS headers', async () => {
  for (const [method, path] of [['GET', '/health'], ['GET', '/catalog'], ['GET', '/me'], ['GET', '/nope-404']]) {
    assertAppCors(await req(method, path));
  }
});

test('OPTIONS preflight short-circuits with 204 and an empty body', async () => {
  for (const path of ['/health', '/me', '/wallet/withdraw', '/anything-at-all']) {
    const r = await req('OPTIONS', path, {
      headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(r.status, 204, `OPTIONS ${path}`);
    assert.equal(r.text, '', `OPTIONS ${path} body`);
    assertAppCors(r);
  }
});

test('OPTIONS on an auth-gated route is not challenged for credentials', async () => {
  const r = await req('OPTIONS', '/wallet');
  assert.equal(r.status, 204);
  assert.equal(r.headers['www-authenticate'], undefined);
});

// ----------------------------------------------------------------- catalog --

test('GET /catalog is byte-stable', async () => {
  const r = await req('GET', '/catalog');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.sha256, CATALOG_SHA256, 'catalog payload changed byte-for-byte');
  assertAppCors(r);
});

test('GET /catalog has the expected structure', async () => {
  const { json } = await req('GET', '/catalog');
  assert.deepEqual(Object.keys(json), ['activities', 'items', 'holidays']);

  assert.equal(json.activities.length, 69);
  assert.deepEqual(json.activities[0], { id: 'ramen', label: 'Ramen', category: 'Food & Drink' });
  assert.deepEqual(json.activities.at(-1), { id: 'aquarium', label: 'Aquarium', category: 'Chill & Social' });
  for (const a of json.activities) assert.deepEqual(Object.keys(a), ['id', 'label', 'category']);
  assert.deepEqual([...new Set(json.activities.map((a) => a.category))], [
    'Food & Drink', 'Outdoors', 'Active & Sports', 'Games & Play',
    'Arts & Culture', 'Music & Nightlife', 'Chill & Social',
  ]);
  assert.equal(new Set(json.activities.map((a) => a.id)).size, json.activities.length, 'activity ids unique');

  assert.equal(json.items.length, 23);
  assert.deepEqual(json.items[0], { id: 'party_hat', name: 'Party Hat', price: 60 });
  for (const i of json.items) assert.deepEqual(Object.keys(i), ['id', 'name', 'price']);

  assert.deepEqual(json.holidays, [
    { month: 1, day: 1, label: 'New Year' },
    { month: 2, day: 14, label: 'Valentines' },
    { month: 7, day: 30, label: 'Friendship Day' },
    { month: 10, day: 31, label: 'Halloween' },
    { month: 12, day: 25, label: 'Christmas' },
    { month: 12, day: 31, label: 'New Years Eve' },
  ]);
});

test('HEAD /catalog reports the body length without a body', async () => {
  const r = await req('HEAD', '/catalog');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-length'], '5820');
  assert.equal(r.text, '');
});

// ------------------------------------------------------- static + downloads --

test('GET / serves the marketing homepage byte-for-byte', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  // serve-static spells the charset upper-case; the Express error pages do not.
  assert.equal(r.headers['content-type'], 'text/html; charset=UTF-8');
  assert.equal(r.headers['cache-control'], 'public, max-age=0');
  assert.equal(r.headers['accept-ranges'], 'bytes');
  assert.ok(r.headers['etag'], 'static assets must carry an ETag');
  assert.ok(r.headers['last-modified'], 'static assets must carry Last-Modified');
  assert.equal(r.sha256, HOMEPAGE_SHA256);
  assertAppCors(r);
});

test('GET /apk/version returns the updater metadata', async () => {
  const r = await req('GET', '/apk/version');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(Object.keys(r.json), ['versionCode', 'versionName']);
  assert.equal(typeof r.json.versionCode, 'number');
  assert.ok(Number.isInteger(r.json.versionCode) && r.json.versionCode > 0);
  assert.match(r.json.versionName, /^\d+\.\d+\.\d+$/);
});

test('HEAD /apk offers the APK as a named attachment', async () => {
  const r = await req('HEAD', '/apk');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/vnd.android.package-archive');
  assert.equal(r.headers['content-disposition'], 'attachment; filename="tomo-yard.apk"');
  assert.equal(r.headers['accept-ranges'], 'bytes');
  assert.equal(r.headers['cache-control'], 'public, max-age=0');
  assert.ok(Number(r.headers['content-length']) > 1_000_000, 'APK should be megabytes');
});

test('GET /apk supports range requests and serves a real ZIP', async () => {
  const r = await req('GET', '/apk', { headers: { Range: 'bytes=0-3' } });
  assert.equal(r.status, 206);
  assert.match(r.headers['content-range'], /^bytes 0-3\/\d+$/);
  assert.equal(r.headers['content-length'], '4');
  assert.deepEqual([...r.bytes], [0x50, 0x4b, 0x03, 0x04], 'APK must start with the PK zip magic');
});

test('a missing upload 404s rather than erroring', async () => {
  const r = await req('GET', '/uploads/definitely-missing-9f3a2b.jpg');
  assert.equal(r.status, 404);
  assert.match(r.text, /Cannot GET \/uploads\/definitely-missing-9f3a2b\.jpg/);
});

// -------------------------------------------------------------- auth model --

// The live service must use self-hosted opaque bearer tokens. AUTH0_AUDIENCE,
// AUTH0_ISSUER_BASE_URL and ALLOW_LEGACY_AUTH are dead env vars: no code reads
// them. These tests pin that, so a regression that reintroduces an Auth0 code
// path fails loudly.

test('the Auth0 onboarding surface does not exist', async () => {
  for (const method of ['GET', 'PUT']) {
    const r = await req(method, '/auth/profile');
    assert.equal(r.status, 404, `${method} /auth/profile must not exist`);
    assert.match(r.text, new RegExp(`Cannot ${method} /auth/profile`));
  }
});

test('a JWT-shaped bearer is not verified as a JWT, it simply is not a token', async () => {
  // The Auth0 build answered `{"error":"invalid_token","message":"Authentication required"}`
  // here. Self-hosted auth treats the value as an opaque token that does not exist.
  const r = await req('GET', '/me', { headers: { Authorization: 'Bearer aaa.bbb.ccc' } });
  assert.equal(r.status, 401);
  assert.equal(r.text, '{"error":"Not signed in"}');
  assert.equal(r.headers['www-authenticate'], 'Bearer');
});

test('unknown or malformed credentials all fail the same way', async () => {
  const authorizations = [
    undefined,                                   // no header at all
    'Bearer ' + '0'.repeat(48),                  // well-formed but unknown token
    'Bearer aaa.bbb.ccc',                        // JWT-shaped
    'Basic YWxpY2U6c2VjcmV0',                    // wrong scheme
    'Bearer tok1,tok2',                          // comma-joined credentials
    'Bearer',                                    // scheme with no credential
    'bearer ' + '0'.repeat(48),                  // lower-case scheme
  ];
  for (const authorization of authorizations) {
    const headers = authorization === undefined ? {} : { Authorization: authorization };
    const r = await req('GET', '/me', { headers });
    assert.equal(r.status, 401, `Authorization: ${authorization}`);
    assert.equal(r.text, '{"error":"Not signed in"}', `Authorization: ${authorization}`);
    assert.equal(r.headers['www-authenticate'], 'Bearer', `Authorization: ${authorization}`);
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  }
});

const PROTECTED_ROUTES = [
  ['GET', '/me'],
  ['PUT', '/me/interests'],
  ['PUT', '/me/avatar'],
  ['GET', '/users/search?q=ab'],
  ['GET', '/friends'],
  ['GET', '/friends/nobody_here'],
  ['GET', '/friends/nobody_here/card'],
  ['POST', '/friends/request'],
  ['POST', '/friends/accept'],
  ['GET', '/activities/ranked'],
  ['POST', '/duels'],
  ['GET', '/suggestions'],
  ['POST', '/hangouts'],
  ['GET', '/hangouts'],
  ['GET', '/hangouts/1'],
  ['GET', '/hangouts/999999999'],
  ['POST', '/hangouts/1/stake'],
  ['POST', '/hangouts/1/photo'],
  ['POST', '/hangouts/1/end'],
  ['GET', '/hangouts/1/nfc-token'],
  ['POST', '/hangouts/1/confirm'],
  ['GET', '/memories'],
  ['GET', '/leaderboard'],
  ['POST', '/shop/buy'],
  ['POST', '/secret/acorns'],
  ['GET', '/wallet'],
  ['POST', '/wallet/add-funds'],
  ['POST', '/wallet/refresh'],
  ['POST', '/wallet/withdraw'],
  ['POST', '/world/ws-ticket'],
];

test('every protected route challenges before doing any work', async () => {
  for (const [method, path] of PROTECTED_ROUTES) {
    const r = await req(method, path, { body: method === 'GET' ? undefined : {} });
    assert.equal(r.status, 401, `${method} ${path}`);
    assert.equal(r.text, '{"error":"Not signed in"}', `${method} ${path}`);
    assert.equal(r.headers['www-authenticate'], 'Bearer', `${method} ${path}`);
    assertAppCors(r);
  }
});

test('the auth gate runs before body parsing and before upload handling', async () => {
  // Multipart upload route: rejected on credentials, not on the missing file.
  const r = await req('POST', '/hangouts/1/photo', {
    raw: 'not a multipart body',
    headers: { 'Content-Type': 'multipart/form-data; boundary=xyz' },
  });
  assert.equal(r.status, 401);
  assert.equal(r.text, '{"error":"Not signed in"}');
});

test('the withdraw idempotency check is behind the auth gate', async () => {
  // No Idempotency-Key at all must still be a 401, never a 400 — the credential
  // check has to come first.
  const r = await req('POST', '/wallet/withdraw', { body: { amountUnits: '1' } });
  assert.equal(r.status, 401);
  assert.equal(r.text, '{"error":"Not signed in"}');
});

// ---------------------------------------------- registration input contract --

// All of these are rejected by validation before any insert, so they are safe
// to run against production.
test('POST /auth/register validates in a fixed order', async () => {
  const cases = [
    [{}, 'Username must be 3-20 chars: a-z, 0-9, _'],
    [{ username: 'AB' }, 'Username must be 3-20 chars: a-z, 0-9, _'],
    [{ username: 'ab' }, 'Username must be 3-20 chars: a-z, 0-9, _'],
    [{ username: 'has-a-hyphen' }, 'Username must be 3-20 chars: a-z, 0-9, _'],
    [{ username: 'x'.repeat(21) }, 'Username must be 3-20 chars: a-z, 0-9, _'],
    [{ username: 'ctest_probe_a1' }, 'Name is required'],
    [{ username: 'ctest_probe_a1', name: '' }, 'Name is required'],
    [{ username: 'ctest_probe_a1', name: 'x'.repeat(41) }, 'Name is required'],
    [{ username: 'ctest_probe_a1', name: 'P' }, 'Birthday must be a valid date'],
    [{ username: 'ctest_probe_a1', name: 'P', birthday: 'nope' }, 'Birthday must be a valid date'],
    [{ username: 'ctest_probe_a1', name: 'P', birthday: '2000-01-01' }, 'Password must be at least 6 characters'],
    [{ username: 'ctest_probe_a1', name: 'P', birthday: '2000-01-01', password: 'short' }, 'Password must be at least 6 characters'],
  ];
  for (const [body, error] of cases) {
    const r = await req('POST', '/auth/register', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(r.json, { error }, JSON.stringify(body));
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  }
});

test('a MongoDB operator object can never reach a query', async () => {
  // `{ $gt: "" }` as a username must be treated as an invalid string, not as a
  // filter that matches every row.
  const reg = await req('POST', '/auth/register', { body: { username: { $gt: '' } } });
  assert.equal(reg.status, 400);
  assert.deepEqual(reg.json, { error: 'Username must be 3-20 chars: a-z, 0-9, _' });

  const login = await req('POST', '/auth/login', { body: { username: { $gt: '' }, password: 'x' } });
  assert.equal(login.status, 401);
  assert.deepEqual(login.json, { error: 'Wrong username or password' });

  const loginPw = await req('POST', '/auth/login', {
    body: { username: 'ctest_no_such_user_9f3a2b', password: { $gt: '' } },
  });
  assert.equal(loginPw.status, 401);
  assert.deepEqual(loginPw.json, { error: 'Wrong username or password' });
});

test('POST /auth/login rejects an unknown account without leaking whether it exists', async () => {
  // This also proves the datastore read path is live end-to-end: the handler
  // does a users.findOne() before it can answer 401. A dead database surfaces
  // as a 500 here, not a 401.
  for (const body of [{}, { username: 'ctest_no_such_user_9f3a2b', password: 'whatever123' }]) {
    const r = await req('POST', '/auth/login', { body });
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: 'Wrong username or password' });
    assert.equal(r.headers['www-authenticate'], undefined,
      'a failed login is not a Bearer challenge');
  }
});

// ------------------------------------------------------------ error formats --

test('an unknown route returns the Express HTML 404 with its hardening headers', async () => {
  const r = await req('GET', '/definitely-not-a-route');
  assert.equal(r.status, 404);
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(r.headers['content-security-policy'], "default-src 'none'");
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.text, /<pre>Cannot GET \/definitely-not-a-route<\/pre>/);
  assertAppCors(r);
});

test('the 404 body reflects the method', async () => {
  const r = await req('POST', '/definitely-not-a-route');
  assert.equal(r.status, 404);
  assert.match(r.text, /<pre>Cannot POST \/definitely-not-a-route<\/pre>/);
});

test('a malformed JSON body surfaces as the generic 500 envelope', async () => {
  // Quirk of the current error handler: it special-cases only 401/403, so the
  // body-parser's 400 SyntaxError falls through to the 500 branch. Reproduced
  // deliberately — the prime directive is identical behaviour, not better
  // behaviour.
  const r = await req('POST', '/auth/login', {
    raw: 'not-json',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(r.status, 500);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(r.json, { error: 'server_error', message: 'Internal server error' });
  assertAppCors(r);
});

// ------------------------------------------------------------- world socket --

test('a WebSocket upgrade without a valid ticket is rejected with a bare 401', async () => {
  for (const target of [
    '/ws',                    // no ticket
    '/ws?ticket=bogus',       // unknown ticket
    '/ws?ticket=a&ticket=b',  // duplicated ticket parameter
    '/ws?ticket=a&other=1',   // extra parameter
    '/ws?other=1',            // wrong parameter
    '/not-the-ws-path',       // wrong path
  ]) {
    const head = await upgradeHandshake(target);
    assert.match(head, /^HTTP\/1\.1 401 Unauthorized/, `upgrade ${target} -> ${head.split('\r\n')[0]}`);
    assert.doesNotMatch(head, /Sec-WebSocket-Accept/i, `upgrade ${target} must not be accepted`);
  }
});

test('a rejected upgrade leaks nothing about the ticket', async () => {
  const head = await upgradeHandshake('/ws?ticket=super-secret-value-123');
  assert.doesNotMatch(head, /super-secret-value-123/);
  assert.match(head, /^HTTP\/1\.1 401 Unauthorized/);
});
