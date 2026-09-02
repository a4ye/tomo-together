// Port of custody/src/auth.ts.
//
// Hashing both values gives a fixed-length comparison and avoids a fast-fail
// length check leaking information about the configured token. node:crypto's
// timingSafeEqual is replaced by a constant-time comparison over the two SHA-256
// digests, which is the same property with no Node dependency.
import type { Context, Next } from 'hono';
import { config } from './config';
import { json } from './http/express';

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function requireServiceToken(c: Context, next: Next): Promise<Response | void> {
  const authorization = c.req.header('authorization') ?? '';
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);

  let ok = false;
  if (match) {
    const [candidate, expected] = await Promise.all([
      digest(match[1]),
      digest(config(c.env as never).CRYPTO_SERVICE_TOKEN),
    ]);
    ok = constantTimeEqual(candidate, expected);
  }

  if (!ok) {
    return json(c.req.raw.headers, c.req.method, { ok: false, error: 'unauthorized' }, {
      status: 401,
      headers: { 'www-authenticate': 'Bearer' },
    });
  }
  await next();
}
