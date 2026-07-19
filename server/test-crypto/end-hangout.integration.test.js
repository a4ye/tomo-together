'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { after, before, test } = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomoyard-end-hangout-'));
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

const clone = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  let markEntered;
  const entered = new Promise((resolveEntered) => { markEntered = resolveEntered; });
  return { promise, resolve, reject, entered, markEntered };
}

const state = {
  events: new Map(),
  checkinCalls: [],
  getEventCalls: [],
  settleCalls: [],
  checkinErrors: new Map(),
  checkinGates: new Map(),
};

function eventView(event) {
  return clone({ id: event.id, status: event.status, rsvps: event.rsvps });
}

const fakeCrypto = {
  CryptoError,
  CryptoUnavailableError,
  extId: (username) => `ty_${username}`,
  validIdempotencyKey: () => true,
  enabled: () => true,
  ready: async () => true,
  ensureUser: async () => {},
  createEvent: async () => ({ id: 'unused-create-event' }),
  getEvent: async (eventId) => {
    state.getEventCalls.push(eventId);
    const event = state.events.get(eventId);
    if (!event) throw new CryptoError(404, 'Event not found', 'crypto_not_found');
    return eventView(event);
  },
  rsvp: async () => {
    throw new Error('Unexpected RSVP in end-hangout test');
  },
  checkin: async (eventId, username) => {
    state.checkinCalls.push({ eventId, username });
    const key = `${eventId}:${username}`;
    const gate = state.checkinGates.get(key);
    if (gate) {
      gate.markEntered();
      await gate.promise;
    }
    const error = state.checkinErrors.get(key);
    if (error) throw error;
    const event = state.events.get(eventId);
    const rsvp = event && event.rsvps.find((entry) => entry.userId === `ty_${username}`);
    if (!rsvp) throw new CryptoError(400, 'User has not RSVP\'d', 'crypto_request_failed');
    rsvp.status = 'attended';
    return eventView(event);
  },
  settle: async (eventId) => {
    state.settleCalls.push(eventId);
    const event = state.events.get(eventId);
    if (!event) throw new CryptoError(404, 'Event not found', 'crypto_not_found');
    const behavior = event.settleBehaviors && event.settleBehaviors.shift();
    if (behavior) return behavior(event);
    event.status = 'settled';
    return clone(event.result);
  },
  getWallet: async () => ({ balanceUnits: '0', readyToCashOut: false, withdrawals: [] }),
  addFunds: async () => ({ ok: true }),
  refreshDeposits: async () => ({ ok: true, creditedUnits: '0' }),
  withdraw: async () => ({ status: 202, data: { pending: true } }),
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
const auth = new Map();

async function request(route, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* assertion output uses the raw status */ }
  return { status: response.status, json };
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
  auth.set(username, result.json.token);
}

function userId(username) {
  return db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
}

function settlementResult(eventId, stakeUnits, entries, forfeitPoolUnits) {
  return {
    eventId,
    status: 'settled',
    forfeitPoolUnits,
    results: entries.map(([username, status, payoutUnits]) => ({
      userId: `ty_${username}`,
      status,
      stakedUnits: stakeUnits,
      payoutUnits,
    })),
  };
}

function makeHangout({
  members = ['alice', 'bob'],
  date = new Date(Date.now() - 60_000).toISOString(),
  photo = 'proof.jpg',
  photoBy = 'alice',
  completedAt = null,
  stakeUnits = null,
  eventId = null,
  remoteStakers = members,
  result = null,
  eventStatus = 'open',
  settleBehaviors = [],
} = {}) {
  const creatorId = userId(members[0]);
  const photoById = photoBy == null ? null : userId(photoBy);
  const info = db.prepare(`INSERT INTO hangouts
    (creator_id, activity, activity_label, date, place, photo, photo_by,
      completed_at, created_at, stake_units, crypto_event_id)
    VALUES (?, 'ramen', 'Ramen', ?, 'Test cafe', ?, ?, ?, ?, ?, ?)`)
    .run(
      creatorId,
      date,
      photo,
      photoById,
      completedAt,
      new Date().toISOString(),
      stakeUnits,
      eventId,
    );
  const hangoutId = Number(info.lastInsertRowid);
  const insertMember = db.prepare('INSERT INTO hangout_members (hangout_id, user_id) VALUES (?, ?)');
  for (const username of members) insertMember.run(hangoutId, userId(username));

  if (eventId) {
    state.events.set(eventId, {
      id: eventId,
      status: eventStatus,
      rsvps: remoteStakers.map((username) => ({
        userId: `ty_${username}`,
        status: eventStatus === 'settled' && result
          ? result.results.find((entry) => entry.userId === `ty_${username}`).status
          : 'staked',
        stakedUnits: stakeUnits,
      })),
      result,
      settleBehaviors: [...settleBehaviors],
    });
  }
  return hangoutId;
}

