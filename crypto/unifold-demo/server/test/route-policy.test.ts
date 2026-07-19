import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import request from 'supertest';
import { app } from '../src/index.js';
import {
  IdempotencyConflictError,
  WithdrawalPendingError,
} from '../src/withdraw.js';
import {
  closeStore,
  getStore,
  initializeStore,
} from '../src/runtimeStore.js';

const AUTHORIZATION =
  'Bearer test-only-crypto-service-token-0123456789abcdef';
const DESTINATION = {
  chain_type: 'ethereum',
  chain_id: '8453',
  token_address: '0x0000000000000000000000000000000000000001',
  recipient_address: '0x1111111111111111111111111111111111111111',
};

function api() {
  return request(app).post('/withdraw').set('Authorization', AUTHORIZATION);
}

before(async () => {
  await initializeStore();
});

after(async () => {
  await closeStore();
});

test('production recurring grant denial is an HTTP 403', async () => {
  const id = `grant-policy-${Date.now()}`;
  await getStore().registerUser(id);
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOptIn = process.env.ENABLE_RECURRING_REAL_USDC_GRANTS;
  process.env.NODE_ENV = 'production';
  delete process.env.ENABLE_RECURRING_REAL_USDC_GRANTS;
  try {
    const response = await request(app)
      .post('/grant')
      .set('Authorization', AUTHORIZATION)
      .send({ externalUserId: id });
    assert.equal(response.status, 403);
    assert.equal(response.body.ok, false);
    assert.match(response.body.error, /recurring real-USDC grants are disabled/);
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousOptIn === undefined) {
      delete process.env.ENABLE_RECURRING_REAL_USDC_GRANTS;
    } else {
      process.env.ENABLE_RECURRING_REAL_USDC_GRANTS = previousOptIn;
    }
  }
});

test('disabled production raw adjustment returns 403 before datastore access', async () => {
  const store = getStore();
  const originalGetUser = store.getUser;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOptIn = process.env.ENABLE_RAW_BALANCE_ADJUSTMENTS;
  store.getUser = async () => {
    throw new Error('datastore must not be called');
  };
  process.env.NODE_ENV = 'production';
  delete process.env.ENABLE_RAW_BALANCE_ADJUSTMENTS;
  try {
    const response = await request(app)
      .post('/adjust')
      .set('Authorization', AUTHORIZATION)
      .send({ externalUserId: 'nobody', deltaUnits: '1' });
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, {
      ok: false,
      error: 'raw balance adjustments are disabled',
    });
  } finally {
    store.getUser = originalGetUser;
    process.env.NODE_ENV = previousNodeEnv;
    if (previousOptIn === undefined) {
      delete process.env.ENABLE_RAW_BALANCE_ADJUSTMENTS;
    } else {
      process.env.ENABLE_RAW_BALANCE_ADJUSTMENTS = previousOptIn;
    }
  }
});

test('disabled production event bonus returns 403', async () => {
  const host = `bonus-policy-${Date.now()}`;
  await getStore().registerUser(host);
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOptIn = process.env.ENABLE_TREASURY_FUNDED_EVENT_BONUSES;
  process.env.NODE_ENV = 'production';
  delete process.env.ENABLE_TREASURY_FUNDED_EVENT_BONUSES;
  try {
    const response = await request(app)
      .post('/events')
      .set('Authorization', AUTHORIZATION)
      .send({ host, title: 'Bonus', stakeUnits: '1000000', multiplierBps: 15000 });
    assert.equal(response.status, 403);
    assert.match(response.body.error, /treasury-funded event bonuses are disabled/);
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousOptIn === undefined) {
      delete process.env.ENABLE_TREASURY_FUNDED_EVENT_BONUSES;
    } else {
      process.env.ENABLE_TREASURY_FUNDED_EVENT_BONUSES = previousOptIn;
    }
  }
});

test('withdraw requires exactly one valid Idempotency-Key', async () => {
  const body = {
    externalUserId: 'nobody',
    amountUnits: '20000000',
    destination: DESTINATION,
  };

  const missing = await api().send(body);
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /exactly one Idempotency-Key/);

  const invalid = await api().set('Idempotency-Key', 'bad key').send(body);
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /Idempotency-Key must be/);
});

test('withdraw maps idempotency conflict and pending reconciliation states', async () => {
  const store = getStore();
  const originalGetWithdrawal = store.getWithdrawal;
  const body = {
    externalUserId: 'nobody',
    amountUnits: '20000000',
    destination: DESTINATION,
  };
  try {
    store.getWithdrawal = async () => {
      throw new IdempotencyConflictError();
    };
    const conflict = await api()
      .set('Idempotency-Key', 'withdraw-conflict-1')
      .send(body);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.ok, false);
    assert.match(conflict.body.error, /different withdrawal/);

    store.getWithdrawal = async () => {
      throw new WithdrawalPendingError('withdraw-pending-1');
    };
    const pending = await api()
      .set('Idempotency-Key', 'withdraw-pending-1')
      .send(body);
    assert.equal(pending.status, 202);
    assert.deepEqual(pending.body, {
      ok: false,
      pending: true,
      withdrawalId: 'withdraw-pending-1',
      error: 'withdrawal is pending reconciliation; retry with the same Idempotency-Key',
    });
  } finally {
    store.getWithdrawal = originalGetWithdrawal;
  }
});

test('rejected async datastore operation returns 500 instead of hanging', async () => {
  const store = getStore();
  const originalGetUser = store.getUser;
  const originalConsoleError = console.error;
  store.getUser = async () => {
    throw new Error('synthetic datastore rejection');
  };
  console.error = () => {};
  try {
    const response = await request(app)
      .get('/users/error-path')
      .set('Authorization', AUTHORIZATION)
      .timeout({ response: 1_000, deadline: 2_000 });
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      ok: false,
      error: 'synthetic datastore rejection',
    });
  } finally {
    store.getUser = originalGetUser;
    console.error = originalConsoleError;
  }
});
