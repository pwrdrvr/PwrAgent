import path from "node:path";
import { IterableQueueMapper } from "@shutterstock/p-map-iterable";
import { PerKeyAsyncLock } from "../util/per-key-async-lock";
import { canonicalWorktreePaths } from "./archive-worktree-references";

export const ARCHIVE_CLEANUP_SLICE_SIZE = 25;
export const ARCHIVE_CLEANUP_PAUSE_MS = 25;
export const ARCHIVE_CLEANUP_QUEUE_LIMIT = 256;
export const ARCHIVE_CLEANUP_CONCURRENCY = 4;

export class ArchiveCleanupCancelledError extends Error {
  constructor() {
    super("Archive cleanup cancelled by a thread lifecycle change or shutdown; the worktree was kept.");
  }
}

export type ArchiveCleanupContext = {
  /** Shared until this queue drains; writers keep the fleet index current. */
  batch?: object;
  assertCurrent: () => void;
  checkpoint: () => Promise<void>;
  /** Finish the snapshot persistence boundary after removal, even on cancel. */
  settleCheckpoint: () => Promise<void>;
  /** The shared fleet index has one reader/writer at a time. */
  withInventory?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Overlapping checkouts and managed containers cannot be removed together. */
  withWorktree?: <T>(scope: string, work: () => Promise<T>) => Promise<T>;
  setWorktreePath?: (worktreePath: string) => void;
};

export type ArchiveCleanupQueueProgress = {
  batch: number;
  active: Array<{ key: string; worktreePath?: string }>;
  queued: number;
  completed: number;
  total: number;
};

type Job<T> = {
  key: string;
  reportProgress: boolean;
  batch: object;
  cancelled: boolean;
  started: boolean;
  active: boolean;
  worktreePath?: string;
  wakes: Set<() => void>;
  work: (context: ArchiveCleanupContext) => Promise<T>;
  promise: Promise<T>;
  resolve: (result: T) => void;
  reject: (error: unknown) => void;
};
type Result<T> = { job: Job<T> } & ({ ok: true; value: T } | { ok: false; error: unknown });

/** Four bounded workers, with results consumed in completion order. Shared
 * ownership reads and overlapping filesystem scopes retain their own locks. */
export class ArchiveCleanupQueue<T> {
  private readonly jobs = new Map<string, Job<T>>();
  private readonly waiting: Job<T>[] = [];
  private readonly inventory = new PerKeyAsyncLock();
  private readonly scopes = new Map<symbol, { owner: Job<T>; path: string; done: Promise<void> }>();
  private readonly mapper: IterableQueueMapper<Job<T>, Result<T>>;
  private readonly consuming: Promise<void>;
  private feeding?: Promise<void>;
  private closed = false;
  private batch: object = {};
  private batchNumber = 0;
  private completed = 0;
  private total = 0;
  private reportedCompleted = 0;
  private reportedTotal = 0;
  private progressScheduled = false;
  private readonly checkpointWaiters: (() => void)[] = [];

  constructor(
    private readonly pauseMs = ARCHIVE_CLEANUP_PAUSE_MS,
    private readonly onCapacityAvailable?: () => void,
    private readonly onProgress?: (progress: ArchiveCleanupQueueProgress) => void,
  ) {
    this.mapper = new IterableQueueMapper(async (job) => await this.run(job), {
      concurrency: ARCHIVE_CLEANUP_CONCURRENCY,
      maxUnread: ARCHIVE_CLEANUP_CONCURRENCY,
    });
    this.consuming = this.consume();
    void this.consuming.catch((error: unknown) => {
      this.closed = true;
      for (const job of this.jobs.values()) {
        job.cancelled = true;
        for (const wake of job.wakes) wake();
        job.reject(error);
      }
    });
  }

  get availableSlots(): number {
    return this.closed ? 0 : ARCHIVE_CLEANUP_QUEUE_LIMIT - this.jobs.size;
  }

  progress(reportedOnly = false): ArchiveCleanupQueueProgress {
    const jobs = [...this.jobs.values()].filter((job) => !reportedOnly || job.reportProgress);
    const active = jobs.filter((job) => job.active)
      .map((job) => ({ key: job.key, ...(job.worktreePath ? { worktreePath: job.worktreePath } : {}) }));
    return { batch: this.batchNumber, active, queued: jobs.filter((job) => !job.started).length,
      completed: reportedOnly ? this.reportedCompleted : this.completed, total: reportedOnly ? this.reportedTotal : this.total };
  }

  /** A fake-clock driver advances only owned pacing timers, never host I/O. */
  whenCheckpointPending(): Promise<void> {
    if (this.closed || [...this.jobs.values()].some((job) => job.wakes.size > 0)) return Promise.resolve();
    return new Promise((resolve) => { this.checkpointWaiters.push(resolve); });
  }

  pending(key: string): Promise<T> | undefined { return this.jobs.get(key)?.promise; }
  pendingKeys(): string[] { return [...this.jobs.keys()]; }
  isCancelled(key: string): boolean { return this.jobs.get(key)?.cancelled === true; }

