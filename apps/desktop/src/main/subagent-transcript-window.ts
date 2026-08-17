import { BrowserWindow } from "electron";
import {
  buildThreadIdentityKey,
  type OpenSubAgentTranscriptWindowRequest,
} from "@pwragent/shared";
import { getMainLogger } from "./log";
import {
  applyWindowSecurityHardening,
  getPreloadPath,
  getRendererEntry,
} from "./window";
import {
  WINDOW_KIND_SUB_AGENT_TRANSCRIPT,
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

const log = getMainLogger("pwragent:subagent-transcript-window");
const SUB_AGENT_TRANSCRIPT_HASH = "sub-agent";
const SUB_AGENT_TRANSCRIPT_WINDOW_WIDTH = 1_040;
const SUB_AGENT_TRANSCRIPT_WINDOW_HEIGHT = 780;
const SUB_AGENT_TRANSCRIPT_HASH_TITLE_MAX_LENGTH = 240;

const transcriptWindows = new Map<string, BrowserWindow>();

/**
 * Opens an inspection-only transcript surface for a delegated agent.
 *
 * Sub-agents are addressable through the App Server's `thread/read`, but they
 * are not necessarily materialized PwrAgent threads. Giving them a dedicated
 * window keeps navigation, composer, and thread mutations unavailable while
 * still letting an operator inspect the full child transcript.
 */
export function showSubAgentTranscriptWindow(
  request: OpenSubAgentTranscriptWindowRequest,
  source: WindowPlacementSource = {},
): void {
  const threadId = request.threadId.trim();
  if (!threadId) {
    throw new Error("Sub-agent transcript requires a thread id.");
  }
  const title = request.title.trim() || "Sub-agent transcript";
  const ownerKey = request.federationTarget?.scope === "remote"
    ? request.federationTarget.instanceId
    : "local";
  const windowKey = `${ownerKey}:${buildThreadIdentityKey(request.backend, threadId)}`;
  const current = transcriptWindows.get(windowKey);
  if (current && !current.isDestroyed()) {
    positionWindowForSourceDisplay(current, source);
    showAndFocusAuxiliaryWindow(current);
    return;
  }

  const windowTitle = `Sub-agent transcript — ${title}`;
  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    ...placementForSourceDisplay(
      SUB_AGENT_TRANSCRIPT_WINDOW_WIDTH,
      SUB_AGENT_TRANSCRIPT_WINDOW_HEIGHT,
      source,
    ),
    width: SUB_AGENT_TRANSCRIPT_WINDOW_WIDTH,
    height: SUB_AGENT_TRANSCRIPT_WINDOW_HEIGHT,
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
  registerWindowChannels(window, WINDOW_KIND_SUB_AGENT_TRANSCRIPT, [
    APPEARANCE_CHANGED_EVENT_CHANNEL,
  ]);

  const hash = [
    SUB_AGENT_TRANSCRIPT_HASH,
    encodeURIComponent(request.backend),
    encodeURIComponent(threadId),
    encodeURIComponent(title.slice(0, SUB_AGENT_TRANSCRIPT_HASH_TITLE_MAX_LENGTH)),
    ...(request.federationTarget?.scope === "remote"
      ? [encodeURIComponent(request.federationTarget.instanceId)]
      : []),
  ].join("/");
  const rendererEntry = getRendererEntry();
  if (rendererEntry.kind === "url") {
    void window.loadURL(`${rendererEntry.value}#${hash}`);
  } else {
    void window.loadFile(rendererEntry.value, { hash });
  }

  showAuxiliaryWindowWhenReady(window);
  transcriptWindows.set(windowKey, window);
  window.on("closed", () => {
    if (transcriptWindows.get(windowKey) === window) {
      transcriptWindows.delete(windowKey);
    }
    log.debug("sub-agent transcript window closed", { windowKey });
  });
  log.debug("sub-agent transcript window created", { windowKey });
}
