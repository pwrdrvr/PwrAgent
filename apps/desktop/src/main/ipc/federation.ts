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
  SetFederationEventSubscriptionsRequest,
  SetFederationEventSubscriptionsResponse,
} from "@pwragent/shared";
import {
  isCelestialIconId,
  isFederationEventClass,
  isFederationInstanceId,
} from "@pwragent/shared";
import {
  FEDERATION_GET_HEALTH_CHANNEL,
  FEDERATION_GET_DIAGNOSTICS_CHANNEL,
  FEDERATION_GENERATE_INVITE_CHANNEL,
  FEDERATION_IMPORT_INVITE_CHANNEL,
  FEDERATION_OPEN_WINDOW_CHANNEL,
  FEDERATION_RESET_ENROLLMENT_CHANNEL,
  FEDERATION_REVOKE_PEER_CHANNEL,
  FEDERATION_SET_CELESTIAL_ICON_CHANNEL,
  FEDERATION_SET_EVENT_SUBSCRIPTIONS_CHANNEL,
  FEDERATION_TAILSCALE_CONFIGURE_CHANNEL,
  FEDERATION_TAILSCALE_STATUS_CHANNEL,
} from "../../shared/ipc";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { getFederationTailscaleService } from "../federation/federation-tailscale";
import { createMainWindow } from "../window";

const rendererSubscriptionCleanupIds = new Set<number>();

function peerAllowsEventClass(
  capabilities: readonly string[],
  eventClass: string,
): boolean {
  switch (eventClass) {
    case "navigation":
    case "star_map":
      return capabilities.includes("thread_navigation");
    case "transcript":
      return capabilities.includes("thread_detail");
    case "pending_requests":
      return capabilities.includes("pending_request_control");
    case "scheduled_actions":
      return capabilities.includes("scheduled_actions");
    default:
      return false;
  }
}

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
  ipcMain.removeHandler(FEDERATION_SET_EVENT_SUBSCRIPTIONS_CHANNEL);
  ipcMain.handle(
    FEDERATION_SET_EVENT_SUBSCRIPTIONS_CHANNEL,
    async (
      event,
      request: SetFederationEventSubscriptionsRequest,
    ): Promise<SetFederationEventSubscriptionsResponse> => {
      const runtime = getDesktopFederationRuntime();
      if (!rendererSubscriptionCleanupIds.has(event.sender.id)) {
        const webContentsId = event.sender.id;
        rendererSubscriptionCleanupIds.add(webContentsId);
        event.sender.once("destroyed", () => {
          rendererSubscriptionCleanupIds.delete(webContentsId);
          runtime.clearRendererEventSubscriptions(webContentsId);
        });
      }
      const peers = new Map(
        runtime.connectedPeerTargets().map((peer) => [
          peer.target.instanceId,
          peer,
        ]),
      );
      const subscriptions = Array.isArray(request?.subscriptions)
        ? request.subscriptions.flatMap((subscription) => {
            const peer = peers.get(subscription?.sourceInstanceId);
            if (!peer || !peer.capabilities.includes("event_subscriptions")) {
              return [];
            }
            const eventClasses = Array.isArray(subscription.eventClasses)
              ? subscription.eventClasses.filter(
                  (eventClass) =>
                    isFederationEventClass(eventClass)
                    && peerAllowsEventClass(peer.capabilities, eventClass),
                )
              : [];
            return eventClasses.length > 0
              ? [{
                  sourceInstanceId: peer.target.instanceId,
                  eventClasses,
                }]
              : [];
          })
        : [];
      return {
        subscriptions: runtime.setRendererEventSubscriptions(
          event.sender.id,
          "star-map",
          subscriptions,
        ),
      };
    },
  );
  ipcMain.handle(
    FEDERATION_SET_CELESTIAL_ICON_CHANNEL,
    async (
      _event,
      request: SetCelestialIconRequest,
    ): Promise<SetCelestialIconResponse> => {
      if (
        !isFederationInstanceId(request.instanceId)
        || (request.icon !== null && !isCelestialIconId(request.icon))
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
      const webContentsId = window.webContents.id;
      runtime.setRendererEventSubscriptions(webContentsId, "remote-window", [{
        sourceInstanceId: request.target.instanceId,
        eventClasses: [
          ...(peer.capabilities.includes("thread_navigation")
            ? ["navigation" as const]
            : []),
          ...(peer.capabilities.includes("thread_detail")
            ? ["transcript" as const]
            : []),
          ...(peer.capabilities.includes("pending_request_control")
            ? ["pending_requests" as const]
            : []),
          ...(peer.capabilities.includes("scheduled_actions")
            ? ["scheduled_actions" as const]
            : []),
        ],
      }]);
      window.once("closed", () => {
        runtime.clearRendererEventSubscriptions(webContentsId, "remote-window");
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
  ipcMain.removeHandler(FEDERATION_SET_EVENT_SUBSCRIPTIONS_CHANNEL);
  rendererSubscriptionCleanupIds.clear();
}