  enqueue(key: string, work: Job<T>["work"], options: { reportProgress?: boolean } = {}): Promise<T> {
    const existing = this.pending(key);
    if (existing) return existing;
    if (this.closed) return Promise.reject(new ArchiveCleanupCancelledError());
    if (this.jobs.size >= ARCHIVE_CLEANUP_QUEUE_LIMIT) {
      return Promise.reject(new Error("Archive cleanup queue is full; retry archive from Settings after cleanup settles. The worktree was kept."));
    }
    let resolve!: Job<T>["resolve"];
    let reject!: Job<T>["reject"];
    const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
    if (this.jobs.size === 0) {
      this.batch = {};
      this.batchNumber += 1;
      this.completed = 0;
      this.total = 0;
      this.reportedCompleted = 0;
      this.reportedTotal = 0;
    }
    const job: Job<T> = { key, reportProgress: options.reportProgress === true, batch: this.batch, work, promise, resolve, reject, cancelled: false, started: false, active: false, wakes: new Set() };
    this.jobs.set(key, job);
    this.waiting.push(job);
    this.total += 1;
    if (job.reportProgress) this.reportedTotal += 1;
    this.publishProgress();
    this.feed();
    return promise;
  }

  async cancelAndWait(key: string): Promise<void> {
    const pending = this.jobs.get(key)?.promise;
    this.cancel(key);
    await pending?.catch(() => {});
  }

  cancel(key: string): void {
    const job = this.jobs.get(key);
    if (!job) return;
    job.cancelled = true;
    for (const wake of job.wakes) wake();
    if (!job.started) {
      const index = this.waiting.indexOf(job);
      if (index >= 0) this.waiting.splice(index, 1);
      this.jobs.delete(key);
      this.completed += 1;
      if (job.reportProgress) this.reportedCompleted += 1;
      job.reject(new ArchiveCleanupCancelledError());
      this.publishProgress();
      if (!this.closed) this.onCapacityAvailable?.();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const cancelled = Promise.all([...this.jobs.keys()].map((key) => this.cancelAndWait(key)));
    await this.feeding;
    this.mapper.done();
    await cancelled;
    await this.consuming;
    for (const waiter of this.checkpointWaiters.splice(0)) waiter();
  }

  private feed(): void {
    if (this.feeding || this.closed) return;
    this.feeding = Promise.resolve().then(async () => {
      while (!this.closed && this.waiting.length > 0) {
        const job = this.waiting.shift()!;
        if (!job.cancelled) await this.mapper.enqueue(job);
      }
    }).finally(() => {
      this.feeding = undefined;
      if (this.waiting.length > 0 && !this.closed) this.feed();
    });
  }

  private async run(job: Job<T>): Promise<Result<T>> {
    const assertCurrent = () => {
      if (this.closed || job.cancelled) throw new ArchiveCleanupCancelledError();
    };
    const settleCheckpoint = async () => {
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); job.wakes.delete(finish); resolve(); };
        const timer = setTimeout(finish, this.pauseMs);
        job.wakes.add(finish);
        for (const waiter of this.checkpointWaiters.splice(0)) waiter();
      });
    };
    const checkpoint = async () => { assertCurrent(); await settleCheckpoint(); assertCurrent(); };
    try {
      assertCurrent();
      job.started = true;
      job.active = true;
      this.publishProgress();
      await checkpoint();
      const value = await job.work({
        batch: job.batch, assertCurrent, checkpoint, settleCheckpoint,
        withInventory: async (work) => await this.inventory.run("fleet", async () => { assertCurrent(); return await work(); }),
        withWorktree: async (scope, work) => await this.withWorktree(job, scope, assertCurrent, work),
        setWorktreePath: (worktreePath) => { job.worktreePath = worktreePath; this.publishProgress(); },
      });
      return { job, ok: true, value };
    } catch (error) {
      return { job, ok: false, error };
    } finally {
      job.active = false;
      if (job.started) this.completed += 1;
      if (job.started && job.reportProgress) this.reportedCompleted += 1;
      this.publishProgress();
    }
  }

  private async consume(): Promise<void> {
    for await (const result of this.mapper) {
      const { job } = result;
      if (this.jobs.get(job.key) !== job) continue;
      if (result.ok) job.resolve(result.value);
      else job.reject(result.error);
      // Completion observers persist the last reference boundary while the
      // completing job still belongs to this batch, before capacity is freed.
      await Promise.resolve();
      this.jobs.delete(job.key);
      if (!this.closed) this.onCapacityAvailable?.();
      this.publishProgress();
    }
  }

  private async withWorktree<R>(owner: Job<T>, scope: string, assertCurrent: () => void, work: () => Promise<R>): Promise<R> {
    for (;;) {
      assertCurrent();
      const canonical = await canonicalWorktreePaths()(scope);
      const contains = (parent: string, child: string) => {
        const relative = path.relative(parent, child);
        return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      };
      if ([...this.scopes.values()].some((active) => active.owner === owner && contains(active.path, canonical))) return await work();
      const blockers = [...this.scopes.values()].filter((active) => active.owner !== owner && (contains(canonical, active.path) || contains(active.path, canonical)));
      if (blockers.length) {
        // Initial scopes are sorted. Never wait in reverse order if fresh
        // ownership adds a scope. An unblocked scope is safe to acquire,
        // including an alias that now dangles after another job's removal.
        if ([...this.scopes.values()].some((active) => active.owner === owner && canonical < active.path)) {
          throw new Error("Worktree ownership changed during archive cleanup; the worktree was kept.");
        }
        await Promise.race(blockers.map((blocker) => blocker.done));
        continue;
      }
      let release!: () => void;
      const token = Symbol(scope);
      this.scopes.set(token, { owner, path: canonical, done: new Promise<void>((resolve) => { release = resolve; }) });
      try { assertCurrent(); return await work(); }
      finally { this.scopes.delete(token); release(); }
    }
  }

  private publishProgress(): void {
    if (this.progressScheduled || !this.onProgress) return;
    this.progressScheduled = true;
    queueMicrotask(() => { this.progressScheduled = false; this.onProgress?.(this.progress()); });
  }
}
