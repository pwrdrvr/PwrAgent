import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  buildThreadIdentityKey,
  type AppServerBackendKind,
  defaultThreadMaintenanceRules,
  type DesktopCheckoutHibernationPolicy,
  normalizeCheckoutHibernationPolicy,
  type DesktopThreadArchivePolicy,
  type ThreadMaintenanceApplyRequest,
  type ThreadMaintenanceArchivedCheckout,
  type ThreadMaintenanceCoverage,
  type ThreadMaintenanceFailure,
  type ThreadMaintenanceHibernateCheckout,
  type ThreadMaintenanceKeptThread,
  type ThreadMaintenanceKeptCheckout,
  type ThreadMaintenanceIdleThread,
  type ThreadMaintenanceProblem,
  type ThreadMaintenanceProject,
  type ThreadMaintenanceRules,
  type ThreadMaintenanceRun,
  type ThreadMaintenanceScan,
  type ThreadMaintenanceScanProgress,
  type ThreadMaintenanceScanStep,
  type ThreadMaintenanceStep,
  type ThreadMaintenanceStepResult,
  type ThreadMaintenanceWorkspace,
  type ThreadMaintenanceSpace,
  THREAD_MAINTENANCE_SCAN_STEPS,
} from "@pwragent/shared";
import {
  archiveCandidateKeepReason,
  archiveCandidateLastActivity,
  archiveFamilies,
  keepSubthreadParents,
  MAX_SUBTHREADS_LEFT_BY_ARCHIVE,
  PEER_SUBTHREADS_UNREADABLE,
  isPeerSubthreadKey,
  SUBTHREAD_PARENT_KEEP_REASON,
  subthreadChildren,
  subthreadsFirst,
  type ThreadArchiveCandidate,
} from "./thread-archive-sweeper";
import { inspectMaintenanceWorkspace, type MaintenanceWorkspaceInspection } from "./thread-maintenance-workspace";
import { inspectHibernationWorkspace, type HibernationWorkspaceInspection } from "./checkout-hibernation-workspace";
import { HIBERNATION_KEEP_REASONS, hibernatedSnapshotFor, checkoutHibernationLastActivity } from "./checkout-hibernation";
import { missingWorktreeRepository } from "./worktree-archive-service";
import type { MaintenanceDiscoveryProgress } from "./unreferenced-worktrees";
import type { CargoBuildOutputCandidate, scanCargoBuildOutputs, removeCargoBuildOutput } from "./maintenance-cargo-output";
import { MaintenanceCheckoutOwners, maintenanceKeptThread } from "./maintenance-checkout-owners";
import { candidateCheckoutDirectories } from "./thread-owned-checkouts";

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
  /** Legacy audit fields. Unidentified checkouts are never offered. */
  unreferenced?: string[];
  unreferencedUnavailable?: string;
  unreferencedTruncated?: boolean;
  inventory?: { roots: string[]; paths: string[]; repositories?: string[]; providers: NonNullable<ThreadMaintenanceCoverage["providers"]>;
    keptPaths?: { path: string; reason: string }[];
    owners?: { path: string; threads: ThreadMaintenanceKeptThread[]; candidates?: ThreadArchiveCandidate[] }[] };
};