function timestamps(hangoutId) {
  return db.prepare('SELECT settled_at, completed_at FROM hangouts WHERE id = ?').get(hangoutId);
}

function settlementRows(hangoutId) {
  return db.prepare(`SELECT u.username, hs.status, hs.payout_units
    FROM hangout_settlements hs JOIN users u ON u.id = hs.user_id
    WHERE hs.hangout_id = ? ORDER BY u.username`).all(hangoutId);
}

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const username of ['alice', 'bob', 'carol', 'dave', 'erin']) await register(username);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete require.cache[cryptoPath];
});

test('end requires authentication, membership, start time, and a photo', async () => {
  const futureId = makeHangout({ date: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await request(`/hangouts/${futureId}/end`, { method: 'POST' })).status, 401);
  assert.equal((await request(`/hangouts/${futureId}/end`, {
    method: 'POST', token: auth.get('erin'),
  })).status, 404);

  const tooEarly = await request(`/hangouts/${futureId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(tooEarly.status, 400);
  assert.equal(timestamps(futureId).completed_at, null);

  const noPhotoId = makeHangout({ photo: null, photoBy: null });
  const noPhoto = await request(`/hangouts/${noPhotoId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(noPhoto.status, 400);
  assert.equal(timestamps(noPhotoId).completed_at, null);
});

test('non-staked end is successful and already-ended retries are idempotent', async () => {
  const hangoutId = makeHangout();
  const ended = await request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('bob'),
  });
  assert.equal(ended.status, 200);
  assert.ok(ended.json.hangout.completedAt);
  const firstCompletedAt = ended.json.hangout.completedAt;

  const retried = await request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(retried.status, 200);
  assert.equal(retried.json.hangout.completedAt, firstCompletedAt);
  assert.equal(timestamps(hangoutId).settled_at, null);
});

test('attendance combines photo_by with both confirmation sides and check-ins are awaited', async () => {
  const eventId = 'end-attendance';
  const result = settlementResult(eventId, '300', [
    ['alice', 'attended', '400'],
    ['bob', 'attended', '400'],
    ['carol', 'attended', '400'],
    ['dave', 'flaked', '0'],
  ], '300');
  const hangoutId = makeHangout({
    members: ['alice', 'bob', 'carol', 'dave'],
    stakeUnits: '300',
    eventId,
    result,
  });
  db.prepare('INSERT INTO confirms (hangout_id, u1, u2, confirmed_at) VALUES (?, ?, ?, ?)')
    .run(hangoutId, userId('bob'), userId('carol'), new Date().toISOString());

  const gate = deferred();
  state.checkinGates.set(`${eventId}:bob`, gate);
  let requestFinished = false;
  const ending = request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('alice'),
  }).then((response) => {
    requestFinished = true;
    return response;
  });
  await gate.entered;
  assert.equal(requestFinished, false);
  assert.deepEqual(state.settleCalls.filter((id) => id === eventId), []);
  assert.equal(timestamps(hangoutId).completed_at, null);
  gate.resolve();

  const ended = await ending;
  assert.equal(ended.status, 200);
  assert.deepEqual(
    state.checkinCalls.filter((call) => call.eventId === eventId).map((call) => call.username),
    ['alice', 'bob', 'carol'],
  );
  assert.deepEqual(settlementRows(hangoutId), [
    { username: 'alice', status: 'attended', payout_units: '400' },
    { username: 'bob', status: 'attended', payout_units: '400' },
    { username: 'carol', status: 'attended', payout_units: '400' },
    { username: 'dave', status: 'flaked', payout_units: '0' },
  ]);
  assert.ok(timestamps(hangoutId).settled_at);
  assert.ok(timestamps(hangoutId).completed_at);
});

