import {
  THREAD_MAINTENANCE_SCAN_STEPS,
  type ThreadMaintenanceApplyRequest,
  type ThreadMaintenanceArchivedCheckout,
  type ThreadMaintenanceBuildOutput,
  type ThreadMaintenanceHibernateCheckout,
  type ThreadMaintenanceIdleThread,
  type ThreadMaintenanceOverLimitChoice,
  type ThreadMaintenanceProblem,
  type ThreadMaintenanceScan,
  type ThreadMaintenanceScanStep,
  type ThreadMaintenanceSpace,
  type ThreadMaintenanceWorkspace,
} from "@pwragent/shared";

/** Which steps a tab runs. Combined runs the steps its plan has ticked. */
export type ThreadMaintenanceMode = "combined" | ThreadMaintenanceScanStep;

/** The steps Combined runs, as the operator ticked them. */
export type ThreadMaintenancePlan = Record<ThreadMaintenanceScanStep, boolean>;

/** Archiving is the operator's choice, so Combined never starts with it on. */
export const DEFAULT_THREAD_MAINTENANCE_PLAN: ThreadMaintenancePlan = { threads: false, hibernate: true, checkouts: true };

/** The steps a tab runs, in run order. */
export function runSteps(mode: ThreadMaintenanceMode, plan: ThreadMaintenancePlan = DEFAULT_THREAD_MAINTENANCE_PLAN): ThreadMaintenanceScanStep[] {
  return THREAD_MAINTENANCE_SCAN_STEPS.filter((step) => mode === "combined" ? plan[step] : mode === step);
}

/** A tab, or the exact steps that run. A bare "combined" means every step. */
export type ThreadMaintenanceSteps = ThreadMaintenanceMode | readonly ThreadMaintenanceScanStep[];

function stepList(steps: ThreadMaintenanceSteps): readonly ThreadMaintenanceScanStep[] {
  if (typeof steps !== "string") return steps;
  return steps === "combined" ? THREAD_MAINTENANCE_SCAN_STEPS : [steps];
}

/** Whether a step runs. */
export function stepRuns(steps: ThreadMaintenanceSteps, step: ThreadMaintenanceScanStep): boolean {
  return stepList(steps).includes(step);
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
  /** Build output folders (`outputPath`) chosen for cleaning. Absent when
   * the selection predates them. */
  buildOutputs?: Set<string>;
};

/** Idle checkouts a tab offers. A tab that archives does not offer a
 * thread again once its archive row is chosen. */
export function hibernateItems(
  scan: ThreadMaintenanceScan,
  selection?: Pick<ThreadMaintenanceSelection, "threads">,
  steps?: ThreadMaintenanceSteps,
): ThreadMaintenanceHibernateCheckout[] {
  const items = scan.hibernate?.items ?? [];
  if (!selection || !steps || !stepRuns(steps, "threads")) return items;
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
    // Cleaning costs a rebuild, so the operator picks which.
    buildOutputs: new Set(),
  };
}

/** Whether `path` is `root` or inside it. */
function within(path: string, root: string): boolean {
  const base = root.replace(/[\\/]+$/, "");
  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
}

/** The checkout this request removes that holds `output`, if any: an
 * archived checkout chosen for removal or the Trash, or an idle checkout
 * chosen to hibernate. Every ignored file goes with a removed checkout,
 * whatever an older scan says about rebuildable output, so its output is
 * neither sent nor counted again. */
export function buildOutputCoveredBy(
  scan: ThreadMaintenanceScan,
  selection: ThreadMaintenanceSelection,
  steps: ThreadMaintenanceSteps,
  output: Pick<ThreadMaintenanceBuildOutput, "outputPath">,
): string | undefined {
  if (stepRuns(steps, "checkouts")) {
    const checkout = scan.checkouts.items.find((item) =>
      selection.checkouts.has(item.worktreePath) && within(output.outputPath, item.worktreePath));
    if (checkout) return checkout.worktreePath;
  }
  if (stepRuns(steps, "hibernate")) {
    const idle = hibernateItems(scan, selection, steps).find((item) =>
      selection.hibernate.has(idleThreadKey(item)) && within(output.outputPath, item.worktreePath));
    if (idle) return idle.worktreePath;
  }
  return undefined;
}

/** Whether the scan named a thread that uses this output's checkout. Output
 * with no identified thread is never offered: a checkout nobody is known to
 * use is not this review's to clean. */
export function buildOutputOwned(output: Pick<ThreadMaintenanceBuildOutput, "threads">): boolean {
  return (output.threads?.length ?? 0) > 0;
}

/** Selected build outputs the request sends: chosen, owned by an identified
 * thread, in a checkouts run, and not inside a checkout the same request
 * removes. */
export function buildOutputsToClean(
  scan: ThreadMaintenanceScan,
  selection: ThreadMaintenanceSelection,
  steps: ThreadMaintenanceSteps,
): ThreadMaintenanceBuildOutput[] {
  if (!stepRuns(steps, "checkouts")) return [];
  const seen = new Set<string>();
  return (scan.checkouts.buildOutputs ?? []).filter((output) => {
    if (!buildOutputOwned(output) || !selection.buildOutputs?.has(output.outputPath) || seen.has(output.outputPath)) return false;
    seen.add(output.outputPath);
    return !buildOutputCoveredBy(scan, selection, steps, output);
  });
}

/** One apply request for every reviewed step. A step that does not run
 * sends nothing, whatever was selected for it. */
