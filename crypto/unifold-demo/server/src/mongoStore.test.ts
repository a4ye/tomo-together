import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventItem } from './store.js';
import {
  MongoStore,
  MongoStoreConflictError,
  connectMongoStoreFromEnv,
  type MongoDbLike,
} from './mongoStore.js';

type Call = {
  collection: string;
  method: string;
  args: unknown[];
};

interface ScriptedCollection {
  createIndexes(...args: unknown[]): Promise<unknown>;
  findOne(...args: unknown[]): Promise<unknown>;
  findOneAndUpdate(...args: unknown[]): Promise<unknown>;
  updateOne(...args: unknown[]): Promise<unknown>;
  replaceOne(...args: unknown[]): Promise<unknown>;
  insertOne(...args: unknown[]): Promise<unknown>;
  find(...args: unknown[]): { toArray(): Promise<unknown[]> };
}

function scriptedDb(responses: Map<string, unknown[]> = new Map()): {
  db: MongoDbLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const response = (collection: string, method: string, fallback: unknown): unknown => {
    const queue = responses.get(`${collection}.${method}`);
    return queue && queue.length > 0 ? queue.shift() : fallback;
  };
  const collection = (name: string): ScriptedCollection => ({
    async createIndexes(...args: unknown[]) {
      calls.push({ collection: name, method: 'createIndexes', args });
      return response(name, 'createIndexes', []);
    },
    async findOne(...args: unknown[]) {
      calls.push({ collection: name, method: 'findOne', args });
      return response(name, 'findOne', null);
    },
    async findOneAndUpdate(...args: unknown[]) {
      calls.push({ collection: name, method: 'findOneAndUpdate', args });
      return response(name, 'findOneAndUpdate', null);
    },
    async updateOne(...args: unknown[]) {
      calls.push({ collection: name, method: 'updateOne', args });
      return response(name, 'updateOne', { matchedCount: 1, modifiedCount: 1 });
    },
    async replaceOne(...args: unknown[]) {
      calls.push({ collection: name, method: 'replaceOne', args });
      return response(name, 'replaceOne', { matchedCount: 1, modifiedCount: 1 });
    },
    async insertOne(...args: unknown[]) {
      calls.push({ collection: name, method: 'insertOne', args });
      return response(name, 'insertOne', { acknowledged: true });
    },
    find(...args: unknown[]) {
      calls.push({ collection: name, method: 'find', args });
      return {
        async toArray() {
          return response(name, 'find.toArray', []) as unknown[];
        },
      };
    },
  });
  return {
    db: {
      collection: (name) => collection(name) as never,
      async command(...args: unknown[]) {
        calls.push({ collection: '$db', method: 'command', args });
        return response('$db', 'command', { ok: 1 });
      },
    },
    calls,
  };
}

const userDocument = (balanceUnits: string) => ({
  _id: 'alice',
  externalUserId: 'alice',
  balanceUnits,
  lastGrantPeriod: null,
  createdAt: new Date('2026-07-19T00:00:00Z'),
  updatedAt: new Date('2026-07-19T00:00:00Z'),
});

test('initialize creates unique identity, idempotency, transfer, and event indexes', async () => {
  const { db, calls } = scriptedDb();
  const store = new MongoStore(db);
  await store.initialize();

  const indexCalls = calls.filter((call) => call.method === 'createIndexes');
  assert.equal(indexCalls.length, 4);
  const indexes = indexCalls.flatMap((call) => call.args[0] as Array<Record<string, unknown>>);
  assert.ok(indexes.some((index) => index.name === 'uniq_external_user_id' && index.unique));
  assert.ok(indexes.some((index) => index.name === 'uniq_user_reference_hash' && index.unique));
  assert.ok(indexes.some((index) => index.name === 'uniq_transfer_id' && index.unique));
  assert.ok(indexes.some((index) => index.name === 'uniq_event_id' && index.unique));
});

