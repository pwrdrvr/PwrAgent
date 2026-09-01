// "Forget gateway pairing" must clear the multi-path endpoint state too.
// Leaving `gateway_endpoints` (or the last-good endpoint memory) behind would
// keep a dual-mode instance dialing the gateway it was just told to forget,
// with no pinned keys left to satisfy it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettingsConfigPatch } from "@pwragent/shared";
import { DesktopFederationRuntime } from "../federation/federation-runtime";

const metaStore = vi.hoisted(() => new Map<string, string>());
const configPatches = vi.hoisted(() => [] as DesktopSettingsConfigPatch[]);
const clearedSecrets = vi.hoisted(() => [] as string[]);
const federationMode = vi.hoisted(() => ({ value: "dual" as string }));
const removeRemoteThreadPinsForInstance = vi.hoisted(() =>
  vi.fn(async (_params: { instanceId: string }) => 2),
);
const tombstoneRemoteThreadPinsForInstance = vi.hoisted(() =>
  vi.fn(async (_params: { instanceId: string; revokedAt?: number }) => 2),
);
const restoreRemoteThreadPinsForInstance = vi.hoisted(() =>
  vi.fn(async (_params: { instanceId: string }) => 0),
);
const countRemoteThreadPinsByInstance = vi.hoisted(() =>
  vi.fn(
    async (): Promise<Map<string, { live: number; revoked: number }>> =>
      new Map([["gateway_one", { live: 2, revoked: 0 }]]),
  ),
);
const publishLocalEvent = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../state/app-state", () => ({
  getAppStateDb: () => ({
    getMeta: (key: string) => metaStore.get(key) ?? "",
    setMeta: (key: string, value: string) => void metaStore.set(key, value),
  }),
  isAppStateInitialized: () => true,
}));

vi.mock("../app-server/desktop-overlay-store", () => ({
  getDesktopOverlayStore: () => ({
    removeRemoteThreadPinsForInstance,
    tombstoneRemoteThreadPinsForInstance,
    restoreRemoteThreadPinsForInstance,
    countRemoteThreadPinsByInstance,
  }),
}));

vi.mock("../app-server/backend-registry", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDesktopBackendRegistry: () => ({
    publishLocalEvent,
  }),
}));

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: () => ({
    readFederationConfig: () => ({ mode: federationMode.value }),
    writeConfigPatchTargeted: async (patch: DesktopSettingsConfigPatch) => {
      configPatches.push(patch);
    },
    clearSecret: async (name: string) => {
      clearedSecrets.push(name);
      return true;
    },
  }),
}));

const GATEWAY_ID_KEY = "federation_gateway_instance_id";
const LAST_ENDPOINT_KEY = "federation_gateway_last_endpoint";

type ResetHarness = {
  restart: () => Promise<void>;
  resetEnrollment: (request?: {
    pinDisposition?: "forget" | "remember";
  }) => Promise<{ cleared: boolean }>;
};

function createHarness(): ResetHarness {
  const runtime = new DesktopFederationRuntime() as unknown as ResetHarness;
  // The real restart would boot the whole runtime; the pairing teardown is
  // what this test is about.
  runtime.restart = async () => undefined;
  return runtime;
}

