import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildThreadIdentityKey,
  type AppServerBackendKind,
  defaultThreadMaintenanceRules,
  type DesktopThreadArchivePolicy,
  type ThreadMaintenanceApplyRequest,
  type ThreadMaintenanceArchivedCheckout,
  type ThreadMaintenanceFailure,
  type ThreadMaintenanceIdleThread,
  type ThreadMaintenanceProblem,
  type ThreadMaintenanceProject,
  type ThreadMaintenanceRules,
  type ThreadMaintenanceRun,
  type ThreadMaintenanceScan,
  type ThreadMaintenanceStep,
  type ThreadMaintenanceStepResult,
  type ThreadMaintenanceWorkspace,
} from "@pwragent/shared";
import {
  archiveCandidateKeepReason,
  archiveCandidateLastActivity,
  archiveFamilies,
  type ThreadArchiveCandidate,
} from "./thread-archive-sweeper";
import { inspectMaintenanceWorkspace, type MaintenanceWorkspaceInspection } from "./thread-maintenance-workspace";
import { missingWorktreeRepository } from "./worktree-archive-service";

/** Failures kept on a scan or run; the rest are counted, not listed. */
const FAILURE_LIMIT = 50;
/** Git inspections in flight at once during a scan. */
const INSPECT_CONCURRENCY = 6;
/** Scans kept for a later apply. A newer scan replaces the oldest. */
const RETAINED_SCANS = 4;

export type ArchivedCheckoutAudit = {
  candidates: { backend: string; threadId: string; worktreePath: string }[];
  kept: Record<string, number>;
  emptyFolders: number;
};

export type ArchivedCheckoutRemoval = {
  removed: { worktreePath: string }[];
  kept: { worktreePath: string; reason: string }[];
  failed: { worktreePath: string; message: string }[];
  emptyFoldersRemoved: number;
  emptyFoldersFailed: { worktreePath: string; message: string }[];
};

export type ThreadMaintenanceDeps = {
  getPolicy: () => DesktopThreadArchivePolicy;
  snapshotLimitBytes: number;
  listCandidates: () => Promise<ThreadArchiveCandidate[]>;
  resolveProject: (candidate: ThreadArchiveCandidate) => Promise<string | undefined>;
  refreshCandidate: (candidate: ThreadArchiveCandidate) => Promise<ThreadArchiveCandidate>;
  isBusy: (candidate: ThreadArchiveCandidate) => boolean;
  /** Read-only discovery of archived threads' checkouts still on disk. */
  auditArchivedCheckouts: () => Promise<ArchivedCheckoutAudit>;
  /** Archive one reviewed family as an operator archive. Resolves false when cancelled. */
  archiveFamily: (family: ThreadArchiveCandidate[], options: {
    preserveWorktrees: boolean;
    /** A one-run approval to snapshot past the normal limit. */
    snapshotLimitBytes?: number;
  }) => Promise<boolean>;
  /** Remove only the listed archived checkouts, plus empty folders when asked. */
  removeArchivedCheckouts: (selection: { worktreePaths: string[]; emptyFolders: boolean }) => Promise<ArchivedCheckoutRemoval>;
  /** True only inside a worktree root that PwrAgent or Codex manages. */
  isManagedCheckoutPath: (worktreePath: string) => boolean;
  trashItem: (absolutePath: string) => Promise<void>;
  inspectWorkspace?: typeof inspectMaintenanceWorkspace;
  now?: () => number;
  newId?: () => string;
  onRun?: (run: ThreadMaintenanceRun) => void;
  onError?: (error: unknown, context: Record<string, unknown>) => void;
};

type RetainedScan = {
  scan: ThreadMaintenanceScan;
  families: Map<string, { family: ThreadArchiveCandidate[]; row: ThreadMaintenanceIdleThread }>;
  checkouts: Map<string, ThreadMaintenanceArchivedCheckout>;
};

/**
 * The reviewed counterpart of the hourly sweep, used by the Thread maintenance
 * dialog and the agent tool. A scan reads state and changes nothing. An apply
 * acts only on items from one retained scan, re-checks each item first, and
 * never lets one item's failure stop the others or the next step.
 */
export class ThreadMaintenanceService {
  private readonly scans = new Map<string, RetainedScan>();
  private run?: ThreadMaintenanceRun;
  private running?: Promise<ThreadMaintenanceRun>;
  private readonly abort = new AbortController();

  constructor(private readonly deps: ThreadMaintenanceDeps) {}

