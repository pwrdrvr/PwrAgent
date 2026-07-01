import { BrowserWindow } from "electron";
import type {
  MarkdownFileViewerFile,
  MarkdownFileViewerSnapshot,
  OpenMarkdownFileViewerRequest,
  ReadMarkdownFileViewerSnapshotResponse,
} from "@pwragent/shared";
import { getMainLogger } from "./log";
import {
  applyWindowSecurityHardening,
  getPreloadPath,
  getRendererEntry,
} from "./window";
import {
  WINDOW_KIND_MARKDOWN_FILES,
  registerWindowChannels,
} from "./window-channels";
import {
  APPEARANCE_CHANGED_EVENT_CHANNEL,
  MARKDOWN_FILE_VIEWER_SNAPSHOT_CHANGED_CHANNEL,
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

const log = getMainLogger("pwragent:markdown-files-window");
const FILES_HASH = "files";
const FILES_WINDOW_WIDTH = 1040;
const FILES_WINDOW_HEIGHT = 780;

type WindowState = {
  snapshot: MarkdownFileViewerSnapshot;
  window?: BrowserWindow;
};

const fileViewerWindows = new Map<string, WindowState>();

export function readMarkdownFileViewerSnapshot(
  contextKey: string,
): ReadMarkdownFileViewerSnapshotResponse {
  return { snapshot: fileViewerWindows.get(contextKey)?.snapshot };
}

export function showMarkdownFileViewerWindow(
  request: OpenMarkdownFileViewerRequest,
  source: WindowPlacementSource = {},
): void {
  const contextKey = request.context.key.trim();
  if (!contextKey) {
    throw new Error("Markdown file viewer requires a context key.");
  }

  const current = fileViewerWindows.get(contextKey);
  const snapshot = upsertSnapshotFile(
    current?.snapshot ?? {
      context: request.context,
      files: [],
      selectedPath: request.file.path,
      editorApplication: request.editorApplication,
    },
    request.file,
    request.editorApplication,
  );
  fileViewerWindows.set(contextKey, {
    snapshot,
    window: current?.window,
  });

  if (current?.window && !current.window.isDestroyed()) {
    current.window.webContents.send(
      MARKDOWN_FILE_VIEWER_SNAPSHOT_CHANGED_CHANNEL,
      { snapshot },
    );
    positionWindowForSourceDisplay(current.window, source);
    showAndFocusAuxiliaryWindow(current.window);
    return;
  }

  const windowTitle = snapshot.context.title || "Files";
  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    ...placementForSourceDisplay(
      FILES_WINDOW_WIDTH,
      FILES_WINDOW_HEIGHT,
      source,
    ),
    width: FILES_WINDOW_WIDTH,
    height: FILES_WINDOW_HEIGHT,
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
  registerWindowChannels(window, WINDOW_KIND_MARKDOWN_FILES, [
    APPEARANCE_CHANGED_EVENT_CHANNEL,
  ]);

  const rendererEntry = getRendererEntry();
  const hash = `${FILES_HASH}/${encodeURIComponent(contextKey)}`;
  if (rendererEntry.kind === "url") {
    void window.loadURL(`${rendererEntry.value}#${hash}`);
  } else {
    void window.loadFile(rendererEntry.value, { hash });
  }

  showAuxiliaryWindowWhenReady(window);

  window.on("closed", () => {
    const latest = fileViewerWindows.get(contextKey);
    if (latest?.window === window) {
      fileViewerWindows.delete(contextKey);
    }
    log.debug("markdown files window closed", { contextKey });
  });

  fileViewerWindows.set(contextKey, { snapshot, window });
  log.debug("markdown files window created", { contextKey });
}

function upsertSnapshotFile(
  snapshot: MarkdownFileViewerSnapshot,
  file: MarkdownFileViewerFile,
  editorApplication: OpenMarkdownFileViewerRequest["editorApplication"],
): MarkdownFileViewerSnapshot {
  const existingIndex = snapshot.files.findIndex((candidate) => candidate.path === file.path);
  const files =
    existingIndex >= 0
      ? snapshot.files.map((candidate, index) => index === existingIndex ? file : candidate)
      : [...snapshot.files, file];

  return {
    ...snapshot,
    files,
    selectedPath: file.path,
    ...(editorApplication ? { editorApplication } : {}),
  };
}