describe("federation resetEnrollment", () => {
  beforeEach(() => {
    metaStore.clear();
    configPatches.length = 0;
    clearedSecrets.length = 0;
    federationMode.value = "dual";
    removeRemoteThreadPinsForInstance.mockClear();
    tombstoneRemoteThreadPinsForInstance.mockClear();
    restoreRemoteThreadPinsForInstance.mockClear();
    countRemoteThreadPinsByInstance.mockClear();
    countRemoteThreadPinsByInstance.mockResolvedValue(
      new Map([["gateway_one", { live: 2, revoked: 0 }]]),
    );
    publishLocalEvent.mockClear();
    metaStore.set(GATEWAY_ID_KEY, "gateway_one");
    metaStore.set("federation_gateway_public_key_pem", "pem");
    metaStore.set("federation_gateway_noise_public_key", "noise");
    metaStore.set(LAST_ENDPOINT_KEY, "wss://federation.example.com");
  });

  it("clears the endpoint list and the last-good endpoint memory", async () => {
    const result = await createHarness().resetEnrollment();

    expect(result).toEqual({ cleared: true });
    expect(metaStore.get(GATEWAY_ID_KEY)).toBe("");
    expect(metaStore.get(LAST_ENDPOINT_KEY)).toBe("");
    expect(configPatches).toHaveLength(1);
    expect(configPatches[0].federation?.gatewayUrl).toBe("");
    expect(configPatches[0].federation?.gatewayEndpoints).toEqual([]);
  });

  it("keeps a dual instance listening while dropping its client pairing", async () => {
    await createHarness().resetEnrollment();

    expect(configPatches[0].federation?.mode).toBeUndefined();
    // Gateway/dual key material stays: enrolled clients pinned it.
    expect(clearedSecrets).toEqual([]);
  });

  it("disables a pure client and drops its own key material", async () => {
    federationMode.value = "client";

    await createHarness().resetEnrollment();

    expect(configPatches[0].federation?.mode).toBe("disabled");
    expect(configPatches[0].federation?.gatewayEndpoints).toEqual([]);
    expect(clearedSecrets).toEqual([
      "federationInstancePrivateKey",
      "federationNoiseStaticPrivateKey",
    ]);
  });

  it("reports nothing cleared when no pairing existed", async () => {
    metaStore.set(GATEWAY_ID_KEY, "");
    countRemoteThreadPinsByInstance.mockResolvedValue(new Map());

    expect(await createHarness().resetEnrollment()).toEqual({ cleared: false });
    expect(tombstoneRemoteThreadPinsForInstance).not.toHaveBeenCalled();
    expect(removeRemoteThreadPinsForInstance).not.toHaveBeenCalled();
  });

  it("tombstones the forgotten federation's pins and pokes the renderer", async () => {
    await createHarness().resetEnrollment();

    // Default disposition is non-destructive: the rows stop rendering but
    // survive a later re-enrollment.
    expect(tombstoneRemoteThreadPinsForInstance).toHaveBeenCalledWith({
      instanceId: "gateway_one",
      revokedAt: undefined,
    });
    expect(removeRemoteThreadPinsForInstance).not.toHaveBeenCalled();
    expect(publishLocalEvent).toHaveBeenCalledWith({
      backend: "codex",
      notification: {
        method: "navigation/remoteThreadPins/changed",
        params: { instanceId: "gateway_one", pinned: false },
      },
    });
  });

  it("covers every instance reachable only through the forgotten gateway", async () => {
    // The gap in the first cut: pins for relayed peers, not just the
    // gateway's own threads, are equally unreachable afterwards.
    countRemoteThreadPinsByInstance.mockResolvedValue(
      new Map([
        ["gateway_one", { live: 2, revoked: 0 }],
        ["relayed_peer", { live: 1, revoked: 0 }],
      ]),
    );

    await createHarness().resetEnrollment();

    expect(
      tombstoneRemoteThreadPinsForInstance.mock.calls.map(
        (call) => call[0].instanceId,
      ),
    ).toEqual(["gateway_one", "relayed_peer"]);
  });

  it("hard-deletes only when the operator explicitly forgets", async () => {
    await createHarness().resetEnrollment({ pinDisposition: "forget" });

    expect(removeRemoteThreadPinsForInstance).toHaveBeenCalledWith({
      instanceId: "gateway_one",
    });
    expect(tombstoneRemoteThreadPinsForInstance).not.toHaveBeenCalled();
  });

  it("skips the pins-changed event when nothing was pinned", async () => {
    tombstoneRemoteThreadPinsForInstance.mockResolvedValueOnce(0);

    await createHarness().resetEnrollment();

    expect(publishLocalEvent).not.toHaveBeenCalled();
  });
});

describe("federation remote pin restore", () => {
  type StatusHarness = {
    publishPeerStatus: (instanceId: string, status: string) => void;
  };

  beforeEach(() => {
    restoreRemoteThreadPinsForInstance.mockClear();
    restoreRemoteThreadPinsForInstance.mockResolvedValue(3);
    publishLocalEvent.mockClear();
  });

  it("restores tombstoned pins when the instance connects again", async () => {
    const runtime = new DesktopFederationRuntime() as unknown as StatusHarness;

    runtime.publishPeerStatus("client_one", "connected");
    await vi.waitFor(() =>
      expect(restoreRemoteThreadPinsForInstance).toHaveBeenCalledWith({
        instanceId: "client_one",
      }),
    );
    await vi.waitFor(() =>
      expect(publishLocalEvent).toHaveBeenCalledWith({
        backend: "codex",
        notification: {
          method: "navigation/remoteThreadPins/changed",
          params: { instanceId: "client_one", pinned: true },
        },
      }),
    );
  });

  it("does not restore on a non-connected transition", async () => {
    const runtime = new DesktopFederationRuntime() as unknown as StatusHarness;

    runtime.publishPeerStatus("client_one", "disconnected");
    runtime.publishPeerStatus("client_one", "degraded");

    expect(restoreRemoteThreadPinsForInstance).not.toHaveBeenCalled();
  });

  it("restores once per connect transition, not per repeat publish", async () => {
    const runtime = new DesktopFederationRuntime() as unknown as StatusHarness;

    runtime.publishPeerStatus("client_one", "connected");
    runtime.publishPeerStatus("client_one", "connected");
    await vi.waitFor(() =>
      expect(restoreRemoteThreadPinsForInstance).toHaveBeenCalledTimes(1),
    );
  });
});

