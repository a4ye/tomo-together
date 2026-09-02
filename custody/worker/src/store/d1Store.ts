// D1 replacement for custody/src/mongoStore.ts.
//
// ---------------------------------------------------------------------------
// HOW ATOMICITY IS PRESERVED
// ---------------------------------------------------------------------------
// The Mongo store leaned on two things D1 does not have:
//
//   1. multi-document transactions (session.withTransaction), and
//   2. Decimal128 update pipelines, so a balance change was computed *inside*
//      the database and could never lose a concurrent update.
//
// D1 gives one transaction primitive: batch(), which runs its statements
// sequentially in a single implicit transaction and rolls the whole thing back
// if any statement errors. It cannot branch on an earlier statement's result,
// so "UPDATE ... WHERE <precondition>" silently matching zero rows would leave a
// half-applied batch.
//
// The fix is to express every precondition as a statement that *fails* when it
// does not hold:
//
//     INSERT INTO _txn_guard (id) SELECT 1 WHERE NOT (<precondition>)
//
// `_txn_guard.id` has CHECK (id = 0), so a violated precondition raises a
// constraint error and the batch rolls back; a satisfied one inserts nothing.
// Balance arithmetic happens in JS BigInt (SQLite INTEGER is 64-bit and the
// ledger domain is 34 digits), and every write carries a compare-and-swap guard
// on the exact balance string that was read, so a lost update becomes a rolled
// back batch and a retry instead of silent corruption.
//
// Balances stay canonical integer STRINGS at every boundary, exactly as before.

export interface Destination {
  chain_type: string;
  chain_id: string;
  token_address: string;
  recipient_address: string;
}

export interface Withdrawal {
  id: string;
  transferId: string;
  amountUnits: string;
  destination: Destination;
  status: string;
  refunded: boolean;
  createdAt: string;
}

export interface User {
  externalUserId: string;
  balanceUnits: string;
  lastGrantPeriod: string | null;
  withdrawals: Withdrawal[];
  references: string[];
}

export type RsvpStatus = 'staked' | 'attended' | 'flaked' | 'refunded';

export interface Rsvp {
  userId: string;
  stakedUnits: string;
  status: RsvpStatus;
  payoutUnits: string;
}

export interface EventItem {
  id: string;
  host: string;
  title: string;
  startsAt: string | null;
  stakeUnits: string;
  multiplierBps: number;
  status: 'open' | 'settled';
  rsvps: Rsvp[];
  createdAt: string;
}

export interface VersionedEvent {
  event: EventItem;
  revision: number;
}

export interface EventSettlementCredit {
  userId: string;
  units: string;
  reference: string;
}

export interface BalanceAdjustmentResult {
  balanceUnits: string;
  appliedUnits: string;
}

export interface IdempotentAdjustmentResult extends BalanceAdjustmentResult {
  alreadyApplied: boolean;
  requestedDeltaUnits: string;
  clamped: boolean;
}

export interface GrantClaimResult {
  alreadyGranted: boolean;
  balanceUnits: string;
}

export interface WithdrawalReservationResult {
  created: boolean;
  withdrawalId: string;
  transferId: string | null;
  status: string;
  amountUnits: string;
  balanceUnits: string;
}

export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MongoStoreConflictError';
  }
}

/** A guard fired: another writer won the race. Always retried, never surfaced. */
class GuardViolation extends Error {}

// Decimal128 has 34 significant digits. Keeping every persisted integer at or
// below this ceiling prevents a ledger balance leaving the integer domain.
const MAX_LEDGER_UNITS = 10n ** 34n - 1n;
const MAX_CAS_ATTEMPTS = 8;

