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
