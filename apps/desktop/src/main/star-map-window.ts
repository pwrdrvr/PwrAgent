import { BrowserWindow } from "electron";
import { getMainLogger } from "./log";
import {
  applyWindowSecurityHardening,
  getPreloadPath,
  getRendererEntry,
} from "./window";
import {
  WINDOW_KIND_STAR_MAP,
  registerWindowChannels,
} from "./window-channels";
import {
  AGENT_EVENT_CHANNEL,
  APPEARANCE_CHANGED_EVENT_CHANNEL,
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

const log = getMainLogger("pwragent:star-map-window");
const STAR_MAP_WINDOW_TITLE = "Federation Star Map";
const STAR_MAP_WINDOW_WIDTH = 1280;
const STAR_MAP_WINDOW_HEIGHT = 820;

/**
 * Hash that the renderer (`main.tsx`) reads to decide whether to mount
 * the full app shell or just the Star Map surface. Loaded windows pass
 * through unchanged on reload, so the hash survives DevTools refreshes
 * and renderer crashes.
 */
const STAR_MAP_HASH = "star-map";

let starMapWindow: BrowserWindow | undefined;

/**
 * Spawn (or focus, if already open) the dedicated Federation Star Map
 * window. The window reuses the same renderer bundle as the main
 * window — `main.tsx` reads `window.location.hash` and mounts a
 * standalone Star Map surface instead of the full app shell.
 *
 * Distinct OS window: own traffic lights, own focus, own lifecycle.
 * Closing the window does NOT affect the main window. Reopening
 * focuses the existing window when one is already open.
 */
export function showStarMapWindow(source: WindowPlacementSource = {}): void {
  if (starMapWindow && !starMapWindow.isDestroyed()) {
    positionWindowForSourceDisplay(starMapWindow, source);
    showAndFocusAuxiliaryWindow(starMapWindow);
    return;
  }

  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    ...placementForSourceDisplay(
      STAR_MAP_WINDOW_WIDTH,
      STAR_MAP_WINDOW_HEIGHT,
      source,
    ),
    width: STAR_MAP_WINDOW_WIDTH,
    height: STAR_MAP_WINDOW_HEIGHT,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: STAR_MAP_WINDOW_TITLE,
    ...auxiliaryWindowChromeOptions(),
    // Unlike the other auxiliary windows, the Star Map is meant to live
    // full-screen on its own macOS Space while the operator keeps the
    // regular windows in windowed mode — so native fullscreen stays ON
    // for this one.
    fullscreenable: true,
    backgroundColor: themedWindowBackgroundColor(appearance),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: themedWindowAdditionalArguments(appearance),
    },
  });
  registerAuxiliaryWindowTitle(window, STAR_MAP_WINDOW_TITLE);
  hideAuxiliaryWindowMenuBar(window);

  applyWindowSecurityHardening(window);
  // The map is a live surface: thread status, star-map arrangement
  // deltas, and federation peer changes all arrive as agent events, so
  // this window subscribes to that push channel (unlike the polling
  // Messaging Activity window). Appearance broadcasts keep the theme in
  // sync when the operator changes it from another window. The window is
  // deliberately registered WITHOUT a federation target: remote-scoped
  // event delivery is gated per-webContents by the renderer's own
  // `setFederationEventSubscriptions` registration instead.
  registerWindowChannels(window, WINDOW_KIND_STAR_MAP, [
    AGENT_EVENT_CHANNEL,
    APPEARANCE_CHANGED_EVENT_CHANNEL,
  ]);

  const rendererEntry = getRendererEntry();
  if (rendererEntry.kind === "url") {
    void window.loadURL(`${rendererEntry.value}#${STAR_MAP_HASH}`);
  } else {
    void window.loadFile(rendererEntry.value, { hash: STAR_MAP_HASH });
  }

  showAuxiliaryWindowWhenReady(window);

  window.on("closed", () => {
    // The top-of-function "already-open" guard prevents two star map
    // windows from coexisting, so the singleton always points at the
    // window that just closed. No need to compare references.
    starMapWindow = undefined;
    log.debug("star map window closed");
  });

  starMapWindow = window;
  log.debug("star map window created");
}
