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

vi.mock("../state/app-state", () => ({
  getAppStateDb: () => ({
    getMeta: (key: string) => metaStore.get(key) ?? "",
    setMeta: (key: string, value: string) => void metaStore.set(key, value),
  }),
  isAppStateInitialized: () => true,
}));

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: () => ({
    readSettings: async () => ({
      federation: { mode: { value: federationMode.value } },
    }),
    writeConfigPatch: async (patch: DesktopSettingsConfigPatch) => {
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
  resetEnrollment: () => Promise<{ cleared: boolean }>;
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

    expect(await createHarness().resetEnrollment()).toEqual({ cleared: false });
  });
});
