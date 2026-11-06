import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { DEFAULT_THREAD_ARCHIVE_POLICY, REBUILDABLE_OUTPUT_NAMES, type ThreadMaintenanceWorkspace } from "@pwragent/shared";
import type { ThreadArchiveCandidate } from "../app-server/thread-archive-sweeper";
import {
  ThreadMaintenanceService,
  type ArchivedCheckoutRemoval,
  type ThreadMaintenanceDeps,
} from "../app-server/thread-maintenance-service";
import { inspectMaintenanceWorkspace, rebuildableOutputFolder } from "../app-server/thread-maintenance-workspace";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-maintenance-"));
  tempDirs.push(root);
  return root;
}

async function gitRepo(root: string, name = "repo"): Promise<{ repo: string; git: (...args: string[]) => Promise<unknown> }> {
  const repo = path.join(root, name);
  await mkdir(repo);
  const git = async (...args: string[]) => await execFileAsync("git", ["-C", repo, ...args]);
  await git("init", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test User");
  await writeFile(path.join(repo, "file.txt"), "committed\n");
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\ndist/\n.env.local\n");
  await git("add", ".");
  await git("-c", "commit.gpgsign=false", "commit", "-m", "initial");
  return { repo, git };
}

function candidate(id: string, options: { daysIdle?: number; cwd?: string; pinned?: boolean; parent?: string } = {}): ThreadArchiveCandidate {
  return {
    thread: {
      id, title: `Thread ${id}`, titleSource: "explicit", source: "codex", threadStatus: "notLoaded",
      updatedAt: NOW - (options.daysIdle ?? 30) * DAY,
      ...(options.pinned ? { isPinned: true } : {}),
      ...(options.parent ? { codexNativeSubAgent: { parentThreadId: options.parent } } : {}),
      linkedDirectories: options.cwd ? [{ id: options.cwd, label: "repo", path: "/projects/app", worktreePath: options.cwd, kind: "worktree" }] : [],
    } as ThreadArchiveCandidate["thread"],
  };
}

function harness(candidates: ThreadArchiveCandidate[], overrides: Partial<ThreadMaintenanceDeps> = {}) {
  let id = 0;
  const workspaces = new Map<string, ThreadMaintenanceWorkspace | { keep: string }>();
  const deps: ThreadMaintenanceDeps = {
    getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "count", keepPerProject: 1 }),
    snapshotLimitBytes: 100,
    listCandidates: vi.fn(async () => candidates),
    resolveProject: vi.fn(async () => "/projects/app"),
    refreshCandidate: vi.fn(async (item: ThreadArchiveCandidate) => item),
    isBusy: vi.fn(() => false),
    auditArchivedCheckouts: vi.fn(async () => ({ candidates: [], kept: {}, emptyFolders: 0 })),
    archiveFamily: vi.fn(async () => true),
    removeArchivedCheckouts: vi.fn(async () => ({ removed: [], kept: [], failed: [], emptyFoldersRemoved: 0, emptyFoldersFailed: [] })),
    isManagedCheckoutPath: () => true,
    trashItem: vi.fn(async () => {}),
    inspectWorkspace: vi.fn(async (cwd: string) => {
      const value = workspaces.get(cwd) ?? { kind: "clean" as const };
      return "keep" in value ? { keep: value.keep } : { workspace: value };
    }),
    now: () => NOW,
    newId: () => `id-${++id}`,
    ...overrides,
  };
  return { deps, workspaces, service: new ThreadMaintenanceService(deps) };
}

