'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { after, before, test } = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomoyard-crypto-routes-'));
process.env.DATA_DIR = dataDir;
process.env.SQLITE_JOURNAL = 'delete';
process.env.ALLOW_LEGACY_AUTH = 'true';
process.env.AUTH0_ISSUER_BASE_URL = 'https://test.us.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.tomoyard.invalid';

class CryptoError extends Error {
  constructor(status, message, code = 'crypto_request_failed') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
class CryptoUnavailableError extends CryptoError {
  constructor() {
    super(503, 'Crypto is temporarily unavailable. Please try again.', 'crypto_unavailable');
  }
}

const state = {
  ready: true,
  event: null,
  rsvpCalls: 0,
  checkinCalls: [],
  withdrawCalls: [],
  withdrawMode: 'pending',
  settlementMode: 'valid',
};

const fakeCrypto = {
  CryptoError,
  CryptoUnavailableError,
  extId: (username) => `ty_${username}`,
  validIdempotencyKey: (value) =>
    typeof value === 'string' && value.length >= 8 && value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value),
  enabled: () => state.ready,
  ready: async () => state.ready,
  ensureUser: async () => {
    if (!state.ready) throw new CryptoUnavailableError();
  },
  createEvent: async (_host, _title, stakeUnits) => {
    if (!state.ready) throw new CryptoUnavailableError();
    state.event = { id: 'event-1', status: 'open', stakeUnits, rsvps: [] };
    return state.event;
  },
  getEvent: async () => {
    if (!state.ready) throw new CryptoUnavailableError();
    return state.event;
  },
  rsvp: async (_eventId, username) => {
    if (!state.ready) throw new CryptoUnavailableError();
    state.rsvpCalls += 1;
    const userId = `ty_${username}`;
    if (!state.event.rsvps.some((entry) => entry.userId === userId)) {
      state.event.rsvps.push({ userId, status: 'staked', stakedUnits: state.event.stakeUnits });
    }
    return state.event;
  },
  checkin: async (_eventId, username) => {
    if (!state.ready) throw new CryptoUnavailableError();
    state.checkinCalls.push(username);
    const rsvp = state.event.rsvps.find((entry) => entry.userId === `ty_${username}`);
    if (!rsvp) throw new CryptoError(400, 'user has not RSVP’d');
    rsvp.status = 'attended';
    return state.event;
  },
  settle: async () => {
    if (state.settlementMode === 'invalid') {
      return { eventId: 'wrong-event', status: 'settled', forfeitPoolUnits: '0', results: [] };
    }
    return {
      eventId: state.event.id,
      status: 'settled',
      forfeitPoolUnits: '0',
      results: state.event.rsvps.map((entry) => ({
        userId: entry.userId,
        status: entry.status === 'attended' ? 'attended' : 'refunded',
        stakedUnits: entry.stakedUnits,
        payoutUnits: entry.stakedUnits,
      })),
    };
  },
  getWallet: async () => ({
    balanceUnits: '20000000',
    readyToCashOut: true,
    cashoutThresholdUnits: '20000000',
    withdrawals: [],
  }),
  addFunds: async () => ({ ok: true }),
  refreshDeposits: async () => ({ ok: true, creditedUnits: '0' }),
  withdraw: async (_username, amountUnits, destination, key) => {
    state.withdrawCalls.push({ amountUnits, destination, key });
    if (state.withdrawMode === 'conflict') {
      throw new CryptoError(409, 'key belongs to a different withdrawal', 'crypto_conflict');
    }
    return {
      status: 202,
      data: {
        ok: false,
        pending: true,
        withdrawalId: 'withdrawal-1',
        error: 'withdrawal is pending reconciliation; retry with the same Idempotency-Key',
      },
    };
  },
};

const cryptoPath = require.resolve('../crypto');
require.cache[cryptoPath] = {
  id: cryptoPath,
  filename: cryptoPath,
  loaded: true,
  exports: fakeCrypto,
};

const { app, db } = require('../index');
let server;
let baseUrl;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete require.cache[cryptoPath];
});

