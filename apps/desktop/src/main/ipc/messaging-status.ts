import { ipcMain } from "electron";
import type {
  ApproveMessagingPairingRequest,
  ApproveMessagingPairingResponse,
  DesktopAuthorizedContact,
  DesktopSettingsConfigPatch,
  DesktopSettingsSnapshot,
  GenerateMessagingPairingTokenRequest,
  GenerateMessagingPairingTokenResponse,
  ListMessagingActivityRequest,
  ListMessagingActivityResponse,
  ListMessagingPairingRequestsRequest,
  ListMessagingPairingRequestsResponse,
  MessagingPairingEntry,
  MessagingPlatformStatus,
  MessagingPlatformStatusEvent,
  RejectMessagingPairingRequest,
  RejectMessagingPairingResponse,
  SetMessagingEnabledRequest,
  SetMessagingEnabledResponse,
  UnbindMessagingThreadRequest,
  UnbindMessagingThreadResponse,
} from "@pwragent/shared";
import { getDesktopMessagingRuntime } from "../messaging/messaging-runtime";
import { loadDesktopMessagingConfigFromSettings } from "../messaging/messaging-config";
import { getDesktopMessagingActivityLog } from "../messaging/desktop-messaging-activity-log";
import { getDesktopMessagingPairingStore } from "../messaging/desktop-messaging-pairing-store";
import { getMainLogger } from "../log";
import { showMessagingActivityWindow } from "../messaging-activity-window";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { resolveRuntimeMessagingOverride } from "../runtime-flags";
import { subscribersForChannel } from "../window-channels";
import {
  MESSAGING_BINDINGS_CHANGED_EVENT_CHANNEL,
  MESSAGING_APPROVE_PAIRING_CHANNEL,
  MESSAGING_GENERATE_PAIRING_TOKEN_CHANNEL,
  MESSAGING_GET_PLATFORM_STATUSES_CHANNEL,
  MESSAGING_LIST_ACTIVITY_CHANNEL,
  MESSAGING_LIST_PAIRING_REQUESTS_CHANNEL,
  MESSAGING_OPEN_ACTIVITY_WINDOW_CHANNEL,
  MESSAGING_PAIRING_CHANGED_EVENT_CHANNEL,
  MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL,
  MESSAGING_REJECT_PAIRING_CHANNEL,
  MESSAGING_SET_ENABLED_CHANNEL,
  MESSAGING_UNBIND_THREAD_CHANNEL,
} from "../../shared/ipc";

const log = getMainLogger("pwragent:messaging-ipc");

let unsubscribePlatformStatus: (() => void) | undefined;
let unsubscribeBindingsChanged: (() => void) | undefined;
let unsubscribePairingChanged: (() => void) | undefined;

/**
 * Send a payload to every window that has subscribed to `channel`
 * via `registerWindowChannels`. Skips windows that opted out (e.g.
 * the Messaging Activity window, which polls instead). Replaces
 * the previous `BrowserWindow.getAllWindows()` fan-out so additional
 * secondary windows pay zero IPC cost for events they don't consume.
 */
function fanOut(channel: string, payload: unknown): void {
  for (const webContents of subscribersForChannel(channel)) {
    if (typeof webContents.send !== "function") continue;
    webContents.send(channel, payload);
  }
}

function broadcastPlatformStatusEvent(event: MessagingPlatformStatusEvent): void {
  fanOut(MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL, event);
}

function broadcastBindingsChanged(): void {
  fanOut(MESSAGING_BINDINGS_CHANGED_EVENT_CHANNEL, { at: Date.now() });
}

function broadcastPairingChanged(event: { at: number; entry: MessagingPairingEntry }): void {
  fanOut(MESSAGING_PAIRING_CHANGED_EVENT_CHANNEL, event);
}

function markPairingConsumed(entryId: string): MessagingPairingEntry | undefined {
  return getDesktopMessagingPairingStore().markStatus({
    entryId,
    status: "consumed",
  });
}

function markPairingRejected(entryId: string): MessagingPairingEntry | undefined {
  return getDesktopMessagingPairingStore().markStatus({
    entryId,
    status: "rejected",
  });
}

