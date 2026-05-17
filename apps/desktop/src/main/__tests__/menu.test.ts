import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { buildApplicationMenuTemplate } from "../menu";

function buildTemplate(developerMode: boolean): MenuItemConstructorOptions[] {
  return buildApplicationMenuTemplate({
    appName: "PwrAgent",
    developerMode,
    isMac: true,
    actions: {
      checkForUpdates: vi.fn(),
      openDocumentation: vi.fn(),
      openIssueReporter: vi.fn(),
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
});