test('check-in and invalid remote settlement failures publish no completion state', async () => {
  const checkinEventId = 'end-checkin-failure';
  const checkinResult = settlementResult(checkinEventId, '100', [
    ['alice', 'attended', '200'],
    ['bob', 'flaked', '0'],
  ], '100');
  const checkinHangoutId = makeHangout({
    stakeUnits: '100', eventId: checkinEventId, result: checkinResult,
  });
  state.checkinErrors.set(
    `${checkinEventId}:alice`,
    new CryptoError(502, 'Check-in response was lost', 'crypto_upstream_failed'),
  );

  const checkinFailure = await request(`/hangouts/${checkinHangoutId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(checkinFailure.status, 502);
  assert.deepEqual(state.settleCalls.filter((id) => id === checkinEventId), []);
  assert.deepEqual(timestamps(checkinHangoutId), { settled_at: null, completed_at: null });
  assert.deepEqual(settlementRows(checkinHangoutId), []);

  const invalidEventId = 'end-invalid-settlement';
  const hangoutId = makeHangout({
    stakeUnits: '100',
    eventId: invalidEventId,
    result: settlementResult('wrong-event', '100', [
      ['alice', 'attended', '200'],
      ['bob', 'flaked', '0'],
    ], '100'),
  });
  db.prepare(`INSERT INTO hangout_settlements (hangout_id, user_id, status, payout_units)
    VALUES (?, ?, 'refunded', '77')`).run(hangoutId, userId('bob'));

  const invalid = await request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(invalid.status, 502);
  assert.deepEqual(timestamps(hangoutId), { settled_at: null, completed_at: null });
  assert.deepEqual(settlementRows(hangoutId), [
    { username: 'bob', status: 'refunded', payout_units: '77' },
  ]);
});

test('local mirror failure rolls back atomically and reconciles a remote-settled retry', async () => {
  const eventId = 'end-local-failure';
  const result = settlementResult(eventId, '100', [
    ['alice', 'attended', '200'],
    ['bob', 'flaked', '0'],
  ], '100');
  const hangoutId = makeHangout({ stakeUnits: '100', eventId, result });
  db.prepare(`INSERT INTO hangout_settlements (hangout_id, user_id, status, payout_units)
    VALUES (?, ?, 'refunded', '91')`).run(hangoutId, userId('bob'));
  const trigger = `fail_end_mirror_${hangoutId}`;
  db.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON hangout_settlements
    WHEN NEW.hangout_id = ${hangoutId}
    BEGIN SELECT RAISE(ABORT, 'forced local mirror failure'); END`);

  const failed = await request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(failed.status, 502);
  assert.deepEqual(timestamps(hangoutId), { settled_at: null, completed_at: null });
  assert.deepEqual(settlementRows(hangoutId), [
    { username: 'bob', status: 'refunded', payout_units: '91' },
  ]);
  assert.equal(state.events.get(eventId).status, 'settled');
  const checkinsBeforeRetry = state.checkinCalls.filter((call) => call.eventId === eventId).length;

  db.exec(`DROP TRIGGER ${trigger}`);
  const reconciled = await request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('bob'),
  });
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.json.hangout.stake.settled, true);
  assert.ok(timestamps(hangoutId).settled_at);
  assert.ok(timestamps(hangoutId).completed_at);
  assert.equal(
    state.checkinCalls.filter((call) => call.eventId === eventId).length,
    checkinsBeforeRetry,
    'a settled remote event must not receive another check-in',
  );
  assert.deepEqual(settlementRows(hangoutId), [
    { username: 'alice', status: 'attended', payout_units: '200' },
    { username: 'bob', status: 'flaked', payout_units: '0' },
  ]);

  const remoteCallsBeforeCompletedRetry = state.settleCalls.filter((id) => id === eventId).length;
  const alreadyEnded = await request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(alreadyEnded.status, 200);
  assert.equal(
    state.settleCalls.filter((id) => id === eventId).length,
    remoteCallsBeforeCompletedRetry,
  );
});

test('a lost settlement response is safe to reconcile on retry', async () => {
  const eventId = 'end-lost-response';
  const result = settlementResult(eventId, '100', [
    ['alice', 'attended', '200'],
    ['bob', 'flaked', '0'],
  ], '100');
  const loseFirstResponse = async (event) => {
    event.status = 'settled';
    throw new CryptoError(502, 'Settlement response was lost', 'crypto_upstream_failed');
  };
  const hangoutId = makeHangout({
    stakeUnits: '100', eventId, result, settleBehaviors: [loseFirstResponse],
  });

  const lost = await request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(lost.status, 502);
  assert.deepEqual(timestamps(hangoutId), { settled_at: null, completed_at: null });
  assert.deepEqual(settlementRows(hangoutId), []);
  const firstCheckins = state.checkinCalls.filter((call) => call.eventId === eventId).length;

  const retry = await request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.hangout.stake.settled, true);
  assert.equal(
    state.checkinCalls.filter((call) => call.eventId === eventId).length,
    firstCheckins,
  );
  assert.deepEqual(settlementRows(hangoutId), [
    { username: 'alice', status: 'attended', payout_units: '200' },
    { username: 'bob', status: 'flaked', payout_units: '0' },
  ]);
});
