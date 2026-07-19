import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { rsvp, settle } from '../src/events.js';
import {
  resetStoreForTests,
  setStoreForTests,
} from '../src/runtimeStore.js';
import {
  MongoStore,
  MongoStoreConflictError,
  type EventSettlementCredit,
} from '../src/mongoStore.js';
import type { EventItem } from '../src/store.js';

afterEach(() => resetStoreForTests());

function openEvent(): EventItem {
  return {
    id: 'evt_atomic',
    host: 'host',
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
      {
        userId: 'bob',
        stakedUnits: '1000000',
        status: 'staked',
        payoutUnits: '0',
      },
    ],
    createdAt: '2026-07-19T00:00:00.000Z',
  };
}

test('RSVP delegates the balance debit and event append to one atomic store operation', async () => {
  const event = openEvent();
  let calls = 0;
  setStoreForTests({
    async stakeRsvp(eventId: string, userId: string) {
      calls += 1;
      assert.equal(eventId, event.id);
      assert.equal(userId, 'charlie');
      return event;
    },
  } as never);

  assert.equal(await rsvp(event.id, 'charlie'), event);
  assert.equal(calls, 1);
});

test('Mongo RSVP debits and appends in one transaction while honoring the credit floor', async () => {
  const event = openEvent();
  event.rsvps = [];
  const eventDocument = {
    ...event,
    _id: event.id,
    revision: 2,
    updatedAt: new Date('2026-07-19T00:00:00.000Z'),
  };
  const updatedDocument = {
    ...eventDocument,
    revision: 3,
    rsvps: [
      {
        userId: 'alice',
        stakedUnits: event.stakeUnits,
        status: 'staked' as const,
        payoutUnits: '0',
      },
    ],
  };
  let eventReads = 0;
  let balanceFilter: Record<string, unknown> | undefined;
  let transactionCalls = 0;
  const db = {
    collection(name: string) {
      if (name === 'crypto_events') {
        return {
          async findOne() {
            eventReads += 1;
            return eventReads === 1 ? eventDocument : updatedDocument;
          },
          async updateOne() {
            return { matchedCount: 1, modifiedCount: 1 };
          },
        };
      }
      if (name === 'crypto_users') {
        return {
          async updateOne(filter: Record<string, unknown>) {
            balanceFilter = filter;
            return { matchedCount: 1, modifiedCount: 1 };
          },
        };
      }
      return {};
    },
  };
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
  const store = new MongoStore(db as never, {
    client: client as never,
    creditLimitUnits: '-500000',
  });

  const result = await store.stakeRsvp(event.id, 'alice');

  assert.equal(transactionCalls, 1);
  assert.equal(result.rsvps[0]?.userId, 'alice');
  assert.ok(balanceFilter);
  assert.match(JSON.stringify(balanceFilter), /\$subtract/);
  assert.match(JSON.stringify(balanceFilter), /-500000/);
});

test('a concurrent settlement loser returns the durable winner without double-crediting', async () => {
  const snapshot = openEvent();
  let durable: EventItem = snapshot;
  let submittedCredits: ReadonlyArray<EventSettlementCredit> | undefined;
  let commitCalls = 0;

  setStoreForTests({
    async getVersionedEvent() {
      return { event: structuredClone(snapshot), revision: 7 };
    },
    async commitEventSettlement(
      settledEvent: EventItem,
      expectedRevision: number,
      credits: ReadonlyArray<EventSettlementCredit>,
    ) {
      commitCalls += 1;
      assert.equal(expectedRevision, 7);
      submittedCredits = credits;
      // Model another transaction committing the exact durable state before
      // this request observes its optimistic-concurrency loss.
      durable = structuredClone(settledEvent);
      throw new MongoStoreConflictError('event changed concurrently');
    },
    async getEvent() {
      return structuredClone(durable);
    },
  } as never);

  const result = await settle(snapshot.id);

  assert.equal(commitCalls, 1);
  assert.deepEqual(submittedCredits, [
    {
      userId: 'alice',
      units: '2000000',
      reference: 'settle:evt_atomic:alice',
    },
  ]);
  assert.equal(result.status, 'settled');
  assert.equal(result.forfeitPoolUnits, '1000000');
  assert.deepEqual(
    result.results.map(({ userId, status, payoutUnits }) => ({
      userId,
      status,
      payoutUnits,
    })),
    [
      { userId: 'alice', status: 'attended', payoutUnits: '2000000' },
      { userId: 'bob', status: 'flaked', payoutUnits: '0' },
    ],
  );
});

test('an already settled event is an idempotent read and does not commit again', async () => {
  const settled: EventItem = {
    ...openEvent(),
    status: 'settled',
    rsvps: [
      {
        userId: 'alice',
        stakedUnits: '1000000',
        status: 'attended',
        payoutUnits: '2000000',
      },
      {
        userId: 'bob',
        stakedUnits: '1000000',
        status: 'flaked',
        payoutUnits: '0',
      },
    ],
  };
  let commitCalls = 0;

  setStoreForTests({
    async getVersionedEvent() {
      return { event: structuredClone(settled), revision: 8 };
    },
    async commitEventSettlement() {
      commitCalls += 1;
      return settled;
    },
  } as never);

  const result = await settle(settled.id);

  assert.equal(commitCalls, 0);
  assert.equal(result.status, 'settled');
  assert.equal(result.forfeitPoolUnits, '1000000');
});
