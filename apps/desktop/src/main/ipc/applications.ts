import { access, readFile, stat } from "node:fs/promises";
import { BrowserWindow, ipcMain, shell } from "electron";
import type {
  OpenDesktopApplicationRequest,
  OpenDesktopApplicationResponse,
  OpenMarkdownFileViewerRequest,
  OpenMarkdownFileViewerResponse,
  OpenPathRequest,
  OpenPathResponse,
  ReadMarkdownFileRequest,
  ReadMarkdownFileResponse,
  ReadMarkdownFileViewerSnapshotRequest,
  ReadMarkdownFileViewerSnapshotResponse,
} from "@pwragent/shared";
import {
  APPLICATION_OPEN_CHANNEL,
  MARKDOWN_FILE_READ_CHANNEL,
  MARKDOWN_FILE_VIEWER_OPEN_CHANNEL,
  MARKDOWN_FILE_VIEWER_SNAPSHOT_READ_CHANNEL,
  PATH_OPEN_CHANNEL,
  PATH_REVEAL_CHANNEL,
} from "../../shared/ipc";
import {
  readMarkdownFileViewerSnapshot,
  showMarkdownFileViewerWindow,
} from "../markdown-files-window";
import { openDesktopApplication } from "../settings/application-discovery";

const MAX_MARKDOWN_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Open a filesystem path with the OS default handler. The fallback the
 * edited-file rows use when no editor application is configured/available, so
 * "open file" still does something via the OS-registered program.
 */
async function openPathWithOsDefault(
  request: OpenPathRequest,
): Promise<OpenPathResponse> {
  const target = request.path?.trim();
  if (!target) {
    return { opened: false, error: "No file path was provided." };
  }
  try {
    await access(target);
  } catch {
    return { opened: false, error: `Path does not exist: ${target}` };
  }
  // `shell.openPath` resolves to "" on success or an error message on failure.
  const error = await shell.openPath(target);
  return error ? { opened: false, error } : { opened: true };
}

/**
 * Reveal a filesystem path in the OS file manager (Finder on macOS),
 * highlighting the item. Used by the Logs window's "Reveal" button so the user
 * can grab the log file off disk even while it's open in the viewer.
 */
async function revealPathInFolder(
  request: OpenPathRequest,
): Promise<OpenPathResponse> {
  const target = request.path?.trim();
  if (!target) {
    return { opened: false, error: "No file path was provided." };
  }
  try {
    await access(target);
  } catch {
    return { opened: false, error: `Path does not exist: ${target}` };
  }
  shell.showItemInFolder(target);
  return { opened: true };
}

async function readMarkdownFile(
  request: ReadMarkdownFileRequest,
): Promise<ReadMarkdownFileResponse> {
  const target = request.path?.trim();
  if (!target) {
    return { path: "", error: "No file path was provided." };
  }

  if (!/\.(?:md|markdown)$/i.test(target)) {
    return { path: target, error: "Only Markdown files can be previewed." };
  }

  try {
    const fileStat = await stat(target);
    if (!fileStat.isFile()) {
      return { path: target, error: `Path is not a file: ${target}` };
    }
    if (fileStat.size > MAX_MARKDOWN_FILE_BYTES) {
      return { path: target, error: "Markdown file is too large to preview." };
    }

    return {
      path: target,
      content: await readFile(target, "utf8"),
    };
  } catch {
    return { path: target, error: `Path does not exist: ${target}` };
  }
}

export function registerApplicationIpcHandlers(): void {
  ipcMain.removeHandler(APPLICATION_OPEN_CHANNEL);
  ipcMain.handle(
    APPLICATION_OPEN_CHANNEL,
    async (
      _event,
      request: OpenDesktopApplicationRequest,
    ): Promise<OpenDesktopApplicationResponse> => openDesktopApplication(request),
  );

  ipcMain.removeHandler(PATH_OPEN_CHANNEL);
  ipcMain.handle(
    PATH_OPEN_CHANNEL,
    async (_event, request: OpenPathRequest): Promise<OpenPathResponse> =>
      openPathWithOsDefault(request),
  );

  ipcMain.removeHandler(PATH_REVEAL_CHANNEL);
  ipcMain.handle(
    PATH_REVEAL_CHANNEL,
    async (_event, request: OpenPathRequest): Promise<OpenPathResponse> =>
      revealPathInFolder(request),
  );

  ipcMain.removeHandler(MARKDOWN_FILE_READ_CHANNEL);
  ipcMain.handle(
    MARKDOWN_FILE_READ_CHANNEL,
    async (
      _event,
      request: ReadMarkdownFileRequest,
    ): Promise<ReadMarkdownFileResponse> => readMarkdownFile(request),
  );

  ipcMain.removeHandler(MARKDOWN_FILE_VIEWER_OPEN_CHANNEL);
  ipcMain.handle(
    MARKDOWN_FILE_VIEWER_OPEN_CHANNEL,
    async (
      event,
      request: OpenMarkdownFileViewerRequest,
    ): Promise<OpenMarkdownFileViewerResponse> => {
      showMarkdownFileViewerWindow(request, {
        sourceWindow: BrowserWindow.fromWebContents(event.sender),
      });
      return { opened: true };
    },
  );

  ipcMain.removeHandler(MARKDOWN_FILE_VIEWER_SNAPSHOT_READ_CHANNEL);
  ipcMain.handle(
    MARKDOWN_FILE_VIEWER_SNAPSHOT_READ_CHANNEL,
    async (
      _event,
      request: ReadMarkdownFileViewerSnapshotRequest,
    ): Promise<ReadMarkdownFileViewerSnapshotResponse> =>
      readMarkdownFileViewerSnapshot(request.contextKey),
  );
}

export function disposeApplicationIpcHandlers(): void {
  ipcMain.removeHandler(APPLICATION_OPEN_CHANNEL);
  ipcMain.removeHandler(PATH_OPEN_CHANNEL);
  ipcMain.removeHandler(PATH_REVEAL_CHANNEL);
  ipcMain.removeHandler(MARKDOWN_FILE_READ_CHANNEL);
  ipcMain.removeHandler(MARKDOWN_FILE_VIEWER_OPEN_CHANNEL);
  ipcMain.removeHandler(MARKDOWN_FILE_VIEWER_SNAPSHOT_READ_CHANNEL);
}
