import type { MenuItemConstructorOptions } from "electron";
import {
  profileMenuShortcutDigits,
  type DesktopPwrAgentProfileSummary,
} from "@pwragent/shared";

export type ApplicationMenuFederationPeer = {
  instanceId: string;
  label: string;
};

/**
 * Heading the connected federation peers sit under inside the Profiles
 * menu, and the label of the submenu they collapse into once there are
 * more of them than `MAX_INLINE_FEDERATION_PEERS`.
 */
const REMOTE_INSTANCES_LABEL = "Remote Instances";

/**
 * How many peers stay listed inline before collapsing into a submenu.
 * Five keeps the Profiles menu scannable in the common case (a laptop, a
 * desktop, a couple of build machines) without a second level of clicks.
 */
const MAX_INLINE_FEDERATION_PEERS = 5;

export type ApplicationMenuActions = {
  checkForUpdates: () => void;
  copyLocalDiagnosticsInfo: () => void;
  focusWindow: (windowId: number) => void;
  openDocumentation: () => void | Promise<void>;
  openFederationWindow: (peer: ApplicationMenuFederationPeer) => void;
  openIssueReporter: () => void | Promise<void>;
  /** Settings → Profiles with the create form already open. */
  openNewProfile: () => void;
  openNewThread: () => void;
  openProfile: (profile: string) => void | Promise<void>;
  /** Settings → Profiles, on the list. */
  openProfilesSettings: () => void;
  openSecurityReporter: () => void | Promise<void>;
  openSettings: () => void;
  openSource: () => void | Promise<void>;
  openWebsite: () => void | Promise<void>;
  quit: () => void | Promise<void>;
  replayOnboarding: () => void;
  /** Settings → About, on every platform. */
  showAbout: () => void;
  showChangelogWindow: () => void;
  showLicenseWindow: () => void;
  showLogsWindow: () => void;
  showThirdPartyNoticesWindow: () => void;
  showUsageActivityWindow: () => void;
};

export type ApplicationMenuWindow = {
  focused: boolean;
  id: number;
  title: string;
};

export type ApplicationMenuOptions = {
  appName: string;
  developerMode: boolean;
  isMac: boolean;
  /** Connected federation peers; empty hides the Remote Instances section. */
  federationPeers: ApplicationMenuFederationPeer[];
  profiles: DesktopPwrAgentProfileSummary[];
  windows: ApplicationMenuWindow[];
  actions: ApplicationMenuActions;
};

/**
 * The PwrSuite menu standard (v1), shared with PwrGit and PwrSnap:
 * [App] · File · Edit · View · Profiles · Window · Help. On macOS the app menu
 * holds About, updates, Settings and the account items; elsewhere File holds
 * Settings and the account items and Help ends with updates and About.
 * `menu.test.ts` pins the exact label and separator order per platform.
 */
export function buildApplicationMenuTemplate(
  options: ApplicationMenuOptions,
): MenuItemConstructorOptions[] {
  return [
    ...(options.isMac ? [buildMacAppMenu(options)] : []),
    buildFileMenu(options),
    { role: "editMenu" },
    buildViewMenu(options),
    buildProfilesMenu(options),
    buildWindowMenu(options),
    buildHelpMenu(options),
  ];
}

function buildMacAppMenu(
  options: ApplicationMenuOptions,
): MenuItemConstructorOptions {
  return {
    label: options.appName,
    submenu: [
      {
        label: `About ${options.appName}`,
        click: options.actions.showAbout,
      },
      {
        label: "Check for Updates…",
        click: options.actions.checkForUpdates,
      },
      { type: "separator" },
      ...buildSettingsItems(options),
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      {
        label: `Quit ${options.appName}`,
        accelerator: "Command+Q",
        click: () => {
          void options.actions.quit();
        },
      },
    ],
  };
}

/**
 * Settings and the account items. They sit in the macOS app menu and at the
 * same place in File elsewhere, so an operator who switches platforms finds
 * them in the same group.
 */
