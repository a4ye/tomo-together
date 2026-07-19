// Treasury-custody backend. Money runs on Unifold managed rails: users + treasury +
// outbound transfers. No per-user wallet, no user gas, no client signing.
import type { Server } from 'node:http';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { isAddress } from 'viem';
import {
  PORT,
  TREASURY_ACCOUNT_ID,
  CREDIT_LIMIT_UNITS,
  CASHOUT_THRESHOLD_UNITS,
} from './config.js';
import { unifold } from './unifold.js';
import { grant, RecurringGrantDisabledError } from './grant.js';
import { adjust, rawBalanceAdjustmentsEnabled } from './adjust.js';
import { addFunds } from './addFunds.js';
import { refreshDeposits } from './deposits.js';
import {
  IdempotencyConflictError,
  pollWithdrawal,
  validateIdempotencyKey,
  ValidationError,
  withdraw,
  WithdrawalPendingError,
} from './withdraw.js';
import {
  createHangout,
  rsvp,
  checkin,
  settle,
  TreasuryEventBonusDisabledError,
} from './events.js';
import {
  handleUnifoldWebhook,
  WebhookNotReadyError,
  WebhookVerificationError,
} from './webhooks.js';
import { getSupportedDestinations } from './catalog.js';
import { requireServiceToken } from './auth.js';
import {
  closeStore,
  getStore,
  getStoreReadiness,
  initializeStore,
  isStoreReady,
} from './runtimeStore.js';
import { MongoStoreConflictError } from './mongoStore.js';

export const app = express();

type AsyncRequestHandler = (req: Request, res: Response) => Promise<unknown>;

// Express 4 does not automatically forward rejected promises from async route
// handlers. Always turn a rejection into next(error) so requests cannot hang.
function asyncRoute(handler: AsyncRequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };
}

// Azure and container health probes must remain usable without credentials.
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

// Readiness is deliberately stricter than liveness. A process can be alive
// while Atlas is still connecting (or startup has failed), but it must not
// receive business traffic until the datastore has initialized and its indexes
// exist.
app.get(['/ready', '/readyz'], asyncRoute(async (_req: Request, res: Response) => {
  const ready = await isStoreReady();
  const readiness = getStoreReadiness();
  res.status(ready ? 200 : 503).json({
    ok: ready,
    state: readiness.state,
    backend: readiness.backend,
  });
}));

// Webhooks need the RAW body for HMAC verification, so this route is registered
// with express.raw BEFORE the global express.json() parser.
app.post(
  '/webhooks/unifold',
  express.raw({ type: 'application/json' }),
  asyncRoute(async (req: Request, res: Response) => {
    try {
      const result = await handleUnifoldWebhook(req.body, req.headers as Record<string, unknown>);
      res.status(200).json({ received: true, ...result });
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        console.warn('[webhook] verification rejected:', err.message);
        res.sendStatus(400);
        return;
      }
      console.error('[webhook] processing failed:', err instanceof Error ? err.message : err);
      res
        .status(err instanceof WebhookNotReadyError ? 503 : 500)
        .json({ received: false, error: 'webhook processing failed; retry later' });
    }
  }),
);

// SECURITY: every route registered below this line — including the treasury-
// moving /adjust and /withdraw — requires the shared CRYPTO_SERVICE_TOKEN
// bearer (constant-time check in auth.ts). Only the health/readiness probes
// above stay public, and the provider webhook above is authenticated by its
// HMAC signature instead. Reject unauthenticated business requests before
// parsing their bodies.
app.use(requireServiceToken);
app.use(express.json());

