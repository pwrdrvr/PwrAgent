import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import type { DesktopPwrAgentProfileSummary } from "@pwragent/shared";
import {
  buildApplicationMenuTemplate,
  type ApplicationMenuActions,
} from "../menu";

function buildTemplate(
  developerMode: boolean,
  options?: {
    isMac?: boolean;
    actions?: Partial<ApplicationMenuActions>;
    federationPeers?: Array<{ instanceId: string; label: string }>;
    openFederationWindow?: (peer: {
      instanceId: string;
      label: string;
    }) => void;
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
      profile("default", { active: true, default: true }),
      profile("personal"),
      profile("work"),
    ],
    windows: options?.windows ?? [
      { focused: true, id: 1, title: "PwrAgent" },
      { focused: false, id: 2, title: "Logs" },
    ],
    actions: {
      checkForUpdates: vi.fn(),
      copyLocalDiagnosticsInfo: vi.fn(),
      focusWindow: vi.fn(),
      openDocumentation: vi.fn(),
      openFederationWindow: options?.openFederationWindow ?? vi.fn(),
      openIssueReporter: vi.fn(),
      openNewProfile: vi.fn(),
      openNewThread: vi.fn(),
      openProfile: vi.fn(),
      openProfilesSettings: vi.fn(),
      openSecurityReporter: vi.fn(),
      openSettings: vi.fn(),
      openSource: vi.fn(),
      openWebsite: vi.fn(),
      quit: vi.fn(),
      replayOnboarding: vi.fn(),
      showAbout: vi.fn(),
      showChangelogWindow: vi.fn(),
      showLicenseWindow: vi.fn(),
      showLogsWindow: vi.fn(),
      showThirdPartyNoticesWindow: vi.fn(),
      showUsageActivityWindow: vi.fn(),
      ...options?.actions,
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
    showInMenu: true,
    ...options,
  };
}

/** A menu item as the standard names it: its label, else its role. */
function nameOf(item: MenuItemConstructorOptions): string {
  return item.label ?? `role:${item.role ?? "?"}`;
}

/** Labels, roles and separators in order — the shape the standard pins. */
function flatten(items: MenuItemConstructorOptions[]): string[] {
  return items.map((item) => (item.type === "separator" ? "---" : nameOf(item)));
}

function submenuItems(
  template: MenuItemConstructorOptions[],
  name: string,
): MenuItemConstructorOptions[] {
  const menu = template.find((item) => nameOf(item) === name);
  return Array.isArray(menu?.submenu) ? menu.submenu : [];
}

function allItems(
  items: MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? allItems(item.submenu) : []),
  ]);
}

function click(
  items: MenuItemConstructorOptions[],
  label: string,
): void {
  const item = items.find((candidate) => candidate.label === label);
  if (!item) {
    throw new Error(`Menu item not found: ${label}`);
  }
  (item.click as (() => void) | undefined)?.();
}

const HELP_SHARED = [
  "PwrAgent Documentation",
  "Changelog",
  "Replay Onboarding…",
  "---",
  "Report an Issue…",
  "Report a Security Vulnerability…",
  "Copy Diagnostics Info",
  "Logs",
  "---",
  "PwrAgent Website",
  "View Source",
  "---",
  "View License",
  "Third-Party Notices",
];

