import { stat } from "node:fs/promises";
import type { AppServerThreadSummary, ThreadOverlayState } from "@pwragent/shared";
import { DEFAULT_THREAD_ARCHIVE_POLICY, type DesktopThreadArchivePolicy, buildThreadIdentityKey } from "@pwragent/shared";
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
  cleanupRetention?: () => Promise<void>;
  listCandidates: () => Promise<ThreadArchiveCandidate[]>;
  refreshCandidate: (candidate: ThreadArchiveCandidate) => Promise<ThreadArchiveCandidate>;
  isBusy: (candidate: ThreadArchiveCandidate) => boolean;
  canArchive: (candidates: ThreadArchiveCandidate[]) => Promise<boolean>;
  archive: (candidate: ThreadArchiveCandidate, family: ThreadArchiveCandidate[]) => Promise<unknown>;
  workspaceIsSafe?: (cwd: string, signal: AbortSignal) => Promise<boolean>;
  onError: (error: unknown, threadId?: string) => void;
};

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
  const status = await runGitCommand(cwd, [
    "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none",
  ], options);
  if (status.stdout.trim()) return false;
  const retained = await runGitCommand(cwd, [
    "rev-list", "--count", "HEAD", "--not", "--branches", "--remotes",
  ], options);
  return retained.stdout.trim() === "0";
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
  private timer?: ReturnType<typeof setInterval>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private readonly abort = new AbortController();

  constructor(private readonly deps: SweeperDeps) {}

  start(): void {
    if (this.timer || this.abort.signal.aborted) return;
    this.startupTimer = setTimeout(() => { void this.sweep(); }, THREAD_ARCHIVE_SWEEP_START_DELAY_MS);
    this.startupTimer.unref?.();
    this.timer = setInterval(() => { void this.sweep(); }, THREAD_ARCHIVE_SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  sweep(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().catch((error) => {
      if (!this.abort.signal.aborted) this.deps.onError(error);
    }).finally(() => { this.running = undefined; });
    return this.running;
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    clearTimeout(this.startupTimer);
    this.abort.abort();
    // An archive already sent must settle before the registry closes its stores.
    await this.running;
  }

  private async run(): Promise<void> {
    const policy = this.deps.getPolicy?.() ?? { ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age" as const };
    try { await this.deps.cleanupRetention?.(); }
    catch (error) { if (!this.abort.signal.aborted) this.deps.onError(error); }
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
          if (!this.abort.signal.aborted) this.deps.onError(error, candidate.thread.id);
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
        await this.deps.archive(refreshed[0]!, refreshed);
      } catch (error) {
        if (!this.abort.signal.aborted) this.deps.onError(error, candidate.thread.id);
      }
    }
  }
}
