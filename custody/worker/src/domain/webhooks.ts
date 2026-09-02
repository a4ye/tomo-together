// Port of custody/src/webhooks.ts. The raw request body is authenticated before
// any event field or datastore access.
//
// Live `ht6-tomoyard-crypto` has UNIFOLD_WEBHOOK_SECRET unset, so verifiedEvent()
// throws immediately and POST /webhooks/unifold always answers a plain-text 400.
// The rest of this module is still ported so setting the secret restores the
// real-time path unchanged.
import type { Env } from '../env';
import { config } from '../config';
import type { D1Store } from '../store/d1Store';
import { unifoldClient } from '../unifold/client';
import { adjust, depositReference } from './money';

export interface WebhookHandlingResult {
  type: string;
  handled: boolean;
  reason?: 'not_owned' | 'unsupported';
}

export class WebhookVerificationError extends Error {
  constructor(cause: unknown) {
    super('invalid Unifold webhook signature or payload', { cause });
    this.name = 'WebhookVerificationError';
  }
}

export class WebhookNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookNotReadyError';
  }
}

function verifiedEvent(env: Env, rawBody: string, headers: Record<string, unknown>): any {
  const cfg = config(env);
  if (!cfg.WEBHOOK_SECRET) {
    throw new WebhookVerificationError(new Error('UNIFOLD_WEBHOOK_SECRET not configured'));
  }
  try {
    return unifoldClient(cfg.UNIFOLD_SECRET_KEY).webhooks.constructEvent(
      rawBody as never,
      headers as never,
      cfg.WEBHOOK_SECRET,
    );
  } catch (error) {
    throw new WebhookVerificationError(error);
  }
}

const sameAddress = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

export async function handleUnifoldWebhook(
  env: Env,
  store: D1Store,
  rawBody: string,
  headers: Record<string, unknown>,
): Promise<WebhookHandlingResult> {
  const cfg = config(env);
  const event = verifiedEvent(env, rawBody, headers);
  const belongsToConfiguredMode = event.livemode === cfg.UNIFOLD_LIVE_MODE;

  switch (event.type) {
    case 'deposit.direct_execution.completed': {
      const execution = event.data.object;
      const details = execution.details;
      // Credit the destination amount in BASE UNITS — never `execution.amount`,
      // a separate nullable field that need not agree with what the poll credits.
      const amount = details?.destination_amount;
      const owned =
        belongsToConfiguredMode &&
        // Accept the provider's terminal-success vocabulary in both spellings so
        // a naming difference cannot silently drop every webhook-credited deposit.
        (execution.status === 'completed' || execution.status === 'succeeded') &&
        execution.treasury_account_id === cfg.TREASURY_ACCOUNT_ID &&
        details?.destination_chain_type === 'ethereum' &&
        details.destination_chain_id === String(cfg.CHAIN_ID) &&
        sameAddress(details.destination_token_address, cfg.USDC_BASE_TOKEN_ADDRESS);

      // A project can legitimately emit signed events for other flows. ACK the
      // delivery but state truthfully that this ledger did not process it.
      if (!owned) return { type: event.type, handled: false, reason: 'not_owned' };
      if (
        typeof execution.id !== 'string' ||
        execution.id.trim() === '' ||
        typeof execution.external_user_id !== 'string' ||
        execution.external_user_id.trim() === '' ||
        typeof amount !== 'string' ||
        !/^\d+$/.test(amount) ||
        BigInt(amount) <= 0n
      ) {
        return { type: event.type, handled: false, reason: 'not_owned' };
      }

      if (!(await store.getUser(execution.external_user_id))) {
        // The address endpoint exists only for registered users. Treat a missing
        // ledger user as a retryable ordering failure, not success.
        throw new WebhookNotReadyError('deposit user is not present in the ledger');
      }
      await adjust(store, execution.external_user_id, amount, depositReference(execution.id));
      return { type: event.type, handled: true };
    }

    case 'treasury.outbound_transfer.failed':
    case 'treasury.outbound_transfer.completed': {
      const transfer = event.data.object;
      if (
        !belongsToConfiguredMode ||
        transfer.treasury_account_id !== cfg.TREASURY_ACCOUNT_ID ||
        transfer.status !==
          (event.type === 'treasury.outbound_transfer.failed' ? 'failed' : 'completed')
      ) {
        return { type: event.type, handled: false, reason: 'not_owned' };
      }

      const found = await store.getWithdrawalByTransferId(transfer.id);
      if (!found) {
        // The provider response may arrive before attachWithdrawalTransfer
        // commits. A non-2xx asks Unifold to retry instead of losing the
        // terminal transition.
        throw new WebhookNotReadyError('withdrawal transfer is not attached yet');
      }
      const matchesReservation =
        transfer.external_user_id === found.user.externalUserId &&
        transfer.amount === found.withdrawal.amountUnits &&
        sameAddress(transfer.recipient_address, found.withdrawal.destination.recipient_address);
      if (!matchesReservation) return { type: event.type, handled: false, reason: 'not_owned' };

      if (event.type === 'treasury.outbound_transfer.failed') {
        await store.refundWithdrawal(found.withdrawal.id, 'failed');
      } else {
        await store.completeWithdrawal(found.withdrawal.id);
      }
      return { type: event.type, handled: true };
    }

    default:
      return { type: event.type, handled: false, reason: 'unsupported' };
  }
}
