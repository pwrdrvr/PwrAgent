import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";

/** The ledger is keyed by usage ID for replacements. Transcript reads also
 * need live-only turns, without visiting unrelated monitor rows. */
export class LivePricingLines extends Map<string, ThreadUsageLineRecord> {
  private readonly turns = new Map<string, Set<string>>();

  private readonly changeListeners = new Set<(id?: string) => void>();

  watchChanges(listener: (id?: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  constructor(previous?: Iterable<readonly [string, ThreadUsageLineRecord]>) {
    super();
    if (previous) {
      for (const [id, line] of previous) this.set(id, line);
    }
  }

  override set(id: string, line: ThreadUsageLineRecord): this {
    this.removeTurnIndex(id);
    if (line.scope === "turn" && line.turnId) {
      const ids = this.turns.get(line.turnId) ?? new Set<string>();
      ids.add(id);
      this.turns.set(line.turnId, ids);
    }
    super.set(id, line);
    for (const notify of this.changeListeners) notify(id);
    return this;
  }

  private removeTurnIndex(id: string): void {
    const previous = this.get(id);
    if (previous?.scope === "turn" && previous.turnId) {
      const ids = this.turns.get(previous.turnId);
      ids?.delete(id);
      if (!ids?.size) this.turns.delete(previous.turnId);
    }
  }

  override delete(id: string): boolean {
    this.removeTurnIndex(id);
    const removed = super.delete(id);
    if (removed) for (const notify of this.changeListeners) notify(id);
    return removed;
  }

  override clear(): void {
    this.turns.clear();
    super.clear();
    for (const notify of this.changeListeners) notify();
  }

  appendForTurns(turnIds: ReadonlySet<string>, selected: Map<string, ThreadUsageLineRecord>): void {
    // A live row of any scope can replace a previously selected row by ID.
    // Probe the smaller side so one worker with one line never walks an entire loaded page.
    const candidates = this.size < selected.size ? this.keys() : selected.keys();
    for (const id of candidates) {
      const replacement = this.get(id);
      if (replacement && selected.has(id)) {
        selected.set(id, replacement);
      }
    }
    const turns = this.turns.size < turnIds.size ? this.turns.keys() : turnIds;
    for (const turn of turns) {
      if (!turnIds.has(turn)) continue;
      for (const id of this.turns.get(turn) ?? []) {
        selected.set(id, this.get(id)!);
      }
    }
  }
}
