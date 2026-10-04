import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AppServerBackendScope, NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { NavigationQueryIndex } from "../app-server/navigation-query-projection";
import budgets from "./fixtures/navigation-listing-budgets.json";

const mocks = vi.hoisted(() => ({
  store: {
    readNavigationSourceVersion: vi.fn(() => "unchanged"),
    readNavigationQueryIndex: vi.fn((_params: { threads: NavigationThreadSummary[] }): NavigationQueryIndex => ({ threads: [], directories: [] })),
    readDirectoryGitStatusCache: async () => ({}),
  },
}));
vi.mock("../app-server/desktop-overlay-store", () => ({ getDesktopOverlayStore: () => mocks.store }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: vi.fn() }));
vi.mock("../app-server/scratch-projects", () => ({ resolveScratchProjectsRoots: () => [] }));
import { loadLocalNavigationQueryIndex } from "../app-server/navigation-query-source";
import { NavigationQueryPool } from "../app-server/navigation-query-pool";
import { NavigationQueryStore } from "../app-server/navigation-query-store";

function createSource() {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const listeners = new Set<(event: AgentEvent) => void>();
  const listThreads = vi.fn(async (_params?: { forceRefresh?: boolean }) => { await gate; return []; });
  const registry = {
    listThreads,
    onEvent: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    canonicalizeNavigationThreadPullRequests: async (threads: []) => threads,
    hydrateThreadGitWorkingStates: async (threads: []) => threads,
    withNavigationSubAgentActivity: (threads: []) => threads,
    getNavigationInputRequestThreadKeys: () => new Set<string>(),
  } as unknown as DesktopBackendRegistry;
  return {
    finish, listThreads, listeners,
    read: (backend?: AppServerBackendScope) => loadLocalNavigationQueryIndex({ registry, backend, callerReason: "source-event-regression" }),
    refresh: () => loadLocalNavigationQueryIndex({ registry, callerReason: "source-event-regression", refreshProviders: true }),
    emit: (method: string) => {
      const event = { backend: "codex", notification: { method, params: { threadId: "thread" } } } as AgentEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

describe("owner index source event admission", () => {
  it("shares pending index work across transcript-only events", async () => {
    const source = createSource();
    const first = source.read();
    await Promise.resolve();
    source.emit("item/agentMessage/delta");
    source.emit("thread/tokenUsage/updated");
    const second = source.read();
    await Promise.resolve();
    source.finish();
    const [a, b] = await Promise.all([first, second]);
    expect(source.listThreads).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(await source.read()).toBe(a);
    expect(source.listThreads).toHaveBeenCalledTimes(1);
    expect(source.listeners.size).toBe(1);
    source.emit("thread/name/updated");
    expect(source.listeners.size).toBe(0);
  });

  it("runs a provider refresh beside an in-flight read without costing it a retry", async () => {
    const source = createSource();
    const first = source.read();
    await Promise.resolve();
    const refreshed = source.refresh();
    await Promise.resolve();
    source.finish();
    await Promise.all([first, refreshed]);
    // The refresh lists providers afresh; the read in flight finishes once.
    expect(source.listThreads.mock.calls.map(([params]) => Boolean(params?.forceRefresh)))
      .toEqual([false, true]);
  });

  it("does not restart an index for a subagent event with unchanged navigation", async () => {
    const source = createSource();
    const first = source.read();
    await Promise.resolve();
    const event = { backend: "codex", notification: { method: "thread/subAgents/updated",
      params: { threadId: "thread", navigationChanged: false } } } as AgentEvent;
    for (const listener of source.listeners) listener(event);
    const second = source.read();
    source.finish();
    expect(await second).toBe(await first);
    expect(source.listThreads).toHaveBeenCalledTimes(1);
    source.emit("thread/name/updated");
  });

  it("keeps repeated unchanged reads stable, but refreshes after a durable source version change", async () => {
    const source = createSource();
    source.finish();
    try {
      const first = await source.read();
      for (let index = 0; index < 20; index++) expect(await source.read()).toBe(first);
      expect(source.listThreads).toHaveBeenCalledTimes(1);
      mocks.store.readNavigationSourceVersion.mockReturnValue("external-change");
      const changed = await source.read();
      expect(changed).not.toBe(first);
      expect(source.listThreads).toHaveBeenCalledTimes(2);
      expect(await source.read()).toBe(changed);
    } finally {
      mocks.store.readNavigationSourceVersion.mockReturnValue("unchanged");
      source.emit("thread/name/updated");
    }
  });

  it("shares one replacement across durable revisions while an owner scan is pending", async () => {
    const source = createSource();
    const reads = [source.read()];
    try {
      await Promise.resolve();
      for (let revision = 1; revision <= 12; revision++) {
        mocks.store.readNavigationSourceVersion.mockReturnValue(`revision-${revision}`);
        const read = source.read();
        void read.catch(() => undefined);
        reads.push(read);
        await Promise.resolve();
      }
      source.finish();
      const results = await Promise.allSettled(reads);
      expect(results).toEqual(reads.map(() => expect.objectContaining({ status: "fulfilled" })));
      expect(source.listThreads).toHaveBeenCalledTimes(2);
      const first = await reads[0];
      for (const read of reads) expect(await read).toBe(first);
      expect(await source.read()).toBe(first);
      expect(source.listThreads).toHaveBeenCalledTimes(2);
      expect(source.listeners.size).toBe(1);
    } finally {
      source.finish();
      mocks.store.readNavigationSourceVersion.mockReturnValue("unchanged");
      source.emit("thread/name/updated");
      await Promise.allSettled(reads);
    }
    expect(source.listeners.size).toBe(0);
  });

  it("does not share owner work across registries or provider scopes", async () => {
    const first = createSource();
    const second = createSource();
    first.finish(); second.finish();
    try {
      await Promise.all([first.read(), first.read("codex"), second.read()]);
      expect(first.listThreads).toHaveBeenCalledTimes(2);
      expect(second.listThreads).toHaveBeenCalledTimes(1);
      await Promise.all([first.read(), first.read("codex"), second.read()]);
      expect(first.listThreads).toHaveBeenCalledTimes(2);
      expect(second.listThreads).toHaveBeenCalledTimes(1);
    } finally {
      first.emit("thread/name/updated"); second.emit("thread/name/updated");
    }
  });

  it("starts fresh owner work after a canonical navigation event", async () => {
    const source = createSource();
    const first = source.read();
    await Promise.resolve();
    source.emit("thread/name/updated");
    const second = source.read();
    await Promise.resolve();
    source.finish();
    const [a, b] = await Promise.all([first, second]);
    expect(source.listThreads).toHaveBeenCalledTimes(2);
    expect(a).toBe(b);
    expect(source.listeners.size).toBe(1);
    source.emit("thread/name/updated");
    expect(source.listeners.size).toBe(0);
  });

  it("shares one replacement scan across consumers admitted between related events", async () => {
    const source = createSource();
    const reads = [source.read()];
    await Promise.resolve();
    for (const method of ["turn/started", "thread/status/changed", "thread/subAgents/updated", "navigation/thread/seen"]) {
      source.emit(method);
      reads.push(source.read());
      await Promise.resolve();
    }
    source.finish();
    const results = await Promise.all(reads);
    expect(source.listThreads).toHaveBeenCalledTimes(2);
    expect(results.every((result) => result === results[0])).toBe(true);
    expect(source.listeners.size).toBe(1);
    source.emit("thread/name/updated");
    expect(source.listeners.size).toBe(0);
  });
});

it("bounds physical listing work for a turn start across directory, children and exact consumers", async () => {
  const originalProjection = mocks.store.readNavigationQueryIndex.getMockImplementation();
  mocks.store.readNavigationQueryIndex.mockClear();
  const parent: NavigationThreadSummary = { id: "parent", source: "codex", title: "before", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false } };
  let current = parent;
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStart = new Promise<void>((resolve) => { firstStarted = resolve; });
  const listeners = new Set<(event: AgentEvent) => void>();
  const rpc = vi.fn();
  const listThreads = vi.fn(async () => {
    const snapshot = current;
    for (let page = 1; page <= 3; page++) {
      rpc(page);
      if (listThreads.mock.calls.length === 1 && page === 1) {
        firstStarted();
        await firstGate;
      }
    }
    return [snapshot];
  });
  const registry = {
    listThreads,
    onEvent: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    canonicalizeNavigationThreadPullRequests: async (threads: NavigationThreadSummary[]) => threads,
    hydrateThreadGitWorkingStates: async (threads: NavigationThreadSummary[]) => threads,
    withNavigationSubAgentActivity: (threads: NavigationThreadSummary[]) => threads,
    getNavigationInputRequestThreadKeys: () => new Set<string>(),
  } as unknown as DesktopBackendRegistry;
  mocks.store.readNavigationQueryIndex.mockImplementation(({ threads }) => ({ threads, directories: [] }));
  const pool = new NavigationQueryPool();
  const store = new NavigationQueryStore();
  const requests: NavigationQueryRequest[] = [
    { protocol: 2, consumer: "main-sidebar", query: { kind: "directory", directoryKey: "project" } },
    { protocol: 2, consumer: "main-sidebar", query: { kind: "children", parent: { backend: "codex", threadId: "parent" } } },
    { protocol: 2, consumer: "main-sidebar", query: { kind: "exact", identities: [{ backend: "codex", threadId: "parent" }] } },
    { protocol: 2, consumer: "main-sidebar", query: { kind: "directory", directoryKey: "project" } },
  ];
  const read = (index: number) => pool.read({
    consumerId: `sidebar-${index}`,
    request: requests[index]!,
    load: ({ signal }) => store.readPage({
      request: requests[index]!, scopeKey: "renderer-local",
      loadIndex: () => loadLocalNavigationQueryIndex({ registry, callerReason: "renderer-navigation-query", signal }),
    }),
  });
  const emit = (method: string) => {
    const event = { backend: "codex", notification: { method, params: { threadId: "parent" } } } as AgentEvent;
    for (const listener of listeners) listener(event);
    store.observeAttentionEvent(event);
    pool.invalidateQueryOwner();
  };
  try {
    const pending = [read(0)];
    await firstStart;
    current = { ...parent, title: "after", threadStatus: "active" };
    for (const [index, method] of ["turn/started", "thread/status/changed", "thread/subAgents/updated"].entries()) {
      emit(method);
      pending.push(read(index + 1));
      await Promise.resolve();
    }
    releaseFirst();
    const pages = await Promise.all(pending);
    expect(pages[2]!.entries[0]?.row.title).toBe("after");
    expect({ logicalRequests: pending.length, indexConstructions: mocks.store.readNavigationQueryIndex.mock.calls.length,
      providerListings: listThreads.mock.calls.length, paginatedRpcs: rpc.mock.calls.length, pagesPerListing: 3 })
      .toEqual(budgets["turn-start-with-related-notifications"]);
    const rerender = await Promise.all(requests.map((_, index) => read(index)));
    expect(rerender[2]!.entries[0]?.row.title).toBe("after");
    expect({ logicalRequests: rerender.length, indexConstructions: mocks.store.readNavigationQueryIndex.mock.calls.length,
      providerListings: listThreads.mock.calls.length, paginatedRpcs: rpc.mock.calls.length, pagesPerListing: 3 })
      .toEqual(budgets["unchanged-rerender"]);
    current = { ...current, title: "later" };
    emit("thread/name/updated");
    const later = await read(2);
    expect(later.entries[0]?.row.title).toBe("later");
    expect({ logicalRequests: 1, indexConstructions: mocks.store.readNavigationQueryIndex.mock.calls.length,
      providerListings: listThreads.mock.calls.length, paginatedRpcs: rpc.mock.calls.length, pagesPerListing: 3 })
      .toEqual(budgets["later-mutation"]);
  } finally {
    releaseFirst();
    for (let index = 0; index < requests.length; index++) pool.release(`sidebar-${index}`);
    mocks.store.readNavigationQueryIndex.mockImplementation(originalProjection!);
  }
});