describe("buildApplicationMenuTemplate", () => {
  // The PwrSuite menu standard (v1). PwrGit and PwrSnap pin the same order
  // in their own menu tests; a change here is a change to the suite standard.
  describe("PwrSuite menu standard on macOS", () => {
    const template = buildTemplate(false, { isMac: true });

    it("orders the menu bar", () => {
      expect(template.map(nameOf)).toEqual([
        "PwrAgent",
        "File",
        "role:editMenu",
        "View",
        "Profiles",
        "role:windowMenu",
        "role:help",
      ]);
    });

    it("pins the app menu", () => {
      expect(flatten(submenuItems(template, "PwrAgent"))).toEqual([
        "About PwrAgent",
        "Check for Updates…",
        "---",
        "Settings…",
        "Usage Activity",
        "---",
        "role:services",
        "---",
        "role:hide",
        "role:hideOthers",
        "role:unhide",
        "---",
        "Quit PwrAgent",
      ]);
    });

    it("pins File", () => {
      expect(flatten(submenuItems(template, "File"))).toEqual([
        "New Thread",
        "---",
        "Close Window",
      ]);
    });

    it("pins View, keeping the one full-screen item", () => {
      // Decision E: drop the stock item on macOS only if macOS adds its own.
      // It does not, so this is the only full-screen entry the menu bar has.
      expect(flatten(submenuItems(template, "View"))).toEqual([
        "Reload Window",
        "---",
        "role:resetZoom",
        "role:zoomIn",
        "role:zoomOut",
        "---",
        "role:togglefullscreen",
      ]);
    });

    it("pins Help", () => {
      expect(flatten(submenuItems(template, "role:help"))).toEqual(HELP_SHARED);
    });
  });

  describe("PwrSuite menu standard on Linux and Windows", () => {
    const template = buildTemplate(false, { isMac: false });

    it("orders the menu bar", () => {
      expect(template.map(nameOf)).toEqual([
        "File",
        "role:editMenu",
        "View",
        "Profiles",
        "Window",
        "role:help",
      ]);
    });

    it("pins File", () => {
      expect(flatten(submenuItems(template, "File"))).toEqual([
        "New Thread",
        "---",
        "Settings…",
        "Usage Activity",
        "---",
        "Close Window",
        "Quit",
      ]);
    });

    it("pins View", () => {
      expect(flatten(submenuItems(template, "View"))).toEqual([
        "Reload Window",
        "---",
        "role:resetZoom",
        "role:zoomIn",
        "role:zoomOut",
        "---",
        "role:togglefullscreen",
      ]);
    });

    it("pins Window with the open windows", () => {
      expect(flatten(submenuItems(template, "Window"))).toEqual([
        "role:minimize",
        "role:close",
        "---",
        "PwrAgent",
        "Logs",
      ]);
    });

    it("pins Help, ending with updates and then About", () => {
      expect(flatten(submenuItems(template, "role:help"))).toEqual([
        ...HELP_SHARED,
        "---",
        "Check for Updates…",
        "About PwrAgent",
      ]);
    });
  });

  it.each([true, false])("pins the shared Profiles menu (isMac: %s)", (isMac) => {
    expect(
      flatten(submenuItems(buildTemplate(false, { isMac }), "Profiles")),
    ).toEqual([
      "default",
      "personal",
      "work",
      "---",
      "New Profile…",
      "Manage Profiles…",
    ]);
  });

  it.each([true, false])(
    "adds Force Reload and Toggle Developer Tools only in Developer Mode (isMac: %s)",
    (isMac) => {
      const view = flatten(submenuItems(buildTemplate(true, { isMac }), "View"));

      expect(view.slice(0, 4)).toEqual([
        "Reload Window",
        "role:forceReload",
        "role:toggleDevTools",
        "---",
      ]);
      expect(
        flatten(submenuItems(buildTemplate(false, { isMac }), "View")),
      ).not.toContain("role:forceReload");
    },
  );

  it.each([true, false])("keeps the standard's accelerators (isMac: %s)", (isMac) => {
    const items = allItems(buildTemplate(false, { isMac }));
    const accelerator = (label: string) =>
      items.find((item) => item.label === label)?.accelerator;

    expect(accelerator("Settings…")).toBe("CmdOrCtrl+,");
    expect(accelerator("New Thread")).toBe("CmdOrCtrl+N");
    expect(accelerator(isMac ? "Quit PwrAgent" : "Quit")).toBe(
      isMac ? "Command+Q" : "CmdOrCtrl+Q",
    );
    // PwrSnap owns ⇧⌘L across the suite.
    expect(accelerator("Logs")).toBeUndefined();
    expect(
      items.filter((item) => item.accelerator === "CmdOrCtrl+Shift+L"),
    ).toEqual([]);
  });

  it("keeps Reload Window and Close Window on their roles", () => {
    const items = allItems(buildTemplate(false, { isMac: false }));

    expect(items.find((item) => item.label === "Reload Window")?.role).toBe(
      "reload",
    );
    expect(items.find((item) => item.label === "Close Window")?.role).toBe(
      "close",
    );
  });

  it.each([true, false])("routes the standard's items to their actions (isMac: %s)", (isMac) => {
    const actions = {
      checkForUpdates: vi.fn(),
      copyLocalDiagnosticsInfo: vi.fn(),
      openDocumentation: vi.fn(),
      openIssueReporter: vi.fn(),
      openSecurityReporter: vi.fn(),
      openSettings: vi.fn(),
      openSource: vi.fn(),
      openWebsite: vi.fn(),
      quit: vi.fn(),
      replayOnboarding: vi.fn(),
      showAbout: vi.fn(),
      showLogsWindow: vi.fn(),
      showUsageActivityWindow: vi.fn(),
    };
    // No window titled "Logs", or the Window menu's row for it answers first.
    const items = allItems(
      buildTemplate(false, {
        isMac,
        actions,
        windows: [{ focused: true, id: 1, title: "PwrAgent" }],
      }),
    );

    click(items, "About PwrAgent");
    click(items, "Check for Updates…");
    click(items, "Settings…");
    click(items, "Usage Activity");
    click(items, "PwrAgent Documentation");
    click(items, "Replay Onboarding…");
    click(items, "Report an Issue…");
    click(items, "Report a Security Vulnerability…");
    click(items, "Copy Diagnostics Info");
    click(items, "Logs");
    click(items, "PwrAgent Website");
    click(items, "View Source");
    click(items, isMac ? "Quit PwrAgent" : "Quit");

    for (const action of Object.values(actions)) {
      expect(action).toHaveBeenCalledOnce();
    }
  });

  describe("Profiles", () => {
    it("lists profiles in the operator's order, not default-first or alphabetical", () => {
      const items = submenuItems(
        buildTemplate(false, {
          profiles: [
            profile("work"),
            profile("default", { active: true, default: true }),
            profile("alpha"),
          ],
        }),
        "Profiles",
      );

      expect(flatten(items).slice(0, 3)).toEqual(["work", "default", "alpha"]);
      expect(items.slice(0, 3).map((item) => item.type)).toEqual([
        "checkbox",
        "checkbox",
        "checkbox",
      ]);
      // The check marks the profile this process — so every window of this
      // menu bar — runs.
      expect(items.slice(0, 3).map((item) => item.checked)).toEqual([
        false,
        true,
        false,
      ]);
    });

    it("gives the first nine shown profiles ⌘1–⌘9 and the rest no shortcut", () => {
      const profiles = Array.from({ length: 11 }, (_unused, index) =>
        profile(`p${index + 1}`),
      );
      const items = submenuItems(buildTemplate(false, { profiles }), "Profiles");

      expect(items.slice(0, 11).map((item) => item.accelerator)).toEqual([
        "CmdOrCtrl+1",
        "CmdOrCtrl+2",
        "CmdOrCtrl+3",
        "CmdOrCtrl+4",
        "CmdOrCtrl+5",
        "CmdOrCtrl+6",
        "CmdOrCtrl+7",
        "CmdOrCtrl+8",
        "CmdOrCtrl+9",
        undefined,
        undefined,
      ]);
    });

    it("gives a hidden profile no row and passes its number to the next shown one", () => {
      const items = submenuItems(
        buildTemplate(false, {
          profiles: [
            profile("default", { active: true }),
            profile("scratch", { showInMenu: false }),
            profile("work"),
          ],
        }),
        "Profiles",
      );

      expect(flatten(items)).toEqual([
        "default",
        "work",
        "---",
        "New Profile…",
        "Manage Profiles…",
      ]);
      expect(items.slice(0, 2).map((item) => item.accelerator)).toEqual([
        "CmdOrCtrl+1",
        "CmdOrCtrl+2",
      ]);
    });

    it("drops the separator when every profile is hidden", () => {
      const items = submenuItems(
        buildTemplate(false, {
          profiles: [profile("default", { active: true, showInMenu: false })],
        }),
        "Profiles",
      );

      expect(flatten(items)).toEqual(["New Profile…", "Manage Profiles…"]);
    });

    it("routes profile rows through the shared profile opener", () => {
      const openProfile = vi.fn();
      const items = submenuItems(
        buildTemplate(false, { actions: { openProfile } }),
        "Profiles",
      );

      click(items, "work");

      expect(openProfile).toHaveBeenCalledWith("work");
    });

    it("opens the create form from New Profile… and the list from Manage Profiles…", () => {
      const openNewProfile = vi.fn();
      const openProfilesSettings = vi.fn();
      const items = submenuItems(
        buildTemplate(false, {
          actions: { openNewProfile, openProfilesSettings },
        }),
        "Profiles",
      );

      click(items, "New Profile…");
      expect(openNewProfile).toHaveBeenCalledOnce();
      expect(openProfilesSettings).not.toHaveBeenCalled();

      click(items, "Manage Profiles…");
      expect(openProfilesSettings).toHaveBeenCalledOnce();
      expect(openNewProfile).toHaveBeenCalledOnce();
    });
  });

  describe("Window menu", () => {
    it("keeps the native Window menu role on macOS", () => {
      const template = buildTemplate(false, { isMac: true });

      expect(template.find((item) => item.role === "windowMenu")).toBeDefined();
      expect(template.find((item) => item.label === "Window")).toBeUndefined();
    });

    it("focuses an open window from its row on non-Mac platforms", () => {
      const focusWindow = vi.fn();
      const items = submenuItems(
        buildTemplate(false, { isMac: false, actions: { focusWindow } }),
        "Window",
      );

      click(items, "Logs");

      expect(focusWindow).toHaveBeenCalledWith(2);
    });

    it("shows an empty state when no windows are open on non-Mac platforms", () => {
      const items = submenuItems(
        buildTemplate(false, { isMac: false, windows: [] }),
        "Window",
      );

      expect(flatten(items)).toEqual([
        "role:minimize",
        "role:close",
        "---",
        "No Open Windows",
      ]);
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
      // Federation peers belong to Profiles; File stays the standard's.

      expect(flatten(items)).toEqual([
        "New Thread",
        "---",
        "Close Window",
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

      expect(flatten(items)).toEqual([
        "default",
        "personal",
        "work",
        "---",
        "Remote Instances",
        "Studio-Mac-1 / default",
        "Studio-Mac-2 / default",
        "---",
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

    it("leads with Remote Instances when every local profile is hidden", () => {
      const items = submenuItems(
        buildTemplate(false, {
          federationPeers: peers(1),
          profiles: [profile("default", { active: true, showInMenu: false })],
        }),
        "Profiles",
      );

      expect(flatten(items)).toEqual([
        "Remote Instances",
        "Studio-Mac-1 / default",
        "---",
        "New Profile…",
        "Manage Profiles…",
      ]);
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

      expect(flatten(items)).toEqual([
        "default",
        "personal",
        "work",
        "---",
        "Remote Instances",
        "---",
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
