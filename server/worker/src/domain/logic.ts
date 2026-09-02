// Pure functions transcribed from server/index.js. No bindings, no I/O — every
// one of these takes plain data and returns plain data so it can be exercised
// without workerd (SPEC section 4).
import {
  ACTIVITIES, ACTIVITY_IDS, AVATAR_R, HOLIDAYS, INTEREST_BOOST,
  VIBE_PER_LEVEL, WORLD_H, WORLD_W,
} from './catalog';
import type { HangoutRow, UserRow } from '../ports/store';

export const AUTH0_DISABLED_PREFIX = 'auth0-disabled:';

/** Extracts a single Bearer credential, rejecting comma/space-joined values. */
export function getBearerToken(authorization: string | null): string | null {
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer[\t ]+([^\s,]+)$/i.exec(authorization.trim());
  return match ? match[1] : null;
}

export function safeJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function sanitizeInterests(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const x of arr) if (typeof x === 'string' && ACTIVITY_IDS.has(x) && !out.includes(x)) out.push(x);
  return out.slice(0, 12);
}

export const interestsOf = (u: { interests?: unknown }): string[] =>
  sanitizeInterests(safeJsonArray(u?.interests));

/** Bodies are attacker-controlled; anything reaching a query must be a string. */
export const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

export const parseId = (value: unknown): number | null =>
  /^\d+$/.test(String(value)) ? Number(value) : null;

export const pair = (x: number, y: number): [number, number] => (x < y ? [x, y] : [y, x]);
export const level = (vibe: number): number => Math.floor(vibe / VIBE_PER_LEVEL) + 1;
export const nowIso = (): string => new Date().toISOString();

export function publicUser(u: UserRow) {
  return {
    username: u.username,
    name: u.name,
    color: u.color,
    species: u.species,
    equipped: safeJsonArray(u.equipped),
  };
}

export function meView(u: UserRow) {
  return {
    username: u.username,
    name: u.name,
    birthday: u.birthday,
    acorns: u.acorns,
    color: u.color,
    species: u.species,
    owned: safeJsonArray(u.owned),
    equipped: safeJsonArray(u.equipped),
    interests: interestsOf(u),
  };
}

export function isValidBirthday(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

/**
 * Holiday/birthday multiplier. Uses the runtime's local calendar exactly as the
 * Express build did; a Worker's local time is UTC, and so is the Linux App
 * Service's (WEBSITE_TIME_ZONE is unset), so the two agree.
 */
export function bonusFor(dateISO: string, members: UserRow[]): { mult: number; reason: string | null } {
  const d = new Date(dateISO);
  const hol = HOLIDAYS.find((h) => h.month === d.getMonth() + 1 && h.day === d.getDate());
  if (hol) return { mult: 2, reason: hol.label };
  const mmdd = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  for (const u of members) {
    if (u.birthday.slice(5) === mmdd) return { mult: 2, reason: `${u.name}'s birthday` };
  }
  return { mult: 1, reason: null };
}

/** Deliberately low so "Need to hang out" is demoable. */
export const TITLE_STALE_MS = 2 * 60 * 1000;

export function friendTitle({
  vibeLevel, streak, lastHangoutAt, friendsSince,
}: {
  vibeLevel: number;
  streak: boolean;
  lastHangoutAt: string | null;
  friendsSince: string | null;
}): { title: string; titleKind: string } {
  const now = Date.now();
  const last = lastHangoutAt ? new Date(lastHangoutAt).getTime() : null;
  const since = friendsSince ? new Date(friendsSince).getTime() : now;
  const stale = last != null ? now - last > TITLE_STALE_MS : now - since > TITLE_STALE_MS;
  if (stale) return { title: 'Need to hang out', titleKind: 'stale' };
  if (streak) return { title: 'On a streak', titleKind: 'streak' };
  if (vibeLevel >= 3) return { title: 'Best friend', titleKind: 'best' };
  if (last == null) return { title: 'New friend', titleKind: 'new' };
  if (vibeLevel >= 2) return { title: 'Close friend', titleKind: 'close' };
  return { title: 'Friend', titleKind: 'friend' };
}

export function hangoutStatsFrom(completedAt: string[]): {
  lastHangoutAt: string | null;
  recentHangouts: number;
  streak: boolean;
} {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  let last: string | null = null;
  let recent = 0;
  for (const value of completedAt) {
    if (last === null || value > last) last = value;
    if (value > cutoff) recent += 1;
  }
  return { lastHangoutAt: last, recentHangouts: recent, streak: recent >= 3 };
}

/** Next Friday 18:00 local, strictly in the future. */
export function nextFriday18(from: Date = new Date()): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7));
  d.setHours(18, 0, 0, 0);
  if (d <= from) d.setDate(d.getDate() + 7);
  return d;
}

