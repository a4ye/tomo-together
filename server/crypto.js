'use strict';

// Thin, authenticated proxy from the Tomo Yard API to the treasury-custody
// service. The Unifold and Atlas credentials never cross this boundary.

const HEALTH_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 20_000;
const READY_TTL_MS = 15_000;
const UNREADY_TTL_MS = 5_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '[::1]' || normalized === '::1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  return !!match && match.slice(1).every((part) => Number(part) <= 255) && Number(match[1]) === 127;
}

function loadBaseUrl(env = process.env) {
  const raw = (env.CRYPTO_API_URL || '').trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const isProduction = env.NODE_ENV === 'production';
  const safeProtocol = url.protocol === 'https:' ||
    (!isProduction && url.protocol === 'http:' && isLoopbackHostname(url.hostname));
  const isOriginOnly = url.pathname === '/' && !url.search && !url.hash;
  if (
    !safeProtocol ||
    !isOriginOnly ||
    url.username ||
    url.password
  ) {
    return null;
  }

  return url.origin;
}

const BASE = loadBaseUrl();
const SERVICE_TOKEN = (process.env.CRYPTO_SERVICE_TOKEN || '').trim();
// The crypto service enforces the same minimum. Failing closed here avoids
// transmitting an obviously invalid credential to an arbitrary endpoint.
const CONFIGURED = BASE !== null && SERVICE_TOKEN.length >= 32;

let readiness = 'unknown'; // unknown | ready | unready | unauthorized
let readinessCheckedAt = 0;
let readinessProbe = null;

class CryptoError extends Error {
  constructor(status, message, code = 'crypto_request_failed') {
    super(message);
    this.name = 'CryptoError';
    this.status = status;
    this.code = code;
  }
}

class CryptoUnavailableError extends CryptoError {
  constructor() {
    super(503, 'Crypto is temporarily unavailable. Please try again.', 'crypto_unavailable');
    this.name = 'CryptoUnavailableError';
  }
}

function validIdempotencyKey(value) {
  return typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 128 &&
    IDEMPOTENCY_KEY_PATTERN.test(value);
}

function recordReadiness(next, authenticated = false) {
  // A public readiness response cannot prove that a rejected service token has
  // become valid. A process restart is required after rotating the token.
  if (readiness === 'unauthorized' && !authenticated) return;
  readiness = next;
  readinessCheckedAt = Date.now();
}

async function probeReadiness() {
  if (!CONFIGURED) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    // /ready is intentionally public and checks that Atlas plus its indexes are
    // initialized. Do not send the service credential to a public probe.
    const response = await fetch(`${BASE}/ready`, { signal: controller.signal });
    const payload = await response.json().catch(() => null);
    const isReady = response.status === 200 && payload && payload.ok === true;
    recordReadiness(isReady ? 'ready' : 'unready');
  } catch {
    recordReadiness('unready');
  } finally {
    clearTimeout(timer);
  }
  return readiness === 'ready';
}

function refreshReadinessIfNeeded() {
  if (!CONFIGURED || readiness === 'unauthorized') return null;
  const ttl = readiness === 'unready' ? UNREADY_TTL_MS : READY_TTL_MS;
  if (readinessProbe || Date.now() - readinessCheckedAt < ttl) return readinessProbe;
  readinessProbe = probeReadiness().finally(() => {
    readinessProbe = null;
  });
  return readinessProbe;
}

function enabled() {
  if (!CONFIGURED) return false;
  refreshReadinessIfNeeded();
  return readiness === 'ready';
}

async function ready() {
  if (!CONFIGURED || readiness === 'unauthorized') return false;
  const probe = refreshReadinessIfNeeded();
  if (probe) await probe;
  return readiness === 'ready';
}

async function requireAvailable() {
  if (!(await ready())) throw new CryptoUnavailableError();
}

