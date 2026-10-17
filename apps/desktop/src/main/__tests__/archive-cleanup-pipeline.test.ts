import { afterEach, describe, expect, it, vi } from "vitest";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent, AppServerThreadSummary, ThreadOverlayState } from "@pwragent/shared";
import { ARCHIVE_CLEANUP_PAUSE_MS } from "../app-server/archive-cleanup-queue";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { deleteThreadAssets } from "../app-server/thread-assets";
import { CountingBackendClient, codexThread, publishNotification } from "./fixtures/thread-read-harness";
import budgets from "./fixtures/archive-cleanup-budgets.json";

vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../app-server/worktree-container-service", () => ({ WorktreeContainerService: class {
  // Every path in this harness is outside the managed root. Keep container
  // discovery free of host I/O just like the contrived Git/stat operations.
  async containerPath(_worktreePath: string): Promise<undefined> { return undefined; }
  comparisonPaths(containerPath: string): string[] { return [containerPath]; }
  worktreeComparisonPaths(worktreePath: string): string[] { return [worktreePath]; }
} }));
vi.mock("../app-server/thread-assets", async (importOriginal) => ({
  ...await importOriginal<typeof import("../app-server/thread-assets")>(),
  // The registry delivers `thread/deleted` only after removing the thread's
  // owned asset directories, and a test publishes it from inside an inventory
  // read. These threads own no assets, and advancing fake timers cannot
  // complete the host `rm` calls the real cleanup makes.
  deleteThreadAssets: vi.fn(async () => {}),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // The worktree service is contrived, so its post-removal sentinel must be
    // contrived too. Advancing fake timers cannot complete host filesystem I/O.
    stat: vi.fn(async (filePath: Parameters<typeof actual.stat>[0], options?: Parameters<typeof actual.stat>[1]) => {
      if (typeof filePath === "string" && filePath.startsWith("/contrived/")) {
        throw Object.assign(new Error("Contrived worktree was removed."), { code: "ENOENT" });
      }
      return await actual.stat(filePath, options);
    }),
  };
});

/**
 * Runs archive cleanup to completion under fake timers. The clock advances only
 * while cleanup is parked on its checkpoint pause, the one timer it owns.
 * Between checkpoints it awaits provider, DB, and filesystem work that no clock
 * advance completes. Slicing the clock on a budget instead ran out on a loaded
 * runner while the real thread-asset `rm` was in flight; 500 slices cover well
 * under 50 ms of wall time. The stub above removes that I/O; this pacer keeps
 * the next host call on the path from needing one.
 */
async function drivePacer<T>(registry: DesktopBackendRegistry, promise: Promise<T>): Promise<T> {
  let settled = false;
  const settlement = promise.then(() => { settled = true; }, () => { settled = true; });
  for (;;) {
    await Promise.race([settlement, registry.whenArchiveCleanupCheckpointPendingForTests()]);
    if (settled) return await promise;
    await vi.advanceTimersByTimeAsync(ARCHIVE_CLEANUP_PAUSE_MS);
  }
}

const registries: DesktopBackendRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  vi.mocked(stat).mockReset();
  vi.mocked(deleteThreadAssets).mockClear();
  vi.useRealTimers();
});

function build(active: AppServerThreadSummary[], target = codexThread({ id: "target" })) {
  const overlays = new Map<string, ThreadOverlayState>();
  let archived: AppServerThreadSummary[] = [];
  const counts = { aggregateLists: 0, archiveMutations: 0, providerPages: 0, largestProviderPage: 0, overlayReads: 0, largestOverlaySlice: 0 };
  const client = Object.assign(new CountingBackendClient([...active, target]), {
    archiveThread: vi.fn(async ({ threadId }: { threadId: string }) => {
      counts.archiveMutations += 1;
      archived = [target];
      return { threadId };
    }),
    listThreads: vi.fn(async (): Promise<AppServerThreadSummary[]> => { counts.aggregateLists += 1; throw new Error("Broad discovery is outside the archive budget."); }),
    listArchiveCleanupThreadsPage: vi.fn(async (params: { archived: boolean; cursor?: string; limit: number }) => {
      counts.providerPages += 1;
      counts.largestProviderPage = Math.max(counts.largestProviderPage, params.limit);
      const rows = params.archived ? archived : active;
      const offset = Number(params.cursor ?? 0);
      const threads = rows.slice(offset, offset + params.limit);
      return { threads, nextCursor: offset + threads.length < rows.length ? String(offset + threads.length) : undefined };
    }),
  });
  const readOverlays = vi.fn(async ({ threadIds }: { threadIds: string[] }) => {
    counts.overlayReads += 1;
    counts.largestOverlaySlice = Math.max(counts.largestOverlaySlice, threadIds.length);
    return Object.fromEntries(threadIds.map((id) => [id, overlays.get(id)]));
  });
  const store = new Proxy({
    getArchiveCleanupOverlayStates: readOverlays,
    getThreadListingOverlayStates: readOverlays,
    getThreadOverlayStates: readOverlays,
    getThreadOverlayState: vi.fn(async ({ threadId }: { threadId: string }) => overlays.get(threadId)),
    setThreadParent: vi.fn(async (_request: { threadId: string }) => {}),
    setThreadArchiveTombstone: vi.fn(async (_request: { threadId: string; archivedAt: number }) => {}),
  }, { get(object, key) {
    if (key === "then") return undefined;
    if (key in object) return object[key as keyof typeof object];
    return vi.fn(async () => String(key).startsWith("list") ? [] : undefined);
  } });
  const archiveWorktree = vi.fn(async (params: { backend: string; threadId: string; worktreePath: string; beforeRemove?: () => Promise<() => void> }) => {
    const assertRemoval = await params.beforeRemove?.();
    assertRemoval?.();
    return { id: "snapshot", backend: params.backend, threadId: params.threadId, worktreePath: params.worktreePath,
      repositoryPath: "/contrived/repo", snapshotRef: "refs/codex/snapshots/test", snapshotCommit: "abc",
      createdAt: 1, archivedAt: 2, state: "archived", ignoredFilesExcluded: true };
  });
  const registry = new DesktopBackendRegistry({ codexClient: client as never, overlayStore: store as never,
    worktreeArchiveService: { archive: archiveWorktree } as never, threadTitleGenerationService: null });
  registries.push(registry);
  const events: AgentEvent[] = [];
  const completion = new Promise<AgentEvent>((resolve) => {
    registry.onEvent((event) => {
      events.push(event);
      if (event.notification.method === "thread/archiveCleanup/completed") resolve(event);
    });
  });
  return { registry, client, counts, events, overlays, store, archiveWorktree, completion };
}

