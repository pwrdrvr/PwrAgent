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
import { codexThread, createThreadReadRegistry, publishNotification } from "./fixtures/thread-read-harness";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const grants: FederationCapability[] = ["turn_control", "durable_turn_requests_v1"];
const target = { scope: "remote" as const, instanceId: "owner" };
const ref = { backend: "codex" as const, threadId: "thread" };

it("duplicate bursts reuse the fresh owner inventory and inspect no peer labels or neighboring queue entries", async () => {
  const peerCount = 4, depth = 4, retries = 3;
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
  const resolveThread = vi.spyOn(registry, "resolveThread");
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
  expect(labelReads).toBe(0);
  expect(ownerIdReads).toBe(threads.length);
  neighborIdReads = 0;
  const { result: warm, writes } = await measureSqliteWrites(burst);
  for (const receipt of warm) expect(receipt).toEqual(cold[0]);
  expect(submitTurn).toHaveBeenCalledTimes(1);
  expect(writes.commits).toBe(0);
  expect(resolveThread).toHaveBeenCalledTimes(2 * retries);
  // Claimed IDs can coincide across providers in an aggregate listing.
  expect(await registry.resolveThread(ref)).toBe(threads[3]);
  expect(await registry.resolveThread({ threadId: ref.threadId })).toBe(threads[0]);
  expect(ownerIdReads).toBe(threads.length);
  expect(visiblePeers).not.toHaveBeenCalled();
  expect({ labelReads, copiedEntries, neighborIdReads, queuedInputReads }).toEqual({
    labelReads: 0, copiedEntries: 0, neighborIdReads: 0, queuedInputReads: 0,
  });

  // Simulate a lost lifecycle event. The same entry ID in another FIFO cannot
  // confirm this receipt. Once uncertain, retries cannot admit it again.
  expect(queue.hasQueuedEntry({ ...ref, backend: "claude", queueEntryId: cold[0]!.queueEntryId })).toBe(false);
  const entry = queue.cancelEntry(cold[0]!.queueEntryId)!;
  queue.restoreQueued([{ ...entry, threadId: "other" }]);
  const missing = await viewer.submitDurableTurnRequest("device", request, target);
  expect(missing).toMatchObject({ state: "uncertain", queueEntryId: entry.id });
  const terminal = await measureSqliteWrites(burst);
  expect(terminal.writes.commits).toBe(0);
  for (const receipt of terminal.result) expect(receipt).toEqual(missing);

  // Even a settled receipt requires fresh ownership evidence. A replacement
  // list containing this ID on a different backend cannot authorize the replay.
  snapshot.expiresAt = 0;
  threadListCache.set("other-backend", { ...snapshot, expiresAt: Infinity, threads: [{ ...threads[3]!, source: "claude" }] });
  const refresh = vi.spyOn(registry, "listThreads").mockResolvedValue([]);
  await expect(viewer.submitDurableTurnRequest("device", request, target)).rejects.toMatchObject({ code: "request_destination_unavailable" });
  expect(refresh).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ backend: ref.backend, forceRefresh: true }));
  expect(submitTurn).toHaveBeenCalledTimes(1);
});

it("rechecks ownership after status invalidation without discovering workspace environments", async () => {
  const { dbPath, tempDir } = createTempStateDb("durable-cold-retry-");
  const db = StateDb.open(dbPath);
  const queue = new ThreadTurnQueue({ startTurn: async () => { throw new Error("Fixture queue is held"); } });
  const { client, registry } = createThreadReadRegistry([codexThread({ id: ref.threadId })]);
  onTestFinished(async () => {
    await registry.close();
    queue.close();
    db.close();
    removeTempStateDbDir(tempDir);
    vi.restoreAllMocks();
  });
  Object.assign(registry, { threadTurnQueue: queue });
  const submitTurn = vi.spyOn(registry, "submitTurn").mockImplementation(async (request) => {
    const [entry] = queue.restoreQueued([{
      ...ref, id: request.queueEntryId!, createdAt: Date.now(), origin: "manual", input: request.input,
    }]);
    return { status: "queued", entry, position: 1 };
  });
  const environmentBatches: number[] = [];
  vi.spyOn(registry as unknown as {
    withThreadEnvironmentOptions(rows: AppServerThreadSummary[]): Promise<AppServerThreadSummary[]>;
  }, "withThreadEnvironmentOptions").mockImplementation(async (rows) => {
    environmentBatches.push(rows.length);
    return rows;
  });
  vi.spyOn(registryModule, "getDesktopBackendRegistry").mockReturnValue(registry);
  vi.spyOn(federationStorage, "createDurableTurnRequestStorage").mockReturnValue(new SqliteDurableTurnRequestStore(db));
  const owner = new DesktopFederationRuntime();
  Object.assign(owner, { localInstanceId: "owner" });
  const request: SubmitDurableTurnRequest = {
    clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" },
    request: { ...ref, input: [{ type: "text", text: "Durable retry fixture" }] },
  };
  request.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableTurnRequest("owner", request)).digest("hex");
  const deliver = () => owner.submitDurableTurnRequest("device", request);
  const original = await deliver();
  expect(original.result?.queueStatus).toBe("queued");
  environmentBatches.length = 0;
  let status: "active" | "idle" = "active";
  const update = async () => {
    await publishNotification(registry, {
      method: "thread/status/changed", params: { threadId: "neighbor-0", status: { type: status } },
    });
    status = status === "active" ? "idle" : "active";
  };
  for (const [neighbors, duplicates] of [[8, 2], [32, 8], [128, 4]]) {
    client.setThreads([codexThread({ id: ref.threadId }),
      ...Array.from({ length: neighbors }, (_, index) => codexThread({ id: `neighbor-${index}` }))]);
    await update();
    client.resetCounts();
    const receipts = await Promise.all(Array.from({ length: duplicates }, (_, index) =>
      index % 2 ? owner.getDurableTurnRequest("device", { ...ref, id: original.id }) : deliver()));
    // A new provider observation authorizes each burst without scanning any
    // checkout's display-only environment catalog.
    expect(receipts).toEqual(Array(duplicates).fill(original));
    expect(client.listCalls).toHaveLength(1);
    expect(environmentBatches).toEqual([]);
  }
  await registry.listThreads({ backend: "codex" });
  expect(environmentBatches).toEqual([129]);
  client.setThreads([]);
  await update();
  await expect(deliver()).rejects.toMatchObject({ code: "request_destination_unavailable" });
  expect(submitTurn).toHaveBeenCalledTimes(1);
});

