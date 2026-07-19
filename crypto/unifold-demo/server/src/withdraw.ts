// Treasury outbound transfers. "Withdraw" = Unifold routes cross-chain and pays the gas.
import { randomUUID } from 'node:crypto';
import { MIN_WITHDRAW_UNITS, TREASURY_ACCOUNT_ID } from './config.js';
import { unifold } from './unifold.js';
import { withUserLock } from './locks.js';
import {
  getUser,
  debitBalance,
  creditBalance,
  addWithdrawal,
  updateWithdrawal,
  getWithdrawal,
  type Destination,
} from './store.js';

// Validation errors are mapped to HTTP 400 by index.ts.
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// Positive-integer base-unit string guard. Shared with events.ts.
export function isPositiveIntString(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9]+$/.test(s) && BigInt(s) > 0n;
}

export async function withdraw(
  externalUserId: string,
  amountUnits: string,
  destination: Destination,
): Promise<{
  withdrawalId: string;
  transferId: string;
  status: string;
  balanceUnits: string;
}> {
  // Serialize the whole validate -> debit -> transfer body per user so two
  // concurrent withdraws can't both pass the balance check and double-spend.
  return withUserLock(externalUserId, async () => {
    const user = getUser(externalUserId);
    if (!user) {
      throw new ValidationError('user not found');
    }

    if (typeof amountUnits !== 'string' || !isPositiveIntString(amountUnits)) {
      throw new ValidationError('amountUnits must be a positive integer string');
    }
    if (BigInt(amountUnits) < BigInt(MIN_WITHDRAW_UNITS)) {
      throw new ValidationError(
        `amountUnits must be >= ${MIN_WITHDRAW_UNITS} (3 USDC minimum)`,
      );
    }
    if (BigInt(amountUnits) > BigInt(user.balanceUnits)) {
      throw new ValidationError('amountUnits exceeds available balance');
    }
    if (
      !destination ||
      typeof destination.recipient_address !== 'string' ||
      destination.recipient_address.trim() === ''
    ) {
      throw new ValidationError('recipient_address is required');
    }

    // Random id doubles as the Unifold idempotencyKey — concurrent/retried
    // withdraws never collide (match events.ts: `wd_${randomUUID()}`).
    const withdrawalId = `wd_${randomUUID()}`;

    // Debit BEFORE the transfer so a crash can't leave a sent transfer un-debited.
    debitBalance(externalUserId, amountUnits);

    let t;
    try {
      t = await unifold.treasury.outboundTransfers.create(
        {
          source: {
            treasury_account_id: TREASURY_ACCOUNT_ID,
            currency: 'usdc',
            chain_id: '8453' as '8453' | '137',
          },
          destination,
          amount: amountUnits,
          external_user_id: externalUserId,
        },
        { idempotencyKey: withdrawalId },
      );
    } catch (err) {
      // Unifold error -> HTTP 500, balance NOT deducted: roll back and rethrow.
      creditBalance(externalUserId, amountUnits);
      throw err;
    }

    addWithdrawal(externalUserId, {
      id: withdrawalId,
      transferId: t.id,
      amountUnits,
      destination,
      status: t.status,
      refunded: false,
      createdAt: new Date().toISOString(),
    });

    return {
      withdrawalId,
      transferId: t.id,
      status: t.status,
      balanceUnits: getUser(externalUserId)!.balanceUnits,
    };
  });
}

export async function pollWithdrawal(withdrawalId: string): Promise<{
  withdrawalId: string;
  transferId: string;
  status: string;
  amountUnits: string;
  destination: Destination;
  balanceUnits: string;
}> {
  const found = getWithdrawal(withdrawalId);
  if (!found) {
    throw new ValidationError('withdrawal not found');
  }
  const { user, withdrawal } = found;

  const t = await unifold.treasury.outboundTransfers.retrieve(withdrawal.transferId);

  if (t.status === 'failed' && !withdrawal.refunded) {
    creditBalance(user.externalUserId, withdrawal.amountUnits);
    updateWithdrawal(withdrawalId, { refunded: true });
  }
  updateWithdrawal(withdrawalId, { status: t.status });

  return {
    withdrawalId,
    transferId: withdrawal.transferId,
    status: t.status,
    amountUnits: withdrawal.amountUnits,
    destination: withdrawal.destination,
    balanceUnits: getUser(user.externalUserId)!.balanceUnits,
  };
}
