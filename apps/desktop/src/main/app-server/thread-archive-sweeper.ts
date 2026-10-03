import { stat } from "node:fs/promises";
import type { AppServerThreadSummary, ThreadOverlayState } from "@pwragent/shared";
import {
  DEFAULT_THREAD_ARCHIVE_POLICY,
  type DesktopThreadArchivePolicy,
  type DesktopThreadArchiveSweepStatus,
  buildThreadIdentityKey,
} from "@pwragent/shared";
import { runGitCommand } from "./git-executable";

export const THREAD_AUTO_ARCHIVE_AGE_MS = 7 * 24 * 60 * 60_000;
export const THREAD_ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60_000;
export const THREAD_ARCHIVE_SWEEP_START_DELAY_MS = 60_000;

export type ThreadArchiveCandidate = {
  thread: AppServerThreadSummary;
  overlay?: ThreadOverlayState;
};

type SweeperDeps = {
  getPolicy?: () => DesktopThreadArchivePolicy;
  resolveProject?: (candidate: ThreadArchiveCandidate) => Promise<string | undefined>;
  /** Resolves to the number of expired families deleted. A cleanup that
   * logs its own per-thread failures reports each through onFailure. */
  cleanupRetention?: (onFailure: (error: unknown) => void) => Promise<number | void>;
  listCandidates: () => Promise<ThreadArchiveCandidate[]>;
  refreshCandidate: (candidate: ThreadArchiveCandidate) => Promise<ThreadArchiveCandidate>;
  isBusy: (candidate: ThreadArchiveCandidate) => boolean;
  canArchive: (candidates: ThreadArchiveCandidate[]) => Promise<boolean>;
  /** Resolves false when the archive was cancelled at the mutation boundary. */
  archive: (candidate: ThreadArchiveCandidate, family: ThreadArchiveCandidate[]) => Promise<unknown>;
  workspaceIsSafe?: (cwd: string, signal: AbortSignal) => Promise<boolean>;
  onError: (error: unknown, threadId?: string) => void;
  onStatus?: (status: DesktopThreadArchiveSweepStatus) => void;
};

type SweepTally = Pick<DesktopThreadArchiveSweepStatus, "archived" | "deleted" | "failed" | "error">;

/** Reads live Git state, including ignored files, untracked files and dirty submodules. A
 * detached tip is safe only when a local or remote branch retains it. No fetch
 * is needed: committed work on an unpushed local branch is eligible too. */
export async function workspaceIsSafeForAutoArchive(
  cwd: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await stat(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
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
    if (isOutsideAnyGitRepository(error)) return true;
    throw error;
  }
  if (status.stdout.trim()) return false;
  const retained = await runGitCommand(cwd, [
    "rev-list", "--count", "HEAD", "--not", "--branches", "--remotes",
  ], options);
  return retained.stdout.trim() === "0";
}

function isOutsideAnyGitRepository(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const text = `${error instanceof Error ? error.message : String(error)}\n${typeof stderr === "string" ? stderr : ""}`;
  return text.includes("not a git repository (or any of the parent directories)");
}

export function archiveCandidateLastActivity({ thread, overlay }: ThreadArchiveCandidate): number {
  return Math.max(thread.updatedAt ?? 0, overlay?.lastSeenAt ?? 0, overlay?.archiveRestoredAt ?? 0,
    ...(overlay?.worktreeSnapshots ?? []).map((snapshot) => snapshot.restoredAt ?? 0));
}

export function archiveCandidateProtectionReason({ thread, overlay }: ThreadArchiveCandidate): string | undefined {
  if (thread.isPinned || overlay?.pinnedRank !== undefined) return "Pinned thread";
  if (overlay?.agent) return "Agent thread";
  if (overlay?.queuedAgentChange || overlay?.prAutoDispatchPending) return "Pending work";
  if (overlay?.scheduledStart?.state === "scheduled") return "Scheduled work";
  if ((overlay?.codexEnvironmentRuntime ?? thread.codexEnvironmentRuntime)?.executionTarget === "remote") return "Remote execution";
  if (overlay?.subAgents?.some((agent) => ["running", "pending", "cancelling", "blocked"].includes(agent.status))) return "Active subagent";
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
  const { thread, overlay } = candidate;
  if (!policy.enabled || thread.archivedAt !== undefined || overlay?.archiveTombstonedAt !== undefined
    || isProtectedArchiveCandidate(candidate)) return false;
  if (!Number.isFinite(thread.updatedAt) || (thread.updatedAt ?? 0) <= 0) return false;
  return policy.mode === "count" || now - archiveCandidateLastActivity(candidate) >= policy.inactivityDays * 86_400_000;
}

/** Main-process housekeeping. Only explicit start() schedules it, so registry
 * construction and startup discovery never wait on archive or Git work. */
