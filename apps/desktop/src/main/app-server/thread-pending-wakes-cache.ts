import { THREAD_PENDING_WAKES_ENDED_MAX_LIMIT, type ThreadPendingWakesList, type ThreadPullRequestWatchSummary } from "@pwragent/shared";
import { DEFAULT_PENDING_WAKES_ENDED_LIMIT, type PendingWakeThread } from "./thread-pending-wakes";

const REFRESH_INTERVAL_MS = 200;
const MAX_THREADS = 64;
const MAX_WAITERS_PER_THREAD = 512;
const MAX_RESULT_BYTES = 128 * 1024;

type Snapshot = {
  value: ThreadPendingWakesList;
  generation: number;
  endedLimit: number;
  expiresAt: number;
};
type Entry = {
  controller: AbortController;
  generation: number;
  nextReadAt: number;
  endedLimits: Map<number, number>;
  users: number;
  snapshot?: Snapshot;
  pending?: Promise<Snapshot>;
};
type ReadOptions = {
  endedLimit?: number;
  activePrWatches?: readonly ThreadPullRequestWatchSummary[];
};

/** One owner-side projection shared by IPC windows and federation detail. */
export class ThreadPendingWakesCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly load: (thread: PendingWakeThread, options: ReadOptions) => Promise<ThreadPendingWakesList>) {}

  async read(thread: PendingWakeThread, options: ReadOptions = {}): Promise<ThreadPendingWakesList> {
    const key = JSON.stringify([thread.backend, thread.threadId]);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= MAX_THREADS) {
        const idle = [...this.entries].find(([, candidate]) => !candidate.pending && candidate.users === 0);
        if (!idle) throw new Error("Pending wake read capacity is occupied.");
        this.entries.delete(idle[0]);
      }
      entry = { controller: new AbortController(), generation: 0, nextReadAt: 0, endedLimits: new Map(), users: 0 };
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (entry.users >= MAX_WAITERS_PER_THREAD) throw new Error("Pending wake read capacity is occupied.");
    const endedLimit = normalizeEndedLimit(options.endedLimit);
    entry.users += 1;
    entry.endedLimits.set(endedLimit, (entry.endedLimits.get(endedLimit) ?? 0) + 1);
    try {
      return await this.readEntry(thread, entry, { ...options, endedLimit });
    } finally {
      entry.users -= 1;
      const remaining = entry.endedLimits.get(endedLimit)! - 1;
      if (remaining === 0) entry.endedLimits.delete(endedLimit);
      else entry.endedLimits.set(endedLimit, remaining);
    }
  }

  private async readEntry(thread: PendingWakeThread, entry: Entry, options: ReadOptions & { endedLimit: number }): Promise<ThreadPendingWakesList> {
    const { endedLimit } = options;
    let canReuseWatches = true;
    for (;;) {
      entry.controller.signal.throwIfAborted();
      const cached = entry.snapshot;
      if (cached && cached.generation === entry.generation && cached.expiresAt > Date.now() && cached.endedLimit >= endedLimit) {
        return { ...cached.value, ended: cached.value.ended.slice(0, endedLimit) };
      }
      if (!entry.pending) {
        const retained = entry;
        const generation = entry.generation;
        const waitMs = Math.max(0, entry.nextReadAt - Date.now());
        const activePrWatches = canReuseWatches && waitMs === 0 ? options.activePrWatches : undefined;
        entry.pending = (async () => {
          if (waitMs > 0) await waitForRefresh(waitMs, retained.controller.signal);
          retained.controller.signal.throwIfAborted();
          const startedGeneration = retained.generation;
          const requested = Math.max(0, ...retained.endedLimits.keys());
          retained.nextReadAt = Date.now() + REFRESH_INTERVAL_MS;
          const value = await this.load(thread, { endedLimit: requested,
            ...(startedGeneration === generation && activePrWatches ? { activePrWatches } : {}) });
          retained.controller.signal.throwIfAborted();
          const snapshot = { value, generation: startedGeneration, endedLimit: requested, expiresAt: Date.now() + REFRESH_INTERVAL_MS };
          // Oversized history may be answered, but cannot occupy an unbounded cache.
          if (startedGeneration === retained.generation && Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_RESULT_BYTES) {
            retained.snapshot = snapshot;
          }
          return snapshot;
        })().finally(() => { retained.pending = undefined; });
      }
      const result = await entry.pending;
      canReuseWatches = false;
      if (result.generation === entry.generation && result.endedLimit >= endedLimit) {
        return { ...result.value, ended: result.value.ended.slice(0, endedLimit) };
      }
    }
  }

  invalidate(thread?: PendingWakeThread): void {
    const affected = thread ? [this.entries.get(JSON.stringify([thread.backend, thread.threadId]))] : this.entries.values();
    for (const entry of affected) {
      if (!entry) continue;
      entry.generation += 1;
      entry.snapshot = undefined;
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.controller.abort(new Error("Pending wake reader closed."));
    this.entries.clear();
  }
}

function normalizeEndedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PENDING_WAKES_ENDED_LIMIT;
  return Math.min(THREAD_PENDING_WAKES_ENDED_MAX_LIMIT, Math.max(0, Math.floor(limit)));
}

function waitForRefresh(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
