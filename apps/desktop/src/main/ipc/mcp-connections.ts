import { ipcMain } from "electron";
import {
  type AuthorizeMcpConnectionRequest,
  type AuthorizeMcpConnectionResponse,
  type CreateMcpConnectionRequest,
  type CreateMcpConnectionResponse,
  type DisconnectMcpConnectionRequest,
  isRemoteFederationTarget,
  type ListMcpConnectionsResponse,
  type McpConnectionStatus,
  type MutateMcpConnectionResponse,
  type RemoveMcpConnectionRequest,
  type SetMcpConnectionEnabledRequest,
  type SetThreadMcpConnectionsRequest,
  type SetThreadMcpConnectionsResponse,
  type ConnectPwrSnapResponse,
  type OpenPwrSnapResponse,
  type PwrSnapConnectionStatus,
  type ReadPwrSnapConnectionStatusRequest,
} from "@pwragent/shared";
import {
  MCP_CONNECTION_AUTHORIZE_CHANNEL,
  MCP_CONNECTION_CREATE_CHANNEL,
  MCP_CONNECTION_DISCONNECT_CHANNEL,
  MCP_CONNECTION_LIST_CHANNEL,
  MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL,
  MCP_CONNECTION_PWRSNAP_DOWNLOAD_CHANNEL,
  MCP_CONNECTION_PWRSNAP_OPEN_CHANNEL,
  MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL,
  MCP_CONNECTION_REMOVE_CHANNEL,
  MCP_CONNECTION_SET_ENABLED_CHANNEL,
  MCP_CONNECTION_SET_THREAD_CHANNEL,
} from "../../shared/ipc";
import {
  getMcpConnectionGatewayService,
  type McpConnectionGatewayService,
} from "../mcp-connections/mcp-connection-gateway-service";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { federationWindowTargetForWebContents } from "../window";

export function registerMcpConnectionIpcHandlers(
  service: McpConnectionGatewayService = getMcpConnectionGatewayService(),
): void {
  const requireLocalOwner = (event: Electron.IpcMainInvokeEvent): void => {
    if (federationWindowTargetForWebContents(event.sender)) {
      throw new Error(
        "MCP connections can only be changed on the machine that owns this window.",
      );
    }
  };
  ipcMain.removeHandler(MCP_CONNECTION_LIST_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_LIST_CHANNEL,
    async (event): Promise<ListMcpConnectionsResponse> => {
      requireLocalOwner(event);
      return { connections: await service.listConnections() };
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_CREATE_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_CREATE_CHANNEL,
    async (
      event,
      request: CreateMcpConnectionRequest,
    ): Promise<CreateMcpConnectionResponse> => {
      requireLocalOwner(event);
      return { connection: await service.createConnection(request) };
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_AUTHORIZE_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_AUTHORIZE_CHANNEL,
    async (
      event,
      request: AuthorizeMcpConnectionRequest,
    ): Promise<AuthorizeMcpConnectionResponse> => {
      requireLocalOwner(event);
      return {
        connection: await service.authorizeConnection(request.connectionId),
      };
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_DISCONNECT_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_DISCONNECT_CHANNEL,
    async (
      event,
      request: DisconnectMcpConnectionRequest,
    ): Promise<MutateMcpConnectionResponse> => {
      requireLocalOwner(event);
      const connection: McpConnectionStatus =
        await service.disconnectConnection(request.connectionId);
      return { connectionId: request.connectionId, connection };
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_REMOVE_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_REMOVE_CHANNEL,
    async (
      event,
      request: RemoveMcpConnectionRequest,
    ): Promise<MutateMcpConnectionResponse> => {
      requireLocalOwner(event);
      await service.removeConnection(request.connectionId);
      return { connectionId: request.connectionId, removed: true };
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_SET_ENABLED_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_SET_ENABLED_CHANNEL,
    async (
      event,
      request: SetMcpConnectionEnabledRequest,
    ): Promise<MutateMcpConnectionResponse> => {
      requireLocalOwner(event);
      const connection: McpConnectionStatus =
        await service.setConnectionEnabled(
          request.connectionId,
          request.enabled,
        );
      return { connectionId: request.connectionId, connection };
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_SET_THREAD_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_SET_THREAD_CHANNEL,
    async (
      event,
      request: SetThreadMcpConnectionsRequest,
    ): Promise<SetThreadMcpConnectionsResponse> => {
      // Managed connections belong to the profile that runs the thread. A
      // federated viewer editing this would write a selection the executing
      // machine cannot honor, so the guard matches the rest of this surface.
      requireLocalOwner(event);
      return await getDesktopBackendRegistry().setThreadMcpConnections(request);
    },
  );
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
  ipcMain.removeHandler(MCP_CONNECTION_LIST_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_CREATE_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_AUTHORIZE_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_DISCONNECT_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_REMOVE_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_SET_ENABLED_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_SET_THREAD_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_OPEN_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_DOWNLOAD_CHANNEL);
}
