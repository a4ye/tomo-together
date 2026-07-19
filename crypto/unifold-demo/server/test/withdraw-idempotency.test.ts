import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MIN_WITHDRAW_UNITS } from '../src/config.js';
import { MongoStoreConflictError } from '../src/mongoStore.js';
import type { Destination, User, Withdrawal } from '../src/store.js';
import {
  IdempotencyConflictError,
  ValidationError,
  WithdrawalPendingError,
  pollWithdrawal,
  validateIdempotencyKey,
  withdraw,
  type WithdrawalDependencies,
  type WithdrawalStore,
} from '../src/withdraw.js';

const USER_ID = 'ty_alice';
const KEY = 'wd_mobile_attempt_123';
const DESTINATION: Destination = {
  chain_type: 'ethereum',
  chain_id: '8453',
  token_address: '0xUSDC',
  recipient_address: '0xALICE',
};

function sameDestination(left: Destination, right: Destination): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof Destination] === right[key as keyof Destination],
  );
}

class FakeStore implements WithdrawalStore {
  readonly user: User = {
    externalUserId: USER_ID,
    balanceUnits: '25000000',
    lastGrantPeriod: null,
    withdrawals: [],
    references: [],
  };

  readonly withdrawals = new Map<string, Withdrawal>();
  reserveCalls = 0;
  refundCalls = 0;

  async getUser(externalUserId: string): Promise<User | undefined> {
    return externalUserId === this.user.externalUserId ? this.user : undefined;
  }

  async reserveWithdrawal(
    externalUserId: string,
    operationId: string,
    amountUnits: string,
    destination: Destination,
  ) {
    this.reserveCalls += 1;
    const existing = this.withdrawals.get(operationId);
    if (existing) {
      if (
        externalUserId !== this.user.externalUserId ||
        existing.amountUnits !== amountUnits ||
        !sameDestination(existing.destination, destination)
      ) {
        throw new MongoStoreConflictError('key reused with another payload');
      }
      return {
        created: false,
        withdrawalId: existing.id,
        transferId: existing.transferId || null,
        status: existing.status,
        amountUnits: existing.amountUnits,
        balanceUnits: this.user.balanceUnits,
      };
    }

    if (BigInt(this.user.balanceUnits) < BigInt(amountUnits)) {
      throw new Error('debitBalance would drive balance below 0');
    }
    this.user.balanceUnits = (BigInt(this.user.balanceUnits) - BigInt(amountUnits)).toString();
    const withdrawal: Withdrawal = {
      id: operationId,
      transferId: '',
      amountUnits,
      destination: { ...destination },
      status: 'reserved',
      refunded: false,
      createdAt: new Date().toISOString(),
    };
    this.withdrawals.set(operationId, withdrawal);
    return {
      created: true,
      withdrawalId: operationId,
      transferId: null,
      status: 'reserved',
      amountUnits,
      balanceUnits: this.user.balanceUnits,
    };
  }

  async attachWithdrawalTransfer(operationId: string, transferId: string, status: string) {
    const withdrawal = this.requireWithdrawal(operationId);
    if (withdrawal.transferId && withdrawal.transferId !== transferId) {
      throw new MongoStoreConflictError('already attached');
    }
    withdrawal.transferId = transferId;
    withdrawal.status = status;
    return { user: this.user, withdrawal };
  }

  async getWithdrawal(withdrawalId: string) {
    const withdrawal = this.withdrawals.get(withdrawalId);
    return withdrawal ? { user: this.user, withdrawal } : undefined;
  }

  async updateWithdrawal(withdrawalId: string, patch: Partial<Withdrawal>): Promise<void> {
    Object.assign(this.requireWithdrawal(withdrawalId), patch);
  }

  async completeWithdrawal(withdrawalId: string) {
    const withdrawal = this.requireWithdrawal(withdrawalId);
    if (!withdrawal.refunded && withdrawal.status !== 'failed') withdrawal.status = 'completed';
    return { user: this.user, withdrawal };
  }

  async refundWithdrawal(withdrawalId: string, status = 'failed') {
    const withdrawal = this.requireWithdrawal(withdrawalId);
    if (!withdrawal.refunded && withdrawal.status !== 'completed') {
      this.refundCalls += 1;
      withdrawal.refunded = true;
      withdrawal.status = status;
      this.user.balanceUnits = (
        BigInt(this.user.balanceUnits) + BigInt(withdrawal.amountUnits)
      ).toString();
    }
    return { user: this.user, withdrawal };
  }

  getTestWithdrawal(withdrawalId: string): Withdrawal {
    return this.requireWithdrawal(withdrawalId);
  }

  private requireWithdrawal(withdrawalId: string): Withdrawal {
    const withdrawal = this.withdrawals.get(withdrawalId);
    if (!withdrawal) throw new Error('withdrawal not found');
    return withdrawal;
  }
}

class FakeOutboundTransfers {
  createCalls: string[] = [];
  retrieveCalls = 0;
  failCreate = false;
  retrieveStatus = 'pending';

  async create(_params: unknown, options: { idempotencyKey: string }) {
    this.createCalls.push(options.idempotencyKey);
    if (this.failCreate) throw new Error('connection reset after request write');
    return { id: 'transfer_123', status: 'pending' };
  }

  async retrieve(_transferId: string) {
    this.retrieveCalls += 1;
    return { status: this.retrieveStatus };
  }
}

