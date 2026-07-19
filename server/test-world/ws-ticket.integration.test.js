'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { after, before, test } = require('node:test');
const WebSocket = require('ws');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomoyard-world-'));
process.env.DATA_DIR = dataDir;
process.env.SQLITE_JOURNAL = 'delete';
process.env.NODE_ENV = 'test';
process.env.WORLD_WS_TICKET_TTL_MS = '80';
process.env.ALLOW_LEGACY_AUTH = 'true';
process.env.AUTH0_ISSUER_BASE_URL = 'https://test.us.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.tomoyard.invalid';
delete process.env.CRYPTO_API_URL;
delete process.env.CRYPTO_SERVICE_TOKEN;

const LEGACY_TOKEN = 'f00dcafe'.repeat(6);
const AUTH0_TOKEN = 'world.jwt.linked-profile';
const PROFILE_REQUIRED_TOKEN = 'world.jwt.profile-required';
const AUTH0_SUB = 'auth0|world-linked';
const loggedOutput = [];
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

// Keep the full server authentication dispatcher in the test. Only replace the
// external signature/JWKS boundary with deterministic verified subjects.
const auth0Path = require.resolve('../auth0');
const realAuth0 = require(auth0Path);
require.cache[auth0Path].exports = {
  ...realAuth0,
  createAuth0JwtMiddleware: () => (req, _res, next) => {
    const token = realAuth0.getBearerToken(req);
    const subjects = {
      [AUTH0_TOKEN]: AUTH0_SUB,
      [PROFILE_REQUIRED_TOKEN]: 'auth0|world-profile-required',
    };
    if (subjects[token]) {
      req.auth = { payload: { sub: subjects[token] } };
      return next();
    }
    const error = new Error('signature verification failed');
    error.status = 401;
    error.code = 'invalid_token';
    error.headers = { 'WWW-Authenticate': 'Bearer error="invalid_token"' };
    return next(error);
  },
};

const { createServer, db, worldTicketTtlMs } = require('../index');
let server;
let httpBaseUrl;
let wsBaseUrl;
const issuedTickets = [];

function captureConsole(method) {
  console[method] = (...args) => {
    loggedOutput.push(args.map((value) => {
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value); } catch { return String(value); }
    }).join(' '));
  };
}

