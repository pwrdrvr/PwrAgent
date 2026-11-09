import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { WorktreeContainerService } from "../app-server/worktree-container-service";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb } from "./sqlite-test-utils";
import { runOneTimeArchivedWorktreeRepair } from "../state/archived-worktree-repair";
import { ArchiveCleanupCheckpointStore } from "../state/archive-cleanup-checkpoint";
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { AcpAgentStore } from "../storage/acp-agent-store";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { WorktreeArchiveService } from "../app-server/worktree-archive-service";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import type { AcpTransportFactory } from "../app-server/acp-backend-adapter";
import type { AppServerThreadSummary, PwrAgentThreadOrchestrationRequest, PwrAgentThreadOrchestrationResponse } from "@pwragent/shared";
import type { ArchiveCleanupContext } from "../app-server/archive-cleanup-queue";
import type { MaintenanceDiscoveryProgress } from "../app-server/unreferenced-worktrees";
import { AcpSessionStore } from "../storage/acp-session-store";
import { ArchiveWorktreeTransport, type ArchiveWorktreeThread } from "./fixtures/archive-worktree-transport";

vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../codex-app-server/stdio-transport", async () => ({
  StdioJsonRpcTransport: (await import("./fixtures/archive-worktree-transport")).ArchiveWorktreeTransport,
}));

const execute = promisify(execFile);
const registries: DesktopBackendRegistry[] = [];
const databases: StateDb[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  ArchiveWorktreeTransport.threads = [];
  ArchiveWorktreeTransport.requests = [];
  ArchiveWorktreeTransport.onList = undefined;
  ArchiveWorktreeTransport.rejectSafetySources = false;
  ArchiveWorktreeTransport.emitArchiveNotifications = false;
  ArchiveWorktreeTransport.onReviewStart = undefined;
});

async function createFixture(managed: boolean | "claude" = false) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-archive-restart-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  const codexHome = path.join(root, "selected-codex");
  const worktree = managed === "claude" ? path.join(root, ".pwragent", "worktrees", "id", "repo")
    : managed ? path.join(codexHome, "worktrees", "id", "repo") : path.join(root, "worktree");
  if (managed === true) {
    vi.stubEnv("CODEX_HOME", codexHome);
    await mkdir(path.dirname(worktree), { recursive: true });
  }
  await mkdir(repo);
  const git = async (cwd: string, args: string[]) => (await execute("git", ["-C", cwd, ...args])).stdout;
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "core.autocrlf", "false"]);
  await git(repo, ["config", "core.eol", "lf"]);
  await writeFile(path.join(repo, "file.txt"), "original\n");
  await git(repo, ["add", "file.txt"]);
  await git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
  await git(repo, ["worktree", "add", "-b", "owned", worktree]);
  const directory = { id: "owned", kind: "worktree" as const, label: "repo", path: repo, worktreePath: worktree };
  const { dbPath, tempDir } = createTempStateDb("pwragent-archive-restart-db-");
  roots.push(tempDir);
  const claudeStore = new ClaudeSessionStore(path.join(root, "claude"));
  const reopen = (workspace = directory, checkpoint = false, createAcpTransport?: AcpTransportFactory,
    extraWorkspaces: Array<typeof directory> = []) => {
    const db = StateDb.open(dbPath);
    databases.push(db);
    const store = new SqliteOverlayStore(db);
    const client = new CodexAppServerClient({ directoryResolver: async (cwd) =>
      [workspace, ...extraWorkspaces].filter((row) => row.worktreePath === cwd) });
    const acpAgentStore = new AcpAgentStore(db);
    const acpSessionStore = new AcpSessionStore(db);
    const registry = new DesktopBackendRegistry({ codexClient: client, overlayStore: store, messagingStore: null, threadTitleGenerationService: null,
      runtimeInstanceId: `restart-${registries.length}`, resolveLiveProfileRuntimeInstanceIds: () => [],
      archiveCleanupCheckpointStore: checkpoint ? new ArchiveCleanupCheckpointStore(db.raw, { processAlive: () => false }) : null,
      claudeBackendOptions: { store: claudeStore },
      acpAgentStore, acpSessionStore, createAcpTransport, discoverLocalAcpAgents: async () => [],
      acpWorktreeRepositoryResolver: async (cwd) => cwd === worktree ? directory : undefined,
      managedWorktreeRoots: async () => [path.join(root, ".pwragent", "worktrees")] });
    registries.push(registry);
    return { db, store, client, registry, acpAgentStore, acpSessionStore };
  };
  return { root, claudeStore, repo, worktree, directory, git, reopen, codexHome, container: path.dirname(worktree) };
}

async function createSharedArchiveFixture(otherBackend: "claude" | "codex", archived: boolean) {
  const fixture = await createFixture("claude");
  const owners = [{ backend: "claude" as const, threadId: "11111111-1111-4111-8111-111111111111" },
    { backend: otherBackend, threadId: otherBackend === "codex"
      ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222" }];
  for (const owner of owners) {
    if (owner.backend === "claude") await fixture.claudeStore.save({ cwd: fixture.worktree, thread: {
      id: owner.threadId, source: "claude", title: "Shared archive fixture", titleSource: "explicit",
      linkedDirectories: [fixture.directory], archivedAt: archived ? 1 : undefined,
    } });
    else ArchiveWorktreeTransport.threads = [{ id: owner.threadId, source: "cli", cwd: fixture.worktree, archived }];
  }
  await writeFile(path.join(fixture.worktree, "file.txt"), "shared dirty edit\n");
  await writeFile(path.join(fixture.worktree, "notes.txt"), "shared untracked file\n");
  return { ...fixture, owners };
}

const acpOwner = { backend: "acp:fixture" as const, threadId: "stable-thread-id" };

function seedAcpOwner(instance: ReturnType<Awaited<ReturnType<typeof createFixture>>["reopen"]>, cwd: string, archived = false) {
  instance.acpAgentStore.upsertInstalledAgent({ backendId: acpOwner.backend, registryId: "fixture", name: "Fixture ACP",
    distributionKind: "local", distributionSource: "fixture", installStatus: "installed", authStatus: "not-required",
    verificationStatus: "not-applicable", allowlistRuleId: "fixture", installedAt: 1, updatedAt: 1,
    launchDescriptor: { backendId: acpOwner.backend, registryId: "fixture", distributionKind: "local", command: process.execPath, args: [], env: {}, cwd },
    runtimeCapabilities: { schemaVersion: 1, status: "discovered", checkedAt: 1, agentCapabilities: { loadSession: true } } });
  instance.acpSessionStore.upsertSession({ backendId: acpOwner.backend, sessionId: acpOwner.threadId,
    agentSessionId: "immutable-provider-id", cwd, title: "Archive ACP fixture", titleSource: "explicit",
    createdAt: 1, updatedAt: 1, executionMode: "default", status: "idle", hasConversationHistory: true,
    ...(archived ? { archivedAt: 1 } : {}) });
}

class ArchiveAcpTransport extends FakeAcpAgentTransport {
  onLoad?: (params: Record<string, unknown>) => Promise<void>;
  onClose?: () => Promise<void>;
  constructor(close = true) {
    super({ initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true,
      ...(close ? { sessionCapabilities: { close: {} } } : {}) } } });
  }
  override async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const result = await super.request(method, params);
    if (method === "session/load") await this.onLoad?.(params!);
    if (method === "session/close") await this.onClose?.();
    return result;
  }
}

describe("current-profile worktree registration across providers", () => {
  it.each(["claude", "acp:fixture"] as const)("registers an archived %s owner's outside checkout without changing its external marker", async (backend) => {
    const fixture = await createFixture();
    const instance = fixture.reopen();
    const owner = { backend, threadId: backend === "claude" ? "11111111-1111-4111-8111-111111111111" : acpOwner.threadId };
    if (backend === "claude") {
      await fixture.claudeStore.save({ cwd: fixture.worktree, thread: {
        id: owner.threadId, source: "claude", title: "Registration fixture", titleSource: "explicit",
        linkedDirectories: [fixture.directory], updatedAt: 1, archivedAt: 1,
      } });
    } else seedAcpOwner(instance, fixture.worktree, true);
    await instance.store.replaceWorkspaceLinkedDirectory({ ...owner,
      directory: { ...fixture.directory, worktreeOwnership: "external" } });
    const internal = instance.registry as unknown as {
      isLiveDynamicToolCall: () => boolean;
      requestThreadMaintenanceConfirmation: () => Promise<boolean>;
      handleThreadOrchestrationRequest: (request: PwrAgentThreadOrchestrationRequest) => Promise<PwrAgentThreadOrchestrationResponse>;
    };
    vi.spyOn(internal, "isLiveDynamicToolCall").mockReturnValue(true);
    vi.spyOn(internal, "requestThreadMaintenanceConfirmation").mockResolvedValue(true);
    expect(await internal.handleThreadOrchestrationRequest({ operation: "register_thread_worktree",
      context: { backend: "codex", threadId: "operator-agent", turnId: "registration" },
      args: { ...owner, worktreePath: fixture.worktree },
    })).toMatchObject({ ok: true, data: { ...owner, registered: true } });
    const candidate = (await instance.registry.listAutoArchiveCandidates()).find((item) => item.thread.source === backend && item.thread.id === owner.threadId);
    expect(candidate?.managedWorktreePath).toBe(fixture.worktree);
    expect((await instance.registry.auditArchivedCheckouts()).candidates).toContainEqual({ ...owner, worktreePath: fixture.worktree });
    expect((await instance.store.getThreadOverlayState(owner))?.extraLinkedDirectories[0]?.worktreeOwnership).toBe("external");
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("original\n");
  });
});

