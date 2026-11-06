import type {
  ThreadMaintenanceApplyRequest,
  ThreadMaintenanceArchivedCheckout,
  ThreadMaintenanceHibernateCheckout,
  ThreadMaintenanceIdleThread,
  ThreadMaintenanceOverLimitChoice,
  ThreadMaintenanceScan,
  ThreadMaintenanceWorkspace,
} from "@pwragent/shared";

/** Which steps a tab runs. Combined runs every step in order. */
export type ThreadMaintenanceMode = "combined" | "threads" | "hibernate" | "checkouts";

/** Whether a tab runs a step. */
export function modeRuns(mode: ThreadMaintenanceMode, step: Exclude<ThreadMaintenanceMode, "combined">): boolean {
  return mode === "combined" || mode === step;
}

/** "keep" leaves an over-limit thread alone; it is never archived. */
export type OverLimitDecision = "keep" | ThreadMaintenanceOverLimitChoice;

export type ThreadMaintenanceSelection = {
  /** Idle-thread keys (`backend:threadId`) chosen for archive. */
  threads: Set<string>;
  overLimit: Map<string, OverLimitDecision>;
  /** Archived checkout paths chosen for removal or the Trash. */
  checkouts: Set<string>;
  emptyFolders: boolean;
  /** Idle-thread keys (`backend:threadId`) whose checkout hibernates. */
  hibernate: Set<string>;
};

/** Idle checkouts a tab offers. A tab that archives does not offer a
 * thread again once its archive row is chosen. */
export function hibernateItems(
  scan: ThreadMaintenanceScan,
  selection?: Pick<ThreadMaintenanceSelection, "threads">,
  mode?: ThreadMaintenanceMode,
): ThreadMaintenanceHibernateCheckout[] {
  const items = scan.hibernate?.items ?? [];
  if (!selection || !mode || !modeRuns(mode, "threads")) return items;
  return items.filter((item) => !item.archiveKey || !selection.threads.has(item.archiveKey));
}

export function idleThreadKey(row: Pick<ThreadMaintenanceIdleThread, "backend" | "threadId">): string {
  return `${row.backend}:${row.threadId}`;
}

export function needsDecision(row: ThreadMaintenanceIdleThread): boolean {
  return row.workspace.kind === "overLimit";
}

export function allIdleThreads(scan: ThreadMaintenanceScan): ThreadMaintenanceIdleThread[] {
  return scan.threads.projects.flatMap((project) => project.idle);
}

/** Everything that needs no decision starts selected. A thread over the
 * snapshot limit and a checkout whose repository is gone never do. */
export function defaultSelection(scan: ThreadMaintenanceScan): ThreadMaintenanceSelection {
  return {
    threads: new Set(allIdleThreads(scan).filter((row) => !needsDecision(row)).map(idleThreadKey)),
    overLimit: new Map(),
    checkouts: new Set(scan.checkouts.items.filter((item) => item.kind === "removable").map((item) => item.worktreePath)),
    emptyFolders: scan.checkouts.emptyFolders > 0,
    // Every row already passed the snapshot limit and the other checks.
    hibernate: new Set(hibernateItems(scan).map(idleThreadKey)),
  };
}

/** One apply request for every reviewed step. A tab that runs one step
 * sends nothing for the others. */
export function buildApplyRequest(
  scan: ThreadMaintenanceScan,
  selection: ThreadMaintenanceSelection,
  mode: ThreadMaintenanceMode,
): ThreadMaintenanceApplyRequest {
  const runThreads = modeRuns(mode, "threads");
  const runCheckouts = modeRuns(mode, "checkouts");
  const runHibernate = modeRuns(mode, "hibernate");
  const archive = runThreads
    ? allIdleThreads(scan).flatMap((row) => {
      const key = idleThreadKey(row);
      if (!selection.threads.has(key)) return [];
      if (!needsDecision(row)) return [{ backend: row.backend, threadId: row.threadId }];
      const decision = selection.overLimit.get(key) ?? "keep";
      return decision === "keep" ? [] : [{ backend: row.backend, threadId: row.threadId, overLimit: decision }];
    })
    : [];
  const chosen = (item: ThreadMaintenanceArchivedCheckout) => runCheckouts && selection.checkouts.has(item.worktreePath);
  const owned = scan.checkouts.items.filter((item) => item.kind !== "unreferenced");
  return {
    scanId: scan.scanId,
    archive,
    removeCheckouts: owned.filter((item) => item.kind === "removable" && chosen(item))
      .map(({ backend, threadId, worktreePath }) => ({ backend, threadId, worktreePath })),
    trashCheckouts: owned.filter((item) => item.kind === "repositoryGone" && chosen(item))
      .map(({ worktreePath }) => ({ worktreePath })),
    removeUnreferenced: scan.checkouts.items.filter((item) => item.kind === "unreferenced" && chosen(item))
      .map(({ worktreePath }) => ({ worktreePath })),
    removeEmptyFolders: runCheckouts && selection.emptyFolders,
    hibernate: runHibernate
      ? hibernateItems(scan, selection, mode).filter((item) => selection.hibernate.has(idleThreadKey(item)))
        .map(({ backend, threadId }) => ({ backend, threadId }))
      : [],
  };
}

/** True once a selected over-limit row has a choice other than keep. */
export function selectedCount(scan: ThreadMaintenanceScan, selection: ThreadMaintenanceSelection): number {
  return buildApplyRequest(scan, selection, "threads").archive.length;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "touched 26 days ago". Measured from the scan time, never Date.now(),
 * so the render path stays pure. */
export function formatAge(at: number, now: number): string {
  const days = Math.floor(Math.max(0, now - at) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 45) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

/** The colored lead of a row's state line, and its tone. */
export function workspaceLead(workspace: ThreadMaintenanceWorkspace): { text: string; tone: "ok" | "warn" | "muted" } {
  switch (workspace.kind) {
    case "clean": return { text: "Clean", tone: "ok" };
    case "changes": return {
      text: `${workspace.files} uncommitted ${workspace.files === 1 ? "file" : "files"}, saved to a recovery snapshot (${formatBytes(workspace.bytes)})`,
      tone: "warn",
    };
    case "overLimit": return {
      text: `Uncommitted changes are ${formatBytes(workspace.bytes)}, over the ${formatBytes(workspace.limitBytes)} snapshot limit`,
      tone: "warn",
    };
    case "notGit": return { text: "Not a Git folder; it stays in place", tone: "muted" };
    case "inPlace": return { text: "Main checkout; it stays in place", tone: "muted" };
    case "missing": return { text: "Folder already gone", tone: "muted" };
  }
}

/** Kept reasons, largest first. */
export function keptEntries(kept: Record<string, number>): [string, number][] {
  return Object.entries(kept).filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function keptTotal(kept: Record<string, number>): number {
  return Object.values(kept).reduce((sum, count) => sum + count, 0);
}
