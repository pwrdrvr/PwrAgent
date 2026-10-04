import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent, NavigationDirectorySummary, NavigationThreadSummary } from "@pwragent/shared";
import type { FederationBackendOperations } from "../federation/federation-backend-bridge";
import { markAgentProjectRead } from "../app-server/agent-project-read";
import { buildPwrAgentThreadToolRouter } from "../agent-tools/pwragent-thread-agent-tools";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const mocks = vi.hoisted(() => ({ loadIndex: vi.fn(), publish: vi.fn(),
  listeners: new Set<(event: AgentEvent) => void>(), store: undefined as SqliteOverlayStore | undefined,
}));
vi.mock("../app-server/navigation-query-source", () => ({ loadLocalNavigationQueryIndex: mocks.loadIndex }));
vi.mock("../app-server/desktop-overlay-store", () => ({ getDesktopOverlayStore: () => mocks.store }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: () => ({
  publishLocalEvent: mocks.publish,
  onEvent: (listener: (event: AgentEvent) => void) => {
    mocks.listeners.add(listener);
    return () => { mocks.listeners.delete(listener); };
  },
}) }));
import { removeLocalNavigationDirectory } from "../app-server/navigation-directory-actions";
import { markLocalNavigationDirectorySeen } from "../app-server/navigation-directory-actions";

let db: ReturnType<typeof openInMemoryStateDb>;
let measuredTempDir: string | undefined;
const key = "directory:/repo";
const directory: NavigationDirectorySummary = { key, kind: "directory", label: "Repo", path: "/repo", threadKeys: [], needsAttentionCount: 0 };
beforeEach(async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  db = openInMemoryStateDb();
  mocks.store = new SqliteOverlayStore(db);
  mocks.loadIndex.mockReset().mockResolvedValue({ threads: [], directories: [directory] });
  mocks.publish.mockReset();
  await mocks.store.upsertDirectoryLaunchpad({ directoryKey: key, directoryKind: "directory", directoryLabel: "Repo", directoryPath: "/repo",
    backend: "codex", workMode: "local", executionMode: "default", prompt: "Unsent launchpad", createdAt: 1, updatedAt: 1, registeredAt: 1 });
  await mocks.store.setDirectoryPin({ directoryKey: key, pinned: true });
});
afterEach(() => {
  db.close();
  if (measuredTempDir) removeTempStateDbDir(measuredTempDir);
  measuredTempDir = undefined;
  mocks.listeners.clear();
  vi.unstubAllEnvs();
});

it("rejects unloaded owner membership without clearing registration or pin", async () => {
  mocks.loadIndex.mockResolvedValue({ threads: [], directories: [{ ...directory, threadKeys: ["codex:unloaded"] }] });
  const { writes } = await measureSqliteWrites(async () => {
    await expect(removeLocalNavigationDirectory({ directoryKey: key })).rejects.toThrow("contains threads");
  });
  expect(writes.commits).toBe(0);
  expect((await mocks.store!.getDirectoryLaunchpad({ directoryKey: key }))?.prompt).toBe("Unsent launchpad");
  expect((await mocks.store!.getDirectoryOverlayState({ directoryKey: key }))?.pinnedRank).toBe("1024");
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(mocks.listeners.size).toBe(0);
});

it("removes an empty owner registration and pin atomically", async () => {
  const { writes } = await measureSqliteWrites(() => removeLocalNavigationDirectory({ directoryKey: key }));
  expect(await mocks.store!.getDirectoryLaunchpad({ directoryKey: key })).toBeUndefined();
  expect((await mocks.store!.getDirectoryOverlayState({ directoryKey: key }))?.pinnedRank).toBeUndefined();
  expect(mocks.publish).toHaveBeenCalledWith({ backend: "codex", notification: { method: "navigation/directory/removed", params: { directoryKey: key } } });
  expectSqliteWriteBudget({ scenario: "navigation-remove-empty-directory", writes,
    note: "Owner membership check and removal: one transaction deletes registration and clears pin; 100 removals/day at ~8 KiB/commit is ~0.8 MB/day; no idle writes" });
});

it("rejects a membership check invalidated during the owner read", async () => {
  mocks.loadIndex.mockImplementation(async () => {
    for (const listener of mocks.listeners) listener({ backend: "codex", notification: { method: "directory/pin/removed", params: { directoryKey: key } } });
    return { threads: [], directories: [directory] };
  });
  await expect(removeLocalNavigationDirectory({ directoryKey: key })).rejects.toThrow("Owner state changed");
  expect(await mocks.store!.getDirectoryLaunchpad({ directoryKey: key })).toBeDefined();
  expect(mocks.listeners.size).toBe(0);
});

