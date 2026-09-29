/**
 * PRs a thread lookup is fetching right now, keyed by PR status key.
 *
 * Selecting a thread starts the renderer's scheduled lookup and puts the
 * thread's PRs in the poller's focused tier at the same moment. The lookup
 * stamps the status registry only when its response lands, so a poller tick
 * in between saw the PR as due and fetched it a second time. The poller reads
 * `startedAt` as the PR's freshness instead. A failed lookup releases its
 * PRs without stamping them, and the poller picks them up on its next tick.
 */
export class PrLookupsInFlight {
  private readonly byPrKey = new Map<string, { count: number; startedAt: number }>();

  /** Returns the release; call it exactly once, when the lookup settles. */
  begin(prKeys: readonly string[], startedAt: number): () => void {
    const keys = [...new Set(prKeys)];
    for (const key of keys) {
      const current = this.byPrKey.get(key);
      this.byPrKey.set(key, {
        count: (current?.count ?? 0) + 1,
        startedAt: Math.max(current?.startedAt ?? 0, startedAt),
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        const current = this.byPrKey.get(key);
        if (!current) continue;
        if (current.count <= 1) {
          this.byPrKey.delete(key);
        } else {
          this.byPrKey.set(key, { ...current, count: current.count - 1 });
        }
      }
    };
  }

  startedAt(prKey: string): number | undefined {
    return this.byPrKey.get(prKey)?.startedAt;
  }
}
