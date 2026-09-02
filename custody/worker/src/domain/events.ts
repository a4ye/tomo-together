// Port of custody/src/events.ts. Flake-tax hangouts: you stake to RSVP; if you
// no-show, your stake is split among the friends who showed up. Stakes and
// payouts are internal ledger moves; real USDC only moves on cash-out.
import type { Env } from '../env';
import { treasuryEventBonusesEnabled } from '../config';
import {
  StoreConflictError,
  type D1Store,
  type EventItem,
  type EventSettlementCredit,
} from '../store/d1Store';
import { ValidationError, isPositiveIntString } from './withdraw';

/** An invariant violation means persisted money state is inconsistent. */
function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`settlement invariant violated: ${message}`);
}

export interface SettleResult {
  eventId: string;
  status: EventItem['status'];
  forfeitPoolUnits: string;
  results: Array<{ userId: string; status: string; stakedUnits: string; payoutUnits: string }>;
}

interface SettlementPlan {
  event: EventItem;
  credits: EventSettlementCredit[];
  forfeitPoolUnits: string;
}

export class TreasuryEventBonusDisabledError extends Error {
  readonly statusCode = 403;
  constructor() {
    super(
      'treasury-funded event bonuses are disabled in production; set ENABLE_TREASURY_FUNDED_EVENT_BONUSES=true to opt in',
    );
    this.name = 'TreasuryEventBonusDisabledError';
  }
}

export async function createHangout(
  env: Env,
  store: D1Store,
  host: unknown,
  title: unknown,
  stakeUnits: unknown,
  opts?: { startsAt?: string; multiplierBps?: number },
): Promise<EventItem> {
  if (!isPositiveIntString(stakeUnits)) {
    throw new ValidationError('stakeUnits must be a positive integer string');
  }

  // The multiplier is a holiday bonus only: 1x (10000) up to the 1.5x cap
  // (15000). The bonus is treasury-funded, so an unbounded value would mint an
  // unbounded internal balance.
  let multiplierBps = 10000;
  if (opts?.multiplierBps !== undefined) {
    multiplierBps = opts.multiplierBps;
    if (!Number.isInteger(multiplierBps) || multiplierBps < 10000 || multiplierBps > 15000) {
      throw new ValidationError('multiplierBps must be an integer between 10000 and 15000');
    }
    if (multiplierBps > 10000 && !treasuryEventBonusesEnabled(env)) {
      throw new TreasuryEventBonusDisabledError();
    }
  }

  if (typeof host !== 'string' || !(await store.getUser(host))) {
    throw new ValidationError('host user not found');
  }

  const event: EventItem = {
    id: `evt_${crypto.randomUUID()}`,
    host,
    title: typeof title === 'string' && title.trim() !== '' ? title : 'Hangout',
    startsAt: opts?.startsAt ?? null,
    stakeUnits,
    multiplierBps,
    status: 'open',
    rsvps: [],
    createdAt: new Date().toISOString(),
  };
  return store.createEvent(event);
}

export async function rsvp(store: D1Store, eventId: string, userId: string): Promise<EventItem> {
  requireId(eventId, 'eventId');
  requireId(userId, 'userId');
  try {
    // stakeRsvp owns the debit and the RSVP append in one transaction, so a
    // failed/stale event update cannot leave an orphaned debit.
    return await store.stakeRsvp(eventId, userId);
  } catch (error) {
    throwKnownRsvpError(error);
  }
}

export async function checkin(store: D1Store, eventId: string, userId: string): Promise<EventItem> {
  requireId(eventId, 'eventId');
  requireId(userId, 'userId');

  // The read gives callers specific validation errors; the write remains a
  // guarded conditional update, so this read is not relied on for safety.
  const event = await store.getEvent(eventId);
  if (!event) throw new ValidationError('event not found');
  if (event.status === 'settled') throw new ValidationError('event already settled');
  const existing = event.rsvps.find((candidate) => candidate.userId === userId);
  if (!existing) throw new ValidationError('user has not RSVP’d');
  if (existing.status === 'attended') return event;
  if (existing.status !== 'staked') throw new ValidationError('RSVP is not available for check-in');

  try {
    return await store.checkInRsvp(eventId, userId);
  } catch (error) {
    // The conditional update can lose a race with settlement. Re-read only to
    // turn that terminal state into the established public validation error.
    const current = await store.getEvent(eventId);
    if (!current) throw new ValidationError('event not found');
    if (current.status === 'settled') throw new ValidationError('event already settled');
    const currentRsvp = current.rsvps.find((candidate) => candidate.userId === userId);
    if (!currentRsvp) throw new ValidationError('user has not RSVP’d');
    if (currentRsvp.status === 'attended') return current;
    throw error;
  }
}

