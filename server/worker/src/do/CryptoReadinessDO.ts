// Durable replacement for server/crypto.js's module-level readiness state.
//
// WHY THIS EXISTS (SPEC 9.4, "the latch has no equivalent and must be
// redesigned"):
//
// The Express build kept `readiness` in a module variable. Two behaviours came
// out of that, and they are not the same behaviour:
//
//   1. a 15 s / 5 s cache in front of the anonymous GET /ready probe, and
//   2. a LATCH: once custody answered 401 to an authenticated call, the client
//      recorded `unauthorized` and every later ready() returned false —
//      permanently, "until this process restarts with a valid
//      CRYPTO_SERVICE_TOKEN". A public probe is not allowed to clear it,
//      because a public probe cannot prove a rotated token is now accepted.
//
// A Worker has no process, so a module variable is per-isolate: the cache would
// still work (badly — N isolates probe N times) but the latch would be *gone*.
// One isolate would go dark while every other isolate kept sending the rejected
// token to a service that holds real custody of USDC. Dropping the latch was
// not an option, and neither was reimplementing it per-isolate.
//
// So the state moves into one Durable Object — a single instance, named
// "crypto", shared by every isolate. That is a strictly stronger version of the
// original: the latch is now global rather than per-process, and it survives
// eviction because it is written to DO storage.
//
// The remaining question was what "restart the process" means here. The answer
// has to be an explicit operator action that cannot be faked by traffic, and
// the two things that changed on a real restart were the process and the value
// of CRYPTO_SERVICE_TOKEN it was started with. Both have exact Workers
// analogues, and the latch is keyed on the pair:
//
//     latchKey = sha256(CRYPTO_SERVICE_TOKEN)[0..16] + "|" + <worker version id>
//
// `wrangler secret put CRYPTO_SERVICE_TOKEN` changes the first half and also
// produces a new version, and any redeploy changes the second half. Either one
// clears the latch, exactly as restarting the App Service did. Ordinary traffic
// changes neither. The token is never stored — only a truncated digest of it.

import type { Env } from '../env';
import { custodyFetch } from '../crypto/client';

const HEALTH_TIMEOUT_MS = 2_000;
const READY_TTL_MS = 15_000;
const UNREADY_TTL_MS = 5_000;

export type Readiness = 'unknown' | 'ready' | 'unready' | 'unauthorized';

interface Persisted {
  state: Readiness;
  checkedAt: number;
  latchKey: string | null;
}

export class CryptoReadinessDO implements DurableObject {
  private loaded?: Persisted;
  private probe: Promise<void> | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  private get configured(): boolean {
    return !!this.env.CRYPTO_API_URL && (this.env.CRYPTO_SERVICE_TOKEN ?? '').trim().length >= 32;
  }

  /**
   * `key` is supplied by the caller (see CryptoApi.latchKey): a running Durable
   * Object keeps the env of the Worker version that started it, so it must not
   * derive the latch identity from its own bindings — it would miss a rotation
   * until it happened to be evicted.
   */
  private async load(key: string): Promise<Persisted> {
    if (!this.loaded) {
      this.loaded =
        (await this.state.storage.get<Persisted>('readiness')) ??
        { state: 'unknown', checkedAt: 0, latchKey: null };
    }
    // Clearing a stale latch is the "process restart" equivalent; see the header.
    if (this.loaded.state === 'unauthorized' && this.loaded.latchKey !== key) {
      console.warn('[crypto] service token or worker version changed; clearing the unauthorized latch');
      this.loaded = { state: 'unknown', checkedAt: 0, latchKey: null };
      await this.state.storage.put('readiness', this.loaded);
    }
    return this.loaded;
  }

  private async record(next: Readiness, authenticated: boolean, key: string): Promise<void> {
    const current = await this.load(key);
    // A public readiness response cannot prove that a rejected service token has
    // become valid. Only a deploy/rotation clears this (see load()).
    if (current.state === 'unauthorized' && !authenticated) return;
    this.loaded = {
      state: next,
      checkedAt: Date.now(),
      latchKey: next === 'unauthorized' ? key : null,
    };
    await this.state.storage.put('readiness', this.loaded);
  }

  private async runProbe(key: string): Promise<void> {
    const base = (this.env.CRYPTO_API_URL ?? '').replace(/\/+$/, '');
    try {
      // /ready is intentionally public and checks that the datastore plus its
      // indexes are initialized. Never send the service credential to it.
      const response = await custodyFetch(this.env, `${base}/ready`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: unknown } | null;
      await this.record(
        response.status === 200 && payload?.ok === true ? 'ready' : 'unready',
        false,
        key,
      );
    } catch {
      await this.record('unready', false, key);
    }
  }

  private async refreshIfNeeded(key: string): Promise<void> {
    const current = await this.load(key);
    if (!this.configured || current.state === 'unauthorized') return;
    const ttl = current.state === 'unready' ? UNREADY_TTL_MS : READY_TTL_MS;
    if (this.probe) return this.probe;
    if (Date.now() - current.checkedAt < ttl) return;
    this.probe = this.runProbe(key).finally(() => {
      this.probe = null;
    });
    return this.probe;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ready') {
      const key = url.searchParams.get('key') ?? '';
      const current = await this.load(key);
      if (!this.configured || current.state === 'unauthorized') {
        return Response.json({ ready: false, state: current.state });
      }
      await this.refreshIfNeeded(key);
      const after = await this.load(key);
      return Response.json({ ready: after.state === 'ready', state: after.state });
    }
    if (url.pathname === '/record') {
      const body = (await request.json()) as {
        next: Readiness;
        authenticated: boolean;
        key: string;
      };
      await this.record(body.next, body.authenticated, body.key ?? '');
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  }
}
