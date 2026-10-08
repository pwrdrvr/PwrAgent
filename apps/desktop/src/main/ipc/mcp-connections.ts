import { ipcMain } from "electron";
import {
  isMcpConnectionToolApproval,
  type AuthorizeMcpConnectionRequest,
  type AuthorizeMcpConnectionResponse,
  type CancelMcpConnectionAuthorizationRequest,
  type CreateMcpConnectionRequest,
  type CreateMcpConnectionResponse,
  type DescribeThreadMcpConnectionsRequest,
  type DescribeThreadMcpConnectionsResponse,
  type ProbeMcpConnectionRequest,
  type ProbeMcpConnectionResponse,
  type UpdateMcpConnectionRequest,
  type DisconnectMcpConnectionRequest,
  type ListMcpConnectionToolsRequest,
  type ListMcpConnectionToolsResponse,
  isRemoteFederationTarget,
  type ConnectPwrGitResponse,
  type ListMcpConnectionsResponse,
  type McpConnectionStatus,
  type MutateMcpConnectionResponse,
  type RemoveMcpConnectionRequest,
  type SetMcpConnectionEnabledRequest,
  type SetMcpConnectionSelectForNewThreadsRequest,
  type SetMcpConnectionToolApprovalRequest,
  type ReadThreadMcpConnectionsRequest,
  type SetThreadMcpConnectionsRequest,
  type SetThreadMcpConnectionsResponse,
  type ConnectPwrSnapResponse,
  type OpenPwrGitResponse,
  type OpenPwrSnapResponse,
  type PwrGitConnectionStatus,
  type PwrSnapConnectionStatus,
  type ReadPwrSnapConnectionStatusRequest,
} from "@pwragent/shared";
import {
  MCP_CONNECTION_PWRGIT_CONNECT_CHANNEL,
  MCP_CONNECTION_PWRGIT_DOWNLOAD_CHANNEL,
  MCP_CONNECTION_PWRGIT_OPEN_CHANNEL,
  MCP_CONNECTION_PWRGIT_STATUS_CHANNEL,
  MCP_CONNECTION_AUTHORIZE_CHANNEL,
  MCP_CONNECTION_CANCEL_AUTHORIZE_CHANNEL,
  MCP_CONNECTION_CREATE_CHANNEL,
  MCP_CONNECTION_DISCONNECT_CHANNEL,
  MCP_CONNECTION_LIST_CHANNEL,
  MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL,
  MCP_CONNECTION_PWRSNAP_DOWNLOAD_CHANNEL,
  MCP_CONNECTION_PWRSNAP_OPEN_CHANNEL,
  MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL,
  MCP_CONNECTION_REMOVE_CHANNEL,
  MCP_CONNECTION_SET_ENABLED_CHANNEL,
  MCP_CONNECTION_SET_SELECT_FOR_NEW_THREADS_CHANNEL,
  MCP_CONNECTION_SET_TOOL_APPROVAL_CHANNEL,
  MCP_CONNECTION_LIST_TOOLS_CHANNEL,
  MCP_CONNECTION_SET_THREAD_CHANNEL,
  MCP_CONNECTION_READ_THREAD_CHANNEL,
  MCP_CONNECTION_DESCRIBE_THREAD_CHANNEL,
  MCP_CONNECTION_UPDATE_CHANNEL,
  MCP_CONNECTION_PROBE_CHANNEL,
  PWRSUITE_INSTALLER_CANCEL_CHANNEL,
  PWRSUITE_INSTALLER_EVENT_CHANNEL,
  PWRSUITE_INSTALLER_OPEN_CHANNEL,
  PWRSUITE_INSTALLER_READ_CHANNEL,
  PWRSUITE_INSTALLER_REVEAL_CHANNEL,
  PWRSUITE_INSTALLER_START_CHANNEL,
} from "../../shared/ipc";
import type {
  PwrSuiteAppId,
  PwrSuiteInstallerActionResult,
  PwrSuiteInstallerState,
} from "../../shared/pwrsuite-installer";
import {
  getMcpConnectionGatewayService,
  type McpConnectionGatewayService,
} from "../mcp-connections/mcp-connection-gateway-service";
import {
  getPwrGitConnectionService,
  type PwrGitConnectionService,
} from "../mcp-connections/pwrgit-connection-service";
import {
  getPwrSuiteInstallerService,
  isPwrSuiteAppId,
  type PwrSuiteInstallerService,
} from "../mcp-connections/pwrsuite-installer-service";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { federationWindowTargetForWebContents } from "../window";
import { subscribersForChannel } from "../window-channels";

let unsubscribeInstallerEvents: (() => void) | undefined;

