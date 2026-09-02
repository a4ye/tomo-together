// Contract tests for the treasury-custody service (Azure Web App
// `ht6-tomoyard-crypto`; target Worker `tomo-together-custody`).
//
//   BASE_URL=https://ht6-tomoyard-crypto.azurewebsites.net node --test custody.contract.test.mjs
//
// STRICTLY READ-ONLY. This service holds real custody of USDC. Every request in
// this file is either a public probe (/health, /ready, /readyz) or an
// unauthenticated call that is rejected by requireServiceToken *before*
// express.json() parses the body and before any handler runs. The only
// unauthenticated business surface is POST /webhooks/unifold, and the single
// request made against it fails HMAC verification inside verifiedEvent(), which
// runs before any datastore access. Nothing here can move money or mutate state.
//
// The service token is never supplied by this suite, by design: an
// authenticated write-path suite must not run against production.
import test from 'node:test';
import assert from 'node:assert/strict';
import { req } from './helpers.mjs';

const UNAUTHORIZED_BODY = '{"ok":false,"error":"unauthorized"}';

function assertNoCors(r) {
  for (const k of [
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-allow-headers',
    'access-control-allow-credentials',
  ]) {
    assert.equal(r.headers[k], undefined, `custody must not send ${k}`);
  }
}

// -------------------------------------------------------- public liveness --

