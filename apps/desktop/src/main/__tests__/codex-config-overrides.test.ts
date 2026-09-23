import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateCodexConfigOverrides } from "../settings/codex-config-overrides";
import { applyDesktopSettingsPatch, parseDesktopSettingsToml } from "../settings/desktop-config";
import { normalizeConfigDomains } from "../settings/config-store/config-domains";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe("Codex configuration overlays", () => {
  it("preserves ordered Codex values, including inline tables, equals signs and shell metacharacters", () => {
    const overrides = [
      ' model = "fixture model" ',
      'model_providers.local={ name = "Local", base_url = "http://127.0.0.1:1234/v1?x=y" }',
      'model_provider=local',
      'developer_instructions="Keep $(command) and `code` literal"',
      'features.example=true',
      'model="last-entry-wins"',
    ];
    expect(validateCodexConfigOverrides(overrides)).toEqual([
      'model="fixture model"', ...overrides.slice(1),
    ]);
  });

  it.each([
    null, "model=fixture", [3], [""], ["--profile=other"], ["model="],
    ["model"], ["model.x\n=true"], ['"model"="fixture"'], ["a..b=true"],
    ["model=fixture\0"], Array(129).fill("model=fixture"), [`model=${"x".repeat(16_384)}`],
  ])("rejects malformed override envelopes without echoing values: %#", (input) => {
    expect(() => validateCodexConfigOverrides(input)).toThrow("models.codex.config_overrides");
  });

  it.each([
    "approval_policy", "sandbox_mode", "approval_policy.foo", "shell_environment_policy",
    "shell_environment_policy.set", "shell_environment_policy.set.PATH",
    "shell_environment_policy.set.CODEX_HOME", "shell_environment_policy.set.CODEX_HOME.foo",
  ])("rejects managed key and parent-table replacements: %s", (key) => {
    expect(() => validateCodexConfigOverrides([`${key}=private-value`]))
      .toThrow("conflicts with a PwrAgent-managed Codex setting");
    try {
      validateCodexConfigOverrides([`${key}=private-value`]);
    } catch (error) {
      expect(String(error)).not.toContain("private-value");
    }
  });

  it("adds, round-trips and clears overlays without rewriting existing profile settings or comments", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-overlay-config-"));
    roots.push(root);
    const file = path.join(root, "config.toml");
    const original = '# keep this\n[models.codex]\nprofile = "work" # auth home\nallow_fast = false\nunknown = "keep"\n';
    fs.writeFileSync(file, original);
    const configOverrides = ['model_provider="local"', 'features.example=true'];
    applyDesktopSettingsPatch(file, { models: { codex: { configOverrides } } });
    const source = fs.readFileSync(file, "utf8");
    expect(source).toContain(original);
    expect(parseDesktopSettingsToml(source, file).models?.codex).toEqual({
      profile: "work", allowFast: false, configOverrides,
    });
    expect(applyDesktopSettingsPatch(file, { models: { codex: { configOverrides } } }).changed).toBe(false);
    expect(() => applyDesktopSettingsPatch(file, { models: { codex: { configOverrides: ["sandbox_mode=private"] } } })).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(source);
    applyDesktopSettingsPatch(file, { models: { codex: { configOverrides: [] } } });
    expect(parseDesktopSettingsToml(fs.readFileSync(file, "utf8"), file).models?.codex?.configOverrides).toEqual([]);
  });

  it("validates explicit local-model pricing IDs without silently dropping malformed values", () => {
    expect(parseDesktopSettingsToml("[models.codex]\nlocal_model_ids=['/models/bonsai.gguf']", "fixture.toml").models?.codex?.localModelIds)
      .toEqual(["/models/bonsai.gguf"]);
    for (const value of ['[42]', '"free"', '["unterminated]', '[""]']) {
      expect(() => parseDesktopSettingsToml(`[models.codex]\nlocal_model_ids=${value}`, "fixture.toml"))
        .toThrow();
    }
  });

  it("rejects malformed stored overlays and preserves absent legacy settings", () => {
    expect(parseDesktopSettingsToml('[models.codex]\nprofile="work"', "fixture.toml").models?.codex)
      .toEqual({ profile: "work" });
    expect(() => parseDesktopSettingsToml('[models.codex]\nconfig_overrides="bad"', "fixture.toml"))
      .toThrow("models.codex.config_overrides");
    expect(() => parseDesktopSettingsToml('[models.codex]\nconfig_overrides=[42]', "fixture.toml"))
      .toThrow("models.codex.config_overrides");
  });

  it("reads literal and basic strings in multiline TOML arrays without losing hashes, commas or backslashes", () => {
    const source = String.raw`[models.codex]
config_overrides = [
  'model_providers.local={ name = "Local, #1", base_url = "http://127.0.0.1:1234/v1" }', # comment
  'model_instructions_file="C:\\fixture\\instructions.md"',
  "model=\"fixture\"",
]
`;
    expect(parseDesktopSettingsToml(source, "fixture.toml").models?.codex?.configOverrides).toEqual([
      'model_providers.local={ name = "Local, #1", base_url = "http://127.0.0.1:1234/v1" }',
      String.raw`model_instructions_file="C:\\fixture\\instructions.md"`,
      'model="fixture"',
    ]);
  });

  it("changes only Codex's runtime fingerprint and restores it when overrides are cleared", () => {
    const original = normalizeConfigDomains({ config: {} });
    const withOverlay = normalizeConfigDomains({ config: { models: { codex: { configOverrides: ['model="fixture"'] } } } });
    expect(withOverlay.providers.codex.dependencyFingerprint).not.toBe(original.providers.codex.dependencyFingerprint);
    expect(withOverlay.providers.gemini).toEqual(original.providers.gemini);
    const cleared = normalizeConfigDomains({ config: { models: { codex: { configOverrides: [] } } } });
    expect(cleared.providers.codex).toEqual(original.providers.codex);
  });
});