function safeBusinessMessage(status, payload) {
  if (![400, 403, 404, 409].includes(status)) return null;
  const message = payload && payload.error;
  if (
    typeof message !== 'string' ||
    message.length < 1 ||
    message.length > 240 ||
    /[\u0000-\u001f\u007f]/.test(message)
  ) {
    return null;
  }
  return message;
}

async function call(method, path, body, extraHeaders = {}) {
  await requireAvailable();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${SERVICE_TOKEN}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    recordReadiness('unready');
    throw new CryptoError(502, 'Crypto service request failed. Please try again.', 'crypto_upstream_failed');
  } finally {
    clearTimeout(timer);
  }

  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    recordReadiness('unauthorized', true);
    throw new CryptoUnavailableError();
  }

  if (response.status >= 500) recordReadiness('unready', true);
  else recordReadiness('ready', true);

  if (!response.ok) {
    const businessMessage = safeBusinessMessage(response.status, payload);
    throw new CryptoError(
      response.status,
      businessMessage || 'Crypto service request failed. Please try again.',
      response.status === 409 ? 'crypto_conflict' :
        response.status === 403 ? 'crypto_policy_denied' : 'crypto_request_failed',
    );
  }
  return { status: response.status, data: payload };
}

const extId = (username) => `ty_${username}`;

// Registration and grants are deliberately separate. Registration is required
// for ordinary wallet use; a real-money grant is an explicit optional policy.
async function ensureUser(username) {
  const { data } = await call('POST', '/users/register', { externalUserId: extId(username) });
  return data;
}

async function grantUser(username) {
  const { data } = await call('POST', '/grant', { externalUserId: extId(username) });
  return data;
}

async function getWallet(username) {
  await ensureUser(username);
  const { data } = await call('GET', `/users/${encodeURIComponent(extId(username))}`);
  return data;
}

async function createEvent(hostUsername, title, stakeUnits, opts = {}) {
  const { data } = await call('POST', '/events', {
    host: extId(hostUsername),
    title,
    stakeUnits,
    multiplierBps: opts.multiplierBps,
    startsAt: opts.startsAt,
  });
  return data.event;
}

async function rsvp(eventId, username) {
  const { data } = await call('POST', `/events/${encodeURIComponent(eventId)}/rsvp`, {
    userId: extId(username),
  });
  return data.event;
}

async function checkin(eventId, username) {
  const { data } = await call('POST', `/events/${encodeURIComponent(eventId)}/checkin`, {
    userId: extId(username),
  });
  return data.event;
}

async function settle(eventId) {
  const { data } = await call('POST', `/events/${encodeURIComponent(eventId)}/settle`);
  return data;
}

async function getEvent(eventId) {
  const { data } = await call('GET', `/events/${encodeURIComponent(eventId)}`);
  return data.event;
}

async function addFunds(username) {
  await ensureUser(username);
  const { data } = await call('POST', '/add-funds', { externalUserId: extId(username) });
  return data;
}

async function refreshDeposits(username) {
  await ensureUser(username);
  const { data } = await call('POST', '/deposits/refresh', { externalUserId: extId(username) });
  return data;
}

async function withdraw(username, amountUnits, destination, idempotencyKey) {
  if (!validIdempotencyKey(idempotencyKey)) {
    throw new CryptoError(400, 'Invalid Idempotency-Key', 'invalid_idempotency_key');
  }
  await ensureUser(username);
  const { status, data } = await call(
    'POST',
    '/withdraw',
    { externalUserId: extId(username), amountUnits, destination },
    { 'Idempotency-Key': idempotencyKey },
  );
  return { status, data };
}

module.exports = {
  enabled,
  ready,
  loadBaseUrl,
  validIdempotencyKey,
  extId,
  CryptoError,
  CryptoUnavailableError,
  ensureUser,
  grantUser,
  getWallet,
  createEvent,
  rsvp,
  checkin,
  settle,
  getEvent,
  addFunds,
  refreshDeposits,
  withdraw,
};
