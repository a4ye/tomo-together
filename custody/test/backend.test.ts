// Backend tests. Unifold network calls are stubbed on the client singleton, so
// these run fully offline (no sk_live, no HTTP to api.unifold.io).
// Test-only env (dummy keys + temp DATA_DIR + NODE_ENV=test) is preloaded by
// test/setup-env.mjs; no real credentials or ignored local env file are needed.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import request from 'supertest';

import { app } from '../src/index.js';
import { unifold } from '../src/unifold.js';
import { closeStore, getStore, initializeStore } from '../src/runtimeStore.js';
import { grant } from '../src/grant.js';
import { adjust } from '../src/adjust.js';
import {
  withdraw,
  pollWithdrawal,
  ValidationError,
  WithdrawalPendingError,
} from '../src/withdraw.js';
import { createHangout, rsvp, checkin, settle } from '../src/events.js';
import { refreshDeposits } from '../src/deposits.js';
import {
  CRYPTO_SERVICE_TOKEN,
  MIN_WITHDRAW_UNITS,
  validateServiceToken,
} from '../src/config.js';

const api = {
  get: (path: string) =>
    request(app).get(path).set('Authorization', `Bearer ${CRYPTO_SERVICE_TOKEN}`),
  post: (path: string) =>
    request(app).post(path).set('Authorization', `Bearer ${CRYPTO_SERVICE_TOKEN}`),
};

before(async () => {
  await initializeStore();
});

after(async () => {
  await closeStore();
});

// ---- Stub the Unifold client (Stripe-style resource instances) ----
let createImpl: () => Promise<{ id: string; status: string }> = async () => ({
  id: 'ot_test',
  status: 'pending',
});
let retrieveStatus = 'pending';
let createCallCount = 0;
let lastProviderIdempotencyKey: string | undefined;

let depositExecutions: Array<Record<string, unknown>> = [];
let listDepositsImpl: (params: Record<string, unknown>) => Promise<{
  data: Array<Record<string, unknown>>;
  has_more: boolean;
  total_count: number;
}>;

const u = unifold as any;
u.treasury.outboundTransfers.create = (
  _body: unknown,
  opts: { idempotencyKey?: string },
) => {
  createCallCount += 1;
  lastProviderIdempotencyKey = opts?.idempotencyKey;
  return createImpl();
};
u.treasury.outboundTransfers.retrieve = async (_id: string) => ({ status: retrieveStatus });
u.treasury.accounts.retrieve = async (_id: string) => ({
  address: '0xTREASURYADDR',
  chain_type: 'ethereum',
});
u.directExecutions.list = (params: Record<string, unknown>) => listDepositsImpl(params);

beforeEach(() => {
  createImpl = async () => ({ id: 'ot_test', status: 'pending' });
  retrieveStatus = 'pending';
  createCallCount = 0;
  lastProviderIdempotencyKey = undefined;
  depositExecutions = [];
  listDepositsImpl = async () => ({
    data: depositExecutions,
    has_more: false,
    total_count: depositExecutions.length,
  });
});

let n = 0;
const uid = () => `u_${++n}`;

// Register a fresh user and return its id.
const newUser = async () => {
  const id = uid();
  await getStore().registerUser(id);
  return id;
};
// Register a fresh user funded with `units` of balance; return its id.
const funded = async (units: string) => {
  const id = await newUser();
  await adjust(id, units);
  return id;
};
// Current balance (base units) for a user id.
const bal = async (id: string) => (await getStore().getUser(id))!.balanceUnits;

const withdrawalKey = () => `wd_backend_${uid()}`;

const RECIPIENT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'; // valid EIP-55 checksum
const DEST = {
  chain_type: 'ethereum',
  chain_id: '8453',
  token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  recipient_address: RECIPIENT,
};

// ---------------------------------------------------------------------------

describe('service authentication configuration', () => {
  test('rejects short service tokens', () => {
    assert.throws(() => validateServiceToken('too-short'), /at least 32 characters/);
  });

  test('accepts and trims a sufficiently long service token', () => {
    const token = 'a'.repeat(32);
    assert.equal(validateServiceToken(`  ${token}  `), token);
  });
});

describe('grant — monthly, idempotent', () => {
  test('first grant credits 4 USDC; second same-month is a no-op', async () => {
    const id = await newUser();

    const r1 = await grant(id);
    assert.equal(r1.alreadyGranted, false);
    assert.equal(r1.balanceUnits, '4000000');

    const r2 = await grant(id);
    assert.equal(r2.alreadyGranted, true);
    assert.equal(r2.balanceUnits, '4000000'); // not double-credited
  });
});

