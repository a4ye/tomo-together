import { createHash } from 'node:crypto';
import { MongoClient, ServerApiVersion } from 'mongodb';
import type { EventItem, Rsvp, User, Withdrawal } from './store.js';

type MongoFilter = Record<string, unknown>;
type MongoUpdate = Record<string, unknown> | ReadonlyArray<Record<string, unknown>>;
type MongoOptions = Record<string, unknown>;

interface MongoCursorLike<T> {
  toArray(): Promise<T[]>;
}

interface MongoWriteResultLike {
  acknowledged?: boolean;
  matchedCount: number;
  modifiedCount?: number;
  upsertedCount?: number;
}

interface MongoCollectionLike<T> {
  createIndexes(indexes: ReadonlyArray<Record<string, unknown>>): Promise<unknown>;
  findOne(filter: MongoFilter, options?: MongoOptions): Promise<T | null>;
  findOneAndUpdate(
    filter: MongoFilter,
    update: MongoUpdate,
    options?: MongoOptions,
  ): Promise<T | null>;
  updateOne(
    filter: MongoFilter,
    update: MongoUpdate,
    options?: MongoOptions,
  ): Promise<MongoWriteResultLike>;
  replaceOne(
    filter: MongoFilter,
    replacement: T,
    options?: MongoOptions,
  ): Promise<MongoWriteResultLike>;
  insertOne(document: T, options?: MongoOptions): Promise<unknown>;
  find(filter: MongoFilter, options?: MongoOptions): MongoCursorLike<T>;
}

export interface MongoDbLike {
  collection<T>(name: string): MongoCollectionLike<T>;
  command?(command: Record<string, unknown>, options?: MongoOptions): Promise<unknown>;
}

interface MongoSessionLike {
  withTransaction<T>(
    callback: () => Promise<T>,
    options?: MongoOptions,
  ): Promise<T>;
  endSession(): Promise<void>;
}

interface MongoClientLike {
  connect(): Promise<unknown>;
  close(): Promise<void>;
  db(name: string): MongoDbLike;
  startSession(): MongoSessionLike;
}

interface UserDocument {
  _id: string;
  externalUserId: string;
  balanceUnits: string;
  lastGrantPeriod: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface WithdrawalDocument extends Omit<Withdrawal, 'transferId'> {
  _id: string;
  externalUserId: string;
  // Absent while the durable debit reservation has not yet been attached to
  // the provider transfer. The public legacy shape maps absence to ''.
  transferId?: string;
  updatedAt: Date;
}

interface EventDocument extends EventItem {
  _id: string;
  revision: number;
  updatedAt: Date;
}

interface ReferenceDocument {
  _id: string;
  externalUserId: string;
  referenceHash: string;
  reference: string;
  operation?: 'adjustment' | 'settlement' | 'legacy';
  requestedDeltaUnits?: string;
  createdAt: Date;
}

export interface MongoStoreOptions {
  creditLimitUnits?: string;
  client?: MongoClientLike;
}

export interface MongoStoreConnectionOptions {
  uri: string;
  dbName: string;
  creditLimitUnits?: string;
  serverSelectionTimeoutMS?: number;
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

export interface VersionedEvent {
  event: EventItem;
  revision: number;
}

export interface EventSettlementCredit {
  userId: string;
  units: string;
  reference: string;
}

export class MongoStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MongoStoreConflictError';
  }
}

const COLLECTIONS = {
  users: 'crypto_users',
  references: 'crypto_idempotency',
  withdrawals: 'crypto_withdrawals',
  events: 'crypto_events',
} as const;

// Decimal128 has 34 significant digits. Keeping every persisted integer at or
// below this exact ceiling prevents an update pipeline from silently rounding
// a ledger balance outside the integer domain.
const MAX_LEDGER_UNITS = 10n ** 34n - 1n;

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

function hashReference(externalUserId: string, reference: string): string {
  return createHash('sha256')
    .update(String(Buffer.byteLength(externalUserId, 'utf8')))
    .update(':')
    .update(externalUserId)
    .update('\0')
    .update(reference)
    .digest('hex');
}

function referenceDocument(
  externalUserId: string,
  reference: string,
  metadata: Pick<ReferenceDocument, 'operation' | 'requestedDeltaUnits'> = {},
): ReferenceDocument {
  const referenceHash = hashReference(externalUserId, reference);
  return {
    _id: `ref_${referenceHash}`,
    externalUserId,
    referenceHash,
    reference,
    ...metadata,
    createdAt: new Date(),
  };
}

