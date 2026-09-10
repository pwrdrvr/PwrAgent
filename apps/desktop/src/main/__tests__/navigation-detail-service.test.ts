import { beforeEach, describe, expect, it, vi } from "vitest";
import { NAVIGATION_QUERY_MAX_RESULT_BYTES } from "@pwragent/shared";
import type {
  NavigationSnapshot,
  NavigationThreadSummary,
  ThreadQueuedTurnSummary,
} from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";

const mocks = vi.hoisted(() => ({
  reconcileNavigationSnapshot: vi.fn(),
  getThreadOverlayState: vi.fn(),
  getLaunchpadDefaults: vi.fn(),
  getDirectoryLaunchpad: vi.fn(),
  listCodexEnvironmentOptions: vi.fn(),
}));

vi.mock("../app-server/desktop-overlay-store", () => ({
  getDesktopOverlayStore: () => ({
    reconcileNavigationSnapshot: mocks.reconcileNavigationSnapshot,
    getThreadOverlayState: mocks.getThreadOverlayState,
    getLaunchpadDefaults: mocks.getLaunchpadDefaults,
    getDirectoryLaunchpad: mocks.getDirectoryLaunchpad,
  }),
}));

vi.mock("../app-server/codex-environment-config", () => ({ listCodexEnvironmentOptions: mocks.listCodexEnvironmentOptions }));

vi.mock("../messaging/messaging-bindings-snapshot", () => ({
  buildMessagingBindingsByThreadKey: vi.fn(async () => new Map()),
}));

import { NavigationDetailService } from "../app-server/navigation-detail-service";

function thread(id: string): NavigationThreadSummary {
  return {
    id,
    source: "codex",
    title: `Thread ${id}`,
    titleSource: "derived",
    linkedDirectories: [],
    inbox: { inInbox: false },
  };
}

