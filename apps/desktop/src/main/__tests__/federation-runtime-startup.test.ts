import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopFederationMode,
} from "@pwragent/shared";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import type { FederationRuntimeConfig } from "../federation/federation-runtime-config";

// vi.hoisted so the mock factories (which run when the statically imported
// federation-runtime module first resolves them) can reach these fns.
const mocks = vi.hoisted(() => ({
  readFederationConfig: vi.fn(),
  getNoiseKeyPair: vi.fn(),
  getIdentityKeyPair: vi.fn(),
  gatewayServerStart: vi.fn(),
  gatewayServerStop: vi.fn(),
  stateDbGetMeta: vi.fn(() => "pwr_test_instance"),
  stateDbSetMeta: vi.fn(),
  registryOnEvent: vi.fn(() => () => {}),
}));

const GatewayServerCtorMock = vi.hoisted(() =>
  // A `function` (not an arrow) so the mock is constructable with `new`;
  // returning an object overrides the fresh `this`.
  vi.fn(function () {
    return {
      start: mocks.gatewayServerStart,
      stop: mocks.gatewayServerStop,
    };
  }),
);

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: vi.fn(() => ({
    readFederationConfig: mocks.readFederationConfig,
    getOrCreateFederationNoiseStaticKeyPair: mocks.getNoiseKeyPair,
    getOrCreateFederationIdentityKeyPair: mocks.getIdentityKeyPair,
  })),
}));

vi.mock("../federation/federation-host-info", () => ({
  collectFederationHostInfo: vi.fn(async () => undefined),
}));

vi.mock("../state/app-state", () => ({
  isAppStateInitialized: vi.fn(() => false),
  getAppStateDb: vi.fn(() => ({
    getMeta: mocks.stateDbGetMeta,
    setMeta: mocks.stateDbSetMeta,
  })),
}));

vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: vi.fn(() => ({
    onEvent: mocks.registryOnEvent,
    listThreads: vi.fn(async () => []),
  })),
}));

vi.mock("../federation/federation-noise", () => ({
  noiseKeyPairFromRawPrivate: vi.fn(() => ({})),
}));

vi.mock("../federation/federation-transport", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../federation/federation-transport")>();
  return {
    ...actual,
    FederationGatewayWebSocketServer:
      GatewayServerCtorMock as unknown as typeof actual.FederationGatewayWebSocketServer,
  };
});

type StartupHarness = {
  startAfterLeaseAcquired(
    mode: DesktopFederationMode,
    config: FederationRuntimeConfig,
  ): Promise<void>;
  stop(): Promise<void>;
  server?: unknown;
  listenUrl?: string;
};

const fakeSettings = {
  advertisedEndpoints: [],
  cloudflareAccessServiceAuthEnabled: false,
  cloudflareEndpoint: "",
  cloudflareMtlsEnabled: false,
  gatewayEndpoints: [],
  instanceLabel: "",
  instanceNotes: "",
  listenHost: "127.0.0.1",
  listenPort: 4321,
  mode: "gateway",
  publicUrl: "",
} as const satisfies FederationRuntimeConfig;

const NOISE_KEY = {
  privateKeyBase64: Buffer.alloc(32, 1).toString("base64"),
};
const IDENTITY_KEY = { privateKeyPem: "p", publicKeyPem: "P" };

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.readFederationConfig.mockReturnValue(fakeSettings);
  mocks.getNoiseKeyPair.mockReset();
  mocks.getIdentityKeyPair.mockReset();
  mocks.gatewayServerStart.mockReset();
  mocks.gatewayServerStop.mockReset();
  mocks.gatewayServerStop.mockResolvedValue(undefined);
  GatewayServerCtorMock.mockClear();
});

