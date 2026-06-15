import { access } from "node:fs/promises";
import { ipcMain, shell } from "electron";
import type {
  OpenDesktopApplicationRequest,
  OpenDesktopApplicationResponse,
  OpenPathRequest,
  OpenPathResponse,
} from "@pwragent/shared";
import { APPLICATION_OPEN_CHANNEL, PATH_OPEN_CHANNEL } from "../../shared/ipc";
import { openDesktopApplication } from "../settings/application-discovery";

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
}

export function disposeApplicationIpcHandlers(): void {
  ipcMain.removeHandler(APPLICATION_OPEN_CHANNEL);
  ipcMain.removeHandler(PATH_OPEN_CHANNEL);
}
