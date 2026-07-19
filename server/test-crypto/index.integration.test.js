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
  createEventOpts: null,
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
  createEvent: async (_host, _title, stakeUnits, opts = {}) => {
    if (!state.ready) throw new CryptoUnavailableError();
    state.createEventOpts = opts;
    // Mirror the custody service: treasury-funded event bonuses are gated off,
    // so any stake multiplier above 1x is rejected outright.
    if (opts.multiplierBps != null && opts.multiplierBps > 10000) {
      throw new CryptoError(403, 'treasury-funded event bonuses are disabled in production');
    }
    state.event = {
      id: 'event-1', status: 'open', stakeUnits, multiplierBps: opts.multiplierBps, rsvps: [],
    };
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
    // Mirror the custody split: attendees reclaim their stake plus an equal
    // share of the flakers' forfeits; with no attendees everyone is refunded.
    const attendeeCount = BigInt(state.event.rsvps.filter((e) => e.status === 'attended').length);
    const forfeitPool = attendeeCount === 0n
      ? 0n
      : BigInt(state.event.stakeUnits) * (BigInt(state.event.rsvps.length) - attendeeCount);
    const share = attendeeCount === 0n ? 0n : forfeitPool / attendeeCount;
    const remainder = attendeeCount === 0n ? 0n : forfeitPool % attendeeCount;
    let attendeeIndex = 0n;
    return {
      eventId: state.event.id,
      status: 'settled',
      forfeitPoolUnits: String(forfeitPool),
      results: state.event.rsvps.map((entry) => {
        const base = { userId: entry.userId, stakedUnits: entry.stakedUnits };
        if (attendeeCount === 0n) {
          return { ...base, status: 'refunded', payoutUnits: entry.stakedUnits };
        }
        if (entry.status !== 'attended') return { ...base, status: 'flaked', payoutUnits: '0' };
        const payout = BigInt(entry.stakedUnits) + share + (attendeeIndex < remainder ? 1n : 0n);
        attendeeIndex += 1n;
        return { ...base, status: 'attended', payoutUnits: String(payout) };
      }),
    };
  },
  getWallet: async () => ({
    balanceUnits: '20000000',
    readyToCashOut: true,
    cashoutThresholdUnits: '1000000',
    withdrawals: [],
  }),
  addFunds: async () => ({ ok: true }),
  refreshDeposits: async () => ({ ok: true, creditedUnits: '0' }),
  withdraw: async (_username, amountUnits, destination, key) => {
    state.withdrawCalls.push({ amountUnits, destination, key });
    if (state.withdrawMode === 'conflict') {
      throw new CryptoError(409, 'key belongs to a different withdrawal', 'crypto_conflict');
    }
    if (state.withdrawMode === 'success') {
      return {
        status: 200,
        data: {
          ok: true,
          withdrawalId: 'withdrawal-1',
          transferId: 'ot_x',
          status: 'completed',
          balanceUnits: '0',
        },
      };
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

// A holiday/birthday doubles acorns and vibe, never cashable USDC: the stake
// multiplier is clamped to 1x so payouts stay backed by real deposits and
// redistributed forfeits, and the custody treasury-bonus gate never trips.
test('a bonus-day staked hangout stakes at 1x USDC while acorns keep the 2x', async () => {
  const carol = await register('carol');
  const dave = await register('dave');
  assert.equal((await request('/friends/request', {
    method: 'POST', token: carol, body: { username: 'dave' },
  })).status, 200);
  assert.equal((await request('/friends/accept', {
    method: 'POST', token: dave, body: { username: 'carol' },
  })).status, 200);

  // The most recent Valentine's Day already in the past: a fixed-date holiday,
  // so bonusFor() reports mult 2 while the hangout is still endable.
  const today = new Date();
  let valentines = new Date(today.getFullYear(), 1, 14, 12, 0, 0);
  if (valentines.getTime() >= today.getTime()) {
    valentines = new Date(today.getFullYear() - 1, 1, 14, 12, 0, 0);
  }

  state.event = null;
  state.createEventOpts = null;
  state.rsvpCalls = 0;
  state.checkinCalls = [];
  state.settlementMode = 'valid';

  const created = await request('/hangouts', {
    method: 'POST', token: carol, body: {
      activity: 'ramen',
      date: valentines.toISOString(),
      place: 'Holiday cafe',
      friendUsernames: ['dave'],
      stakeUnits: '2000000',
    },
  });
  // Creation succeeds: the fake custody service, like the real one, throws for
  // any multiplierBps above 10000, and the clamp keeps us at exactly 1x.
  assert.equal(created.status, 200);
  const hangoutId = created.json.hangout.id;
  assert.equal(state.createEventOpts.multiplierBps, 10000);
  // The 2x is still stored locally; it drives acorns/vibe and the UI label.
  const stored = db.prepare('SELECT bonus_mult, bonus_reason FROM hangouts WHERE id = ?').get(hangoutId);
  assert.equal(stored.bonus_mult, 2);
  assert.equal(stored.bonus_reason, 'Valentines');

  assert.equal((await request(`/hangouts/${hangoutId}/stake`, { method: 'POST', token: carol })).status, 200);
  assert.equal((await request(`/hangouts/${hangoutId}/stake`, { method: 'POST', token: dave })).status, 200);

  // The confirmation still pays the doubled vibe on a bonus day.
  const tokenResponse = await request(`/hangouts/${hangoutId}/nfc-token`, { token: dave });
  const [, , , nfcToken] = tokenResponse.json.payload.split('|');
  const confirmed = await request(`/hangouts/${hangoutId}/confirm`, {
    method: 'POST', token: carol, body: { username: 'dave', token: nfcToken },
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.json.vibeGain, 30, 'vibe per confirm is 15, doubled on a bonus day');
  assert.equal(confirmed.json.bonusReason, 'Valentines');

  const photoForm = new FormData();
  photoForm.append('photo', new Blob(['proof'], { type: 'image/jpeg' }), 'proof.jpg');
  assert.equal((await request(`/hangouts/${hangoutId}/photo`, {
    method: 'POST', token: carol, body: photoForm,
  })).status, 200);

  // Settlement accepts the mirrored 1x multiplier and pays out exactly the
  // stake plus redistributed forfeits (none here) — no treasury-minted bonus.
  const settled = await request(`/hangouts/${hangoutId}/end`, { method: 'POST', token: carol });
  assert.equal(settled.status, 200);
  assert.equal(settled.json.hangout.stake.settled, true);
  const payouts = db.prepare(
    'SELECT payout_units FROM hangout_settlements WHERE hangout_id = ?').all(hangoutId);
  assert.deepEqual(payouts.map((row) => row.payout_units), ['2000000', '2000000']);
});

test('the wallet reports disabled without custody and passes custody fields through', async () => {
  const wally = await register('wally');

  state.ready = false;
  const disabled = await request('/wallet', { token: wally });
  assert.equal(disabled.status, 200);
  assert.deepEqual(disabled.json, { enabled: false });

  state.ready = true;
  const wallet = await request('/wallet', { token: wally });
  assert.equal(wallet.status, 200);
  assert.equal(wallet.json.enabled, true);
  assert.equal(wallet.json.balanceUnits, '20000000');
  assert.equal(wallet.json.readyToCashOut, true);
  assert.equal(wallet.json.cashoutThresholdUnits, '1000000');
});

test('a completed withdrawal returns 200 and forwards the Idempotency-Key', async () => {
  const wanda = await register('wanda');
  state.withdrawMode = 'success';
  state.withdrawCalls = [];

  const key = 'withdraw:wanda:stable-key-1';
  const done = await request('/wallet/withdraw', {
    method: 'POST', token: wanda,
    headers: { 'Idempotency-Key': key },
    body: {
      amountUnits: '20000000',
      destination: {
        chain_type: 'ethereum', chain_id: '8453',
        token_address: '0x0000000000000000000000000000000000000001',
        recipient_address: '0x1111111111111111111111111111111111111111',
      },
    },
  });
  assert.equal(done.status, 200);
  assert.equal(done.json.ok, true);
  assert.equal(done.json.status, 'completed');
  assert.equal(done.json.balanceUnits, '0');
  assert.equal(state.withdrawCalls.length, 1);
  assert.equal(state.withdrawCalls[0].key, key);
});

test('a flaker forfeits their stake to the friend who showed up', async () => {
  const erin = await register('erin');
  const frank = await register('frank');
  assert.equal((await request('/friends/request', {
    method: 'POST', token: erin, body: { username: 'frank' },
  })).status, 200);
  assert.equal((await request('/friends/accept', {
    method: 'POST', token: frank, body: { username: 'erin' },
  })).status, 200);

  state.event = null;
  state.rsvpCalls = 0;
  state.checkinCalls = [];
  state.settlementMode = 'valid';

  const created = await request('/hangouts', {
    method: 'POST', token: erin, body: {
      activity: 'ramen',
      date: new Date(Date.now() - 60_000).toISOString(),
      place: 'Test cafe',
      friendUsernames: ['frank'],
      stakeUnits: '2000000',
    },
  });
  assert.equal(created.status, 200);
  const hangoutId = created.json.hangout.id;
  assert.equal((await request(`/hangouts/${hangoutId}/stake`, { method: 'POST', token: erin })).status, 200);
  assert.equal((await request(`/hangouts/${hangoutId}/stake`, { method: 'POST', token: frank })).status, 200);

  // Only erin shows up: her photo is the sole attendance proof, no NFC taps.
  const photoForm = new FormData();
  photoForm.append('photo', new Blob(['proof'], { type: 'image/jpeg' }), 'proof.jpg');
  assert.equal((await request(`/hangouts/${hangoutId}/photo`, {
    method: 'POST', token: erin, body: photoForm,
  })).status, 200);

  const settled = await request(`/hangouts/${hangoutId}/end`, { method: 'POST', token: erin });
  assert.equal(settled.status, 200);
  assert.equal(settled.json.hangout.stake.settled, true);
  const members = settled.json.hangout.stake.members;
  const erinRow = members.find((m) => m.username === 'erin');
  const frankRow = members.find((m) => m.username === 'frank');
  assert.equal(erinRow.settleStatus, 'attended');
  assert.equal(erinRow.payoutUnits, '4000000', 'her stake plus frank\'s forfeited stake');
  assert.equal(frankRow.settleStatus, 'flaked');
  assert.equal(frankRow.payoutUnits, '0');
});