describe("ACP snapshot archive and restoration", () => {
  it("preserves archive metadata when an earlier replay read resumes between cleanup inventories", async () => {
    const fixture = await createFixture("claude");
    const transport = new ArchiveAcpTransport();
    let releaseInitialize!: () => void;
    let initializeStarted!: () => void;
    const initializeBarrier = new Promise<void>((resolve) => { releaseInitialize = resolve; });
    const initializing = new Promise<void>((resolve) => { initializeStarted = resolve; });
    const request = transport.request.bind(transport);
    vi.spyOn(transport, "request").mockImplementation(async (method, params) => {
      if (method === "initialize") {
        initializeStarted();
        await initializeBarrier;
      }
      return await request(method, params);
    });
    const instance = fixture.reopen(fixture.directory, false, () => transport);
    seedAcpOwner(instance, fixture.worktree);
    // Replay-backed E2E uses the aggregate inventory instead of the paged
    // Codex cleanup API. Hold initialization until its active pass completes.
    Object.defineProperty(instance.client, "listArchiveCleanupThreadsPage", { value: undefined });
    const read = instance.registry.readThread(acpOwner);
    await initializing;
    const listThreads = instance.registry.listThreads.bind(instance.registry);
    let resumedRead = false;
    vi.spyOn(instance.registry, "listThreads").mockImplementation(async (params) => {
      const threads = await listThreads(params);
      if (!resumedRead && params?.callerReason === "archive-cleanup" && params.archived === false) {
        resumedRead = true;
        expect(instance.acpSessionStore.getSession(acpOwner.backend, acpOwner.threadId)?.archivedAt).toBeDefined();
        releaseInitialize();
        await read;
      }
      return threads;
    });
    try {
      const result = await instance.registry.archiveThread(acpOwner);
      expect(resumedRead).toBe(true);
      expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true })]);
      expect(instance.acpSessionStore.getSession(acpOwner.backend, acpOwner.threadId)?.archivedAt).toBeDefined();
      await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseInitialize();
      await read;
    }
  });

  it.each([false, true])("restores dirty files, unpublished commits and original protocol identity across restart (repair=%s)", async (repair) => {
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    const fixture = await createFixture("claude");
    const first = fixture.reopen();
    seedAcpOwner(first, fixture.worktree, repair);
    const local = path.join(fixture.root, "other-repository");
    await mkdir(local);
    await writeFile(path.join(local, "keep.txt"), "keep local repository\n");
    await first.store.addLinkedDirectory({ ...acpOwner, directory: { id: local, kind: "local", label: "local", path: local } });
    await writeFile(path.join(fixture.worktree, "unpublished.txt"), "unpublished commit\n");
    await fixture.git(fixture.worktree, ["add", "."]);
    await fixture.git(fixture.worktree, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "unpublished"]);
    const head = (await fixture.git(fixture.worktree, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(fixture.worktree, "file.txt"), "dirty tracked edit\n");
    await writeFile(path.join(fixture.worktree, "notes.txt"), "untracked notes\n");
    await writeFile(path.join(fixture.worktree, ".gitignore"), "target/\n");
    await mkdir(path.join(fixture.worktree, "target"));
    await writeFile(path.join(fixture.worktree, "target", "ignored"), "build output");
    const { writes: archiveWrites } = await measureSqliteWrites(async () => {
      const result = repair ? await first.registry.repairArchivedThreadWorktrees() : await first.registry.archiveThread(acpOwner);
      expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true })]);
    });
    expectSqliteWriteBudget({ scenario: repair ? "acp-worktree-repair" : "acp-worktree-archive",
      note: "One ACP checkout snapshotted and removed at an archive boundary; no idle or timer writes.", writes: archiveWrites });
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    await first.registry.close();
    first.db.close();
    databases.splice(databases.indexOf(first.db), 1);
    const transport = new ArchiveAcpTransport();
    const second = fixture.reopen(fixture.directory, false, () => transport);
    transport.onLoad = async (params) => {
      expect(params).toMatchObject({ cwd: fixture.worktree, sessionId: "immutable-provider-id" });
      expect(second.acpSessionStore.getSession(acpOwner.backend, acpOwner.threadId)?.archivedAt).toBeDefined();
      expect((await fixture.git(fixture.worktree, ["rev-parse", "HEAD"])).trim()).toBe(head);
      expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("dirty tracked edit\n");
      expect(await readFile(path.join(fixture.worktree, "notes.txt"), "utf8")).toBe("untracked notes\n");
    };
    const { writes } = await measureSqliteWrites(async () => {
      expect(await second.registry.restoreThread(acpOwner)).toMatchObject({ worktrees: [expect.objectContaining({ restored: true })] });
    });
    expectSqliteWriteBudget({ scenario: "acp-worktree-restore", note: "Recreate one saved ACP checkout and load the original provider session before unarchiving; boundary writes only.", writes });
    expect(transport.requests.filter((request) => request.method === "session/load")).toHaveLength(1);
    expect(transport.requests.some((request) => request.method === "session/new")).toBe(false);
    expect(second.acpSessionStore.getSession(acpOwner.backend, acpOwner.threadId)).toMatchObject({ agentSessionId: "immutable-provider-id", cwd: fixture.worktree });
    expect(second.acpSessionStore.getSession(acpOwner.backend, acpOwner.threadId)?.archivedAt).toBeUndefined();
    expect((await fixture.git(fixture.worktree, ["branch", "--show-current"])).trim()).toBe("owned");
    expect(await fixture.git(fixture.worktree, ["status", "--short"])).toContain(" M file.txt");
    expect(await fixture.git(fixture.worktree, ["status", "--short"])).toContain("?? notes.txt");
    await expect(stat(path.join(fixture.worktree, "target"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(local, "keep.txt"), "utf8")).toBe("keep local repository\n");
  });

  it("resumes queued ACP cleanup after restart without re-archiving the session", async () => {
    const fixture = await createFixture("claude");
    const first = fixture.reopen(fixture.directory, true);
    seedAcpOwner(first, fixture.worktree);
    await writeFile(path.join(fixture.worktree, "file.txt"), "queued ACP edit\n");
    expect(await first.registry.archiveThread({ ...acpOwner, backgroundCleanup: true })).toMatchObject({ cleanupPending: true });
    const archivedAt = first.acpSessionStore.getSession(acpOwner.backend, acpOwner.threadId)?.archivedAt;
    await first.registry.close();
    first.db.close();
    databases.splice(databases.indexOf(first.db), 1);
    const second = fixture.reopen(fixture.directory, true, () => new ArchiveAcpTransport());
    await second.registry.resumeArchiveCleanupsAtStartup();
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(second.acpSessionStore.getSession(acpOwner.backend, acpOwner.threadId)?.archivedAt).toBe(archivedAt);
    await second.registry.restoreThread(acpOwner);
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("queued ACP edit\n");
  });

  it("rejects a replacement checkout after the provider failed to load the restored session", async () => {
    const fixture = await createFixture("claude");
    const instance = fixture.reopen(fixture.directory, false, () => {
      const transport = new ArchiveAcpTransport();
      transport.onLoad = async () => { throw new Error("Saved session unavailable"); };
      return transport;
    });
    seedAcpOwner(instance, fixture.worktree);
    await instance.registry.archiveThread(acpOwner);
    await expect(instance.registry.restoreThread(acpOwner)).rejects.toThrow("thread remains archived");
    await fixture.git(fixture.repo, ["worktree", "move", fixture.worktree, path.join(fixture.root, "moved-checkout")]);
    await fixture.git(fixture.repo, ["worktree", "add", "--detach", fixture.worktree, "HEAD"]);
    await writeFile(path.join(fixture.worktree, "keep.txt"), "replacement checkout");
    await expect(instance.registry.restoreThread(acpOwner)).rejects.toThrow("restored ACP checkout was replaced");
    expect(instance.acpSessionStore.getSession(acpOwner.backend, acpOwner.threadId)?.archivedAt).toBeDefined();
    expect(await readFile(path.join(fixture.worktree, "keep.txt"), "utf8")).toBe("replacement checkout");
  });

  it.each(["close", "dispose", "other live session", "close failure"])("releases a loaded session safely before removal (%s)", async (scenario) => {
    const fixture = await createFixture("claude");
    const transport = new ArchiveAcpTransport(scenario === "close" || scenario === "close failure");
    const instance = fixture.reopen(fixture.directory, false, () => transport);
    seedAcpOwner(instance, fixture.worktree);
    if (scenario === "other live session" || scenario === "close") {
      instance.acpSessionStore.upsertSession({ ...instance.acpSessionStore.getSession(acpOwner.backend, acpOwner.threadId)!,
        sessionId: "other-session", agentSessionId: "other-provider-id", cwd: fixture.repo });
      await instance.registry.readThread({ backend: acpOwner.backend, threadId: "other-session" });
    }
    await instance.registry.readThread(acpOwner);
    expect(transport.requests.some((request) => request.method === "session/load" && request.params?.sessionId === "immutable-provider-id")).toBe(true);
    transport.onClose = async () => {
      expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
      if (scenario === "close failure") throw new Error("Provider close failed");
    };
    const completed = new Promise<Record<string, unknown>>((resolve) => instance.registry.onEvent((event) => {
      if (event.notification.method === "thread/archiveCleanup/completed") resolve(event.notification.params);
    }));
    expect(await instance.registry.archiveThread({ ...acpOwner, backgroundCleanup: true })).toMatchObject({ cleanupPending: true });
    const result = await completed;
    const kept = scenario === "other live session" || scenario === "close failure";
    expect(result).toMatchObject({ cleanup: [expect.objectContaining({ removedWorktree: !kept,
      ...(kept ? { error: expect.stringContaining(scenario === "close failure" ? "Provider close failed" : "another live session") } : {}) })] });
    expect(transport.closeCount).toBe(scenario === "dispose" ? 1 : 0);
    if (kept) expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
    else await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    if (scenario === "close") {
      expect(transport.requests.filter((request) => request.method === "session/close")).toEqual([
        expect.objectContaining({ params: { sessionId: "immutable-provider-id" } }),
      ]);
      expect(instance.acpSessionStore.getSession(acpOwner.backend, "other-session")?.archivedAt).toBeUndefined();
    }
    const loadCount = transport.requests.filter((request) => request.method === "session/load").length;
    await instance.registry.readThread(acpOwner);
    expect(transport.requests.filter((request) => request.method === "session/load")).toHaveLength(loadCount);
  });

  it.each(["primary", "external", "active owner", "unknown capability", "no load", "rebind"])("retains protected ACP checkouts (%s)", async (scenario) => {
    const fixture = await createFixture(scenario === "external" ? false : "claude");
    const instance = fixture.reopen();
    const cwd = scenario === "primary" ? fixture.repo : fixture.worktree;
    seedAcpOwner(instance, cwd);
    if (scenario === "external") await instance.store.addLinkedDirectory({ ...acpOwner,
      directory: { ...fixture.directory, worktreeOwnership: "external" } });
    if (scenario === "active owner") ArchiveWorktreeTransport.threads = [{ id: "active-owner", cwd: fixture.worktree, source: "cli", archived: false }];
    if (scenario === "unknown capability" || scenario === "no load") {
      const agent = instance.acpAgentStore.getInstalledAgent(acpOwner.backend)!;
      instance.acpAgentStore.upsertInstalledAgent({ ...agent, runtimeCapabilities: { ...agent.runtimeCapabilities!,
        agentCapabilities: scenario === "no load" ? { loadSession: false } : {} } });
    }
    if (scenario === "rebind") instance.acpSessionStore.upsertSession({ ...instance.acpSessionStore.getSession(acpOwner.backend, acpOwner.threadId)!, requiresAgentSessionRebind: true });
    const result = await instance.registry.archiveThread(acpOwner);
    expect(result.cleanup.every((item) => !item.removedWorktree)).toBe(true);
    expect((await stat(cwd)).isDirectory()).toBe(true);
    expect((await instance.store.getThreadOverlayState(acpOwner))?.worktreeSnapshots ?? []).toHaveLength(0);
  });

  it("snapshots and restores an attached ACP checkout inside the managed root despite its external marker", async () => {
    const fixture = await createFixture("claude");
    const instance = fixture.reopen(fixture.directory, false, () => new ArchiveAcpTransport());
    seedAcpOwner(instance, fixture.worktree);
    await instance.store.addLinkedDirectory({ ...acpOwner, directory: { ...fixture.directory, worktreeOwnership: "external" } });
    await writeFile(path.join(fixture.worktree, "file.txt"), "saved managed checkout work\n");
    const result = await instance.registry.archiveThread(acpOwner);
    expect(result.cleanup.some((item) => item.removedWorktree)).toBe(true);
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(instance.acpSessionStore.getSession(acpOwner.backend, acpOwner.threadId)?.archivedAt).toBeDefined();
    await instance.registry.restoreThread(acpOwner);
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("saved managed checkout work\n");
  });

  it.each(["checkout", "load", "unsupported", "unadvertised", "partial"])("keeps the session archived and recovery available on %s failure", async (failure) => {
    const fixture = await createFixture("claude");
    const transports: ArchiveAcpTransport[] = [];
    let rejectLoad = failure === "load";
    const first = fixture.reopen(fixture.directory, false, () => {
      const transport = new ArchiveAcpTransport();
      transport.onLoad = async () => { if (rejectLoad) throw new Error("Provider rejected saved session"); };
      if (failure === "unsupported" || failure === "unadvertised") transport.request = async (method) => method === "initialize"
        ? { protocolVersion: 1, agentCapabilities: failure === "unsupported" ? { loadSession: false } : {} } : {};
      transports.push(transport);
      return transport;
    });
    seedAcpOwner(first, fixture.worktree);
    await first.registry.archiveThread(acpOwner);
    const spy = failure === "checkout" ? vi.spyOn(WorktreeArchiveService.prototype, "restore").mockRejectedValueOnce(new Error("Snapshot unavailable")) : undefined;
    if (failure === "partial") {
      await mkdir(fixture.worktree);
      await writeFile(path.join(fixture.worktree, "keep.txt"), "partial checkout");
    }
    try { await expect(first.registry.restoreThread(acpOwner)).rejects.toThrow("thread remains archived"); }
    finally { spy?.mockRestore(); }
    expect(first.acpSessionStore.getSession(acpOwner.backend, acpOwner.threadId)?.archivedAt).toBeDefined();
    expect((await first.store.getThreadOverlayState(acpOwner))?.worktreeSnapshots).toHaveLength(1);
    expect(transports.some((transport) => transport.requests.some((request) => request.method === "session/new"))).toBe(false);
    if (failure === "partial") expect(await readFile(path.join(fixture.worktree, "keep.txt"), "utf8")).toBe("partial checkout");
    if (failure === "load") {
      // A failed load leaves a validated checkout. A retry uses it without
      // overwriting edits made since the first restoration attempt.
      await writeFile(path.join(fixture.worktree, "after.txt"), "keep later edit");
      rejectLoad = false;
      await first.registry.restoreThread(acpOwner);
      expect(await readFile(path.join(fixture.worktree, "after.txt"), "utf8")).toBe("keep later edit");
    }
  });

  it.each([
    ["claude", false], ["claude", true], ["codex", false], ["codex", true], ["acp:fixture", false], ["acp:fixture", true],
  ] as const)("preserves snapshots for both shared owners (%s, ACP first=%s)", async (otherBackend, acpFirst) => {
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    const fixture = await createFixture("claude");
    const transport = new ArchiveAcpTransport();
    const first = fixture.reopen(fixture.directory, false, () => transport);
    seedAcpOwner(first, fixture.worktree);
    const other = { backend: otherBackend, threadId: "22222222-2222-4222-8222-222222222222" };
    if (otherBackend === "claude") await fixture.claudeStore.save({ cwd: fixture.worktree, thread: { id: other.threadId,
      source: "claude", title: "Shared owner", titleSource: "explicit", linkedDirectories: [fixture.directory] } });
    else if (otherBackend === "codex") ArchiveWorktreeTransport.threads = [{ id: other.threadId, cwd: fixture.worktree, source: "cli", archived: false }];
    else first.acpSessionStore.upsertSession({ ...first.acpSessionStore.getSession(acpOwner.backend, acpOwner.threadId)!,
      sessionId: other.threadId, agentSessionId: "other-provider-id" });
    await writeFile(path.join(fixture.worktree, "file.txt"), "shared dirty edit\n");
    const { writes: archiveWrites } = await measureSqliteWrites(async () => {
      expect((await first.registry.archiveThread(acpOwner)).cleanup).toEqual([expect.objectContaining({ removedWorktree: false })]);
      const cleanup = (await first.registry.archiveThread(other)).cleanup;
      expect(cleanup).toEqual([expect.objectContaining({ worktreePath: fixture.worktree })]);
      // Releasing the final reference can let the first owner's queued retry
      // remove the checkout before this owner's cleanup reaches it.
      if (!cleanup[0]!.removedWorktree) expect(cleanup[0]!.skippedReason).toBe("Worktree directory no longer exists.");
      await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    });
    if (otherBackend === "acp:fixture" && acpFirst) expectSqliteWriteBudget({ scenario: "acp-shared-worktree-archive",
      note: "Archive two ACP owners, retain the active checkout until both archive, then save both recovery snapshots; boundary writes only.", writes: archiveWrites });
    for (const owner of [acpOwner, other]) expect((await first.store.getThreadOverlayState(owner))?.worktreeSnapshots).toHaveLength(1);
    await first.registry.close();
    first.db.close();
    databases.splice(databases.indexOf(first.db), 1);
    const second = fixture.reopen(fixture.directory, false, () => new ArchiveAcpTransport());
    const owners = acpFirst ? [acpOwner, other] : [other, acpOwner];
    const { writes } = await measureSqliteWrites(async () => {
      await second.registry.restoreThread(owners[0]!);
      await writeFile(path.join(fixture.worktree, "later.txt"), "later shared edit");
      await second.registry.restoreThread(owners[1]!);
    });
    if (otherBackend === "acp:fixture" && acpFirst) expectSqliteWriteBudget({ scenario: "acp-shared-worktree-restore",
      note: "Restore two ACP owners through protocol session/load, recreating a shared checkout once and preserving later edits; boundary writes only.", writes });
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("shared dirty edit\n");
    expect(await readFile(path.join(fixture.worktree, "later.txt"), "utf8")).toBe("later shared edit");
  });
});

