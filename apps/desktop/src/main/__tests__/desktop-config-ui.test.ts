import { describe, it, expect } from "vitest";
import {
  parseDesktopSettingsToml,
  desktopSettingsPatchToEdits,
} from "../settings/desktop-config";
import { applyTomlEdits } from "../settings/toml-editor";

// Regression: the `[ui]` window-layout section (sidebar hidden, context-rail
// pinned, active tab) must survive the read path. `pruneEmptyConfig`
// reconstructs the config section-by-section, so a newly added section that
// it doesn't copy is silently dropped — which made persisted layout prefs
// never restore on relaunch.
describe("desktop config [ui] section", () => {
  it("reads [ui] booleans + string into config.ui", () => {
    const src = [
      "[general.appearance]",
      'theme = "light"',
      "",
      "[ui]",
      "context_rail_pinned = true",
      "sidebar_hidden = true",
      'active_context_tab = "providers"',
      "",
    ].join("\n");

    const config = parseDesktopSettingsToml(src, "test.toml");

    expect(config.ui).toEqual({
      contextRailPinned: true,
      sidebarHidden: true,
      activeContextTab: "providers",
    });
  });

  it("omits config.ui when the section is absent", () => {
    const config = parseDesktopSettingsToml('[general]\ndeveloper_mode = true\n', "test.toml");
    expect(config.ui).toBeUndefined();
  });

  it("round-trips a write then read of the [ui] section", () => {
    const edits = desktopSettingsPatchToEdits(
      {
        ui: {
          sidebarHidden: true,
          contextRailPinned: true,
          activeContextTab: "providers",
        },
      },
      "",
    );
    const written = applyTomlEdits("", edits);
    const config = parseDesktopSettingsToml(written, "test.toml");

    expect(config.ui).toEqual({
      sidebarHidden: true,
      contextRailPinned: true,
      activeContextTab: "providers",
    });
  });

  it("deletes default-valued [ui] keys on write (off/info are absent on disk)", () => {
    const edits = desktopSettingsPatchToEdits(
      {
        ui: { sidebarHidden: false, contextRailPinned: false, activeContextTab: "info" },
      },
      "[ui]\nsidebar_hidden = true\ncontext_rail_pinned = true\nactive_context_tab = \"providers\"\n",
    );
    const written = applyTomlEdits(
      "[ui]\nsidebar_hidden = true\ncontext_rail_pinned = true\nactive_context_tab = \"providers\"\n",
      edits,
    );
    const config = parseDesktopSettingsToml(written, "test.toml");
    // All three reverted to defaults → the section carries no values.
    expect(config.ui).toBeUndefined();
  });
});
