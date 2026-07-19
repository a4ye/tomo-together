// One-time "add funds" (deposit) flow. Creates per-user Unifold deposit addresses
// that route incoming crypto into the project treasury, tagged with external_user_id.
// A webhook would then credit the user's balance on arrival.
//
// NOTE: wired against the real Unifold deposit-addresses endpoint but NOT tested —
// it's the "add funds is supported but doesn't have to be tested" path. Uses a raw
// fetch so it compiles regardless of the SDK's exact method surface.
import { UNIFOLD_SECRET_KEY, TREASURY_ACCOUNT_ID, CHAIN_ID } from './config.js';
import { unifold } from './unifold.js';

// Native Circle USDC on Base — the token deposits are converted into.
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export async function addFunds(externalUserId: string): Promise<{
  treasuryAddress: string;
  depositAddresses: unknown;
}> {
  // Deposits should land in the treasury (where the grant pool lives).
  const acct = await unifold.treasury.accounts.retrieve(TREASURY_ACCOUNT_ID);

  const res = await fetch('https://api.unifold.io/v1/deposit_addresses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${UNIFOLD_SECRET_KEY}`,
    },
    body: JSON.stringify({
      external_user_id: externalUserId,
      destination_chain_type: 'ethereum',
      destination_chain_id: String(CHAIN_ID),
      destination_token_address: USDC_BASE,
      recipient_address: acct.address,
      action_type: 'deposit',
    }),
  });

  if (!res.ok) {
    throw new Error(`deposit_addresses ${res.status}: ${await res.text().catch(() => '')}`);
  }

  const data = (await res.json()) as { data?: unknown };
  return { treasuryAddress: acct.address, depositAddresses: data.data ?? data };
}
