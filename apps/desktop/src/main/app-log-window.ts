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
import { APP_LOG_ENTRY_EVENT_CHANNEL } from "../shared/ipc";

const log = getMainLogger("pwragent:app-log-window");
const LOGS_HASH = "logs";

let appLogWindow: BrowserWindow | undefined;

export function showAppLogWindow(): void {
  if (appLogWindow && !appLogWindow.isDestroyed()) {
    if (appLogWindow.isMinimized()) {
      appLogWindow.restore();
    }
    appLogWindow.show();
    appLogWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 700,
    minHeight: 500,
    show: false,
    title: "Logs - PwrAgent",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 18 },
    backgroundColor: "#000000",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  applyWindowSecurityHardening(window);
  registerWindowChannels(window, WINDOW_KIND_APP_LOGS, [APP_LOG_ENTRY_EVENT_CHANNEL]);

  const rendererEntry = getRendererEntry();
  if (rendererEntry.kind === "url") {
    void window.loadURL(`${rendererEntry.value}#${LOGS_HASH}`);
  } else {
    void window.loadFile(rendererEntry.value, { hash: LOGS_HASH });
  }

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("closed", () => {
    appLogWindow = undefined;
    log.debug("log window closed");
  });

  appLogWindow = window;
  log.debug("log window created");
}
