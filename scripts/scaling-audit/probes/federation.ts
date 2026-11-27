import { record } from "./scaling-audit-results";
import { createHash, randomUUID } from "node:crypto";
import { expect, it, onTestFinished, vi } from "vitest";
import type { DurableTurnRequestService } from "@pwragent/owner-core/durable-turn-request-service";
import { ThreadTurnQueue } from "@pwragent/owner-core/thread-turn-queue";
import type { SubmitDurableTurnRequest } from "@pwragent/shared/contracts/durable-turn-requests";
import type { FederationCapability, FederationPeerSummary } from "@pwragent/shared/contracts/federation";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { canonicalDurableTurnRequest } from "@pwragent/shared/durable-turn-request";
import * as registryModule from "../app-server/backend-registry";
import {
  additionalFederationBackendCapabilities, FEDERATION_BACKEND_METHOD_CAPABILITIES, registerFederationBackendHandlers,
} from "../federation/federation-backend-bridge";
import { FederationRouter } from "../federation/federation-router";
import type { FederationRpcEndpoint } from "../federation/federation-rpc";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";
import * as federationStorage from "../storage/desktop-federation-storage";
import { SqliteDurableTurnRequestStore } from "../storage/durable-turn-request-store";
import { createThreadReadRegistry } from "./fixtures/thread-read-harness";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const grants: FederationCapability[] = ["turn_control", "durable_turn_requests_v1"];
const target = { scope: "remote" as const, instanceId: "owner" };
const ref = { backend: "codex" as const, threadId: "thread" };

it.each([[2,8,4],[4,8,4],[8,8,4],[2,16,4],[2,32,4],[2,8,8],[2,8,16],[4,16,8],[8,32,16]])("durable request roundtrip %i peers %i depth %i redeliveries", async (peerCount,depth,retries) => {

  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const { dbPath, tempDir } = createTempStateDb("durable-retry-");
  const db = StateDb.open(dbPath);
  const queue = new ThreadTurnQueue({ startTurn: async () => { throw new Error("Fixture queue is held"); } });
  onTestFinished(() => {
    queue.close();
    db.close();
    removeTempStateDbDir(tempDir);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  let labelReads = 0, copiedEntries = 0, neighborIdReads = 0, queuedInputReads = 0;
  const peers = Array.from({ length: peerCount }, (_, i): FederationPeerSummary => {
    const id = i === peerCount - 1 ? target.instanceId : `peer-${i}`;
    return { id, get label() { labelReads++; return id; }, role: "client", status: "connected", capabilities: grants };
  });
  const viewer = new DesktopFederationRuntime();
  const viewerRouter = new FederationRouter({ localInstanceId: "viewer" });
  const ownerRouter = new FederationRouter({ localInstanceId: "owner", methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    additionalRequiredCapabilities: additionalFederationBackendCapabilities });
  const rpcByPeer = new Map<string, FederationRpcEndpoint>();
  const visiblePeers = vi.fn(() => peers);
  Object.assign(viewer, { router: viewerRouter, localInstanceId: "viewer", rpcByPeer, visiblePeers,
    shortNames: { shortLabelFor: () => undefined } });
  for (const peer of peers) {
    viewerRouter.registerConnection({ peerId: peer.id, capabilities: peer.capabilities, sendEnvelope: envelope => {
      void ownerRouter.routeEnvelope({ sourcePeerId: "viewer", envelope });
    } });
  }
  ownerRouter.registerConnection({ peerId: "viewer", capabilities: grants,
    sendEnvelope: envelope => { rpcByPeer.get("owner")!.receiveEnvelope(envelope); } });

  const input = [{ type: "text" as const, text: "Durable retry fixture" }];
  queue.restoreQueued(Array.from({ length: depth - 1 }, (_, i) => ({
    ...ref, get id() { neighborIdReads++; return `neighbor-${i}`; }, createdAt: i, origin: "manual", input,
  })));
  const getEntries = queue.getQueuedEntries.bind(queue);
  vi.spyOn(queue, "getQueuedEntries").mockImplementation(params => {
    const entries = getEntries(params);
    copiedEntries += entries.length;
    return entries;
  });
  const submitTurn = vi.fn(async (request: SubmitDurableTurnRequest["request"] & { queueEntryId: string }) => {
    const [entry] = queue.restoreQueued([{
      backend: request.backend, threadId: request.threadId, origin: "manual", id: request.queueEntryId, createdAt: Date.now(),
      get input() { queuedInputReads++; return request.input; },
    }]);
    return { status: "queued", entry, position: depth };
  });
  let ownerIdReads = 0;
  const threads = Array.from({ length: 4 }, (_, i): AppServerThreadSummary => ({
    get id() { ownerIdReads++; return i === 0 || i === 3 ? ref.threadId : `thread-${i}`; },
    source: i === 0 ? "claude" : ref.backend, title: "Fixture", titleSource: "explicit", linkedDirectories: [],
  }));
  const snapshot = { threads, archived: false, expiresAt: Infinity };
  const threadListCache = new Map([["provider", snapshot]]);

  const { registry } = createThreadReadRegistry([]);
  onTestFinished(() => registry.close());
  Object.assign(registry, {
    threadTurnQueue: queue, onEvent: vi.fn(), threadListCache,
    assertProjectAcceptsThreadMessage: vi.fn(), submitTurn,
  });
  vi.spyOn(registryModule, "getDesktopBackendRegistry").mockReturnValue(registry);
  vi.spyOn(federationStorage, "createDurableTurnRequestStorage").mockReturnValue(new SqliteDurableTurnRequestStore(db));
  const owner = new DesktopFederationRuntime();
  Object.assign(owner, { localInstanceId: "owner" });
  const service = (owner as unknown as { durableTurnRequestService(): DurableTurnRequestService }).durableTurnRequestService();
  registerFederationBackendHandlers({ router: ownerRouter, backend: owner.localBackend(), durableTurnRequests: service });

  const request: SubmitDurableTurnRequest = {
    clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" }, request: { ...ref, input },
  };
  request.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableTurnRequest("owner", request)).digest("hex");
  const burst = () => Promise.all(Array.from({ length: retries }, () => viewer.submitDurableTurnRequest("device", request, target)));
  const { result: cold, writes: coldWrites } = await measureSqliteWrites(burst);
  expect(submitTurn).toHaveBeenCalledTimes(1);
  expect(coldWrites.commits).toBeGreaterThan(0);
  expect(cold.every(receipt => receipt.queueEntryId === cold[0]!.queueEntryId)).toBe(true);
  expect(cold[0]).toMatchObject({ state: "accepted", result: { queueStatus: "queued" } });

  const before = { labelReads, copiedEntries, ownerIdReads, queuedInputReads };
  neighborIdReads = 0;
  const { result: warm, writes } = await measureSqliteWrites(burst);
  for (const receipt of warm) expect(receipt).toEqual(cold[0]);
  expect(submitTurn).toHaveBeenCalledTimes(1);
  expect(writes.commits).toBe(0);
  record({
    kind: "federation", peerCount, depth, retries, writes: writes.commits, neighborIdReads,
    labelReads: labelReads - before.labelReads, copiedEntries: copiedEntries - before.copiedEntries,
    ownerIdReads: ownerIdReads - before.ownerIdReads, queuedInputReads: queuedInputReads - before.queuedInputReads,
  });
});
