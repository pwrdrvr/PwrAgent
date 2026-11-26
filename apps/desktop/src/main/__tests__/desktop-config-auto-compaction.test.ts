import { describe, expect, it } from "vitest";
import type { DesktopAutoCompactionRule } from "@pwragent/shared/auto-compaction";
import {
  desktopSettingsPatchToEdits,
  parseDesktopSettingsToml,
} from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";

const saveRules = (existing: string, autoCompaction: DesktopAutoCompactionRule[]): string =>
  applyTomlEdits(
    existing,
    desktopSettingsPatchToEdits(
      { models: { autoCompaction } },
      parseTomlTables(existing, "test.toml"),
    ),
  );

describe("desktop config auto-compaction rules", () => {
  it("writes one row per saved rule and reads them back", () => {
    const written = saveRules("", [
      {
        provider: "acp:antigravity",
        model: "gemini-*",
        enabled: true,
        contextWindowTokens: 400_000,
        compactAtPercent: 75,
        duringTurn: "wait",
      },
      { provider: "*", model: "gemini-*", enabled: false },
    ]);

    expect(written).toBe([
      "[[models.auto_compaction]]",
      "provider = \"acp:antigravity\"",
      "model = \"gemini-*\"",
      "enabled = true",
      "context_window = 400000",
      "compact_at_percent = 75",
      "during_turn = \"wait\"",
      "",
      "[[models.auto_compaction]]",
      "provider = \"*\"",
      "model = \"gemini-*\"",
      "enabled = false",
      "",
    ].join("\n"));
    expect(parseDesktopSettingsToml(written, "test.toml").models?.autoCompaction).toEqual([
      {
        provider: "acp:antigravity",
        model: "gemini-*",
        enabled: true,
        contextWindowTokens: 400_000,
        compactAtPercent: 75,
        duringTurn: "wait",
      },
      { provider: "*", model: "gemini-*", enabled: false },
    ]);
  });

  it("removes the rows when only the defaults remain", () => {
    const written = saveRules("", [{ provider: "codex", model: "gpt-5", enabled: true }]);
    expect(saveRules(written, [])).not.toContain("auto_compaction");
  });

  it("skips a malformed row and an out-of-range number, and keeps the rest", () => {
    const parsed = parseDesktopSettingsToml([
      "[[models.auto_compaction]]",
      "provider = \"codex\"",
      "",
      "[[models.auto_compaction]]",
      "provider = \"claude\"",
      "model = \"claude-sonnet-5-5\"",
      "compact_at_percent = 120",
      "",
    ].join("\n"), "test.toml");
    expect(parsed.models?.autoCompaction).toEqual([
      { provider: "claude", model: "claude-sonnet-5-5", enabled: true },
    ]);
  });
});
