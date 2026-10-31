import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { NavigationQueryPage, NavigationThreadSummary, UpdateSubthreadOrderRequest, UpdateSubthreadOrderResponse } from "@pwragent/shared";
import { buildFederatedThreadRef } from "@pwragent/shared";
import { DesktopFederationRuntime, getDesktopFederationRuntime } from "../federation/federation-runtime";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { setDesktopOverlayStoreForTests, resetDesktopOverlayStoreForTests } from "../app-server/desktop-overlay-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV, type SqliteWriteDelta } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createSubthreadTrays } from "../../renderer/src/features/navigation/subthread-trays";

const providerRegistry = vi.hoisted(() => ({ archiveThread: vi.fn(), publishLocalEvent: vi.fn(async () => {}) }));
vi.mock("../app-server/backend-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app-server/backend-registry")>()),
  getDesktopBackendRegistry: () => providerRegistry,
}));

vi.mock("../acp/acp-instance-discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../acp/acp-instance-discovery")>()),
  discoverLocalAcpAgentRecords: vi.fn(async () => []),
}));

describe("Federation nested archive placement", () => {
  const stores = new Map<string, SqliteOverlayStore>();
  const databases: StateDb[] = [];
  const directories: string[] = [];
  const owners = new Map([
    ["root", "root-owner"], ["before", "root-owner"], ["after", "root-owner"],
    ["middle", "middle-owner"], ["child-b", "child-owner"],
    ["child-a", "fourth-owner"], ["deeper", "fourth-owner"],
  ]);
  const fixtureIds = new Set(owners.keys());
  const creationTimes = new Map<string, number>();
  let runtime: DesktopFederationRuntime;
  type OwnerUpdate = (owner: string, request: UpdateSubthreadOrderRequest) => Promise<UpdateSubthreadOrderResponse>;
  let remoteUpdate: Mock<OwnerUpdate>;

  const summary = async (id: string): Promise<NavigationThreadSummary> => {
    const overlay = await stores.get(owners.get(id)!)!.getThreadOverlayState({ backend: "codex", threadId: id });
    return { ...overlay, archivedAt: overlay?.archiveRetentionStartedAt,
      id, source: "codex", title: id, titleSource: "explicit", linkedDirectories: [],
      createdAt: creationTimes.get(id) ?? 0, inbox: { inInbox: false } };
  };
  const mount = async (viewer: string, id: string) => {
    await stores.get(viewer)!.addRemoteThreadPin({
      ref: buildFederatedThreadRef({ backend: "codex", threadId: id, instanceId: owners.get(id)! }),
      summary: await summary(id), instanceLabel: owners.get(id)!, pinnedVia: "child",
    });
  };
  const link = async (id: string, parent: string) => {
    const owner = owners.get(id)!;
    const parentOwner = owners.get(parent)!;
    await stores.get(owner)!.setThreadParent({ backend: "codex", threadId: id, parentThreadId: parent,
      parentThreadBackend: "codex", ...(owner === parentOwner ? {} : { parentThreadInstanceId: parentOwner }) });
    if (owner !== parentOwner) await mount(parentOwner, id);
  };
  const tray = async () => {
    const rows = await Promise.all([...owners.keys()].map(summary));
    const buckets = new Map<string, NavigationThreadSummary[]>();
    for (const row of rows) {
      if (!row.parentThreadId || row.archivedAt !== undefined) continue;
      const key = `codex:${row.parentThreadId}`;
      buckets.set(key, [...(buckets.get(key) ?? []), row]);
    }
    return createSubthreadTrays(buckets, [rows.find((row) => row.id === "root")!])
      .subtree("codex:root").map((row) => row.id);
  };

  beforeEach(async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    for (const owner of new Set(owners.values())) {
      const temp = createTempStateDb("federation-archive-");
      directories.push(temp.tempDir);
      const db = StateDb.open(temp.dbPath);
      databases.push(db);
      stores.set(owner, new SqliteOverlayStore(db));
    }
    setDesktopOverlayStoreForTests(stores.get("middle-owner")!);
    await link("before", "root");
    await link("middle", "root");
    await link("after", "root");
    await link("child-b", "middle");
    await link("child-a", "middle");
    await link("deeper", "child-b");
    await stores.get("root-owner")!.updateSubthreadOrder({ backend: "codex", parentThreadId: "root",
      threadIds: ["before", "middle", "after"] });
    await stores.get("middle-owner")!.updateSubthreadOrder({ backend: "codex", parentThreadId: "middle",
      threadIds: ["child-b", "child-a"] });
    await mount("middle-owner", "root");
    runtime = new DesktopFederationRuntime();
    vi.spyOn(runtime, "health").mockResolvedValue({ instanceId: "middle-owner" } as never);
    vi.spyOn(runtime, "assertRemoteNavigationQueryProtocol").mockImplementation(() => {});
    vi.spyOn(runtime, "remoteTargetSupportsCapability").mockReturnValue(true);
    vi.spyOn(runtime, "remoteNavigationQueryPage").mockImplementation(async (target, request) => {
      if (request.query.kind !== "exact") throw new Error("Expected an exact ancestor read.");
      const identity = request.query.identities[0]!;
      const row = owners.get(identity.threadId) === target.instanceId ? await summary(identity.threadId) : undefined;
      return { protocol: 2, complete: true, coverage: { state: "complete" }, entries: row && row.archivedAt === undefined ? [{
        row: { ...row, ref: { ...identity, ownerInstanceId: target.instanceId } },
        orderKey: identity.threadId, placement: { kind: "root" },
      }] : [] } as NavigationQueryPage;
    });
    remoteUpdate = vi.fn<OwnerUpdate>(async (owner, request) => {
      const store = stores.get(owner)!;
      // Exercise the same atomic store boundary as the receiving owner.
      const threadIds = request.archivePromotion
        ? store.applyArchiveSubthreadPromotion(request.archivePromotion, owner)
        : await store.updateSubthreadOrder({ ...request, backend: request.backend ?? "codex" });
      return { backend: "codex", parentThreadId: request.parentThreadId, threadIds };
    });
    vi.spyOn(runtime, "remoteBackend").mockImplementation((target) => ({
      lookupArchivedThreads: async (request: { threadIds: string[] }) => ({ threads:
        (await Promise.all(request.threadIds.filter((id) => owners.get(id) === target.instanceId).map(summary)))
          .filter((row) => row.archivedAt !== undefined),
      }),
      setThreadParent: (request: Parameters<SqliteOverlayStore["setThreadParent"]>[0]) =>
        stores.get(target.instanceId)!.setThreadParent(request),
      updateSubthreadOrder: (request: UpdateSubthreadOrderRequest) => remoteUpdate(target.instanceId, request),
    }) as never);
  });
  afterEach(() => {
    resetDesktopOverlayStoreForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    databases.splice(0).forEach((db) => db.close());
    directories.splice(0).forEach(removeTempStateDbDir);
    stores.clear();
    creationTimes.clear();
    for (const id of [...owners.keys()]) if (!fixtureIds.has(id)) owners.delete(id);
  });

  it("replaces only the intermediate row across four owners in exact flattened order", async () => {
    expect(await tray()).toEqual(["before", "middle", "child-b", "deeper", "child-a", "after"]);
    await runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" });
    await stores.get("middle-owner")!.observeArchivedThreads([{ backend: "codex", threadId: "middle" }], 1000, { promoteSubthreads: true });
    expect(await tray()).toEqual(["before", "child-b", "deeper", "child-a", "after"]);
    for (const id of ["child-b", "child-a"]) {
      expect(await summary(id)).toMatchObject({ parentThreadId: "root", parentThreadInstanceId: "root-owner" });
      for (const viewer of ["root-owner", "middle-owner"]) {
        const pin = (await stores.get(viewer)!.listRemoteThreadPins()).find((entry) => entry.ref.threadId === id);
        expect(pin?.summary).toMatchObject({ parentThreadId: "root", parentThreadInstanceId: "root-owner" });
      }
      expect(await stores.get("middle-owner")!.getThreadOverlayState({ backend: "codex", threadId: id })).toBeUndefined();
    }
    expect(await summary("deeper")).toMatchObject({ parentThreadId: "child-b", parentThreadInstanceId: "child-owner" });
    expect((await summary("middle")).subthreadOrder).toEqual([]);
  });

  it("finishes owner and viewer promotion before invoking the provider archive", async () => {
    vi.spyOn(getDesktopFederationRuntime(), "ungroupRemoteChildrenOfArchivedThread")
      .mockImplementation((request) => runtime.ungroupRemoteChildrenOfArchivedThread(request));
    const archive = vi.spyOn(getDesktopBackendRegistry(), "archiveThread").mockImplementation(async (request) => {
      expect(await summary("child-b")).toMatchObject({ parentThreadId: "root", parentThreadInstanceId: "root-owner" });
      expect((await summary("root")).subthreadOrder).toEqual(["before", "child-b", "child-a", "after"]);
      await stores.get("middle-owner")!.observeArchivedThreads([{ backend: "codex", threadId: request.threadId }], 1000, { promoteSubthreads: true });
      return { backend: "codex", threadId: request.threadId, archivedAt: 1000, cleanup: [] };
    });
    await runtime.localBackend().archiveThread({ backend: "codex", threadId: "middle" });
    expect(archive).toHaveBeenCalledOnce();
    expect(await tray()).toEqual(["before", "child-b", "deeper", "child-a", "after"]);
  });

  it("archives a remote-parent leaf without a parent pin or peer access", async () => {
    owners.set("leaf", "middle-owner");
    await link("leaf", "root");
    await stores.get("middle-owner")!.removeRemoteThreadPin({
      ref: buildFederatedThreadRef({ backend: "codex", threadId: "root", instanceId: "root-owner" }),
    });
    vi.mocked(runtime.assertRemoteNavigationQueryProtocol).mockImplementation(() => { throw new Error("offline"); });
    vi.spyOn(getDesktopFederationRuntime(), "ungroupRemoteChildrenOfArchivedThread")
      .mockImplementation((request) => runtime.ungroupRemoteChildrenOfArchivedThread(request));
    const archive = vi.spyOn(getDesktopBackendRegistry(), "archiveThread").mockResolvedValue({
      backend: "codex", threadId: "leaf", archivedAt: 1000, cleanup: [],
    });
    const { writes } = await measureSqliteWrites(() => runtime.localBackend().archiveThread({ backend: "codex", threadId: "leaf" }));
    expect(archive).toHaveBeenCalledWith({ backend: "codex", threadId: "leaf" });
    expect(runtime.remoteNavigationQueryPage).not.toHaveBeenCalled();
    expect(remoteUpdate).not.toHaveBeenCalled();
    expectSqliteWriteBudget({ scenario: "federation-archive-leaf-preparation", writes,
      note: "A leaf with an uncached remote parent needs no promotion, peer access, or SQLite writes; 0 MB/day." });
  });

  it("reads missing ancestor membership from its owner without inventing a local overlay", async () => {
    await stores.get("middle-owner")!.removeRemoteThreadPin({
      ref: buildFederatedThreadRef({ backend: "codex", threadId: "root", instanceId: "root-owner" }),
    });
    await runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" });
    expect(runtime.remoteNavigationQueryPage).toHaveBeenCalledWith({ scope: "remote", instanceId: "root-owner" },
      expect.objectContaining({ query: { kind: "exact", includeAncestry: false,
        identities: [{ backend: "codex", threadId: "root", ownerInstanceId: "root-owner" }] } }), expect.anything());
    expect((await summary("root")).subthreadOrder).toEqual(["before", "child-b", "child-a", "after"]);
    expect(await stores.get("middle-owner")!.getThreadOverlayState({ backend: "codex", threadId: "root" })).toBeUndefined();
  });

  it("does not start promotion or provider archive with a stale expected parent", async () => {
    await expect(runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle",
      expectedParent: { backend: "codex", threadId: "elsewhere", instanceId: "root-owner" } })).rejects.toThrow("grouping changed");
    expect(remoteUpdate).not.toHaveBeenCalled();
    expect(await summary("child-b")).toMatchObject({ parentThreadId: "middle" });
  });

  it("preserves viewer pin labels, provenance, and curated ranks", async () => {
    const store = stores.get("middle-owner")!;
    for (const id of ["root", "child-b"]) {
      const ref = buildFederatedThreadRef({ backend: "codex", threadId: id, instanceId: owners.get(id)! });
      await store.addRemoteThreadPin({ ref, summary: await summary(id), instanceLabel: `Display ${id}`, pinnedVia: "explicit" });
      await store.setRemoteThreadLocalPin({ ref, pinnedRank: "8192" });
    }
    await runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" });
    const pins = await store.listRemoteThreadPins();
    for (const id of ["root", "child-b"]) expect(pins.find((pin) => pin.ref.threadId === id)).toMatchObject({
      instanceLabel: `Display ${id}`, pinnedVia: "explicit", localPinnedRank: "8192",
    });
  });

  it("promotes local survivors through a remote ancestor without remote-owner overlays", async () => {
    owners.set("local-survivor", "middle-owner");
    owners.set("ancestor-owned-survivor", "root-owner");
    await link("local-survivor", "middle");
    await link("ancestor-owned-survivor", "middle");
    await stores.get("middle-owner")!.updateSubthreadOrder({ backend: "codex", parentThreadId: "middle",
      threadIds: ["child-b", "local-survivor", "ancestor-owned-survivor", "child-a"] });
    await runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" });
    await stores.get("middle-owner")!.observeArchivedThreads([{ backend: "codex", threadId: "middle" }], 1000, { promoteSubthreads: true });
    expect(await tray()).toEqual(["before", "child-b", "deeper", "local-survivor", "ancestor-owned-survivor", "child-a", "after"]);
    expect(await summary("local-survivor")).toMatchObject({ parentThreadId: "root", parentThreadInstanceId: "root-owner" });
    expect((await summary("ancestor-owned-survivor")).parentThreadInstanceId).toBeUndefined();
    expect(await stores.get("middle-owner")!.getThreadOverlayState({ backend: "codex", threadId: "root" })).toBeUndefined();
    expect(await stores.get("root-owner")!.getThreadOverlayState({ backend: "codex", threadId: "local-survivor" })).toBeUndefined();
    expect((await stores.get("middle-owner")!.listRemoteThreadPins()).find((pin) => pin.ref.threadId === "root")?.summary?.subthreadOrder)
      .toEqual(["before", "child-b", "local-survivor", "ancestor-owned-survivor", "child-a", "after"]);
  });

  it.each([false, true])("retries a transport failure after one owner commits (viewer refreshed: %s)", async (refresh) => {
    if (refresh) {
      creationTimes.set("child-b", 20);
      creationTimes.set("child-a", 10);
      await mount("middle-owner", "child-b");
      await mount("middle-owner", "child-a");
      await stores.get("middle-owner")!.updateSubthreadOrder({ backend: "codex", parentThreadId: "middle", threadIds: [] });
    }
    const apply = remoteUpdate.getMockImplementation()!;
    let fail = true;
    remoteUpdate.mockImplementation(async (owner: string, request: UpdateSubthreadOrderRequest) => {
      if (owner === "fourth-owner" && !request.archivePromotion?.dryRun && fail) {
        fail = false;
        throw new Error("transport interrupted");
      }
      const result = await apply(owner, request);
      if (refresh && owner === "child-owner" && !request.archivePromotion?.dryRun) {
        await stores.get("middle-owner")!.updateRemoteThreadPinSnapshots([{
          ref: buildFederatedThreadRef({ backend: "codex", threadId: "child-b", instanceId: owner }),
          summary: await summary("child-b"), instanceLabel: owner,
        }]);
      }
      return result;
    });
    await expect(runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" })).rejects.toThrow("transport interrupted");
    expect((await summary("middle")).archivedAt).toBeUndefined();
    expect((await summary("child-b")).parentThreadId).toBe("root");
    expect((await summary("child-a")).parentThreadId).toBe("middle");
    await runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" });
    await stores.get("middle-owner")!.observeArchivedThreads([{ backend: "codex", threadId: "middle" }], 1000, { promoteSubthreads: true });
    expect(await tray()).toEqual(["before", "child-b", "deeper", "child-a", "after"]);
    const rootPins = await stores.get("root-owner")!.listRemoteThreadPins();
    for (const id of ["child-b", "child-a"]) expect(rootPins.some((pin) => pin.ref.threadId === id)).toBe(true);
  });

  it.each(["lost ancestor response", "failed source commit"])("retains committed ancestor placement after %s", async (failure) => {
    const apply = remoteUpdate.getMockImplementation()!;
    let ancestorCommits = 0;
    let replayWrites: SqliteWriteDelta | undefined;
    remoteUpdate.mockImplementation(async (owner, request) => {
      if (owner !== "root-owner" || request.archivePromotion?.dryRun) return await apply(owner, request);
      ancestorCommits++;
      if (ancestorCommits > 1) {
        const measured = await measureSqliteWrites(() => apply(owner, request));
        replayWrites = measured.writes;
        return measured.result;
      }
      const response = await apply(owner, request);
      if (failure === "lost ancestor response") throw new Error(failure);
      return response;
    });
    if (failure === "failed source commit") {
      const source = stores.get("middle-owner")!;
      const applySource = source.applyArchiveSubthreadPromotion.bind(source);
      let fail = true;
      vi.spyOn(source, "applyArchiveSubthreadPromotion").mockImplementation((promotion, instanceId) => {
        if (!promotion.dryRun && fail) { fail = false; throw new Error(failure); }
        return applySource(promotion, instanceId);
      });
    }
    await expect(runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" })).rejects.toThrow(failure);
    expect((await summary("root")).subthreadOrder).toEqual(["before", "child-b", "child-a", "after"]);
    // A manual move after the commit is newer than the replayed request.
    await stores.get("root-owner")!.updateSubthreadOrder({ backend: "codex", parentThreadId: "root",
      threadIds: ["before", "child-a", "child-b", "after"] });
    await runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" });
    expect((await summary("root")).subthreadOrder).toEqual(["before", "child-a", "child-b", "after"]);
    expect(replayWrites).toBeDefined();
    expectSqliteWriteBudget({ scenario: "federation-archive-ancestor-promotion-repeat", writes: replayWrites!,
      note: "Replay after a committed ancestor promotion preserves placement and newer manual ranks with zero SQLite writes; 0 MB/day." });
    await stores.get("middle-owner")!.observeArchivedThreads([{ backend: "codex", threadId: "middle" }], 1000, { promoteSubthreads: true });
    expect(await tray()).toEqual(["before", "child-a", "child-b", "deeper", "after"]);
  });

  it("accepts owner events refreshing viewer membership before the final local commit", async () => {
    const apply = remoteUpdate.getMockImplementation()!;
    remoteUpdate.mockImplementation(async (owner, request) => {
      const result = await apply(owner, request);
      if (request.archivePromotion && !request.archivePromotion.dryRun) {
        const entries = await Promise.all(request.archivePromotion.children
          .filter(({ ref }) => ref.target.scope === "remote" && ref.target.instanceId === owner)
          .map(async ({ ref, instanceLabel }) => ({ ref, instanceLabel, summary: await summary(ref.threadId) })));
        await stores.get("middle-owner")!.updateRemoteThreadPinSnapshots(entries);
      }
      return result;
    });
    await runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" });
    await stores.get("middle-owner")!.observeArchivedThreads([{ backend: "codex", threadId: "middle" }], 1000, { promoteSubthreads: true });
    expect(await tray()).toEqual(["before", "child-b", "deeper", "child-a", "after"]);
  });

  it("skips an older remote archive and replaces its slot under the nearest live ancestor", async () => {
    owners.set("older-archive", "root-owner");
    await link("older-archive", "root");
    await link("middle", "older-archive");
    await stores.get("root-owner")!.updateSubthreadOrder({ backend: "codex", parentThreadId: "root",
      threadIds: ["before", "older-archive", "after"] });
    await stores.get("root-owner")!.observeArchivedThreads([{ backend: "codex", threadId: "older-archive" }], 500);
    await mount("middle-owner", "older-archive");
    await mount("middle-owner", "root");
    await runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" });
    await stores.get("middle-owner")!.observeArchivedThreads([{ backend: "codex", threadId: "middle" }], 1000, { promoteSubthreads: true });
    expect(await tray()).toEqual(["before", "child-b", "deeper", "child-a", "after"]);
  });

  it("retains unranked remote siblings in their visible creation order", async () => {
    owners.set("unranked-remote", "fourth-owner");
    creationTimes.set("unranked-remote", 10);
    await link("unranked-remote", "root");
    await stores.get("root-owner")!.updateSubthreadOrder({ backend: "codex", parentThreadId: "root", threadIds: ["before", "middle"] });
    await mount("middle-owner", "root");
    expect(await tray()).toEqual(["before", "middle", "child-b", "deeper", "child-a", "unranked-remote", "after"]);
    await runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" });
    await stores.get("middle-owner")!.observeArchivedThreads([{ backend: "codex", threadId: "middle" }], 1000, { promoteSubthreads: true });
    expect(await tray()).toEqual(["before", "child-b", "deeper", "child-a", "unranked-remote", "after"]);
  });

  it("rolls back all relationships and cached membership on a failed owner transaction", async () => {
    const request = await (async () => {
      await runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" });
      return remoteUpdate.mock.calls.find(([owner, entry]) => owner === "root-owner" && entry.archivePromotion?.dryRun === false)![1];
    })();
    // Restore only the root owner's cache/order to the pre-boundary snapshot.
    await stores.get("root-owner")!.removeRemoteThreadPin({ ref: buildFederatedThreadRef({ backend: "codex", threadId: "child-b", instanceId: "child-owner" }) });
    await stores.get("root-owner")!.removeRemoteThreadPin({ ref: buildFederatedThreadRef({ backend: "codex", threadId: "child-a", instanceId: "fourth-owner" }) });
    await stores.get("root-owner")!.updateSubthreadOrder({ backend: "codex", parentThreadId: "root", threadIds: ["before", "middle", "after"] });
    databases[0]!.raw.exec(`CREATE TRIGGER fail_promotion BEFORE INSERT ON remote_thread_pins
      WHEN NEW.thread_id = 'child-a' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
    expect(() => stores.get("root-owner")!.applyArchiveSubthreadPromotion(request.archivePromotion!, "root-owner")).toThrow("fixture failure");
    expect((await summary("root")).subthreadOrder).toEqual(["before", "middle", "after"]);
    expect((await stores.get("root-owner")!.listRemoteThreadPins()).some((pin) => pin.ref.threadId === "child-b")).toBe(false);
  });

  it("rejects a child reparented after discovery without overwriting its owner or viewer", async () => {
    let moved = false;
    remoteUpdate.mockImplementation(async (owner: string, request: UpdateSubthreadOrderRequest) => {
      if (!moved && request.archivePromotion?.dryRun) {
        moved = true;
        await stores.get("child-owner")!.setThreadParent({ backend: "codex", threadId: "child-b", parentThreadId: "elsewhere" });
      }
      const threadIds = stores.get(owner)!.applyArchiveSubthreadPromotion(request.archivePromotion!, owner);
      return { backend: "codex", parentThreadId: request.parentThreadId, threadIds };
    });
    await expect(runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" })).rejects.toThrow("parent changed");
    expect(await summary("child-b")).toMatchObject({ parentThreadId: "elsewhere" });
    expect((await summary("root")).subthreadOrder).toEqual(["before", "middle", "after"]);
    expect((await stores.get("middle-owner")!.listRemoteThreadPins()).find((pin) => pin.ref.threadId === "child-b")?.summary?.parentThreadId).toBe("middle");
  });

  it.each(["membership", "order"])("rejects concurrent source %s changes before committing any promotion", async (change) => {
    const apply = remoteUpdate.getMockImplementation()!;
    let changed = false;
    remoteUpdate.mockImplementation(async (owner, request) => {
      if (!changed && request.archivePromotion?.dryRun) {
        changed = true;
        if (change === "membership") {
          owners.set("late-child", "middle-owner");
          await link("late-child", "middle");
        } else await stores.get("middle-owner")!.updateSubthreadOrder({ backend: "codex", parentThreadId: "middle",
          threadIds: ["child-a", "child-b"] });
      }
      return await apply(owner, request);
    });
    await expect(runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" }))
      .rejects.toThrow("children changed before archive");
    expect((await summary("child-b")).parentThreadId).toBe("middle");
    expect((await summary("root")).subthreadOrder).toEqual(["before", "middle", "after"]);
    expect(remoteUpdate.mock.calls.every(([, request]) => request.archivePromotion?.dryRun)).toBe(true);
  });

  it("batches 100 children by owner with no writes on repeat", async () => {
    for (let index = 0; index < 98; index++) {
      const id = `extra-${index}`;
      owners.set(id, "child-owner");
      await link(id, "middle");
    }
    const { writes } = await measureSqliteWrites(() => runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" }));
    expectSqliteWriteBudget({ scenario: "federation-archive-subthread-promotion", writes,
      note: "100 direct children (98 unranked) across four owners: 6 boundary commits including recovery slots and viewer cache (~0.255 MB WAL); 10 such archives/day cost ~2.55 MB/day. No per-child commits; idle cost 0 MB/day." });
    const repeated = await measureSqliteWrites(() => runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" }));
    expectSqliteWriteBudget({ scenario: "federation-archive-subthread-promotion-repeat", writes: repeated.writes,
      note: "Repeated completed archive promotion: zero commits, 0 MB/day." });
    for (let index = 0; index < 98; index++) owners.delete(`extra-${index}`);
  });

  it.each(["offline", "denied", "upgrade"])("keeps relationships and caches intact when the last participant is %s", async (reason) => {
    if (reason === "offline") vi.mocked(runtime.assertRemoteNavigationQueryProtocol).mockImplementation((target) => {
      if (target.instanceId === "root-owner") throw new Error("offline");
    });
    else vi.mocked(runtime.remoteTargetSupportsCapability).mockImplementation((target, capability) =>
      target.instanceId !== "root-owner" || capability !== (reason === "denied" ? "thread_grouping" : "archive_subthread_promotion_v1"));
    await expect(runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" })).rejects.toThrow();
    expect(await summary("child-b")).toMatchObject({ parentThreadId: "middle", parentThreadInstanceId: "middle-owner" });
    expect((await summary("root")).subthreadOrder).toEqual(["before", "middle", "after"]);
    expect(remoteUpdate).not.toHaveBeenCalled();
  });
});
