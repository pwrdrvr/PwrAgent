import { BrowserWindow } from "electron";
import { getMainLogger } from "./log";
import {
  applyWindowSecurityHardening,
  getPreloadPath,
  getRendererEntry,
} from "./window";
import {
  WINDOW_KIND_FEDERATION_ACTIVITY,
  registerWindowChannels,
} from "./window-channels";
import { APPEARANCE_CHANGED_EVENT_CHANNEL } from "../shared/ipc";
import {
  readBootstrapAppearance,
  themedWindowAdditionalArguments,
} from "./settings/appearance-bootstrap";
import { themedWindowBackgroundColor } from "./native-appearance";
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

const log = getMainLogger("pwragent:federation-activity-window");
const ACTIVITY_WINDOW_TITLE = "Federation Activity";
const ACTIVITY_WINDOW_WIDTH = 760;
const ACTIVITY_WINDOW_HEIGHT = 620;

/**
 * Hash that the renderer (`main.tsx`) reads to decide whether to mount
 * the full app shell or just the federation-activity surface. Loaded
 * windows pass through unchanged on reload, so the hash survives DevTools
 * refreshes and renderer crashes.
 */
const ACTIVITY_HASH = "federation-activity";

let activityWindow: BrowserWindow | undefined;

/**
 * Spawn (or focus, if already open) the dedicated Federation Activity
 * window. The window reuses the same renderer bundle as the main
 * window — `main.tsx` reads `window.location.hash` and mounts a
 * standalone activity surface instead of the full app shell.
 *
 * Distinct OS window: own traffic lights, own focus, own lifecycle.
 * Closing the window does NOT affect the main window. Reopening
 * focuses the existing window when one is already open.
 */
export function showFederationActivityWindow(
  source: WindowPlacementSource = {},
): void {
  if (activityWindow && !activityWindow.isDestroyed()) {
    positionWindowForSourceDisplay(activityWindow, source);
    showAndFocusAuxiliaryWindow(activityWindow);
    return;
  }

  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    ...placementForSourceDisplay(
      ACTIVITY_WINDOW_WIDTH,
      ACTIVITY_WINDOW_HEIGHT,
      source,
    ),
    width: ACTIVITY_WINDOW_WIDTH,
    height: ACTIVITY_WINDOW_HEIGHT,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: ACTIVITY_WINDOW_TITLE,
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
  registerAuxiliaryWindowTitle(window, ACTIVITY_WINDOW_TITLE);
  hideAuxiliaryWindowMenuBar(window);

  applyWindowSecurityHardening(window);
  // Local activity polling needs no federation or backend push subscriptions.
  // Appearance broadcasts keep detached windows synchronized with Settings.
  registerWindowChannels(window, WINDOW_KIND_FEDERATION_ACTIVITY, [
    APPEARANCE_CHANGED_EVENT_CHANNEL,
  ]);

  const rendererEntry = getRendererEntry();
  if (rendererEntry.kind === "url") {
    void window.loadURL(`${rendererEntry.value}#${ACTIVITY_HASH}`);
  } else {
    void window.loadFile(rendererEntry.value, { hash: ACTIVITY_HASH });
  }

  showAuxiliaryWindowWhenReady(window);

  window.on("closed", () => {
    // The top-of-function "already-open" guard prevents two activity
    // windows from coexisting, so the singleton always points at the
    // window that just closed. No need to compare references.
    activityWindow = undefined;
    log.debug("activity window closed");
  });

  activityWindow = window;
  log.debug("activity window created");
}

/** Only the activity window itself may change its topmost state. */
export function setFederationActivityTopmost(senderId: number, enabled: boolean): boolean {
  if (!activityWindow || activityWindow.isDestroyed()
    || activityWindow.webContents.id !== senderId) {
    throw new Error("Federation Activity window is not the caller.");
  }
  activityWindow.setAlwaysOnTop(enabled);
  return activityWindow.isAlwaysOnTop();
}