/** Photo taker plus anyone who tapped; everyone else is a no-show. */
export function attendeeIdSet(h: HangoutRow): Set<number> {
  const set = new Set<number>();
  if (h.photo_by != null) set.add(h.photo_by);
  for (const c of h.confirms) {
    set.add(c.u1);
    set.add(c.u2);
  }
  return set;
}

export function hangoutView(h: HangoutRow, meId: number, members: UserRow[]) {
  const ids = h.member_ids;
  const byId = new Map(members.map((u) => [u.id, u]));
  const attendees = attendeeIdSet(h);
  const memberViews = ids.map((id) => ({
    ...publicUser(byId.get(id)!),
    attended: attendees.has(id),
  }));
  const confirmedPairs = h.confirms.map((c) => [byId.get(c.u1)!.username, byId.get(c.u2)!.username]);
  const pairsTotal = (ids.length * (ids.length - 1)) / 2;

  let stake: unknown = null;
  if (h.stake_units) {
    const stakedIds = new Set(h.stakes.map((s) => s.user_id));
    const settleByUser = new Map(h.settlements.map((s) => [s.user_id, s]));
    stake = {
      stakeUnits: h.stake_units,
      settled: !!h.settled_at,
      poolUnits: String(BigInt(h.stake_units) * BigInt(stakedIds.size)),
      members: ids.map((id) => {
        const s = settleByUser.get(id);
        return {
          username: byId.get(id)!.username,
          staked: stakedIds.has(id),
          settleStatus: s ? s.status : null,
          payoutUnits: s ? s.payout_units : null,
        };
      }),
      iStaked: stakedIds.has(meId),
    };
  }

  return {
    id: h.id,
    activity: h.activity,
    activityLabel: h.activity_label,
    date: h.date,
    place: h.place,
    bonusMult: h.bonus_mult,
    bonusReason: h.bonus_reason,
    photoUrl: h.photo ? `/uploads/${h.photo}` : null,
    completedAt: h.completed_at,
    members: memberViews,
    confirmedPairs,
    pairsTotal,
    mine: ids.includes(meId),
    canEnd: !h.completed_at && !!h.photo && new Date(h.date).getTime() < Date.now(),
    stake,
  };
}

export function rankScore(
  weights: Map<string, number>,
  userId: number,
  activity: string,
  interestSet: Set<string> | null,
): number {
  const stored = weights.get(`${userId}:${activity}`);
  const base = stored === undefined ? 50 : stored;
  return interestSet && interestSet.has(activity) ? Math.min(100, base + INTEREST_BOOST) : base;
}

export function rankedActivities(
  ids: number[],
  weights: Map<string, number>,
  sets: Map<number, Set<string>>,
) {
  return ACTIVITIES.map((a) => ({
    ...a,
    combined: ids.reduce((s, id) => s + rankScore(weights, id, a.id, sets.get(id) ?? null), 0) / ids.length,
  })).sort((x, y) => y.combined - x.combined);
}

/** Elo-ish duel update, identical constants to the Express build. */
export function duelUpdate(winnerWeight: number, loserWeight: number) {
  const expected = 1 / (1 + Math.pow(10, (loserWeight - winnerWeight) / 40));
  const dw = Math.max(1, Math.round(8 * (1 - expected)));
  return {
    winner: Math.min(100, winnerWeight + dw),
    loser: Math.max(0, loserWeight - dw / 2),
  };
}

export function clampPos(v: unknown, max: number): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(AVATAR_R, Math.min(max - AVATAR_R, n));
}

export function spawnPoint(): { x: number; y: number } {
  return {
    x: WORLD_W / 2 + (Math.random() * 2 - 1) * 300,
    y: WORLD_H / 2 + (Math.random() * 2 - 1) * 220,
  };
}

export function worldPlayer(u: UserRow, online: boolean) {
  return {
    username: u.username,
    name: u.name,
    color: u.color,
    species: u.species,
    equipped: safeJsonArray(u.equipped),
    x: u.pos_x,
    y: u.pos_y,
    online,
  };
}

export const validCryptoInteger = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 34;
