import { API_URL, Destination } from './constants';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function get<T>(path: string): Promise<T> {
  return json(await fetch(`${API_URL}${path}`));
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  return json(
    await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
}

export type Withdrawal = {
  id: string;
  transferId: string;
  amountUnits: string;
  destination: Destination & { recipient_address: string };
  status: 'pending' | 'processing' | 'completed' | 'failed';
  refunded: boolean;
  createdAt: string;
};

export async function registerUser(
  externalUserId: string
): Promise<{ ok: true; externalUserId: string; balanceUnits: string }> {
  return post('/users/register', { externalUserId });
}

export async function getUser(externalUserId: string): Promise<{
  externalUserId: string;
  balanceUnits: string;
  lastGrantPeriod: string | null;
  withdrawals: Withdrawal[];
  creditLimitUnits: string;
  cashoutThresholdUnits: string;
  readyToCashOut: boolean;
}> {
  return get(`/users/${encodeURIComponent(externalUserId)}`);
}

export async function grant(externalUserId: string): Promise<{
  ok: true;
  alreadyGranted: boolean;
  period: string;
  balanceUnits: string;
}> {
  return post('/grant', { externalUserId });
}

// External-input monthly credit/debit. deltaUnits is a signed integer string.
export async function adjust(
  externalUserId: string,
  deltaUnits: string,
  reference?: string
): Promise<{
  ok: true;
  alreadyApplied: boolean;
  balanceUnits: string;
  appliedUnits: string;
  requestedDeltaUnits: string;
  clamped: boolean;
}> {
  return post('/adjust', { externalUserId, deltaUnits, reference });
}

// One-time add funds (deposit): returns a Unifold deposit address to send USDC to.
export async function addFunds(externalUserId: string): Promise<{
  ok: true;
  treasuryAddress: string;
  depositAddresses: unknown;
}> {
  return post('/add-funds', { externalUserId });
}

// Poll for arrived deposits and credit them to the balance (idempotent).
export async function refreshDeposits(externalUserId: string): Promise<{
  ok: true;
  creditedUnits: string;
  newDeposits: Array<{ id: string; amountUnits: string }>;
  balanceUnits: string;
}> {
  return post('/deposits/refresh', { externalUserId });
}

export async function withdraw(
  externalUserId: string,
  amountUnits: string,
  destination: {
    chain_type: string;
    chain_id: string;
    token_address: string;
    recipient_address: string;
  }
): Promise<{
  ok: true;
  withdrawalId: string;
  transferId: string;
  status: string;
  balanceUnits: string;
}> {
  return post('/withdraw', { externalUserId, amountUnits, destination });
}

// Live supported tokens/chains from Unifold (drives cash-out options dynamically).
export type CatalogDestination = {
  symbol: string;
  name: string;
  chain_type: string;
  chain_id: string;
  chain_name: string;
  token_address: string;
  is_stablecoin: boolean;
  icon_url?: string;
};

export async function getCatalog(): Promise<{
  ok: true;
  destinations: CatalogDestination[];
  error?: string;
}> {
  return get('/catalog');
}

// Treasury address — where beginDeposit routes funds (and the reserve backing balances).
export async function getTreasury(): Promise<{
  ok?: boolean;
  treasuryAccountId: string;
  address?: string;
  chainType?: string;
  error?: string;
}> {
  return get('/treasury');
}

// ---- Flake-tax hangouts ----

export type Rsvp = {
  userId: string;
  stakedUnits: string;
  status: 'staked' | 'attended' | 'flaked' | 'refunded';
  payoutUnits: string;
};

export type EventItem = {
  id: string;
  host: string;
  title: string;
  startsAt: string | null;
  stakeUnits: string;
  multiplierBps: number;
  status: 'open' | 'settled';
  rsvps: Rsvp[];
  createdAt: string;
};

export async function createEvent(
  host: string,
  title: string,
  stakeUnits: string,
  multiplierBps?: number
): Promise<{ ok: true; event: EventItem }> {
  return post('/events', { host, title, stakeUnits, multiplierBps });
}

export async function listEvents(userId: string): Promise<{ ok: true; events: EventItem[] }> {
  return get(`/users/${encodeURIComponent(userId)}/events`);
}

async function eventAction(
  eventId: string,
  action: 'rsvp' | 'checkin',
  userId: string
): Promise<{ ok: true; event: EventItem }> {
  return post(`/events/${encodeURIComponent(eventId)}/${action}`, { userId });
}

export const rsvpEvent = (eventId: string, userId: string) =>
  eventAction(eventId, 'rsvp', userId);
export const checkinEvent = (eventId: string, userId: string) =>
  eventAction(eventId, 'checkin', userId);

export async function settleEvent(eventId: string): Promise<{
  ok: true;
  eventId: string;
  status: string;
  forfeitPoolUnits: string;
  results: Array<{ userId: string; status: string; stakedUnits: string; payoutUnits: string }>;
}> {
  return post(`/events/${encodeURIComponent(eventId)}/settle`);
}

export async function getWithdrawal(withdrawalId: string): Promise<{
  withdrawalId: string;
  transferId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  amountUnits: string;
  destination: Destination & { recipient_address: string };
  balanceUnits: string;
}> {
  return get(`/withdrawals/${encodeURIComponent(withdrawalId)}`);
}
