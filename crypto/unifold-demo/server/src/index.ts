// Treasury-custody backend. Money runs on Unifold managed rails: users + treasury +
// outbound transfers. No per-user wallet, no user gas, no client signing.
import express, { type Request, type Response } from 'express';
import { isAddress } from 'viem';
import {
  PORT,
  TREASURY_ACCOUNT_ID,
  CREDIT_LIMIT_UNITS,
  CASHOUT_THRESHOLD_UNITS,
} from './config.js';
import { unifold } from './unifold.js';
import { registerUser, getUser, getWithdrawal, getEvent, eventsForUser } from './store.js';
import { grant } from './grant.js';
import { adjust } from './adjust.js';
import { addFunds } from './addFunds.js';
import { refreshDeposits } from './deposits.js';
import { withdraw, pollWithdrawal, ValidationError } from './withdraw.js';
import { createHangout, rsvp, checkin, settle } from './events.js';
import { handleUnifoldWebhook } from './webhooks.js';
import { getSupportedDestinations } from './catalog.js';

export const app = express();

// Webhooks need the RAW body for HMAC verification, so this route is registered
// with express.raw BEFORE the global express.json() parser.
app.post(
  '/webhooks/unifold',
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response) => {
    try {
      const result = await handleUnifoldWebhook(req.body, req.headers as Record<string, unknown>);
      res.status(200).json({ received: true, ...result });
    } catch (err) {
      console.error('[webhook] rejected:', err instanceof Error ? err.message : err);
      res.sendStatus(400);
    }
  },
);

app.use(express.json());

// Map ValidationError → 400, anything else → 500.
function handleErr(res: Response, err: unknown): Response {
  if (err instanceof ValidationError) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  const message = err instanceof Error ? err.message : String(err);
  return res.status(500).json({ ok: false, error: message });
}

// Validate that the body carries a known externalUserId. On failure, sends the
// matching error response (400 missing / 404 unknown) and returns null.
function requireUserFromBody(req: Request, res: Response): string | null {
  const { externalUserId } = req.body ?? {};
  if (typeof externalUserId !== 'string' || externalUserId.trim() === '') {
    res.status(400).json({ ok: false, error: 'externalUserId is required' });
    return null;
  }
  if (!getUser(externalUserId)) {
    res.status(404).json({ ok: false, error: 'user not found' });
    return null;
  }
  return externalUserId;
}

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

app.post('/users/register', (req: Request, res: Response) => {
  const { externalUserId } = req.body ?? {};
  if (typeof externalUserId !== 'string' || externalUserId.trim() === '') {
    return res.status(400).json({ ok: false, error: 'externalUserId is required' });
  }
  const user = registerUser(externalUserId);
  res.json({ ok: true, externalUserId: user.externalUserId, balanceUnits: user.balanceUnits });
});

app.get('/users/:externalUserId', (req: Request, res: Response) => {
  const user = getUser(req.params.externalUserId);
  if (!user) {
    return res.status(404).json({ ok: false, error: 'user not found' });
  }
  res.json({
    externalUserId: user.externalUserId,
    balanceUnits: user.balanceUnits,
    lastGrantPeriod: user.lastGrantPeriod,
    withdrawals: user.withdrawals,
    // Net-settlement band: only touch the chain at the edges.
    creditLimitUnits: CREDIT_LIMIT_UNITS,
    cashoutThresholdUnits: CASHOUT_THRESHOLD_UNITS,
    readyToCashOut: BigInt(user.balanceUnits) >= BigInt(CASHOUT_THRESHOLD_UNITS),
  });
});

app.post('/grant', async (req: Request, res: Response) => {
  const externalUserId = requireUserFromBody(req, res);
  if (externalUserId === null) return;
  try {
    const result = await grant(externalUserId);
    res.json({ ok: true, ...result });
  } catch (err) {
    handleErr(res, err);
  }
});

// The `deposit:<execId>` reference namespace is reserved for internal deposit
// crediting (deposits.ts/webhooks.ts call adjust() with it directly). Untrusted
// callers must not be able to write into it, or they could pre-register a
// victim's future deposit ref and cause the real deposit to be dropped.
function isReservedReference(reference: string): boolean {
  return reference.toLowerCase().startsWith('deposit:');
}

// External-input monthly credit/debit. `deltaUnits` is a signed integer string
// (e.g. "4000000" to add 4 USDC, "-3000000" to take 3 USDC). Balance floors at 0.
// Optional `reference` makes a given adjustment idempotent (e.g. a "2026-07" tag).
app.post('/adjust', (req: Request, res: Response) => {
  const { externalUserId, deltaUnits, reference } = req.body ?? {};
  if (typeof externalUserId !== 'string' || externalUserId.trim() === '') {
    return res.status(400).json({ ok: false, error: 'externalUserId is required' });
  }
  if (typeof deltaUnits !== 'string' || !/^-?\d+$/.test(deltaUnits)) {
    return res.status(400).json({ ok: false, error: 'deltaUnits must be a signed integer string' });
  }
  // Guard the internal deposit namespace at the untrusted route boundary.
  if (typeof reference === 'string' && isReservedReference(reference)) {
    return res.status(400).json({ ok: false, error: 'reference uses a reserved prefix' });
  }
  if (!getUser(externalUserId)) {
    return res.status(404).json({ ok: false, error: 'user not found' });
  }
  const ref = typeof reference === 'string' && reference.trim() !== '' ? reference : undefined;
  const result = adjust(externalUserId, deltaUnits, ref);
  res.json({ ok: true, ...result });
});