function setup(): {
  store: FakeStore;
  provider: FakeOutboundTransfers;
  dependencies: WithdrawalDependencies;
} {
  const store = new FakeStore();
  const provider = new FakeOutboundTransfers();
  return {
    store,
    provider,
    dependencies: { store, outboundTransfers: provider },
  };
}

describe('cash-out idempotency and recovery', () => {
  test('uses the configurable $20 default as the actual service minimum', async () => {
    assert.equal(MIN_WITHDRAW_UNITS, '20000000');
    const { dependencies } = setup();
    await assert.rejects(
      withdraw(USER_ID, '19999999', DESTINATION, KEY, dependencies),
      (error: unknown) => error instanceof ValidationError && /20 USDC minimum/.test(error.message),
    );
  });

  test('validates a bounded, provider-safe HTTP key', () => {
    assert.equal(validateIdempotencyKey(KEY), KEY);
    for (const invalid of [undefined, '', 'short', 'spaces are unsafe', 'x'.repeat(129)]) {
      assert.throws(() => validateIdempotencyKey(invalid), ValidationError);
    }
  });

  test('passes the exact key to Unifold and a successful retry never debits or submits twice', async () => {
    const { store, provider, dependencies } = setup();
    const first = await withdraw(USER_ID, '20000000', DESTINATION, KEY, dependencies);
    const retried = await withdraw(USER_ID, '20000000', DESTINATION, KEY, dependencies);

    assert.equal(first.withdrawalId, KEY);
    assert.deepEqual(retried, first);
    assert.deepEqual(provider.createCalls, [KEY]);
    assert.equal(store.reserveCalls, 1);
    assert.equal(store.user.balanceUnits, '5000000');
  });

  test('keeps an ambiguous provider failure durably debited and reconciles with the same key', async () => {
    const { store, provider, dependencies } = setup();
    provider.failCreate = true;

    await assert.rejects(
      withdraw(USER_ID, '20000000', DESTINATION, KEY, dependencies),
      (error: unknown) =>
        error instanceof WithdrawalPendingError && error.withdrawalId === KEY,
    );
    assert.equal(store.user.balanceUnits, '5000000');
    assert.equal(store.getTestWithdrawal(KEY).status, 'reserved');
    assert.equal(store.refundCalls, 0);

    provider.failCreate = false;
    const reconciled = await withdraw(USER_ID, '20000000', DESTINATION, KEY, dependencies);
    assert.equal(reconciled.transferId, 'transfer_123');
    assert.deepEqual(provider.createCalls, [KEY, KEY]);
    assert.equal(store.user.balanceUnits, '5000000');
    assert.equal(store.reserveCalls, 1);
  });

  test('rejects same-key payload changes even after the original debit', async () => {
    const { dependencies } = setup();
    await withdraw(USER_ID, '20000000', DESTINATION, KEY, dependencies);
    await assert.rejects(
      withdraw(
        USER_ID,
        '20000000',
        { ...DESTINATION, recipient_address: '0xMALLORY' },
        KEY,
        dependencies,
      ),
      IdempotencyConflictError,
    );
  });

  test('poll exposes an unattached reservation as pending without another provider call', async () => {
    const { provider, dependencies } = setup();
    provider.failCreate = true;
    await assert.rejects(
      withdraw(USER_ID, '20000000', DESTINATION, KEY, dependencies),
      WithdrawalPendingError,
    );

    const result = await pollWithdrawal(KEY, dependencies);
    assert.equal(result.status, 'pending');
    assert.equal(result.transferId, null);
    assert.equal(provider.retrieveCalls, 0);
  });

  test('poll refunds exactly once only after an authoritative failed status', async () => {
    const { store, provider, dependencies } = setup();
    await withdraw(USER_ID, '20000000', DESTINATION, KEY, dependencies);
    provider.retrieveStatus = 'failed';

    const first = await pollWithdrawal(KEY, dependencies);
    const second = await pollWithdrawal(KEY, dependencies);
    assert.equal(first.status, 'failed');
    assert.equal(second.status, 'failed');
    assert.equal(store.refundCalls, 1);
    assert.equal(store.user.balanceUnits, '25000000');
  });

  test('same-key retry completes a refund interrupted after failed status was attached', async () => {
    const { store, provider, dependencies } = setup();
    await store.reserveWithdrawal(USER_ID, KEY, '20000000', DESTINATION);
    await store.attachWithdrawalTransfer(KEY, 'transfer_123', 'failed');

    const recovered = await withdraw(
      USER_ID,
      '20000000',
      DESTINATION,
      KEY,
      dependencies,
    );

    assert.equal(recovered.status, 'failed');
    assert.equal(store.refundCalls, 1);
    assert.equal(store.user.balanceUnits, '25000000');
    assert.deepEqual(provider.createCalls, []);
  });

  test('poll completes a refund interrupted after failed status was attached', async () => {
    const { store, provider, dependencies } = setup();
    await store.reserveWithdrawal(USER_ID, KEY, '20000000', DESTINATION);
    await store.attachWithdrawalTransfer(KEY, 'transfer_123', 'failed');

    const recovered = await pollWithdrawal(KEY, dependencies);

    assert.equal(recovered.status, 'failed');
    assert.equal(store.refundCalls, 1);
    assert.equal(store.user.balanceUnits, '25000000');
    assert.equal(provider.retrieveCalls, 0);
  });
});
