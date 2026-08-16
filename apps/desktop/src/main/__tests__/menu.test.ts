import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import type { DesktopPwrAgentProfileSummary } from "@pwragent/shared";
import { buildApplicationMenuTemplate } from "../menu";

function buildTemplate(
  developerMode: boolean,
  options?: {
    isMac?: boolean;
    copyLocalDiagnosticsInfo?: () => void;
    federationPeers?: Array<{ instanceId: string; label: string }>;
    openFederationWindow?: (peer: {
      instanceId: string;
      label: string;
    }) => void;
    openNewThread?: () => void;
    openProfile?: (profile: string) => void;
    openProfilesSettings?: () => void;
    openSettings?: () => void;
    profiles?: DesktopPwrAgentProfileSummary[];
    windows?: Array<{
      focused: boolean;
      id: number;
      title: string;
    }>;
  },
): MenuItemConstructorOptions[] {
  return buildApplicationMenuTemplate({
    appName: "PwrAgent",
    developerMode,
    isMac: options?.isMac ?? true,
    federationPeers: options?.federationPeers ?? [],
    profiles: options?.profiles ?? [
      profile("work"),
      profile("default", { active: true, default: true }),
      profile("personal"),
    ],
    windows: options?.windows ?? [
      { focused: true, id: 1, title: "PwrAgent" },
      { focused: false, id: 2, title: "Logs" },
    ],
    actions: {
      checkForUpdates: vi.fn(),
      copyLocalDiagnosticsInfo: options?.copyLocalDiagnosticsInfo ?? vi.fn(),
      focusWindow: vi.fn(),
      openDocumentation: vi.fn(),
      openFederationWindow: options?.openFederationWindow ?? vi.fn(),
      openIssueReporter: vi.fn(),
      openNewThread: options?.openNewThread ?? vi.fn(),
      openProfile: options?.openProfile ?? vi.fn(),
      openProfilesSettings: options?.openProfilesSettings ?? vi.fn(),
      openSettings: options?.openSettings ?? vi.fn(),
      openWebsite: vi.fn(),
      quit: vi.fn(),
      replayOnboarding: vi.fn(),
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

  describe("New Thread menu item", () => {
    it("places New Thread at the top of File with CmdOrCtrl+N", () => {
      const items = submenuItems(buildTemplate(false), "File");

      expect(items[0]?.label).toBe("New Thread");
      expect(items[0]?.accelerator).toBe("CmdOrCtrl+N");
      expect(items[1]?.type).toBe("separator");
      expect(items[2]?.role).toBe("close");
    });

    it("invokes the openNewThread action on click", () => {
      const openNewThread = vi.fn();
      const items = submenuItems(buildTemplate(false, { openNewThread }), "File");

      (items.find((item) => item.label === "New Thread")?.click as
        | (() => void)
        | undefined)?.();

      expect(openNewThread).toHaveBeenCalledOnce();
    });

    it("keeps Quit available on non-Mac platforms after inserting New Thread", () => {
      const items = submenuItems(buildTemplate(false, { isMac: false }), "File");

      expect(items.map((item) => item.label ?? item.role ?? item.type)).toEqual([
        "New Thread",
        "separator",
        "close",
        "separator",
        "Quit",
      ]);
    });
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

    it("routes macOS Quit through the shared quit action", () => {
      const quit = vi.fn();
      const template = buildApplicationMenuTemplate({
        appName: "PwrAgent",
        developerMode: false,
        isMac: true,
        federationPeers: [],
        profiles: [],
        windows: [],
        actions: {
          checkForUpdates: vi.fn(),
          copyLocalDiagnosticsInfo: vi.fn(),
          focusWindow: vi.fn(),
          openDocumentation: vi.fn(),
          openFederationWindow: vi.fn(),
          openIssueReporter: vi.fn(),
          openNewThread: vi.fn(),
          openProfile: vi.fn(),
          openProfilesSettings: vi.fn(),
          openSettings: vi.fn(),
          openWebsite: vi.fn(),
          quit,
          replayOnboarding: vi.fn(),
          showAboutPanel: vi.fn(),
          showChangelogWindow: vi.fn(),
          showLicenseWindow: vi.fn(),
          showLogsWindow: vi.fn(),
          showThirdPartyNoticesWindow: vi.fn(),
        },
      });
      const quitItem = submenuItems(template, "PwrAgent").find(
        (item) => item.label === "Quit PwrAgent",
      );

      expect(quitItem?.accelerator).toBe("Command+Q");
      (quitItem?.click as () => void | undefined)?.();
      expect(quit).toHaveBeenCalledOnce();
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

  it("routes Help → Copy Local Diagnostics Info through the shared action", () => {
    const copyLocalDiagnosticsInfo = vi.fn();
    const items = findSubmenuByRole(
      buildTemplate(false, { copyLocalDiagnosticsInfo }),
      "help",
    );

    (items.find((item) => item.label === "Copy Local Diagnostics Info")?.click as
      | (() => void)
      | undefined)?.();

    expect(copyLocalDiagnosticsInfo).toHaveBeenCalledOnce();
  });

  describe("Window menu", () => {
    it("keeps the native Window menu role on macOS", () => {
      const windowMenu = buildTemplate(false).find(
        (item) => item.role === "windowMenu",
      );

      expect(windowMenu).toBeDefined();
    });

    it("lists open windows on non-Mac platforms", () => {
      const items = submenuItems(buildTemplate(false, { isMac: false }), "Window");

      expect(items.map((item) => item.label ?? item.role ?? item.type)).toEqual([
        "minimize",
        "close",
        "separator",
        "PwrAgent",
        "Logs",
      ]);
      expect(items[3]?.type).toBeUndefined();
      expect(items[3]?.checked).toBeUndefined();
      expect(items[4]?.type).toBeUndefined();
      expect(items[4]?.checked).toBeUndefined();
    });

    it("shows an empty state when no windows are open on non-Mac platforms", () => {
      const items = submenuItems(
        buildTemplate(false, { isMac: false, windows: [] }),
        "Window",
      );

      expect(items.at(-1)?.label).toBe("No Open Windows");
      expect(items.at(-1)?.enabled).toBe(false);
    });
  });

  describe("federation remote instances", () => {
    function peer(index: number): { instanceId: string; label: string } {
      return {
        instanceId: `pwr_peer_${index}`,
        label: `Studio-Mac-${index} / default`,
      };
    }

    function peers(count: number): Array<{ instanceId: string; label: string }> {
      return Array.from({ length: count }, (_unused, index) => peer(index + 1));
    }

    it("shows no Remote Instances section when no peers are connected", () => {
      const items = submenuItems(buildTemplate(false), "Profiles");

      expect(items.some((item) => item.label === "Remote Instances")).toBe(false);
    });

    it("keeps the File menu free of federation entries", () => {
      const items = submenuItems(
        buildTemplate(false, { federationPeers: peers(1) }),
        "File",
      );

      expect(items.map((item) => item.label ?? item.role ?? item.type)).toEqual([
        "New Thread",
        "separator",
        "close",
      ]);
    });

    it("lists peers under the local profiles and routes clicks to openFederationWindow", () => {
      const openFederationWindow = vi.fn();
      const items = submenuItems(
        buildTemplate(false, {
          federationPeers: peers(2),
          openFederationWindow,
        }),
        "Profiles",
      );

      expect(items.map((item) => item.label ?? item.type)).toEqual([
        "default",
        "personal",
        "work",
        "separator",
        "Remote Instances",
        "Studio-Mac-1 / default",
        "Studio-Mac-2 / default",
        "separator",
        "New Profile…",
        "Manage Profiles…",
      ]);
      // The heading is a label, not a target: it must not be clickable and
      // must not carry the peers as a submenu at this count.
      const heading = items.find((item) => item.label === "Remote Instances");
      expect(heading?.enabled).toBe(false);
      expect(heading?.submenu).toBeUndefined();

      (items.find((item) => item.label === "Studio-Mac-2 / default")?.click as
        | (() => void)
        | undefined)?.();

      expect(openFederationWindow).toHaveBeenCalledWith(peer(2));
    });

    it("sorts peers by label so a rebuild cannot swap rows under the pointer", () => {
      // connectedPeerTargets() walks the gateway directory, then stored
      // peers, then connection-only peers — an order that changes across a
      // directory re-announcement or a federation restart, both of which
      // rebuild this menu.
      const items = submenuItems(
        buildTemplate(false, {
          federationPeers: [
            { instanceId: "pwr_c", label: "Studio-Mac-3 / dev" },
            { instanceId: "pwr_a", label: "Studio-Mac-1 / default" },
            { instanceId: "pwr_b2", label: "Studio-Mac-2 / default" },
            { instanceId: "pwr_b1", label: "Studio-Mac-2 / default" },
          ],
          openFederationWindow: vi.fn(),
        }),
        "Profiles",
      );
      const headingIndex = items.findIndex(
        (item) => item.label === "Remote Instances",
      );

      expect(
        items.slice(headingIndex + 1, headingIndex + 5).map((item) => item.label),
      ).toEqual([
        "Studio-Mac-1 / default",
        "Studio-Mac-2 / default",
        "Studio-Mac-2 / default",
        "Studio-Mac-3 / dev",
      ]);
    });

    it("breaks label ties by instance id so duplicate labels hold still", () => {
      const openFederationWindow = vi.fn();
      const items = submenuItems(
        buildTemplate(false, {
          federationPeers: [
            { instanceId: "pwr_b2", label: "Studio-Mac / default" },
            { instanceId: "pwr_b1", label: "Studio-Mac / default" },
          ],
          openFederationWindow,
        }),
        "Profiles",
      );
      const headingIndex = items.findIndex(
        (item) => item.label === "Remote Instances",
      );

      (items[headingIndex + 1]?.click as (() => void) | undefined)?.();

      expect(openFederationWindow).toHaveBeenCalledWith({
        instanceId: "pwr_b1",
        label: "Studio-Mac / default",
      });
    });

    it("keeps five peers inline", () => {
      const items = submenuItems(
        buildTemplate(false, { federationPeers: peers(5) }),
        "Profiles",
      );
      const headingIndex = items.findIndex(
        (item) => item.label === "Remote Instances",
      );

      expect(items[headingIndex]?.enabled).toBe(false);
      expect(
        items.slice(headingIndex + 1, headingIndex + 6).map((item) => item.label),
      ).toEqual(peers(5).map((entry) => entry.label));
    });

    it("collapses past five peers into a Remote Instances submenu", () => {
      const openFederationWindow = vi.fn();
      const items = submenuItems(
        buildTemplate(false, {
          federationPeers: peers(6),
          openFederationWindow,
        }),
        "Profiles",
      );

      expect(items.map((item) => item.label ?? item.type)).toEqual([
        "default",
        "personal",
        "work",
        "separator",
        "Remote Instances",
        "separator",
        "New Profile…",
        "Manage Profiles…",
      ]);
      const remoteInstances = items.find(
        (item) => item.label === "Remote Instances",
      );
      expect(remoteInstances?.enabled).toBeUndefined();
      const peerItems = Array.isArray(remoteInstances?.submenu)
        ? remoteInstances.submenu
        : [];
      expect(peerItems.map((item) => item.label)).toEqual(
        peers(6).map((entry) => entry.label),
      );

      (peerItems.at(-1)?.click as (() => void) | undefined)?.();

      expect(openFederationWindow).toHaveBeenCalledWith(peer(6));
    });
  });
});
