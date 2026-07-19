// External-input balance adjustment. An outside system (e.g. a monthly scheduler)
// credits or debits a user's treasury-backed balance. Balance is clamped at 0 —
// it can never go negative. Optionally idempotent via `reference` (e.g. "2026-07").
import { getUser, adjustBalance, hasReference, addReference } from './store.js';

export function adjust(
  externalUserId: string,
  deltaUnits: string,
  reference?: string,
): {
  alreadyApplied: boolean;
  balanceUnits: string;
  appliedUnits: string;
  requestedDeltaUnits: string;
  clamped: boolean;
} {
  const user = getUser(externalUserId);
  if (!user) throw new Error('user not found');

  if (reference && hasReference(externalUserId, reference)) {
    return {
      alreadyApplied: true,
      balanceUnits: user.balanceUnits,
      appliedUnits: '0',
      requestedDeltaUnits: deltaUnits,
      clamped: false,
    };
  }

  const { balanceUnits, appliedUnits } = adjustBalance(externalUserId, deltaUnits);
  if (reference) addReference(externalUserId, reference);

  // If we could not apply the full delta (a debit hit the 0 floor), it's clamped.
  const clamped = BigInt(appliedUnits) !== BigInt(deltaUnits);

  return {
    alreadyApplied: false,
    balanceUnits,
    appliedUnits,
    requestedDeltaUnits: deltaUnits,
    clamped,
  };
}
