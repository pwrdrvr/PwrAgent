import { ipcMain } from "electron";
import type {
  ConfigureFederationTailscaleRequest,
  ConfigureFederationTailscaleResponse,
  GenerateFederationInviteRequest,
  GenerateFederationInviteResponse,
  ImportFederationInviteRequest,
  ImportFederationInviteResponse,
  OpenFederationWindowRequest,
  OpenFederationWindowResponse,
  ResetFederationEnrollmentRequest,
  ResetFederationEnrollmentResponse,
  ReadFederationHealthRequest,
  ReadFederationHealthResponse,
  ReadFederationDiagnosticsRequest,
  ReadFederationDiagnosticsResponse,
  ReadFederationTailscaleStatusRequest,
  ReadFederationTailscaleStatusResponse,
  RevokeFederationPeerRequest,
  RevokeFederationPeerResponse,
  SetCelestialIconRequest,
  SetCelestialIconResponse,
} from "@pwragent/shared";
import { isCelestialIconId, isFederationInstanceId } from "@pwragent/shared";
import {
  FEDERATION_GET_HEALTH_CHANNEL,
  FEDERATION_GET_DIAGNOSTICS_CHANNEL,
  FEDERATION_GENERATE_INVITE_CHANNEL,
  FEDERATION_IMPORT_INVITE_CHANNEL,
  FEDERATION_OPEN_WINDOW_CHANNEL,
  FEDERATION_RESET_ENROLLMENT_CHANNEL,
  FEDERATION_REVOKE_PEER_CHANNEL,
  FEDERATION_SET_CELESTIAL_ICON_CHANNEL,
  FEDERATION_TAILSCALE_CONFIGURE_CHANNEL,
  FEDERATION_TAILSCALE_STATUS_CHANNEL,
} from "../../shared/ipc";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { getFederationTailscaleService } from "../federation/federation-tailscale";
import { createMainWindow } from "../window";

export function registerFederationIpcHandlers(): void {
  ipcMain.removeHandler(FEDERATION_OPEN_WINDOW_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GET_HEALTH_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GET_DIAGNOSTICS_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GENERATE_INVITE_CHANNEL);
  ipcMain.removeHandler(FEDERATION_IMPORT_INVITE_CHANNEL);
  ipcMain.removeHandler(FEDERATION_REVOKE_PEER_CHANNEL);
  ipcMain.removeHandler(FEDERATION_RESET_ENROLLMENT_CHANNEL);
  ipcMain.removeHandler(FEDERATION_TAILSCALE_STATUS_CHANNEL);
  ipcMain.removeHandler(FEDERATION_TAILSCALE_CONFIGURE_CHANNEL);
  ipcMain.removeHandler(FEDERATION_SET_CELESTIAL_ICON_CHANNEL);
  ipcMain.handle(
    FEDERATION_SET_CELESTIAL_ICON_CHANNEL,
    async (
      _event,
      request: SetCelestialIconRequest,
    ): Promise<SetCelestialIconResponse> => {
      if (
        !isFederationInstanceId(request.instanceId)
        || !isCelestialIconId(request.icon)
      ) {
        throw new Error("Invalid celestial icon override request");
      }
      return await getDesktopFederationRuntime().setCelestialIcon(request);
    },
  );
  ipcMain.handle(
    FEDERATION_TAILSCALE_STATUS_CHANNEL,
    async (
      _event,
      _request?: ReadFederationTailscaleStatusRequest,
    ): Promise<ReadFederationTailscaleStatusResponse> => ({
      status: await getFederationTailscaleService().readStatus(),
    }),
  );
  ipcMain.handle(
    FEDERATION_TAILSCALE_CONFIGURE_CHANNEL,
    async (
      _event,
      request: ConfigureFederationTailscaleRequest,
    ): Promise<ConfigureFederationTailscaleResponse> =>
      await getFederationTailscaleService().configure(request),
  );
  ipcMain.handle(
    FEDERATION_GET_DIAGNOSTICS_CHANNEL,
    async (
      _event,
      request: ReadFederationDiagnosticsRequest = {},
    ): Promise<ReadFederationDiagnosticsResponse> =>
      await getDesktopFederationRuntime().diagnostics(request),
  );
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
      const runtime = getDesktopFederationRuntime();
      const peer = runtime.connectedPeerTargets().find(
        (candidate) =>
          candidate.target.instanceId === request.target.instanceId,
      );
      if (!peer) {
        throw new Error("Federation peer is not connected.");
      }
      if (!peer.capabilities.includes("remote_window")) {
        throw new Error(
          "Federation peer does not allow remote windows (remote_window capability).",
        );
      }
      if (
        request.initialThread &&
        (
          request.initialThread.target.scope !== "remote" ||
          request.initialThread.target.instanceId !== request.target.instanceId
        )
      ) {
        throw new Error("Federation initial thread target does not match its window.");
      }
      const window = createMainWindow({
        federationLabel: peer.label,
        federationTarget: request.target,
        initialThread: request.initialThread
          ? {
              backend: request.initialThread.backend,
              threadId: request.initialThread.threadId,
            }
          : undefined,
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
  ipcMain.handle(
    FEDERATION_RESET_ENROLLMENT_CHANNEL,
    async (
      _event,
      _request?: ResetFederationEnrollmentRequest,
    ): Promise<ResetFederationEnrollmentResponse> =>
      await getDesktopFederationRuntime().resetEnrollment(),
  );
  ipcMain.handle(
    FEDERATION_REVOKE_PEER_CHANNEL,
    async (
      _event,
      request: RevokeFederationPeerRequest,
    ): Promise<RevokeFederationPeerResponse> => {
      if (!isFederationInstanceId(request.peerId)) {
        throw new Error("Invalid federation peer id");
      }
      return {
        peer: await getDesktopFederationRuntime().revokePeer(request.peerId),
      };
    },
  );
}

export function disposeFederationIpcHandlers(): void {
  ipcMain.removeHandler(FEDERATION_OPEN_WINDOW_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GET_HEALTH_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GET_DIAGNOSTICS_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GENERATE_INVITE_CHANNEL);
  ipcMain.removeHandler(FEDERATION_IMPORT_INVITE_CHANNEL);
  ipcMain.removeHandler(FEDERATION_REVOKE_PEER_CHANNEL);
  ipcMain.removeHandler(FEDERATION_RESET_ENROLLMENT_CHANNEL);
  ipcMain.removeHandler(FEDERATION_TAILSCALE_STATUS_CHANNEL);
  ipcMain.removeHandler(FEDERATION_TAILSCALE_CONFIGURE_CHANNEL);
  ipcMain.removeHandler(FEDERATION_SET_CELESTIAL_ICON_CHANNEL);
}
