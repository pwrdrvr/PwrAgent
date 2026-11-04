/** Owns command probes, including obsolete cache entries still in flight. */
export class CommandDiscoveryLifetime {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private closing?: Promise<void>;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  run<T>(operation: () => Promise<T>, afterClose: T): Promise<T> {
    if (this.signal.aborted) return Promise.resolve(afterClose);
    const pending = operation();
    this.pending.add(pending);
    const settled = () => { this.pending.delete(pending); };
    void pending.then(settled, settled);
    return pending;
  }

  close(): Promise<void> {
    // Cancel admission before taking the snapshot. Already-running probes
    // finish gracefully; their promises include the child's stdio close.
    this.controller.abort();
    return this.closing ??= Promise.allSettled([...this.pending]).then(() => undefined);
  }
}
