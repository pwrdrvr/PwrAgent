import type { MenuItemConstructorOptions } from "electron";

export type ApplicationMenuActions = {
  checkForUpdates: () => void;
  openDocumentation: () => void | Promise<void>;
  openIssueReporter: () => void | Promise<void>;
  openSettings: () => void;
  openWebsite: () => void | Promise<void>;
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
