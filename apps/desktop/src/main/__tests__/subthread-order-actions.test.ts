import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import { buildFederatedThreadRef } from "@pwragent/shared/contracts/federation";
import { buildThreadIdentityKey, type NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { resolveThreadParentKey, sortSubthreadSummaries } from "@pwragent/shared/subthreads";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const mocks = vi.hoisted(() => ({
  readProvider: vi.fn(),
  listeners: new Set<(event: AgentEvent) => void>(),
  publish: vi.fn(),
  store: undefined as SqliteOverlayStore | undefined,
}));
vi.mock("../storage/desktop-overlay-store", () => ({ getDesktopOverlayStore: () => mocks.store }));
vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: () => ({
    publishLocalEvent: mocks.publish,
    getStartupProviderRefreshStatus: () => undefined,
    onEvent: (listener: (event: AgentEvent) => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
    readSubthreadOrderProviderRows: async (backend: string, ids: ReadonlySet<string>, preserveListingOrder?: boolean) => {
      const result = await mocks.readProvider({ backend, ids, preserveListingOrder });
      if (result.coverage && result.coverage.state !== "complete") throw new Error("Wait for complete owner discovery before moving a child.");
      return result.threads;
    },
  }),
}));
import { type PeerChildSource, peerSubthreadChildren, updateLocalSubthreadOrder } from "../app-server/subthread-order-actions";
import { peerSubthreadKey } from "../app-server/thread-archive-sweeper";
import { loadViewerNavigationPins } from "../app-server/navigation-viewer-pins";
import { RemoteThreadSummaryCache } from "../federation/remote-thread-summary-cache";

let db: ReturnType<typeof openInMemoryStateDb>;

function summary(
  source: NavigationThreadSummary["source"],
  id: string,
  extra: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return { source, id, title: id, createdAt: 1, updatedAt: 1, linkedDirectories: [], ...extra } as NavigationThreadSummary;
}

beforeEach(() => {
  db = openInMemoryStateDb();
  mocks.store = new SqliteOverlayStore(db);
  mocks.publish.mockReset();
  mocks.readProvider.mockReset();
});
afterEach(() => db.close());

it("moves a Claude sub-thread under a Codex parent", async () => {
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "gondola", parentThreadId: "root" });
  await mocks.store!.setThreadParent({ backend: "claude", threadId: "design", parentThreadId: "root", parentThreadBackend: "codex" });
  // A legacy cross-provider link: only the parent id, resolved by unique id.
  await writeLegacyParentLink(mocks.store!, "claude", "legacy", "root");
  mocks.readProvider.mockResolvedValue({ threads: [
    summary("codex", "root"),
    summary("codex", "gondola", { parentThreadId: "root", createdAt: 3 }),
    summary("claude", "design", { parentThreadId: "root", parentThreadBackend: "codex", createdAt: 2 }),
    summary("claude", "legacy", { parentThreadId: "root", createdAt: 1 }),
    // Workers and federated rows never join the owner's order.
    summary("codex", "worker", { parentThreadId: "root", codexNativeSubAgent: {} } as unknown as Partial<NavigationThreadSummary>),
  ] });

  await updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    move: { threadId: "legacy", anchorThreadId: "gondola", placement: "before" } });

  expect((await mocks.store!.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
    .toEqual(["legacy", "gondola", "design"]);
  // Each provider in the group contributes its own candidate identities.
  expect(mocks.readProvider.mock.calls.map(([params]) => params.backend).sort()).toEqual(["claude", "codex"]);
  expect(mocks.publish).toHaveBeenCalledWith({ backend: "codex", notification: {
    method: "thread/subthreadOrder/updated", params: { parentThreadId: "root" } } });
});

it("refuses a legacy link whose parent id also names a thread on the child's own provider", async () => {
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "gondola", parentThreadId: "root" });
  await writeLegacyParentLink(mocks.store!, "claude", "design", "root");
  mocks.readProvider.mockResolvedValue({ threads: [
    summary("codex", "root"),
    summary("claude", "root"),
    summary("codex", "gondola", { parentThreadId: "root" }),
    summary("claude", "design", { parentThreadId: "root" }),
  ] });

  await expect(updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    move: { threadId: "design", anchorThreadId: "gondola", placement: "before" } })).rejects.toThrow("no longer places");
  expect(mocks.publish).not.toHaveBeenCalled();
});

