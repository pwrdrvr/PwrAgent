import { pushFederationFile, type FilePushResult } from "../federation/federation-file-push";
import { setFederationMessagingDestinationHandler } from "../federation/federation-messaging-tools";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { expect, it, vi } from "vitest";
import fc from "fast-check";
import { FEDERATION_CAPABILITIES, type FederationRequestEnvelope } from "@pwragent/shared";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import { FederationStore } from "../storage/federation-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { FEDERATION_BACKEND_METHODS } from "@pwragent/federation/federation-backend-methods";
import type { FederationRouter } from "../federation/federation-router";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";

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

it("contained messaging uploads reuse the bounded file receiver and source-scoped receipts", async () => {
  const { tempDir } = createTempStateDb("contained-upload-");
  const db = openInMemoryStateDb();
  const store = new FederationStore(db);
  store.upsertPeer({ peer: { id: "outpost", label: "Fixture", role: "client", status: "connected",
    capabilities: [...FEDERATION_CAPABILITIES], pinnedPublicKeyPem: "fixture" }, updatedAt: 1 });
  store.setPeerRole("outpost", "contained", 2);
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
    expect(contained).toBe(true);
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
    const scoped = { request: async <T,>(request: { method: string; params?: unknown }): Promise<T> =>
      await call<T>("messaging.destination.v2", { kind: "upload", authorization, method: request.method, input: request.params }) };
    const receipt = await pushFederationFile(scoped, Buffer.from("bound messaging reply"), "messaging-upload.bin");
    expect(Buffer.from(await instance.consumeMessagingFile("outpost", receipt)).toString()).toBe("bound messaging reply");
    await expect(instance.consumeMessagingFile("outpost", receipt)).rejects.toThrow("receipt");
    await expect(call("file.push.begin", { name: "general-file.txt", sizeBytes: 1 })).rejects.toThrow("capability_denied");
    await expect(call<FilePushResult>("messaging.destination.v2", { kind: "upload", authorization: { ...authorization,
      context: { backend: "codex", threadId: "another-thread" } }, method: "file.push.begin",
      input: { name: "messaging-upload.bin", sizeBytes: 1 } })).rejects.toThrow("capability_denied");
  } finally { setFederationMessagingDestinationHandler(undefined); await runtime.filePushReceiver?.dispose(); db.close(); removeTempStateDbDir(tempDir); }
});
