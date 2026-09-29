import { BrowserWindow } from "electron";
import { getMainLogger } from "./log";
import {
  applyWindowSecurityHardening,
  getPreloadPath,
  getRendererEntry,
} from "./window";
import {
  WINDOW_KIND_USAGE_ACTIVITY,
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

const log = getMainLogger("pwragent:usage-activity-window");
const USAGE_WINDOW_TITLE = "Usage Activity";
// Wide enough for the limits band, the chart and the thread table beside an
// open inspector without the narrow layouts.
const USAGE_WINDOW_WIDTH = 1180;
const USAGE_WINDOW_HEIGHT = 820;

/** Hash that `main.tsx` routes to the standalone Usage Activity surface. */
const USAGE_HASH = "usage-activity";

let usageWindow: BrowserWindow | undefined;

/**
 * Spawn (or focus, if already open) the Usage Activity window. It reuses the
 * renderer bundle, like the other auxiliary windows, and reads usage on its
 * own through the usage-activity IPC; it subscribes to no push channels
 * except appearance.
 */
export function showUsageActivityWindow(source: WindowPlacementSource = {}): void {
  if (usageWindow && !usageWindow.isDestroyed()) {
    positionWindowForSourceDisplay(usageWindow, source);
    showAndFocusAuxiliaryWindow(usageWindow);
    return;
  }

  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    ...placementForSourceDisplay(USAGE_WINDOW_WIDTH, USAGE_WINDOW_HEIGHT, source),
    width: USAGE_WINDOW_WIDTH,
    height: USAGE_WINDOW_HEIGHT,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: USAGE_WINDOW_TITLE,
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
  registerAuxiliaryWindowTitle(window, USAGE_WINDOW_TITLE);
  hideAuxiliaryWindowMenuBar(window);

  applyWindowSecurityHardening(window);
  registerWindowChannels(window, WINDOW_KIND_USAGE_ACTIVITY, [
    APPEARANCE_CHANGED_EVENT_CHANNEL,
  ]);

  const rendererEntry = getRendererEntry();
  if (rendererEntry.kind === "url") {
    void window.loadURL(`${rendererEntry.value}#${USAGE_HASH}`);
  } else {
    void window.loadFile(rendererEntry.value, { hash: USAGE_HASH });
  }

  showAuxiliaryWindowWhenReady(window);

  window.on("closed", () => {
    usageWindow = undefined;
    log.debug("usage activity window closed");
  });

  usageWindow = window;
  log.debug("usage activity window created");
}
