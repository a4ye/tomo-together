// Port of custody/src/withdraw.ts. Treasury outbound transfers: "withdraw" =
// Unifold routes cross-chain and pays the gas.
import type { Env } from '../env';
import { config } from '../config';
import { StoreConflictError, type D1Store, type Destination, type User, type Withdrawal } from '../store/d1Store';
import { unifoldClient } from '../unifold/client';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor(message = 'Idempotency-Key was already used with a different withdrawal') {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * The ledger debit is safely reserved, but the provider result is not yet
 * authoritative. The caller must retry with the same Idempotency-Key.
 */
export class WithdrawalPendingError extends Error {
  readonly withdrawalId: string;
  constructor(withdrawalId: string, cause?: unknown) {
    super('withdrawal is pending reconciliation; retry with the same Idempotency-Key', { cause });
    this.name = 'WithdrawalPendingError';
    this.withdrawalId = withdrawalId;
  }
}

/** Positive-integer base-unit string guard. Shared with events.ts. */
export function isPositiveIntString(s: unknown): s is string {
  return typeof s === 'string' && /^(0|[1-9]\d*)$/.test(s) && s.length <= 34 && BigInt(s) > 0n;
}

/** Keeps keys log-safe, header-safe, and within common provider limits. */
export function validateIdempotencyKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 8 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new ValidationError(
      'Idempotency-Key must be 8-128 characters using letters, numbers, dot, underscore, colon, or hyphen',
    );
  }
  return value;
}

function validateDestination(destination: Destination): void {
  for (const field of ['chain_type', 'chain_id', 'token_address', 'recipient_address'] as const) {
    if (typeof destination?.[field] !== 'string' || destination[field].trim() === '') {
      throw new ValidationError(`${field} is required`);
    }
  }
}

const sameDestination = (left: Destination, right: Destination): boolean =>
  left.chain_type === right.chain_type &&
  left.chain_id === right.chain_id &&
  left.token_address === right.token_address &&
  left.recipient_address === right.recipient_address;

export async function withdraw(
  env: Env,
  store: D1Store,
  externalUserId: string,
  amountUnits: string,
  destination: Destination,
  idempotencyKey: string,
): Promise<{ withdrawalId: string; transferId: string; status: string; balanceUnits: string }> {
  const cfg = config(env);
  const outboundTransfers: any = unifoldClient(cfg.UNIFOLD_SECRET_KEY).treasury.outboundTransfers;

  const operationId = validateIdempotencyKey(idempotencyKey);
  if (typeof amountUnits !== 'string' || !isPositiveIntString(amountUnits)) {
    throw new ValidationError('amountUnits must be a positive integer string');
  }
  validateDestination(destination);

  let reservation: {
    created: boolean;
    withdrawalId: string;
    transferId: string | null;
    status: string;
    amountUnits: string;
    balanceUnits: string;
  };
  const existing = await store.getWithdrawal(operationId);
  if (existing) {
    // Existing operations bypass today's balance/minimum checks: the debit may
    // already have happened and configuration may have changed since attempt 1.
    if (
      existing.user.externalUserId !== externalUserId ||
      existing.withdrawal.amountUnits !== amountUnits ||
      !sameDestination(existing.withdrawal.destination, destination)
    ) {
      throw new IdempotencyConflictError();
    }
    reservation = {
      created: false,
      withdrawalId: existing.withdrawal.id,
      transferId: existing.withdrawal.transferId || null,
      status: existing.withdrawal.status,
      amountUnits: existing.withdrawal.amountUnits,
      balanceUnits: existing.user.balanceUnits,
    };
  } else {
    const user = await store.getUser(externalUserId);
    if (!user) throw new ValidationError('user not found');
    if (BigInt(amountUnits) < BigInt(cfg.MIN_WITHDRAW_UNITS)) {
      throw new ValidationError(
        `amountUnits must be >= ${cfg.MIN_WITHDRAW_UNITS} (${Number(cfg.MIN_WITHDRAW_UNITS) / 1e6} USDC minimum)`,
      );
    }
    try {
      reservation = await store.reserveWithdrawal(externalUserId, operationId, amountUnits, destination);
    } catch (error) {
      if (error instanceof StoreConflictError) throw new IdempotencyConflictError();
      if (error instanceof Error && error.message === 'debitBalance would drive balance below 0') {
        throw new ValidationError('amountUnits exceeds available balance');
      }
      throw error;
    }
  }

  // A completed first request may have lost its HTTP response. Never submit a
  // second provider operation once its transfer id has been durably attached.
  if (reservation.transferId) {
    // A process can stop after attaching a provider's terminal failure but
    // before the compensating ledger refund; replaying the same key must finish
    // that durable transition exactly once.
    if (reservation.status === 'failed') {
      const refunded = await store.refundWithdrawal(reservation.withdrawalId, 'failed');
      if (refunded) {
        return {
          withdrawalId: refunded.withdrawal.id,
          transferId: refunded.withdrawal.transferId,
          status: refunded.withdrawal.status,
          balanceUnits: refunded.user.balanceUnits,
        };
      }
    }
    return {
      withdrawalId: reservation.withdrawalId,
      transferId: reservation.transferId,
      status: reservation.status,
      balanceUnits: reservation.balanceUnits,
    };
  }

  let transfer: { id: string; status: string };
  try {
    transfer = await outboundTransfers.create(
      {
        source: {
          treasury_account_id: cfg.TREASURY_ACCOUNT_ID,
          currency: 'usdc',
          chain_id: cfg.TREASURY_SOURCE_CHAIN_ID,
        },
        destination,
        amount: amountUnits,
        external_user_id: externalUserId,
      },
      // The exact key supplied over HTTP, so provider retries reconcile the same
      // transfer even if the first response was lost.
      { idempotencyKey: operationId },
    );
  } catch (error) {
    // The provider may have accepted the transfer before the connection failed.
    // Keep the reservation debited; a same-key retry safely reconciles it.
    throw new WithdrawalPendingError(operationId, error);
  }

  let attached: { user: User; withdrawal: Withdrawal };
  try {
    attached = await store.attachWithdrawalTransfer(operationId, transfer.id, transfer.status);
  } catch (error) {
    throw new WithdrawalPendingError(operationId, error);
  }

  if (transfer.status === 'failed') {
    attached = (await store.refundWithdrawal(operationId, 'failed')) ?? attached;
  } else if (transfer.status === 'completed') {
    attached = (await store.completeWithdrawal(operationId)) ?? attached;
  }

  return {
    withdrawalId: operationId,
    transferId: transfer.id,
    status: attached.withdrawal.status,
    balanceUnits: attached.user.balanceUnits,
  };
}