test('GET /health is public and returns exactly {"ok":true}', async () => {
  const r = await req('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.text, '{"ok":true}');
  assert.equal(r.headers['www-authenticate'], undefined);
  assertNoCors(r);
});

test('GET /health stays public even when a bogus credential is offered', async () => {
  const r = await req('GET', '/health', {
    headers: { Authorization: 'Bearer ' + 'z'.repeat(64) },
  });
  assert.equal(r.status, 200);
  assert.equal(r.text, '{"ok":true}');
});

test('HEAD /health works', async () => {
  const r = await req('HEAD', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-length'], '11');
  assert.equal(r.text, '');
});

test('GET /ready reports the initialized datastore', async () => {
  const r = await req('GET', '/ready');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(Object.keys(r.json), ['ok', 'state', 'backend']);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.state, 'ready');
  // `backend` reports which datastore this deployment actually initialized, so it
  // legitimately differs between the two: Azure still runs MongoDB Atlas, the Worker
  // runs D1. The phase-1/phase-2 split was merged for this service, so pinning
  // 'mongodb' would force the Worker to report a datastore it does not use — a false
  // operational signal on the service that holds the treasury. Both values are valid;
  // anything else still means a migration bug.
  assert.ok(
    ['mongodb', 'd1'].includes(r.json.backend),
    `unexpected backend: ${r.json.backend}`,
  );
  assertNoCors(r);
});

test('GET /readyz is an alias of /ready', async () => {
  const a = await req('GET', '/ready');
  const b = await req('GET', '/readyz');
  assert.equal(b.status, a.status);
  assert.equal(b.text, a.text);
});

test('readiness is public — the app server probes it without a credential', async () => {
  // server/crypto.js deliberately probes /ready anonymously and must never send
  // the service token to it.
  const r = await req('GET', '/ready');
  assert.equal(r.status, 200);
  assert.equal(r.headers['www-authenticate'], undefined);
});

// ------------------------------------------------------------- auth gate ----

// Every route below the requireServiceToken middleware, including the ones that
// move treasury funds. All must be unreachable without the shared bearer.
const GATED_ROUTES = [
  ['GET', '/'],
  ['GET', '/catalog'],
  ['GET', '/treasury'],
  ['POST', '/users/register'],
  ['GET', '/users/ty_contract_probe'],
  ['GET', '/users/ty_contract_probe/events'],
  ['POST', '/grant'],
  ['POST', '/adjust'],
  ['POST', '/add-funds'],
  ['POST', '/deposits/refresh'],
  ['POST', '/withdraw'],
  ['GET', '/withdrawals/ctest-none'],
  ['POST', '/events'],
  ['GET', '/events/ctest-none'],
  ['POST', '/events/ctest-none/rsvp'],
  ['POST', '/events/ctest-none/checkin'],
  ['POST', '/events/ctest-none/settle'],
];

test('every business route requires the service token', async () => {
  for (const [method, path] of GATED_ROUTES) {
    const r = await req(method, path, { body: method === 'GET' ? undefined : {} });
    assert.equal(r.status, 401, `${method} ${path}`);
    assert.equal(r.text, UNAUTHORIZED_BODY, `${method} ${path}`);
    assert.equal(r.headers['www-authenticate'], 'Bearer', `${method} ${path}`);
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8', `${method} ${path}`);
    assertNoCors(r);
  }
});

test('the treasury-moving routes are never reachable anonymously', async () => {
  // Called out separately so a regression on exactly these reads unmistakably
  // in the test output.
  for (const [method, path] of [
    ['POST', '/withdraw'],
    ['POST', '/adjust'],
    ['POST', '/grant'],
    ['POST', '/events/ctest-none/settle'],
  ]) {
    const r = await req(method, path, { body: {} });
    assert.equal(r.status, 401, `${method} ${path} MUST be 401`);
    assert.equal(r.text, UNAUTHORIZED_BODY);
  }
});

test('an unknown route is challenged, not 404ed — the gate precedes routing', async () => {
  const r = await req('GET', '/definitely-not-a-route');
  assert.equal(r.status, 401);
  assert.equal(r.text, UNAUTHORIZED_BODY);
  assert.equal(r.headers['www-authenticate'], 'Bearer');
});

test('there is no CORS or OPTIONS handling at all', async () => {
  const r = await req('OPTIONS', '/health', {
    headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' },
  });
  // Even OPTIONS on the public health path falls into the gate: express only
  // auto-answers OPTIONS for routes it knows, and app.use() sits in front.
  assert.equal(r.status, 401);
  assert.equal(r.text, UNAUTHORIZED_BODY);
  assertNoCors(r);
});

test('a public GET does not gain CORS headers from an Origin', async () => {
  assertNoCors(await req('GET', '/ready', { headers: { Origin: 'https://example.com' } }));
});

test('malformed credentials are all rejected identically', async () => {
  const authorizations = [
    undefined,
    'Bearer',
    'Bearer ',
    'Basic YWxpY2U6c2VjcmV0',
    'Bearer tok1 tok2',
    'Bearer tok1,tok2',
    'Token abcdefabcdefabcdefabcdefabcdefab',
    'Bearer ' + 'z'.repeat(64),
  ];
  for (const authorization of authorizations) {
    const headers = authorization === undefined ? {} : { Authorization: authorization };
    const r = await req('GET', '/catalog', { headers });
    assert.equal(r.status, 401, `Authorization: ${authorization}`);
    assert.equal(r.text, UNAUTHORIZED_BODY, `Authorization: ${authorization}`);
    assert.equal(r.headers['www-authenticate'], 'Bearer', `Authorization: ${authorization}`);
  }
});

test('a lower-case bearer scheme is accepted by the parser but still rejected', async () => {
  const r = await req('GET', '/catalog', {
    headers: { Authorization: 'bearer ' + 'z'.repeat(64) },
  });
  assert.equal(r.status, 401);
  assert.equal(r.text, UNAUTHORIZED_BODY);
});

// --------------------------------------------------------------- webhooks ----

test('an unsigned Unifold webhook is rejected as a plain-text 400', async () => {
  // Safe: handleUnifoldWebhook() verifies the HMAC in verifiedEvent() before it
  // reads a single event field or touches the datastore. A rejection here can
  // never have mutated anything.
  const r = await req('POST', '/webhooks/unifold', {
    raw: JSON.stringify({ type: 'deposit.direct_execution.completed' }),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(r.text, 'Bad Request');
  assert.equal(r.headers['www-authenticate'], undefined,
    'the webhook is authenticated by signature, not by the service token');
});

test('the webhook route is reachable without the service token', async () => {
  // It must NOT fall into requireServiceToken — it is registered above the gate.
  const r = await req('POST', '/webhooks/unifold', { raw: 'x' });
  assert.equal(r.status, 400, 'expected the signature check (400), not the auth gate (401)');
  assert.notEqual(r.text, UNAUTHORIZED_BODY);
});

test('the webhook never reflects its input', async () => {
  const r = await req('POST', '/webhooks/unifold', {
    raw: JSON.stringify({ secret: 'ctest-canary-value-9f3a2b' }),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.text, /ctest-canary-value-9f3a2b/);
});
