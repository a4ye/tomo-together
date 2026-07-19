// Monthly USDC grant into the user's treasury-backed balance. Idempotent per (user, YYYY-MM).
import { GRANT_USDC_UNITS } from './config.js';
import { currentPeriod } from './period.js';
import { getStore } from './runtimeStore.js';

export class RecurringGrantDisabledError extends Error {
  readonly statusCode = 403;

  constructor() {
    super(
      'recurring real-USDC grants are disabled in production; set ENABLE_RECURRING_REAL_USDC_GRANTS=true to opt in',
    );
    this.name = 'RecurringGrantDisabledError';
  }
}

/**
 * Automatic real-USDC grants are a treasury-drain/Sybil primitive unless the
 * operator has explicitly accepted that risk. Development and tests remain
 * frictionless; production requires an exact, case-sensitive opt-in.
 */
export function recurringRealUsdcGrantsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const explicitlyNonProduction = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  return explicitlyNonProduction || env.ENABLE_RECURRING_REAL_USDC_GRANTS === 'true';
}

export async function grant(externalUserId: string): Promise<{
  alreadyGranted: boolean;
  period: string;
  balanceUnits: string;
}> {
  if (!recurringRealUsdcGrantsEnabled()) {
    throw new RecurringGrantDisabledError();
  }

  const period = currentPeriod();
  // One conditional Mongo update claims the period and credits the balance, so
  // concurrent sign-ins cannot grant the same user twice.
  const result = await getStore().claimGrantPeriod(
    externalUserId,
    period,
    GRANT_USDC_UNITS,
  );
  return {
    alreadyGranted: result.alreadyGranted,
    period,
    balanceUnits: result.balanceUnits,
  };
}
