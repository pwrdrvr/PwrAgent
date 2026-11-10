import { pushFederationFile, type FilePushResult } from "../federation/federation-file-push";
import { setFederationMessagingDestinationHandler } from "../federation/federation-messaging-tools";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { expect, it, vi } from "vitest";
import fc from "fast-check";
import { FEDERATION_CAPABILITIES, type FederationPeerRole, type FederationRequestEnvelope } from "@pwragent/shared";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import { FederationStore } from "../storage/federation-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { FEDERATION_BACKEND_METHODS } from "@pwragent/federation/federation-backend-methods";
import { FederationRouter } from "../federation/federation-router";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import type { FederationGatewayConnection } from "../federation/federation-transport";

vi.mock("../settings/desktop-settings-singleton", () => ({ getDesktopSettingsService: vi.fn() }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: () => ({}) }));

it("the actual desktop receiver denies every generated owner request from a contained peer", async () => {
  const db = openInMemoryStateDb();
  const store = new FederationStore(db);
  store.upsertPeer({ peer: { id: "outpost", label: "Fixture", role: "client", status: "connected",
    capabilities: [...FEDERATION_CAPABILITIES], pinnedPublicKeyPem: "fixture" }, updatedAt: 1 });
  store.setPeerRole("outpost", "contained", 2);
  const stop = new Error("Router constructed; no listener needed");
  vi.mocked(getDesktopSettingsService).mockReturnValue({ readFederationConfig: () => ({}),
    getOrCreateFederationNoiseStaticKeyPair: async () => { throw stop; },
  } as unknown as ReturnType<typeof getDesktopSettingsService>);
  const runtime = Object.assign(new DesktopFederationRuntime(), { localInstanceId: "desktop", store: () => store,
    durableTurnRequestService: () => ({}), subscribeLocalBackendEvents: () => {} }) as unknown as {
      router?: FederationRouter; filePushReceiver?: { dispose(): Promise<void> };
      startAfterLeaseAcquired(mode: string, config: object): Promise<void>;
    };
  try {
    await expect(runtime.startAfterLeaseAcquired("disabled", {})).rejects.toBe(stop);
    const router = runtime.router!;
    expect(router).toBeDefined();
    router.registerConnection({ peerId: "outpost", capabilities: [...FEDERATION_CAPABILITIES], sendEnvelope: () => {} });
    await fc.assert(fc.asyncProperty(fc.constantFrom(...Object.values(FEDERATION_BACKEND_METHODS), "file.push.begin", "pty.open", "service.open", "unmapped.futureMethod"), async (method) => {
      const request: FederationRequestEnvelope = { id: "request", kind: "request", method, params: { privatePayload: "must not be audited" },
        sourceInstanceId: "outpost", targetInstanceId: "desktop", protocolVersion: 1, createdAt: 1 };
      expect(await router.routeEnvelope({ envelope: request, sourcePeerId: "outpost" })).toMatchObject({ status: "rejected", code: "capability_denied" });
    }));
  } finally { await runtime.filePushReceiver?.dispose(); db.close(); }
});

it("live role changes preserve the authenticated session's relay support", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.constantFrom("full" as const, "contained" as const),
    fc.array(fc.constantFrom("full" as const, "contained" as const), { minLength: 1, maxLength: 20 }), async (relaySupported, initialRole, roles) => {
      const db = openInMemoryStateDb();
      const store = new FederationStore(db);
      store.upsertPeer({ peer: { id: "outpost", label: "Fixture", role: "client", status: "connected",
        capabilities: [...FEDERATION_CAPABILITIES], pinnedPublicKeyPem: "fixture" }, assignedRole: initialRole, updatedAt: 1 });
      const router = new FederationRouter({ localInstanceId: "desktop", peerRole: (id) => store.getPeer(id)?.permissionRole ?? "full" });
      const session = { peerId: "outpost", sessionId: "fixture-session", relaySupported, capabilities: FEDERATION_CAPABILITIES.filter((capability) =>
        capability !== "gateway_relay" || (relaySupported && initialRole === "full")), sendEnvelope: () => {}, close: () => {} };
      router.registerConnection({ peerId: "target", capabilities: [...FEDERATION_CAPABILITIES], sendEnvelope: () => {} });
      const runtime = Object.assign(new DesktopFederationRuntime(), { localInstanceId: "desktop", router, store: () => store,
        broadcastPeerDirectory: () => {}, sendEnvelopeToTarget: () => {}, publishPeerStatus: () => {},
        replayRelayedEventSubscriptions: () => {}, syncDesiredEventSubscriptions: () => {} }) as unknown as DesktopFederationRuntime;
      (runtime as unknown as { registerGatewayConnection(connection: FederationGatewayConnection): void }).registerGatewayConnection(session);
      try {
        // Force both transitions even when a generated command sequence omits one.
        for (const role of ["contained" as const, "full" as const, ...roles]) {
          await runtime.setPeerRole("outpost", role);
          const result = await router.routeEnvelope({ sourcePeerId: "outpost", envelope: { id: "relay", kind: "request",
            method: "backend.startThread", params: {}, sourceInstanceId: "outpost", targetInstanceId: "target", protocolVersion: 1, createdAt: 1 } });
          expect(result.status).toBe(role === "full" && relaySupported ? "relayed" : "rejected");
          expect(router.getConnection("outpost")?.capabilities.includes("gateway_relay")).toBe(role === "full" && relaySupported);
        }
      } finally { db.close(); }
    }));
});

