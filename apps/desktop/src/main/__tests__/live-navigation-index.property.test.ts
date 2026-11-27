import fc from "fast-check";
import { expect, it } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationQueryPage, NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { buildFederatedThreadRef } from "@pwragent/shared/contracts/federation";
import { appendViewerNavigationPins } from "../app-server/navigation-viewer-pins";
import { buildDirectorySummaries } from "@pwragent/shared/directory-navigation";
import { expandNavigationRemoteOwner, navigationQueryPageBudgetBytes } from "@pwragent/shared/navigation-remote-owner";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { NavigationQueryStore } from "@pwragent/owner-core/navigation-query-store";
import { projectNavigationQuery } from "@pwragent/owner-core/navigation-query-projection";
import { LiveNavigationIndex } from "../app-server/live-navigation-index";
import { NavigationWindowPageDeltas } from "../app-server/navigation-window-page-deltas";
import { expandWindowNavigationPage, NavigationWindowQueries } from "../../renderer/src/lib/navigation-window-queries";

function fixture(observe?: (event: AgentEvent) => void, durable = false,
  refresh?: ConstructorParameters<typeof LiveNavigationIndex>[0]["refresh"]) {
  const db = durable ? openInMemoryStateDb() : undefined;
  const storage = db && new SqliteOverlayStore(db);
  const providers = new Map<string, AppServerThreadSummary>(["a", "b", "c", "d"].map((id) =>
    [id, { id, source: "codex", title: id, titleSource: "explicit", updatedAt: 2, linkedDirectories: [{ id: "project", label: "Project", path: "/project", kind: "local" }], threadStatus: "idle" }]));
  const archived = new Set<string>();
  const overlays = new Map<string, Partial<NavigationThreadSummary>>();
  const rows = () => [...providers.values()].filter((row) => !archived.has(row.id));
  const projectRows = (threads: AppServerThreadSummary[]): NavigationThreadSummary[] => storage
    ? storage.readNavigationQueryThreads({ backend: "all", threads }).threads
    : threads.map((row) => ({ ...row, inbox: { inInbox: false }, ...overlays.get(row.id) }));
  const directories = (threads: NavigationThreadSummary[]) => ({ directories: storage ? storage.readNavigationQueryDirectories(threads).directories : buildDirectorySummaries({ threads }) });
  const full = () => {
    const inputs = rows();
    const threads = storage ? storage.readNavigationQueryIndex({ backend: "all", threads: inputs }) : undefined;
    if (threads) return { threads: threads.threads, directories: threads.directories, coverage: { state: "complete" as const } };
    const projected = projectRows(inputs);
    const index = { threads: projected, ...directories(projected) };
    return { threads: index.threads, directories: index.directories, coverage: { state: "complete" as const } };
  };
  function persist(id: string) {
    const row = overlays.get(id)!;
    db?.raw.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)").run("codex:" + id,
      JSON.stringify({ backend: "codex", threadId: id, parentThreadId: row.parentThreadId, pinnedRank: row.pinnedRank,
        lastSeenUpdatedAt: row.inbox?.inInbox ? 1 : 2 }));
  }
  let complete = Promise.withResolvers<void>();
  let gate: Promise<void> | undefined;
  let version = 0;
  const lists: string[] = [];
  const live = new LiveNavigationIndex({
    backend: "all", version: () => String(version) + ":0", changedKeys: () => undefined,
    sqlite: async () => { const result = structuredClone(rows()); await gate; return result; },
    list: async (scope) => {
      lists.push(scope);
      const captured = structuredClone(rows());
      await gate;
      return { rows: captured, coverage: { state: "complete" } };
    },
    join: async (rows, coverage) => {
      const threads = projectRows(rows);
      return { threads, coverage, ...directories(threads) };
    },
    cached: (_, id) => providers.get(id), refresh,
    projectRows: async (rows) => projectRows(rows), directories: async (threads) => { await gate; return directories(threads); },
    inputKeys: () => new Set(), notify: () => complete.resolve(), failed: (error) => { throw error; },
  });
  const emit = (notification: AgentEvent["notification"]) => {
    const event = { backend: "codex" as const, notification };
    observe?.(event);
    live.event(event);
  };
  return { live, providers, archived, overlays, full, emit, lists, persist, close: () => { live.close(); db?.close(); },
    block: (promise: Promise<void>) => { gate = promise; },
    external: () => { version++; },
    completion: () => { complete = Promise.withResolvers<void>(); return complete.promise; } };
}

