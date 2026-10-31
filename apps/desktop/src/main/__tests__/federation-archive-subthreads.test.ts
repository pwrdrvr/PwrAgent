import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, UpdateSubthreadOrderRequest } from "@pwragent/shared";
import { buildFederatedThreadRef } from "@pwragent/shared";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import { setDesktopOverlayStoreForTests, resetDesktopOverlayStoreForTests } from "../app-server/desktop-overlay-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { createSubthreadTrays } from "../../renderer/src/features/navigation/subthread-trays";

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
  let runtime: DesktopFederationRuntime;
  let remoteUpdate: ReturnType<typeof vi.fn>;

  const summary = async (id: string): Promise<NavigationThreadSummary> => ({
    ...await stores.get(owners.get(id)!)!.getThreadOverlayState({ backend: "codex", threadId: id }),
    id, source: "codex", title: id, titleSource: "explicit", linkedDirectories: [],
    createdAt: 0, inbox: { inInbox: false },
  });
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
      if (!row.parentThreadId || row.id === "middle") continue;
      const key = `codex:${row.parentThreadId}`;
      buckets.set(key, [...(buckets.get(key) ?? []), row]);
    }
    return createSubthreadTrays(buckets, [rows.find((row) => row.id === "root")!])
      .subtree("codex:root").map((row) => row.id);
  };

  beforeEach(async () => {
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
    remoteUpdate = vi.fn(async (owner: string, request: UpdateSubthreadOrderRequest) => {
      const store = stores.get(owner)!;
      // Exercise the same atomic store boundary as the receiving owner.
      const threadIds = request.archivePromotion
        ? store.applyArchiveSubthreadPromotion(request.archivePromotion, owner)
        : await store.updateSubthreadOrder({ ...request, backend: request.backend ?? "codex" });
      return { backend: "codex", parentThreadId: request.parentThreadId, threadIds };
    });
    vi.spyOn(runtime, "remoteBackend").mockImplementation((target) => ({
      setThreadParent: (request: Parameters<SqliteOverlayStore["setThreadParent"]>[0]) =>
        stores.get(target.instanceId)!.setThreadParent(request),
      updateSubthreadOrder: (request: UpdateSubthreadOrderRequest) => remoteUpdate(target.instanceId, request),
    }) as never);
  });
  afterEach(() => {
    resetDesktopOverlayStoreForTests();
    vi.restoreAllMocks();
    databases.splice(0).forEach((db) => db.close());
    directories.splice(0).forEach(removeTempStateDbDir);
    stores.clear();
  });

  it("replaces only the intermediate row across four owners in exact flattened order", async () => {
    await runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" });
    expect(await tray()).toEqual(["before", "child-b", "deeper", "child-a", "after"]);
    for (const id of ["child-b", "child-a"]) {
      expect(await summary(id)).toMatchObject({ parentThreadId: "root", parentThreadInstanceId: "root-owner" });
      for (const viewer of ["root-owner", "middle-owner"]) {
        const pin = (await stores.get(viewer)!.listRemoteThreadPins()).find((entry) => entry.ref.threadId === id);
        expect(pin?.summary).toMatchObject({ parentThreadId: "root", parentThreadInstanceId: viewer === "root-owner" ? undefined : "root-owner" });
      }
      expect(await stores.get("middle-owner")!.getThreadOverlayState({ backend: "codex", threadId: id })).toBeUndefined();
    }
    expect(await summary("deeper")).toMatchObject({ parentThreadId: "child-b", parentThreadInstanceId: "child-owner" });
    expect((await summary("middle")).subthreadOrder).toEqual([]);
  });

  it.each(["offline", "denied"])("keeps relationships and caches intact when an owner is %s", async (reason) => {
    if (reason === "offline") vi.mocked(runtime.assertRemoteNavigationQueryProtocol).mockImplementation(() => { throw new Error("offline"); });
    else vi.mocked(runtime.remoteTargetSupportsCapability).mockReturnValue(false);
    await expect(runtime.ungroupRemoteChildrenOfArchivedThread({ backend: "codex", parentThreadId: "middle" })).rejects.toThrow();
    expect(await summary("child-b")).toMatchObject({ parentThreadId: "middle", parentThreadInstanceId: "middle-owner" });
    expect((await summary("root")).subthreadOrder).toEqual(["before", "middle", "after"]);
    expect(remoteUpdate).not.toHaveBeenCalled();
  });
});
