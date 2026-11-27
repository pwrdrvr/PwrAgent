import fc from "fast-check";
import { expect, it } from "vitest";
import { FEDERATION_CAPABILITIES } from "@pwragent/shared/contracts/federation";
import { NAVIGATION_QUERY_MAX_RESULT_BYTES, type NavigationQueryPage, type NavigationQueryRequest, type FederationNavigationPageRequest, type FederationNavigationPageResult } from "@pwragent/shared/contracts/navigation";
import { createNavigationQuerySnapshot, type NavigationQueryIndex } from "@pwragent/owner-core/navigation-query-projection";
import { NavigationQueryStore } from "@pwragent/owner-core/navigation-query-store";
import { FEDERATION_BACKEND_METHOD_CAPABILITIES, FederationRemoteBackendClient } from "../federation/federation-backend-bridge";
import { registerNavigationBackendHandlers } from "../federation/federation-navigation-handlers";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";
import { navigationRequestForOwner } from "../federation/federation-navigation-query";
import { FederationNavigationPageDeltas } from "../federation/federation-navigation-page-deltas";
import { RemoteNavigationPageBaselines } from "../federation/remote-navigation-page-baselines";
import { NavigationWindowPageDeltas } from "../app-server/navigation-window-page-deltas";
import { expandNavigationRemoteOwner } from "@pwragent/shared/navigation-remote-owner";
import { NavigationWindowQueries } from "../../renderer/src/lib/navigation-window-queries";

const target = { scope: "remote" as const, instanceId: "owner" };
function fixture(inventory: number) {
  const threads: NavigationQueryIndex["threads"] = Array.from({ length: inventory }, (_, i) => ({
    id: String(i), source: "codex", title: `Thread ${i}`, titleSource: "explicit", linkedDirectories: [],
    updatedAt: inventory - i, createdAt: 1, inbox: { inInbox: true },
  }));
  const directories: NavigationQueryIndex["directories"] = [];
  let coverage: "complete" | "degraded" = "complete";
  const snapshot = () => createNavigationQuerySnapshot({ threads: [...threads], directories: [...directories], coverage: { state: coverage } });
  let index = snapshot();
  let store = new NavigationQueryStore();
  const project = (request: NavigationQueryRequest, viewer: string) => store.readPage({
    request, scopeKey: viewer, incremental: true, loadIndex: async () => index,
  });
  const router = new FederationRouter({ localInstanceId: target.instanceId, methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES });
  registerNavigationBackendHandlers({ router, backend: {
    getNavigationQueryPage: (request, options) => project(request, options!.requesterInstanceId!),
  } });
  function connect(viewer: string, negotiated = true, maxEntries = 64, navigation = true) {
    const results: FederationNavigationPageResult[] = [];
    const ipc: NavigationQueryPage[] = [];
    let requests = 0;
    const rpc = new FederationRpcEndpoint({ localInstanceId: viewer, remoteInstanceId: target.instanceId,
      sendEnvelope: (frame) => {
        requests++;
        void router.routeEnvelope({ envelope: JSON.parse(JSON.stringify(frame)), sourcePeerId: viewer });
      } });
    const reconnect = () => router.registerConnection({ peerId: viewer, capabilities: FEDERATION_CAPABILITIES.filter(
      (cap) => (negotiated || cap !== "navigation_page_deltas_v1") && (navigation || cap !== "thread_navigation")),
      sendEnvelope: (frame) => {
        const wire = JSON.parse(JSON.stringify(frame));
        if (wire.kind === "response") results.push(wire.result);
        rpc.receiveEnvelope(wire);
      } });
    reconnect();
    const backend = new FederationRemoteBackendClient(rpc);
    const cache = new RemoteNavigationPageBaselines(undefined, maxEntries);
    const window = new NavigationWindowPageDeltas();
    const raw = async (sent: FederationNavigationPageRequest): Promise<FederationNavigationPageResult> =>
      backend.getNavigationQueryPage(navigationRequestForOwner(sent, target));
    const read = (request: NavigationQueryRequest) => cache.read(request, raw, negotiated);
    const windowApi = { getNavigationQueryPage: async (request: NavigationQueryRequest) => {
      const page = await read(request);
      const mounted = { ...page, remoteOwner: { instanceId: "owner", instanceLabel: "Owner" } };
      const patch = window.encode(viewer, request.windowPageBase ?? "", mounted);
      ipc.push(JSON.parse(JSON.stringify(patch)));
      return expandNavigationRemoteOwner(patch);
    } };
    return { read, raw, results, ipc, reconnect, windowApi, requests: () => requests };
  }
  const fresh = (query: NavigationQueryRequest) => new NavigationQueryStore().readPage({ request: navigationRequestForOwner(query, target),
    scopeKey: "viewer", incremental: true, loadIndex: async () => snapshot() });
  return { connect, fresh, threads, directories, publish: (state = coverage) => { coverage = state; index = snapshot(); }, restart: () => { store = new NavigationQueryStore(); } };
}

