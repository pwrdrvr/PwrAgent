import { ipcMain } from "electron";
import type { ManageAgentNotificationsRequest } from "@pwragent/shared/contracts/scheduled-thread-actions";
import {
  AGENT_NOTIFICATIONS_CHANGED_EVENT_CHANNEL,
  AGENT_NOTIFICATIONS_MANAGE_CHANNEL,
} from "../../../shared/ipc";
import { getDesktopFederationRuntime } from "../../federation/federation-runtime";
import { getMainLogger } from "../../log";
import { ownerNotifications, requestShowThread } from "../../owner-host";
import { manageLocalAgentNotifications } from "../../scheduled-actions/agent-notification-operations";
import { FederatedAgentNotifications } from "../../scheduled-actions/federated-agent-notifications";
import { getDesktopSettingsService } from "../../settings/desktop-settings-singleton";
import { federationTargetForChannelSubscriber, subscribersForChannel } from "../window-channels";

const AGENT_NOTIFICATIONS_EVENT_CONSUMER_ID = "agent-notifications-watch";
const log = getMainLogger("pwragent:agent-notifications");

let unsubscribe: (() => void) | undefined;

function broadcastChanged(): void {
  for (const webContents of subscribersForChannel(AGENT_NOTIFICATIONS_CHANGED_EVENT_CHANNEL)) {
    if (!webContents.isDestroyed()) webContents.send(AGENT_NOTIFICATIONS_CHANGED_EVENT_CHANNEL);
  }
}

/**
 * The notices each window shows: a main window this machine's and its
 * connected peers', a peer's window that peer's. See
 * `FederatedAgentNotifications`.
 */
export function registerAgentNotificationIpcHandlers(): void {
  const runtime = getDesktopFederationRuntime();
  const notices = new FederatedAgentNotifications({
    local: (request) => manageLocalAgentNotifications(request),
    remote: (target, request) => runtime.requestAgentNotifications(target, request),
    peers: () => {
      try {
        return runtime.connectedPeerTargets()
          .filter((peer) => peer.capabilities.includes("agent_notifications"))
          .map((peer) => ({ target: peer.target, label: peer.shortLabel ?? peer.label }));
      } catch {
        // Federation state is not readable yet; the first peer status change syncs again.
        return [];
      }
    },
    watch: (instanceIds) => {
      runtime.setEventSubscriptions(AGENT_NOTIFICATIONS_EVENT_CONSUMER_ID, instanceIds.map((sourceInstanceId) => ({
        sourceInstanceId,
        eventClasses: ["agent_notifications" as const],
        // The class is threadless (`eventMatchesThreadSelection`). An empty
        // selection leaves the merged selection the other consumers made.
        threadSelection: { kind: "threads" as const, threads: [] },
      })));
    },
    nativeNotificationsEnabled: () => {
      try {
        return getDesktopSettingsService().resolveNotificationsEnabled();
      } catch {
        return false;
      }
    },
    notifyNative: (params) => ownerNotifications().notifyAttention(params),
    clearNative: (key) => ownerNotifications().clearAttentionKey(key),
    showThread: (request) => requestShowThread(request),
    changed: broadcastChanged,
    warn: (message, fields) => log.warn(message, fields),
  });
  unsubscribe?.();
  const offEvents = runtime.onRemoteBackendEvent((event) => notices.onRemoteEvent(event));
  const offPeers = runtime.onPeerStatusChanged(() => notices.syncPeers());
  // A peer's notices name it; a new short name relabels them.
  const offNames = runtime.onShortNamesChanged(() => notices.syncPeers());
  unsubscribe = () => {
    offEvents();
    offPeers();
    offNames();
    runtime.setEventSubscriptions(AGENT_NOTIFICATIONS_EVENT_CONSUMER_ID, []);
  };
  notices.syncPeers();

  ipcMain.removeHandler(AGENT_NOTIFICATIONS_MANAGE_CHANNEL);
  ipcMain.handle(AGENT_NOTIFICATIONS_MANAGE_CHANNEL, async (event, request: ManageAgentNotificationsRequest) =>
    await notices.manage(request, federationTargetForChannelSubscriber(event.sender)));
}
