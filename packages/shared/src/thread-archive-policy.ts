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
  /** First failure of the last finished sweep. */
  error?: string;
};