const operation = fc.record({
  kind: fc.constantFrom("status", "pin", "parent", "archive", "seen", "reconnect"),
  id: fc.constantFrom("a", "b", "c", "d"), on: fc.boolean(),
});

async function compareSequence(ops: readonly { kind: string; id: string; on: boolean }[], durable = false) {
  const actualStore = new NavigationQueryStore();
  const expectedStore = new NavigationQueryStore();
  const f = fixture((event) => {
    actualStore.observeAttentionEvent(event);
    expectedStore.observeAttentionEvent(event);
  }, durable);
  try {
    await f.live.read();
    for (const { kind, id, on } of ops) {
      const provider = f.providers.get(id)!;
      const overlay = f.overlays.get(id) ?? {};
      f.overlays.set(id, overlay);
      if (kind === "reconnect") {
        provider.threadStatus = on ? "active" : "idle";
        const done = f.completion();
        f.emit({ method: "navigation/providerThreads/refreshed", params: { failedProviders: 0, backend: "codex" } });
        await done;
      } else if (kind === "archive") {
        if (on) f.archived.add(id);
        else f.archived.delete(id);
        f.emit(on ? { method: "thread/archived", params: { threadId: id } } : { method: "thread/unarchived", params: { threadId: id } });
      } else if (kind === "status") {
        provider.threadStatus = on ? "active" : "idle";
        f.emit({ method: "thread/status/changed", params: { threadId: id, status: { type: provider.threadStatus } } });
      } else if (kind === "pin") {
        overlay.pinnedRank = on ? "100" : undefined;
        f.emit(on ? { method: "thread/pin/added", params: { threadId: id, pinnedRank: "100" } }
          : { method: "thread/pin/removed", params: { threadId: id } });
      } else if (kind === "parent" && id !== "a") {
        overlay.parentThreadId = on ? "a" : undefined;
        f.emit(on ? { method: "thread/parent/set", params: { threadId: id, parentThreadId: "a" } }
          : { method: "thread/parent/cleared", params: { threadId: id } });
      } else {
        overlay.inbox = { inInbox: on };
        f.emit({ method: "navigation/thread/seen", params: { threadId: id } });
      }
      if (kind === "pin" || kind === "parent" || kind === "seen") f.persist(id);
      const index = await f.live.read();
      const reference = { ...f.full(), observedAt: index.observedAt };
      for (const query of [
        { kind: "lens", lens: "inbox", roots: "pinned" }, { kind: "directory-index" },
      ] as const) {
        const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query };
        expect(projectNavigationQuery({ index, request })).toEqual(projectNavigationQuery({ index: reference, request }));
      }
      for (const promote of [true, false]) {
        const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "attention" },
          attentionView: { id: String(promote), promoteOnTurnEnd: promote }, pageSize: 2 };
        const actual = await actualStore.readPage({ scopeKey: "test", request, loadIndex: async () => index });
        const expected = await expectedStore.readPage({ scopeKey: "test", request, loadIndex: async () => reference });
        expect([actual.entries, actual.counts, Boolean(actual.nextCursor)]).toEqual([expected.entries, expected.counts, Boolean(expected.nextCursor)]);
      }
    }
  } finally { f.close(); }
}

it("agrees with full projection after status, pin, archive, parent, seen and reconnect events", async () => {
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 5, maxLength: 18 }), (ops) => compareSequence(ops)), { numRuns: 5 });
});

it("matches the full SQLite join after a pinned child disappears and returns across reconnect", async () => {
  await compareSequence(["pin", "parent", "status", "seen", "archive", "reconnect", "archive"].map((kind, i) =>
    ({ kind, id: "b", on: i !== 6 })), true);
});