// One-time "add funds" (deposit): returns a Unifold deposit address to send USDC to.
app.post('/add-funds', async (req: Request, res: Response) => {
  const externalUserId = requireUserFromBody(req, res);
  if (externalUserId === null) return;
  try {
    const result = await addFunds(externalUserId);
    res.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[add-funds] error:', message);
    res.status(500).json({ ok: false, error: message });
  }
});

// Poll for arrived deposits and credit them to the balance (idempotent).
app.post('/deposits/refresh', async (req: Request, res: Response) => {
  const externalUserId = requireUserFromBody(req, res);
  if (externalUserId === null) return;
  try {
    const result = await refreshDeposits(externalUserId);
    res.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[deposits/refresh] error:', message);
    res.status(500).json({ ok: false, error: message });
  }
});

app.post('/withdraw', async (req: Request, res: Response) => {
  const { externalUserId, amountUnits, destination } = req.body ?? {};

  try {
    if (typeof externalUserId !== 'string' || externalUserId.trim() === '') {
      throw new ValidationError('externalUserId is required');
    }
    if (!destination || typeof destination !== 'object') {
      throw new ValidationError('destination is required');
    }
    const { chain_type, chain_id, token_address, recipient_address } = destination;
    if (typeof recipient_address !== 'string' || recipient_address.trim() === '') {
      throw new ValidationError('recipient_address is required');
    }
    // All presets are ethereum-type EVM chains.
    if (chain_type === 'ethereum' && !isAddress(recipient_address)) {
      throw new ValidationError('recipient_address is not a valid EVM address');
    }

    const dest = {
      chain_type: String(chain_type),
      chain_id: String(chain_id),
      token_address: String(token_address),
      recipient_address,
    };

    const result = await withdraw(externalUserId, amountUnits, dest);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[withdraw] unifold error:', message);
    res.status(500).json({ ok: false, error: message });
  }
});

app.get('/withdrawals/:withdrawalId', async (req: Request, res: Response) => {
  if (!getWithdrawal(req.params.withdrawalId)) {
    return res.status(404).json({ ok: false, error: 'withdrawal not found' });
  }
  try {
    const result = await pollWithdrawal(req.params.withdrawalId);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[withdrawals] unifold error:', message);
    res.status(500).json({ ok: false, error: message });
  }
});

// Live supported tokens/chains from Unifold — drives the app's cash-out options.
// Non-fatal: on error returns an empty list and the app falls back to its presets.
app.get('/catalog', async (_req: Request, res: Response) => {
  try {
    const destinations = await getSupportedDestinations();
    res.json({ ok: true, destinations });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[catalog] falling back — could not fetch supported tokens:', message);
    res.json({ ok: true, destinations: [], error: message });
  }
});

app.get('/treasury', async (_req: Request, res: Response) => {
  try {
    const acct = await unifold.treasury.accounts.retrieve(TREASURY_ACCOUNT_ID);
    res.json({
      treasuryAccountId: TREASURY_ACCOUNT_ID,
      address: acct.address,
      chainType: acct.chain_type,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.json({ treasuryAccountId: TREASURY_ACCOUNT_ID, error: message });
  }
});

// ---- Flake-tax hangouts ----

app.post('/events', (req: Request, res: Response) => {
  const { host, title, stakeUnits, startsAt, multiplierBps } = req.body ?? {};
  try {
    const event = createHangout(host, title, stakeUnits, { startsAt, multiplierBps });
    res.json({ ok: true, event });
  } catch (err) {
    handleErr(res, err);
  }
});

app.post('/events/:id/rsvp', (req: Request, res: Response) => {
  const { userId } = req.body ?? {};
  try {
    if (typeof userId !== 'string' || userId.trim() === '') {
      throw new ValidationError('userId is required');
    }
    const event = rsvp(req.params.id, userId);
    res.json({ ok: true, event });
  } catch (err) {
    handleErr(res, err);
  }
});

app.post('/events/:id/checkin', (req: Request, res: Response) => {
  const { userId } = req.body ?? {};
  try {
    if (typeof userId !== 'string' || userId.trim() === '') {
      throw new ValidationError('userId is required');
    }
    const event = checkin(req.params.id, userId);
    res.json({ ok: true, event });
  } catch (err) {
    handleErr(res, err);
  }
});

app.post('/events/:id/settle', (req: Request, res: Response) => {
  try {
    const result = settle(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    handleErr(res, err);
  }
});

app.get('/events/:id', (req: Request, res: Response) => {
  const event = getEvent(req.params.id);
  if (!event) return res.status(404).json({ ok: false, error: 'event not found' });
  res.json({ ok: true, event });
});

app.get('/users/:externalUserId/events', (req: Request, res: Response) => {
  res.json({ ok: true, events: eventsForUser(req.params.externalUserId) });
});

// Only start listening when run directly (tests import `app` without a live port).
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Unifold treasury-custody server listening on http://localhost:${PORT}`);
    console.log(
      `Using Unifold treasury ${TREASURY_ACCOUNT_ID}. USDC grants are held in the treasury; withdrawals route via outbound transfers (Unifold pays gas).`,
    );
  });
}
