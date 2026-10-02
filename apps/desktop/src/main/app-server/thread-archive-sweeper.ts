import { stat } from "node:fs/promises";
import type { AppServerThreadSummary, ThreadOverlayState } from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { runGitCommand } from "./git-executable";

export const THREAD_AUTO_ARCHIVE_AGE_MS = 30 * 24 * 60 * 60_000;
export const THREAD_ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60_000;
export const THREAD_ARCHIVE_SWEEP_START_DELAY_MS = 60_000;

export type ThreadArchiveCandidate = {
  thread: AppServerThreadSummary;
  overlay?: ThreadOverlayState;
};

type SweeperDeps = {
  listCandidates: () => Promise<ThreadArchiveCandidate[]>;
  refreshCandidate: (candidate: ThreadArchiveCandidate) => Promise<ThreadArchiveCandidate>;
  isBusy: (candidate: ThreadArchiveCandidate) => boolean;
  canArchive: (candidates: ThreadArchiveCandidate[]) => Promise<boolean>;
  archive: (candidate: ThreadArchiveCandidate) => Promise<unknown>;
  workspaceIsSafe?: (cwd: string, signal: AbortSignal) => Promise<boolean>;
  onError: (error: unknown, threadId?: string) => void;
};

/** Reads live Git state, including untracked files and dirty submodules. A
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
    "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
  ], options);
  if (status.stdout.trim()) return false;
  const retained = await runGitCommand(cwd, [
    "rev-list", "--count", "HEAD", "--not", "--branches", "--remotes",
  ], options);
  return retained.stdout.trim() === "0";
}

export function isStaleArchiveCandidate(candidate: ThreadArchiveCandidate, now: number): boolean {
  const { thread, overlay } = candidate;
  if (thread.archivedAt !== undefined
    || thread.isPinned
    || overlay?.archiveTombstonedAt !== undefined
    || overlay?.pinnedRank !== undefined
    || overlay?.agent
    || overlay?.queuedAgentChange
    || overlay?.scheduledStart?.state === "scheduled"
    || overlay?.prAutoDispatchPending
    || (overlay?.codexEnvironmentRuntime ?? thread.codexEnvironmentRuntime)?.executionTarget === "remote"
    || overlay?.subAgents?.some((agent) => ["running", "pending", "cancelling", "blocked"].includes(agent.status))
    || (thread.threadStatus !== "idle" && thread.threadStatus !== "notLoaded")) {
    return false;
  }
  // A missing activity timestamp is not evidence that a thread is abandoned.
  if (!Number.isFinite(thread.updatedAt) || (thread.updatedAt ?? 0) <= 0) return false;
  const lastActivityAt = Math.max(
    thread.updatedAt!,
    overlay?.lastSeenAt ?? 0,
    overlay?.archiveRestoredAt ?? 0,
    ...(overlay?.worktreeSnapshots ?? []).map((snapshot) => snapshot.restoredAt ?? 0),
  );
  return now - lastActivityAt >= THREAD_AUTO_ARCHIVE_AGE_MS;
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
    for (const candidate of candidates) {
      if (this.abort.signal.aborted) return;
      if (candidate.thread.codexNativeSubAgent) continue;
      const group = groupFor(candidate);
      if (!group.every((item) => isStaleArchiveCandidate(item, Date.now()) && !this.deps.isBusy(item))) continue;
      try {
        const refreshed = await Promise.all(group.map((item) => this.deps.refreshCandidate(item)));
        if (this.abort.signal.aborted) return;
        if (!refreshed.every((item) => isStaleArchiveCandidate(item, Date.now()) && !this.deps.isBusy(item))) continue;
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
        await this.deps.archive(refreshed[0]!);
      } catch (error) {
        if (!this.abort.signal.aborted) this.deps.onError(error, candidate.thread.id);
      }
    }
  }
}