export class ThreadArchiveSweeper {
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private running?: Promise<void>;
  private readonly abort = new AbortController();
  private status: DesktopThreadArchiveSweepStatus = { running: false, archived: 0, deleted: 0, failed: 0 };

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
  sweep(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    if (this.running) return this.running;
    clearTimeout(this.timer);
    const tally: SweepTally = { archived: 0, deleted: 0, failed: 0 };
    this.publish({ ...tally, running: true, startedAt: Date.now() });
    this.running = this.run(tally).catch((error) => {
      if (!this.abort.signal.aborted) this.fail(tally, error);
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
    // An archive already sent must settle before the registry closes its stores.
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

  private count(tally: SweepTally, error: unknown): void {
    tally.failed += 1;
    tally.error ??= error instanceof Error ? error.message : String(error);
  }

  private fail(tally: SweepTally, error: unknown, threadId?: string): void {
    this.count(tally, error);
    this.deps.onError(error, threadId);
  }

  private async run(tally: SweepTally): Promise<void> {
    const policy = this.deps.getPolicy?.() ?? { ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age" as const };
    try { tally.deleted += await this.deps.cleanupRetention?.((error) => this.count(tally, error)) || 0; }
    catch (error) { if (!this.abort.signal.aborted) this.fail(tally, error); }
    if (!policy.enabled || this.abort.signal.aborted) return;
    const candidates = await this.deps.listCandidates();
    const children = new Map<string, ThreadArchiveCandidate[]>();
    for (const candidate of candidates) {
      const parentId = candidate.thread.codexNativeSubAgent?.parentThreadId;
      if (!parentId) continue;
      const key = buildThreadIdentityKey(candidate.thread.source, parentId);
      children.set(key, [...children.get(key) ?? [], candidate]);
    }
    const groupFor = (root: ThreadArchiveCandidate): ThreadArchiveCandidate[] => {
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
    const eligibleRoots = candidates.filter((candidate) => !candidate.thread.codexNativeSubAgent
      && groupFor(candidate).every((item) => isStaleArchiveCandidate(item, Date.now(), policy) && !this.deps.isBusy(item)));
    const selected = new Set<ThreadArchiveCandidate>();
    if (policy.mode === "count") {
      const projects = new Map<string, ThreadArchiveCandidate[]>();
      for (const candidate of eligibleRoots) {
        if (this.abort.signal.aborted) return;
        // Workspaces that cannot be safely archived are kept in addition to
        // the quota, just like pins and active work.
        try {
          let safe = true;
          const paths = new Set(groupFor(candidate).flatMap(({ thread, overlay }) =>
            [...thread.linkedDirectories, ...overlay?.extraLinkedDirectories ?? []]
              .map((directory) => directory.worktreePath ?? directory.path)));
          for (const cwd of paths) {
            if (!cwd.trim() || !await (this.deps.workspaceIsSafe ?? workspaceIsSafeForAutoArchive)(cwd, this.abort.signal)) {
              safe = false;
              break;
            }
          }
          if (!safe) continue;
        } catch (error) {
          if (!this.abort.signal.aborted) this.fail(tally, error, candidate.thread.id);
          continue;
        }
        const key = this.deps.resolveProject
          ? await this.deps.resolveProject(candidate)
          : candidate.thread.projectKey ?? candidate.thread.linkedDirectories[0]?.path;
        // Unknown project identity must not combine unrelated worktrees into one quota.
        if (!key) continue;
        projects.set(key, [...projects.get(key) ?? [], candidate]);
      }
      for (const group of projects.values()) {
        group.sort((a, b) => archiveCandidateLastActivity(b) - archiveCandidateLastActivity(a)
          || a.thread.id.localeCompare(b.thread.id));
        for (const candidate of group.slice(policy.keepPerProject)) selected.add(candidate);
      }
    } else {
      for (const candidate of eligibleRoots) selected.add(candidate);
    }
    for (const candidate of candidates) {
      if (this.abort.signal.aborted) return;
      if (!selected.has(candidate)) continue;
      const group = groupFor(candidate);
      if (!group.every((item) => isStaleArchiveCandidate(item, Date.now(), policy) && !this.deps.isBusy(item))) continue;
      try {
        const refreshed = await Promise.all(group.map((item) => this.deps.refreshCandidate(item)));
        if (this.abort.signal.aborted) return;
        if (policy.mode === "count" && archiveCandidateLastActivity(refreshed[0]!) > archiveCandidateLastActivity(candidate)) continue;
        if (!refreshed.every((item) => isStaleArchiveCandidate(item, Date.now(), policy) && !this.deps.isBusy(item))) continue;
        const paths = new Set(refreshed.flatMap(({ thread, overlay }) =>
          [...thread.linkedDirectories, ...overlay?.extraLinkedDirectories ?? []]
            .map((directory) => directory.worktreePath ?? directory.path),
        ));
        let safe = true;
        for (const cwd of paths) {
          if (!cwd.trim() || !await (this.deps.workspaceIsSafe ?? workspaceIsSafeForAutoArchive)(cwd, this.abort.signal)) {
            safe = false;
            break;
          }
        }
        if (!safe || this.abort.signal.aborted) continue;
        if (!refreshed.every((item) => !this.deps.isBusy(item)) || !await this.deps.canArchive(refreshed)) continue;
        if (this.abort.signal.aborted) return;
        if (JSON.stringify(this.deps.getPolicy?.() ?? policy) !== JSON.stringify(policy)) return;
        if (await this.deps.archive(refreshed[0]!, refreshed) !== false) tally.archived += 1;
      } catch (error) {
        if (!this.abort.signal.aborted) this.fail(tally, error, candidate.thread.id);
      }
    }
  }
}