  getRun(): ThreadMaintenanceRun | undefined {
    return this.run;
  }

  getScan(scanId: string): ThreadMaintenanceScan | undefined {
    return this.scans.get(scanId)?.scan;
  }

  stop(): void {
    if (this.run?.running) this.publish({ ...this.run, stopRequested: true });
  }

  dispose(): void {
    this.abort.abort();
  }

  async scan(request: { rules?: Partial<ThreadMaintenanceRules>; projectKey?: string } = {}): Promise<ThreadMaintenanceScan> {
    const now = this.now();
    const policy = this.deps.getPolicy();
    const rules = normalizeRules({ ...defaultThreadMaintenanceRules(policy), ...request.rules });
    const failures: ThreadMaintenanceFailure[] = [];
    const fail = (step: ThreadMaintenanceStep, error: unknown, details: { path?: string; threadId?: string } = {}) => {
      this.deps.onError?.(error, { step, ...details });
      if (failures.length < FAILURE_LIMIT) failures.push({ step, message: errorMessage(error), ...details });
    };
    const retained: RetainedScan = {
      scan: undefined as unknown as ThreadMaintenanceScan,
      families: new Map(),
      checkouts: new Map(),
    };
    const threads = await this.scanThreads(rules, policy, now, request.projectKey, retained, fail);
    const checkouts = await this.scanCheckouts(rules, request.projectKey, retained, fail);
    const scan: ThreadMaintenanceScan = {
      scanId: this.newId(),
      startedAt: now,
      finishedAt: this.now(),
      rules,
      ...(request.projectKey ? { projectKey: request.projectKey } : {}),
      spaceSource: "none",
      threads,
      checkouts,
      expired: { enabled: policy.retentionDays > 0, retentionDays: policy.retentionDays },
      failures,
    };
    retained.scan = scan;
    this.scans.set(scan.scanId, retained);
    while (this.scans.size > RETAINED_SCANS) this.scans.delete(this.scans.keys().next().value!);
    return scan;
  }

  /** Starts a run, or throws when one is running or the scan is gone.
   * Progress goes to onRun; `done` resolves with the finished run. */
  start(request: ThreadMaintenanceApplyRequest): { run: ThreadMaintenanceRun; done: Promise<ThreadMaintenanceRun> } {
    if (this.running) throw new Error("Thread maintenance is already running.");
    const retained = this.scans.get(request.scanId);
    if (!retained) throw new Error("That scan is no longer available. Scan again.");
    const run: ThreadMaintenanceRun = {
      runId: this.newId(), scanId: request.scanId, running: true, startedAt: this.now(),
      steps: [], problems: [],
    };
    this.publish(run);
    const done = this.execute(request, retained).finally(() => { this.running = undefined; });
    this.running = done;
    return { run, done };
  }

  async apply(request: ThreadMaintenanceApplyRequest): Promise<ThreadMaintenanceRun> {
    return await this.start(request).done;
  }

