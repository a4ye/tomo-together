/// <reference types="@cloudflare/workers-types" />

/**
 * Bindings and settings for the treasury-custody Worker.
 *
 * These mirror the App Service settings of `ht6-tomoyard-crypto` exactly.
 * DATA_DIR and WEBSITES_ENABLE_APP_SERVICE_STORAGE are deliberately absent:
 * DATA_DIR only fed the JSON fallback store, and production forces
 * CRYPTO_STORE_BACKEND=mongodb, so no R2 bucket is needed here (SPEC 9.4).
 */
export interface Env {
  /** D1 replacement for MongoDB `ht6_crypto`. */
  DB: D1Database;

  /** Shared bearer required by every business route (wrangler secret). */
  CRYPTO_SERVICE_TOKEN: string;
  UNIFOLD_SECRET_KEY: string;
  TREASURY_ACCOUNT_ID: string;
  UNIFOLD_WEBHOOK_SECRET?: string;

  NODE_ENV?: string;
  /** 'mongodb' on Azure; 'd1' here. /ready reports this value verbatim. */
  CRYPTO_STORE_BACKEND?: string;
  TREASURY_SOURCE_CHAIN_ID?: string;
  ENABLE_RAW_BALANCE_ADJUSTMENTS?: string;
  ENABLE_RECURRING_REAL_USDC_GRANTS?: string;
  ENABLE_TREASURY_FUNDED_EVENT_BONUSES?: string;
  CREDIT_LIMIT_UNITS?: string;
  CASHOUT_THRESHOLD_UNITS?: string;
}
