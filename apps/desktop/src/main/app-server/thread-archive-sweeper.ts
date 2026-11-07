import { stat } from "node:fs/promises";
import type { AppServerThreadSummary, ThreadOverlayState } from "@pwragent/shared";
import {
  DEFAULT_THREAD_ARCHIVE_POLICY,
  type DesktopCheckoutHibernationPolicy,
  THREAD_ARCHIVE_SWEEP_FAILURE_LIMIT,
  type DesktopThreadArchivePolicy,
  type DesktopThreadArchiveSweepFailure,
  type DesktopThreadArchiveSweepStatus,
  buildThreadIdentityKey,
  isCodexChatsDirectory,
  toolWorktreeRootOwner,
} from "@pwragent/shared";
import { runGitCommand } from "./git-executable";
import { withCodexRequestActivity } from "../codex-app-server/request-activity";

export const THREAD_AUTO_ARCHIVE_AGE_MS = 7 * 24 * 60 * 60_000;
export const THREAD_ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60_000;
export const THREAD_ARCHIVE_SWEEP_START_DELAY_MS = 60_000;

export type ThreadArchiveCandidate = {
  thread: AppServerThreadSummary;
  overlay?: ThreadOverlayState;
  /** A sub-agent card on the thread is still pending, running or blocked. */
  activeSubAgent?: boolean;
  /** A PR watch (watching or dispatching) will wake the thread. */
  activePrWatch?: boolean;
  /** Its overlay or sub-agent state could not be read; fail closed. */
  unreadable?: boolean;
};

/** Card statuses that keep housekeeping away from a thread. */
export const ARCHIVE_ACTIVE_SUB_AGENT_STATUSES: readonly string[] = ["running", "pending", "cancelling", "blocked"];

/** The hourly sweep never archives a thread: archiving is the operator's
 * call (a thread, a selection, or Thread maintenance). It cleans up after
 * archives the operator made and hibernates idle checkouts. */
type SweeperDeps = {
  /** Resolves to the number of expired families deleted. A cleanup that
   * logs its own per-thread failures reports each through onFailure. */
  cleanupRetention?: (onFailure: (error: unknown, details?: SweepFailureDetails) => void) => Promise<number | void>;
  cleanupWorktrees?: (options: {
    manual: boolean;
    onProgress: (status: NonNullable<DesktopThreadArchiveSweepStatus["worktrees"]>) => void;
    onFailure: (error: unknown, details?: SweepFailureDetails) => void;
  }) => Promise<void>;
  listCandidates: () => Promise<ThreadArchiveCandidate[]>;
  onError: (error: unknown, threadId?: string) => void;
  onStatus?: (status: DesktopThreadArchiveSweepStatus) => void;
  /** Idle checkout hibernation, the sweep's last phase. Absent: no phase. */
  hibernation?: CheckoutHibernationSweepDeps;
};

export type CheckoutHibernationSweepDeps = {
  getPolicy: () => DesktopCheckoutHibernationPolicy;
  /** Why this candidate's checkout stays, from thread state alone, or
   * undefined. Undefined target: the thread has no checkout to hibernate,
   * and is not counted. */
  keepReason: (candidate: ThreadArchiveCandidate, candidates: readonly ThreadArchiveCandidate[],
    policy: DesktopCheckoutHibernationPolicy, now: number) => { target?: string; keep?: string };
  /** Why the checkout itself must stay, from Git, or undefined. */
  inspectWorkspace: (worktreePath: string, policy: DesktopCheckoutHibernationPolicy, signal: AbortSignal) => Promise<string | undefined>;
  /** True when hibernated, false when cancelled, or the reason it was kept. */
  hibernate: (candidate: ThreadArchiveCandidate, policy: DesktopCheckoutHibernationPolicy) => Promise<boolean | string>;
};

type SweepTally = Pick<DesktopThreadArchiveSweepStatus, "deleted" | "failed" | "error" | "failures" | "hibernation">;
type SweepFailureDetails = { path?: string; threadId?: string };
type SweepPhase = DesktopThreadArchiveSweepFailure["phase"];

/** Keep reasons reported for workspaces that fail the archive safety check. */
export const WORKSPACE_KEEP_REASONS = {
  changes: "Uncommitted changes",
  ignored: "Ignored files only",
  unretained: "Commits on no branch",
} as const;