before(async () => {
  captureConsole('log');
  captureConsole('warn');
  captureConsole('error');

  const insertUser = db.prepare(`INSERT INTO users
    (username, name, birthday, pass_hash, salt, token, auth0_sub, color, species, interests, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertUser.run(
    'world_legacy', 'World Legacy', '2000-01-01', 'unused', 'unused', LEGACY_TOKEN,
    null, '#A8D8C8', 'cat', '[]', new Date().toISOString(),
  );
  insertUser.run(
    'world_auth0', 'World Auth0', '2001-02-03', 'auth0-disabled:test', 'auth0-disabled:test',
    'auth0-disabled:world-test', AUTH0_SUB, '#123ABC', 'frog', '[]', new Date().toISOString(),
  );

  server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  httpBaseUrl = `http://127.0.0.1:${port}`;
  wsBaseUrl = `ws://127.0.0.1:${port}`;
});

after(async () => {
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function issueTicket(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(`${httpBaseUrl}/world/ws-ticket`, {
    method: 'POST',
    headers,
  });
  const json = await response.json();
  if (json.ticket) issuedTickets.push(json.ticket);
  return { status: response.status, headers: response.headers, json };
}

function connect(pathname) {
  const ws = new WebSocket(`${wsBaseUrl}${pathname}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WebSocket handshake timed out for ${pathname}`));
    }, 2_000);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ws, ...result });
    };

    ws.once('open', () => finish({ accepted: true }));
    ws.once('unexpected-response', (_request, response) => {
      const status = response.statusCode;
      response.resume();
      finish({ accepted: false, status });
    });
    ws.once('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

async function connectAndReadInit(ticket) {
  const ws = new WebSocket(`${wsBaseUrl}/ws?ticket=${encodeURIComponent(ticket)}`);
  const opened = once(ws, 'open');
  const message = once(ws, 'message');
  await opened;
  const [data] = await message;
  return { ws, init: JSON.parse(data.toString()) };
}

async function closeSocket(ws) {
  if (!ws || ws.readyState >= WebSocket.CLOSING) return;
  const closed = once(ws, 'close');
  ws.close(1000, 'test complete');
  await closed;
}

async function assertRejected(pathname) {
  const result = await connect(pathname);
  assert.equal(result.accepted, false, `${pathname} must not upgrade`);
  assert.equal(result.status, 401);
}

test('ticket issuance requires an authenticated application profile', async () => {
  const missing = await issueTicket();
  assert.equal(missing.status, 401);

  const profileRequired = await issueTicket(PROFILE_REQUIRED_TOKEN);
  assert.equal(profileRequired.status, 409);
  assert.deepEqual(profileRequired.json, { error: 'PROFILE_REQUIRED' });
});

test('authenticated issuance is random, non-cacheable, and rotates abandoned tickets', async () => {
  const first = await issueTicket(LEGACY_TOKEN);
  const second = await issueTicket(LEGACY_TOKEN);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.match(first.json.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second.json.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.json.ticket, second.json.ticket);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(second.headers.get('cache-control'), 'no-store');

  await assertRejected(`/ws?ticket=${encodeURIComponent(first.json.ticket)}`);
  const accepted = await connectAndReadInit(second.json.ticket);
  assert.equal(accepted.init.type, 'init');
  assert.equal(accepted.init.me, 'world_legacy');
  await closeSocket(accepted.ws);
});

test('a websocket ticket is accepted exactly once and a fresh reconnect ticket works', async () => {
  const first = await issueTicket(LEGACY_TOKEN);
  assert.equal(first.status, 200);
  const connected = await connectAndReadInit(first.json.ticket);
  assert.equal(connected.init.me, 'world_legacy');
  await closeSocket(connected.ws);

  await assertRejected(`/ws?ticket=${encodeURIComponent(first.json.ticket)}`);

  const reconnect = await issueTicket(LEGACY_TOKEN);
  assert.equal(reconnect.status, 200);
  assert.notEqual(reconnect.json.ticket, first.json.ticket);
  const reconnected = await connectAndReadInit(reconnect.json.ticket);
  assert.equal(reconnected.init.me, 'world_legacy');
  await closeSocket(reconnected.ws);
});

test('the websocket identity comes from the authenticated ticket issuer', async () => {
  const response = await issueTicket(AUTH0_TOKEN);
  assert.equal(response.status, 200);
  const connected = await connectAndReadInit(response.json.ticket);
  assert.equal(connected.init.type, 'init');
  assert.equal(connected.init.me, 'world_auth0');
  assert.ok(connected.init.players.some((player) => player.username === 'world_auth0'));
  await closeSocket(connected.ws);
});

test('expired and unknown tickets are rejected', async () => {
  assert.equal(worldTicketTtlMs(), 80);
  const response = await issueTicket(LEGACY_TOKEN);
  assert.equal(response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, worldTicketTtlMs() + 40));
  await assertRejected(`/ws?ticket=${encodeURIComponent(response.json.ticket)}`);
  await assertRejected('/ws?ticket=unknown-world-ticket');
});

test('missing, duplicate, legacy, JWT, and legacy token query credentials are rejected', async () => {
  await assertRejected('/ws');
  await assertRejected('/ws?ticket=');
  await assertRejected(`/ws?ticket=${LEGACY_TOKEN}`);
  await assertRejected(`/ws?ticket=${encodeURIComponent(AUTH0_TOKEN)}`);
  await assertRejected(`/ws?token=${LEGACY_TOKEN}`);
  await assertRejected(`/ws?token=${encodeURIComponent(AUTH0_TOKEN)}`);
  await assertRejected('/ws?ticket=one&ticket=two');
  await assertRejected('/ws?ticket=unknown&token=also-unknown');
});

test('websocket credential material is never written to application logs', () => {
  const output = loggedOutput.join('\n');
  const credentials = [
    LEGACY_TOKEN,
    AUTH0_TOKEN,
    PROFILE_REQUIRED_TOKEN,
    ...issuedTickets,
  ];
  for (const credential of credentials) {
    assert.equal(output.includes(credential), false, `log leaked credential ${credential.slice(0, 8)}...`);
  }
});
