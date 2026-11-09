import type {
  ApplyThreadMaintenanceToolArgs,
  ThreadMaintenanceApplyRequest,
  ThreadMaintenanceOwnedCheckout,
  ThreadMaintenanceCoverage,
  ThreadMaintenancePlanToolResult,
  ThreadMaintenanceRun,
  ThreadMaintenanceRunToolResult,
  ThreadMaintenanceScan,
  ThreadMaintenanceScanToolResult,
} from "@pwragent/shared";

/** Idle rows returned to an agent across all projects. */
export const THREAD_MAINTENANCE_TOOL_ROW_LIMIT = 200;
/** Archived checkouts returned to an agent, per kind. */
export const THREAD_MAINTENANCE_TOOL_CHECKOUT_LIMIT = 100;
const FAILURE_LIMIT = 20;
const PROBLEM_LIMIT = 50;

function boundedCoverage(coverage: ThreadMaintenanceCoverage): ThreadMaintenanceCoverage {
  const rows = (items: NonNullable<ThreadMaintenanceCoverage["keptCheckouts"]>) => items
    .slice(0, THREAD_MAINTENANCE_TOOL_CHECKOUT_LIMIT).map((item) => ({ ...item,
      ...(item.threads ? { threads: item.threads.slice(0, THREAD_MAINTENANCE_TOOL_CHECKOUT_LIMIT) } : {}),
    }));
  return { ...coverage,
    ...(coverage.keptCheckouts ? { keptCheckouts: rows(coverage.keptCheckouts) } : {}),
    ...(coverage.largestKept ? { largestKept: rows(coverage.largestKept) } : {}),
  };
}

function coverageTruncated(coverage: ThreadMaintenanceCoverage | undefined): boolean {
  return [coverage?.keptCheckouts ?? [], coverage?.largestKept ?? []].some((rows) =>
    rows.length > THREAD_MAINTENANCE_TOOL_CHECKOUT_LIMIT
      || rows.some((row) => (row.threads?.length ?? 0) > THREAD_MAINTENANCE_TOOL_CHECKOUT_LIMIT));
}