it("keeps the last page during a SQLite gap and applies a newer event over a delayed source listing", async () => {
  const f = fixture();
  const old = await f.live.read();
  const gate = Promise.withResolvers<void>();
  const complete = f.completion();
  try {
    f.block(gate.promise);
    f.providers.get("b")!.title = "external rename";
    f.external();
    expect(await f.live.read()).toBe(old);
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.emit({ method: "thread/name/updated", params: { threadId: "a", threadName: "newer" } });
    expect(await f.live.read()).toBe(old);
    gate.resolve();
    await complete;
    const next = await f.live.read();
    expect(next.threads.map((row) => row.title)).toEqual(["newer", "external rename", "c", "d"]);
    expect(old.threads.map((row) => row.title)).toEqual(["a", "b", "c", "d"]);
  } finally { gate.resolve(); f.close(); }
});

it("transmits one changed entry and recovers with a full page when the window loses its baseline", async () => {
  const f = fixture();
  const store = new NavigationQueryStore();
  const wire = new NavigationWindowPageDeltas();
  const read = () => store.readPage({ scopeKey: "test", request: { protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" } },
    loadIndex: () => f.live.read() });
  try {
    const first = wire.encode("window", "", await read());
    const base = first.windowPagePatch!.token;
    const previous = expandWindowNavigationPage(first)!;
    f.live.refreshRows(["codex:a"], true);
    f.emit({ method: "thread/name/updated", params: { threadId: "a", threadName: "changed" } });
    const full = await read();
    const delta = wire.encode("window", base, full);
    expect(delta.entries.map((entry) => entry.row.title)).toEqual(["changed"]);
    expect(expandWindowNavigationPage(delta, previous, base)).toEqual(full);
    expect(expandWindowNavigationPage(delta, previous, "wrong")).toBeUndefined();
    const moved = { ...full, entries: [...full.entries].reverse().map((entry, i) => ({ ...entry, orderKey: String(i) })) };
    const reorder = wire.encode("window", delta.windowPagePatch!.token, moved);
    expect(reorder.entries).toHaveLength(0);
    expect(expandWindowNavigationPage(reorder, full, delta.windowPagePatch!.token)).toEqual(moved);
    expect(wire.encode("window", "", full).entries).toEqual(full.entries);

    const remote = { ...full, remoteOwner: { instanceId: "peer", instanceLabel: "Peer" } };
    const mounted = expandNavigationRemoteOwner(wire.encode("peer-window", "", remote));
    const remoteBase = mounted.windowPagePatch!.token;
    const peerUpdate = { ...remote, entries: moved.entries };
    const patch = expandNavigationRemoteOwner(wire.encode("peer-window", remoteBase, peerUpdate));
    expect(patch.entries).toHaveLength(0);
    expect(navigationQueryPageBudgetBytes(patch)).toBe(navigationQueryPageBudgetBytes(peerUpdate));
    expect(expandWindowNavigationPage(patch, mounted, remoteBase)).toEqual(expandNavigationRemoteOwner(peerUpdate));
    const renamed = wire.encode("peer-window", patch.windowPagePatch!.token,
      { ...remote, remoteOwner: { ...remote.remoteOwner, instanceLabel: "Renamed" } });
    expect(renamed.entries).toHaveLength(4);

  } finally { f.close(); }
});

it("keeps a viewer's mounted rows during a peer gap without listing its local owner", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  const source = {};
  let label = "before";
  try {
    const owner = await f.live.read();
    const prepare = async () => {
      const captured = label;
      if (captured !== "before") await gate.promise;
      return (local: typeof owner) => ({ ...local, localInstanceId: captured });
    };
    const first = await f.live.viewer(owner, { source, prepare }, "1");
    label = "after";
    const done = f.completion();
    f.emit({ method: "federation/eventStream/changed", params: { instanceId: "peer", epoch: "second" } });
    expect(await f.live.viewer(owner, { source, prepare }, "1")).toBe(first);
    gate.resolve();
    await done;
    expect((await f.live.viewer(owner, { source, prepare }, "1")).localInstanceId).toBe("after");
    expect(f.lists).toEqual(["all"]);
  } finally { gate.resolve(); f.close(); }
});

it("admits an owner-committed creation even when the provider has not announced the new identity", async () => {
  const f = fixture();
  try {
    await f.live.read();
    f.providers.set("new", { ...f.providers.get("a")!, id: "new", title: "Pending creation" });
    f.emit({ method: "navigation/threadDirectories/updated", params: { reason: "thread-created", threadIds: ["new"] } });
    expect((await f.live.read()).threads.map((row) => row.id)).toContain("new");
    expect(f.lists).toEqual(["all"]);
  } finally { f.close(); }
});

