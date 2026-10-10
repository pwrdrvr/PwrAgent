export const ARCHIVE_CLEANUP_SLICE_SIZE = 25;
export const ARCHIVE_CLEANUP_PAUSE_MS = 25;
export const ARCHIVE_CLEANUP_QUEUE_LIMIT = 256;

export class ArchiveCleanupCancelledError extends Error {
  constructor() {
    super("Archive cleanup cancelled by a thread lifecycle change or shutdown; the worktree was kept.");
  }
}

export type ArchiveCleanupContext = {
  assertCurrent: () => void;
  checkpoint: () => Promise<void>;
  /** Finish the snapshot persistence boundary after removal, even on cancel. */
  settleCheckpoint: () => Promise<void>;
};

type Job<T> = {
  key: string;
  cancelled: boolean;
  work: (context: ArchiveCleanupContext) => Promise<T>;
  promise: Promise<T>;
  resolve: (result: T) => void;
  reject: (error: unknown) => void;
};

/** One physical cleanup at a time. Each provider/DB/discovery slice yields
 * through the owned, interruptible pacer; delaying a whole scan is not pacing. */
export class ArchiveCleanupQueue<T> {
  private readonly jobs = new Map<string, Job<T>>();
  private readonly waiting: Job<T>[] = [];
  private running?: Job<T>;
  private closed = false;
  private wake?: () => void;
  private readonly checkpointWaiters: (() => void)[] = [];

  constructor(private readonly pauseMs = ARCHIVE_CLEANUP_PAUSE_MS) {}

  /** Resolves once the running cleanup is parked on its checkpoint pause, the
   * only timer the queue owns. Between checkpoints a job awaits provider, DB,
   * and filesystem work that no clock can complete. */
  whenCheckpointPending(): Promise<void> {
    if (this.wake) return Promise.resolve();
    return new Promise((resolve) => { this.checkpointWaiters.push(resolve); });
  }

  pending(key: string): Promise<T> | undefined {
    return this.jobs.get(key)?.promise;
  }

  isCancelled(key: string): boolean {
    return this.jobs.get(key)?.cancelled === true;
  }

  enqueue(key: string, work: Job<T>["work"]): Promise<T> {
    const existing = this.pending(key);
    if (existing) return existing;
    if (this.closed) return Promise.reject(new ArchiveCleanupCancelledError());
    if (this.jobs.size >= ARCHIVE_CLEANUP_QUEUE_LIMIT) {
      return Promise.reject(new Error("Archive cleanup queue is full; retry archive from Settings after cleanup settles. The worktree was kept."));
    }
    let resolve!: Job<T>["resolve"];
    let reject!: Job<T>["reject"];
    const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
    const job: Job<T> = { key, work, promise, resolve, reject, cancelled: false };
    this.jobs.set(key, job);
    this.waiting.push(job);
    this.startNext();
    return promise;
  }

  async cancelAndWait(key: string): Promise<void> {
    const job = this.jobs.get(key);
    if (!job) return;
    job.cancelled = true;
    if (job === this.running) this.wake?.();
    else {
      this.waiting.splice(this.waiting.indexOf(job), 1);
      this.jobs.delete(key);
      job.reject(new ArchiveCleanupCancelledError());
    }
    await job.promise.catch(() => {});
  }

  cancel(key: string): void {
    const job = this.jobs.get(key);
    if (!job) return;
    job.cancelled = true;
    if (job === this.running) this.wake?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.jobs.keys()].map((key) => this.cancelAndWait(key)));
  }

  private startNext(): void {
    if (this.running || this.closed) return;
    const job = this.waiting.shift();
    if (!job) return;
    this.running = job;
    const assertCurrent = () => {
      if (this.closed || job.cancelled) throw new ArchiveCleanupCancelledError();
    };
    const settleCheckpoint = async () => {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.wake = undefined;
          resolve();
        };
        const timer = setTimeout(finish, this.pauseMs);
        this.wake = finish;
        for (const waiter of this.checkpointWaiters.splice(0)) waiter();
      });
    };
    const checkpoint = async () => {
      assertCurrent();
      await settleCheckpoint();
      assertCurrent();
    };
    void Promise.resolve().then(async () => {
      await checkpoint();
      return await job.work({ assertCurrent, checkpoint, settleCheckpoint });
    }).then(job.resolve, job.reject).finally(() => {
      this.jobs.delete(job.key);
      this.running = undefined;
      this.startNext();
    });
  }
}