describe('adjust — external-input credit/debit, floored at 0', () => {
  test('credit adds to balance', async () => {
    const id = await newUser();
    const r = await adjust(id, '4000000');
    assert.equal(r.balanceUnits, '4000000');
    assert.equal(r.appliedUnits, '4000000');
    assert.equal(r.clamped, false);
  });

  test('debit within balance subtracts', async () => {
    const id = await funded('4000000');
    const r = await adjust(id, '-3000000');
    assert.equal(r.balanceUnits, '1000000');
    assert.equal(r.appliedUnits, '-3000000');
    assert.equal(r.clamped, false);
  });

  test('debit from zero clamps at 0 (no debt)', async () => {
    const id = await newUser();
    const r = await adjust(id, '-1000000'); // can't go below 0
    assert.equal(r.balanceUnits, '0');
    assert.equal(r.appliedUnits, '0');
    assert.equal(r.clamped, true);
  });

  test('debit beyond balance clamps at 0 (never negative)', async () => {
    const id = await funded('4000000');
    const r = await adjust(id, '-9000000'); // only $4 available
    assert.equal(r.balanceUnits, '0');
    assert.equal(r.appliedUnits, '-4000000');
    assert.equal(r.clamped, true);
  });

  test('reference makes an adjustment idempotent', async () => {
    const id = await newUser();
    const r1 = await adjust(id, '4000000', '2026-07');
    assert.equal(r1.alreadyApplied, false);
    assert.equal(r1.balanceUnits, '4000000');

    const r2 = await adjust(id, '4000000', '2026-07');
    assert.equal(r2.alreadyApplied, true);
    assert.equal(r2.balanceUnits, '4000000'); // not applied twice
  });
});

describe('withdraw — validation (no network)', () => {
  const isValidationError = (e: unknown) => e instanceof ValidationError;

  test('unknown user rejects', async () => {
    await assert.rejects(
      () => withdraw('nobody', MIN_WITHDRAW_UNITS, DEST, withdrawalKey()),
      isValidationError,
    );
  });

  test('uses the configured $20 minimum', async () => {
    assert.equal(MIN_WITHDRAW_UNITS, '20000000');
    const id = await funded(MIN_WITHDRAW_UNITS);
    await assert.rejects(
      () => withdraw(id, '19999999', DEST, withdrawalKey()),
      (error: unknown) =>
        error instanceof ValidationError && error.message.includes(MIN_WITHDRAW_UNITS),
    );
  });

  test('exceeding balance rejects', async () => {
    const id = await funded(MIN_WITHDRAW_UNITS);
    await assert.rejects(
      () => withdraw(id, '21000000', DEST, withdrawalKey()),
      isValidationError,
    );
  });

  test('non-integer amount rejects', async () => {
    const id = await funded(MIN_WITHDRAW_UNITS);
    await assert.rejects(
      () => withdraw(id, '3.5', DEST, withdrawalKey()),
      isValidationError,
    );
  });

  test('missing recipient rejects', async () => {
    const id = await funded(MIN_WITHDRAW_UNITS);
    await assert.rejects(
      () =>
        withdraw(
          id,
          MIN_WITHDRAW_UNITS,
          { ...DEST, recipient_address: '' },
          withdrawalKey(),
        ),
      isValidationError,
    );
  });
});

