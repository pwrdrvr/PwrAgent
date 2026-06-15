import { describe, it, expect } from "vitest";
import {
  parseDesktopSettingsToml,
  desktopSettingsPatchToEdits,
} from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";

// Regression: the `[ui]` window-layout section (sidebar hidden, context-rail
// pinned, active tab, edited-files dock) must survive the read path.
// `pruneEmptyConfig` reconstructs the config section-by-section, so a newly
// added section that it doesn't copy is silently dropped — which made
// persisted layout prefs never restore on relaunch.
describe("desktop config [ui] section", () => {
  it("reads [ui] booleans + strings into config.ui", () => {
    const src = [
      "[general.appearance]",
      'theme = "light"',
      "",
      "[ui]",
      "context_rail_pinned = true",
      "sidebar_hidden = true",
      'active_context_tab = "providers"',
      'edited_files_dock = "sidebar"',
      "",
    ].join("\n");

    const config = parseDesktopSettingsToml(src, "test.toml");

    expect(config.ui).toEqual({
      contextRailPinned: true,
      sidebarHidden: true,
      activeContextTab: "providers",
      editedFilesDock: "sidebar",
    });
  });

  it("omits config.ui when the section is absent", () => {
    const config = parseDesktopSettingsToml('[general]\ndeveloper_mode = true\n', "test.toml");
    expect(config.ui).toBeUndefined();
  });

  it("round-trips a write then read of the [ui] section", () => {
    // `context_rail_pinned` defaults to pinned-open, so its persisted
    // non-default value is `false` (an explicit unpin).
    const edits = desktopSettingsPatchToEdits({
      ui: {
        sidebarHidden: true,
        contextRailPinned: false,
        activeContextTab: "providers",
        editedFilesDock: "sidebar",
      },
    });
    const written = applyTomlEdits("", edits);
    const config = parseDesktopSettingsToml(written, "test.toml");

    expect(config.ui).toEqual({
      sidebarHidden: true,
      contextRailPinned: false,
      activeContextTab: "providers",
      editedFilesDock: "sidebar",
    });
  });

  it("deletes default-valued [ui] keys on write (off/pinned/info/above are absent on disk)", () => {
    const existing = [
      "[ui]",
      "sidebar_hidden = true",
      "context_rail_pinned = false",
      'active_context_tab = "providers"',
      'edited_files_dock = "sidebar"',
      "",
    ].join("\n");
    const edits = desktopSettingsPatchToEdits(
      {
        ui: {
          // Defaults: sidebar shown, rail pinned-open, info tab, dock above.
          sidebarHidden: false,
          contextRailPinned: true,
          activeContextTab: "info",
          editedFilesDock: "above",
        },
      },
      parseTomlTables(existing, "test.toml"),
    );
    const written = applyTomlEdits(existing, edits);
    const config = parseDesktopSettingsToml(written, "test.toml");

    // All four reverted to defaults → the section carries no values.
    expect(config.ui).toBeUndefined();
  });
});
