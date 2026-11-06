import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAVIGATION_QUERY_MAX_RESULT_BYTES } from "@pwragent/shared";
import type {
  NavigationThreadSummary,
  ThreadQueuedTurnSummary,
  ThreadPullRequestWatchSummary,
  ThreadSubAgentSummary,
} from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import * as backendRegistry from "../app-server/backend-registry";
import * as navigationDetail from "../app-server/navigation-detail-service";
import { ThreadPendingWakesCache } from "../app-server/thread-pending-wakes-cache";
import { expectPendingWakeReadBudget } from "./fixtures/pending-wake-read-budget";
import { buildThreadPendingWakes, type PendingWakeThread, type ThreadPendingWakeReaders } from "../app-server/thread-pending-wakes";

const mocks = vi.hoisted(() => ({
  /** The selected thread's stored cards, as the store's card reads see them. */
  cards: [] as ThreadSubAgentSummary[],
  /** The selected thread's active PR watches, as the watch table returns them. */
  prWatches: [] as ThreadPullRequestWatchSummary[],
  /** The card table's order: newest `createdAt` first, then monitor id. */
  newestFirst: (cards: readonly ThreadSubAgentSummary[]) => [...cards].sort((left, right) =>
    right.createdAt - left.createdAt
    || (left.monitorId < right.monitorId ? -1 : left.monitorId > right.monitorId ? 1 : 0)),
  reconcileNavigationSnapshot: vi.fn(),
  projectNavigationThreadDetail: vi.fn(),
  getThreadOverlayState: vi.fn(),
  getLaunchpadDefaults: vi.fn(),
  getDirectoryLaunchpad: vi.fn(),
  listCodexEnvironmentOptions: vi.fn(),
  listActiveThreadPrStatusWatches: vi.fn(),
}));

vi.mock("../storage/desktop-overlay-store", () => ({
  getDesktopOverlayStore: () => ({
    reconcileNavigationSnapshot: mocks.reconcileNavigationSnapshot,
    projectNavigationThreadDetail: mocks.projectNavigationThreadDetail,
    getThreadOverlayState: mocks.getThreadOverlayState,
    getLaunchpadDefaults: mocks.getLaunchpadDefaults,
    getDirectoryLaunchpad: mocks.getDirectoryLaunchpad,
    listThreadSubAgentPage: async (params: { excludeMonitorIds?: readonly string[]; offset: number; limit: number }) =>
      mocks.newestFirst(mocks.cards)
        .filter((card) => !params.excludeMonitorIds?.includes(card.monitorId))
        .slice(params.offset, params.offset + params.limit),
    getThreadSubAgent: async ({ monitorId }: { monitorId: string }) =>
      mocks.cards.find((card) => card.monitorId === monitorId),
    getThreadSubAgents: async ({ monitorIds }: { monitorIds: readonly string[] }) =>
      mocks.cards.filter((card) => monitorIds.includes(card.monitorId)),
    listActiveThreadPrStatusWatches: mocks.listActiveThreadPrStatusWatches,
    listActiveThreadSubAgents: async () => mocks.cards.filter((card) =>
      card.completedAt === undefined || card.status === "failed" || card.status === "failure"),
    readThreadSubAgentRevision: async () => {
      // Any card change moves it, as each write moves the store's counter.
      let revision = 0;
      for (const char of JSON.stringify(mocks.cards)) revision = (revision * 31 + char.charCodeAt(0)) >>> 0;
      return { count: mocks.cards.length, revision };
    },
  }),
}));

vi.mock("../app-server/codex-environment-config", () => ({ listCodexEnvironmentOptions: mocks.listCodexEnvironmentOptions }));

