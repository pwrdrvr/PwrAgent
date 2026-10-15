import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalDurableSteerRequest, canonicalDurableTurnRequest,
  DURABLE_TURN_REQUEST_RETENTION_MS,
  type SubmitDurableSteerRequest, type ControlActiveTurnResponse,
  type FederationRequestEnvelope,
  type GetDurableTurnRequest,
} from "@pwragent/shared";
import { DurableTurnRequestService } from "../federation/durable-turn-request-service";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import {
  durableFederationCallerScope, registerFederationBackendHandlers,
  FEDERATION_BACKEND_METHODS, FEDERATION_BACKEND_METHOD_CAPABILITIES,
  additionalFederationBackendCapabilities, type FederationBackendOperations,
} from "../federation/federation-backend-bridge";
import { FederationRouter } from "../federation/federation-router";

const NOW = 1_800_000_000_000;
const SCOPE = durableFederationCallerScope("gateway", "mobile:device");
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.unstubAllEnvs(); });

function submission(options: { id?: string; expectedTurnId?: string; text?: string; createdAt?: number } = {}): SubmitDurableSteerRequest {
  const value: SubmitDurableSteerRequest = {
    clientRequest: { version: 1, id: options.id ?? randomUUID(), createdAt: options.createdAt ?? NOW, payloadHash: "" },
    request: { backend: "codex", threadId: "thread", expectedTurnId: options.expectedTurnId ?? "active-turn", input: [{ type: "text", text: options.text ?? "please focus on tests" }] },
  };
  value.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableSteerRequest("owner", value)).digest("hex");
  return value;
}
function setup(options: { now?: () => number; maxTotal?: number } = {}) {
  const { dbPath, tempDir } = createTempStateDb("durable-steer-");
  let db = StateDb.open(dbPath);
  cleanups.push(() => { db.close(); removeTempStateDbDir(tempDir); });
  const authorize = vi.fn(async (_scope: string, _request: GetDurableTurnRequest) => {});
  const dispatch = vi.fn(async () => { throw new Error("Steer must never start a new turn"); });
  const steer = vi.fn(async (request: SubmitDurableSteerRequest["request"] & { requestId: string }): Promise<ControlActiveTurnResponse> => ({ ok: true, backend: request.backend, threadId: request.threadId, requestId: request.requestId, turnId: request.expectedTurnId, disposition: "steered" }));
  const make = () => new DurableTurnRequestService({ stateDb: db, ownerInstanceId: "owner", authorize, dispatch, steer, now: options.now ?? (() => NOW), maxTotal: options.maxTotal });
  return { get db() { return db; }, dbPath, service: make(), make, authorize, dispatch, steer, reopen() { db.close(); db = StateDb.open(dbPath); } };
}
function lookup(value: SubmitDurableSteerRequest) {
  return { id: value.clientRequest.id, backend: value.request.backend, threadId: value.request.threadId };
}