function assertSameAdjustmentReference(
  document: ReferenceDocument,
  externalUserId: string,
  reference: string,
  deltaUnits: string,
): void {
  if (
    document.externalUserId !== externalUserId ||
    document.reference !== reference ||
    document.operation !== 'adjustment' ||
    document.requestedDeltaUnits !== deltaUnits
  ) {
    throw new MongoStoreConflictError(
      `adjustment reference ${reference} was already used with a different payload`,
    );
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === 11000 ||
    (typeof candidate.message === 'string' && candidate.message.includes('E11000'))
  );
}

function balanceUpdatePipeline(
  deltaUnits: string,
  floorUnits?: string,
): ReadonlyArray<Record<string, unknown>> {
  const nextDecimal = {
    $add: [{ $toDecimal: '$balanceUnits' }, { $toDecimal: deltaUnits }],
  };
  const balanceDecimal = floorUnits
    ? {
        $let: {
          vars: { next: nextDecimal },
          in: {
            $cond: [
              { $gte: ['$$next', { $toDecimal: floorUnits }] },
              '$$next',
              { $toDecimal: floorUnits },
            ],
          },
        },
      }
    : nextDecimal;

  return [
    {
      $set: {
        balanceUnits: { $toString: balanceDecimal },
        updatedAt: '$$NOW',
      },
    },
  ];
}

function withCreditHeadroom(
  filter: MongoFilter,
  deltaUnits: string,
): MongoFilter {
  const delta = requireIntegerString(deltaUnits, 'deltaUnits');
  if (delta <= 0n) return filter;
  return {
    ...filter,
    $expr: {
      $lte: [
        { $toDecimal: '$balanceUnits' },
        { $toDecimal: (MAX_LEDGER_UNITS - delta).toString() },
      ],
    },
  };
}

function eventFromDocument(document: EventDocument): EventItem {
  return {
    id: document.id,
    host: document.host,
    title: document.title,
    startsAt: document.startsAt,
    stakeUnits: document.stakeUnits,
    multiplierBps: document.multiplierBps,
    status: document.status,
    rsvps: document.rsvps.map((rsvp) => ({ ...rsvp })),
    createdAt: document.createdAt,
  };
}

function eventDocument(event: EventItem, revision: number): EventDocument {
  return {
    ...event,
    rsvps: event.rsvps.map((rsvp) => ({ ...rsvp })),
    _id: event.id,
    revision,
    updatedAt: new Date(),
  };
}

function withdrawalFromDocument(document: WithdrawalDocument): Withdrawal {
  return {
    id: document.id,
    transferId: document.transferId ?? '',
    amountUnits: document.amountUnits,
    destination: { ...document.destination },
    status: document.status,
    refunded: document.refunded,
    createdAt: document.createdAt,
  };
}

function sameDestination(
  left: Withdrawal['destination'],
  right: Withdrawal['destination'],
): boolean {
  return (
    left.chain_type === right.chain_type &&
    left.chain_id === right.chain_id &&
    left.token_address === right.token_address &&
    left.recipient_address === right.recipient_address
  );
}

/**
 * Atlas-backed implementation of the crypto ledger store.
 *
 * Balances remain integer strings at the API boundary. MongoDB Decimal128 is
 * used only inside update pipelines so balance changes are atomic and do not
 * lose precision to JavaScript numbers.
 */
export class MongoStore {
  private readonly db: MongoDbLike;
  private readonly users: MongoCollectionLike<UserDocument>;
  private readonly references: MongoCollectionLike<ReferenceDocument>;
  private readonly withdrawals: MongoCollectionLike<WithdrawalDocument>;
  private readonly events: MongoCollectionLike<EventDocument>;
  private readonly floorUnits: string;
  private readonly client?: MongoClientLike;
  private initializePromise?: Promise<void>;

  constructor(db: MongoDbLike, options: MongoStoreOptions = {}) {
    this.db = db;
    this.floorUnits = options.creditLimitUnits ?? process.env.CREDIT_LIMIT_UNITS ?? '0';
    requireIntegerString(this.floorUnits, 'creditLimitUnits');
    this.client = options.client;
    this.users = db.collection<UserDocument>(COLLECTIONS.users);
    this.references = db.collection<ReferenceDocument>(COLLECTIONS.references);
    this.withdrawals = db.collection<WithdrawalDocument>(COLLECTIONS.withdrawals);
    this.events = db.collection<EventDocument>(COLLECTIONS.events);
  }

