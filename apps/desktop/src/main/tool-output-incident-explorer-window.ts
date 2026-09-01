import { BrowserWindow, type WebContents } from "electron";
import {
  buildThreadIdentityKey,
  type OpenToolOutputIncidentExplorerWindowRequest,
} from "@pwragent/shared";
import {
  APPEARANCE_CHANGED_EVENT_CHANNEL,
  TOOL_OUTPUT_INCIDENT_EXPLORER_REFRESH_EVENT_CHANNEL,
} from "../shared/ipc";
import {
  auxiliaryWindowChromeOptions,
  hideAuxiliaryWindowMenuBar,
  registerAuxiliaryWindowTitle,
  showAndFocusAuxiliaryWindow,
  showAuxiliaryWindowWhenReady,
} from "./auxiliary-window-chrome";
import { getMainLogger } from "./log";
import { themedWindowBackgroundColor } from "./native-appearance";
import {
  readBootstrapAppearance,
  themedWindowAdditionalArguments,
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
import type { WindowShowThreadRequest } from "../shared/window-show-thread";
import { requestShowThread } from "./window-show-thread";
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
const incidentWindowContexts = new Map<number, {
  owner: WebContents;
  threadKey: string;
}>();

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
    if (source.sourceWindow && !source.sourceWindow.isDestroyed()) {
      incidentWindowContexts.set(current.webContents.id, {
        owner: source.sourceWindow.webContents,
        threadKey: windowKey,
      });
    }
    positionWindowForSourceDisplay(current, source);
    current.webContents.send(
      TOOL_OUTPUT_INCIDENT_EXPLORER_REFRESH_EVENT_CHANNEL,
      request,
    );
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
    TOOL_OUTPUT_INCIDENT_EXPLORER_REFRESH_EVENT_CHANNEL,
  ]);

  const hash = [
    HASH,
    encodeURIComponent(request.backend),
    encodeURIComponent(threadId),
    encodeURIComponent(title.slice(0, TITLE_MAX_LENGTH)),
    encodeURIComponent(request.projectLabel?.trim() ?? ""),
    /* The lens the operator asked for, so a window created by this click opens
       on it. The renderer otherwise picks the lens from the thread's own
       accounting, and that accounting has a lookback window the durable gate
       records outlive — an older gated thread would open on incidents with the
       Savings tab sitting right there unselected. Always emitted, empty when
       the request expresses no preference, so the segment below keeps a fixed
       position. */
    encodeURIComponent(request.lens ?? ""),
    /* The owning instance, appended only for a peer's thread: a viewer's
       explorer must read the peer's thread, not a local thread that happens
       to share the id. */
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
  incidentWindows.set(windowKey, window);
  const webContentsId = window.webContents.id;
  if (source.sourceWindow && !source.sourceWindow.isDestroyed()) {
    incidentWindowContexts.set(webContentsId, {
      owner: source.sourceWindow.webContents,
      threadKey: windowKey,
    });
  }
  window.on("closed", () => {
    if (incidentWindows.get(windowKey) === window) {
      incidentWindows.delete(windowKey);
    }
    // Electron has destroyed the BrowserWindow by the time `closed` fires.
    // Reading `window.webContents` here throws "Object has been destroyed",
    // so retain the primitive id while the window is still live.
    incidentWindowContexts.delete(webContentsId);
    log.debug("tool-output incident explorer closed", { windowKey });
  });
  log.debug("tool-output incident explorer created", { windowKey });
}

export function showThreadFromToolOutputIncidentExplorer(
  sender: WebContents,
  request: WindowShowThreadRequest,
): void {
  const context = incidentWindowContexts.get(sender.id);
  if (!context || context.owner.isDestroyed()) {
    throw new Error("Tool-output incident explorer has no active owner window.");
  }
  if (
    buildThreadIdentityKey(request.backend, request.threadId)
    !== context.threadKey
  ) {
    throw new Error("Tool-output incident explorer can only open its own thread.");
  }
  requestShowThread(request, { preferWebContents: context.owner });
}