test('readiness actively pings MongoDB with bounded operation timeouts', async () => {
  const { db, calls } = scriptedDb();
  const store = new MongoStore(db);

  assert.equal(await store.checkReady(), true);

  const ping = calls.find((call) => call.collection === '$db' && call.method === 'command');
  assert.ok(ping);
  assert.deepEqual(ping!.args[0], { ping: 1 });
  assert.deepEqual(ping!.args[1], { maxTimeMS: 1_500, timeoutMS: 2_000 });
});

test('adjustBalance uses an atomic Decimal128 pipeline and computes a clamped result', async () => {
  const responses = new Map<string, unknown[]>([
    ['crypto_users.findOneAndUpdate', [userDocument('4000000')]],
  ]);
  const { db, calls } = scriptedDb(responses);
  const store = new MongoStore(db, { creditLimitUnits: '0' });

  const result = await store.adjustBalance('alice', '-9000000');
  assert.deepEqual(result, { balanceUnits: '0', appliedUnits: '-4000000' });

  const call = calls.find((candidate) => candidate.method === 'findOneAndUpdate');
  assert.ok(call);
  assert.deepEqual(call!.args[0], { _id: 'alice' });
  assert.ok(JSON.stringify(call!.args[1]).includes('$toDecimal'));
  assert.deepEqual(call!.args[2], {
    session: undefined,
    returnDocument: 'before',
    includeResultMetadata: false,
  });
});

test('debitBalance rejects when the conditional update sees an existing insufficient user', async () => {
  const responses = new Map<string, unknown[]>([
    ['crypto_users.updateOne', [{ matchedCount: 0, modifiedCount: 0 }]],
    ['crypto_users.findOne', [userDocument('100')]],
  ]);
  const { db, calls } = scriptedDb(responses);
  const store = new MongoStore(db);

  await assert.rejects(() => store.debitBalance('alice', '101'), /below 0/);
  const update = calls.find((call) => call.method === 'updateOne');
  assert.ok(update);
  assert.ok(JSON.stringify(update!.args[0]).includes('$expr'));
});

test('references are persisted with a deterministic digest key', async () => {
  const responses = new Map<string, unknown[]>([
    ['crypto_users.findOne', [userDocument('0')]],
  ]);
  const { db, calls } = scriptedDb(responses);
  const store = new MongoStore(db);
  await store.addReference('alice', 'deposit:exec_123');

  const insert = calls.find(
    (call) => call.collection === 'crypto_idempotency' && call.method === 'insertOne',
  );
  assert.ok(insert);
  const document = insert!.args[0] as Record<string, unknown>;
  assert.match(String(document._id), /^ref_[a-f0-9]{64}$/);
  assert.equal(document.externalUserId, 'alice');
  assert.equal(document.reference, 'deposit:exec_123');
});

test('claimGrantPeriod combines the period claim and balance credit in one update', async () => {
  const responses = new Map<string, unknown[]>([
    ['crypto_users.findOneAndUpdate', [userDocument('1000000')]],
  ]);
  const { db, calls } = scriptedDb(responses);
  const store = new MongoStore(db);
  const result = await store.claimGrantPeriod('alice', '2026-07', '4000000');

  assert.deepEqual(result, { alreadyGranted: false, balanceUnits: '5000000' });
  const call = calls.find((candidate) => candidate.method === 'findOneAndUpdate');
  assert.ok(call);
  assert.equal((call!.args[0] as { _id: string })._id, 'alice');
  assert.deepEqual(
    (call!.args[0] as { lastGrantPeriod: unknown }).lastGrantPeriod,
    { $ne: '2026-07' },
  );
  assert.ok(JSON.stringify(call!.args[0]).includes('$toDecimal'));
  assert.ok(JSON.stringify(call!.args[1]).includes('lastGrantPeriod'));
});

