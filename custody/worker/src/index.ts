// Treasury-custody backend on Hono. Money runs on Unifold managed rails:
// users + treasury + outbound transfers. No per-user wallet, no user gas, no
// client signing.
//
// Route order is Express's and it is load-bearing:
//   GET /health, GET /ready|/readyz, POST /webhooks/unifold   <- public
//   app.use(requireServiceToken)                              <- the gate
//   app.use(express.json())
//   ...every business route...
//
// Because the gate sits in front of BOTH routing and the body parser, an unknown
// path, a wrong method on /health, and an OPTIONS preflight all answer
// 401 {"ok":false,"error":"unauthorized"} rather than 404/204. There are no CORS
// headers anywhere, by design.
import { Hono } from 'hono';
import { isAddress } from 'viem';

import type { Env } from './env';
import { config, rawBalanceAdjustmentsEnabled } from './config';
import { requireServiceToken } from './auth';
import { D1Store, StoreConflictError } from './store/d1Store';
import {
  RecurringGrantDisabledError, addFunds, adjust, getSupportedDestinations, grant, refreshDeposits,
} from './domain/money';
import {
  IdempotencyConflictError, ValidationError, WithdrawalPendingError, pollWithdrawal,
  validateIdempotencyKey, withdraw,
} from './domain/withdraw';
import {
  TreasuryEventBonusDisabledError, checkin, createHangout, rsvp, settle,
} from './domain/events';
import { WebhookNotReadyError, WebhookVerificationError, handleUnifoldWebhook } from './domain/webhooks';
import { unifoldClient } from './unifold/client';
import { POWERED_BY, json, sendBody } from './http/express';

interface Ctx {
  Bindings: Env;
  Variables: { store: D1Store; body: any };
}

const app = new Hono<Ctx>({ strict: false });

const jsonRes = (c: any, value: unknown, status = 200) =>
  json(c.req.raw.headers, c.req.method, value, { status });

app.use('*', async (c, next) => {
  c.set('store', new D1Store(c.env.DB, c.env.CREDIT_LIMIT_UNITS ?? '0'));
  await next();
});

// Azure and container health probes must remain usable without credentials.
app.get('/health', (c) => jsonRes(c, { ok: true }));

// Readiness is deliberately stricter than liveness: a process can be alive while
// the datastore is still connecting, but it must not receive business traffic
// until the datastore has initialized.
const readiness = async (c: any) => {
  let ready = false;
  let state = 'ready';
  try {
    ready = await c.get('store').checkReady();
    state = ready ? 'ready' : 'degraded';
  } catch {
    state = 'degraded';
  }
  return jsonRes(
    c,
    { ok: ready, state, backend: backendName(c.env) },
    ready ? 200 : 503,
  );
};
app.get('/ready', readiness);
app.get('/readyz', readiness);

/**
 * `/ready` echoes the CONFIGURED storage backend, exactly as
 * runtimeStore.getStoreReadiness() did. On Azure that value is "mongodb"; here
 * the ledger is D1, so it is "d1". Reporting "mongodb" from a service whose
 * money now lives in D1 would be a false operational signal on the
 * highest-blast-radius component in the estate, so the honest value is emitted
 * and the divergence is written down instead of hidden.
 */
function backendName(env: Env): string {
  const value = env.CRYPTO_STORE_BACKEND?.trim().toLowerCase();
  return value === 'd1' || value === 'mongodb' || value === 'json' ? value : 'unconfigured';
}