  private async scanThreads(
    rules: ThreadMaintenanceRules,
    policy: DesktopThreadArchivePolicy,
    now: number,
    projectFilter: string | undefined,
    retained: RetainedScan,
    fail: (step: ThreadMaintenanceStep, error: unknown, details?: { path?: string; threadId?: string }) => void,
  ): Promise<ThreadMaintenanceScan["threads"]> {
    const result: ThreadMaintenanceScan["threads"] = { checked: 0, projects: [], kept: {} };
    let candidates: ThreadArchiveCandidate[];
    try { candidates = await this.deps.listCandidates(); }
    catch (error) {
      fail("threads", error);
      return { ...result, skipped: "Threads could not be listed" };
    }
    // The dialog is an explicit request, so it runs whether or not the hourly
    // sweep is on. Everything else about the keep rules is the same.
    const reviewPolicy: DesktopThreadArchivePolicy = { ...policy, enabled: true,
      mode: rules.mode, keepPerProject: rules.keepPerProject, inactivityDays: rules.inactivityDays };
    const groupFor = archiveFamilies(candidates);
    const projects = new Map<string, ThreadMaintenanceProject>();
    const projectFor = (key: string): ThreadMaintenanceProject => {
      let project = projects.get(key);
      if (!project) {
        project = { key, label: path.basename(key) || key, path: key, idle: [], kept: {} };
        projects.set(key, project);
      }
      return project;
    };
    const keep = (project: ThreadMaintenanceProject | undefined, reason: string) => {
      result.kept[reason] = (result.kept[reason] ?? 0) + 1;
      if (project) project.kept[reason] = (project.kept[reason] ?? 0) + 1;
    };
    const roots = candidates.filter((candidate) => !candidate.thread.codexNativeSubAgent);
    type Evaluated = { root: ThreadArchiveCandidate; family: ThreadArchiveCandidate[]; project?: string;
      reason?: string; workspace?: ThreadMaintenanceWorkspace; worktreePath?: string };
    const evaluated = await mapLimit(roots, INSPECT_CONCURRENCY, async (root): Promise<Evaluated | undefined> => {
      if (this.abort.signal.aborted) return undefined;
      const family = groupFor(root);
      let project: string | undefined;
      try {
        project = await this.deps.resolveProject(root) ?? undefined;
      } catch (error) {
        fail("threads", error, { threadId: root.thread.id });
        return undefined;
      }
      if (projectFilter && (!project || path.resolve(project) !== path.resolve(projectFilter))) return undefined;
      const listed = familyKeepReason(family, now, reviewPolicy, this.deps.isBusy);
      if (listed) return { root, family, project, reason: listed };
      try {
        const inspection = await this.inspectFamily(family, rules);
        if (inspection.keep !== undefined) return { root, family, project, reason: inspection.keep };
        return { root, family, project, workspace: inspection.workspace, worktreePath: inspection.worktreePath };
      } catch (error) {
        fail("threads", error, { threadId: root.thread.id });
        return undefined;
      }
    });
    const eligible = new Map<string, Evaluated[]>();
    for (const item of evaluated) {
      if (!item) continue;
      result.checked += 1;
      if (!item.project) {
        keep(undefined, "Project unknown");
        continue;
      }
      const project = projectFor(item.project);
      if (item.reason) keep(project, item.reason);
      else eligible.set(item.project, [...eligible.get(item.project) ?? [], item]);
    }
    for (const [key, group] of eligible) {
      const project = projectFor(key);
      group.sort((a, b) => archiveCandidateLastActivity(b.root) - archiveCandidateLastActivity(a.root)
        || a.root.thread.id.localeCompare(b.root.thread.id));
      const idle = rules.mode === "count" ? group.slice(rules.keepPerProject) : group;
      if (rules.mode === "count") {
        for (let index = 0; index < Math.min(group.length, rules.keepPerProject); index++) keep(project, "Within the per-project limit");
      }
      for (const item of idle) {
        const directory = item.root.thread.linkedDirectories[0];
        const row: ThreadMaintenanceIdleThread = {
          backend: item.root.thread.source,
          threadId: item.root.thread.id,
          title: item.root.thread.title,
          ...(directory?.gitBranch ? { branch: directory.gitBranch } : {}),
          ...(item.worktreePath ? { worktreePath: item.worktreePath } : {}),
          lastActivityAt: archiveCandidateLastActivity(item.root),
          subThreads: item.family.length - 1,
          workspace: item.workspace!,
        };
        project.idle.push(row);
        retained.families.set(buildThreadIdentityKey(row.backend as AppServerBackendKind, row.threadId), { family: item.family, row });
      }
    }
    result.projects = [...projects.values()]
      .filter((project) => project.idle.length || Object.keys(project.kept).length)
      .sort((a, b) => b.idle.length - a.idle.length || a.label.localeCompare(b.label));
    for (const project of result.projects) project.idle.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    return result;
  }

  /** The family's combined workspace state: any keep reason wins, then the
   * largest change, so a family is only as safe as its riskiest checkout. */
  private async inspectFamily(
    family: ThreadArchiveCandidate[],
    rules: ThreadMaintenanceRules,
  ): Promise<{ keep: string } | { keep?: undefined; workspace: ThreadMaintenanceWorkspace; worktreePath?: string }> {
    const paths = [...new Set(family.flatMap(({ thread, overlay }) =>
      [...thread.linkedDirectories, ...overlay?.extraLinkedDirectories ?? []]
        .map((directory) => directory.worktreePath ?? directory.path)))];
    if (paths.some((cwd) => !cwd.trim())) return { keep: "Workspace unknown" };
    if (!paths.length) return { workspace: { kind: "notGit" } };
    const inspect = this.deps.inspectWorkspace ?? inspectMaintenanceWorkspace;
    let worst: { workspace: ThreadMaintenanceWorkspace; worktreePath: string } | undefined;
    for (const cwd of paths) {
      const inspection: MaintenanceWorkspaceInspection = await inspect(cwd, {
        signal: this.abort.signal, limitBytes: this.deps.snapshotLimitBytes,
        rebuildableOutputIsClean: rules.rebuildableOutputIsClean,
      });
      if (inspection.keep !== undefined) return { keep: inspection.keep };
      if (!worst || workspaceRank(inspection.workspace) > workspaceRank(worst.workspace)) {
        worst = { workspace: inspection.workspace, worktreePath: cwd };
      }
    }
    return { workspace: worst!.workspace, worktreePath: worst!.worktreePath };
  }