describe("checkouts no thread refers to", () => {
  it.each([
    { selections: [[0], [0]] },
    { selections: [[0], [0], [0]] },
    { selections: [[0, 1], [1, 0]] },
  ])("refuses every unattributed removal across overlapping requests: $selections", async ({ selections }) => {
    const fixture = await createFixture("claude");
    const checkouts = Array.from({ length: Math.max(...selections.flat()) + 1 }, (_, index) =>
      path.join(fixture.root, ".pwragent", "worktrees", `spare-${index}`, "repo"));
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const [index, checkout] of checkouts.entries()) {
      await fixture.git(fixture.repo, ["worktree", "add", "-b", `spare-${index}`, checkout]);
      await writeFile(path.join(checkout, "notes.txt"), `checkout ${index}\n`);
      await utimes(path.join(checkout, ".git"), twoHoursAgo, twoHoursAgo);
    }
    const { registry } = fixture.reopen();
    const result = await Promise.all(selections.map(async (selection) =>
      await registry.removeUnreferencedCheckouts(selection.map((index) => checkouts[index]!))));
    expect(result.flatMap((row) => row.failed)).toEqual([]);
    expect(result.flatMap((row) => row.removed)).toEqual([]);
    expect(result.flatMap((row) => row.kept)).toHaveLength(selections.flat().length);
    expect(result.flatMap((row) => row.kept).every((row) => row.reason === "No identified thread owns this checkout")).toBe(true);
    // A refusal needs no provider inventory or snapshot mutation.
    expect(ArchiveWorktreeTransport.requests.filter((request) => request.method === "thread/list")).toHaveLength(0);
    const registrations = await fixture.git(fixture.repo, ["worktree", "list", "--porcelain"]);
    expect((await fixture.git(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/pwragent/snapshots/"])).trim()).toBe("");
    for (const [index, checkout] of checkouts.entries()) {
      expect(registrations).toContain(checkout.replaceAll("\\", "/"));
      expect(await readFile(path.join(checkout, "notes.txt"), "utf8")).toBe(`checkout ${index}\n`);
    }
  });

  // Ownership is independent of physical location: a profile not queried
  // could own any registered checkout. Git verifies that it stays intact.
  it("identifies every known provider owner of a kept checkout without inferring owners for unknown paths", async () => {
    const fixture = await createSharedArchiveFixture("codex", false);
    ArchiveWorktreeTransport.threads[0]!.name = "Investigate widget layout";
    const { registry } = fixture.reopen();
    const audit = await registry.auditArchivedCheckouts();
    const owners = audit.inventory?.owners?.find((row) => row.path === fixture.worktree)?.threads ?? [];
    // Both providers intentionally use the same thread id: identity is not
    // a title or a path, and must include the provider that owns it.
    expect(owners.map((owner) => ({ backend: owner.backend, threadId: owner.threadId })).sort((a, b) => a.backend.localeCompare(b.backend)))
      .toEqual([...fixture.owners].sort((a, b) => a.backend.localeCompare(b.backend)));
    expect(owners.find((owner) => owner.backend === "codex")?.title).toBe("Investigate widget layout");
    expect(owners.find((owner) => owner.backend === "claude")?.title).toBe("Shared archive fixture");
    expect(audit.candidates).toEqual([]);
    expect(await stat(fixture.worktree)).toBeDefined();
  });

  it("limits maintenance inventory to identified thread checkouts and never offers a spare folder for removal", async () => {
    const fixture = await createSharedArchiveFixture("codex", false);
    const spare = path.join(fixture.root, ".pwragent", "worktrees", "spare", "repo");
    await fixture.git(fixture.repo, ["worktree", "add", "-b", "spare", spare]);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(path.join(spare, ".git"), old, old);
    const { registry } = fixture.reopen();
    const audit = await registry.auditArchivedCheckouts();
    expect(audit.inventory!.paths).toEqual([fixture.worktree]);
    expect(audit.unreferenced).toEqual([]);
    expect(await registry.removeUnreferencedCheckouts([spare])).toEqual({ removed: [], failed: [],
      kept: [{ worktreePath: spare, reason: "No identified thread owns this checkout" }] });
    expect(await stat(spare)).toBeDefined();
  });


});

it("checks archived owners concurrently with bounded work, ordered results and batch pacing", async () => {
  const fixture = await createFixture("claude");
  const { registry } = fixture.reopen();
  const threads: AppServerThreadSummary[] = Array.from({ length: 13 }, (_, index) => ({
    id: String(index), source: "claude", title: String(index), titleSource: "explicit",
    linkedDirectories: [{ ...fixture.directory, worktreePath: path.join(fixture.root, `audit-${index}`) }],
  }));
  await Promise.all(threads.map((thread) => mkdir(thread.linkedDirectories[0]!.worktreePath!)));
  type Ownership = { users: AppServerThreadSummary[]; external: boolean };
  const boundary = registry as unknown as {
    readPacedArchiveCleanupInventory: () => Promise<{ activeThreads: AppServerThreadSummary[]; archivedThreads: AppServerThreadSummary[] }>;
    maintenanceThreadWorkspace: (thread: AppServerThreadSummary) => Promise<AppServerThreadSummary>;
    readCanonicalArchiveOwnership: (_inventory: unknown, target: string) => Promise<Ownership>;
    describeMaintenanceCheckoutInventory: () => Promise<void>;
    archiveCleanupQueue: { enqueue: (_key: string, work: (context: ArchiveCleanupContext) => Promise<unknown>) => Promise<unknown> };
  };
  vi.spyOn(boundary, "readPacedArchiveCleanupInventory").mockResolvedValue({ activeThreads: [], archivedThreads: threads });
  vi.spyOn(boundary, "maintenanceThreadWorkspace").mockImplementation(async (thread) => thread);
  vi.spyOn(boundary, "describeMaintenanceCheckoutInventory").mockResolvedValue();
  const checkpoint = vi.fn(async () => {});
  vi.spyOn(boundary.archiveCleanupQueue, "enqueue").mockImplementation(async (_key, work) => await work({
    checkpoint, assertCurrent() {}, settleCheckpoint: async () => {},
  }));
  let active = 0, peak = 0, completed = 0, drain = false;
  const pending: (() => void)[] = [];
  vi.spyOn(boundary, "readCanonicalArchiveOwnership").mockImplementation(async (_inventory, target) => {
    active += 1; peak = Math.max(peak, active);
    try {
      if (!drain) await new Promise<void>((resolve) => pending.push(resolve));
      const index = Number(path.basename(target).slice("audit-".length));
      if (index % 3 === 2) throw new Error("Fixture unreadable checkout");
      return { users: index % 3 === 1 ? [threads[index]!] : [], external: false };
    } finally { active -= 1; completed += 1; }
  });
  const progress: MaintenanceDiscoveryProgress[] = [];
  const audit = registry.auditArchivedCheckouts((update) => progress.push(update));
  try {
    // The model holds six independent reads in flight, then completes each
    // wave backwards. Eligibility and scan order must be timing-independent.
    while (completed < threads.length) {
      const before = completed;
      const expected = Math.min(6, threads.length - completed);
      await vi.waitFor(() => expect(pending).toHaveLength(expected));
      for (const release of pending.splice(0).reverse()) release();
      await vi.waitFor(() => expect(completed).toBe(before + expected));
    }
    const result = await audit;
    expect(peak).toBe(6);
    expect(active).toBe(0);
    expect(result.candidates.map((row) => row.threadId)).toEqual(threads.filter((_, index) => index % 3 === 0).map((row) => row.id));
    expect(checkpoint).toHaveBeenCalledTimes(3);
    expect(progress.some((row) => row.detail?.includes("13/13 checked"))).toBe(true);
  } finally {
    drain = true;
    for (const release of pending.splice(0)) release();
    await audit;
  }
});

describe("archive worktrees across a desktop restart", () => {
  it("restores dirty contents after a deferred removal loses its snapshot-store write and restarts", async () => {
    const fixture = await createFixture(true);
    ArchiveWorktreeTransport.threads = [
      { id: "target", cwd: fixture.worktree, source: "cli" },
      { id: "owner", cwd: fixture.repo, source: "cli" },
    ];
    const first = fixture.reopen(fixture.directory, true);
    await first.store.addLinkedDirectory({ backend: "codex", threadId: "owner", directory: fixture.directory });
    await writeFile(path.join(fixture.worktree, "file.txt"), "deferred dirty edit\n");
    expect((await first.registry.archiveThread({ backend: "codex", threadId: "target" })).cleanup[0]?.removedWorktree).toBe(false);
    vi.spyOn(first.store, "upsertWorktreeSnapshot").mockRejectedValueOnce(new Error("Snapshot store unavailable"));
    const completed = new Promise<void>((resolve) => first.registry.onEvent((event) => {
      if (event.notification.method === "thread/archiveCleanup/completed" && event.notification.params.threadId === "target") resolve();
    }));
    await first.store.removeLinkedDirectory({ backend: "codex", threadId: "owner", directory: fixture.directory });
    await first.registry.publishLocalEvent({ backend: "codex", notification: {
      method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: ["owner"] },
    } });
    await completed;
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await first.store.getThreadOverlayState({ backend: "codex", threadId: "target" }))?.worktreeSnapshots ?? []).toEqual([]);
    await first.registry.close();
    first.db.close();
    databases.splice(databases.indexOf(first.db), 1);
    const resumed = fixture.reopen(fixture.directory, true);
    await resumed.registry.resumeArchiveCleanupsAtStartup();
    await resumed.registry.restoreThread({ backend: "codex", threadId: "target" });
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("deferred dirty edit\n");
  });

  it.each([
    ["claude", "archive", "claude"], ["claude", "repair", "claude"],
    ["codex", "archive", "claude"], ["codex", "archive", "codex"],
    ["codex", "repair", "claude"], ["codex", "repair", "codex"],
  ] as const)("retains every shared owner's snapshot and restores both across restart (%s, %s, %s first)", async (otherBackend, operation, restoreFirst) => {
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    const fixture = await createSharedArchiveFixture(otherBackend, operation === "repair");
    const first = fixture.reopen();
    const { writes: archiveWrites } = await measureSqliteWrites(async () => {
      if (operation === "repair") {
        expect((await first.registry.repairArchivedThreadWorktrees()).cleanup).toEqual([expect.objectContaining({ removedWorktree: true })]);
      } else {
        expect((await first.registry.archiveThread(fixture.owners[0]!)).cleanup).toEqual([expect.objectContaining({ removedWorktree: false })]);
        const cleanup = (await first.registry.archiveThread(fixture.owners[1]!)).cleanup;
        expect(cleanup).toEqual([expect.objectContaining({ worktreePath: fixture.worktree })]);
        if (!cleanup[0]!.removedWorktree) expect(cleanup[0]!.skippedReason).toBe("Worktree directory no longer exists.");
      }
    });
    if (otherBackend === "codex" && restoreFirst === "codex") expectSqliteWriteBudget({
      scenario: `mixed-provider-worktree-${operation}`, note: "One checkout archived for one Claude and one Codex owner, including each owner's recovery snapshot; boundary writes only.", writes: archiveWrites,
    });
    const snapshots = await Promise.all(fixture.owners.map(async (owner) => {
      const snapshots = (await first.store.getThreadOverlayState(owner))?.worktreeSnapshots ?? [];
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ backend: owner.backend, threadId: owner.threadId });
      return snapshots[0]!;
    }));
    expect(snapshots[0]!.snapshotCommit).toBe(snapshots[1]!.snapshotCommit);
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    await first.registry.close();
    first.db.close();
    databases.splice(databases.indexOf(first.db), 1);
    const restarted = fixture.reopen();
    const ordered = restoreFirst === "codex" ? [...fixture.owners].reverse() : fixture.owners;
    const { writes: restoreWrites } = await measureSqliteWrites(async () => {
      expect((await restarted.registry.restoreThread(ordered[0]!)).worktrees).toEqual([expect.objectContaining({ restored: true })]);
      const identity = await stat(fixture.worktree);
      await writeFile(path.join(fixture.worktree, "after-restore.txt"), "new shared work\n");
      expect((await restarted.registry.restoreThread(ordered[1]!)).worktrees).toEqual([expect.objectContaining({ restored: false, skippedReason: "Worktree path already exists." })]);
      const after = await stat(fixture.worktree);
      expect([after.dev, after.ino]).toEqual([identity.dev, identity.ino]);
    });
    if (otherBackend === "claude" && operation === "archive") expectSqliteWriteBudget({
      scenario: "shared-claude-worktree-restore", note: "Restore two Claude owners of one snapshot: recreate the checkout once, then validate and reuse it without overwriting subsequent edits.", writes: restoreWrites,
    });
    for (const owner of fixture.owners) {
      const snapshot = (await restarted.store.getThreadOverlayState(owner))?.worktreeSnapshots?.[0];
      expect(snapshot?.state).toBe("restored");
      expect(snapshot?.restoredCheckoutIdentity).toBeDefined();
      if (owner.backend === "claude") expect((await fixture.claudeStore.read(owner.threadId)).thread.archivedAt).toBeUndefined();
    }
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("shared dirty edit\n");
    expect(await readFile(path.join(fixture.worktree, "notes.txt"), "utf8")).toBe("shared untracked file\n");
    expect(await readFile(path.join(fixture.worktree, "after-restore.txt"), "utf8")).toBe("new shared work\n");
  });

  it("rejects a replacement Git checkout even when another owner's saved restore metadata remains", async () => {
    const fixture = await createSharedArchiveFixture("claude", true);
    const instance = fixture.reopen();
    await instance.registry.repairArchivedThreadWorktrees();
    await instance.registry.restoreThread(fixture.owners[0]!);
    await fixture.git(fixture.repo, ["worktree", "move", fixture.worktree, path.join(fixture.root, "moved-checkout")]);
    await fixture.git(fixture.repo, ["worktree", "add", "--detach", fixture.worktree, "HEAD"]);
    await writeFile(path.join(fixture.worktree, "keep.txt"), "replacement checkout\n");
    await expect(instance.registry.restoreThread(fixture.owners[1]!)).rejects.toThrow("unexpected or incomplete checkout");
    expect((await fixture.claudeStore.read(fixture.owners[1]!.threadId)).thread.archivedAt).toBeDefined();
    expect(await readFile(path.join(fixture.worktree, "keep.txt"), "utf8")).toBe("replacement checkout\n");
  });

  it.each([false, true])("snapshots archived Claude worktrees and restores their branch and edits after restart (historical repair=%s)", async (historical) => {
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    const fixture = await createFixture("claude");
    const threadId = "11111111-1111-4111-8111-111111111111";
    const localPath = path.join(fixture.root, "linked-local");
    await mkdir(localPath);
    await writeFile(path.join(localPath, "keep.txt"), "keep local directory\n");
    await writeFile(path.join(fixture.worktree, "unpublished.txt"), "unpublished commit\n");
    await fixture.git(fixture.worktree, ["add", "."]);
    await fixture.git(fixture.worktree, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "unpublished"]);
    const head = (await fixture.git(fixture.worktree, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(fixture.worktree, "file.txt"), "unsaved tracked edit\n");
    await writeFile(path.join(fixture.worktree, "notes.txt"), "non-ignored untracked file\n");
    await writeFile(path.join(fixture.worktree, ".gitignore"), "target/\n");
    await mkdir(path.join(fixture.worktree, "target"));
    await writeFile(path.join(fixture.worktree, "target", "cache"), "ignored build cache\n");
    await fixture.claudeStore.save({ cwd: fixture.worktree, sdkSessionId: "retained-sdk-session", thread: {
      id: threadId, source: "claude", title: "Contrived Claude archive", titleSource: "explicit",
      archivedAt: historical ? 1 : undefined, linkedDirectories: [fixture.directory],
    } });
    const first = fixture.reopen();
    await first.store.addLinkedDirectory({ backend: "claude", threadId, directory: fixture.directory });
    await first.store.addLinkedDirectory({ backend: "claude", threadId,
      directory: { id: localPath, kind: "local", label: "local", path: localPath } });
    if (historical) {
      const result = await first.registry.repairArchivedThreadWorktrees();
      expect(result.cleanup).toEqual([expect.objectContaining({ worktreePath: fixture.worktree, removedWorktree: true })]);
    } else {
      const completed = new Promise<unknown>((resolve) => first.registry.onEvent((event) => {
        if (event.notification.method === "thread/archiveCleanup/completed") resolve(event.notification.params);
      }));
      const { writes } = await measureSqliteWrites(async () => {
        expect(await first.registry.archiveThread({ backend: "claude", threadId, backgroundCleanup: true })).toMatchObject({ cleanupPending: true });
        expect(await completed).toMatchObject({ cleanup: [expect.objectContaining({ worktreePath: fixture.worktree, removedWorktree: true })] });
      });
      expectSqliteWriteBudget({ scenario: "claude-worktree-archive", note: "One explicit archive with one managed worktree: snapshot and lifecycle boundary writes only; no idle or timer writes.", writes });
    }
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fixture.git(fixture.repo, ["worktree", "list", "--porcelain"])).not.toContain(fixture.worktree.replaceAll(path.sep, "/"));
    expect(await fixture.git(fixture.repo, ["rev-parse", "owned"])).toContain(head);
    expect((await first.store.getThreadOverlayState({ backend: "claude", threadId }))?.worktreeSnapshots).toHaveLength(1);
    await first.registry.close();
    first.db.close();
    databases.splice(databases.indexOf(first.db), 1);
    const second = fixture.reopen();
    const failedRestore = vi.spyOn(WorktreeArchiveService.prototype, "restore").mockRejectedValueOnce(new Error("Contrived restore failure"));
    try {
      await expect(second.registry.restoreThread({ backend: "claude", threadId })).rejects.toThrow("thread remains archived");
      expect((await fixture.claudeStore.read(threadId)).thread.archivedAt).toBeDefined();
    } finally { failedRestore.mockRestore(); }
    await mkdir(fixture.worktree);
    await writeFile(path.join(fixture.worktree, "partial.txt"), "keep unexpected files\n");
    await expect(second.registry.restoreThread({ backend: "claude", threadId })).rejects.toThrow("incomplete checkout already exists");
    expect((await fixture.claudeStore.read(threadId)).thread.archivedAt).toBeDefined();
    expect(await readFile(path.join(fixture.worktree, "partial.txt"), "utf8")).toBe("keep unexpected files\n");
    await rm(fixture.worktree, { recursive: true });
    const { writes } = await measureSqliteWrites(async () => {
      expect(await second.registry.restoreThread({ backend: "claude", threadId })).toMatchObject({ worktrees: [expect.objectContaining({ restored: true })] });
    });
    expectSqliteWriteBudget({ scenario: historical ? "claude-worktree-repair-restore" : "claude-worktree-restore", note: "One explicit restore recreates a saved checkout before unarchiving the Claude session; no idle or timer writes.", writes });
    expect((await fixture.claudeStore.read(threadId)).thread.archivedAt).toBeUndefined();
    expect((await fixture.claudeStore.read(threadId)).sdkSessionId).toBe("retained-sdk-session");
    expect((await fixture.git(fixture.worktree, ["branch", "--show-current"])).trim()).toBe("owned");
    expect((await fixture.git(fixture.worktree, ["rev-parse", "HEAD"])).trim()).toBe(head);
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("unsaved tracked edit\n");
    expect(await readFile(path.join(fixture.worktree, "notes.txt"), "utf8")).toBe("non-ignored untracked file\n");
    expect(await fixture.git(fixture.worktree, ["status", "--short"])).toContain(" M file.txt");
    expect(await fixture.git(fixture.worktree, ["status", "--short"])).toContain("?? notes.txt");
    await expect(stat(path.join(fixture.worktree, "target"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(localPath, "keep.txt"), "utf8")).toBe("keep local directory\n");
  });

  it("keeps a Claude checkout also owned by an archived ACP session that cannot restore snapshots", async () => {
    const fixture = await createFixture("claude");
    const threadId = "11111111-1111-4111-8111-111111111111";
    await fixture.claudeStore.save({ cwd: fixture.worktree, thread: { id: threadId, source: "claude",
      title: "Claude shared checkout", titleSource: "explicit", linkedDirectories: [fixture.directory] } });
    const instance = fixture.reopen();
    instance.acpAgentStore.upsertInstalledAgent({ backendId: "acp:grok", registryId: "grok", name: "Grok",
      distributionKind: "local", distributionSource: "grok --acp", installStatus: "installed", authStatus: "not-required",
      verificationStatus: "not-applicable", allowlistRuleId: "fixture-grok", installedAt: 1, updatedAt: 1 });
    instance.acpSessionStore.upsertSession({ backendId: "acp:grok", sessionId: "acp-owner", title: "Archived ACP owner",
      cwd: fixture.worktree, createdAt: 1, updatedAt: 1, executionMode: "default", status: "idle", archivedAt: 1 });
    const result = await instance.registry.archiveThread({ backend: "claude", threadId });
    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: false,
      skippedReason: expect.stringContaining("Archived ACP session") })]);
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
  });

  it("checkpoints a queued cleanup on quit and resumes it without archiving the provider again", async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [{ id: "queued", cwd: fixture.worktree, source: "cli", archived: false }];
    await writeFile(path.join(fixture.worktree, "file.txt"), "work retained across cleanup restart\n");
    const first = fixture.reopen(fixture.directory, true);
    expect(await first.registry.archiveThread({ backend: "codex", threadId: "queued", backgroundCleanup: true }))
      .toMatchObject({ cleanupPending: true });
    await first.registry.close();
    first.db.close();
    databases.splice(databases.indexOf(first.db), 1);
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
    const archiveCalls = ArchiveWorktreeTransport.requests.filter((request) => request.method === "thread/archive").length;
    const second = fixture.reopen(fixture.directory, true);
    await second.registry.resumeArchiveCleanupsAtStartup();
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(ArchiveWorktreeTransport.requests.filter((request) => request.method === "thread/archive")).toHaveLength(archiveCalls);
    const restored = await second.registry.restoreThread({ backend: "codex", threadId: "queued" });
    expect(restored.worktrees).toEqual([expect.objectContaining({ restored: true })]);
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("work retained across cleanup restart\n");
  });

  it.each(["ACP only", "shared with Codex", "late ACP owner", "shared through home alias"])("preserves archived ACP checkouts during repair (%s)", async (scenario) => {
    const fixture = await createFixture(scenario === "shared through home alias");
    let codexWorktree = fixture.worktree;
    if (scenario === "shared through home alias") {
      const alias = path.join(path.dirname(fixture.codexHome), "codex-home-alias");
      await symlink(fixture.codexHome, alias, process.platform === "win32" ? "junction" : "dir");
      vi.stubEnv("CODEX_HOME", alias);
      codexWorktree = path.join(alias, "worktrees", "id", "repo");
    }
    ArchiveWorktreeTransport.threads = scenario === "ACP only" ? [] : [{ id: "codex-owner", cwd: codexWorktree, source: "cli", archived: true }];
    const instance = fixture.reopen({ ...fixture.directory, worktreePath: codexWorktree });
    instance.acpAgentStore.upsertInstalledAgent({ backendId: "acp:grok", registryId: "grok", name: "Grok",
      distributionKind: "local", distributionSource: "grok --acp", installStatus: "installed", authStatus: "not-required",
      verificationStatus: "not-applicable", allowlistRuleId: "fixture-grok", installedAt: 1, updatedAt: 1 });
    const addAcpOwner = () => instance.acpSessionStore.upsertSession({ backendId: "acp:grok", sessionId: "acp-owner",
      title: "Archived ACP owner", cwd: fixture.worktree, createdAt: 1, updatedAt: 1, executionMode: "default", status: "idle", archivedAt: 1 });
    if (scenario === "late ACP owner") {
      let activeReads = 0;
      // Discovery is read 1; the authoritative removal admission is read 2.
      ArchiveWorktreeTransport.onList = (params) => { if (!params.archived && ++activeReads === 2) addAcpOwner(); };
    } else addAcpOwner();
    await writeFile(path.join(fixture.worktree, "file.txt"), "preserve ACP edits\n");
    const report = await instance.registry.repairArchivedThreadWorktrees();
    expect(report.cleanup.every((item) => !item.removedWorktree)).toBe(true);
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("preserve ACP edits\n");
    expect(await fixture.git(fixture.repo, ["worktree", "list", "--porcelain"])).toContain(fixture.worktree.split(path.sep).join("/"));
    if (scenario !== "late ACP owner") expect(await fixture.git(fixture.repo, ["for-each-ref", "refs/codex/snapshots/"])).toBe("");
    expect(instance.acpSessionStore.getSession("acp:grok", "acp-owner")?.archivedAt).toBe(1);
    // Non-reloadable ACP sessions keep their original checkout.
    await instance.registry.restoreThread({ backend: "acp:grok", threadId: "acp-owner" });
    expect(instance.acpSessionStore.getSession("acp:grok", "acp-owner")?.archivedAt).toBeUndefined();
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("preserve ACP edits\n");
  });

  it.each(["file", "non-directory ancestor"])("retains invalid historical paths and still completes a valid repair (%s)", async (scenario) => {
    const fixture = await createFixture();
    const replaced = path.join(path.dirname(fixture.repo), "replaced-checkout");
    await writeFile(replaced, "retain this file\n");
    const invalid = scenario === "file" ? replaced : path.join(replaced, "missing-child");
    ArchiveWorktreeTransport.threads = [
      { id: "invalid", cwd: invalid, source: "cli", archived: true }, { id: "valid", cwd: fixture.worktree, source: "cli", archived: true },
    ];
    const instance = fixture.reopen();
    await instance.store.addLinkedDirectory({ backend: "codex", threadId: "invalid", directory: { ...fixture.directory, worktreePath: invalid } });
    const first = await runOneTimeArchivedWorktreeRepair({ db: instance.db.raw, repair: async () => await instance.registry.repairArchivedThreadWorktrees() });
    // Windows reports ENOENT below a file; POSIX reports ENOTDIR. Both must
    // retain the file and continue the valid repair. Reported failures keep
    // the pass eligible for another sweep.
    const missingBelowFile = scenario === "non-directory ancestor" && process.platform === "win32";
    const retained = expect.objectContaining({ worktreePath: invalid, removedWorktree: false, error: expect.any(String) });
    const removed = expect.objectContaining({ worktreePath: fixture.worktree, removedWorktree: true });
    expect(first?.cleanup).toEqual(missingBelowFile ? [removed] : [retained, removed]);
    if (missingBelowFile) expect(first?.missingWorktrees).toBe(1);
    expect(await readFile(replaced, "utf8")).toBe("retain this file\n");
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    const again = vi.fn(async () => await instance.registry.repairArchivedThreadWorktrees());
    const second = await runOneTimeArchivedWorktreeRepair({ db: instance.db.raw, repair: again });
    if (missingBelowFile) {
      expect(second).toBeUndefined();
      expect(again).not.toHaveBeenCalled();
    } else {
      expect(again).toHaveBeenCalledOnce();
      expect(second?.cleanup).toEqual([retained]);
    }
  });

  it("archives, prunes and restores through a symlinked Codex home", async () => {
    const fixture = await createFixture(true);
    const alias = path.join(path.dirname(fixture.codexHome), "codex-home-alias");
    await symlink(fixture.codexHome, alias, process.platform === "win32" ? "junction" : "dir");
    vi.stubEnv("CODEX_HOME", alias);
    const aliasedWorktree = path.join(alias, "worktrees", "id", "repo");
    ArchiveWorktreeTransport.threads = [{ id: "target", cwd: aliasedWorktree, source: "cli" }];
    const instance = fixture.reopen({ ...fixture.directory, worktreePath: aliasedWorktree });
    expect((await instance.registry.archiveThread({ backend: "codex", threadId: "target" })).cleanup)
      .toEqual([expect.objectContaining({ removedWorktree: true })]);
    await expect(stat(fixture.container)).rejects.toMatchObject({ code: "ENOENT" });
    await instance.registry.restoreThread({ backend: "codex", threadId: "target" });
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("original\n");
  });

  it("protects an empty canonical container referenced by an active home-alias cwd", async () => {
    const fixture = await createFixture(true);
    const alias = path.join(path.dirname(fixture.codexHome), "codex-home-alias");
    await symlink(fixture.codexHome, alias, process.platform === "win32" ? "junction" : "dir");
    vi.stubEnv("CODEX_HOME", alias);
    await fixture.git(fixture.repo, ["worktree", "remove", fixture.worktree]);
    ArchiveWorktreeTransport.threads = [
      { id: "archived", cwd: fixture.worktree, source: "cli", archived: true },
      { id: "active", cwd: path.join(alias, "worktrees", "id", "another-missing-checkout"), source: "exec" },
    ];
    const report = await fixture.reopen().registry.repairArchivedThreadWorktrees();
    expect(report.emptyContainerCandidates).toEqual([]);
    expect((await stat(fixture.container)).isDirectory()).toBe(true);
  });

  it("prunes the empty managed container on ordinary archive and recreates it on restore", async () => {
    const fixture = await createFixture(true);
    ArchiveWorktreeTransport.threads = [{ id: "target", cwd: fixture.worktree, source: "cli" }];
    const instance = fixture.reopen();
    await writeFile(path.join(fixture.worktree, "file.txt"), "preserved dirty edit\n");
    expect((await instance.registry.archiveThread({ backend: "codex", threadId: "target" })).cleanup)
      .toEqual([expect.objectContaining({ removedWorktree: true })]);
    await expect(stat(fixture.container)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(path.dirname(fixture.container))).isDirectory()).toBe(true);
    await instance.registry.restoreThread({ backend: "codex", threadId: "target" });
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("preserved dirty edit\n");
  });

  it("repairs only empty containers associated with archived provider cwd, without inventing a snapshot", async () => {
    const fixture = await createFixture(true);
    await fixture.git(fixture.repo, ["worktree", "remove", fixture.worktree]);
    const unrelated = path.join(fixture.codexHome, "worktrees", "unattributed");
    await mkdir(unrelated);
    ArchiveWorktreeTransport.threads = [{ id: "archived", cwd: fixture.worktree, source: "cli", archived: true }];
    // Missing checkout enrichment returns no linked directory. Association
    // comes from the archived provider cwd, not enumeration of root folders.
    const instance = fixture.reopen({ ...fixture.directory, worktreePath: "not-this-cwd" });
    const dryRun = await instance.registry.repairArchivedThreadWorktrees({ dryRun: true });
    expect(dryRun.emptyContainerCandidates).toHaveLength(1);
    expect((await stat(fixture.container)).isDirectory()).toBe(true);
    const result = await instance.registry.repairArchivedThreadWorktrees();
    expect(result.containerCleanup).toEqual([expect.objectContaining({ removed: true })]);
    await expect(stat(fixture.container)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(unrelated)).isDirectory()).toBe(true);
    expect(await fixture.git(fixture.repo, ["for-each-ref", "refs/codex/snapshots/"])).toBe("");
    expect((await instance.store.getThreadOverlayState({ backend: "codex", threadId: "archived" }))?.worktreeSnapshots ?? []).toEqual([]);
    expect(ArchiveWorktreeTransport.requests.filter((request) => request.method === "thread/archive")).toEqual([]);
  });

  it("removes the archived checkout while preserving another checkout in the same id", async () => {
    const fixture = await createFixture(true);
    const sibling = path.join(fixture.container, "other-checkout");
    await fixture.git(fixture.repo, ["worktree", "add", "--detach", sibling]);
    ArchiveWorktreeTransport.threads = [
      { id: "target", cwd: fixture.worktree, source: "cli" }, { id: "active", cwd: sibling, source: "exec" },
    ];
    const result = await fixture.reopen().registry.archiveThread({ backend: "codex", threadId: "target" });
    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true })]);
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(fixture.container)).isDirectory()).toBe(true);
    expect(await readFile(path.join(sibling, "file.txt"), "utf8")).toBe("original\n");
  });

  it.each(["existing owner", "new owner"])("keeps an empty id used by an active thread (%s)", async (scenario) => {
    const fixture = await createFixture(true);
    await fixture.git(fixture.repo, ["worktree", "remove", fixture.worktree]);
    ArchiveWorktreeTransport.threads = [{ id: "archived", cwd: fixture.worktree, source: "cli", archived: true }];
    const owner = { id: "active", cwd: path.join(fixture.container, "another-missing-checkout"), source: "exec" };
    if (scenario === "existing owner") ArchiveWorktreeTransport.threads.push(owner);
    else {
      let activeReads = 0;
      ArchiveWorktreeTransport.onList = (params) => {
        if (!params.archived && ++activeReads === 2) ArchiveWorktreeTransport.threads.push(owner);
      };
    }
    const instance = fixture.reopen();
    const result = await instance.registry.repairArchivedThreadWorktrees();
    expect(result.containerCleanup.every((item) => !item.removed)).toBe(true);
    expect((await stat(fixture.container)).isDirectory()).toBe(true);
  });

  it("retains a container when another client restores its owner after discovery", async () => {
    const fixture = await createFixture(true);
    await fixture.git(fixture.repo, ["worktree", "remove", fixture.worktree]);
    ArchiveWorktreeTransport.threads = [{ id: "archived", cwd: fixture.worktree, source: "cli", archived: true }];
    let activeReads = 0;
    ArchiveWorktreeTransport.onList = (params) => {
      if (!params.archived && ++activeReads === 2) ArchiveWorktreeTransport.threads[0]!.archived = false;
    };
    const result = await fixture.reopen().registry.repairArchivedThreadWorktrees();
    expect(result.containerCleanup).toEqual([expect.objectContaining({ removed: false, error: expect.any(String) })]);
    expect((await stat(fixture.container)).isDirectory()).toBe(true);
  });

  it("reports a container error and continues to other archived containers", async () => {
    const fixture = await createFixture(true);
    await fixture.git(fixture.repo, ["worktree", "remove", fixture.worktree]);
    const secondContainer = path.join(fixture.codexHome, "worktrees", "second-id");
    const secondWorktree = path.join(secondContainer, "repo");
    await mkdir(secondContainer);
    ArchiveWorktreeTransport.threads = [
      { id: "first", cwd: fixture.worktree, source: "cli", archived: true },
      { id: "second", cwd: secondWorktree, source: "cli", archived: true },
    ];
    const original = WorktreeContainerService.prototype.prune;
    const prune = vi.spyOn(WorktreeContainerService.prototype, "prune").mockImplementation(async function(this: WorktreeContainerService, worktree, check, identity) {
      if (worktree === fixture.worktree) return { worktreePath: worktree, containerPath: fixture.container, removed: false, error: "Access denied" };
      return await original.call(this, worktree, check, identity);
    });
    try {
      const result = await fixture.reopen().registry.repairArchivedThreadWorktrees();
      expect(result.containerCleanup).toEqual([
        expect.objectContaining({ removed: false, error: "Access denied" }), expect.objectContaining({ removed: true }),
      ]);
      expect((await stat(fixture.container)).isDirectory()).toBe(true);
      await expect(stat(secondContainer)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      prune.mockRestore();
    }
  });

  it("repairs an already archived checkout once, preserves non-ignored edits, and restores every archived owner after restart", async () => {
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [
      { id: "old-target", cwd: fixture.worktree, source: "cli", archived: true },
      { id: "shared-archive", cwd: fixture.worktree, source: "appServer", archived: true },
    ];
    await writeFile(path.join(fixture.worktree, "file.txt"), "previously abandoned edit\n");
    await writeFile(path.join(fixture.worktree, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(fixture.worktree, "untracked.txt"), "new non-ignored work\n");
    await writeFile(path.join(fixture.worktree, "ignored.txt"), "ignored build output\n");
    const instance = fixture.reopen();
    const dryRun = await instance.registry.repairArchivedThreadWorktrees({ dryRun: true });
    expect(dryRun.candidates).toHaveLength(1);
    expect(await fixture.git(fixture.repo, ["for-each-ref", "refs/codex/snapshots/"])).toBe("");
    const { result, writes } = await measureSqliteWrites(async () => await runOneTimeArchivedWorktreeRepair({
      db: instance.db.raw, repair: async () => await instance.registry.repairArchivedThreadWorktrees(),
    }));
    expect(result?.cleanup).toEqual([expect.objectContaining({ removedWorktree: true })]);
    expectSqliteWriteBudget({ scenario: "archived-worktree-repair-shared-snapshot", note: "One-time repair of one dirty checkout shared by two archived threads, including the profile claim and completion; no timer or idle writes.", writes });
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(ArchiveWorktreeTransport.requests.filter((request) => request.method === "thread/archive")).toEqual([]);
    const snapshots = (await instance.store.getThreadOverlayState({ backend: "codex", threadId: "old-target" }))!.worktreeSnapshots!;
    expect(snapshots).toHaveLength(1);
    expect(await fixture.git(fixture.repo, ["show", `${snapshots[0]!.snapshotRef}:untracked.txt`])).toBe("new non-ignored work\n");
    expect(await fixture.git(fixture.repo, ["ls-tree", "--name-only", snapshots[0]!.snapshotRef])).not.toContain("ignored.txt");
    await instance.registry.close();
    instance.db.close();
    databases.splice(databases.indexOf(instance.db), 1);
    const restarted = fixture.reopen();
    const repair = vi.fn(async () => await restarted.registry.repairArchivedThreadWorktrees());
    expect(await runOneTimeArchivedWorktreeRepair({ db: restarted.db.raw, repair })).toBeUndefined();
    expect(repair).not.toHaveBeenCalled();
    await restarted.registry.restoreThread({ backend: "codex", threadId: "old-target" });
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("previously abandoned edit\n");
    expect(await readFile(path.join(fixture.worktree, "untracked.txt"), "utf8")).toBe("new non-ignored work\n");
    await expect(stat(path.join(fixture.worktree, "ignored.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["active", "external"])("keeps an archived checkout protected by %s ownership during repair", async (protection) => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [{ id: "old-target", cwd: fixture.worktree, source: "cli", archived: true }];
    if (protection === "active") ArchiveWorktreeTransport.threads.push({ id: "hidden-user", cwd: fixture.worktree, source: "subAgentOther" });
    const instance = fixture.reopen();
    if (protection === "external") await instance.store.addLinkedDirectory({
      backend: "codex", threadId: "old-target", directory: { ...fixture.directory, worktreeOwnership: "external" },
    });
    const result = await instance.registry.repairArchivedThreadWorktrees();
    expect(result.protectedWorktrees).toBe(1);
    expect(result.candidates).toEqual([]);
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
  });

  it("keeps an archived checkout if an owner appears after repair discovery", async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [{ id: "old-target", cwd: fixture.worktree, source: "cli", archived: true }];
    let activeReads = 0;
    ArchiveWorktreeTransport.onList = (params) => {
      if (!params.archived && ++activeReads === 2) ArchiveWorktreeTransport.threads.push({ id: "new-owner", cwd: fixture.worktree, source: "appServer" });
    };
    const instance = fixture.reopen();
    const result = await instance.registry.repairArchivedThreadWorktrees();
    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(activeReads).toBe(2);
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
  });

  it("keeps an orphaned checkout whose repository is gone, as a skip, and still cleans the next one", async () => {
    const fixture = await createFixture();
    const goneRepo = path.join(fixture.root, "gone-repo");
    const orphan = path.join(fixture.root, "orphan");
    await mkdir(goneRepo);
    await fixture.git(goneRepo, ["init", "-b", "main"]);
    await writeFile(path.join(goneRepo, "file.txt"), "gone\n");
    await fixture.git(goneRepo, ["add", "file.txt"]);
    await fixture.git(goneRepo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "gone"]);
    await fixture.git(goneRepo, ["worktree", "add", "-b", "orphan", orphan]);
    await rm(goneRepo, { recursive: true, force: true });
    const orphanDirectory = { id: "orphan", kind: "worktree" as const, label: "gone-repo", path: goneRepo, worktreePath: orphan };
    ArchiveWorktreeTransport.threads = [
      { id: "orphan-owner", cwd: orphan, source: "cli", archived: true },
      { id: "old-target", cwd: fixture.worktree, source: "cli", archived: true },
    ];
    const instance = fixture.reopen(fixture.directory, false, undefined, [orphanDirectory]);
    const result = await instance.registry.repairArchivedThreadWorktrees();
    expect(result.cleanup).toEqual(expect.arrayContaining([
      expect.objectContaining({ worktreePath: orphan, removedWorktree: false,
        skippedReason: "Its repository no longer exists; the checkout was kept." }),
      expect.objectContaining({ worktreePath: fixture.worktree, removedWorktree: true }),
    ]));
    expect(result.cleanup.filter((item) => item.error)).toEqual([]);
    expect((await stat(orphan)).isDirectory()).toBe(true);
  });

  it("records a discovery failure for one checkout and still cleans the others", async () => {
    const fixture = await createFixture();
    const second = path.join(fixture.root, "second");
    await fixture.git(fixture.repo, ["worktree", "add", "-b", "second", second]);
    const secondDirectory = { ...fixture.directory, id: "second", worktreePath: second };
    ArchiveWorktreeTransport.threads = [
      { id: "broken-owner", cwd: second, source: "cli", archived: true },
      { id: "old-target", cwd: fixture.worktree, source: "cli", archived: true },
    ];
    const instance = fixture.reopen(fixture.directory, false, undefined, [secondDirectory]);
    const registry = instance.registry as unknown as { archivedAcpWorktreeBlocker: (worktreePath: string, inventory: unknown) => string | undefined };
    const original = registry.archivedAcpWorktreeBlocker.bind(registry);
    let thrown = false;
    vi.spyOn(registry, "archivedAcpWorktreeBlocker").mockImplementation((worktreePath, inventory) => {
      if (!thrown && worktreePath === second) {
        thrown = true;
        throw new Error("EACCES: permission denied");
      }
      return original(worktreePath, inventory);
    });
    const result = await instance.registry.repairArchivedThreadWorktrees();
    expect(result.cleanup).toEqual(expect.arrayContaining([
      expect.objectContaining({ worktreePath: second, removedWorktree: false, error: "EACCES: permission denied" }),
      expect.objectContaining({ worktreePath: fixture.worktree, removedWorktree: true }),
    ]));
    expect((await stat(second)).isDirectory()).toBe(true);
  });

  it("does not remove the primary checkout or invent a snapshot for an absent worktree", async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [{ id: "old-target", cwd: fixture.repo, source: "cli", archived: true }];
    const primary = { ...fixture.directory, path: fixture.repo, worktreePath: fixture.repo };
    const instance = fixture.reopen(primary);
    const result = await instance.registry.repairArchivedThreadWorktrees();
    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.error).toContain("primary checkout");
    expect((await stat(fixture.repo)).isDirectory()).toBe(true);
    ArchiveWorktreeTransport.threads[0]!.cwd = fixture.worktree;
    await fixture.git(fixture.repo, ["worktree", "remove", fixture.worktree]);
    const restarted = fixture.reopen();
    const missing = await restarted.registry.repairArchivedThreadWorktrees();
    expect(missing.missingWorktrees).toBe(1);
    expect(missing.cleanup).toEqual([]);
  });

  it.each(["cli", "vscode", "appServer", "exec", "unknown"])("archives and restores an old %s thread after closing and reopening the registry and SQLite store", async (source) => {
    const fixture = await createFixture();
    const first = fixture.reopen();
    const started = await first.registry.startThread({
      backend: "codex", cwd: fixture.worktree, linkedDirectories: [fixture.directory], mcpConnectionIds: [],
    });
    await writeFile(path.join(fixture.worktree, "file.txt"), "uncommitted work from days ago\n");
    await first.registry.close();
    first.db.close();
    databases.splice(databases.indexOf(first.db), 1);
    ArchiveWorktreeTransport.threads[0]!.source = source;
    // Recreating the process-owned registry removes every pending-start row.
    const second = fixture.reopen();

    const result = await second.registry.archiveThread({ backend: "codex", threadId: started.threadId });

    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true, worktreePath: fixture.worktree })]);
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fixture.git(fixture.repo, ["worktree", "list", "--porcelain"])).not.toContain(fixture.worktree);
    const snapshots = (await second.store.getThreadOverlayState({ backend: "codex", threadId: started.threadId }))?.worktreeSnapshots ?? [];
    expect(snapshots).toHaveLength(1);
    expect(await fixture.git(fixture.repo, ["show", `${snapshots[0]!.snapshotRef}:file.txt`])).toBe("uncommitted work from days ago\n");
    expect(await readFile(path.join(fixture.repo, "file.txt"), "utf8")).toBe("original\n");
    await second.registry.restoreThread({ backend: "codex", threadId: started.threadId });
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("uncommitted work from days ago\n");
  });

  it.each([
    { source: "subAgentThreadSpawn", originator: "codex", name: "worker" },
    { source: "subAgent", originator: "codex", name: "generic worker" },
    { source: "subAgentReview", originator: "codex", name: "review worker" },
    { source: "subAgentCompact", originator: "codex", name: "compact worker" },
    { source: "subAgentOther", originator: "codex", name: "other worker" },
    { source: "appServer", originator: "companion-app", name: "companion" },
    { source: "exec", originator: "codex", name: "exec checkout user" },
    { source: "unknown", originator: "codex", name: "unknown checkout user" },
    { source: "cli", originator: "codex", name: "PwrSnap Capture Metadata Worker" },
  ])("keeps a worktree used by a navigation-hidden $name thread after restart", async (user) => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [
      { id: "old-target", cwd: fixture.worktree, source: "cli", originator: "codex" },
      { id: "hidden-user", cwd: fixture.worktree, status: { type: "notLoaded" }, ...user },
    ];
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup[0]?.skippedReason).toContain("another active thread: hidden-user");
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
    expect((await instance.store.getThreadOverlayState({ backend: "codex", threadId: "old-target" }))?.worktreeSnapshots ?? []).toEqual([]);
  });

  it.each(["completed", "cancelled", "failed", "early", "new work", "archive failure"])("retires a distinct native review child after its result is retained (%s)", async (terminal) => {
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    const fixture = await createFixture();
    const parent: ArchiveWorktreeThread = { id: "reviewed-parent", cwd: fixture.worktree, source: "cli" };
    const child: ArchiveWorktreeThread = { id: "native-review", cwd: fixture.worktree, source: "subAgentReview",
      wireSource: { subAgent: "review" }, threadSource: "subagent", parentThreadId: parent.id, status: { type: "notLoaded" } };
    ArchiveWorktreeTransport.threads = [parent, child];
    ArchiveWorktreeTransport.emitArchiveNotifications = true;
    const instance = fixture.reopen();
    await instance.registry.listBackends({ includeUnavailable: true });
    let transport!: ArchiveWorktreeTransport;
    const params = { threadId: child.id, turnId: "native-review-turn" };
    const notification = terminal === "failed"
      ? { method: "turn/failed" as const, params: { ...params, turn: { id: params.turnId, status: "failed" as const, error: { message: "Contrived review failure" } } } }
      : terminal === "cancelled"
        ? { method: "turn/cancelled" as const, params: { ...params, turn: { id: params.turnId, status: "cancelled" as const } } }
        : { method: "turn/completed" as const, params: { ...params, turn: { id: params.turnId, status: "completed" as const, output: [] } } };
    ArchiveWorktreeTransport.onReviewStart = (_params, connection) => {
      transport = connection;
      const result = { reviewThreadId: child.id, turn: { id: "native-review-turn", status: "inProgress" } };
      if (terminal === "early") {
        const completed = new Promise<void>((resolve) => instance.registry.onEvent((event) => {
          if (event.notification.method === notification.method && event.notification.params.turnId === "native-review-turn") resolve();
        }));
        transport.emitNotification(notification);
        return completed.then(() => result);
      }
      return result;
    };
    const archive = terminal === "archive failure" ? vi.spyOn(instance.client, "archiveThread").mockRejectedValueOnce(new Error("Provider archive rejected")) : undefined;
    const { writes } = await measureSqliteWrites(async () => {
      await instance.registry.startReview({ backend: "codex", threadId: parent.id, target: { type: "uncommittedChanges" } });
      if (terminal !== "early") {
        if (terminal === "new work") child.status = { type: "active", activeFlags: [] };
        const completed = new Promise<void>((resolve) => instance.registry.onEvent((event) => {
          if (event.notification.method === notification.method && event.notification.params.turnId === "native-review-turn") resolve();
        }));
        transport.emitNotification(notification);
        await completed;
      }
    });
    archive?.mockRestore();
    if (terminal === "completed") expectSqliteWriteBudget({ scenario: "native-review-retirement",
      note: "One native review start and terminal completion, retaining its parent result and archiving only the review helper; no timer or idle writes.", writes });
    const kept = terminal === "new work" || terminal === "archive failure";
    expect(child.archived === true).toBe(!kept);
    expect(parent.archived).toBeUndefined();
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
    expect(ArchiveWorktreeTransport.requests.filter((request) => request.method === "thread/unsubscribe" && request.params.threadId === child.id)).toHaveLength(kept ? 0 : 1);
    const subAgent = await instance.store.getThreadSubAgent({ backend: "codex", threadId: parent.id, monitorId: "review:native-review-turn" });
    expect(subAgent?.monitorThreadId).toBe(child.id);
    expect(["success", "cancelled", "failed"]).toContain(subAgent?.status);
  });

  it.each(["parent", "ordinary", "wrong parent", "unknown"])("does not retire a live or unrelated checkout owner (%s)", async (kind) => {
    const fixture = await createFixture();
    const child: ArchiveWorktreeThread = { id: "review-child", cwd: fixture.worktree, source: kind === "ordinary" ? "cli" : "subAgentReview",
      ...(kind === "ordinary" ? {} : { wireSource: { subAgent: "review" as const }, threadSource: "subagent" as const }),
      parentThreadId: "actual-parent", status: kind === "unknown" ? { type: "systemError" } : { type: "notLoaded" } };
    ArchiveWorktreeTransport.threads = [child];
    const instance = fixture.reopen();
    expect(await instance.client.retireReviewThread({ threadId: child.id,
      parentThreadId: kind === "parent" ? child.id : kind === "wrong parent" ? "other-parent" : "actual-parent" })).toBe(false);
    expect(ArchiveWorktreeTransport.requests.some((request) => request.method === "thread/archive" || request.method === "thread/unsubscribe")).toBe(false);
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
  });

  it.each(["active", "unknown", "ordinary", "late-active"])("preserves a checkout with a real or uncertain review owner (%s)", async (kind) => {
    const fixture = await createFixture();
    const child: ArchiveWorktreeThread = { id: "review-child", cwd: fixture.worktree, source: kind === "ordinary" ? "cli" : "subAgentReview",
      ...(kind === "ordinary" ? {} : { wireSource: { subAgent: "review" as const }, threadSource: "subagent" as const }),
      status: kind === "active" ? { type: "active", activeFlags: [] } : kind === "unknown" ? undefined : { type: "notLoaded" } };
    ArchiveWorktreeTransport.threads = [{ id: "reviewed-parent", cwd: fixture.worktree, source: "cli" }, child];
    if (kind === "late-active") {
      let activeReads = 0;
      ArchiveWorktreeTransport.onList = (params) => {
        if (!params.archived && ++activeReads === 2) child.status = { type: "active", activeFlags: [] };
      };
    }
    const instance = fixture.reopen();
    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "reviewed-parent" });
    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: false })]);
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
  });

  it.each([false, true])("does not retain a checkout for six completed native review children after restart (repair=%s)", async (repair) => {
    const fixture = await createFixture(true);
    ArchiveWorktreeTransport.threads = [
      { id: "reviewed-parent", cwd: fixture.worktree, source: "cli", archived: repair },
      ...Array.from({ length: 6 }, (_, index): ArchiveWorktreeThread => ({
        id: `completed-review-${index}`, cwd: fixture.worktree, source: "subAgentReview",
        wireSource: { subAgent: "review" }, threadSource: "subagent", parentThreadId: "reviewed-parent", archived: index >= 3,
        status: { type: index % 2 ? "idle" : "notLoaded" },
      })),
    ];
    await writeFile(path.join(fixture.worktree, "file.txt"), "dirty parent edit\n");
    await writeFile(path.join(fixture.worktree, "notes.txt"), "untracked parent notes\n");
    const first = fixture.reopen();
    const result = repair ? await first.registry.repairArchivedThreadWorktrees()
      : await first.registry.archiveThread({ backend: "codex", threadId: "reviewed-parent" });
    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true })]);
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    for (let index = 0; index < 6; index += 1) {
      expect((await first.store.getThreadOverlayState({ backend: "codex", threadId: `completed-review-${index}` }))?.worktreeSnapshots ?? []).toEqual([]);
    }
    await first.registry.close();
    first.db.close();
    databases.splice(databases.indexOf(first.db), 1);
    const second = fixture.reopen();
    await second.registry.restoreThread({ backend: "codex", threadId: "reviewed-parent" });
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("dirty parent edit\n");
    expect(await readFile(path.join(fixture.worktree, "notes.txt"), "utf8")).toBe("untracked parent notes\n");
  });

  it.each([
    { kind: "source", status: "notLoaded" },
    { kind: "source", status: "idle" },
    { kind: "threadSource", status: "notLoaded" },
    { kind: "threadSource", status: "idle" },
  ] as const)("archives and restores a worktree with a $status Guardian review identified by $kind", async ({ kind, status }) => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [
      { id: "old-target", cwd: fixture.worktree, source: "cli" },
      {
        id: "guardian-review", cwd: fixture.worktree, source: "subAgentOther", status: { type: status },
        // thread/list omits threadSource; thread/read can return guardian_review.
        wireSource: kind === "source" ? { subAgent: { other: "guardian" } } : undefined,
        threadSource: kind === "threadSource" ? "guardian_review" : null,
      },
    ];
    await writeFile(path.join(fixture.worktree, "file.txt"), "work preserved past the approval review\n");
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true, worktreePath: fixture.worktree })]);
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(ArchiveWorktreeTransport.threads.find((thread) => thread.id === "guardian-review")?.archived).toBeUndefined();
    await instance.registry.restoreThread({ backend: "codex", threadId: "old-target" });
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("work preserved past the approval review\n");
  });

  it.each([
    { type: "active", activeFlags: [] },
    { type: "systemError" },
    undefined,
  ] satisfies ArchiveWorktreeThread["status"][])("keeps a worktree when a Guardian review has active or uncertain status %j", async (status) => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [
      { id: "old-target", cwd: fixture.worktree, source: "cli" },
      {
        id: "guardian-review", cwd: fixture.worktree, source: "subAgentOther",
        wireSource: { subAgent: { other: "guardian" } }, threadSource: null, status,
      },
    ];
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup[0]?.skippedReason).toContain("another active thread: guardian-review");
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
  });

  it("rechecks Guardian activity before removing the worktree", async () => {
    const fixture = await createFixture();
    const guardian: ArchiveWorktreeThread = {
      id: "guardian-review", cwd: fixture.worktree, source: "subAgentOther",
      wireSource: { subAgent: { other: "guardian" } }, threadSource: null, status: { type: "notLoaded" },
    };
    ArchiveWorktreeTransport.threads = [
      { id: "old-target", cwd: fixture.worktree, source: "cli" }, guardian,
    ];
    let activeReads = 0;
    ArchiveWorktreeTransport.onList = (params) => {
      if (!params.archived && ++activeReads === 2) guardian.status = { type: "active", activeFlags: [] };
    };
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(activeReads).toBe(2);
    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.error).toContain("Worktree is still used by another active thread");
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
  });

  it("continues past a page containing only inactive Guardian reviews to find a real checkout user", async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [
      { id: "old-target", cwd: fixture.worktree, source: "cli" },
      ...Array.from({ length: 25 }, (_, index): ArchiveWorktreeThread => ({
        id: `guardian-review-${index}`, cwd: fixture.worktree, source: "subAgentOther",
        wireSource: { subAgent: { other: "guardian" } }, threadSource: null, status: { type: "notLoaded" },
      })),
      { id: "real-user", cwd: fixture.worktree, source: "cli", status: { type: "notLoaded" } },
    ];
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup[0]?.skippedReason).toBe("Worktree is still used by another active thread: real-user.");
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
  });

  it("finds an old target on a later archived page and retains its recovery snapshot", async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [
      ...Array.from({ length: 100 }, (_, index) => ({ id: `older-archive-${index}`, cwd: fixture.repo, source: "cli", archived: true })),
      { id: "old-target", cwd: fixture.worktree, source: "cli" },
    ];
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup[0]?.removedWorktree).toBe(true);
    const pages = ArchiveWorktreeTransport.requests.filter((request) => request.method === "thread/list");
    // The target must cross a real page boundary even with 100-row metadata
    // pages. The promise is complete discovery and a retained recovery ref.
    expect(pages.some((request) => request.params.archived && request.params.cursor)).toBe(true);
    expect(pages.every((request) => Number(request.params.limit) <= 100 && request.params.useStateDbOnly === true)).toBe(true);
    expect((await instance.store.getThreadOverlayState({ backend: "codex", threadId: "old-target" }))?.worktreeSnapshots)
      .toEqual([expect.objectContaining({ state: "archived" })]);
  });

  it("accepts a delayed matching archive notification through the production provider subscriber", async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [{ id: "old-target", cwd: fixture.worktree, source: "cli" }];
    let activeReads = 0;
    ArchiveWorktreeTransport.onList = (params, transport) => {
      if (!params.archived && ++activeReads === 2) transport.emitNotification({ method: "thread/archived", params: { threadId: "old-target" } });
    };
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup[0]?.removedWorktree).toBe(true);
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { method: "thread/name/updated", params: { threadId: "unrelated", threadName: "Updated title" } },
    { method: "thread/status/changed", params: { threadId: "unrelated", status: { type: "notLoaded" } } },
  ] as const)("archives and restores real work despite an unrelated $method notification during removal admission", async (notification) => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [{ id: "old-target", cwd: fixture.worktree, source: "cli" }];
    await writeFile(path.join(fixture.worktree, "file.txt"), "work retained by the snapshot\n");
    let activeReads = 0;
    ArchiveWorktreeTransport.onList = (params, transport) => {
      if (!params.archived && ++activeReads === 2) transport.emitNotification(notification);
    };
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true, worktreePath: fixture.worktree })]);
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fixture.git(fixture.repo, ["worktree", "list", "--porcelain"])).not.toContain(fixture.worktree);
    await instance.registry.restoreThread({ backend: "codex", threadId: "old-target" });
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("work retained by the snapshot\n");
  });

  it("keeps a worktree with an external ownership marker on a navigation-hidden archived user", async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [
      { id: "old-target", cwd: fixture.worktree, source: "cli" },
      { id: "external-owner", cwd: fixture.worktree, source: "appServer", originator: "companion-app", archived: true },
    ];
    const instance = fixture.reopen();
    await instance.store.addLinkedDirectory({
      backend: "codex", threadId: "external-owner", directory: { ...fixture.directory, worktreeOwnership: "external" },
    });

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup[0]?.skippedReason).toContain("Externally managed worktree");
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
  });

  it("refuses to remove a primary checkout mislabeled as the archived thread's worktree", async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [{ id: "old-target", cwd: fixture.repo, source: "cli" }];
    const instance = fixture.reopen({ ...fixture.directory, worktreePath: fixture.repo });

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.error).toMatch(/primary|main/i);
    expect(await readFile(path.join(fixture.repo, "file.txt"), "utf8")).toBe("original\n");
  });

  it("does not fall back to a partial interactive inventory when the provider rejects safety source filters", async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [
      { id: "old-target", cwd: fixture.worktree, source: "cli" },
      { id: "hidden-user", cwd: fixture.worktree, source: "subAgentThreadSpawn" },
    ];
    ArchiveWorktreeTransport.rejectSafetySources = true;
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.skippedReason).toContain("Unsupported safety source filter");
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
  });
});
