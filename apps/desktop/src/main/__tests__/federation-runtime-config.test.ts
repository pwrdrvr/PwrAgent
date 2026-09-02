import { describe, expect, it } from "vitest";
import { resolveFederationRuntimeConfig } from "../federation/federation-runtime-config";

describe("resolveFederationRuntimeConfig", () => {
  it("normalizes the credential-free runtime projection", () => {
    const config = resolveFederationRuntimeConfig({
      advertisedEndpoints: [" ", " wss://public.example/federation "],
      cloudflareAccessServiceAuthEnabled: true,
      cloudflareEndpoint: " wss://edge.example/federation ",
      gatewayEndpoints: [],
      gatewayUrl: " wss://gateway.example/federation ",
      instanceLabel: " Studio ",
      instanceNotes: " Primary ",
      listenHost: "0.0.0.0",
      listenPort: 49_000,
      mode: "dual",
      publicUrl: " wss://public.example/federation ",
    });

    expect(config).toEqual({
      advertisedEndpoints: ["wss://public.example/federation"],
      cloudflareAccessServiceAuthEnabled: true,
      cloudflareEndpoint: "wss://edge.example/federation",
      cloudflareMtlsEnabled: false,
      gatewayEndpoints: ["wss://gateway.example/federation"],
      instanceLabel: "Studio",
      instanceNotes: "Primary",
      listenHost: "0.0.0.0",
      listenPort: 49_000,
      mode: "dual",
      publicUrl: "wss://public.example/federation",
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.gatewayEndpoints)).toBe(true);
  });

  it("uses safe defaults without consulting secrets or discovery", () => {
    expect(resolveFederationRuntimeConfig({})).toEqual({
      advertisedEndpoints: [],
      cloudflareAccessServiceAuthEnabled: false,
      cloudflareEndpoint: "",
      cloudflareMtlsEnabled: false,
      gatewayEndpoints: [],
      instanceLabel: "",
      instanceNotes: "",
      listenHost: "127.0.0.1",
      listenPort: 47_830,
      mode: "disabled",
      publicUrl: "",
    });
  });
});
