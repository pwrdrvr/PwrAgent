import { afterEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import { rmSync } from "node:fs";
import type { AgentEvent, FederationCapability } from "@pwragent/shared";
import {
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  FederationRemoteBackendClient,
  registerFederationBackendHandlers,
  type FederationBackendOperations,
} from "../federation/federation-backend-bridge";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";
import { setLocalDirectoryPin, reorderLocalDirectoryPins } from "../app-server/local-directory-pins";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb } from "./sqlite-test-utils";

const owner = vi.hoisted(() => ({ store: undefined as unknown, events: [] as AgentEvent[] }));
vi.mock("../storage/desktop-overlay-store", () => ({ getDesktopOverlayStore: () => owner.store }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: () => ({
  publishLocalEvent: async (event: AgentEvent) => { owner.events.push(event); },
}) }));
vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {} }) }));

afterEach(() => { owner.store = undefined; owner.events = []; vi.unstubAllEnvs(); });

function connectOwner(backend: Partial<FederationBackendOperations>) {
  const router = new FederationRouter({ localInstanceId: "owner", methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES });
  const rpc = new FederationRpcEndpoint({ localInstanceId: "viewer", remoteInstanceId: "owner",
    sendEnvelope: (envelope) => { void router.routeEnvelope({ envelope, sourcePeerId: "viewer" }); } });
  registerFederationBackendHandlers({ router, backend: backend as FederationBackendOperations });
  const grant = (capabilities: FederationCapability[]) => router.registerConnection({ peerId: "viewer", capabilities,
    sendEnvelope: (envelope) => { rpc.receiveEnvelope(envelope); } });
  grant(["thread_navigation"]);
  return { client: new FederationRemoteBackendClient(rpc), grant, rpc };
}

it("makes remote directory pin operations agree with the owner's persisted order and events", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    kind: fc.constantFrom("pin", "unpin", "up", "down"), index: fc.integer({ min: 0, max: 2 }),
  }), { minLength: 1, maxLength: 10 }), async (commands) => {
    const db = openInMemoryStateDb();
    const store = new SqliteOverlayStore(db);
    owner.store = store;
    owner.events = [];
    const { client, rpc } = connectOwner({ setDirectoryPin: setLocalDirectoryPin, reorderDirectoryPins: reorderLocalDirectoryPins });
    const expected: string[] = [];
    try {
      for (const command of commands) {
        const directoryKey = `directory:/fixture/project-${command.index}`;
        const from = expected.indexOf(directoryKey);
        if (command.kind === "pin" || command.kind === "unpin") {
          if (command.kind === "pin" && from < 0) expected.push(directoryKey);
          if (command.kind === "unpin" && from >= 0) expected.splice(from, 1);
          const response = await client.setDirectoryPin({ directoryKey, pinned: command.kind === "pin" });
          expect(Boolean(response.pinnedRank)).toBe(command.kind === "pin");
          expect(owner.events.at(-1)?.notification).toEqual(response.pinnedRank
            ? { method: "directory/pin/added", params: response }
            : { method: "directory/pin/removed", params: { directoryKey } });
        } else {
          if (from < 0) continue;
          const to = from + (command.kind === "up" ? -1 : 1);
          if (to >= 0 && to < expected.length) {
            expected.splice(from, 1);
            expected.splice(to, 0, directoryKey);
          }
          const response = await client.reorderDirectoryPins({ move: { key: directoryKey, direction: command.kind } });
          expect(owner.events.at(-1)?.notification).toEqual({ method: "directory/pin/reordered", params: response });
        }
        const persisted: Array<{ key: string; rank: string }> = [];
        for (let index = 0; index < 3; index++) {
          const key = `directory:/fixture/project-${index}`;
          const overlay = await store.getDirectoryOverlayState({ directoryKey: key });
          if (overlay?.pinnedRank) persisted.push({ key, rank: overlay.pinnedRank });
        }
        expect(persisted.sort((left, right) => Number(left.rank) - Number(right.rank)).map(({ key }) => key)).toEqual(expected);
      }
    } finally { rpc.rejectAll(new Error("Fixture closed.")); db.close(); }
  }), { numRuns: 25 });
});

it("requires navigation permission and rejects synthetic directory pins on the owner", async () => {
  const setDirectoryPin = vi.fn(setLocalDirectoryPin);
  const reorderDirectoryPins = vi.fn(reorderLocalDirectoryPins);
  const { client, grant, rpc } = connectOwner({ setDirectoryPin, reorderDirectoryPins });
  try {
    grant(["thread_detail"]);
    await expect(client.setDirectoryPin({ directoryKey: "directory:/fixture/git", pinned: true })).rejects.toThrow();
    await expect(client.reorderDirectoryPins({ move: { key: "directory:/fixture/git", direction: "up" } })).rejects.toThrow();
    expect(setDirectoryPin).not.toHaveBeenCalled();
    expect(reorderDirectoryPins).not.toHaveBeenCalled();
    grant(["thread_navigation"]);
    await expect(client.setDirectoryPin({ directoryKey: "unlinked", pinned: true })).rejects.toThrow("synthetic directory");
    await expect(client.reorderDirectoryPins({ move: { key: "directory:/fixture/git", anchorKey: "unlinked", placement: "before" } }))
      .rejects.toThrow("synthetic directory");
    expect(owner.events).toEqual([]);
  } finally { rpc.rejectAll(new Error("Fixture closed.")); }
});

it("commits each remote pin action once on its owner with no idle writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const { dbPath, tempDir } = createTempStateDb("pwragent-remote-directory-pins-");
  const db = StateDb.open(dbPath);
  const store = new SqliteOverlayStore(db);
  owner.store = store;
  const { client, rpc } = connectOwner({ setDirectoryPin: setLocalDirectoryPin, reorderDirectoryPins: reorderLocalDirectoryPins });
  try {
    await store.setDirectoryPin({ directoryKey: "directory:/fixture/existing", pinned: true });
    const { writes } = await measureSqliteWrites(async () => {
      await client.setDirectoryPin({ directoryKey: "directory:/fixture/git", pinned: true });
      await client.reorderDirectoryPins({ move: { key: "directory:/fixture/git", direction: "up" } });
      await client.setDirectoryPin({ directoryKey: "directory:/fixture/git", pinned: false });
    });
    expectSqliteWriteBudget({ scenario: "federation-directory-pin-actions", writes,
      note: "Pin, move and unpin use three owner commits; 100 actions/day at ~8 KiB/commit is ~0.8 MB/day; no idle writes" });
  } finally { rpc.rejectAll(new Error("Fixture closed.")); db.close(); rmSync(tempDir, { recursive: true, force: true }); }
});

it("asks to update an older owner without falling back to a local pin", async () => {
  const { client, rpc } = connectOwner({});
  try {
    await expect(client.setDirectoryPin({ directoryKey: "directory:/fixture/git", pinned: true }))
      .rejects.toThrow("Update PwrAgent on the owning instance");
    await expect(client.reorderDirectoryPins({ move: { key: "directory:/fixture/git", direction: "up" } }))
      .rejects.toThrow("Update PwrAgent on the owning instance");
    expect(owner.events).toEqual([]);
  } finally { rpc.rejectAll(new Error("Fixture closed.")); }
});