it("checks the current owner's feature and turn-control grants on every submit and receipt lookup", async () => {
  const viewer = new DesktopFederationRuntime();
  const router = new FederationRouter({ localInstanceId: "viewer" });
  const directory = new Map<string, FederationPeerSummary>();
  const sent = vi.fn();
  const getPeer = vi.fn<() => FederationPeerSummary | undefined>(() => undefined);
  Object.assign(viewer, {
    localInstanceId: "viewer", router, gatewayInstanceId: "hub", remotePeerDirectory: directory,
    store: () => ({ getPeer }),
    remoteBackend: () => ({ submitTurnRequest: sent, getTurnRequest: sent, submitSteerRequest: sent, getSteerRequest: sent }),
  });
  const request: SubmitDurableTurnRequest = { clientRequest: { version: 1, id: "id", createdAt: 0, payloadHash: "" },
    request: { ...ref, input: [] } };
  const lookup = { ...ref, id: "id" };
  const check = async (turn: boolean, steer: boolean) => {
    sent.mockClear();
    const outcomes = await Promise.allSettled([
      viewer.submitDurableTurnRequest("device", request, target), viewer.getDurableTurnRequest("device", lookup, target),
      viewer.submitDurableSteerRequest("device", { ...request, request: { ...request.request, expectedTurnId: "turn" } }, target),
      viewer.getDurableSteerRequest("device", lookup, target),
    ]);
    for (const [i, outcome] of outcomes.entries()) {
      if (i < 2 ? turn : steer) expect(outcome.status).toBe("fulfilled");
      else expect(outcome).toMatchObject({ status: "rejected", reason: { code: "request_unsupported" } });
    }
    expect(sent).toHaveBeenCalledTimes(2 * (Number(turn) + Number(steer)));
  };
  const connect = (peerId: string, capabilities: FederationCapability[]) =>
    router.registerConnection({ peerId, capabilities, sendEnvelope: () => {} });
  const owner: FederationPeerSummary = { id: "owner", label: "Owner", role: "client", status: "connected", capabilities: grants };
  directory.set("owner", owner);
  connect("hub", ["gateway_relay", "turn_control", "durable_steer_requests_v1"]);
  await check(true, false);
  connect("owner", ["turn_control", "durable_steer_requests_v1"]);
  await check(false, true);
  connect("owner", ["durable_turn_requests_v1", "durable_steer_requests_v1"]);
  await check(false, false);
  router.unregisterConnection("owner");
  await check(true, false);
  router.unregisterConnection("hub");
  await check(false, false);
  connect("hub", ["gateway_relay"]);
  directory.set("owner", { ...owner, status: "disconnected" });
  await check(false, false);
  directory.set("owner", { ...owner, capabilities: ["turn_control", "durable_steer_requests_v1"] });
  await check(false, true);
  directory.set("owner", { ...owner, capabilities: ["durable_turn_requests_v1", "durable_steer_requests_v1"] });
  await check(false, false);
  directory.set("owner", owner);
  getPeer.mockReturnValue({ ...owner, capabilities: ["turn_control"] });
  await check(false, false);
  getPeer.mockReturnValue({ ...owner, status: "revoked" });
  await check(false, false);
});
