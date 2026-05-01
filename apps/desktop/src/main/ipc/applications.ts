import { ipcMain } from "electron";
import type {
  OpenDesktopApplicationRequest,
  OpenDesktopApplicationResponse,
} from "@pwragnt/shared";
import { APPLICATION_OPEN_CHANNEL } from "../../shared/ipc";
import { openDesktopApplication } from "../settings/application-discovery";

export function registerApplicationIpcHandlers(): void {
  ipcMain.removeHandler(APPLICATION_OPEN_CHANNEL);
  ipcMain.handle(
    APPLICATION_OPEN_CHANNEL,
    async (
      _event,
      request: OpenDesktopApplicationRequest,
    ): Promise<OpenDesktopApplicationResponse> => openDesktopApplication(request),
  );
}

export function disposeApplicationIpcHandlers(): void {
  ipcMain.removeHandler(APPLICATION_OPEN_CHANNEL);
}
