import { ipcMain } from "electron";
import {
  isRemoteFederationTarget,
  type ConnectPwrSnapResponse,
  type OpenPwrSnapResponse,
  type PwrSnapConnectionStatus,
  type ReadPwrSnapConnectionStatusRequest,
} from "@pwragent/shared";
import {
  MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL,
  MCP_CONNECTION_PWRSNAP_DOWNLOAD_CHANNEL,
  MCP_CONNECTION_PWRSNAP_OPEN_CHANNEL,
  MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL,
} from "../../shared/ipc";
import {
  getPwrSnapConnectionService,
  type PwrSnapConnectionService,
} from "../mcp-connections/pwrsnap-connection-service";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { federationWindowTargetForWebContents } from "../window";

export function registerMcpConnectionIpcHandlers(
  service: PwrSnapConnectionService = getPwrSnapConnectionService(),
): void {
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL,
    async (
      event,
      request: ReadPwrSnapConnectionStatusRequest = {},
    ): Promise<PwrSnapConnectionStatus> => {
      const federationTarget =
        federationWindowTargetForWebContents(event.sender)
        ?? request.federationTarget;
      if (federationTarget && isRemoteFederationTarget(federationTarget)) {
        return await getDesktopFederationRuntime()
          .remoteBackend(federationTarget)
          .readPwrSnapConnectionStatus();
      }
      return await service.readStatus();
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL,
    async (event): Promise<ConnectPwrSnapResponse> => {
      if (federationWindowTargetForWebContents(event.sender)) {
        throw new Error(
          "PwrSnap pairing is only available on the machine that owns this window.",
        );
      }
      return await service.connect();
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_OPEN_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_PWRSNAP_OPEN_CHANNEL,
    async (event): Promise<OpenPwrSnapResponse> => {
      if (federationWindowTargetForWebContents(event.sender)) {
        return {
          opened: false,
          error: "This thread uses PwrSnap on its remote owner.",
        };
      }
      return await service.openApplication();
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_DOWNLOAD_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_PWRSNAP_DOWNLOAD_CHANNEL,
    async (event): Promise<OpenPwrSnapResponse> => {
      if (federationWindowTargetForWebContents(event.sender)) {
        return {
          opened: false,
          error: "Install PwrSnap on the machine that owns this thread.",
        };
      }
      return await service.openDownload();
    },
  );
}

export function disposeMcpConnectionIpcHandlers(): void {
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_OPEN_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_DOWNLOAD_CHANNEL);
}
