import {
  createDeferred,
  createMessagingArchiveCleanupStoreMock,
  createOverlayStoreMock,
  flushAsync,
  MockBackendClient,
  waitForCondition,
} from "./helpers/backend-registry-fixture";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { ArchiveCleanupTransport } from "./fixtures/archive-cleanup-transport";

type PartialRead = "limit" | "maxPages" | "failure" | "repeatedCursor";

async function checkInventory(reads: PartialRead[], prefixLength: number) {
  const provider = new CodexAppServerClient({ directoryResolver: async () => [] });
  await provider.getInitializeResult();
  const transport = ArchiveCleanupTransport.latest;
  const row = (id: string) => ({ id, cwd: "/fixture/project" });
  const prefix = Array.from({ length: 100 }, (_, i) => row(`active-${i}`));
  const archived = Array.from({ length: 100 }, (_, i) => row(`archived-${i}`));
  const inventory = {
    active: [...prefix, row("bound"), row("disappears")],
    archived: [...archived, row("older")],
  };
  transport.rows = inventory;
  let failActive = false;
  const client = Object.assign(new MockBackendClient({}), {
    async listThreads(...[params, diagnostics, onIncompletePageWalk]: Parameters<CodexAppServerClient["listThreads"]>) {
      if (!params?.archived && failActive) throw new Error("fixture provider unavailable");
      // Isolate the separate archived-metadata scheduler below the registry.
      // The Codex paginator uses limit as a page size. Model an adapter that
      // returns only the requested rows for limit alone. maxPages truncates
      // in the production paginator, with a live cursor after the first page.
      const rows = await provider.listThreads({ ...params, skipArchivedMetadataRefresh: true }, diagnostics, onIncompletePageWalk);
      return params?.limit === undefined ? rows : rows.slice(0, params.limit);
    },
  });
  const store = createMessagingArchiveCleanupStoreMock({ bindings: [{ id: "binding", threadId: "bound" }] });
  const bindings = vi.spyOn(store, "findActiveBindingsForBackend");
  const registry = createDesktopBackendRegistry({
    codexClient: client, messagingStore: store, overlayStore: createOverlayStoreMock(),
    resolveCodexRuntimeCommand: async () => ({ command: "/fixture/codex", version: "0.160.0" }),
  });
  const list = (bounds: { archived?: boolean; limit?: number; maxPages?: number } = {}) => registry.listThreads({
    backend: "codex", forceRefresh: true, enrichDirectories: false, ...bounds,
  });
  const archivedCursors = () => transport.listings.filter((rpc) => rpc.archived).map((rpc) => rpc.cursor);
  try {
    expect((await list()).map((row) => row.id)).toEqual(inventory.active.map(({ id }) => id));
    for (const read of reads) {
      failActive = read === "failure";
      transport.repeatActiveCursor = read === "repeatedCursor";
      const bounds = { repeatedCursor: {}, limit: { limit: prefixLength }, maxPages: { maxPages: 1 }, failure: {} };
      const expected = { limit: prefix.slice(0, prefixLength), maxPages: prefix.slice(0, 50), repeatedCursor: prefix, failure: [] };
      const rows = await list(bounds[read]);
      expect(rows.map(({ id }) => id)).toEqual(expected[read].map(({ id }) => id));
      if (failActive || transport.repeatActiveCursor) expect(registry.isIncompleteThreadList(rows)).toBe(true);
      await flushAsync();
      expect(archivedCursors()).toEqual([]);
      expect(bindings).toHaveBeenCalledTimes(1);
    }
    // No binding on this thread: only the last complete baseline can detect
    // its disappearance. Membership is on the last of three physical pages.
    failActive = false;
    transport.repeatActiveCursor = false;
    inventory.active = [...prefix, row("bound")];
    inventory.archived = [...archived, row("disappears")];
    await list();
    await flushAsync();
    expect(archivedCursors()).toEqual([undefined, "50", "100"]);
    expect(store.deletedPendingThreads).toEqual([{ backend: "codex", threadId: "disappears" }]);
    expect(store.revokedBindingIds).toEqual([]);

    // A bounded archive page still provides positive evidence for its rows.
    await list({ archived: true, limit: 1, maxPages: 1 });
    expect(store.deletedPendingThreads).toEqual([
      { backend: "codex", threadId: "disappears" }, { backend: "codex", threadId: "archived-0" },
    ]);
  } finally {
    await registry.close();
    await provider.close();
  }
}

it.each<PartialRead>(["limit", "maxPages", "failure", "repeatedCursor"])("keeps the complete active inventory after %s", async (read) => {
  await checkInventory([read], 1);
});

it("infers disappearances only between complete active inventories", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.constantFrom<PartialRead>("limit", "maxPages", "failure", "repeatedCursor"), { minLength: 1, maxLength: 5 }),
    fc.integer({ min: 1, max: 5 }), checkInventory,
  ), { numRuns: 25 });
});

