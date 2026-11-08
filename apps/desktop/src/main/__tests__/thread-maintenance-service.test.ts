import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_THREAD_ARCHIVE_POLICY,
  REBUILDABLE_OUTPUT_NAMES,
  type ThreadMaintenanceRun,
  type ThreadMaintenanceScanStep,
  type ThreadMaintenanceWorkspace,
} from "@pwragent/shared";
import { PEER_SUBTHREADS_UNREADABLE, peerSubthreadKey, type ThreadArchiveCandidate } from "../app-server/thread-archive-sweeper";
import {
  ThreadMaintenanceService,
  UNREFERENCED_KEEP_PREFIX,
  unreferencedKeepReason,
  type ArchivedCheckoutAudit,
  type ArchivedCheckoutRemoval,
  type CheckoutHibernationReviewDeps,
  type ScanProgressSnapshot,
  type ThreadMaintenanceDeps,
} from "../app-server/thread-maintenance-service";
import { inspectMaintenanceWorkspace, rebuildableOutputFolder } from "../app-server/thread-maintenance-workspace";
import { planThreadMaintenanceApply, summarizeThreadMaintenanceScan, threadMaintenanceConfirmationQuestion } from "../agent-tools/thread-maintenance-tool-results";

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
  it("allows the agent to plan only reviewed Cargo output and describes cache-only cleanup accurately", async () => {
    const scan = await harness([]).service.scan({ steps: ["checkouts"] });
    scan.checkouts.buildOutputs = [0, 1].map((index) => ({ kind: "cargo", checkoutPath: `/fixture/${index}`,
      outputPath: `/fixture/${index}/target/debug`, manifestPath: `/fixture/${index}/Cargo.toml` }));
    fc.assert(fc.property(fc.array(fc.nat({ max: 3 }), { minLength: 1, maxLength: 10 }), (selection) => {
      const plan = planThreadMaintenanceApply({ scanId: scan.scanId,
        removeBuildOutputs: selection.map((index) => ({ outputPath: `/fixture/${index}/target/debug` })) }, scan, { backend: "codex", threadId: "caller" });
      if (selection.some((index) => index >= 2)) expect(plan).toHaveProperty("error");
      else {
        expect(plan).not.toHaveProperty("error");
        if ("error" in plan) throw new Error(plan.error);
        expect(plan.request.removeBuildOutputs).toHaveLength(new Set(selection).size);
        const question = threadMaintenanceConfirmationQuestion(plan.summary);
        expect(question).toContain("Only compiled Cargo output");
        expect(question).not.toContain("recovery snapshots");
      }
    }));
  });

  it("offers build output independently of whole-checkout eligibility and retains reviewed targets", async () => {
    const row = { kind: "cargo" as const, checkoutPath: "/fixture/repo", outputPath: "/fixture/repo/target/debug",
      manifestPath: "/fixture/repo/Cargo.toml", space: { allocatedBytes: 32 * 2 ** 30 } };
    const remove = vi.fn(async () => ({ allocatedBytesRemoved: row.space.allocatedBytes }));
    const { service } = harness([candidate("recent", { daysIdle: 0, cwd: row.checkoutPath })], {
      inspectWorkspace: async () => ({ keep: "Other ignored files" }),
      buildOutputs: { scan: async () => ({ items: [{ row, identity: "fixture" }], kept: [] }), remove },
    });
    const scan = await service.scan({ steps: ["checkouts"] });
    expect(scan.checkouts.items).toEqual([]);
    expect(scan.checkouts.buildOutputs).toEqual([row]);
    const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
      removeEmptyFolders: false, removeBuildOutputs: [{ outputPath: row.outputPath }, { outputPath: row.outputPath }] });
    expect(remove).toHaveBeenCalledOnce();
    expect(run.steps.find((step) => step.step === "checkouts"))
      .toMatchObject({ done: 1, failed: 0, allocatedBytesRemoved: row.space.allocatedBytes });
  });

  it("matches the selected-profile model for duplicates, missing, busy and failed output", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("done", "missing", "busy", "error"), { maxLength: 8 }), fc.array(fc.nat({ max: 10 }), { maxLength: 14 }), async (states, selection) => {
      const rows = states.map((_, index) => ({ kind: "cargo" as const, checkoutPath: `/fixture/${index}`,
        outputPath: `/fixture/${index}/target/debug`, manifestPath: `/fixture/${index}/Cargo.toml`, space: { allocatedBytes: (index + 1) * 1024 } }));
      const called: string[] = [];
      const { service } = harness([], { buildOutputs: {
        scan: async () => ({ items: rows.map((row) => ({ row, identity: "fixture" })), kept: [] }),
        remove: async ({ row }) => {
          called.push(row.outputPath);
          const index = rows.findIndex((item) => item.outputPath === row.outputPath);
          if (states[index] === "error") throw new Error("fixture error");
          if (states[index] === "missing") return { alreadyGone: true };
          if (states[index] === "busy") return { kept: "Cargo build in progress" };
          return { allocatedBytesRemoved: rows[index]!.space.allocatedBytes };
        },
      } });
      const scan = await service.scan({ steps: ["checkouts"] });
      const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false,
        removeBuildOutputs: selection.map((index) => ({ outputPath: `/fixture/${index}/target/debug` })) });
      const selected = [...new Set(selection)];
      const count = (state: string) => selected.filter((index) => states[index] === state).length;
      const step = run.steps.find((item) => item.step === "checkouts")!;
      expect(step).toMatchObject({ done: count("done"), kept: count("busy"), failed: count("error") + selected.filter((index) => index >= states.length).length });
      expect(step.allocatedBytesRemoved ?? 0).toBe(selected.filter((index) => states[index] === "done").reduce((total, index) => total + rows[index]!.space.allocatedBytes, 0));
      expect(called).toEqual(selected.filter((index) => index < states.length).map((index) => rows[index]!.outputPath));
    }), { numRuns: 20 });
  });

  it("keeps measured allocation and coverage in bounded agent tool results", async () => {
    const scan = await harness([]).service.scan({ steps: ["checkouts"] });
    fc.assert(fc.property(fc.array(fc.nat({ max: 1_000_000 }), { maxLength: 140 }), (sizes) => {
      scan.hibernate = { idleDays: 3, maxSnapshotMb: 100, removeRebuildableOutput: true, checked: sizes.length, kept: {},
        coverage: { roots: [], providers: [{ backend: "codex", threads: sizes.length }] },
        items: sizes.map((bytes, index) => ({ backend: "codex", threadId: String(index), title: "Fixture",
          worktreePath: `/fixture/${index}`, lastActivityAt: NOW, files: 0, bytes: 0, space: { allocatedBytes: bytes } })) };
      const summary = summarizeThreadMaintenanceScan(scan);
      expect(summary.hibernate?.coverage).toEqual(scan.hibernate.coverage);
      expect(summary.hibernate?.items.map((item) => item.space)).toEqual(scan.hibernate.items.slice(0, 100).map((item) => item.space));
      scan.checkouts.buildOutputs = sizes.map((bytes, index) => ({ kind: "cargo", checkoutPath: `/fixture/${index}`,
        outputPath: `/fixture/${index}/target/debug`, manifestPath: `/fixture/${index}/Cargo.toml`, space: { allocatedBytes: bytes } }));
      const complete = summarizeThreadMaintenanceScan(scan);
      expect(complete.checkouts.buildOutputCount).toBe(sizes.length);
      expect(complete.checkouts.buildOutputSpace?.allocatedBytes).toBe(sizes.reduce((sum, value) => sum + value, 0));
      expect(complete.checkouts.buildOutputs).toHaveLength(Math.min(100, sizes.length));
    }));
  });

  it("never counts a confirmed missing checkout as space on disk", async () => {
    const measureAllocation = vi.fn(async () => ({ allocatedBytes: 1_000_000 }));
    const { service } = harness([candidate("gone", { cwd: "/gone/checkout" })], {
      isCheckoutOnDisk: async () => false,
      measureAllocation,
      hibernation: { getPolicy: () => ({ enabled: true, idleDays: 1, maxSnapshotMb: 100, removeRebuildableOutput: true, restoreOn: "send" }),
        keepReason: () => ({ target: "/gone/checkout" }), inspect: async () => ({ files: 0, bytes: 0 }), hibernate: async () => true },
    });
    const scan = await service.scan({ steps: ["hibernate"] });
    expect(scan.hibernate).toMatchObject({ checked: 0, items: [], coverage: { roots: [], excluded: [{ reason: "Checkout missing", count: 1 }] } });
    expect(measureAllocation).not.toHaveBeenCalled();
  });

  it("publishes provider discovery while the archived audit is still pending", async () => {
    await fc.assert(fc.asyncProperty(fc.nat({ max: 5000 }), async (found) => {
      let release!: () => void;
      let listed!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { listed = resolve; });
      const updates: ScanProgressSnapshot[] = [];
      const { service } = harness([], { auditArchivedCheckouts: async (report) => {
        report?.({ detail: "Reading archived Codex page", found, root: "/arbitrary/checkouts" });
        listed();
        await pending;
        return { candidates: [], kept: {}, emptyFolders: 0 };
      } });
      const scan = service.scan({ steps: ["checkouts"] }, { onProgress: (update) => updates.push(update) });
      await started;
      expect(updates.at(-1)).toMatchObject({ stage: "listing", detail: "Reading archived Codex page", found, root: "/arbitrary/checkouts" });
      release();
      await scan;
    }));
  });

  it("accounts for independent child checkouts across providers and remote-parent links", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("codex", "claude", "acp:grok"), { minLength: 1, maxLength: 12 }), async (backends) => {
      const rows = backends.map((backend, index) => {
        const row = candidate(String(index), { cwd: `/outside/checkout-${index}`, parent: `parent-${index}` });
        row.thread.source = backend as typeof row.thread.source;
        row.overlay = { parentThreadId: `remote-${index}`, parentThreadInstanceId: "peer-machine" } as ThreadArchiveCandidate["overlay"];
        return row;
      });
      const { service } = harness(rows, {
        measureAllocation: async () => ({ allocatedBytes: 4096 }),
        hibernation: {
          getPolicy: () => ({ enabled: true, idleDays: 1, maxSnapshotMb: 100, removeRebuildableOutput: true, restoreOn: "send" }),
          keepReason: (row) => ({ target: row.thread.linkedDirectories[0]?.worktreePath }),
          inspect: async () => ({ files: 0, bytes: 0 }),
          hibernate: async () => true,
        },
      });
      const scan = await service.scan({ steps: ["hibernate"] });
      expect(scan.hibernate?.items.map((row) => row.threadId).sort()).toEqual(rows.map((row) => row.thread.id).sort());
      expect(scan.hibernate?.coverage?.roots.reduce((sum, root) => sum + (root.allocatedBytes ?? 0), 0)).toBe(backends.length * 4096);
      expect(scan.hibernate?.items.every((row) => row.space?.allocatedBytes === 4096 && row.bytes === 0)).toBe(true);
    }));
  });

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

  // The agent tool names a scan before it finishes and reads it back later.
  it("retains a scan under the scanId the caller chose", async () => {
    const { service } = harness([]);
    const scan = await service.scan({ scanId: "tool-scan" });
    expect(scan.scanId).toBe("tool-scan");
    expect(service.getScan("tool-scan")).toBe(scan);
    expect((await service.scan()).scanId).toBe("id-1");
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

  it("counts a parent's sub-threads on peers at scan and at run time", async () => {
    const peerChildren = (count: number) => new Map([["codex:parent",
      Array.from({ length: count }, (_, index) => peerSubthreadKey("pwr_peer", "codex", `p${index}`))]]);
    const family = () => [candidate("parent", { cwd: "/w/parent", daysIdle: 40 }), child("a", "parent")];
    // One local and two peer sub-threads: archiving them all leaves the 2 peers.
    const offered = harness(family(), { getPolicy: agePolicy, listPeerSubthreads: vi.fn(async () => peerChildren(2)) });
    const scan = await offered.service.scan();
    expect(scan.threads.projects[0]!.idle.map((row) => row.threadId)).toEqual(expect.arrayContaining(["parent", "a"]));
    // A third peer sub-thread appears after the scan: the run keeps the parent.
    vi.mocked(offered.deps.listPeerSubthreads!).mockResolvedValue(peerChildren(3));
    const run = await offered.service.apply({ scanId: scan.scanId,
      archive: [{ backend: "codex", threadId: "parent" }, { backend: "codex", threadId: "a" }],
      removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false });
    expect(run.problems).toEqual([expect.objectContaining({ threadId: "parent", kind: "kept",
      reason: "Would leave 3 sub-threads without their parent" })]);
    expect(vi.mocked(offered.deps.archiveFamily).mock.calls.map(([items]) => items[0]!.thread.id)).toEqual(["a"]);

    const kept = harness(family(), { getPolicy: agePolicy, listPeerSubthreads: vi.fn(async () => peerChildren(3)) });
    const keptScan = await kept.service.scan();
    expect(keptScan.threads.projects[0]!.idle.map((row) => row.threadId)).toEqual(["a"]);
    expect(keptScan.threads.projects[0]!.kept["Parent of 3+ sub-threads"]).toBe(1);
  });

  it("offers no threads when peer sub-threads cannot be read, and keeps a peer parent when the run cannot", async () => {
    const unreadable = harness([candidate("solo", { cwd: "/w/solo", daysIdle: 40 })], { getPolicy: agePolicy,
      listPeerSubthreads: vi.fn(async () => { throw new Error("db locked"); }) });
    const scan = await unreadable.service.scan();
    expect(scan.threads.skipped).toBe(PEER_SUBTHREADS_UNREADABLE);
    expect(scan.threads.projects).toEqual([]);

    const listPeerSubthreads = vi.fn(async () => new Map([["codex:parent", [peerSubthreadKey("pwr_peer", "codex", "p0")]]]));
    const { service, deps } = harness([candidate("parent", { cwd: "/w/parent", daysIdle: 40 }),
      candidate("other", { cwd: "/w/other", daysIdle: 40 })], { getPolicy: agePolicy, listPeerSubthreads });
    const ready = await service.scan();
    listPeerSubthreads.mockRejectedValue(new Error("db locked"));
    const run = await service.apply({ scanId: ready.scanId,
      archive: [{ backend: "codex", threadId: "parent" }, { backend: "codex", threadId: "other" }],
      removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false });
    expect(run.problems).toEqual([expect.objectContaining({ threadId: "parent", kind: "kept", reason: PEER_SUBTHREADS_UNREADABLE })]);
    expect(vi.mocked(deps.archiveFamily).mock.calls.map(([items]) => items[0]!.thread.id)).toEqual(["other"]);
  });

  it("archives a nested family from the deepest sub-threads up", async () => {
    const { service, deps } = harness([
      candidate("top", { cwd: "/w/top", daysIdle: 40 }),
      child("mid", "top"), child("x", "mid"), child("y", "mid"), child("z", "mid"),
    ], { getPolicy: agePolicy });
    const scan = await service.scan();
    const run = await service.apply({ scanId: scan.scanId,
      archive: ["top", "mid", "x", "y", "z"].map((threadId) => ({ backend: "codex", threadId })),
      removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false });
    expect(run.problems).toEqual([]);
    expect(vi.mocked(deps.archiveFamily).mock.calls.map(([family]) => family[0]!.thread.id))
      .toEqual(["x", "y", "z", "mid", "top"]);
  });
});

