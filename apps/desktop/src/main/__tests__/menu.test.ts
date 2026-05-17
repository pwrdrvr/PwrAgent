import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { buildApplicationMenuTemplate } from "../menu";

function buildTemplate(
  developerMode: boolean,
  options?: { isMac?: boolean; openSettings?: () => void },
): MenuItemConstructorOptions[] {
  return buildApplicationMenuTemplate({
    appName: "PwrAgent",
    developerMode,
    isMac: options?.isMac ?? true,
    actions: {
      checkForUpdates: vi.fn(),
      openDocumentation: vi.fn(),
      openIssueReporter: vi.fn(),
      openSettings: options?.openSettings ?? vi.fn(),
      openWebsite: vi.fn(),
      showAboutPanel: vi.fn(),
      showChangelogWindow: vi.fn(),
      showLicenseWindow: vi.fn(),
      showLogsWindow: vi.fn(),
      showThirdPartyNoticesWindow: vi.fn(),
    },
  });
}

function submenuRoles(
  template: MenuItemConstructorOptions[],
  label: string,
): Array<string | undefined> {
  const menu = template.find((item) => item.label === label);
  const submenu = Array.isArray(menu?.submenu) ? menu.submenu : [];
  return submenu.map((item) => item.role);
}

function submenuItems(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] {
  const menu = template.find((item) => item.label === label);
  return Array.isArray(menu?.submenu) ? menu.submenu : [];
}

function findSubmenuByRole(
  template: MenuItemConstructorOptions[],
  role: string,
): MenuItemConstructorOptions[] {
  const menu = template.find((item) => item.role === role);
  return Array.isArray(menu?.submenu) ? menu.submenu : [];
}

describe("buildApplicationMenuTemplate", () => {
  it("hides developer-only View items when Developer Mode is off", () => {
    const roles = submenuRoles(buildTemplate(false), "View");

    expect(roles).not.toContain("reload");
    expect(roles).not.toContain("forceReload");
    expect(roles).not.toContain("toggleDevTools");
    expect(roles.filter((role) => role === "togglefullscreen")).toHaveLength(1);
  });

  it("includes developer-only View items when Developer Mode is on", () => {
    const roles = submenuRoles(buildTemplate(true), "View");

    expect(roles).toContain("reload");
    expect(roles).toContain("forceReload");
    expect(roles).toContain("toggleDevTools");
    expect(roles.filter((role) => role === "togglefullscreen")).toHaveLength(1);
  });

  describe("Settings menu item placement", () => {
    it("places Settings… under About on the macOS app menu with separators", () => {
      const items = submenuItems(buildTemplate(false), "PwrAgent");
      const labels = items.map((item) => item.label ?? item.role ?? item.type);

      // About → separator → Settings… → separator → services …
      const aboutIndex = labels.indexOf("About PwrAgent");
      const settingsIndex = labels.indexOf("Settings…");
      expect(aboutIndex).toBeGreaterThanOrEqual(0);
      expect(settingsIndex).toBe(aboutIndex + 2);
      expect(items[aboutIndex + 1]?.type).toBe("separator");
      expect(items[settingsIndex + 1]?.type).toBe("separator");
    });

    it("gives the Mac Settings item the universal ⌘, accelerator", () => {
      const items = submenuItems(buildTemplate(false), "PwrAgent");
      const settings = items.find((item) => item.label === "Settings…");
      expect(settings?.accelerator).toBe("CmdOrCtrl+,");
    });

    it("invokes the openSettings action on click", () => {
      const openSettings = vi.fn();
      const items = submenuItems(buildTemplate(false, { openSettings }), "PwrAgent");
      const settings = items.find((item) => item.label === "Settings…");
      expect(settings).toBeDefined();
      // `click` on MenuItemConstructorOptions takes (menuItem, browserWindow, event)
      // — we don't need the args here, just that our action gets called.
      (settings?.click as () => void | undefined)?.();
      expect(openSettings).toHaveBeenCalledOnce();
    });

    it("surfaces Settings in Help → About cluster on non-Mac platforms", () => {
      const helpItems = findSubmenuByRole(
        buildTemplate(false, { isMac: false }),
        "help",
      );
      const labels = helpItems.map((item) => item.label ?? item.type);
      const aboutIndex = labels.indexOf("About PwrAgent");
      const settingsIndex = labels.indexOf("Settings…");
      expect(aboutIndex).toBeGreaterThanOrEqual(0);
      expect(settingsIndex).toBeGreaterThan(aboutIndex);
      // About → separator → Settings… → separator → Check for Updates …
      expect(helpItems[aboutIndex + 1]?.type).toBe("separator");
      expect(helpItems[settingsIndex + 1]?.type).toBe("separator");
    });

    it("does NOT add Settings to the PwrAgent menu on non-Mac (no app menu there)", () => {
      const template = buildTemplate(false, { isMac: false });
      const appMenu = template.find((item) => item.label === "PwrAgent");
      expect(appMenu).toBeUndefined();
    });
  });
});
