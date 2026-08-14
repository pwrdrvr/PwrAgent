import { BrowserWindow } from "electron";
import {
  buildThreadIdentityKey,
  type OpenToolOutputIncidentExplorerWindowRequest,
} from "@pwragent/shared";
import { APPEARANCE_CHANGED_EVENT_CHANNEL } from "../shared/ipc";
import {
  auxiliaryWindowChromeOptions,
  hideAuxiliaryWindowMenuBar,
  registerAuxiliaryWindowTitle,
  showAndFocusAuxiliaryWindow,
  showAuxiliaryWindowWhenReady,
} from "./auxiliary-window-chrome";
import { getMainLogger } from "./log";
import {
  readBootstrapAppearance,
  themedWindowAdditionalArguments,
  themedWindowBackgroundColor,
} from "./settings/appearance-bootstrap";
import {
  applyWindowSecurityHardening,
  getPreloadPath,
  getRendererEntry,
} from "./window";
import {
  WINDOW_KIND_TOOL_OUTPUT_INCIDENT_EXPLORER,
  registerWindowChannels,
} from "./window-channels";
import {
  placementForSourceDisplay,
  positionWindowForSourceDisplay,
  type WindowPlacementSource,
} from "./window-placement";

const log = getMainLogger("pwragent:tool-output-incident-explorer-window");
const HASH = "tool-output-incidents";
const WIDTH = 1_180;
const HEIGHT = 820;
const TITLE_MAX_LENGTH = 240;
const incidentWindows = new Map<string, BrowserWindow>();

export function showToolOutputIncidentExplorerWindow(
  request: OpenToolOutputIncidentExplorerWindowRequest,
  source: WindowPlacementSource = {},
): void {
  const threadId = request.threadId.trim();
  if (!threadId) {
    throw new Error("Tool-output incident explorer requires a thread id.");
  }
  const title = request.title.trim() || "Thread";
  const windowKey = buildThreadIdentityKey(request.backend, threadId);
  const current = incidentWindows.get(windowKey);
  if (current && !current.isDestroyed()) {
    positionWindowForSourceDisplay(current, source);
    showAndFocusAuxiliaryWindow(current);
    return;
  }

  const windowTitle = `Tool-output incidents — ${title}`;
  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    ...placementForSourceDisplay(WIDTH, HEIGHT, source),
    width: WIDTH,
    height: HEIGHT,
    minWidth: 840,
    minHeight: 600,
    show: false,
    title: windowTitle,
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
  registerAuxiliaryWindowTitle(window, windowTitle);
  hideAuxiliaryWindowMenuBar(window);
  applyWindowSecurityHardening(window);
  registerWindowChannels(window, WINDOW_KIND_TOOL_OUTPUT_INCIDENT_EXPLORER, [
    APPEARANCE_CHANGED_EVENT_CHANNEL,
  ]);

  const hash = [
    HASH,
    encodeURIComponent(request.backend),
    encodeURIComponent(threadId),
    encodeURIComponent(title.slice(0, TITLE_MAX_LENGTH)),
  ].join("/");
  const rendererEntry = getRendererEntry();
  if (rendererEntry.kind === "url") {
    void window.loadURL(`${rendererEntry.value}#${hash}`);
  } else {
    void window.loadFile(rendererEntry.value, { hash });
  }
  showAuxiliaryWindowWhenReady(window);
  incidentWindows.set(windowKey, window);
  window.on("closed", () => {
    if (incidentWindows.get(windowKey) === window) {
      incidentWindows.delete(windowKey);
    }
    log.debug("tool-output incident explorer closed", { windowKey });
  });
  log.debug("tool-output incident explorer created", { windowKey });
}