  /** Create every required index. Safe to call on every process startup. */
  initialize(): Promise<void> {
    this.initializePromise ??= (async () => {
      await Promise.all([
        this.users.createIndexes([
          {
            key: { externalUserId: 1 },
            name: 'uniq_external_user_id',
            unique: true,
          },
        ]),
        this.references.createIndexes([
          {
            key: { externalUserId: 1, referenceHash: 1 },
            name: 'uniq_user_reference_hash',
            unique: true,
          },
          {
            key: { createdAt: 1 },
            name: 'idempotency_created_at',
          },
        ]),
        this.withdrawals.createIndexes([
          {
            key: { transferId: 1 },
            name: 'uniq_transfer_id',
            unique: true,
            // Reservations omit transferId until Unifold responds. Without a
            // partial index, multiple missing values would collide.
            partialFilterExpression: {
              transferId: { $type: 'string', $gt: '' },
            },
          },
          {
            key: { externalUserId: 1, createdAt: -1 },
            name: 'withdrawals_by_user',
          },
        ]),
        this.events.createIndexes([
          {
            key: { id: 1 },
            name: 'uniq_event_id',
            unique: true,
          },
          {
            key: { host: 1, createdAt: -1 },
            name: 'events_by_host',
          },
          {
            key: { 'rsvps.userId': 1, createdAt: -1 },
            name: 'events_by_rsvp_user',
          },
        ]),
      ]);
    })();
    return this.initializePromise;
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  async checkReady(): Promise<boolean> {
    if (!this.db.command) {
      throw new Error('MongoDB readiness command is unavailable');
    }
    await this.db.command(
      { ping: 1 },
      // maxTimeMS bounds server execution; timeoutMS also bounds driver-side
      // selection/network work in mongodb@7.
      { maxTimeMS: 1_500, timeoutMS: 2_000 },
    );
    return true;
  }

  async registerUser(externalUserId: string): Promise<User> {
    requireIdentifier(externalUserId, 'externalUserId');
    const now = new Date();
    const document = await this.users.findOneAndUpdate(
      { _id: externalUserId },
      {
        $setOnInsert: {
          _id: externalUserId,
          externalUserId,
          balanceUnits: '0',
          lastGrantPeriod: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true, returnDocument: 'after', includeResultMetadata: false },
    );
    if (!document) throw new Error('MongoDB did not return the registered user');
    return this.hydrateUser(document);
  }

  async getUser(externalUserId: string): Promise<User | undefined> {
    const document = await this.users.findOne({ _id: externalUserId });
    return document ? this.hydrateUser(document) : undefined;
  }

  async creditBalance(externalUserId: string, units: string): Promise<void> {
    requireNonNegativeIntegerString(units, 'units');
    const result = await this.users.updateOne(
      withCreditHeadroom({ _id: externalUserId }, units),
      balanceUpdatePipeline(units),
    );
    if (result.matchedCount !== 1) {
      const exists = await this.users.findOne({ _id: externalUserId }, { projection: { _id: 1 } });
      if (!exists) throw new Error('user not found');
      throw new RangeError('balance would exceed the supported ledger range');
    }
  }

  async debitBalance(externalUserId: string, units: string): Promise<void> {
    requireNonNegativeIntegerString(units, 'units');
    const result = await this.users.updateOne(
      {
        _id: externalUserId,
        $expr: {
          $gte: [{ $toDecimal: '$balanceUnits' }, { $toDecimal: units }],
        },
      },
      balanceUpdatePipeline(`-${units}`),
    );

    if (result.matchedCount === 0) {
      const exists = await this.users.findOne({ _id: externalUserId }, { projection: { _id: 1 } });
      if (exists) throw new Error('debitBalance would drive balance below 0');
    }
  }

  async adjustBalance(
    externalUserId: string,
    deltaUnits: string,
  ): Promise<BalanceAdjustmentResult> {
    return this.adjustBalanceInSession(externalUserId, deltaUnits);
  }

  async hasReference(externalUserId: string, reference: string): Promise<boolean> {
    const ref = referenceDocument(externalUserId, reference);
    const found = await this.references.findOne({
      externalUserId,
      referenceHash: ref.referenceHash,
      reference,
    });
    return found !== null;
  }

  async addReference(externalUserId: string, reference: string): Promise<void> {
    const exists = await this.users.findOne({ _id: externalUserId }, { projection: { _id: 1 } });
    if (!exists) return;
    try {
      await this.references.insertOne(
        referenceDocument(externalUserId, reference, { operation: 'legacy' }),
      );
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  }

  /**
   * Atomically apply a referenced adjustment exactly once. This replaces the
   * unsafe hasReference -> adjustBalance -> addReference sequence.
   */
  async applyAdjustment(
    externalUserId: string,
    deltaUnits: string,
    reference?: string,
  ): Promise<IdempotentAdjustmentResult> {
    requireIntegerString(deltaUnits, 'deltaUnits');
    if (!reference) {
      const adjusted = await this.adjustBalance(externalUserId, deltaUnits);
      return {
        alreadyApplied: false,
        ...adjusted,
        requestedDeltaUnits: deltaUnits,
        clamped: BigInt(adjusted.appliedUnits) !== BigInt(deltaUnits),
      };
    }

    try {
      return await this.withTransaction(async (session) => {
        const ref = referenceDocument(externalUserId, reference, {
          operation: 'adjustment',
          requestedDeltaUnits: deltaUnits,
        });
        const existing = await this.references.findOne(
          { _id: ref._id, reference },
          { session },
        );
        if (existing) {
          assertSameAdjustmentReference(existing, externalUserId, reference, deltaUnits);
          const user = await this.users.findOne({ _id: externalUserId }, { session });
          if (!user) throw new Error('user not found');
          return {
            alreadyApplied: true,
            balanceUnits: user.balanceUnits,
            appliedUnits: '0',
            requestedDeltaUnits: deltaUnits,
            clamped: false,
          };
        }

        const adjusted = await this.adjustBalanceInSession(
          externalUserId,
          deltaUnits,
          session,
        );
        await this.references.insertOne(ref, { session });
        return {
          alreadyApplied: false,
          ...adjusted,
          requestedDeltaUnits: deltaUnits,
          clamped: BigInt(adjusted.appliedUnits) !== BigInt(deltaUnits),
        };
      });
    } catch (error) {
      // A concurrent transaction may win the unique reference insert. Its
      // balance update committed; our transaction was rolled back.
      if (!isDuplicateKeyError(error)) throw error;
      const ref = referenceDocument(externalUserId, reference, {
        operation: 'adjustment',
        requestedDeltaUnits: deltaUnits,
      });
      const existing = await this.references.findOne({ _id: ref._id });
      if (!existing) throw error;
      assertSameAdjustmentReference(existing, externalUserId, reference, deltaUnits);
      const user = await this.getUser(externalUserId);
      if (!user) throw new Error('user not found');
      return {
        alreadyApplied: true,
        balanceUnits: user.balanceUnits,
        appliedUnits: '0',
        requestedDeltaUnits: deltaUnits,
        clamped: false,
      };
    }
  }

  async setGrantPeriod(externalUserId: string, period: string): Promise<void> {
    await this.users.updateOne(
      { _id: externalUserId },
      { $set: { lastGrantPeriod: period, updatedAt: new Date() } },
    );
  }

  /** Atomically claim a monthly grant and credit its units once. */
  async claimGrantPeriod(
    externalUserId: string,
    period: string,
    grantUnits: string,
  ): Promise<GrantClaimResult> {
    requireNonNegativeIntegerString(grantUnits, 'grantUnits');
    const before = await this.users.findOneAndUpdate(
      withCreditHeadroom(
        { _id: externalUserId, lastGrantPeriod: { $ne: period } },
        grantUnits,
      ),
      [
        ...balanceUpdatePipeline(grantUnits),
        { $set: { lastGrantPeriod: period } },
      ],
      { returnDocument: 'before', includeResultMetadata: false },
    );
    if (before) {
      return {
        alreadyGranted: false,
        balanceUnits: (BigInt(before.balanceUnits) + BigInt(grantUnits)).toString(),
      };
    }
    const existing = await this.users.findOne({ _id: externalUserId });
    if (!existing) throw new Error('user not found');
    if (existing.lastGrantPeriod !== period) {
      throw new RangeError('balance would exceed the supported ledger range');
    }
    return { alreadyGranted: true, balanceUnits: existing.balanceUnits };
  }

  /**
   * Atomically reserve a withdrawal and debit its balance exactly once.
   *
   * operationId must be stable across HTTP/provider retries and must also be
   * passed to Unifold as its idempotency key. A provider timeout must leave the
   * reservation in `reserved`; retry/reconcile it with the same operationId.
   * Only refund after an authoritative provider `failed` result.
   */
  async reserveWithdrawal(
    externalUserId: string,
    operationId: string,
    amountUnits: string,
    destination: Withdrawal['destination'],
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
      const existing = await this.withdrawals.findOne({ _id: operationId });
      if (!existing) return undefined;
      this.assertSameWithdrawalOperation(existing, externalUserId, amountUnits, destination);
      const user = await this.users.findOne({ _id: externalUserId });
      if (!user) throw new Error('user not found');
      return {
        created: false,
        withdrawalId: existing.id,
        transferId: existing.transferId ?? null,
        status: existing.status,
        amountUnits: existing.amountUnits,
        balanceUnits: user.balanceUnits,
      };
    };

    const existing = await readExisting();
    if (existing) return existing;

    try {
      return await this.withTransaction(async (session) => {
        const raced = await this.withdrawals.findOne({ _id: operationId }, { session });
        if (raced) {
          this.assertSameWithdrawalOperation(raced, externalUserId, amountUnits, destination);
          const user = await this.users.findOne({ _id: externalUserId }, { session });
          if (!user) throw new Error('user not found');
          return {
            created: false,
            withdrawalId: raced.id,
            transferId: raced.transferId ?? null,
            status: raced.status,
            amountUnits: raced.amountUnits,
            balanceUnits: user.balanceUnits,
          };
        }

        await this.debitBalanceInSession(externalUserId, amountUnits, session);
        const now = new Date();
        await this.withdrawals.insertOne(
          {
            _id: operationId,
            id: operationId,
            externalUserId,
            amountUnits,
            destination: { ...destination },
            status: 'reserved',
            refunded: false,
            createdAt: now.toISOString(),
            updatedAt: now,
          },
          { session },
        );
        const user = await this.users.findOne({ _id: externalUserId }, { session });
        if (!user) throw new Error('user not found after withdrawal reservation');
        return {
          created: true,
          withdrawalId: operationId,
          transferId: null,
          status: 'reserved',
          amountUnits,
          balanceUnits: user.balanceUnits,
        };
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await readExisting();
      if (!raced) throw error;
      return raced;
    }
  }

  /** Attach the provider transfer to its reservation without allowing reassignment. */
  async attachWithdrawalTransfer(
    operationId: string,
    transferId: string,
    status: string,
  ): Promise<{ user: User; withdrawal: Withdrawal }> {
    requireIdentifier(operationId, 'operationId');
    requireIdentifier(transferId, 'transferId');
    const updated = await this.withdrawals.findOneAndUpdate(
      {
        _id: operationId,
        $or: [
          { transferId: { $exists: false } },
          { transferId, status: 'reserved' },
        ],
      },
      { $set: { transferId, status, updatedAt: new Date() } },
      { returnDocument: 'after', includeResultMetadata: false },
    );
    if (!updated) {
      const existing = await this.withdrawals.findOne({ _id: operationId });
      if (!existing) throw new Error('withdrawal reservation not found');
      if (existing.transferId !== transferId) {
        throw new MongoStoreConflictError(
          `withdrawal ${operationId} is already attached to another transfer`,
        );
      }
      return this.hydrateWithdrawal(existing);
    }
    return this.hydrateWithdrawal(updated);
  }

  async addWithdrawal(externalUserId: string, withdrawal: Withdrawal): Promise<void> {
    const user = await this.users.findOne({ _id: externalUserId }, { projection: { _id: 1 } });
    if (!user) return;
    const document: WithdrawalDocument = {
      ...withdrawal,
      destination: { ...withdrawal.destination },
      _id: withdrawal.id,
      externalUserId,
      updatedAt: new Date(),
    };
    if (!document.transferId) delete document.transferId;
    await this.withdrawals.insertOne(document);
  }

  async getWithdrawal(
    withdrawalId: string,
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined> {
    const document = await this.withdrawals.findOne({ _id: withdrawalId });
    return document ? this.hydrateWithdrawal(document) : undefined;
  }

  async getWithdrawalByTransferId(
    transferId: string,
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined> {
    const document = await this.withdrawals.findOne({ transferId });
    return document ? this.hydrateWithdrawal(document) : undefined;
  }

  async updateWithdrawal(
    withdrawalId: string,
    patch: Partial<Withdrawal>,
  ): Promise<void> {
    const allowed: Partial<WithdrawalDocument> = {};
    if (patch.transferId !== undefined) allowed.transferId = patch.transferId;
    if (patch.amountUnits !== undefined) allowed.amountUnits = patch.amountUnits;
    if (patch.destination !== undefined) allowed.destination = { ...patch.destination };
    if (patch.status !== undefined) allowed.status = patch.status;
    if (patch.refunded !== undefined) allowed.refunded = patch.refunded;
    if (patch.createdAt !== undefined) allowed.createdAt = patch.createdAt;
    await this.withdrawals.updateOne(
      { _id: withdrawalId },
      { $set: { ...allowed, updatedAt: new Date() } },
    );
  }

  /** Atomically mark a failed withdrawal refunded and restore its balance once. */
  async refundWithdrawal(
    withdrawalId: string,
    status = 'failed',
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined> {
    return this.withTransaction(async (session) => {
      const before = await this.withdrawals.findOneAndUpdate(
        { _id: withdrawalId, refunded: false, status: { $ne: 'completed' } },
        { $set: { refunded: true, status, updatedAt: new Date() } },
        { session, returnDocument: 'before', includeResultMetadata: false },
      );
      if (!before) {
        const existing = await this.withdrawals.findOne({ _id: withdrawalId }, { session });
        return existing ? this.hydrateWithdrawal(existing, session) : undefined;
      }
      await this.creditBalanceInSession(before.externalUserId, before.amountUnits, session);
      const updated: WithdrawalDocument = {
        ...before,
        refunded: true,
        status,
        updatedAt: new Date(),
      };
      return this.hydrateWithdrawal(updated, session);
    });
  }

  /**
   * Mark a provider-confirmed withdrawal completed without allowing a late,
   * contradictory completion webhook to reverse an earlier failure/refund.
   */
  async completeWithdrawal(
    withdrawalId: string,
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined> {
    const updated = await this.withdrawals.findOneAndUpdate(
      {
        _id: withdrawalId,
        refunded: false,
        status: { $ne: 'failed' },
      },
      { $set: { status: 'completed', updatedAt: new Date() } },
      { returnDocument: 'after', includeResultMetadata: false },
    );
    if (updated) return this.hydrateWithdrawal(updated);

    // Idempotently return the durable state for duplicate or contradictory
    // deliveries without mutating a failed/refunded withdrawal.
    const existing = await this.withdrawals.findOne({ _id: withdrawalId });
    return existing ? this.hydrateWithdrawal(existing) : undefined;
  }

  async createEvent(event: EventItem): Promise<EventItem> {
    await this.events.insertOne(eventDocument(event, 0));
    return eventFromDocument(eventDocument(event, 0));
  }

  async getEvent(id: string): Promise<EventItem | undefined> {
    const document = await this.events.findOne({ _id: id });
    return document ? eventFromDocument(document) : undefined;
  }

  async getVersionedEvent(id: string): Promise<VersionedEvent | undefined> {
    const document = await this.events.findOne({ _id: id });
    return document
      ? { event: eventFromDocument(document), revision: document.revision }
      : undefined;
  }

  /**
   * Persist one event with optimistic concurrency. Callers must keep the
   * revision returned by getVersionedEvent; stale writes fail instead of
   * silently overwriting another RSVP/check-in.
   */
  async saveEvent(event: EventItem, expectedRevision: number): Promise<number> {
    const nextRevision = expectedRevision + 1;
    const result = await this.events.replaceOne(
      { _id: event.id, revision: expectedRevision },
      eventDocument(event, nextRevision),
    );
    if (result.matchedCount !== 1) {
      throw new MongoStoreConflictError(`event ${event.id} changed concurrently`);
    }
    return nextRevision;
  }

  async eventsForUser(userId: string): Promise<EventItem[]> {
    const documents = await this.events
      .find(
        { $or: [{ host: userId }, { 'rsvps.userId': userId }] },
        { sort: { createdAt: -1 } },
      )
      .toArray();
    return documents.map(eventFromDocument);
  }

  /** Atomically debit a user's stake and append their RSVP to an open event. */
  async stakeRsvp(eventId: string, userId: string): Promise<EventItem> {
    return this.withTransaction(async (session) => {
      const event = await this.events.findOne({ _id: eventId }, { session });
      if (!event) throw new Error('event not found');
      if (event.status !== 'open') throw new Error('event is not open for RSVPs');
      if (event.rsvps.some((rsvp) => rsvp.userId === userId)) {
        throw new Error('user already RSVP’d');
      }

      // Stakes respect the configured internal-ledger credit floor. Cash-out
      // reservations intentionally keep using this helper's hard-zero default,
      // so borrowed/internal credit can never be withdrawn as real funds.
      await this.debitBalanceInSession(
        userId,
        event.stakeUnits,
        session,
        this.floorUnits,
      );
      const rsvp: Rsvp = {
        userId,
        stakedUnits: event.stakeUnits,
        status: 'staked',
        payoutUnits: '0',
      };
      const result = await this.events.updateOne(
        {
          _id: eventId,
          status: 'open',
          revision: event.revision,
          'rsvps.userId': { $ne: userId },
        },
        {
          $push: { rsvps: rsvp },
          $inc: { revision: 1 },
          $set: { updatedAt: new Date() },
        },
        { session },
      );
      if (result.matchedCount !== 1) {
        throw new MongoStoreConflictError(`event ${eventId} changed concurrently`);
      }
      const updated = await this.events.findOne({ _id: eventId }, { session });
      if (!updated) throw new Error('event disappeared after RSVP');
      return eventFromDocument(updated);
    });
  }

  /** Atomically mark a staked RSVP attended. */
  async checkInRsvp(eventId: string, userId: string): Promise<EventItem> {
    const document = await this.events.findOneAndUpdate(
      {
        _id: eventId,
        status: 'open',
        rsvps: { $elemMatch: { userId, status: 'staked' } },
      },
      {
        $set: {
          'rsvps.$.status': 'attended',
          updatedAt: new Date(),
        },
        $inc: { revision: 1 },
      },
      { returnDocument: 'after', includeResultMetadata: false },
    );
    if (!document) throw new MongoStoreConflictError('RSVP is not available for check-in');
    return eventFromDocument(document);
  }

  /**
   * Atomically commit every settlement credit and the final event state.
   * Callers calculate payouts from getVersionedEvent(), then submit the same
   * expected revision here. A stale snapshot aborts without changing balances.
   */
  async commitEventSettlement(
    settledEvent: EventItem,
    expectedRevision: number,
    credits: ReadonlyArray<EventSettlementCredit>,
  ): Promise<EventItem> {
    if (settledEvent.status !== 'settled') {
      throw new TypeError('settledEvent.status must be settled');
    }
    return this.withTransaction(async (session) => {
      const current = await this.events.findOne({ _id: settledEvent.id }, { session });
      if (!current) throw new Error('event not found');
      if (current.status === 'settled') return eventFromDocument(current);
      if (current.revision !== expectedRevision) {
        throw new MongoStoreConflictError(
          `event ${settledEvent.id} changed concurrently`,
        );
      }

      for (const credit of credits) {
        requireIdentifier(credit.userId, 'credit.userId');
        requireIdentifier(credit.reference, 'credit.reference');
        if (requireNonNegativeIntegerString(credit.units, 'credit.units') === 0n) continue;
        const ref = referenceDocument(credit.userId, credit.reference, {
          operation: 'settlement',
        });
        const alreadyApplied = await this.references.findOne({ _id: ref._id }, { session });
        if (alreadyApplied) {
          throw new Error(
            `settlement reference ${credit.reference} exists while event is still open`,
          );
        }
        await this.creditBalanceInSession(credit.userId, credit.units, session);
        await this.references.insertOne(ref, { session });
      }

      const next = eventDocument(settledEvent, expectedRevision + 1);
      const result = await this.events.replaceOne(
        { _id: settledEvent.id, revision: expectedRevision, status: 'open' },
        next,
        { session },
      );
      if (result.matchedCount !== 1) {
        throw new MongoStoreConflictError(
          `event ${settledEvent.id} changed concurrently`,
        );
      }
      return eventFromDocument(next);
    });
  }

  private async hydrateUser(
    document: UserDocument,
    session?: MongoSessionLike,
  ): Promise<User> {
    const withdrawalDocuments = await this.withdrawals
      .find(
        { externalUserId: document.externalUserId },
        { session, sort: { createdAt: 1 } },
      )
      .toArray();
    return {
      externalUserId: document.externalUserId,
      balanceUnits: document.balanceUnits,
      lastGrantPeriod: document.lastGrantPeriod,
      withdrawals: withdrawalDocuments.map(withdrawalFromDocument),
      references: [],
    };
  }

  private async hydrateWithdrawal(
    document: WithdrawalDocument,
    session?: MongoSessionLike,
  ): Promise<{ user: User; withdrawal: Withdrawal }> {
    const userDocument = await this.users.findOne(
      { _id: document.externalUserId },
      { session },
    );
    if (!userDocument) {
      throw new Error(`withdrawal ${document.id} references a missing user`);
    }
    return {
      user: await this.hydrateUser(userDocument, session),
      withdrawal: withdrawalFromDocument(document),
    };
  }

  private async adjustBalanceInSession(
    externalUserId: string,
    deltaUnits: string,
    session?: MongoSessionLike,
  ): Promise<BalanceAdjustmentResult> {
    requireIntegerString(deltaUnits, 'deltaUnits');
    const before = await this.users.findOneAndUpdate(
      withCreditHeadroom({ _id: externalUserId }, deltaUnits),
      balanceUpdatePipeline(deltaUnits, this.floorUnits),
      { session, returnDocument: 'before', includeResultMetadata: false },
    );
    if (!before) {
      const exists = await this.users.findOne({ _id: externalUserId }, { session });
      if (!exists) throw new Error('user not found');
      throw new RangeError('balance would exceed the supported ledger range');
    }
    const oldBalance = BigInt(before.balanceUnits);
    const requested = oldBalance + BigInt(deltaUnits);
    const floor = BigInt(this.floorUnits);
    const next = requested < floor ? floor : requested;
    return {
      balanceUnits: next.toString(),
      appliedUnits: (next - oldBalance).toString(),
    };
  }

  private async creditBalanceInSession(
    externalUserId: string,
    units: string,
    session: MongoSessionLike,
  ): Promise<void> {
    requireNonNegativeIntegerString(units, 'units');
    const result = await this.users.updateOne(
      withCreditHeadroom({ _id: externalUserId }, units),
      balanceUpdatePipeline(units),
      { session },
    );
    if (result.matchedCount !== 1) {
      const exists = await this.users.findOne({ _id: externalUserId }, { session });
      if (!exists) throw new Error('user not found');
      throw new RangeError('balance would exceed the supported ledger range');
    }
  }

  private async debitBalanceInSession(
    externalUserId: string,
    units: string,
    session: MongoSessionLike,
    floorUnits = '0',
  ): Promise<void> {
    requireNonNegativeIntegerString(units, 'units');
    requireIntegerString(floorUnits, 'floorUnits');
    const result = await this.users.updateOne(
      {
        _id: externalUserId,
        $expr: {
          $gte: [
            {
              $subtract: [
                { $toDecimal: '$balanceUnits' },
                { $toDecimal: units },
              ],
            },
            { $toDecimal: floorUnits },
          ],
        },
      },
      balanceUpdatePipeline(`-${units}`),
      { session },
    );
    if (result.matchedCount !== 1) {
      const exists = await this.users.findOne({ _id: externalUserId }, { session });
      if (!exists) throw new Error('user not found');
      throw new Error(`debitBalance would drive balance below ${floorUnits}`);
    }
  }

  private assertSameWithdrawalOperation(
    document: WithdrawalDocument,
    externalUserId: string,
    amountUnits: string,
    destination: Withdrawal['destination'],
  ): void {
    if (
      document.externalUserId !== externalUserId ||
      document.amountUnits !== amountUnits ||
      !sameDestination(document.destination, destination)
    ) {
      throw new MongoStoreConflictError(
        `withdrawal operation ${document.id} was reused with a different payload`,
      );
    }
  }

  private async withTransaction<T>(
    operation: (session: MongoSessionLike) => Promise<T>,
  ): Promise<T> {
    if (!this.client) {
      throw new Error('this operation requires a MongoClient for transaction support');
    }
    const session = this.client.startSession();
    try {
      return await session.withTransaction(
        () => operation(session),
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
        },
      );
    } finally {
      await session.endSession();
    }
  }
}

export async function connectMongoStore(
  options: MongoStoreConnectionOptions,
): Promise<MongoStore> {
  if (!options.uri || options.uri.trim() === '') throw new Error('MONGODB_URI is required');
  if (!options.dbName || options.dbName.trim() === '') {
    throw new Error('MONGODB_DB_NAME is required');
  }
  const client = new MongoClient(options.uri, {
    appName: 'ht6-unifold-crypto',
    retryWrites: true,
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 10_000,
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  });
  await client.connect();
  const store = new MongoStore(client.db(options.dbName) as unknown as MongoDbLike, {
    client: client as unknown as MongoClientLike,
    creditLimitUnits: options.creditLimitUnits,
  });
  try {
    await store.initialize();
    return store;
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function connectMongoStoreFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<MongoStore> {
  const uri = env.MONGODB_URI?.trim();
  const dbName = env.MONGODB_DB_NAME?.trim();
  if (!uri) throw new Error('MONGODB_URI is required');
  if (!dbName) throw new Error('MONGODB_DB_NAME is required');
  return connectMongoStore({
    uri,
    dbName,
    creditLimitUnits: env.CREDIT_LIMIT_UNITS,
  });
}
