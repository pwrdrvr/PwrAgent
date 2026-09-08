/** In-memory only. No timers, filesystem reads, or per-request log writes. */
export type DirectoryEnrichmentCaller =
  | "thread-list"
  | "selected-thread"
  | "missing-worktree-backfill"
  | "explicit-enrichment"
  | "direct";

export type DirectoryEnrichmentReason =
  | "empty-path"
  | "pending-reuse"
  | "cache-hit"
  | "observation-unavailable"
  | "unversioned"
  | "cold"
  | "relationship-changed"
  | "head-changed";

export type DirectoryEnrichmentContext = {
  directory: string;
  enricherId: number;
  caller: DirectoryEnrichmentCaller;
  reason: DirectoryEnrichmentReason;
};

type Counters = {
  requests: number;
  observationErrors: number;
  gitStarted: number;
  gitSucceeded: number;
  gitFailed: number;
  gitDurationMs: number;
  topLevelCommands: number;
  worktreeListCommands: number;
  branchCommands: number;
  cacheStored: number;
  observationChangedDuringProbe: number;
  resultNotCached: number;
};

function counters(): Counters {
  return {
    requests: 0, observationErrors: 0, gitStarted: 0, gitSucceeded: 0, gitFailed: 0, gitDurationMs: 0,
    topLevelCommands: 0, worktreeListCommands: 0, branchCommands: 0,
    cacheStored: 0, observationChangedDuringProbe: 0, resultNotCached: 0,
  };
}

const BUCKET_MS = 2_000;
const BUCKET_COUNT = 60;
const ROWS_PER_BUCKET = 32;
const MAX_PATH_LENGTH = 1_024;

type Row = DirectoryEnrichmentContext & Counters;
type Bucket = {
  startMs: number;
  totals: Counters;
  overflow: Counters;
  rows: Map<string, Row>;
};

/**
 * Each bucket retains the first 32 directory/caller/reason combinations.
 * Overflow still contributes to exact totals; it is never presented as a
 * complete directory ranking. Command starts and completions are counted in
 * their respective buckets; elapsed time is wall duration, not CPU time.
 */
export class DirectoryEnrichmentDiagnostics {
  private enricherInstancesCreated = 0;
  private readonly buckets = new Map<number, Bucket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}

  createEnricherId(): number {
    return ++this.enricherInstancesCreated;
  }

  private prune(now: number): void {
    const start = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    for (const key of this.buckets.keys()) {
      if (key <= start - BUCKET_COUNT * BUCKET_MS || key > start) {
        this.buckets.delete(key);
      }
    }
  }

  record(context: DirectoryEnrichmentContext, delta: Partial<Counters>): void {
    const now = this.now();
    const startMs = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    let bucket = this.buckets.get(startMs);
    if (!bucket) {
      this.prune(now);
      bucket = { startMs, totals: counters(), overflow: counters(), rows: new Map() };
      this.buckets.set(startMs, bucket);
    }
    const directory = context.directory.slice(0, MAX_PATH_LENGTH);
    const key = JSON.stringify([directory, context.enricherId, context.caller, context.reason]);
    let row = bucket.rows.get(key);
    if (!row && bucket.rows.size < ROWS_PER_BUCKET) {
      row = { ...context, directory, ...counters() };
      bucket.rows.set(key, row);
    }
    for (const name of Object.keys(delta) as Array<keyof Counters>) {
      const amount = delta[name] ?? 0;
      bucket.totals[name] += amount;
      (row ?? bucket.overflow)[name] += amount;
    }
  }

  startGit(context: DirectoryEnrichmentContext, args: string[]): (failed: boolean) => void {
    const started = this.monotonicNow();
    this.record(context, {
      gitStarted: 1,
      ...(args.includes("--show-toplevel") ? { topLevelCommands: 1 }
        : args.includes("--porcelain") ? { worktreeListCommands: 1 }
        : { branchCommands: 1 }),
    });
    return (failed) => this.record(context, {
      gitSucceeded: failed ? 0 : 1,
      gitFailed: failed ? 1 : 0,
      gitDurationMs: Math.max(0, this.monotonicNow() - started),
    });
  }

  snapshot() {
    const capturedAtMs = this.now();
    this.prune(capturedAtMs);
    return {
      schemaVersion: 1,
      enricherInstancesCreated: this.enricherInstancesCreated,
      capturedAtMs,
      bucketMs: BUCKET_MS,
      retentionMs: BUCKET_COUNT * BUCKET_MS,
      rowsPerBucket: ROWS_PER_BUCKET,
      maxPathLength: MAX_PATH_LENGTH,
      buckets: [...this.buckets.values()].map((bucket) => ({
        startMs: bucket.startMs,
        totals: { ...bucket.totals },
        overflow: { ...bucket.overflow },
        rows: [...bucket.rows.values()].map((row) => ({ ...row })),
      })),
    };
  }
}

export const directoryEnrichmentDiagnostics = new DirectoryEnrichmentDiagnostics();
