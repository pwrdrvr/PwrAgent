import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NavigationSnapshot,
  NavigationThreadSummary,
  ThreadQueuedTurnSummary,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";

const mocks = vi.hoisted(() => ({
  reconcileNavigationSnapshot: vi.fn(),
  getLaunchpadDefaults: vi.fn(),
  getDirectoryLaunchpad: vi.fn(),
  listCodexEnvironmentOptions: vi.fn(),
}));

vi.mock("../app-server/desktop-overlay-store", () => ({
  getDesktopOverlayStore: () => ({
    reconcileNavigationSnapshot: mocks.reconcileNavigationSnapshot,
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
  beforeEach(() => {
    mocks.reconcileNavigationSnapshot.mockReset();
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
      getQueuedTurnsForThread: vi.fn(() => entries),
      getQueuedExecutionModeForThread: vi.fn(() => undefined),
    } as unknown as DesktopBackendRegistry;
    const service = new NavigationDetailService(registry);
    const request = {
      protocol: 2 as const,
      ref: { backend: "codex" as const, threadId: "selected" },
    };
    const first = service.readQueueProjection(request);
    expect(registry.getQueuedTurnsForThread).toHaveBeenCalledExactlyOnceWith(request.ref);
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
