import { ipcMain } from "electron";
import type {
  OpenFederationWindowRequest,
  OpenFederationWindowResponse,
} from "@pwragent/shared";
import { isFederationInstanceId } from "@pwragent/shared";
import { FEDERATION_OPEN_WINDOW_CHANNEL } from "../../shared/ipc";
import { createMainWindow } from "../window";

export function registerFederationIpcHandlers(): void {
  ipcMain.removeHandler(FEDERATION_OPEN_WINDOW_CHANNEL);
  ipcMain.handle(
    FEDERATION_OPEN_WINDOW_CHANNEL,
    async (
      _event,
      request: OpenFederationWindowRequest,
    ): Promise<OpenFederationWindowResponse> => {
      if (
        request.target?.scope !== "remote" ||
        !isFederationInstanceId(request.target.instanceId)
      ) {
        throw new Error("Invalid federation window target");
      }
      const window = createMainWindow({
        federationTarget: request.target,
      });
      return {
        opened: true,
        windowId: window.id,
        target: request.target,
      };
    },
  );
}

export function disposeFederationIpcHandlers(): void {
  ipcMain.removeHandler(FEDERATION_OPEN_WINDOW_CHANNEL);
}