function requireIntegerString(value: string, name: string): bigint {
  if (!/^-?(0|[1-9]\d*)$/.test(value) || value === '-0') {
    throw new TypeError(`${name} must be a canonical integer string`);
  }
  if (value.replace('-', '').length > 34) {
    throw new RangeError(`${name} exceeds MongoDB Decimal128's 34-digit precision`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_LEDGER_UNITS || parsed < -MAX_LEDGER_UNITS) {
    throw new RangeError(`${name} exceeds the supported ledger range`);
  }
  return parsed;
}

function requireNonNegativeIntegerString(value: string, name: string): bigint {
  const parsed = requireIntegerString(value, name);
  if (parsed < 0n) throw new RangeError(`${name} must be non-negative`);
  return parsed;
}

function requireIdentifier(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} is required`);
  }
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Byte-identical to mongoStore.hashReference():
 *   sha256(String(utf8ByteLength(user)) + ":" + user + "\u0000" + reference)
 * Kept identical so a reference written by the Express build and one written
 * here collide — that is what makes deposit crediting idempotent across both.
 */
export function hashReference(externalUserId: string, reference: string): Promise<string> {
  const bytes = new TextEncoder().encode(externalUserId).length;
  return sha256Hex(`${bytes}:${externalUserId}\u0000${reference}`);
}

function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint failed|UNIQUE constraint|CHECK constraint/i.test(message);
}

function sameDestination(left: Destination, right: Destination): boolean {
  return (
    left.chain_type === right.chain_type &&
    left.chain_id === right.chain_id &&
    left.token_address === right.token_address &&
    left.recipient_address === right.recipient_address
  );
}

interface UserRow {
  external_user_id: string;
  balance_units: string;
  last_grant_period: string | null;
  created_at: number;
  updated_at: number;
}

interface WithdrawalRow {
  id: string;
  external_user_id: string;
  transfer_id: string | null;
  amount_units: string;
  dest_chain_type: string;
  dest_chain_id: string;
  dest_token_address: string;
  dest_recipient_address: string;
  status: string;
  refunded: number;
  created_at: string;
  updated_at: number;
}

const withdrawalFromRow = (r: WithdrawalRow): Withdrawal => ({
  id: r.id,
  // The public legacy shape maps a missing transfer id to ''.
  transferId: r.transfer_id ?? '',
  amountUnits: r.amount_units,
  destination: {
    chain_type: r.dest_chain_type,
    chain_id: r.dest_chain_id,
    token_address: r.dest_token_address,
    recipient_address: r.dest_recipient_address,
  },
  status: r.status,
  refunded: !!r.refunded,
  createdAt: r.created_at,
});

export class D1Store {
  constructor(
    private readonly db: D1Database,
    private readonly floorUnits: string,
  ) {
    requireIntegerString(floorUnits, 'creditLimitUnits');
  }

  /** Fails the enclosing batch unless `condition` (a SQL boolean) holds. */
  private guard(condition: string, ...params: unknown[]): D1PreparedStatement {
    return this.db
      .prepare(`INSERT INTO _txn_guard (id) SELECT 1 WHERE NOT (${condition})`)
      .bind(...(params as any[]));
  }

  private balanceCas(externalUserId: string, expected: string): D1PreparedStatement {
    return this.guard(
      'EXISTS (SELECT 1 FROM crypto_users WHERE external_user_id = ?1 AND balance_units = ?2)',
      externalUserId,
      expected,
    );
  }

  private setBalance(externalUserId: string, next: string): D1PreparedStatement {
    return this.db
      .prepare('UPDATE crypto_users SET balance_units = ?2, updated_at = ?3 WHERE external_user_id = ?1')
      .bind(externalUserId, next, Date.now());
  }

  private async runGuarded(statements: D1PreparedStatement[]): Promise<void> {
    try {
      await this.db.batch(statements);
    } catch (error) {
      if (isConstraintError(error)) throw new GuardViolation(String(error));
      throw error;
    }
  }

  /** Read → compute → guarded write, retried while another writer keeps winning. */
  private async retrying<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof GuardViolation && attempt < MAX_CAS_ATTEMPTS) continue;
        if (error instanceof GuardViolation) {
          throw new StoreConflictError('the ledger row changed concurrently too many times');
        }
        throw error;
      }
    }
  }

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async checkReady(): Promise<boolean> {
    await this.db.prepare('SELECT 1').first();
    return true;
  }

  // ----------------------------------------------------------------- users --

  private async userRow(externalUserId: string): Promise<UserRow | null> {
    return this.db
      .prepare('SELECT * FROM crypto_users WHERE external_user_id = ?1')
      .bind(externalUserId)
      .first<UserRow>();
  }

  private async hydrate(row: UserRow): Promise<User> {
    const { results } = await this.db
      .prepare('SELECT * FROM crypto_withdrawals WHERE external_user_id = ?1 ORDER BY created_at ASC')
      .bind(row.external_user_id)
      .all<WithdrawalRow>();
    return {
      externalUserId: row.external_user_id,
      balanceUnits: row.balance_units,
      lastGrantPeriod: row.last_grant_period,
      withdrawals: (results ?? []).map(withdrawalFromRow),
      references: [],
    };
  }

  async registerUser(externalUserId: string): Promise<User> {
    requireIdentifier(externalUserId, 'externalUserId');
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO crypto_users
           (external_user_id, balance_units, last_grant_period, created_at, updated_at)
         VALUES (?1, '0', NULL, ?2, ?2)`,
      )
      .bind(externalUserId, now)
      .run();
    const row = await this.userRow(externalUserId);
    if (!row) throw new Error('the datastore did not return the registered user');
    return this.hydrate(row);
  }

  async getUser(externalUserId: string): Promise<User | undefined> {
    const row = await this.userRow(externalUserId);
    return row ? this.hydrate(row) : undefined;
  }

  async creditBalance(externalUserId: string, units: string): Promise<void> {
    requireNonNegativeIntegerString(units, 'units');
    await this.retrying(async () => {
      const row = await this.userRow(externalUserId);
      if (!row) throw new Error('user not found');
      const next = BigInt(row.balance_units) + BigInt(units);
      if (next > MAX_LEDGER_UNITS) {
        throw new RangeError('balance would exceed the supported ledger range');
      }
      await this.runGuarded([
        this.balanceCas(externalUserId, row.balance_units),
        this.setBalance(externalUserId, next.toString()),
      ]);
    });
  }

  async debitBalance(externalUserId: string, units: string): Promise<void> {
    requireNonNegativeIntegerString(units, 'units');
    await this.retrying(async () => {
      const row = await this.userRow(externalUserId);
      if (!row) return; // matches Mongo: a missing user is a no-op here
      const next = BigInt(row.balance_units) - BigInt(units);
      if (next < 0n) throw new Error('debitBalance would drive balance below 0');
      await this.runGuarded([
        this.balanceCas(externalUserId, row.balance_units),
        this.setBalance(externalUserId, next.toString()),
      ]);
    });
  }

  /**
   * Atomically apply a referenced adjustment exactly once. Replaces the unsafe
   * hasReference -> adjustBalance -> addReference sequence.
   */
  async applyAdjustment(
    externalUserId: string,
    deltaUnits: string,
    reference?: string,
  ): Promise<IdempotentAdjustmentResult> {
    requireIntegerString(deltaUnits, 'deltaUnits');
    const floor = BigInt(this.floorUnits);

    if (!reference) {
      return this.retrying(async () => {
        const row = await this.userRow(externalUserId);
        if (!row) throw new Error('user not found');
        const old = BigInt(row.balance_units);
        const requested = old + BigInt(deltaUnits);
        if (requested > MAX_LEDGER_UNITS) {
          throw new RangeError('balance would exceed the supported ledger range');
        }
        const next = requested < floor ? floor : requested;
        await this.runGuarded([
          this.balanceCas(externalUserId, row.balance_units),
          this.setBalance(externalUserId, next.toString()),
        ]);
        return {
          alreadyApplied: false,
          balanceUnits: next.toString(),
          appliedUnits: (next - old).toString(),
          requestedDeltaUnits: deltaUnits,
          clamped: next - old !== BigInt(deltaUnits),
        };
      });
    }

    const referenceHash = await hashReference(externalUserId, reference);
    const refId = `ref_${referenceHash}`;

    const alreadyApplied = async (): Promise<IdempotentAdjustmentResult> => {
      const existing = await this.db
        .prepare('SELECT * FROM crypto_idempotency WHERE id = ?1')
        .bind(refId)
        .first<any>();
      if (!existing) throw new StoreConflictError(`adjustment reference ${reference} vanished`);
      if (
        existing.external_user_id !== externalUserId ||
        existing.reference !== reference ||
        existing.operation !== 'adjustment' ||
        existing.requested_delta_units !== deltaUnits
      ) {
        throw new StoreConflictError(
          `adjustment reference ${reference} was already used with a different payload`,
        );
      }
      const row = await this.userRow(externalUserId);
      if (!row) throw new Error('user not found');
      return {
        alreadyApplied: true,
        balanceUnits: row.balance_units,
        appliedUnits: '0',
        requestedDeltaUnits: deltaUnits,
        clamped: false,
      };
    };

    const existing = await this.db
      .prepare('SELECT 1 AS hit FROM crypto_idempotency WHERE id = ?1')
      .bind(refId)
      .first();
    if (existing) return alreadyApplied();

    try {
      return await this.retrying(async () => {
        // Re-checked on every attempt: a concurrent winner turns this into the
        // already-applied path immediately instead of burning the retries.
        const raced = await this.db
          .prepare('SELECT 1 AS hit FROM crypto_idempotency WHERE id = ?1')
          .bind(refId)
          .first();
        if (raced) throw new StoreConflictError('adjustment reference was claimed concurrently');

        const row = await this.userRow(externalUserId);
        if (!row) throw new Error('user not found');
        const old = BigInt(row.balance_units);
        const requested = old + BigInt(deltaUnits);
        if (requested > MAX_LEDGER_UNITS) {
          throw new RangeError('balance would exceed the supported ledger range');
        }
        const next = requested < floor ? floor : requested;
        await this.runGuarded([
          this.balanceCas(externalUserId, row.balance_units),
          // A concurrent winner makes this INSERT violate the unique index and
          // rolls the balance change back with it.
          this.db
            .prepare(
              `INSERT INTO crypto_idempotency
                 (id, external_user_id, reference_hash, reference, operation, requested_delta_units, created_at)
               VALUES (?1, ?2, ?3, ?4, 'adjustment', ?5, ?6)`,
            )
            .bind(refId, externalUserId, referenceHash, reference, deltaUnits, Date.now()),
          this.setBalance(externalUserId, next.toString()),
        ]);
        return {
          alreadyApplied: false,
          balanceUnits: next.toString(),
          appliedUnits: (next - old).toString(),
          requestedDeltaUnits: deltaUnits,
          clamped: next - old !== BigInt(deltaUnits),
        };
      });
    } catch (error) {
      if (!(error instanceof StoreConflictError)) throw error;
      // A concurrent transaction won the unique reference insert: its balance
      // update committed, ours rolled back.
      return alreadyApplied();
    }
  }

  /** Atomically claim a monthly grant and credit its units once. */
  async claimGrantPeriod(
    externalUserId: string,
    period: string,
    grantUnits: string,
  ): Promise<GrantClaimResult> {
    requireNonNegativeIntegerString(grantUnits, 'grantUnits');
    return this.retrying(async () => {
      const row = await this.userRow(externalUserId);
      if (!row) throw new Error('user not found');
      if (row.last_grant_period === period) {
        return { alreadyGranted: true, balanceUnits: row.balance_units };
      }
      const next = BigInt(row.balance_units) + BigInt(grantUnits);
      if (next > MAX_LEDGER_UNITS) {
        throw new RangeError('balance would exceed the supported ledger range');
      }
      await this.runGuarded([
        this.guard(
          `EXISTS (SELECT 1 FROM crypto_users
                    WHERE external_user_id = ?1 AND balance_units = ?2
                      AND (last_grant_period IS NULL OR last_grant_period <> ?3))`,
          externalUserId,
          row.balance_units,
          period,
        ),
        this.db
          .prepare(
            `UPDATE crypto_users SET balance_units = ?2, last_grant_period = ?3, updated_at = ?4
              WHERE external_user_id = ?1`,
          )
          .bind(externalUserId, next.toString(), period, Date.now()),
      ]);
      return { alreadyGranted: false, balanceUnits: next.toString() };
    });
  }

  // ----------------------------------------------------------- withdrawals --

  private assertSameWithdrawalOperation(
    row: WithdrawalRow,
    externalUserId: string,
    amountUnits: string,
    destination: Destination,
  ): void {
    if (
      row.external_user_id !== externalUserId ||
      row.amount_units !== amountUnits ||
      !sameDestination(withdrawalFromRow(row).destination, destination)
    ) {
      throw new StoreConflictError(
        `withdrawal operation ${row.id} was reused with a different payload`,
      );
    }
  }

  /**
   * Atomically reserve a withdrawal and debit its balance exactly once.
   * A provider timeout must leave the reservation in `reserved`; retry with the
   * same operationId. Only refund after an authoritative provider `failed`.
   */
  async reserveWithdrawal(
    externalUserId: string,
    operationId: string,
    amountUnits: string,
    destination: Destination,
  ): Promise<WithdrawalReservationResult> {
    requireIdentifier(externalUserId, 'externalUserId');
    requireIdentifier(operationId, 'operationId');
    if (requireNonNegativeIntegerString(amountUnits, 'amountUnits') === 0n) {
      throw new RangeError('amountUnits must be positive');
    }
    requireIdentifier(destination.chain_type, 'destination.chain_type');
    requireIdentifier(destination.chain_id, 'destination.chain_id');
    requireIdentifier(destination.token_address, 'destination.token_address');
    requireIdentifier(destination.recipient_address, 'destination.recipient_address');

    const readExisting = async (): Promise<WithdrawalReservationResult | undefined> => {
      const row = await this.db
        .prepare('SELECT * FROM crypto_withdrawals WHERE id = ?1')
        .bind(operationId)
        .first<WithdrawalRow>();
      if (!row) return undefined;
      this.assertSameWithdrawalOperation(row, externalUserId, amountUnits, destination);
      const user = await this.userRow(externalUserId);
      if (!user) throw new Error('user not found');
      return {
        created: false,
        withdrawalId: row.id,
        transferId: row.transfer_id ?? null,
        status: row.status,
        amountUnits: row.amount_units,
        balanceUnits: user.balance_units,
      };
    };

    const existing = await readExisting();
    if (existing) return existing;

    try {
      return await this.retrying(async () => {
        const user = await this.userRow(externalUserId);
        if (!user) throw new Error('user not found');
        const next = BigInt(user.balance_units) - BigInt(amountUnits);
        // Cash-out reservations keep the hard-zero floor, so borrowed internal
        // credit can never be withdrawn as real funds.
        if (next < 0n) throw new Error('debitBalance would drive balance below 0');
        const now = Date.now();
        await this.runGuarded([
          this.balanceCas(externalUserId, user.balance_units),
          this.db
            .prepare(
              `INSERT INTO crypto_withdrawals
                 (id, external_user_id, transfer_id, amount_units, dest_chain_type, dest_chain_id,
                  dest_token_address, dest_recipient_address, status, refunded, created_at, updated_at)
               VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, 'reserved', 0, ?8, ?9)`,
            )
            .bind(
              operationId, externalUserId, amountUnits, destination.chain_type,
              destination.chain_id, destination.token_address, destination.recipient_address,
              new Date(now).toISOString(), now,
            ),
          this.setBalance(externalUserId, next.toString()),
        ]);
        return {
          created: true,
          withdrawalId: operationId,
          transferId: null,
          status: 'reserved',
          amountUnits,
          balanceUnits: next.toString(),
        };
      });
    } catch (error) {
      if (!(error instanceof StoreConflictError)) throw error;
      const raced = await readExisting();
      if (!raced) throw error;
      return raced;
    }
  }

  /** Attach the provider transfer without allowing reassignment. */
  async attachWithdrawalTransfer(
    operationId: string,
    transferId: string,
    status: string,
  ): Promise<{ user: User; withdrawal: Withdrawal }> {
    requireIdentifier(operationId, 'operationId');
    requireIdentifier(transferId, 'transferId');
    const result = await this.db
      .prepare(
        `UPDATE crypto_withdrawals
            SET transfer_id = ?2, status = ?3, updated_at = ?4
          WHERE id = ?1
            AND (transfer_id IS NULL OR (transfer_id = ?2 AND status = 'reserved'))`,
      )
      .bind(operationId, transferId, status, Date.now())
      .run();
    if ((result.meta.changes ?? 0) === 0) {
      const existing = await this.db
        .prepare('SELECT * FROM crypto_withdrawals WHERE id = ?1')
        .bind(operationId)
        .first<WithdrawalRow>();
      if (!existing) throw new Error('withdrawal reservation not found');
      if (existing.transfer_id !== transferId) {
        throw new StoreConflictError(
          `withdrawal ${operationId} is already attached to another transfer`,
        );
      }
      return this.hydrateWithdrawal(existing);
    }
    const updated = await this.db
      .prepare('SELECT * FROM crypto_withdrawals WHERE id = ?1')
      .bind(operationId)
      .first<WithdrawalRow>();
    return this.hydrateWithdrawal(updated!);
  }

  private async hydrateWithdrawal(row: WithdrawalRow): Promise<{ user: User; withdrawal: Withdrawal }> {
    const user = await this.userRow(row.external_user_id);
    if (!user) throw new Error(`withdrawal ${row.id} references a missing user`);
    return { user: await this.hydrate(user), withdrawal: withdrawalFromRow(row) };
  }

  async getWithdrawal(withdrawalId: string): Promise<{ user: User; withdrawal: Withdrawal } | undefined> {
    const row = await this.db
      .prepare('SELECT * FROM crypto_withdrawals WHERE id = ?1')
      .bind(withdrawalId)
      .first<WithdrawalRow>();
    return row ? this.hydrateWithdrawal(row) : undefined;
  }

  async getWithdrawalByTransferId(
    transferId: string,
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined> {
    const row = await this.db
      .prepare('SELECT * FROM crypto_withdrawals WHERE transfer_id = ?1')
      .bind(transferId)
      .first<WithdrawalRow>();
    return row ? this.hydrateWithdrawal(row) : undefined;
  }

  async updateWithdrawal(withdrawalId: string, patch: Partial<Withdrawal>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = ?${params.length + 1}`);
    };
    if (patch.transferId !== undefined) push('transfer_id', patch.transferId);
    if (patch.amountUnits !== undefined) push('amount_units', patch.amountUnits);
    if (patch.destination !== undefined) {
      push('dest_chain_type', patch.destination.chain_type);
      push('dest_chain_id', patch.destination.chain_id);
      push('dest_token_address', patch.destination.token_address);
      push('dest_recipient_address', patch.destination.recipient_address);
    }
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.refunded !== undefined) push('refunded', patch.refunded ? 1 : 0);
    if (patch.createdAt !== undefined) push('created_at', patch.createdAt);
    push('updated_at', Date.now());
    await this.db
      .prepare(`UPDATE crypto_withdrawals SET ${sets.join(', ')} WHERE id = ?1`)
      .bind(withdrawalId, ...(params as any[]))
      .run();
  }

  /** Atomically mark a failed withdrawal refunded and restore its balance once. */
  async refundWithdrawal(
    withdrawalId: string,
    status = 'failed',
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined> {
    return this.retrying(async () => {
      const row = await this.db
        .prepare('SELECT * FROM crypto_withdrawals WHERE id = ?1')
        .bind(withdrawalId)
        .first<WithdrawalRow>();
      if (!row) return undefined;
      if (row.refunded || row.status === 'completed') return this.hydrateWithdrawal(row);

      const user = await this.userRow(row.external_user_id);
      if (!user) throw new Error(`withdrawal ${row.id} references a missing user`);
      const next = BigInt(user.balance_units) + BigInt(row.amount_units);
      if (next > MAX_LEDGER_UNITS) {
        throw new RangeError('balance would exceed the supported ledger range');
      }
      await this.runGuarded([
        this.guard(
          `EXISTS (SELECT 1 FROM crypto_withdrawals
                    WHERE id = ?1 AND refunded = 0 AND status <> 'completed')`,
          withdrawalId,
        ),
        this.balanceCas(row.external_user_id, user.balance_units),
        this.db
          .prepare('UPDATE crypto_withdrawals SET refunded = 1, status = ?2, updated_at = ?3 WHERE id = ?1')
          .bind(withdrawalId, status, Date.now()),
        this.setBalance(row.external_user_id, next.toString()),
      ]);
      const after = await this.db
        .prepare('SELECT * FROM crypto_withdrawals WHERE id = ?1')
        .bind(withdrawalId)
        .first<WithdrawalRow>();
      return this.hydrateWithdrawal(after!);
    });
  }

  /**
   * Mark a provider-confirmed withdrawal completed without letting a late,
   * contradictory completion webhook reverse an earlier failure/refund.
   */
  async completeWithdrawal(
    withdrawalId: string,
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined> {
    await this.db
      .prepare(
        `UPDATE crypto_withdrawals SET status = 'completed', updated_at = ?2
          WHERE id = ?1 AND refunded = 0 AND status <> 'failed'`,
      )
      .bind(withdrawalId, Date.now())
      .run();
    const row = await this.db
      .prepare('SELECT * FROM crypto_withdrawals WHERE id = ?1')
      .bind(withdrawalId)
      .first<WithdrawalRow>();
    return row ? this.hydrateWithdrawal(row) : undefined;
  }

  // ---------------------------------------------------------------- events --

  private async loadEvents(rows: any[]): Promise<Array<{ event: EventItem; revision: number }>> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id as string);
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(',');
    const { results } = await this.db
      .prepare(
        `SELECT * FROM crypto_event_rsvps WHERE event_id IN (${placeholders}) ORDER BY event_id, position`,
      )
      .bind(...ids)
      .all<any>();
    const byEvent = new Map<string, Rsvp[]>();
    for (const r of results ?? []) {
      const list = byEvent.get(r.event_id) ?? [];
      list.push({
        userId: r.user_id,
        stakedUnits: r.staked_units,
        status: r.status,
        payoutUnits: r.payout_units,
      });
      byEvent.set(r.event_id, list);
    }
    return rows.map((r) => ({
      event: {
        id: r.id,
        host: r.host,
        title: r.title,
        startsAt: r.starts_at,
        stakeUnits: r.stake_units,
        multiplierBps: Number(r.multiplier_bps),
        status: r.status,
        rsvps: byEvent.get(r.id) ?? [],
        createdAt: r.created_at,
      },
      revision: Number(r.revision),
    }));
  }

  async createEvent(event: EventItem): Promise<EventItem> {
    await this.db
      .prepare(
        `INSERT INTO crypto_events
           (id, host, title, starts_at, stake_units, multiplier_bps, status, created_at, revision, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,?9)`,
      )
      .bind(
        event.id, event.host, event.title, event.startsAt, event.stakeUnits,
        event.multiplierBps, event.status, event.createdAt, Date.now(),
      )
      .run();
    return { ...event, rsvps: event.rsvps.map((r) => ({ ...r })) };
  }

  async getEvent(id: string): Promise<EventItem | undefined> {
    return (await this.getVersionedEvent(id))?.event;
  }

  async getVersionedEvent(id: string): Promise<VersionedEvent | undefined> {
    const row = await this.db.prepare('SELECT * FROM crypto_events WHERE id = ?1').bind(id).first<any>();
    if (!row) return undefined;
    const [loaded] = await this.loadEvents([row]);
    return loaded;
  }

  async eventsForUser(userId: string): Promise<EventItem[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM crypto_events e
          WHERE e.host = ?1
             OR EXISTS (SELECT 1 FROM crypto_event_rsvps r WHERE r.event_id = e.id AND r.user_id = ?1)
          ORDER BY e.created_at DESC`,
      )
      .bind(userId)
      .all<any>();
    return (await this.loadEvents(results ?? [])).map((l) => l.event);
  }

  /** Atomically debit a user's stake and append their RSVP to an open event. */
  async stakeRsvp(eventId: string, userId: string): Promise<EventItem> {
    return this.retrying(async () => {
      const versioned = await this.getVersionedEvent(eventId);
      if (!versioned) throw new Error('event not found');
      const { event, revision } = versioned;
      if (event.status !== 'open') throw new Error('event is not open for RSVPs');
      if (event.rsvps.some((r) => r.userId === userId)) throw new Error('user already RSVP’d');
      const user = await this.userRow(userId);
      if (!user) throw new Error('user not found');

      // Stakes respect the configured internal-ledger credit floor.
      const next = BigInt(user.balance_units) - BigInt(event.stakeUnits);
      if (next < BigInt(this.floorUnits)) {
        throw new Error(`debitBalance would drive balance below ${this.floorUnits}`);
      }

      await this.runGuarded([
        this.guard(
          "EXISTS (SELECT 1 FROM crypto_events WHERE id = ?1 AND status = 'open' AND revision = ?2)",
          eventId,
          revision,
        ),
        this.balanceCas(userId, user.balance_units),
        this.db
          .prepare(
            `INSERT INTO crypto_event_rsvps
               (event_id, user_id, position, staked_units, status, payout_units)
             VALUES (?1, ?2, ?3, ?4, 'staked', '0')`,
          )
          .bind(eventId, userId, event.rsvps.length, event.stakeUnits),
        this.db
          .prepare('UPDATE crypto_events SET revision = revision + 1, updated_at = ?2 WHERE id = ?1')
          .bind(eventId, Date.now()),
        this.setBalance(userId, next.toString()),
      ]);
      return (await this.getEvent(eventId))!;
    });
  }

  /** Atomically mark a staked RSVP attended. */
  async checkInRsvp(eventId: string, userId: string): Promise<EventItem> {
    try {
      await this.runGuarded([
        this.guard(
          `EXISTS (SELECT 1 FROM crypto_events e
                     JOIN crypto_event_rsvps r ON r.event_id = e.id
                    WHERE e.id = ?1 AND e.status = 'open' AND r.user_id = ?2 AND r.status = 'staked')`,
          eventId,
          userId,
        ),
        this.db
          .prepare("UPDATE crypto_event_rsvps SET status = 'attended' WHERE event_id = ?1 AND user_id = ?2")
          .bind(eventId, userId),
        this.db
          .prepare('UPDATE crypto_events SET revision = revision + 1, updated_at = ?2 WHERE id = ?1')
          .bind(eventId, Date.now()),
      ]);
    } catch (error) {
      if (error instanceof GuardViolation) {
        throw new StoreConflictError('RSVP is not available for check-in');
      }
      throw error;
    }
    return (await this.getEvent(eventId))!;
  }

  /**
   * Atomically commit every settlement credit and the final event state.
   * A stale snapshot aborts without changing balances.
   */
  async commitEventSettlement(
    settledEvent: EventItem,
    expectedRevision: number,
    credits: ReadonlyArray<EventSettlementCredit>,
  ): Promise<EventItem> {
    if (settledEvent.status !== 'settled') {
      throw new TypeError('settledEvent.status must be settled');
    }
    try {
      return await this.retrying(async () => {
        const current = await this.getVersionedEvent(settledEvent.id);
        if (!current) throw new Error('event not found');
        if (current.event.status === 'settled') return current.event;
        if (current.revision !== expectedRevision) {
          throw new StoreConflictError(`event ${settledEvent.id} changed concurrently`);
        }

        const statements: D1PreparedStatement[] = [
          this.guard(
            "EXISTS (SELECT 1 FROM crypto_events WHERE id = ?1 AND revision = ?2 AND status = 'open')",
            settledEvent.id,
            expectedRevision,
          ),
        ];
        const now = Date.now();
        for (const credit of credits) {
          requireIdentifier(credit.userId, 'credit.userId');
          requireIdentifier(credit.reference, 'credit.reference');
          if (requireNonNegativeIntegerString(credit.units, 'credit.units') === 0n) continue;
          const referenceHash = await hashReference(credit.userId, credit.reference);
          const refId = `ref_${referenceHash}`;
          const existing = await this.db
            .prepare('SELECT 1 AS hit FROM crypto_idempotency WHERE id = ?1')
            .bind(refId)
            .first();
          if (existing) {
            throw new Error(
              `settlement reference ${credit.reference} exists while event is still open`,
            );
          }
          const user = await this.userRow(credit.userId);
          if (!user) throw new Error('user not found');
          const next = BigInt(user.balance_units) + BigInt(credit.units);
          if (next > MAX_LEDGER_UNITS) {
            throw new RangeError('balance would exceed the supported ledger range');
          }
          statements.push(
            this.balanceCas(credit.userId, user.balance_units),
            this.db
              .prepare(
                `INSERT INTO crypto_idempotency
                   (id, external_user_id, reference_hash, reference, operation, requested_delta_units, created_at)
                 VALUES (?1, ?2, ?3, ?4, 'settlement', NULL, ?5)`,
              )
              .bind(refId, credit.userId, referenceHash, credit.reference, now),
            this.setBalance(credit.userId, next.toString()),
          );
        }

        for (const rsvp of settledEvent.rsvps) {
          statements.push(
            this.db
              .prepare(
                `UPDATE crypto_event_rsvps SET status = ?3, payout_units = ?4
                  WHERE event_id = ?1 AND user_id = ?2`,
              )
              .bind(settledEvent.id, rsvp.userId, rsvp.status, rsvp.payoutUnits),
          );
        }
        statements.push(
          this.db
            .prepare(
              `UPDATE crypto_events SET status = 'settled', revision = ?2, updated_at = ?3 WHERE id = ?1`,
            )
            .bind(settledEvent.id, expectedRevision + 1, now),
        );

        await this.runGuarded(statements);
        return (await this.getEvent(settledEvent.id))!;
      });
    } catch (error) {
      if (error instanceof StoreConflictError) throw error;
      throw error;
    }
  }
}
