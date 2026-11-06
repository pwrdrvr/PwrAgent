import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildThreadIdentityKey,
  type AppServerBackendKind,
  defaultThreadMaintenanceRules,
  type DesktopCheckoutHibernationPolicy,
  type DesktopThreadArchivePolicy,
  type ThreadMaintenanceApplyRequest,
  type ThreadMaintenanceArchivedCheckout,
  type ThreadMaintenanceFailure,
  type ThreadMaintenanceHibernateCheckout,
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
  keepSubthreadParents,
  MAX_SUBTHREADS_LEFT_BY_ARCHIVE,
  SUBTHREAD_PARENT_KEEP_REASON,
  subthreadChildren,
  subthreadsFirst,
  type ThreadArchiveCandidate,
} from "./thread-archive-sweeper";
import { inspectMaintenanceWorkspace, type MaintenanceWorkspaceInspection } from "./thread-maintenance-workspace";
import { inspectHibernationWorkspace, type HibernationWorkspaceInspection } from "./checkout-hibernation-workspace";
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
  /** PwrAgent worktrees no thread refers to. */
  unreferenced?: string[];
  unreferencedUnavailable?: string;
  unreferencedTruncated?: boolean;
};

export type UnreferencedCheckoutRemoval = {
  removed: { worktreePath: string }[];
  kept: { worktreePath: string; reason: string }[];
  failed: { worktreePath: string; message: string }[];
};

/** Keep reasons for a checkout no thread refers to start with this, so the
 * review tells them from archived threads' checkouts. */
export const UNREFERENCED_KEEP_PREFIX = "No thread · ";

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
  /** Snapshot and remove reviewed checkouts no thread refers to. Re-checks
   * each against every thread first. */
  removeUnreferencedCheckouts?: (worktreePaths: string[]) => Promise<UnreferencedCheckoutRemoval>;
  /** True only inside a worktree root that PwrAgent or Codex manages. */
  isManagedCheckoutPath: (worktreePath: string) => boolean;
  trashItem: (absolutePath: string) => Promise<void>;
  inspectWorkspace?: typeof inspectMaintenanceWorkspace;
  /** Idle checkout hibernation, reviewed. Absent: the step finds nothing. */
  hibernation?: CheckoutHibernationReviewDeps;
  now?: () => number;
  newId?: () => string;
  onRun?: (run: ThreadMaintenanceRun) => void;
  onError?: (error: unknown, context: Record<string, unknown>) => void;
};

/** The same rules and probe as the hourly hibernation sweep. */
export type CheckoutHibernationReviewDeps = {
  getPolicy: () => DesktopCheckoutHibernationPolicy;
  /** The candidate's checkout, and why the rules keep it, from thread state.
   * No target: the thread has no checkout hibernation could remove. */
  keepReason: (candidate: ThreadArchiveCandidate, candidates: readonly ThreadArchiveCandidate[],
    policy: DesktopCheckoutHibernationPolicy, now: number) => { target?: string; keep?: string };
  inspect: (worktreePath: string, policy: DesktopCheckoutHibernationPolicy, signal: AbortSignal) => Promise<HibernationWorkspaceInspection>;
  /** Re-checks everything, then hibernates. True when hibernated, false when
   * cancelled, or the reason it was kept. */
  hibernate: (candidate: ThreadArchiveCandidate, policy: DesktopCheckoutHibernationPolicy) => Promise<boolean | string>;
};

/** The registry hooks the hibernate step uses. */
export type CheckoutHibernationReviewHost = {
  getCheckoutHibernationPolicy: () => DesktopCheckoutHibernationPolicy;
  checkoutHibernationKeepReason: CheckoutHibernationReviewDeps["keepReason"];
  hibernateReviewedCheckout: CheckoutHibernationReviewDeps["hibernate"];
};

/** The hibernate step's deps: the registry's rules, then the sweep's own
 * Git probe at hibernation's snapshot limit. */
