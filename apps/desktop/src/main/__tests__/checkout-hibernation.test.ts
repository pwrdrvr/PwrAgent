import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DesktopCheckoutHibernationPolicy, PrSummary, PwrAgentThreadOrchestrationRequest, PwrAgentThreadOrchestrationResponse,
  ThreadPullRequestWatchSummary, WorktreeSnapshotSummary } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { checkoutHibernationReviewDeps, ThreadMaintenanceService } from "../app-server/thread-maintenance-service";
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

async function createFixture(options: { environment?: boolean; worktreeRoot?: ".pwragent" | ".codex" } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-hibernate-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  const worktree = path.join(root, options.worktreeRoot ?? ".pwragent", "worktrees", "id", "repo");
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

function registrationTool(registry: DesktopBackendRegistry) {
  const internal = registry as unknown as {
    isLiveDynamicToolCall: () => boolean;
    requestThreadMaintenanceConfirmation: (params: { question: string }) => Promise<boolean>;
    handleThreadOrchestrationRequest: (request: PwrAgentThreadOrchestrationRequest) => Promise<PwrAgentThreadOrchestrationResponse>;
  };
  const live = vi.spyOn(internal, "isLiveDynamicToolCall").mockReturnValue(true);
  const call = (worktreePath: string, action?: "register" | "unregister" | "inspect", threadId = THREAD_ID) =>
    internal.handleThreadOrchestrationRequest({ operation: "register_thread_worktree",
      context: { backend: "codex", threadId: "registration-agent", turnId: "registration-turn" },
      args: { backend: "codex", threadId, worktreePath, ...(action ? { action } : {}) },
    });
  return { internal, live, call };
}

async function outsideRegistrationFixture() {
  const fixture = await createFixture({ worktreeRoot: ".codex" });
  const runtime = fixture.open({ ...ON, enabled: false });
  await runtime.store.replaceWorkspaceLinkedDirectory({ ...identity,
    directory: { ...fixture.directory, worktreeOwnership: "external" } });
  return { ...fixture, ...runtime, ...registrationTool(runtime.registry) };
}

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

  it.each([true, false])("ignored files do not keep a checkout with legacy output policy %s", async (legacyPolicy) => {
    const { worktree } = await createFixture();
    await writeFile(path.join(worktree, ".env.local"), "SECRET=1\n");
    await mkdir(path.join(worktree, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(worktree, "node_modules", "dep", "output.bin"), Buffer.alloc(1024));
    expect(await probe(worktree, { removeRebuildableOutput: legacyPolicy, limitBytes: 1 }))
      .toEqual({ files: 0, bytes: 0, removedOutput: ["node_modules"] });
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

  // Codex never removes its own ~/.codex/worktrees checkouts, so they
  // hibernate like PwrAgent's and come back on the same path.
  it("hibernates and restores a checkout under Codex's worktree root", async () => {
    const fixture = await createFixture({ worktreeRoot: ".codex" });
    await writeFile(path.join(fixture.worktree, "file.txt"), "uncommitted edit\n");
    const before = await new WorktreeArchiveService().readCheckoutTree(fixture.worktree);
    const { registry, store } = fixture.open();
    expect(await sweep(registry)).toMatchObject({ checked: 1, hibernated: 1 });
    expect(await exists(fixture.worktree)).toBe(false);
    const snapshot = await snapshotOf(store);
    expect(snapshot).toMatchObject({ state: "hibernated", worktreePath: fixture.worktree });
    await registry.restoreWorktree({ ...identity, worktreePath: fixture.worktree, snapshotRef: snapshot!.snapshotRef });
    expect((await git(fixture.worktree, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe("owned");
    expect(await new WorktreeArchiveService().readCheckoutTree(fixture.worktree)).toBe(before);
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
    await writeFile(path.join(kept.worktree, "file.txt"), "stashed work\n");
    await git(kept.worktree, ["stash", "push", "-m", "keep checkout"]);
    const second = kept.open();
    const { writes: keptWrites } = await measureSqliteWrites(async () => {
      expect(await sweep(second.registry)).toMatchObject({ hibernated: 0, kept: { "Stashed changes": 1 } });
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

describe("Thread maintenance's hibernate step", () => {
  it.each(["merged", "closed"] as const)("uses the latest saved PR lifecycle for a locked thread's stale %s watch", async (lifecycleState) => {
    const fixture = await createFixture();
    const { registry, store } = fixture.open({ ...ON, enabled: false });
    const watch: ThreadPullRequestWatchSummary = { ...identity, watchId: "terminal-watch", prKey: "github.com/example/project#12",
      prUrl: "https://github.com/example/project/pull/12", prNumber: 12, headSha: "head", kind: "terminal",
      createdAt: 1, notifyOn: ["merged", "closed"], failureHandledByAutoFix: false };
    const pr: PrSummary = { provider: "github.com", org: "example", repo: "project", number: 12,
      state: "passing", lifecycleState, headSha: "head", url: watch.prUrl };
    await store.registerThreadPrStatusWatch({ watch, now: 1 });
    await store.setThreadLock({ ...identity, lock: { source: "operator", lockedAt: 1, note: "Handed off" } });
    await store.setThreadPullRequests({ ...identity, prs: [pr], fetchedAt: 2 });
    const remember = async (value: PrSummary, fetchedAt: number) => await store.writePrStatusCacheEntries([
      { prKey: watch.prKey, provider: value.provider, pr: value, fetchedAt },
    ]);
    await remember(pr, 2);
    const service = maintenance(registry);
    const measured = await measureSqliteWrites(async () => await service.scan({ steps: ["hibernate"], hibernateIdleDays: 2 }));
    expect(measured.writes.commits).toBe(0);
    let scan = measured.result;
    expect(scan.hibernate?.items.map((item) => item.threadId)).toEqual([THREAD_ID]);
    const apply = async () => await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
      removeEmptyFolders: false, hibernate: [identity] });
    if (lifecycleState === "closed") {
      // A later cached reopening wins over the older attached terminal row.
      await remember({ ...pr, lifecycleState: "open" }, 3);
      const kept = await apply();
      expect(kept.problems).toContainEqual(expect.objectContaining({ kind: "kept", reason: "Watching a PR" }));
      expect(await exists(fixture.worktree)).toBe(true);
      await remember(pr, 4);
      scan = await service.scan({ steps: ["hibernate"], hibernateIdleDays: 2 });
    }
    const run = await apply();
    expect(run.steps.find((step) => step.step === "hibernate")).toMatchObject({ done: 1, kept: 0, failed: 0 });
    expect(await exists(fixture.worktree)).toBe(false);
    // Eligibility neither dispatches nor retires the watch, and does not unlock.
    expect(await store.listActiveThreadPrStatusWatches(identity)).toHaveLength(1);
    expect((await store.getThreadOverlayState(identity))?.lock?.lockedAt).toBe(1);
  });

  it("rechecks managed-root ownership when a reviewed external checkout moves outside through a symlink", async () => {
    const fixture = await createFixture();
    const { registry, store } = fixture.open({ ...ON, enabled: false });
    await store.replaceWorkspaceLinkedDirectory({ ...identity, directory: { ...fixture.directory, worktreeOwnership: "external" } });
    const service = maintenance(registry);
    const scan = await service.scan({ steps: ["hibernate"], hibernateIdleDays: 2 });
    expect(scan.hibernate?.items.map((item) => item.threadId)).toEqual([THREAD_ID]);
    const outside = path.join(fixture.root, "outside-checkout");
    await git(fixture.repo, ["worktree", "move", fixture.worktree, outside]);
    await symlink(outside, fixture.worktree, process.platform === "win32" ? "junction" : "dir");
    const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
      removeEmptyFolders: false, hibernate: [identity] });
    expect(run.steps.find((step) => step.step === "hibernate")).toMatchObject({ done: 0, kept: 1, failed: 0 });
    expect(await readFile(path.join(outside, "file.txt"), "utf8")).toBe("original\n");
    expect(await snapshotOf(store)).toBeUndefined();
  });

  it("registers an explicitly approved outside linked checkout without weakening snapshot or ownership checks (Git oracle)", async () => {
    const fixture = await outsideRegistrationFixture();
    const { registry, store, internal, call } = fixture;
    await writeFile(path.join(fixture.worktree, "file.txt"), "registered edit\n");
    await writeFile(path.join(fixture.worktree, "notes.txt"), "registered notes\n");
    await writeFile(path.join(fixture.worktree, ".env.local"), "invented ignored fixture\n");
    const service = maintenance(registry);
    expect((await service.scan({ steps: ["hibernate"], hibernateIdleDays: 2 })).hibernate?.items).toEqual([]);
    const approval = vi.spyOn(internal, "requestThreadMaintenanceConfirmation").mockResolvedValue(true);
    const registered = await measureSqliteWrites(() => call(fixture.worktree));
    expect(registered.result).toMatchObject({ ok: true });
    expectSqliteWriteBudget({ scenario: "worktree-registration-one", writes: registered.writes,
      note: "One explicitly approved linked-checkout registration; provider inventory and Git validation are read-only" });
    expect(approval).toHaveBeenCalledOnce();
    const scan = await service.scan({ steps: ["hibernate"], hibernateIdleDays: 2 });
    expect(scan.hibernate?.items.map((item) => item.threadId)).toEqual([THREAD_ID]);
    const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
      removeEmptyFolders: false, hibernate: [identity] });
    expect(run.steps.find((step) => step.step === "hibernate")).toMatchObject({ done: 1, kept: 0, failed: 0 });
    expect(await exists(fixture.worktree)).toBe(false);
    expect((await store.getThreadOverlayState(identity))?.extraLinkedDirectories[0]?.worktreeOwnership).toBe("external");
    const snapshot = await snapshotOf(store);
    expect(snapshot).toMatchObject({ state: "hibernated", worktreePath: fixture.worktree });
    const recovery = new WorktreeArchiveService();
    await recovery.restore({ ...identity, worktreePath: fixture.worktree, repositoryPath: fixture.repo,
      snapshotRef: snapshot!.snapshotRef, snapshotCommit: snapshot!.snapshotCommit, snapshot: snapshot!, restoreSourceCheckout: true });
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("registered edit\n");
    expect(await readFile(path.join(fixture.worktree, "notes.txt"), "utf8")).toBe("registered notes\n");
    expect(await exists(path.join(fixture.worktree, ".env.local"))).toBe(false);
  });

  it.each(["Cancel", "Register worktree"])("requires the exact operator answer in Full Access: %s", async (answer) => {
    const { registry, store, worktree, call } = await outsideRegistrationFixture();
    await store.setThreadExecutionMode({ backend: "codex", threadId: "registration-agent", executionMode: "full-access" });
    const measured = await measureSqliteWrites(async () => {
      const card = new Promise<import("@pwragent/shared").AppServerToolRequestUserInputNotification>((resolve) => {
        releases.push(registry.onEvent((event) => {
          if (event.notification.method === "item/tool/requestUserInput") {
            resolve(event.notification as import("@pwragent/shared").AppServerToolRequestUserInputNotification);
          }
        }));
      });
      const pending = call(worktree);
      const notification = await card;
      expect(notification.params.questions[0]?.question).toContain(worktree);
      expect(notification.params.questions[0]?.question).toContain(THREAD_ID);
      expect(notification.params.questions[0]?.question).toContain("ignored files are deleted without recovery");
      expect((await store.getThreadOverlayState(identity))?.worktreeRegistrations).toBeUndefined();
      await registry.submitServerRequest({ backend: "codex", threadId: "registration-agent", turnId: "registration-turn",
        requestId: notification.params.requestId,
        response: { answers: { thread_maintenance: { answers: [answer] } } },
      });
      return await pending;
    });
    expect(measured.result.ok).toBe(answer === "Register worktree");
    expectSqliteWriteBudget({ scenario: answer === "Cancel" ? "worktree-registration-card-cancel" : "worktree-registration-card-approve",
      writes: measured.writes, note: "One native operator registration card, its questionnaire receipt, and the resulting authorization if approved" });
    expect(await exists(worktree)).toBe(true);
  });

  it.each(["main", "unattached", "unknown", "alias", "ended", "moved-during-review"])("refuses registration for %s", async (scenario) => {
    const { registry, store, root, repo, worktree, call, internal, live } = await outsideRegistrationFixture();
    const approval = vi.spyOn(internal, "requestThreadMaintenanceConfirmation").mockImplementation(async () => {
      if (scenario === "moved-during-review") {
        await git(repo, ["worktree", "move", worktree, path.join(root, "moved")]);
        await symlink(path.join(root, "moved"), worktree, process.platform === "win32" ? "junction" : "dir");
      }
      return true;
    });
    let target = worktree;
    if (scenario === "main") target = repo;
    if (scenario === "unattached") {
      target = path.join(root, "spare");
      await git(repo, ["worktree", "add", "--detach", target]);
    }
    if (scenario === "alias") {
      target = path.join(root, "alias");
      await symlink(worktree, target, process.platform === "win32" ? "junction" : "dir");
    }
    if (scenario === "ended") live.mockReturnValue(false);
    const measured = await measureSqliteWrites(() => call(target, undefined, scenario === "unknown" ? "unknown-thread" : THREAD_ID));
    expect(measured.result.ok).toBe(false);
    expect(measured.writes.commits).toBe(0);
    expect((await store.getThreadOverlayState(identity))?.worktreeRegistrations).toBeUndefined();
    if (scenario !== "moved-during-review") expect(approval).not.toHaveBeenCalled();
    expect(await exists(repo)).toBe(true);
    expect(await exists(worktree)).toBe(true);
    await registry.close();
  });

  it("revokes a reviewed registration and keeps outside external owners protected", async () => {
    const { registry, store, worktree, call, internal } = await outsideRegistrationFixture();
    vi.spyOn(internal, "requestThreadMaintenanceConfirmation").mockResolvedValue(true);
    expect((await call(worktree)).ok).toBe(true);
    const service = maintenance(registry);
    const scan = await service.scan({ steps: ["hibernate"], hibernateIdleDays: 2 });
    expect(scan.hibernate?.items).toHaveLength(1);
    const revoke = await measureSqliteWrites(() => call(worktree, "unregister"));
    expect(revoke.result.ok).toBe(true);
    expectSqliteWriteBudget({ scenario: "worktree-registration-revoke", writes: revoke.writes, note: "Revoke one existing checkout authorization" });
    const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false, hibernate: [identity] });
    expect(run.steps.find((step) => step.step === "hibernate")).toMatchObject({ done: 0, kept: 1 });
    expect(await exists(worktree)).toBe(true);
    expect(await snapshotOf(store)).toBeUndefined();
  });

  // Each case owns its native fixture through afterEach; no generated case
  // leaves a registry, SQLite connection or Git tree alive for the next one.
  const archivedOwnerReceiptCases = [1, 2, 3].flatMap((ownerCount) =>
    Array.from({ length: 2 ** ownerCount }, (_, mask) => ({
      authorizations: Array.from({ length: ownerCount }, (_, index) => Boolean(mask & (1 << index))),
    })));
  it.each(archivedOwnerReceiptCases)("requires every archived external owner's receipt at hibernation admission: $authorizations (Git oracle)", async ({ authorizations }) => {
    expect({ registries: registries.length, databases: databases.length, roots: roots.length })
      .toEqual({ registries: 0, databases: 0, roots: 0 });
    const { registry, store, directory, worktree, call, internal } = await outsideRegistrationFixture();
    vi.spyOn(internal, "requestThreadMaintenanceConfirmation").mockResolvedValue(true);
    expect((await call(worktree)).ok).toBe(true);
    const service = maintenance(registry);
    const scan = await service.scan({ steps: ["hibernate"], hibernateIdleDays: 2 });
    expect(scan.hibernate?.items).toHaveLength(1);
    // Each owner joins after review. Archived conversations do not count as
    // active users, but their external marker still requires authorization.
    for (const [index, authorized] of authorizations.entries()) {
      const other = { backend: "codex" as const, threadId: `archived-external-${index}` };
      ArchiveWorktreeTransport.threads.push({ ...ArchiveWorktreeTransport.threads[0]!, id: other.threadId, archived: true });
      await store.replaceWorkspaceLinkedDirectory({ ...other, directory: { ...directory, worktreeOwnership: "external" } });
      await store.setThreadArchiveTombstone({ ...other, archivedAt: 1 });
      if (authorized) expect((await call(worktree, "register", other.threadId)).ok).toBe(true);
    }
    const allowed = authorizations.every(Boolean);
    const inspected = await measureSqliteWrites(() => service.scan({ steps: ["hibernate"], hibernateIdleDays: 2 }));
    expect(inspected.writes.commits).toBe(0);
    const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
      removeEmptyFolders: false, hibernate: [identity] });
    expect(run.steps.find((step) => step.step === "hibernate")).toMatchObject({ done: allowed ? 1 : 0, kept: allowed ? 0 : 1 });
    expect(await exists(worktree)).toBe(!allowed);
    expect(Boolean(await snapshotOf(store))).toBe(allowed);
    expect(inspected.result.hibernate?.items.some((item) => item.threadId === THREAD_ID)).toBe(allowed);
  });

  it.each(["hibernating-owner", "archived-owner"])("revoking the %s receipt cancels an in-flight hibernation before removal", async (ownerKind) => {
    const { registry, store, directory, worktree, call, internal } = await outsideRegistrationFixture();
    vi.spyOn(internal, "requestThreadMaintenanceConfirmation").mockResolvedValue(true);
    expect((await call(worktree)).ok).toBe(true);
    const revokedThreadId = ownerKind === "hibernating-owner" ? THREAD_ID : "archived-owner";
    if (ownerKind === "archived-owner") {
      ArchiveWorktreeTransport.threads.push({ ...ArchiveWorktreeTransport.threads[0]!, id: revokedThreadId, archived: true });
      await store.replaceWorkspaceLinkedDirectory({ backend: "codex", threadId: revokedThreadId,
        directory: { ...directory, worktreeOwnership: "external" } });
      await store.setThreadArchiveTombstone({ backend: "codex", threadId: revokedThreadId, archivedAt: 1 });
      expect((await call(worktree, "register", revokedThreadId)).ok).toBe(true);
    }
    await writeFile(path.join(worktree, "file.txt"), "kept after revocation\n");
    const service = maintenance(registry);
    const scan = await service.scan({ steps: ["hibernate"], hibernateIdleDays: 2 });
    expect(scan.hibernate?.items.some((item) => item.threadId === THREAD_ID)).toBe(true);
    let reachedRemoval!: () => void;
    const paused = new Promise<void>((resolve) => { reachedRemoval = resolve; });
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => { resume = resolve; });
    const archive = (registry as unknown as { worktreeArchiveService: WorktreeArchiveService }).worktreeArchiveService;
    const hibernate = archive.hibernate.bind(archive);
    vi.spyOn(archive, "hibernate").mockImplementation(async (params) => await hibernate({ ...params,
      beforeRemove: async () => {
        const assertCurrent = await params.beforeRemove();
        reachedRemoval();
        await barrier;
        return assertCurrent;
      },
    }));
    const run = service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
      removeEmptyFolders: false, hibernate: [identity] });
    await paused;
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
    const lifecycle = registry as unknown as { cancelAutomaticArchive: (backend: "codex", threadId: string) => void };
    const cancel = lifecycle.cancelAutomaticArchive.bind(lifecycle);
    vi.spyOn(lifecycle, "cancelAutomaticArchive").mockImplementation((backend, threadId) => {
      cancel(backend, threadId);
      cancelled();
    });
    const revocation = call(worktree, "unregister", revokedThreadId);
    try {
      // Before the fix, revocation completes while removal is paused. The
      // corrected lifecycle path cancels first and waits for housekeeping.
      await Promise.race([revocation, cancellation]);
    } finally { resume(); }
    expect(await revocation).toMatchObject({ ok: true, data: { registered: false } });
    expect((await run).steps.find((step) => step.step === "hibernate")).toMatchObject({ done: 0, kept: 1 });
    expect(await readFile(path.join(worktree, "file.txt"), "utf8")).toBe("kept after revocation\n");
    expect(await snapshotOf(store)).toBeUndefined();
  });

  it("reads a durable receipt after restart but requires current-profile membership", async () => {
    const fixture = await outsideRegistrationFixture();
    vi.spyOn(fixture.internal, "requestThreadMaintenanceConfirmation").mockResolvedValue(true);
    expect((await fixture.call(fixture.worktree)).ok).toBe(true);
    const receipt = (await fixture.store.getThreadOverlayState(identity))?.worktreeRegistrations?.[0];
    expect(receipt).toMatchObject({ worktreePath: fixture.worktree,
      requestedBy: { backend: "codex", threadId: "registration-agent" }, authorizedAt: expect.any(Number) });
    await fixture.registry.close();
    const restarted = fixture.open({ ...ON, enabled: false });
    const tool = registrationTool(restarted.registry);
    const observed = await measureSqliteWrites(() => tool.call(fixture.worktree, "inspect"));
    expect(observed.result).toMatchObject({ ok: true, data: { registered: true, valid: true, registration: receipt } });
    expectSqliteWriteBudget({ scenario: "worktree-registration-inspect", writes: observed.writes,
      note: "Read and revalidate one persisted registration receipt after reopening SQLite" });
    ArchiveWorktreeTransport.threads = [];
    expect((await tool.call(fixture.worktree, "inspect")).ok).toBe(false);
    expect(await exists(fixture.worktree)).toBe(true);
  });

  it("models approval, rejection, observation and revocation without inferring ownership", async () => {
    const fixture = await outsideRegistrationFixture();
    const { registry, store, worktree, call, internal } = fixture;
    const approval = vi.spyOn(internal, "requestThreadMaintenanceConfirmation");
    type Model = { authorized: boolean };
    type Real = typeof fixture;
    class RegistrationCommand implements fc.AsyncCommand<Model, Real> {
      constructor(readonly operation: "approve" | "cancel" | "revoke" | "observe") {}
      check = () => true;
      async run(model: Model, real: Real) {
        if (this.operation !== "observe") {
          approval.mockResolvedValue(this.operation !== "cancel");
          const result = await real.call(real.worktree, this.operation === "revoke" ? "unregister" : "register");
          expect(result.ok).toBe(this.operation !== "cancel");
          if (this.operation === "approve") model.authorized = true;
          if (this.operation === "revoke") model.authorized = false;
        }
        const observed = await measureSqliteWrites(() => real.call(real.worktree, "inspect"));
        expect(observed.result).toMatchObject({ ok: true, data: { registered: model.authorized, valid: model.authorized } });
        expect(observed.writes.commits).toBe(0);
        const candidates = await registry.listAutoArchiveCandidates();
        const owner = candidates.find((item) => item.thread.id === THREAD_ID)!;
        expect(Boolean(owner.managedWorktreePath)).toBe(model.authorized);
        expect(await exists(worktree)).toBe(true);
      }
      toString() { return this.operation; }
    }
    await fc.assert(fc.asyncProperty(fc.commands([
      fc.constant(new RegistrationCommand("approve")), fc.constant(new RegistrationCommand("cancel")),
      fc.constant(new RegistrationCommand("revoke")), fc.constant(new RegistrationCommand("observe")),
    ], { maxCommands: 6 }), async (commands) => {
      await store.setThreadWorktreeRegistration({ ...identity, worktreePath: worktree });
      await fc.asyncModelRun(() => ({ model: { authorized: false }, real: fixture }), commands);
    }), { numRuns: 10 });
    expect((await call(worktree, "inspect")).ok).toBe(true);
  });

  it.each(["recent", "active", "shared", "snapshot-limit", "replaced"])("retains %s protection after outside registration and review", async (protection) => {
    const { registry, store, root, repo, worktree, call, internal } = await outsideRegistrationFixture();
    vi.spyOn(internal, "requestThreadMaintenanceConfirmation").mockResolvedValue(true);
    expect((await call(worktree)).ok).toBe(true);
    const service = maintenance(registry);
    const scan = await service.scan({ steps: ["hibernate"], hibernateIdleDays: 2 });
    expect(scan.hibernate?.items).toHaveLength(1);
    if (protection === "recent") ArchiveWorktreeTransport.threads[0]!.updatedAt = Math.floor(Date.now() / 1000);
    if (protection === "active") await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: THREAD_ID, turnId: "active", turn: { id: "active" } },
    } });
    if (protection === "shared") ArchiveWorktreeTransport.threads.push({ ...ArchiveWorktreeTransport.threads[0]!, id: "shared-owner" });
    if (protection === "snapshot-limit") await writeFile(path.join(worktree, "file.txt"), Buffer.alloc(6 * MB));
    if (protection === "replaced") {
      await git(repo, ["worktree", "move", worktree, path.join(root, "original")]);
      await git(repo, ["worktree", "add", "--detach", worktree]);
    }
    const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false, hibernate: [identity] });
    expect(run.steps.find((step) => step.step === "hibernate")).toMatchObject({ done: 0, kept: 1 });
    expect(await exists(worktree)).toBe(true);
    expect(await snapshotOf(store)).toBeUndefined();
  });

  it.each(["sole", "active", "external-archived"])("archives a registered outside checkout subject to %s ownership (Git oracle)", async (ownership) => {
    const { registry, store, repo, worktree, directory, call, internal } = await outsideRegistrationFixture();
    vi.spyOn(internal, "requestThreadMaintenanceConfirmation").mockResolvedValue(true);
    expect((await call(worktree)).ok).toBe(true);
    await writeFile(path.join(worktree, "file.txt"), "saved archive edit\n");
    if (ownership !== "sole") {
      const other = { backend: "codex" as const, threadId: "another-owner" };
      ArchiveWorktreeTransport.threads.push({ ...ArchiveWorktreeTransport.threads[0]!, id: other.threadId,
        archived: ownership === "external-archived" });
      await store.replaceWorkspaceLinkedDirectory({ ...other, directory: { ...directory, worktreeOwnership: "external" } });
    }
    const result = await registry.archiveThread(identity);
    expect(result.cleanup).toContainEqual(expect.objectContaining({ worktreePath: worktree, removedWorktree: ownership === "sole" }));
    expect(await exists(worktree)).toBe(ownership !== "sole");
    expect(await exists(repo)).toBe(true);
    if (ownership === "sole") expect(await snapshotOf(store)).toMatchObject({ worktreePath: worktree });
    else expect(await readFile(path.join(worktree, "file.txt"), "utf8")).toBe("saved archive edit\n");
  });

  it.each([".pwragent", ".codex"] as const)("uses canonical PwrAgent root ownership for an attached external checkout: %s", async (worktreeRoot) => {
    const fixture = await createFixture({ worktreeRoot });
    const { registry, store } = fixture.open({ ...ON, enabled: false });
    await store.replaceWorkspaceLinkedDirectory({ ...identity, directory: { ...fixture.directory, worktreeOwnership: "external" } });
    const service = maintenance(registry);
    const scan = await service.scan({ steps: ["hibernate"], hibernateIdleDays: 2 });
    if (worktreeRoot === ".codex") {
      expect(scan.hibernate?.items).toEqual([]);
      expect(await exists(fixture.worktree)).toBe(true);
      return;
    }
    expect(scan.hibernate?.items.map((item) => item.threadId)).toEqual([THREAD_ID]);
    const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
      removeEmptyFolders: false, hibernate: [identity] });
    expect(run.steps.find((step) => step.step === "hibernate")).toMatchObject({ done: 1, kept: 0, failed: 0 });
    expect(await exists(fixture.worktree)).toBe(false);
    expect(await snapshotOf(store)).toMatchObject({ state: "hibernated", worktreePath: fixture.worktree });
    expect((await store.getThreadOverlayState(identity))?.extraLinkedDirectories[0]?.worktreeOwnership).toBe("external");
  });

  it("does not confuse a persisted archive with an archive operation still in flight", async () => {
    const fixture = await createFixture();
    const { registry } = fixture.open({ ...ON, enabled: false });
    const candidate = (await registry.listAutoArchiveCandidates())[0]!;
    const cache = (registry as unknown as { threadInfoStore: { get: () => { archived: boolean } | undefined } }).threadInfoStore;
    vi.spyOn(cache, "get").mockReturnValue({ archived: true });
    expect(registry.isArchiveCandidateBusy(candidate)).toBe(true);
    for (const archiveState of [{ archiveTombstonedAt: 1 }, { archiveRetentionStartedAt: 1 }]) {
      expect(registry.isArchiveCandidateBusy({ ...candidate, overlay: { ...candidate.overlay!, ...archiveState } })).toBe(false);
    }
    expect(registry.isArchiveCandidateBusy({ ...candidate, thread: { ...candidate.thread, archivedAt: 1 } })).toBe(false);
  });

  it("discovers a provider-archived checkout, saves its work and leaves its conversation archived", async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads[0]!.archived = true;
    ArchiveWorktreeTransport.threads[0]!.updatedAt = Math.floor(Date.now() / 1000) - 5 * 86_400;
    await writeFile(path.join(fixture.worktree, "file.txt"), "saved archived edit\n");
    await writeFile(path.join(fixture.worktree, "notes.txt"), "saved archived notes\n");
    const { registry, store } = fixture.open({ ...ON, enabled: false });
    const service = maintenance(registry);
    const scan = await service.scan({ steps: ["hibernate"], hibernateIdleDays: 2 });
    expect(scan.hibernate?.items.map((item) => item.threadId)).toEqual([THREAD_ID]);
    const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
      removeEmptyFolders: false, hibernate: [identity] });
    expect(run.steps.find((step) => step.step === "hibernate")).toMatchObject({ done: 1, kept: 0, failed: 0 });
    expect(await exists(fixture.worktree)).toBe(false);
    expect(ArchiveWorktreeTransport.threads[0]!.archived).toBe(true);
    const snapshot = (await snapshotOf(store))!;
    await registry.restoreWorktree({ ...identity, worktreePath: fixture.worktree, snapshotRef: snapshot.snapshotRef });
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("saved archived edit\n");
    expect(await readFile(path.join(fixture.worktree, "notes.txt"), "utf8")).toBe("saved archived notes\n");
    expect(ArchiveWorktreeTransport.threads[0]!.archived).toBe(true);
  });

  it("allows inspecting a reviewed thread through the final snapshot admission without restarting its idle clock", async () => {
    const fixture = await createFixture();
    const { registry, store } = fixture.open();
    const candidate = (await registry.listAutoArchiveCandidates())[0]!;
    await store.markThreadSeen({ ...identity, seenUpdatedAt: candidate.thread.updatedAt });
    expect(await registry.hibernateReviewedCheckout(candidate, ON)).toBe(true);
    expect(await exists(fixture.worktree)).toBe(false);
    expect(await snapshotOf(store)).toMatchObject({ state: "hibernated", worktreePath: fixture.worktree });
  });

  it("carries the protecting watch's PR into the kept checkout even before a PR chip was cached", async () => {
    const fixture = await createFixture();
    const { registry, store } = fixture.open();
    const watch = { watchId: "watch-fixture", backend: "codex" as const, threadId: THREAD_ID,
      prKey: "github.com/example/project/12", prUrl: "https://github.com/example/project/pull/12", prNumber: 12,
      prTitle: "Fix widget layout", headSha: "head", notifyOn: [], createdAt: Date.now(), failureHandledByAutoFix: false };
    vi.spyOn(store, "listAllActivePrStatusWatches").mockResolvedValue([watch]);
    const service = new ThreadMaintenanceService({
      getPolicy: () => ({ mode: "age", inactivityDays: 7, keepPerProject: 10, retentionDays: 30 }), snapshotLimitBytes: 100,
      listCandidates: async () => await registry.listAutoArchiveCandidates(), resolveProject: async () => fixture.repo,
      refreshCandidate: async (row) => row, isBusy: () => false,
      archiveFamily: async () => { throw new Error("A scan must not archive"); },
      auditArchivedCheckouts: async () => ({ candidates: [], kept: {}, emptyFolders: 0 }),
      removeArchivedCheckouts: async () => { throw new Error("A scan must not remove"); },
      isManagedCheckoutPath: () => true, trashItem: async () => { throw new Error("A scan must not remove"); },
      isCheckoutOnDisk: async () => true, hibernation: checkoutHibernationReviewDeps(() => registry),
    });
    const scan = await service.scan({ steps: ["hibernate"] });
    const kept = scan.hibernate?.coverage?.keptCheckouts?.find((row) => row.path === fixture.worktree);
    expect(kept).toMatchObject({ reason: "Watching a PR", threads: [{ backend: "codex", threadId: THREAD_ID,
      pullRequests: [{ url: watch.prUrl, title: watch.prTitle, number: watch.prNumber }] }] });
    expect(scan.hibernate?.items).toEqual([]);
  });

  // Provider inventory is the oracle, independently of navigation's source
  // and companion-app filters. A hidden row can still hold real disk space.
  it("includes every provider checkout owner even when navigation hides it", async () => {
    const fixture = await createFixture();
    const { registry } = fixture.open();
    await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.constantFrom("cli", "vscode", "exec", "appServer"), { minLength: 1 }), async (sources) => {
      ArchiveWorktreeTransport.threads = sources.map((source, index) => ({
        id: `owner-${index}`, cwd: fixture.worktree, source, name: "PwrSnap Capture Metadata Worker", status: { type: "notLoaded" },
      }));
      const found = await registry.listAutoArchiveCandidates();
      expect(found.map((row) => row.thread.id).sort()).toEqual(ArchiveWorktreeTransport.threads.map((row) => row.id).sort());
    }), { numRuns: 12 });
  });

  // Git is the oracle for workspace kind. A provider's minimal cwd summary
  // must not turn a real linked checkout into a plain directory on recheck.
  it("revalidates provider cwd summaries against Git instead of losing their checkout", async () => {
    const fixture = await createFixture();
    const { registry } = fixture.open();
    const listed = (await registry.listAutoArchiveCandidates())[0]!;
    const client = (registry as unknown as { codexClient: CodexAppServerClient }).codexClient;
    vi.spyOn(client, "readThreadSummary").mockResolvedValue({
      ...listed.thread,
      projectKey: fixture.worktree,
      linkedDirectories: [{ id: fixture.worktree, path: fixture.worktree, kind: "local", label: "repo" }],
    });
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 4 }), async (depth) => {
      // Equivalent Git spellings must produce the same native review paths.
      // Windows Git's forward slashes are covered by this real-Git oracle
      // there; dot segments exercise the normalization on every platform.
      const suffix = `${path.sep}.`.repeat(depth);
      Object.assign(registry, { acpWorktreeRepositoryResolver: async () => ({
        ...listed.thread.linkedDirectories[0]!, path: fixture.repo + suffix, worktreePath: fixture.worktree + suffix,
      }) });
      const refreshed = await registry.refreshArchiveCandidate(listed);
      expect(refreshed.thread.linkedDirectories).toEqual([expect.objectContaining({
        kind: "worktree", worktreePath: fixture.worktree, path: fixture.repo,
      })]);
    }), { numRuns: 8, examples: [[1]] });
  });

  function maintenance(registry: DesktopBackendRegistry) {
    return new ThreadMaintenanceService({
      getPolicy: () => registry.getThreadArchivePolicy(),
      snapshotLimitBytes: 100 * MB,
      listCandidates: async () => await registry.listAutoArchiveCandidates(),
      resolveProject: async (candidate) => await registry.resolveAutoArchiveProject(candidate),
      refreshCandidate: async (candidate) => await registry.refreshArchiveCandidate(candidate),
      isBusy: (candidate) => registry.isArchiveCandidateBusy(candidate),
      auditArchivedCheckouts: async () => ({ candidates: [], kept: {}, emptyFolders: 0 }),
      archiveFamily: vi.fn(async () => true),
      removeArchivedCheckouts: vi.fn(async () => ({ removed: [], kept: [], failed: [], emptyFoldersRemoved: 0, emptyFoldersFailed: [] })),
      isManagedCheckoutPath: () => true,
      trashItem: vi.fn(async () => {}),
      hibernation: checkoutHibernationReviewDeps(() => registry),
    });
  }

  it("hibernates a reviewed checkout in one commit while the hourly sweep is off", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.worktree, "file.txt"), "uncommitted edit\n");
    const { registry, store } = fixture.open({ ...ON, enabled: false });
    const service = maintenance(registry);
    const scan = await service.scan();
    expect(scan.hibernate).toMatchObject({ idleDays: 7, maxSnapshotMb: 5, checked: 1, kept: {} });
    expect(scan.hibernate?.items).toEqual([expect.objectContaining({ threadId: THREAD_ID, worktreePath: fixture.worktree, files: 1 })]);

    const { writes } = await measureSqliteWrites(async () => {
      const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
        removeEmptyFolders: false, hibernate: [identity] });
      expect(run.steps.find((step) => step.step === "hibernate")).toEqual({ step: "hibernate", ran: true, done: 1, kept: 0, failed: 0 });
    });
    expectSqliteWriteBudget({ scenario: "thread-maintenance-hibernate-one", note: "Thread maintenance hibernates one reviewed checkout", writes });
    expect(await exists(fixture.worktree)).toBe(false);
    expect(await snapshotOf(store)).toMatchObject({ state: "hibernated", worktreePath: fixture.worktree });
    // The sweep itself stays off.
    expect(await sweep(registry)).toMatchObject({ skipped: "Hibernation is off" });
  });

  it.each(["before scan", "after scan"])("hibernates with ignored files %s and restores only saved work", async (when) => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads[0]!.updatedAt = Math.floor(Date.now() / 1000) - 5 * 86_400;
    await writeFile(path.join(fixture.worktree, "file.txt"), "saved tracked edit\n");
    await writeFile(path.join(fixture.worktree, "notes.txt"), "saved untracked work\n");
    const addIgnored = async () => {
      await writeFile(path.join(fixture.worktree, ".env.local"), "ignored local data\n");
      await mkdir(path.join(fixture.worktree, "node_modules", "dep"), { recursive: true });
      await writeFile(path.join(fixture.worktree, "node_modules", "dep", "output.bin"), Buffer.alloc(MB));
    };
    if (when === "before scan") await addIgnored();
    const { registry, store } = fixture.open({ ...ON, enabled: false, removeRebuildableOutput: false });
    const service = maintenance(registry);
    const scan = await service.scan({ steps: ["hibernate"], hibernateIdleDays: 2 });
    expect(scan.hibernate?.items.map((item) => item.threadId)).toEqual([THREAD_ID]);
    expect(scan.hibernate?.removeRebuildableOutput).toBe(true);
    if (when === "after scan") await addIgnored();
    const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
      removeEmptyFolders: false, hibernate: [identity] });
    expect(run.steps.find((step) => step.step === "hibernate")).toMatchObject({ done: 1, kept: 0, failed: 0 });
    expect(await exists(fixture.worktree)).toBe(false);
    const snapshot = (await snapshotOf(store))!;
    expect(snapshot.ignoredFilesExcluded).toBe(true);
    const files = await git(fixture.repo, ["ls-tree", "--name-only", "-r", snapshot.snapshotCommit]);
    expect(files).not.toMatch(/\.env\.local|node_modules/);
    await registry.restoreWorktree({ ...identity, worktreePath: fixture.worktree, snapshotRef: snapshot.snapshotRef });
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("saved tracked edit\n");
    expect(await readFile(path.join(fixture.worktree, "notes.txt"), "utf8")).toBe("saved untracked work\n");
    expect(await exists(path.join(fixture.worktree, ".env.local"))).toBe(false);
    expect(await exists(path.join(fixture.worktree, "node_modules"))).toBe(false);
  });

  // Oracle: the registry's own rules. Every thread with a checkout lands in
  // exactly one count, the dialog's idle days decide "not idle yet" for the
  // scan and its run, and a hibernated checkout is noted apart from them.
  it("scans and runs with the dialog's idle days, and counts each thread once", async () => {
    const fixture = await createFixture();
    // Last active two days ago: Settings' 7 days keeps it, the dialog's 1 day does not.
    ArchiveWorktreeTransport.threads[0]!.updatedAt = Math.floor(Date.now() / 1000) - 2 * 86_400;
    const { registry } = fixture.open({ ...ON, enabled: false, idleDays: 7 });
    const service = maintenance(registry);

    const settings = await service.scan({ steps: ["hibernate"] });
    expect(settings.hibernate).toMatchObject({ idleDays: 7, checked: 1, notIdleYet: 1, alreadyHibernated: 0, kept: {}, items: [] });

    const reviewed = await service.scan({ steps: ["hibernate"], hibernateIdleDays: 1 });
    expect(reviewed.hibernate).toMatchObject({ idleDays: 1, checked: 1, notIdleYet: 0, alreadyHibernated: 0, kept: {} });
    expect(reviewed.hibernate?.items.map((item) => item.threadId)).toEqual([THREAD_ID]);
    const run = await service.apply({ scanId: reviewed.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
      removeEmptyFolders: false, hibernate: [identity] });
    expect(run.steps.find((step) => step.step === "hibernate")).toMatchObject({ ran: true, done: 1, kept: 0, failed: 0 });
    expect(await exists(fixture.worktree)).toBe(false);

    const after = await service.scan({ steps: ["hibernate"], hibernateIdleDays: 1 });
    expect(after.hibernate).toMatchObject({ checked: 0, notIdleYet: 0, alreadyHibernated: 1, kept: {}, items: [] });
  });

  it("keeps a reviewed checkout whose saved work grows past the snapshot limit", async () => {
    const fixture = await createFixture();
    const { registry } = fixture.open({ ...ON, enabled: false });
    const service = maintenance(registry);
    const scan = await service.scan();
    await writeFile(path.join(fixture.worktree, "file.txt"), Buffer.alloc(6 * MB));
    const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
      removeEmptyFolders: false, hibernate: [identity] });
    expect(run.problems).toEqual([expect.objectContaining({ step: "hibernate", kind: "kept", reason: "Changes over the snapshot limit" })]);
    expect(await exists(fixture.worktree)).toBe(true);
  });
});