describe("checkouts no thread refers to", () => {
  const unreferencedAudit = (paths: string[], extra: Partial<ArchivedCheckoutAudit> = {}) =>
    vi.fn(async (): Promise<ArchivedCheckoutAudit> => ({ candidates: [], kept: {}, emptyFolders: 0, unreferenced: paths, ...extra }));

  it("lists a clean or snapshot-sized one, and keeps every other with a No thread reason", async () => {
    const { service, workspaces } = harness([], {
      auditArchivedCheckouts: unreferencedAudit(["/u/clean", "/u/edits", "/u/commits", "/u/big", "/u/main", "/u/scratch"]),
    });
    workspaces.set("/u/edits", { kind: "changes", files: 2, bytes: 40 });
    workspaces.set("/u/commits", { keep: "Commits on no branch" });
    workspaces.set("/u/big", { kind: "overLimit", files: 1, bytes: 900, limitBytes: 100, largest: [] });
    workspaces.set("/u/main", { kind: "inPlace" });
    workspaces.set("/u/scratch", { kind: "notGit" });
    const scan = await service.scan();
    expect(scan.checkouts.items).toEqual([
      { kind: "unreferenced", worktreePath: "/u/clean", workspace: { kind: "clean" } },
      { kind: "unreferenced", worktreePath: "/u/edits", workspace: { kind: "changes", files: 2, bytes: 40 } },
    ]);
    expect(scan.checkouts.kept).toEqual({
      [`${UNREFERENCED_KEEP_PREFIX}Commits on no branch`]: 1,
      [`${UNREFERENCED_KEEP_PREFIX}Changes over the snapshot limit`]: 1,
      [`${UNREFERENCED_KEEP_PREFIX}Main checkout`]: 1,
      [`${UNREFERENCED_KEEP_PREFIX}Not a Git checkout`]: 1,
    });
  });

  it("says so when they could not be checked", async () => {
    const { service } = harness([], {
      auditArchivedCheckouts: unreferencedAudit([], { unreferencedUnavailable: "A thread's folder could not be resolved" }),
    });
    const scan = await service.scan();
    expect(scan.checkouts.kept).toEqual({ [`${UNREFERENCED_KEEP_PREFIX}not checked: A thread's folder could not be resolved`]: 1 });
  });

  it("removes only selected ones that are still safe, and reports what the registry kept", async () => {
    const removeUnreferencedCheckouts = vi.fn(async (paths: string[]) => ({
      removed: paths.filter((value) => value === "/u/clean").map((worktreePath) => ({ worktreePath })),
      kept: paths.filter((value) => value === "/u/claimed").map((worktreePath) => ({ worktreePath, reason: "A thread uses it now" })),
      failed: [],
    }));
    const { service, workspaces } = harness([], {
      auditArchivedCheckouts: unreferencedAudit(["/u/clean", "/u/claimed", "/u/later", "/u/unselected"]),
      removeUnreferencedCheckouts,
    });
    const scan = await service.scan();
    // A commit lands in one checkout between review and removal.
    workspaces.set("/u/later", { keep: "Commits on no branch" });
    const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
      removeUnreferenced: ["/u/clean", "/u/claimed", "/u/later", "/u/not-scanned"].map((worktreePath) => ({ worktreePath })),
      removeEmptyFolders: false });
    expect(removeUnreferencedCheckouts).toHaveBeenCalledWith(["/u/clean", "/u/claimed"]);
    expect(run.steps.find((step) => step.step === "checkouts")).toEqual({ step: "checkouts", ran: true, done: 1, kept: 2, failed: 1 });
    expect(run.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ object: "/u/later", kind: "kept", reason: "Changed since the scan", detail: "Commits on no branch" }),
      expect.objectContaining({ object: "/u/claimed", kind: "kept", reason: "A thread uses it now" }),
      expect.objectContaining({ object: "/u/not-scanned", kind: "failed", reason: "Not in this scan" }),
    ]));
    expect(run.problems.some((problem) => problem.object === "/u/unselected")).toBe(false);
  });

  it("is removable only for a clean or snapshot-sized checkout", () => {
    const workspaces: ThreadMaintenanceWorkspace[] = [
      { kind: "clean" }, { kind: "changes", files: 1, bytes: 1 },
      { kind: "overLimit", files: 1, bytes: 2, limitBytes: 1, largest: [] },
      { kind: "notGit" }, { kind: "inPlace" }, { kind: "missing" },
    ];
    for (const workspace of workspaces) {
      const removable = typeof unreferencedKeepReason({ workspace }) !== "string";
      expect(removable).toBe(workspace.kind === "clean" || workspace.kind === "changes");
    }
    expect(unreferencedKeepReason({ keep: "Other ignored files" })).toBe("Other ignored files");
  });
});