  private async scanCheckouts(
    rules: ThreadMaintenanceRules,
    projectFilter: string | undefined,
    retained: RetainedScan,
    fail: (step: ThreadMaintenanceStep, error: unknown, details?: { path?: string; threadId?: string }) => void,
  ): Promise<ThreadMaintenanceScan["checkouts"]> {
    let audit: ArchivedCheckoutAudit;
    try { audit = await this.deps.auditArchivedCheckouts(); }
    catch (error) {
      fail("checkouts", error);
      return { items: [], kept: {}, emptyFolders: 0, skipped: "Archived checkouts could not be read" };
    }
    const inspect = this.deps.inspectWorkspace ?? inspectMaintenanceWorkspace;
    const kept = { ...audit.kept };
    const items = await mapLimit(audit.candidates, INSPECT_CONCURRENCY, async (candidate): Promise<ThreadMaintenanceArchivedCheckout | undefined> => {
      if (this.abort.signal.aborted) return undefined;
      if (projectFilter && await checkoutProjectPath(candidate.worktreePath) !== path.resolve(projectFilter)) return undefined;
      try {
        const missingRepository = await missingWorktreeRepository(candidate.worktreePath);
        if (missingRepository) {
          return { ...candidate, kind: "repositoryGone" as const, missingRepositoryPath: missingRepository };
        }
        const inspection = await inspect(candidate.worktreePath, {
          signal: this.abort.signal, limitBytes: this.deps.snapshotLimitBytes,
          rebuildableOutputIsClean: rules.rebuildableOutputIsClean,
        });
        if (inspection.keep !== undefined) {
          kept[inspection.keep] = (kept[inspection.keep] ?? 0) + 1;
          return undefined;
        }
        if (inspection.workspace.kind === "overLimit") {
          kept["Changes over the snapshot limit"] = (kept["Changes over the snapshot limit"] ?? 0) + 1;
          return undefined;
        }
        return { ...candidate, kind: "removable" as const, workspace: inspection.workspace };
      } catch (error) {
        fail("checkouts", error, { path: candidate.worktreePath, threadId: candidate.threadId });
        return undefined;
      }
    });
    const result = items.filter((item): item is ThreadMaintenanceArchivedCheckout => item !== undefined);
    for (const item of result) retained.checkouts.set(item.worktreePath, item);
    return { items: result, kept, emptyFolders: audit.emptyFolders };
  }