export function registerMcpConnectionIpcHandlers(
  service: McpConnectionGatewayService = getMcpConnectionGatewayService(),
  pwrGit: PwrGitConnectionService = getPwrGitConnectionService(),
  installer: PwrSuiteInstallerService = getPwrSuiteInstallerService(),
): void {
  registerPwrGitHandlers(pwrGit);
  registerPwrSuiteInstallerHandlers(installer);
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
  ipcMain.removeHandler(MCP_CONNECTION_CANCEL_AUTHORIZE_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_CANCEL_AUTHORIZE_CHANNEL,
    async (
      event,
      request: CancelMcpConnectionAuthorizationRequest,
    ): Promise<MutateMcpConnectionResponse> => {
      requireLocalOwner(event);
      const connection: McpConnectionStatus =
        await service.cancelAuthorization(request.connectionId);
      return { connectionId: request.connectionId, connection };
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
  ipcMain.removeHandler(MCP_CONNECTION_SET_SELECT_FOR_NEW_THREADS_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_SET_SELECT_FOR_NEW_THREADS_CHANNEL,
    async (
      event,
      request: SetMcpConnectionSelectForNewThreadsRequest,
    ): Promise<MutateMcpConnectionResponse> => {
      requireLocalOwner(event);
      const connection: McpConnectionStatus =
        await service.setConnectionSelectForNewThreads(
          request.connectionId,
          request.selectForNewThreads,
        );
      return { connectionId: request.connectionId, connection };
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_SET_TOOL_APPROVAL_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_SET_TOOL_APPROVAL_CHANNEL,
    async (
      event,
      request: SetMcpConnectionToolApprovalRequest,
    ): Promise<MutateMcpConnectionResponse> => {
      requireLocalOwner(event);
      if (!isMcpConnectionToolApproval(request?.toolApproval)) {
        throw new Error("Choose a tool approval mode for this MCP connection.");
      }
      const connection: McpConnectionStatus =
        await service.setConnectionToolApproval(
          request.connectionId,
          request.toolApproval,
        );
      return { connectionId: request.connectionId, connection };
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_LIST_TOOLS_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_LIST_TOOLS_CHANNEL,
    async (
      event,
      request: ListMcpConnectionToolsRequest,
    ): Promise<ListMcpConnectionToolsResponse> => {
      requireLocalOwner(event);
      return await service.listConnectionTools(request);
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
  ipcMain.removeHandler(MCP_CONNECTION_READ_THREAD_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_READ_THREAD_CHANNEL,
    async (
      event,
      request: ReadThreadMcpConnectionsRequest,
    ): Promise<SetThreadMcpConnectionsResponse> => {
      requireLocalOwner(event);
      return await getDesktopBackendRegistry().readThreadMcpConnections(request);
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_DESCRIBE_THREAD_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_DESCRIBE_THREAD_CHANNEL,
    async (
      event,
      request: DescribeThreadMcpConnectionsRequest,
    ): Promise<DescribeThreadMcpConnectionsResponse> => {
      requireLocalOwner(event);
      return await getDesktopBackendRegistry()
        .describeThreadMcpConnections(request);
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_UPDATE_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_UPDATE_CHANNEL,
    async (
      event,
      request: UpdateMcpConnectionRequest,
    ): Promise<MutateMcpConnectionResponse> => {
      requireLocalOwner(event);
      const connection = await service.updateConnection(request);
      return { connectionId: connection.id, connection };
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_PROBE_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_PROBE_CHANNEL,
    async (
      event,
      request: ProbeMcpConnectionRequest,
    ): Promise<ProbeMcpConnectionResponse> => {
      requireLocalOwner(event);
      return await service.probeConnection(request);
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

/**
 * PwrGit pairing runs on the machine that owns the window, the same rule
 * PwrSnap uses: a remote viewer must not be able to mint a credential against
 * the owner's repositories, and an install check on the viewer's machine says
 * nothing about the owner's.
 */
function registerPwrGitHandlers(service: PwrGitConnectionService): void {
  ipcMain.removeHandler(MCP_CONNECTION_PWRGIT_STATUS_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_PWRGIT_STATUS_CHANNEL,
    async (event): Promise<PwrGitConnectionStatus> => {
      if (federationWindowTargetForWebContents(event.sender)) {
        return {
          connectionId: "pwrgit",
          displayName: "PwrGit",
          availability: "not_installed",
          configured: false,
        };
      }
      return await service.readStatus();
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_PWRGIT_CONNECT_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_PWRGIT_CONNECT_CHANNEL,
    async (event): Promise<ConnectPwrGitResponse> => {
      if (federationWindowTargetForWebContents(event.sender)) {
        throw new Error(
          "PwrGit pairing is only available on the machine that owns this window.",
        );
      }
      return await service.connect();
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_PWRGIT_OPEN_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_PWRGIT_OPEN_CHANNEL,
    async (event): Promise<OpenPwrGitResponse> => {
      if (federationWindowTargetForWebContents(event.sender)) {
        return {
          opened: false,
          error: "This thread uses PwrGit on its remote owner.",
        };
      }
      return await service.openApplication();
    },
  );
  ipcMain.removeHandler(MCP_CONNECTION_PWRGIT_DOWNLOAD_CHANNEL);
  ipcMain.handle(
    MCP_CONNECTION_PWRGIT_DOWNLOAD_CHANNEL,
    async (event): Promise<OpenPwrGitResponse> => {
      if (federationWindowTargetForWebContents(event.sender)) {
        return {
          opened: false,
          error: "Install PwrGit on the machine that owns this thread.",
        };
      }
      return await service.openDownload();
    },
  );
}

/**
 * The launchpad tiles' installer downloads. They land in this machine's
 * Downloads folder, so a federation window, which fronts another machine, is
 * refused: the owner would need the app, not the viewer.
 */
function registerPwrSuiteInstallerHandlers(
  service: PwrSuiteInstallerService,
): void {
  const requireLocalApp = (
    event: Electron.IpcMainInvokeEvent,
    app: unknown,
  ): PwrSuiteAppId => {
    if (federationWindowTargetForWebContents(event.sender)) {
      throw new Error("Install PwrSuite apps on the machine that owns this thread.");
    }
    if (!isPwrSuiteAppId(app)) {
      throw new Error("Unknown PwrSuite app.");
    }
    return app;
  };
  unsubscribeInstallerEvents?.();
  unsubscribeInstallerEvents = service.subscribe((state) => {
    for (const webContents of subscribersForChannel(
      PWRSUITE_INSTALLER_EVENT_CHANNEL,
    )) {
      if (!webContents.isDestroyed()) {
        webContents.send(PWRSUITE_INSTALLER_EVENT_CHANNEL, state);
      }
    }
  });
  ipcMain.removeHandler(PWRSUITE_INSTALLER_READ_CHANNEL);
  ipcMain.handle(
    PWRSUITE_INSTALLER_READ_CHANNEL,
    async (event, app: unknown): Promise<PwrSuiteInstallerState> =>
      service.readState(requireLocalApp(event, app)),
  );
  ipcMain.removeHandler(PWRSUITE_INSTALLER_START_CHANNEL);
  ipcMain.handle(
    PWRSUITE_INSTALLER_START_CHANNEL,
    async (event, app: unknown): Promise<PwrSuiteInstallerState> =>
      await service.start(requireLocalApp(event, app)),
  );
  ipcMain.removeHandler(PWRSUITE_INSTALLER_CANCEL_CHANNEL);
  ipcMain.handle(
    PWRSUITE_INSTALLER_CANCEL_CHANNEL,
    async (event, app: unknown): Promise<PwrSuiteInstallerState> =>
      service.cancel(requireLocalApp(event, app)),
  );
  ipcMain.removeHandler(PWRSUITE_INSTALLER_OPEN_CHANNEL);
  ipcMain.handle(
    PWRSUITE_INSTALLER_OPEN_CHANNEL,
    async (event, app: unknown): Promise<PwrSuiteInstallerActionResult> =>
      await service.openInstaller(requireLocalApp(event, app)),
  );
  ipcMain.removeHandler(PWRSUITE_INSTALLER_REVEAL_CHANNEL);
  ipcMain.handle(
    PWRSUITE_INSTALLER_REVEAL_CHANNEL,
    async (event, app: unknown): Promise<PwrSuiteInstallerActionResult> =>
      service.revealInstaller(requireLocalApp(event, app)),
  );
}

export function disposeMcpConnectionIpcHandlers(): void {
  unsubscribeInstallerEvents?.();
  unsubscribeInstallerEvents = undefined;
  ipcMain.removeHandler(PWRSUITE_INSTALLER_READ_CHANNEL);
  ipcMain.removeHandler(PWRSUITE_INSTALLER_START_CHANNEL);
  ipcMain.removeHandler(PWRSUITE_INSTALLER_CANCEL_CHANNEL);
  ipcMain.removeHandler(PWRSUITE_INSTALLER_OPEN_CHANNEL);
  ipcMain.removeHandler(PWRSUITE_INSTALLER_REVEAL_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_LIST_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_LIST_TOOLS_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_SET_SELECT_FOR_NEW_THREADS_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_SET_TOOL_APPROVAL_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_CREATE_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_AUTHORIZE_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_CANCEL_AUTHORIZE_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_DISCONNECT_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_REMOVE_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_SET_ENABLED_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_SET_THREAD_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_READ_THREAD_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_DESCRIBE_THREAD_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_UPDATE_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PROBE_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_OPEN_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRSNAP_DOWNLOAD_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRGIT_STATUS_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRGIT_CONNECT_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRGIT_OPEN_CHANNEL);
  ipcMain.removeHandler(MCP_CONNECTION_PWRGIT_DOWNLOAD_CHANNEL);
}
