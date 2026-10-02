import { DEFAULT_THREAD_ARCHIVE_POLICY } from "@pwragent/shared";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isStaleArchiveCandidate,
  ThreadArchiveSweeper,
  THREAD_AUTO_ARCHIVE_AGE_MS,
  THREAD_ARCHIVE_SWEEP_INTERVAL_MS,
  THREAD_ARCHIVE_SWEEP_START_DELAY_MS,
  workspaceIsSafeForAutoArchive,
  type ThreadArchiveCandidate,
} from "../app-server/thread-archive-sweeper";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function candidate(id = "old"): ThreadArchiveCandidate {
  return {
    thread: {
      id, title: id, titleSource: "explicit", source: "codex", threadStatus: "notLoaded",
      updatedAt: Date.now() - THREAD_AUTO_ARCHIVE_AGE_MS - 1,
      linkedDirectories: [],
    },
  };
}

function harness(candidates = [candidate()]) {
  const deps = {
    listCandidates: vi.fn(async () => candidates),
    refreshCandidate: vi.fn(async (item: ThreadArchiveCandidate) => item),
    isBusy: vi.fn(() => false),
    canArchive: vi.fn(async () => true),
    archive: vi.fn<ConstructorParameters<typeof ThreadArchiveSweeper>[0]["archive"]>(async () => {}),
    workspaceIsSafe: vi.fn(async (_cwd: string, _signal: AbortSignal) => true),
    onError: vi.fn(),
  };
  return { deps, sweeper: new ThreadArchiveSweeper(deps) };
}

