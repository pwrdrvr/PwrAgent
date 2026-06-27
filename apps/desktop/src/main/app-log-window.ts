import { BrowserWindow } from "electron";
import { getMainLogFilePath, getMainLogger } from "./log";
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
import {
  placementForSourceDisplay,
  positionWindowForSourceDisplay,
  type WindowPlacementSource,
} from "./window-placement";

const log = getMainLogger("pwragent:app-log-window");
const LOGS_HASH = "logs";
const LOGS_WINDOW_TITLE = "Logs";
const LOGS_WINDOW_WIDTH = 1040;
const LOGS_WINDOW_HEIGHT = 760;

let appLogWindow: BrowserWindow | undefined;

export function showAppLogWindow(source: WindowPlacementSource = {}): void {
  if (appLogWindow && !appLogWindow.isDestroyed()) {
    positionWindowForSourceDisplay(appLogWindow, source);
    showAndFocusAuxiliaryWindow(appLogWindow);
    return;
  }

  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    ...placementForSourceDisplay(LOGS_WINDOW_WIDTH, LOGS_WINDOW_HEIGHT, source),
    width: LOGS_WINDOW_WIDTH,
    height: LOGS_WINDOW_HEIGHT,
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
      additionalArguments: [
        ...themedWindowAdditionalArguments(appearance),
        // Hand the log file's on-disk path to the renderer up front so the
        // Logs window can show + reveal it even if the snapshot IPC read later
        // fails — that failure is exactly when finding the log matters most.
        `--pwragent-log-file-path=${JSON.stringify(getMainLogFilePath() ?? "")}`,
      ],
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