vi.mock("../messaging/messaging-bindings-snapshot", () => ({
  buildMessagingBindingsByThreadKey: vi.fn(async () => undefined),
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

function selectedCollectionService(): NavigationDetailService {
  return new NavigationDetailService({
    getCachedThreadSummary: () => thread("selected"),
    listLiveTokenMiserSubAgents: () => [],
    readLiveSubAgentRevisionSource: () => [],
    readCheckoutHibernation: () => ({ restoring: false }),
    mergeLiveTokenMiserSubAgents: (_id: string, cards: ThreadSubAgentSummary[]) => cards,
  } as unknown as DesktopBackendRegistry);
}

const selectedCollectionRequest = {
  protocol: 2 as const,
  ref: { backend: "codex" as const, threadId: "selected-💡\"" },
  collection: { name: "subAgents" as const },
};

function collectionCursor(offset: number, revision: string): string {
  return Buffer.from(JSON.stringify({ offset, revision }), "utf8").toString("base64url");
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
    mocks.projectNavigationThreadDetail.mockReset();
    mocks.getThreadOverlayState.mockReset();
    mocks.cards = [];
    mocks.prWatches = [];
    mocks.listActiveThreadPrStatusWatches.mockReset().mockImplementation(async () => mocks.prWatches);
    mocks.getLaunchpadDefaults.mockReset().mockResolvedValue({ backend: "codex", executionMode: "default" });
    mocks.getDirectoryLaunchpad.mockReset().mockResolvedValue(undefined);
    mocks.listCodexEnvironmentOptions.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    navigationDetail.setNavigationDetailPendingWakesProjector(undefined);
    vi.restoreAllMocks();
  });

  it.each([false, true])("bounds selected Git reads and keeps directory order and revision after out-of-order completion (peer wakes: %s)", async (includePendingWakes) => {
    const selected = thread("selected");
    selected.linkedDirectories = Array.from({ length: 9 }, (_, index) => ({ id: String(index), kind: "local", label: String(index), path: `/repo/${index}` }));
    mocks.projectNavigationThreadDetail.mockResolvedValue(selected);
    const project = vi.fn(async () => ({ wakes: [] }));
    navigationDetail.setNavigationDetailPendingWakesProjector(project);
    const releases = new Map<string, () => void>();
    let active = 0;
    let peak = 0;
    let gated = true;
    const read = vi.fn(async (cwd: string) => {
      active += 1;
      peak = Math.max(peak, active);
      if (gated) await new Promise<void>((resolve) => releases.set(cwd, resolve));
      active -= 1;
      return { currentBranch: cwd };
    });
    const registry = {
      getCachedThreadSummary: () => selected,
      getQueuedExecutionModeForThread: () => undefined,
      canonicalizeNavigationThreadPullRequests: async (threads: unknown[]) => threads,
      hydrateThreadGitWorkingStates: async (threads: unknown[]) => threads,
      readSelectedWorkspaceGitStatus: read,
      listLiveTokenMiserSubAgents: () => [], readLiveSubAgentRevisionSource: () => [],
      readCheckoutHibernation: () => ({ restoring: false }),
      mergeLiveTokenMiserSubAgents: (_id: string, cards: unknown[]) => cards,
    } as unknown as DesktopBackendRegistry;
    const service = new NavigationDetailService(registry);
    const request = { protocol: 2 as const, ref: { backend: "codex" as const, threadId: "selected" }, includeWorkspaceConfiguration: true };
    const options = { includePendingWakes };
    const pending = service.readSelectedDetail(request, options);
    await vi.waitFor(() => expect(releases.size).toBe(4));
    if (includePendingWakes) expect(project).toHaveBeenCalledExactlyOnceWith(request.ref, mocks.prWatches);
    else expect(project).not.toHaveBeenCalled();
    expect(mocks.listActiveThreadPrStatusWatches).toHaveBeenCalledExactlyOnceWith(request.ref);
    releases.get("/repo/3")!();
    await vi.waitFor(() => expect(releases.has("/repo/4")).toBe(true));
    gated = false;
    for (const release of releases.values()) release();
    const result = await pending;
    expect(result.thread?.pendingWakes).toEqual(includePendingWakes ? [] : undefined);
    expect(peak).toBe(4);
    expect(result.workspaceDirectories?.map((directory) => directory.key)).toEqual(selected.linkedDirectories.map((directory) => directory.id));
    const unchanged = await service.readSelectedDetail({ ...request, knownRevision: result.revision }, options);
    expect(unchanged).toMatchObject({ unchanged: true, revision: result.revision });
    read.mockRejectedValueOnce(new Error("git failed"));
    await expect(service.readSelectedDetail(request, options)).rejects.toThrow("git failed");
    read.mockClear();
    selected.linkedDirectories = Array.from({ length: 101 }, () => selected.linkedDirectories[0]!);
    await expect(service.readSelectedDetail(request, options)).rejects.toMatchObject({ code: "navigation_item_too_large" });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { offset: 0, complete: false },
    { offset: 8, complete: false },
    { offset: 98, complete: false },
    { offset: 0, complete: true },
    { offset: 8, complete: true },
    { offset: 98, complete: true },
  ])("fits exactly at the byte budget and stops one byte over at $offset (complete:$complete)", async ({ offset, complete }) => {
    const service = selectedCollectionService();
    for (const over of [0, 1]) {
      mocks.cards = Array.from({ length: offset + (complete ? 2 : 3) }, (_, index) => ({
        monitorId: `card-${index}`, task: "é💡\"\\\n", status: "success" as const,
        createdAt: -index, updatedAt: 1, lastMessage: index > offset + 1 ? "tail".repeat(100) : "",
      }));
      const baseline = await service.readSelectedDetail(selectedCollectionRequest);
      const candidate = { ...baseline, collectionPage: { ...baseline.collectionPage!,
        values: { subAgents: mocks.cards.slice(offset, offset + 2) }, complete,
        nextCursor: complete ? undefined : collectionCursor(offset + 2, baseline.revision),
      } };
      const padding = NAVIGATION_QUERY_MAX_RESULT_BYTES - Buffer.byteLength(JSON.stringify(candidate)) + over;
      mocks.cards[offset + 1]!.lastMessage = "x".repeat(padding);
      // Padding changes the revision, whose SHA-256 encoding keeps the same length.
      const first = await service.readSelectedDetail(selectedCollectionRequest);
      const response = await service.readSelectedDetail({ ...selectedCollectionRequest,
        collection: { name: "subAgents", cursor: collectionCursor(offset, first.revision) },
      });
      const taken = over === 0 ? 2 : 1;
      expect(response.collectionPage?.values.subAgents).toEqual(mocks.cards.slice(offset, offset + taken));
      expect(response.collectionPage?.complete).toBe(complete && over === 0);
      expect(response.collectionPage?.nextCursor).toBe(complete && over === 0
        ? undefined : collectionCursor(offset + taken, response.revision));
      const bytes = Buffer.byteLength(JSON.stringify(response));
      if (over === 0) expect(bytes).toBe(NAVIGATION_QUERY_MAX_RESULT_BYTES);
      else expect(bytes).toBeLessThan(NAVIGATION_QUERY_MAX_RESULT_BYTES);
    }
  });

  it.each([1, 2])("rejects a single oversized record with %i records remaining", async (count) => {
    const service = selectedCollectionService();
    mocks.cards = Array.from({ length: count }, (_, index) => ({
      monitorId: `card-${index}`, task: "task", status: "success" as const,
      createdAt: -index, updatedAt: 1, lastMessage: index > 0 ? "tail".repeat(100) : "",
    }));
    const baseline = await service.readSelectedDetail(selectedCollectionRequest);
    const candidate = { ...baseline, collectionPage: { ...baseline.collectionPage!,
      values: { subAgents: mocks.cards.slice(0, 1) }, complete: count === 1,
      nextCursor: count === 1 ? undefined : collectionCursor(1, baseline.revision),
    } };
    mocks.cards[0]!.lastMessage = "x".repeat(NAVIGATION_QUERY_MAX_RESULT_BYTES - Buffer.byteLength(JSON.stringify(candidate)));
    const exact = await service.readSelectedDetail(selectedCollectionRequest);
    expect(exact.collectionPage?.values.subAgents).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(NAVIGATION_QUERY_MAX_RESULT_BYTES);
    mocks.cards[0]!.lastMessage += "x";
    await expect(service.readSelectedDetail(selectedCollectionRequest)).rejects.toMatchObject({
      code: "navigation_item_too_large", message: "[navigation_item_too_large] One selected collection record exceeds the result budget.",
    });
  });

  it("serializes only a linear number of bytes when sizing 100 large collection records", async () => {
    mocks.cards = Array.from({ length: 100 }, (_, index) => ({
      monitorId: `card-${index}`, task: "task", status: "success" as const,
      createdAt: -index, updatedAt: 1, lastMessage: "x".repeat(2400),
    }));
    const service = selectedCollectionService();
    const stringify = vi.spyOn(JSON, "stringify");
    let serializedBytes = 0;
    let response;
    try {
      response = await service.readSelectedDetail(selectedCollectionRequest);
      serializedBytes = stringify.mock.results.reduce((sum, result) =>
        sum + (result.type === "return" && typeof result.value === "string" ? Buffer.byteLength(result.value) : 0), 0);
    } finally {
      stringify.mockRestore();
    }
    expect(response.collectionPage?.values.subAgents).toHaveLength(100);
    expect(response.collectionPage?.complete).toBe(true);
    // Includes the mock store's full-card revision hash as well as page sizing.
    expect(serializedBytes).toBeLessThan(3 * NAVIGATION_QUERY_MAX_RESULT_BYTES);
  });

  it("keeps empty collection pages complete without a cursor", async () => {
    const service = selectedCollectionService();
    const empty = await service.readSelectedDetail(selectedCollectionRequest);
    expect(empty.collectionPage).toMatchObject({ values: { subAgents: [] }, complete: true });
    expect(empty.collectionPage).not.toHaveProperty("nextCursor");
    const end = await service.readSelectedDetail({ ...selectedCollectionRequest,
      collection: { name: "subAgents", cursor: collectionCursor(0, empty.revision) },
    });
    expect(end).toEqual(empty);
  });

  it("counts UTF-8 and escaped string records in overlay collections", async () => {
    const service = selectedCollectionService();
    const values = ["é💡\"\\\n", "", "tail".repeat(100)];
    mocks.getThreadOverlayState.mockResolvedValue({ subthreadOrder: values });
    const request = { ...selectedCollectionRequest, collection: { name: "subthreadOrder" as const } };
    const baseline = await service.readSelectedDetail(request);
    const candidate = { ...baseline, collectionPage: { ...baseline.collectionPage!,
      values: { subthreadOrder: values.slice(0, 2) }, complete: false,
      nextCursor: collectionCursor(2, baseline.revision),
    } };
    values[1] = "x".repeat(NAVIGATION_QUERY_MAX_RESULT_BYTES - Buffer.byteLength(JSON.stringify(candidate)));
    const exact = await service.readSelectedDetail(request);
    expect(exact.collectionPage?.values.subthreadOrder).toEqual(values.slice(0, 2));
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(NAVIGATION_QUERY_MAX_RESULT_BYTES);
    values[1] += "x";
    const over = await service.readSelectedDetail(request);
    expect(over.collectionPage?.values.subthreadOrder).toEqual(values.slice(0, 1));
    expect(over.collectionPage?.complete).toBe(false);
    expect(over.collectionPage?.nextCursor).toBe(collectionCursor(1, over.revision));
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
    const cards = Array.from({ length: 738 }, (_, index) => ({
      monitorId: `monitor-${index}`, task: "Historical task", status: "success" as const,
      createdAt: index, updatedAt: index, lastMessage: "result".repeat(350),
    }));
    mocks.cards = cards;
    selected.agent = {
      name: "Operator",
      instructions: "exact detail only",
      instructionLineCount: 1,
      instructionsTooLong: false,
      updatedAt: 1,
    };
    mocks.projectNavigationThreadDetail.mockResolvedValue(selected);
    const registry = {
      readSelectedWorkspaceGitStatus: vi.fn(async () => ({ currentBranch: "feature", handoffBranches: ["main"] })),
      getCachedThreadSummary: vi.fn(() => undefined),
      resolveThread: vi.fn(async () => thread("selected")),
      getQueuedExecutionModeForThread: vi.fn(() => undefined),
      getQueuedTurnsSnapshot: vi.fn(() => { throw new Error("FIFO must remain independent"); }),
      hydrateThreadGitWorkingStates: vi.fn(async (threads) => threads),
      canonicalizeNavigationThreadPullRequests: vi.fn(async (threads) => threads),
      mergeLiveTokenMiserSubAgents: (_id: string, persisted: unknown[]) => persisted ?? [],
      listLiveTokenMiserSubAgents: () => [],
      readLiveSubAgentRevisionSource: () => [],
      readCheckoutHibernation: () => ({ restoring: false }),
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
    expect(mocks.reconcileNavigationSnapshot).not.toHaveBeenCalled();
    expect(mocks.projectNavigationThreadDetail).toHaveBeenCalledOnce();
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
    expect(monitors).toEqual(cards.map((agent) => agent.monitorId).reverse());
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
    const live = {
      monitorId: "system:token-miser:live", task: "Evaluate output", status: "success" as const,
      createdAt: 200, updatedAt: 200, parentTurnId: "running-turn",
    };
    const liveAgents = new Map([[live.monitorId, live]]);
    mocks.cards = persisted;
    mocks.projectNavigationThreadDetail.mockResolvedValue(selected);
    const registry = {
      getCachedThreadSummary: () => selected,
      getQueuedExecutionModeForThread: () => undefined,
      canonicalizeNavigationThreadPullRequests: async (threads: unknown[]) => threads,
      hydrateThreadGitWorkingStates: async (threads: unknown[]) => threads,
      liveTokenMiserSubAgents: new Map([[selected.id, liveAgents]]),
      liveCodexNativeSubAgentUsage: new Map(),
      mergeLiveTokenMiserSubAgents: DesktopBackendRegistry.prototype["mergeLiveTokenMiserSubAgents"],
      listLiveTokenMiserSubAgents: DesktopBackendRegistry.prototype.listLiveTokenMiserSubAgents,
      readLiveSubAgentRevisionSource: DesktopBackendRegistry.prototype.readLiveSubAgentRevisionSource,
      readCheckoutHibernation: () => ({ restoring: false }),
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
    const cards: ThreadSubAgentSummary[] = [
      { ...running, lastMessage: "large result".repeat(100_000),
        monitorUsage: { summary: "Large accounting summary".repeat(10_000), tokenUsage: { totalTokens: 1234 } } },
      ...Array.from({ length: 10_000 }, (_, index) => ({
        ...running, monitorId: `old-${index}`, status: "success" as const, completedAt: 2,
      })),
    ];
    mocks.cards = cards;
    mocks.projectNavigationThreadDetail.mockResolvedValue(selected);
    const service = new NavigationDetailService({
      getCachedThreadSummary: () => selected,
      getQueuedExecutionModeForThread: () => undefined,
      canonicalizeNavigationThreadPullRequests: async (threads: unknown[]) => threads,
      hydrateThreadGitWorkingStates: async (threads: unknown[]) => threads,
      mergeLiveTokenMiserSubAgents: (_id: string, persisted: unknown[]) => persisted,
      listLiveTokenMiserSubAgents: () => [],
      readLiveSubAgentRevisionSource: () => [],
      readCheckoutHibernation: () => ({ restoring: false }),
    } as unknown as DesktopBackendRegistry);
    const request = { protocol: 2 as const, ref: { backend: "codex" as const, threadId: selected.id } };
    const first = await service.readSelectedDetail(request);
    expect(first.thread?.activeSubAgents).toEqual([running]);
    expect(first.thread).not.toHaveProperty("subAgents");
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(4000);
    expect(mocks.getThreadOverlayState).not.toHaveBeenCalled();

    cards[0] = { ...cards[0]!, status: "success", completedAt: 3 };
    const completed = await service.readSelectedDetail({ ...request, knownRevision: first.revision });
    expect(completed.unchanged).not.toBe(true);
    expect(completed.thread?.activeSubAgents).toEqual([]);
  });

  it("projects the owner's active PR watches on selected detail only", async () => {
    const selected = thread("selected");
    const watch: ThreadPullRequestWatchSummary = {
      watchId: "watch-ci", backend: "codex", threadId: selected.id,
      prKey: "github.com/fixture/repo#7", prUrl: "https://github.com/fixture/repo/pull/7", prNumber: 7,
      headSha: "a".repeat(40), notifyOn: ["success", "failure"], createdAt: 1,
      failureHandledByAutoFix: false, kind: "checks",
    };
    mocks.prWatches = [watch];
    mocks.projectNavigationThreadDetail.mockResolvedValue(selected);
    const service = new NavigationDetailService({
      getCachedThreadSummary: () => selected,
      getQueuedExecutionModeForThread: () => undefined,
      canonicalizeNavigationThreadPullRequests: async (threads: unknown[]) => threads,
      hydrateThreadGitWorkingStates: async (threads: unknown[]) => threads,
      mergeLiveTokenMiserSubAgents: (_id: string, persisted: unknown[]) => persisted,
      listLiveTokenMiserSubAgents: () => [],
      readLiveSubAgentRevisionSource: () => [],
      readCheckoutHibernation: () => ({ restoring: false }),
    } as unknown as DesktopBackendRegistry);
    const request = { protocol: 2 as const, ref: { backend: "codex" as const, threadId: selected.id } };

    const first = await service.readSelectedDetail(request);
    expect(first.thread?.activePrWatches).toEqual([watch]);
    // The projection is per read: the stored navigation row is untouched.
    expect(selected).not.toHaveProperty("activePrWatches");
    expect(mocks.reconcileNavigationSnapshot).not.toHaveBeenCalled();

    mocks.prWatches = [];
    const stopped = await service.readSelectedDetail({ ...request, knownRevision: first.revision });
    expect(stopped.unchanged).not.toBe(true);
    expect(stopped.thread).not.toHaveProperty("activePrWatches");
  });

  it("skips wake readers locally and projects them for the existing federation detail request", async () => {
    const selected = thread("selected");
    mocks.projectNavigationThreadDetail.mockResolvedValue(selected);
    const service = new NavigationDetailService({
      getCachedThreadSummary: () => selected,
      getQueuedExecutionModeForThread: () => undefined,
      canonicalizeNavigationThreadPullRequests: async (threads: unknown[]) => threads,
      hydrateThreadGitWorkingStates: async (threads: unknown[]) => threads,
      mergeLiveTokenMiserSubAgents: (_id: string, cards: ThreadSubAgentSummary[]) => cards,
      listLiveTokenMiserSubAgents: () => [],
      readLiveSubAgentRevisionSource: () => [],
      readCheckoutHibernation: () => ({ restoring: false }),
    } as unknown as DesktopBackendRegistry);
    const monitor = { monitorId: "monitor-1", task: "Wait for CI", backend: "codex" as const,
      createdAt: 1, lastActivityAt: 2, pollIntervalSeconds: 60 };
    const readers = {
      prWatches: vi.fn(async () => []),
      prWatchHistory: vi.fn(async () => []),
      autoFix: vi.fn(async () => []),
      dependencies: vi.fn(async () => []),
      scheduledActions: vi.fn(() => ({ actions: [] })),
      monitors: vi.fn(() => [monitor]),
      recentSubAgents: vi.fn(async () => []),
      backendTasks: vi.fn(async () => []),
      backendWakes: vi.fn(() => []),
      hold: vi.fn(async () => undefined),
      heldEntries: vi.fn(() => []),
    } satisfies ThreadPendingWakeReaders;
    const project = vi.fn(async (ref: PendingWakeThread, activePrWatches: readonly ThreadPullRequestWatchSummary[]) =>
      buildThreadPendingWakes(readers, ref, { endedLimit: 0, activePrWatches }));
    navigationDetail.setNavigationDetailPendingWakesProjector(project);
    const request = { protocol: 2 as const, ref: { backend: "codex" as const, threadId: selected.id } };
    const local = await service.readSelectedDetail(request);
    expect(local.thread).not.toHaveProperty("pendingWakes");
    expect(local.thread).not.toHaveProperty("pendingWakesIncomplete");
    monitor.lastActivityAt = 3;
    const refreshed = await service.readSelectedDetail({ ...request, knownRevision: local.revision });
    expect(refreshed).toMatchObject({ revision: local.revision, unchanged: true });
    expect(project).not.toHaveBeenCalled();
    for (const reader of Object.values(readers)) expect(reader).not.toHaveBeenCalled();

    // Exercise the peer-serving bridge with the request old peers already send.
    // The projection option stays inside the owner, outside the signed request.
    vi.spyOn(navigationDetail, "getDesktopNavigationDetailService").mockReturnValue(service);
    vi.spyOn(backendRegistry, "getDesktopBackendRegistry").mockReturnValue({} as DesktopBackendRegistry);
    const { DesktopFederationRuntime, navigationInvalidationForLocalEvent } = await import("../federation/federation-runtime");
    expect(navigationInvalidationForLocalEvent({ backend: "codex", notification: {
      method: "thread/dependencies/updated", params: { threadId: selected.id, dependencyId: "dep-1" },
    } })?.notification).toMatchObject({ method: "navigation/invalidated", params: { threadId: selected.id, sourceMethod: "thread/dependencies/updated" } });
    const peer = new DesktopFederationRuntime().localBackend();
    mocks.listActiveThreadPrStatusWatches.mockClear();
    const detail = await peer.getNavigationSelectedDetail!(request);
    expect(detail.thread?.pendingWakes).toEqual([expect.objectContaining({ kind: "monitor", lastActivityAt: 3 })]);
    expect(project).toHaveBeenCalledExactlyOnceWith(request.ref, mocks.prWatches);
    expect(mocks.listActiveThreadPrStatusWatches).toHaveBeenCalledExactlyOnceWith(request.ref);
    expect(readers.prWatches).not.toHaveBeenCalled();
    for (const [name, reader] of Object.entries(readers)) {
      if (name === "prWatchHistory" || name === "recentSubAgents" || name === "prWatches") expect(reader).not.toHaveBeenCalled();
      else expect(reader).toHaveBeenCalledTimes(1);
    }
    monitor.lastActivityAt = 4;
    const updated = await peer.getNavigationSelectedDetail!({ ...request, knownRevision: detail.revision });
    expect(updated.revision).not.toBe(detail.revision);
    expect(updated.thread?.pendingWakes).toEqual([expect.objectContaining({ lastActivityAt: 4 })]);
    expect(selected).not.toHaveProperty("pendingWakes");
    expect(await service.readSelectedDetail({ ...request, knownRevision: local.revision }))
      .toMatchObject({ revision: local.revision, unchanged: true });
    // Exercise sequential completed reads, which the query pool's in-flight
    // coalescing cannot protect. Both paths use the owner's production cache.
    vi.useFakeTimers();
    try {
      let builds = 0;
      const cache = new ThreadPendingWakesCache(async (ref, options) => {
        builds += 1;
        return await buildThreadPendingWakes(readers, ref, options);
      });
      navigationDetail.setNavigationDetailPendingWakesProjector((ref, activePrWatches) =>
        cache.read(ref, { endedLimit: 0, activePrWatches }));
      for (const reader of Object.values(readers)) reader.mockClear();
      for (let requestIndex = 0; requestIndex < 96; requestIndex += 1) await service.readSelectedDetail(request);
      expectPendingWakeReadBudget("local-detail-burst", { requests: 96, builds,
        sourceCalls: Object.values(readers).reduce((sum, reader) => sum + reader.mock.calls.length, 0) });
      for (let requestIndex = 0; requestIndex < 96; requestIndex += 1) {
        const projected = await peer.getNavigationSelectedDetail!(request);
        expect(projected.thread?.pendingWakes).toEqual([expect.objectContaining({ kind: "monitor" })]);
      }
      expectPendingWakeReadBudget("peer-detail-burst", { requests: 96, builds,
        sourceCalls: Object.values(readers).reduce((sum, reader) => sum + reader.mock.calls.length, 0) });
      cache.clear();
    } finally {
      vi.useRealTimers();
    }
    selected.title = "é".repeat(100_000);
    navigationDetail.setNavigationDetailPendingWakesProjector(async () => ({ wakes: Array.from({ length: 500 }, (_, index) => ({
      kind: "monitor", key: `monitor:${index}`, monitorId: String(index), monitorBackend: "codex",
      task: "x".repeat(600), createdAt: 1, lastActivityAt: 2, pollIntervalSeconds: 60, durable: false,
    })) }));
    const large = await peer.getNavigationSelectedDetail!(request);
    expect(large.identity).toBe("present");
    expect(large.thread?.pendingWakesIncomplete).toBe(true);
    expect(large.thread?.pendingWakes?.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThanOrEqual(NAVIGATION_QUERY_MAX_RESULT_BYTES);
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

  it("tells the selected thread its worktree folder is gone, with the main checkout's branch", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-detail-missing-"));
    try {
      const selected = {
        ...thread("selected"),
        gitBranch: "fix/retry-backoff",
        linkedDirectories: [{
          id: "wt", label: "atlas", kind: "worktree" as const,
          path: root, worktreePath: path.join(root, "gone", "atlas"),
        }],
      };
      mocks.projectNavigationThreadDetail.mockResolvedValue(selected);
      const registry = {
        readSelectedWorkspaceGitStatus: vi.fn(async () => ({ currentBranch: "main" })),
        getCachedThreadSummary: vi.fn(() => selected),
        getQueuedExecutionModeForThread: vi.fn(() => undefined),
        hydrateThreadGitWorkingStates: vi.fn(async (threads) => threads),
        canonicalizeNavigationThreadPullRequests: vi.fn(async (threads) => threads),
        mergeLiveTokenMiserSubAgents: (_id: string, persisted: unknown[]) => persisted ?? [],
        listLiveTokenMiserSubAgents: () => [],
        readLiveSubAgentRevisionSource: () => [],
        readCheckoutHibernation: () => ({ restoring: false }),
      } as unknown as DesktopBackendRegistry;
      const service = new NavigationDetailService(registry);

      const missing = await service.readSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: "selected" } });
      expect(missing.thread?.workspaceMissing).toEqual({
        worktreePath: path.join(root, "gone", "atlas"),
        repositoryPath: root,
        repositoryAvailable: true,
        branch: "fix/retry-backoff",
        mainCheckoutBranch: "main",
      });

      mkdirSync(path.join(root, "gone", "atlas"), { recursive: true });
      const present = await service.readSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: "selected" } });
      expect(present.thread).not.toHaveProperty("workspaceMissing");
      expect(present.revision).not.toBe(missing.revision);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("reports a hibernated checkout instead of a missing one until its restore fails", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-detail-hibernated-"));
    try {
      const worktreePath = path.join(root, "gone", "atlas");
      const selected = {
        ...thread("selected"),
        linkedDirectories: [{ id: "wt", label: "atlas", kind: "worktree" as const, path: root, worktreePath }],
        worktreeSnapshots: [{
          id: "s", backend: "codex" as const, threadId: "selected", worktreePath, repositoryPath: root,
          snapshotRef: "refs/codex/snapshots/s", snapshotCommit: "abc", sourceBranch: "fix/retry-backoff",
          createdAt: 1, hibernatedAt: 2, state: "hibernated" as const, ignoredFilesExcluded: true,
        }],
      };
      mocks.projectNavigationThreadDetail.mockResolvedValue(selected);
      let hibernation: { restoring: boolean; restoreFailure?: { worktreePath: string; message: string } } = { restoring: true };
      const registry = {
        readSelectedWorkspaceGitStatus: vi.fn(async () => ({ currentBranch: "main" })),
        getCachedThreadSummary: vi.fn(() => selected),
        getQueuedExecutionModeForThread: vi.fn(() => undefined),
        hydrateThreadGitWorkingStates: vi.fn(async (threads) => threads),
        canonicalizeNavigationThreadPullRequests: vi.fn(async (threads) => threads),
        mergeLiveTokenMiserSubAgents: (_id: string, persisted: unknown[]) => persisted ?? [],
        listLiveTokenMiserSubAgents: () => [],
        readLiveSubAgentRevisionSource: () => [],
        readCheckoutHibernation: () => hibernation,
      } as unknown as DesktopBackendRegistry;
      const service = new NavigationDetailService(registry);

      const restoring = await service.readSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: "selected" } });
      expect(restoring.thread).not.toHaveProperty("workspaceMissing");
      expect(restoring.thread?.workspaceHibernated).toEqual({
        worktreePath, repositoryPath: root, hibernatedAt: 2, branch: "fix/retry-backoff", restoring: true,
      });

      hibernation = { restoring: false, restoreFailure: { worktreePath, message: "fix/retry-backoff moved" } };
      const failed = await service.readSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: "selected" } });
      expect(failed.thread).not.toHaveProperty("workspaceHibernated");
      expect(failed.thread?.workspaceMissing).toMatchObject({
        worktreePath, checkpoint: { snapshotRef: "refs/codex/snapshots/s", snapshotCommit: "abc" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
