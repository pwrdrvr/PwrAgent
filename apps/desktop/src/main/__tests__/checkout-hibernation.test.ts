import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DesktopCheckoutHibernationPolicy, WorktreeSnapshotSummary } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb } from "./sqlite-test-utils";
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { SnapshotTreeMismatchError, WorktreeArchiveService } from "../app-server/worktree-archive-service";
import {
  HIBERNATION_WORKSPACE_KEEP_REASONS,
  inspectHibernationWorkspace,
} from "../app-server/checkout-hibernation-workspace";
import { registerWorktreeTerminalOwner } from "../terminal/worktree-terminals";
import { ArchiveWorktreeTransport } from "./fixtures/archive-worktree-transport";
import type { CodexEnvironmentCommandRunner } from "../app-server/codex-environment-runtime";

/**
 * Real Git and real SQLite. Each keep case builds the Git state it names
 * with Git itself, then checks that hibernation leaves the checkout alone.
 */

const probeHook = vi.hoisted(() => ({ onInspect: undefined as undefined | ((call: number) => void), calls: 0 }));
vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../codex-app-server/stdio-transport", async () => ({
  StdioJsonRpcTransport: (await import("./fixtures/archive-worktree-transport")).ArchiveWorktreeTransport,
}));
vi.mock("../app-server/checkout-hibernation-workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app-server/checkout-hibernation-workspace")>();
  return {
    ...actual,
    inspectHibernationWorkspace: async (...args: Parameters<typeof actual.inspectHibernationWorkspace>) => {
      probeHook.calls += 1;
      probeHook.onInspect?.(probeHook.calls);
      return await actual.inspectHibernationWorkspace(...args);
    },
  };
});

const execute = promisify(execFile);
const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const identity = { backend: "codex" as const, threadId: THREAD_ID };
const MB = 1024 * 1024;
const registries: DesktopBackendRegistry[] = [];
const databases: StateDb[] = [];
const roots: string[] = [];
const releases: Array<() => void> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const release of releases.splice(0)) release();
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  ArchiveWorktreeTransport.threads = [];
  ArchiveWorktreeTransport.requests = [];
  ArchiveWorktreeTransport.onList = undefined;
  probeHook.onInspect = undefined;
  probeHook.calls = 0;
});

const ON: DesktopCheckoutHibernationPolicy = {
  enabled: true, idleDays: 7, maxSnapshotMb: 5, removeRebuildableOutput: true, restoreOn: "send",
};

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execute("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args])).stdout;
}

async function createFixture(options: { environment?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-hibernate-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  const worktree = path.join(root, ".pwragent", "worktrees", "id", "repo");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(repo, "file.txt"), "original\n");
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\n.env.local\n");
  if (options.environment) {
    await mkdir(path.join(repo, ".codex", "environments"), { recursive: true });
    await writeFile(path.join(repo, ".codex", "environments", "env.toml"), 'version = 1\nname = "Env"\n[setup]\nscript = "install"\n');
  }
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "fixture"]);
  await mkdir(path.dirname(worktree), { recursive: true });
  await git(repo, ["worktree", "add", "-b", "owned", worktree]);
  const directory = { id: "owned", kind: "worktree" as const, label: "repo", path: repo, worktreePath: worktree };
  ArchiveWorktreeTransport.threads = [{ id: THREAD_ID, cwd: worktree, source: "cli", status: { type: "notLoaded" } }];
  const { dbPath, tempDir } = createTempStateDb("pwragent-hibernate-db-");
  roots.push(tempDir);
  const open = (policy: DesktopCheckoutHibernationPolicy = ON, extra: { commandRunner?: CodexEnvironmentCommandRunner } = {}) => {
    // Without the counters every budget below, the zeros included, would pass unmeasured.
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    const db = StateDb.open(dbPath);
    databases.push(db);
    const store = new SqliteOverlayStore(db);
    const client = new CodexAppServerClient({ directoryResolver: async (cwd) => cwd === worktree ? [directory] : [] });
    let current = policy;
    const registry = new DesktopBackendRegistry({
      codexClient: client, overlayStore: store, messagingStore: null, threadTitleGenerationService: null,
      runtimeInstanceId: `hibernate-${registries.length}`, resolveLiveProfileRuntimeInstanceIds: () => [],
      archiveCleanupCheckpointStore: null,
      getThreadArchivePolicy: () => ({ enabled: false, mode: "count", inactivityDays: 30, keepPerProject: 20, retentionDays: 0 }),
      getCheckoutHibernationPolicy: () => current,
      ...(extra.commandRunner ? { codexEnvironmentCommandRunner: extra.commandRunner } : {}),
      discoverLocalAcpAgents: async () => [],
      managedWorktreeRoots: async () => [path.join(root, ".pwragent", "worktrees")],
    });
    registries.push(registry);
    return { db, store, registry, setPolicy: (next: DesktopCheckoutHibernationPolicy) => { current = next; } };
  };
  return { root, repo, worktree, directory, open };
}