function request(pageSize: number): NavigationQueryRequest {
  return { protocol: 2, consumer: "main-sidebar", federationTarget: target, query: { kind: "lens", lens: "inbox" }, pageSize };
}

it("sends only a visible unread edit and then acknowledges the retained first page over RPC", async () => {
  const f = fixture(32);
  const viewer = f.connect("viewer");
  const query = request(8);
  const window = new NavigationWindowQueries(viewer.windowApi);
  try {
    const first = Promise.withResolvers<void>();
    window.subscribe(() => {
      const inbox = window.getSnapshot().resources.get("inbox");
      if (inbox?.state.page && !inbox.loading) first.resolve();
    });
    window.setDemand(new Map([["inbox", query]]));
    await first.promise;
    f.threads[0] = { ...f.threads[0]!, inbox: { inInbox: false } };
    f.publish();
    const invalidate = () => window.invalidate(undefined, [target], { backend: "codex", federationTarget: target,
      notification: { method: "navigation/invalidated", params: { sourceMethod: "navigation/thread/seen", threadId: "0" } } });
    invalidate();
    await window.refresh(undefined, [target], true);
    const edited = window.getSnapshot().resources.get("inbox")!.state.page!;
    expect(edited.entries[0]!.row.inbox.inInbox).toBe(false);
    invalidate();
    await window.refresh(undefined, [target], true);
    expect(window.getSnapshot().resources.get("inbox")!.state.page!.entries).toEqual(edited.entries);
    expect(viewer.requests()).toBe(3);
    expect(viewer.ipc.map(page => page.entries.length)).toEqual([8, 1, 0]);
    expect(viewer.results.map(page => page.entries.length)).toEqual([8, 1, 0]);
  } finally { window.dispose(); }
});
it("keeps owner cursors immutable through edits, and falls back on restart, reconnect and viewer eviction", async () => {
  const f = fixture(32);
  const viewer = f.connect("viewer", true, 1);
  const first = await viewer.read(request(8));
  const next = { ...request(8), cursor: first.nextCursor };
  const retained = await viewer.read(next);
  f.threads[8] = { ...f.threads[8]!, title: "changed at the owner" };
  f.publish();
  expect(await viewer.read(next)).toEqual(retained);
  expect(viewer.results.at(-1)!.entries).toHaveLength(0);
  await viewer.read(request(8));
  expect(viewer.results.at(-1)!.entries).toHaveLength(8);
  viewer.reconnect();
  await viewer.read(request(8));
  expect(viewer.results.at(-1)!.entries).toHaveLength(8);
  f.restart();
  expect((await viewer.read(request(8))).ownerEpoch).not.toBe(first.ownerEpoch);
  expect(viewer.results.at(-1)!.entries).toHaveLength(8);
  await expect(viewer.read(next)).rejects.toThrow(/cursor expired/i);
});

it("scopes tokens to the authenticated requester, page size, view and anchor and serves legacy peers", async () => {
  const f = fixture(32);
  const viewer = f.connect("one");
  const other = f.connect("two");
  const legacy = f.connect("legacy", false);
  const query = request(8);
  const first = await viewer.raw({ ...query, ownerPageBase: "" });
  const base = first.ownerPagePatch!.token;
  const denied = f.connect("denied", true, 64, false);
  await expect(denied.raw({ ...query, ownerPageBase: base })).rejects.toThrow(/capability|permission/i);
  for (const wire of [
    await other.raw({ ...query, ownerPageBase: base }),
    await viewer.raw({ ...request(7), ownerPageBase: base }),
    await viewer.raw({ ...query, query: { kind: "lens", lens: "recents" }, ownerPageBase: base }),
    await viewer.raw({ ...query, anchor: { kind: "thread", ref: first.entries[0]!.row.ref }, ownerPageBase: base }),
  ]) {
    expect(wire.entries.length).toBeGreaterThan(0);
    expect(wire.ownerPagePatch?.base).toBeUndefined();
  }
  const attention = { ...query, query: { kind: "lens" as const, lens: "attention" as const },
    attentionView: { id: "window-a", promoteOnTurnEnd: true } };
  const attentionBase = (await viewer.raw({ ...attention, ownerPageBase: "" })).ownerPagePatch!.token;
  expect((await viewer.raw({ ...attention, attentionView: { ...attention.attentionView, id: "window-b" },
    ownerPageBase: attentionBase })).ownerPagePatch?.base).toBeUndefined();
  expect((await legacy.raw({ ...query, ownerPageBase: base })).ownerPagePatch).toBeUndefined();
  expect((await viewer.raw(query)).ownerPagePatch).toBeUndefined();
  await legacy.read(query);
  await legacy.read(query);
  expect(legacy.results.at(-1)!.entries).toHaveLength(8);
  // The owner advanced its token, but the viewer never accepted that response.
  await viewer.raw({ ...query, ownerPageBase: base });
  expect((await viewer.raw({ ...query, ownerPageBase: base })).entries).toHaveLength(8);
});

