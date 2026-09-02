// Ports of custody/src/{adjust,grant,addFunds,deposits,catalog}.ts.
// Same validation, same error strings, same idempotency references.
import type { Env } from '../env';
import { config, currentPeriod, recurringRealUsdcGrantsEnabled } from '../config';
import type { D1Store, IdempotentAdjustmentResult } from '../store/d1Store';
import { unifoldClient } from '../unifold/client';
import { ValidationError, isPositiveIntString } from './withdraw';

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
 * With a reference, the store claims the reference and applies the balance delta
 * in one transaction. This closes the check-then-write race across replicas and
 * between the polling and webhook paths.
 */
export function adjust(
  store: D1Store,
  externalUserId: string,
  deltaUnits: string,
  reference?: string,
): Promise<IdempotentAdjustmentResult> {
  return store.applyAdjustment(externalUserId, deltaUnits, reference);
}

export async function grant(
  env: Env,
  store: D1Store,
  externalUserId: string,
): Promise<{ alreadyGranted: boolean; period: string; balanceUnits: string }> {
  if (!recurringRealUsdcGrantsEnabled(env)) throw new RecurringGrantDisabledError();
  const period = currentPeriod();
  const result = await store.claimGrantPeriod(externalUserId, period, config(env).GRANT_USDC_UNITS);
  return { alreadyGranted: result.alreadyGranted, period, balanceUnits: result.balanceUnits };
}

/**
 * Alignment contract with ownedDeposit(): addresses are provisioned with the
 * exact tuple the deposit poll checks, so an arrived deposit credits the user
 * through either the webhook or /deposits/refresh.
 */
export async function addFunds(
  env: Env,
  externalUserId: string,
): Promise<{ treasuryAddress: string; depositAddresses: unknown[] }> {
  const cfg = config(env);
  const unifold = unifoldClient(cfg.UNIFOLD_SECRET_KEY);
  const acct: any = await unifold.treasury.accounts.retrieve(cfg.TREASURY_ACCOUNT_ID);
  try {
    const created: any = await unifold.depositAddresses.create({
      external_user_id: externalUserId,
      destination_chain_type: 'ethereum',
      destination_chain_id: String(cfg.CHAIN_ID),
      destination_token_address: cfg.USDC_BASE_TOKEN_ADDRESS,
      recipient_address: acct.address,
      action_type: 'deposit',
    } as never);
    return { treasuryAddress: acct.address, depositAddresses: created.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Unifold deposit-address provisioning failed for user ${externalUserId}: ${message}`,
    );
  }
}

const sameAddress = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/**
 * Idempotency reference for crediting a deposit execution. The webhook and poll
 * paths both build it here so they are byte-identical for the same execution id
 * — a deposit observed by both can never double-credit.
 */
export const depositReference = (executionId: string): string => `deposit:${executionId}`;

function ownedDeposit(env: Env, execution: any, treasuryAddress: string): boolean {
  const cfg = config(env);
  return (
    execution.action_type === 'deposit' &&
    execution.status === 'succeeded' &&
    execution.destination_chain_type === 'ethereum' &&
    execution.destination_chain_id === String(cfg.CHAIN_ID) &&
    sameAddress(execution.destination_token_address, cfg.USDC_BASE_TOKEN_ADDRESS) &&
    sameAddress(execution.recipient_address, treasuryAddress)
  );
}

/**
 * Poll-based deposit credit, the fallback for delayed/missed webhooks. Every
 * page is scanned so an older uncredited deposit cannot be stranded.
 */
export async function refreshDeposits(
  env: Env,
  store: D1Store,
  externalUserId: string,
): Promise<{
  creditedUnits: string;
  newDeposits: Array<{ id: string; amountUnits: string }>;
  balanceUnits: string;
}> {
  const cfg = config(env);
  const unifold = unifoldClient(cfg.UNIFOLD_SECRET_KEY);
  const user = await store.getUser(externalUserId);
  if (!user) throw new ValidationError('user not found');

  const treasury: any = await unifold.treasury.accounts.retrieve(cfg.TREASURY_ACCOUNT_ID);
  let creditedTotal = 0n;
  const newDeposits: Array<{ id: string; amountUnits: string }> = [];
  let startingAfter: string | undefined;

  for (;;) {
    const page: any = await unifold.directExecutions.list({
      external_user_id: externalUserId,
      action_type: 'deposit',
      status: 'succeeded',
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    } as never);

    for (const execution of page.data) {
      if (!ownedDeposit(env, execution, treasury.address)) continue;
      const amount = execution.destination_amount_base_unit;
      if (!isPositiveIntString(amount)) continue;
      if (typeof execution.id !== 'string' || execution.id.trim() === '') continue;

      const result = await adjust(store, externalUserId, amount, depositReference(execution.id));
      if (!result.alreadyApplied && BigInt(result.appliedUnits) > 0n) {
        creditedTotal += BigInt(result.appliedUnits);
        newDeposits.push({ id: execution.id, amountUnits: amount });
      }
    }

    if (!page.has_more) break;
    const nextCursor = page.data.at(-1)?.id;
    if (!nextCursor || nextCursor === startingAfter) {
      throw new Error('Unifold deposit pagination did not advance');
    }
    startingAfter = nextCursor;
  }

  const updated = await store.getUser(externalUserId);
  if (!updated) throw new ValidationError('user not found');
  return {
    creditedUnits: creditedTotal.toString(),
    newDeposits,
    balanceUnits: updated.balanceUnits,
  };
}

export interface CatalogDestination {
  symbol: string;
  name: string;
  chain_type: string;
  chain_id: string;
  chain_name: string;
  token_address: string;
  is_stablecoin: boolean;
  icon_url?: string;
}

/** Flattens Unifold's supported-deposit-tokens response into destination rows. */
export async function getSupportedDestinations(env: Env): Promise<CatalogDestination[]> {
  const res = await fetch('https://api.unifold.io/v1/tokens/supported_deposit_tokens', {
    headers: { Authorization: `Bearer ${config(env).UNIFOLD_SECRET_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`supported_deposit_tokens ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const body = (await res.json()) as { data?: Array<Record<string, any>> };

  const out: CatalogDestination[] = [];
  for (const tok of body.data ?? []) {
    for (const ch of tok.chains ?? []) {
      out.push({
        symbol: String(tok.symbol),
        name: String(tok.name ?? tok.symbol),
        is_stablecoin: !!tok.is_stablecoin,
        chain_type: String(ch.chain_type),
        chain_id: String(ch.chain_id),
        chain_name: String(ch.chain_name ?? ch.chain_id),
        token_address: String(ch.token_address),
        icon_url: ch.icon_url ? String(ch.icon_url) : undefined,
      });
    }
  }
  return out;
}