function buildPairingApprovalPatch(
  entry: MessagingPairingEntry,
  snapshot: DesktopSettingsSnapshot,
): { added: boolean; patch: DesktopSettingsConfigPatch } {
  if (entry.status !== "observed" || !entry.observedActor || !entry.observedChat) {
    throw new Error("Pairing request has not been observed yet.");
  }

  const contact = contactForPairing(entry);
  const merge = (
    current: DesktopAuthorizedContact[],
  ): { added: boolean; contacts: DesktopAuthorizedContact[] } => {
    if (current.some((existing) => existing.id === contact.id)) {
      return { added: false, contacts: current };
    }
    return { added: true, contacts: [...current, contact] };
  };

  switch (entry.platform) {
    case "telegram": {
      if (entry.scope === "bucket") {
        const merged = merge(snapshot.messaging.telegram.authorizedSupergroups.value);
        return {
          added: merged.added,
          patch: { messaging: { telegram: { authorizedSupergroups: merged.contacts } } },
        };
      }
      const merged = merge(snapshot.messaging.telegram.authorizedUserIds.value);
      return {
        added: merged.added,
        patch: { messaging: { telegram: { authorizedUserIds: merged.contacts } } },
      };
    }
    case "discord": {
      if (entry.scope === "bucket") {
        const merged = merge(snapshot.messaging.discord.authorizedGuilds.value);
        return {
          added: merged.added,
          patch: { messaging: { discord: { authorizedGuilds: merged.contacts } } },
        };
      }
      const merged = merge(snapshot.messaging.discord.authorizedUserIds.value);
      return {
        added: merged.added,
        patch: { messaging: { discord: { authorizedUserIds: merged.contacts } } },
      };
    }
    case "mattermost": {
      if (entry.scope === "bucket") {
        throw new Error("Mattermost bucket pairing is not supported by the current settings schema.");
      }
      const merged = merge(snapshot.messaging.mattermost.authorizedUserIds.value);
      return {
        added: merged.added,
        patch: { messaging: { mattermost: { authorizedUserIds: merged.contacts } } },
      };
    }
    case "slack": {
      if (entry.scope === "bucket") {
        const merged = merge(snapshot.messaging.slack.authorizedWorkspaces.value);
        return {
          added: merged.added,
          patch: { messaging: { slack: { authorizedWorkspaces: merged.contacts } } },
        };
      }
      const merged = merge(snapshot.messaging.slack.authorizedUserIds.value);
      return {
        added: merged.added,
        patch: { messaging: { slack: { authorizedUserIds: merged.contacts } } },
      };
    }
    case "feishu": {
      const mergeFeishuContact = (
        current: DesktopAuthorizedContact[],
        feishuContact: DesktopAuthorizedContact,
      ): { added: boolean; contacts: DesktopAuthorizedContact[] } => {
        if (current.some((existing) => existing.id === feishuContact.id)) {
          return { added: false, contacts: current };
        }
        return { added: true, contacts: [...current, feishuContact] };
      };
      if (entry.scope === "bucket") {
        const feishuChatContact = {
          id: entry.observedChat.id,
          displayName: entry.observedChat.title ?? "",
        };
        const merged = mergeFeishuContact(
          snapshot.messaging.feishu.authorizedChats.value,
          feishuChatContact,
        );
        return {
          added: merged.added,
          patch: { messaging: { feishu: { authorizedChats: merged.contacts } } },
        };
      }
      const merged = merge(snapshot.messaging.feishu.authorizedUserIds.value);
      if (entry.scope === "user_in_group" && entry.observedChat.kind !== "dm") {
        const mergedChat = mergeFeishuContact(
          snapshot.messaging.feishu.authorizedChats.value,
          {
            id: entry.observedChat.id,
            displayName: entry.observedChat.title ?? "",
          },
        );
        return {
          added: merged.added || mergedChat.added,
          patch: {
            messaging: {
              feishu: {
                authorizedChats: mergedChat.contacts,
                authorizedUserIds: merged.contacts,
              },
            },
          },
        };
      }
      return {
        added: merged.added,
        patch: { messaging: { feishu: { authorizedUserIds: merged.contacts } } },
      };
    }
    case "line": {
      if (entry.scope === "bucket") {
        if (contact.id.startsWith("C")) {
          const merged = merge(snapshot.messaging.line.authorizedGroups.value);
          return {
            added: merged.added,
            patch: { messaging: { line: { authorizedGroups: merged.contacts } } },
          };
        }
        if (contact.id.startsWith("R")) {
          const merged = merge(snapshot.messaging.line.authorizedRooms.value);
          return {
            added: merged.added,
            patch: { messaging: { line: { authorizedRooms: merged.contacts } } },
          };
        }
        throw new Error("LINE bucket pairing requires a group or room ID.");
      }
      const merged = merge(snapshot.messaging.line.authorizedUserIds.value);
      return {
        added: merged.added,
        patch: { messaging: { line: { authorizedUserIds: merged.contacts } } },
      };
    }
    default:
      throw new Error(`Pairing approval is not supported for ${entry.platform}.`);
  }
}