it("lists only the providers in the group, so an unrelated failing provider cannot block a move", async () => {
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "gondola", parentThreadId: "root" });
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "steam", parentThreadId: "root" });
  // A Grok thread with its own unrelated group.
  await mocks.store!.setThreadParent({ backend: "acp:grok", threadId: "probe", parentThreadId: "elsewhere" });
  mocks.readProvider.mockImplementation(async ({ backend }: { backend?: string }) => backend === "codex"
    ? { coverage: { state: "complete" }, threads: [
      summary("codex", "root"),
      summary("codex", "gondola", { parentThreadId: "root", createdAt: 2 }),
      summary("codex", "steam", { parentThreadId: "root", createdAt: 1 }),
    ] }
    : { coverage: { state: "degraded", failedProviders: 1 }, threads: [] });

  await updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    move: { threadId: "steam", anchorThreadId: "gondola", placement: "before" } });

  expect(mocks.readProvider.mock.calls.map(([params]) => params.backend)).toEqual(["codex"]);
  expect((await mocks.store!.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
    .toEqual(["steam", "gondola"]);
});

it("refuses a move while a provider with a child in the group is incompletely listed", async () => {
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "gondola", parentThreadId: "root" });
  await mocks.store!.setThreadParent({ backend: "claude", threadId: "design", parentThreadId: "root", parentThreadBackend: "codex" });
  mocks.readProvider.mockImplementation(async ({ backend }: { backend?: string }) => backend === "codex"
    ? { coverage: { state: "complete" }, threads: [summary("codex", "root"),
      summary("codex", "gondola", { parentThreadId: "root" })] }
    : { coverage: { state: "degraded", failedProviders: 1 }, threads: [] });

  await expect(updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    move: { threadId: "gondola", anchorThreadId: "design", placement: "after" } })).rejects.toThrow("complete owner discovery");
  expect(mocks.publish).not.toHaveBeenCalled();
});

it("places a new Claude child below its Codex source before the owner lists it", async () => {
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "gondola", parentThreadId: "root" });
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "steam", parentThreadId: "root" });
  await mocks.store!.setThreadParent({ backend: "claude", threadId: "fresh", parentThreadId: "root", parentThreadBackend: "codex" });
  mocks.readProvider.mockResolvedValue({ coverage: { state: "complete" }, threads: [
    summary("codex", "root"),
    summary("codex", "gondola", { parentThreadId: "root", createdAt: 2 }),
    summary("codex", "steam", { parentThreadId: "root", createdAt: 1 }),
  ] });

  await updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    insertAfter: { threadId: "fresh", sourceThreadId: "gondola" } });

  expect((await mocks.store!.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
    .toEqual(["gondola", "fresh", "steam"]);
});

const LOCAL = "pwr_local";
const PEER = "pwr_peer";

/** A peer's thread whose link names this machine's `root` as its parent. */
async function pinPeerChild(threadId: string, extra: Partial<NavigationThreadSummary> = {}) {
  await mocks.store!.addRemoteThreadPin({
    ref: buildFederatedThreadRef({ backend: "codex", instanceId: PEER, threadId }),
    instanceLabel: "Win PC / dev",
    pinnedVia: "explicit",
    summary: summary("codex", threadId, { parentThreadId: "root", parentThreadBackend: "codex",
      parentThreadInstanceId: LOCAL, createdAt: 5, ...extra }),
  });
}

/**
 * The live peer summaries, as the sidebar reads pins through them. `live`
 * stands in for what a reachable peer serves now; any other pin falls back to
 * its saved snapshot, as it does while the peer is offline.
 */
function peers(live: NavigationThreadSummary[] = []): PeerChildSource {
  const liveById = new Map(live.map((thread) => [thread.id, thread]));
  return {
    localInstanceId: async () => LOCAL,
    summaries: {
      readPinnedThreads: (pins) => {
        const served = pins.flatMap((pin) => {
          const thread = liveById.get(pin.ref.threadId);
          return thread ? [{ pin, thread: { ...thread, federation: pin.summary!.federation } }] : [];
        });
        return {
          threads: pins.map((pin) => served.find((entry) => entry.pin === pin)?.thread ?? pin.summary!),
          refreshed: served.map(({ pin, thread }) => ({ ref: pin.ref, summary: thread, instanceLabel: pin.instanceLabel })),
          archived: [],
        };
      },
    },
  };
}

it("moves a peer's sub-thread among this machine's children of a local parent", async () => {
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "gondola", parentThreadId: "root" });
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "steam", parentThreadId: "root" });
  await pinPeerChild("windows-e2e");
  // Another parent's peer child and one linked to a different machine stay out.
  await pinPeerChild("elsewhere", { parentThreadId: "other" });
  await pinPeerChild("foreign", { parentThreadInstanceId: "pwr_third" });
  mocks.readProvider.mockResolvedValue({ coverage: { state: "complete" }, threads: [
    summary("codex", "root"),
    summary("codex", "gondola", { parentThreadId: "root", createdAt: 2 }),
    summary("codex", "steam", { parentThreadId: "root", createdAt: 1 }),
  ] });

  await updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    move: { threadId: "windows-e2e", anchorThreadId: "steam", placement: "before" } }, { peers: peers() });

  expect((await mocks.store!.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
    .toEqual(["gondola", "windows-e2e", "steam"]);

  // A local move keeps the peer's child in the saved order.
  await updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    move: { threadId: "steam", anchorThreadId: "gondola", placement: "before" } }, { peers: peers() });

  expect((await mocks.store!.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
    .toEqual(["steam", "gondola", "windows-e2e"]);
});

