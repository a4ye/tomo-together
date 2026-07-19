// Backend tests. Unifold network calls are stubbed on the client singleton, so
// these run fully offline (no sk_live, no HTTP to api.unifold.io).
// Env (dummy keys + temp DATA_DIR + NODE_ENV=test) comes from test/.env.test.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import request from 'supertest';

import { app } from '../src/index.js';
import { unifold } from '../src/unifold.js';
import { registerUser, getUser } from '../src/store.js';
import { grant } from '../src/grant.js';
import { adjust } from '../src/adjust.js';
import { withdraw, pollWithdrawal, ValidationError } from '../src/withdraw.js';
import { createHangout, rsvp, checkin, settle } from '../src/events.js';
import { refreshDeposits } from '../src/deposits.js';

// ---- Stub the Unifold client (Stripe-style resource instances) ----
let createImpl: () => Promise<{ id: string; status: string }> = async () => ({
  id: 'ot_test',
  status: 'pending',
});
let retrieveStatus = 'pending';

let depositExecutions: Array<Record<string, unknown>> = [];

const u = unifold as any;
u.treasury.outboundTransfers.create = (_body: unknown, _opts: unknown) => createImpl();
u.treasury.outboundTransfers.retrieve = async (_id: string) => ({ status: retrieveStatus });
u.treasury.accounts.retrieve = async (_id: string) => ({
  address: '0xTREASURYADDR',
  chain_type: 'ethereum',
});
u.directExecutions.list = async (_params: unknown) => ({ data: depositExecutions });

beforeEach(() => {
  createImpl = async () => ({ id: 'ot_test', status: 'pending' });
  retrieveStatus = 'pending';
  depositExecutions = [];
});

let n = 0;
const uid = () => `u_${++n}`;

// Register a fresh user and return its id.
const newUser = () => {
  const id = uid();
  registerUser(id);
  return id;
};
// Register a fresh user funded with `units` of balance; return its id.
const funded = (units: string) => {
  const id = newUser();
  adjust(id, units);
  return id;
};
// Current balance (base units) for a user id.
const bal = (id: string) => getUser(id)!.balanceUnits;

const RECIPIENT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'; // valid EIP-55 checksum
const DEST = {
  chain_type: 'ethereum',
  chain_id: '8453',
  token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  recipient_address: RECIPIENT,
};

// ---------------------------------------------------------------------------

describe('grant — monthly, idempotent', () => {
  test('first grant credits 4 USDC; second same-month is a no-op', async () => {
    const id = newUser();

    const r1 = await grant(id);
    assert.equal(r1.alreadyGranted, false);
    assert.equal(r1.balanceUnits, '4000000');

    const r2 = await grant(id);
    assert.equal(r2.alreadyGranted, true);
    assert.equal(r2.balanceUnits, '4000000'); // not double-credited
  });
});

describe('adjust — external-input credit/debit, floored at 0', () => {
  test('credit adds to balance', () => {
    const id = newUser();
    const r = adjust(id, '4000000');
    assert.equal(r.balanceUnits, '4000000');
    assert.equal(r.appliedUnits, '4000000');
    assert.equal(r.clamped, false);
  });

  test('debit within balance subtracts', () => {
    const id = funded('4000000');
    const r = adjust(id, '-3000000');
    assert.equal(r.balanceUnits, '1000000');
    assert.equal(r.appliedUnits, '-3000000');
    assert.equal(r.clamped, false);
  });

  test('debit from zero clamps at 0 (no debt)', () => {
    const id = newUser();
    const r = adjust(id, '-1000000'); // can't go below 0
    assert.equal(r.balanceUnits, '0');
    assert.equal(r.appliedUnits, '0');
    assert.equal(r.clamped, true);
  });

  test('debit beyond balance clamps at 0 (never negative)', () => {
    const id = funded('4000000');
    const r = adjust(id, '-9000000'); // only $4 available
    assert.equal(r.balanceUnits, '0');
    assert.equal(r.appliedUnits, '-4000000');
    assert.equal(r.clamped, true);
  });

  test('reference makes an adjustment idempotent', () => {
    const id = newUser();
    const r1 = adjust(id, '4000000', '2026-07');
    assert.equal(r1.alreadyApplied, false);
    assert.equal(r1.balanceUnits, '4000000');

    const r2 = adjust(id, '4000000', '2026-07');
    assert.equal(r2.alreadyApplied, true);
    assert.equal(r2.balanceUnits, '4000000'); // not applied twice
  });
});

