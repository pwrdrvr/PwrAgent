import { BrowserWindow } from "electron";
import { getMainLogger } from "./log";
import {
  applyWindowSecurityHardening,
  getPreloadPath,
  getRendererEntry,
} from "./window";
import {
  WINDOW_KIND_APP_LOGS,
  registerWindowChannels,
} from "./window-channels";
import {
  APPEARANCE_CHANGED_EVENT_CHANNEL,
  APP_LOG_ENTRY_EVENT_CHANNEL,
} from "../shared/ipc";
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

const log = getMainLogger("pwragent:app-log-window");
const LOGS_HASH = "logs";
const LOGS_WINDOW_TITLE = "Logs";

let appLogWindow: BrowserWindow | undefined;

export function showAppLogWindow(): void {
  if (appLogWindow && !appLogWindow.isDestroyed()) {
    showAndFocusAuxiliaryWindow(appLogWindow);
    return;
  }

  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 700,
    minHeight: 500,
    show: false,
    title: LOGS_WINDOW_TITLE,
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
  registerAuxiliaryWindowTitle(window, LOGS_WINDOW_TITLE);
  hideAuxiliaryWindowMenuBar(window);

  applyWindowSecurityHardening(window);
  registerWindowChannels(window, WINDOW_KIND_APP_LOGS, [
    APP_LOG_ENTRY_EVENT_CHANNEL,
    APPEARANCE_CHANGED_EVENT_CHANNEL,
  ]);

  const rendererEntry = getRendererEntry();
  if (rendererEntry.kind === "url") {
    void window.loadURL(`${rendererEntry.value}#${LOGS_HASH}`);
  } else {
    void window.loadFile(rendererEntry.value, { hash: LOGS_HASH });
  }

  showAuxiliaryWindowWhenReady(window);

  window.on("closed", () => {
    appLogWindow = undefined;
    log.debug("log window closed");
  });

  appLogWindow = window;
  log.debug("log window created");
}
