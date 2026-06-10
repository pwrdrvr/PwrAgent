import { ipcMain } from "electron";
import type {
  GenerateFederationInviteRequest,
  GenerateFederationInviteResponse,
  ImportFederationInviteRequest,
  ImportFederationInviteResponse,
  OpenFederationWindowRequest,
  OpenFederationWindowResponse,
  ReadFederationHealthRequest,
  ReadFederationHealthResponse,
} from "@pwragent/shared";
import { isFederationInstanceId } from "@pwragent/shared";
import {
  FEDERATION_GET_HEALTH_CHANNEL,
  FEDERATION_GENERATE_INVITE_CHANNEL,
  FEDERATION_IMPORT_INVITE_CHANNEL,
  FEDERATION_OPEN_WINDOW_CHANNEL,
} from "../../shared/ipc";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { createMainWindow } from "../window";

export function registerFederationIpcHandlers(): void {
  ipcMain.removeHandler(FEDERATION_OPEN_WINDOW_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GET_HEALTH_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GENERATE_INVITE_CHANNEL);
  ipcMain.removeHandler(FEDERATION_IMPORT_INVITE_CHANNEL);
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
      return {
        health: await getDesktopFederationRuntime().health(),
      };
    },
  );
  ipcMain.handle(
    FEDERATION_GENERATE_INVITE_CHANNEL,
    async (
      _event,
      request: GenerateFederationInviteRequest = {},
    ): Promise<GenerateFederationInviteResponse> =>
      await getDesktopFederationRuntime().generateInvite(request),
  );
  ipcMain.handle(
    FEDERATION_IMPORT_INVITE_CHANNEL,
    async (
      _event,
      request: ImportFederationInviteRequest,
    ): Promise<ImportFederationInviteResponse> =>
      await getDesktopFederationRuntime().importInvite(request.invite),
  );
}

export function disposeFederationIpcHandlers(): void {
  ipcMain.removeHandler(FEDERATION_OPEN_WINDOW_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GET_HEALTH_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GENERATE_INVITE_CHANNEL);
  ipcMain.removeHandler(FEDERATION_IMPORT_INVITE_CHANNEL);
}