it("marks all owner directory members read in one transaction with no renderer allowlist", async () => {
  const { markLocalNavigationDirectorySeen } = await import("../app-server/navigation-directory-actions");
  const threads = Array.from({ length: 100 }, (_, index) => ({ id: `thread-${index}`, source: "codex" as const,
    title: `Thread ${index}`, titleSource: "derived" as const, linkedDirectories: [],
    inbox: { inInbox: true }, updatedAt: index + 1,
  }));
  mocks.loadIndex.mockResolvedValue({ threads, directories: [{ ...directory, threadKeys: threads.map((thread) => `codex:${thread.id}`) }] });
  const { writes, result } = await measureSqliteWrites(() => markLocalNavigationDirectorySeen({ directoryKey: key }));
  expect(result).toEqual({ directoryKey: key, changedCount: 100 });
  expect(writes.commits).toBe(1);
  expect(await mocks.store!.getThreadOverlayState({ backend: "codex", threadId: "thread-99" })).toMatchObject({ lastSeenUpdatedAt: 100 });
  expect(mocks.publish).toHaveBeenCalledWith({ backend: "codex", notification: { method: "navigation/directory/seen", params: result } });
  expectSqliteWriteBudget({ scenario: "navigation-mark-directory-seen-100-threads", writes,
    note: "Explicit owner directory action commits 100 watermarks in one transaction, no per-thread commits or idle writes; conservative 4 KiB/row is ~0.4 MB/action (~4 MB/day at 10 such actions)" });
  mocks.loadIndex.mockResolvedValue({ threads: threads.map((thread) => ({ ...thread, inbox: { inInbox: false } })), directories: [{ ...directory, threadKeys: threads.map((thread) => `codex:${thread.id}`) }] });
  const repeated = await measureSqliteWrites(() => markLocalNavigationDirectorySeen({ directoryKey: key }));
  expect(repeated.result.changedCount).toBe(0);
  expect(repeated.writes.commits).toBe(0);
});

it("does not mark unread state when owner directory membership is incomplete", async () => {
  const { markLocalNavigationDirectorySeen } = await import("../app-server/navigation-directory-actions");
  mocks.loadIndex.mockResolvedValue({ threads: [], directories: [{ ...directory, threadKeys: ["codex:unloaded"] }] });
  const { writes } = await measureSqliteWrites(async () => {
    await expect(markLocalNavigationDirectorySeen({ directoryKey: key })).rejects.toThrow("resolved completely");
  });
  expect(writes.commits).toBe(0);
  expect(mocks.publish).not.toHaveBeenCalled();
});

it("marks 140 unread project members across backends through one agent call and one commit", async () => {
  db.close();
  const temp = createTempStateDb("agent-project-read-");
  measuredTempDir = temp.tempDir;
  db = StateDb.open(temp.dbPath);
  mocks.store = new SqliteOverlayStore(db);
  const threads: NavigationThreadSummary[] = Array.from({ length: 140 }, (_, index) => ({
    id: `thread-${index}`, source: index % 2 ? "acp:claude" : "codex",
    title: `Thread ${index}`, titleSource: "derived", linkedDirectories: [],
    inbox: { inInbox: true }, updatedAt: index + 1,
    ...(index === 0 ? { threadStatus: "active" as const } : {}),
  }));
  const alreadyRead: NavigationThreadSummary = { ...threads[0]!, id: "already-read", inbox: { inInbox: false } };
  const elsewhere: NavigationThreadSummary = { ...threads[0]!, id: "elsewhere" };
  mocks.loadIndex.mockResolvedValue({ threads: [...threads, alreadyRead, elsewhere], directories: [{
    ...directory, threadKeys: [...threads, alreadyRead].map((thread) => `${thread.source}:${thread.id}`),
  }] });
  const localMark = vi.fn(markLocalNavigationDirectorySeen);
  const runtime = {
    localFederationInstanceId: () => "local",
    localBackend: () => ({ markNavigationDirectorySeen: localMark }) as unknown as FederationBackendOperations,
    remoteBackend: vi.fn(),
  };
  const router = buildPwrAgentThreadToolRouter(async (request) => {
    if (request.operation !== "mark_project_read") throw new Error("Unexpected operation");
    return { ok: true, data: { projectRead: await markAgentProjectRead(runtime, request.args) } };
  });
  const { result, writes } = await measureSqliteWrites(() => router.handleDynamicToolCall({
    backend: "codex", call: { threadId: "manager", turnId: "turn-1", callId: "call-1",
      namespace: "pwragent", tool: "mark_project_read", arguments: { projectKey: key } },
  }));
  expect(result.success).toBe(true);
  const output = result.contentItems[0];
  if (!output || output.type !== "inputText") throw new Error("Expected a text result");
  expect(JSON.parse(output.text)).toEqual({ projectRead: {
    projectKey: key, instanceId: "local", isLocal: true, changedCount: 140,
  } });
  expect(localMark).toHaveBeenCalledExactlyOnceWith({ directoryKey: key });
  expect(writes.commits).toBe(1);
  expect(writes.walBytes).toBeGreaterThan(0);
  for (const thread of threads) {
    expect(await mocks.store!.getThreadOverlayState({ backend: thread.source, threadId: thread.id }))
      .toMatchObject({ lastSeenUpdatedAt: thread.updatedAt });
  }
  expect(await mocks.store!.getThreadOverlayState({ backend: "codex", threadId: "already-read" })).toBeUndefined();
  expect(await mocks.store!.getThreadOverlayState({ backend: "codex", threadId: "elsewhere" })).toBeUndefined();
  expect(mocks.publish).toHaveBeenCalledExactlyOnceWith({ backend: "codex", notification: {
    method: "navigation/directory/seen", params: { directoryKey: key, changedCount: 140 },
  } });
  expectSqliteWriteBudget({ scenario: "agent-project-mark-read-140-threads", writes,
    note: "One explicit agent call marks 140 unread owner members across backends in one commit; observed ~0.054 MB/action (~0.54 MB/day at 10 actions), no idle writes" });
});

