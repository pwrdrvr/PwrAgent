import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AppServerBackendScope, NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { NavigationQueryIndex } from "../app-server/navigation-query-projection";
import budgets from "./fixtures/navigation-listing-budgets.json";

const mocks = vi.hoisted(() => {
  const findActiveBindings = vi.fn(async (): Promise<MessagingBindingRecord[]> => []);
  return {
    store: {
      readNavigationSourceVersion: vi.fn(() => "unchanged"),
      readNavigationQueryIndex: vi.fn((_params: { threads: NavigationThreadSummary[] }): NavigationQueryIndex => ({ threads: [], directories: [] })),
      readDirectoryGitStatusCache: async () => ({}),
    },
    messaging: {
      findActiveBindings,
      // A one-thread index uses the per-thread query. Answer it from the same
      // rows without counting a full read.
      findActiveBindingsForThread: async (params: { backend: string; threadId: string }) =>
        (await findActiveBindings.getMockImplementation()!()).filter((binding) =>
          binding.threadId === params.threadId && (!binding.backend || binding.backend === params.backend)),
    },
  };
});
vi.mock("../app-server/desktop-overlay-store", () => ({ getDesktopOverlayStore: () => mocks.store }));
vi.mock("../messaging/desktop-messaging-store", () => ({ getDesktopMessagingStore: () => mocks.messaging }));
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

  it("carries each thread's active messaging bindings on its index row", async () => {
    // The sidebar's binding chips and Unbind menu items read the row. Before
    // this, only the selected thread's detail read had bindings, so a bound
    // thread showed no chip and no Unbind control unless it was selected.
    const row = (id: string, source: NavigationThreadSummary["source"] = "codex"): NavigationThreadSummary => ({
      id, source, title: id, titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
    });
    const binding = (id: string, threadId: string, extra: Partial<MessagingBindingRecord> = {}): MessagingBindingRecord => ({
      id, threadId, backend: "codex", authorizedActorIds: [], createdAt: 1, updatedAt: 2,
      channel: { channel: "telegram", conversation: { kind: "topic", id: `${id}-topic`, title: "Grid work",
        parentTitle: "M5 Group" } },
      ...extra,
    } as MessagingBindingRecord);
    const remote = { ...row("remote-bound"), federation: { ref: { target: { scope: "remote", instanceId: "peer" },
      backend: "codex", threadId: "remote-bound" }, instanceLabel: "Peer" } } as NavigationThreadSummary;
    const original = mocks.store.readNavigationQueryIndex.getMockImplementation();
    mocks.store.readNavigationQueryIndex.mockImplementation(() => ({
      threads: [row("bound"), row("unbound"), row("other-backend", "claude"), remote], directories: [],
    }));
    mocks.messaging.findActiveBindings.mockResolvedValue([
      // The store lists by updated_at DESC; a status render bumps it. Chips
      // must stay in creation order rather than trade places.
      binding("binding-0", "bound", { createdAt: 5, updatedAt: 9,
        channel: { channel: "slack", conversation: { kind: "channel", id: "c", title: "ops" } } } as Partial<MessagingBindingRecord>),
      binding("binding-1", "bound"),
      // A binding for the same id on another backend belongs to that thread.
      binding("binding-2", "other-backend", { backend: "codex" }),
      // A remote row is the peer's thread; this machine's bindings never attach.
      binding("binding-3", "remote-bound"),
    ]);
    const source = createSource();
    source.finish();
    try {
      const index = await source.read();
      const byId = new Map(index.threads.map((thread) => [thread.id, thread]));
      expect(byId.get("bound")?.messagingBindings).toEqual([{
        bindingId: "binding-1", platform: "telegram", conversationKind: "topic",
        conversationTitle: "Grid work", parentTitle: "M5 Group", ancestorTitle: undefined, activeAt: 2,
      }, expect.objectContaining({ bindingId: "binding-0", platform: "slack", activeAt: 9 })]);
      expect(byId.get("unbound")?.messagingBindings).toBeUndefined();
      expect(byId.get("other-backend")?.messagingBindings).toBeUndefined();
      expect(byId.get("remote-bound")?.messagingBindings).toBeUndefined();
      expect(mocks.messaging.findActiveBindings).toHaveBeenCalledTimes(1);
    } finally {
      mocks.store.readNavigationQueryIndex.mockImplementation(original!);
      mocks.messaging.findActiveBindings.mockResolvedValue([]);
      mocks.messaging.findActiveBindings.mockClear();
      source.emit("thread/name/updated");
    }
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

describe("owner index reads under live turns", () => {
  it("finishes the scan it started while row events keep landing", async () => {
    // Each scan stays open until the test has emitted its events, the way a
    // busy owner's live turns land while a slow listing is in flight. The
    // pool used to restart for each one and failed the third time with
    // "Navigation changed repeatedly during its owner index read".
    const scans: Array<() => void> = [];
    const listeners = new Set<(event: AgentEvent) => void>();
    const listThreads = vi.fn(() => new Promise<[]>((resolve) => { scans.push(() => resolve([])); }));
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
    const emit = (method: string) => {
      const event = { backend: "codex", notification: { method, params: { threadId: "thread" } } } as AgentEvent;
      for (const listener of listeners) listener(event);
    };
    let settled = false;
    const read = loadLocalNavigationQueryIndex({ registry, callerReason: "thread-todo-owners" })
      .finally(() => { settled = true; });
    for (let scan = 1; scan <= 3 && !settled; scan += 1) {
      await vi.waitFor(() => expect(scans.length).toBe(1));
      emit("turn/started");
      emit("thread/status/changed");
      emit("thread/archived");
      scans.shift()!();
      await vi.waitFor(() => expect(settled || scans.length === 1).toBe(true));
    }
    await expect(read).resolves.toMatchObject({ threads: [] });
    expect(listThreads).toHaveBeenCalledTimes(1);
    // An overtaken scan is not reused, so it holds no listener afterwards.
    await vi.waitFor(() => expect(listeners.size).toBe(0));
  });
});

it.each([
  ["Inbox lens", { kind: "lens", lens: "inbox" }],
  ["selected thread's exact row", { kind: "exact", identities: [{ backend: "codex", threadId: "bound" }] }],
] as const)("serves a bound thread's bindings on its %s page row", async (_scenario, query) => {
  // The sidebar row, selected or not, renders from these pages alone; the
  // selected-detail read feeds the composer and detail pane, never the row.
  const thread: NavigationThreadSummary = { id: "bound", source: "codex", title: "Electric grid",
    titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: true } };
  const registry = {
    listThreads: async () => [thread],
    onEvent: () => () => undefined,
    canonicalizeNavigationThreadPullRequests: async (threads: NavigationThreadSummary[]) => threads,
    hydrateThreadGitWorkingStates: async (threads: NavigationThreadSummary[]) => threads,
    withNavigationSubAgentActivity: (threads: NavigationThreadSummary[]) => threads,
    getNavigationInputRequestThreadKeys: () => new Set<string>(),
  } as unknown as DesktopBackendRegistry;
  const original = mocks.store.readNavigationQueryIndex.getMockImplementation();
  mocks.store.readNavigationQueryIndex.mockImplementation(({ threads }) => ({ threads, directories: [] }));
  mocks.messaging.findActiveBindings.mockResolvedValue([{
    id: "binding-1", threadId: "bound", backend: "codex", authorizedActorIds: [], createdAt: 1, updatedAt: 2,
    channel: { channel: "telegram", conversation: { kind: "topic", id: "topic", title: "Electric grid" } },
  } as MessagingBindingRecord]);
  try {
    const request = { protocol: 2, consumer: "main-sidebar", query } as NavigationQueryRequest;
    const page = await new NavigationQueryStore().readPage({
      request, scopeKey: "renderer-local",
      loadIndex: () => loadLocalNavigationQueryIndex({ registry, callerReason: "renderer-navigation-query" }),
    });
    const row = page.entries.find((entry) => entry.row.id === "bound")?.row;
    expect(row?.messagingBindings).toEqual([expect.objectContaining({
      bindingId: "binding-1", platform: "telegram", conversationTitle: "Electric grid",
    })]);
  } finally {
    mocks.store.readNavigationQueryIndex.mockImplementation(original!);
    mocks.messaging.findActiveBindings.mockResolvedValue([]);
  }
});

it.each([
  ["title change", ["thread/name/updated"]],
  ["pin action", ["thread/pin/added"]],
  ["mark seen", ["navigation/thread/seen"]],
  ["turn start", ["turn/started", "thread/status/changed", "thread/subAgents/updated"]],
])("bounds physical listing work for %s across directory, children and exact consumers", async (_scenario, methods) => {
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
    for (const [index, method] of methods.entries()) {
      emit(method);
      pending.push(read(index + 1));
      await Promise.resolve();
    }
    for (let index = pending.length; index < requests.length; index++) pending.push(read(index));
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

describe("owner index coverage", () => {
  function readCoverage(params: {
    startup?: { state: "checking" | "degraded" | "ready"; failedProviders?: number };
    incomplete: boolean;
  }) {
    const listed: NavigationThreadSummary[] = [];
    const registry = {
      listThreads: async () => listed,
      isIncompleteThreadList: (threads: unknown) => params.incomplete && threads === listed,
      getStartupProviderRefreshStatus: () => params.startup,
      onEvent: () => () => {},
      canonicalizeNavigationThreadPullRequests: async (threads: []) => threads,
      hydrateThreadGitWorkingStates: async (threads: []) => threads,
      withNavigationSubAgentActivity: (threads: []) => threads,
      getNavigationInputRequestThreadKeys: () => new Set<string>(),
    } as unknown as DesktopBackendRegistry;
    return loadLocalNavigationQueryIndex({ registry, callerReason: "coverage-regression" })
      .then((index) => index.coverage);
  }

  it("completes an index built from a complete listing after a degraded startup", async () => {
    // A Claude or ACP discovery failure at startup, or a Codex failure that has
    // since recovered, must not block group archive for the whole session.
    await expect(readCoverage({ startup: { state: "degraded", failedProviders: 2 }, incomplete: false }))
      .resolves.toEqual({ state: "complete" });
  });

  it("degrades an index whose listing stood in an empty Codex inventory after a ready startup", async () => {
    await expect(readCoverage({ startup: { state: "ready" }, incomplete: true }))
      .resolves.toEqual({ state: "degraded", failedProviders: 1 });
  });

  it("keeps an index checking until the startup provider refresh settles", async () => {
    await expect(readCoverage({ startup: { state: "checking" }, incomplete: false }))
      .resolves.toEqual({ state: "checking" });
  });
});