export async function settle(store: D1Store, eventId: string): Promise<SettleResult> {
  requireId(eventId, 'eventId');
  const versioned = await store.getVersionedEvent(eventId);
  if (!versioned) throw new ValidationError('event not found');
  invariant(versioned.event.id === eventId, 'event identity does not match its lookup key');

  // commitEventSettlement is deliberately idempotent: a retried request or a
  // concurrent winner returns the already-settled event without double crediting.
  if (versioned.event.status === 'settled') {
    return summarize(versioned.event, forfeitPoolFromSettledEvent(versioned.event));
  }

  const plan = buildSettlementPlan(versioned.event);
  let committed: EventItem;
  try {
    committed = await store.commitEventSettlement(plan.event, versioned.revision, plan.credits);
  } catch (error) {
    if (!(error instanceof StoreConflictError)) throw error;
    // Another settlement may have committed after our snapshot. Returning its
    // durable result keeps the operation idempotent while a genuine unrelated
    // mutation still surfaces as a conflict.
    const current = await store.getEvent(eventId);
    if (current?.status === 'settled') {
      return summarize(current, forfeitPoolFromSettledEvent(current));
    }
    throw error;
  }
  return summarize(
    committed,
    committed.status === 'settled' ? forfeitPoolFromSettledEvent(committed) : plan.forfeitPoolUnits,
  );
}

function buildSettlementPlan(source: EventItem): SettlementPlan {
  invariant(source.status === 'open', 'only an open event can be planned for settlement');
  invariant(
    source.rsvps.every(
      (r) =>
        typeof r.userId === 'string' &&
        r.userId.trim() !== '' &&
        (r.status === 'staked' || r.status === 'attended') &&
        typeof r.stakedUnits === 'string' &&
        /^\d+$/.test(r.stakedUnits) &&
        BigInt(r.stakedUnits) > 0n,
    ),
    'an open event may only contain positive staked or attended RSVPs',
  );
  invariant(
    new Set(source.rsvps.map((r) => r.userId)).size === source.rsvps.length,
    'an event cannot contain duplicate users',
  );
  invariant(
    Number.isInteger(source.multiplierBps) &&
      source.multiplierBps >= 10000 &&
      source.multiplierBps <= 15000,
    'multiplier is outside the supported range',
  );

  const event: EventItem = { ...source, rsvps: source.rsvps.map((r) => ({ ...r })) };
  const attendees = event.rsvps.filter((r) => r.status === 'attended');
  const flakers = event.rsvps.filter((r) => r.status === 'staked');
  const totalStaked = event.rsvps.reduce((sum, r) => sum + BigInt(r.stakedUnits), 0n);
  const credits: EventSettlementCredit[] = [];

  // No one showed up: refund every stake and do not award a multiplier.
  if (attendees.length === 0) {
    let refunded = 0n;
    for (const r of event.rsvps) {
      credits.push({
        userId: r.userId,
        units: r.stakedUnits,
        reference: settlementReference(event.id, r.userId),
      });
      r.status = 'refunded';
      r.payoutUnits = r.stakedUnits;
      refunded += BigInt(r.stakedUnits);
    }
    invariant(refunded === totalStaked, 'refunds must equal total staked');
    event.status = 'settled';
    return { event, credits, forfeitPoolUnits: '0' };
  }

  const forfeitPool = flakers.reduce((sum, r) => sum + BigInt(r.stakedUnits), 0n);
  const attendeeCount = BigInt(attendees.length);
  const share = forfeitPool / attendeeCount;
  const remainder = forfeitPool - share * attendeeCount;

  let basePaid = 0n;
  attendees.forEach((r, index) => {
    const ownStake = BigInt(r.stakedUnits);
    const remainderUnit = BigInt(index) < remainder ? 1n : 0n;
    const basePayout = ownStake + share + remainderUnit;
    basePaid += basePayout;
    const bonus = (basePayout * BigInt(event.multiplierBps - 10000)) / 10000n;
    r.payoutUnits = (basePayout + bonus).toString();
    credits.push({
      userId: r.userId,
      units: r.payoutUnits,
      reference: settlementReference(event.id, r.userId),
    });
  });
  invariant(basePaid === totalStaked, 'base payouts must equal total staked');

  for (const r of flakers) {
    r.status = 'flaked';
    r.payoutUnits = '0';
  }
  event.status = 'settled';
  return { event, credits, forfeitPoolUnits: forfeitPool.toString() };
}

function forfeitPoolFromSettledEvent(event: EventItem): string {
  invariant(event.status === 'settled', 'forfeit pool requires a settled event');
  return event.rsvps
    .filter((r) => r.status === 'flaked')
    .reduce((sum, r) => sum + BigInt(r.stakedUnits), 0n)
    .toString();
}

const settlementReference = (eventId: string, userId: string): string =>
  `settle:${eventId}:${userId}`;

function requireId(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${name} is required`);
  }
}

function throwKnownRsvpError(error: unknown): never {
  if (!(error instanceof Error)) throw error;
  if (error.message.startsWith('debitBalance would drive balance below ')) {
    throw new ValidationError('insufficient balance to stake');
  }
  switch (error.message) {
    case 'event not found':
    case 'event is not open for RSVPs':
    case 'user already RSVP’d':
    case 'user not found':
      throw new ValidationError(error.message);
    default:
      throw error;
  }
}

function summarize(event: EventItem, forfeitPoolUnits: string): SettleResult {
  return {
    eventId: event.id,
    status: event.status,
    forfeitPoolUnits,
    results: event.rsvps.map((r) => ({
      userId: r.userId,
      status: r.status,
      stakedUnits: r.stakedUnits,
      payoutUnits: r.payoutUnits,
    })),
  };
}
