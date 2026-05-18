import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import type { DesktopPwrAgentProfileSummary } from "@pwragent/shared";
import { buildApplicationMenuTemplate } from "../menu";

function buildTemplate(
  developerMode: boolean,
  options?: {
    isMac?: boolean;
    openProfile?: (profile: string) => void;
    openProfilesSettings?: () => void;
    openSettings?: () => void;
    profiles?: DesktopPwrAgentProfileSummary[];
  },
): MenuItemConstructorOptions[] {
  return buildApplicationMenuTemplate({
    appName: "PwrAgent",
    developerMode,
    isMac: options?.isMac ?? true,
    profiles: options?.profiles ?? [
      profile("work"),
      profile("default", { active: true, default: true }),
      profile("personal"),
    ],
    actions: {
      checkForUpdates: vi.fn(),
      openDocumentation: vi.fn(),
      openIssueReporter: vi.fn(),
      openProfile: options?.openProfile ?? vi.fn(),
      openProfilesSettings: options?.openProfilesSettings ?? vi.fn(),
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

function profile(
  name: string,
  options: Partial<DesktopPwrAgentProfileSummary> = {},
): DesktopPwrAgentProfileSummary {
  return {
    active: false,
    canDelete: name !== "default",
    codexProfile: {
      codexHome: `/codex/${name}`,
      displayName: name || "default",
      exists: true,
      hasAuthFile: true,
      hasConfigFile: true,
      name: "",
      selected: false,
      source: "default",
    },
    default: false,
    name,
    profileDir: `/profiles/${name}`,
    ...options,
  };
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
  it("places Profiles between View and Window", () => {
    const labels = buildTemplate(false).map((item) => item.label ?? item.role);

    expect(labels).toEqual([
      "PwrAgent",
      "File",
      "editMenu",
      "View",
      "Profiles",
      "windowMenu",
      "help",
    ]);
  });

  it("orders profiles with default pinned, checks the active profile, and assigns first shortcuts", () => {
    const items = submenuItems(buildTemplate(false), "Profiles");
    const profileItems = items.slice(0, 3);

    expect(profileItems.map((item) => item.label)).toEqual([
      "default",
      "personal",
      "work",
    ]);
    expect(profileItems.map((item) => item.type)).toEqual([
      "checkbox",
      "checkbox",
      "checkbox",
    ]);
    expect(profileItems.map((item) => item.checked)).toEqual([
      true,
      false,
      false,
    ]);
    expect(profileItems.map((item) => item.accelerator)).toEqual([
      "CmdOrCtrl+1",
      "CmdOrCtrl+2",
      "CmdOrCtrl+3",
    ]);
  });

  it("routes profile menu clicks through the shared profile opener", () => {
    const openProfile = vi.fn();
    const items = submenuItems(buildTemplate(false, { openProfile }), "Profiles");

    (items.find((item) => item.label === "work")?.click as
      | (() => void)
      | undefined)?.();

    expect(openProfile).toHaveBeenCalledWith("work");
  });

  it("opens the profile settings surface from profile management menu items", () => {
    const openProfilesSettings = vi.fn();
    const items = submenuItems(
      buildTemplate(false, { openProfilesSettings }),
      "Profiles",
    );

    (items.find((item) => item.label === "New Profile…")?.click as
      | (() => void)
      | undefined)?.();
    (items.find((item) => item.label === "Manage Profiles…")?.click as
      | (() => void)
      | undefined)?.();

    expect(openProfilesSettings).toHaveBeenCalledTimes(2);
  });

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