it("refuses a peer's sub-thread when this machine has no federation identity", async () => {
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "gondola", parentThreadId: "root" });
  await pinPeerChild("windows-e2e");
  mocks.readProvider.mockResolvedValue({ coverage: { state: "complete" }, threads: [
    summary("codex", "root"),
    summary("codex", "gondola", { parentThreadId: "root" }),
  ] });

  await expect(updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    move: { threadId: "windows-e2e", anchorThreadId: "gondola", placement: "before" } })).rejects.toThrow("no longer places");
});

it("trusts the peer over a stale pin snapshot that still names this parent", async () => {
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "gondola", parentThreadId: "root" });
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "steam", parentThreadId: "root" });
  await pinPeerChild("windows-e2e");
  mocks.readProvider.mockResolvedValue({ coverage: { state: "complete" }, threads: [
    summary("codex", "root"),
    summary("codex", "gondola", { parentThreadId: "root", createdAt: 2 }),
    summary("codex", "steam", { parentThreadId: "root", createdAt: 1 }),
  ] });
  // The peer moved its thread under another of this machine's threads.
  const moved = summary("codex", "windows-e2e", { parentThreadId: "other", parentThreadBackend: "codex",
    parentThreadInstanceId: LOCAL, createdAt: 5 });

  await expect(updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    move: { threadId: "windows-e2e", anchorThreadId: "steam", placement: "before" } },
  { peers: peers([moved]) })).rejects.toThrow("no longer places");
  expect((await mocks.store!.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder ?? [])
    .not.toContain("windows-e2e");
  // The pin snapshot caught up with the peer, as a sidebar read would.
  const [pin] = await mocks.store!.listRemoteThreadPins();
  expect(pin?.summary?.parentThreadId).toBe("other");
});

it("places a peer's fresh sub-thread below its source once its pin is written", async () => {
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "gondola", parentThreadId: "root" });
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "steam", parentThreadId: "root" });
  mocks.readProvider.mockResolvedValue({ coverage: { state: "complete" }, threads: [
    summary("codex", "root"),
    summary("codex", "gondola", { parentThreadId: "root", createdAt: 2 }),
    summary("codex", "steam", { parentThreadId: "root", createdAt: 1 }),
  ] });
  await pinPeerChild("fresh", { createdAt: 9 });

  await updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    insertAfter: { threadId: "fresh", sourceThreadId: "gondola" } }, { peers: peers() });

  expect((await mocks.store!.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
    .toEqual(["gondola", "fresh", "steam"]);
});

/** Rows written before links recorded the parent's provider name only its id. */
async function writeLegacyParentLink(store: SqliteOverlayStore, backend: "claude", threadId: string, parentThreadId: string) {
  await store.setThreadParent({ backend, threadId, parentThreadId, parentThreadBackend: "codex" });
  const state = await store.getThreadOverlayState({ backend, threadId });
  (store as unknown as { putThread(key: string, state: object): void })
    .putThread(buildThreadIdentityKey(backend, threadId), { ...state, parentThreadBackend: undefined });
}

it("counts a peer thread as a sub-thread of this machine's thread only when it names this machine", () => {
  const pin = (instanceId: string, id: string, extra: Partial<NavigationThreadSummary>, more: { revokedAt?: number } = {}) => ({
    ref: buildFederatedThreadRef({ backend: "codex", threadId: id, instanceId }),
    summary: summary("codex", id, extra), ...more,
  });
  const parent = { parentThreadId: "parent", parentThreadInstanceId: "pwr_local" };
  const children = peerSubthreadChildren([
    pin("pwr_peer", "child", parent),
    pin("pwr_peer", "child", parent),
    pin("pwr_peer", "claude-parent", { ...parent, parentThreadBackend: "claude" }),
    pin("pwr_peer", "elsewhere", { parentThreadId: "parent", parentThreadInstanceId: "pwr_other" }),
    pin("pwr_peer", "archived", { ...parent, archivedAt: 5 }),
    pin("pwr_peer", "revoked", parent, { revokedAt: 5 }),
    pin("pwr_local", "own", parent),
  ], "pwr_local");
  expect(children).toEqual(new Map([
    [buildThreadIdentityKey("codex", "parent"), [peerSubthreadKey("pwr_peer", "codex", "child")]],
    [buildThreadIdentityKey("claude", "parent"), [peerSubthreadKey("pwr_peer", "codex", "claude-parent")]],
  ]));
  expect(peerSubthreadChildren([pin("pwr_peer", "child", parent)], undefined)).toEqual(new Map());
});

