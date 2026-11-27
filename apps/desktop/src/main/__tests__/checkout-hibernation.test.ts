import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AppServerThreadSummary,
  WorktreeSnapshotSummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { DesktopCheckoutHibernationPolicy } from "@pwragent/shared/checkout-hibernation-policy";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import type {
  PwrAgentThreadOrchestrationRequest,
  PwrAgentThreadOrchestrationResponse,
} from "@pwragent/shared/contracts/thread-orchestration-tools";
import type { ThreadPullRequestWatchSummary } from "@pwragent/shared/contracts/thread-tools";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { CheckoutPathOwners } from "../app-server/checkout-path-owners";
import type { ThreadArchiveCandidate } from "../app-server/thread-archive-sweeper";
import { checkoutHibernationReviewDeps, ThreadMaintenanceService } from "../app-server/thread-maintenance-service";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb } from "./sqlite-test-utils";
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { SnapshotTreeMismatchError, WorktreeArchiveService } from "../app-server/worktree-archive-service";
import { PWRAGENT_WORKTREE_LOCK_REASON } from "../app-server/worktree-volume-lock";
import {
  HIBERNATION_WORKSPACE_KEEP_REASONS,
  inspectHibernationWorkspace,
} from "../app-server/checkout-hibernation-workspace";
import { registerWorktreeTerminalOwner } from "../terminal/worktree-terminals";
import { ArchiveWorktreeTransport } from "./fixtures/archive-worktree-transport";
import type { CodexEnvironmentCommandRunner } from "../app-server/codex-environment-runtime";
import { inspectRegisterableWorktree } from "../app-server/worktree-maintenance-registration";

/**
 * Real Git and real SQLite. Each keep case builds the Git state it names
 * with Git itself, then checks that hibernation leaves the checkout alone.
 */