describe("ThreadMaintenanceService.scan", () => {
  it("keeps the newest per project, lists the rest as idle oldest first, and counts every keep reason", async () => {
    const { service, workspaces } = harness([
      candidate("newest", { daysIdle: 1, cwd: "/w/newest" }),
      candidate("old", { daysIdle: 40, cwd: "/w/old" }),
      candidate("older", { daysIdle: 60, cwd: "/w/older" }),
      candidate("pinned", { daysIdle: 90, cwd: "/w/pinned", pinned: true }),
      candidate("env", { daysIdle: 50, cwd: "/w/env" }),
    ]);
    workspaces.set("/w/env", { keep: "Other ignored files" });
    workspaces.set("/w/old", { kind: "changes", files: 2, bytes: 40 });
    const scan = await service.scan();
    expect(scan.threads.checked).toBe(5);
    expect(scan.threads.projects).toHaveLength(1);
    const [project] = scan.threads.projects;
    expect(project!.idle.map((row) => row.threadId)).toEqual(["older", "old"]);
    expect(project!.idle[1]!.workspace).toEqual({ kind: "changes", files: 2, bytes: 40 });
    expect(project!.kept).toEqual({ "Pinned thread": 1, "Other ignored files": 1, "Within the per-project limit": 1 });
    expect(scan.spaceSource).toBe("none");
  });

  it("archives sub-agent threads with their root and never lists them on their own", async () => {
    const { service } = harness([
      candidate("root", { daysIdle: 30, cwd: "/w/root" }),
      candidate("child", { daysIdle: 30, parent: "root" }),
    ], { getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age", inactivityDays: 7 }) });
    const scan = await service.scan();
    expect(scan.threads.checked).toBe(1);
    expect(scan.threads.projects[0]!.idle).toEqual([expect.objectContaining({ threadId: "root", subThreads: 1 })]);
  });

  it("reports a thread whose lookups fail and still scans the rest", async () => {
    const { service } = harness([
      candidate("broken", { cwd: "/w/broken" }),
      candidate("fine", { cwd: "/w/fine" }),
    ], {
      getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age", inactivityDays: 7 }),
      resolveProject: vi.fn(async (item: ThreadArchiveCandidate) => {
        if (item.thread.id === "broken") throw new Error("git worktree list failed");
        return "/projects/app";
      }),
    });
    const scan = await service.scan();
    expect(scan.threads.projects[0]!.idle.map((row) => row.threadId)).toEqual(["fine"]);
    expect(scan.failures).toEqual([{ step: "threads", message: "git worktree list failed", threadId: "broken" }]);
  });

  it("still reports archived checkouts when threads cannot be listed", async () => {
    const root = await tempRoot();
    const { service } = harness([], {
      listCandidates: vi.fn(async () => { throw new Error("provider offline"); }),
      auditArchivedCheckouts: vi.fn(async () => ({
        candidates: [{ backend: "codex", threadId: "a", worktreePath: path.join(root, "gone") }],
        kept: { "Used by an active thread": 2 }, emptyFolders: 3,
      })),
    });
    const scan = await service.scan();
    expect(scan.threads.skipped).toBe("Threads could not be listed");
    expect(scan.checkouts.items).toEqual([expect.objectContaining({ threadId: "a", kind: "removable" })]);
    expect(scan.checkouts.emptyFolders).toBe(3);
    expect(scan.failures).toEqual([{ step: "threads", message: "provider offline" }]);
  });

  it("lists a checkout whose repository is gone separately, as repositoryGone", async () => {
    const root = await tempRoot();
    const checkout = path.join(root, "worktrees", "abc123", "kiln");
    await mkdir(checkout, { recursive: true });
    const missing = path.join(root, "deleted-repo");
    await writeFile(path.join(checkout, ".git"), `gitdir: ${path.join(missing, ".git", "worktrees", "kiln")}\n`);
    const { service } = harness([], {
      auditArchivedCheckouts: vi.fn(async () => ({
        candidates: [{ backend: "codex", threadId: "orphan", worktreePath: checkout }], kept: {}, emptyFolders: 0,
      })),
    });
    const scan = await service.scan();
    expect(scan.checkouts.items).toEqual([expect.objectContaining({
      kind: "repositoryGone", worktreePath: checkout, missingRepositoryPath: missing,
    })]);
  });
});

describe("sub-thread parents", () => {
  const child = (id: string, parent: string, options: { pinned?: boolean; daysIdle?: number } = {}): ThreadArchiveCandidate => ({
    ...candidate(id, { cwd: `/w/${id}`, ...options }),
    overlay: { parentThreadId: parent, parentThreadBackend: "codex" } as ThreadArchiveCandidate["overlay"],
  });
  const agePolicy = () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age" as const, inactivityDays: 7 });

  it("offers a parent whose remaining sub-threads would be 2 or fewer, and keeps one that would leave 3", async () => {
    const twoLeft = harness([
      candidate("parent", { cwd: "/w/parent" }),
      child("idle1", "parent"), child("idle2", "parent"),
      child("pinned1", "parent", { pinned: true }), child("pinned2", "parent", { pinned: true }),
    ], { getPolicy: agePolicy });
    const offered = await twoLeft.service.scan();
    expect(offered.threads.projects[0]!.idle.map((row) => row.threadId)).toEqual(expect.arrayContaining(["parent", "idle1", "idle2"]));

    const threeLeft = harness([
      candidate("parent", { cwd: "/w/parent" }),
      child("idle1", "parent"),
      child("pinned1", "parent", { pinned: true }), child("pinned2", "parent", { pinned: true }),
      child("pinned3", "parent", { pinned: true }),
    ], { getPolicy: agePolicy });
    const kept = await threeLeft.service.scan();
    const [project] = kept.threads.projects;
    expect(project!.idle.map((row) => row.threadId)).toEqual(["idle1"]);
    expect(project!.kept["Parent of 3+ sub-threads"]).toBe(1);
  });

  it("keeps a parent at run time when the operator archives it without enough of its sub-threads", async () => {
    const { service, deps } = harness([
      candidate("parent", { cwd: "/w/parent", daysIdle: 40 }),
      child("a", "parent"), child("b", "parent"), child("c", "parent"),
    ], { getPolicy: agePolicy });
    const scan = await service.scan();
    expect(scan.threads.projects[0]!.idle).toHaveLength(4);
    const onlyParent = await service.apply({ scanId: scan.scanId, archive: [{ backend: "codex", threadId: "parent" }],
      removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false });
    expect(onlyParent.problems).toEqual([expect.objectContaining({ threadId: "parent", kind: "kept",
      reason: "Would leave 3 sub-threads without their parent" })]);
    expect(deps.archiveFamily).not.toHaveBeenCalled();

    const rescan = await service.scan();
    const withChild = await service.apply({ scanId: rescan.scanId,
      archive: [{ backend: "codex", threadId: "parent" }, { backend: "codex", threadId: "a" }],
      removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false });
    expect(withChild.problems).toEqual([]);
    // The sub-thread is archived before its parent, so it keeps its place.
    expect(vi.mocked(deps.archiveFamily).mock.calls.map(([family]) => family[0]!.thread.id)).toEqual(["a", "parent"]);
  });
});

describe("ThreadMaintenanceService.apply", () => {
  it("archives selections, keeps one with new activity, and keeps going after a failure", async () => {
    const items = [
      candidate("a", { daysIdle: 30, cwd: "/w/a" }),
      candidate("b", { daysIdle: 31, cwd: "/w/b" }),
      candidate("c", { daysIdle: 32, cwd: "/w/c" }),
    ];
    const archiveFamily = vi.fn(async (family: ThreadArchiveCandidate[]) => {
      if (family[0]!.thread.id === "b") throw new Error("Codex App Server did not answer");
      return true;
    });
    const { service, deps } = harness(items, {
      getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age", inactivityDays: 7 }),
      archiveFamily,
    });
    const scan = await service.scan();
    vi.mocked(deps.refreshCandidate).mockImplementation(async (item) => item.thread.id === "c"
      ? { ...item, thread: { ...item.thread, updatedAt: NOW } }
      : item);
    const run = await service.apply({
      scanId: scan.scanId,
      archive: ["a", "b", "c"].map((threadId) => ({ backend: "codex", threadId })),
      removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false,
    });
    expect(run.running).toBe(false);
    expect(run.steps[0]).toEqual({ step: "threads", ran: true, done: 1, kept: 1, failed: 1 });
    expect(run.problems).toEqual([
      expect.objectContaining({ kind: "failed", threadId: "b", reason: "Archive failed", detail: "Codex App Server did not answer" }),
      expect.objectContaining({ kind: "kept", threadId: "c", reason: "New activity during the run" }),
    ]);
  });

  it("needs an explicit choice for changes over the limit and passes that choice through", async () => {
    const items = [candidate("big", { cwd: "/w/big" }), candidate("big2", { cwd: "/w/big2" }), candidate("big3", { cwd: "/w/big3" })];
    const { service, workspaces, deps } = harness(items, {
      getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age", inactivityDays: 7 }),
    });
    for (const id of ["big", "big2", "big3"]) {
      workspaces.set(`/w/${id}`, { kind: "overLimit", files: 1, bytes: 1_000, limitBytes: 100, largest: [] });
    }
    const scan = await service.scan();
    const run = await service.apply({
      scanId: scan.scanId,
      archive: [
        { backend: "codex", threadId: "big" },
        { backend: "codex", threadId: "big2", overLimit: "keepCheckout" },
        { backend: "codex", threadId: "big3", overLimit: "snapshotAll" },
      ],
      removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false,
    });
    expect(run.problems).toEqual([expect.objectContaining({ threadId: "big", reason: "Changes are over the snapshot limit" })]);
    expect(deps.archiveFamily).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.archiveFamily).mock.calls[0]![1]).toEqual({ preserveWorktrees: true });
    expect(vi.mocked(deps.archiveFamily).mock.calls[1]![1]).toEqual({ preserveWorktrees: false, snapshotLimitBytes: 1_100 });
  });

  it("moves only a still-orphaned, managed checkout to the Trash and keeps unselected ones", async () => {
    const root = await tempRoot();
    const makeOrphan = async (name: string) => {
      const checkout = path.join(root, "worktrees", name, "kiln");
      await mkdir(checkout, { recursive: true });
      await writeFile(path.join(checkout, ".git"), `gitdir: ${path.join(root, `gone-${name}`, ".git", "worktrees", "kiln")}\n`);
      return checkout;
    };
    const selected = await makeOrphan("one");
    const unselected = await makeOrphan("two");
    const { service, deps } = harness([], {
      auditArchivedCheckouts: vi.fn(async () => ({
        candidates: [selected, unselected].map((worktreePath, index) => ({ backend: "codex", threadId: `t${index}`, worktreePath })),
        kept: {}, emptyFolders: 0,
      })),
    });
    const scan = await service.scan();
    const run = await service.apply({
      scanId: scan.scanId, archive: [], removeCheckouts: [],
      trashCheckouts: [{ worktreePath: selected }], removeEmptyFolders: false,
    });
    expect(deps.trashItem).toHaveBeenCalledWith(selected);
    expect(run.steps[1]).toEqual(expect.objectContaining({ step: "checkouts", done: 1 }));
    expect(run.problems).toEqual([expect.objectContaining({ kind: "kept", path: unselected, reason: "Repository no longer exists" })]);
  });

  it("reports checkouts a stop skipped as kept instead of dropping them", async () => {
    const root = await tempRoot();
    const removable = path.join(root, "worktrees", "r1", "app");
    const orphan = path.join(root, "worktrees", "o1", "app");
    await mkdir(removable, { recursive: true });
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(orphan, ".git"), `gitdir: ${path.join(root, "gone", ".git", "worktrees", "app")}\n`);
    let service!: ThreadMaintenanceService;
    const built = harness([candidate("a", { cwd: "/w/a" })], {
      getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age", inactivityDays: 7 }),
      archiveFamily: vi.fn(async () => { service.stop(); return true; }),
      auditArchivedCheckouts: vi.fn(async () => ({
        candidates: [removable, orphan].map((worktreePath, index) => ({ backend: "codex", threadId: `c${index}`, worktreePath })),
        kept: {}, emptyFolders: 0,
      })),
    });
    service = built.service;
    const scan = await service.scan();
    const run = await service.apply({
      scanId: scan.scanId, archive: [{ backend: "codex", threadId: "a" }],
      removeCheckouts: [{ backend: "codex", threadId: "c0", worktreePath: removable }],
      trashCheckouts: [{ worktreePath: orphan }], removeEmptyFolders: false,
    });
    expect(built.deps.removeArchivedCheckouts).not.toHaveBeenCalled();
    expect(built.deps.trashItem).not.toHaveBeenCalled();
    expect(run.steps[1]).toEqual(expect.objectContaining({ step: "checkouts", kept: 2, done: 0 }));
    expect(run.problems.map((problem) => [problem.path, problem.reason])).toEqual([
      [removable, "Stopped before removing"],
      [orphan, "Stopped before removing"],
    ]);
  });

  it("refuses a second run and an unknown scan", async () => {
    const { service } = harness([]);
    expect(() => service.start({ scanId: "missing", archive: [], removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false }))
      .toThrow("Scan again");
    const scan = await service.scan();
    let release!: () => void;
    const { service: blocked } = harness([], {
      removeArchivedCheckouts: vi.fn(() => new Promise<ArchivedCheckoutRemoval>((resolve) => {
        release = () => resolve({ removed: [], kept: [], failed: [], emptyFoldersRemoved: 1, emptyFoldersFailed: [] });
      })),
    });
    const blockedScan = await blocked.scan();
    const first = blocked.start({ scanId: blockedScan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: true });
    expect(() => blocked.start({ scanId: blockedScan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: true }))
      .toThrow("already running");
    release();
    await expect(first.done).resolves.toEqual(expect.objectContaining({ running: false }));
    expect(scan.scanId).toBeTruthy();
  });
});

