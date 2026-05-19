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

const log = getMainLogger("pwragent:changelog-window");
const CHANGELOG_HASH = "changelog";

let changelogWindow: BrowserWindow | undefined;

export function showChangelogWindow(): void {
  if (changelogWindow && !changelogWindow.isDestroyed()) {
    if (changelogWindow.isMinimized()) {
      changelogWindow.restore();
    }
    changelogWindow.show();
    changelogWindow.focus();
    return;
  }

  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: "Changelog - PwrAgent",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 18 },
    backgroundColor: themedWindowBackgroundColor(appearance),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: themedWindowAdditionalArguments(appearance),
    },
  });

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

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("closed", () => {
    changelogWindow = undefined;
    log.debug("changelog window closed");
  });

  changelogWindow = window;
  log.debug("changelog window created");
}