describe('withdraw — success + poll/refund (stubbed Unifold)', () => {
  test('success deducts balance and records the transfer', async () => {
    const id = await funded(MIN_WITHDRAW_UNITS);
    const key = withdrawalKey();

    const r = await withdraw(id, MIN_WITHDRAW_UNITS, DEST, key);
    assert.equal(r.transferId, 'ot_test');
    assert.equal(r.status, 'pending');
    assert.equal(r.balanceUnits, '0'); // full cash-out
    assert.equal((await getStore().getUser(id))!.withdrawals.length, 1);
    assert.equal(lastProviderIdempotencyKey, key);
  });

  test('poll reports completed', async () => {
    const id = await funded(MIN_WITHDRAW_UNITS);
    const r = await withdraw(id, MIN_WITHDRAW_UNITS, DEST, withdrawalKey());

    retrieveStatus = 'completed';
    const p = await pollWithdrawal(r.withdrawalId);
    assert.equal(p.status, 'completed');
    assert.equal(p.balanceUnits, '0');
  });

  test('poll refunds the balance once on failure', async () => {
    const id = await funded(MIN_WITHDRAW_UNITS);
    const r = await withdraw(id, MIN_WITHDRAW_UNITS, DEST, withdrawalKey());
    assert.equal(await bal(id), '0');

    retrieveStatus = 'failed';
    const p1 = await pollWithdrawal(r.withdrawalId);
    assert.equal(p1.status, 'failed');
    assert.equal(p1.balanceUnits, MIN_WITHDRAW_UNITS); // refunded

    const p2 = await pollWithdrawal(r.withdrawalId);
    assert.equal(p2.balanceUnits, MIN_WITHDRAW_UNITS); // not double-refunded
  });

  test('ambiguous provider failure keeps the debit durable and same-key retry reconciles once', async () => {
    const id = await funded(MIN_WITHDRAW_UNITS);
    const key = withdrawalKey();
    createImpl = async () => {
      throw new Error('unifold boom');
    };
    await assert.rejects(
      () => withdraw(id, MIN_WITHDRAW_UNITS, DEST, key),
      (error: unknown) =>
        error instanceof WithdrawalPendingError && error.withdrawalId === key,
    );

    assert.equal(await bal(id), '0');
    assert.equal((await getStore().getUser(id))!.withdrawals.length, 1);
    const pending = await pollWithdrawal(key);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.transferId, null);
    assert.equal(pending.balanceUnits, '0');

    createImpl = async () => ({ id: 'ot_reconciled', status: 'pending' });
    const retried = await withdraw(id, MIN_WITHDRAW_UNITS, DEST, key);
    assert.equal(retried.transferId, 'ot_reconciled');
    assert.equal(retried.balanceUnits, '0');
    assert.equal(createCallCount, 2);
    assert.equal(lastProviderIdempotencyKey, key);

    const replayed = await withdraw(id, MIN_WITHDRAW_UNITS, DEST, key);
    assert.deepEqual(replayed, retried);
    assert.equal(createCallCount, 2);
    assert.equal((await getStore().getUser(id))!.withdrawals.length, 1);
  });
});

