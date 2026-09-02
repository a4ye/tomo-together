// Port of server/crypto.js — the authenticated proxy to the treasury-custody
// service. Unifold and datastore credentials never cross this boundary.
//
// Only the readiness state moved: it lives in CryptoReadinessDO instead of a
// module variable (see that file for why). Everything else — the URL guard, the
// 20 s timeout, the status→error mapping, the "public probe must not carry the
// token" rule — is transcribed.
import type { Env } from '../env';

const REQUEST_TIMEOUT_MS = 20_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '[::1]' || normalized === '::1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  return !!match && match.slice(1).every((part) => Number(part) <= 255) && Number(match[1]) === 127;
}

export function loadBaseUrl(env: Env): string | null {
  const raw = (env.CRYPTO_API_URL ?? '').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const isProduction = env.NODE_ENV === 'production';
  const safeProtocol =
    url.protocol === 'https:' ||
    (!isProduction && url.protocol === 'http:' && isLoopbackHostname(url.hostname));
  const isOriginOnly = url.pathname === '/' && !url.search && !url.hash;
  if (!safeProtocol || !isOriginOnly || url.username || url.password) return null;
  return url.origin;
}

export class CryptoError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string, code = 'crypto_request_failed') {
    super(message);
    this.name = 'CryptoError';
    this.status = status;
    this.code = code;
  }
}

export class CryptoUnavailableError extends CryptoError {
  constructor() {
    super(503, 'Crypto is temporarily unavailable. Please try again.', 'crypto_unavailable');
    this.name = 'CryptoUnavailableError';
  }
}

export function validIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 128 &&
    IDEMPOTENCY_KEY_PATTERN.test(value)
  );
}

export const extId = (username: string): string => `ty_${username}`;

/**
 * One outbound call to the custody service. Uses the CUSTODY service binding
 * when it is bound (a Worker cannot reach another Worker of the same account
 * over workers.dev — Cloudflare answers `error code: 1042`), and a plain fetch
 * otherwise, so pointing CRYPTO_API_URL at a non-Workers host keeps working.
 */
export function custodyFetch(env: Env, url: string, init?: RequestInit): Promise<Response> {
  if (env.CUSTODY) return env.CUSTODY.fetch(url, init as never) as unknown as Promise<Response>;
  return fetch(url, init);
}

function safeBusinessMessage(status: number, payload: any): string | null {
  if (![400, 403, 404, 409].includes(status)) return null;
  const message = payload && payload.error;
  if (
    typeof message !== 'string' ||
    message.length < 1 ||
    message.length > 240 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(message)
  ) {
    return null;
  }
  return message;
}

export class CryptoApi {
  private readonly base: string | null;
  private readonly token: string;
  private readonly configured: boolean;

  constructor(private readonly env: Env) {
    this.base = loadBaseUrl(env);
    this.token = (env.CRYPTO_SERVICE_TOKEN ?? '').trim();
    // The crypto service enforces the same minimum. Failing closed here avoids
    // transmitting an obviously invalid credential to an arbitrary endpoint.
    this.configured = this.base !== null && this.token.length >= 32;
  }

  private latch(): DurableObjectStub {
    return this.env.CRYPTO_READINESS.get(this.env.CRYPTO_READINESS.idFromName('crypto'));
  }