export function summarizeThreadMaintenanceScan(
  scan: ThreadMaintenanceScan,
  run?: ThreadMaintenanceRun,
): ThreadMaintenanceScanToolResult {
  let remaining = THREAD_MAINTENANCE_TOOL_ROW_LIMIT;
  let truncated = false;
  const projects = scan.threads.projects.map((project) => {
    const idle = project.idle.slice(0, Math.max(0, remaining));
    remaining -= idle.length;
    if (idle.length < project.idle.length) truncated = true;
    return {
      key: project.key,
      label: project.label,
      idleCount: project.idle.length,
      kept: project.kept,
      idle: idle.map((row) => ({
        backend: row.backend,
        threadId: row.threadId,
        title: row.title,
        lastActivityAt: row.lastActivityAt,
        workspace: row.workspace.kind,
        ...("files" in row.workspace ? { changedFiles: row.workspace.files, changedBytes: row.workspace.bytes } : {}),
        ...(row.worktreePath ? { worktreePath: row.worktreePath } : {}),
        subThreads: row.subThreads,
        ...(row.space ? { space: row.space } : {}),
      })),
    };
  });
  const owned = scan.checkouts.items.filter((item): item is ThreadMaintenanceOwnedCheckout => item.kind !== "unreferenced");
  const removable = owned.filter((item) => item.kind === "removable");
  const gone = owned.filter((item) => item.kind === "repositoryGone");
  const unreferenced = scan.checkouts.items.filter((item) => item.kind === "unreferenced");
  return {
    scanId: scan.scanId,
    finishedAt: scan.finishedAt,
    rules: scan.rules,
    ...(scan.projectKey ? { projectKey: scan.projectKey } : {}),
    threads: {
      checked: scan.threads.checked,
      idleCount: scan.threads.projects.reduce((total, project) => total + project.idle.length, 0),
      kept: scan.threads.kept,
      ...(scan.threads.skipped ? { skipped: scan.threads.skipped } : {}),
      projects,
      truncated,
    },
    checkouts: {
      ...(scan.checkouts.buildOutputs ? {
        buildOutputs: [...new Map(scan.checkouts.buildOutputs.map((item) => [item.outputPath, item])).values()]
          .sort((a, b) => (b.space?.allocatedBytes ?? -1) - (a.space?.allocatedBytes ?? -1)).slice(0, THREAD_MAINTENANCE_TOOL_CHECKOUT_LIMIT),
        buildOutputCount: new Set(scan.checkouts.buildOutputs.map((item) => item.outputPath)).size,
        buildOutputSpace: {
          ...(!scan.checkouts.buildOutputs.length || scan.checkouts.buildOutputs.some((item) => item.space?.allocatedBytes !== undefined)
            ? { allocatedBytes: [...new Map(scan.checkouts.buildOutputs.map((item) => [item.outputPath, item.space?.allocatedBytes])).values()]
              .reduce<number>((sum, value) => sum + (value ?? 0), 0) } : {}),
          ...(scan.checkouts.buildOutputs.some((item) => item.space?.allocatedBytes === undefined || item.space.lowerBound) ? { lowerBound: true } : {}),
        },
      } : {}),
      removable: removable.slice(0, THREAD_MAINTENANCE_TOOL_CHECKOUT_LIMIT).map((item) => ({
        backend: item.backend, threadId: item.threadId, worktreePath: item.worktreePath,
        ...(item.workspace ? { workspace: item.workspace.kind } : {}),
        ...(item.space ? { space: item.space } : {}),
      })),
      repositoryGone: gone.slice(0, THREAD_MAINTENANCE_TOOL_CHECKOUT_LIMIT).map((item) => ({
        worktreePath: item.worktreePath,
        ...(item.missingRepositoryPath ? { missingRepositoryPath: item.missingRepositoryPath } : {}),
        ...(item.space ? { space: item.space } : {}),
      })),
      // Listed so an agent can tell the operator; only the dialog removes them.
      unreferenced: unreferenced.slice(0, THREAD_MAINTENANCE_TOOL_CHECKOUT_LIMIT).map((item) => ({
        worktreePath: item.worktreePath, workspace: item.workspace.kind,
        ...(item.space ? { space: item.space } : {}),
      })),
      kept: scan.checkouts.kept,
      emptyFolders: scan.checkouts.emptyFolders,
      ...(scan.checkouts.coverage ? { coverage: boundedCoverage(scan.checkouts.coverage) } : {}),
      ...(scan.checkouts.skipped ? { skipped: scan.checkouts.skipped } : {}),
      truncated: [removable, gone, unreferenced, scan.checkouts.buildOutputs ?? []].some((items) => items.length > THREAD_MAINTENANCE_TOOL_CHECKOUT_LIMIT)
        || coverageTruncated(scan.checkouts.coverage),
    },
    ...(scan.hibernate ? {
      hibernate: {
        idleDays: scan.hibernate.idleDays,
        maxSnapshotMb: scan.hibernate.maxSnapshotMb,
        checked: scan.hibernate.checked,
        items: scan.hibernate.items.slice(0, THREAD_MAINTENANCE_TOOL_CHECKOUT_LIMIT).map((item) => ({
          backend: item.backend, threadId: item.threadId, title: item.title, worktreePath: item.worktreePath,
          lastActivityAt: item.lastActivityAt, changedFiles: item.files, changedBytes: item.bytes,
          ...(item.space ? { space: item.space } : {}),
          ...(item.archiveKey ? { offeredForArchive: true } : {}),
        })),
        ...(scan.hibernate.notIdleYet !== undefined ? { notIdleYet: scan.hibernate.notIdleYet } : {}),
        ...(scan.hibernate.alreadyHibernated !== undefined ? { alreadyHibernated: scan.hibernate.alreadyHibernated } : {}),
        kept: scan.hibernate.kept,
        ...(scan.hibernate.coverage ? { coverage: boundedCoverage(scan.hibernate.coverage) } : {}),
        ...(scan.hibernate.skipped ? { skipped: scan.hibernate.skipped } : {}),
        truncated: scan.hibernate.items.length > THREAD_MAINTENANCE_TOOL_CHECKOUT_LIMIT || coverageTruncated(scan.hibernate.coverage),
      },
    } : {}),
    expired: scan.expired,
    failureCount: scan.failures.length,
    failures: scan.failures.slice(0, FAILURE_LIMIT),
    ...(run ? { run: summarizeThreadMaintenanceRun(run) } : {}),
    guidance: "Show the operator this summary before changing anything. Prefer open_thread_maintenance when they want to review it themselves. Pass this scanId to apply_thread_maintenance with the items they chose.",
  };
}

