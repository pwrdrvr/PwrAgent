/**
 * Serialises async operations keyed by an arbitrary string. Each call to
 * {@link PerKeyAsyncLock.run} chains its `task` after the previous task
 * registered against the same key; tasks on different keys run in
 * parallel. This is the right primitive when you have read-modify-write
 * operations against shared state (e.g. an overlay row) keyed by an
 * identifier (e.g. a thread id) that need to serialise per-key but
 * shouldn't block unrelated work.
 *
 * Failure semantics: a task that rejects does NOT poison the chain for
 * subsequent tasks on the same key. The chain is tracked via a
 * promise that swallows errors so future awaiters never see them; each
 * caller's `run()` call returns the unfiltered promise so they observe
 * the rejection themselves.
 *
 * Memory: map entries are dropped once the chain settles AND no later
 * `run()` call has queued on the same key, so a busy-then-quiet key
 * doesn't grow the map unboundedly.
 */
export class PerKeyAsyncLock {
  private readonly chains = new Map<string, Promise<unknown>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    // Chain regardless of previous settled state — a single failed
    // task shouldn't poison the chain for subsequent ones.
    const next = previous.then(task, task);
    // The map tracks the swallowed-error form so future chains don't
    // reject when they await the previous link.
    const tracked = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tracked);
    try {
      return await next;
    } finally {
      // Lazy cleanup: only drop the map entry if no later task got
      // chained on this same slot while we were running.
      if (this.chains.get(key) === tracked) {
        this.chains.delete(key);
      }
    }
  }

  /** For tests: how many keys currently have a chained task in flight. */
  size(): number {
    return this.chains.size;
  }
}