describe("federation remote pin impact", () => {
  type ImpactHarness = {
    readRemoteThreadPinImpact: (request: {
      scope: { kind: "peer"; peerId: string } | { kind: "enrollment" };
    }) => Promise<{
      pinnedThreadCount: number;
      tombstonedThreadCount: number;
      instanceLabels: string[];
    }>;
  };

  beforeEach(() => {
    countRemoteThreadPinsByInstance.mockClear();
    countRemoteThreadPinsByInstance.mockResolvedValue(
      new Map([["client_one", { live: 2, revoked: 0 }]]),
    );
  });

  it("reports one peer's counts, ignoring other pinned instances", async () => {
    countRemoteThreadPinsByInstance.mockResolvedValue(
      new Map([
        ["client_one", { live: 2, revoked: 0 }],
        // A second pinned instance must not leak into a peer-scoped read.
        ["other_peer", { live: 9, revoked: 9 }],
      ]),
    );
    const runtime = new DesktopFederationRuntime() as unknown as ImpactHarness;

    expect(
      await runtime.readRemoteThreadPinImpact({
        scope: { kind: "peer", peerId: "client_one" },
      }),
    ).toEqual({
      pinnedThreadCount: 2,
      tombstonedThreadCount: 0,
      instanceLabels: ["client_one"],
    });
  });

  it("sums every instance a gateway forget would affect", async () => {
    countRemoteThreadPinsByInstance.mockResolvedValue(
      new Map([
        ["gateway_one", { live: 1, revoked: 2 }],
        ["relayed_peer", { live: 1, revoked: 2 }],
      ]),
    );

    const runtime = new DesktopFederationRuntime() as unknown as ImpactHarness;

    expect(
      await runtime.readRemoteThreadPinImpact({ scope: { kind: "enrollment" } }),
    ).toEqual({
      pinnedThreadCount: 2,
      tombstonedThreadCount: 4,
      instanceLabels: ["gateway_one", "relayed_peer"],
    });
  });

  it("reports zero for an instance with nothing pinned", async () => {
    // The renderer keys the whole keep-or-forget prompt off this: no pins
    // means no question worth asking.
    countRemoteThreadPinsByInstance.mockResolvedValue(new Map());

    const runtime = new DesktopFederationRuntime() as unknown as ImpactHarness;

    expect(
      await runtime.readRemoteThreadPinImpact({
        scope: { kind: "peer", peerId: "never_pinned" },
      }),
    ).toEqual({
      pinnedThreadCount: 0,
      tombstonedThreadCount: 0,
      instanceLabels: [],
    });
  });
});

describe("federation revokePeer — remote pin disposition", () => {
  beforeEach(() => {
    removeRemoteThreadPinsForInstance.mockClear();
    tombstoneRemoteThreadPinsForInstance.mockClear();
    publishLocalEvent.mockClear();
  });

  type RevokeHarness = {
    store: () => unknown;
    revokePeer: (
      peerId: string,
      request?: { pinDisposition?: "forget" | "remember" },
    ) => Promise<{ status: string }>;
  };

  function createRevokeHarness(): RevokeHarness {
    const runtime = new DesktopFederationRuntime() as unknown as RevokeHarness;
    runtime.store = () => ({
      getPeer: (peerId: string) => ({
        id: peerId,
        label: "Old laptop",
        role: "client",
        status: "connected",
        capabilities: [],
        canRevoke: true,
      }),
      revokePeer: () => undefined,
    });
    return runtime;
  }

  it("tombstones the revoked instance's pins by default", async () => {
    const peer = await createRevokeHarness().revokePeer("client_one");

    expect(peer.status).toBe("revoked");
    expect(tombstoneRemoteThreadPinsForInstance).toHaveBeenCalledWith({
      instanceId: "client_one",
      revokedAt: expect.any(Number),
    });
    expect(removeRemoteThreadPinsForInstance).not.toHaveBeenCalled();
    expect(publishLocalEvent).toHaveBeenCalledWith({
      backend: "codex",
      notification: {
        method: "navigation/remoteThreadPins/changed",
        params: { instanceId: "client_one", pinned: false },
      },
    });
  });

  it("hard-deletes only on an explicit forget", async () => {
    await createRevokeHarness().revokePeer("client_one", {
      pinDisposition: "forget",
    });

    expect(removeRemoteThreadPinsForInstance).toHaveBeenCalledWith({
      instanceId: "client_one",
    });
    expect(tombstoneRemoteThreadPinsForInstance).not.toHaveBeenCalled();
  });

  it("still revokes when pin bookkeeping fails", async () => {
    tombstoneRemoteThreadPinsForInstance.mockRejectedValueOnce(
      new Error("db locked"),
    );

    const peer = await createRevokeHarness().revokePeer("client_one");

    expect(peer.status).toBe("revoked");
    expect(publishLocalEvent).not.toHaveBeenCalled();
  });
});
