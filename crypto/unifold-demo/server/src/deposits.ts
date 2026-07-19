// Poll-based deposit credit. After /add-funds hands the user a deposit address,
// they send USDC (e.g. from Coinbase, on Base). Unifold records the arrival as a
// "direct execution"; this polls those and credits the user's balance — no webhook
// / public URL needed. Crediting reuses adjust() with a per-execution reference,
// so it's idempotent (a deposit is never counted twice, no matter how often you poll).
import { unifold } from './unifold.js';
import { adjust } from './adjust.js';
import { getUser } from './store.js';
import { ValidationError } from './withdraw.js';
import { CHAIN_ID } from './config.js';

export async function refreshDeposits(externalUserId: string): Promise<{
  creditedUnits: string;
  newDeposits: Array<{ id: string; amountUnits: string }>;
  balanceUnits: string;
}> {
  const user = getUser(externalUserId);
  if (!user) throw new ValidationError('user not found');

  // Cast: this is an external poll; we only rely on a few documented fields.
  const list = (await (unifold as any).directExecutions.list({
    external_user_id: externalUserId,
    status: 'succeeded',
    limit: 50,
  })) as { data?: Array<Record<string, unknown>> };

  let creditedTotal = 0n;
  const newDeposits: Array<{ id: string; amountUnits: string }> = [];

  for (const ex of list.data ?? []) {
    // Only credit USDC-on-Base deposits — that's what /add-funds routes to.
    if (String(ex.destination_chain_id) !== String(CHAIN_ID)) continue;
    const amount = ex.destination_amount_base_unit;
    if (typeof amount !== 'string' || !/^[0-9]+$/.test(amount) || BigInt(amount) <= 0n) continue;

    const ref = `deposit:${String(ex.id)}`;
    const r = adjust(externalUserId, amount, ref); // idempotent via reference
    if (!r.alreadyApplied && BigInt(r.appliedUnits) > 0n) {
      creditedTotal += BigInt(r.appliedUnits);
      newDeposits.push({ id: String(ex.id), amountUnits: amount });
    }
  }

  return {
    creditedUnits: creditedTotal.toString(),
    newDeposits,
    balanceUnits: getUser(externalUserId)!.balanceUnits,
  };
}