it("fences an in-flight membership read when a bounded active list observes a restore", async () => {
  const restored: AppServerThreadSummary = {
    id: "restored", source: "codex", title: "Restored", titleSource: "explicit", linkedDirectories: [],
  };
  const pending = createDeferred<AppServerThreadSummary[]>();
  const membership = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue([]);
  const client = new MockBackendClient({});
  const list = client.listThreads.bind(client);
  vi.spyOn(client, "listThreads").mockImplementation((params, diagnostics) =>
    params?.archived ? membership() : list(params, diagnostics));
  const store = createMessagingArchiveCleanupStoreMock({ bindings: [{ id: "binding", threadId: restored.id }] });
  const registry = createDesktopBackendRegistry({ codexClient: client, messagingStore: store, overlayStore: createOverlayStoreMock() });
  try {
    await registry.listThreads({ backend: "codex" });
    await waitForCondition(() => membership.mock.calls.length === 1);
    client.setThreads([restored]);
    await registry.listThreads({ backend: "codex", limit: 1 });
    pending.resolve([restored]);
    await flushAsync();
    expect(membership).toHaveBeenCalledTimes(2);
    expect(store.revokedBindingIds).toEqual([]);
    expect(store.deletedPendingThreads).toEqual([]);
  } finally {
    pending.resolve([]);
    await registry.close();
  }
});

const summary = (id: string): AppServerThreadSummary => ({
  id, source: "codex", title: id, titleSource: "explicit", linkedDirectories: [],
});

it("reconciles the positive rows of a partial first inventory on the next complete read", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.subarray(["thread-1", "other"]), { maxLength: 3 }), async (reads) => {
    const archived: AppServerThreadSummary[] = [];
    const client = new MockBackendClient({ archivedThreads: archived });
    const store = createMessagingArchiveCleanupStoreMock({ pendingIntentIds: ["intent"] });
    const bindings = vi.spyOn(store, "findActiveBindingsForBackend");
    const registry = createDesktopBackendRegistry({ codexClient: client, messagingStore: store, overlayStore: createOverlayStoreMock() });
    try {
      for (const ids of [["thread-1"], ...reads]) {
        client.setThreads(ids.map(summary));
        await registry.listThreads({ backend: "codex", limit: 2, forceRefresh: true });
      }
      expect(bindings).not.toHaveBeenCalled();
      archived.push(summary("thread-1"));
      client.setThreads([summary("other")]);
      await registry.listThreads({ backend: "codex" });
      await flushAsync();
      expect(store.deletedPendingThreads).toEqual([{ backend: "codex", threadId: "thread-1" }]);
    } finally {
      await registry.close();
    }
  }), { numRuns: 12 });
});

it("cleans only archived identities without a newer active observation", async () => {
  await fc.assert(fc.asyncProperty(fc.subarray(["a", "b", "c"], { minLength: 1, maxLength: 2 }), async (restored) => {
    const ids = ["a", "b", "c"];
    const client = new MockBackendClient({ threads: ids.map(summary), archivedThreads: ids.map(summary) });
    const filterStarted = createDeferred<void>();
    const oldActiveFilter = createDeferred<AppServerThreadSummary[]>();
    const list = client.listThreads.bind(client);
    vi.spyOn(client, "listThreads").mockImplementation((params, diagnostics) => {
      if (diagnostics?.callerReason?.endsWith(":active-archive-filter")) {
        filterStarted.resolve();
        return oldActiveFilter.promise;
      }
      return list(params, diagnostics);
    });
    const store = createMessagingArchiveCleanupStoreMock({ bindings: ids.map((id) => ({ id, threadId: id })) });
    const registry = createDesktopBackendRegistry({ codexClient: client, messagingStore: store, overlayStore: createOverlayStoreMock() });
    try {
      await registry.listThreads({ backend: "codex" });
      client.setThreads([]);
      const archived = registry.listThreads({ backend: "codex", archived: true });
      await filterStarted.promise;
      client.setThreads(restored.map(summary));
      await registry.listThreads({ backend: "codex", limit: restored.length });
      oldActiveFilter.resolve([]);
      await archived;
      await flushAsync();
      expect(store.revokedBindingIds.sort()).toEqual(ids.filter((id) => !restored.includes(id)));
    } finally {
      oldActiveFilter.resolve([]);
      await registry.close();
    }
  }), { numRuns: 12 });
});

it("reports a repeated cursor to each reader sharing the physical page walk", async () => {
  const provider = new CodexAppServerClient({ directoryResolver: async () => [] });
  await provider.getInitializeResult();
  const transport = ArchiveCleanupTransport.latest;
  transport.rows = { active: ["a", "b", "c"].map((id) => ({ id, cwd: "/fixture/project" })), archived: [] };
  transport.repeatActiveCursor = true;
  transport.holdNextListing(false);
  try {
    const incomplete = [vi.fn(), vi.fn(), vi.fn()];
    // Two identical listings share enrichment. A third shares only raw pages.
    const reads = incomplete.map((notify, i) => provider.listThreads({
      limit: 1, enrichDirectories: i === 2, skipArchivedMetadataRefresh: true,
    }, undefined, notify));
    await transport.whenListing(false);
    transport.releaseListings();
    for (const rows of await Promise.all(reads)) expect(rows.map(({ id }) => id)).toEqual(["a", "b"]);
    for (const notify of incomplete) expect(notify).toHaveBeenCalledOnce();
    expect(transport.listings.map(({ cursor }) => cursor)).toEqual([undefined, "1"]);
  } finally {
    transport.releaseListings();
    await provider.close();
  }
});
