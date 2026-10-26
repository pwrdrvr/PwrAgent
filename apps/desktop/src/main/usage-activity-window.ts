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
import { APPEARANCE_CHANGED_EVENT_CHANNEL, USAGE_ACTIVITY_FOCUS_PROVIDER_EVENT_CHANNEL } from "../shared/ipc";
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
 * except appearance. A `provider` focuses that provider's account limits:
 * a new window reads it from its hash, an open one is told.
 */
export function showUsageActivityWindow(
  source: WindowPlacementSource = {},
  focus: { provider?: string } = {},
): void {
  if (usageWindow && !usageWindow.isDestroyed()) {
    if (focus.provider) usageWindow.webContents.send(USAGE_ACTIVITY_FOCUS_PROVIDER_EVENT_CHANNEL, focus.provider);
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
  const hash = focus.provider ? `${USAGE_HASH}?provider=${encodeURIComponent(focus.provider)}` : USAGE_HASH;
  if (rendererEntry.kind === "url") {
    void window.loadURL(`${rendererEntry.value}#${hash}`);
  } else {
    void window.loadFile(rendererEntry.value, { hash });
  }

  showAuxiliaryWindowWhenReady(window);

  window.on("closed", () => {
    usageWindow = undefined;
    log.debug("usage activity window closed");
  });

  usageWindow = window;
  log.debug("usage activity window created");
}