export async function pollWithdrawal(
  env: Env,
  store: D1Store,
  withdrawalId: string,
): Promise<{
  withdrawalId: string;
  transferId: string | null;
  status: string;
  amountUnits: string;
  destination: Destination;
  balanceUnits: string;
}> {
  const cfg = config(env);
  const outboundTransfers: any = unifoldClient(cfg.UNIFOLD_SECRET_KEY).treasury.outboundTransfers;

  const found = await store.getWithdrawal(withdrawalId);
  if (!found) throw new ValidationError('withdrawal not found');
  let { user, withdrawal } = found;

  // A provider timeout can leave a durable reservation without a transfer id.
  // Polling stays read-only and reports that the operation is still pending.
  if (!withdrawal.transferId) {
    return {
      withdrawalId,
      transferId: null,
      status: 'pending',
      amountUnits: withdrawal.amountUnits,
      destination: withdrawal.destination,
      balanceUnits: user.balanceUnits,
    };
  }

  if (withdrawal.status === 'failed' && !withdrawal.refunded) {
    const refunded = await store.refundWithdrawal(withdrawalId, 'failed');
    if (refunded) ({ user, withdrawal } = refunded);
  } else if (withdrawal.status !== 'completed' && withdrawal.status !== 'failed') {
    let transfer: { status: string };
    try {
      transfer = await outboundTransfers.retrieve(withdrawal.transferId);
    } catch (error) {
      throw new WithdrawalPendingError(withdrawalId, error);
    }

    if (transfer.status === 'failed') {
      const refunded = await store.refundWithdrawal(withdrawalId, 'failed');
      if (refunded) ({ user, withdrawal } = refunded);
    } else if (transfer.status === 'completed') {
      const completed = await store.completeWithdrawal(withdrawalId);
      if (completed) ({ user, withdrawal } = completed);
    } else {
      // Do not persist a nonterminal poll result: a concurrent terminal webhook
      // may already have won. Prefer that durable terminal state if present.
      const latest = await store.getWithdrawal(withdrawalId);
      if (latest) ({ user, withdrawal } = latest);
      if (withdrawal.status !== 'completed' && withdrawal.status !== 'failed') {
        withdrawal = { ...withdrawal, status: transfer.status };
      }
    }
  }

  return {
    withdrawalId,
    transferId: withdrawal.transferId,
    status: withdrawal.status === 'reserved' ? 'pending' : withdrawal.status,
    amountUnits: withdrawal.amountUnits,
    destination: withdrawal.destination,
    balanceUnits: user.balanceUnits,
  };
}