describe('withdraw — validation (no network)', () => {
  const isValidationError = (e: unknown) => e instanceof ValidationError;

  test('unknown user rejects', async () => {
    await assert.rejects(() => withdraw('nobody', '3000000', DEST), isValidationError);
  });

  test('below 3 USDC minimum rejects', async () => {
    const id = funded('4000000');
    await assert.rejects(() => withdraw(id, '1000000', DEST), isValidationError);
  });

  test('exceeding balance rejects', async () => {
    const id = funded('4000000');
    await assert.rejects(() => withdraw(id, '5000000', DEST), isValidationError);
  });

  test('non-integer amount rejects', async () => {
    const id = funded('4000000');
    await assert.rejects(() => withdraw(id, '3.5', DEST), isValidationError);
  });

  test('missing recipient rejects', async () => {
    const id = funded('4000000');
    await assert.rejects(
      () => withdraw(id, '3000000', { ...DEST, recipient_address: '' }),
      isValidationError,
    );
  });
});

describe('withdraw — success + poll/refund (stubbed Unifold)', () => {
  test('success deducts balance and records the transfer', async () => {
    const id = funded('4000000');

    const r = await withdraw(id, '4000000', DEST);
    assert.equal(r.transferId, 'ot_test');
    assert.equal(r.status, 'pending');
    assert.equal(r.balanceUnits, '0'); // full cash-out
    assert.equal(getUser(id)!.withdrawals.length, 1);
  });

  test('poll reports completed', async () => {
    const id = funded('4000000');
    const r = await withdraw(id, '4000000', DEST);

    retrieveStatus = 'completed';
    const p = await pollWithdrawal(r.withdrawalId);
    assert.equal(p.status, 'completed');
    assert.equal(p.balanceUnits, '0');
  });

  test('poll refunds the balance once on failure', async () => {
    const id = funded('4000000');
    const r = await withdraw(id, '4000000', DEST);
    assert.equal(bal(id), '0');

    retrieveStatus = 'failed';
    const p1 = await pollWithdrawal(r.withdrawalId);
    assert.equal(p1.status, 'failed');
    assert.equal(p1.balanceUnits, '4000000'); // refunded

    const p2 = await pollWithdrawal(r.withdrawalId);
    assert.equal(p2.balanceUnits, '4000000'); // not double-refunded
  });

  test('Unifold error does not deduct balance', async () => {
    const id = funded('4000000');
    createImpl = async () => {
      throw new Error('unifold boom');
    };
    await assert.rejects(() => withdraw(id, '4000000', DEST), /unifold boom/);
    assert.equal(bal(id), '4000000'); // unchanged
  });
});

describe('deposit credit (poll-based)', () => {
  test('credits a succeeded USDC-on-Base deposit, once', async () => {
    const id = newUser();
    depositExecutions = [
      {
        id: 'exec_1',
        status: 'succeeded',
        destination_chain_id: '8453',
        destination_amount_base_unit: '4000000', // $4 USDC
      },
    ];
    const r1 = await refreshDeposits(id);
    assert.equal(r1.creditedUnits, '4000000');
    assert.equal(bal(id), '4000000');

    // Polling again must NOT double-credit the same execution.
    const r2 = await refreshDeposits(id);
    assert.equal(r2.creditedUnits, '0');
    assert.equal(bal(id), '4000000');
  });

  test('ignores deposits on other chains', async () => {
    const id = newUser();
    depositExecutions = [
      { id: 'exec_2', status: 'succeeded', destination_chain_id: '1', destination_amount_base_unit: '9000000' },
    ];
    const r = await refreshDeposits(id);
    assert.equal(r.creditedUnits, '0');
    assert.equal(bal(id), '0');
  });
});

