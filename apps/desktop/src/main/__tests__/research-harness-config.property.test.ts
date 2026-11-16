import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseDesktopSettingsToml } from "../settings/desktop-config";

describe("optional Harness configuration", () => {
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
