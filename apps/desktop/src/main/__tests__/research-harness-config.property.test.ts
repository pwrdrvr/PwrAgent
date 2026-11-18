import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseDesktopSettingsToml } from "../settings/desktop-config";
import { selectHarnessModel } from "../research/research-harness-model";

describe("optional Harness configuration", () => {
  it("keeps observation independent of malformed model configuration and discloses only endpoint origin", () => {
    const config = { command: "/bridge", args: [], model: "explicit-model", endpoint: "invalid endpoint" };
    expect(selectHarnessModel(config, "import")).toBeUndefined();
    expect(() => selectHarnessModel(config, "execute")).toThrow();
    const selected = selectHarnessModel({ ...config, endpoint: "https://fixture.example/v1/chat/completions" }, "execute");
    expect(selected).toMatchObject({ model: "explicit-model", endpointOrigin: "https://fixture.example" });
    expect(() => selectHarnessModel({ ...config, endpoint: "https://user:secret@fixture.example/v1" }, "execute")).toThrow("credentials");
  });
  it("preserves literal executable arguments, including whitespace and empty arguments", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom("", " has spaces ", "$(literal)", "--socket", "/fixture/ui.sock"), { maxLength: 12 }), (args) => {
      const config = parseDesktopSettingsToml(`[research.harness]\ncommand = "/fixture/bridge"\nargs = ${JSON.stringify(args)}\n`, "fixture.toml");
      expect(config.research?.harness).toMatchObject({ command: "/fixture/bridge", args });
    }));
    expect(parseDesktopSettingsToml("", "fixture.toml").research).toBeUndefined();
  });
  it.each(['args = "--execute"', 'args = [1]', 'model = 123', 'endpoint = false'])("fails closed on malformed %s", (field) => {
    expect(() => parseDesktopSettingsToml(`[research.harness]\ncommand = "/fixture/bridge"\n${field}\n`, "fixture.toml")).toThrow();
  });
});