function contactForPairing(entry: MessagingPairingEntry): DesktopAuthorizedContact {
  if (!entry.observedActor || !entry.observedChat) {
    throw new Error("Pairing request is missing observed identity.");
  }
  if (entry.scope === "bucket") {
    return {
      id: entry.observedChat.bucketId ?? entry.observedChat.parentId ?? entry.observedChat.id,
      displayName: entry.observedChat.title ?? entry.observedChat.parentTitle ?? "",
    };
  }
  return {
    id: entry.observedActor.id,
    displayName:
      entry.observedActor.displayName
      ?? (entry.observedActor.username ? `@${entry.observedActor.username}` : ""),
  };
}

function recordPairingActivity(entry: MessagingPairingEntry, summary: string): void {
  try {
    getDesktopMessagingActivityLog().record({
      platform: entry.platform,
      kind: "pairing",
      conversationId: entry.observedChat?.id,
      conversationTitle: entry.observedChat?.title,
      actorId: entry.observedActor?.id,
      actorDisplayName: entry.observedActor?.displayName,
      summary,
      payload: {
        pairingId: entry.id,
        scope: entry.scope,
        status: entry.status,
        instanceId: entry.instanceId,
        expiresAt: entry.expiresAt,
        conversationKind: entry.observedChat?.kind,
        conversationParentId: entry.observedChat?.parentId,
        conversationParentTitle: entry.observedChat?.parentTitle,
        conversationBucketId: entry.observedChat?.bucketId,
        actorUsername: entry.observedActor?.username,
      },
    });
  } catch (error) {
    log.warn("messaging pairing activity write failed", {
      pairingId: entry.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function registerMessagingStatusIpcHandlers(): void {
  const runtime = getDesktopMessagingRuntime();

  unsubscribePlatformStatus?.();
  unsubscribePlatformStatus = runtime.onPlatformStatus(
    broadcastPlatformStatusEvent,
  );
  unsubscribeBindingsChanged?.();
  unsubscribeBindingsChanged = runtime.onBindingsChanged(broadcastBindingsChanged);
  unsubscribePairingChanged?.();
  unsubscribePairingChanged = runtime.onPairingChanged(broadcastPairingChanged);

  ipcMain.removeHandler(MESSAGING_GET_PLATFORM_STATUSES_CHANNEL);
  ipcMain.handle(
    MESSAGING_GET_PLATFORM_STATUSES_CHANNEL,
    async (): Promise<MessagingPlatformStatus[]> => {
      return runtime.getPlatformStatuses();
    },
  );

  ipcMain.removeHandler(MESSAGING_LIST_ACTIVITY_CHANNEL);
  ipcMain.handle(
    MESSAGING_LIST_ACTIVITY_CHANNEL,
    async (
      _event,
      request: ListMessagingActivityRequest | undefined,
    ): Promise<ListMessagingActivityResponse> => {
      const entries = getDesktopMessagingActivityLog().list({
        limit: request?.limit,
        sinceId: request?.sinceId,
      });
      return { entries };
    },
  );

  ipcMain.removeHandler(MESSAGING_GENERATE_PAIRING_TOKEN_CHANNEL);
  ipcMain.handle(
    MESSAGING_GENERATE_PAIRING_TOKEN_CHANNEL,
    async (
      _event,
      request: GenerateMessagingPairingTokenRequest,
    ): Promise<GenerateMessagingPairingTokenResponse> => {
      return runtime.generatePairingToken(request);
    },
  );

  ipcMain.removeHandler(MESSAGING_LIST_PAIRING_REQUESTS_CHANNEL);
  ipcMain.handle(
    MESSAGING_LIST_PAIRING_REQUESTS_CHANNEL,
    async (
      _event,
      request: ListMessagingPairingRequestsRequest | undefined,
    ): Promise<ListMessagingPairingRequestsResponse> => {
      return runtime.listPairingRequests(request);
    },
  );

  ipcMain.removeHandler(MESSAGING_APPROVE_PAIRING_CHANNEL);
  ipcMain.handle(
    MESSAGING_APPROVE_PAIRING_CHANNEL,
    async (
      _event,
      request: ApproveMessagingPairingRequest,
    ): Promise<ApproveMessagingPairingResponse> => {
      const service = getDesktopSettingsService();
      const pairing = runtime.listPairingRequests({ includeResolved: true }).entries
        .find((entry) => entry.id === request.entryId);
      if (!pairing) throw new Error("Pairing request not found.");
      const approval = buildPairingApprovalPatch(pairing, await service.readSettings());
      const next = await service.writeConfigPatch(approval.patch);
      await runtime.applyConfig(
        await loadDesktopMessagingConfigFromSettings(service, process.env, {
          logStartupEligibility: true,
        }),
        { allowStart: true },
      );
      const consumed = markPairingConsumed(request.entryId);
      recordPairingActivity(consumed ?? pairing, "Approved pairing request");
      await runtime.deliverPairingOutcome(consumed ?? pairing, "approved");
      broadcastPairingChanged({ at: Date.now(), entry: consumed ?? pairing });
      log.info("messaging pairing approved", {
        pairingId: request.entryId,
        platform: pairing.platform,
        added: approval.added,
        configPath: next.configPath,
      });
      return { entry: consumed ?? pairing, added: approval.added };
    },
  );

  ipcMain.removeHandler(MESSAGING_REJECT_PAIRING_CHANNEL);
  ipcMain.handle(
    MESSAGING_REJECT_PAIRING_CHANNEL,
    async (
      _event,
      request: RejectMessagingPairingRequest,
    ): Promise<RejectMessagingPairingResponse> => {
      const entry = markPairingRejected(request.entryId);
      if (!entry) throw new Error("Pairing request not found.");
      recordPairingActivity(entry, "Rejected pairing request");
      await runtime.deliverPairingOutcome(entry, "rejected");
      broadcastPairingChanged({ at: Date.now(), entry });
      return { entry };
    },
  );

  ipcMain.removeHandler(MESSAGING_UNBIND_THREAD_CHANNEL);
  ipcMain.handle(
    MESSAGING_UNBIND_THREAD_CHANNEL,
    async (
      _event,
      request: UnbindMessagingThreadRequest,
    ): Promise<UnbindMessagingThreadResponse> => {
      // Emit on the runtime bus rather than touching the store
      // directly. The runtime fans out to whichever controller owns
      // the binding's channel, which delivers the platform-side
      // retirement + "Thread detached" confirmation. This keeps the
      // IPC layer free of any per-platform knowledge — adding
      // Slack / Mattermost requires zero changes here.
      const result = await runtime.requestBindingRevoke({
        bindingId: request.bindingId,
        origin: "ui",
      });
      log.info("messaging binding unbound", {
        bindingId: request.bindingId,
        revoked: result.revoked,
        notifiedPlatform: result.notifiedPlatform,
      });
      return { revoked: result.revoked, bindingId: request.bindingId };
    },
  );

  ipcMain.removeHandler(MESSAGING_SET_ENABLED_CHANNEL);
  ipcMain.handle(
    MESSAGING_SET_ENABLED_CHANNEL,
    async (
      _event,
      request: SetMessagingEnabledRequest,
    ): Promise<SetMessagingEnabledResponse> => {
      if (request.enabled) {
        await runtime.applyConfig(
          await loadDesktopMessagingConfigFromSettings(
            getDesktopSettingsService(),
            process.env,
            {
              logStartupEligibility: true,
              messagingEnabledOverride: true,
            },
          ),
          { allowStart: true },
        );
      } else {
        await runtime.stop();
      }

      const override = resolveRuntimeMessagingOverride();
      return {
        enabled: runtime.isEnabled(),
        overridden: override.disabled,
        ...(override.reason ? { overrideReason: override.reason } : {}),
      };
    },
  );

  ipcMain.removeHandler(MESSAGING_OPEN_ACTIVITY_WINDOW_CHANNEL);
  ipcMain.handle(MESSAGING_OPEN_ACTIVITY_WINDOW_CHANNEL, async (): Promise<void> => {
    showMessagingActivityWindow();
  });
}

export async function disposeMessagingStatusIpcHandlers(): Promise<void> {
  unsubscribePlatformStatus?.();
  unsubscribePlatformStatus = undefined;
  unsubscribeBindingsChanged?.();
  unsubscribeBindingsChanged = undefined;
  unsubscribePairingChanged?.();
  unsubscribePairingChanged = undefined;
  ipcMain.removeHandler(MESSAGING_GET_PLATFORM_STATUSES_CHANNEL);
  ipcMain.removeHandler(MESSAGING_LIST_ACTIVITY_CHANNEL);
  ipcMain.removeHandler(MESSAGING_GENERATE_PAIRING_TOKEN_CHANNEL);
  ipcMain.removeHandler(MESSAGING_LIST_PAIRING_REQUESTS_CHANNEL);
  ipcMain.removeHandler(MESSAGING_APPROVE_PAIRING_CHANNEL);
  ipcMain.removeHandler(MESSAGING_REJECT_PAIRING_CHANNEL);
  ipcMain.removeHandler(MESSAGING_UNBIND_THREAD_CHANNEL);
  ipcMain.removeHandler(MESSAGING_SET_ENABLED_CHANNEL);
  ipcMain.removeHandler(MESSAGING_OPEN_ACTIVITY_WINDOW_CHANNEL);
}
