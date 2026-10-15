import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalDurableSteerRequest, canonicalDurableTurnRequest,
  type AppServerTurnInputItem, type FederationRequestEnvelope,
  type SubmitDurableSteerRequest, type SubmitDurableTurnRequest,
} from "@pwragent/shared";
import { DurableTurnRequestService } from "../federation/durable-turn-request-service";
import {
  additionalFederationBackendCapabilities, durableFederationCallerScope,
  FEDERATION_BACKEND_METHOD_CAPABILITIES, FEDERATION_BACKEND_METHODS,
  registerFederationBackendHandlers, type FederationBackendOperations,
} from "../federation/federation-backend-bridge";
import { FederationRouter } from "../federation/federation-router";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const NOW = 1_800_000_000_000;
const SCOPE = durableFederationCallerScope("gateway", "mobile:device");
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function setup() {
  const { dbPath, tempDir } = createTempStateDb("durable-federation-input-");
  const db = StateDb.open(dbPath);
  cleanups.push(() => { db.close(); removeTempStateDbDir(tempDir); });
  const dispatch = vi.fn(async () => ({ backend: "codex" as const, threadId: "thread", turnId: "turn" }));
  const steer = vi.fn(async (request: SubmitDurableSteerRequest["request"] & { requestId: string }) => ({ ok: true as const, backend: "codex" as const, threadId: "thread", requestId: request.requestId, turnId: "turn", disposition: "steered" as const }));
  const service = new DurableTurnRequestService({ stateDb: db, ownerInstanceId: "owner", now: () => NOW, authorize: async () => {}, dispatch, steer });
  const router = new FederationRouter({ localInstanceId: "owner", trustedRelayPeerId: "relay", methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES, additionalRequiredCapabilities: additionalFederationBackendCapabilities });
  // Durable inputs must be checked, not transformed into un-hashed owner paths.
  const resolveTurnInput = vi.fn(async () => { throw new Error("Must not rewrite canonical inputs"); });
  registerFederationBackendHandlers({ router, backend: {} as FederationBackendOperations, durableTurnRequests: service, resolveTurnInput });
  for (const peerId of ["gateway", "relay"]) {
    router.registerConnection({ peerId, capabilities: ["turn_control", "durable_turn_requests_v1", "durable_steer_requests_v1"], sendEnvelope: () => {} });
  }
  return { db, service, router, dispatch, steer, resolveTurnInput };
}

function submission(input: AppServerTurnInputItem[], steering: boolean) {
  const value: SubmitDurableTurnRequest | SubmitDurableSteerRequest = {
    clientRequest: { version: 1, id: randomUUID(), createdAt: NOW, payloadHash: "" },
    request: { backend: "codex", threadId: "thread", input, ...(steering ? { expectedTurnId: "turn" } : {}) },
  };
  value.clientRequest.payloadHash = createHash("sha256").update(steering
    ? canonicalDurableSteerRequest("owner", value as SubmitDurableSteerRequest)
    : canonicalDurableTurnRequest("owner", value as SubmitDurableTurnRequest)).digest("hex");
  return value;
}

const localReferences: AppServerTurnInputItem[] = [
  { type: "localFile", path: "/owner/private.txt" },
  { type: "localImage", path: "/owner/private.png" },
  { type: "image", url: "file:///owner/private.png" },
  { type: "image", url: "FILE:///owner/private.png" },
  { type: "image", url: " \nfile:///owner/private.png" },
];

describe.each([false, true])("durable Federation input trust (steering=%s)", (steering) => {
  function envelope(value: ReturnType<typeof submission>, relayed: boolean): FederationRequestEnvelope {
    return { id: randomUUID(), kind: "request", protocolVersion: 1, sourceInstanceId: "gateway", targetInstanceId: "owner", createdAt: NOW,
      ...(relayed ? { hopCount: 1 } : {}),
      method: steering ? FEDERATION_BACKEND_METHODS.submitSteerRequest : FEDERATION_BACKEND_METHODS.submitTurnRequest,
      params: { ...value, callerScope: "mobile:device" },
    };
  }

  it.each([false, true])("rejects owner-local paths before admission or dispatch (relayed=%s)", async (relayed) => {
    const fixture = setup();
    for (const input of localReferences) {
      const value = submission([input], steering);
      expect(await fixture.router.routeEnvelope({ sourcePeerId: relayed ? "relay" : "gateway", envelope: envelope(value, relayed) })).toMatchObject({ status: "rejected", code: "request_invalid" });
    }
    expect(fixture.db.raw.prepare("SELECT count(*) AS n FROM durable_turn_requests").get()).toEqual({ n: 0 });
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(fixture.steer).not.toHaveBeenCalled();
    expect(fixture.resolveTurnInput).not.toHaveBeenCalled();
  });

  it("preserves safe inline content, its canonical hash, and lost-ACK replay", async () => {
    const fixture = setup();
    const value = submission([
      { type: "text", text: "review these inline attachments" },
      { type: "image", url: "data:image/png;base64,aGVsbG8=" },
      { type: "file", name: "note.txt", mimeType: "text/plain", data: "aGVsbG8=" },
    ], steering);
    const request = envelope(value, true);
    const first = await fixture.router.routeEnvelope({ sourcePeerId: "relay", envelope: request });
    expect(first).toMatchObject({ status: "handled", response: { result: { payloadHash: value.clientRequest.payloadHash, state: "dispatched" } } });
    const repeat = await fixture.router.routeEnvelope({ sourcePeerId: "relay", envelope: { ...request, id: randomUUID() } });
    if (first.status !== "handled" || repeat.status !== "handled") throw new Error("Owner did not accept inline request");
    expect(repeat.response?.result).toEqual(first.response?.result);
    const dispatch = steering ? fixture.steer : fixture.dispatch;
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ input: value.request.input }), SCOPE);
    expect(fixture.resolveTurnInput).not.toHaveBeenCalled();
  });

  it("keeps trusted local owner submission compatible with local references", async () => {
    const fixture = setup();
    const value = submission(localReferences.slice(0, 3), steering);
    const receipt = steering
      ? await fixture.service.submitSteer(SCOPE, value as SubmitDurableSteerRequest)
      : await fixture.service.submit(SCOPE, value as SubmitDurableTurnRequest);
    expect(receipt.state).toBe("dispatched");
    expect(steering ? fixture.steer : fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ input: value.request.input }), SCOPE);
  });
});
