export type DesktopThreadArchivePolicy = {
  enabled: boolean;
  mode: "age" | "count";
  inactivityDays: number;
  keepPerProject: number;
  /** Zero means archived threads and their snapshots never expire automatically. */
  retentionDays: number;
};

export const DEFAULT_THREAD_ARCHIVE_POLICY: DesktopThreadArchivePolicy = {
  enabled: true,
  mode: "count",
  inactivityDays: 7,
  keepPerProject: 20,
  retentionDays: 0,
};

export function normalizeThreadArchivePolicy(
  value?: Partial<DesktopThreadArchivePolicy>,
): DesktopThreadArchivePolicy {
  const integer = (value: unknown, fallback: number, minimum: number, maximum: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
      : fallback;
  return {
    enabled: value?.enabled ?? DEFAULT_THREAD_ARCHIVE_POLICY.enabled,
    mode: value?.mode === "age" ? "age" : "count",
    inactivityDays: integer(value?.inactivityDays, 7, 1, 3650),
    keepPerProject: integer(value?.keepPerProject, 20, 1, 10000),
    retentionDays: integer(value?.retentionDays, DEFAULT_THREAD_ARCHIVE_POLICY.retentionDays, 0, 3650),
  };
}

/** Main-process memory only: an idle hourly sweep must make no SQLite commits,
 * so a relaunch starts again from "not run yet". */
export type DesktopThreadArchiveSweepStatus = {
  running: boolean;
  /** Start of the running sweep, or of the last finished one. */
  startedAt?: number;
  finishedAt?: number;
  /** When the scheduler next starts a sweep. Absent before start() and after stop(). */
  nextAt?: number;
  archived: number;
  deleted: number;
  failed: number;
  /** Archived checkout repair, separate from archiving or deleting conversations. */
  worktrees?: {
    candidates: number;
    protected: number;
    processed: number;
    removed: number;
    emptyContainers?: number;
    processedContainers?: number;
    removedContainers?: number;
    /** Checkouts left in place, counted by reason. */
    kept?: Record<string, number>;
  };
  /** The conversation archive pass. Absent while it has not started. */
  threads?: {
    /** Root threads read; native sub-agents travel with their root. */
    checked: number;
    eligible: number;
    archived: number;
    /** Threads left active, counted by reason. */
    kept: Record<string, number>;
    /** Why the pass did not run, for example when automatic archiving is off. */
    skipped?: string;
  };
  /** The idle checkout hibernation pass. Absent while it has not started. */
  hibernation?: {
    /** Threads with a PwrAgent worktree checkout that were read. */
    checked: number;
    hibernated: number;
    /** Checkouts left in place, counted by reason. */
    kept: Record<string, number>;
    /** Why the pass did not run, for example when hibernation is off. */
    skipped?: string;
  };
  /** First failure of the last finished sweep. */
  error?: string;
  /** Up to THREAD_ARCHIVE_SWEEP_FAILURE_LIMIT failures; `failed` is the full count. */
  failures?: DesktopThreadArchiveSweepFailure[];
};

export const THREAD_ARCHIVE_SWEEP_FAILURE_LIMIT = 20;

export type DesktopThreadArchiveSweepFailure = {
  phase: "worktrees" | "retention" | "threads" | "hibernation";
  message: string;
  path?: string;
  threadId?: string;
};