describe('webhooks (verified, real HMAC)', () => {
  const secret = process.env.UNIFOLD_WEBHOOK_SECRET!;
  // Sign exactly as Unifold does: HMAC-SHA256(secret, `${id}.${ts}.${body}`).
  const sign = (evId: string, payload: string) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', secret).update(`${evId}.${ts}.${payload}`).digest('hex');
    return { 'unifold-id': evId, 'unifold-timestamp': ts, 'unifold-signature': `v1,${sig}` };
  };

  test('valid deposit.completed webhook credits the balance (idempotent)', async () => {
    const id = newUser();
    const evId = `evt_dep_${id}`;
    const payload = JSON.stringify({
      id: evId,
      object: 'event',
      type: 'deposit.direct_execution.completed',
      created: 1737075600,
      livemode: true,
      data: {
        object: {
          id: `exec_${id}`,
          external_user_id: id,
          status: 'completed',
          amount: '4000000',
          details: { destination_chain_id: '8453', destination_token_symbol: 'USDC' },
        },
      },
    });
    const headers = sign(evId, payload);

    const r = await request(app)
      .post('/webhooks/unifold')
      .set('Content-Type', 'application/json')
      .set(headers)
      .send(payload);
    assert.equal(r.status, 200);
    assert.equal(bal(id), '4000000');

    // Replay the same event → same exec reference → no double credit.
    const r2 = await request(app)
      .post('/webhooks/unifold')
      .set('Content-Type', 'application/json')
      .set(headers)
      .send(payload);
    assert.equal(r2.status, 200);
    assert.equal(bal(id), '4000000');
  });

  test('bad signature is rejected (400)', async () => {
    const r = await request(app)
      .post('/webhooks/unifold')
      .set('Content-Type', 'application/json')
      .set({
        'unifold-id': 'evt_x',
        'unifold-timestamp': String(Math.floor(Date.now() / 1000)),
        'unifold-signature': 'v1,deadbeef',
      })
      .send(JSON.stringify({ type: 'deposit.direct_execution.completed', data: { object: {} } }));
    assert.equal(r.status, 400);
  });

  test('outbound_transfer.failed webhook refunds the withdrawal', async () => {
    const id = funded('5000000');
    createImpl = async () => ({ id: 'ot_wh_fail', status: 'pending' });
    await withdraw(id, '5000000', DEST);
    assert.equal(bal(id), '0');

    const evId = `evt_ot_${id}`;
    const payload = JSON.stringify({
      id: evId,
      type: 'treasury.outbound_transfer.failed',
      data: { object: { id: 'ot_wh_fail', external_user_id: id, status: 'failed', amount: '5000000' } },
    });
    const headers = sign(evId, payload);

    const r = await request(app)
      .post('/webhooks/unifold')
      .set('Content-Type', 'application/json')
      .set(headers)
      .send(payload);
    assert.equal(r.status, 200);
    assert.equal(bal(id), '5000000'); // refunded
  });
});