export function buildApplyRequest(
  scan: ThreadMaintenanceScan,
  selection: ThreadMaintenanceSelection,
  steps: ThreadMaintenanceSteps,
): ThreadMaintenanceApplyRequest {
  const runThreads = stepRuns(steps, "threads");
  const runCheckouts = stepRuns(steps, "checkouts");
  const runHibernate = stepRuns(steps, "hibernate");
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
  // A checkout no thread refers to is never sent, even when a selection
  // restored from an older scan still holds its path.
  const owned = scan.checkouts.items.filter((item) => item.kind !== "unreferenced");
  const outputs = buildOutputsToClean(scan, selection, steps).map(({ outputPath }) => ({ outputPath }));
  return {
    scanId: scan.scanId,
    archive,
    removeCheckouts: owned.filter((item) => item.kind === "removable" && chosen(item))
      .map(({ backend, threadId, worktreePath }) => ({ backend, threadId, worktreePath })),
    trashCheckouts: owned.filter((item) => item.kind === "repositoryGone" && chosen(item))
      .map(({ worktreePath }) => ({ worktreePath })),
    removeEmptyFolders: runCheckouts && selection.emptyFolders,
    hibernate: runHibernate
      ? hibernateItems(scan, selection, steps).filter((item) => selection.hibernate.has(idleThreadKey(item)))
        .map(({ backend, threadId }) => ({ backend, threadId }))
      : [],
    // Sent only when there is one, so a request without build outputs
    // keeps the shape an older owner reads.
    ...(outputs.length ? { removeBuildOutputs: outputs } : {}),
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

/** "42s", "2m 14s", "1h 3m". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Measured rows by allocation, largest first; unmeasured rows after them,
 * each group in scan order. */
export function largestFirst<T extends { space?: ThreadMaintenanceSpace }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index, bytes: item.space?.allocatedBytes }))
    .sort((a, b) => a.bytes === undefined
      ? b.bytes === undefined ? a.index - b.index : 1
      : b.bytes === undefined ? -1 : b.bytes - a.bytes || a.index - b.index)
    .map(({ item }) => item);
}

export type AllocationTotal = {
  bytes: number;
  /** Rows with a measured allocation. */
  measured: number;
  /** True when any measured row is a lower bound, or a row is unmeasured. */
  lowerBound: boolean;
};

/** Summed allocation of rows, or undefined when none was measured. Rows
 * that name the same checkout path count once: a parent and its sub-thread
 * can share one checkout. */
export function allocationTotal(
  items: readonly { space?: ThreadMaintenanceSpace; worktreePath?: string }[],
): AllocationTotal | undefined {
  const seen = new Set<string>();
  let rows = 0;
  let bytes = 0;
  let measured = 0;
  let lowerBound = false;
  for (const item of items) {
    if (item.worktreePath !== undefined) {
      if (seen.has(item.worktreePath)) continue;
      seen.add(item.worktreePath);
    }
    rows += 1;
    if (item.space?.allocatedBytes === undefined) continue;
    bytes += item.space.allocatedBytes;
    measured += 1;
    if (item.space.lowerBound) lowerBound = true;
  }
  if (!measured) return undefined;
  return { bytes, measured, lowerBound: lowerBound || measured < rows };
}

const BUILD_OUTPUT_TYPES: Record<ThreadMaintenanceBuildOutput["kind"], string> = { cargo: "Cargo" };

/** The detected build tool's name, such as "Cargo". */
export function buildOutputType(kind: ThreadMaintenanceBuildOutput["kind"]): string {
  return BUILD_OUTPUT_TYPES[kind] ?? kind;
}

/** "Cargo output · 9 GB" for each detected type inside an owned checkout.
 * A description only: it never makes a checkout eligible or changes which
 * rows a step offers. */
export function rebuildableOutputLabels(output: ThreadMaintenanceSpace["rebuildableOutput"]): string[] {
  const kinds = new Map<ThreadMaintenanceBuildOutput["kind"], { space?: ThreadMaintenanceSpace }[]>();
  for (const item of output ?? []) {
    const rows = kinds.get(item.kind) ?? [];
    rows.push({ space: item.allocatedBytes === undefined ? undefined : { allocatedBytes: item.allocatedBytes, lowerBound: item.lowerBound } });
    kinds.set(item.kind, rows);
  }
  return [...kinds].map(([kind, rows]) => {
    const total = allocationTotal(rows);
    return `${buildOutputType(kind)} output${total ? ` · ${formatAllocation(total)}` : ""}`;
  });
}

/** "≥ 12 GB" for a lower bound. */
export function formatAllocation(total: Pick<AllocationTotal, "bytes" | "lowerBound">): string {
  return `${total.lowerBound ? "≥ " : ""}${formatBytes(total.bytes)}`;
}

/** Outcome rows grouped by reason: the largest group first, ties in the
 * order each reason first appears. Rows keep their order inside a group. */
export function groupProblems(problems: readonly ThreadMaintenanceProblem[]): { reason: string; problems: ThreadMaintenanceProblem[] }[] {
  const groups = new Map<string, ThreadMaintenanceProblem[]>();
  for (const problem of problems) {
    const group = groups.get(problem.reason);
    if (group) group.push(problem);
    else groups.set(problem.reason, [problem]);
  }
  return [...groups].map(([reason, rows], index) => ({ reason, problems: rows, index }))
    .sort((a, b) => b.problems.length - a.problems.length || a.index - b.index)
    .map(({ reason, problems: rows }) => ({ reason, problems: rows }));
}