async function exists(target: string): Promise<boolean> {
  try { await stat(target); return true; } catch { return false; }
}

async function snapshotOf(store: SqliteOverlayStore): Promise<WorktreeSnapshotSummary | undefined> {
  return (await store.getThreadOverlayState(identity))?.worktreeSnapshots?.[0];
}

async function sweep(registry: DesktopBackendRegistry) {
  await registry.sweepInactiveThreads({ manual: false });
  return registry.getThreadArchiveSweepStatus().hibernation;
}

/** The provider turn start is out of scope; the restore hook before it is not. */
function stubProviderTurnStart(registry: DesktopBackendRegistry) {
  return vi.spyOn(registry as unknown as { startTurnWithoutHandoff: (params: { threadId: string }) => Promise<unknown> },
    "startTurnWithoutHandoff").mockImplementation(async (params) => ({ backend: "codex", threadId: params.threadId, turnId: `turn-${Date.now()}` }));
}

function recreateSpy(registry: DesktopBackendRegistry) {
  const service = (registry as unknown as { worktreeRecoveryService: { recreate: (...args: unknown[]) => Promise<unknown> } }).worktreeRecoveryService;
  return vi.spyOn(service, "recreate");
}

const probe = (cwd: string, overrides: Partial<{ limitBytes: number; removeRebuildableOutput: boolean }> = {}) =>
  inspectHibernationWorkspace(cwd, { signal: new AbortController().signal, limitBytes: 5 * MB, removeRebuildableOutput: true, ...overrides });