describe("NavigationDetailService", () => {
  it("includes a continuation cursor in the queue wire-byte admission check", () => {
    const entries: ThreadQueuedTurnSummary[] = [{ queueEntryId: "first", createdAt: 1, displayText: "", origin: "manual", position: 0 }];
    const service = new NavigationDetailService({
      iterateQueuedTurnSummaries: () => entries,
      getQueuedExecutionModeForThread: () => undefined,
    } as unknown as DesktopBackendRegistry);
    const request = { protocol: 2 as const, ref: { backend: "codex" as const, threadId: "thread" } };
    const overhead = Buffer.byteLength(JSON.stringify(service.readQueueProjection(request)));
    entries[0]!.displayText = "x".repeat(NAVIGATION_QUERY_MAX_RESULT_BYTES - overhead - 10);
    expect(Buffer.byteLength(JSON.stringify(service.readQueueProjection(request)))).toBeLessThan(NAVIGATION_QUERY_MAX_RESULT_BYTES);
    entries.push({ queueEntryId: "second", createdAt: 2, displayText: "next", origin: "manual", position: 1 });
    expect(() => service.readQueueProjection(request)).toThrow("One queue entry exceeds the result budget");
  });

  it("stops admission before retaining an oversized complete FIFO", () => {
    let visited = 0;
    const service = new NavigationDetailService({
      *iterateQueuedTurnSummaries() {
        for (let index = 0; index < 100_000; index += 1) {
          visited += 1;
          yield { queueEntryId: String(index), createdAt: 1,
            displayText: "x".repeat(200), origin: "manual", position: index };
        }
      },
      getQueuedExecutionModeForThread: () => undefined,
    } as unknown as DesktopBackendRegistry);
    expect(() => service.readQueueProjection({ protocol: 2,
      ref: { backend: "codex", threadId: "thread" } })).toThrow("8 MiB admission budget");
    expect(visited).toBeLessThan(100_000);
  });

  beforeEach(() => {
    mocks.reconcileNavigationSnapshot.mockReset();
    mocks.getThreadOverlayState.mockReset();
    mocks.getLaunchpadDefaults.mockReset().mockResolvedValue({ backend: "codex", executionMode: "default" });
    mocks.getDirectoryLaunchpad.mockReset().mockResolvedValue(undefined);
    mocks.listCodexEnvironmentOptions.mockReset().mockResolvedValue([]);
  });

  it("reads defaults and only the selected launchpad without enumerating navigation", async () => {
    const service = new NavigationDetailService({} as DesktopBackendRegistry);
    const defaults = await service.readLaunchpadConfig({ protocol: 2 });
    expect(defaults.defaults).toEqual({ backend: "codex", executionMode: "default" });
    expect(mocks.getDirectoryLaunchpad).not.toHaveBeenCalled();
    expect(mocks.reconcileNavigationSnapshot).not.toHaveBeenCalled();
    mocks.getDirectoryLaunchpad.mockResolvedValue({ directoryKey: "chosen", prompt: "selected draft" });
    const selected = await service.readLaunchpadConfig({ protocol: 2, directoryKey: "chosen" });
    expect(mocks.getDirectoryLaunchpad).toHaveBeenCalledExactlyOnceWith({ directoryKey: "chosen" });
    expect(selected.launchpad?.directoryKey).toBe("chosen");
    expect(JSON.stringify(selected)).not.toContain("selected draft");
    const unchanged = await service.readLaunchpadConfig({ protocol: 2, directoryKey: "chosen", knownRevision: selected.revision });
    expect(unchanged.unchanged).toBe(true);
    expect(unchanged.defaults).toBeUndefined();
    expect(unchanged.launchpad).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(unchanged))).toBeLessThan(1024);
  });

  it("loads environment and branch choices only for the selected owner directory", async () => {
    const readSelectedWorkspaceGitStatus = vi.fn(async () => ({ currentBranch: "feature", branches: ["main", "feature"] }));
    const service = new NavigationDetailService({ readSelectedWorkspaceGitStatus } as unknown as DesktopBackendRegistry);
    mocks.getDirectoryLaunchpad.mockResolvedValue({ directoryKey: "chosen", directoryPath: "/owner/repo", prompt: "private draft" });
    mocks.listCodexEnvironmentOptions.mockResolvedValue([{ id: "env", name: "Owner environment", actions: [] }]);
    const response = await service.readLaunchpadConfig({ protocol: 2, directoryKey: "chosen" });
    expect(response.launchpad?.codexEnvironmentOptions).toEqual([{ id: "env", name: "Owner environment", actions: [] }]);
    expect(response.directoryGitStatus?.branches).toEqual(["main", "feature"]);
    expect(mocks.listCodexEnvironmentOptions).toHaveBeenCalledExactlyOnceWith("/owner/repo");
    expect(JSON.stringify(response)).not.toContain("private draft");
    mocks.getDirectoryLaunchpad.mockResolvedValue({ directoryKey: "viewer", directoryPath: "/same/path", federationTarget: { scope: "remote", instanceId: "peer" } });
    await service.readLaunchpadConfig({ protocol: 2, directoryKey: "viewer" });
    expect(mocks.listCodexEnvironmentOptions).toHaveBeenCalledTimes(1);
    expect(readSelectedWorkspaceGitStatus).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized configuration without truncating action metadata", async () => {
    const service = new NavigationDetailService({} as DesktopBackendRegistry);
    mocks.getDirectoryLaunchpad.mockResolvedValue({ directoryKey: "chosen", agent: { name: "owner", instructions: "x".repeat(252 * 1024) } });
    await expect(service.readLaunchpadConfig({ protocol: 2, directoryKey: "chosen" }))
      .rejects.toMatchObject({ code: "navigation_item_too_large" });
  });

  it("loads authoritative selected detail independently of a row page", async () => {
    const selected = thread("selected");
    selected.linkedDirectories = [{ id: "selected-repo", kind: "local", label: "Selected", path: "/repo/selected" }];
    selected.queuedTurns = [{ queueEntryId: "independent", origin: "manual", displayText: "Private FIFO", createdAt: 1, position: 0 }];
    selected.subAgents = Array.from({ length: 738 }, (_, index) => ({
      monitorId: `monitor-${index}`, task: "Historical task", status: "success" as const,
      createdAt: index, updatedAt: index, lastMessage: "result".repeat(350),
    }));
    mocks.getThreadOverlayState.mockResolvedValue({ subAgents: selected.subAgents });
    selected.agent = {
      name: "Operator",
      instructions: "exact detail only",
      instructionLineCount: 1,
      instructionsTooLong: false,
      updatedAt: 1,
    };
    mocks.reconcileNavigationSnapshot.mockImplementation(async (params) => ({
      backend: "codex",
      fetchedAt: 1,
      unchanged: false,
      threads: [selected],
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: { backend: "codex", executionMode: "default" },
      params,
    } satisfies NavigationSnapshot & { params: unknown }));
    const registry = {
      readSelectedWorkspaceGitStatus: vi.fn(async () => ({ currentBranch: "feature", handoffBranches: ["main"] })),
      getCachedThreadSummary: vi.fn(() => undefined),
      resolveThread: vi.fn(async () => thread("selected")),
      getQueuedExecutionModeForThread: vi.fn(() => undefined),
      getQueuedTurnsSnapshot: vi.fn(() => { throw new Error("FIFO must remain independent"); }),
      hydrateThreadGitWorkingStates: vi.fn(async (threads) => threads),
      canonicalizeNavigationThreadPullRequests: vi.fn(async (threads) => threads),
      mergeLiveTokenMiserSubAgents: (_id: string, persisted: unknown[]) => persisted ?? [],
    } as unknown as DesktopBackendRegistry;
    const service = new NavigationDetailService(registry);
    const first = await service.readSelectedDetail({
      protocol: 2,
      ref: { backend: "codex", threadId: "selected" },
    });

    expect(first).toMatchObject({
      identity: "present",
      readiness: "ready",
      thread: {
        id: "selected",
        agent: { instructions: "exact detail only" },
      },
    });
    expect(first.thread).not.toHaveProperty("queuedTurns");
    expect(first.thread).not.toHaveProperty("subAgents");
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(NAVIGATION_QUERY_MAX_RESULT_BYTES);
    expect(first.collections).toContainEqual(expect.objectContaining({ name: "subAgents", count: 738 }));
    const hydratedBefore = vi.mocked(registry.hydrateThreadGitWorkingStates).mock.calls.length;
    let cursor: string | undefined;
    const monitors: string[] = [];
    do {
      const response = await service.readSelectedDetail({ protocol: 2, ref: first.ref, collection: { name: "subAgents", cursor } });
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(NAVIGATION_QUERY_MAX_RESULT_BYTES);
      expect(response.thread).toBeUndefined();
      monitors.push(...response.collectionPage!.values.subAgents!.map((agent) => agent.monitorId));
      cursor = response.collectionPage!.nextCursor;
      expect(response.collectionPage!.complete).toBe(!cursor);
    } while (cursor);
    expect(monitors).toEqual(selected.subAgents.map((agent) => agent.monitorId));
    expect(registry.hydrateThreadGitWorkingStates).toHaveBeenCalledTimes(hydratedBefore);
    expect(registry.getQueuedTurnsSnapshot).not.toHaveBeenCalled();
    await service.readSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: "selected" }, probeWorkingStates: true });
    expect(registry.hydrateThreadGitWorkingStates).toHaveBeenLastCalledWith(expect.any(Array), { probeMissing: true });
    const unchanged = await service.readSelectedDetail({
      protocol: 2,
      ref: { backend: "codex", threadId: "selected" },
      knownRevision: first.revision,
    });
    expect(unchanged).toMatchObject({ unchanged: true });
    expect(unchanged.thread).toBeUndefined();
    expect(registry.readSelectedWorkspaceGitStatus).not.toHaveBeenCalled();
    const workspace = await service.readSelectedDetail({ protocol: 2, ref: first.ref,
      includeWorkspaceConfiguration: true, knownRevision: first.revision });
    expect(workspace.unchanged).not.toBe(true);
    expect(workspace.workspaceDirectories).toEqual([{ key: "selected-repo", label: "Selected", path: "/repo/selected",
      gitStatus: { currentBranch: "feature", handoffBranches: ["main"] } }]);
    expect(registry.readSelectedWorkspaceGitStatus).toHaveBeenCalledExactlyOnceWith("/repo/selected");
  });

  it("keeps live Token Miser parent links through selected-detail refresh and paging", async () => {
    const selected = thread("selected");
    const persisted = Array.from({ length: 101 }, (_, index) => ({
      monitorId: `historical-${index}`, task: "Historical helper", status: "success" as const,
      createdAt: index, updatedAt: index,
    }));
    selected.subAgents = persisted;
    const live = {
      monitorId: "system:token-miser:live", task: "Evaluate output", status: "success" as const,
      createdAt: 200, updatedAt: 200, parentTurnId: "running-turn",
    };
    const liveAgents = new Map([[live.monitorId, live]]);
    mocks.getThreadOverlayState.mockResolvedValue({ subAgents: persisted });
    mocks.reconcileNavigationSnapshot.mockResolvedValue({ threads: [selected] });
    const registry = {
      getCachedThreadSummary: () => selected,
      getQueuedExecutionModeForThread: () => undefined,
      canonicalizeNavigationThreadPullRequests: async (threads: unknown[]) => threads,
      hydrateThreadGitWorkingStates: async (threads: unknown[]) => threads,
      liveTokenMiserSubAgents: new Map([[selected.id, liveAgents]]),
      mergeLiveTokenMiserSubAgents: DesktopBackendRegistry.prototype["mergeLiveTokenMiserSubAgents"],
    } as unknown as DesktopBackendRegistry;
    const service = new NavigationDetailService(registry);
    const request = { protocol: 2 as const, ref: { backend: "codex" as const, threadId: selected.id } };
    const first = await service.readSelectedDetail(request);
    expect(first.collections).toContainEqual(expect.objectContaining({ name: "subAgents", count: 102 }));
    const page = await service.readSelectedDetail({ ...request, collection: { name: "subAgents" } });
    expect(page.collectionPage?.revision).toBe(first.collections?.find((entry) => entry.name === "subAgents")?.revision);
    expect(page.collectionPage?.values.subAgents).toContainEqual(live);
    const next = await service.readSelectedDetail({ ...request, collection: { name: "subAgents", cursor: page.collectionPage?.nextCursor } });
    expect(next.collectionPage?.complete).toBe(true);
    expect(next.collectionPage?.values.subAgents).toHaveLength(2);

    liveAgents.set(live.monitorId, { ...live, updatedAt: 201 });
    const refreshed = await service.readSelectedDetail({ ...request, knownRevision: first.revision });
    expect(refreshed.unchanged).toBe(true);
    expect(refreshed.collections?.find((entry) => entry.name === "subAgents")?.revision)
      .not.toBe(page.collectionPage?.revision);
    await expect(service.readSelectedDetail({ ...request, collection: { name: "subAgents", cursor: page.collectionPage?.nextCursor } }))
      .rejects.toMatchObject({ code: "navigation_cursor_expired" });
  });

  it("projects composer sub-agents without loading result or accounting history", async () => {
    const running = { monitorId: "running", task: "Watch the build", status: "running" as const,
      createdAt: 1, updatedAt: 2, monitorThreadId: "child", monitorTurnId: "turn" };
    const selected = thread("selected");
    selected.subAgents = [
      { ...running, lastMessage: "large result".repeat(100_000),
        monitorUsage: { summary: "Large accounting summary".repeat(10_000), tokenUsage: { totalTokens: 1234 } } },
      ...Array.from({ length: 10_000 }, (_, index) => ({
        ...running, monitorId: `old-${index}`, status: "success" as const,
      })),
    ];
    mocks.reconcileNavigationSnapshot.mockResolvedValue({ threads: [selected] });
    const service = new NavigationDetailService({
      getCachedThreadSummary: () => selected,
      getQueuedExecutionModeForThread: () => undefined,
      canonicalizeNavigationThreadPullRequests: async (threads: unknown[]) => threads,
      hydrateThreadGitWorkingStates: async (threads: unknown[]) => threads,
      mergeLiveTokenMiserSubAgents: (_id: string, persisted: unknown[]) => persisted,
    } as unknown as DesktopBackendRegistry);
    const request = { protocol: 2 as const, ref: { backend: "codex" as const, threadId: selected.id } };
    const first = await service.readSelectedDetail(request);
    expect(first.thread?.activeSubAgents).toEqual([running]);
    expect(first.thread).not.toHaveProperty("subAgents");
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(4000);
    expect(mocks.getThreadOverlayState).not.toHaveBeenCalled();

    selected.subAgents[0] = { ...selected.subAgents[0]!, status: "success", completedAt: 3 };
    const completed = await service.readSelectedDetail({ ...request, knownRevision: first.revision });
    expect(completed.unchanged).not.toBe(true);
    expect(completed.thread?.activeSubAgents).toEqual([]);
  });

  it("pages a complete FIFO projection with its own revision", () => {
    let entries: ThreadQueuedTurnSummary[] = Array.from(
      { length: 205 },
      (_, index) => ({
        queueEntryId: `queue-${index}`,
        origin: "manual",
        displayText: `Queued ${index}`,
        createdAt: index,
        position: index,
      }),
    );
    const registry = {
      getQueuedTurnsSnapshot: vi.fn(() => { throw new Error("Fleet FIFO enumeration is forbidden"); }),
      iterateQueuedTurnSummaries: vi.fn(() => entries),
      getQueuedExecutionModeForThread: vi.fn(() => undefined),
    } as unknown as DesktopBackendRegistry;
    const service = new NavigationDetailService(registry);
    const request = {
      protocol: 2 as const,
      ref: { backend: "codex" as const, threadId: "selected" },
    };
    const first = service.readQueueProjection(request);
    expect(registry.iterateQueuedTurnSummaries).toHaveBeenCalledWith(request.ref);
    expect(registry.getQueuedTurnsSnapshot).not.toHaveBeenCalled();
    expect(first.entries).toHaveLength(100);
    expect(first.complete).toBe(false);
    const second = service.readQueueProjection({
      ...request,
      cursor: first.nextCursor,
    });
    expect(second.entries).toHaveLength(100);
    const third = service.readQueueProjection({
      ...request,
      cursor: second.nextCursor,
    });
    expect(third.entries).toHaveLength(5);
    expect(third.complete).toBe(true);

    const unchanged = service.readQueueProjection({
      ...request,
      knownRevision: third.revision,
    });
    expect(unchanged).toMatchObject({
      complete: true,
      entries: [],
      unchanged: true,
    });

    entries = [...entries, {
      queueEntryId: "queue-new",
      origin: "manual",
      displayText: "new",
      createdAt: 999,
      position: 205,
    }];
    expect(() => service.readQueueProjection({
      ...request,
      cursor: second.nextCursor,
    })).toThrow("Queue changed while paging");
  });
});