test('a referenced adjustment rejects reuse with a different delta', async () => {
  const existingReference = {
    _id: 'ref_existing',
    externalUserId: 'alice',
    referenceHash: 'hash',
    reference: 'deposit:exec_123',
    operation: 'adjustment',
    requestedDeltaUnits: '4000000',
    createdAt: new Date('2026-07-19T00:00:00Z'),
  };
  const responses = new Map<string, unknown[]>([
    ['crypto_idempotency.findOne', [existingReference]],
  ]);
  const { db } = scriptedDb(responses);
  const session = {
    async withTransaction<T>(callback: () => Promise<T>): Promise<T> {
      return callback();
    },
    async endSession() {},
  };
  const client = {
    async connect() {},
    async close() {},
    db: () => db,
    startSession: () => session,
  };
  const store = new MongoStore(db, { client: client as never });

  await assert.rejects(
    () => store.applyAdjustment('alice', '5000000', 'deposit:exec_123'),
    (error: unknown) => error instanceof MongoStoreConflictError,
  );
});

test('reserveWithdrawal transactionally debits once and persists the stable operation id first', async () => {
  const responses = new Map<string, unknown[]>([
    ['crypto_withdrawals.findOne', [null, null]],
    ['crypto_users.findOne', [userDocument('1000000')]],
  ]);
  const { db, calls } = scriptedDb(responses);
  let transactionCalls = 0;
  const session = {
    async withTransaction<T>(callback: () => Promise<T>): Promise<T> {
      transactionCalls += 1;
      return callback();
    },
    async endSession() {},
  };
  const client = {
    async connect() {},
    async close() {},
    db: () => db,
    startSession: () => session,
  };
  const store = new MongoStore(db, { client: client as never });
  const result = await store.reserveWithdrawal(
    'alice',
    'wd_client_stable_123',
    '3000000',
    {
      chain_type: 'ethereum',
      chain_id: '8453',
      token_address: '0xUSDC',
      recipient_address: '0xALICE',
    },
  );

  assert.equal(transactionCalls, 1);
  assert.deepEqual(result, {
    created: true,
    withdrawalId: 'wd_client_stable_123',
    transferId: null,
    status: 'reserved',
    amountUnits: '3000000',
    balanceUnits: '1000000',
  });
  const insert = calls.find(
    (call) => call.collection === 'crypto_withdrawals' && call.method === 'insertOne',
  );
  assert.ok(insert);
  const reservation = insert!.args[0] as Record<string, unknown>;
  assert.equal(reservation._id, 'wd_client_stable_123');
  assert.equal(reservation.status, 'reserved');
  assert.equal('transferId' in reservation, false);
  const debit = calls.find(
    (call) => call.collection === 'crypto_users' && call.method === 'updateOne',
  );
  assert.ok(debit);
  assert.ok(JSON.stringify(debit!.args[0]).includes('$expr'));
});

test('completeWithdrawal cannot reverse an already failed and refunded withdrawal', async () => {
  const failedWithdrawal = {
    _id: 'wd_failed',
    id: 'wd_failed',
    externalUserId: 'alice',
    transferId: 'tr_failed',
    amountUnits: '3000000',
    destination: {
      chain_type: 'ethereum',
      chain_id: '8453',
      token_address: '0xUSDC',
      recipient_address: '0xALICE',
    },
    status: 'failed',
    refunded: true,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: new Date('2026-07-19T00:00:00Z'),
  };
  const responses = new Map<string, unknown[]>([
    ['crypto_withdrawals.findOneAndUpdate', [null]],
    ['crypto_withdrawals.findOne', [failedWithdrawal]],
    ['crypto_users.findOne', [userDocument('4000000')]],
    ['crypto_withdrawals.find.toArray', [[failedWithdrawal]]],
  ]);
  const { db, calls } = scriptedDb(responses);
  const store = new MongoStore(db);

  const result = await store.completeWithdrawal('wd_failed');

  assert.equal(result?.withdrawal.status, 'failed');
  assert.equal(result?.withdrawal.refunded, true);
  const conditionalUpdate = calls.find(
    (call) =>
      call.collection === 'crypto_withdrawals' && call.method === 'findOneAndUpdate',
  );
  assert.ok(conditionalUpdate);
  assert.deepEqual(conditionalUpdate!.args[0], {
    _id: 'wd_failed',
    refunded: false,
    status: { $ne: 'failed' },
  });
  assert.equal(
    calls.some(
      (call) => call.collection === 'crypto_withdrawals' && call.method === 'updateOne',
    ),
    false,
  );
});

