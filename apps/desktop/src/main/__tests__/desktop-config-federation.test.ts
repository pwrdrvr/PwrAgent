import { describe, expect, it } from "vitest";
import {
  desktopSettingsPatchToEdits,
  parseDesktopSettingsToml,
} from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";

describe("desktop config [federation] section", () => {
  it("reads federation settings from TOML", () => {
    const src = [
      "[federation]",
      'mode = "gateway"',
      'instance_label = "Studio Mac"',
      'listen_host = "127.0.0.1"',
      "listen_port = 47830",
      'public_url = "https://pwragent.example.com"',
      'gateway_url = "https://pwragent.example.com"',
      "cloudflare_mtls_enabled = true",
      "cloudflare_access_service_auth_enabled = true",
      "",
    ].join("\n");

    const config = parseDesktopSettingsToml(src, "test.toml");

    expect(config.federation).toEqual({
      mode: "gateway",
      instanceLabel: "Studio Mac",
      listenHost: "127.0.0.1",
      listenPort: 47830,
      publicUrl: "https://pwragent.example.com",
      gatewayUrl: "https://pwragent.example.com",
      cloudflareMtlsEnabled: true,
      cloudflareAccessServiceAuthEnabled: true,
    });
  });

  it("round-trips federation writes through TOML edits", () => {
    const edits = desktopSettingsPatchToEdits({
      federation: {
        mode: "dual",
        instanceLabel: "Studio Mac",
        listenHost: "0.0.0.0",
        listenPort: 47831,
        publicUrl: "https://gateway.example.com",
        gatewayUrl: "https://gateway.example.com",
        cloudflareMtlsEnabled: true,
        cloudflareAccessServiceAuthEnabled: true,
      },
    });
    const written = applyTomlEdits("", edits);
    const config = parseDesktopSettingsToml(written, "test.toml");

    expect(config.federation).toEqual({
      mode: "dual",
      instanceLabel: "Studio Mac",
      listenHost: "0.0.0.0",
      listenPort: 47831,
      publicUrl: "https://gateway.example.com",
      gatewayUrl: "https://gateway.example.com",
      cloudflareMtlsEnabled: true,
      cloudflareAccessServiceAuthEnabled: true,
    });
  });

  it("deletes federation defaults on write", () => {
    const existing = [
      "[federation]",
      'mode = "gateway"',
      'instance_label = "Studio Mac"',
      'listen_host = "127.0.0.1"',
      "listen_port = 47830",
      'public_url = "https://gateway.example.com"',
      'gateway_url = "https://gateway.example.com"',
      "cloudflare_mtls_enabled = true",
      "cloudflare_access_service_auth_enabled = true",
      "",
    ].join("\n");
    const edits = desktopSettingsPatchToEdits(
      {
        federation: {
          mode: "disabled",
          instanceLabel: "",
          listenHost: "",
          listenPort: 0,
          publicUrl: "",
          gatewayUrl: "",
          cloudflareMtlsEnabled: false,
          cloudflareAccessServiceAuthEnabled: false,
        },
      },
      parseTomlTables(existing, "test.toml"),
    );
    const written = applyTomlEdits(existing, edits);
    const config = parseDesktopSettingsToml(written, "test.toml");

    expect(config.federation).toBeUndefined();
  });

  it("reads ordered gateway and advertised endpoint lists", () => {
    const src = [
      "[federation]",
      'mode = "client"',
      'gateway_url = "ws://192.168.1.20:47830"',
      'gateway_endpoints = ["ws://192.168.1.20:47830", "wss://studio.example.ts.net/pwragent-federation", "ssh://ops@gateway.lan"]',
      'advertised_endpoints = ["wss://federation.example.com"]',
      "",
    ].join("\n");

    const config = parseDesktopSettingsToml(src, "test.toml");

    expect(config.federation?.gatewayEndpoints).toEqual([
      "ws://192.168.1.20:47830",
      "wss://studio.example.ts.net/pwragent-federation",
      "ssh://ops@gateway.lan",
    ]);
    expect(config.federation?.advertisedEndpoints).toEqual([
      "wss://federation.example.com",
    ]);
  });

  it("writes only the canonical shape for a config without a legacy gateway_url", () => {
    const edits = desktopSettingsPatchToEdits({
      federation: {
        gatewayEndpoints: [
          " wss://studio.example.ts.net/pwragent-federation ",
          "wss://federation.example.com",
          "wss://federation.example.com",
        ],
      },
    });
    const written = applyTomlEdits("", edits);
    const config = parseDesktopSettingsToml(written, "test.toml");

    expect(config.federation?.gatewayEndpoints).toEqual([
      "wss://studio.example.ts.net/pwragent-federation",
      "wss://federation.example.com",
    ]);
    // docs/config-file-evolution.md: a brand-new config gets the canonical
    // shape only; the legacy scalar is not invented for it.
    expect(config.federation?.gatewayUrl).toBeUndefined();
  });

  it("keeps an existing legacy gateway_url in sync and marks it", () => {
    const existing = [
      "[federation]",
      'mode = "client"',
      'gateway_url = "wss://old.example.com"',
      "",
    ].join("\n");
    const edits = desktopSettingsPatchToEdits(
      {
        federation: {
          gatewayEndpoints: [
            "wss://studio.example.ts.net/pwragent-federation",
            "wss://federation.example.com",
          ],
        },
      },
      parseTomlTables(existing, "test.toml"),
    );
    const written = applyTomlEdits(existing, edits);
    const config = parseDesktopSettingsToml(written, "test.toml");

    expect(config.federation?.gatewayUrl).toBe(
      "wss://studio.example.ts.net/pwragent-federation",
    );
    expect(written).toContain("pwragent-legacy-settings");
    expect(written).toContain("key=gateway_url");
  });

  it("drops endpoints whose scheme the transport must never dial", () => {
    const src = [
      "[federation]",
      'gateway_endpoints = ["https://evil.example", "ws://ok.example:47830", "ssh://user:secret@host", "ssh://-oProxyCommand=x"]',
      "",
    ].join("\n");

    const config = parseDesktopSettingsToml(src, "test.toml");

    expect(config.federation?.gatewayEndpoints).toEqual([
      "ws://ok.example:47830",
    ]);
  });

  it("lets an explicit gatewayUrl win over the endpoint dual-write", () => {
    const edits = desktopSettingsPatchToEdits({
      federation: {
        gatewayUrl: "wss://explicit.example.com",
        gatewayEndpoints: ["wss://first.example.com"],
      },
    });
    const written = applyTomlEdits("", edits);
    const config = parseDesktopSettingsToml(written, "test.toml");

    expect(config.federation?.gatewayUrl).toBe("wss://explicit.example.com");
    expect(config.federation?.gatewayEndpoints).toEqual([
      "wss://first.example.com",
    ]);
  });

  it("clearing the endpoint list preserves the legacy gateway_url", () => {
    const existing = [
      "[federation]",
      'mode = "client"',
      'gateway_url = "wss://old.example.com"',
      'gateway_endpoints = ["wss://old.example.com"]',
      'advertised_endpoints = ["wss://old.example.com"]',
      "",
    ].join("\n");
    const edits = desktopSettingsPatchToEdits(
      {
        federation: {
          gatewayEndpoints: [],
          advertisedEndpoints: [],
        },
      },
      parseTomlTables(existing, "test.toml"),
    );
    const written = applyTomlEdits(existing, edits);
    const config = parseDesktopSettingsToml(written, "test.toml");

    expect(config.federation?.gatewayEndpoints).toBeUndefined();
    expect(config.federation?.advertisedEndpoints).toBeUndefined();
    // docs/config-file-evolution.md rule 7: never delete the preserved legacy
    // scalar an older client still reads.
    expect(config.federation?.gatewayUrl).toBe("wss://old.example.com");
  });

  it("ignores unknown federation modes", () => {
    const config = parseDesktopSettingsToml(
      '[federation]\nmode = "coordinator"\n',
      "test.toml",
    );

    expect(config.federation).toBeUndefined();
  });

  it("maps the legacy child federation mode to client", () => {
    const config = parseDesktopSettingsToml(
      '[federation]\nmode = "child"\n',
      "test.toml",
    );

    expect(config.federation?.mode).toBe("client");
  });
});