export function checkoutHibernationReviewDeps(host: () => CheckoutHibernationReviewHost): CheckoutHibernationReviewDeps {
  return {
    getPolicy: () => host().getCheckoutHibernationPolicy(),
    keepReason: (candidate, candidates, policy, now) => host().checkoutHibernationKeepReason(candidate, candidates, policy, now),
    inspect: async (worktreePath, policy, signal) => await inspectHibernationWorkspace(worktreePath, {
      signal, limitBytes: policy.maxSnapshotMb * 1024 * 1024, removeRebuildableOutput: policy.removeRebuildableOutput,
    }),
    hibernate: async (candidate, policy) => await host().hibernateReviewedCheckout(candidate, policy),
  };
}

type RetainedScan = {
  scan: ThreadMaintenanceScan;
  /** Every thread the scan read, for the hibernation step. */
  candidates?: ThreadArchiveCandidate[];
  hibernate: Map<string, { candidate: ThreadArchiveCandidate; row: ThreadMaintenanceHibernateCheckout }>;
  /** Direct, non-archived sub-threads per parent key, at scan time. */
  subthreads: Map<string, string[]>;
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
  private revision = 0;
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
      subthreads: new Map(),
      hibernate: new Map(),
    };
    const threads = await this.scanThreads(rules, policy, now, request.projectKey, retained, fail);
    // After archive: a thread offered for archive is never also offered here.
    const hibernate = await this.scanHibernation(now, request.projectKey, retained, fail);
    const checkouts = await this.scanCheckouts(rules, request.projectKey, retained, fail);
    const scan: ThreadMaintenanceScan = {
      scanId: this.newId(),
      startedAt: now,
      finishedAt: this.now(),
      rules,
      ...(request.projectKey ? { projectKey: request.projectKey } : {}),
      spaceSource: "none",
      threads,
      ...(hibernate ? { hibernate } : {}),
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
    const run = this.publish({
      runId: this.newId(), revision: 0, scanId: request.scanId, running: true, startedAt: this.now(),
      steps: [], problems: [],
    });
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
    retained.candidates = candidates;
    // The dialog is an explicit request, so it runs whether or not the hourly
    // sweep is on. Everything else about the keep rules is the same.
    const reviewPolicy: DesktopThreadArchivePolicy = { ...policy, enabled: true,
      mode: rules.mode, keepPerProject: rules.keepPerProject, inactivityDays: rules.inactivityDays };
    const groupFor = archiveFamilies(candidates);
    retained.subthreads = subthreadChildren(candidates);
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
    // A parent stays when archiving it would scatter 3 or more sub-threads.
    // Its idle children are still offered; archiving them keeps their place.
    const idleKeys = new Set(retained.families.keys());
    for (const key of keepSubthreadParents(idleKeys, retained.subthreads)) {
      const entry = retained.families.get(key)!;
      retained.families.delete(key);
      for (const project of projects.values()) {
        const index = project.idle.indexOf(entry.row);
        if (index < 0) continue;
        project.idle.splice(index, 1);
        keep(project, SUBTHREAD_PARENT_KEEP_REASON);
      }
    }
    result.projects = [...projects.values()]
      .filter((project) => project.idle.length || Object.keys(project.kept).length)
      .sort((a, b) => b.idle.length - a.idle.length || a.label.localeCompare(b.label));
    for (const project of result.projects) project.idle.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    return result;
  }

  /** Idle threads whose checkout can hibernate. The review is an explicit
   * request, so it runs whether or not the hourly sweep does; every other
   * rule is the sweep's own. */
  private async scanHibernation(
    now: number,
    projectFilter: string | undefined,
    retained: RetainedScan,
    fail: (step: ThreadMaintenanceStep, error: unknown, details?: { path?: string; threadId?: string }) => void,
  ): Promise<ThreadMaintenanceScan["hibernate"]> {
    const deps = this.deps.hibernation;
    if (!deps) return undefined;
    let settings: DesktopCheckoutHibernationPolicy;
    try { settings = deps.getPolicy(); }
    catch (error) {
      fail("hibernate", error);
      return undefined;
    }
    const policy = { ...settings, enabled: true };
    const result: NonNullable<ThreadMaintenanceScan["hibernate"]> = {
      idleDays: policy.idleDays, maxSnapshotMb: policy.maxSnapshotMb, removeRebuildableOutput: policy.removeRebuildableOutput,
      checked: 0, items: [], kept: {},
    };
    const candidates = retained.candidates;
    if (!candidates) return { ...result, skipped: "Threads could not be listed" };
    const keep = (reason: string) => { result.kept[reason] = (result.kept[reason] ?? 0) + 1; };
    const roots = candidates.filter((candidate) => !candidate.thread.codexNativeSubAgent
      && !retained.families.has(buildThreadIdentityKey(candidate.thread.source, candidate.thread.id)));
    const evaluated = await mapLimit(roots, INSPECT_CONCURRENCY, async (candidate) => {
      if (this.abort.signal.aborted) return undefined;
      try {
        if (projectFilter) {
          const project = await this.deps.resolveProject(candidate);
          if (!project || path.resolve(project) !== path.resolve(projectFilter)) return undefined;
        }
        const listed = deps.keepReason(candidate, candidates, policy, now);
        if (!listed.target) return undefined;
        if (listed.keep) return { keep: listed.keep };
        const inspection = await deps.inspect(listed.target, policy, this.abort.signal);
        if (inspection.keep !== undefined) return { keep: inspection.keep };
        const directory = candidate.thread.linkedDirectories.find((item) => item.worktreePath === listed.target);
        const row: ThreadMaintenanceHibernateCheckout = {
          backend: candidate.thread.source,
          threadId: candidate.thread.id,
          title: candidate.thread.title,
          ...(directory?.gitBranch ? { branch: directory.gitBranch } : {}),
          worktreePath: listed.target,
          lastActivityAt: archiveCandidateLastActivity(candidate),
          files: inspection.files,
          bytes: inspection.bytes,
          ...(inspection.removedOutput?.length ? { removedOutput: inspection.removedOutput } : {}),
        };
        return { row, candidate };
      } catch (error) {
        fail("hibernate", error, { threadId: candidate.thread.id });
        return undefined;
      }
    });
    for (const item of evaluated) {
      if (!item) continue;
      result.checked += 1;
      if ("keep" in item) {
        keep(item.keep!);
        continue;
      }
      result.items.push(item.row);
      retained.hibernate.set(buildThreadIdentityKey(item.candidate.thread.source, item.candidate.thread.id), item);
    }
    // Longest idle first, as the archive review lists its rows.
    result.items.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
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
    const result: ThreadMaintenanceArchivedCheckout[] = items.filter((item) => item !== undefined);
    const keepUnreferenced = (reason: string) => {
      const key = UNREFERENCED_KEEP_PREFIX + reason;
      kept[key] = (kept[key] ?? 0) + 1;
    };
    if (audit.unreferencedUnavailable) keepUnreferenced(`not checked: ${audit.unreferencedUnavailable}`);
    if (audit.unreferencedTruncated) keepUnreferenced("more than could be listed");
    const unreferenced = await mapLimit(audit.unreferenced ?? [], INSPECT_CONCURRENCY, async (worktreePath): Promise<ThreadMaintenanceArchivedCheckout | undefined> => {
      if (this.abort.signal.aborted) return undefined;
      if (projectFilter && await checkoutProjectPath(worktreePath) !== path.resolve(projectFilter)) return undefined;
      try {
        if (await missingWorktreeRepository(worktreePath)) {
          keepUnreferenced("repository no longer exists");
          return undefined;
        }
        const reason = unreferencedKeepReason(await inspect(worktreePath, {
          signal: this.abort.signal, limitBytes: this.deps.snapshotLimitBytes,
          rebuildableOutputIsClean: rules.rebuildableOutputIsClean,
        }));
        if (typeof reason === "string") {
          keepUnreferenced(reason);
          return undefined;
        }
        return { kind: "unreferenced", worktreePath, workspace: reason };
      } catch (error) {
        fail("checkouts", error, { path: worktreePath });
        return undefined;
      }
    });
    result.push(...unreferenced.filter((item) => item !== undefined));
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
    // Sub-threads first, so their parent's check below sees them archived.
    const keyOf = (item: { backend: string; threadId: string }) => buildThreadIdentityKey(item.backend as AppServerBackendKind, item.threadId);
    const ordered = subthreadsFirst(request.archive, (item) => retained.families.get(keyOf(item))?.family[0]);
    const archivedKeys = new Set<string>();
    for (const [index, item] of ordered.entries()) {
      const entry = retained.families.get(keyOf(item));
      const object = entry ? entry.row.title : item.threadId;
      update({ current: { step: "threads", processed: index, total: ordered.length, object } });
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
      const left = (retained.subthreads.get(keyOf(item)) ?? []).filter((child) => !archivedKeys.has(child)).length;
      if (left > MAX_SUBTHREADS_LEFT_BY_ARCHIVE) {
        threadStep.kept += 1;
        addProblem({ step: "threads", kind: "kept", object, reason: `Would leave ${left} sub-threads without their parent`,
          detail: "Archive its sub-threads too, or keep it.", backend: item.backend, threadId: item.threadId });
        continue;
      }
      try {
        const outcome = await this.archiveReviewed(entry, item.overLimit, retained.scan.rules);
        if (outcome === true) {
          threadStep.done += 1;
          archivedKeys.add(keyOf(item));
        } else {
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

    // Step 2: hibernate idle checkouts. After archive, so a thread is never
    // hibernated and then archived in one run.
    const hibernateItems = request.hibernate ?? [];
    const hibernateStep: ThreadMaintenanceStepResult = { step: "hibernate", ran: hibernateItems.length > 0, done: 0, kept: 0, failed: 0 };
    steps.push(hibernateStep);
    for (const [index, item] of hibernateItems.entries()) {
      const entry = retained.hibernate.get(keyOf(item));
      const object = entry?.row.title ?? item.threadId;
      const ids = { backend: item.backend, threadId: item.threadId, ...(entry ? { path: entry.row.worktreePath } : {}) };
      const keepIt = (reason: string, detail?: string) => {
        hibernateStep.kept += 1;
        addProblem({ step: "hibernate", kind: "kept", object, reason, ...(detail ? { detail } : {}), ...ids });
      };
      update({ current: { step: "hibernate", processed: index, total: hibernateItems.length, object } });
      if (!entry || !this.deps.hibernation) {
        hibernateStep.failed += 1;
        addProblem({ step: "hibernate", kind: "failed", object, reason: "Not in this scan", ...ids });
        continue;
      }
      if (archivedKeys.has(keyOf(item))) {
        keepIt("Archived in this run");
        continue;
      }
      if (stopped()) {
        keepIt("Stopped before hibernating");
        continue;
      }
      try {
        const refreshed = await this.deps.refreshCandidate(entry.candidate);
        if (archiveCandidateLastActivity(refreshed) > entry.row.lastActivityAt) {
          keepIt("New activity during the run");
          continue;
        }
        const outcome = await this.deps.hibernation.hibernate(refreshed, { ...this.deps.hibernation.getPolicy(), enabled: true });
        if (outcome === true) hibernateStep.done += 1;
        else keepIt(outcome === false ? "Hibernation cancelled" : outcome);
      } catch (error) {
        hibernateStep.failed += 1;
        this.deps.onError?.(error, { step: "hibernate", threadId: item.threadId });
        addProblem({ step: "hibernate", kind: "failed", object, reason: "Hibernation failed", detail: errorMessage(error), ...ids });
      }
    }

    // Step 3: archived checkouts. One failure never skips the rest.
    const checkoutStep: ThreadMaintenanceStepResult = { step: "checkouts",
      ran: request.removeCheckouts.length > 0 || request.trashCheckouts.length > 0
        || (request.removeUnreferenced?.length ?? 0) > 0 || request.removeEmptyFolders,
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
    await this.removeUnreferenced(request, retained, checkoutStep, { stopped, keepStopped, addProblem, update });
    // Repository-gone checkouts the operator left unselected are kept on
    // purpose. A run that skipped this step reports nothing about them.
    for (const checkout of checkoutStep.ran ? retained.checkouts.values() : []) {
      if (checkout.kind === "repositoryGone" && !request.trashCheckouts.some((item) => item.worktreePath === checkout.worktreePath)) {
        addProblem({ step: "checkouts", kind: "kept", object: checkout.worktreePath, reason: "Repository no longer exists",
          detail: checkout.missingRepositoryPath, path: checkout.worktreePath });
      }
    }

    // Step 4: expired archives are deleted by the hourly sweep under the
    // Settings retention period; the reviewed run reports, never deletes.
    steps.push({ step: "expired", ran: false, done: 0, kept: 0, failed: 0 });
    const finished = { ...this.run!, running: false, finishedAt: this.now(), current: undefined,
      steps: [...steps], problems: [...problems] };
    return this.publish(finished);
  }

  /** Checkouts no thread refers to: inspected again, then handed to the
   * registry, which re-checks every thread before it snapshots and removes. */
  private async removeUnreferenced(
    request: ThreadMaintenanceApplyRequest,
    retained: RetainedScan,
    checkoutStep: ThreadMaintenanceStepResult,
    run: {
      stopped: () => boolean;
      keepStopped: (worktreePath: string) => void;
      addProblem: (problem: ThreadMaintenanceProblem) => void;
      update: (patch: Partial<ThreadMaintenanceRun>) => void;
    },
  ): Promise<void> {
    const kept = (worktreePath: string, reason: string, detail?: string) => {
      checkoutStep.kept += 1;
      run.addProblem({ step: "checkouts", kind: "kept", object: worktreePath, reason, path: worktreePath, ...(detail ? { detail } : {}) });
    };
    const failed = (worktreePath: string, reason: string, detail?: string) => {
      checkoutStep.failed += 1;
      run.addProblem({ step: "checkouts", kind: "failed", object: worktreePath, reason, path: worktreePath, ...(detail ? { detail } : {}) });
    };
    const ready: string[] = [];
    const inspect = this.deps.inspectWorkspace ?? inspectMaintenanceWorkspace;
    for (const { worktreePath } of request.removeUnreferenced ?? []) {
      if (retained.checkouts.get(worktreePath)?.kind !== "unreferenced") {
        failed(worktreePath, "Not in this scan");
        continue;
      }
      if (run.stopped()) {
        run.keepStopped(worktreePath);
        continue;
      }
      try {
        const reason = unreferencedKeepReason(await inspect(worktreePath, {
          signal: this.abort.signal, limitBytes: this.deps.snapshotLimitBytes,
          rebuildableOutputIsClean: retained.scan.rules.rebuildableOutputIsClean,
        }));
        if (typeof reason === "string") kept(worktreePath, "Changed since the scan", reason);
        else ready.push(worktreePath);
      } catch (error) {
        this.deps.onError?.(error, { step: "checkouts", path: worktreePath });
        failed(worktreePath, "Removal failed", errorMessage(error));
      }
    }
    if (!ready.length) return;
    if (!this.deps.removeUnreferencedCheckouts) {
      for (const worktreePath of ready) failed(worktreePath, "Removal failed", "Removing checkouts with no thread is unavailable.");
      return;
    }
    run.update({ current: { step: "checkouts", processed: 0, total: ready.length, object: ready[0] } });
    try {
      const removal = await this.deps.removeUnreferencedCheckouts(ready);
      checkoutStep.done += removal.removed.length;
      for (const item of removal.kept) kept(item.worktreePath, item.reason);
      for (const item of removal.failed) failed(item.worktreePath, "Removal failed", item.message);
    } catch (error) {
      this.deps.onError?.(error, { step: "checkouts" });
      for (const worktreePath of ready) failed(worktreePath, "Removal failed", errorMessage(error));
    }
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

  private publish(snapshot: ThreadMaintenanceRun): ThreadMaintenanceRun {
    const run = { ...snapshot, revision: ++this.revision };
    this.run = run;
    this.deps.onRun?.(run);
    return run;
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

/** The workspace when a checkout no thread refers to can be removed, else the
 * reason it stays. Unlike an archived thread's checkout, a main checkout or a
 * folder that is not Git stays too: nothing here says it is safe to touch. */
export function unreferencedKeepReason(
  inspection: MaintenanceWorkspaceInspection,
): string | Extract<ThreadMaintenanceWorkspace, { kind: "clean" | "changes" }> {
  if (inspection.keep !== undefined) return inspection.keep;
  const { workspace } = inspection;
  switch (workspace.kind) {
    case "clean":
    case "changes":
      return workspace;
    case "overLimit": return "Changes over the snapshot limit";
    case "inPlace": return "Main checkout";
    case "notGit": return "Not a Git checkout";
    case "missing": return "No longer on disk";
  }
}
