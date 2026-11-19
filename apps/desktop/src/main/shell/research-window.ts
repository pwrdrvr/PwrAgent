import { BrowserWindow } from "electron";
import { getMainLogger } from "../log";
import {
  applyWindowSecurityHardening,
  rendererPreloadWebPreferences,
  getRendererEntry,
} from "./window";
import {
  WINDOW_KIND_RESEARCH,
  registerWindowChannels,
} from "./window-channels";
import { APPEARANCE_CHANGED_EVENT_CHANNEL, RESEARCH_CHANGED_EVENT_CHANNEL, RESEARCH_WINDOW_SELECT_EVENT_CHANNEL } from "../../shared/ipc";
import {
  readBootstrapAppearance,
  themedWindowAdditionalArguments,
} from "../settings/appearance-bootstrap";
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

const log = getMainLogger("pwragent:research-window");
const RESEARCH_WINDOW_TITLE = "Research";
// Wide enough for the run list, a three-lane Map and the inspector side by side.
const RESEARCH_WINDOW_WIDTH = 1240;
const RESEARCH_WINDOW_HEIGHT = 820;

/** Hash that `main.tsx` routes to the standalone Research surface. */
export const RESEARCH_WINDOW_HASH = "research";

let researchWindow: BrowserWindow | undefined;

/** A run ID as the renderer may receive it in a hash or event: bounded, and never markup. */
export function researchWindowRunId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,300}$/.test(value) ? value : undefined;
}

/**
 * Spawn (or focus, if already open) the Research window: every run this
 * profile owns, with one selected. It reuses the renderer bundle and reads
 * through the research IPC, which admits it as a local owner window. A
 * `runId` selects that run: a new window reads it from its hash, an open one
 * is told.
 */
export function showResearchWindow(
  source: WindowPlacementSource = {},
  focus: { runId?: string } = {},
): void {
  const runId = researchWindowRunId(focus.runId);
  if (researchWindow && !researchWindow.isDestroyed()) {
    if (runId) researchWindow.webContents.send(RESEARCH_WINDOW_SELECT_EVENT_CHANNEL, runId);
    positionWindowForSourceDisplay(researchWindow, source);
    showAndFocusAuxiliaryWindow(researchWindow);
    return;
  }

  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    ...placementForSourceDisplay(RESEARCH_WINDOW_WIDTH, RESEARCH_WINDOW_HEIGHT, source),
    width: RESEARCH_WINDOW_WIDTH,
    height: RESEARCH_WINDOW_HEIGHT,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: RESEARCH_WINDOW_TITLE,
    ...auxiliaryWindowChromeOptions(),
    backgroundColor: themedWindowBackgroundColor(appearance),
    webPreferences: {
      ...rendererPreloadWebPreferences(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: themedWindowAdditionalArguments(appearance),
    },
  });
  registerAuxiliaryWindowTitle(window, RESEARCH_WINDOW_TITLE);
  hideAuxiliaryWindowMenuBar(window);

  applyWindowSecurityHardening(window);
  registerWindowChannels(window, WINDOW_KIND_RESEARCH, [
    APPEARANCE_CHANGED_EVENT_CHANNEL,
    RESEARCH_CHANGED_EVENT_CHANNEL,
    RESEARCH_WINDOW_SELECT_EVENT_CHANNEL,
  ]);

  const rendererEntry = getRendererEntry();
  const hash = runId ? `${RESEARCH_WINDOW_HASH}?run=${encodeURIComponent(runId)}` : RESEARCH_WINDOW_HASH;
  if (rendererEntry.kind === "url") {
    void window.loadURL(`${rendererEntry.value}#${hash}`);
  } else {
    void window.loadFile(rendererEntry.value, { hash });
  }

  showAuxiliaryWindowWhenReady(window);

  window.on("closed", () => {
    researchWindow = undefined;
    log.debug("research window closed");
  });

  researchWindow = window;
  log.debug("research window created");
}
