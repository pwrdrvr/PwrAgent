import { ipcMain } from "electron";
import type {
  ConfigureFederationTailscaleRequest,
  ConfigureFederationTailscaleResponse,
  FederationPinDisposition,
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
  ReadFederationInstanceLoadRequest,
  ReadFederationInstanceLoadResponse,
  ReadFederationDiagnosticsRequest,
  ReadFederationDiagnosticsResponse,
  ReadFederationPinImpactRequest,
  ReadFederationPinImpactResponse,
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
  isFederationPinDisposition,
} from "@pwragent/shared";
import {
  FEDERATION_GET_HEALTH_CHANNEL,
  FEDERATION_GET_DIAGNOSTICS_CHANNEL,
  FEDERATION_READ_INSTANCE_LOAD_CHANNEL,
  FEDERATION_GENERATE_INVITE_CHANNEL,
  FEDERATION_IMPORT_INVITE_CHANNEL,
  FEDERATION_OPEN_WINDOW_CHANNEL,
  FEDERATION_PIN_IMPACT_CHANNEL,
  FEDERATION_RESET_ENROLLMENT_CHANNEL,
  FEDERATION_REVOKE_PEER_CHANNEL,
  FEDERATION_SET_CELESTIAL_ICON_CHANNEL,
  FEDERATION_SET_EVENT_SUBSCRIPTIONS_CHANNEL,
  FEDERATION_TAILSCALE_CONFIGURE_CHANNEL,
  FEDERATION_TAILSCALE_STATUS_CHANNEL,
} from "../../shared/ipc";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { getFederationTailscaleService } from "../federation/federation-tailscale";
import { createFederationWindow } from "../federation/federation-window";

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
  ipcMain.removeHandler(FEDERATION_READ_INSTANCE_LOAD_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GET_DIAGNOSTICS_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GENERATE_INVITE_CHANNEL);
  ipcMain.removeHandler(FEDERATION_IMPORT_INVITE_CHANNEL);
  ipcMain.removeHandler(FEDERATION_REVOKE_PEER_CHANNEL);
  ipcMain.removeHandler(FEDERATION_RESET_ENROLLMENT_CHANNEL);
  ipcMain.removeHandler(FEDERATION_TAILSCALE_STATUS_CHANNEL);
  ipcMain.removeHandler(FEDERATION_TAILSCALE_CONFIGURE_CHANNEL);
  ipcMain.removeHandler(FEDERATION_SET_CELESTIAL_ICON_CHANNEL);
  ipcMain.removeHandler(FEDERATION_SET_EVENT_SUBSCRIPTIONS_CHANNEL);
  ipcMain.removeHandler(FEDERATION_PIN_IMPACT_CHANNEL);
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
          request.consumer === "thread_view" ? "thread-view" : "star-map",
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
      if (
        request.initialThread &&
        (
          request.initialThread.target.scope !== "remote" ||
          request.initialThread.target.instanceId !== request.target.instanceId
        )
      ) {
        throw new Error("Federation initial thread target does not match its window.");
      }
      const window = createFederationWindow({
        peer,
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
    FEDERATION_READ_INSTANCE_LOAD_CHANNEL,
    async (
      _event,
      request?: ReadFederationInstanceLoadRequest,
    ): Promise<ReadFederationInstanceLoadResponse> => {
      const instanceId = request?.instanceId;
      if (instanceId !== undefined && !isFederationInstanceId(instanceId)) {
        throw new Error("Invalid federation instance id");
      }
      const runtime = getDesktopFederationRuntime();
      const health = await runtime.health();
      try {
        if (!instanceId || instanceId === health.instanceId) {
          return { load: await runtime.localBackend().getLoadStatus() };
        }
        const peer = runtime.connectedPeerTargets().find(
          (candidate) => candidate.target.instanceId === instanceId,
        );
        if (!peer || !peer.capabilities.includes("thread_navigation")) {
          // Unreachable reads as "no load reading", never an error — a
          // polling health surface wants a missing indicator, not a
          // dialog, when a peer drops mid-poll.
          return {};
        }
        return {
          load: await runtime.remoteBackend(peer.target).getLoadStatus(),
        };
      } catch {
        return {};
      }
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
      request?: ResetFederationEnrollmentRequest,
    ): Promise<ResetFederationEnrollmentResponse> =>
      await getDesktopFederationRuntime().resetEnrollment({
        pinDisposition: readPinDisposition(request?.pinDisposition),
      }),
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
        peer: await getDesktopFederationRuntime().revokePeer(request.peerId, {
          pinDisposition: readPinDisposition(request.pinDisposition),
        }),
      };
    },
  );
  ipcMain.handle(
    FEDERATION_PIN_IMPACT_CHANNEL,
    async (
      _event,
      request: ReadFederationPinImpactRequest,
    ): Promise<ReadFederationPinImpactResponse> => {
      const scope = request?.scope;
      if (scope?.kind === "peer") {
        if (!isFederationInstanceId(scope.peerId)) {
          throw new Error("Invalid federation peer id");
        }
      } else if (scope?.kind !== "enrollment") {
        throw new Error("Invalid federation pin impact scope");
      }
      return await getDesktopFederationRuntime().readRemoteThreadPinImpact({
        scope,
      });
    },
  );
}

/**
 * An absent or unrecognized disposition means "remember". Discarding an
 * operator's pinned threads is irreversible, so an out-of-date renderer or
 * a malformed payload must never be able to select the destructive branch
 * by accident — only an explicit "forget" does.
 */
function readPinDisposition(value: unknown): FederationPinDisposition {
  return isFederationPinDisposition(value) ? value : "remember";
}

export function disposeFederationIpcHandlers(): void {
  ipcMain.removeHandler(FEDERATION_OPEN_WINDOW_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GET_HEALTH_CHANNEL);
  ipcMain.removeHandler(FEDERATION_READ_INSTANCE_LOAD_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GET_DIAGNOSTICS_CHANNEL);
  ipcMain.removeHandler(FEDERATION_GENERATE_INVITE_CHANNEL);
  ipcMain.removeHandler(FEDERATION_IMPORT_INVITE_CHANNEL);
  ipcMain.removeHandler(FEDERATION_REVOKE_PEER_CHANNEL);
  ipcMain.removeHandler(FEDERATION_RESET_ENROLLMENT_CHANNEL);
  ipcMain.removeHandler(FEDERATION_TAILSCALE_STATUS_CHANNEL);
  ipcMain.removeHandler(FEDERATION_TAILSCALE_CONFIGURE_CHANNEL);
  ipcMain.removeHandler(FEDERATION_SET_CELESTIAL_ICON_CHANNEL);
  ipcMain.removeHandler(FEDERATION_SET_EVENT_SUBSCRIPTIONS_CHANNEL);
  ipcMain.removeHandler(FEDERATION_PIN_IMPACT_CHANNEL);
  rendererSubscriptionCleanupIds.clear();
}
