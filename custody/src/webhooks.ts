// Verified Unifold webhooks — the real-time alternative to polling. The raw
// request body is authenticated before any event field or datastore is used.
import type { WebhookEvent } from '@unifold/node';
import { unifold } from './unifold.js';
import {
  WEBHOOK_SECRET,
  CHAIN_ID,
  TREASURY_ACCOUNT_ID,
  UNIFOLD_LIVE_MODE,
  USDC_BASE_TOKEN_ADDRESS,
} from './config.js';
import { adjust } from './adjust.js';
import { depositReference } from './deposits.js';
import { getStore } from './runtimeStore.js';

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

function verifiedEvent(
  rawBody: Buffer | string,
  headers: Record<string, unknown>,
): WebhookEvent {
  if (!WEBHOOK_SECRET) {
    throw new WebhookVerificationError(
      new Error('UNIFOLD_WEBHOOK_SECRET not configured'),
    );
  }
  try {
    return unifold.webhooks.constructEvent(
      rawBody,
      headers as Record<string, string | string[] | undefined>,
      WEBHOOK_SECRET,
    );
  } catch (error) {
    throw new WebhookVerificationError(error);
  }
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function eventBelongsToConfiguredMode(event: WebhookEvent): boolean {
  return event.livemode === UNIFOLD_LIVE_MODE;
}

export async function handleUnifoldWebhook(
  rawBody: Buffer | string,
  headers: Record<string, unknown>,
): Promise<WebhookHandlingResult> {
  const event = verifiedEvent(rawBody, headers);

  switch (event.type) {
    case 'deposit.direct_execution.completed': {
      const execution = event.data.object;
      const details = execution.details;
      // Credit only the canonical destination amount — never `execution.amount`,
      // which is a different field and could disagree with what the poll path
      // credits. The SDK leaves `details.destination_amount` undocumented as to
      // units (no `_base_unit` suffix), so the integer-only guard below stays
      // load-bearing: a decimal-formatted value is rejected here and the
      // deposit is later credited by the poll from the documented
      // `destination_amount_base_unit` field instead.
      const amount = details?.destination_amount;
      const owned =
        eventBelongsToConfiguredMode(event) &&
        // The event type already gates this to a completed deposit; accept the
        // provider's terminal-success vocabulary ('completed' on the event object,
        // 'succeeded' in the DirectExecution status enum) so a naming difference
        // does not silently drop every webhook-credited deposit.
        (execution.status === 'completed' || execution.status === 'succeeded') &&
        execution.treasury_account_id === TREASURY_ACCOUNT_ID &&
        details?.destination_chain_type === 'ethereum' &&
        details.destination_chain_id === String(CHAIN_ID) &&
        sameAddress(details.destination_token_address, USDC_BASE_TOKEN_ADDRESS);

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

      const store = getStore();
      if (!(await store.getUser(execution.external_user_id))) {
        // The address endpoint is available only for registered users. Treat a
        // missing ledger user as retryable ordering/state failure, not success.
        throw new WebhookNotReadyError('deposit user is not present in the ledger');
      }
      await adjust(
        execution.external_user_id,
        amount,
        depositReference(execution.id),
      );
      return { type: event.type, handled: true };
    }

    case 'treasury.outbound_transfer.failed':
    case 'treasury.outbound_transfer.completed': {
      const transfer = event.data.object;
      if (
        !eventBelongsToConfiguredMode(event) ||
        transfer.treasury_account_id !== TREASURY_ACCOUNT_ID ||
        transfer.status !==
          (event.type === 'treasury.outbound_transfer.failed' ? 'failed' : 'completed')
      ) {
        return { type: event.type, handled: false, reason: 'not_owned' };
      }

      const store = getStore();
      const found = await store.getWithdrawalByTransferId(transfer.id);
      if (!found) {
        // The provider response may reach us before attachWithdrawalTransfer
        // commits. A non-2xx response asks Unifold to retry instead of losing
        // the terminal transition.
        throw new WebhookNotReadyError('withdrawal transfer is not attached yet');
      }
      const matchesReservation =
        transfer.external_user_id === found.user.externalUserId &&
        transfer.amount === found.withdrawal.amountUnits &&
        sameAddress(
          transfer.recipient_address,
          found.withdrawal.destination.recipient_address,
        );
      if (!matchesReservation) {
        return { type: event.type, handled: false, reason: 'not_owned' };
      }

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
