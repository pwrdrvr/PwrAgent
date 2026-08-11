import { BrowserWindow } from "electron";
import type { OpenAutomationRunWindowRequest } from "@pwragent/shared";
import { getMainLogger } from "./log";
import {
  applyWindowSecurityHardening,
  getPreloadPath,
  getRendererEntry,
} from "./window";
import {
  WINDOW_KIND_AUTOMATION_RUN,
  registerWindowChannels,
} from "./window-channels";
import { APPEARANCE_CHANGED_EVENT_CHANNEL } from "../shared/ipc";
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

const log = getMainLogger("pwragent:automation-run-window");
const AUTOMATION_RUN_HASH = "automation-run";
const AUTOMATION_RUN_WINDOW_WIDTH = 1_040;
const AUTOMATION_RUN_WINDOW_HEIGHT = 780;

const runWindows = new Map<string, BrowserWindow>();

/**
 * Opens an inspection-only window for one automation run's captured events.
 *
 * The transcript was previously readable only inline in the automations
 * table, where a long run competes with the table itself for space. Same
 * pattern as the sub-agent transcript window: keyed by identity (one window
 * per run, refocused on re-open), hash-routed into the shared renderer
 * bundle, read-only.
 */
export function showAutomationRunWindow(
  request: OpenAutomationRunWindowRequest,
  source: WindowPlacementSource = {},
): void {
  const automationId = request.automationId.trim();
  const runId = request.runId.trim();
  if (!automationId || !runId) {
    throw new Error("Automation run window requires automation and run ids.");
  }
  const current = runWindows.get(runId);
  if (current && !current.isDestroyed()) {
    positionWindowForSourceDisplay(current, source);
    showAndFocusAuxiliaryWindow(current);
    return;
  }

  const title = request.title?.trim() || "Automation run";
  const windowTitle = `Automation run — ${title}`;
  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    ...placementForSourceDisplay(
      AUTOMATION_RUN_WINDOW_WIDTH,
      AUTOMATION_RUN_WINDOW_HEIGHT,
      source,
    ),
    width: AUTOMATION_RUN_WINDOW_WIDTH,
    height: AUTOMATION_RUN_WINDOW_HEIGHT,
    minWidth: 720,
    minHeight: 520,
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
  registerWindowChannels(window, WINDOW_KIND_AUTOMATION_RUN, [
    APPEARANCE_CHANGED_EVENT_CHANNEL,
  ]);

  const hash = [
    AUTOMATION_RUN_HASH,
    encodeURIComponent(automationId),
    encodeURIComponent(runId),
  ].join("/");
  const rendererEntry = getRendererEntry();
  if (rendererEntry.kind === "url") {
    void window.loadURL(`${rendererEntry.value}#${hash}`);
  } else {
    void window.loadFile(rendererEntry.value, { hash });
  }

  showAuxiliaryWindowWhenReady(window);
  runWindows.set(runId, window);
  window.on("closed", () => {
    if (runWindows.get(runId) === window) {
      runWindows.delete(runId);
    }
    log.debug("automation run window closed", { runId });
  });
  log.debug("automation run window created", { automationId, runId });
}