describe('deposit credit (poll-based)', () => {
  test('credits a succeeded USDC-on-Base deposit, once', async () => {
    const id = await newUser();
    depositExecutions = [
      {
        id: 'exec_1',
        action_type: 'deposit',
        status: 'succeeded',
        recipient_address: '0xTREASURYADDR',
        destination_chain_type: 'ethereum',
        destination_chain_id: '8453',
        destination_token_address: DEST.token_address,
        destination_amount_base_unit: '4000000', // $4 USDC
      },
    ];
    const r1 = await refreshDeposits(id);
    assert.equal(r1.creditedUnits, '4000000');
    assert.equal(await bal(id), '4000000');

    // Polling again must NOT double-credit the same execution.
    const r2 = await refreshDeposits(id);
    assert.equal(r2.creditedUnits, '0');
    assert.equal(await bal(id), '4000000');
  });

  test('ignores deposits on other chains', async () => {
    const id = await newUser();
    depositExecutions = [
      {
        id: 'exec_2',
        action_type: 'deposit',
        status: 'succeeded',
        recipient_address: '0xTREASURYADDR',
        destination_chain_type: 'ethereum',
        destination_chain_id: '1',
        destination_token_address: DEST.token_address,
        destination_amount_base_unit: '9000000',
      },
    ];
    const r = await refreshDeposits(id);
    assert.equal(r.creditedUnits, '0');
    assert.equal(await bal(id), '0');
  });

  test('ignores non-deposit and wrong-token executions even when provider filters regress', async () => {
    const id = await newUser();
    depositExecutions = [
      {
        id: 'exec_withdraw',
        action_type: 'withdraw',
        status: 'succeeded',
        recipient_address: '0xTREASURYADDR',
        destination_chain_type: 'ethereum',
        destination_chain_id: '8453',
        destination_token_address: DEST.token_address,
        destination_amount_base_unit: '4000000',
      },
      {
        id: 'exec_wrong_token',
        action_type: 'deposit',
        status: 'succeeded',
        recipient_address: '0xTREASURYADDR',
        destination_chain_type: 'ethereum',
        destination_chain_id: '8453',
        destination_token_address: '0x0000000000000000000000000000000000000001',
        destination_amount_base_unit: '4000000',
      },
    ];

    const result = await refreshDeposits(id);
    assert.equal(result.creditedUnits, '0');
    assert.equal(await bal(id), '0');
  });

  test('scans every deposit page with ownership filters applied', async () => {
    const id = await newUser();
    const execution = (executionId: string) => ({
      id: executionId,
      action_type: 'deposit',
      status: 'succeeded',
      recipient_address: '0xTREASURYADDR',
      destination_chain_type: 'ethereum',
      destination_chain_id: '8453',
      destination_token_address: DEST.token_address,
      destination_amount_base_unit: '1000000',
    });
    const requestedCursors: unknown[] = [];
    listDepositsImpl = async (params) => {
      assert.equal(params.external_user_id, id);
      assert.equal(params.action_type, 'deposit');
      assert.equal(params.status, 'succeeded');
      assert.equal(params.limit, 100);
      requestedCursors.push(params.starting_after);
      return params.starting_after
        ? { data: [execution('exec_page_2')], has_more: false, total_count: 2 }
        : { data: [execution('exec_page_1')], has_more: true, total_count: 2 };
    };

    const result = await refreshDeposits(id);

    assert.equal(result.creditedUnits, '2000000');
    assert.deepEqual(requestedCursors, [undefined, 'exec_page_1']);
    assert.equal(await bal(id), '2000000');
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
    const id = await newUser();
    const evId = `evt_dep_${id}`;
    const payload = JSON.stringify({
      id: evId,
      object: 'event',
      type: 'deposit.direct_execution.completed',
      created: 1737075600,
      livemode: false,
      data: {
        object: {
          id: `exec_${id}`,
          external_user_id: id,
          treasury_account_id: 'ta_test_not_a_real_account',
          status: 'completed',
          amount: '4000000',
          details: {
            destination_chain_type: 'ethereum',
            destination_chain_id: '8453',
            destination_token_address: DEST.token_address,
            destination_token_symbol: 'USDC',
            destination_amount: '4000000',
          },
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
    assert.equal(await bal(id), '4000000');

    // Replay the same event → same exec reference → no double credit.
    const r2 = await request(app)
      .post('/webhooks/unifold')
      .set('Content-Type', 'application/json')
      .set(headers)
      .send(payload);
    assert.equal(r2.status, 200);
    assert.equal(await bal(id), '4000000');
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

  test('a verified webhook gets a retryable response on datastore failure', async () => {
    const id = await newUser();
    const evId = `evt_retry_${id}`;
    const payload = JSON.stringify({
      id: evId,
      object: 'event',
      type: 'deposit.direct_execution.completed',
      created: 1737075600,
      livemode: false,
      data: {
        object: {
          id: `exec_retry_${id}`,
          external_user_id: id,
          treasury_account_id: 'ta_test_not_a_real_account',
          status: 'completed',
          amount: '4000000',
          details: {
            destination_chain_type: 'ethereum',
            destination_chain_id: '8453',
            destination_token_address: DEST.token_address,
            destination_amount: '4000000',
          },
        },
      },
    });
    const store = getStore();
    const originalGetUser = store.getUser;
    const originalConsoleError = console.error;
    store.getUser = async () => {
      throw new Error('Atlas temporarily unavailable');
    };
    console.error = () => {};
    try {
      const response = await request(app)
        .post('/webhooks/unifold')
        .set('Content-Type', 'application/json')
        .set(sign(evId, payload))
        .send(payload);
      assert.equal(response.status, 500);
      assert.deepEqual(response.body, {
        received: false,
        error: 'webhook processing failed; retry later',
      });
    } finally {
      store.getUser = originalGetUser;
      console.error = originalConsoleError;
    }
  });

  test('outbound_transfer.failed webhook refunds the withdrawal', async () => {
    const id = await funded(MIN_WITHDRAW_UNITS);
    createImpl = async () => ({ id: 'ot_wh_fail', status: 'pending' });
    await withdraw(id, MIN_WITHDRAW_UNITS, DEST, withdrawalKey());
    assert.equal(await bal(id), '0');

    const evId = `evt_ot_${id}`;
    const payload = JSON.stringify({
      id: evId,
      type: 'treasury.outbound_transfer.failed',
      livemode: false,
      data: {
        object: {
          id: 'ot_wh_fail',
          external_user_id: id,
          treasury_account_id: 'ta_test_not_a_real_account',
          status: 'failed',
          amount: MIN_WITHDRAW_UNITS,
          recipient_address: DEST.recipient_address,
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
    assert.equal(await bal(id), MIN_WITHDRAW_UNITS); // refunded
  });

  // ---- A5 acceptance: zero-amount events + webhook/poll convergence ----

  // Signed deposit.direct_execution.completed payload for one execution.
  const depositEvent = (
    evId: string,
    execId: string,
    userId: string,
    destinationAmount: string,
  ) =>
    JSON.stringify({
      id: evId,
      object: 'event',
      type: 'deposit.direct_execution.completed',
      created: 1737075600,
      livemode: false,
      data: {
        object: {
          id: execId,
          external_user_id: userId,
          treasury_account_id: 'ta_test_not_a_real_account',
          status: 'completed',
          amount: destinationAmount,
          details: {
            destination_chain_type: 'ethereum',
            destination_chain_id: '8453',
            destination_token_address: DEST.token_address,
            destination_token_symbol: 'USDC',
            destination_amount: destinationAmount,
          },
        },
      },
    });

  const postDepositWebhook = (
    evId: string,
    execId: string,
    userId: string,
    destinationAmount: string,
  ) => {
    const payload = depositEvent(evId, execId, userId, destinationAmount);
    return request(app)
      .post('/webhooks/unifold')
      .set('Content-Type', 'application/json')
      .set(sign(evId, payload))
      .send(payload);
  };

  // Poll-path execution record for the same execution id (owned deposit shape).
  const pollExecution = (execId: string, amountBaseUnits: string) => ({
    id: execId,
    action_type: 'deposit',
    status: 'succeeded',
    recipient_address: '0xTREASURYADDR',
    destination_chain_type: 'ethereum',
    destination_chain_id: '8453',
    destination_token_address: DEST.token_address,
    destination_amount_base_unit: amountBaseUnits,
  });

  test('zero-amount deposit webhook credits nothing and leaves the deposit reference unclaimed for a later valid webhook', async () => {
    const id = await newUser();
    const execId = `exec_zero_wh_${id}`;

    const zero = await postDepositWebhook(`evt_zero_${id}`, execId, id, '0');
    assert.equal(zero.status, 200);
    assert.equal(zero.body.handled, false);
    assert.equal(zero.body.reason, 'not_owned');
    assert.equal(await bal(id), '0'); // nothing credited

    // The rejected zero-amount event must not have claimed deposit:<execId>,
    // so a later valid webhook for the SAME execution still credits in full.
    const valid = await postDepositWebhook(`evt_zero_retry_${id}`, execId, id, '4000000');
    assert.equal(valid.status, 200);
    assert.equal(valid.body.handled, true);
    assert.equal(await bal(id), '4000000');
  });

  test('zero-amount deposit webhook does not block a later poll credit for the same execution', async () => {
    const id = await newUser();
    const execId = `exec_zero_poll_${id}`;

    const zero = await postDepositWebhook(`evt_zero_p_${id}`, execId, id, '0');
    assert.equal(zero.status, 200);
    assert.equal(zero.body.handled, false);
    assert.equal(await bal(id), '0');

    depositExecutions = [pollExecution(execId, '4000000')];
    const refreshed = await refreshDeposits(id);
    assert.equal(refreshed.creditedUnits, '4000000'); // full credit, reference was never poisoned
    assert.equal(await bal(id), '4000000');
  });

  test('webhook then poll converge on one execution id: credited exactly once', async () => {
    const id = await newUser();
    const execId = `exec_conv_wp_${id}`;

    const wh = await postDepositWebhook(`evt_conv_wp_${id}`, execId, id, '4000000');
    assert.equal(wh.status, 200);
    assert.equal(wh.body.handled, true);
    assert.equal(await bal(id), '4000000');

    depositExecutions = [pollExecution(execId, '4000000')];
    const refreshed = await refreshDeposits(id);
    assert.equal(refreshed.creditedUnits, '0'); // no-op via shared deposit:<execId> reference
    assert.equal(await bal(id), '4000000'); // not double-credited
  });

  test('poll then webhook converge on one execution id: credited exactly once', async () => {
    const id = await newUser();
    const execId = `exec_conv_pw_${id}`;

    depositExecutions = [pollExecution(execId, '5000000')];
    const refreshed = await refreshDeposits(id);
    assert.equal(refreshed.creditedUnits, '5000000');
    assert.equal(await bal(id), '5000000');

    const wh = await postDepositWebhook(`evt_conv_pw_${id}`, execId, id, '5000000');
    assert.equal(wh.status, 200);
    assert.equal(wh.body.handled, true); // idempotent replay via the shared reference
    assert.equal(await bal(id), '5000000'); // not double-credited
  });

  test('webhook and poll credit the same base-unit magnitude for the same raw amount', async () => {
    const webhookUser = await newUser();
    const pollUser = await newUser();
    const amount = '7250000'; // $7.25 USDC in base units

    const wh = await postDepositWebhook(
      `evt_mag_${webhookUser}`,
      `exec_mag_wh_${webhookUser}`,
      webhookUser,
      amount,
    );
    assert.equal(wh.status, 200);
    assert.equal(wh.body.handled, true);

    depositExecutions = [pollExecution(`exec_mag_poll_${pollUser}`, amount)];
    const refreshed = await refreshDeposits(pollUser);
    assert.equal(refreshed.creditedUnits, amount);

    // Webhook details.destination_amount and poll destination_amount_base_unit
    // carry the same base-unit integer string, so both paths credit identically.
    assert.equal(await bal(webhookUser), amount);
    assert.equal(await bal(pollUser), amount);
  });
});

describe('flake-tax hangouts — staking + settlement', () => {
  test('RSVP stakes (debits balance)', async () => {
    const host = await funded('0');
    const u = await funded('10000000'); // $10
    const ev = await createHangout(host, 'Coffee', '4000000');
    await rsvp(ev.id, u);
    assert.equal(await bal(u), '6000000'); // $10 - $4 staked
  });

  test('can stake exactly your balance', async () => {
    const host = await funded('0');
    const u = await funded('5000000'); // $5
    const ev = await createHangout(host, 'Dinner', '5000000'); // $5 stake
    await rsvp(ev.id, u);
    assert.equal(await bal(u), '0');
  });

  test('cannot stake more than your balance (no debt)', async () => {
    const host = await funded('0');
    const u = await funded('2000000'); // $2
    const ev = await createHangout(host, 'Big night', '4000000'); // $4 stake
    await assert.rejects(() => rsvp(ev.id, u), (e) => e instanceof ValidationError);
  });

  test('flake tax: a no-show pays the friends who showed up', async () => {
    const host = await funded('0');
    const a = await funded('3000000'); // each funded to exactly the stake
    const b = await funded('3000000');
    const c = await funded('3000000');
    const ev = await createHangout(host, 'Hike', '3000000'); // $3 stake

    await rsvp(ev.id, a);
    await rsvp(ev.id, b);
    await rsvp(ev.id, c);
    assert.equal(await bal(a), '0'); // all staked

    await checkin(ev.id, a); // A and B show up
    await checkin(ev.id, b);
    // C flakes

    const r = await settle(ev.id);
    assert.equal(r.forfeitPoolUnits, '3000000'); // C's stake
    // A and B each get their $3 back + half of C's $3 = $4.50
    assert.equal(await bal(a), '4500000');
    assert.equal(await bal(b), '4500000');
    assert.equal(await bal(c), '0'); // C lost the stake
  });

  test('odd split distributes the remainder deterministically', async () => {
    const host = await funded('0');
    const a = await funded('1000000');
    const b = await funded('1000000');
    const c = await funded('1000000');
    const d = await funded('1000000');
    const ev = await createHangout(host, 'Lunch', '1000000'); // $1 stake
    for (const userId of [a, b, c, d]) await rsvp(ev.id, userId);
    await checkin(ev.id, a);
    await checkin(ev.id, b);
    await checkin(ev.id, c);
    // D flakes → pool = 1000000, split 3 ways = 333333 r1

    const r = await settle(ev.id);
    assert.equal(r.forfeitPoolUnits, '1000000');
    // own 1000000 + share 333333, first attendee gets the +1 remainder
    assert.equal(await bal(a), '1333334');
    assert.equal(await bal(b), '1333333');
    assert.equal(await bal(c), '1333333');
    assert.equal(await bal(d), '0');
    // conservation: nothing created or destroyed
    const total = ['1333334', '1333333', '1333333', '0'].reduce((s, x) => s + BigInt(x), 0n);
    assert.equal(total.toString(), '4000000'); // == 4 stakes
  });

  test('everyone shows up: each just gets their stake back', async () => {
    const host = await funded('0');
    const a = await funded('2000000');
    const b = await funded('2000000');
    const ev = await createHangout(host, 'Gym', '2000000');
    await rsvp(ev.id, a);
    await rsvp(ev.id, b);
    await checkin(ev.id, a);
    await checkin(ev.id, b);
    await settle(ev.id);
    assert.equal(await bal(a), '2000000');
    assert.equal(await bal(b), '2000000');
  });

  test('nobody shows up: every stake is refunded', async () => {
    const host = await funded('0');
    const a = await funded('2000000');
    const b = await funded('2000000');
    const ev = await createHangout(host, 'Ghosted', '2000000');
    await rsvp(ev.id, a);
    await rsvp(ev.id, b);
    // no check-ins
    await settle(ev.id);
    assert.equal(await bal(a), '2000000'); // refunded
    assert.equal(await bal(b), '2000000');
  });

  test('holiday multiplier adds a treasury-funded bonus', async () => {
    const host = await funded('0');
    const a = await funded('2000000');
    const c = await funded('2000000');
    const ev = await createHangout(host, 'NYE', '2000000', { multiplierBps: 15000 }); // 1.5x
    await rsvp(ev.id, a);
    await rsvp(ev.id, c);
    await checkin(ev.id, a); // C flakes
    await settle(ev.id);
    // base = own 2000000 + pool 2000000 = 4000000; bonus = 4000000 * 0.5 = 2000000
    assert.equal(await bal(a), '6000000');
  });

  test('cannot RSVP twice; a second settlement is idempotent', async () => {
    const host = await funded('0');
    const a = await funded('4000000');
    const ev = await createHangout(host, 'Dupe', '2000000');
    await rsvp(ev.id, a);
    await assert.rejects(() => rsvp(ev.id, a), (e) => e instanceof ValidationError);
    await checkin(ev.id, a);
    const first = await settle(ev.id);
    const balanceAfterFirst = await bal(a);
    const second = await settle(ev.id);
    assert.deepEqual(second, first);
    assert.equal(await bal(a), balanceAfterFirst);
  });
});

describe('HTTP endpoints (supertest)', () => {
  const registerHttp = (id: string) => api.post('/users/register').send({ externalUserId: id });
  const adjustHttp = (id: string, deltaUnits: string) =>
    api.post('/adjust').send({ externalUserId: id, deltaUnits });
  const getUserHttp = (id: string) => api.get(`/users/${id}`);

  test('GET /health', async () => {
    const res = await request(app).get('/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  test('non-health routes reject missing, malformed, and incorrect credentials', async () => {
    const missing = await request(app).get('/treasury');
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.body, { ok: false, error: 'unauthorized' });
    assert.equal(missing.headers['www-authenticate'], 'Bearer');

    await request(app).get('/treasury').set('Authorization', 'Basic ignored').expect(401);
    await request(app).get('/treasury').set('Authorization', 'Bearer incorrect').expect(401);
    await request(app)
      .get('/treasury')
      .set('Authorization', `Bearer ${CRYPTO_SERVICE_TOKEN} trailing`)
      .expect(401);
  });

  test('every business route is protected and rejected mutations have no side effects', async () => {
    const rejectedUser = uid();
    const protectedRequests = [
      () => request(app).post('/users/register').send({ externalUserId: rejectedUser }),
      () => request(app).get('/users/nobody'),
      () => request(app).post('/grant').send({ externalUserId: 'nobody' }),
      () => request(app).post('/adjust').send({ externalUserId: 'nobody', deltaUnits: '1' }),
      () => request(app).post('/add-funds').send({ externalUserId: 'nobody' }),
      () => request(app).post('/deposits/refresh').send({ externalUserId: 'nobody' }),
      () => request(app).post('/withdraw').send({}),
      () => request(app).get('/withdrawals/missing'),
      () => request(app).get('/catalog'),
      () => request(app).get('/treasury'),
      () => request(app).post('/events').send({}),
      () => request(app).post('/events/missing/rsvp').send({}),
      () => request(app).post('/events/missing/checkin').send({}),
      () => request(app).post('/events/missing/settle'),
      () => request(app).get('/events/missing'),
      () => request(app).get('/users/nobody/events'),
    ];

    for (const makeRequest of protectedRequests) {
      await makeRequest().expect(401);
    }
    assert.equal(await getStore().getUser(rejectedUser), undefined);
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
    await adjustHttp(id, MIN_WITHDRAW_UNITS);
    const res = await api
      .post('/withdraw')
      .set('Idempotency-Key', withdrawalKey())
      .send({ externalUserId: id, amountUnits: '19999999', destination: DEST });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /20000000/);
  });

  test('POST /withdraw requires exactly one Idempotency-Key header', async () => {
    const id = uid();
    await registerHttp(id);
    await adjustHttp(id, MIN_WITHDRAW_UNITS);
    const res = await api
      .post('/withdraw')
      .send({ externalUserId: id, amountUnits: MIN_WITHDRAW_UNITS, destination: DEST });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'exactly one Idempotency-Key header is required');
    assert.equal((await getStore().getUser(id))!.withdrawals.length, 0);
    assert.equal(await bal(id), MIN_WITHDRAW_UNITS);
  });

  test('POST /withdraw success (stubbed) returns a transfer id', async () => {
    const id = uid();
    await registerHttp(id);
    await adjustHttp(id, MIN_WITHDRAW_UNITS);
    const key = withdrawalKey();
    const res = await api
      .post('/withdraw')
      .set('Idempotency-Key', key)
      .send({ externalUserId: id, amountUnits: MIN_WITHDRAW_UNITS, destination: DEST });
    assert.equal(res.status, 200);
    assert.equal(res.body.transferId, 'ot_test');
    assert.equal(res.body.balanceUnits, '0');
    assert.equal(lastProviderIdempotencyKey, key);
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
      const res = await api.get('/catalog');
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
    const res = await api.get('/treasury');
    assert.equal(res.status, 200);
    assert.equal(res.body.address, '0xTREASURYADDR');
  });

  test('POST /add-funds returns a deposit target (SDK stubbed)', async () => {
    const id = uid();
    await registerHttp(id);

    const origCreate = u.depositAddresses.create;
    u.depositAddresses.create = async () => ({ data: [{ address: '0xDEPOSIT' }] });
    try {
      const res = await api.post('/add-funds').send({ externalUserId: id });
      assert.equal(res.status, 200);
      assert.equal(res.body.treasuryAddress, '0xTREASURYADDR');
      assert.equal(res.body.depositAddresses[0].address, '0xDEPOSIT');
    } finally {
      u.depositAddresses.create = origCreate;
    }
  });

  test('deposit journey over HTTP: add-funds → on-chain arrival → refresh credits the balance', async () => {
    const id = uid();
    await registerHttp(id).expect(200);

    // Realistic multi-chain provisioning (Solana entry FIRST): the client
    // (DepositScreen) selects the entry with chain_type === 'ethereum'.
    const origCreate = u.depositAddresses.create;
    u.depositAddresses.create = async () => ({
      data: [
        { id: 'wallet_sol', chain_type: 'solana', address: 'So1anaDepositAddr11111111111111111111111111', is_primary: true, destination_chain_id: '8453' },
        { id: 'wallet_evm', chain_type: 'ethereum', address: '0x1111111111111111111111111111111111111111', is_primary: false, destination_chain_id: '8453' },
      ],
    });
    try {
      const res = await api.post('/add-funds').send({ externalUserId: id });
      assert.equal(res.status, 200);
      assert.equal(res.body.treasuryAddress, '0xTREASURYADDR');
      // The selection contract: an EVM address the client can pick IS present.
      assert.ok(
        res.body.depositAddresses.some(
          (a: { chain_type?: string; address?: string }) =>
            a.chain_type === 'ethereum' && a.address,
        ),
      );
    } finally {
      u.depositAddresses.create = origCreate;
    }

    // The user sends $4 USDC; Unifold reports one succeeded Base-USDC execution.
    depositExecutions = [
      {
        id: `exec_journey_${id}`,
        action_type: 'deposit',
        status: 'succeeded',
        recipient_address: '0xTREASURYADDR',
        destination_chain_type: 'ethereum',
        destination_chain_id: '8453',
        destination_token_address: DEST.token_address,
        destination_amount_base_unit: '4000000',
      },
    ];
    const refreshed = await api.post('/deposits/refresh').send({ externalUserId: id });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.creditedUnits, '4000000');

    const usr = await getUserHttp(id);
    assert.equal(usr.body.balanceUnits, '4000000');
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

    const ev = await api
      .post('/events')
      .send({ host, title: 'Trivia', stakeUnits: '3000000' });
    assert.equal(ev.status, 200);
    const eventId = ev.body.event.id;

    await api.post(`/events/${eventId}/rsvp`).send({ userId: a }).expect(200);
    await api.post(`/events/${eventId}/rsvp`).send({ userId: b }).expect(200);
    await api.post(`/events/${eventId}/checkin`).send({ userId: a }).expect(200);
    // B flakes

    const settled = await api.post(`/events/${eventId}/settle`);
    assert.equal(settled.status, 200);
    assert.equal(settled.body.forfeitPoolUnits, '3000000');

    // A got their $3 back + B's $3 = $6; B lost their stake
    const usrA = await getUserHttp(a);
    const usrB = await getUserHttp(b);
    assert.equal(usrA.body.balanceUnits, '6000000');
    assert.equal(usrB.body.balanceUnits, '0');
  });
});
