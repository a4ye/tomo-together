// Environment configuration for the treasury-custody backend.
// All money is held in the project's Unifold TREASURY. No gas wallet, no RPC.

function required(name: string, placeholders: string[] = []): string {
  const v = process.env[name];
  if (!v || v.trim() === '' || placeholders.includes(v.trim())) {
    throw new Error(
      `Missing or placeholder env var ${name}. Set it in the service environment (or server/.env locally).`,
    );
  }
  return v.trim();
}

export const PORT = Number(process.env.PORT ?? '8787');

export const UNIFOLD_SECRET_KEY = required('UNIFOLD_SECRET_KEY', [
  'sk_live_replace_me',
  'sk_test_replace_me',
  'replace_me',
]);

export const TREASURY_ACCOUNT_ID = required('TREASURY_ACCOUNT_ID', [
  'ta_replace_me',
  'replace_me',
]);

// Shared secret used by the main API when calling this internal money service.
// This must never be exposed to the mobile client.
export function validateServiceToken(value: string): string {
  const token = value.trim();
  if (token.length < 32) {
    throw new Error('CRYPTO_SERVICE_TOKEN must be at least 32 characters long.');
  }
  return token;
}

export const CRYPTO_SERVICE_TOKEN = validateServiceToken(
  required('CRYPTO_SERVICE_TOKEN', ['replace_me', 'change_me']),
);

function treasurySourceChainId(): '8453' | '137' {
  const value = process.env.TREASURY_SOURCE_CHAIN_ID?.trim() || '8453';
  if (value !== '8453' && value !== '137') {
    throw new Error('TREASURY_SOURCE_CHAIN_ID must be 8453 (Base) or 137 (Polygon)');
  }
  return value;
}

export const TREASURY_SOURCE_CHAIN_ID = treasurySourceChainId();

// Optional signing secret for the Unifold webhook endpoint (whsec_…). When set,
// POST /webhooks/unifold verifies (HMAC-SHA256) and processes real-time events.
export const WEBHOOK_SECRET = process.env.UNIFOLD_WEBHOOK_SECRET ?? '';

// Money constants (USDC has 6 decimals).
export const GRANT_USDC_UNITS = '4000000'; // 4 USDC

// Net-settlement: winnings accrue in the ledger and only settle on-chain past the
// threshold (batches transfers → fewer fees). No debt by default — you can only
// stake/spend what you actually have, so there's nothing to skip out on.
function unitsSetting(name: string, fallback: string, positive = false): string {
  const configured = process.env[name];
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

export const CREDIT_LIMIT_UNITS = unitsSetting('CREDIT_LIMIT_UNITS', '0'); // floor at 0 (no debt)
export const CASHOUT_THRESHOLD_UNITS = unitsSetting(
  'CASHOUT_THRESHOLD_UNITS',
  '20000000',
  true,
); // cash out once you're owed $20+
// Validation and the wallet's ready flag intentionally share one configurable
// product minimum. Unifold's lower network floor does not bypass our batching.
export const MIN_WITHDRAW_UNITS = CASHOUT_THRESHOLD_UNITS;

// Base mainnet chain id.
export const CHAIN_ID = 8453;
export const USDC_BASE_TOKEN_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const UNIFOLD_LIVE_MODE = UNIFOLD_SECRET_KEY.startsWith('sk_live_');