describe("DesktopFederationRuntime startup lease fence", () => {
  it("publishes the listener when startup completes uninterrupted", async () => {
    mocks.getNoiseKeyPair.mockResolvedValue(NOISE_KEY);
    mocks.getIdentityKeyPair.mockResolvedValue(IDENTITY_KEY);
    mocks.gatewayServerStart.mockResolvedValue({ url: "ws://127.0.0.1:4321" });
    const runtime =
      new DesktopFederationRuntime() as unknown as StartupHarness;

    await runtime.startAfterLeaseAcquired("gateway", fakeSettings);

    expect(runtime.listenUrl).toBe("ws://127.0.0.1:4321");
    expect(runtime.server).toBeDefined();
  });

  it("creates no listener when the lease is lost during key material reads", async () => {
    const noise = deferred<typeof NOISE_KEY>();
    mocks.getNoiseKeyPair.mockReturnValue(noise.promise);
    mocks.getIdentityKeyPair.mockResolvedValue(IDENTITY_KEY);
    const runtime =
      new DesktopFederationRuntime() as unknown as StartupHarness;

    const startPromise = runtime.startAfterLeaseAcquired(
      "gateway",
      fakeSettings,
    );
    // Startup is parked on the key material read; a lease-loss heartbeat
    // stop must abort it before any socket is constructed.
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.stop();
    noise.resolve(NOISE_KEY);
    await startPromise;

    expect(GatewayServerCtorMock).not.toHaveBeenCalled();
    expect(mocks.gatewayServerStart).not.toHaveBeenCalled();
    expect(runtime.listenUrl).toBeUndefined();
    expect(runtime.server).toBeUndefined();
  });

  it("tears down a listener that finishes binding after the lease was lost", async () => {
    mocks.getNoiseKeyPair.mockResolvedValue(NOISE_KEY);
    mocks.getIdentityKeyPair.mockResolvedValue(IDENTITY_KEY);
    const serverStart = deferred<{ url: string }>();
    mocks.gatewayServerStart.mockReturnValue(serverStart.promise);
    const runtime =
      new DesktopFederationRuntime() as unknown as StartupHarness;

    const startPromise = runtime.startAfterLeaseAcquired(
      "gateway",
      fakeSettings,
    );
    await vi.waitFor(() =>
      expect(mocks.gatewayServerStart).toHaveBeenCalledTimes(1)
    );
    // The lease is lost while the listener is still binding; stop() tears
    // the runtime down, then the bind completes on the stale continuation.
    await runtime.stop();
    serverStart.resolve({ url: "ws://127.0.0.1:4321" });
    await startPromise;

    expect(runtime.listenUrl).toBeUndefined();
    expect(runtime.server).toBeUndefined();
    expect(mocks.gatewayServerStop).toHaveBeenCalled();
  });
});


describe("DesktopFederationRuntime session toggle", () => {
  it("keeps a stopped instance off across restarts without changing a sibling or the saved mode", async () => {
    const runtime = new DesktopFederationRuntime();
    const sibling = new DesktopFederationRuntime();
    const start = vi.spyOn(runtime as unknown as StartupHarness, "startAfterLeaseAcquired").mockResolvedValue(undefined);
    const siblingStart = vi.spyOn(sibling as unknown as StartupHarness, "startAfterLeaseAcquired").mockResolvedValue(undefined);
    await runtime.setEnabledForSession(false);
    await runtime.restart();
    await sibling.restart();
    expect(start).not.toHaveBeenCalled();
    expect(siblingStart).toHaveBeenCalledWith("gateway", expect.objectContaining({ mode: "gateway" }));
    expect(fakeSettings.mode).toBe("gateway");
    mocks.readFederationConfig.mockReturnValue({ ...fakeSettings, mode: "dual" });
    await runtime.restart();
    expect(start).not.toHaveBeenCalled();
    await runtime.setEnabledForSession(true);
    expect(start).toHaveBeenCalledWith("dual", expect.objectContaining({ mode: "dual" }));
    expect(siblingStart).toHaveBeenCalledTimes(1);
  });

  it.each([
    { gatewayEndpoints: [], mode: "gateway" },
    { gatewayEndpoints: ["wss://fixture.invalid"], mode: "client" },
  ])("enables a saved-disabled profile as $mode only for this instance", async ({ gatewayEndpoints, mode }) => {
    const saved = { ...fakeSettings, mode: "disabled", gatewayEndpoints };
    mocks.readFederationConfig.mockReturnValue(saved);
    const runtime = new DesktopFederationRuntime();
    const start = vi.spyOn(runtime as unknown as StartupHarness, "startAfterLeaseAcquired").mockResolvedValue(undefined);
    await runtime.setEnabledForSession(true);
    await runtime.restart();
    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenLastCalledWith(mode, expect.objectContaining({ mode }));
    expect(saved.mode).toBe("disabled");
    vi.spyOn(runtime, "health").mockResolvedValue({ enabled: true, role: "gateway", status: "connected", peers: [] });
    expect((await runtime.activity({ includeHistory: false })).configuredMode).toBe("disabled");
    const fresh = new DesktopFederationRuntime();
    const freshStart = vi.spyOn(fresh as unknown as StartupHarness, "startAfterLeaseAcquired").mockResolvedValue(undefined);
    await fresh.restart();
    expect(freshStart).not.toHaveBeenCalled();
  });

  it("applies a toggle after an in-flight restart finishes", async () => {
    const runtime = new DesktopFederationRuntime();
    const pendingStart = deferred<void>();
    const start = vi.spyOn(runtime as unknown as StartupHarness, "startAfterLeaseAcquired")
      .mockImplementation(() => pendingStart.promise);
    const restarting = runtime.restart();
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const stopping = runtime.setEnabledForSession(false);
    pendingStart.resolve();
    await Promise.all([restarting, stopping]);
    await runtime.restart();
    expect(start).toHaveBeenCalledTimes(1);
  });
});