const probeHook = vi.hoisted(() => ({ onInspect: undefined as undefined | ((call: number) => void), calls: 0, identities: 0 }));
vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
// These fixtures verify real Git ownership and removal, not elapsed rest
// time. Keep host turns; the discovery property suite budgets the pacing.
vi.mock("../app-server/archive-candidate-discovery", async (original) => {
  const actual = await original<typeof import("../app-server/archive-candidate-discovery")>();
  return { ...actual, archiveCandidateCheckpoint: (assertCurrent: () => void) => actual.archiveCandidateCheckpoint(assertCurrent, {
    now: () => performance.now(), rest: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); },
  }) };
});
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
vi.mock("../app-server/worktree-maintenance-registration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app-server/worktree-maintenance-registration")>();
  return {
    ...actual,
    hasWorktreeRegistration: async (...args: Parameters<typeof actual.hasWorktreeRegistration>) => {
      probeHook.identities += 1;
      return await actual.hasWorktreeRegistration(...args);
    },
    inspectRegisterableWorktree: async (...args: Parameters<typeof actual.inspectRegisterableWorktree>) => {
      probeHook.identities += 1;
      return await actual.inspectRegisterableWorktree(...args);
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
class FixtureOwner {
  readonly work = new Set<Promise<unknown>>();
  private closing = false;
  constructor(readonly signal: AbortSignal) {}
  check(): void {
    this.signal.throwIfAborted();
    if (this.closing) throw new Error("Checkout fixture owner retired");
  }
  stop(): void { this.closing = true; }
  async close(): Promise<void> {
    this.stop();
    while (this.work.size) await Promise.allSettled([...this.work]);
  }
}
let fixtureOwner: FixtureOwner;
let retirement: Promise<void> | undefined;
beforeEach(({ signal }) => { fixtureOwner = new FixtureOwner(signal); retirement = undefined; });

function ownFixtureWork<T>(work: Promise<T>): Promise<T> {
  const owner = fixtureOwner;
  owner.work.add(work);
  const settled = () => { owner.work.delete(work); };
  void work.then(settled, settled);
  return work;
}

function ownFixtureTest<Args extends unknown[]>(run: (...args: Args) => Promise<void>): (...args: Args) => Promise<void> {
  return (...args) => {
    const owner = fixtureOwner;
    owner.check();
    return ownFixtureWork(Promise.resolve().then(() => { owner.check(); return run(...args); }));
  };
}

async function disposeFixtures() {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

function cleanupFixtureTest(): Promise<void> {
  return retirement ??= (async () => {
    fixtureOwner.stop();
    for (const release of releases.splice(0)) release();
    // The whole test owns setup, Git, SQLite, assertions and generated cases.
    // Vitest's deadline stops waiting; it does not retire that asynchronous work.
    await fixtureOwner.close();
    await disposeFixtures();
    vi.unstubAllEnvs();
    ArchiveWorktreeTransport.threads = [];
    ArchiveWorktreeTransport.requests = [];
    ArchiveWorktreeTransport.onList = undefined;
    probeHook.onInspect = undefined;
    probeHook.calls = 0;
    probeHook.identities = 0;
  })();
}
// The control body may retire the fixture it is observing. Its own lifetime
// therefore belongs to the outer hook, outside that fixture's retirement.
const oracleWork = new Set<Promise<void>>();
function ownFixtureOracle<Args extends unknown[]>(run: (...args: Args) => Promise<void>): (...args: Args) => Promise<void> {
  return (...args) => {
    const work = Promise.resolve().then(() => run(...args));
    oracleWork.add(work);
    const settled = () => { oracleWork.delete(work); };
    void work.then(settled, settled);
    return work;
  };
}
afterEach(async () => {
  while (oracleWork.size) await Promise.allSettled([...oracleWork]);
  await cleanupFixtureTest();
});

const ON: DesktopCheckoutHibernationPolicy = {
  enabled: true, idleDays: 7, maxSnapshotMb: 5, removeRebuildableOutput: true, restoreOn: "send",
};

async function runGit(cwd: string, args: string[]): Promise<string> {
  return (await execute("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args])).stdout;
}

async function git(cwd: string, args: string[]): Promise<string> {
  fixtureOwner.check();
  return await runGit(cwd, args);
}

async function createRepoSeed(repo: string, environment: boolean) {
  await mkdir(repo);
  await runGit(repo, ["init", "--template=", "-b", "main"]);
  await runGit(repo, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(repo, "file.txt"), "original\n");
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\n.env.local\n");
  if (environment) {
    await mkdir(path.join(repo, ".codex", "environments"), { recursive: true });
    await writeFile(path.join(repo, ".codex", "environments", "env.toml"), 'version = 1\nname = "Env"\n[setup]\nscript = "install"\n');
  }
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "-m", "fixture"]);
}

function ownRepoSeeds(
  createSeed = createRepoSeed,
  removeRoot = (root: string) => rm(root, { recursive: true, force: true }),
) {
  let root: string;
  let initialization: Promise<void> | undefined;
  return {
    get root() { return root; },
    initialize: () => initialization ??= (async () => {
      root = await mkdtemp(path.join(os.tmpdir(), "pwragent-hibernate-seed-"));
      await createSeed(path.join(root, "plain"), false);
      await createSeed(path.join(root, "environment"), true);
    })(),
    close: async () => {
      // Vitest can stop awaiting the setup hook while Git still uses the root.
      // Setup reports its own failure. Teardown joins it before removing files.
      await initialization?.catch(() => {});
      if (root) await removeRoot(root);
    },
  };
}

const repoSeeds = ownRepoSeeds();
beforeAll(repoSeeds.initialize);
afterAll(repoSeeds.close);

async function createFixture(options: { environment?: boolean; worktreeRoot?: ".pwragent" | ".codex" } = {}) {
  const scope = fixtureOwner;
  scope.check();
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-hibernate-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  const worktree = path.join(root, options.worktreeRoot ?? ".pwragent", "worktrees", "id", "repo");
  // Copy refs, objects and index before Git writes the linked-worktree metadata.
  // Each case owns its primary checkout and its linked worktree.
  await cp(path.join(repoSeeds.root, options.environment ? "environment" : "plain"), repo, { recursive: true });
  await mkdir(path.dirname(worktree), { recursive: true });
  await git(repo, ["worktree", "add", "-b", "owned", worktree]);
  const directory = { id: "owned", kind: "worktree" as const, label: "repo", path: repo, worktreePath: worktree };
  ArchiveWorktreeTransport.threads = [{ id: THREAD_ID, cwd: worktree, source: "cli", status: { type: "notLoaded" } }];
  const { dbPath, tempDir } = createTempStateDb("pwragent-hibernate-db-");
  roots.push(tempDir);
  const open = (policy: DesktopCheckoutHibernationPolicy = ON, extra: { commandRunner?: CodexEnvironmentCommandRunner } = {}) => {
    scope.check();
    // Without the counters every budget below, the zeros included, would pass unmeasured.
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    const db = StateDb.open(dbPath);
    databases.push(db);
    const store = new SqliteOverlayStore(db);
    const client = new CodexAppServerClient({ directoryResolver: async (cwd) => cwd === worktree ? [directory] : [] });
    let current = policy;
    const registry = createDesktopBackendRegistry({
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
function stubProviderTurnStart(registry: DesktopBackendRegistry, onStart?: () => void) {
  return vi.spyOn(registry as unknown as { startTurnWithoutHandoff: (params: { threadId: string }) => Promise<unknown> },
    "startTurnWithoutHandoff").mockImplementation(async (params) => {
      onStart?.();
      return { backend: "codex", threadId: params.threadId, turnId: `turn-${Date.now()}` };
    });
}

function recreateSpy(registry: DesktopBackendRegistry, beforeRecreate?: () => Promise<void>) {
  const service = (registry as unknown as { worktreeRecoveryService: { recreate: (...args: unknown[]) => Promise<unknown> } }).worktreeRecoveryService;
  const recreate = service.recreate.bind(service);
  const spy = vi.spyOn(service, "recreate");
  if (beforeRecreate) spy.mockImplementation(async (...args) => {
    await beforeRecreate();
    return await recreate(...args);
  });
  return spy;
}

const probe = (cwd: string, overrides: Partial<{ limitBytes: number; removeRebuildableOutput: boolean }> = {}) =>
  inspectHibernationWorkspace(cwd, { signal: new AbortController().signal, limitBytes: 5 * MB, removeRebuildableOutput: true, ...overrides });

function registrationTool(registry: DesktopBackendRegistry) {
  const internal = registry as unknown as {
    isLiveDynamicToolCall: () => boolean;
    handleThreadOrchestrationRequest: (request: PwrAgentThreadOrchestrationRequest) => Promise<PwrAgentThreadOrchestrationResponse>;
  };
  const live = vi.spyOn(internal, "isLiveDynamicToolCall").mockReturnValue(true);
  const call = (worktreePath: string, action?: "register" | "unregister" | "inspect", threadId = THREAD_ID) =>
    internal.handleThreadOrchestrationRequest({ operation: "register_thread_worktree",
      context: { backend: "codex", threadId: "registration-agent", turnId: "registration-turn" },
      args: { backend: "codex", threadId, worktreePath, ...(action ? { action } : {}) },
    });
  // The operator's confirmation card belongs to the thread inspection tools.
  const approvals = registryModules(registry).threadInspectionTools;
  return { approvals, live, call };
}

type RegistrationCard = import("@pwragent/shared/contracts/normalized-app-server").AppServerToolRequestUserInputNotification;

function waitForRegistrationCard(registry: DesktopBackendRegistry): Promise<RegistrationCard> {
  fixtureOwner.check();
  const signal = fixtureOwner.signal;
  const card = Promise.withResolvers<RegistrationCard>();
  let settled = false;
  let unsubscribe = () => {};
  const dispose = () => {
    signal.removeEventListener("abort", abort);
    unsubscribe();
  };
  const cancel = (reason: unknown) => {
    if (settled) return;
    settled = true;
    dispose();
    card.reject(reason);
  };
  const abort = () => cancel(signal.reason);
  unsubscribe = registry.onEvent((event) => {
    if (settled || event.notification.method !== "item/tool/requestUserInput") return;
    settled = true;
    dispose();
    card.resolve(event.notification as RegistrationCard);
  });
  signal.addEventListener("abort", abort, { once: true });
  releases.push(() => cancel(new Error("Checkout notification wait retired")));
  if (signal.aborted) abort();
  return card.promise;
}

async function outsideRegistrationFixture() {
  const fixture = await createFixture({ worktreeRoot: ".codex" });
  const runtime = fixture.open({ ...ON, enabled: false });
  await runtime.store.replaceWorkspaceLinkedDirectory({ ...identity,
    directory: { ...fixture.directory, worktreeOwnership: "external" } });
  return { ...fixture, ...runtime, ...registrationTool(runtime.registry) };
}

describe("hibernation workspace checks (real Git)", () => {
  it("accepts a clean checkout and one with small uncommitted changes", ownFixtureTest(async () => {
    const { worktree } = await createFixture();
    expect(await probe(worktree)).toEqual({ files: 0, bytes: 0 });
    await writeFile(path.join(worktree, "file.txt"), "edited\n");
    await writeFile(path.join(worktree, "notes.txt"), "new\n");
    expect(await probe(worktree)).toMatchObject({ files: 2 });
  }));

  it("keeps changes over the snapshot limit", ownFixtureTest(async () => {
    const { worktree } = await createFixture();
    await writeFile(path.join(worktree, "big.bin"), Buffer.alloc(6 * MB, 1));
    expect(await probe(worktree)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.overLimit });
  }));

  it("keeps a submodule with uncommitted work", ownFixtureTest(async () => {
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
  }));

  it.each([true, false])("ignored files do not keep a checkout with legacy output policy %s", ownFixtureTest(async (legacyPolicy) => {
    const { worktree } = await createFixture();
    await writeFile(path.join(worktree, ".env.local"), "SECRET=1\n");
    await mkdir(path.join(worktree, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(worktree, "node_modules", "dep", "output.bin"), Buffer.alloc(1024));
    expect(await probe(worktree, { removeRebuildableOutput: legacyPolicy, limitBytes: 1 }))
      .toEqual({ files: 0, bytes: 0, removedOutput: ["node_modules"] });
  }));

  it("keeps a checkout in the middle of a rebase", ownFixtureTest(async () => {
    const { repo, worktree } = await createFixture();
    await writeFile(path.join(worktree, "file.txt"), "branch side\n");
    await git(worktree, ["commit", "-am", "branch"]);
    await writeFile(path.join(repo, "file.txt"), "main side\n");
    await git(repo, ["commit", "-am", "main"]);
    await expect(git(worktree, ["rebase", "main"])).rejects.toThrow();
    expect(await probe(worktree)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.operation });
  }));

  it("keeps a checkout in the middle of a merge", ownFixtureTest(async () => {
    const { repo, worktree } = await createFixture();
    await writeFile(path.join(worktree, "file.txt"), "branch side\n");
    await git(worktree, ["commit", "-am", "branch"]);
    await writeFile(path.join(repo, "file.txt"), "main side\n");
    await git(repo, ["commit", "-am", "main"]);
    await expect(git(worktree, ["merge", "main"])).rejects.toThrow();
    expect(await probe(worktree)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.operation });
  }));

  it("keeps a checkout with a bisect in progress", ownFixtureTest(async () => {
    const { worktree } = await createFixture();
    await git(worktree, ["bisect", "start"]);
    expect(await probe(worktree)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.operation });
  }));

  it("keeps a checkout whose branch has a stash", ownFixtureTest(async () => {
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
  }));

  it("keeps commits no branch or remote retains", ownFixtureTest(async () => {
    const { worktree } = await createFixture();
    await git(worktree, ["checkout", "--detach"]);
    await writeFile(path.join(worktree, "file.txt"), "detached commit\n");
    await git(worktree, ["commit", "-am", "detached"]);
    expect(await probe(worktree)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.unretained });
  }));

  // Rule: any lock is a hold except PwrAgent's own drive lock, which the
  // removal clears; a worktree on another drive must still hibernate.
  it.each([
    ["with no reason", [], true],
    ["with an operator's reason", ["--reason", "operator hold"], true],
    ["with PwrAgent's drive lock", ["--reason", PWRAGENT_WORKTREE_LOCK_REASON], false],
  ] as const)("keeps a worktree locked %s only when someone else holds it", ownFixtureTest(async (_name, reason, kept) => {
    const { repo, worktree } = await createFixture();
    await git(repo, ["worktree", "lock", ...reason, worktree]);
    const inspection = await probe(worktree);
    if (kept) expect(inspection).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.locked });
    else expect(inspection).not.toHaveProperty("keep");
  }));
});

describe("hibernating a checkout (real Git)", () => {
  it("keeps the checkout when it changes after the snapshot is written", ownFixtureTest(async () => {
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
  }));

  it("hibernates a checkout under PwrAgent's drive lock and clears the lock with it", ownFixtureTest(async () => {
    const { repo, worktree } = await createFixture();
    await writeFile(path.join(worktree, "file.txt"), "saved edit\n");
    await git(repo, ["worktree", "lock", "--reason", PWRAGENT_WORKTREE_LOCK_REASON, worktree]);
    await new WorktreeArchiveService().hibernate({
      ...identity, worktreePath: worktree, repositoryPath: repo, capSnapshotBytes: 5 * MB, beforeRemove: async () => () => {},
    });
    expect(await exists(worktree)).toBe(false);
    expect(await git(repo, ["worktree", "list", "--porcelain"])).not.toContain(worktree.replaceAll("\\", "/"));
  }));

  it("caps the snapshot at the hibernation limit even where archive would allow more", ownFixtureTest(async () => {
    const { repo, worktree } = await createFixture();
    await writeFile(path.join(worktree, "big.bin"), Buffer.alloc(2 * MB, 1));
    const service = new WorktreeArchiveService({ maxSnapshotBytes: 100 * MB });
    await expect(service.hibernate({
      ...identity, worktreePath: worktree, repositoryPath: repo, capSnapshotBytes: 1 * MB, beforeRemove: async () => () => {},
    })).rejects.toThrow(/Snapshot size limit exceeded/);
    expect(await exists(path.join(worktree, "big.bin"))).toBe(true);
  }));
});

describe("idle checkout hibernation and restore", () => {
  it("hibernates an idle checkout with one commit and restores it on the same path, branch and tree", ownFixtureTest(async () => {
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
  }));

  // Codex never removes its own ~/.codex/worktrees checkouts, so they
  // hibernate like PwrAgent's and come back on the same path.
  it("hibernates and restores a checkout under Codex's worktree root", ownFixtureTest(async () => {
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
  }));

  it("makes no commits across 24 sweeps with nothing to hibernate, or when it keeps a checkout", ownFixtureTest(async () => {
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
  }));

  it("writes nothing while hibernation is off, which is the default", ownFixtureTest(async () => {
    const fixture = await createFixture();
    const { registry } = fixture.open({ ...ON, enabled: false });
    expect(await sweep(registry)).toMatchObject({ skipped: "Hibernation is off" });
    expect(await exists(fixture.worktree)).toBe(true);
  }));

  it("refuses a checkout with an open terminal, and never closes it", ownFixtureTest(async () => {
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
  }));

  it("keeps a pinned thread listed and pinned, and hibernates its checkout", ownFixtureTest(async () => {
    const fixture = await createFixture();
    const { registry, store } = fixture.open();
    await store.setThreadPin({ ...identity, pinned: true });
    const rank = (await store.getThreadOverlayState(identity))?.pinnedRank;
    expect(rank).toBeDefined();
    expect(await sweep(registry)).toMatchObject({ hibernated: 1 });
    expect((await store.getThreadOverlayState(identity))?.pinnedRank).toBe(rank);
  }));

  it("is cancelled by a send that arrives while it re-runs its checks", ownFixtureTest(async () => {
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
  }));

  it("restores on send: the message waits for the restore, and concurrent sends share one", ownFixtureTest(async () => {
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
  }));

  it("starts from the main checkout when a hibernated Codex worktree lost its checkpoint and branch", ownFixtureTest(async () => {
    const fixture = await createFixture();
    const { registry, store } = fixture.open();
    expect(await sweep(registry)).toMatchObject({ hibernated: 1 });
    const saved = (await snapshotOf(store))!;
    await git(fixture.repo, ["update-ref", "-d", saved.snapshotRef]);
    await git(fixture.repo, ["branch", "-D", "owned"]);
    await store.upsertWorktreeSnapshot({ ...identity, snapshot: {
      ...saved, snapshotCommit: "f".repeat(40), sourceHead: "e".repeat(40),
    } });
    const start = stubProviderTurnStart(registry);
    await registry.startTurn({ ...identity, input: [{ type: "text", text: "Continue" }] });
    expect(start).toHaveBeenCalledOnce();
    expect((await git(fixture.worktree, ["rev-parse", "HEAD"])).trim())
      .toBe((await git(fixture.repo, ["rev-parse", "HEAD"])).trim());
    expect((await git(fixture.worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("HEAD");
    expect(await snapshotOf(store)).toMatchObject({ state: "restored" });
  }));

  it.each([false, true])("keeps a queued send behind its own checkout restore (delayed acknowledgement: %s)", ownFixtureTest(async (delayAcknowledgement) => {
    // Each provider inventory has one registry owner. The preceding direct
    // sends must settle and close before a queued-send fixture replaces it.
    expect(registries).toHaveLength(0);
    const fixture = await createFixture();
    await writeFile(path.join(fixture.worktree, "file.txt"), "queued edit\n");
    const { registry } = fixture.open();
    expect(await sweep(registry)).toMatchObject({ hibernated: 1 });
    let restoring!: () => void;
    const restoreEntered = new Promise<void>((resolve) => { restoring = resolve; });
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => { resume = resolve; });
    releases.push(resume);
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => { admitted = resolve; });
    registry.onEvent(async (event) => {
      if (event.notification.method !== "thread/turnQueue/updated" || event.notification.params.status !== "queued") return;
      admitted();
      if (delayAcknowledgement) await barrier;
    });
    const recreate = recreateSpy(registry, async () => { restoring(); await barrier; });
    let didStart!: () => void;
    const queuedStart = new Promise<void>((resolve) => { didStart = resolve; });
    const started = stubProviderTurnStart(registry, didStart);
    const submission = ownFixtureWork(registry.submitTurn({ ...identity, input: [{ type: "text", text: "queued" }] }));
    try {
      // Queue admission, not its publication acknowledgement, proves the
      // send is waiting. Publication may itself await restore progress.
      await Promise.all([restoreEntered, admission]);
      expect(registry.getQueuedTurnsForThread(identity).map((entry) => entry.displayText)).toEqual(["queued"]);
      expect(started).not.toHaveBeenCalled();
    } finally { resume(); }
    expect((await submission).status).toBe("queued");
    await queuedStart;
    expect(recreate).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("queued edit\n");
  }));

  it("restores with environment setup in two commits", ownFixtureTest(async () => {
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
  }));

  it.each([
    ["the path is occupied", async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      await mkdir(fixture.worktree, { recursive: true });
      await writeFile(path.join(fixture.worktree, "someone-else.txt"), "not ours\n");
    }],
  ])("keeps the snapshot and holds the message when %s", ownFixtureTest(async (_name, breakRestore) => {
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
  }));
});

// Oracle: a branch Git can't put back unmoved (checked out elsewhere, moved,
// or deleted) never blocks the restore. The checkout comes back at its saved
// HEAD on a detached HEAD with its saved edits, the branch stays where it
// was, the message goes ahead, and the final event says why, once.
describe("hibernated restore when the branch can't be put back", () => {
  it.each(["clean", "dirty"] as const)("recreates a %s hibernated checkout detached at its saved commit after branch deletion", ownFixtureTest(async (state) => {
    const fixture = await createFixture();
    const file = path.join(fixture.worktree, "file.txt");
    await writeFile(file, "committed edit\n");
    await git(fixture.worktree, ["commit", "-am", "change on the worktree branch"]);
    const head = (await git(fixture.worktree, ["rev-parse", "HEAD"])).trim();
    if (state === "dirty") {
      await writeFile(file, "uncommitted edit\n");
      await writeFile(path.join(fixture.worktree, "new.txt"), "untracked file\n");
    }
    const readStatus = () => git(fixture.worktree, ["status", "--porcelain"]);
    const status = await readStatus();
    const contents = await readFile(file, "utf8");
    const { registry, store } = fixture.open();
    await store.replaceWorkspaceLinkedDirectory({ ...identity, directory: fixture.directory });
    await sweep(registry);
    const snapshot = await snapshotOf(store);
    expect(snapshot).toMatchObject({ state: "hibernated", sourceHead: head });
    const savedHead = state === "clean" ? snapshot!.snapshotCommit
      : (await git(fixture.repo, ["rev-parse", `${snapshot!.snapshotCommit}^1`])).trim();
    expect(savedHead).toBe(head);
    await git(fixture.repo, ["branch", "-D", "owned"]);

    const request = { ...identity, worktreePath: fixture.worktree };
    await expect(registry.recreateThreadWorktree(request)).resolves.toMatchObject({ status: "failed", reason: "branch-missing" });
    await expect(registry.recreateThreadWorktree({ ...request, detached: true })).resolves.toMatchObject({ status: "recreated" });

    // Hibernation must round-trip Git's original HEAD and working-tree state.
    expect((await git(fixture.worktree, ["rev-parse", "HEAD"])).trim()).toBe(head);
    expect(await readStatus()).toBe(status);
    expect(await readFile(file, "utf8")).toBe(contents);
    if (state === "dirty") expect(await readFile(path.join(fixture.worktree, "new.txt"), "utf8")).toBe("untracked file\n");
    expect(await git(fixture.worktree, ["branch", "--show-current"])).toBe("");
    expect(await snapshotOf(store)).toMatchObject({ state: "restored" });
  }));

  it.each([
    ["in-use", async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      await git(fixture.repo, ["worktree", "add", path.join(fixture.root, "elsewhere"), "owned"]);
    }],
    ["moved", async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      await writeFile(path.join(fixture.repo, "other.txt"), "moved on\n");
      await git(fixture.repo, ["add", "other.txt"]);
      await git(fixture.repo, ["commit", "-m", "move"]);
      await git(fixture.repo, ["branch", "-f", "owned", "main"]);
    }],
    ["missing", async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      await git(fixture.repo, ["branch", "-D", "owned"]);
    }],
  ] as const)("restores detached when the branch is %s, and sends", ownFixtureTest(async (reason, breakBranch) => {
    const fixture = await createFixture();
    const head = (await git(fixture.worktree, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(fixture.worktree, "file.txt"), "uncommitted edit\n");
    const { registry, store } = fixture.open();
    await sweep(registry);
    await breakBranch(fixture);
    const branchBefore = reason === "missing" ? "" : (await git(fixture.repo, ["rev-parse", "owned"])).trim();
    const events: unknown[] = [];
    registry.onEvent((event) => {
      if (event.notification.method === "thread/checkoutHibernation/updated") events.push(event.notification.params);
    });

    const started = stubProviderTurnStart(registry);
    await registry.startTurn({ ...identity, input: [{ type: "text", text: "after hibernation" }] });
    expect(started).toHaveBeenCalledTimes(1);

    expect((await git(fixture.worktree, ["rev-parse", "HEAD"])).trim()).toBe(head);
    expect((await git(fixture.worktree, ["branch", "--show-current"])).trim()).toBe("");
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("uncommitted edit\n");
    if (reason !== "missing") expect((await git(fixture.repo, ["rev-parse", "owned"])).trim()).toBe(branchBefore);
    const detachedFrom = { branch: "owned", head, reason,
      ...(reason === "in-use" ? { checkedOutAt: expect.stringContaining("elsewhere") } : {}) };
    expect(await snapshotOf(store)).toMatchObject({ state: "restored", detachedFrom });
    const withOutcome = events.filter((params) => (params as { restoredDetached?: unknown }).restoredDetached);
    expect(withOutcome).toEqual([{ threadId: THREAD_ID, workspace: null,
      restoredDetached: { worktreePath: fixture.worktree, detachedFrom } }]);
    expect(events.at(-1)).toBe(withOutcome[0]);
  }));
});