export type UnreferencedCheckoutRemoval = {
  removed: { worktreePath: string }[];
  kept: { worktreePath: string; reason: string }[];
  failed: { worktreePath: string; message: string }[];
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
  listCandidates: (onProgress?: (progress: MaintenanceDiscoveryProgress) => void) => Promise<ThreadArchiveCandidate[]>;
  /** This machine's threads' sub-threads on peers, by parent identity key. */
  listPeerSubthreads?: () => Promise<ReadonlyMap<string, readonly string[]>>;
  resolveProject: (candidate: ThreadArchiveCandidate) => Promise<string | undefined>;
  refreshCandidate: (candidate: ThreadArchiveCandidate) => Promise<ThreadArchiveCandidate>;
  isBusy: (candidate: ThreadArchiveCandidate) => boolean;
  /** Read-only discovery of archived threads' checkouts still on disk. */
  auditArchivedCheckouts: (onProgress?: (progress: MaintenanceDiscoveryProgress) => void) => Promise<ArchivedCheckoutAudit>;
  /** Allocation only, never snapshot size or predicted space recovery. */
  measureAllocation?: (checkout: string, signal: AbortSignal) => Promise<ThreadMaintenanceSpace | undefined>;
  isCheckoutOnDisk?: (checkout: string) => Promise<boolean>;
  buildOutputs?: { scan: typeof scanCargoBuildOutputs; remove: typeof removeCargoBuildOutput };
  /** Archive one reviewed family as an operator archive. Resolves false when cancelled. */
  archiveFamily: (family: ThreadArchiveCandidate[], options: {
    preserveWorktrees: boolean;
    /** A one-run approval to snapshot past the normal limit. */
    snapshotLimitBytes?: number;
  }) => Promise<boolean>;
  /** Remove only the listed archived checkouts, plus empty folders when asked. */
  removeArchivedCheckouts: (selection: { worktreePaths: string[]; emptyFolders: boolean }) => Promise<ArchivedCheckoutRemoval>;
  /** Legacy dependency retained for callers; never invoked. */
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
  /** Each root's project, as the archive step resolved it. */
  projects: Map<string, string | undefined>;
  hibernate: Map<string, { candidate: ThreadArchiveCandidate; row: ThreadMaintenanceHibernateCheckout }>;
  /** Hibernation's settings as the review ran them. The run uses these, not
   * whatever Settings says by then. */
  hibernatePolicy?: DesktopCheckoutHibernationPolicy;
  /** Direct, non-archived sub-threads per parent key, at scan time. */
  subthreads: Map<string, string[]>;
  families: Map<string, { family: ThreadArchiveCandidate[]; row: ThreadMaintenanceIdleThread }>;
  checkouts: Map<string, ThreadMaintenanceArchivedCheckout>;
  buildOutputs: Map<string, CargoBuildOutputCandidate & { owners: ThreadArchiveCandidate[] }>;
  outputClassification: Map<string, Promise<NonNullable<ThreadMaintenanceSpace["rebuildableOutput"]>>>;
  allocation: Map<string, Promise<ThreadMaintenanceSpace | undefined>>;
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

  /** Reads the requested steps, or every step. `onProgress` hears where the
   * scan is as it goes; a step the scan does not read comes back empty.
   * `scanId` names the retained scan, so a caller can name a scan before it
   * finishes. Omitted, the service picks one. */
  async scan(
    request: {
      rules?: Partial<ThreadMaintenanceRules>;
      projectKey?: string;
      scanId?: string;
      steps?: readonly ThreadMaintenanceScanStep[];
      /** Idle days for this scan's hibernate step, in place of Settings'. */
      hibernateIdleDays?: number;
    } = {},
    options: { onProgress?: (progress: ScanProgressSnapshot) => void } = {},
  ): Promise<ThreadMaintenanceScan> {
    const now = this.now();
    const steps = THREAD_MAINTENANCE_SCAN_STEPS.filter((step) => !request.steps || request.steps.includes(step));
    const progress = new ScanProgress(steps, options.onProgress);
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
      buildOutputs: new Map(), outputClassification: new Map(),
      subthreads: new Map(),
      projects: new Map(),
      hibernate: new Map(),
      allocation: new Map(),
    };
    const threads = steps.includes("threads") || steps.includes("hibernate")
      ? await this.scanThreads(rules, policy, now, request.projectKey, retained, fail, progress, steps.includes("threads"))
      : { checked: 0, projects: [], kept: {} };
    // After archive, so each row can say which archive row also takes it.
    const hibernate = steps.includes("hibernate")
      ? await this.scanHibernation(now, request.projectKey, retained, fail, progress, request.hibernateIdleDays)
      : undefined;
    const checkouts = steps.includes("checkouts")
      ? await this.scanCheckouts(rules, request.projectKey, retained, fail, progress)
      : { items: [], kept: {}, emptyFolders: 0 };
    const scan: ThreadMaintenanceScan = {
      scanId: request.scanId ?? this.newId(),
      startedAt: now,
      finishedAt: this.now(),
      rules,
      ...(request.projectKey ? { projectKey: request.projectKey } : {}),
      ...(request.steps ? { steps } : {}),
      spaceSource: this.deps.measureAllocation ? "filesystem" : "none",
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
    progress: ScanProgress,
    /** False when only the hibernate step needs the thread list. */
    evaluate: boolean,
  ): Promise<ThreadMaintenanceScan["threads"]> {
    const result: ThreadMaintenanceScan["threads"] = { checked: 0, projects: [], kept: {} };
    let candidates: ThreadArchiveCandidate[];
    progress.list(evaluate ? "threads" : "hibernate");
    try { candidates = await this.deps.listCandidates((update) => progress.discovery(update)); }
    catch (error) {
      fail("threads", error);
      return { ...result, skipped: "Threads could not be listed" };
    }
    retained.candidates = candidates;
    if (!evaluate) return result;
    // Unread peer sub-threads could belong to any parent, so offer nothing.
    let peerSubthreads: ReadonlyMap<string, readonly string[]> | undefined;
    try { peerSubthreads = await this.deps.listPeerSubthreads?.(); }
    catch (error) {
      fail("threads", error);
      return { ...result, skipped: PEER_SUBTHREADS_UNREADABLE };
    }
    // The dialog's own rules start from the archive settings.
    const reviewPolicy: DesktopThreadArchivePolicy = { ...policy,
      mode: rules.mode, keepPerProject: rules.keepPerProject, inactivityDays: rules.inactivityDays };
    const groupFor = archiveFamilies(candidates);
    retained.subthreads = subthreadChildren(candidates, peerSubthreads);
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
    progress.check("threads", roots.length);
    const evaluated = await mapLimit(roots, INSPECT_CONCURRENCY, progress.track((root) => root.thread.title, async (root): Promise<Evaluated | undefined> => {
      if (this.abort.signal.aborted) return undefined;
      const family = groupFor(root);
      let project: string | undefined;
      try {
        project = await this.deps.resolveProject(root) ?? undefined;
        retained.projects.set(buildThreadIdentityKey(root.thread.source, root.thread.id), project);
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
    }));
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
    progress: ScanProgress,
    idleDaysOverride?: number,
  ): Promise<ThreadMaintenanceScan["hibernate"]> {
    const deps = this.deps.hibernation;
    if (!deps) return undefined;
    let settings: DesktopCheckoutHibernationPolicy;
    try { settings = deps.getPolicy(); }
    catch (error) {
      fail("hibernate", error);
      return undefined;
    }
    // The run hibernates under this policy too, so it keeps the reviewed idle days.
    const policy = normalizeCheckoutHibernationPolicy({ ...settings, enabled: true,
      ...(idleDaysOverride !== undefined ? { idleDays: idleDaysOverride } : {}) });
    retained.hibernatePolicy = policy;
    const result: NonNullable<ThreadMaintenanceScan["hibernate"]> = {
      idleDays: policy.idleDays, maxSnapshotMb: policy.maxSnapshotMb, removeRebuildableOutput: policy.removeRebuildableOutput,
      checked: 0, items: [], notIdleYet: 0, alreadyHibernated: 0, kept: {},
    };
    const candidates = retained.candidates;
    if (!candidates) return { ...result, skipped: "Threads could not be listed" };
    const keep = (reason: string) => { result.kept[reason] = (result.kept[reason] ?? 0) + 1; };
    // Threads the archive step offers are listed too, marked with the archive
    // row that takes them: the operator may not archive them, or may run
    // this step alone. The dialog hides a row once its archive is chosen.
    const archivedWith = new Map<string, string>();
    for (const [rootKey, { family }] of retained.families) {
      for (const member of family) archivedWith.set(buildThreadIdentityKey(member.thread.source, member.thread.id), rootKey);
    }
    // A native child can own an independent checkout even when its parent
    // lives elsewhere. Shared-checkout protection decides whether it stays.
    const roots = candidates;
    const measuredPaths = new Map<string, ThreadMaintenanceSpace | undefined>();
    const excluded = new Map<string, { count: number; paths: Set<string> }>();
    const exclude = (reason: string, target?: string) => {
      const item = excluded.get(reason) ?? { count: 0, paths: new Set<string>() };
      if (!target || !item.paths.has(target)) item.count += 1;
      if (target) item.paths.add(target);
      excluded.set(reason, item);
    };
    progress.check("hibernate", roots.length);
    const evaluated = await mapLimit(roots, INSPECT_CONCURRENCY, progress.track((candidate) => candidate.thread.title, async (candidate) => {
      if (this.abort.signal.aborted) return undefined;
      try {
        if (projectFilter) {
          const key = buildThreadIdentityKey(candidate.thread.source, candidate.thread.id);
          const project = retained.projects.has(key) ? retained.projects.get(key) : await this.deps.resolveProject(candidate);
          if (!project || path.resolve(project) !== path.resolve(projectFilter)) return undefined;
        }
        const listed = deps.keepReason(candidate, candidates, policy, now);
        if (!listed.target) { exclude(listed.keep ?? "No linked worktree checkout"); return undefined; }
        if (hibernatedSnapshotFor(candidate) || listed.keep === HIBERNATION_KEEP_REASONS.alreadyHibernated) {
          exclude(HIBERNATION_KEEP_REASONS.alreadyHibernated);
          return { keep: HIBERNATION_KEEP_REASONS.alreadyHibernated, hibernated: true };
        }
        if (this.deps.isCheckoutOnDisk && !await this.deps.isCheckoutOnDisk(listed.target)) {
          exclude("Checkout missing");
          return undefined;
        }
        const space = await this.ownedCheckoutSpace(listed.target, candidates.filter((owner) =>
          candidateCheckoutDirectories(owner).some((cwd) => cwd === listed.target || cwd.startsWith(listed.target! + path.sep))), retained, progress);
        measuredPaths.set(listed.target, space);
        // A hibernated checkout has nothing on disk, whichever reason keeps it.
        if (listed.keep) { exclude(listed.keep, listed.target); return { keep: listed.keep, hibernated: !!hibernatedSnapshotFor(candidate) }; }
        const inspection = await deps.inspect(listed.target, policy, this.abort.signal);
        if (inspection.keep !== undefined) { exclude(inspection.keep, listed.target); return { keep: inspection.keep, hibernated: false }; }
        const directory = candidate.thread.linkedDirectories.find((item) => item.worktreePath === listed.target);
        const row: ThreadMaintenanceHibernateCheckout = {
          backend: candidate.thread.source,
          threadId: candidate.thread.id,
          title: candidate.thread.title,
          ...(directory?.gitBranch ? { branch: directory.gitBranch } : {}),
          worktreePath: listed.target,
          lastActivityAt: checkoutHibernationLastActivity(candidate),
          files: inspection.files,
          bytes: inspection.bytes,
          ...(space ? { space } : {}),
          ...(inspection.removedOutput?.length ? { removedOutput: inspection.removedOutput } : {}),
        };
        const archiveKey = archivedWith.get(buildThreadIdentityKey(candidate.thread.source, candidate.thread.id));
        if (archiveKey) row.archiveKey = archiveKey;
        return { row, candidate };
      } catch (error) {
        fail("hibernate", error, { threadId: candidate.thread.id });
        return undefined;
      }
    }));
    let notIdleYet = 0;
    let alreadyHibernated = 0;
    for (const item of evaluated) {
      if (!item) continue;
      // Already hibernated: nothing on disk, so it is noted apart, not checked.
      if ("keep" in item && (item.hibernated || item.keep === HIBERNATION_KEEP_REASONS.alreadyHibernated)) {
        alreadyHibernated += 1;
        continue;
      }
      result.checked += 1;
      if ("keep" in item && item.keep === HIBERNATION_KEEP_REASONS.recentlyActive) {
        notIdleYet += 1;
        continue;
      }
      if ("keep" in item) {
        keep(item.keep!);
        continue;
      }
      result.items.push(item.row);
      retained.hibernate.set(buildThreadIdentityKey(item.candidate.thread.source, item.candidate.thread.id), item);
    }
    result.notIdleYet = notIdleYet;
    result.alreadyHibernated = alreadyHibernated;
    result.coverage = allocationCoverage(measuredPaths, providerCounts(candidates.map((item) => item.thread.source)), undefined,
      [...excluded].map(([reason, item]) => ({ reason, count: item.count, paths: [...item.paths] })), now,
      MaintenanceCheckoutOwners.fromCandidates(candidates));
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
    progress: ScanProgress,
  ): Promise<ThreadMaintenanceScan["checkouts"]> {
    let audit: ArchivedCheckoutAudit;
    progress.list("checkouts");
    try { audit = await this.deps.auditArchivedCheckouts((update) => progress.discovery(update)); }
    catch (error) {
      fail("checkouts", error);
      return { items: [], kept: {}, emptyFolders: 0, skipped: "Archived checkouts could not be read" };
    }
    const measuredPaths = new Map<string, ThreadMaintenanceSpace | undefined>();
    const ownership = new Map(audit.inventory?.owners?.map((item) => [item.path, item]));
    const ownedPaths = [...new Set(audit.inventory?.owners?.filter((item) => item.candidates?.length).map((item) => item.path)
      ?? audit.candidates.map((item) => item.worktreePath))];
    const canonical = async (target: string) => {
      const resolved = await realpath(target).catch(() => path.resolve(target));
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const selectedProject = projectFilter ? await canonical(projectFilter) : undefined;
    const matchesProject = async (target: string) => {
      if (!selectedProject || await canonical(target) === selectedProject) return true;
      const repository = await checkoutProjectPath(target);
      return !!repository && await canonical(repository) === selectedProject;
    };
    const paths = selectedProject
      ? (await mapLimit(ownedPaths, INSPECT_CONCURRENCY, async (target) =>
        await matchesProject(target) ? target : undefined))
        .filter((target) => target !== undefined)
      : ownedPaths;
    const candidates = selectedProject
      ? (await mapLimit(audit.candidates, INSPECT_CONCURRENCY, async (item) => await matchesProject(item.worktreePath) ? item : undefined))
        .filter((item) => item !== undefined)
      : audit.candidates;
    progress.check("checkouts", paths.length);
    progress.discovery({ detail: "Measuring checkout allocation on disk", found: paths.length });
    await mapLimit(paths, INSPECT_CONCURRENCY, progress.track((target) => target, async (target) => {
      measuredPaths.set(target, await this.ownedCheckoutSpace(target, ownership.get(target)?.candidates ?? [], retained, progress));
    }));
    const inspect = this.deps.inspectWorkspace ?? inspectMaintenanceWorkspace;
    const kept = { ...audit.kept };
    const excludedReasons = new Map(audit.inventory?.keptPaths?.map((item) => [item.path, item.reason]));
    progress.check("checkouts", candidates.length);
    const items = await mapLimit(candidates, INSPECT_CONCURRENCY, progress.track((candidate) => candidate.worktreePath, async (candidate): Promise<ThreadMaintenanceArchivedCheckout | undefined> => {
      if (this.abort.signal.aborted) return undefined;
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
          excludedReasons.set(candidate.worktreePath, inspection.keep);
          return undefined;
        }
        if (inspection.workspace.kind === "overLimit") {
          kept["Changes over the snapshot limit"] = (kept["Changes over the snapshot limit"] ?? 0) + 1;
          excludedReasons.set(candidate.worktreePath, "Changes over the snapshot limit");
          return undefined;
        }
        return { ...candidate, kind: "removable" as const, workspace: inspection.workspace };
      } catch (error) {
        fail("checkouts", error, { path: candidate.worktreePath, threadId: candidate.threadId });
        return undefined;
      }
    }));
    const result: ThreadMaintenanceArchivedCheckout[] = items.filter((item) => item !== undefined);
    for (const item of result) {
      const space = measuredPaths.get(item.worktreePath);
      if (space) item.space = space;
      retained.checkouts.set(item.worktreePath, item);
    }
    const offered = new Set(result.map((item) => item.worktreePath));
    const excluded = new Map<string, string[]>();
    for (const target of paths) {
      if (offered.has(target)) continue;
      const reason = excludedReasons.get(target) ?? "Protected, referenced, recent or not safe to snapshot";
      excluded.set(reason, [...excluded.get(reason) ?? [], target]);
    }
    const buildOutputs = [...retained.buildOutputs.values()].filter((item) => paths.includes(item.row.checkoutPath)).map((item) => item.row);
    const owners = new MaintenanceCheckoutOwners();
    for (const row of audit.inventory?.owners ?? []) for (const thread of row.threads) owners.add(row.path, thread);
    return { items: result, kept, emptyFolders: audit.emptyFolders, ...(buildOutputs ? { buildOutputs } : {}),
      coverage: allocationCoverage(measuredPaths, audit.inventory?.providers ?? [], selectedProject ? undefined : audit.inventory?.roots,
        [...excluded].map(([reason, paths]) => ({ reason, paths, count: paths.length })), this.now(), owners) };
  }

  /** Classification is attached to an already identified checkout; its size
   * never changes the thread's idle or protection rules. */
  private async ownedCheckoutSpace(target: string, owners: ThreadArchiveCandidate[], retained: RetainedScan,
    progress: ScanProgress): Promise<ThreadMaintenanceSpace | undefined> {
    const allocation = await this.allocation(target, retained);
    owners = owners.filter((owner) => !owner.unreadable);
    if (!owners.length || !this.deps.buildOutputs) return allocation;
    let classification = retained.outputClassification.get(target);
    if (!classification) {
      classification = (async () => {
        const totals = new Map<"cargo", { kind: "cargo"; allocatedBytes?: number; lowerBound?: boolean }>();
        try {
          const outputs = await this.deps.buildOutputs!.scan([target], this.abort.signal, (update) => progress.discovery(update));
          if (outputs.kept.length) totals.set("cargo", { kind: "cargo", lowerBound: true });
          const seen = new Set<string>();
          for (const item of outputs.items) {
            if (path.resolve(item.row.checkoutPath) !== path.resolve(target) || seen.has(item.row.outputPath)) continue;
            seen.add(item.row.outputPath);
            item.row.threads = owners.map((owner) => maintenanceKeptThread(owner, checkoutHibernationLastActivity(owner)));
            retained.buildOutputs.set(item.row.outputPath, { ...item, owners });
            let total = totals.get(item.row.kind);
            if (!total) totals.set(item.row.kind, total = { kind: item.row.kind });
            if (item.row.space?.allocatedBytes !== undefined) total.allocatedBytes = (total.allocatedBytes ?? 0) + item.row.space.allocatedBytes;
            if (item.row.space?.allocatedBytes === undefined || item.row.space.lowerBound) total.lowerBound = true;
          }
        } catch (error) {
          this.deps.onError?.(error, { operation: "classify-owned-checkout-output", path: target });
        }
        return [...totals.values()];
      })();
      retained.outputClassification.set(target, classification);
    }
    const rebuildableOutput = await classification;
    // Later steps can identify more owners of a shared checkout. Reuse the
    // read-only classification without losing their identity or display data.
    for (const output of retained.buildOutputs.values()) {
      if (output.row.checkoutPath !== target) continue;
      output.owners = [...new Map([...output.owners, ...owners].map((owner) =>
        [buildThreadIdentityKey(owner.thread.source, owner.thread.id), owner])).values()];
      output.row.threads = output.owners.map((owner) => maintenanceKeptThread(owner, checkoutHibernationLastActivity(owner)));
    }
    return rebuildableOutput.length ? { ...allocation, rebuildableOutput } : allocation;
  }

  private async stillOwnsBuildOutput(candidate: CargoBuildOutputCandidate & { owners: ThreadArchiveCandidate[] }): Promise<boolean> {
    const canonical = async (value: string) => {
      const target = await realpath(value).catch(() => path.resolve(value));
      return process.platform === "win32" ? target.toLowerCase() : target;
    };
    const checkout = await canonical(candidate.row.checkoutPath);
    for (const owner of candidate.owners) {
      try {
        const refreshed = await this.deps.refreshCandidate(owner);
        if (refreshed.unreadable) continue;
        if (refreshed.thread.source !== owner.thread.source || refreshed.thread.id !== owner.thread.id) continue;
        for (const cwd of candidateCheckoutDirectories(refreshed)) {
          const current = await canonical(cwd);
          if (current === checkout || current.startsWith(checkout + path.sep)) return true;
        }
      } catch { /* A thread that cannot be read is not an ownership grant. */ }
    }
    return false;
  }

  private allocation(target: string, retained: RetainedScan): Promise<ThreadMaintenanceSpace | undefined> {
    let measured = retained.allocation.get(target);
    if (!measured) {
      measured = this.deps.measureAllocation?.(target, this.abort.signal) ?? Promise.resolve(undefined);
      retained.allocation.set(target, measured);
    }
    return measured;
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
    // A peer can gain a sub-thread of one of ours after the scan. Count
    // both reads; if this one fails, every parent with a peer sub-thread is
    // kept, since the scan's count is no longer known to be current.
    const subthreads = new Map(retained.subthreads);
    let peerUnreadable = false;
    if (request.archive.length) {
      try {
        for (const [key, list] of await this.deps.listPeerSubthreads?.() ?? []) {
          subthreads.set(key, [...new Set([...subthreads.get(key) ?? [], ...list])]);
        }
      } catch (error) {
        peerUnreadable = true;
        this.deps.onError?.(error, { step: "threads" });
      }
    }
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
      const children = subthreads.get(keyOf(item)) ?? [];
      if (peerUnreadable && children.some(isPeerSubthreadKey)) {
        threadStep.kept += 1;
        addProblem({ step: "threads", kind: "kept", object, reason: PEER_SUBTHREADS_UNREADABLE,
          detail: "It has sub-threads on another instance. Scan again to retry.", backend: item.backend, threadId: item.threadId });
        continue;
      }
      const left = children.filter((child) => !archivedKeys.has(child)).length;
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
      const ids = { backend: item.backend, threadId: item.threadId, ...(entry ? { path: entry.row.worktreePath } : {}),
        ...(entry?.row.space?.allocatedBytes !== undefined ? { bytes: entry.row.space.allocatedBytes } : {}) };
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
      if (archivedKeys.has(keyOf(item)) || (entry.row.archiveKey && archivedKeys.has(entry.row.archiveKey))) {
        keepIt("Archived in this run");
        continue;
      }
      if (stopped()) {
        keepIt("Stopped before hibernating");
        continue;
      }
      try {
        const refreshed = await this.deps.refreshCandidate(entry.candidate);
        if (checkoutHibernationLastActivity(refreshed) > entry.row.lastActivityAt) {
          keepIt("New activity during the run");
          continue;
        }
        const outcome = await this.deps.hibernation.hibernate(refreshed,
          retained.hibernatePolicy ?? { ...this.deps.hibernation.getPolicy(), enabled: true });
        if (outcome === true) {
          hibernateStep.done += 1;
          if (entry.row.space?.allocatedBytes !== undefined) hibernateStep.allocatedBytesRemoved = (hibernateStep.allocatedBytesRemoved ?? 0) + entry.row.space.allocatedBytes;
        }
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
        || (request.removeUnreferenced?.length ?? 0) > 0 || (request.removeBuildOutputs?.length ?? 0) > 0 || request.removeEmptyFolders,
      done: 0, kept: 0, failed: 0 };
    steps.push(checkoutStep);
    const removedPaths = new Set<string>();
    const removed = (worktreePath: string) => {
      if (removedPaths.has(worktreePath)) return;
      removedPaths.add(worktreePath);
      const bytes = retained.checkouts.get(worktreePath)?.space?.allocatedBytes;
      if (bytes !== undefined) checkoutStep.allocatedBytesRemoved = (checkoutStep.allocatedBytesRemoved ?? 0) + bytes;
    };
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
        for (const item of removal.removed) removed(item.worktreePath);
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
        removed(item.worktreePath);
      } catch (error) {
        checkoutStep.failed += 1;
        this.deps.onError?.(error, { step: "checkouts", path: item.worktreePath });
        addProblem({ step: "checkouts", kind: "failed", object: item.worktreePath, reason: "Move to Trash failed",
          detail: errorMessage(error), path: item.worktreePath });
      }
    }
    for (const { worktreePath } of request.removeUnreferenced ?? []) {
      checkoutStep.kept += 1;
      addProblem({ step: "checkouts", kind: "kept", object: worktreePath, path: worktreePath,
        reason: "No identified thread owns this checkout" });
    }
    for (const outputPath of new Set((request.removeBuildOutputs ?? []).map((item) => item.outputPath))) {
      const candidate = retained.buildOutputs.get(outputPath);
      if (!candidate || !this.deps.buildOutputs) {
        checkoutStep.failed += 1;
        addProblem({ step: "checkouts", kind: "failed", object: outputPath, path: outputPath, reason: "Not in this scan" });
        continue;
      }
      if ([...removedPaths].some((parent) => outputPath.startsWith(parent + path.sep))) continue;
      if (stopped()) { keepStopped(outputPath); continue; }
      update({ current: { step: "checkouts", processed: 0, total: request.removeBuildOutputs!.length, object: outputPath } });
      try {
        if (!await this.stillOwnsBuildOutput(candidate)) {
          checkoutStep.kept += 1;
          addProblem({ step: "checkouts", kind: "kept", object: outputPath, path: outputPath,
            reason: "Thread no longer identifies this checkout" });
          continue;
        }
        const result = await this.deps.buildOutputs.remove(candidate, this.abort.signal);
        if (result.kept) {
          checkoutStep.kept += 1;
          addProblem({ step: "checkouts", kind: "kept", object: outputPath, path: outputPath, reason: result.kept,
            ...(candidate.row.space?.allocatedBytes !== undefined ? { bytes: candidate.row.space.allocatedBytes } : {}) });
        } else if (!result.alreadyGone) {
          checkoutStep.done += 1;
          if (result.allocatedBytesRemoved !== undefined) checkoutStep.allocatedBytesRemoved = (checkoutStep.allocatedBytesRemoved ?? 0) + result.allocatedBytesRemoved;
        }
      } catch (error) {
        checkoutStep.failed += 1;
        addProblem({ step: "checkouts", kind: "failed", object: outputPath, path: outputPath, reason: "Build output removal failed", detail: errorMessage(error) });
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

    // Step 4: expired archives are deleted by the hourly sweep under the
    // Settings retention period; the reviewed run reports, never deletes.
    steps.push({ step: "expired", ran: false, done: 0, kept: 0, failed: 0 });
    const finished = { ...this.run!, running: false, finishedAt: this.now(), current: undefined,
      steps: [...steps], problems: [...problems] };
    return this.publish(finished);
  }

  /** True when archived, else the reason it was kept. Throws on failure. */
  private async archiveReviewed(
    entry: { family: ThreadArchiveCandidate[]; row: ThreadMaintenanceIdleThread },
    overLimit: ThreadMaintenanceApplyRequest["archive"][number]["overLimit"],
    rules: ThreadMaintenanceRules,
  ): Promise<true | string> {
    const refreshed = await Promise.all(entry.family.map((item) => this.deps.refreshCandidate(item)));
    if (archiveCandidateLastActivity(refreshed[0]!) > entry.row.lastActivityAt) return "New activity during the run";
    const policy = { ...this.deps.getPolicy(), mode: "age" as const, inactivityDays: 0 };
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
    rebuildableOutputIsClean: true,
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

/** A scan's position, without the window's progress id. */
export type ScanProgressSnapshot = Omit<ThreadMaintenanceScanProgress, "progressId">;

function providerCounts(backends: string[]): NonNullable<ThreadMaintenanceCoverage["providers"]> {
  const counts = new Map<string, number>();
  for (const backend of backends) counts.set(backend, (counts.get(backend) ?? 0) + 1);
  return [...counts].map(([backend, threads]) => ({ backend, threads }));
}

/** Counts each checkout once, independently of how many threads share it.
 * Unknown allocation stays unknown; partial sums are explicitly lower bounds. */
function allocationCoverage(
  paths: ReadonlyMap<string, ThreadMaintenanceSpace | undefined>,
  providers: NonNullable<ThreadMaintenanceCoverage["providers"]>,
  scannedRoots: string[] = [],
  exclusions: { reason: string; count: number; paths: string[] }[] = [],
  measuredAt: number,
  owners?: MaintenanceCheckoutOwners,
): ThreadMaintenanceCoverage {
  const roots = new Map<string, ThreadMaintenanceCoverage["roots"][number]>();
  const rootFor = (target: string) => {
    const explicit = scannedRoots.filter((root) => target === root || target.startsWith(root + path.sep))
      .sort((a, b) => b.length - a.length)[0];
    if (explicit) return explicit;
    const marker = path.sep + "worktrees" + path.sep;
    const index = target.lastIndexOf(marker);
    return index >= 0 ? target.slice(0, index + marker.length - 1) : path.dirname(target);
  };
  const rootRow = (root: string) => {
    let row = roots.get(root);
    if (!row) {
      const normalized = root.replace(/\\/g, "/");
      const owner = /\/\.codex(?:\/|$)/.test(normalized) ? "codex"
        : /\/\.pwrag(?:ent|nt)(?:\/|$)/.test(normalized) ? "pwragent" : "other";
      row = { path: root, owner, checkouts: 0 };
      roots.set(root, row);
    }
    return row;
  };
  for (const root of scannedRoots) rootRow(root);
  for (const [target, space] of paths) {
    const row = rootRow(rootFor(target));
    row.checkouts += 1;
    if (space?.allocatedBytes !== undefined) row.allocatedBytes = (row.allocatedBytes ?? 0) + space.allocatedBytes;
    if (space?.allocatedBytes === undefined || space.lowerBound) row.lowerBound = true;
  }
  const largestKept = new Map<string, ThreadMaintenanceKeptCheckout>();
  for (const item of exclusions) for (const target of item.paths) {
    const threads = owners?.forPath(target);
    if (!largestKept.has(target)) largestKept.set(target, { path: target, reason: item.reason,
      ...(threads?.length ? { threads } : {}),
      ...(paths.get(target)?.rebuildableOutput ? { rebuildableOutput: paths.get(target)!.rebuildableOutput } : {}),
      ...(paths.get(target)?.allocatedBytes !== undefined ? { allocatedBytes: paths.get(target)!.allocatedBytes } : {}) });
  }
  const keptCheckouts = [...largestKept.values()].sort((a, b) => (b.allocatedBytes ?? -1) - (a.allocatedBytes ?? -1));
  return { roots: [...roots.values()], providers, measuredAt,
    largestKept: keptCheckouts.slice(0, 10), keptCheckouts,
    excluded: exclusions.filter((item) => item.count > 0).map((item) => {
      const measured = item.paths.map((target) => paths.get(target)?.allocatedBytes);
      return { reason: item.reason, count: item.count,
        ...(measured.some((value) => value !== undefined)
          ? { allocatedBytes: measured.reduce<number>((sum, value) => sum + (value ?? 0), 0) } : {}) };
    }) };
}

/** Tracks where a scan is and tells the listener on every change. A step
 * starts "listing" while it reads what to check, then counts items as they
 * finish. Items in flight are named, in the order they started. */
class ScanProgress {
  private step: ThreadMaintenanceScanStep;
  private stage: ScanProgressSnapshot["stage"] = "listing";
  private processed = 0;
  private total = 0;
  private readonly inFlight: string[] = [];
  private discoveryState: MaintenanceDiscoveryProgress = {};

  constructor(private readonly steps: ThreadMaintenanceScanStep[], private readonly listener?: (progress: ScanProgressSnapshot) => void) {
    this.step = steps[0] ?? "threads";
  }

  list(step: ThreadMaintenanceScanStep): void {
    this.reset(step, "listing", 0);
  }

  check(step: ThreadMaintenanceScanStep, total: number): void {
    this.reset(step, "checking", total);
  }

  discovery(update: MaintenanceDiscoveryProgress): void {
    this.discoveryState = update;
    this.emit();
  }

  /** Wraps one item's work so it is named while it runs and counted when it ends. */
  track<T, R>(label: (item: T) => string, work: (item: T) => Promise<R>): (item: T) => Promise<R> {
    return async (item) => {
      const name = label(item);
      this.inFlight.push(name);
      this.emit();
      try {
        return await work(item);
      } finally {
        const index = this.inFlight.indexOf(name);
        if (index >= 0) this.inFlight.splice(index, 1);
        this.processed += 1;
        this.emit();
      }
    };
  }

  private reset(step: ThreadMaintenanceScanStep, stage: ScanProgressSnapshot["stage"], total: number): void {
    this.step = step;
    this.stage = stage;
    this.processed = 0;
    this.total = total;
    this.inFlight.length = 0;
    this.discoveryState = {};
    this.emit();
  }

  private emit(): void {
    this.listener?.({
      steps: [...this.steps], step: this.step, stage: this.stage,
      processed: this.processed, total: this.total, inFlight: [...this.inFlight],
      ...this.discoveryState,
    });
  }
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
