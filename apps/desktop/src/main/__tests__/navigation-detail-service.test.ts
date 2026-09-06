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
}));

vi.mock("../app-server/desktop-overlay-store", () => ({
  getDesktopOverlayStore: () => ({
    reconcileNavigationSnapshot: mocks.reconcileNavigationSnapshot,
    getLaunchpadDefaults: mocks.getLaunchpadDefaults,
    getDirectoryLaunchpad: mocks.getDirectoryLaunchpad,
  }),
}));

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

  it("rejects oversized configuration without truncating action metadata", async () => {
    const service = new NavigationDetailService({} as DesktopBackendRegistry);
    mocks.getDirectoryLaunchpad.mockResolvedValue({ directoryKey: "chosen", agent: { name: "owner", instructions: "x".repeat(252 * 1024) } });
    await expect(service.readLaunchpadConfig({ protocol: 2, directoryKey: "chosen" }))
      .rejects.toMatchObject({ code: "navigation_item_too_large" });
  });

  it("loads authoritative selected detail independently of a row page", async () => {
    const selected = thread("selected");
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
      getCachedThreadSummary: vi.fn(() => undefined),
      resolveThread: vi.fn(async () => thread("selected")),
      getQueuedExecutionModesSnapshot: vi.fn(() => ({})),
      getQueuedTurnsSnapshot: vi.fn(() => ({})),
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
    const unchanged = await service.readSelectedDetail({
      protocol: 2,
      ref: { backend: "codex", threadId: "selected" },
      knownRevision: first.revision,
    });
    expect(unchanged).toMatchObject({ unchanged: true });
    expect(unchanged.thread).toBeUndefined();
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
      getQueuedTurnsSnapshot: vi.fn(() => ({ "codex:selected": entries })),
      getQueuedExecutionModesSnapshot: vi.fn(() => ({})),
    } as unknown as DesktopBackendRegistry;
    const service = new NavigationDetailService(registry);
    const request = {
      protocol: 2 as const,
      ref: { backend: "codex" as const, threadId: "selected" },
    };
    const first = service.readQueueProjection(request);
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
