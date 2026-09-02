// Port of custody/src/config.ts. The only structural change: a Worker has no
// module-load environment, so the constants become a per-request object derived
// from `env`. The validation, the defaults and the error strings are unchanged.
//
// Fail-closed note: on the App Service a missing/placeholder variable threw
// during startup and the port never bound, so nothing answered at all. A Worker
// cannot refuse to exist, so the same failure surfaces as a 500 on every route
// (including /health). That is the one behavioural difference in this file, and
// it only shows up in a misconfigured deployment.
import type { Env } from './env';

export interface Config {
  UNIFOLD_SECRET_KEY: string;
  TREASURY_ACCOUNT_ID: string;
  CRYPTO_SERVICE_TOKEN: string;
  TREASURY_SOURCE_CHAIN_ID: '8453' | '137';
  WEBHOOK_SECRET: string;
  GRANT_USDC_UNITS: string;
  CREDIT_LIMIT_UNITS: string;
  CASHOUT_THRESHOLD_UNITS: string;
  MIN_WITHDRAW_UNITS: string;
  CHAIN_ID: number;
  USDC_BASE_TOKEN_ADDRESS: string;
  UNIFOLD_LIVE_MODE: boolean;
  NODE_ENV: string | undefined;
}

function required(env: Env, name: keyof Env, placeholders: string[] = []): string {
  const v = env[name] as string | undefined;
  if (!v || v.trim() === '' || placeholders.includes(v.trim())) {
    throw new Error(
      `Missing or placeholder env var ${name}. Set it in the service environment (or server/.env locally).`,
    );
  }
  return v.trim();
}

export function validateServiceToken(value: string): string {
  const token = value.trim();
  if (token.length < 32) {
    throw new Error('CRYPTO_SERVICE_TOKEN must be at least 32 characters long.');
  }
  return token;
}

function unitsSetting(
  env: Env,
  name: 'CREDIT_LIMIT_UNITS' | 'CASHOUT_THRESHOLD_UNITS',
  fallback: string,
  positive = false,
): string {
  const configured = env[name];
  const value = configured === undefined ? fallback : configured.trim();
  if (
    !/^-?(0|[1-9]\d*)$/.test(value) ||
    value === '-0' ||
    value.replace('-', '').length > 34 ||
    (positive && BigInt(value) <= 0n)
  ) {
    throw new Error(
      `${name} must be ${positive ? 'a positive' : 'a canonical'} integer base-unit string of at most 34 digits`,
    );
  }
  return value;
}

function treasurySourceChainId(env: Env): '8453' | '137' {
  const value = env.TREASURY_SOURCE_CHAIN_ID?.trim() || '8453';
  if (value !== '8453' && value !== '137') {
    throw new Error('TREASURY_SOURCE_CHAIN_ID must be 8453 (Base) or 137 (Polygon)');
  }
  return value;
}

const cache = new WeakMap<Env, Config>();

export function config(env: Env): Config {
  const cached = cache.get(env);
  if (cached) return cached;

  const UNIFOLD_SECRET_KEY = required(env, 'UNIFOLD_SECRET_KEY', [
    'sk_live_replace_me',
    'sk_test_replace_me',
    'replace_me',
  ]);
  const CASHOUT_THRESHOLD_UNITS = unitsSetting(env, 'CASHOUT_THRESHOLD_UNITS', '3000000', true);
  const built: Config = {
    UNIFOLD_SECRET_KEY,
    TREASURY_ACCOUNT_ID: required(env, 'TREASURY_ACCOUNT_ID', ['ta_replace_me', 'replace_me']),
    CRYPTO_SERVICE_TOKEN: validateServiceToken(
      required(env, 'CRYPTO_SERVICE_TOKEN', ['replace_me', 'change_me']),
    ),
    TREASURY_SOURCE_CHAIN_ID: treasurySourceChainId(env),
    // When unset every Unifold webhook is rejected, so deposit credits and
    // withdrawal refunds rely on polling only. Live `ht6-tomoyard-crypto` has it
    // unset, which is why POST /webhooks/unifold always answers 400 there.
    WEBHOOK_SECRET: env.UNIFOLD_WEBHOOK_SECRET ?? '',
    GRANT_USDC_UNITS: '4000000', // 4 USDC
    CREDIT_LIMIT_UNITS: unitsSetting(env, 'CREDIT_LIMIT_UNITS', '0'),
    CASHOUT_THRESHOLD_UNITS,
    // Validation and the wallet's ready flag share one configurable product
    // minimum; it must stay at/above Unifold's outbound-transfer floor.
    MIN_WITHDRAW_UNITS: CASHOUT_THRESHOLD_UNITS,
    CHAIN_ID: 8453,
    USDC_BASE_TOKEN_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    UNIFOLD_LIVE_MODE: UNIFOLD_SECRET_KEY.startsWith('sk_live_'),
    NODE_ENV: env.NODE_ENV,
  };
  cache.set(env, built);
  return built;
}

const explicitlyNonProduction = (env: Env) =>
  env.NODE_ENV === 'development' || env.NODE_ENV === 'test';

/**
 * A public arbitrary credit/debit API can directly drain a real treasury, so
 * production keeps it closed unless the operator explicitly opts in.
 */
export const rawBalanceAdjustmentsEnabled = (env: Env): boolean =>
  explicitlyNonProduction(env) || env.ENABLE_RAW_BALANCE_ADJUSTMENTS === 'true';

/** Automatic real-USDC grants are a treasury-drain/Sybil primitive. */
export const recurringRealUsdcGrantsEnabled = (env: Env): boolean =>
  explicitlyNonProduction(env) || env.ENABLE_RECURRING_REAL_USDC_GRANTS === 'true';

/** The multiplier bonus is treasury-funded, so it is opt-in in production. */
export const treasuryEventBonusesEnabled = (env: Env): boolean =>
  explicitlyNonProduction(env) || env.ENABLE_TREASURY_FUNDED_EVENT_BONUSES === 'true';

/** Returns the current billing period as "YYYY-MM" in local time. */
export function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
