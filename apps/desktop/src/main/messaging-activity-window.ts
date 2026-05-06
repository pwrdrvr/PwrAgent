import { BrowserWindow } from "electron";
import { getMainLogger } from "./log";
import { getPreloadPath, getRendererEntry } from "./window";

const log = getMainLogger("pwragent:activity-window");

/**
 * Hash that the renderer (`main.tsx`) reads to decide whether to mount
 * the full app shell or just the messaging-activity surface. Loaded
 * windows pass through unchanged on reload, so the hash survives DevTools
 * refreshes and renderer crashes.
 */
const ACTIVITY_HASH = "messaging-activity";

let activityWindow: BrowserWindow | undefined;

/**
 * Spawn (or focus, if already open) the dedicated Messaging Activity
 * window. The window reuses the same renderer bundle as the main
 * window — `main.tsx` reads `window.location.hash` and mounts a
 * standalone activity surface instead of the full app shell.
 *
 * Distinct OS window: own traffic lights, own focus, own lifecycle.
 * Closing the window does NOT affect the main window. Reopening
 * focuses the existing window when one is already open.
 */
export function showMessagingActivityWindow(): void {
  if (activityWindow && !activityWindow.isDestroyed()) {
    if (activityWindow.isMinimized()) {
      activityWindow.restore();
    }
    activityWindow.show();
    activityWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: "Messaging Activity — PwrAgent",
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

  const rendererEntry = getRendererEntry();
  if (rendererEntry.kind === "url") {
    void window.loadURL(`${rendererEntry.value}#${ACTIVITY_HASH}`);
  } else {
    void window.loadFile(rendererEntry.value, { hash: ACTIVITY_HASH });
  }

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("closed", () => {
    if (activityWindow === window) {
      activityWindow = undefined;
    }
    log.debug("activity window closed");
  });

  activityWindow = window;
  log.debug("activity window created");
}
