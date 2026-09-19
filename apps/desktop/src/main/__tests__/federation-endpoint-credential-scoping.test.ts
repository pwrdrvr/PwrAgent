import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateFederationNoiseStaticKeyPair } from "../federation/federation-noise";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import { CloudflareSignInRequiredError } from "../federation/cloudflare-access-oauth";
import type { FederationClientWebSocketClient } from "../federation/federation-transport";

const metaStore = vi.hoisted(() => new Map<string, string>());
const clientClose = vi.hoisted(() => vi.fn());
const connectCalls = vi.hoisted(
  () =>
    [] as Array<{
      url: string;
      headers?: Record<string, string>;
      clientCertificate?: string;
      clientPrivateKey?: string;
      createSocket?: () => unknown;
    }>,
);

vi.mock("../state/app-state", () => ({
  getAppStateDb: () => ({
    getMeta: (key: string) => metaStore.get(key) ?? "",
    setMeta: (key: string, value: string) => void metaStore.set(key, value),
  }),
  isAppStateInitialized: () => true,
}));

vi.mock("../federation/federation-transport", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connectFederationClient: async (params: (typeof connectCalls)[number]): Promise<FederationClientWebSocketClient> => {
    connectCalls.push(params);
    return {
      sessionId: "federation-session:test",
      capabilities: [],
      startReceiving: () => undefined,
      sendEnvelope: () => undefined,
      close: clientClose,
    };
  },
}));

const cloudflareEndpoint = vi.hoisted(() => ({ value: "" }));
const signIn = vi.hoisted(() => ({
  enabled: false,
  accessToken: vi.fn(async (_endpoint: string): Promise<string> => "oauth:access-token"),
  // Due now: the refresh timer then waits its one-minute floor.
  refreshDueAt: vi.fn(async (_endpoint: string): Promise<number | undefined> => Date.now()),
}));

vi.mock("../federation/cloudflare-access-sign-in", () => ({
  getCloudflareAccessSignIn: () => ({
    accessToken: signIn.accessToken,
    refreshDueAt: signIn.refreshDueAt,
    invalidateAccessToken: async () => undefined,
  }),
}));

vi.mock("../settings/desktop-settings-singleton", () => {
  const noise = generateFederationNoiseStaticKeyPair();
  return {
    getDesktopSettingsService: () => ({
      readFederationConfig: () => ({
        cloudflareEndpoint: cloudflareEndpoint.value,
        cloudflareMtlsEnabled: true,
        cloudflareAccessServiceAuthEnabled: true,
        cloudflareAccessOAuthEnabled: signIn.enabled,
      }),
      resolveFederationCloudflareCredentials: async () => ({
        clientCertificate: "PEM-CERT",
        clientPrivateKey: "PEM-KEY",
        accessClientId: "access-id",
        accessClientSecret: "access-secret",
      }),
      getOrCreateFederationIdentityKeyPair: async () => ({
        privateKeyPem: "identity-private",
        publicKeyPem: "identity-public",
      }),
      getOrCreateFederationNoiseStaticKeyPair: async () => noise,
    }),
  };
});

type CredentialHarness = {
  stopping: boolean;
  configuredEndpoints: string[];
  connectClient: (gatewayUrl: string) => Promise<void>;
  store: () => { appendAudit: (entry: unknown) => void };
};

function createHarness(configuredEndpoints: string[] = []): CredentialHarness {
  const runtime = new DesktopFederationRuntime() as unknown as CredentialHarness;
  runtime.stopping = false;
  runtime.configuredEndpoints = configuredEndpoints;
  runtime.store = () => ({ appendAudit: () => undefined });
  return runtime;
}