// Map ValidationError → 400, anything else → 500.
function handleErr(res: Response, err: unknown): Response {
  if (err instanceof RecurringGrantDisabledError) {
    return res.status(err.statusCode).json({ ok: false, error: err.message });
  }
  if (err instanceof TreasuryEventBonusDisabledError) {
    return res.status(err.statusCode).json({ ok: false, error: err.message });
  }
  if (err instanceof ValidationError) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  if (err instanceof MongoStoreConflictError) {
    return res.status(409).json({ ok: false, error: err.message });
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error('[request] operation failed:', message);
  return res.status(500).json({
    ok: false,
    error: process.env.NODE_ENV === 'production' ? 'internal server error' : message,
  });
}

function operationalError(message: string, productionFallback: string): string {
  return process.env.NODE_ENV === 'production' ? productionFallback : message;
}

// Validate that the body carries a known externalUserId. On failure, sends the
// matching error response (400 missing / 404 unknown) and returns null.
async function requireUserFromBody(req: Request, res: Response): Promise<string | null> {
  const { externalUserId } = req.body ?? {};
  if (typeof externalUserId !== 'string' || externalUserId.trim() === '') {
    res.status(400).json({ ok: false, error: 'externalUserId is required' });
    return null;
  }
  if (!(await getStore().getUser(externalUserId))) {
    res.status(404).json({ ok: false, error: 'user not found' });
    return null;
  }
  return externalUserId;
}

app.post('/users/register', asyncRoute(async (req: Request, res: Response) => {
  const { externalUserId } = req.body ?? {};
  if (typeof externalUserId !== 'string' || externalUserId.trim() === '') {
    return res.status(400).json({ ok: false, error: 'externalUserId is required' });
  }
  const user = await getStore().registerUser(externalUserId);
  res.json({ ok: true, externalUserId: user.externalUserId, balanceUnits: user.balanceUnits });
}));

app.get('/users/:externalUserId', asyncRoute(async (req: Request, res: Response) => {
  const user = await getStore().getUser(req.params.externalUserId);
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
}));

app.post('/grant', asyncRoute(async (req: Request, res: Response) => {
  const externalUserId = await requireUserFromBody(req, res);
  if (externalUserId === null) return;
  try {
    const result = await grant(externalUserId);
    res.json({ ok: true, ...result });
  } catch (err) {
    handleErr(res, err);
  }
}));

// The `deposit:<execId>` reference namespace is reserved for internal deposit
// crediting (deposits.ts/webhooks.ts call adjust() with it directly). Untrusted
// callers must not be able to write into it, or they could pre-register a
// victim's future deposit ref and cause the real deposit to be dropped.
function isReservedReference(reference: string): boolean {
  const normalized = reference.toLowerCase();
  return normalized.startsWith('deposit:') || normalized.startsWith('settle:');
}

function requireIdempotencyKey(req: Request): string {
  const values: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === 'idempotency-key') {
      values.push(req.rawHeaders[index + 1] ?? '');
    }
  }
  if (values.length !== 1) {
    throw new ValidationError('exactly one Idempotency-Key header is required');
  }
  return validateIdempotencyKey(values[0]);
}

