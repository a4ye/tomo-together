// Flake-tax hangouts. You stake to RSVP; if you no-show, your stake is split
// among the friends who showed up (verified via check-in). Stakes and payouts are
// internal ledger moves (treasury-backed); real USDC only moves on cash-out.
import { randomUUID } from 'node:crypto';
import {
  getUser,
  debitBalance,
  getEvent,
  createEvent as storeCreateEvent,
  saveEvents,
  type EventItem,
} from './store.js';
import { adjust } from './adjust.js';
import { ValidationError, isPositiveIntString } from './withdraw.js';
import { CREDIT_LIMIT_UNITS } from './config.js';

// Internal invariant — a violation is a bug, not user error (surfaces as HTTP 500).
function invariant(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`settlement invariant violated: ${msg}`);
}

export interface SettleResult {
  eventId: string;
  status: string;
  forfeitPoolUnits: string;
  results: Array<{
    userId: string;
    status: string;
    stakedUnits: string;
    payoutUnits: string;
  }>;
}

export function createHangout(
  host: string,
  title: unknown,
  stakeUnits: unknown,
  opts?: { startsAt?: string; multiplierBps?: number },
): EventItem {
  if (typeof host !== 'string' || !getUser(host)) {
    throw new ValidationError('host user not found');
  }
  if (!isPositiveIntString(stakeUnits)) {
    throw new ValidationError('stakeUnits must be a positive integer string');
  }
  // multiplier is a holiday bonus only — 1x (10000) up to the 1.5x holiday cap (15000).
  // The bonus is net-new treasury money, so an unbounded multiplier would mint balance.
  let multiplierBps = 10000;
  if (opts?.multiplierBps !== undefined) {
    multiplierBps = opts.multiplierBps;
    if (
      !Number.isInteger(multiplierBps) ||
      multiplierBps < 10000 ||
      multiplierBps > 15000
    ) {
      throw new ValidationError('multiplierBps must be an integer between 10000 and 15000');
    }
  }

  const ev: EventItem = {
    id: `evt_${randomUUID()}`,
    host,
    title: typeof title === 'string' && title.trim() !== '' ? title : 'Hangout',
    startsAt: opts?.startsAt ?? null,
    stakeUnits,
    multiplierBps,
    status: 'open',
    rsvps: [],
    createdAt: new Date().toISOString(),
  };
  return storeCreateEvent(ev);
}

export function rsvp(eventId: string, userId: string): EventItem {
  const ev = getEvent(eventId);
  if (!ev) throw new ValidationError('event not found');
  if (ev.status !== 'open') throw new ValidationError('event is not open for RSVPs');

  const user = getUser(userId);
  if (!user) throw new ValidationError('user not found');
  if (ev.rsvps.some((r) => r.userId === userId)) {
    throw new ValidationError('user already RSVP’d');
  }
  // You can only stake what you have (floor = credit limit, 0 by default).
  if (BigInt(user.balanceUnits) - BigInt(ev.stakeUnits) < BigInt(CREDIT_LIMIT_UNITS)) {
    throw new ValidationError('insufficient balance to stake');
  }

  debitBalance(userId, ev.stakeUnits); // stake leaves spendable balance
  ev.rsvps.push({ userId, stakedUnits: ev.stakeUnits, status: 'staked', payoutUnits: '0' });
  saveEvents();
  return ev;
}

export function checkin(eventId: string, userId: string): EventItem {
  const ev = getEvent(eventId);
  if (!ev) throw new ValidationError('event not found');
  if (ev.status === 'settled') throw new ValidationError('event already settled');

  const r = ev.rsvps.find((x) => x.userId === userId);
  if (!r) throw new ValidationError('user has not RSVP’d');
  r.status = 'attended'; // the selfie / touch-tips oracle confirms attendance
  saveEvents();
  return ev;
}

export function settle(eventId: string): SettleResult {
  const ev = getEvent(eventId);
  if (!ev) throw new ValidationError('event not found');
  if (ev.status === 'settled') throw new ValidationError('event already settled');

  const attendees = ev.rsvps.filter((r) => r.status === 'attended');
  const flakers = ev.rsvps.filter((r) => r.status === 'staked');
  // Every unit that was staked must be fully accounted for on the way out.
  const totalStaked = ev.rsvps.reduce((s, r) => s + BigInt(r.stakedUnits), 0n);

  // No one showed up → the event fizzled; refund every stake, nobody profits.
  if (attendees.length === 0) {
    let refunded = 0n;
    for (const r of ev.rsvps) {
      // Idempotent credit: a replay after a crash short-circuits per (event,user).
      adjust(r.userId, r.stakedUnits, `settle:${ev.id}:${r.userId}`);
      r.status = 'refunded';
      r.payoutUnits = r.stakedUnits;
      refunded += BigInt(r.stakedUnits);
    }
    invariant(refunded === totalStaked, 'refunds must equal total staked');
    ev.status = 'settled';
    saveEvents();
    return summarize(ev, '0');
  }

  const forfeitPool = flakers.reduce((s, r) => s + BigInt(r.stakedUnits), 0n);
  const n = BigInt(attendees.length);
  const share = forfeitPool / n;
  const remainder = forfeitPool - share * n; // 0 .. n-1, spread 1 unit each

  let basePaid = 0n; // payouts excluding the treasury-funded multiplier bonus
  attendees.forEach((r, i) => {
    const own = BigInt(r.stakedUnits);
    const extra = BigInt(i) < remainder ? 1n : 0n;
    const base = own + share + extra; // own stake back + cut of the flake pool
    basePaid += base;
    // Holiday multiplier bonus (net-new, funded from the treasury).
    const bonus = (base * BigInt(ev.multiplierBps - 10000)) / 10000n;
    const total = base + bonus;
    // Idempotent credit: a replay after a crash short-circuits per (event,user).
    adjust(r.userId, total.toString(), `settle:${ev.id}:${r.userId}`);
    r.payoutUnits = total.toString();
  });
  // Redistribution must be exactly conservative: own stakes + forfeit pool, no more.
  invariant(basePaid === totalStaked, 'base payouts must equal total staked');

  for (const r of flakers) {
    r.status = 'flaked';
    r.payoutUnits = '0'; // stake was debited at RSVP and is now redistributed
  }

  ev.status = 'settled';
  saveEvents();
  return summarize(ev, forfeitPool.toString());
}

function summarize(ev: EventItem, forfeitPoolUnits: string): SettleResult {
  return {
    eventId: ev.id,
    status: ev.status,
    forfeitPoolUnits,
    results: ev.rsvps.map((r) => ({
      userId: r.userId,
      status: r.status,
      stakedUnits: r.stakedUnits,
      payoutUnits: r.payoutUnits,
    })),
  };
}