function buildArchiveBurst(active: AppServerThreadSummary[], targets: AppServerThreadSummary[], history: AppServerThreadSummary[] = []) {
  const fixture = build(active);
  const archived = [...history];
  fixture.client.archiveThread.mockImplementation(async ({ threadId }) => {
    fixture.counts.archiveMutations += 1;
    archived.push(targets.find((thread) => thread.id === threadId)!);
    return { threadId };
  });
  fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
    fixture.counts.providerPages += 1;
    const rows = params.archived ? archived : active;
    const offset = Number(params.cursor ?? 0);
    const threads = rows.slice(offset, offset + params.limit);
    return { threads, nextCursor: offset + threads.length < rows.length ? String(offset + threads.length) : undefined };
  });
  const completions: AgentEvent[] = [];
  const finished = new Promise<void>((resolve) => {
    fixture.registry.onEvent((event) => {
      if (event.notification.method !== "thread/archiveCleanup/completed") return;
      completions.push(event);
      if (completions.length === targets.length) resolve();
    });
  });
  return { ...fixture, completions, finished };
}

describe("archive cleanup pipeline", () => {
  it("shares ownership discovery across a 130-thread archive burst", async () => {
    vi.useFakeTimers();
    const directory = { id: "shared", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/shared" };
    const active = Array.from({ length: 1000 }, (_, id) => codexThread({ id: `active-${id}` }));
    active[0] = codexThread({ id: "shared-user", linkedDirectories: [directory] });
    const targets = Array.from({ length: 130 }, (_, id) => codexThread({ id: `target-${id}`, linkedDirectories: [directory] }));
    const fixture = buildArchiveBurst(active, targets,
      Array.from({ length: 500 }, (_, id) => codexThread({ id: `historical-${id}` })),
    );
    await Promise.all(targets.map((thread) => fixture.registry.archiveThread({ backend: "codex", threadId: thread.id, backgroundCleanup: true })));
    await drivePacer(fixture.registry, fixture.finished);
    expect(fixture.completions).toHaveLength(130);
    for (const event of fixture.completions) {
      expect(event.notification.params).toMatchObject({ cleanup: [expect.objectContaining({ skippedReason: expect.stringContaining("shared-user") })] });
    }
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    // One inventory: 40 active pages and 26 archived pages, rather than
    // rebuilding those 66 pages for each of the 130 queued threads.
    expect(fixture.counts.providerPages).toBe(66);
  });

  it.each(["during discovery", "between jobs"])("refreshes batch discovery after a workspace change %s", async (timing) => {
    vi.useFakeTimers();
    const firstDirectory = { id: "first", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/first" };
    const secondDirectory = { ...firstDirectory, id: "second", worktreePath: "/contrived/second" };
    const active = [codexThread({ id: "first-user", linkedDirectories: [firstDirectory] })];
    const targets = [codexThread({ id: "first", linkedDirectories: [firstDirectory] }), codexThread({ id: "second", linkedDirectories: [secondDirectory] })];
    const fixture = buildArchiveBurst(active, targets);
    const changeWorkspace = async () => {
      active.push(codexThread({ id: "new-user", linkedDirectories: [secondDirectory] }));
      await publishNotification(fixture.registry, { method: "navigation/threadDirectories/updated",
        params: { reason: "selected-thread", threadIds: ["new-user"] } });
    };
    if (timing === "during discovery") {
      const read = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
      let changed = false;
      fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
        if (params.archived && !changed) { changed = true; await changeWorkspace(); }
        return await read(params);
      });
    } else {
      fixture.registry.onEvent((event) => {
        if (event.notification.method === "thread/archiveCleanup/completed" && event.notification.params.threadId === "first") {
          void changeWorkspace();
        }
      });
    }
    await Promise.all(targets.map((thread) => fixture.registry.archiveThread({ backend: "codex", threadId: thread.id, backgroundCleanup: true })));
    await drivePacer(fixture.registry, fixture.finished);
    expect(fixture.completions[1]?.notification.params).toMatchObject({ cleanup: [expect.objectContaining({ skippedReason: expect.stringContaining("new-user") })] });
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    expect(fixture.counts.providerPages).toBe(4);
  });

  it("rechecks live ownership before removal even when preliminary discovery was reused", async () => {
    vi.useFakeTimers();
    const directory = { id: "second", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/second" };
    const active: AppServerThreadSummary[] = [];
    const targets = [codexThread({ id: "first" }), codexThread({ id: "second", linkedDirectories: [directory] })];
    const fixture = buildArchiveBurst(active, targets);
    fixture.registry.onEvent((event) => {
      if (event.notification.method === "thread/archiveCleanup/completed" && event.notification.params.threadId === "first") {
        // Model a provider change whose notification has not arrived yet.
        active.push(codexThread({ id: "new-user", linkedDirectories: [directory] }));
      }
    });
    await Promise.all(targets.map((thread) => fixture.registry.archiveThread({ backend: "codex", threadId: thread.id, backgroundCleanup: true })));
    await drivePacer(fixture.registry, fixture.finished);
    expect(fixture.completions[1]?.notification.params).toMatchObject({ cleanup: [expect.objectContaining({ removedWorktree: false, error: expect.stringContaining("still used") })] });
    expect(fixture.counts.providerPages).toBe(4);
    expect(fixture.archiveWorktree).toHaveBeenCalledOnce();
  });

  it("selects each parent's own children from the shared inventory", async () => {
    vi.useFakeTimers();
    const targets = [codexThread({ id: "first" }), codexThread({ id: "second" })];
    const fixture = buildArchiveBurst([codexThread({ id: "child-first" }), codexThread({ id: "child-second" })], targets);
    for (const thread of targets) fixture.overlays.set(`child-${thread.id}`, {
      backend: "codex", threadId: `child-${thread.id}`, extraLinkedDirectories: [],
      parentThreadId: thread.id, parentThreadBackend: "codex",
    });
    await Promise.all(targets.map((thread) => fixture.registry.archiveThread({ backend: "codex", threadId: thread.id, backgroundCleanup: true })));
    await drivePacer(fixture.registry, fixture.finished);
    expect(fixture.store.setThreadParent.mock.calls.map(([request]) => request.threadId)).toEqual(["child-first", "child-second"]);
    expect(fixture.counts.providerPages).toBe(2);
  });

  it("refreshes cached children when a thread is regrouped between cleanup jobs", async () => {
    vi.useFakeTimers();
    const targets = [codexThread({ id: "first" }), codexThread({ id: "second" })];
    const fixture = buildArchiveBurst([codexThread({ id: "child" })], targets);
    fixture.overlays.set("child", { backend: "codex", threadId: "child", extraLinkedDirectories: [], parentThreadId: "first", parentThreadBackend: "codex" });
    fixture.registry.onEvent((event) => {
      if (event.notification.method === "thread/archiveCleanup/completed" && event.notification.params.threadId === "first") {
        fixture.overlays.set("child", { backend: "codex", threadId: "child", extraLinkedDirectories: [], parentThreadId: "second", parentThreadBackend: "codex" });
        void publishNotification(fixture.registry, { method: "thread/parent/set",
          params: { threadId: "child", parentThreadId: "second", parentThreadBackend: "codex" } });
      }
    });
    await Promise.all(targets.map((thread) => fixture.registry.archiveThread({ backend: "codex", threadId: thread.id, backgroundCleanup: true })));
    await drivePacer(fixture.registry, fixture.finished);
    expect(fixture.store.setThreadParent).toHaveBeenCalledTimes(2);
    expect(fixture.counts.providerPages).toBe(4);
  });

  it("retains an inaccessible historical path while discovering other repair candidates", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    const rows = ["denied", "valid"].map((id) => codexThread({ id, linkedDirectories: [{
      id, kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: `/contrived/${id}`,
    }] }));
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => ({ threads: params.archived ? rows : [], nextCursor: undefined }));
    vi.mocked(stat).mockImplementation(async (filePath) => {
      if (filePath === path.normalize("/contrived/denied")) throw Object.assign(new Error("Access denied"), { code: "EACCES" });
      return { isDirectory: () => true } as Awaited<ReturnType<typeof stat>>;
    });
    const scan = fixture.registry.repairArchivedThreadWorktrees({ dryRun: true });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await scan;
    expect(result.cleanup).toEqual([expect.objectContaining({ worktreePath: path.normalize("/contrived/denied"), removedWorktree: false, error: "Access denied" })]);
    expect(result.candidates).toEqual([{ backend: "codex", threadId: "valid", worktreePath: path.normalize("/contrived/valid") }]);
  });

  it("discovers more than 500 archived worktrees in bounded pages without mutating them", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    const archived = Array.from({ length: 501 }, (_, index) => codexThread({ id: `archived-${index}`, linkedDirectories: [{
      id: String(index), kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: `/contrived/worktree-${index}`,
    }] }));
    const pages: number[] = [];
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      const rows = params.archived ? archived : [];
      const offset = Number(params.cursor ?? 0);
      const threads = rows.slice(offset, offset + params.limit);
      pages.push(threads.length);
      return { threads, nextCursor: offset + threads.length < rows.length ? String(offset + threads.length) : undefined };
    });
    vi.mocked(stat).mockImplementation(async () => ({ isDirectory: () => true }) as Awaited<ReturnType<typeof stat>>);
    const scan = fixture.registry.repairArchivedThreadWorktrees({ dryRun: true });
    await vi.advanceTimersByTimeAsync(100_000);
    const result = await scan;
    expect(result.archivedThreads).toBe(501);
    expect(result.candidates).toHaveLength(501);
    expect(pages).toHaveLength(22);
    expect(Math.max(...pages)).toBe(25);
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    expect(fixture.client.archiveThread).not.toHaveBeenCalled();
  });

  it("acknowledges before discovery and bounds each provider/overlay slice for 1000 active threads", async () => {
    vi.useFakeTimers();
    const fixture = build(Array.from({ length: 1000 }, (_, id) => codexThread({ id: `active-${id}` })));
    const request = fixture.registry.archiveThread({ backend: "codex", threadId: "target", backgroundCleanup: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.counts.archiveMutations).toBe(1);
    expect(await request).toMatchObject({ cleanupPending: true, cleanup: [] });
    expect(fixture.counts.providerPages).toBe(0);
    await vi.advanceTimersToNextTimerAsync();
    // Admission itself yields, then the provider page gets its own slice.
    expect(fixture.counts.providerPages).toBe(0);
    await vi.advanceTimersToNextTimerAsync();
    expect(fixture.counts.providerPages).toBe(1);
    expect(fixture.counts.overlayReads).toBe(0);
    await drivePacer(fixture.registry, fixture.completion);
    expect(fixture.counts).toEqual(budgets["1000-active-threads"]);
    expect(fixture.events.find((event) => event.notification.method === "thread/archiveCleanup/completed")?.notification.params)
      .toMatchObject({ threadId: "target", cleanup: [] });
  });

  it("coalesces duplicate archive requests by backend identity", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    const first = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    const second = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    await drivePacer(fixture.registry, first);
    expect(await first).toEqual(await second);
    expect(fixture.client.archiveThread).toHaveBeenCalledOnce();
    expect(fixture.counts.providerPages).toBe(2);
  });

  it.each([false, true])("removes a newly started thread's worktree before navigation acknowledges its workspace (background: %s)", async (backgroundCleanup) => {
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    Object.assign(fixture.client, { startThread: vi.fn(async () => ({ threadId: target.id })) });
    await fixture.registry.startThread({
      backend: "codex", cwd: "/contrived/worktree", linkedDirectories: target.linkedDirectories,
      mcpConnectionIds: [],
    });
    vi.useFakeTimers();

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: target.id, backgroundCleanup }));
    let cleanup: unknown = result.cleanup;
    if (backgroundCleanup) {
      const notification = (await drivePacer(fixture.registry, fixture.completion)).notification;
      if (notification.method !== "thread/archiveCleanup/completed") throw new Error("Expected archive cleanup completion.");
      cleanup = notification.params.cleanup;
    }

    expect(cleanup).toEqual([expect.objectContaining({
      removedWorktree: true, worktreePath: "/contrived/worktree",
    })]);
    expect(fixture.archiveWorktree).toHaveBeenCalledOnce();
    expect(stat).toHaveBeenCalledWith("/contrived/worktree");
    expect(fixture.counts.providerPages).toBe(4);
    expect(fixture.counts.aggregateLists).toBe(0);
  });

  it("retains the provisional active thread when the provider rejects archive", async () => {
    const fixture = build([]);
    Object.assign(fixture.client, { startThread: vi.fn(async () => ({ threadId: "target" })) });
    await fixture.registry.startThread({ backend: "codex", cwd: "/contrived/worktree", mcpConnectionIds: [] });
    fixture.client.archiveThread.mockRejectedValue(new Error("Archive rejected."));

    await expect(fixture.registry.archiveThread({ backend: "codex", threadId: "target" })).rejects.toThrow("Archive rejected.");

    fixture.client.listThreads.mockResolvedValue([]);
    expect(await fixture.registry.listThreads({ backend: "codex" })).toEqual([
      expect.objectContaining({ id: "target", projectKey: "/contrived/worktree" }),
    ]);
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
  });

  it.each([
    { method: "thread/archived", params: { threadId: "target" } },
    { method: "thread/deleted", params: { threadId: "target" } },
  ] as const)("retires provisional active metadata on $method", async (notification) => {
    const fixture = build([]);
    Object.assign(fixture.client, { startThread: vi.fn(async () => ({ threadId: "target" })) });
    await fixture.registry.startThread({ backend: "codex", cwd: "/contrived/worktree", mcpConnectionIds: [] });

    await publishNotification(fixture.registry, notification);

    fixture.client.listThreads.mockResolvedValue([]);
    expect(await fixture.registry.listThreads({ backend: "codex" })).toEqual([]);
  });

  it("keeps a worktree used by another newly started thread absent from provider listings", async () => {
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const fixture = build([], codexThread({ id: "target", linkedDirectories: [directory] }));
    Object.assign(fixture.client, { startThread: vi.fn(async () => ({ threadId: "shared-user" })) });
    await fixture.registry.startThread({
      backend: "codex", cwd: "/contrived/worktree", linkedDirectories: [directory], mcpConnectionIds: [],
    });
    vi.useFakeTimers();

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.skippedReason).toContain("another active thread: shared-user");
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
  });

  it("recovers retained active metadata after a confirmed missing rollout, including removal admission", async () => {
    vi.useFakeTimers();
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const target = codexThread({ id: "target", linkedDirectories: [directory] });
    const fixture = build([target], target);
    fixture.client.archiveThread.mockRejectedValue(new Error("json-rpc error (-32600): no rollout found for thread id target"));
    const result = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    // Observe rejection while driving the pacer so the failing regression is
    // not reported as an unhandled rejection by the test runner.
    const observed = result.then((response) => ({ response }), (error: Error) => ({ error }));
    expect(await drivePacer(fixture.registry, observed)).toMatchObject({ response: { cleanup: [expect.objectContaining({ removedWorktree: true })] } });
    expect(fixture.store.setThreadArchiveTombstone).toHaveBeenCalledWith(expect.objectContaining({ backend: "codex", threadId: "target" }));
    expect(fixture.counts.providerPages).toBe(4);
    expect(fixture.counts.aggregateLists).toBe(0);
  });

  it("recovers a missing rollout using only the newly started thread's retained workspace", async () => {
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    Object.assign(fixture.client, { startThread: vi.fn(async () => ({ threadId: target.id })) });
    await fixture.registry.startThread({
      backend: "codex", cwd: "/contrived/worktree", linkedDirectories: target.linkedDirectories, mcpConnectionIds: [],
    });
    fixture.client.archiveThread.mockRejectedValue(new Error("json-rpc error (-32600): no rollout found for thread id target"));
    vi.useFakeTimers();

    const result = fixture.registry.archiveThread({ backend: "codex", threadId: target.id });
    const observed = result.then((response) => ({ response }), (error: Error) => ({ error }));
    expect(await drivePacer(fixture.registry, observed)).toMatchObject({ response: { cleanup: [expect.objectContaining({ removedWorktree: true })] } });
    expect(fixture.store.setThreadArchiveTombstone).toHaveBeenCalledOnce();

    fixture.client.listThreads.mockResolvedValue([]);
    expect(await fixture.registry.listThreads({ backend: "codex" })).toEqual([]);
  });

  it("removes independent worktrees for concurrent synchronous archives after both provider mutations settle", async () => {
    vi.useFakeTimers();
    const targets = ["target", "second"].map((id) => codexThread({ id, linkedDirectories: [{
      id: `directory-${id}`, kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: `/contrived/${id}`,
    }] }));
    const fixture = build([], targets[0]);
    const archived: AppServerThreadSummary[] = [];
    fixture.client.archiveThread.mockImplementation(async ({ threadId }) => {
      archived.push(targets.find((target) => target.id === threadId)!);
      return { threadId };
    });
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async ({ archived: isArchived }) => ({ threads: isArchived ? archived : [], nextCursor: undefined }));
    const results = await drivePacer(fixture.registry, Promise.all(targets.map((target) =>
      fixture.registry.archiveThread({ backend: "codex", threadId: target.id }),
    )));
    expect(fixture.client.archiveThread).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.cleanup[0])).toEqual([
      expect.objectContaining({ removedWorktree: true, worktreePath: "/contrived/target" }),
      expect.objectContaining({ removedWorktree: true, worktreePath: "/contrived/second" }),
    ]);
    expect(stat).toHaveBeenCalledWith("/contrived/target");
    expect(stat).toHaveBeenCalledWith("/contrived/second");
  });

  it("waits for the removal sentinel before admitting the next queued cleanup", async () => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    let release!: () => void;
    const sentinelGate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const sentinelStarted = new Promise<void>((resolve) => { entered = resolve; });
    const defaultStat = vi.mocked(stat).getMockImplementation()!;
    vi.mocked(stat).mockImplementation(async (filePath, options) => {
      if (filePath !== "/contrived/worktree") return await defaultStat(filePath, options);
      entered();
      await sentinelGate;
      throw Object.assign(new Error("Contrived worktree was removed."), { code: "ENOENT" });
    });
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async ({ archived }) => {
      fixture.counts.providerPages += 1;
      return { threads: archived ? [target, codexThread({ id: "second" })] : [], nextCursor: undefined };
    });
    const first = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    const second = fixture.registry.archiveThread({ backend: "codex", threadId: "second" });
    let settled = false;
    const results = Promise.all([first, second]).then((responses) => { settled = true; return responses; });
    try {
      await drivePacer(fixture.registry, sentinelStarted);
      expect(stat).toHaveBeenCalledWith("/contrived/worktree");
      expect(settled).toBe(false);
      // Only the first job's initial and final admission inventories ran.
      expect(fixture.counts.providerPages).toBe(4);
    } finally { release(); }
    const responses = await drivePacer(fixture.registry, results);
    expect(responses[0].cleanup[0]?.removedWorktree).toBe(true);
    expect(fixture.counts.providerPages).toBe(6);
  });

  it("keeps rejecting active target metadata without confirmed missing-rollout recovery", async () => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target" });
    const fixture = build([target], target);
    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(result.cleanup[0]?.skippedReason).toContain("thread is active again");
    expect(fixture.store.setThreadArchiveTombstone).not.toHaveBeenCalled();
  });

  it.each(["active", "archived"] as const)("does not treat the target's delayed archive notification as a new workspace mutation during the final %s inventory", async (phase) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    const listPage = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
    let reads = 0;
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      if (++reads === (phase === "active" ? 3 : 4)) {
        await publishNotification(fixture.registry, { method: "thread/archived", params: { threadId: "target" } });
      }
      return await listPage(params);
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true })]);
    expect(fixture.counts.providerPages).toBe(4);
  });

  it.each([
    { active: false, archived: true, removes: true },
    { active: true, archived: true, removes: false },
    { active: true, archived: false, removes: false },
    { active: false, archived: false, removes: false },
  ])("requires unambiguous archived membership (active: $active, archived: $archived)", async (inventory) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    Object.assign(fixture.client, { readArchiveCleanupThreadSummary: vi.fn(async () => target) });
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async ({ archived }) => ({
      threads: (archived ? inventory.archived : inventory.active) ? [target] : [], nextCursor: undefined,
    }));

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.removedWorktree).toBe(inventory.removes);
    if (!inventory.removes) {
      expect(result.cleanup[0]?.skippedReason).toContain("metadata was not found or the thread is active again");
      expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    }
  });

  it.each([1, 2, 3, 4].flatMap((boundary) => [
    { boundary, notification: { method: "thread/unarchived" as const, params: { threadId: "target" } } },
    { boundary, notification: { method: "thread/deleted" as const, params: { threadId: "target" } } },
  ]))("cancels removal on $notification.method at inventory boundary $boundary", async ({ boundary, notification }) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    const listPage = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
    let reads = 0;
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      if (++reads === boundary) await publishNotification(fixture.registry, notification);
      return await listPage(params);
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.skippedReason ?? result.cleanup[0]?.error).toContain("cancelled");
    // Only permanent deletion releases the thread's assets; unarchive keeps them.
    expect(vi.mocked(deleteThreadAssets).mock.calls).toEqual(notification.method === "thread/deleted"
      ? [[{ backend: "codex", threadId: "target" }]]
      : []);
  });

  it("still rejects a different thread's archive notification during removal admission", async () => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    const listPage = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
    let reads = 0;
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      if (++reads === 3) await publishNotification(fixture.registry, { method: "thread/archived", params: { threadId: "other" } });
      return await listPage(params);
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.error).toContain("workspace state changed");
  });

  it.each([
    { method: "thread/name/updated", params: { threadId: "other", threadName: "Updated title" } },
    { method: "thread/status/changed", params: { threadId: "other", status: { type: "idle" } } },
    { method: "thread/status/changed", params: { threadId: "other", status: { type: "notLoaded" } } },
    { method: "thread/parent/cleared", params: { threadId: "other" } },
  ] as const)("removes the worktree when $method refreshes unrelated display metadata during admission", async (notification) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    const listPage = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
    let reads = 0;
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      if (++reads === 3) await publishNotification(fixture.registry, notification);
      return await listPage(params);
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true, worktreePath: "/contrived/worktree" })]);
    expect(fixture.counts.providerPages).toBe(4);
  });

  it("removes the worktree when navigation refreshes the now-archived thread during admission", async () => {
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    fixture.client.listThreads.mockResolvedValue([target]);
    await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false });
    fixture.client.listThreads.mockResolvedValue([]);
    vi.useFakeTimers();
    const listPage = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
    let reads = 0;
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      if (++reads === 3) await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false, forceRefresh: true });
      return await listPage(params);
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true, worktreePath: "/contrived/worktree" })]);
    expect(fixture.counts.providerPages).toBe(4);
  });

  it.each(["active", "systemError"])("keeps the worktree if an excluded checkout user becomes %s after the final inventory", async (type) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    fixture.archiveWorktree.mockImplementation(async (params) => {
      const assertRemoval = await params.beforeRemove?.();
      await publishNotification(fixture.registry, {
        method: "thread/status/changed", params: { threadId: "guardian-review", status: { type } },
      });
      assertRemoval?.();
      throw new Error("Removal should have been denied.");
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.error).toContain("workspace state changed");
  });

  it("keeps the worktree if navigation discovers a new active identity after the final inventory", async () => {
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    fixture.client.listThreads.mockResolvedValue([]);
    await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false });
    vi.useFakeTimers();
    fixture.archiveWorktree.mockImplementation(async (params) => {
      const assertRemoval = await params.beforeRemove?.();
      fixture.client.listThreads.mockResolvedValue([codexThread({ id: "new-user", linkedDirectories: target.linkedDirectories })]);
      await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false, forceRefresh: true });
      assertRemoval?.();
      throw new Error("Removal should have been denied.");
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.error).toContain("workspace state changed");
  });

  it.each([false, true])("keeps the worktree when navigation observes a checkout owner after the final inventory (previously listed: %s)", async (previouslyListed) => {
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    if (previouslyListed) {
      fixture.client.listThreads.mockResolvedValue([codexThread({ id: "owner", projectKey: "/contrived/other", linkedDirectories: [] })]);
      await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false });
    }
    vi.useFakeTimers();
    let removalAdmitted = false;
    fixture.archiveWorktree.mockImplementation(async (params) => {
      const assertRemoval = await params.beforeRemove?.();
      fixture.client.listThreads.mockResolvedValue([codexThread({ id: "owner", projectKey: "/contrived/worktree", linkedDirectories: [] })]);
      await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false, forceRefresh: true });
      assertRemoval?.();
      removalAdmitted = true;
      throw new Error("Removal should have been denied.");
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(removalAdmitted).toBe(false);
    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.error).toContain("workspace state changed");
  });

  it("keeps the worktree when navigation confirms an older owner observation missing from the final inventory", async () => {
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const owner = codexThread({ id: "owner", projectKey: "/contrived/worktree", linkedDirectories: [] });
    const fixture = build([], target);
    fixture.client.listThreads.mockResolvedValue([owner]);
    await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false });
    vi.useFakeTimers();
    let removalAdmitted = false;
    fixture.archiveWorktree.mockImplementation(async (params) => {
      const assertRemoval = await params.beforeRemove?.();
      await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false, forceRefresh: true });
      fixture.client.listThreads.mockResolvedValue([]);
      await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false, forceRefresh: true });
      assertRemoval?.();
      removalAdmitted = true;
      throw new Error("Removal should have been denied.");
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(removalAdmitted).toBe(false);
    expect(result.cleanup[0]?.error).toContain("workspace state changed");
  });

  it("keeps the worktree when an existing thread gains a linked checkout after the final inventory", async () => {
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    fixture.client.listThreads.mockResolvedValue([codexThread({ id: "owner", linkedDirectories: [] })]);
    await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false });
    vi.useFakeTimers();
    let removalAdmitted = false;
    fixture.archiveWorktree.mockImplementation(async (params) => {
      const assertRemoval = await params.beforeRemove?.();
      fixture.client.listThreads.mockResolvedValue([codexThread({ id: "owner", linkedDirectories: target.linkedDirectories })]);
      await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false, forceRefresh: true });
      assertRemoval?.();
      removalAdmitted = true;
      throw new Error("Removal should have been denied.");
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(removalAdmitted).toBe(false);
    expect(result.cleanup[0]?.error).toContain("workspace state changed");
  });

  it("removes the worktree when an unenriched refresh preserves an existing owner's workspace", async () => {
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const owner = codexThread({ id: "owner", projectKey: "/contrived/other", linkedDirectories: [{
      id: "other-directory", kind: "worktree", label: "other", path: "/contrived/other-repo", worktreePath: "/contrived/other",
    }] });
    const fixture = build([owner], target);
    fixture.client.listThreads.mockResolvedValue([owner]);
    await fixture.registry.listThreads({ backend: "codex", enrichDirectories: true });
    vi.useFakeTimers();
    const archiveWorktree = fixture.archiveWorktree.getMockImplementation()!;
    fixture.archiveWorktree.mockImplementation(async (params) => {
      const beforeRemove = params.beforeRemove;
      return await archiveWorktree({ ...params, beforeRemove: async () => {
        const assertRemoval = await beforeRemove!();
        fixture.client.listThreads.mockResolvedValue([{ ...owner, title: "Updated title", linkedDirectories: [] }]);
        await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false, forceRefresh: true });
        return assertRemoval;
      } });
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.removedWorktree).toBe(true);
  });

  it.each([false, true])("keeps the worktree when provider discovery fails during archived: %s", async (failedArchived) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    const listPage = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      if (params.archived === failedArchived) throw new Error("Inventory unavailable.");
      return await listPage(params);
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.skippedReason).toContain("Inventory unavailable");
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
  });

  it("rejects a non-advancing provider cursor instead of using a partial safety inventory", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    fixture.client.listArchiveCleanupThreadsPage.mockResolvedValue({ threads: [], nextCursor: "repeat" });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.skippedReason).toContain("repeated cursor");
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    expect(fixture.client.listArchiveCleanupThreadsPage).toHaveBeenCalledTimes(2);
  });

  it("preserves shared-checkout protection during missing-rollout recovery", async () => {
    vi.useFakeTimers();
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const target = codexThread({ id: "target", linkedDirectories: [directory] });
    const fixture = build([target, codexThread({ id: "shared-user", linkedDirectories: [directory] })], target);
    fixture.client.archiveThread.mockRejectedValue(new Error("json-rpc error (-32600): no rollout found for thread id target"));
    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(result.cleanup[0]?.skippedReason).toContain("another active thread: shared-user");
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    expect(fixture.store.setThreadArchiveTombstone).toHaveBeenCalledOnce();
  });

  it("removes a shared worktree after the preceding missing-rollout owner is tombstoned", async () => {
    vi.useFakeTimers();
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const targets = ["first", "second"].map((id) => codexThread({ id, linkedDirectories: [directory] }));
    const fixture = build(targets, targets[0]!);
    fixture.client.archiveThread.mockImplementation(async ({ threadId }) => {
      throw new Error(`json-rpc error (-32600): no rollout found for thread id ${threadId}`);
    });
    fixture.store.setThreadArchiveTombstone.mockImplementation(async ({ threadId, archivedAt }) => {
      fixture.overlays.set(threadId, { backend: "codex", threadId, extraLinkedDirectories: [], archiveTombstonedAt: archivedAt });
    });
    const requests = Promise.all(targets.map((thread) => fixture.registry.archiveThread({ backend: "codex", threadId: thread.id })));
    const results = await drivePacer(fixture.registry, requests);

    expect(results[0]?.cleanup[0]?.skippedReason).toContain("another active thread: second");
    expect(results[1]?.cleanup[0]).toMatchObject({ removedWorktree: true });
    expect(fixture.archiveWorktree).toHaveBeenCalledOnce();
    expect(fixture.archiveWorktree).toHaveBeenCalledWith(expect.objectContaining({ threadId: "second" }));
    expect(fixture.store.setThreadArchiveTombstone).toHaveBeenCalledTimes(2);
    // Rebuild discovery after the first tombstone, then scan again at removal.
    expect(fixture.counts.providerPages).toBe(6);
  });

  it("cancels missing-rollout recovery on genuine restore intent before removal", async () => {
    vi.useFakeTimers();
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const target = codexThread({ id: "target", linkedDirectories: [directory] });
    const fixture = build([target], target);
    fixture.client.archiveThread.mockRejectedValue(new Error("json-rpc error (-32600): no rollout found for thread id target"));
    fixture.archiveWorktree.mockImplementation(async (params) => {
      await publishNotification(fixture.registry, { method: "thread/unarchived", params: { threadId: "target" } });
      await params.beforeRemove?.();
      throw new Error("Removal should have been cancelled.");
    });
    const result = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    const observed = result.then(() => undefined, (error: Error) => error.message);
    const error = await drivePacer(fixture.registry, observed);
    expect(error).toContain("cleanup did not complete");
    expect(error).toContain("cancelled");
    expect(fixture.archiveWorktree).toHaveBeenCalledOnce();
    expect(fixture.store.setThreadArchiveTombstone).not.toHaveBeenCalled();
  });

  it("still refuses removal while another provider archive mutation is in flight", async () => {
    vi.useFakeTimers();
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const fixture = build([], codexThread({ id: "target", linkedDirectories: [directory] }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const archive = fixture.client.archiveThread.getMockImplementation()!;
    fixture.client.archiveThread.mockImplementation(async (params) => {
      if (params.threadId === "second") await gate;
      return await archive(params);
    });
    const first = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    const second = fixture.registry.archiveThread({ backend: "codex", threadId: "second" });
    try {
      const result = await drivePacer(fixture.registry, first);
      expect(result.cleanup[0]?.error).toContain("lifecycle mutation is still in flight");
    } finally {
      release();
      await drivePacer(fixture.registry, second);
    }
  });

  it("uses a targeted authoritative row and skips the archived inventory when no worktree can be removed", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    const read = vi.fn(async () => codexThread({ id: "target" }));
    Object.assign(fixture.client, { readArchiveCleanupThreadSummary: read });
    const result = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    await drivePacer(fixture.registry, result);
    expect((await result).cleanup).toEqual([]);
    expect(read).toHaveBeenCalledOnce();
    expect(fixture.client.listArchiveCleanupThreadsPage.mock.calls.map(([params]) => params.archived)).toEqual([false]);
  });

  it("exposes delayed metadata failure on the background completion event", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    fixture.client.listArchiveCleanupThreadsPage.mockRejectedValue(new Error("provider unavailable"));
    expect(await fixture.registry.archiveThread({ backend: "codex", threadId: "target", backgroundCleanup: true }))
      .toMatchObject({ cleanupPending: true });
    const event = await drivePacer(fixture.registry, fixture.completion);
    expect(event.notification.params).toMatchObject({ cleanup: [expect.objectContaining({ skippedReason: expect.stringContaining("provider unavailable") })] });
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
  });

  it("serializes an inverse intent behind provider mutation and cancels its new cleanup", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    let release!: () => void;
    const providerGate = new Promise<void>((resolve) => { release = resolve; });
    const archive = fixture.client.archiveThread.getMockImplementation()!;
    fixture.client.archiveThread.mockImplementation(async (params) => { await providerGate; return await archive(params); });
    const result = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    await vi.advanceTimersByTimeAsync(0);
    let inverseRan = false;
    const inverse = fixture.registry.withThreadLifecycleMutation({ backend: "codex", threadId: "target" }, async () => { inverseRan = true; });
    expect(inverseRan).toBe(false);
    release();
    await drivePacer(fixture.registry, inverse);
    expect(inverseRan).toBe(true);
    expect((await result).cleanup[0]?.skippedReason).toContain("cancelled");
    expect(fixture.counts.providerPages).toBe(0);
  });

  it("keeps a worktree when a new active shared user appears during snapshot preparation", async () => {
    vi.useFakeTimers();
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const active: AppServerThreadSummary[] = [];
    const fixture = build(active, codexThread({ id: "target", linkedDirectories: [directory] }));
    fixture.archiveWorktree.mockImplementation(async (params) => {
      active.push(codexThread({ id: "new-user", linkedDirectories: [directory] }));
      const admission = await params.beforeRemove?.();
      admission?.();
      throw new Error("Removal should have been denied.");
    });
    const result = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    await drivePacer(fixture.registry, result);
    expect((await result).cleanup).toEqual([expect.objectContaining({ removedWorktree: false, error: expect.stringContaining("still used") })]);
    expect(fixture.counts.providerPages).toBe(4);
  });

  it("refuses removal while an older lifecycle mutation remains in flight", async () => {
    vi.useFakeTimers();
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const fixture = build([], codexThread({ id: "target", linkedDirectories: [directory] }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const other = fixture.registry.withThreadLifecycleMutation({ backend: "codex", threadId: "moving-thread" }, async () => { await gate; });
    await vi.advanceTimersByTimeAsync(0);
    try {
      const result = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
      await drivePacer(fixture.registry, result);
      expect((await result).cleanup[0]?.error).toContain("lifecycle mutation is still in flight");
    } finally { release(); await other; }
  });

  it("cancels a queued cleanup on unarchive and reports completion without removal", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    await fixture.registry.archiveThread({ backend: "codex", threadId: "target", backgroundCleanup: true });
    await publishNotification(fixture.registry, { method: "thread/unarchived", params: { threadId: "target" } });
    await drivePacer(fixture.registry, fixture.completion);
    expect(fixture.counts.providerPages).toBe(0);
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    expect(fixture.events.find((event) => event.notification.method === "thread/archiveCleanup/completed")?.notification.params)
      .toMatchObject({ cleanup: [expect.objectContaining({ skippedReason: expect.stringContaining("cancelled") })] });
  });

  it("treats archive after an intervening unarchive as a new provider mutation", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    await fixture.registry.archiveThread({ backend: "codex", threadId: "target", backgroundCleanup: true });
    await publishNotification(fixture.registry, { method: "thread/unarchived", params: { threadId: "target" } });
    const retry = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    await drivePacer(fixture.registry, retry);
    expect((await retry).cleanup).toEqual([]);
    expect(fixture.client.archiveThread).toHaveBeenCalledTimes(2);
    expect(fixture.counts.providerPages).toBe(2);
  });

  it("revalidates child grouping and excludes remote-parent identities", async () => {
    vi.useFakeTimers();
    const fixture = build([codexThread({ id: "child" }), codexThread({ id: "remote-child" })]);
    fixture.overlays.set("child", { backend: "codex", threadId: "child", extraLinkedDirectories: [], parentThreadId: "target", parentThreadBackend: "codex" });
    fixture.overlays.set("remote-child", { backend: "codex", threadId: "remote-child", extraLinkedDirectories: [], parentThreadId: "target", parentThreadBackend: "codex", parentThreadInstanceId: "other-owner" });
    fixture.store.getThreadOverlayState.mockImplementation(async ({ threadId }) => ({
      ...fixture.overlays.get(threadId)!, parentThreadId: "new-parent",
    }));
    const result = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    await drivePacer(fixture.registry, result);
    await result;
    expect(fixture.store.setThreadParent).not.toHaveBeenCalled();
  });
});
