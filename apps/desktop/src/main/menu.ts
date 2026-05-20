import type { MenuItemConstructorOptions } from "electron";
import type { DesktopPwrAgentProfileSummary } from "@pwragent/shared";

export type ApplicationMenuActions = {
  checkForUpdates: () => void;
  openDocumentation: () => void | Promise<void>;
  openIssueReporter: () => void | Promise<void>;
  openProfile: (profile: string) => void | Promise<void>;
  openProfilesSettings: () => void;
  openSettings: () => void;
  openWebsite: () => void | Promise<void>;
  replayOnboarding: () => void;
  showAboutPanel: () => void;
  showChangelogWindow: () => void;
  showLicenseWindow: () => void;
  showLogsWindow: () => void;
  showThirdPartyNoticesWindow: () => void;
};

export type ApplicationMenuOptions = {
  appName: string;
  developerMode: boolean;
  isMac: boolean;
  profiles: DesktopPwrAgentProfileSummary[];
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
    { role: "windowMenu" },
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
      { role: "quit" },
    ],
  };
}

function buildFileMenu(options: ApplicationMenuOptions): MenuItemConstructorOptions {
  return {
    label: "File",
    submenu: [
      { role: "close" },
      ...(options.isMac
        ? []
        : [{ type: "separator" as const }, { role: "quit" as const }]),
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
