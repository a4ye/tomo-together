// Treasury outbound transfers. "Withdraw" = Unifold routes cross-chain and pays the gas.
import {
  MIN_WITHDRAW_UNITS,
  TREASURY_ACCOUNT_ID,
  TREASURY_SOURCE_CHAIN_ID,
} from './config.js';
import { MongoStoreConflictError } from './mongoStore.js';
import { getStore } from './runtimeStore.js';
import type { Destination, User, Withdrawal } from './store.js';
import { unifold } from './unifold.js';

interface WithdrawalReservation {
  created: boolean;
  withdrawalId: string;
  transferId: string | null;
  status: string;
  amountUnits: string;
  balanceUnits: string;
}

export interface WithdrawalStore {
  getUser(externalUserId: string): Promise<User | undefined>;
  reserveWithdrawal(
    externalUserId: string,
    operationId: string,
    amountUnits: string,
    destination: Destination,
  ): Promise<WithdrawalReservation>;
  attachWithdrawalTransfer(
    operationId: string,
    transferId: string,
    status: string,
  ): Promise<{ user: User; withdrawal: Withdrawal }>;
  getWithdrawal(
    withdrawalId: string,
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined>;
  updateWithdrawal(withdrawalId: string, patch: Partial<Withdrawal>): Promise<void>;
  completeWithdrawal(
    withdrawalId: string,
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined>;
  refundWithdrawal(
    withdrawalId: string,
    status?: string,
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined>;
}

interface OutboundTransfers {
  create(
    params: {
      source: {
        treasury_account_id: string;
        currency: string;
        chain_id: '8453' | '137';
      };
      destination: Destination;
      amount: string;
      external_user_id: string;
    },
    options: { idempotencyKey: string },
  ): Promise<{ id: string; status: string }>;
  retrieve(transferId: string): Promise<{ status: string }>;
}

export interface WithdrawalDependencies {
  store: WithdrawalStore;
  outboundTransfers: OutboundTransfers;
}

// Validation errors are mapped to HTTP 400 by index.ts.
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
    super('withdrawal is pending reconciliation; retry with the same Idempotency-Key', {
      cause,
    });
    this.name = 'WithdrawalPendingError';
    this.withdrawalId = withdrawalId;
  }
}

// Positive-integer base-unit string guard. Shared with events.ts.
export function isPositiveIntString(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    /^(0|[1-9]\d*)$/.test(s) &&
    s.length <= 34 &&
    BigInt(s) > 0n
  );
}

// Keep keys log-safe, header-safe, and within common provider limits. The
// validated value is preserved byte-for-byte from HTTP -> Mongo -> Unifold.
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

function defaultDependencies(): WithdrawalDependencies {
  return {
    store: getStore(),
    outboundTransfers: unifold.treasury.outboundTransfers,
  };
}

function validateDestination(destination: Destination): void {
  for (const field of [
    'chain_type',
    'chain_id',
    'token_address',
    'recipient_address',
  ] as const) {
    if (typeof destination?.[field] !== 'string' || destination[field].trim() === '') {
      throw new ValidationError(`${field} is required`);
    }
  }
}

function sameDestination(left: Destination, right: Destination): boolean {
  return (
    left.chain_type === right.chain_type &&
    left.chain_id === right.chain_id &&
    left.token_address === right.token_address &&
    left.recipient_address === right.recipient_address
  );
}