/** A linked worktree of a fresh repository, on its own branch. Archive
 * removes only linked worktrees, so that is what most cases inspect. */
async function linkedWorktree(root: string): Promise<{ repo: string; worktree: string; git: (...args: string[]) => Promise<unknown> }> {
  const { repo, git: repoGit } = await gitRepo(root);
  const worktree = path.join(root, "worktrees", "abc123", "repo");
  await mkdir(path.dirname(worktree), { recursive: true });
  await repoGit("worktree", "add", "-b", "feature", worktree);
  const git = async (...args: string[]) => await execFileAsync("git", ["-C", worktree, ...args]);
  return { repo, worktree, git };
}

describe("inspectMaintenanceWorkspace", () => {
  const options = (rebuildableOutputIsClean: boolean) => ({ signal: new AbortController().signal, limitBytes: 64, rebuildableOutputIsClean });

  it("treats dependency output as clean only when the rule says so, and other ignored files never", async () => {
    const root = await tempRoot();
    const { worktree } = await linkedWorktree(root);
    expect(await inspectMaintenanceWorkspace(worktree, options(true))).toEqual({ workspace: { kind: "clean" } });
    await mkdir(path.join(worktree, "node_modules", "left-pad"), { recursive: true });
    await writeFile(path.join(worktree, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    expect(await inspectMaintenanceWorkspace(worktree, options(true)))
      .toEqual({ workspace: { kind: "clean", rebuildableOutput: ["node_modules"] } });
    expect(await inspectMaintenanceWorkspace(worktree, options(false))).toEqual({ keep: "Ignored files only" });
    await writeFile(path.join(worktree, ".env.local"), "TOKEN=secret\n");
    expect(await inspectMaintenanceWorkspace(worktree, options(true))).toEqual({ keep: "Other ignored files" });
  });

  it("keeps an ignored secret that sits inside a tracked folder with a rebuildable name", async () => {
    const root = await tempRoot();
    const { worktree, git } = await linkedWorktree(root);
    await mkdir(path.join(worktree, "src", "build"), { recursive: true });
    await writeFile(path.join(worktree, "src", "build", "config.ts"), "export {};\n");
    await git("add", ".");
    await git("-c", "commit.gpgsign=false", "commit", "-m", "tracked build folder");
    await writeFile(path.join(worktree, "src", "build", ".env.local"), "TOKEN=secret\n");
    expect(await inspectMaintenanceWorkspace(worktree, options(true))).toEqual({ keep: "Other ignored files" });
  });

  it("measures the files a snapshot would hold and flags changes over the limit", async () => {
    const root = await tempRoot();
    const { worktree } = await linkedWorktree(root);
    await writeFile(path.join(worktree, "notes.txt"), "small\n");
    expect(await inspectMaintenanceWorkspace(worktree, options(true)))
      .toEqual({ workspace: { kind: "changes", files: 1, bytes: 6 } });
    await writeFile(path.join(worktree, "fixture.bin"), "x".repeat(100));
    expect(await inspectMaintenanceWorkspace(worktree, options(true))).toEqual({ workspace: {
      kind: "overLimit", files: 2, bytes: 106, limitBytes: 64,
      largest: [{ path: "fixture.bin", bytes: 100 }, { path: "notes.txt", bytes: 6 }],
    } });
  });

  it("leaves a primary checkout in place whatever it holds", async () => {
    const root = await tempRoot();
    const { repo } = await gitRepo(root);
    await writeFile(path.join(repo, ".env.local"), "TOKEN=secret\n");
    await writeFile(path.join(repo, "notes.txt"), "work in progress\n");
    expect(await inspectMaintenanceWorkspace(repo, options(true))).toEqual({ workspace: { kind: "inPlace" } });
  });

  it("keeps commits that no branch holds and reports missing and non-Git folders", async () => {
    const root = await tempRoot();
    const { worktree, git } = await linkedWorktree(root);
    await git("checkout", "--detach");
    await writeFile(path.join(worktree, "file.txt"), "detached\n");
    await git("-c", "commit.gpgsign=false", "commit", "-am", "detached only");
    expect(await inspectMaintenanceWorkspace(worktree, options(true))).toEqual({ keep: "Commits on no branch" });
    expect(await inspectMaintenanceWorkspace(path.join(root, "nope"), options(true))).toEqual({ workspace: { kind: "missing" } });
    const scratch = path.join(root, "scratch");
    await mkdir(scratch);
    expect(await inspectMaintenanceWorkspace(scratch, options(true))).toEqual({ workspace: { kind: "notGit" } });
  });

  it("keeps a worktree on an unborn branch instead of failing", async (context) => {
    const root = await tempRoot();
    const { git: repoGit } = await gitRepo(root);
    const orphan = path.join(root, "worktrees", "def456", "repo");
    await mkdir(path.dirname(orphan), { recursive: true });
    try {
      await repoGit("worktree", "add", "--orphan", "-b", "empty", orphan);
    } catch {
      context.skip(); // git older than 2.42 has no --orphan worktrees
    }
    expect(await inspectMaintenanceWorkspace(orphan, options(true))).toEqual({ keep: "No commits yet" });
  });
});

describe("rebuildableOutputFolder", () => {
  it("names only an ignored folder whose own name is rebuildable", () => {
    expect(rebuildableOutputFolder("packages/web/node_modules/")).toBe("packages/web/node_modules");
    expect(rebuildableOutputFolder("target/")).toBe("target");
    expect(rebuildableOutputFolder("target")).toBeUndefined();
    expect(rebuildableOutputFolder("src/build/.env.local")).toBeUndefined();
    expect(rebuildableOutputFolder(".env.local")).toBeUndefined();
  });

  it("never treats an ignored file as rebuildable, whatever folders it sits in", () => {
    const segment = fc.oneof(fc.constantFrom(...REBUILDABLE_OUTPUT_NAMES), fc.stringMatching(/^[a-z.]{1,8}$/));
    fc.assert(fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), (segments) => {
      const file = segments.join("/");
      expect(rebuildableOutputFolder(file)).toBeUndefined();
      expect(rebuildableOutputFolder(`${file}/`) !== undefined).toBe(REBUILDABLE_OUTPUT_NAMES.has(segments.at(-1)!));
    }));
  });
});

