// Monthly USDC grant into the user's treasury-backed balance. Idempotent per (user, YYYY-MM).
import { GRANT_USDC_UNITS } from './config.js';
import { currentPeriod } from './period.js';
import { getUser, creditBalance, setGrantPeriod } from './store.js';

export async function grant(externalUserId: string): Promise<{
  alreadyGranted: boolean;
  period: string;
  balanceUnits: string;
}> {
  const period = currentPeriod();
  const user = getUser(externalUserId);
  if (!user) {
    throw new Error('user not found');
  }

  if (user.lastGrantPeriod === period) {
    return { alreadyGranted: true, period, balanceUnits: user.balanceUnits };
  }

  creditBalance(externalUserId, GRANT_USDC_UNITS);
  setGrantPeriod(externalUserId, period);
  return {
    alreadyGranted: false,
    period,
    balanceUnits: getUser(externalUserId)!.balanceUnits,
  };
}
