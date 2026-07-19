// Pure REST client config. No chain/RPC/wallet — everything money-related
// runs on Unifold's managed rails via the backend server.

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787';

// Unifold publishable key (pk_live_… / pk_test_…) for the client Deposit SDK.
export const UNIFOLD_PK = process.env.EXPO_PUBLIC_UNIFOLD_PK ?? '';

export const GRANT_LABEL = '4 USDC/mo';

// Unifold L2/Base minimum withdrawal, in USDC base units (6 decimals).
export const MIN_WITHDRAW_UNITS = 3000000;

// Net-settlement: winnings accrue in the ledger and only settle on-chain past the
// threshold (cuts transaction fees). No debt — you can only stake/spend what you have.
export const CASHOUT_THRESHOLD_UNITS = 20000000; // cash out once you're owed $20+

// Cross-chain destination presets for the outbound-transfer routing demo.
export type Destination = {
  label: string;
  chain_type: string;
  chain_id: string;
  token_address: string;
};

export const DESTINATIONS: Destination[] = [
  {
    label: 'USDC on Base',
    chain_type: 'ethereum',
    chain_id: '8453',
    token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  {
    label: 'USDC on Polygon',
    chain_type: 'ethereum',
    chain_id: '137',
    token_address: '0x3c499c542cEF5E3811e1192cE70d8cC03d5c3359',
  },
  {
    label: 'USDC on Arbitrum',
    chain_type: 'ethereum',
    chain_id: '42161',
    token_address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
];

// Format a USDC base-unit string (6 decimals) as a human dollar amount.
export function formatUsdc(units: string): string {
  return (Number(BigInt(units)) / 1e6).toFixed(2);
}

// Parse a human USDC amount into a base-unit string (6 decimals) — inverse of formatUsdc.
export function toUnits(usdc: string): string {
  return String(Math.round(parseFloat(usdc) * 1e6));
}

// Extract a human-readable message from a thrown value.
export function errMsg(e: any): string {
  return e?.message ?? String(e);
}
