import { afterEach, describe, expect, it, vi } from "vitest";
import { stat } from "node:fs/promises";
import type { AgentEvent, AppServerThreadSummary, ThreadOverlayState } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { CountingBackendClient, codexThread, publishNotification } from "./fixtures/thread-read-harness";
import budgets from "./fixtures/archive-cleanup-budgets.json";

vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
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

async function drivePacer<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  for (let slice = 0; slice < 500 && !settled; slice += 1) await vi.advanceTimersByTimeAsync(25);
  expect(settled).toBe(true);
  return await promise;
}

const registries: DesktopBackendRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  vi.mocked(stat).mockReset();
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
    getThreadOverlayStates: readOverlays,
    getThreadOverlayState: vi.fn(async ({ threadId }: { threadId: string }) => overlays.get(threadId)),
    setThreadParent: vi.fn(async () => {}),
    setThreadArchiveTombstone: vi.fn(async () => {}),
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

describe("archive cleanup pipeline", () => {
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
    await drivePacer(fixture.completion);
    expect(fixture.counts).toEqual(budgets["1000-active-threads"]);
    expect(fixture.events.find((event) => event.notification.method === "thread/archiveCleanup/completed")?.notification.params)
      .toMatchObject({ threadId: "target", cleanup: [] });
  });

  it("coalesces duplicate archive requests by backend identity", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    const first = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    const second = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    await drivePacer(first);
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

    const result = await drivePacer(fixture.registry.archiveThread({ backend: "codex", threadId: target.id, backgroundCleanup }));
    let cleanup: unknown = result.cleanup;
    if (backgroundCleanup) {
      const notification = (await drivePacer(fixture.completion)).notification;
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

    const result = await drivePacer(fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

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
    expect(await drivePacer(observed)).toMatchObject({ response: { cleanup: [expect.objectContaining({ removedWorktree: true })] } });
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
    expect(await drivePacer(observed)).toMatchObject({ response: { cleanup: [expect.objectContaining({ removedWorktree: true })] } });
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
    const results = await drivePacer(Promise.all(targets.map((target) =>
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
      await drivePacer(sentinelStarted);
      expect(stat).toHaveBeenCalledWith("/contrived/worktree");
      expect(settled).toBe(false);
      // Only the first job's initial and final admission inventories ran.
      expect(fixture.counts.providerPages).toBe(4);
    } finally { release(); }
    const responses = await drivePacer(results);
    expect(responses[0].cleanup[0]?.removedWorktree).toBe(true);
    expect(fixture.counts.providerPages).toBe(6);
  });

  it("keeps rejecting active target metadata without confirmed missing-rollout recovery", async () => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target" });
    const fixture = build([target], target);
    const result = await drivePacer(fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(result.cleanup[0]?.skippedReason).toContain("thread is active again");
    expect(fixture.store.setThreadArchiveTombstone).not.toHaveBeenCalled();
  });

  it("preserves shared-checkout protection during missing-rollout recovery", async () => {
    vi.useFakeTimers();
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const target = codexThread({ id: "target", linkedDirectories: [directory] });
    const fixture = build([target, codexThread({ id: "shared-user", linkedDirectories: [directory] })], target);
    fixture.client.archiveThread.mockRejectedValue(new Error("json-rpc error (-32600): no rollout found for thread id target"));
    const result = await drivePacer(fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(result.cleanup[0]?.skippedReason).toContain("another active thread: shared-user");
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    expect(fixture.store.setThreadArchiveTombstone).toHaveBeenCalledOnce();
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
    const error = await drivePacer(observed);
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
      const result = await drivePacer(first);
      expect(result.cleanup[0]?.error).toContain("lifecycle mutation is still in flight");
    } finally {
      release();
      await drivePacer(second);
    }
  });

  it("uses a targeted authoritative row and skips the archived inventory when no worktree can be removed", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    const read = vi.fn(async () => codexThread({ id: "target" }));
    Object.assign(fixture.client, { readArchiveCleanupThreadSummary: read });
    const result = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    await drivePacer(result);
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
    const event = await drivePacer(fixture.completion);
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
    await drivePacer(inverse);
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
    await drivePacer(result);
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
      await drivePacer(result);
      expect((await result).cleanup[0]?.error).toContain("lifecycle mutation is still in flight");
    } finally { release(); await other; }
  });

  it("cancels a queued cleanup on unarchive and reports completion without removal", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    await fixture.registry.archiveThread({ backend: "codex", threadId: "target", backgroundCleanup: true });
    await publishNotification(fixture.registry, { method: "thread/unarchived", params: { threadId: "target" } });
    await drivePacer(fixture.completion);
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
    await drivePacer(retry);
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
    await drivePacer(result);
    await result;
    expect(fixture.store.setThreadParent).not.toHaveBeenCalled();
  });
});
