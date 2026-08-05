import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateFederationNoiseStaticKeyPair } from "../federation/federation-noise";
import { DesktopFederationRuntime } from "../federation/federation-runtime";

const metaStore = vi.hoisted(() => new Map<string, string>());
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
  connectFederationClient: async (params: (typeof connectCalls)[number]) => {
    connectCalls.push(params);
    return {
      sessionId: "federation-session:test",
      capabilities: [],
      sendEnvelope: () => undefined,
      close: () => undefined,
    };
  },
}));

vi.mock("../settings/desktop-settings-singleton", () => {
  const noise = generateFederationNoiseStaticKeyPair();
  return {
    getDesktopSettingsService: () => ({
      readSettings: async () => ({
        federation: {
          cloudflareMtlsEnabled: { value: true },
          cloudflareAccessServiceAuthEnabled: { value: true },
        },
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
  connectClient: (gatewayUrl: string) => Promise<void>;
  store: () => { appendAudit: (entry: unknown) => void };
};

function createHarness(): CredentialHarness {
  const runtime = new DesktopFederationRuntime() as unknown as CredentialHarness;
  runtime.stopping = false;
  runtime.store = () => ({ appendAudit: () => undefined });
  return runtime;
}

describe("federation endpoint credential scoping", () => {
  beforeEach(() => {
    connectCalls.length = 0;
    metaStore.clear();
    metaStore.set("federation_instance_id", "pwr_client-under-test");
    metaStore.set("federation_gateway_instance_id", "gateway_one");
    metaStore.set("federation_gateway_public_key_pem", "gateway-public-pem");
    metaStore.set(
      "federation_gateway_noise_public_key",
      generateFederationNoiseStaticKeyPair().publicKeyBase64,
    );
  });

  it("attaches Cloudflare credentials on wss:// endpoints", async () => {
    await createHarness().connectClient("wss://federation.example.com");

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

  it("never sends Cloudflare credentials on a plain ws:// endpoint", async () => {
    await createHarness().connectClient("ws://192.168.1.20:47830");

    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].headers).toBeUndefined();
    expect(connectCalls[0].clientCertificate).toBeUndefined();
    expect(connectCalls[0].clientPrivateKey).toBeUndefined();
  });

  it("dials ssh:// endpoints through the SSH forward without edge credentials", async () => {
    await createHarness().connectClient(
      "ssh://ops@gateway.lan/?forward=127.0.0.1:47831",
    );

    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].url).toBe("ws://127.0.0.1:47831");
    expect(connectCalls[0].createSocket).toBeTypeOf("function");
    expect(connectCalls[0].headers).toBeUndefined();
    expect(connectCalls[0].clientCertificate).toBeUndefined();
  });
});
