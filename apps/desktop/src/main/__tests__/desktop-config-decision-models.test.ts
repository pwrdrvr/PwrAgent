import { describe, expect, it } from "vitest";
import type { DesktopDecisionModelSettings } from "@pwragent/shared";
import {
  desktopSettingsPatchToEdits,
  parseDesktopSettingsToml,
} from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";

const save = (
  existing: string,
  decisionModels: DesktopDecisionModelSettings,
): string =>
  applyTomlEdits(
    existing,
    desktopSettingsPatchToEdits(
      { models: { decisionModels } },
      parseTomlTables(existing, "test.toml"),
    ),
  );

describe("desktop config decision models", () => {
  it("writes the canonical [models.decision] shape to a blank config and reads it back", () => {
    const written = save("", {
      model: "jev",
      cameraCues: false,
      local: { endpoint: "http://localhost:9911/", model: " clef-pro " },
      jev: { model: " jev-1.13.0 " },
    });

    expect(written).toBe([
      "[models.decision]",
      "model = \"jev\"",
      "camera_cues = false",
      "local_endpoint = \"http://localhost:9911\"",
      "local_model = \"clef-pro\"",
      "jev_model = \"jev-1.13.0\"",
      "",
    ].join("\n"));
    expect(parseDesktopSettingsToml(written, "test.toml").models?.decisionModels).toEqual({
      model: "jev",
      cameraCues: false,
      local: { endpoint: "http://localhost:9911", model: "clef-pro" },
      jev: { model: "jev-1.13.0" },
    });
  });

  it("removes keys put back to their defaults and keeps unrelated keys and comments", () => {
    const existing = [
      "# operator note",
      "[models]",
      "helper_default_model = \"gpt-6-luna\"",
      "",
      "[models.decision]",
      "model = \"off\"",
      "local_endpoint = \"http://127.0.0.1:9000\"",
      "",
    ].join("\n");
    const written = save(existing, { model: "local" });
    expect(written).toContain("# operator note");
    expect(written).toContain("helper_default_model = \"gpt-6-luna\"");
    expect(written).not.toContain("local_endpoint");
    expect(parseDesktopSettingsToml(written, "test.toml").models?.decisionModels).toEqual({ model: "local" });
  });

  it("skips values this build cannot use instead of dropping the section", () => {
    const parsed = parseDesktopSettingsToml([
      "[models.decision]",
      "model = \"gpt\"",
      "camera_cues = true",
      // Frames go only to a server on this Mac.
      "local_endpoint = \"http://192.168.1.20:8787\"",
      "local_model = \"  \"",
      "jev_model = \"\"",
      "",
    ].join("\n"), "test.toml");
    expect(parsed.models?.decisionModels).toEqual({ cameraCues: true });
    expect(parseDesktopSettingsToml("[models]\n", "test.toml").models?.decisionModels).toBeUndefined();
  });
});