function handleWithdrawalError(res: Response, error: unknown): Response {
  if (error instanceof ValidationError) {
    return res.status(400).json({ ok: false, error: error.message });
  }
  if (error instanceof IdempotencyConflictError) {
    return res.status(409).json({ ok: false, error: error.message });
  }
  if (error instanceof WithdrawalPendingError) {
    return res.status(202).json({
      ok: false,
      pending: true,
      withdrawalId: error.withdrawalId,
      error: error.message,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error('[withdraw] unifold error:', message);
  return res.status(500).json({
    ok: false,
    error: process.env.NODE_ENV === 'production' ? 'withdrawal processing failed' : message,
  });
}

// External-input monthly credit/debit. `deltaUnits` is a signed integer string
// (e.g. "4000000" to add 4 USDC, "-3000000" to take 3 USDC). Balance floors at 0.
// Optional `reference` makes a given adjustment idempotent (e.g. a "2026-07" tag).
app.post('/adjust', asyncRoute(async (req: Request, res: Response) => {
  // A public arbitrary credit/debit API can directly drain a real treasury.
  // Production keeps it closed unless the operator explicitly opts in.
  if (!rawBalanceAdjustmentsEnabled()) {
    return res.status(403).json({
      ok: false,
      error: 'raw balance adjustments are disabled',
    });
  }
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
  if (!(await getStore().getUser(externalUserId))) {
    return res.status(404).json({ ok: false, error: 'user not found' });
  }
  const ref = typeof reference === 'string' && reference.trim() !== '' ? reference : undefined;
  const result = await adjust(externalUserId, deltaUnits, ref);
  res.json({ ok: true, ...result });
}));

// One-time "add funds" (deposit): returns a Unifold deposit address to send USDC to.
app.post('/add-funds', asyncRoute(async (req: Request, res: Response) => {
  const externalUserId = await requireUserFromBody(req, res);
  if (externalUserId === null) return;
  try {
    const result = await addFunds(externalUserId);
    res.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[add-funds] error:', message);
    res.status(500).json({
      ok: false,
      error: operationalError(message, 'add-funds request failed'),
    });
  }
}));

// Poll for arrived deposits and credit them to the balance (idempotent).
app.post('/deposits/refresh', asyncRoute(async (req: Request, res: Response) => {
  const externalUserId = await requireUserFromBody(req, res);
  if (externalUserId === null) return;
  try {
    const result = await refreshDeposits(externalUserId);
    res.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[deposits/refresh] error:', message);
    res.status(500).json({
      ok: false,
      error: operationalError(message, 'deposit refresh failed'),
    });
  }
}));

app.post('/withdraw', asyncRoute(async (req: Request, res: Response) => {
  const { externalUserId, amountUnits, destination } = req.body ?? {};

  try {
    const idempotencyKey = requireIdempotencyKey(req);
    if (typeof externalUserId !== 'string' || externalUserId.trim() === '') {
      throw new ValidationError('externalUserId is required');
    }
    if (!destination || typeof destination !== 'object') {
      throw new ValidationError('destination is required');
    }
    const { chain_type, chain_id, token_address, recipient_address } = destination;
    for (const [field, value] of [
      ['chain_type', chain_type],
      ['chain_id', chain_id],
      ['token_address', token_address],
    ] as const) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new ValidationError(`${field} is required`);
      }
    }
    if (typeof recipient_address !== 'string' || recipient_address.trim() === '') {
      throw new ValidationError('recipient_address is required');
    }
    // This service currently supports EVM destinations only. Enforce the
    // exact provider chain type instead of allowing another spelling/type to
    // bypass address validation.
    if (chain_type !== 'ethereum') {
      throw new ValidationError('chain_type must be ethereum');
    }
    if (!/^\d+$/.test(chain_id) || BigInt(chain_id) <= 0n) {
      throw new ValidationError('chain_id must be a positive decimal chain id');
    }
    if (!isAddress(token_address)) {
      throw new ValidationError('token_address is not a valid EVM address');
    }
    if (!isAddress(recipient_address)) {
      throw new ValidationError('recipient_address is not a valid EVM address');
    }

    const dest = {
      chain_type,
      chain_id,
      token_address,
      recipient_address,
    };

    const result = await withdraw(externalUserId, amountUnits, dest, idempotencyKey);
    res.json({ ok: true, ...result });
  } catch (err) {
    handleWithdrawalError(res, err);
  }
}));

app.get('/withdrawals/:withdrawalId', asyncRoute(async (req: Request, res: Response) => {
  if (!(await getStore().getWithdrawal(req.params.withdrawalId))) {
    return res.status(404).json({ ok: false, error: 'withdrawal not found' });
  }
  try {
    const result = await pollWithdrawal(req.params.withdrawalId);
    res.json(result);
  } catch (err) {
    handleWithdrawalError(res, err);
  }
}));

// Live supported tokens/chains from Unifold — drives the app's cash-out options.
// Non-fatal: on error returns an empty list and the app falls back to its presets.
app.get('/catalog', asyncRoute(async (_req: Request, res: Response) => {
  try {
    const destinations = await getSupportedDestinations();
    res.json({ ok: true, destinations });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[catalog] falling back — could not fetch supported tokens:', message);
    res.json({
      ok: true,
      destinations: [],
      error: operationalError(message, 'catalog temporarily unavailable'),
    });
  }
}));

app.get('/treasury', asyncRoute(async (_req: Request, res: Response) => {
  try {
    const acct = await unifold.treasury.accounts.retrieve(TREASURY_ACCOUNT_ID);
    res.json({
      treasuryAccountId: TREASURY_ACCOUNT_ID,
      address: acct.address,
      chainType: acct.chain_type,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.json({
      treasuryAccountId: TREASURY_ACCOUNT_ID,
      error: operationalError(message, 'treasury temporarily unavailable'),
    });
  }
}));

// ---- Flake-tax hangouts ----

app.post('/events', asyncRoute(async (req: Request, res: Response) => {
  const { host, title, stakeUnits, startsAt, multiplierBps } = req.body ?? {};
  try {
    const event = await createHangout(host, title, stakeUnits, { startsAt, multiplierBps });
    res.json({ ok: true, event });
  } catch (err) {
    handleErr(res, err);
  }
}));

app.post('/events/:id/rsvp', asyncRoute(async (req: Request, res: Response) => {
  const { userId } = req.body ?? {};
  try {
    if (typeof userId !== 'string' || userId.trim() === '') {
      throw new ValidationError('userId is required');
    }
    const event = await rsvp(req.params.id, userId);
    res.json({ ok: true, event });
  } catch (err) {
    handleErr(res, err);
  }
}));

app.post('/events/:id/checkin', asyncRoute(async (req: Request, res: Response) => {
  const { userId } = req.body ?? {};
  try {
    if (typeof userId !== 'string' || userId.trim() === '') {
      throw new ValidationError('userId is required');
    }
    const event = await checkin(req.params.id, userId);
    res.json({ ok: true, event });
  } catch (err) {
    handleErr(res, err);
  }
}));

app.post('/events/:id/settle', asyncRoute(async (req: Request, res: Response) => {
  try {
    const result = await settle(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    handleErr(res, err);
  }
}));

app.get('/events/:id', asyncRoute(async (req: Request, res: Response) => {
  const event = await getStore().getEvent(req.params.id);
  if (!event) return res.status(404).json({ ok: false, error: 'event not found' });
  res.json({ ok: true, event });
}));

app.get('/users/:externalUserId/events', asyncRoute(async (req: Request, res: Response) => {
  res.json({ ok: true, events: await getStore().eventsForUser(req.params.externalUserId) });
}));

app.use((error: unknown, _req: Request, res: Response, next: NextFunction): void => {
  if (res.headersSent) {
    next(error);
    return;
  }
  console.error('[request] unhandled route error:', error instanceof Error ? error.message : error);
  handleErr(res, error);
});

export interface StoreLifecycle {
  initializeStore(): Promise<unknown>;
  closeStore(): Promise<void>;
}

export interface StartServerOptions {
  port?: number;
  installSignalHandlers?: boolean;
  shutdownTimeoutMs?: number;
  lifecycle?: StoreLifecycle;
  /** Test seam used to prove a failed datastore initialization never binds. */
  listen?: (port: number) => Server;
}

export interface RunningCryptoServer {
  readonly server: Server;
  /** Idempotently stop accepting traffic, drain HTTP, then close the datastore. */
  shutdown(signal?: NodeJS.Signals | string): Promise<void>;
}

const defaultLifecycle: StoreLifecycle = {
  initializeStore,
  closeStore,
};

function waitForListening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

function closeHttpServer(server: Server, timeoutMs: number): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      // Stop pathological keep-alive/streaming clients from blocking container
      // termination forever after the graceful window has elapsed.
      server.closeAllConnections?.();
      finish(new Error(`HTTP shutdown exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
    server.close((error) => {
      finish(error);
    });
    // Node 18+ can immediately retire idle keep-alive sockets while allowing
    // active requests to finish through server.close().
    server.closeIdleConnections?.();
  });
}

/**
 * Initialize the single process-wide store before accepting any traffic.
 * Mongo connection or index failures reject this function and leave the port
 * unbound, which is the intended production fail-closed behavior.
 *
 * SECURITY: this process holds treasury custody and must NOT be exposed to the
 * public internet — deploy it so it is reachable only by the trusted app
 * server on a private network. The CRYPTO_SERVICE_TOKEN bearer required on all
 * business routes is defense in depth, not a substitute for that isolation.
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningCryptoServer> {
  const port = options.port ?? PORT;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) {
    throw new TypeError('shutdownTimeoutMs must be a positive number');
  }
  const lifecycle = options.lifecycle ?? defaultLifecycle;

  await lifecycle.initializeStore();

  let server: Server;
  try {
    server = options.listen ? options.listen(port) : app.listen(port);
    await waitForListening(server);
  } catch (error) {
    await lifecycle.closeStore().catch((closeError: unknown) => {
      console.error(
        '[shutdown] datastore cleanup after listen failure failed:',
        closeError instanceof Error ? closeError.message : closeError,
      );
    });
    throw error;
  }

  let shutdownPromise: Promise<void> | undefined;
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  let signalHandler: ((signal: NodeJS.Signals) => void) | undefined;

  const shutdown = (signal?: NodeJS.Signals | string): Promise<void> => {
    shutdownPromise ??= (async () => {
      if (signal) console.log(`[shutdown] received ${signal}; draining crypto service`);
      if (signalHandler) {
        for (const registeredSignal of signals) {
          process.off(registeredSignal, signalHandler);
        }
      }

      let httpError: unknown;
      try {
        await closeHttpServer(server, shutdownTimeoutMs);
      } catch (error) {
        httpError = error;
      }

      try {
        await lifecycle.closeStore();
      } catch (storeError) {
        if (httpError) {
          throw new AggregateError(
            [httpError, storeError],
            'HTTP server and datastore both failed to close cleanly',
          );
        }
        throw storeError;
      }

      if (httpError) throw httpError;
    })();
    return shutdownPromise;
  };

  if (options.installSignalHandlers !== false) {
    signalHandler = (signal: NodeJS.Signals) => {
      void shutdown(signal).catch((error: unknown) => {
        console.error(
          '[shutdown] crypto service did not close cleanly:',
          error instanceof Error ? error.message : error,
        );
        process.exitCode = 1;
      });
    };
    for (const signal of signals) process.once(signal, signalHandler);
  }

  console.log(`Unifold treasury-custody server listening on http://localhost:${port}`);
  console.log(
    `Using Unifold treasury ${TREASURY_ACCOUNT_ID}. USDC grants are held in the treasury; withdrawals route via outbound transfers (Unifold pays gas).`,
  );

  return { server, shutdown };
}

// Tests import `app` and initialize the explicit JSON backend themselves.
if (process.env.NODE_ENV !== 'test') {
  void startServer().catch((error: unknown) => {
    console.error(
      '[startup] crypto service failed before listening:',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  });
}
