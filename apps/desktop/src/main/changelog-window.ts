import { BrowserWindow } from "electron";
import { getMainLogger } from "./log";
import {
  applyWindowSecurityHardening,
  getPreloadPath,
  getRendererEntry,
} from "./window";
import {
  WINDOW_KIND_CHANGELOG,
  registerWindowChannels,
} from "./window-channels";
import { APPEARANCE_CHANGED_EVENT_CHANNEL } from "../shared/ipc";
import {
  readBootstrapAppearance,
  themedWindowAdditionalArguments,
  themedWindowBackgroundColor,
} from "./settings/appearance-bootstrap";
import {
  auxiliaryWindowChromeOptions,
  hideAuxiliaryWindowMenuBar,
  registerAuxiliaryWindowTitle,
  showAndFocusAuxiliaryWindow,
  showAuxiliaryWindowWhenReady,
} from "./auxiliary-window-chrome";
import {
  auxiliaryWindowPlacementOptions,
  positionAuxiliaryWindowOnSourceDisplay,
} from "./auxiliary-window-placement";

const log = getMainLogger("pwragent:changelog-window");
const CHANGELOG_HASH = "changelog";
const CHANGELOG_WINDOW_TITLE = "Changelog";
const CHANGELOG_WINDOW_WIDTH = 920;
const CHANGELOG_WINDOW_HEIGHT = 760;

let changelogWindow: BrowserWindow | undefined;

export function showChangelogWindow(): void {
  if (changelogWindow && !changelogWindow.isDestroyed()) {
    positionAuxiliaryWindowOnSourceDisplay(changelogWindow);
    showAndFocusAuxiliaryWindow(changelogWindow);
    return;
  }

  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    ...auxiliaryWindowPlacementOptions(
      CHANGELOG_WINDOW_WIDTH,
      CHANGELOG_WINDOW_HEIGHT,
    ),
    width: CHANGELOG_WINDOW_WIDTH,
    height: CHANGELOG_WINDOW_HEIGHT,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: CHANGELOG_WINDOW_TITLE,
    ...auxiliaryWindowChromeOptions(),
    backgroundColor: themedWindowBackgroundColor(appearance),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: themedWindowAdditionalArguments(appearance),
    },
  });
  registerAuxiliaryWindowTitle(window, CHANGELOG_WINDOW_TITLE);
  hideAuxiliaryWindowMenuBar(window);

  applyWindowSecurityHardening(window);
  registerWindowChannels(window, WINDOW_KIND_CHANGELOG, [
    APPEARANCE_CHANGED_EVENT_CHANNEL,
  ]);

  const rendererEntry = getRendererEntry();
  if (rendererEntry.kind === "url") {
    void window.loadURL(`${rendererEntry.value}#${CHANGELOG_HASH}`);
  } else {
    void window.loadFile(rendererEntry.value, { hash: CHANGELOG_HASH });
  }

  showAuxiliaryWindowWhenReady(window);

  window.on("closed", () => {
    changelogWindow = undefined;
    log.debug("changelog window closed");
  });

  changelogWindow = window;
  log.debug("changelog window created");
}
