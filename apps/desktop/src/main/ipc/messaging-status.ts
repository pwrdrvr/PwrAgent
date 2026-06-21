import { BrowserWindow, ipcMain } from "electron";
import type {
  ApproveMessagingPairingRequest,
  ApproveMessagingPairingResponse,
  DesktopAuthorizedContact,
  DesktopSettingsConfigPatch,
  DesktopSettingsSnapshot,
  GenerateMessagingPairingTokenRequest,
  GenerateMessagingPairingTokenResponse,
  GetMessagingActivitySummaryResponse,
  InboundPreviewMessage,
  ListInboundTopicsRequest,
  ListInboundTopicsResponse,
  ListMessagingActivityRequest,
  ListMessagingActivityResponse,
  ListMessagingPairingRequestsRequest,
  ListMessagingPairingRequestsResponse,
  MessagingPairingApprovalTarget,
  MessagingPairingEntry,
  MessagingPlatformStatus,
  MessagingPlatformStatusEvent,
  RejectMessagingPairingRequest,
  RejectMessagingPairingResponse,
  SetMessagingEnabledRequest,
  SetMessagingEnabledResponse,
  StartInboundPreviewRequest,
  StartInboundPreviewResponse,
  StopInboundPreviewRequest,
  UnbindMessagingThreadRequest,
  UnbindMessagingThreadResponse,
} from "@pwragent/shared";
import {
  validateSlackChannelId,
  validateSlackTeamId,
  validateSlackUserId,
} from "@pwragent/shared";
import { getDesktopMessagingRuntime } from "../messaging/messaging-runtime";
import { loadDesktopMessagingConfigFromSettings } from "../messaging/messaging-config";
import { getDesktopMessagingActivityLog } from "../messaging/desktop-messaging-activity-log";
import { getDesktopMessagingPairingStore } from "../messaging/desktop-messaging-pairing-store";
import { getMainLogger } from "../log";
import { timeStartupProfileOperation } from "../diagnostics/startup-profile-events";
import { showMessagingActivityWindow } from "../messaging-activity-window";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import type { DesktopSettingsService } from "../settings/desktop-settings-service";
import { resolveRuntimeMessagingOverride } from "../runtime-flags";
import { getRuntimeMessagingLeaseCoordinator } from "../runtime-messaging-lease";
import { subscribersForChannel } from "../window-channels";
import {
  MESSAGING_BINDINGS_CHANGED_EVENT_CHANNEL,
  MESSAGING_APPROVE_PAIRING_CHANNEL,
  MESSAGING_GENERATE_PAIRING_TOKEN_CHANNEL,
  MESSAGING_GET_ACTIVITY_SUMMARY_CHANNEL,
  MESSAGING_GET_PLATFORM_STATUSES_CHANNEL,
  MESSAGING_INBOUND_PREVIEW_EVENT_CHANNEL,
  MESSAGING_LIST_ACTIVITY_CHANNEL,
  MESSAGING_LIST_INBOUND_TOPICS_CHANNEL,
  MESSAGING_LIST_PAIRING_REQUESTS_CHANNEL,
  MESSAGING_OPEN_ACTIVITY_WINDOW_CHANNEL,
  MESSAGING_PAIRING_CHANGED_EVENT_CHANNEL,
  MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL,
  MESSAGING_REJECT_PAIRING_CHANNEL,
  MESSAGING_SET_ENABLED_CHANNEL,
  MESSAGING_SHUTDOWN_RUNTIME_CHANNEL,
  MESSAGING_START_INBOUND_PREVIEW_CHANNEL,
  MESSAGING_STOP_INBOUND_PREVIEW_CHANNEL,
  MESSAGING_UNBIND_THREAD_CHANNEL,
} from "../../shared/ipc";
import {
  resetInboundPreview,
  setInboundPreviewSink,
  startInboundPreview,
  stopInboundPreview,
} from "../messaging/inbound-preview-bus";
import { getDesktopMessagingStore } from "../messaging/desktop-messaging-store";

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
  target?: MessagingPairingApprovalTarget,
  options?: { teamName?: string },
): { added: boolean; patch: DesktopSettingsConfigPatch } {
  if (entry.status !== "observed" || !entry.observedActor || !entry.observedChat) {
    throw new Error("Pairing request has not been observed yet.");
  }

  const approvalTarget = entry.platform === "slack" ? target : undefined;
  const contact = contactForPairing(entry, approvalTarget, options?.teamName);
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
      if (approvalTarget === "team") {
        const merged = merge(snapshot.messaging.slack.authorizedWorkspaces.value);
        return {
          added: merged.added,
          patch: { messaging: { slack: { authorizedWorkspaces: merged.contacts } } },
        };
      }
      if (approvalTarget === "conversation" || (!approvalTarget && entry.scope === "bucket")) {
        if (entry.observedChat.kind === "dm") {
          throw new Error("Slack channel approval requires a channel or group DM.");
        }
        const merged = merge(snapshot.messaging.slack.authorizedChannels.value);
        return {
          added: merged.added,
          patch: { messaging: { slack: { authorizedChannels: merged.contacts } } },
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

function contactForPairing(
  entry: MessagingPairingEntry,
  target?: MessagingPairingApprovalTarget,
  teamName?: string,
): DesktopAuthorizedContact {
  if (!entry.observedActor || !entry.observedChat) {
    throw new Error("Pairing request is missing observed identity.");
  }
  const isSlack = entry.platform === "slack";
  if (target === "team") {
    // The team/workspace ID is the observed bucket (Slack teamId). Never fall
    // back to parentId — for a thread that is the thread timestamp, not a team.
    // Validate the shape so a bogus bucketId (e.g. a channel/DM id from an
    // event that omitted `team`) can't be written into the workspace allowlist.
    const id = entry.observedChat.bucketId;
    if (!id || (isSlack && !validateSlackTeamId(id).ok)) {
      throw new Error(
        "Slack team approval requires a valid workspace ID (starts with T).",
      );
    }
    // The workspace name is resolved best-effort at approval time (blank if the
    // lookup is unavailable or times out). Never use parentTitle — for a
    // channel/thread that is the *channel* name, not the workspace name.
    return { id, displayName: teamName ?? "" };
  }
  if (target === "conversation" || (!target && entry.scope === "bucket")) {
    if (isSlack) {
      const id = entry.observedChat.id;
      if (!validateSlackChannelId(id).ok) {
        throw new Error(
          "Slack channel approval requires a valid conversation ID (starts with C, G, or D).",
        );
      }
      return { id, displayName: slackChannelDisplayName(entry.observedChat) };
    }
    const id = entry.observedChat.bucketId ?? entry.observedChat.parentId ?? entry.observedChat.id;
    return {
      id,
      displayName: entry.observedChat.title ?? entry.observedChat.parentTitle ?? "",
    };
  }
  if (isSlack && !validateSlackUserId(entry.observedActor.id).ok) {
    throw new Error(
      "Slack user approval requires a valid user ID (starts with U or W).",
    );
  }
  return {
    id: entry.observedActor.id,
    displayName:
      entry.observedActor.displayName
      ?? (entry.observedActor.username ? `@${entry.observedActor.username}` : ""),
  };
}

/**
 * Best-effort Slack workspace/team name lookup for a pairing approval. Uses the
 * same `resolveContact` path as the Settings "Lookup" button, but bounded by a
 * short timeout and swallowing all failures so approval never hangs or throws —
 * a blank name just means the operator can Lookup it later.
 */
async function resolveSlackWorkspaceName(
  service: DesktopSettingsService,
  teamId: string,
  options?: { timeoutMs?: number },
): Promise<string | undefined> {
  const botToken = service.resolveSlackBotTokenSync();
  if (!botToken) return undefined;
  try {
    const provider = await import("@pwragent/messaging-provider-slack");
    const result = await withTimeout(
      provider.resolveContact({ botToken }, { id: teamId, kind: "workspace" }),
      options?.timeoutMs ?? 2_000,
    );
    if (result && result.status === "ok" && result.displayName) {
      return result.displayName;
    }
  } catch (error) {
    log.warn("slack workspace pairing name lookup failed", {
      teamId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return undefined;
}

/** Resolve `promise`, or `undefined` if it takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  // Clear the timer once either side settles so the fast path doesn't keep a
  // 2s timer (and this closure) alive after `promise` already resolved.
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * A confirmation note sent to the Slack user after approving one facet of a
 * pairing. Tells them what they can do now and what is still gated, so a
 * partial approval (e.g. user-only) doesn't leave them wondering why the bot
 * won't answer in a channel yet.
 */
function slackApprovalConfirmationText(
  target: MessagingPairingApprovalTarget,
  entry: MessagingPairingEntry,
  snapshot: DesktopSettingsSnapshot,
): string {
  const slack = snapshot.messaging.slack;
  const inList = (
    list: readonly DesktopAuthorizedContact[],
    id: string | undefined,
  ): boolean => !!id && list.some((contact) => contact.id === id);

  // State *after* this approval — the just-approved target counts as added.
  const userAuthorized =
    target === "actor" || inList(slack.authorizedUserIds.value, entry.observedActor?.id);
  const channelAuthorized =
    slack.channelAuthorizationMode?.value === "allow_all"
    || target === "conversation"
    || inList(slack.authorizedChannels.value, entry.observedChat?.id);
  const teamAuthorized =
    slack.teamAuthorizationMode?.value === "allow_all"
    || target === "team"
    || inList(slack.authorizedWorkspaces.value, entry.observedChat?.bucketId);

  switch (target) {
    case "actor":
      if (entry.observedChat?.kind === "dm") {
        return "You're now an authorized user — you can DM the bot.";
      }
      if (channelAuthorized && teamAuthorized) {
        return "You're now an authorized user. You can DM the bot and @mention it in this channel.";
      }
      return "You're now an authorized user and can DM the bot. This channel isn't authorized yet, so the bot can't respond here until the channel is approved.";
    case "conversation":
      if (userAuthorized) {
        return "This channel is authorized. Authorized users (including you) can @mention the bot here.";
      }
      return "This channel is authorized. Authorized users can @mention the bot here, but you aren't an authorized user yet — approve your user to interact.";
    case "team":
      return "This workspace is authorized. Channels still need to be approved individually unless channel access is set to allow any channel.";
    default:
      return "PwrAgent pairing approved.";
  }
}

/**
 * The channel name for a Slack observed chat. For a thread the channel name
 * lives in `parentTitle` (its `title` is the thread's root message); for a
 * plain channel it lives in `title`.
 */
function slackChannelDisplayName(
  chat: NonNullable<MessagingPairingEntry["observedChat"]>,
): string {
  if (chat.kind === "thread") {
    return chat.parentTitle ?? chat.title ?? "";
  }
  return chat.title ?? chat.parentTitle ?? "";
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
      return await timeStartupProfileOperation({
        type: "ipc-main:getMessagingPlatformStatuses",
        operation: async () => runtime.getPlatformStatuses(),
      });
    },
  );

  setInboundPreviewSink((message: InboundPreviewMessage) => {
    fanOut(MESSAGING_INBOUND_PREVIEW_EVENT_CHANNEL, message);
  });

  ipcMain.removeHandler(MESSAGING_START_INBOUND_PREVIEW_CHANNEL);
  ipcMain.handle(
    MESSAGING_START_INBOUND_PREVIEW_CHANNEL,
    async (
      event,
      request: StartInboundPreviewRequest,
    ): Promise<StartInboundPreviewResponse> => {
      startInboundPreview(request.subscriptionId, {
        conversationId: request.conversationId,
        provider: request.provider,
        ...(request.parentId ? { parentId: request.parentId } : {}),
      });
      // Reap the scope if the renderer goes away without sending stop (window
      // close, reload, or crash) so it can't keep matching forever.
      event.sender.once("destroyed", () => {
        stopInboundPreview(request.subscriptionId);
      });
      // Best-effort history backfill (Slack today). Pushed through the same
      // preview event channel as live messages, oldest-first, so the renderer
      // shows recent context immediately instead of an empty "waiting" panel.
      void (async () => {
        try {
          const history = await runtime.fetchRecentPreviewMessages({
            provider: request.provider,
            conversationId: request.conversationId,
            ...(request.parentId ? { parentId: request.parentId } : {}),
          });
          for (const message of history) {
            fanOut(MESSAGING_INBOUND_PREVIEW_EVENT_CHANNEL, message);
          }
        } catch {
          // History is optional; live capture continues regardless.
        }
      })();
      return { ok: true };
    },
  );

  ipcMain.removeHandler(MESSAGING_STOP_INBOUND_PREVIEW_CHANNEL);
  ipcMain.handle(
    MESSAGING_STOP_INBOUND_PREVIEW_CHANNEL,
    async (_event, request: StopInboundPreviewRequest): Promise<void> => {
      stopInboundPreview(request.subscriptionId);
    },
  );

  ipcMain.removeHandler(MESSAGING_LIST_INBOUND_TOPICS_CHANNEL);
  ipcMain.handle(
    MESSAGING_LIST_INBOUND_TOPICS_CHANNEL,
    async (
      _event,
      request: ListInboundTopicsRequest,
    ): Promise<ListInboundTopicsResponse> => {
      if (!request.groupId) return { topics: [] };
      const records = await getDesktopMessagingStore().findManagedTopicsForSupergroup(
        { channel: request.provider, supergroupId: request.groupId },
      );
      const topics = records
        .filter((record) => record.lifecycle !== "deleted")
        .map((record) => ({
          id: record.topicId,
          title: record.conversation.title ?? record.topicId,
        }));
      return { topics };
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

  ipcMain.removeHandler(MESSAGING_GET_ACTIVITY_SUMMARY_CHANNEL);
  ipcMain.handle(
    MESSAGING_GET_ACTIVITY_SUMMARY_CHANNEL,
    async (): Promise<GetMessagingActivitySummaryResponse> => {
      return getDesktopMessagingActivityLog().getPlatformActivitySummary();
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
      // For a Slack team approval, resolve the workspace name best-effort so the
      // saved row carries a label (blank on failure/timeout), mirroring how the
      // channel name is captured at observe time.
      const teamName =
        pairing.platform === "slack"
        && request.target === "team"
        && pairing.observedChat?.bucketId
          ? await resolveSlackWorkspaceName(service, pairing.observedChat.bucketId)
          : undefined;
      const snapshot = await service.readSettings();
      const approval = buildPairingApprovalPatch(
        pairing,
        snapshot,
        request.target,
        { teamName },
      );
      const next = await service.writeConfigPatch(approval.patch);
      await getRuntimeMessagingLeaseCoordinator().applyLatestConfig(
        runtime,
        (options) => loadDesktopMessagingConfigFromSettings(service, process.env, options),
        {
          logStartupEligibility: true,
        },
      );
      // Keep the request `observed` when the caller opts out of consuming
      // (Slack "approve user, then channel, then team" flow). We record the
      // approved target so the settings card can show progress, and confirm the
      // grant to the user with a note describing what they can do now and what
      // is still gated.
      const stay =
        request.consume === false
        && pairing.platform === "slack"
        && pairing.scope === "observed"
        && request.target !== undefined;
      if (stay) {
        const target = request.target as MessagingPairingApprovalTarget;
        const updated =
          getDesktopMessagingPairingStore().recordApproval({
            entryId: request.entryId,
            target,
          }) ?? pairing;
        recordPairingActivity(updated, `Approved pairing (${target})`);
        await runtime.deliverPairingOutcome(updated, "approved", {
          text: slackApprovalConfirmationText(target, updated, snapshot),
        });
        broadcastPairingChanged({ at: Date.now(), entry: updated });
        log.info("messaging pairing target approved", {
          pairingId: request.entryId,
          platform: pairing.platform,
          target: request.target,
          added: approval.added,
          configPath: next.configPath,
        });
        return { entry: updated, added: approval.added };
      }
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
        const result = await getRuntimeMessagingLeaseCoordinator().applyLatestConfig(
          runtime,
          (options) => loadDesktopMessagingConfigFromSettings(
            getDesktopSettingsService(),
            process.env,
            options,
          ),
          {
            logStartupEligibility: true,
            messagingEnabledOverride: true,
          },
        );
        const override = resolveRuntimeMessagingOverride();
        return {
          enabled: result.enabled,
          overridden: override.disabled || result.disabledReasonKind === "lease_held",
          ...(override.reason ? { overrideReason: override.reason } : {}),
          ...(result.disabledReason ? { disabledReason: result.disabledReason } : {}),
          ...(result.disabledReasonKind
            ? { disabledReasonKind: result.disabledReasonKind }
            : {}),
          ...(result.leaseHolder ? { leaseHolder: result.leaseHolder } : {}),
        };
      } else {
        const result = await getRuntimeMessagingLeaseCoordinator()
          .disableForSession(runtime);
        const override = resolveRuntimeMessagingOverride();
        return {
          enabled: result.enabled,
          overridden: override.disabled,
          ...(override.reason ? { overrideReason: override.reason } : {}),
          ...(result.disabledReason ? { disabledReason: result.disabledReason } : {}),
          ...(result.disabledReasonKind
            ? { disabledReasonKind: result.disabledReasonKind }
            : {}),
        };
      }
    },
  );

  ipcMain.removeHandler(MESSAGING_OPEN_ACTIVITY_WINDOW_CHANNEL);
  ipcMain.handle(
    MESSAGING_OPEN_ACTIVITY_WINDOW_CHANNEL,
    async (event): Promise<void> => {
      showMessagingActivityWindow({
        sourceWindow: BrowserWindow.fromWebContents(event.sender),
      });
    },
  );

  ipcMain.removeHandler(MESSAGING_SHUTDOWN_RUNTIME_CHANNEL);
  ipcMain.handle(MESSAGING_SHUTDOWN_RUNTIME_CHANNEL, async (): Promise<void> => {
    // Called by the wizard right before it spawns the operator's
    // chosen profile in a new Electron process. The bootstrap's
    // adapters (Telegram long-poll, Discord gateway, etc.) hold
    // exclusive resources upstream; if we don't release them first
    // the child process's adapters race and lose (Telegram 409,
    // Discord "another shard already connected", etc.).
    //
    // `shutdown` stops the runtime AND releases the runtime-messaging
    // lease, mirroring the SIGTERM cleanup path. Idempotent — calling
    // it twice or when nothing is running is a no-op.
    try {
      await getRuntimeMessagingLeaseCoordinator().shutdown(runtime);
      log.info("messaging runtime shutdown via wizard graduation");
    } catch (error) {
      log.warn("messaging runtime shutdown failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export async function disposeMessagingStatusIpcHandlers(): Promise<void> {
  unsubscribePlatformStatus?.();
  unsubscribePlatformStatus = undefined;
  unsubscribeBindingsChanged?.();
  unsubscribeBindingsChanged = undefined;
  unsubscribePairingChanged?.();
  unsubscribePairingChanged = undefined;
  setInboundPreviewSink(undefined);
  ipcMain.removeHandler(MESSAGING_START_INBOUND_PREVIEW_CHANNEL);
  ipcMain.removeHandler(MESSAGING_STOP_INBOUND_PREVIEW_CHANNEL);
  ipcMain.removeHandler(MESSAGING_LIST_INBOUND_TOPICS_CHANNEL);
  ipcMain.removeHandler(MESSAGING_GET_PLATFORM_STATUSES_CHANNEL);
  ipcMain.removeHandler(MESSAGING_LIST_ACTIVITY_CHANNEL);
  ipcMain.removeHandler(MESSAGING_GET_ACTIVITY_SUMMARY_CHANNEL);
  ipcMain.removeHandler(MESSAGING_GENERATE_PAIRING_TOKEN_CHANNEL);
  ipcMain.removeHandler(MESSAGING_LIST_PAIRING_REQUESTS_CHANNEL);
  ipcMain.removeHandler(MESSAGING_APPROVE_PAIRING_CHANNEL);
  ipcMain.removeHandler(MESSAGING_REJECT_PAIRING_CHANNEL);
  ipcMain.removeHandler(MESSAGING_UNBIND_THREAD_CHANNEL);
  ipcMain.removeHandler(MESSAGING_SET_ENABLED_CHANNEL);
  ipcMain.removeHandler(MESSAGING_OPEN_ACTIVITY_WINDOW_CHANNEL);
  ipcMain.removeHandler(MESSAGING_SHUTDOWN_RUNTIME_CHANNEL);
}