describe("hibernation workspace checks (real Git)", () => {
  it("accepts a clean checkout and one with small uncommitted changes", async () => {
    const { worktree } = await createFixture();
    expect(await probe(worktree)).toEqual({ files: 0, bytes: 0 });
    await writeFile(path.join(worktree, "file.txt"), "edited\n");
    await writeFile(path.join(worktree, "notes.txt"), "new\n");
    expect(await probe(worktree)).toMatchObject({ files: 2 });
  });

  it("keeps changes over the snapshot limit", async () => {
    const { worktree } = await createFixture();
    await writeFile(path.join(worktree, "big.bin"), Buffer.alloc(6 * MB, 1));
    expect(await probe(worktree)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.overLimit });
  });

  it("keeps a submodule with uncommitted work", async () => {
    const fixture = await createFixture();
    const sub = path.join(fixture.root, "sub");
    await mkdir(sub);
    await git(sub, ["init", "-b", "main"]);
    await writeFile(path.join(sub, "lib.txt"), "lib\n");
    await git(sub, ["add", "-A"]);
    await git(sub, ["commit", "-m", "sub"]);
    await git(fixture.worktree, ["submodule", "add", sub, "vendor/sub"]);
    await git(fixture.worktree, ["commit", "-m", "add submodule"]);
    expect(await probe(fixture.worktree)).toEqual({ files: 0, bytes: 0 });
    // Untracked content inside the submodule: the superproject diff names no file.
    await writeFile(path.join(fixture.worktree, "vendor", "sub", "scratch.txt"), "work\n");
    expect((await probe(fixture.worktree)).keep).toBe(HIBERNATION_WORKSPACE_KEEP_REASONS.submodule);
    await rm(path.join(fixture.worktree, "vendor", "sub", "scratch.txt"));
    await writeFile(path.join(fixture.worktree, "vendor", "sub", "lib.txt"), "changed\n");
    expect((await probe(fixture.worktree)).keep).toBeDefined();
  });

  it("keeps ignored files that are not rebuildable output", async () => {
    const { worktree } = await createFixture();
    await writeFile(path.join(worktree, ".env.local"), "SECRET=1\n");
    expect(await probe(worktree)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.otherIgnored });
  });

  it("removes node_modules only while the rebuildable output switch is on", async () => {
    const { worktree } = await createFixture();
    await mkdir(path.join(worktree, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(worktree, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    expect(await probe(worktree, { removeRebuildableOutput: true })).toEqual({ files: 0, bytes: 0, removedOutput: ["node_modules"] });
    expect(await probe(worktree, { removeRebuildableOutput: false })).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.ignored });
  });

  it("keeps a checkout in the middle of a rebase", async () => {
    const { repo, worktree } = await createFixture();
    await writeFile(path.join(worktree, "file.txt"), "branch side\n");
    await git(worktree, ["commit", "-am", "branch"]);
    await writeFile(path.join(repo, "file.txt"), "main side\n");
    await git(repo, ["commit", "-am", "main"]);
    await expect(git(worktree, ["rebase", "main"])).rejects.toThrow();
    expect(await probe(worktree)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.operation });
  });

  it("keeps a checkout in the middle of a merge", async () => {
    const { repo, worktree } = await createFixture();
    await writeFile(path.join(worktree, "file.txt"), "branch side\n");
    await git(worktree, ["commit", "-am", "branch"]);
    await writeFile(path.join(repo, "file.txt"), "main side\n");
    await git(repo, ["commit", "-am", "main"]);
    await expect(git(worktree, ["merge", "main"])).rejects.toThrow();
    expect(await probe(worktree)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.operation });
  });

  it("keeps a checkout with a bisect in progress", async () => {
    const { worktree } = await createFixture();
    await git(worktree, ["bisect", "start"]);
    expect(await probe(worktree)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.operation });
  });

  it("keeps a checkout whose branch has a stash", async () => {
    const { repo, worktree } = await createFixture();
    await writeFile(path.join(worktree, "file.txt"), "stashed\n");
    await git(worktree, ["stash", "push", "-m", "keep me"]);
    expect(await probe(worktree)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.stash });
    // Another branch's stash, in the same shared stash list, does not count.
    await git(worktree, ["stash", "drop"]);
    await writeFile(path.join(repo, "file.txt"), "main stash\n");
    await git(repo, ["stash", "push", "-m", "main's"]);
    await writeFile(path.join(worktree, "file.txt"), "other\n");
    await git(worktree, ["commit", "-am", "move off main's commit"]);
    expect(await probe(worktree)).toEqual({ files: 0, bytes: 0 });
  });

  it("keeps commits no branch or remote retains", async () => {
    const { worktree } = await createFixture();
    await git(worktree, ["checkout", "--detach"]);
    await writeFile(path.join(worktree, "file.txt"), "detached commit\n");
    await git(worktree, ["commit", "-am", "detached"]);
    expect(await probe(worktree)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.unretained });
  });

  it("keeps a locked worktree", async () => {
    const { repo, worktree } = await createFixture();
    await git(repo, ["worktree", "lock", worktree]);
    expect(await probe(worktree)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.locked });
  });
});

describe("hibernating a checkout (real Git)", () => {
  it("keeps the checkout when it changes after the snapshot is written", async () => {
    const { repo, worktree } = await createFixture();
    await writeFile(path.join(worktree, "file.txt"), "saved edit\n");
    const service = new WorktreeArchiveService();
    await expect(service.hibernate({
      ...identity, worktreePath: worktree, repositoryPath: repo, capSnapshotBytes: 5 * MB,
      beforeRemove: async () => {
        // An edit that lands between the snapshot and the removal.
        await writeFile(path.join(worktree, "late.txt"), "written while saving\n");
        return () => {};
      },
    })).rejects.toBeInstanceOf(SnapshotTreeMismatchError);
    expect(await readFile(path.join(worktree, "late.txt"), "utf8")).toBe("written while saving\n");
    expect(await readFile(path.join(worktree, "file.txt"), "utf8")).toBe("saved edit\n");
    // The per-path snapshot ref goes back to what it was: nothing.
    expect((await git(repo, ["for-each-ref", "refs/pwragent/snapshots/", "refs/codex/snapshots/"])).trim()).toBe("");
  });

  it("caps the snapshot at the hibernation limit even where archive would allow more", async () => {
    const { repo, worktree } = await createFixture();
    await writeFile(path.join(worktree, "big.bin"), Buffer.alloc(2 * MB, 1));
    const service = new WorktreeArchiveService({ maxSnapshotBytes: 100 * MB });
    await expect(service.hibernate({
      ...identity, worktreePath: worktree, repositoryPath: repo, capSnapshotBytes: 1 * MB, beforeRemove: async () => () => {},
    })).rejects.toThrow(/Snapshot size limit exceeded/);
    expect(await exists(path.join(worktree, "big.bin"))).toBe(true);
  });
});

