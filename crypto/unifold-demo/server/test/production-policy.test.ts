import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RecurringGrantDisabledError,
  grant,
  recurringRealUsdcGrantsEnabled,
} from '../src/grant.js';
import { rawBalanceAdjustmentsEnabled } from '../src/adjust.js';
import { selectStoreBackend } from '../src/runtimeStore.js';
import {
  TreasuryEventBonusDisabledError,
  createHangout,
  treasuryEventBonusesEnabled,
} from '../src/events.js';

test('production selects only an explicit MongoDB backend', () => {
  assert.equal(
    selectStoreBackend({ NODE_ENV: 'production', CRYPTO_STORE_BACKEND: 'mongodb' }),
    'mongodb',
  );
  assert.throws(
    () => selectStoreBackend({ NODE_ENV: 'production', CRYPTO_STORE_BACKEND: 'json' }),
    /only when NODE_ENV is development or test|Production requires/,
  );
  assert.throws(
    () => selectStoreBackend({ NODE_ENV: 'production' }),
    /CRYPTO_STORE_BACKEND is required/,
  );
});

test('JSON storage requires an explicit local or test environment', () => {
  assert.equal(
    selectStoreBackend({ NODE_ENV: 'development', CRYPTO_STORE_BACKEND: 'json' }),
    'json',
  );
  assert.equal(
    selectStoreBackend({ NODE_ENV: 'test', CRYPTO_STORE_BACKEND: 'json' }),
    'json',
  );
  assert.throws(
    () => selectStoreBackend({ CRYPTO_STORE_BACKEND: 'json' }),
    /only when NODE_ENV is development or test/,
  );
});

test('production recurring grants require an exact true opt-in', () => {
  // An unset NODE_ENV is not sufficient evidence that a deployment is safe.
  assert.equal(recurringRealUsdcGrantsEnabled({}), false);
  assert.equal(recurringRealUsdcGrantsEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(
    recurringRealUsdcGrantsEnabled({
      NODE_ENV: 'production',
      ENABLE_RECURRING_REAL_USDC_GRANTS: 'TRUE',
    }),
    false,
  );
  assert.equal(
    recurringRealUsdcGrantsEnabled({
      NODE_ENV: 'production',
      ENABLE_RECURRING_REAL_USDC_GRANTS: 'true',
    }),
    true,
  );
  assert.equal(recurringRealUsdcGrantsEnabled({ NODE_ENV: 'test' }), true);
});

test('production raw balance adjustments require an exact true opt-in', () => {
  assert.equal(rawBalanceAdjustmentsEnabled({}), false);
  assert.equal(rawBalanceAdjustmentsEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(
    rawBalanceAdjustmentsEnabled({
      NODE_ENV: 'production',
      ENABLE_RAW_BALANCE_ADJUSTMENTS: '1',
    }),
    false,
  );
  assert.equal(
    rawBalanceAdjustmentsEnabled({
      NODE_ENV: 'production',
      ENABLE_RAW_BALANCE_ADJUSTMENTS: 'true',
    }),
    true,
  );
  assert.equal(rawBalanceAdjustmentsEnabled({ NODE_ENV: 'development' }), true);
});

test('production treasury-funded event bonuses require an exact true opt-in', () => {
  assert.equal(treasuryEventBonusesEnabled({}), false);
  assert.equal(treasuryEventBonusesEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(
    treasuryEventBonusesEnabled({
      NODE_ENV: 'production',
      ENABLE_TREASURY_FUNDED_EVENT_BONUSES: 'TRUE',
    }),
    false,
  );
  assert.equal(
    treasuryEventBonusesEnabled({
      NODE_ENV: 'production',
      ENABLE_TREASURY_FUNDED_EVENT_BONUSES: 'true',
    }),
    true,
  );
  assert.equal(treasuryEventBonusesEnabled({ NODE_ENV: 'test' }), true);
});

test('disabled production bonus fails before persistence access', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFlag = process.env.ENABLE_TREASURY_FUNDED_EVENT_BONUSES;
  process.env.NODE_ENV = 'production';
  delete process.env.ENABLE_TREASURY_FUNDED_EVENT_BONUSES;
  try {
    await assert.rejects(
      () => createHangout('missing-host', 'Bonus', '1000000', { multiplierBps: 15000 }),
      TreasuryEventBonusDisabledError,
    );
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousFlag === undefined) delete process.env.ENABLE_TREASURY_FUNDED_EVENT_BONUSES;
    else process.env.ENABLE_TREASURY_FUNDED_EVENT_BONUSES = previousFlag;
  }
});

test('disabled production grant fails before touching persistence', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousGrantFlag = process.env.ENABLE_RECURRING_REAL_USDC_GRANTS;
  process.env.NODE_ENV = 'production';
  delete process.env.ENABLE_RECURRING_REAL_USDC_GRANTS;
  try {
    await assert.rejects(() => grant('does-not-exist'), RecurringGrantDisabledError);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousGrantFlag === undefined) delete process.env.ENABLE_RECURRING_REAL_USDC_GRANTS;
    else process.env.ENABLE_RECURRING_REAL_USDC_GRANTS = previousGrantFlag;
  }
});
