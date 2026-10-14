import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalDurableTurnRequest, DURABLE_TURN_REQUEST_RETENTION_MS,
  type DurableTurnReceipt, type SubmitDurableTurnRequest, type FederationRequestEnvelope,
} from "@pwragent/shared";
import { DurableTurnRequestService } from "../federation/durable-turn-request-service";
import {
  registerFederationBackendHandlers, FEDERATION_BACKEND_METHODS,
  FEDERATION_BACKEND_METHOD_CAPABILITIES, additionalFederationBackendCapabilities,
  durableFederationCallerScope, type FederationBackendOperations,
} from "../federation/federation-backend-bridge";
import { FederationRouter } from "../federation/federation-router";
import { ThreadTurnQueue } from "../app-server/thread-turn-queue";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const OWNER = "owner";
const SCOPE = durableFederationCallerScope("phone-gateway", "mobile:device");
const NOW = 1_800_000_000_000;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.unstubAllEnvs(); });

function database() {
  const { dbPath, tempDir } = createTempStateDb("durable-turn-");
  let db = StateDb.open(dbPath);
  cleanups.push(() => { db.close(); removeTempStateDbDir(tempDir); });
  return { get db() { return db; }, reopen() { db.close(); db = StateDb.open(dbPath); return db; }, dbPath };
}
function submission(options: { id?: string; text?: string; createdAt?: number; owner?: string } = {}): SubmitDurableTurnRequest {
  const value: SubmitDurableTurnRequest = {
    clientRequest: { version: 1, id: options.id ?? randomUUID(), createdAt: options.createdAt ?? NOW, payloadHash: "" },
    request: { backend: "codex", threadId: "thread", input: [{ type: "text", text: options.text ?? "hello" }] },
  };
  value.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableTurnRequest(options.owner ?? OWNER, value)).digest("hex");
  return value;
}
function setup(options: { now?: () => number; dispatch?: FederationBackendOperations["startTurn"]; maxPerCaller?: number; maxTotal?: number } = {}) {
  const file = database();
  const authorize = vi.fn(async () => {});
  const dispatch = vi.fn(options.dispatch ?? (async (request) => ({ backend: request.backend, threadId: request.threadId, turnId: "turn", queueStatus: "started" as const, queueEntryId: request.queueEntryId })));
  const make = () => new DurableTurnRequestService({ stateDb: file.db, ownerInstanceId: OWNER, now: options.now ?? (() => NOW), authorize, dispatch, maxPerCaller: options.maxPerCaller, maxTotal: options.maxTotal });
  return { file, service: make(), make, authorize, dispatch };
}
function lookup(value: SubmitDurableTurnRequest) {
  return { id: value.clientRequest.id, backend: value.request.backend, threadId: value.request.threadId };
}
function seed(db: StateDb, value: SubmitDurableTurnRequest, state: "accepted" | "dispatching") {
  const receipt: DurableTurnReceipt = {
    version: 1, id: value.clientRequest.id, payloadHash: value.clientRequest.payloadHash,
    ownerInstanceId: OWNER, backend: "codex", threadId: "thread", state,
    queueEntryId: `durable-turn:${createHash("sha256").update(JSON.stringify([SCOPE, value.clientRequest.id])).digest("hex")}`,
    acceptedAt: NOW, updatedAt: NOW, expiresAt: NOW + DURABLE_TURN_REQUEST_RETENTION_MS,
  };
  db.raw.prepare(`INSERT INTO durable_turn_requests
    (caller_scope, request_id, payload_hash, expires_at, receipt_json, queue_entry_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(SCOPE, receipt.id, receipt.payloadHash, receipt.expiresAt, JSON.stringify(receipt), receipt.queueEntryId);
}

describe("durable turn request inbox", () => {
  it("returns the durable result after accepted dispatch loses its ACK and the owner restarts", async () => {
    const fixture = setup();
    const value = submission();
    const first = await fixture.service.submit(SCOPE, value); // ACK is intentionally discarded.
    fixture.file.reopen();
    const restarted = fixture.make();
    expect(await restarted.get(SCOPE, lookup(value))).toEqual(first);
    expect(await restarted.submit(SCOPE, value)).toEqual(first);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent retries across two database connections without duplicate dispatch", async () => {
    let finish!: (value: { backend: "codex"; threadId: string; turnId: string }) => void;
    const fixture = setup({ dispatch: () => new Promise((resolve) => { finish = resolve; }) });
    const otherDb = StateDb.open(fixture.file.dbPath);
    const other = new DurableTurnRequestService({ stateDb: otherDb, ownerInstanceId: OWNER, now: () => NOW, authorize: fixture.authorize, dispatch: fixture.dispatch });
    const value = submission();
    try {
      const first = fixture.service.submit(SCOPE, value);
      await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledTimes(1));
      const duplicates = await Promise.all(Array.from({ length: 20 }, () => other.submit(SCOPE, value)));
      expect(duplicates.every((receipt) => receipt.state === "dispatching")).toBe(true);
      finish({ backend: "codex", threadId: "thread", turnId: "turn" });
      const receipt = await first;
      expect(await other.submit(SCOPE, value)).toEqual(receipt);
      expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    } finally { otherDb.close(); }
  });

  it("rejects a reused key with changed canonical payload, while repeated content with different UUIDs dispatches", async () => {
    const { service, dispatch } = setup();
    const original = submission();
    await service.submit(SCOPE, original);
    await expect(service.submit(SCOPE, submission({ id: original.clientRequest.id, text: "changed" }))).rejects.toMatchObject({ code: "request_conflict" });
    await service.submit(SCOPE, submission());
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("resumes a crash after admission before claim, but never redispatches a crash before/after provider acceptance", async () => {
    let now = NOW;
    const fixture = setup({ now: () => now });
    const accepted = submission();
    seed(fixture.file.db, accepted, "accepted");
    fixture.file.reopen();
    expect((await fixture.make().submit(SCOPE, accepted)).state).toBe("dispatched");
    const ambiguous = submission();
    seed(fixture.file.db, ambiguous, "dispatching");
    fixture.file.reopen();
    now += 5 * 60_000;
    const restarted = fixture.make();
    expect((await restarted.get(SCOPE, lookup(ambiguous)))?.state).toBe("uncertain");
    expect((await restarted.submit(SCOPE, ambiguous)).state).toBe("uncertain");
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not automatically retry unproven downstream acceptance or persist error contents", async () => {
    const fixture = setup({ dispatch: async () => { throw new Error("private provider details"); } });
    const value = submission();
    expect((await fixture.service.submit(SCOPE, value)).state).toBe("uncertain");
    expect((await fixture.service.submit(SCOPE, value)).state).toBe("uncertain");
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    const rows = fixture.file.db.raw.prepare("SELECT receipt_json FROM durable_turn_requests").all();
    expect(JSON.stringify(rows)).not.toContain("private provider details");
    expect(JSON.stringify(rows)).not.toContain("hello");
  });

  it("keeps queued admission separate from actual start and terminal completion", async () => {
    const fixture = setup({ dispatch: async (request) => ({ backend: "codex", threadId: request.threadId, turnId: request.queueEntryId!, queueStatus: "queued", queueEntryId: request.queueEntryId }) });
    const value = submission();
    const admitted = await fixture.service.submit(SCOPE, value);
    expect(admitted.state).toBe("accepted");
    await fixture.service.submit(SCOPE, value);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    fixture.service.observeQueueEvent({ backend: "codex", threadId: "thread", queueEntryId: admitted.queueEntryId, status: "started", turnId: "real-turn" });
    expect((await fixture.service.get(SCOPE, lookup(value)))?.result?.turnId).toBe("real-turn");
    fixture.service.observeQueueEvent({ backend: "codex", threadId: "thread", queueEntryId: admitted.queueEntryId, status: "terminal", terminalStatus: "turn/failed" });
    expect(await fixture.service.get(SCOPE, lookup(value))).toMatchObject({ state: "completed", outcome: "failed" });
  });

  it("preserves terminal proof when queue events precede the dispatch response", async () => {
    const fixture = setup();
    fixture.dispatch.mockImplementation(async (request) => {
      fixture.service.observeQueueEvent({ backend: "codex", threadId: "thread", queueEntryId: request.queueEntryId!, status: "terminal", terminalStatus: "turn/completed" });
      return { backend: "codex", threadId: "thread", turnId: "turn" };
    });
    expect((await fixture.service.submit(SCOPE, submission())).state).toBe("completed");
  });

  it.each([undefined, "idle", "notLoaded", "unknown", "failed", "completed"])(
    "does not treat queue availability %s as terminal proof or write a receipt",
    async (terminalStatus) => {
      vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
      const fixture = setup();
      const value = submission();
      const receipt = await fixture.service.submit(SCOPE, value);
      const { writes } = await measureSqliteWrites(() => {
        fixture.service.observeQueueEvent({ backend: "codex", threadId: "thread", queueEntryId: receipt.queueEntryId, status: "terminal", terminalStatus });
      });
      expect(writes.commits).toBe(0);
      expect(await fixture.service.get(SCOPE, lookup(value))).toEqual(receipt);
      fixture.service.observeQueueEvent({ backend: "codex", threadId: "thread", queueEntryId: receipt.queueEntryId, status: "terminal", terminalStatus: "turn/failed" });
      expect(await fixture.service.get(SCOPE, lookup(value))).toMatchObject({ state: "completed", outcome: "failed" });
    },
  );

  it.each(["completed", "failed", "cancelled"] as const)("records only explicit turn/%s terminal proof", async (outcome) => {
    const fixture = setup();
    const value = submission();
    const receipt = await fixture.service.submit(SCOPE, value);
    fixture.service.observeQueueEvent({ backend: "codex", threadId: "thread", queueEntryId: receipt.queueEntryId, status: "terminal", terminalStatus: `turn/${outcome}` });
    expect(await fixture.service.get(SCOPE, lookup(value))).toMatchObject({ state: "completed", outcome });
  });

  it("preserves start proof when a delayed queue-admission response arrives after actual start", async () => {
    const fixture = setup();
    fixture.dispatch.mockImplementation(async (request) => {
      fixture.service.observeQueueEvent({ backend: "codex", threadId: "thread", queueEntryId: request.queueEntryId!, status: "started", turnId: "actual-turn" });
      return { backend: "codex", threadId: "thread", turnId: request.queueEntryId!, queueEntryId: request.queueEntryId, queueStatus: "queued" };
    });
    expect(await fixture.service.submit(SCOPE, submission())).toMatchObject({ state: "dispatched", result: { turnId: "actual-turn", queueStatus: "started" } });
  });

  it("marks a queued receipt uncertain if its memory-only queue is lost during restart", async () => {
    const fixture = setup({ dispatch: async (request) => ({ backend: "codex", threadId: request.threadId, turnId: request.queueEntryId!, queueStatus: "queued", queueEntryId: request.queueEntryId }) });
    const value = submission();
    await fixture.service.submit(SCOPE, value);
    fixture.file.reopen();
    const restarted = new DurableTurnRequestService({ stateDb: fixture.file.db, ownerInstanceId: OWNER, now: () => NOW, authorize: fixture.authorize, dispatch: fixture.dispatch, isQueued: async () => false });
    expect((await restarted.get(SCOPE, lookup(value)))?.state).toBe("uncertain");
    await restarted.submit(SCOPE, value);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps acceptance proof after a later ambiguous submission error", async () => {
    const fixture = setup();
    fixture.dispatch.mockImplementation(async (request) => {
      fixture.service.observeQueueEvent({ backend: "codex", threadId: "thread", queueEntryId: request.queueEntryId!, status: "started", turnId: "proven" });
      throw new Error("response lost after proven start");
    });
    expect(await fixture.service.submit(SCOPE, submission())).toMatchObject({ state: "dispatched", result: { turnId: "proven" } });
  });

  it("canonicalizes object order while retaining attachment/reference/setting and destination identity", () => {
    const value = submission();
    expect(canonicalDurableTurnRequest(OWNER, value)).toBe(`{"createdAt":${NOW},"destination":{"backend":"codex","instanceId":"owner","threadId":"thread"},"operation":"startTurn","request":{"backend":"codex","input":[{"text":"hello","type":"text"}],"threadId":"thread"},"version":1}`);
    const reordered = { ...value, request: { input: value.request.input, threadId: "thread", backend: "codex" as const } };
    expect(canonicalDurableTurnRequest(OWNER, reordered)).toBe(canonicalDurableTurnRequest(OWNER, value));
    expect(canonicalDurableTurnRequest(OWNER, { ...value, request: { ...value.request, model: "model" } })).not.toBe(canonicalDurableTurnRequest(OWNER, value));
    expect(canonicalDurableTurnRequest("other-owner", value)).not.toBe(canonicalDurableTurnRequest(OWNER, value));
    expect(() => canonicalDurableTurnRequest(OWNER, { ...value, request: { ...value.request, model: NaN as unknown as string } })).toThrow();
  });

  it("checks authorization on every replay and isolates authenticated device/issuer scopes", async () => {
    const fixture = setup();
    const value = submission();
    await fixture.service.submit(SCOPE, value);
    expect(await fixture.service.get(durableFederationCallerScope("other-gateway", "mobile:device"), lookup(value))).toBeNull();
    expect(await fixture.service.get(durableFederationCallerScope("phone-gateway", "mobile:other"), lookup(value))).toBeNull();
    fixture.authorize.mockRejectedValue(new Error("revoked"));
    await expect(fixture.service.get(SCOPE, lookup(value))).rejects.toThrow("revoked");
    await expect(fixture.service.submit(SCOPE, value)).rejects.toThrow("revoked");
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects expired requests even after pruning, and applies admission quotas without evicting valid receipts", async () => {
    let now = NOW;
    const fixture = setup({ now: () => now, maxPerCaller: 1, maxTotal: 2 });
    const value = submission();
    const receipt = await fixture.service.submit(SCOPE, value);
    await expect(fixture.service.submit(SCOPE, submission())).rejects.toMatchObject({ code: "request_quota_exceeded" });
    expect(await fixture.service.submit(SCOPE, value)).toEqual(receipt);
    now += DURABLE_TURN_REQUEST_RETENTION_MS;
    expect(await fixture.service.get(SCOPE, lookup(value))).toBeNull();
    await fixture.service.submit(SCOPE, submission({ createdAt: now }));
    expect((fixture.file.db.raw.prepare("SELECT count(*) AS n FROM durable_turn_requests").get() as { n: number }).n).toBe(1);
    await expect(fixture.service.submit(SCOPE, value)).rejects.toMatchObject({ code: "request_expired" });
  });

  it("validates destination, creation time, hash, attachments and JSON before admission", async () => {
    const fixture = setup();
    await expect(fixture.service.submit(SCOPE, submission({ owner: "other-owner" }))).rejects.toMatchObject({ code: "request_hash_mismatch" });
    await expect(fixture.service.submit(SCOPE, submission({ createdAt: NOW + 300_001 }))).rejects.toMatchObject({ code: "request_invalid" });
    await expect(fixture.service.submit(SCOPE, submission({ text: "x".repeat(65536) }))).rejects.toMatchObject({ code: "request_too_large" });
    const value = submission();
    value.request.input = [{ type: "federationBlob", transferId: "ephemeral" }] as unknown as typeof value.request.input;
    await expect(fixture.service.submit(SCOPE, value)).rejects.toMatchObject({ code: "request_invalid" });
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("has a checked-in boundary write budget, and retries/status/stream noise add zero writes", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const fixture = setup();
    const value = submission();
    const { writes, result: receipt } = await measureSqliteWrites(async () => {
      const receipt = await fixture.service.submit(SCOPE, value);
      fixture.service.observeQueueEvent({ backend: "codex", threadId: "thread", queueEntryId: receipt.queueEntryId, status: "terminal", terminalStatus: "turn/completed" });
      return receipt;
    });
    expectSqliteWriteBudget({ scenario: "durable-turn-request", note: "One prompt: admission, dispatch claim, dispatch receipt and terminal receipt; no payload persistence.", writes });
    const retries = await measureSqliteWrites(async () => {
      for (let i = 0; i < 100; i += 1) {
        await fixture.service.submit(SCOPE, value);
        await fixture.service.get(SCOPE, lookup(value));
        fixture.service.observeQueueEvent({ backend: "codex", threadId: "thread", queueEntryId: receipt.queueEntryId, status: "queued" });
      }
    });
    expect(retries.writes.commits).toBe(0);
    expect(fixture.file.db.raw.pragma("synchronous", { simple: true })).toBe(1);
  });
});

it.each(["turn/failed", "turn/cancelled"])("leaves a generic release awaiting reconciliation when %s arrives after queue removal", async (terminalStatus) => {
  let fixture!: ReturnType<typeof setup>;
  const provider = vi.fn(async () => ({ backend: "codex" as const, threadId: "thread", turnId: "turn" }));
  const queue = new ThreadTurnQueue({
    startTurn: provider,
    onLifecycle: (event) => fixture.service.observeQueueEvent({
      backend: event.entry.backend, threadId: event.entry.threadId, queueEntryId: event.entry.id,
      status: event.type, turnId: "turnId" in event ? event.turnId : undefined,
      terminalStatus: event.type === "terminal" ? event.status : undefined,
    }),
  });
  cleanups.push(() => queue.close());
  fixture = setup({ dispatch: async (request) => {
    const { delivery: _delivery, ...entry } = request;
    const submitted = await queue.submit({ ...entry, id: request.queueEntryId, origin: "manual" });
    if (submitted.status !== "started") throw new Error("Test turn did not start");
    return { backend: request.backend, threadId: request.threadId, queueEntryId: submitted.entry.id, queueStatus: "started", turnId: submitted.turnId };
  } });
  const value = submission();
  const receipt = await fixture.service.submit(SCOPE, value);
  await queue.releaseThread({ backend: "codex", threadId: "thread", status: "idle" });
  await queue.releaseThread({ backend: "codex", threadId: "thread", turnId: "turn", status: terminalStatus });
  expect(await fixture.service.get(SCOPE, lookup(value))).toEqual(receipt);
  expect(receipt.state).toBe("dispatched");
  expect(receipt.outcome).toBeUndefined();
  expect(await fixture.service.submit(SCOPE, value)).toEqual(receipt);
  expect(provider).toHaveBeenCalledTimes(1);
});

it("routes a durable device submission through gateway -> owner -> actual backend, then reconciles an ACK-lost retry", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  let fixture!: ReturnType<typeof setup>;
  const provider = vi.fn(async () => ({ backend: "codex" as const, threadId: "thread", turnId: "turn" }));
  const queue = new ThreadTurnQueue({
    startTurn: provider,
    onLifecycle: (event) => fixture.service.observeQueueEvent({
      backend: event.entry.backend, threadId: event.entry.threadId,
      queueEntryId: event.entry.id, status: event.type,
      turnId: "turnId" in event ? event.turnId : undefined,
      terminalStatus: event.type === "terminal" ? event.status : undefined,
    }),
  });
  cleanups.push(() => queue.close());
  fixture = setup({ dispatch: async (request) => {
    const { delivery: _delivery, ...entry } = request;
    const submitted = await queue.submit({ ...entry, id: request.queueEntryId, origin: "manual" });
    return { backend: request.backend, threadId: request.threadId, queueEntryId: submitted.entry.id,
      queueStatus: submitted.status, turnId: submitted.status === "started" ? submitted.turnId : submitted.entry.id };
  } });
  const owner = new FederationRouter({ localInstanceId: OWNER, trustedRelayPeerId: "relay", methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES, additionalRequiredCapabilities: additionalFederationBackendCapabilities });
  registerFederationBackendHandlers({ router: owner, backend: {} as FederationBackendOperations, durableTurnRequests: fixture.service });
  owner.registerConnection({ peerId: "relay", capabilities: ["turn_control", "durable_turn_requests_v1"], sendEnvelope: () => {} });
  const relayed: FederationRequestEnvelope[] = [];
  const gateway = new FederationRouter({ localInstanceId: "relay", methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES, additionalRequiredCapabilities: additionalFederationBackendCapabilities });
  gateway.registerConnection({ peerId: "phone-gateway", capabilities: ["turn_control", "durable_turn_requests_v1", "gateway_relay"], sendEnvelope: () => {} });
  gateway.registerConnection({ peerId: OWNER, capabilities: ["turn_control", "durable_turn_requests_v1"], sendEnvelope: (envelope) => { if (envelope.kind === "request") relayed.push(envelope); } });
  const value = submission();
  const envelope: FederationRequestEnvelope = { id: "rpc-1", kind: "request", protocolVersion: 1, sourceInstanceId: "phone-gateway", targetInstanceId: OWNER, createdAt: NOW, method: FEDERATION_BACKEND_METHODS.submitTurnRequest, params: { ...value, callerScope: "mobile:device" } };
  const route = async (request: FederationRequestEnvelope) => {
    expect((await gateway.routeEnvelope({ sourcePeerId: "phone-gateway", envelope: request })).status).toBe("relayed");
    return owner.routeEnvelope({ sourcePeerId: "relay", envelope: relayed.shift()! });
  };
  const { result: first, writes } = await measureSqliteWrites(async () => {
    const receipt = await route(envelope);
    await queue.releaseThread({ backend: "codex", threadId: "thread", turnId: "turn", status: "turn/completed" });
    return receipt;
  });
  expectSqliteWriteBudget({ scenario: "durable-turn-request-through-queue", note: "One prompt through the gateway and real turn queue: admission, claim, start proof, result and terminal proof.", writes });
  expect(first.status).toBe("handled");
  const replay = await route({ ...envelope, id: "rpc-2" });
  if (first.status !== "handled" || replay.status !== "handled") throw new Error("Owner did not handle the request");
  expect(replay.response?.result).toMatchObject({ ...(first.response?.result as object), state: "completed", outcome: "completed" });
  expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(await route({ ...envelope, id: "rpc-conflict", params: { ...submission({ id: value.clientRequest.id, text: "changed" }), callerScope: "mobile:device" } })).toMatchObject({ status: "rejected", code: "request_conflict" });
  const status = await route({ ...envelope, id: "rpc-3", method: FEDERATION_BACKEND_METHODS.getTurnRequest, params: { ...lookup(value), callerScope: "mobile:device" } });
  expect(status).toMatchObject({ response: { result: { state: "completed", result: { turnId: "turn" } } } });
  const spoofed = await gateway.routeEnvelope({ sourcePeerId: "phone-gateway", envelope: { ...envelope, sourceInstanceId: "victim" } });
  expect(spoofed).toMatchObject({ status: "rejected", code: "relay_origin_mismatch" });
  gateway.registerConnection({ peerId: "phone-gateway", capabilities: ["gateway_relay"], sendEnvelope: () => {} });
  expect(await gateway.routeEnvelope({ sourcePeerId: "phone-gateway", envelope })).toMatchObject({ status: "rejected", code: "capability_denied" });
});
