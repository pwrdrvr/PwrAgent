/** Inverted primary-attachment index; status delivery never scans every thread. */
export class PrThreadIndex {
  private readonly threadsByPr = new Map<string, Set<string>>();
  private readonly prsByThread = new Map<string, Set<string>>();

  set(threadKey: string, prKeys: Iterable<string>): void {
    for (const key of this.prsByThread.get(threadKey) ?? []) {
      const threads = this.threadsByPr.get(key);
      threads?.delete(threadKey);
      if (!threads?.size) this.threadsByPr.delete(key);
    }
    const keys = new Set(prKeys);
    if (keys.size) this.prsByThread.set(threadKey, keys);
    else this.prsByThread.delete(threadKey);
    for (const key of keys) {
      let threads = this.threadsByPr.get(key);
      if (!threads) {
        threads = new Set();
        this.threadsByPr.set(key, threads);
      }
      threads.add(threadKey);
    }
  }

  has(prKey: string): boolean {
    return this.threadsByPr.has(prKey);
  }

  get(prKey: string): ReadonlySet<string> | undefined {
    return this.threadsByPr.get(prKey);
  }

  clear(): void {
    this.threadsByPr.clear();
    this.prsByThread.clear();
  }
}
