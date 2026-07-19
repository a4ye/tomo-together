// Environment configuration for the treasury-custody backend.
// All money is held in the project's Unifold TREASURY. No gas wallet, no RPC.

function required(name: string, placeholders: string[] = []): string {
  const v = process.env[name];
  if (!v || v.trim() === '' || placeholders.includes(v.trim())) {
    throw new Error(
      `Missing or placeholder env var ${name}. Set it in server/.env (copy from .env.example).`,
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

export const TREASURY_SOURCE_CHAIN_ID = process.env.TREASURY_SOURCE_CHAIN_ID ?? '8453';

// Optional signing secret for the Unifold webhook endpoint (whsec_…). When set,
// POST /webhooks/unifold verifies (HMAC-SHA256) and processes real-time events.
export const WEBHOOK_SECRET = process.env.UNIFOLD_WEBHOOK_SECRET ?? '';

// Money constants (USDC has 6 decimals).
export const GRANT_USDC_UNITS = '4000000'; // 4 USDC
export const MIN_WITHDRAW_UNITS = '3000000'; // 3 USDC (Unifold L2/Base minimum)

// Net-settlement: winnings accrue in the ledger and only settle on-chain past the
// threshold (batches transfers → fewer fees). No debt by default — you can only
// stake/spend what you actually have, so there's nothing to skip out on.
export const CREDIT_LIMIT_UNITS = process.env.CREDIT_LIMIT_UNITS ?? '0'; // floor at 0 (no debt)
export const CASHOUT_THRESHOLD_UNITS = process.env.CASHOUT_THRESHOLD_UNITS ?? '20000000'; // cash out once you're owed $20+

// Base mainnet chain id.
export const CHAIN_ID = 8453;