function buildSettingsItems(
  options: ApplicationMenuOptions,
): MenuItemConstructorOptions[] {
  return [
    {
      label: "Settings…",
      accelerator: "CmdOrCtrl+,",
      click: options.actions.openSettings,
    },
    // Account limits and spend across instances. It sits beside Settings
    // because it is about the account, not about any one window.
    {
      label: "Usage Activity",
      click: options.actions.showUsageActivityWindow,
    },
  ];
}

function buildFileMenu(options: ApplicationMenuOptions): MenuItemConstructorOptions {
  return {
    label: "File",
    submenu: [
      {
        label: "New Thread",
        accelerator: "CmdOrCtrl+N",
        click: options.actions.openNewThread,
      },
      { type: "separator" },
      ...(options.isMac
        ? []
        : [...buildSettingsItems(options), { type: "separator" as const }]),
      { role: "close", label: "Close Window" },
      ...(options.isMac
        ? []
        : [
            {
              label: "Quit",
              accelerator: "CmdOrCtrl+Q",
              click: () => {
                void options.actions.quit();
              },
            },
          ]),
    ],
  };
}

function buildViewMenu(options: ApplicationMenuOptions): MenuItemConstructorOptions {
  return {
    label: "View",
    submenu: [
      // Recovery must remain reachable when the renderer cannot draw controls.
      { label: "Reload Window", role: "reload" },
      ...(options.developerMode
        ? [
            { role: "forceReload" as const },
            { role: "toggleDevTools" as const },
          ]
        : []),
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      // Kept on macOS too. The standard drops it there only if macOS adds a
      // second one, and it does not: on macOS 26 with Electron 44, a View
      // menu without this item has no full-screen entry at all, and Window
      // gains only Full Screen Tile.
      { role: "togglefullscreen" },
    ],
  };
}

function buildProfilesMenu(options: ApplicationMenuOptions): MenuItemConstructorOptions {
  // `profiles` arrives in the operator's order from Settings → Profiles. A
  // profile switched out of the menu takes no row and no shortcut, so the
  // next shown profile takes its number.
  const shortcutDigits = profileMenuShortcutDigits(options.profiles);
  const profileItems: MenuItemConstructorOptions[] = options.profiles
    .filter((profile) => profile.showInMenu)
    .map((profile) => {
      const digit = shortcutDigits.get(profile.name);
      return {
        label: profile.displayName || profile.name,
        type: "checkbox",
        // Each profile runs in its own process with its own menu bar, so
        // the active profile is the focused window's profile.
        checked: profile.active,
        accelerator: digit === undefined ? undefined : `CmdOrCtrl+${digit}`,
        click: () => {
          void options.actions.openProfile(profile.name);
        },
      };
    });

  // Local profiles, then Remote Instances, then New/Manage. An empty group
  // takes its separator with it: every profile can be switched out of the
  // menu, and an operator who never paired an instance sees no heading.
  const groups = [
    profileItems,
    buildFederationPeerItems(options),
    [
      {
        label: "New Profile…",
        click: options.actions.openNewProfile,
      },
      {
        label: "Manage Profiles…",
        click: options.actions.openProfilesSettings,
      },
    ],
  ].filter((group) => group.length > 0);

  return {
    label: "Profiles",
    submenu: groups.flatMap((group, index) =>
      index === 0 ? group : [{ type: "separator" as const }, ...group],
    ),
  };
}

/**
 * Connected peers live with the local profiles because that is what a
 * peer is to an operator: another place their work runs, addressed the
 * same "<machine> / <profile>" way. They open a remote window instead of
 * switching this window's profile, so they sit under their own heading
 * rather than merging into the checkbox list above.
 *
 * Returns nothing when no peer is connected.
 */