describe("durable steer request inbox", () => {
  it("preserves a lost-ACK steering result through restart with a stable namespaced downstream requestId", async () => {
    const fixture = setup();
    const value = submission();
    const first = await fixture.service.submitSteer(SCOPE, value);
    expect(first).toMatchObject({ operation: "steerTurn", state: "dispatched", result: { ok: true, turnId: "active-turn", disposition: "steered" } });
    expect(fixture.steer.mock.calls[0]?.[0]).toMatchObject({ expectedTurnId: "active-turn", requestId: first.queueEntryId });
    fixture.reopen();
    const restarted = fixture.make();
    expect(await restarted.submitSteer(SCOPE, value)).toEqual(first);
    expect(await restarted.getSteer(SCOPE, lookup(value))).toEqual(first);
    expect(await restarted.get(SCOPE, lookup(value))).toBeNull();
    expect(fixture.steer).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("claims concurrent steering retries once across database connections", async () => {
    const fixture = setup();
    let finish!: () => void;
    fixture.steer.mockImplementation(async (request) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { ok: true, backend: "codex", threadId: "thread", requestId: request.requestId, turnId: request.expectedTurnId, disposition: "steered" };
    });
    const otherDb = StateDb.open(fixture.dbPath);
    const other = new DurableTurnRequestService({ stateDb: otherDb, ownerInstanceId: "owner", authorize: fixture.authorize, dispatch: fixture.dispatch, steer: fixture.steer, now: () => NOW });
    try {
      const value = submission();
      const first = fixture.service.submitSteer(SCOPE, value);
      await vi.waitFor(() => expect(fixture.steer).toHaveBeenCalledTimes(1));
      expect((await other.submitSteer(SCOPE, value)).state).toBe("dispatching");
      finish();
      const receipt = await first;
      expect(await other.submitSteer(SCOPE, value)).toEqual(receipt);
      expect(fixture.steer).toHaveBeenCalledTimes(1);
    } finally { otherDb.close(); }
  });

  it("rejects changed expected turn/input for a key but accepts deliberate repeated content with a new UUID", async () => {
    const fixture = setup();
    const value = submission();
    await fixture.service.submitSteer(SCOPE, value);
    await expect(fixture.service.submitSteer(SCOPE, submission({ id: value.clientRequest.id, expectedTurnId: "new-turn" }))).rejects.toMatchObject({ code: "request_conflict" });
    await expect(fixture.service.submitSteer(SCOPE, submission({ id: value.clientRequest.id, text: "changed" }))).rejects.toMatchObject({ code: "request_conflict" });
    await fixture.service.submitSteer(SCOPE, submission());
    expect(fixture.steer).toHaveBeenCalledTimes(2);
  });

  it("never resends ambiguous downstream steering or a stale crash claim", async () => {
    let now = NOW;
    const fixture = setup({ now: () => now });
    const value = submission();
    fixture.steer.mockRejectedValue(new Error("ACK lost after provider accepts"));
    expect((await fixture.service.submitSteer(SCOPE, value)).state).toBe("uncertain");
    fixture.reopen();
    await fixture.make().submitSteer(SCOPE, value);
    expect(fixture.steer).toHaveBeenCalledTimes(1);
    const pending = submission();
    fixture.steer.mockImplementation(() => new Promise(() => {}));
    void fixture.make().submitSteer(SCOPE, pending);
    await vi.waitFor(() => expect(fixture.steer).toHaveBeenCalledTimes(2));
    fixture.reopen();
    now += 5 * 60_000;
    expect((await fixture.make().getSteer(SCOPE, lookup(pending)))?.state).toBe("uncertain");
    await fixture.make().submitSteer(SCOPE, pending);
    expect(fixture.steer).toHaveBeenCalledTimes(2);
  });

  it("persists sanitized structured refusal without falling back to a new turn", async () => {
    const fixture = setup();
    fixture.steer.mockImplementation(async (request) => ({ ok: false, backend: "codex", threadId: "thread", requestId: request.requestId, error: { code: "stale_target", message: "sensitive provider details", activeTurnId: "private-metadata" } }));
    const value = submission();
    const receipt = await fixture.service.submitSteer(SCOPE, value);
    expect(receipt).toMatchObject({ state: "uncertain", result: { ok: false, error: { code: "stale_target" } } });
    expect(JSON.stringify(receipt)).not.toContain("sensitive provider details");
    expect(JSON.stringify(receipt)).not.toContain("private-metadata");
    expect(await fixture.service.submitSteer(SCOPE, value)).toEqual(receipt);
    expect(fixture.steer).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("requires exact active-turn identity, hashes operation, and forbids client requestId/fallback/provenance", async () => {
    const fixture = setup();
    const value = submission();
    expect(canonicalDurableSteerRequest("owner", value)).not.toBe(canonicalDurableTurnRequest("owner", value));
    await expect(fixture.service.submitSteer(SCOPE, submission({ expectedTurnId: "" }))).rejects.toMatchObject({ code: "request_invalid" });
    for (const extra of [{ requestId: "client-untrusted" }, { fallback: {} }, { messageOrigin: { kind: "agent" } }]) {
      await expect(fixture.service.submitSteer(SCOPE, { ...value, request: { ...value.request, ...extra } })).rejects.toMatchObject({ code: "request_invalid" });
    }
    expect(fixture.steer).not.toHaveBeenCalled();
  });

  it("checks the original authenticated scope on every replay, and enforces retention/global quotas", async () => {
    let now = NOW;
    const fixture = setup({ now: () => now, maxTotal: 1 });
    const value = submission();
    await fixture.service.submitSteer(SCOPE, value);
    expect(fixture.authorize.mock.calls[0]?.[0]).toBe(SCOPE);
    await expect(fixture.service.submitSteer(SCOPE, submission())).rejects.toMatchObject({ code: "request_quota_exceeded" });
    expect(await fixture.service.getSteer(durableFederationCallerScope("gateway", "mobile:other"), lookup(value))).toBeNull();
    fixture.authorize.mockRejectedValueOnce(new Error("revoked"));
    await expect(fixture.service.submitSteer(SCOPE, value)).rejects.toThrow("revoked");
    now += DURABLE_TURN_REQUEST_RETENTION_MS;
    expect(await fixture.service.getSteer(SCOPE, lookup(value))).toBeNull();
    await expect(fixture.service.submitSteer(SCOPE, value)).rejects.toMatchObject({ code: "request_expired" });
  });

  it("reuses the boundary write budget with zero writes for repeated steering receipts", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const fixture = setup();
    const value = submission();
    const { writes } = await measureSqliteWrites(() => fixture.service.submitSteer(SCOPE, value));
    expectSqliteWriteBudget({ scenario: "durable-steer-request", note: "One explicit steer: durable admission, dispatch claim and acceptance receipt; no fallback or streamed writes.", writes });
    const repeated = await measureSqliteWrites(async () => {
      for (let i = 0; i < 100; i += 1) {
        await fixture.service.submitSteer(SCOPE, value);
        await fixture.service.getSteer(SCOPE, lookup(value));
      }
    });
    expect(repeated.writes.commits).toBe(0);
  });
});

it("preserves authenticated device scope and expected turn over a trusted steering relay, and refuses old capability grants", async () => {
  const fixture = setup();
  const owner = new FederationRouter({ localInstanceId: "owner", trustedRelayPeerId: "relay", methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES, additionalRequiredCapabilities: additionalFederationBackendCapabilities });
  registerFederationBackendHandlers({ router: owner, backend: {} as FederationBackendOperations, durableTurnRequests: fixture.service });
  owner.registerConnection({ peerId: "relay", capabilities: ["turn_control", "durable_steer_requests_v1"], sendEnvelope: () => {} });
  const value = submission();
  const envelope: FederationRequestEnvelope = { id: "rpc-1", kind: "request", protocolVersion: 1, sourceInstanceId: "gateway", targetInstanceId: "owner", hopCount: 1, createdAt: NOW, method: FEDERATION_BACKEND_METHODS.submitSteerRequest, params: { ...value, callerScope: "mobile:device" } };
  const first = await owner.routeEnvelope({ sourcePeerId: "relay", envelope });
  const repeat = await owner.routeEnvelope({ sourcePeerId: "relay", envelope: { ...envelope, id: "rpc-2" } });
  if (first.status !== "handled" || repeat.status !== "handled") throw new Error("Owner did not accept steer");
  expect(repeat.response?.result).toEqual(first.response?.result);
  expect(fixture.steer).toHaveBeenCalledTimes(1);
  expect(fixture.authorize).toHaveBeenCalledWith(SCOPE, lookup(value));
  expect(await owner.routeEnvelope({ sourcePeerId: "relay", envelope: { ...envelope, method: FEDERATION_BACKEND_METHODS.getSteerRequest, params: { ...lookup(value), callerScope: "mobile:device" } } })).toMatchObject({ status: "handled", response: { result: { operation: "steerTurn", state: "dispatched" } } });
  owner.registerConnection({ peerId: "relay", capabilities: ["turn_control", "durable_turn_requests_v1"], sendEnvelope: () => {} });
  expect(await owner.routeEnvelope({ sourcePeerId: "relay", envelope })).toMatchObject({ status: "rejected", code: "capability_denied" });
  expect(fixture.steer).toHaveBeenCalledTimes(1);
});