describe("ThreadMaintenanceService.apply", () => {
  it("stamps every published snapshot with a larger revision, across runs", async () => {
    const published: ThreadMaintenanceRun[] = [];
    const { service } = harness([candidate("a", { daysIdle: 30, cwd: "/w/a" })], {
      getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age", inactivityDays: 7 }),
      onRun: (run: ThreadMaintenanceRun) => { published.push(run); },
    });
    for (let index = 0; index < 2; index++) {
      const scan = await service.scan();
      const { run, done } = service.start({ scanId: scan.scanId, archive: [{ backend: "codex", threadId: "a" }],
        removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false });
      const finished = await done;
      // The reply the dialog gets is older than the result it may already have.
      expect(run.revision).toBeLessThan(finished.revision);
      expect(service.getRun()).toEqual(finished);
    }
    const revisions = published.map((run) => run.revision);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(new Set(revisions).size).toBe(revisions.length);
  });

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
    expect(run.steps.find((step) => step.step === "checkouts")).toEqual(expect.objectContaining({ step: "checkouts", done: 1 }));
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
    expect(run.steps.find((step) => step.step === "checkouts")).toEqual(expect.objectContaining({ step: "checkouts", kept: 2, done: 0 }));
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

describe("hibernate idle checkouts", () => {
  const off = { enabled: false, idleDays: 5, maxSnapshotMb: 25, removeRebuildableOutput: true, restoreOn: "send" as const };

  function hibernation(overrides: Partial<CheckoutHibernationReviewDeps> = {}): CheckoutHibernationReviewDeps {
    return {
      getPolicy: () => off,
      keepReason: vi.fn((item: ThreadArchiveCandidate) => {
        const target = item.thread.linkedDirectories[0]?.worktreePath;
        return target ? { target } : {};
      }),
      inspect: vi.fn(async (worktreePath: string) => worktreePath === "/w/rebasing"
        ? { keep: "Rebase in progress" }
        : { files: 2, bytes: 900, removedOutput: ["node_modules"] }),
      hibernate: vi.fn(async () => true),
      ...overrides,
    };
  }

  it("marks threads the archive step offers, and uses hibernation's own rules even while it is off", async () => {
    const items = [
      candidate("newest", { daysIdle: 30, cwd: "/w/newest" }),
      candidate("idle", { daysIdle: 31, cwd: "/w/idle" }),
      candidate("pinned", { daysIdle: 40, cwd: "/w/rebasing", pinned: true }),
      candidate("no-checkout", { daysIdle: 50, pinned: true }),
    ];
    const deps = hibernation();
    const { service } = harness(items, { hibernation: deps });
    const scan = await service.scan();

    expect(scan.threads.projects.flatMap((project) => project.idle).map((row) => row.threadId)).toEqual(["idle"]);
    expect(scan.hibernate).toEqual({
      idleDays: 5, maxSnapshotMb: 25, removeRebuildableOutput: true, checked: 3, notIdleYet: 0, alreadyHibernated: 0,
      items: [
        // The archive row offers it too; the dialog hides it once that row is chosen.
        expect.objectContaining({ threadId: "idle", archiveKey: "codex:idle" }),
        expect.objectContaining({ threadId: "newest", worktreePath: "/w/newest", files: 2, bytes: 900, removedOutput: ["node_modules"] }),
      ],
      kept: { "Rebase in progress": 1 },
      coverage: expect.objectContaining({ providers: [{ backend: "codex", threads: 4 }] }),
    });
    expect(scan.hibernate?.items[1]).not.toHaveProperty("archiveKey");
    // The review runs the rules as if the setting were on.
    expect(vi.mocked(deps.keepReason).mock.calls.every(([, , policy]) => policy.enabled)).toBe(true);
  });

  it("counts a thread the rules keep and lists nothing from an owner without the step", async () => {
    const items = [candidate("newest", { daysIdle: 30, cwd: "/w/newest" })];
    const { service } = harness(items, { hibernation: hibernation({ keepReason: () => ({ target: "/w/newest", keep: "Kept awake" }) }) });
    expect((await service.scan()).hibernate).toEqual(expect.objectContaining({ items: [], kept: { "Kept awake": 1 }, checked: 1 }));
    const { service: older } = harness(items);
    const scan = await older.scan();
    expect(scan.hibernate).toBeUndefined();
    const run = await older.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false,
      hibernate: [{ backend: "codex", threadId: "newest" }] });
    expect(run.problems).toEqual([expect.objectContaining({ step: "hibernate", kind: "failed", reason: "Not in this scan" })]);
  });

  // Oracle: a hibernated checkout has nothing on disk, so it counts as already
  // hibernated whichever keep reason the rules reach first.
  it("counts a hibernated checkout apart even when another reason keeps it", async () => {
    const hibernated = (id: string, keep: string) => {
      const item = candidate(id, { daysIdle: 30, cwd: `/w/${id}` });
      item.overlay = { worktreeSnapshots: [{ id: `s-${id}`, backend: "codex", threadId: id, worktreePath: `/w/${id}`,
        repositoryPath: "/projects/app", snapshotRef: `refs/pwragent/snapshots/${id}`, snapshotCommit: "c", createdAt: 1,
        state: "hibernated", ignoredFilesExcluded: true }] } as ThreadArchiveCandidate["overlay"];
      return { item, keep };
    };
    const rows = [hibernated("awake", "Kept awake"), hibernated("merge-held", "Merge hold"), hibernated("plain", "Already hibernated")];
    const keeps = new Map(rows.map(({ item, keep }) => [item.thread.id, keep]));
    const items = [...rows.map(({ item }) => item), candidate("on-disk", { daysIdle: 30, cwd: "/w/on-disk" })];
    const { service } = harness(items, { hibernation: hibernation({
      keepReason: (item: ThreadArchiveCandidate) => ({ target: `/w/${item.thread.id}`,
        ...(item.thread.id === "on-disk" ? { keep: "Kept awake" } : { keep: keeps.get(item.thread.id) }) }),
    }) });
    expect((await service.scan({ steps: ["hibernate"] })).hibernate).toEqual(expect.objectContaining({
      checked: 1, alreadyHibernated: 3, notIdleYet: 0, kept: { "Kept awake": 1 }, items: [],
    }));
  });

  it("hibernates after archiving, re-checks each one, and keeps going after a failure", async () => {
    const items = [
      candidate("newest", { daysIdle: 30, cwd: "/w/newest" }),
      candidate("idle", { daysIdle: 31, cwd: "/w/idle" }),
      candidate("busy", { daysIdle: 40, cwd: "/w/busy", pinned: true }),
      candidate("touched", { daysIdle: 41, cwd: "/w/touched", pinned: true }),
      candidate("broken", { daysIdle: 42, cwd: "/w/broken", pinned: true }),
    ];
    const order: string[] = [];
    const deps = hibernation({
      hibernate: vi.fn(async (item: ThreadArchiveCandidate) => {
        order.push(`hibernate:${item.thread.id}`);
        if (item.thread.id === "busy") return "Busy";
        if (item.thread.id === "broken") throw new Error("worktree is locked");
        return true;
      }),
    });
    const { service, deps: serviceDeps } = harness(items, {
      hibernation: deps,
      archiveFamily: vi.fn(async (family: ThreadArchiveCandidate[]) => { order.push(`archive:${family[0]!.thread.id}`); return true; }),
    });
    const scan = await service.scan();
    // Longest idle first.
    expect(scan.hibernate?.items.map((item) => item.threadId)).toEqual(["broken", "touched", "busy", "idle", "newest"]);
    expect(scan.hibernate?.items.find((item) => item.threadId === "idle")?.archiveKey).toBe("codex:idle");
    vi.mocked(serviceDeps.refreshCandidate).mockImplementation(async (item) => item.thread.id === "touched"
      ? { ...item, thread: { ...item.thread, updatedAt: NOW } }
      : item);
    const run = await service.apply({
      scanId: scan.scanId,
      archive: [{ backend: "codex", threadId: "idle" }],
      removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false,
      hibernate: ["newest", "busy", "touched", "broken", "unknown", "idle"].map((threadId) => ({ backend: "codex", threadId })),
    });
    expect(order).toEqual(["archive:idle", "hibernate:newest", "hibernate:busy", "hibernate:broken"]);
    expect(vi.mocked(deps.hibernate).mock.calls.every(([, policy]) => policy.enabled && policy.idleDays === 5)).toBe(true);
    expect(run.steps.map((step) => step.step)).toEqual(["threads", "hibernate", "checkouts", "expired"]);
    expect(run.steps.find((step) => step.step === "hibernate")).toEqual({ step: "hibernate", ran: true, done: 1, kept: 3, failed: 2 });
    expect(run.problems.filter((problem) => problem.step === "hibernate")).toEqual([
      expect.objectContaining({ kind: "kept", threadId: "busy", reason: "Busy", path: "/w/busy" }),
      expect.objectContaining({ kind: "kept", threadId: "touched", reason: "New activity during the run" }),
      expect.objectContaining({ kind: "failed", threadId: "broken", reason: "Hibernation failed", detail: "worktree is locked" }),
      expect.objectContaining({ kind: "failed", threadId: "unknown", reason: "Not in this scan" }),
      // Archived just before, so it is not hibernated as well.
      expect.objectContaining({ kind: "kept", threadId: "idle", reason: "Archived in this run" }),
    ]);
  });

  it("runs under the settings it was reviewed with, and reuses the scan's projects", async () => {
    let settings = off;
    const deps = hibernation({ getPolicy: () => settings });
    const items = [candidate("newest", { daysIdle: 30, cwd: "/w/newest" })];
    const { service, deps: serviceDeps } = harness(items, { hibernation: deps });
    const scan = await service.scan({ projectKey: "/projects/app" });
    expect(scan.hibernate?.items).toHaveLength(1);
    // The archive step resolved the project; hibernation reuses it.
    expect(serviceDeps.resolveProject).toHaveBeenCalledTimes(1);
    settings = { ...off, maxSnapshotMb: 5, idleDays: 30 };
    await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false,
      hibernate: [{ backend: "codex", threadId: "newest" }] });
    expect(vi.mocked(deps.hibernate).mock.calls[0]![1]).toEqual({ ...off, enabled: true });
  });
});

