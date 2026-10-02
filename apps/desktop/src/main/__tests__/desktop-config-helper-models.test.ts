import { describe, expect, it } from "vitest";
import type { DesktopHelperModelSettings } from "@pwragent/shared";
import {
  desktopSettingsPatchToEdits,
  parseDesktopSettingsToml,
} from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";

const save = (
  existing: string,
  helperModels: DesktopHelperModelSettings,
): string =>
  applyTomlEdits(
    existing,
    desktopSettingsPatchToEdits(
      { models: { helperModels } },
      parseTomlTables(existing, "test.toml"),
    ),
  );

describe("desktop config helper models", () => {
  it("writes only the canonical shape to a blank config and reads it back", () => {
    const written = save("", {
      defaultModel: "gpt-6-luna",
      helpers: {
        thread_titles: { reasoningEffort: "medium" },
        diff_condensation: { model: "gpt-5.6-luna" },
        usage_analysis: { backend: "acp:grok", model: "grok-fast" },
      },
    });

    expect(written).toBe([
      "[models]",
      "helper_default_model = \"gpt-6-luna\"",
      "",
      "[[models.helper_models]]",
      "helper = \"diff_condensation\"",
      "model = \"gpt-5.6-luna\"",
      "",
      "[[models.helper_models]]",
      "helper = \"thread_titles\"",
      "reasoning_effort = \"medium\"",
      "",
      "[[models.helper_models]]",
      "helper = \"usage_analysis\"",
      "backend = \"acp:grok\"",
      "model = \"grok-fast\"",
      "",
    ].join("\n"));
    expect(parseDesktopSettingsToml(written, "test.toml").models).toEqual({
      helperModels: {
        defaultModel: "gpt-6-luna",
        helpers: {
          diff_condensation: { model: "gpt-5.6-luna" },
          thread_titles: { reasoningEffort: "medium" },
          usage_analysis: { backend: "acp:grok", model: "grok-fast" },
        },
      },
    });
  });

  it("skips a malformed row without dropping the section", () => {
    const parsed = parseDesktopSettingsToml([
      "[models]",
      "helper_default_model = 7",
      "",
      "[[models.helper_models]]",
      "model = \"no-helper-id\"",
      "",
      "[[models.helper_models]]",
      "helper = \"thread_titles\"",
      "",
      "[[models.helper_models]]",
      "helper = \"task_monitors\"",
      "model = \"gpt-5.6-luna\"",
      "",
      "[[models.helper_models]]",
      "helper = \"future_helper\"",
      "model = \"gpt-7-luna\"",
      "",
    ].join("\n"), "test.toml");

    expect(parsed.models?.helperModels).toEqual({
      helpers: {
        task_monitors: { model: "gpt-5.6-luna" },
        // A newer build's helper survives a save from this build.
        future_helper: { model: "gpt-7-luna" },
      },
    });
  });

  it("clears both keys when every helper returns to Helper default", () => {
    const existing = [
      "# Operator comment",
      "[models]",
      "helper_default_model = \"gpt-6-luna\"",
      "",
      "[[models.helper_models]]",
      "helper = \"diff_condensation\"",
      "model = \"gpt-5.6-luna\"",
      "",
      "[models.codex]",
      "allow_fast = false",
      "",
    ].join("\n");
    const written = save(existing, { helpers: {} });

    expect(written).toContain("# Operator comment");
    expect(written).toContain("allow_fast = false");
    expect(written).not.toContain("helper_default_model");
    expect(written).not.toContain("[[models.helper_models]]");
    expect(parseDesktopSettingsToml(written, "test.toml").models).toEqual({
      codex: { allowFast: false },
    });
  });
});
