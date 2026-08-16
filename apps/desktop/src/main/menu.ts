import type { MenuItemConstructorOptions } from "electron";
import type { DesktopPwrAgentProfileSummary } from "@pwragent/shared";

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
  openNewThread: () => void;
  openProfile: (profile: string) => void | Promise<void>;
  openProfilesSettings: () => void;
  openSettings: () => void;
  openWebsite: () => void | Promise<void>;
  quit: () => void | Promise<void>;
  replayOnboarding: () => void;
  showAboutPanel: () => void;
  showChangelogWindow: () => void;
  showLicenseWindow: () => void;
  showLogsWindow: () => void;
  showThirdPartyNoticesWindow: () => void;
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

export function buildApplicationMenuTemplate(
  options: ApplicationMenuOptions,
): MenuItemConstructorOptions[] {
  return [
    ...(options.isMac ? [buildMacAppMenu(options)] : []),
    buildFileMenu(options),
    { role: "editMenu" },
    buildViewMenu(options.developerMode),
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
        click: options.actions.showAboutPanel,
      },
      { type: "separator" },
      // "Settings…" sits where macOS users expect it — directly under
      // the About item, separated from About by a divider and from
      // the Services/Hide cluster below by another divider. The "…"
      // suffix is the standard hint that the item opens a configurable
      // surface (mirrors Mail, Safari, System Settings). Mapped to
      // ⌘, by `accelerator: "CmdOrCtrl+,"` which is the universal
      // Mac "preferences" shortcut.
      {
        label: "Settings…",
        accelerator: "CmdOrCtrl+,",
        click: options.actions.openSettings,
      },
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
      { role: "close" },
      ...(options.isMac
        ? []
        : [
            { type: "separator" as const },
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

function buildViewMenu(developerMode: boolean): MenuItemConstructorOptions {
  return {
    label: "View",
    submenu: [
      ...(developerMode
        ? [
            { role: "reload" as const },
            { role: "forceReload" as const },
            { role: "toggleDevTools" as const },
            { type: "separator" as const },
          ]
        : []),
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
}

function buildProfilesMenu(options: ApplicationMenuOptions): MenuItemConstructorOptions {
  const profiles = orderProfilesForMenu(options.profiles);
  const profileItems: MenuItemConstructorOptions[] = profiles.length
    ? profiles.map((profile, index) => ({
        label: profile.displayName || profile.name,
        type: "checkbox",
        checked: profile.active,
        accelerator: index < 3 ? `CmdOrCtrl+${index + 1}` : undefined,
        click: () => {
          void options.actions.openProfile(profile.name);
        },
      }))
    : [
        {
          label: "No Profiles Found",
          enabled: false,
        },
      ];

  return {
    label: "Profiles",
    submenu: [
      ...profileItems,
      ...buildFederationPeerItems(options),
      { type: "separator" },
      {
        label: "New Profile…",
        click: options.actions.openProfilesSettings,
      },
      {
        label: "Manage Profiles…",
        click: options.actions.openProfilesSettings,
      },
    ],
  };
}

/**
 * Connected peers live with the local profiles because that is what a
 * peer is to an operator: another place their work runs, addressed the
 * same "<machine> / <profile>" way. They open a remote window instead of
 * switching this window's profile, so they sit under their own heading
 * rather than merging into the checkbox list above.
 *
 * Returns nothing when no peer is connected, so an operator who has never
 * paired an instance never sees the heading.
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
    { type: "separator" },
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
 * label, matching the local profiles these rows now sit beside, with the
 * instance id breaking ties so two identically labelled peers hold still
 * too.
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

function orderProfilesForMenu(
  profiles: DesktopPwrAgentProfileSummary[],
): DesktopPwrAgentProfileSummary[] {
  return [...profiles].sort((left, right) => {
    if (left.name === "default") return -1;
    if (right.name === "default") return 1;
    return left.name.localeCompare(right.name);
  });
}

function buildHelpMenu(options: ApplicationMenuOptions): MenuItemConstructorOptions {
  return {
    role: "help",
    submenu: [
      ...(!options.isMac
        ? [
            {
              label: `About ${options.appName}`,
              click: options.actions.showAboutPanel,
            },
            { type: "separator" as const },
            // Non-Mac platforms don't get the macOS app-menu treatment
            // — surface Settings here next to About + its standard
            // shortcut so the menu path stays discoverable.
            {
              label: "Settings…",
              accelerator: "CmdOrCtrl+," as const,
              click: options.actions.openSettings,
            },
            { type: "separator" as const },
          ]
        : []),
      {
        label: "Check for Updates",
        click: options.actions.checkForUpdates,
      },
      {
        label: "Changelog",
        click: options.actions.showChangelogWindow,
      },
      { type: "separator" },
      {
        label: "Documentation",
        click: options.actions.openDocumentation,
      },
      {
        label: "Replay Onboarding…",
        click: options.actions.replayOnboarding,
      },
      {
        label: "Report an Issue",
        click: options.actions.openIssueReporter,
      },
      {
        label: "Copy Local Diagnostics Info",
        click: options.actions.copyLocalDiagnosticsInfo,
      },
      {
        label: "PwrAgent Website",
        click: options.actions.openWebsite,
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
      {
        label: "Logs",
        click: options.actions.showLogsWindow,
      },
    ],
  };
}