test('commitEventSettlement credits balances and closes the event in one transaction', async () => {
  const openEvent = {
    _id: 'evt_settle',
    id: 'evt_settle',
    host: 'alice',
    title: 'Dinner',
    startsAt: null,
    stakeUnits: '1000000',
    multiplierBps: 10000,
    status: 'open',
    rsvps: [
      {
        userId: 'alice',
        stakedUnits: '1000000',
        status: 'attended',
        payoutUnits: '0',
      },
    ],
    createdAt: '2026-07-19T00:00:00.000Z',
    revision: 4,
    updatedAt: new Date('2026-07-19T00:00:00Z'),
  };
  const responses = new Map<string, unknown[]>([
    ['crypto_events.findOne', [openEvent]],
    ['crypto_idempotency.findOne', [null]],
  ]);
  const { db, calls } = scriptedDb(responses);
  const session = {
    async withTransaction<T>(callback: () => Promise<T>): Promise<T> {
      return callback();
    },
    async endSession() {},
  };
  const client = {
    async connect() {},
    async close() {},
    db: () => db,
    startSession: () => session,
  };
  const store = new MongoStore(db, { client: client as never });
  const settledEvent: EventItem = {
    ...openEvent,
    status: 'settled',
    rsvps: [
      {
        userId: 'alice',
        stakedUnits: '1000000',
        status: 'attended',
        payoutUnits: '1000000',
      },
    ],
  };
  const result = await store.commitEventSettlement(settledEvent, 4, [
    { userId: 'alice', units: '1000000', reference: 'settle:evt_settle:alice' },
  ]);

  assert.equal(result.status, 'settled');
  assert.ok(
    calls.some(
      (call) => call.collection === 'crypto_users' && call.method === 'updateOne',
    ),
  );
  assert.ok(
    calls.some(
      (call) => call.collection === 'crypto_idempotency' && call.method === 'insertOne',
    ),
  );
  const replacement = calls.find(
    (call) => call.collection === 'crypto_events' && call.method === 'replaceOne',
  );
  assert.ok(replacement);
  assert.deepEqual(replacement!.args[0], {
    _id: 'evt_settle',
    revision: 4,
    status: 'open',
  });
  assert.equal((replacement!.args[1] as { revision: number }).revision, 5);
});

test('saveEvent requires the expected revision and surfaces a concurrent write', async () => {
  const responses = new Map<string, unknown[]>([
    ['crypto_events.replaceOne', [{ matchedCount: 0, modifiedCount: 0 }]],
  ]);
  const { db, calls } = scriptedDb(responses);
  const store = new MongoStore(db);
  const event: EventItem = {
    id: 'evt_1',
    host: 'alice',
    title: 'Coffee',
    startsAt: null,
    stakeUnits: '1000000',
    multiplierBps: 10000,
    status: 'open',
    rsvps: [],
    createdAt: '2026-07-19T00:00:00.000Z',
  };

  await assert.rejects(
    () => store.saveEvent(event, 3),
    (error: unknown) => error instanceof MongoStoreConflictError,
  );
  const replace = calls.find((call) => call.method === 'replaceOne');
  assert.ok(replace);
  assert.deepEqual(replace!.args[0], { _id: 'evt_1', revision: 3 });
  assert.equal((replace!.args[1] as { revision: number }).revision, 4);
});

test('environment connector fails without exposing or guessing MongoDB credentials', async () => {
  await assert.rejects(
    () => connectMongoStoreFromEnv({ MONGODB_DB_NAME: 'crypto' }),
    /MONGODB_URI is required/,
  );
  await assert.rejects(
    () => connectMongoStoreFromEnv({ MONGODB_URI: 'mongodb+srv:\/\/secret@cluster' }),
    /MONGODB_DB_NAME is required/,
  );
});