  private async execute(request: ThreadMaintenanceApplyRequest, retained: RetainedScan): Promise<ThreadMaintenanceRun> {
    const problems: ThreadMaintenanceProblem[] = [];
    const steps: ThreadMaintenanceStepResult[] = [];
    const update = (patch: Partial<ThreadMaintenanceRun>) => this.publish({ ...this.run!, ...patch, steps: [...steps], problems: [...problems] });
    const addProblem = (problem: ThreadMaintenanceProblem) => {
      if (problems.length < FAILURE_LIMIT) problems.push(problem);
    };
    const stopped = () => this.run?.stopRequested === true || this.abort.signal.aborted;

    // Step 1: archive idle threads.
    const threadStep: ThreadMaintenanceStepResult = { step: "threads", ran: request.archive.length > 0, done: 0, kept: 0, failed: 0 };
    steps.push(threadStep);
    for (const [index, item] of request.archive.entries()) {
      const entry = retained.families.get(buildThreadIdentityKey(item.backend as AppServerBackendKind, item.threadId));
      const object = entry ? entry.row.title : item.threadId;
      update({ current: { step: "threads", processed: index, total: request.archive.length, object } });
      if (!entry) {
        threadStep.failed += 1;
        addProblem({ step: "threads", kind: "failed", object, reason: "Not in this scan", backend: item.backend, threadId: item.threadId });
        continue;
      }
      if (stopped()) {
        threadStep.kept += 1;
        addProblem({ step: "threads", kind: "kept", object, reason: "Stopped before archiving", backend: item.backend, threadId: item.threadId });
        continue;
      }
      try {
        const outcome = await this.archiveReviewed(entry, item.overLimit, retained.scan.rules);
        if (outcome === true) threadStep.done += 1;
        else {
          threadStep.kept += 1;
          addProblem({ step: "threads", kind: "kept", object, reason: outcome, backend: item.backend, threadId: item.threadId });
        }
      } catch (error) {
        threadStep.failed += 1;
        this.deps.onError?.(error, { step: "threads", threadId: item.threadId });
        addProblem({ step: "threads", kind: "failed", object, reason: "Archive failed", detail: errorMessage(error),
          backend: item.backend, threadId: item.threadId });
      }
    }

    // Step 2: archived checkouts. One failure never skips the rest.
    const checkoutStep: ThreadMaintenanceStepResult = { step: "checkouts",
      ran: request.removeCheckouts.length > 0 || request.trashCheckouts.length > 0 || request.removeEmptyFolders,
      done: 0, kept: 0, failed: 0 };
    steps.push(checkoutStep);
    const removable = request.removeCheckouts.filter((item) => retained.checkouts.get(item.worktreePath)?.kind === "removable");
    for (const item of request.removeCheckouts) {
      if (retained.checkouts.get(item.worktreePath)?.kind !== "removable") {
        checkoutStep.failed += 1;
        addProblem({ step: "checkouts", kind: "failed", object: item.worktreePath, reason: "Not in this scan", path: item.worktreePath });
      }
    }
    const keepStopped = (worktreePath: string) => {
      checkoutStep.kept += 1;
      addProblem({ step: "checkouts", kind: "kept", object: worktreePath, reason: "Stopped before removing", path: worktreePath });
    };
    if ((removable.length || request.removeEmptyFolders) && stopped()) {
      for (const item of removable) keepStopped(item.worktreePath);
    } else if (removable.length || request.removeEmptyFolders) {
      update({ current: { step: "checkouts", processed: 0, total: removable.length, object: removable[0]?.worktreePath } });
      try {
        const removal = await this.deps.removeArchivedCheckouts({
          worktreePaths: removable.map((item) => item.worktreePath), emptyFolders: request.removeEmptyFolders,
        });
        checkoutStep.done += removal.removed.length + removal.emptyFoldersRemoved;
        for (const item of removal.kept) {
          checkoutStep.kept += 1;
          addProblem({ step: "checkouts", kind: "kept", object: item.worktreePath, reason: item.reason, path: item.worktreePath });
        }
        for (const item of [...removal.failed, ...removal.emptyFoldersFailed]) {
          checkoutStep.failed += 1;
          addProblem({ step: "checkouts", kind: "failed", object: item.worktreePath, reason: "Removal failed",
            detail: item.message, path: item.worktreePath });
        }
      } catch (error) {
        checkoutStep.failed += removable.length;
        this.deps.onError?.(error, { step: "checkouts" });
        addProblem({ step: "checkouts", kind: "failed", object: `${removable.length} checkouts`, reason: "Removal failed",
          detail: errorMessage(error) });
      }
    }
    for (const item of request.trashCheckouts) {
      const checkout = retained.checkouts.get(item.worktreePath);
      if (stopped()) {
        keepStopped(item.worktreePath);
        continue;
      }
      try {
        // Re-check at the moment of the move: only a managed checkout whose
        // repository is still missing is ever moved to the Trash.
        if (checkout?.kind !== "repositoryGone" || !this.deps.isManagedCheckoutPath(item.worktreePath)
          || !await missingWorktreeRepository(item.worktreePath)) {
          checkoutStep.kept += 1;
          addProblem({ step: "checkouts", kind: "kept", object: item.worktreePath, reason: "No longer safe to move",
            detail: "Its repository is back, or it is outside a managed worktree folder.", path: item.worktreePath });
          continue;
        }
        await this.deps.trashItem(item.worktreePath);
        checkoutStep.done += 1;
      } catch (error) {
        checkoutStep.failed += 1;
        this.deps.onError?.(error, { step: "checkouts", path: item.worktreePath });
        addProblem({ step: "checkouts", kind: "failed", object: item.worktreePath, reason: "Move to Trash failed",
          detail: errorMessage(error), path: item.worktreePath });
      }
    }
    // Repository-gone checkouts the operator left unselected are kept on
    // purpose. A run that skipped this step reports nothing about them.
    for (const checkout of checkoutStep.ran ? retained.checkouts.values() : []) {
      if (checkout.kind === "repositoryGone" && !request.trashCheckouts.some((item) => item.worktreePath === checkout.worktreePath)) {
        addProblem({ step: "checkouts", kind: "kept", object: checkout.worktreePath, reason: "Repository no longer exists",
          detail: checkout.missingRepositoryPath, path: checkout.worktreePath });
      }
    }

    // Step 3: expired archives are deleted by the hourly sweep under the
    // Settings retention period; the reviewed run reports, never deletes.
    steps.push({ step: "expired", ran: false, done: 0, kept: 0, failed: 0 });
    const finished = { ...this.run!, running: false, finishedAt: this.now(), current: undefined,
      steps: [...steps], problems: [...problems] };
    this.publish(finished);
    return finished;
  }