it("matches the complete navigation index for colliding IDs, legacy links, and mixed providers", async () => {
  const parentThreadId = "root";
  const target = { backend: "codex", parentThreadId } as const;
  const providers = ["codex", "claude", "acp:grok"] as const;
  const candidates = fc.array(fc.record({
    source: fc.constantFrom(...providers),
    explicitBackend: fc.option(fc.constantFrom(...providers), { nil: undefined }),
    isRemote: fc.boolean(),
    native: fc.boolean(),
    createdAt: fc.integer({ min: 1, max: 3 }),
  }), { maxLength: 18 });
  await fc.assert(fc.asyncProperty(candidates, fc.boolean(), fc.boolean(), async (rows, claudeCollision, acpCollision) => {
    const state = openInMemoryStateDb();
    try {
      const store = mocks.store = new SqliteOverlayStore(state);
      const put = state.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)");
      const listing = [
        summary("codex", "root"), summary("codex", "anchor", { createdAt: 2 }),
        summary("codex", "moved", { createdAt: 3 }),
      ];
      if (claudeCollision) listing.push(summary("claude", "root"));
      if (acpCollision) listing.push(summary("acp:grok", "root"));
      const write = (source: NavigationThreadSummary["source"], id: string, fields: Record<string, unknown>) => {
        put.run(`${encodeURIComponent(source)}:${id}`, JSON.stringify({
          threadId: id, backend: source, executionMode: "default", extraLinkedDirectories: [], ...fields,
        }));
      };
      write("codex", "anchor", { parentThreadId });
      write("codex", "moved", { parentThreadId });
      // One native handoff lost its remote parent instance, and another
      // inherited through that handoff in the old navigation projection.
      for (const [index, id] of ["origin", "handoff", "handoff-of-handoff"].entries()) {
        listing.push(summary("claude", id, { createdAt: index + 1 }));
        write("claude", id, { parentThreadId, parentThreadBackend: "codex",
          ...(index === 0 ? { parentThreadInstanceId: PEER } : { handoffOrigin: { groupingMode: "subthread",
            sourceBackend: "claude", sourceThreadId: index === 1 ? "origin" : "handoff" } }) });
      }
      for (const [index, row] of rows.entries()) {
        const id = `candidate-${index}`;
        write(row.source, id, {
          parentThreadId,
          parentThreadBackend: row.explicitBackend,
          parentThreadInstanceId: row.isRemote ? PEER : undefined,
        });
        listing.push(summary(row.source, id, {
          createdAt: row.createdAt,
          ...(row.native ? { codexNativeSubAgent: {} as NonNullable<NavigationThreadSummary["codexNativeSubAgent"]> } : {}),
        }));
      }
      const orderHints = ["anchor", "candidate-1"];
      await store.updateSubthreadOrder({ ...target, threadIds: orderHints });
      const scopes = [...new Set(["codex" as const, "claude" as const, ...rows.map((row) => row.source)])];
      // Metadata listing order can disagree with insertion order even when
      // all handoffs have different creation times.
      const canonical = [...listing];
      const firstHandoff = canonical.findIndex((row) => row.id === "handoff");
      const secondHandoff = canonical.findIndex((row) => row.id === "handoff-of-handoff");
      [canonical[firstHandoff], canonical[secondHandoff]] = [canonical[secondHandoff]!, canonical[firstHandoff]!];
      const full = scopes.flatMap((backend) => store.readNavigationQueryIndex({
        backend, threads: canonical.filter((row) => row.source === backend),
      }).threads);
      const byKey = new Map(full.map((thread) => [buildThreadIdentityKey(thread.source, thread.id), thread]));
      const expected = sortSubthreadSummaries({ subthreadOrder: orderHints }, full.filter((thread) =>
        thread.parentThreadId === parentThreadId && !thread.archivedAt && !thread.parentThreadInstanceId
        && !thread.codexNativeSubAgent && resolveThreadParentKey(thread, byKey) === "codex:root"))
        .map((thread) => thread.id).filter((id) => id !== "moved");
      expected.splice(expected.indexOf("anchor") + 1, 0, "moved");

      mocks.readProvider.mockImplementation(async ({ backend, ids, preserveListingOrder }: {
        backend: NavigationThreadSummary["source"]; ids: ReadonlySet<string>; preserveListingOrder?: boolean;
      }) => ({ threads: (preserveListingOrder ? canonical : listing).filter((row) => row.source === backend && ids.has(row.id)) }));
      await updateLocalSubthreadOrder({ ...target, move: { threadId: "moved", anchorThreadId: "anchor", placement: "after" } });
      expect((await store.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder).toEqual(expected);
    } finally {
      state.close();
    }
  }), { numRuns: 8 });
});