it("publishes a terminal provider watermark and title without blocking the mounted page or losing a later rename", async () => {
  const gate = Promise.withResolvers<AppServerThreadSummary>();
  const reads: string[] = [];
  const f = fixture(undefined, false, (_backend, id) => { reads.push(id); return gate.promise; });
  try {
    const before = await f.live.read();
    const done = f.completion();
    f.emit({ method: "turn/completed", params: { threadId: "a", turn: { id: "finished", status: "completed" } } } as AgentEvent["notification"]);
    expect(await f.live.read()).toBe(before);
    f.emit({ method: "thread/name/updated", params: { threadId: "a", threadName: "Renamed during read" } });
    gate.resolve({ ...f.providers.get("a")!, title: "Provider title", updatedAt: 4 });
    await done;
    const after = await f.live.read();
    expect(after.threads.find((row) => row.id === "a")).toMatchObject({ title: "Renamed during read", updatedAt: 4 });
    expect(reads).toEqual(["a"]);
    expect(f.lists).toEqual(["all"]);
  } finally { gate.resolve(f.providers.get("a")!); f.close(); }
});

it("serves the last observation while directory discovery is blocked", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  try {
    const old = await f.live.read();
    f.block(gate.promise);
    f.providers.get("a")!.linkedDirectories = [{ id: "new", kind: "local", path: "/new", label: "new" }];
    const done = f.completion();
    f.emit({ method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: ["a"] } });
    expect(await f.live.read()).toBe(old);
    gate.resolve();
    await done;
    const index = await f.live.read();
    expect(index.directories).toEqual(f.full().directories);
    expect(index.threads[0]!.linkedDirectories[0]?.path).toBe("/new");
  } finally { gate.resolve(); f.close(); }
});

it("applies a single-row IPC patch to the mounted renderer page", async () => {
  const f = fixture();
  const store = new NavigationQueryStore();
  const wire = new NavigationWindowPageDeltas();
  const replies: NavigationQueryPage[] = [];
  const window = new NavigationWindowQueries({ getNavigationQueryPage: async (request, consumer) => {
    const { windowPageBase, ...ownerRequest } = request;
    const page = await store.readPage({ scopeKey: "owner", request: ownerRequest, loadIndex: () => f.live.read() });
    const reply = wire.encode(consumer!, windowPageBase ?? "", page);
    replies.push(reply);
    return reply;
  } });
  try {
    window.setDemand(new Map([["lens", { protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" } }]]));
    await window.refresh();
    f.emit({ method: "thread/name/updated", params: { threadId: "b", threadName: "renamed" } });
    window.invalidate("lens");
    await window.refresh("lens", undefined, true);
    expect(replies.map((page) => page.entries.length)).toEqual([4, 1]);
    const mounted = window.getSnapshot().resources.get("lens")!.state.page!;
    expect(mounted.entries).toHaveLength(4);
    expect(mounted.entries.find((entry) => entry.row.id === "b")?.row.title).toBe("renamed");
  } finally { window.dispose(); f.close(); }
});

it("patches local rows and counts underneath mounted peer pins", async () => {
  const f = fixture();
  try {
    const first = await f.live.read();
    const ref = buildFederatedThreadRef({ backend: "codex", threadId: "pin", instanceId: "peer" });
    const pin = { ...first.threads[0]!, id: "pin", pinnedRank: "100", federation: { ref, instanceLabel: "Peer" } };
    const append = (index: typeof first) => appendViewerNavigationPins({ ...index, localInstanceId: "local" }, [pin]);
    let projections = 0;
    const viewer = { source: {}, appendsPins: true as const, prepare: async () => (index: typeof first) => {
      projections++;
      return append(index);
    } };
    await f.live.viewer(first, viewer, "pins");
    f.overlays.set("a", { inbox: { inInbox: true } });
    f.emit({ method: "navigation/thread/seen", params: { threadId: "a" } });
    const owner = await f.live.read();
    const patched = await f.live.viewer(owner, viewer, "pins");
    const rebuilt = append(owner);
    expect(patched.threads).toEqual(rebuilt.threads);
    expect(patched.directories).toEqual(rebuilt.directories);
    expect(projections).toBe(1);
  } finally { f.close(); }
});