  /** True when archived, else the reason it was kept. Throws on failure. */
  private async archiveReviewed(
    entry: { family: ThreadArchiveCandidate[]; row: ThreadMaintenanceIdleThread },
    overLimit: ThreadMaintenanceApplyRequest["archive"][number]["overLimit"],
    rules: ThreadMaintenanceRules,
  ): Promise<true | string> {
    const refreshed = await Promise.all(entry.family.map((item) => this.deps.refreshCandidate(item)));
    if (archiveCandidateLastActivity(refreshed[0]!) > entry.row.lastActivityAt) return "New activity during the run";
    const policy = { ...this.deps.getPolicy(), enabled: true, mode: "age" as const, inactivityDays: 0 };
    const reason = familyKeepReason(refreshed, this.now(), policy, this.deps.isBusy);
    if (reason) return reason;
    const inspection = await this.inspectFamily(refreshed, rules);
    if (inspection.keep !== undefined) return inspection.keep;
    const workspace = inspection.workspace;
    if (workspace.kind === "overLimit") {
      if (!overLimit) return "Changes are over the snapshot limit";
      if (entry.row.workspace.kind !== "overLimit" || workspace.bytes > entry.row.workspace.bytes * 1.1) {
        return "Changes grew after the review";
      }
    }
    const archived = await this.deps.archiveFamily(refreshed, {
      preserveWorktrees: workspace.kind === "overLimit" && overLimit === "keepCheckout",
      ...(workspace.kind === "overLimit" && overLimit === "snapshotAll"
        ? { snapshotLimitBytes: Math.ceil(workspace.bytes * 11 / 10) } : {}),
    });
    return archived ? true : "Archive cancelled";
  }

  private publish(run: ThreadMaintenanceRun): void {
    this.run = run;
    this.deps.onRun?.(run);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private newId(): string {
    return this.deps.newId?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function familyKeepReason(
  family: ThreadArchiveCandidate[],
  now: number,
  policy: DesktopThreadArchivePolicy,
  isBusy: (candidate: ThreadArchiveCandidate) => boolean,
): string | undefined {
  for (const item of family) {
    const reason = archiveCandidateKeepReason(item, now, policy);
    if (reason) return reason;
  }
  return family.some(isBusy) ? "Busy" : undefined;
}

function workspaceRank(workspace: ThreadMaintenanceWorkspace): number {
  switch (workspace.kind) {
    case "overLimit": return 4;
    case "changes": return 3;
    case "clean": return 2;
    case "notGit":
    case "inPlace": return 1;
    case "missing": return 0;
  }
}

function normalizeRules(rules: ThreadMaintenanceRules): ThreadMaintenanceRules {
  return {
    mode: rules.mode === "age" ? "age" : "count",
    keepPerProject: clampInteger(rules.keepPerProject, 0, 10_000),
    inactivityDays: clampInteger(rules.inactivityDays, 0, 3650),
    rebuildableOutputIsClean: rules.rebuildableOutputIsClean !== false,
  };
}

function clampInteger(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;
}

/** The primary checkout a linked worktree belongs to, read from its `.git`
 * pointer (`<checkout>/.git/worktrees/<name>`). It works when the repository is
 * gone too. Undefined when the folder is not a linked worktree. */
async function checkoutProjectPath(worktreePath: string): Promise<string | undefined> {
  let pointer: string;
  try {
    pointer = await readFile(path.join(worktreePath, ".git"), "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return undefined;
  const gitDirectory = path.resolve(worktreePath, match[1]!.trim());
  if (path.basename(path.dirname(gitDirectory)) !== "worktrees") return undefined;
  const commonDirectory = path.dirname(path.dirname(gitDirectory));
  return path.basename(commonDirectory) === ".git" ? path.dirname(commonDirectory) : commonDirectory;
}

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