export function summarizeThreadMaintenanceRun(run: ThreadMaintenanceRun): ThreadMaintenanceRunToolResult {
  return {
    runId: run.runId,
    scanId: run.scanId,
    running: run.running,
    startedAt: run.startedAt,
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    steps: run.steps,
    problems: run.problems.slice(0, PROBLEM_LIMIT),
    ...(run.running ? { guidance: "The run continues in the background. Do not start another. Call scan_thread_maintenance later to read its result." } : {}),
  };
}

export type ThreadMaintenanceApplyPlan = {
  request: ThreadMaintenanceApplyRequest;
  summary: ThreadMaintenancePlanToolResult;
};

/** Checks every selection against the scan it names. Returns an error
 * message for the agent, or the run request and a plan summary. */
export function planThreadMaintenanceApply(
  args: ApplyThreadMaintenanceToolArgs,
  scan: ThreadMaintenanceScan,
  caller: { backend: string; threadId: string },
): { error: string } | ThreadMaintenanceApplyPlan {
  const archive = args.archive ?? [];
  const removeCheckouts = args.removeCheckouts ?? [];
  const trashCheckouts = args.trashCheckouts ?? [];
  const removeEmptyFolders = args.removeEmptyFolders === true;
  const hibernate = args.hibernate ?? [];
  const removeBuildOutputs = [...new Map((args.removeBuildOutputs ?? []).map((item) => [item?.outputPath, item])).values()];
  if (!archive.length && !removeCheckouts.length && !trashCheckouts.length && !removeEmptyFolders && !hibernate.length && !removeBuildOutputs.length) {
    return { error: "Select at least one thread or checkout from the scan." };
  }
  const idle = new Map(scan.threads.projects.flatMap((project) => project.idle)
    .map((row) => [`${row.backend}:${row.threadId}`, row]));
  const checkouts = new Map(scan.checkouts.items.map((item) => [item.worktreePath, item]));
  const buildOutputs = new Set(scan.checkouts.buildOutputs?.map((item) => item.outputPath));
  for (const item of removeBuildOutputs) {
    if (!item || typeof item.outputPath !== "string" || !buildOutputs.has(item.outputPath)) return { error: "Select Cargo build output from this scan." };
  }
  const snapshotApprovals: ThreadMaintenancePlanToolResult["snapshotApprovals"] = [];
  for (const item of archive) {
    if (!item || typeof item.backend !== "string" || typeof item.threadId !== "string") {
      return { error: "Each archive item needs backend and threadId from the scan." };
    }
    if (item.backend === caller.backend && item.threadId === caller.threadId) {
      return { error: "Do not archive the thread running this tool." };
    }
    const row = idle.get(`${item.backend}:${item.threadId}`);
    if (!row) return { error: `Thread ${item.threadId} is not an idle thread in scan ${scan.scanId}. Scan again.` };
    if (item.overLimit !== undefined && item.overLimit !== "keepCheckout" && item.overLimit !== "snapshotAll") {
      return { error: "overLimit must be keepCheckout or snapshotAll." };
    }
    if (item.overLimit && row.workspace.kind !== "overLimit") {
      return { error: `Thread ${item.threadId} is under the snapshot limit. Omit overLimit for it.` };
    }
    if (row.workspace.kind === "overLimit" && !item.overLimit) {
      return { error: `Thread ${item.threadId} has changes over the snapshot limit. Ask the operator, then pass overLimit keepCheckout or snapshotAll.` };
    }
    if (item.overLimit === "snapshotAll" && row.workspace.kind === "overLimit") {
      snapshotApprovals.push({ threadId: row.threadId, title: row.title, bytes: row.workspace.bytes });
    }
  }
  const hibernatable = new Map((scan.hibernate?.items ?? []).map((item) => [`${item.backend}:${item.threadId}`, item]));
  const archiving = new Set(archive.map((item) => `${item?.backend}:${item?.threadId}`));
  for (const item of hibernate) {
    if (!item || typeof item.backend !== "string" || typeof item.threadId !== "string") {
      return { error: "Each hibernate item needs backend and threadId from the scan." };
    }
    if (item.backend === caller.backend && item.threadId === caller.threadId) {
      return { error: "Do not hibernate the thread running this tool." };
    }
    const key = `${item.backend}:${item.threadId}`;
    const row = hibernatable.get(key);
    if (!row) return { error: `Thread ${item.threadId} has no idle checkout to hibernate in scan ${scan.scanId}. Scan again.` };
    if (row.archiveKey && archiving.has(row.archiveKey)) {
      return { error: `Thread ${item.threadId} is archived by this request. Archive it or hibernate it, not both.` };
    }
  }
  for (const item of removeCheckouts) {
    if (!item || typeof item.worktreePath !== "string" || checkouts.get(item.worktreePath)?.kind !== "removable") {
      return { error: `Checkout ${item?.worktreePath ?? "?"} is not a removable archived checkout in this scan.` };
    }
  }
  for (const item of trashCheckouts) {
    if (!item || typeof item.worktreePath !== "string" || checkouts.get(item.worktreePath)?.kind !== "repositoryGone") {
      return { error: `Checkout ${item?.worktreePath ?? "?"} is not a checkout whose repository is gone in this scan.` };
    }
  }
  return {
    request: {
      scanId: scan.scanId,
      archive: archive.map((item) => ({ backend: item.backend, threadId: item.threadId,
        ...(item.overLimit ? { overLimit: item.overLimit } : {}) })),
      removeCheckouts: removeCheckouts.map((item) => {
        const checkout = checkouts.get(item.worktreePath) as ThreadMaintenanceOwnedCheckout;
        return { backend: checkout.backend, threadId: checkout.threadId, worktreePath: checkout.worktreePath };
      }),
      trashCheckouts: trashCheckouts.map((item) => ({ worktreePath: item.worktreePath })),
      removeEmptyFolders,
      ...(removeBuildOutputs.length ? { removeBuildOutputs: removeBuildOutputs.map((item) => ({ outputPath: item.outputPath })) } : {}),
      ...(hibernate.length ? { hibernate: hibernate.map((item) => ({ backend: item.backend, threadId: item.threadId })) } : {}),
    },
    summary: {
      scanId: scan.scanId,
      archive: archive.length,
      removeCheckouts: removeCheckouts.length,
      trashCheckouts: trashCheckouts.length,
      ...(removeBuildOutputs.length ? { removeBuildOutputs: removeBuildOutputs.length } : {}),
      removeEmptyFolders,
      hibernate: hibernate.length,
      snapshotApprovals,
    },
  };
}