/** A linked worktree of a fresh repository, on its own branch. Archive
 * removes only linked worktrees, so that is what most cases inspect. */
describe("scan steps and progress", () => {
  const threadPaths = ["/w/a", "/w/b", "/w/c"];
  const checkoutPaths = ["/w/x", "/w/u"];
  const policy = { enabled: false, idleDays: 5, maxSnapshotMb: 25, removeRebuildableOutput: true, restoreOn: "send" as const };

  function setup() {
    const hibernation: CheckoutHibernationReviewDeps = {
      getPolicy: () => policy,
      keepReason: vi.fn((item: ThreadArchiveCandidate) => ({ target: item.thread.linkedDirectories[0]!.worktreePath! })),
      inspect: vi.fn(async () => ({ files: 0, bytes: 0 })),
      hibernate: vi.fn(async () => true),
    };
    return {
      hibernation,
      ...harness(threadPaths.map((cwd) => candidate(cwd.slice(3), { cwd })), {
        hibernation,
        auditArchivedCheckouts: vi.fn(async (): Promise<ArchivedCheckoutAudit> => ({
          candidates: [{ backend: "codex", threadId: "x", worktreePath: "/w/x" }],
          kept: {}, emptyFolders: 0, unreferenced: ["/w/u"],
        })),
      }),
    };
  }

  // Model: a scan reads exactly the steps it is asked for. A step it was not
  // asked for costs no Git inspection and comes back empty. Progress names
  // only those steps, in run order, and each step ends with every item
  // counted and nothing in flight.
  it("reads only the requested steps and reports each one through its last item", async () => {
    const all: ThreadMaintenanceScanStep[] = ["threads", "hibernate", "checkouts"];
    await fc.assert(fc.asyncProperty(fc.subarray(all, { minLength: 1 }), async (steps) => {
      const { service, deps, hibernation } = setup();
      const progress: ScanProgressSnapshot[] = [];
      const scan = await service.scan({ steps }, { onProgress: (next) => progress.push(next) });
      expect(scan.steps).toEqual(steps);

      const inspected = vi.mocked(deps.inspectWorkspace!).mock.calls.map(([cwd]) => cwd);
      expect(inspected.some((cwd) => threadPaths.includes(cwd))).toBe(steps.includes("threads"));
      expect(inspected.some((cwd) => checkoutPaths.includes(cwd))).toBe(steps.includes("checkouts"));
      expect(vi.mocked(hibernation.inspect).mock.calls.length > 0).toBe(steps.includes("hibernate"));
      expect(vi.mocked(deps.auditArchivedCheckouts).mock.calls).toHaveLength(steps.includes("checkouts") ? 1 : 0);
      if (!steps.includes("threads")) expect(scan.threads.projects).toEqual([]);
      if (!steps.includes("hibernate")) expect(scan.hibernate).toBeUndefined();
      if (!steps.includes("checkouts")) expect(scan.checkouts.items).toEqual([]);

      expect(progress.every((item) => item.steps.join() === steps.join())).toBe(true);
      expect([...new Set(progress.map((item) => item.step))]).toEqual(steps);
      for (const step of steps) {
        const checking = progress.filter((item) => item.step === step && item.stage === "checking");
        expect(checking.every((item) => item.processed <= item.total && item.inFlight.length <= 6)).toBe(true);
        const last = checking.at(-1)!;
        expect(last.processed).toBe(last.total);
        expect(last.inFlight).toEqual([]);
        expect(last.total).toBe(step === "checkouts" ? checkoutPaths.length : threadPaths.length);
      }
    }), { numRuns: 20 });
  });

  it("names what it is checking while it checks it", async () => {
    const { service } = setup();
    const progress: ScanProgressSnapshot[] = [];
    await service.scan({ steps: ["threads", "checkouts"] }, { onProgress: (next) => progress.push(next) });
    expect(progress[0]).toEqual({ steps: ["threads", "checkouts"], step: "threads", stage: "listing", processed: 0, total: 0, inFlight: [] });
    const named = new Set(progress.flatMap((item) => item.inFlight));
    expect(named).toEqual(new Set(["Thread a", "Thread b", "Thread c", "/w/x", "/w/u"]));
  });

  it("reads every step when none are named, as the agent tool asks", async () => {
    const { service, deps } = setup();
    const scan = await service.scan();
    expect(scan.steps).toBeUndefined();
    expect(scan.threads.checked).toBe(3);
    expect(scan.hibernate?.checked).toBe(3);
    expect(deps.auditArchivedCheckouts).toHaveBeenCalledOnce();
  });
});

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
