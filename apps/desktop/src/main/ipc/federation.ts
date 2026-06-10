import { ipcMain } from "electron";
import type {
  OpenFederationWindowRequest,
  OpenFederationWindowResponse,
  ReadFederationHealthRequest,
  ReadFederationHealthResponse,
} from "@pwragent/shared";
import { isFederationInstanceId } from "@pwragent/shared";
import {
  FEDERATION_GET_HEALTH_CHANNEL,
  FEDERATION_OPEN_WINDOW_CHANNEL,
} from "../../shared/ipc";
import { buildFederationHealthStatus } from "../federation/federation-health";
import { FederationStore } from "../federation/federation-store";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { getAppStateDb } from "../state/app-state";
import { createMainWindow } from "../window";

export function registerFederationIpcHandlers(): void {
  ipcMain.removeHandler(FEDERATION_OPEN_WINDOW_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GET_HEALTH_CHANNEL);
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
  ipcMain.handle(
    FEDERATION_GET_HEALTH_CHANNEL,
    async (
      _event,
      _request?: ReadFederationHealthRequest,
    ): Promise<ReadFederationHealthResponse> => {
      const settings = await getDesktopSettingsService().readSettings();
      const peers = new FederationStore(getAppStateDb()).listPeers({
        includeRevoked: true,
      });
      return {
        health: buildFederationHealthStatus({ settings, peers }),
      };
    },
  );
}

export function disposeFederationIpcHandlers(): void {
  ipcMain.removeHandler(FEDERATION_OPEN_WINDOW_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GET_HEALTH_CHANNEL);
}