it.each(["checking", "degraded"] as const)("rejects directory actions while provider coverage is %s", async (state) => {
  const { markLocalNavigationDirectorySeen } = await import("../app-server/navigation-directory-actions");
  mocks.loadIndex.mockResolvedValue({ threads: [], directories: [directory], coverage: { state } });
  const { writes } = await measureSqliteWrites(async () => {
    await expect(markLocalNavigationDirectorySeen({ directoryKey: key })).rejects.toThrow("providers are ready");
    await expect(removeLocalNavigationDirectory({ directoryKey: key })).rejects.toThrow("providers are ready");
  });
  expect(writes.commits).toBe(0);
  expect(await mocks.store!.getDirectoryLaunchpad({ directoryKey: key })).toBeDefined();
});


it("archives unloaded members before rechecking and removing the registration", async () => {
  mocks.loadIndex.mockResolvedValueOnce({ threads: [{ id: "unloaded", source: "codex" }],
    directories: [{ ...directory, threadKeys: ["codex:unloaded"] }] });
  const archive = vi.fn(async () => undefined);
  const { writes } = await measureSqliteWrites(() => removeLocalNavigationDirectory({ directoryKey: key, archiveThreads: true }, archive));
  expect(archive).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "unloaded" });
  expect(mocks.loadIndex).toHaveBeenCalledTimes(2);
  expect(await mocks.store!.getDirectoryLaunchpad({ directoryKey: key })).toBeUndefined();
  expectSqliteWriteBudget({ scenario: "navigation-archive-project-registration", writes,
    note: "Archive orchestration with provider mocked: one existing registration removal commit (~8 KiB); 100 projects/day is ~0.8 MB/day plus unchanged provider archive costs; no idle writes" });
});

it("retains the project when a member fails to archive", async () => {
  mocks.loadIndex.mockResolvedValue({ threads: [{ id: "unloaded", source: "codex" }],
    directories: [{ ...directory, threadKeys: ["codex:unloaded"] }] });
  await expect(removeLocalNavigationDirectory({ directoryKey: key, archiveThreads: true }, async () => {
    throw new Error("Archive failed");
  })).rejects.toThrow("Archive failed");
  expect(await mocks.store!.getDirectoryLaunchpad({ directoryKey: key })).toBeDefined();
  expect(mocks.publish).not.toHaveBeenCalled();
});

it("retains a project if new threads arrive while archiving", async () => {
  mocks.loadIndex.mockResolvedValueOnce({ threads: [{ id: "old", source: "codex" }],
    directories: [{ ...directory, threadKeys: ["codex:old"] }] })
    .mockResolvedValueOnce({ threads: [{ id: "new", source: "codex" }],
      directories: [{ ...directory, threadKeys: ["codex:new"] }] });
  await expect(removeLocalNavigationDirectory({ directoryKey: key, archiveThreads: true }, async () => undefined))
    .rejects.toThrow("contains threads");
  expect(await mocks.store!.getDirectoryLaunchpad({ directoryKey: key })).toBeDefined();
});

it("refuses incomplete archive membership before archiving any thread", async () => {
  mocks.loadIndex.mockResolvedValue({ threads: [], directories: [{ ...directory, threadKeys: ["codex:missing"] }] });
  const archive = vi.fn();
  await expect(removeLocalNavigationDirectory({ directoryKey: key, archiveThreads: true }, archive))
    .rejects.toThrow("resolved completely");
  expect(archive).not.toHaveBeenCalled();
});


it("archives the Workspaces group without removing its permanent navigation entry", async () => {
  const workspaceKey = "workspace:/scratch";
  mocks.loadIndex.mockResolvedValue({ threads: [{ id: "scratch", source: "codex" }],
    directories: [{ ...directory, key: workspaceKey, kind: "workspace", threadKeys: ["codex:scratch"] }] });
  const archive = vi.fn(async () => undefined);
  await expect(removeLocalNavigationDirectory({ directoryKey: workspaceKey, archiveThreads: true }, archive))
    .resolves.toEqual({ directoryKey: workspaceKey, cleanup: [] });
  expect(archive).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "scratch" });
  expect(mocks.publish).not.toHaveBeenCalled();
});