describe("idle checkout hibernation and restore", () => {
  it("hibernates an idle checkout with one commit and restores it on the same path, branch and tree", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.worktree, "file.txt"), "uncommitted edit\n");
    await writeFile(path.join(fixture.worktree, "notes.txt"), "untracked notes\n");
    const before = await new WorktreeArchiveService().readCheckoutTree(fixture.worktree);
    const { registry, store } = fixture.open();

    const { writes } = await measureSqliteWrites(async () => {
      expect(await sweep(registry)).toMatchObject({ checked: 1, hibernated: 1 });
    });
    expectSqliteWriteBudget({ scenario: "checkout-hibernation-hibernate-one", note: "one sweep hibernates one idle checkout", writes });
    expect(await exists(fixture.worktree)).toBe(false);
    const snapshot = await snapshotOf(store);
    expect(snapshot).toMatchObject({ state: "hibernated", sourceBranch: "owned", worktreePath: fixture.worktree });
    expect(snapshot?.hibernatedAt).toBeGreaterThan(0);
    // The thread stays listed.
    expect((await registry.listAutoArchiveCandidates()).map(({ thread }) => thread.id)).toEqual([THREAD_ID]);

    const { writes: restoreWrites } = await measureSqliteWrites(async () => {
      await registry.restoreWorktree({ ...identity, worktreePath: fixture.worktree, snapshotRef: snapshot!.snapshotRef });
    });
    expectSqliteWriteBudget({ scenario: "checkout-hibernation-restore", note: "restore one hibernated checkout with no environment setup", writes: restoreWrites });
    expect((await git(fixture.worktree, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe("owned");
    expect(await new WorktreeArchiveService().readCheckoutTree(fixture.worktree)).toBe(before);
    expect(await readFile(path.join(fixture.worktree, "notes.txt"), "utf8")).toBe("untracked notes\n");
    expect(await snapshotOf(store)).toMatchObject({ state: "restored" });
  });

  it("makes no commits across 24 sweeps with nothing to hibernate, or when it keeps a checkout", async () => {
    const fixture = await createFixture();
    const { registry } = fixture.open();
    await sweep(registry);
    const { writes } = await measureSqliteWrites(async () => {
      for (let hour = 0; hour < 24; hour++) {
        expect(await sweep(registry)).toMatchObject({ hibernated: 0, kept: { "Already hibernated": 1 } });
      }
    });
    expectSqliteWriteBudget({ scenario: "checkout-hibernation-idle-sweeps", note: "24 hourly sweeps after the only checkout hibernated", writes });

    const kept = await createFixture();
    await writeFile(path.join(kept.worktree, ".env.local"), "SECRET=1\n");
    const second = kept.open();
    const { writes: keptWrites } = await measureSqliteWrites(async () => {
      expect(await sweep(second.registry)).toMatchObject({ hibernated: 0, kept: { "Other ignored files": 1 } });
    });
    expectSqliteWriteBudget({ scenario: "checkout-hibernation-kept", note: "one sweep that keeps the only checkout", writes: keptWrites });
    expect(await exists(kept.worktree)).toBe(true);
  });

  it("writes nothing while hibernation is off, which is the default", async () => {
    const fixture = await createFixture();
    const { registry } = fixture.open({ ...ON, enabled: false });
    expect(await sweep(registry)).toMatchObject({ skipped: "Hibernation is off" });
    expect(await exists(fixture.worktree)).toBe(true);
  });

  it("refuses a checkout with an open terminal, and never closes it", async () => {
    const fixture = await createFixture();
    const closed = vi.fn();
    releases.push(registerWorktreeTerminalOwner({
      hasOpenIn: (worktreePath) => path.resolve(worktreePath) === fixture.worktree,
      withWorktreeClosed: async (_path, work) => { closed(); return await work(); },
    }));
    const { registry, store } = fixture.open();
    expect(await sweep(registry)).toMatchObject({ hibernated: 0, kept: { "Terminal open": 1 } });
    expect(closed).not.toHaveBeenCalled();
    expect(await exists(fixture.worktree)).toBe(true);
    expect(await snapshotOf(store)).toBeUndefined();
  });

  it("keeps a pinned thread listed and pinned, and hibernates its checkout", async () => {
    const fixture = await createFixture();
    const { registry, store } = fixture.open();
    await store.setThreadPin({ ...identity, pinned: true });
    const rank = (await store.getThreadOverlayState(identity))?.pinnedRank;
    expect(rank).toBeDefined();
    expect(await sweep(registry)).toMatchObject({ hibernated: 1 });
    expect((await store.getThreadOverlayState(identity))?.pinnedRank).toBe(rank);
  });

  it("is cancelled by a send that arrives while it re-runs its checks", async () => {
    const fixture = await createFixture();
    const { registry, store } = fixture.open();
    let operator: Promise<unknown> | undefined;
    // The second probe is the re-check just before removal.
    probeHook.onInspect = (call) => {
      if (call === 2) operator = registry.withThreadLifecycleMutation(identity, async () => {});
    };
    expect(await sweep(registry)).toMatchObject({ hibernated: 0, kept: { "Hibernation cancelled": 1 } });
    await operator;
    expect(await exists(fixture.worktree)).toBe(true);
    expect(await snapshotOf(store)).toBeUndefined();
  });

  it("restores on send: the message waits for the restore, and concurrent sends share one", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.worktree, "file.txt"), "uncommitted edit\n");
    const { registry } = fixture.open();
    await sweep(registry);
    const started = stubProviderTurnStart(registry);
    const recreate = recreateSpy(registry);
    const results = await Promise.all([
      registry.startTurn({ ...identity, input: [{ type: "text", text: "one" }] }),
      registry.startTurn({ ...identity, input: [{ type: "text", text: "two" }] }),
    ]);
    expect(results).toHaveLength(2);
    expect(recreate).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("uncommitted edit\n");

    // A queued send: it is admitted as queued while the restore runs.
    const again = await createFixture();
    const second = again.open();
    await sweep(second.registry);
    const startedAgain = stubProviderTurnStart(second.registry);
    const submitted = await second.registry.submitTurn({ ...identity, input: [{ type: "text", text: "queued" }] });
    expect(submitted.status).toBe("queued");
    await vi.waitFor(() => expect(startedAgain).toHaveBeenCalledTimes(1));
    expect(await exists(again.worktree)).toBe(true);
  });

  it("restores with environment setup in two commits", async () => {
    const fixture = await createFixture({ environment: true });
    const runner = vi.fn<CodexEnvironmentCommandRunner>(async () => ({ exitCode: 0, output: "installed", durationMs: 1 }));
    const { registry, store } = fixture.open(ON, { commandRunner: runner });
    await store.setThreadCodexEnvironmentRuntime({ ...identity, codexEnvironmentRuntime: {
      environmentId: "env", environmentName: "Env", executionTarget: "local", setupStatus: "succeeded",
    } as never });
    await sweep(registry);
    const snapshot = await snapshotOf(store);
    expect(snapshot?.state).toBe("hibernated");
    const { writes } = await measureSqliteWrites(async () => {
      await registry.restoreWorktree({ ...identity, worktreePath: fixture.worktree, snapshotRef: snapshot!.snapshotRef });
    });
    expectSqliteWriteBudget({ scenario: "checkout-hibernation-restore-with-setup", note: "restore one hibernated checkout and re-run its environment setup", writes });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![0].cwd).toBe(fixture.worktree);
  });

  it.each([
    ["the branch is checked out elsewhere", async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      await git(fixture.repo, ["worktree", "add", path.join(fixture.root, "elsewhere"), "owned"]);
    }],
    ["the path is occupied", async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      await mkdir(fixture.worktree, { recursive: true });
      await writeFile(path.join(fixture.worktree, "someone-else.txt"), "not ours\n");
    }],
    ["the branch moved", async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      // A commit the saved changes do not conflict with: only the check refuses it.
      await writeFile(path.join(fixture.repo, "other.txt"), "moved on\n");
      await git(fixture.repo, ["add", "other.txt"]);
      await git(fixture.repo, ["commit", "-m", "move"]);
      await git(fixture.repo, ["branch", "-f", "owned", "main"]);
    }],
  ])("keeps the snapshot and holds the message when %s", async (_name, breakRestore) => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.worktree, "file.txt"), "uncommitted edit\n");
    const { registry, store } = fixture.open();
    await sweep(registry);
    const snapshot = await snapshotOf(store);
    await breakRestore(fixture);

    const { writes } = await measureSqliteWrites(async () => {
      await expect(registry.restoreWorktree({ ...identity, worktreePath: fixture.worktree, snapshotRef: snapshot!.snapshotRef }))
        .rejects.toThrow();
    });
    expectSqliteWriteBudget({ scenario: "checkout-hibernation-restore-failed", note: "a refused restore of a hibernated checkout", writes });
    expect(await snapshotOf(store)).toMatchObject({ state: "hibernated", snapshotCommit: snapshot!.snapshotCommit });

    const started = stubProviderTurnStart(registry);
    const submitted = await registry.submitTurn({ ...identity, input: [{ type: "text", text: "after hibernation" }] });
    expect(submitted.status).toBe("queued");
    await vi.waitFor(() => expect(registry.getQueuedTurnsForThread(identity)).toEqual([
      expect.objectContaining({ manualReleaseRequired: true, holdReason: expect.any(String) }),
    ]));
    expect(started).not.toHaveBeenCalled();
    expect(registry.readCheckoutHibernation(identity).restoreFailure?.message).toBe(registry.getQueuedTurnsForThread(identity)[0]!.holdReason);
    expect(await snapshotOf(store)).toMatchObject({ state: "hibernated" });
  });
});

