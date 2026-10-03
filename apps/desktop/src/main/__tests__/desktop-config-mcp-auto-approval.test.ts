import { describe, expect, it } from "vitest";
import { desktopSettingsPatchToEdits, parseDesktopSettingsToml } from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";

describe("MCP Auto reviewer settings", () => {
  it.each(["harness", "completions", "responses", "claude", "system-one"] as const)("round-trips every field for %s without changing provider settings", (modelType) => {
    const existing = "# Keep my settings\n[models.codex]\npath = \"fixture-codex\"\n";
    const mcpAutoApproval = {
      escalationPrompt: "Reject unrelated file changes.", reviewEscalations: true,
      enabled: true, modelType, provider: "codex", model: "gpt-6-luna", reasoningEffort: "low",
      prompt: "Approve only the requested investigation.\nReject unrelated changes.",
      endpoint: "http://localhost:8000/decide", apiKeyEnv: "REVIEWER_API_KEY", confidenceThreshold: 0.95, timeoutMs: 15000,
    };
    const text = applyTomlEdits(existing, desktopSettingsPatchToEdits({ models: { mcpAutoApproval } }, parseTomlTables(existing, "test.toml")));
    expect(parseDesktopSettingsToml(text, "test.toml").models?.mcpAutoApproval).toEqual(mcpAutoApproval);
    expect(text).toContain("# Keep my settings");
    expect(text).toContain('path = "fixture-codex"');
  });

  it("does not enable a reviewer in older configuration files", () => {
    expect(parseDesktopSettingsToml("[models.codex]\npath = \"codex\"\n", "test.toml").models?.mcpAutoApproval).toBeUndefined();
  });
});