it("refuses a relative move when an unseen sibling joins during provider discovery", async () => {
  const store = mocks.store!;
  const target = { backend: "codex", parentThreadId: "root" } as const;
  for (const threadId of ["anchor", "child"]) await store.setThreadParent({ ...target, threadId });
  const original = (await store.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder;
  const read = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  mocks.readProvider.mockImplementation(async () => {
    read.resolve();
    await finish.promise;
    return { threads: ["root", "anchor", "child"].map((id) => summary("codex", id)) };
  });

  const pending = updateLocalSubthreadOrder({ ...target,
    move: { threadId: "child", anchorThreadId: "anchor", placement: "before" } });
  await read.promise;
  // An external writer can commit the durable edge without delivering an
  // event to this owner. The transaction must recheck candidate membership.
  const insert = db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)");
  insert.run("claude:joined", JSON.stringify({ backend: "claude", threadId: "joined", parentThreadId: "root" }));
  finish.resolve();
  await expect(pending).rejects.toThrow("owning group changed");
  expect((await store.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder).toEqual(original);
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(mocks.listeners.size).toBe(0);
});

it("fences relevant provider archive and restore events and re-reads intervening order hints", async () => {
  const store = mocks.store!;
  const target = { backend: "codex", parentThreadId: "root" } as const;
  for (const threadId of ["anchor", "child", "sibling"]) await store.setThreadParent({ ...target, threadId });
  const initial = ["anchor", "child", "sibling"];
  await store.updateSubthreadOrder({ ...target, threadIds: initial });
  const request = { ...target, move: { threadId: "child", anchorThreadId: "anchor", placement: "before" } } as const;

  for (const method of ["thread/archived", "thread/unarchived"] as const) {
    mocks.readProvider.mockImplementation(async () => {
      for (const listener of mocks.listeners) {
        const params = { threadId: "sibling" };
        listener({ backend: "codex", notification: method === "thread/archived"
          ? { method: "thread/archived", params } : { method: "thread/unarchived", params } });
      }
      return { threads: ["root", ...initial].map((id) => summary("codex", id)) };
    });
    await expect(updateLocalSubthreadOrder(request)).rejects.toThrow("owning group changed");
    expect((await store.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder).toEqual(initial);
  }

  mocks.readProvider.mockImplementation(async () => {
    await store.updateSubthreadOrder({ ...target, threadIds: ["sibling", "anchor", "child"] });
    for (const listener of mocks.listeners) {
      listener({ backend: "codex", notification: { method: "thread/archived", params: { threadId: "outside" } } });
    }
    return { threads: ["root", ...initial].map((id) => summary("codex", id)) };
  });
  await updateLocalSubthreadOrder(request);
  expect((await store.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
    .toEqual(["sibling", "child", "anchor"]);
});


it.each(["unmount", "mount", "refresh"] as const)("refuses stale peer membership when another connection can %s a pin", async (mutation) => {
  const { dbPath, tempDir } = createTempStateDb("pwragent-subthread-peer-race-");
  const reader = StateDb.open(dbPath);
  const secondConnection = StateDb.open(dbPath);
  try {
    const store = mocks.store = new SqliteOverlayStore(reader);
    const target = { backend: "codex", parentThreadId: "root" } as const;
    await store.setThreadParent({ ...target, threadId: "anchor" });
    await store.setThreadParent({ ...target, threadId: "child" });
    await pinPeerChild("peer-child");
    const initial = ["anchor", "child", "peer-child"];
    await store.updateSubthreadOrder({ ...target, threadIds: initial });
    mocks.readProvider.mockResolvedValue({ threads: ["root", "anchor", "child"].map((id) => summary("codex", id)) });
    const writer = secondConnection.raw;

    // A synchronous consumer still has to fence a writer in another process.
    // Use a second connection to commit while the local action holds old rows.
    const mutate = () => {
      switch (mutation) {
        case "unmount":
          writer.prepare("DELETE FROM remote_thread_pins WHERE thread_id = ?").run("peer-child");
          break;
        case "mount":
          writer.prepare(`INSERT INTO remote_thread_pins(instance_id, backend, thread_id, added_at, payload)
            SELECT instance_id, backend, ?, added_at, payload FROM remote_thread_pins WHERE thread_id = ?`)
            .run("new-peer-sibling", "peer-child");
          break;
        case "refresh":
          writer.prepare(`UPDATE remote_thread_pins SET payload = json_set(payload, '$.summary.parentThreadId', ?)
            WHERE thread_id = ?`).run("another-parent", "peer-child");
          break;
      }
    };
    await expect(updateLocalSubthreadOrder({ ...target,
      move: { threadId: "child", anchorThreadId: "peer-child", placement: "after" } }, {
      peers: { localInstanceId: async () => LOCAL, summaries: {
        readPinnedThreads: (pins) => {
          mutate();
          return peers().summaries.readPinnedThreads(pins);
        },
      } },
    })).rejects.toThrow("mounted peer threads changed");
    expect((await store.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder).toEqual(initial);
    expect(mocks.publish).not.toHaveBeenCalled();
  } finally {
    secondConnection.close();
    reader.close();
    removeTempStateDbDir(tempDir);
  }
});

it("keeps a child ranked by a concurrent insertion before the provider lists it", async () => {
  const store = mocks.store!;
  const target = { backend: "codex", parentThreadId: "root" } as const;
  for (const threadId of ["anchor", "child", "sibling"]) await store.setThreadParent({ ...target, threadId });
  await store.setThreadParent({ backend: "claude", threadId: "pending", parentThreadId: "root", parentThreadBackend: "codex" });
  const active = ["anchor", "child", "sibling"];
  await store.updateSubthreadOrder({ ...target, threadIds: active });
  const reached = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  mocks.readProvider.mockImplementation(async ({ backend }: { backend: string }) => {
    if (backend !== "codex") return { threads: [] };
    reached.resolve();
    await finish.promise;
    return { threads: ["root", ...active].map((id) => summary("codex", id)) };
  });
  const moving = updateLocalSubthreadOrder({ ...target,
    move: { threadId: "child", anchorThreadId: "anchor", placement: "before" } });
  await reached.promise;
  await expect(store.updateSubthreadOrder({ ...target, children: active.map((id) => ({ id })),
    insertAfter: { threadId: "pending", sourceThreadId: "anchor" } }))
    .resolves.toEqual(["anchor", "pending", "child", "sibling"]);
  finish.resolve();
  await moving;

  expect((await store.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
    .toEqual(["child", "anchor", "pending", "sibling"]);
});


it("commits a changed peer snapshot and the child order together", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const { dbPath, tempDir } = createTempStateDb("pwragent-subthread-peer-writes-");
  const state = StateDb.open(dbPath);
  try {
    const store = mocks.store = new SqliteOverlayStore(state);
    const target = { backend: "codex", parentThreadId: "root" } as const;
    await store.setThreadParent({ ...target, threadId: "anchor" });
    await pinPeerChild("mounted");
    await store.updateSubthreadOrder({ ...target, threadIds: ["anchor", "mounted"] });
    mocks.readProvider.mockResolvedValue({ threads: ["root", "anchor"].map((id) => summary("codex", id)) });
    const live = summary("codex", "mounted", { parentThreadId: "root", parentThreadBackend: "codex",
      parentThreadInstanceId: LOCAL, title: "Fresh peer summary" });
    const { writes } = await measureSqliteWrites(() => updateLocalSubthreadOrder({ ...target,
      move: { threadId: "mounted", anchorThreadId: "anchor", placement: "before" } }, { peers: peers([live]) }));
    expectSqliteWriteBudget({ scenario: "navigation-relative-child-move-peer-refresh",
      note: "One commit for a move and a changed peer snapshot, ~16.5 KB or 1.65 MB/day at 100 such moves/day. No periodic writes.", writes });
    expect((await store.listRemoteThreadPins())[0]?.summary?.title).toBe("Fresh peer summary");
    expect((await store.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
      .toEqual(["mounted", "anchor"]);
  } finally {
    state.close();
    removeTempStateDbDir(tempDir);
    vi.unstubAllEnvs();
  }
});

it("never spends old archive evidence on a same-tick remount", async () => {
  const { dbPath, tempDir } = createTempStateDb("pwragent-subthread-same-tick-");
  const reader = StateDb.open(dbPath);
  const writer = StateDb.open(dbPath);
  try {
    const store = mocks.store = new SqliteOverlayStore(reader);
    const target = { backend: "codex", parentThreadId: "root" } as const;
    for (const threadId of ["anchor", "child"]) await store.setThreadParent({ ...target, threadId });
    await pinPeerChild("mounted");
    await store.updateSubthreadOrder({ ...target, threadIds: ["anchor", "child", "mounted"] });
    mocks.readProvider.mockResolvedValue({ threads: ["root", "anchor", "child"].map((id) => summary("codex", id)) });

    const readPin = writer.raw.prepare("SELECT rowid, instance_id, backend, thread_id, added_at, payload FROM remote_thread_pins");
    const remount = writer.raw.transaction(() => {
      const [old] = readPin.raw().all() as [number, string, string, string, number, string][];
      writer.raw.prepare("DELETE FROM remote_thread_pins").run();
      writer.raw.prepare("INSERT INTO remote_thread_pins(instance_id, backend, thread_id, added_at, payload) VALUES (?, ?, ?, ?, ?)")
        .run(...old!.slice(1));
      expect(readPin.raw().all()).toEqual([old]);
    });

    await expect(updateLocalSubthreadOrder({ ...target,
      move: { threadId: "child", anchorThreadId: "anchor", placement: "before" } }, {
      peers: { localInstanceId: async () => LOCAL, summaries: {
        readPinnedThreads: (pins) => {
          remount();
          return { threads: [], refreshed: [], archived: [pins[0]!.ref] };
        },
      } },
    })).rejects.toThrow("mounted peer threads changed");
    expect((await store.listRemoteThreadPins()).map(({ ref }) => ref.threadId)).toEqual(["mounted"]);
    expect((await store.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
      .toEqual(["anchor", "child", "mounted"]);
  } finally {
    writer.close();
    reader.close();
    removeTempStateDbDir(tempDir);
  }
});

it("commits the chosen live peer view before a cache-only publication can interleave", async () => {
  const store = mocks.store!;
  const target = { backend: "codex", parentThreadId: "root" } as const;
  await store.setThreadParent({ ...target, threadId: "child" });
  await pinPeerChild("mounted");
  await store.updateSubthreadOrder({ ...target, threadIds: ["child", "mounted"] });
  mocks.readProvider.mockResolvedValue({ threads: ["root", "child"].map((id) => summary("codex", id)) });
  const row = summary("codex", "mounted", { parentThreadId: "root", parentThreadBackend: "codex", parentThreadInstanceId: LOCAL });
  let live = row;
  const events: string[] = [];
  const commit = store.commitSubthreadOrder.bind(store);
  vi.spyOn(store, "commitSubthreadOrder").mockImplementation((params) => {
    const order = commit(params);
    events.push("commit");
    return order;
  });

  await updateLocalSubthreadOrder({ ...target,
    move: { threadId: "child", anchorThreadId: "mounted", placement: "after" } }, {
    peers: { localInstanceId: async () => LOCAL, summaries: {
      readPinnedThreads: (pins) => {
        events.push("resolve");
        const chosen = peers([live]).summaries.readPinnedThreads(pins);
        queueMicrotask(() => {
          // This tests the live view independently of persisted pin metadata.
          live = { ...row, parentThreadId: "different-parent" };
          events.push("publish");
        });
        return chosen;
      },
    } },
  });
  expect(live.parentThreadId).toBe("different-parent");
  expect(events).toEqual(["resolve", "commit", "publish"]);
  expect((await store.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
    .toEqual(["mounted", "child"]);
});


it("keeps a replacement mounted before the reorder when the real cache has archive proof for the old mount", async () => {
  const { dbPath, tempDir } = createTempStateDb("pwragent-subthread-queued-proof-");
  const reader = StateDb.open(dbPath);
  const writer = StateDb.open(dbPath);
  const published = Promise.withResolvers<void>();
  const cache = new RemoteThreadSummaryCache({
    peers: () => [{ target: { scope: "remote", instanceId: PEER }, label: "Peer", capabilities: ["thread_navigation"] }],
    fetchSnapshot: async () => ({ backend: "all", fetchedAt: 0, unchanged: false, threads: [], inboxThreadKeys: [], directories: [],
      launchpadDefaults: { backend: "codex", executionMode: "default" } }),
    fetchArchivedThreads: vi.fn().mockResolvedValueOnce([summary("codex", "mounted")]).mockResolvedValue([]),
    peerStatus: () => ({ status: "connected" }),
    onPinnedSummariesRefreshed: () => published.resolve(),
  });
  try {
    const store = mocks.store = new SqliteOverlayStore(reader);
    const target = { backend: "codex", parentThreadId: "root" } as const;
    for (const threadId of ["anchor", "child"]) await store.setThreadParent({ ...target, threadId });
    await pinPeerChild("mounted");
    await store.updateSubthreadOrder({ ...target, threadIds: ["anchor", "child", "mounted"] });
    mocks.readProvider.mockResolvedValue({ threads: ["root", "anchor", "child"].map((id) => summary("codex", id)) });

    cache.readPinnedThreads(store.readSubthreadOrderPeerPins().pins);
    await published.promise;
    writer.raw.transaction(() => {
      const row = writer.raw.prepare("SELECT instance_id, backend, thread_id, added_at, payload FROM remote_thread_pins")
        .raw().get() as [string, string, string, number, string];
      writer.raw.prepare("DELETE FROM remote_thread_pins").run();
      writer.raw.prepare("INSERT INTO remote_thread_pins(instance_id, backend, thread_id, added_at, payload) VALUES (?, ?, ?, ?, ?)")
        .run(...row);
    })();

    await updateLocalSubthreadOrder({ ...target, move: { threadId: "child", anchorThreadId: "anchor", placement: "before" } },
      { peers: { localInstanceId: async () => LOCAL, summaries: cache } });
    expect((await store.listRemoteThreadPins()).map(({ ref }) => ref.threadId)).toEqual(["mounted"]);
    expect((await store.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
      .toEqual(["child", "anchor", "mounted"]);
  } finally {
    cache.dispose();
    writer.close();
    reader.close();
    removeTempStateDbDir(tempDir);
  }
});


async function checkRejectedMoveKeepsArchiveProof(rejection: "owner-event" | "pin-change") {
  const { dbPath, tempDir } = createTempStateDb("pwragent-subthread-retained-proof-");
  const reader = StateDb.open(dbPath);
  const writer = StateDb.open(dbPath);
  const published = Promise.withResolvers<void>();
  const cache = new RemoteThreadSummaryCache({
    peers: () => [{ target: { scope: "remote", instanceId: PEER }, label: "Peer", capabilities: ["thread_navigation"] }],
    fetchSnapshot: async () => ({ backend: "all", fetchedAt: 0, unchanged: false, threads: [], inboxThreadKeys: [], directories: [],
      launchpadDefaults: { backend: "codex", executionMode: "default" } }),
    fetchArchivedThreads: vi.fn().mockResolvedValueOnce([summary("codex", "archived-peer")]).mockResolvedValue([]),
    peerStatus: () => ({ status: "connected" }),
    onPinnedSummariesRefreshed: () => published.resolve(),
    hasNavigationSubscription: () => true,
  });
  try {
    const store = mocks.store = new SqliteOverlayStore(reader);
    const target = { backend: "codex", parentThreadId: "root" } as const;
    for (const threadId of ["anchor", "child"]) await store.setThreadParent({ ...target, threadId });
    await pinPeerChild("archived-peer");
    await pinPeerChild("other-pin", { parentThreadId: "elsewhere" });
    mocks.readProvider.mockResolvedValue({ threads: ["root", "anchor", "child"].map((id) => summary("codex", id)) });
    cache.readPinnedThreads(store.readSubthreadOrderPeerPins().pins);
    await published.promise;

    const discover = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<string>();
    const moving = updateLocalSubthreadOrder({ ...target, move: { threadId: "child", anchorThreadId: "anchor", placement: "before" } },
      { peers: {
        localInstanceId: () => { discover.resolve(); return resume.promise; },
        summaries: { readPinnedThreads: (pins) => {
          const result = cache.readPinnedThreads(pins);
          if (rejection === "pin-change") {
            writer.raw.prepare(`UPDATE remote_thread_pins SET payload = json_set(payload, '$.summary.parentThreadId', ?)
              WHERE thread_id = ?`).run("another-parent", "other-pin");
          }
          return result;
        } },
      } });
    const assertion = expect(moving).rejects.toThrow("changed while discovering");
    await discover.promise;
    if (rejection === "owner-event") {
      for (const listener of mocks.listeners) listener({ backend: "codex",
        notification: { method: "thread/archived", params: { threadId: "anchor" } } });
    }
    resume.resolve(LOCAL);
    await assertion;
    expect((await store.listRemoteThreadPins()).map(({ ref }) => ref.threadId)).toContain("archived-peer");

    // A rejected command never removed the pin. The next sidebar read must
    // still see the owner proof and be able to commit the guarded deletion.
    const remaining = await loadViewerNavigationPins(store, cache);
    expect(remaining.map(({ id }) => id)).toEqual(["other-pin"]);
    expect((await store.listRemoteThreadPins()).map(({ ref }) => ref.threadId)).toEqual(["other-pin"]);
  } finally {
    cache.dispose();
    writer.close();
    reader.close();
    removeTempStateDbDir(tempDir);
  }
}

it("preserves archive evidence when a local owner event rejects the reorder", async () => {
  await checkRejectedMoveKeepsArchiveProof("owner-event");
});

it("models a rejected reorder followed by a sidebar cleanup of the same mount", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("owner-event", "pin-change"), checkRejectedMoveKeepsArchiveProof), { numRuns: 6 });
});

it("skips unreadable archived Claude children and requires metadata after restore", async () => {
  const store = mocks.store!;
  const target = { backend: "codex", parentThreadId: "root" } as const;
  for (const threadId of ["anchor", "child"]) await store.setThreadParent({ ...target, threadId });
  const unreadable = { backend: "claude", threadId: "unreadable" } as const;
  await store.setThreadParent({ ...unreadable, parentThreadId: "root", parentThreadBackend: "codex" });
  mocks.readProvider.mockImplementation(async ({ backend, ids }: { backend: string; ids: ReadonlySet<string> }) => {
    if (backend === "claude") {
      if (ids.has(unreadable.threadId)) throw new Error("Unreadable Claude metadata");
      return { threads: [] };
    }
    return { threads: ["root", "anchor", "child"].map((id) => summary("codex", id)) };
  });
  const request = { ...target, move: { threadId: "child", anchorThreadId: "anchor", placement: "before" } } as const;
  await store.observeArchivedThreads([unreadable], 20);
  await expect(updateLocalSubthreadOrder(request)).resolves.toMatchObject(target);
  expect((await store.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder).toEqual(["child", "anchor"]);

  await store.setThreadArchiveTombstone({ ...unreadable, restoredAt: 21 });
  await expect(updateLocalSubthreadOrder(request)).rejects.toThrow("Unreadable Claude metadata");
});