it.each(["owned", "detached"] as const)("restores a clean hibernated merge commit from a %s checkout", ownFixtureTest(async (checkout) => {
  const fixture = await createFixture();
  await writeFile(path.join(fixture.repo, "merged.txt"), "committed on main\n");
  await git(fixture.repo, ["add", "merged.txt"]);
  await git(fixture.repo, ["commit", "-m", "change on main"]);
  await git(fixture.worktree, ["merge", "--no-ff", "-m", "merge main", "main"]);
  if (checkout === "detached") await git(fixture.worktree, ["switch", "--detach"]);
  const head = (await git(fixture.worktree, ["rev-parse", "HEAD"])).trim();
  const { registry, store } = fixture.open();
  await sweep(registry);
  const snapshot = await snapshotOf(store);
  expect(snapshot).toMatchObject({ state: "hibernated", snapshotCommit: head, sourceHead: head });

  await expect(registry.restoreWorktree({ ...identity, worktreePath: fixture.worktree, snapshotRef: snapshot!.snapshotRef }))
    .resolves.toMatchObject({ snapshot: { state: "restored" } });
  expect((await git(fixture.worktree, ["rev-parse", "HEAD"])).trim()).toBe(head);
  expect((await git(fixture.worktree, ["branch", "--show-current"])).trim()).toBe(checkout === "owned" ? "owned" : "");
  expect(await git(fixture.worktree, ["status", "--porcelain"])).toBe("");
}));

