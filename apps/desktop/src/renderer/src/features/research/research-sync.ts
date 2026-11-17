import {
  applyResearchChanges, emptyResearchRunStore, researchRunStoreCursor, researchRunStoreSynced,
  type ResearchChange, type ResearchChanges, type ResearchPendingRequest, type ResearchRunState, type ResearchRunStore, type ResearchRunSummary, type ResearchSnapshot, type ResearchThread,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/** What the panel draws from: the thread's runs, its pending request, and the store of the run on screen. */
export type ResearchSyncState = {
  /** Undefined until the first read of the run list lands. */
  runs?: ResearchRunSummary[];
  writableRunIds: string[];
  pending?: ResearchPendingRequest;
  /** The store of the run on screen once its sync has finished. */
  store?: ResearchRunStore;
  error?: string;
};

type Reads = Required<Pick<DesktopApi, "researchSnapshot" | "researchChanges">>;

/**
 * Keeps one thread's research current at the cost of what changed.
 *
 * A change event names its run and revision. For the run on screen it reads
 * the items changed since the store's revision; for any other run it reads
 * that run's summary alone. The whole run list is read once, and again only
 * when the thread's pending request changes. Reads run one at a time, and a
 * change that arrives during a read is folded into the next one.
 */
export class ResearchSync {
  private state: ResearchSyncState = { writableRunIds: [] };
  private store?: ResearchRunStore;
  private wantedRunId?: string;
  private listDirty = true;
  private runDirty = false;
  private readonly summariesDirty = new Set<string>();
  private pumping = false;
  private disposed = false;

  constructor(private readonly reads: Reads, private readonly thread: ResearchThread, private readonly publish: (state: ResearchSyncState) => void) {}

  start(): void { void this.pump(); }
  dispose(): void { this.disposed = true; }

  /** The run to show: the chosen one while the thread still lists it, else the newest. */
  select(runId: string | undefined): void {
    this.wantedRunId = runId;
    if (this.adoptRun()) void this.pump();
  }

  notify(change: ResearchChange): void {
    if (this.disposed || change.backend !== this.thread.backend || change.threadId !== this.thread.threadId) return;
    if (change.runId === undefined) this.listDirty = true;
    else if (change.runId === this.store?.runId) {
      // A revision the store already holds was read by an earlier, wider delta.
      if (change.revision === undefined || !researchRunStoreSynced(this.store) || this.store.revision < change.revision) this.runDirty = true;
    } else {
      const known = this.state.runs?.find((run) => run.id === change.runId);
      if (!known || change.revision === undefined || known.revision < change.revision) this.summariesDirty.add(change.runId);
    }
    // Even a change that needs no read of its own retries one that failed earlier.
    void this.pump();
  }

  private runId(): string | undefined {
    const runs = this.state.runs ?? [];
    return (runs.find((run) => run.id === this.wantedRunId) ?? runs[0])?.id;
  }

  /** Point the store at the run to show. True when that run still has to be read. */
  private adoptRun(): boolean {
    const id = this.runId();
    if (this.store?.runId === id) return false;
    this.store = id ? emptyResearchRunStore(id) : undefined;
    this.runDirty = Boolean(id);
    this.emit({ store: undefined });
    return this.runDirty;
  }

  private emit(patch: Partial<ResearchSyncState>): void {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.publish(this.state);
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    try {
      while (!this.disposed && (this.listDirty || this.runDirty || this.summariesDirty.size)) {
        if (this.listDirty) await this.readList();
        else if (this.runDirty) await this.readRun();
        else await this.readSummary(this.summariesDirty.values().next().value!);
      }
    } catch (error) {
      // Leave what was dirty as it is: the next change event retries it.
      this.emit({ error: error instanceof Error ? error.message : "Research could not be read" });
    } finally { this.pumping = false; }
  }

  private async readList(): Promise<void> {
    this.listDirty = false;
    try {
      const snapshot = await this.reads.researchSnapshot({ ...this.thread });
      if (this.disposed) return;
      this.summariesDirty.clear();
      this.emit({ runs: snapshot.runs, writableRunIds: snapshot.writableRunIds, pending: snapshot.pending, error: undefined });
      this.adoptRun();
    } catch (error) { this.listDirty = true; throw error; }
  }

  private async readSummary(runId: string): Promise<void> {
    this.summariesDirty.delete(runId);
    try {
      const snapshot = await this.reads.researchSnapshot({ ...this.thread, runId });
      if (this.disposed) return;
      this.mergeSummary(runId, snapshot);
      this.adoptRun();
    } catch (error) { this.summariesDirty.add(runId); throw error; }
  }

  /** Replace or insert one run in the list, newest first as the owner lists them. */
  private mergeSummary(runId: string, snapshot: ResearchSnapshot): void {
    const summary = snapshot.runs.find((run) => run.id === runId);
    const others = (this.state.runs ?? []).filter((run) => run.id !== runId);
    const runs = summary ? [...others, summary].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)) : others;
    const writable = new Set(this.state.writableRunIds);
    if (snapshot.writableRunIds.includes(runId)) writable.add(runId); else writable.delete(runId);
    this.emit({ runs, writableRunIds: [...writable], pending: snapshot.pending, error: undefined });
  }

  /**
   * Read pages of changes until none remain, then apply them together and show
   * the store. Applying updates the store's items in place, and the panel
   * holds the last store shown, so no page is applied until the sync is whole:
   * the panel never sees items newer than the state beside them, and a sync
   * that fails part way leaves the store as it was.
   */
  private async readRun(): Promise<void> {
    this.runDirty = false;
    let store = this.store;
    if (!store) return;
    const pages: ResearchChanges[] = [];
    try {
      let { sinceRevision, after } = researchRunStoreCursor(store);
      do {
        const page = await this.reads.researchChanges({ ...this.thread, runId: store.runId, sinceRevision, ...(after ? { after } : {}) });
        // The panel moved to another run while this page was in flight.
        if (this.disposed || this.store !== store) return;
        pages.push(page);
        // A reset replaces the store, so the rest of the run is read from the start.
        if (page.reset) sinceRevision = 0;
        after = page.next;
      } while (after);
    } catch (error) { this.runDirty = true; throw error; }
    for (const page of pages) store = applyResearchChanges(store, page);
    this.store = store;
    const state = store.state;
    const synced = store;
    this.emit({
      store,
      // The delta carries the run's current state, so its summary needs no read of its own.
      runs: state ? this.state.runs?.map((run) => run.id === synced.runId ? patchSummary(run, state) : run) : this.state.runs,
      writableRunIds: synced.writable ? [...new Set([...this.state.writableRunIds, synced.runId])] : this.state.writableRunIds.filter((id) => id !== synced.runId),
      error: undefined,
    });
  }
}

/** A run's summary with the state a delta carried. A run that has not ended has no reason. */
function patchSummary(summary: ResearchRunSummary, state: ResearchRunState): ResearchRunSummary {
  const { reason: _reason, ...rest } = summary;
  return { ...rest, revision: state.revision, status: state.status, ...(state.reason !== undefined ? { reason: state.reason } : {}),
    activeWorkers: state.activeWorkers, unreviewed: state.unreviewed, accepted: state.accepted };
}