describe("project-scoped checkout scan", () => {
  it("keeps only checkouts whose own repository is the project, even when names overlap", async () => {
    const root = await tempRoot();
    const pointTo = async (checkout: string, repository: string) => {
      await mkdir(checkout, { recursive: true });
      await writeFile(path.join(checkout, ".git"), `gitdir: ${path.join(repository, ".git", "worktrees", path.basename(checkout))}\n`);
    };
    const app = path.join(root, "src", "app");
    const appWeb = path.join(root, "src", "app-web");
    await mkdir(path.join(app, ".git", "worktrees", "app"), { recursive: true });
    await mkdir(path.join(appWeb, ".git", "worktrees", "app-web"), { recursive: true });
    const ours = path.join(root, "worktrees", "a1", "app");
    const theirs = path.join(root, "worktrees", "b2", "app-web");
    await pointTo(ours, app);
    await pointTo(theirs, appWeb);
    const { service } = harness([], {
      auditArchivedCheckouts: vi.fn(async () => ({
        candidates: [ours, theirs].map((worktreePath, index) => ({ backend: "codex", threadId: `t${index}`, worktreePath })),
        kept: {}, emptyFolders: 0,
      })),
    });
    const scan = await service.scan({ projectKey: app });
    expect(scan.checkouts.items.map((item) => item.worktreePath)).toEqual([ours]);
  });
});
