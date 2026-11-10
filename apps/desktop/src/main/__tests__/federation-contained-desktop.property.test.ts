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
