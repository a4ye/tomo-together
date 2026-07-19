// Poll-based deposit credit. This is the fallback for delayed/missed webhooks.
// Every execution is bound to the same treasury/Base-USDC tuple as /add-funds,
// and every page is scanned so an older uncredited deposit cannot be stranded.
import type { DirectExecution } from '@unifold/node';
import { unifold } from './unifold.js';
import { adjust } from './adjust.js';
import { getStore } from './runtimeStore.js';
import { ValidationError, isPositiveIntString } from './withdraw.js';
import {
  CHAIN_ID,
  TREASURY_ACCOUNT_ID,
  USDC_BASE_TOKEN_ADDRESS,
} from './config.js';

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function ownedDeposit(
  execution: DirectExecution,
  treasuryAddress: string,
): boolean {
  return (
    execution.action_type === 'deposit' &&
    execution.status === 'succeeded' &&
    execution.destination_chain_type === 'ethereum' &&
    execution.destination_chain_id === String(CHAIN_ID) &&
    sameAddress(execution.destination_token_address, USDC_BASE_TOKEN_ADDRESS) &&
    sameAddress(execution.recipient_address, treasuryAddress)
  );
}

export async function refreshDeposits(externalUserId: string): Promise<{
  creditedUnits: string;
  newDeposits: Array<{ id: string; amountUnits: string }>;
  balanceUnits: string;
}> {
  const store = getStore();
  const user = await store.getUser(externalUserId);
  if (!user) throw new ValidationError('user not found');

  const treasury = await unifold.treasury.accounts.retrieve(TREASURY_ACCOUNT_ID);
  let creditedTotal = 0n;
  const newDeposits: Array<{ id: string; amountUnits: string }> = [];
  let startingAfter: string | undefined;

  for (;;) {
    const page = await unifold.directExecutions.list({
      external_user_id: externalUserId,
      action_type: 'deposit',
      status: 'succeeded',
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    for (const execution of page.data) {
      if (!ownedDeposit(execution, treasury.address)) continue;
      const amount = execution.destination_amount_base_unit;
      if (!isPositiveIntString(amount)) continue;
      if (typeof execution.id !== 'string' || execution.id.trim() === '') continue;

      const result = await adjust(
        externalUserId,
        amount,
        `deposit:${execution.id}`,
      );
      if (!result.alreadyApplied && BigInt(result.appliedUnits) > 0n) {
        creditedTotal += BigInt(result.appliedUnits);
        newDeposits.push({ id: execution.id, amountUnits: amount });
      }
    }

    if (!page.has_more) break;
    const nextCursor = page.data.at(-1)?.id;
    if (!nextCursor || nextCursor === startingAfter) {
      throw new Error('Unifold deposit pagination did not advance');
    }
    startingAfter = nextCursor;
  }

  const updated = await store.getUser(externalUserId);
  if (!updated) throw new ValidationError('user not found');

  return {
    creditedUnits: creditedTotal.toString(),
    newDeposits,
    balanceUnits: updated.balanceUnits,
  };
}
