import { DEFAULT_THREAD_ARCHIVE_POLICY } from "@pwragent/shared";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  archiveCandidateProtectionReason,
  CLAUDE_CHECKOUT_KEEP_REASON,
  keepSubthreadParents,
  subthreadChildren,
  subthreadsFirst,
  isProtectedArchiveCandidate,
  isStaleArchiveCandidate,
  ThreadArchiveSweeper,
  THREAD_AUTO_ARCHIVE_AGE_MS,
  THREAD_ARCHIVE_SWEEP_INTERVAL_MS,
  THREAD_ARCHIVE_SWEEP_START_DELAY_MS,
  workspaceArchiveBlocker,
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
    canArchive: vi.fn(async (_family: ThreadArchiveCandidate[]) => true),
    archive: vi.fn<ConstructorParameters<typeof ThreadArchiveSweeper>[0]["archive"]>(async () => {}),
    workspaceIsSafe: vi.fn(async (_cwd: string, _signal: AbortSignal) => true),
    onError: vi.fn(),
  };
  return { deps, sweeper: new ThreadArchiveSweeper(deps) };
}

describe("ThreadArchiveSweeper", () => {
  it("reports worktree cleanup independently of conversation policies and joins concurrent sweeps", async () => {
    const { deps } = harness([]);
    let release!: () => void;
    const cleanupWorktrees = vi.fn<NonNullable<ConstructorParameters<typeof ThreadArchiveSweeper>[0]["cleanupWorktrees"]>>(async ({ manual, onProgress, onFailure }) => {
      expect(manual).toBe(true);
      onProgress({ candidates: 501, protected: 3, processed: 0, removed: 0 });
      await new Promise<void>((resolve) => { release = resolve; });
      onProgress({ candidates: 501, protected: 3, processed: 501, removed: 500 });
      onFailure(new Error("Snapshot size limit exceeded"));
    });
    const sweeper = new ThreadArchiveSweeper({ ...deps, cleanupWorktrees,
      getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, enabled: false }) });
    const run = sweeper.sweep({ manual: true });
    expect(sweeper.getStatus()).toMatchObject({ running: true, worktrees: { candidates: 501, processed: 0 } });
    expect(sweeper.sweep({ manual: true })).toBe(run);
    release();
    await run;
    expect(cleanupWorktrees).toHaveBeenCalledOnce();
    expect(deps.listCandidates).not.toHaveBeenCalled();
    expect(sweeper.getStatus()).toMatchObject({ running: false, archived: 0, failed: 1,
      worktrees: { candidates: 501, protected: 3, processed: 501, removed: 500 }, error: "Snapshot size limit exceeded" });
    await sweeper.stop();
  });

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
        failures: [
          { phase: "retention", message: "snapshot ref is locked" },
          { phase: "threads", message: "provider unavailable", threadId: "failed" },
        ],
        threads: { checked: 3, eligible: 3, archived: 1, kept: { "Archive cancelled": 1 } },
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

  it("records a failed thread listing and still reports worktree and retention results", async () => {
    const { deps } = harness();
    deps.listCandidates.mockRejectedValueOnce(new Error("Codex is restarting"));
    const sweeper = new ThreadArchiveSweeper({ ...deps,
      cleanupWorktrees: async ({ onProgress }) => { onProgress({ candidates: 2, protected: 0, processed: 2, removed: 2 }); },
      cleanupRetention: async () => 1,
    });
    await sweeper.sweep();
    expect(sweeper.getStatus()).toMatchObject({
      deleted: 1, failed: 1, worktrees: { removed: 2 },
      threads: { checked: 0, archived: 0, skipped: "Threads could not be listed" },
      failures: [{ phase: "threads", message: "Codex is restarting" }],
    });
    await sweeper.stop();
  });

  it("reports every failure with its path or thread, up to the cap", async () => {
    const { deps } = harness([candidate("failed"), candidate("next")]);
    deps.archive.mockImplementation(async (item: ThreadArchiveCandidate) => {
      if (item.thread.id === "failed") throw new Error("provider unavailable");
    });
    const sweeper = new ThreadArchiveSweeper({ ...deps,
      cleanupWorktrees: async ({ onFailure }) => {
        onFailure(new Error("ENOENT: realpath '/gone'"), { path: "/worktrees/one" });
        onFailure(new Error("EACCES"), { path: "/worktrees/two" });
      },
    });
    await sweeper.sweep();
    expect(sweeper.getStatus()).toMatchObject({ archived: 1, failed: 3, error: "ENOENT: realpath '/gone'" });
    expect(sweeper.getStatus().failures).toEqual([
      { phase: "worktrees", message: "ENOENT: realpath '/gone'", path: "/worktrees/one" },
      { phase: "worktrees", message: "EACCES", path: "/worktrees/two" },
      { phase: "threads", message: "provider unavailable", threadId: "failed" },
    ]);
    const capped = new ThreadArchiveSweeper({ ...harness([]).deps,
      cleanupWorktrees: async ({ onFailure }) => {
        for (let index = 0; index < 25; index++) onFailure(new Error(`failure ${index}`), { path: `/w/${index}` });
      },
    });
    await capped.sweep();
    expect(capped.getStatus().failed).toBe(25);
    expect(capped.getStatus().failures).toHaveLength(20);
    await sweeper.stop();
    await capped.stop();
  });

  it("counts why each thread was kept", async () => {
    const recent = candidate("recent");
    recent.thread.updatedAt = Date.now();
    const pinned = candidate("pinned");
    pinned.thread.isPinned = true;
    const dirty = candidate("dirty");
    dirty.thread.linkedDirectories = [{ id: "dirty", label: "dirty", kind: "local", path: "/dirty" }];
    const ignored = candidate("ignored");
    ignored.thread.linkedDirectories = [{ id: "ignored", label: "ignored", kind: "local", path: "/ignored" }];
    const unreadable = candidate("unreadable");
    unreadable.unreadable = true;
    const { deps } = harness([candidate(), recent, pinned, dirty, ignored, unreadable]);
    const sweeper = new ThreadArchiveSweeper({ ...deps,
      workspaceArchiveBlocker: async (cwd) => cwd === "/dirty" ? "Uncommitted changes" : cwd === "/ignored" ? "Ignored files only" : undefined,
    });
    await sweeper.sweep();
    expect(deps.archive.mock.calls.map(([item]) => item.thread.id)).toEqual(["old"]);
    expect(sweeper.getStatus().threads).toEqual({
      checked: 6, eligible: 3, archived: 1,
      kept: { "Recently active": 1, "Pinned thread": 1, "Uncommitted changes": 1, "Ignored files only": 1, "Thread state unreadable": 1 },
    });
    await sweeper.stop();
  });

  it("says the thread pass was skipped when automatic archiving is off", async () => {
    const { deps } = harness();
    const sweeper = new ThreadArchiveSweeper({ ...deps, getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, enabled: false }) });
    await sweeper.sweep();
    expect(sweeper.getStatus().threads).toMatchObject({ checked: 0, skipped: "Automatic archiving is off" });
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

  it("never archives or deletes threads in Codex chat folders", async () => {
    const linked = candidate("codex-chat");
    linked.thread.linkedDirectories = [
      { id: "chat", kind: "local", label: "chat", path: "/Users/tester/Documents/Codex/2026-05-08/chat" },
    ];
    const extra = candidate("codex-chat-extra");
    extra.overlay = { backend: "codex", threadId: "codex-chat-extra", extraLinkedDirectories: [
      { id: "chat", kind: "local", label: "chat", path: "C:\\Users\\tester\\Documents\\Codex\\2026-05-08\\chat" },
    ] };
    const lookalike = candidate("lookalike");
    lookalike.thread.linkedDirectories = [
      { id: "repo", kind: "local", label: "repo", path: "/Users/tester/Documents/Codex-tools/repo" },
    ];
    expect(archiveCandidateProtectionReason(linked)).toBe("Codex chat folder");
    expect(isProtectedArchiveCandidate(extra)).toBe(true);
    expect(isProtectedArchiveCandidate(lookalike)).toBe(false);
    for (const mode of ["age", "count"] as const) {
      const items = [linked, extra, lookalike].map((item) => ({ ...item, thread: { ...item.thread, projectKey: "project" } }));
      const { deps } = harness(items);
      const policy = { ...DEFAULT_THREAD_ARCHIVE_POLICY, mode, keepPerProject: 0 };
      const sweeper = new ThreadArchiveSweeper({ ...deps, getPolicy: () => policy });
      await sweeper.sweep();
      expect(deps.archive.mock.calls.map(([item]) => item.thread.id)).toEqual(["lookalike"]);
      await sweeper.stop();
    }
  });

  it("never archives a thread that an active PR watch will wake", async () => {
    const watched = { ...candidate("watched"), activePrWatch: true };
    expect(archiveCandidateProtectionReason(watched)).toBe("Watching a PR");
    expect(isStaleArchiveCandidate(watched, Date.now())).toBe(false);
    const { deps, sweeper } = harness([watched, candidate()]);
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
  });

  it("accepts a directory outside any repository, but rejects a broken worktree link", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-auto-archive-"));
    tempDirs.push(root);
    const signal = new AbortController().signal;
    const scratch = path.join(root, "scratch-project");
    await mkdir(scratch);
    await writeFile(path.join(scratch, "notes.txt"), "scratch work\n");
    expect(await workspaceIsSafeForAutoArchive(scratch, signal)).toBe(true);
    const broken = path.join(root, "broken-worktree");
    await mkdir(broken);
    await writeFile(path.join(broken, ".git"), `gitdir: ${path.join(root, "missing", ".git", "worktrees", "x")}\n`);
    await expect(workspaceIsSafeForAutoArchive(broken, signal)).rejects.toThrow(
      /not a git repository|gitfile does not point to a valid repository/,
    );
  });

  it("names ignored-only checkouts separately from uncommitted changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-auto-archive-"));
    tempDirs.push(root);
    const signal = new AbortController().signal;
    const git = (...args: string[]) => execFileAsync("git", ["-C", root, ...args]);
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
    await git("add", ".gitignore");
    await git("commit", "-q", "-m", "init");
    expect(await workspaceArchiveBlocker(root, signal)).toBeUndefined();
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "node_modules", "dep.js"), "x\n");
    expect(await workspaceArchiveBlocker(root, signal)).toBe("Ignored files only");
    expect(await workspaceIsSafeForAutoArchive(root, signal)).toBe(false);
    await writeFile(path.join(root, "notes.txt"), "work\n");
    expect(await workspaceArchiveBlocker(root, signal)).toBe("Uncommitted changes");
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

  it("isolates a project lookup failure to its own thread", async () => {
    const a1 = candidate("a1"); a1.thread.projectKey = "a";
    const a2 = candidate("a2"); a2.thread.projectKey = "a"; a2.thread.updatedAt! -= 1000;
    const b1 = candidate("b1"); b1.thread.projectKey = "b";
    const { deps } = harness([a1, a2, b1]);
    const sweeper = new ThreadArchiveSweeper({ ...deps,
      getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, keepPerProject: 1 }),
      resolveProject: async (item) => {
        if (item.thread.id === "b1") throw new Error("git timed out");
        return item.thread.projectKey;
      },
    });
    await sweeper.sweep();
    expect(deps.archive.mock.calls.map(([item]) => item.thread.id)).toEqual(["a2"]);
    expect(sweeper.getStatus()).toMatchObject({
      archived: 1, failed: 1, failures: [{ phase: "threads", message: "git timed out", threadId: "b1" }],
      threads: { checked: 3, eligible: 3, archived: 1, kept: { "Within the per-project limit": 1 } },
    });
    await sweeper.stop();
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