describe('flake-tax hangouts — staking + settlement', () => {
  test('RSVP stakes (debits balance)', () => {
    const host = funded('0');
    const u = funded('10000000'); // $10
    const ev = createHangout(host, 'Coffee', '4000000');
    rsvp(ev.id, u);
    assert.equal(bal(u), '6000000'); // $10 - $4 staked
  });

  test('can stake exactly your balance', () => {
    const host = funded('0');
    const u = funded('5000000'); // $5
    const ev = createHangout(host, 'Dinner', '5000000'); // $5 stake
    rsvp(ev.id, u);
    assert.equal(bal(u), '0');
  });

  test('cannot stake more than your balance (no debt)', () => {
    const host = funded('0');
    const u = funded('2000000'); // $2
    const ev = createHangout(host, 'Big night', '4000000'); // $4 stake
    assert.throws(() => rsvp(ev.id, u), (e) => e instanceof ValidationError);
  });

  test('flake tax: a no-show pays the friends who showed up', () => {
    const host = funded('0');
    const a = funded('3000000'); // each funded to exactly the stake
    const b = funded('3000000');
    const c = funded('3000000');
    const ev = createHangout(host, 'Hike', '3000000'); // $3 stake

    rsvp(ev.id, a);
    rsvp(ev.id, b);
    rsvp(ev.id, c);
    assert.equal(bal(a), '0'); // all staked

    checkin(ev.id, a); // A and B show up
    checkin(ev.id, b);
    // C flakes

    const r = settle(ev.id);
    assert.equal(r.forfeitPoolUnits, '3000000'); // C's stake
    // A and B each get their $3 back + half of C's $3 = $4.50
    assert.equal(bal(a), '4500000');
    assert.equal(bal(b), '4500000');
    assert.equal(bal(c), '0'); // C lost the stake
  });

  test('odd split distributes the remainder deterministically', () => {
    const host = funded('0');
    const a = funded('1000000');
    const b = funded('1000000');
    const c = funded('1000000');
    const d = funded('1000000');
    const ev = createHangout(host, 'Lunch', '1000000'); // $1 stake
    [a, b, c, d].forEach((u) => rsvp(ev.id, u));
    checkin(ev.id, a);
    checkin(ev.id, b);
    checkin(ev.id, c);
    // D flakes → pool = 1000000, split 3 ways = 333333 r1

    const r = settle(ev.id);
    assert.equal(r.forfeitPoolUnits, '1000000');
    // own 1000000 + share 333333, first attendee gets the +1 remainder
    assert.equal(bal(a), '1333334');
    assert.equal(bal(b), '1333333');
    assert.equal(bal(c), '1333333');
    assert.equal(bal(d), '0');
    // conservation: nothing created or destroyed
    const total = ['1333334', '1333333', '1333333', '0'].reduce((s, x) => s + BigInt(x), 0n);
    assert.equal(total.toString(), '4000000'); // == 4 stakes
  });

  test('everyone shows up: each just gets their stake back', () => {
    const host = funded('0');
    const a = funded('2000000');
    const b = funded('2000000');
    const ev = createHangout(host, 'Gym', '2000000');
    rsvp(ev.id, a);
    rsvp(ev.id, b);
    checkin(ev.id, a);
    checkin(ev.id, b);
    settle(ev.id);
    assert.equal(bal(a), '2000000');
    assert.equal(bal(b), '2000000');
  });

  test('nobody shows up: every stake is refunded', () => {
    const host = funded('0');
    const a = funded('2000000');
    const b = funded('2000000');
    const ev = createHangout(host, 'Ghosted', '2000000');
    rsvp(ev.id, a);
    rsvp(ev.id, b);
    // no check-ins
    settle(ev.id);
    assert.equal(bal(a), '2000000'); // refunded
    assert.equal(bal(b), '2000000');
  });

  test('holiday multiplier adds a treasury-funded bonus', () => {
    const host = funded('0');
    const a = funded('2000000');
    const c = funded('2000000');
    const ev = createHangout(host, 'NYE', '2000000', { multiplierBps: 15000 }); // 1.5x
    rsvp(ev.id, a);
    rsvp(ev.id, c);
    checkin(ev.id, a); // C flakes
    settle(ev.id);
    // base = own 2000000 + pool 2000000 = 4000000; bonus = 4000000 * 0.5 = 2000000
    assert.equal(bal(a), '6000000');
  });

  test('cannot RSVP twice, cannot settle twice', () => {
    const host = funded('0');
    const a = funded('4000000');
    const ev = createHangout(host, 'Dupe', '2000000');
    rsvp(ev.id, a);
    assert.throws(() => rsvp(ev.id, a), (e) => e instanceof ValidationError);
    checkin(ev.id, a);
    settle(ev.id);
    assert.throws(() => settle(ev.id), (e) => e instanceof ValidationError);
  });
});