it.each([
  ["contained", "contained", "contained"],
  ["contained", "contained", "full"],
  ["contained", "full", "full"],
  ["full", "full", "full"],
  ["full", "contained", "contained"],
] satisfies FederationPeerRole[][])("scoped upload receipts survive roles %s → %s → %s", async (initialRole, uploadRole, deliveryRole) => {
  const { tempDir } = createTempStateDb("contained-upload-");
  const db = openInMemoryStateDb();
  const store = new FederationStore(db);
  store.upsertPeer({ peer: { id: "outpost", label: "Fixture", role: "client", status: "connected",
    capabilities: [...FEDERATION_CAPABILITIES], pinnedPublicKeyPem: "fixture" }, updatedAt: 1 });
  store.setPeerRole("outpost", initialRole, 2);
  const stop = new Error("Router ready");
  vi.mocked(getDesktopSettingsService).mockReturnValue({
    readFederationConfig: () => ({ allowFilePush: true, filePushDirectory: tempDir }),
    getOrCreateFederationNoiseStaticKeyPair: async () => { throw stop; },
  } as unknown as ReturnType<typeof getDesktopSettingsService>);
  const instance = Object.assign(new DesktopFederationRuntime(), { localInstanceId: "desktop", store: () => store,
    durableTurnRequestService: () => ({}), subscribeLocalBackendEvents: () => {} }) as unknown as DesktopFederationRuntime;
  const runtime = instance as unknown as { router?: FederationRouter; filePushReceiver?: { dispose(): Promise<void> };
    startAfterLeaseAcquired(mode: string, config: object): Promise<void> };
  setFederationMessagingDestinationHandler(async (operation, caller, contained) => {
    expect(caller).toBe("outpost");
    expect(contained).toBe(store.getPeer("outpost")?.permissionRole === "contained");
    return { allowed: operation.kind === "authorize" && operation.context.threadId === "own-thread" };
  });
  try {
    await expect(runtime.startAfterLeaseAcquired("disabled", {})).rejects.toBe(stop);
    const router = runtime.router!;
    router.registerConnection({ peerId: "outpost", capabilities: [...FEDERATION_CAPABILITIES], sendEnvelope: () => {} });
    const call = async <T,>(method: string, params: unknown): Promise<T> => {
      const result = await router.routeEnvelope({ sourcePeerId: "outpost", envelope: { id: "upload", kind: "request", method, params,
        sourceInstanceId: "outpost", targetInstanceId: "desktop", protocolVersion: 1, createdAt: 1 } });
      if (result.status !== "handled" || !result.response) throw new Error(result.status === "rejected" ? result.code : "No response");
      return result.response.result as T;
    };
    const authorization = { kind: "authorize", context: { backend: "codex", threadId: "own-thread" },
      check: { backend: "codex", threadId: "own-thread", category: "messaging_context", tool: "send_messaging_file" } };
    const scoped = { request: async <T,>(request: { method: string; params?: unknown }): Promise<T> => {
      if (request.method === "file.push.finish") store.setPeerRole("outpost", uploadRole, 3);
      return await call<T>("messaging.destination.v2", { kind: "upload", authorization, method: request.method, input: request.params });
    } };
    const receipt = await pushFederationFile(scoped, Buffer.from("bound messaging reply"), "messaging-upload.bin");
    store.setPeerRole("outpost", deliveryRole, 4);
    await expect(instance.consumeMessagingFile("another-peer", receipt)).rejects.toThrow("receipt");
    expect(Buffer.from(await instance.consumeMessagingFile("outpost", receipt)).toString()).toBe("bound messaging reply");
    await expect(instance.consumeMessagingFile("outpost", receipt)).rejects.toThrow("receipt");
    store.setPeerRole("outpost", "full", 5);
    const general = await pushFederationFile({ request: async <T,>(request: { method: string; params?: unknown }): Promise<T> =>
      await call<T>(request.method, request.params) }, Buffer.from("general upload"), "general.bin");
    store.setPeerRole("outpost", "contained", 6);
    await expect(instance.consumeMessagingFile("outpost", general)).rejects.toThrow("receipt");
    store.setPeerRole("outpost", "full", 7);
    expect(Buffer.from(await instance.consumeMessagingFile("outpost", general)).toString()).toBe("general upload");
    store.setPeerRole("outpost", "contained", 8);
    await expect(call("file.push.begin", { name: "general-file.txt", sizeBytes: 1 })).rejects.toThrow("capability_denied");
    await expect(call<FilePushResult>("messaging.destination.v2", { kind: "upload", authorization: { ...authorization,
      context: { backend: "codex", threadId: "another-thread" } }, method: "file.push.begin",
      input: { name: "messaging-upload.bin", sizeBytes: 1 } })).rejects.toThrow("capability_denied");
  } finally { setFederationMessagingDestinationHandler(undefined); await runtime.filePushReceiver?.dispose(); db.close(); removeTempStateDbDir(tempDir); }
});