/** One sentence for the operator's confirmation card, naming every change. */
export function threadMaintenanceConfirmationQuestion(plan: ThreadMaintenancePlanToolResult): string {
  const parts = [
    plan.archive ? `archive ${plan.archive} ${plan.archive === 1 ? "thread" : "threads"}` : "",
    plan.hibernate ? `hibernate ${plan.hibernate} idle ${plan.hibernate === 1 ? "checkout" : "checkouts"}` : "",
    plan.removeCheckouts ? `remove ${plan.removeCheckouts} archived ${plan.removeCheckouts === 1 ? "checkout" : "checkouts"}` : "",
    plan.trashCheckouts ? `move ${plan.trashCheckouts} orphaned ${plan.trashCheckouts === 1 ? "checkout" : "checkouts"} to the Trash` : "",
    plan.removeBuildOutputs ? `clean ${plan.removeBuildOutputs} Cargo build ${plan.removeBuildOutputs === 1 ? "profile" : "profiles"}` : "",
    plan.removeEmptyFolders ? "remove empty worktree folders" : "",
  ].filter(Boolean);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "";
  const snapshots = plan.snapshotApprovals.slice(0, 5).map((item) => `${item.title} (${formatBytes(item.bytes)})`);
  const more = plan.snapshotApprovals.length > snapshots.length ? ` and ${plan.snapshotApprovals.length - snapshots.length} more` : "";
  return `An agent asks to ${list}.`
    + (plan.archive || plan.hibernate || plan.removeCheckouts || plan.trashCheckouts ? " Uncommitted changes are saved to recovery snapshots first." : "")
    + (plan.hibernate ? " A hibernated checkout comes back when its thread gets a message." : "")
    + (plan.removeBuildOutputs ? " Only compiled Cargo output is deleted; source files and threads stay. The next build compiles that output again." : "")
    + (snapshots.length ? ` It also asks to snapshot changes over the 100 MB limit for ${snapshots.join(", ")}${more}.` : "")
    + " Allow it?";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