// Webhooks need the RAW body for HMAC verification, so this route is registered
// BEFORE the global JSON parser and above the service-token gate: it is
// authenticated by its signature instead.
app.post('/webhooks/unifold', async (c) => {
  try {
    const raw = await c.req.raw.text();
    const headers: Record<string, string> = {};
    for (const [k, v] of c.req.raw.headers) headers[k] = v;
    const result = await handleUnifoldWebhook(c.env, c.get('store'), raw, headers);
    return jsonRes(c, { received: true, ...result });
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      console.warn('[webhook] verification rejected:', err.message);
      // res.sendStatus(400): text/plain, body "Bad Request".
      return sendBody(c.req.raw.headers, c.req.method, 'Bad Request', {
        status: 400,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    console.error('[webhook] processing failed:', err instanceof Error ? err.message : err);
    return jsonRes(
      c,
      { received: false, error: 'webhook processing failed; retry later' },
      err instanceof WebhookNotReadyError ? 503 : 500,
    );
  }
});

// SECURITY: every route below this line — including the treasury-moving /adjust
// and /withdraw — requires the shared CRYPTO_SERVICE_TOKEN bearer (constant-time
// check in auth.ts). Only the health/readiness probes above stay public, and the
// provider webhook above is authenticated by its HMAC signature instead.
app.use('*', requireServiceToken);

// express.json() — after the gate, so an unauthenticated body is never parsed.
app.use('*', async (c, next) => {
  const type = c.req.header('content-type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type.trim())) {
    c.set('body', {});
    return next();
  }
  const raw = await c.req.raw.text();
  if (raw.trim() === '') {
    c.set('body', {});
    return next();
  }
  try {
    c.set('body', JSON.parse(raw));
  } catch (error) {
    throw new SyntaxError(error instanceof Error ? error.message : 'invalid json');
  }
  return next();
});

// Map ValidationError -> 400, anything else -> 500.
function handleErr(c: any, err: unknown) {
  if (err instanceof RecurringGrantDisabledError || err instanceof TreasuryEventBonusDisabledError) {
    return jsonRes(c, { ok: false, error: err.message }, err.statusCode);
  }
  if (err instanceof ValidationError) return jsonRes(c, { ok: false, error: err.message }, 400);
  if (err instanceof StoreConflictError) return jsonRes(c, { ok: false, error: err.message }, 409);
  const message = err instanceof Error ? err.message : String(err);
  console.error('[request] operation failed:', message);
  return jsonRes(
    c,
    { ok: false, error: c.env.NODE_ENV === 'production' ? 'internal server error' : message },
    500,
  );
}

const operationalError = (env: Env, message: string, productionFallback: string): string =>
  env.NODE_ENV === 'production' ? productionFallback : message;

function handleWithdrawalError(c: any, error: unknown) {
  if (error instanceof ValidationError) return jsonRes(c, { ok: false, error: error.message }, 400);
  if (error instanceof IdempotencyConflictError) {
    return jsonRes(c, { ok: false, error: error.message }, 409);
  }
  if (error instanceof WithdrawalPendingError) {
    return jsonRes(
      c,
      { ok: false, pending: true, withdrawalId: error.withdrawalId, error: error.message },
      202,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error('[withdraw] unifold error:', message);
  return jsonRes(
    c,
    { ok: false, error: c.env.NODE_ENV === 'production' ? 'withdrawal processing failed' : message },
    500,
  );
}

/** 400 when externalUserId is missing, 404 when it is unknown. */
async function requireUserFromBody(c: any): Promise<string | Response> {
  const { externalUserId } = c.get('body') ?? {};
  if (typeof externalUserId !== 'string' || externalUserId.trim() === '') {
    return jsonRes(c, { ok: false, error: 'externalUserId is required' }, 400);
  }
  if (!(await c.get('store').getUser(externalUserId))) {
    return jsonRes(c, { ok: false, error: 'user not found' }, 404);
  }
  return externalUserId;
}

app.post('/users/register', async (c) => {
  const { externalUserId } = c.get('body') ?? {};
  if (typeof externalUserId !== 'string' || externalUserId.trim() === '') {
    return jsonRes(c, { ok: false, error: 'externalUserId is required' }, 400);
  }
  const user = await c.get('store').registerUser(externalUserId);
  return jsonRes(c, { ok: true, externalUserId: user.externalUserId, balanceUnits: user.balanceUnits });
});

app.get('/users/:externalUserId', async (c) => {
  const cfg = config(c.env);
  const user = await c.get('store').getUser(c.req.param('externalUserId'));
  if (!user) return jsonRes(c, { ok: false, error: 'user not found' }, 404);
  return jsonRes(c, {
    externalUserId: user.externalUserId,
    balanceUnits: user.balanceUnits,
    lastGrantPeriod: user.lastGrantPeriod,
    withdrawals: user.withdrawals,
    // Net-settlement band: only touch the chain at the edges.
    creditLimitUnits: cfg.CREDIT_LIMIT_UNITS,
    cashoutThresholdUnits: cfg.CASHOUT_THRESHOLD_UNITS,
    readyToCashOut: BigInt(user.balanceUnits) >= BigInt(cfg.CASHOUT_THRESHOLD_UNITS),
  });
});

app.get('/users/:externalUserId/events', async (c) =>
  jsonRes(c, { ok: true, events: await c.get('store').eventsForUser(c.req.param('externalUserId')) }));

app.post('/grant', async (c) => {
  const externalUserId = await requireUserFromBody(c);
  if (typeof externalUserId !== 'string') return externalUserId;
  try {
    return jsonRes(c, { ok: true, ...(await grant(c.env, c.get('store'), externalUserId)) });
  } catch (err) {
    return handleErr(c, err);
  }
});

/**
 * The `deposit:` / `settle:` reference namespaces are reserved for internal
 * crediting. An untrusted caller must not be able to pre-register a victim's
 * future deposit ref and cause the real deposit to be dropped.
 */
const isReservedReference = (reference: string): boolean => {
  const normalized = reference.toLowerCase();
  return normalized.startsWith('deposit:') || normalized.startsWith('settle:');
};

app.post('/adjust', async (c) => {
  // A public arbitrary credit/debit API can directly drain a real treasury.
  if (!rawBalanceAdjustmentsEnabled(c.env)) {
    return jsonRes(c, { ok: false, error: 'raw balance adjustments are disabled' }, 403);
  }
  const { externalUserId, deltaUnits, reference } = c.get('body') ?? {};
  if (typeof externalUserId !== 'string' || externalUserId.trim() === '') {
    return jsonRes(c, { ok: false, error: 'externalUserId is required' }, 400);
  }
  if (typeof deltaUnits !== 'string' || !/^-?\d+$/.test(deltaUnits)) {
    return jsonRes(c, { ok: false, error: 'deltaUnits must be a signed integer string' }, 400);
  }
  if (typeof reference === 'string' && isReservedReference(reference)) {
    return jsonRes(c, { ok: false, error: 'reference uses a reserved prefix' }, 400);
  }
  if (!(await c.get('store').getUser(externalUserId))) {
    return jsonRes(c, { ok: false, error: 'user not found' }, 404);
  }
  const ref = typeof reference === 'string' && reference.trim() !== '' ? reference : undefined;
  return jsonRes(c, { ok: true, ...(await adjust(c.get('store'), externalUserId, deltaUnits, ref)) });
});

app.post('/add-funds', async (c) => {
  const externalUserId = await requireUserFromBody(c);
  if (typeof externalUserId !== 'string') return externalUserId;
  try {
    return jsonRes(c, { ok: true, ...(await addFunds(c.env, externalUserId)) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[add-funds] error:', message);
    return jsonRes(c, { ok: false, error: operationalError(c.env, message, 'add-funds request failed') }, 500);
  }
});

app.post('/deposits/refresh', async (c) => {
  const externalUserId = await requireUserFromBody(c);
  if (typeof externalUserId !== 'string') return externalUserId;
  try {
    return jsonRes(c, { ok: true, ...(await refreshDeposits(c.env, c.get('store'), externalUserId)) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[deposits/refresh] error:', message);
    return jsonRes(c, { ok: false, error: operationalError(c.env, message, 'deposit refresh failed') }, 500);
  }
});

/**
 * Express counted raw Idempotency-Key headers and answered "exactly one
 * Idempotency-Key header is required" for a repeat. workerd merges repeated
 * headers into one comma-joined value, and RFC 9110 says that IS the wire form
 * of a repeated field, so a comma is treated as "more than one" here. See the
 * migration notes: a *single* header whose value contains a comma therefore gets
 * this message instead of the character-set message. Both are 400.
 */
function requireIdempotencyKey(c: any): string {
  const raw = c.req.header('idempotency-key') ?? null;
  if (raw === null || raw.includes(',')) {
    throw new ValidationError('exactly one Idempotency-Key header is required');
  }
  return validateIdempotencyKey(raw);
}

app.post('/withdraw', async (c) => {
  const { externalUserId, amountUnits, destination } = c.get('body') ?? {};
  try {
    const idempotencyKey = requireIdempotencyKey(c);
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
    // EVM destinations only: enforce the exact provider chain type so another
    // spelling cannot bypass address validation.
    if (chain_type !== 'ethereum') throw new ValidationError('chain_type must be ethereum');
    if (!/^\d+$/.test(chain_id) || BigInt(chain_id) <= 0n) {
      throw new ValidationError('chain_id must be a positive decimal chain id');
    }
    if (!isAddress(token_address)) {
      throw new ValidationError('token_address is not a valid EVM address');
    }
    if (!isAddress(recipient_address)) {
      throw new ValidationError('recipient_address is not a valid EVM address');
    }

    const result = await withdraw(
      c.env,
      c.get('store'),
      externalUserId,
      amountUnits,
      { chain_type, chain_id, token_address, recipient_address },
      idempotencyKey,
    );
    return jsonRes(c, { ok: true, ...result });
  } catch (err) {
    return handleWithdrawalError(c, err);
  }
});

app.get('/withdrawals/:withdrawalId', async (c) => {
  const id = c.req.param('withdrawalId');
  if (!(await c.get('store').getWithdrawal(id))) {
    return jsonRes(c, { ok: false, error: 'withdrawal not found' }, 404);
  }
  try {
    return jsonRes(c, await pollWithdrawal(c.env, c.get('store'), id));
  } catch (err) {
    return handleWithdrawalError(c, err);
  }
});

// Live supported tokens/chains from Unifold. Non-fatal: on error it returns an
// empty list and the app falls back to its presets.
app.get('/catalog', async (c) => {
  try {
    return jsonRes(c, { ok: true, destinations: await getSupportedDestinations(c.env) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[catalog] falling back — could not fetch supported tokens:', message);
    return jsonRes(c, {
      ok: true,
      destinations: [],
      error: operationalError(c.env, message, 'catalog temporarily unavailable'),
    });
  }
});

app.get('/treasury', async (c) => {
  const cfg = config(c.env);
  try {
    const acct: any = await unifoldClient(cfg.UNIFOLD_SECRET_KEY).treasury.accounts.retrieve(
      cfg.TREASURY_ACCOUNT_ID,
    );
    return jsonRes(c, {
      treasuryAccountId: cfg.TREASURY_ACCOUNT_ID,
      address: acct.address,
      chainType: acct.chain_type,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonRes(c, {
      treasuryAccountId: cfg.TREASURY_ACCOUNT_ID,
      error: operationalError(c.env, message, 'treasury temporarily unavailable'),
    });
  }
});

// ---- Flake-tax hangouts ----

app.post('/events', async (c) => {
  const { host, title, stakeUnits, startsAt, multiplierBps } = c.get('body') ?? {};
  try {
    const event = await createHangout(c.env, c.get('store'), host, title, stakeUnits, {
      startsAt,
      multiplierBps,
    });
    return jsonRes(c, { ok: true, event });
  } catch (err) {
    return handleErr(c, err);
  }
});

app.post('/events/:id/rsvp', async (c) => {
  const { userId } = c.get('body') ?? {};
  try {
    if (typeof userId !== 'string' || userId.trim() === '') {
      throw new ValidationError('userId is required');
    }
    return jsonRes(c, { ok: true, event: await rsvp(c.get('store'), c.req.param('id'), userId) });
  } catch (err) {
    return handleErr(c, err);
  }
});

app.post('/events/:id/checkin', async (c) => {
  const { userId } = c.get('body') ?? {};
  try {
    if (typeof userId !== 'string' || userId.trim() === '') {
      throw new ValidationError('userId is required');
    }
    return jsonRes(c, { ok: true, event: await checkin(c.get('store'), c.req.param('id'), userId) });
  } catch (err) {
    return handleErr(c, err);
  }
});

app.post('/events/:id/settle', async (c) => {
  try {
    return jsonRes(c, { ok: true, ...(await settle(c.get('store'), c.req.param('id'))) });
  } catch (err) {
    return handleErr(c, err);
  }
});

app.get('/events/:id', async (c) => {
  const event = await c.get('store').getEvent(c.req.param('id'));
  if (!event) return jsonRes(c, { ok: false, error: 'event not found' }, 404);
  return jsonRes(c, { ok: true, event });
});

// Anything the gate let through but no route matched: Express's app.use()
// ordering means such a request never reaches a 404 handler on this service,
// because requireServiceToken has already answered 401 for unauthenticated
// callers. An AUTHENTICATED unknown path does reach finalhandler's 404.
app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  const body =
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<title>Error</title>\n</head>\n<body>\n' +
    `<pre>Cannot ${c.req.method} ${path.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>\n` +
    '</body>\n</html>\n';
  const bytes = new TextEncoder().encode(body);
  return new Response(c.req.method === 'HEAD' ? null : bytes, {
    status: 404,
    headers: {
      'x-powered-by': POWERED_BY,
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff',
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(bytes.length),
    },
  });
});

app.onError((error, c) => {
  console.error('[request] unhandled route error:', error instanceof Error ? error.message : error);
  return handleErr(c, error);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await app.fetch(request, env, ctx);
    // Cloudflare's edge rewrites/compresses responses it is allowed to
    // transform, which strips Content-Length, Accept-Ranges and ETag that Azure
    // sent. Declaring the entity already-encoded keeps the bytes untouched.
    if (!response.headers.has('content-encoding') && response.status !== 204) {
      const headers = new Headers(response.headers);
      headers.set('content-encoding', 'identity');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  },
};