it("reconstructs fresh owner projections through generated membership, order, metadata and connection changes", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.tuple(fc.nat(31),
    fc.constantFrom("unread", "insert", "promote", "remove", "rename", "coverage", "restart", "reconnect")),
  { minLength: 5, maxLength: 15 }), async (ops) => {
    const f = fixture(32);
    const viewer = f.connect("viewer");
    const query = request(8);
    await viewer.read(query);
    for (const [step, [id, edit]] of ops.entries()) {
      const i = id % f.threads.length;
      const row = f.threads[i]!;
      if (edit === "restart") f.restart();
      else if (edit === "reconnect") viewer.reconnect();
      else if (edit === "insert") f.threads.push({ ...row, id: `inserted-${step}`, updatedAt: 100 + step });
      else if (edit === "remove") f.threads.splice(i, 1);
      else if (edit === "promote") f.threads[i] = { ...row, updatedAt: 100 + step };
      else if (edit === "rename") f.threads[i] = { ...row, title: `revision ${step}` };
      else if (edit === "unread") f.threads[i] = { ...row, inbox: { inInbox: !row.inbox?.inInbox } };
      f.publish(edit === "coverage" ? "degraded" : "complete");
      const reconstructed = await viewer.read(query);
      // A fresh store issues its own cursor, generation and epoch for the same projection.
      const contents = ({ generation: _generation, ownerEpoch: _epoch, nextCursor, ...page }: NavigationQueryPage) =>
        ({ ...page, more: Boolean(nextCursor) });
      expect(contents(reconstructed)).toEqual(contents(await f.fresh(query)));
    }
  }), { numRuns: 6 });
});

it("recovers an unapplicable delta in one extra read and keeps reordered replies with their own request", async () => {
  const f = fixture(32);
  const viewer = f.connect("viewer");
  const query = request(8);
  const cache = new RemoteNavigationPageBaselines();
  const first = await cache.read(query, viewer.raw, true);
  let recoveredReads = 0;
  const repaired = await cache.read(query, async sent => {
    const wire = await viewer.raw(sent);
    if (++recoveredReads === 1) {
      return { ...wire, ownerPagePatch: { ...wire.ownerPagePatch!, slots: { 0: 1000 } } };
    }
    expect(sent.ownerPageBase).toBe("");
    return wire;
  }, true);
  expect(recoveredReads).toBe(2);
  expect(repaired).toEqual(first);

  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const late = cache.read(query, async sent => {
    const wire = await viewer.raw(sent);
    arrived.resolve();
    await release.promise;
    return wire;
  }, true);
  await arrived.promise;
  f.threads[0] = { ...f.threads[0]!, title: "new" };
  f.publish();
  const latest = await cache.read(query, viewer.raw, true);
  release.resolve();
  expect(await late).toEqual(first);
  expect(await cache.read(query, viewer.raw, true)).toEqual(latest);
  expect(viewer.results.at(-1)!.entries).toHaveLength(0);
});

it("drops removed directory slots, including the last row, and preserves fresh counts", async () => {
  const f = fixture(0);
  for (const key of ["alpha", "beta", "gamma"]) {
    f.directories.push({ key, label: key, kind: "directory", threadKeys: [], needsAttentionCount: 0 });
  }
  f.publish();
  const viewer = f.connect("viewer");
  const query = { ...request(8), query: { kind: "directory-index" as const } };
  expect((await viewer.read(query)).directories).toHaveLength(3);
  f.directories.splice(1, 1);
  f.publish();
  const removed = await viewer.read(query);
  expect(removed.directories).toEqual((await f.fresh(query)).directories);
  expect(viewer.results.at(-1)!.directories).toHaveLength(0);
  expect(viewer.results.at(-1)!.ownerPagePatch?.length).toBe(2);
  f.directories.length = 0;
  f.publish();
  expect((await viewer.read(query)).directories).toEqual([]);
  expect(viewer.results.at(-1)!.ownerPagePatch?.length).toBe(0);
});

it("evicts owner fingerprints across requesters and keeps full baseline offers within the result budget", async () => {
  const f = fixture(32);
  const query = request(8);
  const page = await f.fresh(query);
  const encoder = new FederationNavigationPageDeltas();
  const connection = {};
  const base = encoder.encode("first", connection, query, page).ownerPagePatch!.token;
  for (let i = 0; i < 128; i++) encoder.encode(String(i), connection, query, page);
  expect(encoder.encode("first", connection, { ...query, ownerPageBase: base }, page).entries).toHaveLength(8);
  const last = page.entries.at(-1)!.row;
  last.title += "x".repeat(NAVIGATION_QUERY_MAX_RESULT_BYTES - Buffer.byteLength(JSON.stringify(page)));
  expect(Buffer.byteLength(JSON.stringify(page))).toBe(NAVIGATION_QUERY_MAX_RESULT_BYTES);
  expect(encoder.encode("first", connection, { ...query, ownerPageBase: "" }, page)).toBe(page);
});