describe("Restore now and Keep it awake", () => {
  type HibernationEvent = { workspace?: { restoring?: boolean; restorePhase?: string; runsSetup?: boolean } | null; keepAwake?: boolean };
  const hibernationEvents = (registry: DesktopBackendRegistry) => {
    const events: HibernationEvent[] = [];
    registry.onEvent((event) => {
      if (event.notification.method === "thread/checkoutHibernation/updated") events.push(event.notification.params as HibernationEvent);
    });
    return events;
  };

  it("keeps a thread awake in one commit, restores its checkout, and the sweep then keeps it", ownFixtureTest(async () => {
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
  }));

  it("restores now without a send, and reports the snapshot it saved", ownFixtureTest(async () => {
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
  }));

  it("answers a refused restore with its reason and keeps the snapshot", ownFixtureTest(async () => {
    const fixture = await createFixture();
    const { registry, store } = fixture.open();
    await sweep(registry);
    await mkdir(fixture.worktree, { recursive: true });
    await writeFile(path.join(fixture.worktree, "someone-else.txt"), "not ours\n");
    const events = hibernationEvents(registry);
    const result = await registry.setThreadCheckoutHibernation({ ...identity, restore: true });
    expect(result).toMatchObject({ keepAwake: false, hibernated: true, restoreError: expect.stringContaining("Something now exists") });
    expect(await snapshotOf(store)).toMatchObject({ state: "hibernated" });
    expect(registry.readCheckoutHibernation(identity).restoreFailure?.message).toBe(result.restoreError);
    // The card goes back to the hibernated checkout; it never reads awake.
    expect(events.at(-1)?.workspace).toMatchObject({ worktreePath: fixture.worktree, branch: "owned" });
    expect(events.at(-1)?.workspace).not.toHaveProperty("restoring");
  }));

  it("ends a restore that throws, so no surface keeps showing it", ownFixtureTest(async () => {
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
  }));

  it("says the restore runs project setup before any restore starts", ownFixtureTest(async () => {
    const fixture = await createFixture({ environment: true });
    const { registry, store } = fixture.open();
    await store.setThreadCodexEnvironmentRuntime({ ...identity, codexEnvironmentRuntime: {
      environmentId: "env", environmentName: "Env", executionTarget: "local", setupStatus: "succeeded",
    } as never });
    const events = hibernationEvents(registry);
    await sweep(registry);
    expect(events).toEqual([{ threadId: THREAD_ID, workspace: expect.objectContaining({ runsSetup: true }) }]);
  }));

  it("keeps the restoring card through project setup, then clears it", ownFixtureTest(async () => {
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
  }));
});

