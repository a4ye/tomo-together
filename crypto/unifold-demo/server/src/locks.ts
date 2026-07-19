// Per-key async mutex. Serializes money mutations for a single externalUserId so
// two concurrent withdraws can't interleave (check -> transfer -> debit) and
// double-spend against the same pre-debit balance.
const chains = new Map<string, Promise<unknown>>();

export function withUserLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run regardless of whether the prior holder rejected
  // Keep the chain moving but don't leak rejections into the next waiter's tail.
  chains.set(
    id,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}
