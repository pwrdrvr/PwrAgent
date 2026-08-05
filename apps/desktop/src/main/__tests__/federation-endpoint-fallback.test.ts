import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopFederationRuntime } from "../federation/federation-runtime";

const metaStore = vi.hoisted(() => new Map<string, string>());

vi.mock("../state/app-state", () => ({
  getAppStateDb: () => ({
    getMeta: (key: string) => metaStore.get(key) ?? "",
    setMeta: (key: string, value: string) => void metaStore.set(key, value),
  }),
  isAppStateInitialized: () => true,
}));

const LAN = "ws://192.168.1.20:47830";
const TAILSCALE = "wss://studio.example.ts.net/pwragent-federation";
const CLOUDFLARE = "wss://federation.example.com";
const LAST_ENDPOINT_KEY = "federation_gateway_last_endpoint";

type FallbackHarness = {
  stopping: boolean;
  configuredEndpoints: string[];
  endpointStatuses: Map<
    string,
    { state: string; lastError?: string; lastConnectedAt?: number }
  >;
  connectClient: (gatewayUrl: string) => Promise<void>;
  connectToGateway: () => Promise<void>;
  markEndpointConnected: (gatewayUrl: string) => void;
};

function createHarness(endpoints: string[]): FallbackHarness {
  const runtime = new DesktopFederationRuntime() as unknown as FallbackHarness;
  runtime.stopping = false;
  runtime.configuredEndpoints = endpoints;
  return runtime;
}

describe("federation endpoint fallback", () => {
  beforeEach(() => {
    metaStore.clear();
  });

  it("walks endpoints in configured order and stops at the first success", async () => {
    const runtime = createHarness([LAN, TAILSCALE, CLOUDFLARE]);
    const attempts: string[] = [];
    runtime.connectClient = async (gatewayUrl) => {
      attempts.push(gatewayUrl);
      if (gatewayUrl !== CLOUDFLARE) {
        throw new Error(`connect ECONNREFUSED ${gatewayUrl}`);
      }
    };

    await runtime.connectToGateway();

    expect(attempts).toEqual([LAN, TAILSCALE, CLOUDFLARE]);
    expect(runtime.endpointStatuses.get(LAN)).toMatchObject({
      state: "failed",
    });
    expect(runtime.endpointStatuses.get(LAN)?.lastError).toBeTruthy();
    expect(runtime.endpointStatuses.get(TAILSCALE)).toMatchObject({
      state: "failed",
    });
  });

  it("tries the last endpoint that worked first", async () => {
    metaStore.set(LAST_ENDPOINT_KEY, CLOUDFLARE);
    const runtime = createHarness([LAN, TAILSCALE, CLOUDFLARE]);
    const attempts: string[] = [];
    runtime.connectClient = async (gatewayUrl) => {
      attempts.push(gatewayUrl);
    };

    await runtime.connectToGateway();

    expect(attempts).toEqual([CLOUDFLARE]);
  });

  it("ignores a remembered endpoint that is no longer configured", async () => {
    metaStore.set(LAST_ENDPOINT_KEY, "wss://removed.example.com");
    const runtime = createHarness([LAN, TAILSCALE]);
    const attempts: string[] = [];
    runtime.connectClient = async (gatewayUrl) => {
      attempts.push(gatewayUrl);
    };

    await runtime.connectToGateway();

    expect(attempts).toEqual([LAN]);
  });

  it("throws the final endpoint error after a fully failed cycle", async () => {
    const runtime = createHarness([LAN, TAILSCALE]);
    runtime.connectClient = async (gatewayUrl) => {
      throw new Error(`connect ECONNREFUSED ${gatewayUrl}`);
    };

    await expect(runtime.connectToGateway()).rejects.toThrow(
      `connect ECONNREFUSED ${TAILSCALE}`,
    );
  });

  it("records the last-good endpoint only from an established connection", () => {
    const runtime = createHarness([LAN, TAILSCALE]);
    expect(metaStore.get(LAST_ENDPOINT_KEY)).toBeUndefined();

    runtime.markEndpointConnected(TAILSCALE);

    expect(metaStore.get(LAST_ENDPOINT_KEY)).toBe(TAILSCALE);
    expect(runtime.endpointStatuses.get(TAILSCALE)).toMatchObject({
      state: "active",
    });
    expect(
      runtime.endpointStatuses.get(TAILSCALE)?.lastConnectedAt,
    ).toBeTypeOf("number");
  });
});