async function request(route, { method = 'GET', token, body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) requestHeaders['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: requestHeaders,
    body: body === undefined || isForm ? body : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function register(username) {
  const result = await request('/auth/register', {
    method: 'POST',
    body: {
      username,
      name: username.toUpperCase(),
      birthday: '2000-01-02',
      password: 'correct horse',
      color: '#A8D8C8',
      species: 'cat',
    },
  });
  assert.equal(result.status, 200);
  return result.json.token;
}

test('money routes preserve intent, repair retries, and mirror settlement atomically', async () => {
  const alice = await register('alice');
  const bob = await register('bob');
  assert.equal((await request('/friends/request', {
    method: 'POST', token: alice, body: { username: 'bob' },
  })).status, 200);
  assert.equal((await request('/friends/accept', {
    method: 'POST', token: bob, body: { username: 'alice' },
  })).status, 200);

  const createBody = {
    activity: 'ramen',
    date: new Date(Date.now() - 60_000).toISOString(),
    place: 'Test cafe',
    friendUsernames: ['bob'],
    stakeUnits: '2000000',
  };

  const malformed = await request('/hangouts', {
    method: 'POST', token: alice, body: { ...createBody, stakeUnits: '2.5' },
  });
  assert.equal(malformed.status, 400);
  assert.equal(state.event, null);

  state.ready = false;
  const unavailable = await request('/hangouts', {
    method: 'POST', token: alice, body: createBody,
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json.error, 'crypto_unavailable');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM hangouts').get().count, 0);
  state.ready = true;

  const created = await request('/hangouts', { method: 'POST', token: alice, body: createBody });
  assert.equal(created.status, 200);
  const hangoutId = created.json.hangout.id;
  assert.equal(created.json.hangout.stake.iStaked, false, 'host is not debited before local durability');
  assert.equal(state.event.rsvps.length, 0);

  // Simulate a remote RSVP whose HTTP response was lost before SQLite mirror.
  state.event.rsvps.push({ userId: 'ty_alice', status: 'staked', stakedUnits: '2000000' });
  const repaired = await request(`/hangouts/${hangoutId}/stake`, { method: 'POST', token: alice });
  assert.equal(repaired.status, 200);
  assert.equal(repaired.json.hangout.stake.iStaked, true);
  assert.equal(state.rsvpCalls, 0, 'remote durable RSVP was mirrored without a second debit');
  const repeated = await request(`/hangouts/${hangoutId}/stake`, { method: 'POST', token: alice });
  assert.equal(repeated.status, 200);
  assert.equal(state.rsvpCalls, 0);

  const bobStake = await request(`/hangouts/${hangoutId}/stake`, { method: 'POST', token: bob });
  assert.equal(bobStake.status, 200);
  assert.equal(state.rsvpCalls, 1);

  const tokenResponse = await request(`/hangouts/${hangoutId}/nfc-token`, { token: bob });
  const [, , , nfcToken] = tokenResponse.json.payload.split('|');
  const confirmed = await request(`/hangouts/${hangoutId}/confirm`, {
    method: 'POST', token: alice, body: { username: 'bob', token: nfcToken },
  });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(state.checkinCalls, ['alice', 'bob']);
  const confirmedAgain = await request(`/hangouts/${hangoutId}/confirm`, {
    method: 'POST', token: alice, body: { username: 'bob', token: 'no-longer-needed' },
  });
  assert.equal(confirmedAgain.status, 200);
  assert.deepEqual(state.checkinCalls, ['alice', 'bob', 'alice', 'bob']);

  // Settlement happens only through /end, which demands the photo as proof.
  const noProof = await request(`/hangouts/${hangoutId}/end`, { method: 'POST', token: alice });
  assert.equal(noProof.status, 400);
  const photoForm = new FormData();
  photoForm.append('photo', new Blob(['proof'], { type: 'image/jpeg' }), 'proof.jpg');
  const photographed = await request(`/hangouts/${hangoutId}/photo`, {
    method: 'POST', token: alice, body: photoForm,
  });
  assert.equal(photographed.status, 200);

  state.settlementMode = 'invalid';
  const invalidSettlement = await request(`/hangouts/${hangoutId}/end`, { method: 'POST', token: alice });
  assert.equal(invalidSettlement.status, 502);
  assert.equal(db.prepare('SELECT settled_at FROM hangouts WHERE id = ?').get(hangoutId).settled_at, null);
  assert.equal(
    db.prepare('SELECT COUNT(*) count FROM hangout_settlements WHERE hangout_id = ?').get(hangoutId).count,
    0,
  );

  state.settlementMode = 'valid';
  const settled = await request(`/hangouts/${hangoutId}/end`, { method: 'POST', token: alice });
  assert.equal(settled.status, 200);
  assert.equal(settled.json.hangout.stake.settled, true);
  assert.ok(settled.json.hangout.completedAt);
  assert.equal(
    db.prepare('SELECT COUNT(*) count FROM hangout_settlements WHERE hangout_id = ?').get(hangoutId).count,
    2,
  );
  const settledAgain = await request(`/hangouts/${hangoutId}/end`, { method: 'POST', token: alice });
  assert.equal(settledAgain.status, 200);

  const missingKey = await request('/wallet/withdraw', {
    method: 'POST', token: alice, body: { amountUnits: '20000000', destination: {} },
  });
  assert.equal(missingKey.status, 400);
  assert.equal(state.withdrawCalls.length, 0);

  const destination = {
    chain_type: 'ethereum', chain_id: '8453',
    token_address: '0x0000000000000000000000000000000000000001',
    recipient_address: '0x1111111111111111111111111111111111111111',
  };
  const key = 'withdraw:alice:stable-key-1';
  const pending = await request('/wallet/withdraw', {
    method: 'POST', token: alice,
    headers: { 'Idempotency-Key': key },
    body: { amountUnits: '20000000', destination },
  });
  assert.equal(pending.status, 202);
  assert.equal(pending.json.pending, true);
  assert.equal(state.withdrawCalls[0].key, key);

  state.withdrawMode = 'conflict';
  const conflict = await request('/wallet/withdraw', {
    method: 'POST', token: alice,
    headers: { 'Idempotency-Key': key },
    body: { amountUnits: '19000000', destination },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error, 'crypto_conflict');
});