function buildFederationPeerItems(
  options: ApplicationMenuOptions,
): MenuItemConstructorOptions[] {
  if (options.federationPeers.length === 0) {
    return [];
  }

  const peerItems: MenuItemConstructorOptions[] = orderPeersForMenu(
    options.federationPeers,
  ).map((peer) => ({
    label: peer.label,
    click: () => {
      options.actions.openFederationWindow(peer);
    },
  }));

  return [
    // Past the inline budget the flat list crowds out the local profiles
    // it sits under, so the same heading becomes the submenu that holds
    // them. The heading label stays put either way — an operator hunting
    // for a peer looks in the same place at three peers and at thirty.
    ...(peerItems.length > MAX_INLINE_FEDERATION_PEERS
      ? [{ label: REMOTE_INSTANCES_LABEL, submenu: peerItems }]
      : [{ label: REMOTE_INSTANCES_LABEL, enabled: false }, ...peerItems]),
  ];
}

function buildWindowMenu(options: ApplicationMenuOptions): MenuItemConstructorOptions {
  if (options.isMac) {
    return { role: "windowMenu" };
  }

  const windowItems: MenuItemConstructorOptions[] = options.windows.length
    ? options.windows.map((window) => ({
        label: window.title || "Untitled Window",
        click: () => {
          options.actions.focusWindow(window.id);
        },
      }))
    : [
        {
          label: "No Open Windows",
          enabled: false,
        },
      ];

  return {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "close" },
      { type: "separator" },
      ...windowItems,
    ],
  };
}

/**
 * Peers arrive in `connectedPeerTargets()` order, which is a Map walk over
 * the gateway directory, the stored peers, then connection-only peers —
 * an order that survives neither a directory re-announcement nor a
 * federation restart. The menu rebuilds on every peer status change, so
 * leaving that order alone would let rows swap under the pointer and turn
 * a muscle-memory click into the wrong machine's remote window. Sort by
 * label, with the instance id breaking ties so two identically labelled
 * peers hold still too. Local profiles keep the operator's own order; peers
 * have no order to keep, because they come and go with connectivity.
 */
function orderPeersForMenu(
  peers: ApplicationMenuFederationPeer[],
): ApplicationMenuFederationPeer[] {
  return [...peers].sort(
    (left, right) =>
      left.label.localeCompare(right.label)
      || left.instanceId.localeCompare(right.instanceId),
  );
}

function buildHelpMenu(options: ApplicationMenuOptions): MenuItemConstructorOptions {
  return {
    role: "help",
    submenu: [
      {
        label: `${options.appName} Documentation`,
        click: options.actions.openDocumentation,
      },
      {
        label: "Changelog",
        click: options.actions.showChangelogWindow,
      },
      {
        label: "Replay Onboarding…",
        click: options.actions.replayOnboarding,
      },
      { type: "separator" },
      {
        label: "Report an Issue…",
        click: options.actions.openIssueReporter,
      },
      {
        label: "Report a Security Vulnerability…",
        click: options.actions.openSecurityReporter,
      },
      {
        label: "Copy Diagnostics Info",
        click: options.actions.copyLocalDiagnosticsInfo,
      },
      // No accelerator: PwrSnap owns ⇧⌘L across the suite.
      {
        label: "Logs",
        click: options.actions.showLogsWindow,
      },
      { type: "separator" },
      {
        label: `${options.appName} Website`,
        click: options.actions.openWebsite,
      },
      {
        label: "View Source",
        click: options.actions.openSource,
      },
      { type: "separator" },
      {
        label: "View License",
        click: options.actions.showLicenseWindow,
      },
      {
        label: "Third-Party Notices",
        click: options.actions.showThirdPartyNoticesWindow,
      },
      // macOS keeps these in the app menu. Elsewhere Help is their home, and
      // About closes the menu, as it does across the suite.
      ...(options.isMac
        ? []
        : [
            { type: "separator" as const },
            {
              label: "Check for Updates…",
              click: options.actions.checkForUpdates,
            },
            {
              label: `About ${options.appName}`,
              click: options.actions.showAbout,
            },
          ]),
    ],
  };
}
