// External-input balance adjustment. An outside system (e.g. a monthly scheduler)
// credits or debits a user's treasury-backed balance. Balance is clamped at 0 —
// it can never go negative. Optionally idempotent via `reference` (e.g. "2026-07").
import { getStore } from './runtimeStore.js';

/**
 * This gate is for the raw HTTP route only. Deposits and event settlement use
 * adjust() internally with reserved references and must remain available when
 * the dangerous general-purpose route is disabled.
 */
export function rawBalanceAdjustmentsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const explicitlyNonProduction = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  return explicitlyNonProduction || env.ENABLE_RAW_BALANCE_ADJUSTMENTS === 'true';
}

export async function adjust(
  externalUserId: string,
  deltaUnits: string,
  reference?: string,
): Promise<{
  alreadyApplied: boolean;
  balanceUnits: string;
  appliedUnits: string;
  requestedDeltaUnits: string;
  clamped: boolean;
}> {
  // With a reference, MongoStore claims the reference and applies the balance
  // delta in one transaction. This closes the old check-then-write race across
  // replicas as well as between polling and webhook delivery.
  return getStore().applyAdjustment(externalUserId, deltaUnits, reference);
}