describe("Thread maintenance's hibernate step", () => {
  it("uses fleet membership rather than a missing archive timestamp to ignore an archived co-owner", ownFixtureTest(async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads.push({ id: "archived-owner", cwd: fixture.worktree, source: "cli", archived: true });
    const { registry } = fixture.open({ ...ON, enabled: false });
    const candidate = (await registry.listAutoArchiveCandidates()).find((item) => item.thread.id === THREAD_ID)!;
    expect(await registry.hibernateReviewedCheckout(candidate, { ...ON, enabled: true })).toBe(true);
    expect(await exists(fixture.worktree)).toBe(false);
  }));

  // Codex reports no archive time, so the archived page is the only archive
  // evidence. Retired monitor workers once shared a release worktree this way
  // and held it awake. The provider inventory is the oracle: only an
  // unarchived co-owner shares the checkout, and an archived row is never
  // offered for archive again.
  it("uses the provider archive page to distinguish archived and sharing co-owners", ownFixtureTest(async () => {
    const fixture = await createFixture();
    const target = ArchiveWorktreeTransport.threads[0]!;
    const { registry } = fixture.open({ ...ON, enabled: false });
    const service = maintenance(registry);
    for (const archived of [[], [true], [false], [true, true], [true, false], [false, true, true, true]]) {
      ArchiveWorktreeTransport.threads = [target, ...archived.map((isArchived, index) => ({
        id: `co-owner-${index}`, cwd: fixture.worktree, source: "vscode", status: { type: "notLoaded" as const }, archived: isArchived,
      }))];
      const scan = await service.scan({ steps: ["threads", "hibernate"], rules: { mode: "age", inactivityDays: 0 } });
      const shared = archived.some((isArchived) => !isArchived);
      expect(scan.hibernate?.items.some((item) => item.threadId === THREAD_ID)).toBe(!shared);
      const offered = scan.threads.projects.flatMap((project) => project.idle.map((row) => row.threadId));
      const archivedIds = archived.flatMap((isArchived, index) => isArchived ? [`co-owner-${index}`] : []);
      expect(offered.filter((threadId) => archivedIds.includes(threadId))).toEqual([]);
    }
  }));

  // ACP summaries drop the session's archive time, as Codex rows have none.
  // The page that lists the session is the oracle for whether it shares.
  it("uses the ACP archive page to distinguish an archived and a sharing session", ownFixtureTest(async () => {
    const fixture = await createFixture();
    const { registry } = fixture.open({ ...ON, enabled: false });
    const acp = (registry as unknown as { acpBackend: {
      archiveCleanupBackendIds: () => Promise<string[]>;
      listArchiveCleanupSessionsPage: (backendId: string, params: { archived: boolean }) => { sessions: Array<{ sessionId: string }> };
      sessionToThreadSummary: (session: { sessionId: string }) => AppServerThreadSummary;
    } }).acpBackend;
    let sessionArchived = false;
    vi.spyOn(acp, "archiveCleanupBackendIds").mockResolvedValue(["acp:kimi"]);
    vi.spyOn(acp, "listArchiveCleanupSessionsPage").mockImplementation((_backendId, { archived }) =>
      ({ sessions: archived === sessionArchived ? [{ sessionId: "acp-co-owner" }] : [] }));
    vi.spyOn(acp, "sessionToThreadSummary").mockImplementation(({ sessionId }) => ({
      id: sessionId, title: "ACP co-owner", titleSource: "explicit", source: "acp:kimi", threadStatus: "idle", updatedAt: 2,
      projectKey: fixture.worktree, linkedDirectories: [fixture.directory],
    }));
    const service = maintenance(registry);
    for (const archived of [true, false]) {
      sessionArchived = archived;
      const scan = await service.scan({ steps: ["hibernate"] });
      expect(scan.hibernate?.items.some((item) => item.threadId === THREAD_ID)).toBe(archived);
    }
  }));

  // Model test. Maintenance splits its owners into active and archived for
  // checkout ownership, and hibernation's sharing rule indexes owners in
  // CheckoutPathOwners. A retention start alone (a thread restored in the
  // Codex app keeps it) used to be archived to the first and a live owner to
  // the second, so one scan gave the same thread two answers.
  it("splits checkout owners exactly as the shared-checkout index counts them (model property)", ownFixtureTest(async () => {
    const fixture = await createFixture();
    const { registry } = fixture.open({ ...ON, enabled: false });
    const inventory = (candidates: ThreadArchiveCandidate[]) => (registryModules(registry).threadArchiveCoordinator as unknown as {
      maintenanceOwnershipInventory: (rows: ThreadArchiveCandidate[]) => { activeThreads: AppServerThreadSummary[] };
    }).maintenanceOwnershipInventory(candidates);
    const outsider = { thread: { id: "outsider", source: "codex" as const, linkedDirectories: [] } };
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("none", "provider", "tombstone", "retention"), { maxLength: 5 }), async (states) => {
      const candidates: ThreadArchiveCandidate[] = states.map((state, index) => ({
        thread: { id: `owner-${index}`, title: "owner", titleSource: "explicit", source: "codex", updatedAt: 2,
          linkedDirectories: [{ ...fixture.directory, worktreePath: path.join(fixture.root, `checkout-${index}`) }],
          ...(state === "provider" ? { archivedAt: 1 } : {}) },
        overlay: { backend: "codex", threadId: `owner-${index}`, executionMode: "default", extraLinkedDirectories: [],
          ...(state === "tombstone" ? { archiveTombstonedAt: 1 } : {}),
          ...(state === "retention" ? { archiveRetentionStartedAt: 1 } : {}) },
      }));
      const owners = new CheckoutPathOwners(candidates);
      const active = new Set(inventory(candidates).activeThreads.map((thread) => thread.id));
      for (const [index, candidate] of candidates.entries()) {
        expect(active.has(candidate.thread.id)).toBe(owners.sharedWithAnotherThread(outsider, path.join(fixture.root, `checkout-${index}`)));
      }
    }), { numRuns: 5, examples: [[["retention"]], [["none", "provider", "tombstone", "retention"]], [[]]] });
  }));

  it("keeps a co-owner that both provider pages list as a sharing user", ownFixtureTest(async () => {
    const fixture = await createFixture();
    const coOwner = { id: "co-owner", cwd: fixture.worktree, source: "vscode", status: { type: "notLoaded" as const }, archived: false };
    ArchiveWorktreeTransport.threads.push(coOwner);
    // Archived after the active page listed it, before the archived page.
    ArchiveWorktreeTransport.onList = (params) => { if (params.archived === true) coOwner.archived = true; };
    const { registry } = fixture.open({ ...ON, enabled: false });
    const scan = await maintenance(registry).scan({ steps: ["hibernate"] });
    expect(scan.hibernate?.items.some((item) => item.threadId === THREAD_ID)).toBe(false);
    expect(scan.hibernate?.kept["Shared with another thread"]).toBeGreaterThan(0);
  }));

  it("reads archived fleet membership once for a multi-wave reviewed hibernation batch", ownFixtureTest(async () => {
    const fixture = await createFixture();
    const { registry, store } = fixture.open({ ...ON, enabled: false });
    const targets = [{ ...identity, worktreePath: fixture.worktree }];
    for (let index = 1; index < 6; index++) {
      const worktreePath = path.join(fixture.root, ".pwragent", "worktrees", `id-${index}`, "repo");
      await mkdir(path.dirname(worktreePath), { recursive: true });
      await git(fixture.repo, ["worktree", "add", "-b", `owned-${index}`, worktreePath]);
      const threadId = `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
      targets.push({ backend: "codex", threadId, worktreePath });
      ArchiveWorktreeTransport.threads.push({ id: threadId, cwd: worktreePath, source: "cli", updatedAt: 2, status: { type: "notLoaded" } });
      await store.addLinkedDirectory({ backend: "codex", threadId,
        directory: { ...fixture.directory, id: threadId, worktreePath } });
    }
    // Unrelated owners share the primary repository, never a target checkout.
    ArchiveWorktreeTransport.threads.unshift(...Array.from({ length: 220 }, (_, index) => ({
      id: `unrelated-${index}`, cwd: fixture.repo, source: "cli", updatedAt: 1000 - index, status: { type: "notLoaded" as const },
    })));
    const service = maintenance(registry);
    const scan = await service.scan({ steps: ["hibernate"] });
    expect(scan.hibernate?.items).toHaveLength(targets.length);
    ArchiveWorktreeTransport.requests = [];
    const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false,
      hibernate: targets.map(({ backend, threadId }) => ({ backend, threadId })) });
    expect(run.steps.find((step) => step.step === "hibernate")).toMatchObject({ done: targets.length, kept: 0, failed: 0 });
    // Archived membership has no per-checkout delta to read. One complete
    // membership pass per batch is the boundary budget, not one per removal.
    const membershipReads = ArchiveWorktreeTransport.requests.filter((request) => request.method === "thread/list"
      && request.params.archived === true && !request.params.cursor);
    expect(membershipReads).toHaveLength(1);
    for (const target of targets) expect(await exists(target.worktreePath)).toBe(false);
  }));

  it("uses shared fleet admission and reports real snapshot-to-deletion stages", ownFixtureTest(async () => {
    const fixture = await createFixture();
    const { registry, store } = fixture.open({ ...ON, enabled: false });
    const candidate = (await registry.listAutoArchiveCandidates())[0]!;
    const fullDiscovery = vi.spyOn(registryModules(registry).threadArchiveCoordinator, "listAutoArchiveCandidates");
    const stages: string[] = [];
    expect(await registry.hibernateReviewedCheckout(candidate, { ...ON, enabled: true }, (stage) => stages.push(stage))).toBe(true);
    expect(fullDiscovery).not.toHaveBeenCalled();
    // Windows starts removal before unlinking ignored junctions, then
    // confirms that stage again at Git's process-tree-owned spawn boundary.
    // Both callbacks describe one transition into removal.
    const transitions = stages.filter((stage, index) => stage !== stages[index - 1]);
    expect(transitions).toEqual(["waitingForWorker", "waiting", "checking", "snapshotting", "checking", "verifying", "waiting", "removing", "recording"]);
    expect(await exists(fixture.worktree)).toBe(false);
    const snapshot = (await snapshotOf(store))!;
    expect(snapshot.state).toBe("hibernated");
    expect(await git(fixture.repo, ["show", `${snapshot.snapshotRef}:file.txt`])).toBe("original\n");
  }));

  it.each(["cli", "subAgentThreadSpawn"])("fresh hibernation admission sees a new %s owner while exploratory discovery is pending", ownFixtureTest(async (source) => {
    const fixture = await createFixture();
    const { registry } = fixture.open();
    const candidate = (await registry.listAutoArchiveCandidates())[0]!;
    const coordinator = registryModules(registry).threadArchiveCoordinator;
    const client = (registry as unknown as { codexClient: CodexAppServerClient }).codexClient;
    const listPage = client.listArchiveCleanupThreadsPage.bind(client);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    releases.push(release);
    vi.spyOn(client, "listArchiveCleanupThreadsPage").mockImplementationOnce(async (params) => {
      const oldPage = await listPage(params);
      entered();
      await held;
      return oldPage;
    });
    const exploratory = registry.listAutoArchiveCandidates();
    await reading;
    ArchiveWorktreeTransport.threads.push({ id: "new-owner", cwd: fixture.worktree, source,
      ...(source === "subAgentThreadSpawn" ? { parentThreadId: "parent-on-another-machine" } : {}),
      status: { type: "notLoaded" } });
    // If admission accidentally joins the exploratory API, return its old
    // membership immediately: the test must detect unsafe removal, not hang.
    const sharedRead = vi.spyOn(coordinator, "listAutoArchiveCandidates").mockResolvedValue([candidate]);
    try {
      const boundary = coordinator as unknown as { hibernateIdleCheckout(candidate: ThreadArchiveCandidate,
        policy: DesktopCheckoutHibernationPolicy): Promise<boolean | string> };
      expect(await boundary.hibernateIdleCheckout(candidate, ON)).toBe("Shared with another thread");
      expect(sharedRead).not.toHaveBeenCalled();
      expect(await exists(fixture.worktree)).toBe(true);
    } finally { release(); await exploratory; }
  }));

  it("keeps a checkout when fresh admission cannot read a possible owner's state", ownFixtureTest(async () => {
    const fixture = await createFixture();
    const { registry, store } = fixture.open();
    const candidate = (await registry.listAutoArchiveCandidates())[0]!;
    ArchiveWorktreeTransport.threads.push({ id: "unknown-owner", cwd: fixture.repo, source: "cli", status: { type: "notLoaded" } });
    vi.spyOn(store, "listArchiveActiveSubAgentThreadIds").mockRejectedValue(new Error("State unavailable"));
    const boundary = registryModules(registry).threadArchiveCoordinator as unknown as {
      hibernateIdleCheckout(candidate: ThreadArchiveCandidate, policy: DesktopCheckoutHibernationPolicy): Promise<boolean | string>;
    };
    expect(await boundary.hibernateIdleCheckout(candidate, ON)).toBe("Thread state unreadable");
    expect(await exists(fixture.worktree)).toBe(true);
  }));

  it.each(["merged", "closed"] as const)("uses the latest saved PR lifecycle for a locked thread's stale %s watch", ownFixtureTest(async (lifecycleState) => {
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
  }));

  it("rechecks managed-root ownership when a reviewed external checkout moves outside through a symlink", ownFixtureTest(async () => {
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
  }));

  it("registers an explicitly approved outside linked checkout without weakening snapshot or ownership checks (Git oracle)", ownFixtureTest(async () => {
    const fixture = await outsideRegistrationFixture();
    const { registry, store, approvals, call } = fixture;
    await writeFile(path.join(fixture.worktree, "file.txt"), "registered edit\n");
    await writeFile(path.join(fixture.worktree, "notes.txt"), "registered notes\n");
    await writeFile(path.join(fixture.worktree, ".env.local"), "invented ignored fixture\n");
    const service = maintenance(registry);
    expect((await service.scan({ steps: ["hibernate"], hibernateIdleDays: 2 })).hibernate?.items).toEqual([]);
    const approval = vi.spyOn(approvals, "requestThreadMaintenanceConfirmation").mockResolvedValue(true);
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
  }));

  it.each(["Cancel", "Register worktree"])("requires the exact operator answer in Full Access: %s", ownFixtureTest(async (answer) => {
    const { registry, store, worktree, call } = await outsideRegistrationFixture();
    await store.setThreadExecutionMode({ backend: "codex", threadId: "registration-agent", executionMode: "full-access" });
    const measured = await measureSqliteWrites(async () => {
      const card = waitForRegistrationCard(registry);
      const pending = call(worktree);
      // Observe an early producer failure while waiting for its notification;
      // registry shutdown also rejects an unanswered request after retirement.
      const notification = await Promise.race([card, pending.then(() => {
        throw new Error("Registration finished without its confirmation notification");
      })]);
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
  }));

  it.each(["main", "unattached", "unknown", "alias", "ended", "moved-during-review"])("refuses registration for %s", ownFixtureTest(async (scenario) => {
    const { registry, store, root, repo, worktree, call, approvals, live } = await outsideRegistrationFixture();
    const approval = vi.spyOn(approvals, "requestThreadMaintenanceConfirmation").mockImplementation(async () => {
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
  }));

  it("revokes a reviewed registration and keeps outside external owners protected", ownFixtureTest(async () => {
    const { registry, store, worktree, call, approvals } = await outsideRegistrationFixture();
    vi.spyOn(approvals, "requestThreadMaintenanceConfirmation").mockResolvedValue(true);
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
  }));

  // Each case owns its native fixture through afterEach; no generated case
  // leaves a registry, SQLite connection or Git tree alive for the next one.
  const archivedOwnerReceiptCases = [1, 2, 3].flatMap((ownerCount) =>
    Array.from({ length: 2 ** ownerCount }, (_, mask) => ({
      authorizations: Array.from({ length: ownerCount }, (_, index) => Boolean(mask & (1 << index))),
    })));
  it.each(archivedOwnerReceiptCases)("requires every archived external owner's receipt at hibernation admission: $authorizations (Git oracle)", ownFixtureTest(async ({ authorizations }) => {
    await ownFixtureWork((async () => {
      // Each exhaustive case owns its registry, database and Git checkout until
      // it settles. None may survive into the next provider inventory.
      expect({ registries: registries.length, databases: databases.length, roots: roots.length })
        .toEqual({ registries: 0, databases: 0, roots: 0 });
      try {
        const { registry, store, directory, worktree } = await outsideRegistrationFixture();
        // Registration's operator flow has its own coverage above. Admission
        // needs real receipts for this exact Git checkout, shared by its owners.
        const registration = { ...await inspectRegisterableWorktree(worktree), authorizedAt: 1,
          requestedBy: { backend: "codex" as const, threadId: "registration-agent" } };
        await store.setThreadWorktreeRegistration({ ...identity, worktreePath: worktree, registration });
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
          if (authorized) await store.setThreadWorktreeRegistration({ ...other, worktreePath: worktree, registration });
        }
        const allowed = authorizations.every(Boolean);
        const before = { workspaces: probeHook.calls, identities: probeHook.identities };
        const inspected = await measureSqliteWrites(() => service.scan({ steps: ["hibernate"], hibernateIdleDays: 2 }));
        expect(inspected.writes.commits).toBe(0);
        if (allowed) {
          // Git owns one checkout, however many conversations refer to it.
          // A read-only scan must not multiply its probes by owner count.
          expect({ workspaces: probeHook.calls - before.workspaces, identities: probeHook.identities - before.identities })
            .toEqual({ workspaces: 1, identities: 1 });
        }
        const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
          removeEmptyFolders: false, hibernate: [identity] });
        expect(run.steps.find((step) => step.step === "hibernate")).toMatchObject({ done: allowed ? 1 : 0, kept: allowed ? 0 : 1 });
        expect(await exists(worktree)).toBe(!allowed);
        expect(Boolean(await snapshotOf(store))).toBe(allowed);
        expect(inspected.result.hibernate?.items.some((item) => item.threadId === THREAD_ID)).toBe(allowed);
      } finally { await disposeFixtures(); }
    })());
  }));

  it("reads one Git identity for a checkout shared with one authorized archived owner (shrunk regression)", ownFixtureTest(async () => {
    const { registry, store, directory, worktree } = await outsideRegistrationFixture();
    const registration = { ...await inspectRegisterableWorktree(worktree), authorizedAt: 1,
      requestedBy: { backend: "codex" as const, threadId: "registration-agent" } };
    const other = { backend: "codex" as const, threadId: "archived-external" };
    ArchiveWorktreeTransport.threads.push({ ...ArchiveWorktreeTransport.threads[0]!, id: other.threadId, archived: true });
    await store.replaceWorkspaceLinkedDirectory({ ...other, directory: { ...directory, worktreeOwnership: "external" } });
    await store.setThreadArchiveTombstone({ ...other, archivedAt: 1 });
    for (const owner of [identity, other]) {
      await store.setThreadWorktreeRegistration({ ...owner, worktreePath: worktree, registration });
    }
    const before = probeHook.identities;
    const candidates = await registry.listAutoArchiveCandidates();
    expect(candidates.find((candidate) => candidate.thread.id === THREAD_ID)?.managedWorktreePath).toBe(worktree);
    expect(probeHook.identities - before).toBe(1);
  }));

  it("compares every owner's receipt with the current Git checkout, without retaining the observation (Git oracle property)", ownFixtureTest(async ({ signal }) => {
    const { registry, store, repo, worktree } = await outsideRegistrationFixture();
    const old = { ...await inspectRegisterableWorktree(worktree), authorizedAt: 1,
      requestedBy: { backend: "codex" as const, threadId: "registration-agent" } };
    await git(repo, ["worktree", "remove", worktree]);
    await git(repo, ["worktree", "add", worktree, "owned"]);
    const current = { ...old, ...await inspectRegisterableWorktree(worktree) };
    const owner = (await registry.listAutoArchiveCandidates()).find((candidate) => candidate.thread.id === THREAD_ID)!.thread;
    const admission = registryModules(registry).threadArchiveCoordinator as unknown as {
      isManagedArchiveCheckout: (inventory: { activeThreads: AppServerThreadSummary[]; archivedThreads: AppServerThreadSummary[] },
        worktreePath: string) => Promise<boolean>;
    };
    const inventory = async (valid: boolean[]) => {
      const archivedThreads = valid.map((_, index) => ({ ...owner, id: `receipt-owner-${index}`, archivedAt: 1 }));
      for (const [index, thread] of archivedThreads.entries()) {
        await store.setThreadWorktreeRegistration({ backend: "codex", threadId: thread.id, worktreePath: worktree,
          registration: valid[index] ? current : old });
      }
      return { activeThreads: [], archivedThreads };
    };
    const receiptSets = [1, 2, 3].flatMap(length =>
      Array.from({ length: 2 ** length }, (_, bits) =>
        Array.from({ length }, (_, index) => Boolean(bits & (1 << index)))));
    for (const valid of receiptSets) {
      signal.throwIfAborted();
      await ownFixtureWork((async () => {
        const owners = await inventory(valid);
        const before = probeHook.identities;
        expect(await admission.isManagedArchiveCheckout(owners, worktree)).toBe(valid.every(Boolean));
        expect(probeHook.identities - before).toBe(1);
      })());
    }
    const owners = await inventory([true, true]);
    expect(await admission.isManagedArchiveCheckout(owners, worktree)).toBe(true);
    await git(repo, ["worktree", "remove", worktree]);
    await git(repo, ["worktree", "add", worktree, "owned"]);
    // Even the same inventory object must get a new physical identity read.
    expect(await admission.isManagedArchiveCheckout(owners, worktree)).toBe(false);
  }));

  it.for(["hibernating-owner", "archived-owner"])("revoking the %s receipt cancels an in-flight hibernation before removal", ownFixtureTest(async (ownerKind, { signal }) => {
    const { registry, store, directory, worktree, call, approvals } = await outsideRegistrationFixture();
    vi.spyOn(approvals, "requestThreadMaintenanceConfirmation").mockResolvedValue(true);
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
    releases.push(resume);
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
    const run = ownFixtureWork(service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
      removeEmptyFolders: false, hibernate: [identity] }));
    await Promise.race([paused, run.then(() => { throw new Error("Hibernation settled before reaching the removal barrier"); })]);
    signal.throwIfAborted();
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
    const lifecycle = registryModules(registry).threadArchiveCoordinator;
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
  }));

  it("reads a durable receipt after restart but requires current-profile membership", ownFixtureTest(async () => {
    const fixture = await outsideRegistrationFixture();
    vi.spyOn(fixture.approvals, "requestThreadMaintenanceConfirmation").mockResolvedValue(true);
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
  }));

  it("models approval, rejection, observation and revocation without inferring ownership", ownFixtureTest(async ({ signal }) => {
    const fixture = await outsideRegistrationFixture();
    const { registry, store, worktree, call, approvals } = fixture;
    const approval = vi.spyOn(approvals, "requestThreadMaintenanceConfirmation");
    type Model = { authorized: boolean };
    type Real = typeof fixture;
    class RegistrationCommand implements fc.AsyncCommand<Model, Real> {
      constructor(readonly operation: "approve" | "cancel" | "revoke" | "observe") {}
      check = () => true;
      async run(model: Model, real: Real) {
        signal.throwIfAborted();
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
    const check = async (commands: Iterable<fc.AsyncCommand<Model, Real>>) => {
      signal.throwIfAborted();
      await store.setThreadWorktreeRegistration({ ...identity, worktreePath: worktree });
      await fc.asyncModelRun(() => ({ model: { authorized: false }, real: fixture }), commands);
    };
    await ownFixtureWork(check([
      new RegistrationCommand("approve"), new RegistrationCommand("cancel"), new RegistrationCommand("observe"),
      new RegistrationCommand("revoke"), new RegistrationCommand("observe"),
    ]));
    await ownFixtureWork(fc.assert(fc.asyncProperty(fc.commands([
      fc.constant(new RegistrationCommand("approve")), fc.constant(new RegistrationCommand("cancel")),
      fc.constant(new RegistrationCommand("revoke")), fc.constant(new RegistrationCommand("observe")),
    ], { maxCommands: 6 }), check), { numRuns: 4 }));
    expect((await call(worktree, "inspect")).ok).toBe(true);
  }));

  it.each(["recent", "active", "shared", "snapshot-limit", "replaced"])("retains %s protection after outside registration and review", ownFixtureTest(async (protection) => {
    const { registry, store, root, repo, worktree, call, approvals } = await outsideRegistrationFixture();
    vi.spyOn(approvals, "requestThreadMaintenanceConfirmation").mockResolvedValue(true);
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
  }));

  it.each(["sole", "active", "external-archived"])("archives a registered outside checkout subject to %s ownership (Git oracle)", ownFixtureTest(async (ownership) => {
    const { registry, store, repo, worktree, directory, call, approvals } = await outsideRegistrationFixture();
    vi.spyOn(approvals, "requestThreadMaintenanceConfirmation").mockResolvedValue(true);
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
  }));

  it.each([".pwragent", ".codex"] as const)("uses canonical PwrAgent root ownership for an attached external checkout: %s", ownFixtureTest(async (worktreeRoot) => {
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
  }));

  it("does not confuse a persisted archive with an archive operation still in flight", ownFixtureTest(async () => {
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
  }));

  it("discovers a provider-archived checkout, saves its work and leaves its conversation archived", ownFixtureTest(async () => {
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
  }));

  it("allows inspecting a reviewed thread through the final snapshot admission without restarting its idle clock", ownFixtureTest(async () => {
    const fixture = await createFixture();
    const { registry, store } = fixture.open();
    const candidate = (await registry.listAutoArchiveCandidates())[0]!;
    await store.markThreadSeen({ ...identity, seenUpdatedAt: candidate.thread.updatedAt });
    expect(await registry.hibernateReviewedCheckout(candidate, ON)).toBe(true);
    expect(await exists(fixture.worktree)).toBe(false);
    expect(await snapshotOf(store)).toMatchObject({ state: "hibernated", worktreePath: fixture.worktree });
  }));

  it("carries the protecting watch's PR into the kept checkout even before a PR chip was cached", ownFixtureTest(async () => {
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
  }));

  // Provider inventory is the oracle, independently of navigation's source
  // and companion-app filters. A hidden row can still hold real disk space.
  it("includes every provider checkout owner even when navigation hides it", ownFixtureTest(async () => {
    const fixture = await createFixture();
    const { registry } = fixture.open();
    const sources = ["cli", "vscode", "exec", "appServer"] as const;
    for (const inventory of [...sources.map(source => [source]), sources]) {
      ArchiveWorktreeTransport.threads = inventory.map((source, index) => ({
        id: `owner-${index}`, cwd: fixture.worktree, source, name: "PwrSnap Capture Metadata Worker", status: { type: "notLoaded" },
      }));
      const found = await registry.listAutoArchiveCandidates();
      expect(found.map((row) => row.thread.id).sort()).toEqual(ArchiveWorktreeTransport.threads.map((row) => row.id).sort());
    }
  }));

  // Git is the oracle for workspace kind. A provider's minimal cwd summary
  // must not turn a real linked checkout into a plain directory on recheck.
  it("revalidates provider cwd summaries against Git instead of losing their checkout", ownFixtureTest(async () => {
    const fixture = await createFixture();
    const { registry } = fixture.open();
    const listed = (await registry.listAutoArchiveCandidates())[0]!;
    const client = (registry as unknown as { codexClient: CodexAppServerClient }).codexClient;
    vi.spyOn(client, "readThreadSummary").mockResolvedValue({
      ...listed.thread,
      projectKey: fixture.worktree,
      linkedDirectories: [{ id: fixture.worktree, path: fixture.worktree, kind: "local", label: "repo" }],
    });
    for (const depth of [0, 1, 2, 3, 4]) {
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
    }
  }));

  it("observes Git metadata again on the next pass when a checkout path is replaced (oracle)", ownFixtureTest(async () => {
    const fixture = await createFixture();
    const { registry } = fixture.open();
    expect((await registry.listAutoArchiveCandidates())[0]!.thread.linkedDirectories)
      .toContainEqual(expect.objectContaining({ kind: "worktree", worktreePath: fixture.worktree }));
    await git(fixture.repo, ["worktree", "remove", fixture.worktree]);
    const replacement = path.join(fixture.root, "replacement");
    await mkdir(replacement);
    await git(replacement, ["init", "-b", "main"]);
    await git(replacement, ["commit", "--allow-empty", "-m", "replacement"]);
    await git(replacement, ["worktree", "add", "-b", "new-owner", fixture.worktree]);
    expect((await git(fixture.worktree, ["rev-parse", "--git-common-dir"])).trim().replace(/\\/g, "/"))
      .toBe(path.join(replacement, ".git").replace(/\\/g, "/"));
    const next = (await registry.listAutoArchiveCandidates())[0]!;
    expect(next.thread.linkedDirectories).toContainEqual(expect.objectContaining({ kind: "worktree", path: replacement, worktreePath: fixture.worktree }));
  }));

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

  it("hibernates a reviewed checkout in one commit while the hourly sweep is off", ownFixtureTest(async () => {
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
  }));

  it.each(["before scan", "after scan"])("hibernates with ignored files %s and restores only saved work", ownFixtureTest(async (when) => {
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
  }));

  // Oracle: the registry's own rules. Every thread with a checkout lands in
  // exactly one count, the dialog's idle days decide "not idle yet" for the
  // scan and its run, and a hibernated checkout is not eligible at all.
  it("scans and runs with the dialog's idle days, and counts each thread once", ownFixtureTest(async () => {
    const fixture = await createFixture();
    // Last active two days ago: Settings' 7 days keeps it, the dialog's 1 day does not.
    ArchiveWorktreeTransport.threads[0]!.updatedAt = Math.floor(Date.now() / 1000) - 2 * 86_400;
    const { registry } = fixture.open({ ...ON, enabled: false, idleDays: 7 });
    const service = maintenance(registry);

    const settings = await service.scan({ steps: ["hibernate"] });
    expect(settings.hibernate).toMatchObject({ idleDays: 7, checked: 1, notIdleYet: 1, kept: {}, items: [] });

    const reviewed = await service.scan({ steps: ["hibernate"], hibernateIdleDays: 1 });
    expect(reviewed.hibernate).toMatchObject({ idleDays: 1, checked: 1, notIdleYet: 0, kept: {} });
    expect(reviewed.hibernate?.items.map((item) => item.threadId)).toEqual([THREAD_ID]);
    const run = await service.apply({ scanId: reviewed.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
      removeEmptyFolders: false, hibernate: [identity] });
    expect(run.steps.find((step) => step.step === "hibernate")).toMatchObject({ ran: true, done: 1, kept: 0, failed: 0 });
    expect(await exists(fixture.worktree)).toBe(false);

    const after = await service.scan({ steps: ["hibernate"], hibernateIdleDays: 1 });
    expect(after.hibernate).toMatchObject({ checked: 0, notIdleYet: 0, kept: {}, items: [] });
    expect(after.hibernate).not.toHaveProperty("alreadyHibernated");
  }));

  it("keeps a reviewed checkout whose saved work grows past the snapshot limit", ownFixtureTest(async () => {
    const fixture = await createFixture();
    const { registry } = fixture.open({ ...ON, enabled: false });
    const service = maintenance(registry);
    const scan = await service.scan();
    await writeFile(path.join(fixture.worktree, "file.txt"), Buffer.alloc(6 * MB));
    const run = await service.apply({ scanId: scan.scanId, archive: [], removeCheckouts: [], trashCheckouts: [],
      removeEmptyFolders: false, hibernate: [identity] });
    expect(run.problems).toEqual([expect.objectContaining({ step: "hibernate", kind: "kept", reason: "Changes over the snapshot limit" })]);
    expect(await exists(fixture.worktree)).toBe(true);
  }));
});


// A hook timeout ends Vitest's wait. Use a gate to control the still-running
// setup while observing when teardown admits directory removal.
it.each([false, true])("seed teardown joins initialization before removing its root (setup rejects: %s)", async (rejectSetup) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  const refusal = new Error("controlled seed setup failure");
  const seeds = ownRepoSeeds(async (_repo, environment) => {
    if (environment) return;
    entered.resolve();
    await release.promise;
    order.push("seed settled");
    if (rejectSetup) throw refusal;
  }, async root => {
    order.push("root removed");
    await rm(root, { recursive: true, force: true });
  });
  const setup = seeds.initialize().catch((error: unknown) => error);
  await entered.promise;
  const closing = seeds.close();
  release.resolve();
  const outcome = await setup;
  await closing;
  expect(outcome).toBe(rejectSetup ? refusal : undefined);
  expect(order).toEqual(["seed settled", "root removed"]);
  expect(await exists(seeds.root)).toBe(false);
});

// A deadline is unnecessary: gate an admitted body, request the real fixture
// teardown, then observe native Git, its file, and its SQLite owner directly.
it("fixture owner joins the complete test before closing Git and SQLite roots", ownFixtureOracle(async () => {
  const fixture = await createFixture();
  const { registry, store } = fixture.open({ ...ON, enabled: false });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const close = vi.spyOn(registry, "close");
  let observations: PromiseSettledResult<unknown>[] = [];
  const run = ownFixtureTest(async () => {
    entered.resolve();
    await release.promise;
    observations = await Promise.allSettled([
      execute("git", ["-C", fixture.worktree, "rev-parse", "--verify", "HEAD"]),
      readFile(path.join(fixture.worktree, "file.txt"), "utf8"),
      store.getThreadOverlayState(identity),
    ]);
  })();
  await entered.promise;
  const retiring = cleanupFixtureTest();
  let premature = false;
  try {
    // One host boundary observes whether teardown has admitted registry.close;
    // it cannot stand in for completion of the separately gated test body.
    await new Promise<void>((resolve) => setImmediate(resolve));
    premature = close.mock.calls.length > 0;
    if (premature) await retiring;
  } finally {
    release.resolve();
    await run;
    await retiring;
    close.mockRestore();
  }
  expect({ premature, nativeReads: observations.map((item) => item.status) }).toEqual({
    premature: false, nativeReads: ["fulfilled", "fulfilled", "fulfilled"],
  });
  expect(await exists(fixture.root)).toBe(false);
}));

it("fixture owner rejects an aborted case before allocating its real Git roots", ownFixtureOracle(async () => {
  const controller = new AbortController();
  const reason = new Error("controlled aborted checkout case");
  controller.abort(reason);
  fixtureOwner = new FixtureOwner(controller.signal);
  const before = roots.length;
  let failure: unknown;
  try { await createFixture(); } catch (error) { failure = error; }
  expect({ rejectedWithOwnerReason: failure === reason, allocatedRoots: roots.length - before })
    .toEqual({ rejectedWithOwnerReason: true, allocatedRoots: 0 });
}));

it("fixture owner rejects database admission after retirement", ownFixtureOracle(async () => {
  const fixture = await createFixture();
  const fixtureRoots = [...roots];
  await cleanupFixtureTest();
  const opening = vi.spyOn(StateDb, "open");
  let failure: unknown;
  try {
    try { fixture.open(); } catch (error) { failure = error; }
    expect({ message: (failure as Error | undefined)?.message, databaseOpens: opening.mock.calls.length })
      .toEqual({ message: "Checkout fixture owner retired", databaseOpens: 0 });
  } finally {
    opening.mockRestore();
    await disposeFixtures();
    await Promise.all(fixtureRoots.map((root) => rm(root, { recursive: true, force: true })));
  }
}));

it("fixture owner rejects a Git mutation after abort", ownFixtureOracle(async () => {
  const fixture = await createFixture();
  const controller = new AbortController();
  const reason = new Error("controlled aborted Git admission");
  fixtureOwner = new FixtureOwner(controller.signal);
  controller.abort(reason);
  let failure: unknown;
  try { await git(fixture.repo, ["config", "--local", "fixture.admission", "unexpected"]); }
  catch (error) { failure = error; }
  // Git's persisted config is independent of the helper's admission logic.
  const value = await execute("git", ["-C", fixture.repo, "config", "--get", "fixture.admission"])
    .then((result) => result.stdout.trim(), (error: { code: number }) => {
      if (error.code !== 1) throw error;
      return "absent";
    });
  expect({ refused: failure === reason, value }).toEqual({ refused: true, value: "absent" });
}));


it.each(["abort", "retire"] as const)("notification waiter settles before owner join on %s", ownFixtureOracle(async (stop) => {
  const controller = new AbortController();
  fixtureOwner = new FixtureOwner(controller.signal);
  const fixture = await createFixture();
  const { registry } = fixture.open({ ...ON, enabled: false });
  const listen = registry.onEvent.bind(registry);
  let listener: Parameters<DesktopBackendRegistry["onEvent"]>[0] | undefined;
  const unsubscribe = vi.fn<() => void>();
  const subscription = vi.spyOn(registry, "onEvent").mockImplementation((callback) => {
    listener = callback;
    unsubscribe.mockImplementation(listen(callback));
    return unsubscribe;
  });
  const entered = Promise.withResolvers<void>();
  let settled = false;
  let continued = false;
  let failure: unknown;
  const run = ownFixtureTest(async () => {
    const card = waitForRegistrationCard(registry);
    entered.resolve();
    await card;
    continued = true;
  })();
  const observed = run.then(() => { settled = true; }, (error) => { settled = true; failure = error; });
  await entered.promise;
  const reason = new Error("controlled pending notification abort");
  let retiring: Promise<void> | undefined;
  let beforeRescue: { settled: boolean; unsubscribed: number; canceled: boolean } | undefined;
  try {
    if (stop === "abort") controller.abort(reason);
    else retiring = cleanupFixtureTest();
    await new Promise<void>((resolve) => setImmediate(resolve));
    beforeRescue = {
      settled, unsubscribed: unsubscribe.mock.calls.length,
      canceled: stop === "abort" ? failure === reason
        : (failure as Error | undefined)?.message === "Checkout notification wait retired",
    };
  } finally {
    // The retained callback represents a notification already in flight. It
    // rescues the broken pre-fix join, so the regression never needs a timeout;
    // after cancellation it must not resume the fixture body.
    await listener?.({ backend: "codex", notification: {
      method: "item/tool/requestUserInput",
      params: { threadId: "registration-agent", requestId: "controlled-card", questions: [] },
    } });
    await observed;
    await (retiring ?? cleanupFixtureTest());
    subscription.mockRestore();
  }
  expect({ ...beforeRescue, continued }).toEqual({ settled: true, unsubscribed: 1, canceled: true, continued: false });
  expect(await exists(fixture.root)).toBe(false);
  expect({ registries: registries.length, databases: databases.length, roots: roots.length })
    .toEqual({ registries: 0, databases: 0, roots: 0 });
}));
