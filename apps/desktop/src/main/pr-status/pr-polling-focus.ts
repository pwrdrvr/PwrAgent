const EMPTY_FOCUS: ReadonlySet<string> = new Set();

/**
 * Which threads each window currently has selected / on screen, keyed by the
 * sender webContents id. The PR polling scheduler consumes the union across
 * live windows, so a second window pushing its own selection can never
 * clobber the first window's fast-poll tier (that clobbering was the
 * pre-existing bug behind the shared single-set implementation).
 */
export class PrPollingFocusTracker {
  private readonly focusBySender = new Map<number, ReadonlySet<string>>();

  set(senderKey: number, threadKeys: readonly string[]): void {
    if (threadKeys.length === 0) {
      // An empty push means "this window has nothing selected" — drop the
      // entry entirely so closed selections don't pin stale map rows.
      this.focusBySender.delete(senderKey);
      return;
    }
    this.focusBySender.set(senderKey, new Set(threadKeys));
  }

  /** Drop a closed window's focus so its threads leave the fast tier. */
  clearSender(senderKey: number): void {
    this.focusBySender.delete(senderKey);
  }

  clear(): void {
    this.focusBySender.clear();
  }

  union(): ReadonlySet<string> {
    if (this.focusBySender.size === 0) {
      return EMPTY_FOCUS;
    }
    if (this.focusBySender.size === 1) {
      return this.focusBySender.values().next().value ?? EMPTY_FOCUS;
    }
    const union = new Set<string>();
    for (const keys of this.focusBySender.values()) {
      for (const key of keys) {
        union.add(key);
      }
    }
    return union;
  }
}