/** Reads live Git state, including ignored files, untracked files and dirty submodules. A
 * detached tip is safe only when a local or remote branch retains it. No fetch
 * is needed: committed work on an unpushed local branch is eligible too. */
export async function workspaceIsSafeForAutoArchive(
  cwd: string,
  signal: AbortSignal,
): Promise<boolean> {
  return await workspaceArchiveBlocker(cwd, signal) === undefined;
}

/** The same check as workspaceIsSafeForAutoArchive, naming what keeps the
 * workspace. Ignored files alone (for example node_modules) are reported
 * separately so the operator can see why a clean checkout was kept. */
export async function workspaceArchiveBlocker(
  cwd: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    await stat(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const options = { signal, timeout: 10_000 };
  let status: { stdout: string };
  try {
    status = await runGitCommand(cwd, [
      "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none",
    ], options);
  } catch (error) {
    // Archive removes only registered Git worktrees, so a directory with no
    // repository at or above it (a scratch project) is left in place. A broken
    // worktree link reports a different message and still fails closed.
    if (isOutsideAnyGitRepository(error)) return undefined;
    throw error;
  }
  const lines = status.stdout.split("\n").filter((line) => line.trim());
  if (lines.length) {
    return lines.every((line) => line.startsWith("!! "))
      ? WORKSPACE_KEEP_REASONS.ignored
      : WORKSPACE_KEEP_REASONS.changes;
  }
  const retained = await runGitCommand(cwd, [
    "rev-list", "--count", "HEAD", "--not", "--branches", "--remotes",
  ], options);
  return retained.stdout.trim() === "0" ? undefined : WORKSPACE_KEEP_REASONS.unretained;
}

export function isOutsideAnyGitRepository(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const text = `${error instanceof Error ? error.message : String(error)}\n${typeof stderr === "string" ? stderr : ""}`;
  return text.includes("not a git repository (or any of the parent directories)");
}

export function archiveCandidateLastActivity({ thread, overlay }: ThreadArchiveCandidate): number {
  return Math.max(thread.updatedAt ?? 0, overlay?.lastSeenAt ?? 0, overlay?.archiveRestoredAt ?? 0,
    ...(overlay?.worktreeSnapshots ?? []).map((snapshot) => snapshot.restoredAt ?? 0));
}

export const CLAUDE_CHECKOUT_KEEP_REASON = "Checkout not created by PwrAgent";

/** A worktree under PwrAgent's own root (`~/.pwragent/…/worktrees/<id>/<name>`). */
export function isPwrAgentWorktreePath(value: string | undefined): boolean {
  return toolWorktreeRootOwner(value) === "pwragent";
}

/** The Claude thread works in a PwrAgent worktree, and no directory it uses
 * is marked as someone else's checkout. */
export function isPwrAgentClaudeCheckout({ thread, overlay }: Pick<ThreadArchiveCandidate, "thread" | "overlay">): boolean {
  const directories = [...thread.linkedDirectories, ...overlay?.extraLinkedDirectories ?? []];
  return isPwrAgentWorktreePath(thread.projectKey)
    && directories.every((directory) => directory.worktreeOwnership !== "external"
      && (!directory.worktreePath || isPwrAgentWorktreePath(directory.worktreePath)));
}

/** `allowPinned` is for checkout hibernation, which keeps the thread listed. */
export function archiveCandidateProtectionReason(
  { thread, overlay, activeSubAgent, activePrWatch, unreadable }: ThreadArchiveCandidate,
  options: { allowPinned?: boolean } = {},
): string | undefined {
  if (unreadable) return "Thread state unreadable";
  if (!options.allowPinned && (thread.isPinned || overlay?.pinnedRank !== undefined)) return "Pinned thread";
  if (overlay?.agent) return "Agent thread";
  if (overlay?.mergeHolds?.some((hold) => hold.status === "waiting")) return "Merge held";
  if (overlay?.queuedAgentChange || overlay?.prAutoDispatchPending) return "Pending work";
  // The agent asked to be woken by its PR; archiving would strand the wake.
  if (activePrWatch) return "Watching a PR";
  if (overlay?.scheduledStart?.state === "scheduled") return "Scheduled work";
  if ((overlay?.codexEnvironmentRuntime ?? thread.codexEnvironmentRuntime)?.executionTarget === "remote") return "Remote execution";
  // Claude threads are cleaned up only in a worktree PwrAgent created. A
  // Claude session can also run in a checkout the operator or Claude Code made.
  if (thread.source === "claude" && !isPwrAgentClaudeCheckout({ thread, overlay })) return CLAUDE_CHECKOUT_KEEP_REASON;
  // The Codex app owns its chat folders' threads; housekeeping leaves them alone.
  if ([...thread.linkedDirectories, ...overlay?.extraLinkedDirectories ?? []].some(isCodexChatsDirectory)) return "Codex chat folder";
  if (activeSubAgent) return "Active subagent";
  if (thread.threadStatus !== "idle" && thread.threadStatus !== "notLoaded") {
    return thread.threadStatus === undefined ? "Provider status unavailable" : "Active or blocked chat";
  }
  return undefined;
}

export function isProtectedArchiveCandidate(candidate: ThreadArchiveCandidate): boolean {
  return archiveCandidateProtectionReason(candidate) !== undefined;
}

export function isStaleArchiveCandidate(
  candidate: ThreadArchiveCandidate,
  now: number,
  policy: DesktopThreadArchivePolicy = { ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age" },
): boolean {
  return archiveCandidateKeepReason(candidate, now, policy) === undefined;
}

/** Why the policy keeps a candidate, or undefined when it is stale. */
export function archiveCandidateKeepReason(
  candidate: ThreadArchiveCandidate,
  now: number,
  policy: DesktopThreadArchivePolicy = { ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age" },
): string | undefined {
  const { thread, overlay } = candidate;
  if (thread.archivedAt !== undefined || overlay?.archiveTombstonedAt !== undefined) return "Already archived";
  const protection = archiveCandidateProtectionReason(candidate);
  if (protection) return protection;
  if (!Number.isFinite(thread.updatedAt) || (thread.updatedAt ?? 0) <= 0) return "Activity unknown";
  return policy.mode === "count" || now - archiveCandidateLastActivity(candidate) >= policy.inactivityDays * 86_400_000
    ? undefined
    : "Recently active";
}

/** A parent archived with more sub-threads left than this would scatter
 * them: archive ungroups or promotes them. Archiving the children is fine. */
export const MAX_SUBTHREADS_LEFT_BY_ARCHIVE = 2;

export const SUBTHREAD_PARENT_KEEP_REASON = "Parent of 3+ sub-threads";

/** Direct, non-archived local sub-threads per parent identity key. A sub-thread's
 * parent link lives on its own overlay. Peer parents and native sub-agents
 * (which archive with their root) are not counted. */
export function subthreadChildren(candidates: readonly ThreadArchiveCandidate[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const { thread, overlay } of candidates) {
    const parentId = overlay?.parentThreadId?.trim();
    if (!parentId || overlay?.parentThreadInstanceId || thread.codexNativeSubAgent) continue;
    if (overlay?.archiveTombstonedAt !== undefined || overlay?.archiveRetentionStartedAt !== undefined) continue;
    const key = buildThreadIdentityKey(overlay?.parentThreadBackend ?? thread.source, parentId);
    children.set(key, [...children.get(key) ?? [], buildThreadIdentityKey(thread.source, thread.id)]);
  }
  return children;
}

/** Removes from `selected` every parent that would leave more than
 * MAX_SUBTHREADS_LEFT_BY_ARCHIVE sub-threads behind, counting selected
 * children as gone. Repeats until stable, since keeping a child that is itself
 * a parent can push its own parent over the limit. Returns the kept keys. */
export function keepSubthreadParents(selected: Set<string>, children: ReadonlyMap<string, readonly string[]>): string[] {
  const kept: string[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const key of [...selected]) {
      const left = (children.get(key) ?? []).filter((child) => !selected.has(child)).length;
      if (left > MAX_SUBTHREADS_LEFT_BY_ARCHIVE) {
        selected.delete(key);
        kept.push(key);
        changed = true;
      }
    }
  }
  return kept;
}

/** Deepest sub-threads first, then their parents, then top-level threads;
 * otherwise in the given order. A sub-thread that is itself a parent must wait
 * for its own sub-threads, or its archive promotes them. */
export function subthreadsFirst<T>(
  items: readonly T[],
  candidateOf: (item: T) => Pick<ThreadArchiveCandidate, "thread" | "overlay"> | undefined =
    (item) => item as unknown as ThreadArchiveCandidate,
): T[] {
  const parentOf = new Map<string, string | undefined>();
  for (const item of items) {
    const candidate = candidateOf(item);
    if (!candidate) continue;
    const parentId = candidate.overlay?.parentThreadId?.trim();
    parentOf.set(buildThreadIdentityKey(candidate.thread.source, candidate.thread.id), parentId
      ? buildThreadIdentityKey(candidate.overlay?.parentThreadBackend ?? candidate.thread.source, parentId)
      : undefined);
  }
  // Parent links walked from the item, bounded so a parent loop cannot spin.
  const depth = (item: T): number => {
    const candidate = candidateOf(item);
    if (!candidate) return 0;
    let key = buildThreadIdentityKey(candidate.thread.source, candidate.thread.id);
    let levels = 0;
    while (levels <= items.length) {
      const parent = parentOf.get(key);
      if (!parent) break;
      levels += 1;
      key = parent;
    }
    return levels;
  };
  const depths = new Map(items.map((item) => [item, depth(item)]));
  return [...items].sort((a, b) => depths.get(b)! - depths.get(a)!);
}

/** Groups each root with its native sub-agent threads, which archive with it. */
export function archiveFamilies(candidates: ThreadArchiveCandidate[]): (root: ThreadArchiveCandidate) => ThreadArchiveCandidate[] {
  const children = new Map<string, ThreadArchiveCandidate[]>();
  for (const candidate of candidates) {
    const parentId = candidate.thread.codexNativeSubAgent?.parentThreadId;
    if (!parentId) continue;
    const key = buildThreadIdentityKey(candidate.thread.source, parentId);
    children.set(key, [...children.get(key) ?? [], candidate]);
  }
  return (root) => {
    const group: ThreadArchiveCandidate[] = [];
    const seen = new Set<string>();
    const visit = (candidate: ThreadArchiveCandidate) => {
      const key = buildThreadIdentityKey(candidate.thread.source, candidate.thread.id);
      if (seen.has(key)) return;
      seen.add(key);
      group.push(candidate);
      for (const child of children.get(key) ?? []) visit(child);
    };
    visit(root);
    return group;
  };
}

/** Main-process housekeeping. Only explicit start() schedules it, so registry
 * construction and startup discovery never wait on archive or Git work. */
export class ThreadArchiveSweeper {
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private running?: Promise<void>;
  private readonly abort = new AbortController();
  private status: DesktopThreadArchiveSweepStatus = { running: false, deleted: 0, failed: 0 };

  constructor(private readonly deps: SweeperDeps) {}

  getStatus(): DesktopThreadArchiveSweepStatus {
    return this.status;
  }

  start(): void {
    if (this.started || this.abort.signal.aborted) return;
    this.started = true;
    this.schedule(THREAD_ARCHIVE_SWEEP_START_DELAY_MS);
  }

  /** A manual sweep joins a running one. Either way the hourly interval is
   * measured from the last finish, so the advertised next time stays true. */
  sweep(options: { manual?: boolean } = {}): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    if (this.running) return this.running;
    clearTimeout(this.timer);
    const tally: SweepTally = { deleted: 0, failed: 0 };
    this.publish({ ...tally, running: true, startedAt: Date.now() });
    this.running = withCodexRequestActivity(
      { countsAsActivity: false }, () => this.run(tally, options.manual === true),
    ).catch((error) => {
      if (!this.abort.signal.aborted) this.fail(tally, "sweep", error);
    }).finally(() => {
      this.running = undefined;
      if (this.abort.signal.aborted) return;
      this.publish({ ...this.status, ...tally, running: false, finishedAt: Date.now() });
      if (this.started) this.schedule(THREAD_ARCHIVE_SWEEP_INTERVAL_MS);
    });
    return this.running;
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    this.abort.abort();
    // A deletion or hibernation already sent must settle before the registry
    // closes its stores.
    await this.running;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => { void this.sweep(); }, delay);
    this.timer.unref?.();
    this.publish({ ...this.status, nextAt: Date.now() + delay });
  }

  private publish(status: DesktopThreadArchiveSweepStatus): void {
    this.status = status;
    this.deps.onStatus?.(status);
  }

  private count(tally: SweepTally, phase: SweepPhase, error: unknown, details: SweepFailureDetails = {}): void {
    const message = error instanceof Error ? error.message : String(error);
    tally.failed += 1;
    tally.error ??= message;
    const failures = tally.failures ??= [];
    if (failures.length < THREAD_ARCHIVE_SWEEP_FAILURE_LIMIT) {
      failures.push({ phase, message,
        ...(details.path ? { path: details.path } : {}),
        ...(details.threadId ? { threadId: details.threadId } : {}) });
    }
  }

  private fail(tally: SweepTally, phase: SweepPhase, error: unknown, threadId?: string): void {
    this.count(tally, phase, error, { threadId });
    this.deps.onError(error, threadId);
  }

  private async run(tally: SweepTally, manual: boolean): Promise<void> {
    // Each phase reports its own failures; none of them stops a later phase.
    try {
      await this.deps.cleanupWorktrees?.({ manual,
        onProgress: (worktrees) => this.publish({ ...this.status, ...tally, worktrees }),
        onFailure: (error, details) => this.count(tally, "worktrees", error, details),
      });
    } catch (error) { if (!this.abort.signal.aborted) this.fail(tally, "worktrees", error); }
    try { tally.deleted += await this.deps.cleanupRetention?.((error, details) => this.count(tally, "retention", error, details)) || 0; }
    catch (error) { if (!this.abort.signal.aborted) this.fail(tally, "retention", error); }
    if (this.abort.signal.aborted) return;
    await this.hibernateCheckouts(tally);
  }

  private async hibernateCheckouts(tally: SweepTally): Promise<void> {
    const deps = this.deps.hibernation;
    if (!deps) return;
    let policy: DesktopCheckoutHibernationPolicy;
    try { policy = deps.getPolicy(); }
    catch (error) {
      this.fail(tally, "hibernation", error);
      tally.hibernation = { checked: 0, hibernated: 0, kept: {}, skipped: "The hibernation policy could not be read" };
      return;
    }
    const hibernation: NonNullable<SweepTally["hibernation"]> = { checked: 0, hibernated: 0, kept: {} };
    tally.hibernation = hibernation;
    if (!policy.enabled) {
      hibernation.skipped = "Hibernation is off";
      return;
    }
    const keep = (reason: string) => { hibernation.kept[reason] = (hibernation.kept[reason] ?? 0) + 1; };
    let candidates: ThreadArchiveCandidate[];
    try { candidates = await this.deps.listCandidates(); }
    catch (error) {
      if (!this.abort.signal.aborted) this.fail(tally, "hibernation", error);
      hibernation.skipped = "Threads could not be listed";
      return;
    }
    for (const candidate of candidates) {
      if (this.abort.signal.aborted) return;
      // Native sub-agents share their root's checkout.
      if (candidate.thread.codexNativeSubAgent) continue;
      try {
        const listed = deps.keepReason(candidate, candidates, policy, Date.now());
        if (!listed.target) continue;
        hibernation.checked += 1;
        if (listed.keep) {
          keep(listed.keep);
          continue;
        }
        const workspace = await deps.inspectWorkspace(listed.target, policy, this.abort.signal);
        if (this.abort.signal.aborted) return;
        if (workspace) {
          keep(workspace);
          continue;
        }
        if (JSON.stringify(deps.getPolicy()) !== JSON.stringify(policy)) return;
        const result = await deps.hibernate(candidate, policy);
        if (result === true) hibernation.hibernated += 1;
        else keep(result === false ? "Hibernation cancelled" : result);
      } catch (error) {
        if (!this.abort.signal.aborted) {
          this.count(tally, "hibernation", error, { threadId: candidate.thread.id });
          this.deps.onError(error, candidate.thread.id);
        }
      }
    }
  }
}