describe("sub-thread parents", () => {
  it("keeps a selected parent only while it would leave more than 2 sub-threads, repeating as parents drop out", () => {
    // grand -> mid (selected) -> 3 unselected children; grand also has 2 more.
    const children = new Map([
      ["codex:grand", ["codex:mid", "codex:g1", "codex:g2"]],
      ["codex:mid", ["codex:m1", "codex:m2", "codex:m3"]],
    ]);
    const selected = new Set(["codex:grand", "codex:mid", "codex:g1", "codex:g2"]);
    // mid leaves 3 behind, so it stays; then grand would leave mid behind
    // only, which is within the limit.
    expect(keepSubthreadParents(selected, children)).toEqual(["codex:mid"]);
    expect([...selected].sort()).toEqual(["codex:g1", "codex:g2", "codex:grand"]);
  });

  it("never leaves a selected parent with more than 2 unselected sub-threads", () => {
    const ids = fc.constantFrom(...Array.from({ length: 8 }, (_, index) => `codex:t${index}`));
    fc.assert(fc.property(
      fc.array(fc.tuple(ids, ids), { maxLength: 24 }),
      fc.uniqueArray(ids, { maxLength: 8 }),
      (edges, chosen) => {
        const children = new Map<string, string[]>();
        for (const [parent, child] of edges) {
          if (parent !== child) children.set(parent, [...new Set([...children.get(parent) ?? [], child])]);
        }
        const selected = new Set(chosen);
        const kept = keepSubthreadParents(selected, children);
        for (const key of selected) {
          expect((children.get(key) ?? []).filter((child) => !selected.has(child)).length).toBeLessThanOrEqual(2);
        }
        for (const key of kept) expect(selected.has(key)).toBe(false);
      },
    ));
  });

  it("cleans up a Claude thread only in a worktree PwrAgent created", () => {
    const claude = (projectKey: string, directory: Record<string, unknown> = {}): ThreadArchiveCandidate => ({
      thread: { ...candidate("c").thread, source: "claude", projectKey,
        linkedDirectories: [{ id: "d", label: "repo", path: "/src/repo", kind: "local", ...directory }] },
    });
    const managed = "/Users/me/.pwragent/worktrees/k3m9/repo";
    expect(archiveCandidateProtectionReason(claude(managed, { worktreePath: managed }))).toBeUndefined();
    expect(archiveCandidateProtectionReason(claude("/Users/me/.pwragent/profiles/work/worktrees/k3m9/repo"))).toBeUndefined();
    for (const independent of [
      "/src/repo",
      "/src/repo/.claude/worktrees/fix-login",
      "/Users/me/.claude/worktrees/fix-login",
      "/Users/me/.codex/worktrees/a1b2/repo",
    ]) {
      expect(archiveCandidateProtectionReason(claude(independent))).toBe(CLAUDE_CHECKOUT_KEEP_REASON);
    }
    expect(archiveCandidateProtectionReason(claude(managed, { worktreePath: "/src/repo/.claude/worktrees/x" })))
      .toBe(CLAUDE_CHECKOUT_KEEP_REASON);
    expect(archiveCandidateProtectionReason(claude(managed, { worktreeOwnership: "external" })))
      .toBe(CLAUDE_CHECKOUT_KEEP_REASON);
    // Other providers keep their own rules.
    expect(archiveCandidateProtectionReason({ thread: { ...candidate("x").thread, projectKey: "/src/repo" } })).toBeUndefined();
  });

  it("never offers a Claude thread outside PwrAgent's worktree root", () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom(".pwragent", ".pwragnt", ".codex", ".claude", "src", "worktrees", "profiles", "work", "k3m9", "repo"),
        { minLength: 1, maxLength: 7 }),
      (segments) => {
        const projectKey = `/Users/me/${segments.join("/")}`;
        const reason = archiveCandidateProtectionReason({
          thread: { ...candidate("c").thread, source: "claude", projectKey, linkedDirectories: [] },
        });
        if (reason === undefined) {
          expect(projectKey).toMatch(/\/\.pwrag(?:ent|nt)\/(?:profiles\/[^/]+\/)?worktrees\/[^/]+\/[^/]+/);
        }
      },
    ));
  });

  it("orders every thread after all of its sub-threads, however deep", () => {
    fc.assert(fc.property(
      fc.array(fc.nat({ max: 12 }), { minLength: 1, maxLength: 13 }),
      fc.array(fc.nat({ max: 12 }), { maxLength: 13 }),
      (parents, order) => {
        // Node i's parent is an earlier node, so the links form a forest.
        const nodes = parents.map((parent, index) => ({
          thread: { ...candidate(`n${index}`).thread },
          ...(index > 0 && parent % (index + 1) !== index
            ? { overlay: { parentThreadId: `n${parent % index}` } as ThreadArchiveCandidate["overlay"] }
            : {}),
        }));
        const shuffled = [...nodes];
        for (const [index, swap] of order.entries()) {
          const a = index % shuffled.length;
          const b = swap % shuffled.length;
          [shuffled[a], shuffled[b]] = [shuffled[b]!, shuffled[a]!];
        }
        const position = new Map(subthreadsFirst(shuffled).map(({ thread }, index) => [thread.id, index]));
        for (const node of nodes) {
          const parent = node.overlay?.parentThreadId;
          if (parent) expect(position.get(node.thread.id)!).toBeLessThan(position.get(parent)!);
        }
      },
    ));
  });

  it("keeps a parent when sub-threads kept during the sweep would leave 3 behind", async () => {
    const parent = candidate("parent");
    const child = (id: string): ThreadArchiveCandidate => ({
      ...candidate(id), overlay: { parentThreadId: "parent" } as ThreadArchiveCandidate["overlay"],
    });
    const { deps, sweeper } = harness([parent, child("a"), child("b"), child("c"), child("d")]);
    // Refused only when the run reaches them, after the up-front parent rule.
    deps.canArchive.mockImplementation(async (family: ThreadArchiveCandidate[]) => !["a", "b", "c"].includes(family[0]!.thread.id));
    await sweeper.sweep();
    expect(deps.archive.mock.calls.map(([item]) => item.thread.id)).toEqual(["d"]);
    await sweeper.stop();
  });

  it("counts only local, non-archived sub-threads and orders them before parents", () => {
    const row = (id: string, overlay?: Record<string, unknown>) => ({
      thread: { ...candidate(id).thread },
      ...(overlay ? { overlay: overlay as ThreadArchiveCandidate["overlay"] } : {}),
    });
    const candidates = [
      row("parent"),
      row("local", { parentThreadId: "parent" }),
      row("peer", { parentThreadId: "parent", parentThreadInstanceId: "pwr_peer" }),
      row("archived", { parentThreadId: "parent", archiveRetentionStartedAt: 1 }),
    ];
    expect(subthreadChildren(candidates)).toEqual(new Map([["codex:parent", ["codex:local"]]]));
    expect(subthreadsFirst(candidates).map(({ thread }) => thread.id)).toEqual(["local", "peer", "archived", "parent"]);
  });
});