  /**
   * Identity the `unauthorized` latch is scoped to: the configured service
   * token plus the deployed Worker version — the two things a process restart
   * used to change. It is computed HERE rather than inside the Durable Object
   * because a running DO keeps the env of the version that started it, so a DO
   * that already holds the latch would not notice a rotation until it happened
   * to be evicted. The request handler always sees the current values.
   */
  private async latchKey(): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.token));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 16)}|${this.env.CF_VERSION_METADATA?.id ?? 'dev'}`;
  }

  async ready(): Promise<boolean> {
    if (!this.configured) return false;
    const res = await this.latch().fetch(
      `https://crypto-readiness/ready?key=${encodeURIComponent(await this.latchKey())}`,
    );
    const body = (await res.json()) as { ready: boolean };
    return body.ready === true;
  }

  private async record(next: string, authenticated: boolean): Promise<void> {
    await this.latch().fetch('https://crypto-readiness/record', {
      method: 'POST',
      body: JSON.stringify({ next, authenticated, key: await this.latchKey() }),
      headers: { 'content-type': 'application/json' },
    });
  }

  private async requireAvailable(): Promise<void> {
    if (!(await this.ready())) throw new CryptoUnavailableError();
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; data: any }> {
    await this.requireAvailable();
    let response: Response;
    try {
      response = await custodyFetch(this.env, `${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      await this.record('unready', false);
      throw new CryptoError(502, 'Crypto service request failed. Please try again.', 'crypto_upstream_failed');
    }

    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      // This latch is intentional (a public probe can't prove a rotated token is
      // valid), so surface it — otherwise crypto goes permanently dark with no signal.
      console.warn(
        '[crypto] custody rejected the service token (401); crypto is disabled until CRYPTO_SERVICE_TOKEN is rotated or the Worker is redeployed.',
      );
      await this.record('unauthorized', true);
      throw new CryptoUnavailableError();
    }

    if (response.status >= 500) await this.record('unready', true);
    else await this.record('ready', true);

    if (!response.ok) {
      const businessMessage = safeBusinessMessage(response.status, payload);
      throw new CryptoError(
        response.status,
        businessMessage || 'Crypto service request failed. Please try again.',
        response.status === 409
          ? 'crypto_conflict'
          : response.status === 403
            ? 'crypto_policy_denied'
            : 'crypto_request_failed',
      );
    }
    return { status: response.status, data: payload };
  }

  // Registration and grants are deliberately separate. Registration is required
  // for ordinary wallet use; a real-money grant is an explicit optional policy.
  async ensureUser(username: string): Promise<any> {
    const { data } = await this.call('POST', '/users/register', { externalUserId: extId(username) });
    return data;
  }

  async getWallet(username: string): Promise<any> {
    await this.ensureUser(username);
    const { data } = await this.call('GET', `/users/${encodeURIComponent(extId(username))}`);
    return data;
  }

  async createEvent(
    hostUsername: string,
    title: string,
    stakeUnits: string,
    opts: { multiplierBps?: number; startsAt?: string } = {},
  ): Promise<any> {
    const { data } = await this.call('POST', '/events', {
      host: extId(hostUsername),
      title,
      stakeUnits,
      multiplierBps: opts.multiplierBps,
      startsAt: opts.startsAt,
    });
    return data.event;
  }

  async rsvp(eventId: string, username: string): Promise<any> {
    const { data } = await this.call('POST', `/events/${encodeURIComponent(eventId)}/rsvp`, {
      userId: extId(username),
    });
    return data.event;
  }

  async checkin(eventId: string, username: string): Promise<any> {
    const { data } = await this.call('POST', `/events/${encodeURIComponent(eventId)}/checkin`, {
      userId: extId(username),
    });
    return data.event;
  }

  async settle(eventId: string): Promise<any> {
    const { data } = await this.call('POST', `/events/${encodeURIComponent(eventId)}/settle`);
    return data;
  }

  async getEvent(eventId: string): Promise<any> {
    const { data } = await this.call('GET', `/events/${encodeURIComponent(eventId)}`);
    return data.event;
  }

  async addFunds(username: string): Promise<any> {
    await this.ensureUser(username);
    const { data } = await this.call('POST', '/add-funds', { externalUserId: extId(username) });
    return data;
  }

  async refreshDeposits(username: string): Promise<any> {
    await this.ensureUser(username);
    const { data } = await this.call('POST', '/deposits/refresh', { externalUserId: extId(username) });
    return data;
  }

  async withdraw(
    username: string,
    amountUnits: unknown,
    destination: unknown,
    idempotencyKey: string,
  ): Promise<{ status: number; data: any }> {
    if (!validIdempotencyKey(idempotencyKey)) {
      throw new CryptoError(400, 'Invalid Idempotency-Key', 'invalid_idempotency_key');
    }
    await this.ensureUser(username);
    return this.call(
      'POST',
      '/withdraw',
      { externalUserId: extId(username), amountUnits, destination },
      { 'Idempotency-Key': idempotencyKey },
    );
  }
}

export function cryptoEventRsvp(event: any, username: string): any {
  if (!event || !Array.isArray(event.rsvps)) return null;
  return event.rsvps.find((rsvp: any) => rsvp && rsvp.userId === extId(username)) || null;
}
