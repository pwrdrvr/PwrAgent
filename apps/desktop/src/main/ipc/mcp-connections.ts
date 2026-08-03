import { ipcMain } from "electron";
import type {
  ConnectPwrSnapResponse,
  OpenPwrSnapResponse,
  PwrSnapConnectionStatus,
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

export function registerMcpConnectionIpcHandlers(
  service: PwrSnapConnectionService = getPwrSnapConnectionService(),
): void {
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL,
    async (): Promise<PwrSnapConnectionStatus> => await service.readStatus(),
  );
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL,
    async (): Promise<ConnectPwrSnapResponse> => await service.connect(),
  );
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_OPEN_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_PWRSNAP_OPEN_CHANNEL,
    async (): Promise<OpenPwrSnapResponse> => await service.openApplication(),
  );
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_DOWNLOAD_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_PWRSNAP_DOWNLOAD_CHANNEL,
    async (): Promise<OpenPwrSnapResponse> => await service.openDownload(),
  );
}

export function disposeMcpConnectionIpcHandlers(): void {
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_OPEN_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_DOWNLOAD_CHANNEL);
}
