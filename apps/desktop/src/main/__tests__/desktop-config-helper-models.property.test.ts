import fc from "fast-check";
import { expect, it } from "vitest";
import type { DesktopHelperModelSettings } from "@pwragent/shared/helper-models";
import { desktopSettingsPatchToEdits } from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";

it("saving inline helper overrides keeps one TOML array and the retired choice across repeated saves", () => {
  fc.assert(fc.property(
    fc.boolean(), fc.boolean(), fc.boolean(),
    (multiline, retiredFirst, keepActive) => {
      const retired = '{ helper = "diff_condensation", model = "gpt-5.6-luna", reasoning_effort = "low" }';
      const active = '{ helper = "thread_titles", model = "gpt-6-luna" }';
      const rows = retiredFirst ? [retired, active] : [active, retired];
      const inlineArray = multiline ? `[\n  ${rows.join(",\n  ")},\n]` : `[${rows.join(", ")}]`;
      const unrelated = '# Operator comment\n[models.codex]\nallow_fast = false\n';
      const source = `[models]\nhelper_models = ${inlineArray}\n\n${unrelated}`;
      const settings: DesktopHelperModelSettings = {
        helpers: keepActive ? { thread_titles: { model: "gpt-5.5" } } : {},
      };
      const save = (text: string) => {
        const tables = parseTomlTables(text, "test.toml");
        return applyTomlEdits(text, desktopSettingsPatchToEdits({ models: { helperModels: settings } }, tables));
      };

      const saved = save(source);
      // The config reader accepts both spellings together and can mask a
      // redefinition, so check the emitted source as well as the values.
      expect(saved).not.toMatch(/^helper_models\s*=/m);
      expect(saved).toContain(unrelated);
      expect(parseTomlTables(saved, "test.toml").models?.helper_models).toEqual([
        ...(keepActive ? [{ helper: "thread_titles", model: "gpt-5.5" }] : []),
        { helper: "diff_condensation", model: "gpt-5.6-luna", reasoning_effort: "low" },
      ]);
      expect(save(saved)).toBe(saved);
    },
  ));
});
