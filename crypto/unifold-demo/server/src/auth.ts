import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { CRYPTO_SERVICE_TOKEN } from './config.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function tokenMatches(candidate: string): boolean {
  // Hashing both values gives timingSafeEqual fixed-length buffers and avoids a
  // fast-fail length comparison leaking information about the configured token.
  return timingSafeEqual(digest(candidate), digest(CRYPTO_SERVICE_TOKEN));
}

export function requireServiceToken(req: Request, res: Response, next: NextFunction): void {
  const authorization = req.get('authorization') ?? '';
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);

  if (!match || !tokenMatches(match[1])) {
    res.set('WWW-Authenticate', 'Bearer');
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  next();
}
