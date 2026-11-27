import { isDeepStrictEqual } from "node:util";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";

export class LivePricingMap<T> extends Map<string, T> {
  private readonly changeListeners = new Set<(id?: string) => void>();

  constructor() { super(); }

  watchChanges(listener: (id?: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  override set(id: string, value: T): this {
    // Replay can replace every live gate with equivalent records in one batch.
    // Observers need only the ids whose contents actually changed.
    const changed = this.changeListeners.size > 0 && !isDeepStrictEqual(this.get(id), value);
    super.set(id, value);
    if (changed) for (const notify of this.changeListeners) notify(id);
    return this;
  }

  override delete(id: string): boolean {
    const removed = super.delete(id);
    if (removed) for (const notify of this.changeListeners) notify(id);
    return removed;
  }

  override clear(): void {
    super.clear();
    for (const notify of this.changeListeners) notify();
  }
}

/** The ledger is keyed by usage ID for replacements. Transcript reads also
 * need live-only turns, without visiting unrelated monitor rows. */
export class LivePricingLines extends LivePricingMap<ThreadUsageLineRecord> {
  private readonly sources = new Map<string, Set<string>>();
  private readonly turns = new Map<string, Set<string>>();

  constructor(previous?: Iterable<readonly [string, ThreadUsageLineRecord]>) {
    super();
    if (previous) {
      for (const [id, line] of previous) this.set(id, line);
    }
  }

  override set(id: string, line: ThreadUsageLineRecord): this {
    if (this.get(id)?.sourceItemId !== line.sourceItemId) {
      this.removeSource(id);
      if (line.sourceItemId) {
        const ids = this.sources.get(line.sourceItemId) ?? new Set();
        ids.add(id);
        this.sources.set(line.sourceItemId, ids);
      }
    }
    this.removeTurnIndex(id);
    if (line.scope === "turn" && line.turnId) {
      const ids = this.turns.get(line.turnId) ?? new Set<string>();
      ids.add(id);
      this.turns.set(line.turnId, ids);
    }
    return super.set(id, line);
  }

  forSource(source: string): ThreadUsageLineRecord | undefined {
    const id = this.sources.get(source)?.values().next().value;
    return id === undefined ? undefined : this.get(id);
  }

  private removeSource(id: string): void {
    const source = this.get(id)?.sourceItemId;
    if (!source) return;
    const ids = this.sources.get(source);
    ids?.delete(id);
    if (!ids?.size) this.sources.delete(source);
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
    this.removeSource(id);
    this.removeTurnIndex(id);
    return super.delete(id);
  }

  override clear(): void {
    this.sources.clear();
    this.turns.clear();
    super.clear();
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