describe("federation endpoint credential scoping", () => {
  beforeEach(() => {
    connectCalls.length = 0;
    cloudflareEndpoint.value = "";
    signIn.enabled = false;
    signIn.accessToken.mockReset();
    signIn.accessToken.mockImplementation(async () => "oauth:access-token");
    clientClose.mockReset();
    metaStore.clear();
    metaStore.set("federation_instance_id", "pwr_client-under-test");
    metaStore.set("federation_gateway_instance_id", "gateway_one");
    metaStore.set("federation_gateway_public_key_pem", "gateway-public-pem");
    metaStore.set(
      "federation_gateway_noise_public_key",
      generateFederationNoiseStaticKeyPair().publicKeyBase64,
    );
  });

  it("attaches Cloudflare credentials to the designated endpoint", async () => {
    cloudflareEndpoint.value = "wss://federation.example.com";
    await createHarness([
      "ws://192.168.1.20:47830",
      "wss://federation.example.com",
    ]).connectClient("wss://federation.example.com");

    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].url).toBe("wss://federation.example.com");
    expect(connectCalls[0].headers).toMatchObject({
      "CF-Access-Client-Id": "access-id",
      "CF-Access-Client-Secret": "access-secret",
    });
    expect(connectCalls[0].clientCertificate).toBe("PEM-CERT");
    expect(connectCalls[0].clientPrivateKey).toBe("PEM-KEY");
    expect(connectCalls[0].createSocket).toBeUndefined();
  });

  // The core of the fix: these credentials ride the WebSocket upgrade, before
  // the Noise handshake pins anything, so a different wss:// host in the
  // fallback list must never receive them.
  it("never sends Cloudflare credentials to a different wss:// host", async () => {
    cloudflareEndpoint.value = "wss://federation.example.com";
    await createHarness([
      "wss://attacker.example",
      "wss://federation.example.com",
    ]).connectClient("wss://attacker.example");

    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].headers).toBeUndefined();
    expect(connectCalls[0].clientCertificate).toBeUndefined();
    expect(connectCalls[0].clientPrivateKey).toBeUndefined();
  });

  it("presents a Cloudflare Access sign-in only to the designated endpoint", async () => {
    signIn.enabled = true;
    cloudflareEndpoint.value = "wss://federation.example.com";
    const harness = createHarness([
      "wss://attacker.example",
      "wss://federation.example.com",
    ]);
    await harness.connectClient("wss://federation.example.com");
    expect(connectCalls[0].headers).toMatchObject({ Authorization: "Bearer oauth:access-token" });
    expect(signIn.accessToken).toHaveBeenCalledWith("wss://federation.example.com");

    // A bearer token is as good as the person's sign-in for its lifetime; a
    // fallback host must not even cause one to be minted.
    signIn.accessToken.mockClear();
    await harness.connectClient("wss://attacker.example");
    expect(connectCalls[1].headers).toBeUndefined();
    expect(signIn.accessToken).not.toHaveBeenCalled();
  });

  it("fails before dialing when the Cloudflare sign-in has lapsed", async () => {
    signIn.enabled = true;
    cloudflareEndpoint.value = "wss://federation.example.com";
    signIn.accessToken.mockRejectedValue(new CloudflareSignInRequiredError());
    await expect(
      createHarness(["wss://federation.example.com"]).connectClient("wss://federation.example.com"),
    ).rejects.toThrow("Cloudflare Access sign-in is required");
    expect(connectCalls).toHaveLength(0);
  });

  it("walks on to a fallback endpoint when only the Cloudflare sign-in has lapsed", async () => {
    signIn.enabled = true;
    cloudflareEndpoint.value = "wss://federation.example.com";
    signIn.accessToken.mockRejectedValue(new CloudflareSignInRequiredError());
    const harness = createHarness([
      "wss://federation.example.com",
      "ws://192.168.1.20:47830",
    ]) as CredentialHarness & { walkGatewayEndpoints: () => Promise<void> };
    await harness.walkGatewayEndpoints();
    // The Cloudflare path was tried first and refused locally; the LAN path
    // still connected. A lapsed sign-in belongs to one endpoint, not the pairing.
    expect(signIn.accessToken).toHaveBeenCalledTimes(1);
    expect(connectCalls.map((call) => call.url)).toEqual(["ws://192.168.1.20:47830"]);
  });

  it("reports the lapsed sign-in when no endpoint connects", async () => {
    signIn.enabled = true;
    cloudflareEndpoint.value = "wss://federation.example.com";
    signIn.accessToken.mockRejectedValue(new CloudflareSignInRequiredError());
    const harness = createHarness([
      "wss://federation.example.com",
    ]) as CredentialHarness & { walkGatewayEndpoints: () => Promise<void> };
    // The actionable failure, not "unreachable on every configured endpoint".
    await expect(harness.walkGatewayEndpoints()).rejects.toBeInstanceOf(CloudflareSignInRequiredError);
  });

  // Access checks the bearer token only at the upgrade. Without a refresh
  // while connected, a person removed from the allowlist stayed connected for
  // hours in the live test, until the client happened to restart.
  it("ends a signed-in session when Access refuses its refresh", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      signIn.enabled = true;
      cloudflareEndpoint.value = "wss://federation.example.com";
      await createHarness(["wss://federation.example.com"]).connectClient("wss://federation.example.com");
      signIn.accessToken.mockRejectedValue(new CloudflareSignInRequiredError());
      await vi.advanceTimersByTimeAsync(59_000);
      expect(clientClose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(clientClose).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("keeps a signed-in session through a refresh that fails for another reason", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      signIn.enabled = true;
      cloudflareEndpoint.value = "wss://federation.example.com";
      await createHarness(["wss://federation.example.com"]).connectClient("wss://federation.example.com");
      signIn.accessToken.mockClear();
      signIn.accessToken.mockRejectedValueOnce(new Error("fetch failed"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(signIn.accessToken).toHaveBeenCalledTimes(1);
      expect(clientClose).not.toHaveBeenCalled();
      // Retried on the next schedule, and a successful refresh keeps it going.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(signIn.accessToken).toHaveBeenCalledTimes(2);
      expect(clientClose).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("withholds credentials from every host when several are configured and none is designated", async () => {
    cloudflareEndpoint.value = "";
    await createHarness([
      "wss://one.example",
      "wss://two.example",
    ]).connectClient("wss://one.example");

    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].headers).toBeUndefined();
    expect(connectCalls[0].clientCertificate).toBeUndefined();
  });

  it("keeps single-endpoint behavior working without an explicit designation", async () => {
    cloudflareEndpoint.value = "";
    await createHarness(["wss://federation.example.com"]).connectClient(
      "wss://federation.example.com",
    );

    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].headers).toMatchObject({
      "CF-Access-Client-Id": "access-id",
    });
    expect(connectCalls[0].clientCertificate).toBe("PEM-CERT");
  });

  it("matches the designated endpoint case-insensitively and ignores its path", async () => {
    cloudflareEndpoint.value = "WSS://Federation.Example.com/pwragent";
    await createHarness([
      "wss://federation.example.com/other-path",
      "ws://lan",
    ]).connectClient("wss://federation.example.com/other-path");

    expect(connectCalls[0].headers).toMatchObject({
      "CF-Access-Client-Id": "access-id",
    });
  });

  it("never sends Cloudflare credentials on a plain ws:// endpoint", async () => {
    cloudflareEndpoint.value = "";
    await createHarness(["ws://192.168.1.20:47830"]).connectClient(
      "ws://192.168.1.20:47830",
    );

    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].headers).toBeUndefined();
    expect(connectCalls[0].clientCertificate).toBeUndefined();
    expect(connectCalls[0].clientPrivateKey).toBeUndefined();
  });

  it("dials ssh:// endpoints through the SSH forward without edge credentials", async () => {
    await createHarness([
      "ssh://ops@gateway.lan/?forward=127.0.0.1:47831",
    ]).connectClient("ssh://ops@gateway.lan/?forward=127.0.0.1:47831");

    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].url).toBe("ws://127.0.0.1:47831");
    expect(connectCalls[0].createSocket).toBeTypeOf("function");
    expect(connectCalls[0].headers).toBeUndefined();
    expect(connectCalls[0].clientCertificate).toBeUndefined();
  });
});