export async function withdraw(
  externalUserId: string,
  amountUnits: string,
  destination: Destination,
  idempotencyKey: string,
  dependencies: WithdrawalDependencies = defaultDependencies(),
): Promise<{
  withdrawalId: string;
  transferId: string;
  status: string;
  balanceUnits: string;
}> {
  const operationId = validateIdempotencyKey(idempotencyKey);
  if (typeof amountUnits !== 'string' || !isPositiveIntString(amountUnits)) {
    throw new ValidationError('amountUnits must be a positive integer string');
  }
  validateDestination(destination);

  let reservation: WithdrawalReservation;
  const existing = await dependencies.store.getWithdrawal(operationId);
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
    const user = await dependencies.store.getUser(externalUserId);
    if (!user) throw new ValidationError('user not found');
    if (BigInt(amountUnits) < BigInt(MIN_WITHDRAW_UNITS)) {
      throw new ValidationError(
        `amountUnits must be >= ${MIN_WITHDRAW_UNITS} (${Number(MIN_WITHDRAW_UNITS) / 1e6} USDC minimum)`,
      );
    }

    try {
      // Mongo atomically records the pending operation and debits exactly once.
      // Reusing the key with the same payload returns the original reservation.
      reservation = await dependencies.store.reserveWithdrawal(
        externalUserId,
        operationId,
        amountUnits,
        destination,
      );
    } catch (error) {
      if (error instanceof MongoStoreConflictError) {
        throw new IdempotencyConflictError();
      }
      if (error instanceof Error && error.message === 'debitBalance would drive balance below 0') {
        throw new ValidationError('amountUnits exceeds available balance');
      }
      throw error;
    }
  }

  // A completed first request may have lost its HTTP response. Never submit a
  // second provider operation once its transfer id has been durably attached.
  if (reservation.transferId) {
    // Recovery is part of the retry path. A process can stop after attaching a
    // provider's terminal failure but before the compensating ledger refund;
    // replaying the same key must finish that durable transition exactly once.
    if (reservation.status === 'failed') {
      const refunded = await dependencies.store.refundWithdrawal(
        reservation.withdrawalId,
        'failed',
      );
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
    transfer = await dependencies.outboundTransfers.create(
      {
        source: {
          treasury_account_id: TREASURY_ACCOUNT_ID,
          currency: 'usdc',
          chain_id: TREASURY_SOURCE_CHAIN_ID,
        },
        destination,
        amount: amountUnits,
        external_user_id: externalUserId,
      },
      // This is the exact key supplied over HTTP. Provider retries therefore
      // reconcile the same transfer even if the first response was lost.
      { idempotencyKey: operationId },
    );
  } catch (error) {
    // The provider may have accepted the transfer before the connection failed.
    // Keep the Mongo reservation debited; a same-key retry safely reconciles it.
    throw new WithdrawalPendingError(operationId, error);
  }

  let attached: { user: User; withdrawal: Withdrawal };
  try {
    attached = await dependencies.store.attachWithdrawalTransfer(
      operationId,
      transfer.id,
      transfer.status,
    );
  } catch (error) {
    // The provider result exists but was not durably attached. The same-key
    // create retry is safe and lets a later request finish the attachment.
    throw new WithdrawalPendingError(operationId, error);
  }

  if (transfer.status === 'failed') {
    attached =
      (await dependencies.store.refundWithdrawal(operationId, 'failed')) ?? attached;
  } else if (transfer.status === 'completed') {
    attached = (await dependencies.store.completeWithdrawal(operationId)) ?? attached;
  }

  return {
    withdrawalId: operationId,
    transferId: transfer.id,
    status: attached.withdrawal.status,
    balanceUnits: attached.user.balanceUnits,
  };
}

export async function pollWithdrawal(
  withdrawalId: string,
  dependencies: WithdrawalDependencies = defaultDependencies(),
): Promise<{
  withdrawalId: string;
  transferId: string | null;
  status: string;
  amountUnits: string;
  destination: Destination;
  balanceUnits: string;
}> {
  const found = await dependencies.store.getWithdrawal(withdrawalId);
  if (!found) throw new ValidationError('withdrawal not found');
  let { user, withdrawal } = found;

  // A provider timeout can leave a durable reservation without a transfer id.
  // POST /withdraw with the same key performs reconciliation; polling remains
  // read-only and accurately reports that the operation is still pending.
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

  // Finish a refund that may have been interrupted after the provider failure
  // was durably attached. refundWithdrawal is an atomic, idempotent transition.
  if (withdrawal.status === 'failed' && !withdrawal.refunded) {
    const refunded = await dependencies.store.refundWithdrawal(withdrawalId, 'failed');
    if (refunded) ({ user, withdrawal } = refunded);
  } else if (withdrawal.status !== 'completed' && withdrawal.status !== 'failed') {
    let transfer: { status: string };
    try {
      transfer = await dependencies.outboundTransfers.retrieve(withdrawal.transferId);
    } catch (error) {
      throw new WithdrawalPendingError(withdrawalId, error);
    }

    if (transfer.status === 'failed') {
      const refunded = await dependencies.store.refundWithdrawal(withdrawalId, 'failed');
      if (refunded) ({ user, withdrawal } = refunded);
    } else if (transfer.status === 'completed') {
      const completed = await dependencies.store.completeWithdrawal(withdrawalId);
      if (completed) ({ user, withdrawal } = completed);
    } else {
      // Do not persist a nonterminal poll result: a concurrent terminal webhook
      // may already have won. Prefer that durable terminal state if present.
      const latest = await dependencies.store.getWithdrawal(withdrawalId);
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
