import { describe, expect, it } from "vitest";
import { desktopSettingsPatchToEdits, parseDesktopSettingsToml } from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";

const save = (existing: string, usageAccountGroups: Record<string, string>) => applyTomlEdits(
  existing,
  desktopSettingsPatchToEdits({ models: { usageAccountGroups } }, parseTomlTables(existing, "test.toml")),
);

describe("usage account configuration", () => {
  it("round trips groups for API-key and ACP accounts and changes only the saved setting", () => {
    const existing = "# Keep my configuration\n[models.codex]\nprofile = \"work\"\n";
    const written = save(existing, { codex: " Work API ", "acp:grok": "Personal Grok" });
    const parsed = parseDesktopSettingsToml(written, "test.toml");
    expect(parsed.models?.usageAccountGroups).toEqual({ codex: "Work API", "acp:grok": "Personal Grok" });
    expect(parsed.models?.codex?.profile).toBe("work");
    expect(written).toContain("# Keep my configuration");
    const cleared = save(written, {});
    expect(cleared).not.toContain("usage_account_groups");
    expect(parseDesktopSettingsToml(cleared, "test.toml").models?.codex?.profile).toBe("work");
  });

  it("skips malformed rows and retains a newer build's backend group", () => {
    const written = save("", { codex: "", "acp:future": "team", invalid: "bad", "acp:grok": "x".repeat(121) });
    expect(parseDesktopSettingsToml(written, "test.toml").models?.usageAccountGroups)
      .toEqual({ "acp:future": "team" });
    expect(parseDesktopSettingsToml("[models]\nusage_account_groups = 3\n", "test.toml").models)
      .toBeUndefined();
  });

  it("round trips Usage account names beside groups and clears them independently", () => {
    const withGroup = save("", { codex: "Work API" });
    const names = (existing: string, usageAccountNames: Record<string, string>) => applyTomlEdits(
      existing,
      desktopSettingsPatchToEdits({ models: { usageAccountNames } }, parseTomlTables(existing, "test.toml")),
    );
    const written = names(withGroup, {
      "openai:0123abcd": " Personal ", "xai:9f8e": "Grok team",
      "OpenAI:bad": "case", "openai:": "empty key", "openai:long": "x".repeat(61), "openai:blank": " ",
    });
    const parsed = parseDesktopSettingsToml(written, "test.toml").models;
    expect(parsed?.usageAccountNames).toEqual({ "openai:0123abcd": "Personal", "xai:9f8e": "Grok team" });
    expect(parsed?.usageAccountGroups).toEqual({ codex: "Work API" });
    const cleared = names(written, {});
    expect(cleared).not.toContain("usage_account_names");
    expect(parseDesktopSettingsToml(cleared, "test.toml").models?.usageAccountGroups).toEqual({ codex: "Work API" });
  });
});
