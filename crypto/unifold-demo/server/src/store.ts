// In-memory user store with JSON persistence.
// Balances are USDC base-unit strings; math is done on BigInt.
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDIT_LIMIT_UNITS } from './config.js';

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
  // Applied external-adjustment references (for idempotent monthly credits/debits).
  references: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// DATA_DIR is overridable (e.g. tests point it at a temp dir; Docker at a volume).
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, '..', 'data');
const DATA_FILE = join(DATA_DIR, 'users.json');

const users = new Map<string, User>();

// Atomic durable write: write to a same-directory temp file, fsync it, then
// rename over the target (rename is atomic on POSIX). This guarantees a reader
// never sees a truncated file even if we're OOM-killed/redeployed mid-write.
function atomicWrite(file: string, data: string): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, data, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EEXIST')) {
      throw error;
    }
    // Windows rename does not consistently replace an existing destination.
    // This backend is explicitly local/test-only; remove the exact ledger file
    // and finish the replacement. Production uses MongoDB transactions.
    if (existsSync(file)) unlinkSync(file);
    renameSync(tmp, file);
  }
}

function load(): void {
  // Missing file == first run: start empty. But a file that EXISTS yet fails to
  // parse is a corrupt/truncated ledger, not "no data" — refuse to boot rather
  // than silently zero every balance while the real USDC sits in the treasury.
  if (!existsSync(DATA_FILE)) return;
  const raw = readFileSync(DATA_FILE, 'utf8');
  if (raw.trim() === '') return;
  let parsed: User[];
  try {
    parsed = JSON.parse(raw) as User[];
  } catch (err) {
    throw new Error(
      `[store] users.json exists but is corrupt/unparseable; refusing to boot with a zeroed ledger: ${String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      '[store] users.json exists but is not a JSON array; refusing to boot with a zeroed ledger',
    );
  }
  for (const u of parsed) {
    users.set(u.externalUserId, {
      externalUserId: u.externalUserId,
      balanceUnits: u.balanceUnits ?? '0',
      lastGrantPeriod: u.lastGrantPeriod ?? null,
      withdrawals: u.withdrawals ?? [],
      references: u.references ?? [],
    });
  }
}

function persist(): void {
  atomicWrite(DATA_FILE, JSON.stringify([...users.values()], null, 2));
}

export function registerUser(externalUserId: string): User {
  let user = users.get(externalUserId);
  if (!user) {
    user = {
      externalUserId,
      balanceUnits: '0',
      lastGrantPeriod: null,
      withdrawals: [],
      references: [],
    };
    users.set(externalUserId, user);
    persist();
  }
  return user;
}

export function getUser(externalUserId: string): User | undefined {
  return users.get(externalUserId);
}

export function creditBalance(externalUserId: string, units: string): void {
  const user = users.get(externalUserId);
  if (!user) return;
  user.balanceUnits = (BigInt(user.balanceUnits) + BigInt(units)).toString();
  persist();
}

export function debitBalance(externalUserId: string, units: string): void {
  const user = users.get(externalUserId);
  if (!user) return;
  const next = BigInt(user.balanceUnits) - BigInt(units);
  // Defense in depth: callers must validate first; never drive balance negative.
  if (next < 0n) {
    throw new Error('debitBalance would drive balance below 0');
  }
  user.balanceUnits = next.toString();
  persist();
}

// Apply a signed delta (base units) to the balance, clamped at 0 (never negative).
// Returns the new balance and how much was actually applied (may be less than a
// requested debit if it would have gone below zero).
export function adjustBalance(
  externalUserId: string,
  deltaUnits: string,
): { balanceUnits: string; appliedUnits: string } {
  const user = users.get(externalUserId);
  if (!user) return { balanceUnits: '0', appliedUnits: '0' };
  const old = BigInt(user.balanceUnits);
  let next = old + BigInt(deltaUnits);
  // Floor at the credit limit (0 by default = no debt; can't go below it).
  const floor = BigInt(CREDIT_LIMIT_UNITS);
  if (next < floor) next = floor;
  const applied = next - old;
  user.balanceUnits = next.toString();
  persist();
  return { balanceUnits: user.balanceUnits, appliedUnits: applied.toString() };
}

export function hasReference(externalUserId: string, reference: string): boolean {
  const user = users.get(externalUserId);
  return !!user && user.references.includes(reference);
}

export function addReference(externalUserId: string, reference: string): void {
  const user = users.get(externalUserId);
  if (!user) return;
  user.references.push(reference);
  persist();
}

export function setGrantPeriod(externalUserId: string, period: string): void {
  const user = users.get(externalUserId);
  if (!user) return;
  user.lastGrantPeriod = period;
  persist();
}

export function addWithdrawal(externalUserId: string, w: Withdrawal): void {
  const user = users.get(externalUserId);
  if (!user) return;
  user.withdrawals.push(w);
  persist();
}

// Scan every user's withdrawals for the first one matching `pred`.
function findWithdrawal(
  pred: (w: Withdrawal) => boolean,
): { user: User; withdrawal: Withdrawal } | undefined {
  for (const user of users.values()) {
    const withdrawal = user.withdrawals.find(pred);
    if (withdrawal) return { user, withdrawal };
  }
  return undefined;
}

export function getWithdrawal(
  withdrawalId: string,
): { user: User; withdrawal: Withdrawal } | undefined {
  return findWithdrawal((w) => w.id === withdrawalId);
}

export function getWithdrawalByTransferId(
  transferId: string,
): { user: User; withdrawal: Withdrawal } | undefined {
  return findWithdrawal((w) => w.transferId === transferId);
}

export function updateWithdrawal(
  withdrawalId: string,
  patch: Partial<Withdrawal>,
): void {
  const found = findWithdrawal((w) => w.id === withdrawalId);
  if (found) {
    Object.assign(found.withdrawal, patch);
    persist();
  }
}

// --------------------------------------------------------------------------
// Events (flake-tax hangouts). Stakes are held as ledger debits; settlement
// redistributes forfeited stakes to attendees. Persisted separately.
// --------------------------------------------------------------------------

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
  multiplierBps: number; // 10000 = 1x; 15000 = 1.5x (holiday bonus, treasury-funded)
  status: 'open' | 'settled';
  rsvps: Rsvp[];
  createdAt: string;
}

const events = new Map<string, EventItem>();
const EVENTS_FILE = join(DATA_DIR, 'events.json');

function loadEvents(): void {
  // Missing file == first run: start empty. A file that EXISTS yet fails to
  // parse is a corrupt/truncated ledger (staked balances live here) — refuse to
  // boot rather than silently drop every event's held stakes.
  if (!existsSync(EVENTS_FILE)) return;
  const raw = readFileSync(EVENTS_FILE, 'utf8');
  if (raw.trim() === '') return;
  let parsed: EventItem[];
  try {
    parsed = JSON.parse(raw) as EventItem[];
  } catch (err) {
    throw new Error(
      `[store] events.json exists but is corrupt/unparseable; refusing to boot with a zeroed ledger: ${String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      '[store] events.json exists but is not a JSON array; refusing to boot with a zeroed ledger',
    );
  }
  for (const e of parsed) events.set(e.id, e);
}

function persistEvents(): void {
  atomicWrite(EVENTS_FILE, JSON.stringify([...events.values()], null, 2));
}

let initialized = false;

/**
 * Load the legacy JSON ledger only after the runtime explicitly selects the
 * local/test backend. Importing shared types in a MongoDB production process
 * must never touch local ledger files.
 */
export function initializeJsonStore(): void {
  if (initialized) return;
  load();
  loadEvents();
  initialized = true;
}

export function createEvent(ev: EventItem): EventItem {
  events.set(ev.id, ev);
  persistEvents();
  return ev;
}

export function getEvent(id: string): EventItem | undefined {
  return events.get(id);
}

// Persist after mutating an event object returned by getEvent().
export function saveEvents(): void {
  persistEvents();
}

export function eventsForUser(userId: string): EventItem[] {
  return [...events.values()].filter(
    (e) => e.host === userId || e.rsvps.some((r) => r.userId === userId),
  );
}
