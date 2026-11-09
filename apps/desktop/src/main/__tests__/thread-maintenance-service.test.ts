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
  it("normalizes the retired ignored-file rule so older requests cannot restore the blocker", async () => {
    const { service } = harness([]);
    const scan = await service.scan({ rules: { rebuildableOutputIsClean: false } });
    expect(scan.rules.rebuildableOutputIsClean).toBe(true);
  });

  it("classifies output only in positively owned checkouts, regardless of unrelated inventory paths", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (unknownCount) => {
      const owner = candidate("owned", { cwd: "/fixture/owned" });
      const unknown = Array.from({ length: unknownCount }, (_, index) => `/other-profile/checkout-${index}`);
      const scans: string[] = [];
      const row = (checkout: string) => ({ kind: "cargo" as const, checkoutPath: checkout,
        outputPath: `${checkout}/target/debug`, manifestPath: `${checkout}/Cargo.toml`, space: { allocatedBytes: 4096 } });
      const audit = { candidates: [], kept: {}, emptyFolders: 0, unreferenced: unknown,
        inventory: { roots: [], paths: ["/fixture/owned", ...unknown], repositories: ["/unrelated-primary"], providers: [],
          owners: [{ path: "/fixture/owned", threads: [{ backend: "codex", threadId: "owned", title: owner.thread.title }], candidates: [owner] }] } };
      const { service, deps } = harness([owner], { auditArchivedCheckouts: async () => audit,
        buildOutputs: { scan: async (roots) => {
          scans.push(...roots);
          return { items: [...roots, "/unexpected-detector-result"].map((checkout) => ({ row: row(checkout), identity: "fixture" })), kept: [] };
        }, remove: async () => ({}) },
      });
      const scan = await service.scan({ steps: ["checkouts"] });
      expect(scans).toEqual(["/fixture/owned"]);
      expect(scan.checkouts.buildOutputs).toHaveLength(1);
      expect(scan.checkouts.buildOutputs![0]).toMatchObject({ checkoutPath: "/fixture/owned", threads: [{ backend: "codex", threadId: "owned" }] });
      expect(scan.checkouts.items.some((item) => item.kind === "unreferenced")).toBe(false);
      expect(deps.archiveFamily).not.toHaveBeenCalled();
    }), { numRuns: 8 });
  });

  it("classifies each shared checkout once, aggregates unique profiles and retains every identified owner", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.option(fc.nat({ max: 1_000_000 }), { nil: undefined }), { minLength: 1, maxLength: 6 }),
      fc.boolean(), async (sizes, incomplete) => {
        const checkout = path.resolve("/fixture/repo");
        const active = candidate("active", { cwd: checkout });
        const archived = candidate("archived", { cwd: checkout });
        const rows = sizes.map((bytes, index) => ({ row: { kind: "cargo" as const, checkoutPath: checkout,
          outputPath: path.join(checkout, "target", `profile-${index}`), manifestPath: path.join(checkout, "Cargo.toml"),
          ...(bytes !== undefined ? { space: { allocatedBytes: bytes } } : {}) }, identity: "fixture" }));
        const scanOutputs = vi.fn(async () => ({ items: [...rows, rows[0]!],
          kept: incomplete ? [{ path: path.join(checkout, "target", "busy"), reason: "Cargo build in progress" }] : [] }));
        const { service } = harness([active], {
          hibernation: { getPolicy: () => ({ enabled: true, idleDays: 7, maxSnapshotMb: 100, removeRebuildableOutput: true, restoreOn: "send" }),
            keepReason: () => ({ target: checkout, keep: "Watching a PR" }),
            inspect: async () => ({ files: 0, bytes: 0 }), hibernate: async () => true },
          auditArchivedCheckouts: async () => ({ candidates: [], kept: {}, emptyFolders: 0,
            inventory: { roots: [], paths: [checkout], providers: [],
              owners: [{ path: checkout, threads: [], candidates: [active, archived] }] } }),
          buildOutputs: { scan: scanOutputs, remove: async () => ({}) },
        });
        const scan = await service.scan({ steps: ["hibernate", "checkouts"] });
        expect(scanOutputs).toHaveBeenCalledTimes(1);
        expect(scan.checkouts.buildOutputs).toHaveLength(sizes.length);
        expect(scan.checkouts.buildOutputs!.every((row) => row.threads?.map((thread) => thread.threadId).join() === "active,archived")).toBe(true);
        const measured = sizes.filter((size) => size !== undefined);
        expect(scan.hibernate!.coverage!.keptCheckouts![0]!.rebuildableOutput).toEqual([{
          kind: "cargo", ...(measured.length ? { allocatedBytes: measured.reduce((sum, value) => sum + value, 0) } : {}),
          ...(incomplete || measured.length !== sizes.length ? { lowerBound: true } : {}),
        }]);
        expect(scan.hibernate!.items).toEqual([]);
      }), { numRuns: 30 });
  });

  it("matches fresh provider ownership before deleting an output", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("codex" as const, "claude" as const, "acp:grok" as const),
      fc.constantFrom("same", "descendant", "ancestor", "moved", "unreadable", "missing"), async (backend, state) => {
        const owner = candidate("owner", { cwd: "/fixture/repo" });
        owner.thread.source = backend;
        const row = { kind: "cargo" as const, checkoutPath: "/fixture/repo", outputPath: "/fixture/repo/target/debug",
          manifestPath: "/fixture/repo/Cargo.toml", space: { allocatedBytes: 1024 } };
        const remove = vi.fn(async () => ({ allocatedBytesRemoved: 1024 }));
        const { service } = harness([owner], {
          auditArchivedCheckouts: async () => ({ candidates: [], kept: {}, emptyFolders: 0,
            inventory: { roots: [], paths: [row.checkoutPath], providers: [],
              owners: [{ path: row.checkoutPath, threads: [], candidates: [owner] }] } }),
          refreshCandidate: async () => {
            if (state === "missing") throw new Error("Provider no longer has the thread");
            const cwd = state === "ancestor" ? "/fixture" : state === "moved" ? "/other/repo"
              : state === "descendant" ? "/fixture/repo/src" : row.checkoutPath;
            const refreshed = candidate("owner", { cwd });
            refreshed.thread.source = backend;
            if (state === "unreadable") refreshed.unreadable = true;
            return refreshed;
          },
          buildOutputs: { scan: async () => ({ items: [{ row, identity: "fixture" }], kept: [] }), remove },
        });
        const scan = await service.scan({ steps: ["checkouts"] });
        const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false,
          removeBuildOutputs: [{ outputPath: row.outputPath }] });
        const allowed = state === "same" || state === "descendant";
        expect(remove).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(run.steps.find((item) => item.step === "checkouts")).toMatchObject({ done: allowed ? 1 : 0, kept: allowed ? 0 : 1, failed: 0 });
      }), { numRuns: 40 });
  });

  it("classifies a kept owned checkout during ordinary hibernation review without making it eligible", async () => {
    const checkout = path.resolve("/fixture/recent");
    const owner = candidate("recent", { cwd: checkout });
    const output = { kind: "cargo" as const, checkoutPath: checkout, outputPath: path.join(checkout, "target", "debug"),
      manifestPath: path.join(checkout, "Cargo.toml"), space: { allocatedBytes: 9000 } };
    const { service } = harness([owner], { measureAllocation: async () => ({ allocatedBytes: 10000 }),
      hibernation: {
        getPolicy: () => ({ enabled: true, idleDays: 7, maxSnapshotMb: 100, removeRebuildableOutput: true, restoreOn: "send" }),
        keepReason: () => ({ target: checkout, keep: "Recently active" }),
        inspect: async () => ({ files: 0, bytes: 0 }), hibernate: async () => true,
      },
      buildOutputs: { scan: async () => ({ items: [{ row: output, identity: "fixture" }], kept: [] }), remove: async () => ({}) },
    });
    const scan = await service.scan({ steps: ["hibernate"] });
    expect(scan.hibernate!.items).toEqual([]);
    expect(scan.hibernate!.coverage!.keptCheckouts![0]).toMatchObject({ reason: "Recently active",
      rebuildableOutput: [{ kind: "cargo", allocatedBytes: 9000 }] });
  });

  it("revalidates the thread association before clearing a reviewed build output", async () => {
    const owner = candidate("moved", { cwd: "/fixture/owned" });
    const row = { kind: "cargo" as const, checkoutPath: "/fixture/owned", outputPath: "/fixture/owned/target/debug",
      manifestPath: "/fixture/owned/Cargo.toml", space: { allocatedBytes: 4096 } };
    const remove = vi.fn(async () => ({ allocatedBytesRemoved: 4096 }));
    const audit = { candidates: [], kept: {}, emptyFolders: 0, inventory: { roots: [], paths: [row.checkoutPath], providers: [],
      owners: [{ path: row.checkoutPath, threads: [{ backend: "codex", threadId: owner.thread.id, title: owner.thread.title }], candidates: [owner] }] } };
    const { service } = harness([owner], { auditArchivedCheckouts: async () => audit,
      refreshCandidate: async () => candidate("moved", { cwd: "/fixture/new-checkout" }),
      buildOutputs: { scan: async () => ({ items: [{ row, identity: "fixture" }], kept: [] }), remove },
    });
    const scan = await service.scan({ steps: ["checkouts"] });
    const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false,
      removeBuildOutputs: [{ outputPath: row.outputPath }] });
    expect(remove).not.toHaveBeenCalled();
    expect(run.steps.find((item) => item.step === "checkouts")).toMatchObject({ done: 0, kept: 1 });
  });

  it("rechecks work activity rather than view acknowledgements between hibernation review and apply", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("view", "work", "restore"), async (change) => {
      const original = candidate("reviewed", { cwd: "/fixture/reviewed" });
      const refreshed = { ...original, thread: { ...original.thread },
        overlay: { backend: "codex" as const, threadId: "reviewed", extraLinkedDirectories: [],
          ...(change === "view" ? { lastSeenAt: NOW } : {}),
          ...(change === "restore" ? { archiveRestoredAt: NOW } : {}),
        } };
      if (change === "work") refreshed.thread.updatedAt = NOW;
      const hibernate = vi.fn(async () => true);
      const { service } = harness([original], { refreshCandidate: async () => refreshed,
        hibernation: {
          getPolicy: () => ({ enabled: true, idleDays: 1, maxSnapshotMb: 100, removeRebuildableOutput: true, restoreOn: "send" }),
          keepReason: () => ({ target: "/fixture/reviewed" }), inspect: async () => ({ files: 0, bytes: 0 }), hibernate,
        },
      });
      const scan = await service.scan({ steps: ["hibernate"] });
      const run = await service.apply({ scanId: scan.scanId, archive: [], hibernate: [{ backend: "codex", threadId: "reviewed" }],
        removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false });
      expect(run.steps.find((row) => row.step === "hibernate")).toMatchObject({ done: change === "view" ? 1 : 0, kept: change === "view" ? 0 : 1 });
      expect(hibernate).toHaveBeenCalledTimes(change === "view" ? 1 : 0);
    }), { numRuns: 15 });
  });

  it("preserves every kept path's real owners and watch links without offering it for hibernation", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.record({
      owners: fc.integer({ min: 1, max: 3 }),
      kept: fc.boolean(),
      measured: fc.boolean(),
    }), { minLength: 11, maxLength: 15 }), async (model) => {
      const rows = model.flatMap((entry, index) => Array.from({ length: entry.owners }, (_, owner) => {
        const backend = ["codex", "claude", "acp:grok"][owner]! as ThreadArchiveCandidate["thread"]["source"];
        const row = candidate(`thread-${index}`, { cwd: `/worktrees/${index}/project`, parent: owner ? "remote-parent" : undefined });
        row.thread.source = backend;
        row.thread.title = `Project ${index}, owner ${owner}`;
        row.overlay = { backend, threadId: row.thread.id, extraLinkedDirectories: [],
          gitBranch: `fix/project-${index}`, lastSeenAt: NOW - DAY,
          ...(owner ? { parentThreadId: "remote-parent", parentThreadInstanceId: "peer" } : {}),
        };
        return Object.assign(row, { activePrWatch: entry.kept, activePrWatches: [{
          watchId: `watch-${index}-${owner}`, backend, threadId: row.thread.id,
          prKey: `github.com/example/project/${index + 1}`, prUrl: `https://github.com/example/project/pull/${index + 1}`,
          prNumber: index + 1, prTitle: `Project ${index} fix`, headSha: "head", notifyOn: [], createdAt: NOW, failureHandledByAutoFix: false,
        }] });
      }));
      const { service, deps } = harness(rows, {
        measureAllocation: async (target) => model[Number(target.split("/")[2])]!.measured ? { allocatedBytes: 4096 } : undefined,
        hibernation: {
          getPolicy: () => ({ enabled: true, idleDays: 1, maxSnapshotMb: 100, removeRebuildableOutput: true, restoreOn: "send" }),
          keepReason: (row) => ({ target: row.thread.linkedDirectories[0]!.worktreePath,
            ...(row.activePrWatch ? { keep: "Watching a PR" } : {}) }),
          inspect: async () => ({ files: 0, bytes: 0 }), hibernate: async () => true,
        },
      });
      const scan = await service.scan({ steps: ["hibernate"] });
      const coverage = scan.hibernate!.coverage!;
      const kept = coverage.keptCheckouts ?? [];
      expect(kept.map((row) => row.path).sort()).toEqual(model.flatMap((entry, index) => entry.kept ? [`/worktrees/${index}/project`] : []).sort());
      for (const row of kept) {
        const index = Number(row.path.split("/")[2]);
        expect(row).toMatchObject({ reason: "Watching a PR", ...(model[index]!.measured ? { allocatedBytes: 4096 } : {}) });
        if (!model[index]!.measured) expect(row.allocatedBytes).toBeUndefined();
        expect(row.threads).toEqual(rows.filter((owner) => owner.thread.linkedDirectories[0]!.worktreePath === row.path).map((owner) => ({
          backend: owner.thread.source, threadId: owner.thread.id, title: owner.thread.title,
          branch: owner.overlay!.gitBranch, lastActivityAt: owner.thread.updatedAt,
          pullRequests: [{ url: owner.activePrWatches[0]!.prUrl, number: index + 1, title: `Project ${index} fix` }],
        })));
        expect(scan.hibernate!.items.some((item) => item.worktreePath === row.path)).toBe(false);
      }
      expect(coverage.largestKept).toEqual([...kept].sort((a, b) => (b.allocatedBytes ?? -1) - (a.allocatedBytes ?? -1)).slice(0, 10));
      expect(deps.archiveFamily).not.toHaveBeenCalled();
      expect(deps.removeArchivedCheckouts).not.toHaveBeenCalled();
    }), { numRuns: 20 });
  });

  it("keeps archived-audit owner context for all kept paths, including paths with no known owner", async () => {
    const owner = { backend: "claude", threadId: "owner", title: "Investigate widget layout", branch: "fix/widget", lastActivityAt: NOW };
    const paths = Array.from({ length: 12 }, (_, index) => `/worktrees/archived-${index}/project`);
    const audit = { candidates: [], kept: {}, emptyFolders: 0, inventory: { roots: ["/worktrees"], paths,
      providers: [{ backend: "claude", threads: 1 }],
      keptPaths: paths.map((target) => ({ path: target, reason: "Used by an active thread" })),
      owners: paths.map((target, index) => ({ path: target, threads: index === 0 ? [owner] : [],
        candidates: [candidate(`owner-${index}`, { cwd: target })] })),
    } };
    const { service } = harness([], { auditArchivedCheckouts: async () => audit, measureAllocation: async () => ({ allocatedBytes: 1024 }) });
    const scan = await service.scan({ steps: ["checkouts"] });
    expect(scan.checkouts.coverage!.keptCheckouts).toHaveLength(paths.length);
    expect(scan.checkouts.coverage!.keptCheckouts![0]).toMatchObject({ path: paths[0], threads: [owner] });
    expect(scan.checkouts.coverage!.keptCheckouts!.slice(1).every((row) => !row.threads?.length)).toBe(true);
    expect(scan.checkouts.items).toEqual([]);
  });

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
    const owner = candidate("recent", { daysIdle: 0, cwd: row.checkoutPath });
    const { service } = harness([owner], {
      auditArchivedCheckouts: async () => ({ candidates: [], kept: {}, emptyFolders: 0,
        inventory: { roots: [], paths: [row.checkoutPath], providers: [],
          owners: [{ path: row.checkoutPath, threads: [], candidates: [owner] }] } }),
      inspectWorkspace: async () => ({ keep: "Commits on no branch" }),
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
      const owners = rows.map((row, index) => candidate(String(index), { cwd: row.checkoutPath }));
      const { service } = harness(owners, {
        auditArchivedCheckouts: async () => ({ candidates: [], kept: {}, emptyFolders: 0,
          inventory: { roots: [], paths: rows.map((row) => row.checkoutPath), providers: [],
            owners: rows.map((row, index) => ({ path: row.checkoutPath, threads: [], candidates: [owners[index]!] })) } }),
        buildOutputs: {
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

  it("bounds kept-checkout context in agent results while the dialog retains the complete review", async () => {
    const scan = await harness([]).service.scan({ steps: ["checkouts"] });
    fc.assert(fc.property(fc.integer({ min: 101, max: 130 }), (count) => {
      const coverage = { roots: [], keptCheckouts: Array.from({ length: count }, (_, index) => ({
        path: `/fixture/${index}`, reason: "Watching a PR", allocatedBytes: count - index,
        threads: [{ backend: "codex", threadId: String(index), title: `Fixture ${index}` }],
      })) };
      scan.checkouts.coverage = coverage;
      scan.hibernate = { idleDays: 3, maxSnapshotMb: 100, removeRebuildableOutput: true,
        checked: count, items: [], kept: {}, coverage };
      const summary = summarizeThreadMaintenanceScan(scan);
      expect(summary.checkouts.coverage?.keptCheckouts).toEqual(coverage.keptCheckouts.slice(0, 100));
      expect(summary.hibernate?.coverage?.keptCheckouts).toEqual(coverage.keptCheckouts.slice(0, 100));
      expect(summary.checkouts.truncated).toBe(true);
      expect(summary.hibernate?.truncated).toBe(true);
      expect(scan.checkouts.coverage.keptCheckouts).toHaveLength(count);
    }), { numRuns: 10 });
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
      candidate("env", { daysIdle: 50, cwd: "/w/unretained" }),
    ]);
    workspaces.set("/w/unretained", { keep: "Commits on no branch" });
    workspaces.set("/w/old", { kind: "changes", files: 2, bytes: 40 });
    const scan = await service.scan();
    expect(scan.threads.checked).toBe(5);
    expect(scan.threads.projects).toHaveLength(1);
    const [project] = scan.threads.projects;
    expect(project!.idle.map((row) => row.threadId)).toEqual(["older", "old"]);
    expect(project!.idle[1]!.workspace).toEqual({ kind: "changes", files: 2, bytes: 40 });
    expect(project!.kept).toEqual({ "Pinned thread": 1, "Commits on no branch": 1, "Within the per-project limit": 1 });
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

describe("unattributed checkout requests", () => {
  it("never offers or removes an unattributed path, even when an older scan supplied it", async () => {
    await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.integer({ min: 0, max: 100 }), { maxLength: 12 }), async (ids) => {
      const paths = ids.map((id) => `/unknown/${id}`);
      const removeUnreferencedCheckouts = vi.fn(async () => ({ removed: [], kept: [], failed: [] }));
      const { service, deps } = harness([], { removeUnreferencedCheckouts,
        auditArchivedCheckouts: async () => ({ candidates: [], kept: {}, emptyFolders: 0, unreferenced: paths }),
      });
      const scan = await service.scan({ steps: ["checkouts"] });
      expect(scan.checkouts.items).toEqual([]);
      expect(deps.inspectWorkspace).not.toHaveBeenCalled();
      const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
        removeUnreferenced: paths.map((worktreePath) => ({ worktreePath })), removeEmptyFolders: false });
      expect(removeUnreferencedCheckouts).not.toHaveBeenCalled();
      expect(run.steps.find((step) => step.step === "checkouts")).toMatchObject({ done: 0, kept: paths.length, failed: 0 });
    }), { numRuns: 20 });
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
  const checkoutPaths = ["/w/x"];
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
    expect(named).toEqual(new Set(["Thread a", "Thread b", "Thread c", "/w/x"]));
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
  it("ignored files never change snapshot eligibility or saved-work size", async () => {
    const root = await tempRoot();
    const { repo, worktree } = await linkedWorktree(root);
    await writeFile(path.join(repo, ".git", "info", "exclude"), "scratch/\n");
    await writeFile(path.join(worktree, "file.txt"), "edited\n");
    await writeFile(path.join(worktree, "notes.txt"), "new work\n");
    const paths = [".env.local", "node_modules/dep/output.bin", "dist/bundle.js", "scratch/custom-output.bin"];
    await fc.assert(fc.asyncProperty(fc.subarray(paths, { minLength: 1 }), fc.integer({ min: 128, max: 100_000 }), fc.boolean(),
      async (ignored, bytes, legacyRule) => {
        for (const entry of [".env.local", "node_modules", "dist", "scratch"]) await rm(path.join(worktree, entry), { recursive: true, force: true });
        for (const file of ignored) {
          await mkdir(path.dirname(path.join(worktree, file)), { recursive: true });
          await writeFile(path.join(worktree, file), Buffer.alloc(bytes));
        }
        expect(await inspectMaintenanceWorkspace(worktree, { signal: new AbortController().signal,
          limitBytes: 64, rebuildableOutputIsClean: legacyRule })).toMatchObject({
          workspace: { kind: "changes", files: 2, bytes: Buffer.byteLength("edited\nnew work\n") },
        });
      }), { numRuns: 12 });
  });

  const options = (rebuildableOutputIsClean: boolean) => ({ signal: new AbortController().signal, limitBytes: 64, rebuildableOutputIsClean });

  it("describes rebuildable output without treating any ignored files as a blocker", async () => {
    const root = await tempRoot();
    const { worktree } = await linkedWorktree(root);
    expect(await inspectMaintenanceWorkspace(worktree, options(true))).toEqual({ workspace: { kind: "clean" } });
    await mkdir(path.join(worktree, "node_modules", "left-pad"), { recursive: true });
    await writeFile(path.join(worktree, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    expect(await inspectMaintenanceWorkspace(worktree, options(true)))
      .toEqual({ workspace: { kind: "clean", rebuildableOutput: ["node_modules"] } });
    expect(await inspectMaintenanceWorkspace(worktree, options(false)))
      .toEqual({ workspace: { kind: "clean", rebuildableOutput: ["node_modules"] } });
    await writeFile(path.join(worktree, ".env.local"), "TOKEN=secret\n");
    expect(await inspectMaintenanceWorkspace(worktree, options(true)))
      .toEqual({ workspace: { kind: "clean", rebuildableOutput: ["node_modules"] } });
  });

  it("excludes ignored files inside a tracked folder without labelling that folder rebuildable", async () => {
    const root = await tempRoot();
    const { worktree, git } = await linkedWorktree(root);
    await mkdir(path.join(worktree, "src", "build"), { recursive: true });
    await writeFile(path.join(worktree, "src", "build", "config.ts"), "export {};\n");
    await git("add", ".");
    await git("-c", "commit.gpgsign=false", "commit", "-m", "tracked build folder");
    await writeFile(path.join(worktree, "src", "build", ".env.local"), "TOKEN=secret\n");
    expect(await inspectMaintenanceWorkspace(worktree, options(true))).toEqual({ workspace: { kind: "clean" } });
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
  it("review regression: classifies and offers only the selected project's primary and linked checkouts", async () => {
    const root = await tempRoot();
    const projects = await Promise.all(["app", "app-other"].map(async (name) => {
      const { repo, git } = await gitRepo(root, name);
      const checkout = path.join(root, "worktrees", name);
      await git("worktree", "add", "-b", "linked", checkout);
      return { repo, checkout };
    }));
    const entries = projects.flatMap((project, index) => [project.repo, project.checkout].map((target, part) => ({
      path: target, project: index, candidate: candidate(`owner-${index}-${part}`, { cwd: target }),
    })));
    await fc.assert(fc.asyncProperty(fc.constantFrom(undefined, 0, 1), fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length }),
      async (selected, inventory) => {
        const measured: string[] = [], classified: string[] = [];
        const removed: string[] = [];
        const { service } = harness(inventory.map((item) => item.candidate), {
          auditArchivedCheckouts: async () => ({ candidates: [], kept: {}, emptyFolders: 0,
            inventory: { roots: [], paths: inventory.map((item) => item.path), providers: [],
              owners: inventory.map((item) => ({ path: item.path, candidates: [item.candidate], threads: [] })) } }),
          measureAllocation: async (target) => { measured.push(target); return { allocatedBytes: 1024 }; },
          buildOutputs: {
            scan: async (roots) => {
              classified.push(...roots);
              return { items: roots.map((target) => ({ identity: "fixture", row: { kind: "cargo" as const,
                checkoutPath: target, outputPath: path.join(target, "target", "debug"), manifestPath: path.join(target, "Cargo.toml") } })), kept: [] };
            },
            remove: async ({ row }) => { removed.push(row.checkoutPath); return { allocatedBytesRemoved: 1024 }; },
          },
        });
        const scan = await service.scan({ steps: ["checkouts"], ...(selected !== undefined ? { projectKey: projects[selected]!.repo } : {}) });
        const expected = inventory.filter((item) => selected === undefined || item.project === selected).map((item) => item.path).sort();
        expect([...measured].sort()).toEqual(expected);
        expect([...classified].sort()).toEqual(expected);
        expect(scan.checkouts.buildOutputs!.map((row) => row.checkoutPath).sort()).toEqual(expected);
        const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false,
          removeBuildOutputs: scan.checkouts.buildOutputs!.map((row) => ({ outputPath: row.outputPath })) });
        expect([...removed].sort()).toEqual(expected);
        expect(run.steps.find((step) => step.step === "checkouts")).toMatchObject({ done: expected.length, kept: 0, failed: 0 });
      }), { numRuns: 12 });
  });

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