describe('HTTP endpoints (supertest)', () => {
  const registerHttp = (id: string) => request(app).post('/users/register').send({ externalUserId: id });
  const adjustHttp = (id: string, deltaUnits: string) =>
    request(app).post('/adjust').send({ externalUserId: id, deltaUnits });
  const getUserHttp = (id: string) => request(app).get(`/users/${id}`);

  test('GET /health', async () => {
    const res = await request(app).get('/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  test('register → adjust → user reflects balance', async () => {
    const id = uid();
    await registerHttp(id).expect(200);

    const adj = await adjustHttp(id, '4000000');
    assert.equal(adj.status, 200);
    assert.equal(adj.body.balanceUnits, '4000000');

    const usr = await getUserHttp(id);
    assert.equal(usr.body.balanceUnits, '4000000');
  });

  test('POST /adjust rejects a non-integer delta (400)', async () => {
    const id = uid();
    await registerHttp(id);
    const res = await adjustHttp(id, '3.5');
    assert.equal(res.status, 400);
  });

  test('POST /adjust unknown user (404)', async () => {
    const res = await adjustHttp('ghost', '1');
    assert.equal(res.status, 404);
  });

  test('POST /withdraw below minimum (400)', async () => {
    const id = uid();
    await registerHttp(id);
    await adjustHttp(id, '4000000');
    const res = await request(app)
      .post('/withdraw')
      .send({ externalUserId: id, amountUnits: '1000000', destination: DEST });
    assert.equal(res.status, 400);
  });

  test('POST /withdraw success (stubbed) returns a transfer id', async () => {
    const id = uid();
    await registerHttp(id);
    await adjustHttp(id, '4000000');
    const res = await request(app)
      .post('/withdraw')
      .send({ externalUserId: id, amountUnits: '4000000', destination: DEST });
    assert.equal(res.status, 200);
    assert.equal(res.body.transferId, 'ot_test');
    assert.equal(res.body.balanceUnits, '0');
  });

  test('readyToCashOut flips at the +$20 threshold', async () => {
    const id = uid();
    await registerHttp(id);
    await adjustHttp(id, '19000000');
    let u = await getUserHttp(id);
    assert.equal(u.body.readyToCashOut, false);
    await adjustHttp(id, '1000000'); // → $20
    u = await getUserHttp(id);
    assert.equal(u.body.readyToCashOut, true);
  });

  test('GET /catalog flattens Unifold supported tokens (global fetch stubbed)', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              symbol: 'USDC',
              name: 'USD Coin',
              is_stablecoin: true,
              chains: [
                { chain_id: '8453', chain_name: 'Base', chain_type: 'ethereum', token_address: '0xbase' },
                { chain_id: '137', chain_name: 'Polygon', chain_type: 'ethereum', token_address: '0xpoly' },
              ],
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      const res = await request(app).get('/catalog');
      assert.equal(res.status, 200);
      assert.equal(res.body.destinations.length, 2);
      assert.equal(res.body.destinations[0].symbol, 'USDC');
      assert.equal(res.body.destinations[0].chain_name, 'Base');
      assert.equal(res.body.destinations[1].chain_id, '137');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('GET /treasury returns the stubbed treasury address', async () => {
    const res = await request(app).get('/treasury');
    assert.equal(res.status, 200);
    assert.equal(res.body.address, '0xTREASURYADDR');
  });

  test('POST /add-funds returns a deposit target (global fetch stubbed)', async () => {
    const id = uid();
    await registerHttp(id);

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ address: '0xDEPOSIT' }] }), {
        status: 200,
      })) as typeof fetch;
    try {
      const res = await request(app).post('/add-funds').send({ externalUserId: id });
      assert.equal(res.status, 200);
      assert.equal(res.body.treasuryAddress, '0xTREASURYADDR');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('flake-tax flow end-to-end over HTTP', async () => {
    const host = uid();
    const a = uid();
    const b = uid();
    for (const id of [host, a, b]) {
      await registerHttp(id);
    }
    // fund A and B with $3 each
    await adjustHttp(a, '3000000');
    await adjustHttp(b, '3000000');

    const ev = await request(app)
      .post('/events')
      .send({ host, title: 'Trivia', stakeUnits: '3000000' });
    assert.equal(ev.status, 200);
    const eventId = ev.body.event.id;

    await request(app).post(`/events/${eventId}/rsvp`).send({ userId: a }).expect(200);
    await request(app).post(`/events/${eventId}/rsvp`).send({ userId: b }).expect(200);
    await request(app).post(`/events/${eventId}/checkin`).send({ userId: a }).expect(200);
    // B flakes

    const settled = await request(app).post(`/events/${eventId}/settle`);
    assert.equal(settled.status, 200);
    assert.equal(settled.body.forfeitPoolUnits, '3000000');

    // A got their $3 back + B's $3 = $6; B lost their stake
    const usrA = await getUserHttp(a);
    const usrB = await getUserHttp(b);
    assert.equal(usrA.body.balanceUnits, '6000000');
    assert.equal(usrB.body.balanceUnits, '0');
  });
});