describe("Restore now and Keep it awake", () => {
  type HibernationEvent = { workspace?: { restoring?: boolean; restorePhase?: string; runsSetup?: boolean } | null; keepAwake?: boolean };
  const hibernationEvents = (registry: DesktopBackendRegistry) => {
    const events: HibernationEvent[] = [];
    registry.onEvent((event) => {
      if (event.notification.method === "thread/checkoutHibernation/updated") events.push(event.notification.params as HibernationEvent);
    });
    return events;
  };

  it("keeps a thread awake in one commit, restores its checkout, and the sweep then keeps it", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.worktree, "file.txt"), "uncommitted edit\n");
    const { registry, store } = fixture.open();
    await sweep(registry);
    expect(await exists(fixture.worktree)).toBe(false);
    const events = hibernationEvents(registry);
    const recreate = recreateSpy(registry);
    const result = await registry.setThreadCheckoutHibernation({ ...identity, keepAwake: true });
    expect(result).toEqual({ ...identity, keepAwake: true, hibernated: false });
    expect(recreate).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("uncommitted edit\n");
    expect((await store.getThreadOverlayState(identity))?.keepCheckoutAwake).toBe(true);
    // The exemption, then the restore's start and end.
    expect(events).toEqual([
      { threadId: THREAD_ID, keepAwake: true },
      { threadId: THREAD_ID, workspace: expect.objectContaining({ restoring: true, restorePhase: "checkout" }) },
      { threadId: THREAD_ID, workspace: null },
    ]);

    // Idle again, the sweep keeps it until the operator turns this off.
    expect(await sweep(registry)).toMatchObject({ hibernated: 0, kept: { "Kept awake": 1 } });
    expect(await exists(fixture.worktree)).toBe(true);
    const { writes } = await measureSqliteWrites(async () => {
      expect(await registry.setThreadCheckoutHibernation({ ...identity, keepAwake: false }))
        .toEqual({ ...identity, keepAwake: false, hibernated: false });
    });
    expectSqliteWriteBudget({ scenario: "checkout-hibernation-keep-awake-toggle", note: "turn Keep it awake off on an awake thread", writes });
    expect((await store.getThreadOverlayState(identity))?.keepCheckoutAwake).toBeUndefined();
    // Setting what is already set writes nothing.
    const { writes: unchanged } = await measureSqliteWrites(async () => {
      await registry.setThreadCheckoutHibernation({ ...identity, keepAwake: false });
    });
    expect(unchanged.commits).toBe(0);
    // With the exemption off, the restore it made still counts as activity.
    expect(await sweep(registry)).toMatchObject({ hibernated: 0, kept: { "Recently active": 1 } });
  });

  it("restores now without a send, and reports the snapshot it saved", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.worktree, "file.txt"), "uncommitted edit\n");
    await writeFile(path.join(fixture.worktree, "notes.txt"), "untracked\n");
    await mkdir(path.join(fixture.worktree, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(fixture.worktree, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    const { registry, store } = fixture.open();
    await sweep(registry);
    expect(await snapshotOf(store)).toMatchObject({ state: "hibernated", changedFileCount: 2, removedOutput: ["node_modules"] });
    expect((await snapshotOf(store))?.changedBytes).toBeGreaterThan(0);
    expect(registry.readCheckoutHibernation(identity)).toEqual({ restoring: false });

    const result = await registry.setThreadCheckoutHibernation({ ...identity, restore: true });
    expect(result).toEqual({ ...identity, keepAwake: false, hibernated: false });
    expect(await readFile(path.join(fixture.worktree, "notes.txt"), "utf8")).toBe("untracked\n");
    expect((await store.getThreadOverlayState(identity))?.keepCheckoutAwake).toBeUndefined();
  });

  it("answers a refused restore with its reason and keeps the snapshot", async () => {
    const fixture = await createFixture();
    const { registry, store } = fixture.open();
    await sweep(registry);
    await git(fixture.repo, ["worktree", "add", path.join(fixture.root, "elsewhere"), "owned"]);
    const events = hibernationEvents(registry);
    const result = await registry.setThreadCheckoutHibernation({ ...identity, restore: true });
    expect(result).toMatchObject({ keepAwake: false, hibernated: true, restoreError: expect.stringContaining("owned") });
    expect(await snapshotOf(store)).toMatchObject({ state: "hibernated" });
    expect(registry.readCheckoutHibernation(identity).restoreFailure?.message).toBe(result.restoreError);
    // The card goes back to the hibernated checkout; it never reads awake.
    expect(events.at(-1)?.workspace).toMatchObject({ worktreePath: fixture.worktree, branch: "owned" });
    expect(events.at(-1)?.workspace).not.toHaveProperty("restoring");
  });

  it("ends a restore that throws, so no surface keeps showing it", async () => {
    const fixture = await createFixture();
    const { registry, store } = fixture.open();
    await sweep(registry);
    recreateSpy(registry).mockRejectedValueOnce(new Error("git exploded"));
    const events = hibernationEvents(registry);
    const result = await registry.setThreadCheckoutHibernation({ ...identity, restore: true });
    expect(result).toMatchObject({ hibernated: true, restoreError: "git exploded" });
    expect(events.map((event) => event.workspace?.restoring ?? false)).toEqual([true, false]);
    expect(events.at(-1)?.workspace).toMatchObject({ worktreePath: fixture.worktree });
    expect(registry.readCheckoutHibernation(identity)).toEqual({ restoring: false });
    expect(await snapshotOf(store)).toMatchObject({ state: "hibernated" });
  });

  it("says the restore runs project setup before any restore starts", async () => {
    const fixture = await createFixture({ environment: true });
    const { registry, store } = fixture.open();
    await store.setThreadCodexEnvironmentRuntime({ ...identity, codexEnvironmentRuntime: {
      environmentId: "env", environmentName: "Env", executionTarget: "local", setupStatus: "succeeded",
    } as never });
    const events = hibernationEvents(registry);
    await sweep(registry);
    expect(events).toEqual([{ threadId: THREAD_ID, workspace: expect.objectContaining({ runsSetup: true }) }]);
  });

  it("keeps the restoring card through project setup, then clears it", async () => {
    const fixture = await createFixture({ environment: true });
    let releaseSetup!: () => void;
    const setupStarted = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let setupRunning!: () => void;
    const running = new Promise<void>((resolve) => { setupRunning = resolve; });
    const runner = vi.fn<CodexEnvironmentCommandRunner>(async () => {
      setupRunning();
      await setupStarted;
      return { exitCode: 0, output: "installed", durationMs: 1 };
    });
    const { registry, store } = fixture.open(ON, { commandRunner: runner });
    await store.setThreadCodexEnvironmentRuntime({ ...identity, codexEnvironmentRuntime: {
      environmentId: "env", environmentName: "Env", executionTarget: "local", setupStatus: "succeeded",
    } as never });
    await sweep(registry);
    const restore = registry.setThreadCheckoutHibernation({ ...identity, restore: true });
    await running;
    // The snapshot already reads restored; the card still shows the restore.
    expect(await snapshotOf(store)).toMatchObject({ state: "restored" });
    expect(registry.readCheckoutHibernation(identity)).toMatchObject({
      restoring: true,
      progress: { restoring: true, restorePhase: "setup", runsSetup: true, branch: "owned", worktreePath: fixture.worktree },
    });
    releaseSetup();
    await restore;
    expect(registry.readCheckoutHibernation(identity)).toEqual({ restoring: false });
  });
});