describe("ThreadArchiveSweeper", () => {
  it("starts after a delay, runs hourly, and stops scheduling on shutdown", async () => {
    vi.useFakeTimers();
    const { deps, sweeper } = harness([]);
    sweeper.start();
    sweeper.start();
    expect(deps.listCandidates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(THREAD_ARCHIVE_SWEEP_START_DELAY_MS);
    expect(deps.listCandidates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(THREAD_ARCHIVE_SWEEP_INTERVAL_MS - 1);
    expect(deps.listCandidates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.listCandidates).toHaveBeenCalledTimes(2);
    await sweeper.stop();
    await vi.advanceTimersByTimeAsync(THREAD_ARCHIVE_SWEEP_INTERVAL_MS);
    expect(deps.listCandidates).toHaveBeenCalledTimes(2);
  });

  it("restarts the hourly interval after a manual sweep and reports when the next one runs", async () => {
    vi.useFakeTimers();
    const { deps, sweeper } = harness([]);
    sweeper.start();
    expect(sweeper.getStatus()).toEqual({
      running: false, archived: 0, deleted: 0, failed: 0, nextAt: Date.now() + THREAD_ARCHIVE_SWEEP_START_DELAY_MS,
    });
    await vi.advanceTimersByTimeAsync(THREAD_ARCHIVE_SWEEP_START_DELAY_MS / 2);
    await sweeper.sweep();
    expect(deps.listCandidates).toHaveBeenCalledTimes(1);
    const { finishedAt, nextAt } = sweeper.getStatus();
    expect(nextAt).toBe(finishedAt! + THREAD_ARCHIVE_SWEEP_INTERVAL_MS);
    // The startup timer was replaced, not left to run beside the new interval.
    await vi.advanceTimersByTimeAsync(THREAD_ARCHIVE_SWEEP_INTERVAL_MS - 1);
    expect(deps.listCandidates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.listCandidates).toHaveBeenCalledTimes(2);
    await sweeper.stop();
  });

  it("publishes a running status, then archive, deletion, and failure counts", async () => {
    const { deps, sweeper } = harness([candidate("failed"), candidate("archived"), candidate("cancelled")]);
    const statuses: unknown[] = [];
    const sweeperWithStatus = new ThreadArchiveSweeper({
      ...deps,
      cleanupRetention: async (onFailure) => {
        onFailure(new Error("snapshot ref is locked"));
        return 2;
      },
      onStatus: (status) => { statuses.push(status); },
    });
    deps.archive.mockImplementation(async (item: ThreadArchiveCandidate) => {
      if (item.thread.id === "failed") throw new Error("provider unavailable");
      return item.thread.id !== "cancelled";
    });
    await sweeperWithStatus.sweep();
    expect(statuses).toEqual([
      { running: true, startedAt: expect.any(Number), archived: 0, deleted: 0, failed: 0 },
      {
        running: false, startedAt: expect.any(Number), finishedAt: expect.any(Number),
        archived: 1, deleted: 2, failed: 2, error: "snapshot ref is locked",
      },
    ]);
    // Retention logs its own failures; only the archive failure is logged here.
    expect(deps.onError).toHaveBeenCalledTimes(1);
    await sweeperWithStatus.stop();
    await sweeper.stop();
  });

  it("reports a sweep that fails before it lists threads", async () => {
    const { deps, sweeper } = harness();
    deps.listCandidates.mockRejectedValueOnce(new Error("Codex is restarting"));
    await sweeper.sweep();
    expect(sweeper.getStatus()).toMatchObject({ running: false, archived: 0, failed: 1, error: "Codex is restarting" });
    await sweeper.sweep();
    expect(sweeper.getStatus()).toMatchObject({ archived: 1, failed: 0 });
    expect(sweeper.getStatus().error).toBeUndefined();
    await sweeper.stop();
  });

  it("archives old threads while keeping recent, pinned, active and unknown threads", async () => {
    const recent = candidate("recent");
    recent.thread.updatedAt = Date.now();
    const pinned = candidate("pinned");
    pinned.overlay = { backend: "codex", threadId: "pinned", pinnedRank: "a", extraLinkedDirectories: [] };
    const providerPinned = candidate("provider-pin");
    providerPinned.thread.isPinned = true;
    const active = candidate("active");
    active.thread.threadStatus = "active";
    const unknown = candidate("unknown");
    unknown.thread.updatedAt = undefined;
    const { deps, sweeper } = harness([candidate(), recent, pinned, providerPinned, active, unknown]);
    await sweeper.sweep();
    expect(deps.archive.mock.calls.map(([item]) => item.thread.id)).toEqual(["old"]);
    await sweeper.stop();
  });

  it("uses the 30-day boundary and protects recent views and restores", () => {
    const item = candidate();
    item.thread.updatedAt = Date.now() - THREAD_AUTO_ARCHIVE_AGE_MS;
    expect(isStaleArchiveCandidate(item, Date.now())).toBe(true);
    item.overlay = { backend: "codex", threadId: "old", extraLinkedDirectories: [], lastSeenAt: Date.now() };
    expect(isStaleArchiveCandidate(item, Date.now())).toBe(false);
    item.overlay.lastSeenAt = undefined;
    item.overlay.archiveRestoredAt = Date.now();
    expect(isStaleArchiveCandidate(item, Date.now())).toBe(false);
    item.overlay.archiveRestoredAt = undefined;
    item.overlay.agent = { name: "Agent", updatedAt: 1, instructionLineCount: 0, instructionsTooLong: false };
    expect(isStaleArchiveCandidate(item, Date.now())).toBe(false);
  });

  it("protects parents with recent nested native descendants", async () => {
    const child = candidate("child");
    child.thread.codexNativeSubAgent = { parentThreadId: "old" };
    const grandchild = candidate("grandchild");
    grandchild.thread.codexNativeSubAgent = { parentThreadId: "child" };
    grandchild.thread.updatedAt = Date.now();
    const { deps, sweeper } = harness([candidate(), child, grandchild]);
    await sweeper.sweep();
    expect(deps.archive).not.toHaveBeenCalled();
    await sweeper.stop();
  });

  it("checks every workspace in an eligible native family and rejects dirty ones", async () => {
    const child = candidate("child");
    child.thread.codexNativeSubAgent = { parentThreadId: "old" };
    child.thread.linkedDirectories = [{ id: "child-dir", label: "child", path: "/repo", worktreePath: "/worktrees/child", kind: "worktree" }];
    const { deps, sweeper } = harness([candidate(), child]);
    deps.workspaceIsSafe.mockResolvedValue(false);
    await sweeper.sweep();
    expect(deps.workspaceIsSafe).toHaveBeenCalledWith("/worktrees/child", expect.any(AbortSignal));
    expect(deps.archive).not.toHaveBeenCalled();
    await sweeper.stop();
  });

  it("rechecks activity after listing and busy state after asynchronous Git probes", async () => {
    const item = candidate();
    item.thread.linkedDirectories = [{ id: "dir", label: "repo", path: "/repo", kind: "local" }];
    const { deps, sweeper } = harness([item]);
    deps.refreshCandidate.mockResolvedValueOnce({ ...item, thread: { ...item.thread, updatedAt: Date.now() } });
    await sweeper.sweep();
    expect(deps.workspaceIsSafe).not.toHaveBeenCalled();
    deps.workspaceIsSafe.mockImplementation(async () => {
      deps.isBusy.mockReturnValue(true);
      return true;
    });
    await sweeper.sweep();
    expect(deps.archive).not.toHaveBeenCalled();
    await sweeper.stop();
  });

  it("continues after a failed archive and rejects a final admission failure", async () => {
    const { deps, sweeper } = harness([candidate("failed"), candidate("next")]);
    deps.archive.mockRejectedValueOnce(new Error("provider unavailable"));
    await sweeper.sweep();
    expect(deps.archive).toHaveBeenCalledTimes(2);
    expect(deps.onError).toHaveBeenCalledWith(expect.any(Error), "failed");
    deps.archive.mockClear();
    deps.canArchive.mockResolvedValue(false);
    await sweeper.sweep();
    expect(deps.archive).not.toHaveBeenCalled();
    await sweeper.stop();
  });

  it("coalesces overlapping sweeps and drains an in-flight archive before stopping", async () => {
    const { deps, sweeper } = harness();
    let finish!: () => void;
    const archivePending = new Promise<void>((resolve) => { finish = resolve; });
    deps.archive.mockImplementation(async () => await archivePending);
    const pending = sweeper.sweep();
    expect(sweeper.sweep()).toBe(pending);
    await vi.waitFor(() => expect(deps.archive).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stop = sweeper.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await stop;
    await sweeper.sweep();
    expect(deps.archive).toHaveBeenCalledTimes(1);
  });
});

describe("workspaceIsSafeForAutoArchive", () => {
  it("accepts unpushed local branches and retained detached tips, but rejects loose commits and uncommitted files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-auto-archive-"));
    tempDirs.push(root);
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const git = async (...args: string[]) => await execFileAsync("git", ["-C", repo, ...args]);
    await git("init", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test User");
    await writeFile(path.join(repo, "file.txt"), "committed\n");
    await writeFile(path.join(repo, ".gitignore"), ".env\nlocal-data/\n");
    await git("add", ".");
    await git("-c", "commit.gpgsign=false", "commit", "-m", "initial");
    const signal = new AbortController().signal;
    expect(await workspaceIsSafeForAutoArchive(repo, signal)).toBe(true);
    await writeFile(path.join(repo, ".env"), "private local configuration\n");
    expect(await workspaceIsSafeForAutoArchive(repo, signal)).toBe(false);
    await rm(path.join(repo, ".env"));
    await mkdir(path.join(repo, "local-data"));
    await writeFile(path.join(repo, "local-data", "data.txt"), "local data\n");
    expect(await workspaceIsSafeForAutoArchive(repo, signal)).toBe(false);
    await rm(path.join(repo, "local-data"), { recursive: true });
    expect(await workspaceIsSafeForAutoArchive(repo, signal)).toBe(true);
    await writeFile(path.join(repo, "file.txt"), "dirty\n");
    expect(await workspaceIsSafeForAutoArchive(repo, signal)).toBe(false);
    await git("add", ".");
    expect(await workspaceIsSafeForAutoArchive(repo, signal)).toBe(false);
    await git("-c", "commit.gpgsign=false", "commit", "-m", "local only");
    expect(await workspaceIsSafeForAutoArchive(repo, signal)).toBe(true);
    await writeFile(path.join(repo, "untracked.txt"), "unsaved work\n");
    expect(await workspaceIsSafeForAutoArchive(repo, signal)).toBe(false);
    await rm(path.join(repo, "untracked.txt"));
    await git("checkout", "--detach");
    expect(await workspaceIsSafeForAutoArchive(repo, signal)).toBe(true);
    await writeFile(path.join(repo, "file.txt"), "detached commit\n");
    await git("add", ".");
    await git("-c", "commit.gpgsign=false", "commit", "-m", "detached only");
    expect(await workspaceIsSafeForAutoArchive(repo, signal)).toBe(false);
    await git("branch", "retained-local-work");
    expect(await workspaceIsSafeForAutoArchive(repo, signal)).toBe(true);
    expect(await workspaceIsSafeForAutoArchive(path.join(root, "deleted-worktree"), signal)).toBe(true);
    await expect(workspaceIsSafeForAutoArchive(root, signal)).rejects.toThrow();
  });
});


describe("archive policy selection", () => {
  it("keeps 20 eligible chats separately per project, plus pins, Agents and active work", async () => {
    const candidates: ThreadArchiveCandidate[] = [];
    for (const [project, count] of [["one", 23], ["two", 21]] as const) {
      for (let i = 0; i < count; i++) {
        const item = candidate(`${project}-${i}`);
        item.thread.projectKey = project;
        item.thread.updatedAt! -= i * 1000;
        candidates.push(item);
      }
    }
    const pinned = candidate("pinned"); pinned.thread.projectKey = "one"; pinned.thread.isPinned = true;
    const active = candidate("active"); active.thread.projectKey = "one"; active.thread.threadStatus = "active";
    const agent = candidate("agent"); agent.thread.projectKey = "one";
    agent.overlay = { backend: "codex", threadId: "agent", executionMode: "default", extraLinkedDirectories: [], agent: {} as never };
    candidates.push(pinned, active, agent);
    const { deps } = harness(candidates);
    await new ThreadArchiveSweeper({ ...deps, getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY }) }).sweep();
    expect(deps.archive.mock.calls.map(([item]) => item.thread.id).sort()).toEqual(["one-20", "one-21", "one-22", "two-20"]);
  });

  it("keeps dirty workspaces in addition to the eligible project limit", async () => {
    const candidates = [candidate("clean-new"), candidate("dirty-new"), candidate("clean-old")];
    for (const item of candidates) item.thread.projectKey = "project";
    candidates[2]!.thread.updatedAt! -= 1000;
    candidates[1]!.thread.linkedDirectories = [{ id: "dirty", label: "dirty", kind: "local", path: "/dirty" }];
    const { deps } = harness(candidates);
    deps.workspaceIsSafe.mockImplementation(async (cwd) => cwd !== "/dirty");
    await new ThreadArchiveSweeper({ ...deps, getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, keepPerProject: 2 }) }).sweep();
    expect(deps.archive).not.toHaveBeenCalled();
  });

  it("defers an old count candidate that became active after the project ranking", async () => {
    const old = candidate("old"); old.thread.projectKey = "project";
    const newer = candidate("newer"); newer.thread.projectKey = "project"; newer.thread.updatedAt! += 1000;
    const { deps } = harness([old, newer]);
    deps.refreshCandidate.mockImplementation(async (item) => ({ ...item, thread: { ...item.thread, updatedAt: Date.now() } }));
    await new ThreadArchiveSweeper({ ...deps, getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, keepPerProject: 1 }) }).sweep();
    expect(deps.archive).not.toHaveBeenCalled();
  });

  it("uses seven days of inactivity in age mode and supports turning archival off", async () => {
    const old = candidate("old"); old.thread.updatedAt = Date.now() - 8 * 86_400_000;
    const recent = candidate("recent"); recent.thread.updatedAt = Date.now() - 6 * 86_400_000;
    const { deps } = harness([old, recent]);
    let policy = { ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age" as const };
    const sweeper = new ThreadArchiveSweeper({ ...deps, getPolicy: () => policy });
    await sweeper.sweep();
    expect(deps.archive.mock.calls.map(([item]) => item.thread.id)).toEqual(["old"]);
    policy = { ...policy, enabled: false };
    await sweeper.sweep();
    expect(deps.archive).toHaveBeenCalledTimes(1);
  });
});
