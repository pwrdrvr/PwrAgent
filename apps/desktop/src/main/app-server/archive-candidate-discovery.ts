import { setTimeout as pause } from "node:timers/promises";
import type { MaintenanceDiscoveryProgress } from "./unreferenced-worktrees";
import type { ThreadArchiveCandidate } from "./thread-archive-sweeper";
import { ArchiveCleanupCancelledError, ARCHIVE_CLEANUP_PAUSE_MS } from "./archive-cleanup-queue";

export const ARCHIVE_CANDIDATE_SLICE_SIZE = 25;
const ARCHIVE_CANDIDATE_ROW_BATCH = 16;
const ARCHIVE_CANDIDATE_WORK_MS = 8;

/** Bound microtask-only work by both row count and elapsed work time. Page
 * and SQL slice boundaries always rest, including empty provider pages. A
 * single provider response/row is indivisible; check again after it returns. */
export function archiveCandidateCheckpoint(assertCurrent: () => void, effects: {
  now: () => number; rest: (signal?: AbortSignal) => Promise<void>; yieldToHost?: () => Promise<void>;
} = {
  now: () => performance.now(),
  rest: async (signal) => { await pause(ARCHIVE_CLEANUP_PAUSE_MS, undefined, { signal }); },
}, signal?: AbortSignal): (boundary?: boolean) => Promise<void> {
  let rows = 0;
  let started = effects.now();
  return async (boundary = false) => {
    assertCurrent();
    rows += 1;
    if (boundary || effects.now() - started >= ARCHIVE_CANDIDATE_WORK_MS) {
      await effects.rest(signal);
      rows = 0;
      started = effects.now();
      assertCurrent();
    } else if (rows >= ARCHIVE_CANDIDATE_ROW_BATCH) {
      // Cheap metadata still yields, without charging a full rest for every
      // handful of Map inserts. Accumulate work time until the next rest.
      await (effects.yieldToHost?.() ?? new Promise<void>((resolve) => setImmediate(resolve)));
      rows = 0;
      assertCurrent();
    }
  };
}

type Observer = { progress?: (progress: MaintenanceDiscoveryProgress) => void };
type Pass = {
  abort: AbortController;
  observers: Set<Observer>;
  done: Promise<ThreadArchiveCandidate[]>;
};

/** Only concurrent exploratory readers share work. Nothing survives a pass.
 * Destructive admission calls the coordinator's fresh reader directly. Each
 * observer owns its cancellation; abandoning one cannot cancel another. */
export class ArchiveCandidateDiscovery {
  private pass?: Pass;

  constructor(private readonly read: (progress: (progress: MaintenanceDiscoveryProgress) => void,
    signal: AbortSignal) => Promise<ThreadArchiveCandidate[]>) {}

  async list(progress?: Observer["progress"], signal?: AbortSignal): Promise<ThreadArchiveCandidate[]> {
    if (signal?.aborted) throw new ArchiveCleanupCancelledError();
    // An abandoned read may still own an outstanding provider RPC. Let it
    // settle before a new pass, rather than creating a second owner.
    if (this.pass?.abort.signal.aborted) {
      await this.pass.done.catch(() => {});
      return await this.list(progress, signal);
    }
    let pass = this.pass;
    if (!pass) {
      const abort = new AbortController();
      const observers = new Set<Observer>();
      pass = { abort, observers, done: Promise.resolve().then(async () => await this.read((update) => {
        for (const observer of observers) observer.progress?.(update);
      }, abort.signal)).finally(() => { if (this.pass === pass) this.pass = undefined; }) };
      this.pass = pass;
    }
    const owned = pass;
    const observer = { progress };
    owned.observers.add(observer);
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        owned.observers.delete(observer);
        if (owned.observers.size === 0) owned.abort.abort();
        reject(new ArchiveCleanupCancelledError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([owned.done, cancelled]);
      return result.map((candidate) => ({ ...candidate }));
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      owned.observers.delete(observer);
    }
  }

  close(): Promise<void> | undefined {
    const pass = this.pass;
    if (!pass) return;
    pass.abort.abort();
    return pass.done.then(() => {}, () => {});
  }
}
