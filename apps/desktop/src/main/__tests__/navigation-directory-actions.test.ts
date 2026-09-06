import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent, NavigationDirectorySummary } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";
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

let db: ReturnType<typeof openInMemoryStateDb>;
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
afterEach(() => { db.close(); mocks.listeners.clear(); vi.unstubAllEnvs(); });

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
