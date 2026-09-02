/// <reference types="@cloudflare/workers-types" />

/**
 * Cloudflare bindings for the Tomo Together app Worker.
 *
 * Nothing outside src/ports/ and src/do/ may touch these directly — business
 * logic takes plain data and returns plain data (SPEC section 4).
 */
export interface Env {
  /** D1 replacement for MongoDB `tomoyard`. */
  DB: D1Database;
  /** R2 replacement for DATA_DIR (/home/data) plus the bundled marketing site. */
  DATA: R2Bucket;
  /** Single-instance world: WebSocket fan-out and the world ticket table. */
  WORLD: DurableObjectNamespace;
  /** Cross-isolate replacement for server/crypto.js's in-process readiness latch. */
  CRYPTO_READINESS: DurableObjectNamespace;
  /**
   * Service binding to `tomo-together-custody`.
   *
   * A Worker cannot fetch another Worker of the same account through its
   * workers.dev hostname — Cloudflare answers `error code: 1042` — so the
   * cross-service call goes through a binding instead. CRYPTO_API_URL is still
   * the logical base (it builds the request URLs and is still validated exactly
   * as loadBaseUrl() did); the binding only replaces the transport. When it is
   * absent the client falls back to a plain fetch, which is what a deployment
   * pointing at a non-Workers custody host would use.
   */
  CUSTODY?: Fetcher;

  /** Host that gets the Expo web bundle instead of the API (was WEB_HOST). */
  WEB_HOST?: string;
  /** Origin of the treasury-custody service (was CRYPTO_API_URL). */
  CRYPTO_API_URL?: string;
  /** Shared bearer for the custody service (wrangler secret). */
  CRYPTO_SERVICE_TOKEN?: string;
  /** Present only under `wrangler dev`/`vitest`; production leaves it unset. */
  NODE_ENV?: string;
  /** Test-only override, mirrors server/index.js's WORLD_WS_TICKET_TTL_MS. */
  WORLD_WS_TICKET_TTL_MS?: string;

  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
}
