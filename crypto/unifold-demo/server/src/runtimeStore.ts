import { CREDIT_LIMIT_UNITS } from './config.js';
import {
  MongoStore,
  MongoStoreConflictError,
  connectMongoStoreFromEnv,
  type EventSettlementCredit,
  type GrantClaimResult,
  type IdempotentAdjustmentResult,
  type VersionedEvent,
  type WithdrawalReservationResult,
} from './mongoStore.js';
import * as json from './store.js';
import type { EventItem, User, Withdrawal } from './store.js';

export type StoreBackend = 'mongodb' | 'json';
export type StoreState =
  | 'uninitialized'
  | 'initializing'
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'closed';

export interface CryptoStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  checkReady(): Promise<boolean>;
  registerUser(externalUserId: string): Promise<User>;
  getUser(externalUserId: string): Promise<User | undefined>;
  creditBalance(externalUserId: string, units: string): Promise<void>;
  debitBalance(externalUserId: string, units: string): Promise<void>;
  applyAdjustment(
    externalUserId: string,
    deltaUnits: string,
    reference?: string,
  ): Promise<IdempotentAdjustmentResult>;
  claimGrantPeriod(
    externalUserId: string,
    period: string,
    grantUnits: string,
  ): Promise<GrantClaimResult>;
  reserveWithdrawal(
    externalUserId: string,
    operationId: string,
    amountUnits: string,
    destination: Withdrawal['destination'],
  ): Promise<WithdrawalReservationResult>;
  attachWithdrawalTransfer(
    operationId: string,
    transferId: string,
    status: string,
  ): Promise<{ user: User; withdrawal: Withdrawal }>;
  getWithdrawal(
    withdrawalId: string,
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined>;
  getWithdrawalByTransferId(
    transferId: string,
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined>;
  updateWithdrawal(withdrawalId: string, patch: Partial<Withdrawal>): Promise<void>;
  refundWithdrawal(
    withdrawalId: string,
    status?: string,
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined>;
  completeWithdrawal(
    withdrawalId: string,
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined>;
  createEvent(event: EventItem): Promise<EventItem>;
  getEvent(id: string): Promise<EventItem | undefined>;
  getVersionedEvent(id: string): Promise<VersionedEvent | undefined>;
  eventsForUser(userId: string): Promise<EventItem[]>;
  stakeRsvp(eventId: string, userId: string): Promise<EventItem>;
  checkInRsvp(eventId: string, userId: string): Promise<EventItem>;
  commitEventSettlement(
    settledEvent: EventItem,
    expectedRevision: number,
    credits: ReadonlyArray<EventSettlementCredit>,
  ): Promise<EventItem>;
}

export interface StoreReadiness {
  state: StoreState;
  backend: StoreBackend | 'unconfigured';
  error?: string;
}

function requireIntegerString(value: string, name: string): bigint {
  if (!/^-?(0|[1-9]\d*)$/.test(value) || value === '-0') {
    throw new TypeError(`${name} must be a canonical integer string`);
  }
  if (value.replace('-', '').length > 34) {
    throw new RangeError(`${name} exceeds MongoDB Decimal128's 34-digit precision`);
  }
  return BigInt(value);
}

function requirePositiveIntegerString(value: string, name: string): bigint {
  const parsed = requireIntegerString(value, name);
  if (parsed <= 0n) throw new RangeError(`${name} must be positive`);
  return parsed;
}

function requireIdentifier(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required`);
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
 * Compatibility adapter for deliberate local/test use. It serializes every
 * compound mutation within one process. The JSON files are still not safe for
 * multiple replicas or crash-atomic cross-file writes, which is why production
 * selection is rejected below.
 */
class JsonStore implements CryptoStore {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly revisions = new Map<string, number>();
  private readonly adjustmentPayloads = new Map<string, string>();

  async initialize(): Promise<void> {
    json.initializeJsonStore();
  }

  async close(): Promise<void> {}

  async checkReady(): Promise<boolean> {
    return true;
  }

  async registerUser(externalUserId: string): Promise<User> {
    requireIdentifier(externalUserId, 'externalUserId');
    return this.mutate(() => json.registerUser(externalUserId));
  }

  async getUser(externalUserId: string): Promise<User | undefined> {
    return json.getUser(externalUserId);
  }

  async creditBalance(externalUserId: string, units: string): Promise<void> {
    if (requireIntegerString(units, 'units') < 0n) throw new RangeError('units must be non-negative');
    await this.mutate(() => json.creditBalance(externalUserId, units));
  }

  async debitBalance(externalUserId: string, units: string): Promise<void> {
    if (requireIntegerString(units, 'units') < 0n) throw new RangeError('units must be non-negative');
    await this.mutate(() => json.debitBalance(externalUserId, units));
  }

  async applyAdjustment(
    externalUserId: string,
    deltaUnits: string,
    reference?: string,
  ): Promise<IdempotentAdjustmentResult> {
    requireIntegerString(deltaUnits, 'deltaUnits');
    return this.mutate(() => {
      const user = json.getUser(externalUserId);
      if (!user) throw new Error('user not found');
      if (reference && json.hasReference(externalUserId, reference)) {
        const payload = this.adjustmentPayloads.get(`${externalUserId}\0${reference}`);
        if (payload !== undefined && payload !== deltaUnits) {
          throw new MongoStoreConflictError(
            `adjustment reference ${reference} was already used with a different payload`,
          );
        }
        return {
          alreadyApplied: true,
          balanceUnits: user.balanceUnits,
          appliedUnits: '0',
          requestedDeltaUnits: deltaUnits,
          clamped: false,
        };
      }
      const adjusted = json.adjustBalance(externalUserId, deltaUnits);
      if (reference) {
        json.addReference(externalUserId, reference);
        this.adjustmentPayloads.set(`${externalUserId}\0${reference}`, deltaUnits);
      }
      return {
        alreadyApplied: false,
        ...adjusted,
        requestedDeltaUnits: deltaUnits,
        clamped: BigInt(adjusted.appliedUnits) !== BigInt(deltaUnits),
      };
    });
  }

  async claimGrantPeriod(
    externalUserId: string,
    period: string,
    grantUnits: string,
  ): Promise<GrantClaimResult> {
    if (requireIntegerString(grantUnits, 'grantUnits') < 0n) {
      throw new RangeError('grantUnits must be non-negative');
    }
    return this.mutate(() => {
      const user = json.getUser(externalUserId);
      if (!user) throw new Error('user not found');
      if (user.lastGrantPeriod === period) {
        return { alreadyGranted: true, balanceUnits: user.balanceUnits };
      }
      json.creditBalance(externalUserId, grantUnits);
      json.setGrantPeriod(externalUserId, period);
      return {
        alreadyGranted: false,
        balanceUnits: json.getUser(externalUserId)!.balanceUnits,
      };
    });
  }

  async reserveWithdrawal(
    externalUserId: string,
    operationId: string,
    amountUnits: string,
    destination: Withdrawal['destination'],
  ): Promise<WithdrawalReservationResult> {
    requireIdentifier(externalUserId, 'externalUserId');
    requireIdentifier(operationId, 'operationId');
    requirePositiveIntegerString(amountUnits, 'amountUnits');
    return this.mutate(() => {
      const existing = json.getWithdrawal(operationId);
      if (existing) {
        if (
          existing.user.externalUserId !== externalUserId ||
          existing.withdrawal.amountUnits !== amountUnits ||
          !sameDestination(existing.withdrawal.destination, destination)
        ) {
          throw new MongoStoreConflictError(
            `withdrawal operation ${operationId} was reused with a different payload`,
          );
        }
        return {
          created: false,
          withdrawalId: existing.withdrawal.id,
          transferId: existing.withdrawal.transferId || null,
          status: existing.withdrawal.status,
          amountUnits: existing.withdrawal.amountUnits,
          balanceUnits: existing.user.balanceUnits,
        };
      }
      const user = json.getUser(externalUserId);
      if (!user) throw new Error('user not found');
      json.debitBalance(externalUserId, amountUnits);
      const withdrawal: Withdrawal = {
        id: operationId,
        transferId: '',
        amountUnits,
        destination: { ...destination },
        status: 'reserved',
        refunded: false,
        createdAt: new Date().toISOString(),
      };
      json.addWithdrawal(externalUserId, withdrawal);
      return {
        created: true,
        withdrawalId: operationId,
        transferId: null,
        status: 'reserved',
        amountUnits,
        balanceUnits: json.getUser(externalUserId)!.balanceUnits,
      };
    });
  }

  async attachWithdrawalTransfer(
    operationId: string,
    transferId: string,
    status: string,
  ): Promise<{ user: User; withdrawal: Withdrawal }> {
    return this.mutate(() => {
      const found = json.getWithdrawal(operationId);
      if (!found) throw new Error('withdrawal reservation not found');
      if (found.withdrawal.transferId && found.withdrawal.transferId !== transferId) {
        throw new MongoStoreConflictError(
          `withdrawal ${operationId} is already attached to another transfer`,
        );
      }
      json.updateWithdrawal(operationId, { transferId, status });
      return json.getWithdrawal(operationId)!;
    });
  }

  async getWithdrawal(
    withdrawalId: string,
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined> {
    return json.getWithdrawal(withdrawalId);
  }

  async getWithdrawalByTransferId(
    transferId: string,
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined> {
    return json.getWithdrawalByTransferId(transferId);
  }

  async updateWithdrawal(withdrawalId: string, patch: Partial<Withdrawal>): Promise<void> {
    await this.mutate(() => json.updateWithdrawal(withdrawalId, patch));
  }

  async refundWithdrawal(
    withdrawalId: string,
    status = 'failed',
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined> {
    return this.mutate(() => {
      const found = json.getWithdrawal(withdrawalId);
      if (!found) return undefined;
      if (!found.withdrawal.refunded && found.withdrawal.status !== 'completed') {
        json.updateWithdrawal(withdrawalId, { refunded: true, status });
        json.creditBalance(found.user.externalUserId, found.withdrawal.amountUnits);
      }
      return json.getWithdrawal(withdrawalId);
    });
  }

  async completeWithdrawal(
    withdrawalId: string,
  ): Promise<{ user: User; withdrawal: Withdrawal } | undefined> {
    return this.mutate(() => {
      const found = json.getWithdrawal(withdrawalId);
      if (!found) return undefined;
      if (!found.withdrawal.refunded && found.withdrawal.status !== 'failed') {
        json.updateWithdrawal(withdrawalId, { status: 'completed' });
      }
      return json.getWithdrawal(withdrawalId);
    });
  }

  async createEvent(event: EventItem): Promise<EventItem> {
    return this.mutate(() => {
      const created = json.createEvent(event);
      this.revisions.set(event.id, 0);
      return created;
    });
  }

  async getEvent(id: string): Promise<EventItem | undefined> {
    return json.getEvent(id);
  }

  async getVersionedEvent(id: string): Promise<VersionedEvent | undefined> {
    const event = json.getEvent(id);
    return event
      ? { event: structuredClone(event), revision: this.revisions.get(id) ?? 0 }
      : undefined;
  }

  async eventsForUser(userId: string): Promise<EventItem[]> {
    return json.eventsForUser(userId);
  }

  async stakeRsvp(eventId: string, userId: string): Promise<EventItem> {
    return this.mutate(() => {
      const event = json.getEvent(eventId);
      if (!event) throw new Error('event not found');
      if (event.status !== 'open') throw new Error('event is not open for RSVPs');
      if (event.rsvps.some((rsvp) => rsvp.userId === userId)) {
        throw new Error('user already RSVP’d');
      }
      if (!json.getUser(userId)) throw new Error('user not found');
      const next = BigInt(json.getUser(userId)!.balanceUnits) - BigInt(event.stakeUnits);
      if (next < BigInt(CREDIT_LIMIT_UNITS)) {
        throw new Error(`debitBalance would drive balance below ${CREDIT_LIMIT_UNITS}`);
      }
      // The legacy debit helper enforces zero. Negative local credit limits are
      // intentionally unsupported by the fallback; MongoDB owns that feature.
      json.debitBalance(userId, event.stakeUnits);
      event.rsvps.push({
        userId,
        stakedUnits: event.stakeUnits,
        status: 'staked',
        payoutUnits: '0',
      });
      json.saveEvents();
      this.bumpRevision(eventId);
      return event;
    });
  }

  async checkInRsvp(eventId: string, userId: string): Promise<EventItem> {
    return this.mutate(() => {
      const event = json.getEvent(eventId);
      if (!event) throw new Error('event not found');
      if (event.status !== 'open') throw new MongoStoreConflictError('event already settled');
      const rsvp = event.rsvps.find(
        (candidate) => candidate.userId === userId && candidate.status === 'staked',
      );
      if (!rsvp) throw new MongoStoreConflictError('RSVP is not available for check-in');
      rsvp.status = 'attended';
      json.saveEvents();
      this.bumpRevision(eventId);
      return event;
    });
  }

  async commitEventSettlement(
    settledEvent: EventItem,
    expectedRevision: number,
    credits: ReadonlyArray<EventSettlementCredit>,
  ): Promise<EventItem> {
    return this.mutate(() => {
      const current = json.getEvent(settledEvent.id);
      if (!current) throw new Error('event not found');
      if (current.status === 'settled') return current;
      if ((this.revisions.get(settledEvent.id) ?? 0) !== expectedRevision) {
        throw new MongoStoreConflictError(`event ${settledEvent.id} changed concurrently`);
      }
      for (const credit of credits) {
        if (json.hasReference(credit.userId, credit.reference)) {
          throw new Error(
            `settlement reference ${credit.reference} exists while event is still open`,
          );
        }
        json.creditBalance(credit.userId, credit.units);
        json.addReference(credit.userId, credit.reference);
      }
      Object.assign(current, structuredClone(settledEvent));
      json.saveEvents();
      this.revisions.set(settledEvent.id, expectedRevision + 1);
      return current;
    });
  }

  private bumpRevision(eventId: string): void {
    this.revisions.set(eventId, (this.revisions.get(eventId) ?? 0) + 1);
  }

  private mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

let activeStore: CryptoStore | undefined;
let initializationPromise: Promise<CryptoStore> | undefined;
let state: StoreState = 'uninitialized';
let failureMessage: string | undefined;
let testStore: CryptoStore | undefined;

function configuredBackend(env: NodeJS.ProcessEnv = process.env): StoreBackend | 'unconfigured' {
  const value = env.CRYPTO_STORE_BACKEND?.trim().toLowerCase();
  return value === 'mongodb' || value === 'json' ? value : 'unconfigured';
}

export function selectStoreBackend(env: NodeJS.ProcessEnv = process.env): StoreBackend {
  const raw = env.CRYPTO_STORE_BACKEND?.trim().toLowerCase();
  if (!raw) {
    throw new Error('CRYPTO_STORE_BACKEND is required; use mongodb in production or explicit json for local/test');
  }
  if (raw !== 'mongodb' && raw !== 'json') {
    throw new Error(`Unsupported CRYPTO_STORE_BACKEND ${raw}`);
  }
  if (raw === 'json' && env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new Error('CRYPTO_STORE_BACKEND=json is allowed only when NODE_ENV is development or test');
  }
  if (env.NODE_ENV === 'production' && raw !== 'mongodb') {
    throw new Error('Production requires CRYPTO_STORE_BACKEND=mongodb');
  }
  return raw;
}

export function initializeStore(): Promise<CryptoStore> {
  if (activeStore && state === 'ready') return Promise.resolve(activeStore);
  if (initializationPromise) return initializationPromise;

  state = 'initializing';
  failureMessage = undefined;
  initializationPromise = (async () => {
    const backend = selectStoreBackend();
    const store: CryptoStore =
      backend === 'mongodb' ? await connectMongoStoreFromEnv() : new JsonStore();
    // connectMongoStoreFromEnv initializes indexes itself. Calling initialize
    // again is safe and keeps the lifecycle contract uniform for both stores.
    await store.initialize();
    activeStore = store;
    state = 'ready';
    return store;
  })().catch((error: unknown) => {
    state = 'failed';
    failureMessage = error instanceof Error ? error.message : String(error);
    initializationPromise = undefined;
    throw error;
  });
  return initializationPromise;
}

export function getStore(): CryptoStore {
  if (testStore) return testStore;
  if (!activeStore || state !== 'ready') {
    throw new Error('crypto datastore is not ready');
  }
  return activeStore;
}

export function getStoreReadiness(): StoreReadiness {
  return {
    state,
    backend: configuredBackend(),
    ...(failureMessage ? { error: failureMessage } : {}),
  };
}

export async function isStoreReady(): Promise<boolean> {
  if ((state !== 'ready' && state !== 'degraded') || !activeStore) return false;
  try {
    const ready = await activeStore.checkReady();
    state = ready ? 'ready' : 'degraded';
    if (ready) failureMessage = undefined;
    return ready;
  } catch (error) {
    state = 'degraded';
    failureMessage = error instanceof Error ? error.message : String(error);
    return false;
  }
}

export async function closeStore(): Promise<void> {
  const pending = initializationPromise;
  let store = activeStore;
  if (!store && pending) {
    try {
      store = await pending;
    } catch {
      // Failed initialization already closes the Mongo client in its connector.
    }
  }
  activeStore = undefined;
  initializationPromise = undefined;
  testStore = undefined;
  state = 'closed';
  if (store) await store.close();
}

export function setStoreForTests(store: CryptoStore): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setStoreForTests is available only when NODE_ENV=test');
  }
  testStore = store;
}

export function resetStoreForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStoreForTests is available only when NODE_ENV=test');
  }
  testStore = undefined;
}

export { MongoStore };
