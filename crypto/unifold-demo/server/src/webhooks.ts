// Verified Unifold webhooks — the real-time alternative to polling.
// Unifold signs every delivery (HMAC-SHA256); constructEvent() verifies + parses.
// - deposit.direct_execution.completed  → credit balance (idempotent via deposit:<execId>,
//   the SAME reference the poll uses, so webhook + poll never double-credit)
// - treasury.outbound_transfer.completed / .failed → update / refund the withdrawal
import { unifold } from './unifold.js';
import { WEBHOOK_SECRET, CHAIN_ID } from './config.js';
import { adjust } from './adjust.js';
import {
  getUser,
  getWithdrawalByTransferId,
  creditBalance,
  updateWithdrawal,
} from './store.js';

export async function handleUnifoldWebhook(
  rawBody: Buffer | string,
  headers: Record<string, unknown>,
): Promise<{ type: string; handled: boolean }> {
  if (!WEBHOOK_SECRET) throw new Error('UNIFOLD_WEBHOOK_SECRET not configured');

  // Throws if the signature/timestamp is invalid → caller returns 400.
  const event = (unifold as any).webhooks.constructEvent(rawBody, headers, WEBHOOK_SECRET) as {
    type: string;
    data?: { object?: Record<string, any> };
  };
  const obj = event.data?.object ?? {};

  switch (event.type) {
    case 'deposit.direct_execution.completed': {
      const externalUserId = obj.external_user_id;
      const amount = obj.amount; // destination base units (USDC)
      const destChain = obj.details?.destination_chain_id;
      if (
        typeof externalUserId === 'string' &&
        getUser(externalUserId) &&
        typeof amount === 'string' &&
        /^[0-9]+$/.test(amount) &&
        String(destChain) === String(CHAIN_ID)
      ) {
        adjust(externalUserId, amount, `deposit:${String(obj.id)}`);
      }
      return { type: event.type, handled: true };
    }

    case 'treasury.outbound_transfer.failed': {
      const found = getWithdrawalByTransferId(String(obj.id));
      if (found && !found.withdrawal.refunded) {
        creditBalance(found.user.externalUserId, found.withdrawal.amountUnits);
        updateWithdrawal(found.withdrawal.id, { refunded: true, status: 'failed' });
      }
      return { type: event.type, handled: true };
    }

    case 'treasury.outbound_transfer.completed': {
      const found = getWithdrawalByTransferId(String(obj.id));
      if (found) updateWithdrawal(found.withdrawal.id, { status: 'completed' });
      return { type: event.type, handled: true };
    }

    default:
      return { type: event.type, handled: false };
  }
}
