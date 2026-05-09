import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type {
  MessagingActorIdentity,
  MessagingAdapterState,
  MessagingAttachmentDescriptor,
  MessagingAttachmentDownloadRequest,
  MessagingAttachmentDownloadResult,
  MessagingCallbackHandleStore,
  MessagingCapabilityProfile,
  MessagingChannelRef,
  MessagingConversationKind,
  MessagingConversationTitleUpdateRequest,
  MessagingConversationTitleUpdateResult,
  MessagingDeliveryResult,
  MessagingFilePart,
  MessagingInboundEvent,
  MessagingInboundRejectedListener,
  MessagingJsonValue,
  MessagingRejectedInboundEvent,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
  MessagingSurfaceRef,
} from "@pwragent/messaging-interface";
import type { SlackMessagingConfig } from "./slack-config.ts";
import {
  actionsForSlackIntent,
  buildSlackActionBlocks,
  buildSlackBlocksForIntent,
  clampSlackMessage,
  markdownToSlackMrkdwn,
  textForSlackIntent,
  type SlackBlock,
  type SlackPostBody,
} from "./slack-formatting.ts";
import {
  logSlackInvalidIdentifier,
  validateSlackCallbackHandle,
  validateSlackChannelId,
  validateSlackFileId,
  validateSlackMessageTs,
  validateSlackTeamId,
  validateSlackUserId,
} from "./validate-ids.ts";

const SLACK_CALLBACK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SLACK_SIGNED_VALUE_VERSION = 1;
const SLACK_INBOUND_EVENT_DEDUPE_TTL_MS = 5 * 60 * 1000;
const SLACK_INBOUND_EVENT_DEDUPE_MAX = 200;

export type SlackProviderLogger = {
  debug?: (message: string, data?: Record<string, unknown>) => void;
  info?: (message: string, data?: Record<string, unknown>) => void;
  warn?: (message: string, data?: Record<string, unknown>) => void;
  error?: (message: string, data?: Record<string, unknown>) => void;
};

export type SlackApi = {
  authTest(): Promise<SlackAuthTestResult>;
  conversationsInfo?(params: { channel: string }): Promise<SlackConversationInfo | undefined>;
  conversationsReplies?(params: {
    channel: string;
    limit?: number;
    ts: string;
  }): Promise<SlackThreadMessageInfo[]>;
  deleteMessage(params: { channel: string; ts: string }): Promise<void>;
  downloadFile(params: { url: string; maxBytes: number }): Promise<Uint8Array>;
  filesInfo(params: { file: string }): Promise<SlackFileInfo | undefined>;
  postMessage(params: SlackPostBody): Promise<SlackMessageResult>;
  updateMessage(params: SlackPostBody & { ts: string }): Promise<SlackMessageResult>;
  uploadFile?(params: {
    channel: string;
    data: Uint8Array;
    filename: string;
    mimeType?: string;
    threadTs?: string;
    title?: string;
  }): Promise<void>;
  usersInfo?(params: { user: string }): Promise<SlackUserInfo | undefined>;
};

export type SlackSocketClient = {
  disconnect(): Promise<void>;
  off?(event: string, listener: (payload: unknown) => void): unknown;
  on(event: string, listener: (payload: unknown) => void): unknown;
  removeAllListeners?(event?: string): unknown;
  start(): Promise<unknown>;
};

export type SlackAuthTestResult = {
  bot_id?: string;
  team?: string;
  team_id?: string;
  url?: string;
  user?: string;
  user_id?: string;
};

export type SlackMessageResult = {
  channel?: string;
  ts?: string;
};

export type SlackConversationInfo = {
  id?: string;
  name?: string;
};

export type SlackThreadMessageInfo = {
  text?: string;
  ts?: string;
};

export type SlackFileInfo = {
  id?: string;
  mimetype?: string;
  name?: string;
  size?: number;
  title?: string;
  url_private?: string;
  url_private_download?: string;
};

export type SlackUserInfo = {
  id?: string;
  name?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
  };
  real_name?: string;
};

export type SlackProviderAdapter = {
  authorizedActorIds: readonly string[];
  capabilityProfile: MessagingCapabilityProfile;
  channel: "slack";
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  downloadAttachment(
    request: MessagingAttachmentDownloadRequest,
  ): Promise<MessagingAttachmentDownloadResult>;
  onInboundRejected?(listener: MessagingInboundRejectedListener): () => void;
  setConversationTitle(
    request: MessagingConversationTitleUpdateRequest,
  ): Promise<MessagingConversationTitleUpdateResult>;
  start(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
};

export type SlackAdapterOptions = {
  api?: SlackApi;
  callbackHandleStore: MessagingCallbackHandleStore;
  config: SlackMessagingConfig;
  logger?: SlackProviderLogger;
  now?: () => number;
  socketClient?: SlackSocketClient;
};

type SlackSurfaceOpaqueState = {
  channelId?: string;
  threadTs?: string;
  ts?: string;
};

type SlackInboundListener = (event: MessagingInboundEvent) => Promise<void>;

type SlackSocketEnvelope = {
  ack?: (response?: unknown) => Promise<void> | void;
  body?: unknown;
  event?: unknown;
};

type SlackMessageEvent = {
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  event_ts?: string;
  files?: SlackFileInfo[];
  subtype?: string;
  team?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  type: "app_mention" | "message";
  user?: string;
};

type SlackBlockActionPayload = {
  actions?: Array<{ action_id?: string; value?: string }>;
  channel?: { id?: string; name?: string };
  container?: { thread_ts?: string; type?: string };
  message?: { ts?: string; thread_ts?: string };
  team?: { id?: string };
  type?: string;
  user?: { id?: string; name?: string; username?: string };
};

type SlackSlashCommandPayload = {
  channel_id?: string;
  channel_name?: string;
  command?: string;
  team_id?: string;
  text?: string;
  thread_ts?: string;
  trigger_id?: string;
  user_id?: string;
  user_name?: string;
};

export class SlackAdapter implements SlackProviderAdapter {
  readonly channel = "slack" as const;
  readonly capabilityProfile: MessagingCapabilityProfile = {
    actions: {
      // Slack Block Kit actions blocks allow at most 25 elements.
      // Source: https://docs.slack.dev/reference/block-kit/blocks/actions-block/
      maxActions: 25,
      // Slack does not expose explicit columns, but composing multiple
      // actions blocks gives stable rows. Five matches the existing
      // provider visual budget and keeps rows scannable.
      maxActionsPerRow: 5,
      maxRows: 5,
      // Slack button text max is 75 chars; clients may visually truncate
      // around 30. Source: Slack Block Kit button element reference.
      maxLabelLength: 75,
      supportsStyles: true,
      supportsDisabled: false,
      supportsLayoutHints: true,
      // Slack button `value` max is 2,000 chars.
      // Source: Slack Block Kit button element reference.
      maxCallbackPayloadBytes: 2_000,
    },
    text: {
      // Slack truncates `chat.postMessage` text above 40,000 chars.
      // Source: Slack `chat.postMessage` docs.
      maxLength: 40_000,
      encoding: "characters",
      markdownDialect: "slack-mrkdwn",
      supportsCodeBlocks: true,
      supportsBold: true,
      supportsItalic: true,
      supportsLinks: true,
      supportsInlineCode: true,
      supportsMessageEdit: true,
    },
    inboundAttachments: {
      maxAttachmentCount: 10,
      maxDownloadBytes: 100 * 1024 * 1024,
      supportsDownload: true,
    },
    outboundAttachments: {
      // Slack permits large file uploads, but 100 MB keeps parity with
      // the other providers and desktop attachment defaults.
      maxUploadBytes: 100 * 1024 * 1024,
      supportsFileUpload: true,
      supportsImageUpload: true,
      supportsRemoteImageUrl: true,
    },
  };
  readonly authorizedActorIds: readonly string[];

  private readonly api: SlackApi;
  private readonly callbackHandleStore: MessagingCallbackHandleStore;
  private readonly config: SlackMessagingConfig;
  private readonly logger: SlackProviderLogger;
  private readonly now: () => number;
  private readonly signingSecret: string;
  private readonly socketClient: SlackSocketClient | undefined;
  private readonly inboundRejectedListeners = new Set<MessagingInboundRejectedListener>();
  private readonly conversationTitleCache = new Map<string, string | undefined>();
  private readonly recentInboundMessageEvents = new Map<string, number>();
  private readonly threadTitleCache = new Map<string, string | undefined>();
  private readonly userDisplayNameCache = new Map<string, string | undefined>();
  private botUserId: string | undefined;
  private conversationInfoLookupDisabled = false;
  private threadInfoLookupDisabled = false;
  private userInfoLookupDisabled = false;
  private listener: SlackInboundListener | undefined;
  private started = false;

  constructor(options: SlackAdapterOptions) {
    this.config = options.config;
    this.logger = options.logger ?? {};
    this.now = options.now ?? Date.now;
    this.callbackHandleStore = options.callbackHandleStore;
    this.authorizedActorIds = options.config.authorizedActorIds.map((actor) => actor.id);
    this.signingSecret =
      options.config.signingSecret?.trim()
      || options.config.appToken?.trim()
      || options.config.botToken.trim()
      || randomBytes(32).toString("hex");
    this.api = options.api ?? createSlackApi(options.config.botToken);
    this.socketClient =
      options.socketClient
      ?? (options.config.inboundMode === "events"
        ? undefined
        : createSlackSocketClient(options.config.appToken));
  }

  onInboundRejected(listener: MessagingInboundRejectedListener): () => void {
    this.inboundRejectedListeners.add(listener);
    return () => {
      this.inboundRejectedListeners.delete(listener);
    };
  }

  async start(listener: SlackInboundListener): Promise<void> {
    if (this.started) return;
    this.listener = listener;
    const auth = await this.api.authTest();
    this.botUserId = auth.user_id;

    if (this.config.inboundMode === "events") {
      throw new Error("Slack Events API mode is not implemented yet; use Socket Mode");
    }
    if (!this.socketClient) {
      throw new Error("Slack Socket Mode requires an app token");
    }

    this.socketClient.on("slack_event", this.handleSlackEvent);
    this.socketClient.on("interactive", this.handleInteractive);
    this.socketClient.on("slash_commands", this.handleSlashCommand);
    await this.socketClient.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.socketClient?.off?.("slack_event", this.handleSlackEvent);
    this.socketClient?.off?.("interactive", this.handleInteractive);
    this.socketClient?.off?.("slash_commands", this.handleSlashCommand);
    await this.socketClient?.disconnect();
    this.started = false;
    this.listener = undefined;
  }

  async deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult> {
    const deliveredAt = this.now();
    if (intent.kind === "activity") {
      return {
        outcome: "discarded",
        channel: this.channel,
        deliveredAt,
      };
    }
    if (intent.kind === "dismiss") {
      return await this.deliverDismiss(intent);
    }
    if (intent.kind === "stream_update") {
      return await this.deliverStreamUpdate(intent);
    }

    const target = this.resolveTarget(intent);
    if (!target) {
      return {
        outcome: "failed",
        channel: this.channel,
        deliveredAt,
        errorMessage: "Slack delivery target is missing",
      };
    }

    const rawText = textForSlackIntent(intent);
    const text = clampSlackMessage(markdownToSlackMrkdwn(rawText));
    const actions = actionsForSlackIntent(intent);
    const callbackBuilder = this.buildCallbackValueBuilder({
      allowedActorIds: callbackAllowedActorIds(
        intent,
        this.authorizedActorIds[0] ?? "",
      ),
      bindingId: callbackBindingId(intent),
      channelRef: target.channelRef,
      intent,
    });
    const actionBlocks = buildSlackActionBlocks({
      actions,
      buildCallbackValue: callbackBuilder,
      capabilityProfile: this.capabilityProfile,
      layout: intent.actionLayout,
    });
    const blocks = buildSlackBlocksForIntent({
      actionBlocks,
      intent,
      text: rawText,
    });
    const body: SlackPostBody = {
      channel: target.channelId,
      text: text || intent.fallbackText || "PwrAgent",
      ...(blocks.length > 0 ? { blocks } : {}),
      ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false,
    };

    try {
      const updated =
        intent.delivery?.mode === "update" && target.ts
          ? await this.api.updateMessage({ ...body, ts: target.ts })
          : undefined;
      const result = updated ?? (await this.api.postMessage(body));
      const channelId = result.channel ?? target.channelId;
      const ts = result.ts ?? target.ts;
      if (!ts) {
        return {
          outcome: "failed",
          channel: this.channel,
          deliveredAt: this.now(),
          errorMessage: "Slack did not return a message timestamp",
        };
      }

      await this.uploadOutboundFiles({
        channelId,
        intent,
        threadTs: target.threadTs ?? ts,
      });

      return {
        outcome: updated ? "updated" : "presented",
        channel: this.channel,
        deliveredAt: this.now(),
        surface: {
          channel: this.channel,
          id: ts,
          state: {
            opaque: {
              channelId,
              ts,
              ...(target.threadTs ? { threadTs: target.threadTs } : {}),
            },
          },
        },
      };
    } catch (error) {
      return {
        outcome: "failed",
        channel: this.channel,
        deliveredAt: this.now(),
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async downloadAttachment(
    request: MessagingAttachmentDownloadRequest,
  ): Promise<MessagingAttachmentDownloadResult> {
    const opaque = readSlackAttachmentState(request.attachment.state);
    let file = opaque;
    if (!file?.url && request.attachment.id) {
      const validation = validateSlackFileId(request.attachment.id);
      if (!validation.ok) {
        throw new Error(`Invalid Slack file id: ${validation.reason}`);
      }
      const info = await this.api.filesInfo({ file: request.attachment.id });
      file = {
        fileId: info?.id ?? request.attachment.id,
        mimeType: info?.mimetype,
        name: info?.name ?? info?.title,
        size: info?.size,
        url: info?.url_private_download ?? info?.url_private,
      };
    }
    if (!file?.url) {
      throw new Error("Slack attachment is missing a private download URL");
    }
    const data = await this.api.downloadFile({
      url: file.url,
      maxBytes: request.maxBytes,
    });
    return {
      data,
      fileName: file.name ?? request.attachment.name,
      mimeType: file.mimeType ?? request.attachment.mimeType,
      sizeBytes: file.size ?? data.byteLength,
    };
  }

  async setConversationTitle(
    request: MessagingConversationTitleUpdateRequest,
  ): Promise<MessagingConversationTitleUpdateResult> {
    return {
      channel: this.channel,
      conversation: request.channel.conversation,
      outcome: "unsupported",
      title: request.title,
      updatedAt: this.now(),
    };
  }

  private readonly handleSlackEvent = async (payload: unknown): Promise<void> => {
    const envelope = payload as SlackSocketEnvelope;
    await envelope.ack?.();
    const event = (envelope.event ?? (envelope.body as { event?: unknown })?.event) as
      | SlackMessageEvent
      | undefined;
    if (!event || (event.type !== "message" && event.type !== "app_mention")) {
      return;
    }
    await this.handleMessageEvent(event);
  };

  private readonly handleInteractive = async (payload: unknown): Promise<void> => {
    const envelope = payload as SlackSocketEnvelope;
    await envelope.ack?.();
    await this.handleBlockAction(envelope.body as SlackBlockActionPayload);
  };

  private readonly handleSlashCommand = async (payload: unknown): Promise<void> => {
    const envelope = payload as SlackSocketEnvelope;
    await envelope.ack?.();
    await this.handleSlashPayload(envelope.body as SlackSlashCommandPayload);
  };

  private async handleMessageEvent(event: SlackMessageEvent): Promise<void> {
    if (!this.listener) return;
    if (event.bot_id || (this.botUserId && event.user === this.botUserId)) return;
    if (event.subtype && event.subtype !== "file_share") return;

    const ids = this.validateInboundIds({
      channelId: event.channel,
      teamId: event.team,
      userId: event.user,
      ts: event.ts ?? event.event_ts,
    });
    if (!ids) return;
    if (this.isDuplicateMessageEvent(event, ids)) return;

    const actor = await this.actorForSlackUser(ids.userId);
    const channel = await this.channelRefForSlack({
      channelId: ids.channelId,
      channelName: undefined,
      channelType: event.channel_type,
      peerTitle: actor.displayName ?? actor.username,
      teamId: ids.teamId,
      threadTs: event.thread_ts,
      ts: ids.ts,
    });
    const routingState = this.routingStateForChannel(channel);
    const rawText = event.text ?? "";
    const strippedText = stripBotMention(rawText, this.botUserId);
    const text = strippedText.trim();
    const command = strippedText === rawText
      ? parseCommand(text)
      : parseBareCommand(text);
    const kind = command ? "command" : event.files?.length ? "media" : "text";

    if (!this.authorizeInbound({
      actor,
      channel,
      kind,
      routingState,
      teamId: ids.teamId,
    })) return;

    if (event.files?.length) {
      await this.listener({
        id: this.newEventId("slack-media"),
        kind: "media",
        actor,
        channel,
        receivedAt: this.now(),
        routingState,
        text: text || undefined,
        disposition: "available",
        attachments: event.files.flatMap((file) => this.describeFile(file)),
      });
      return;
    }

    if (command) {
      await this.listener({
        id: this.newEventId("slack-command"),
        kind: "command",
        actor,
        channel,
        receivedAt: this.now(),
        routingState,
        command: command.command,
        args: command.args,
        rawText: strippedText === rawText ? text : `/${text}`,
      });
      return;
    }

    if (!text) return;
    await this.listener({
      id: this.newEventId("slack-text"),
      kind: "text",
      actor,
      channel,
      receivedAt: this.now(),
      routingState,
      text,
    });
  }

  private async handleBlockAction(body: SlackBlockActionPayload): Promise<void> {
    if (!this.listener) return;
    const action = body.actions?.[0];
    const ids = this.validateInboundIds({
      channelId: body.channel?.id,
      teamId: body.team?.id,
      userId: body.user?.id,
      ts: body.message?.ts,
    });
    if (!ids || !action?.value) return;
    const signed = this.parseSignedCallbackValue(action.value);
    if (!signed) return;
    const handleValidation = validateSlackCallbackHandle(signed.handle);
    if (!handleValidation.ok) {
      logSlackInvalidIdentifier({
        field: "callback.value",
        logger: this.logger,
        reason: handleValidation.reason,
        value: signed.handle,
      });
      return;
    }

    const actor = await this.actorForSlackUser(
      ids.userId,
      body.user?.name ?? body.user?.username,
    );
    const channel = await this.channelRefForSlack({
      channelId: ids.channelId,
      channelName: body.channel?.name,
      peerTitle: actor.displayName ?? actor.username,
      teamId: ids.teamId,
      threadTs: body.message?.thread_ts ?? body.container?.thread_ts,
      ts: ids.ts,
    });
    const routingState = this.routingStateForChannel(channel, ids.ts);
    if (!this.authorizeInbound({
      actor,
      channel,
      kind: "callback",
      routingState,
      teamId: ids.teamId,
    })) {
      return;
    }

    const record = await this.callbackHandleStore.resolveCallbackHandle({
      actorId: actor.platformUserId,
      channel,
      handle: signed.handle,
      now: this.now(),
    });
    if (!record) {
      this.logger.warn?.("slack callback handle unresolved", {
        actorId: actor.platformUserId,
        channelId: channel.conversation.id,
        conversationKind: channel.conversation.kind,
        handleHash: createHash("sha256").update(signed.handle).digest("hex").slice(0, 8),
      });
      return;
    }

    await this.listener({
      id: this.newEventId("slack-callback"),
      kind: "callback",
      actor,
      channel,
      receivedAt: this.now(),
      routingState,
      interaction: {
        channel: this.channel,
        id: `${ids.channelId}:${ids.ts}:${action.action_id ?? "action"}`,
        state: routingState,
      },
      actionId: record.actionId,
      ...(record.value !== undefined ? { value: record.value } : {}),
    });
  }

  private async handleSlashPayload(body: SlackSlashCommandPayload): Promise<void> {
    if (!this.listener) return;
    const ids = this.validateInboundIds({
      channelId: body.channel_id,
      teamId: body.team_id,
      userId: body.user_id,
      ts: body.thread_ts ?? (this.now() / 1000).toFixed(6),
    });
    if (!ids || !body.command) return;
    const actor = await this.actorForSlackUser(ids.userId, body.user_name);
    const channel = await this.channelRefForSlack({
      channelId: ids.channelId,
      channelName: body.channel_name,
      peerTitle: actor.displayName ?? actor.username,
      teamId: ids.teamId,
      threadTs: body.thread_ts,
      ts: ids.ts,
    });
    const routingState = this.routingStateForChannel(channel);
    if (!this.authorizeInbound({
      actor,
      channel,
      kind: "command",
      routingState,
      teamId: ids.teamId,
    })) {
      return;
    }
    const command = normalizeSlackSlashCommand(
      body.command,
      this.config.slashCommandPrefix,
    );
    const args = (body.text ?? "").trim().split(/\s+/).filter(Boolean);
    await this.listener({
      id: this.newEventId("slack-slash"),
      kind: "command",
      actor,
      channel,
      receivedAt: this.now(),
      routingState,
      command,
      args,
      rawText: [body.command, body.text].filter(Boolean).join(" "),
    });
  }

  private async deliverDismiss(
    intent: Extract<MessagingSurfaceIntent, { kind: "dismiss" }>,
  ): Promise<MessagingDeliveryResult> {
    const target = readSlackSurfaceState(intent.targetSurface);
    if (!target?.channelId || !target.ts) {
      return {
        outcome: "failed",
        channel: this.channel,
        deliveredAt: this.now(),
        errorMessage: "Slack dismiss target is missing",
      };
    }
    try {
      await this.api.deleteMessage({ channel: target.channelId, ts: target.ts });
      return {
        outcome: "dismissed",
        channel: this.channel,
        deliveredAt: this.now(),
      };
    } catch (error) {
      return {
        outcome: "failed",
        channel: this.channel,
        deliveredAt: this.now(),
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async deliverStreamUpdate(
    intent: Extract<MessagingSurfaceIntent, { kind: "stream_update" }>,
  ): Promise<MessagingDeliveryResult> {
    if (this.config.streamingResponses === false || intent.policy === "disabled") {
      return {
        outcome: "discarded",
        channel: this.channel,
        deliveredAt: this.now(),
      };
    }
    const target = this.resolveTarget(intent);
    if (!target?.ts) {
      return {
        outcome: "failed",
        channel: this.channel,
        deliveredAt: this.now(),
        errorMessage: "Slack stream update target is missing",
      };
    }
    const text = clampSlackMessage(markdownToSlackMrkdwn(intent.text));
    try {
      const result = await this.api.updateMessage({
        channel: target.channelId,
        ts: target.ts,
        text,
        blocks: buildSlackBlocksForIntent({ intent, text: intent.text }),
        ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      });
      return {
        outcome: "updated",
        channel: this.channel,
        deliveredAt: this.now(),
        surface: {
          channel: this.channel,
          id: result.ts ?? target.ts,
          state: {
            opaque: {
              channelId: result.channel ?? target.channelId,
              ts: result.ts ?? target.ts,
              ...(target.threadTs ? { threadTs: target.threadTs } : {}),
            },
          },
        },
      };
    } catch (error) {
      return {
        outcome: "failed",
        channel: this.channel,
        deliveredAt: this.now(),
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveTarget(intent: MessagingSurfaceIntent):
    | {
        channelId: string;
        channelRef: MessagingChannelRef;
        threadTs?: string;
        ts?: string;
      }
    | undefined {
    const surfaceState = readSlackSurfaceState(intent.targetSurface);
    const auditChannel = intent.audit?.channel;
    const channelId = surfaceState?.channelId ?? auditChannel?.conversation.id;
    if (!channelId) return undefined;
    const threadTs =
      surfaceState?.threadTs
      ?? auditChannel?.conversation.parentId
      ?? (auditChannel?.conversation.kind === "thread"
        ? auditChannel.conversation.parentId
        : undefined);
    return {
      channelId,
      channelRef:
        auditChannel
        ?? {
          channel: this.channel,
          conversation: {
            id: channelId,
            kind: threadTs ? "thread" : "channel",
            ...(threadTs ? { parentId: threadTs } : {}),
          },
        },
      ...(threadTs ? { threadTs } : {}),
      ...(surfaceState?.ts ? { ts: surfaceState.ts } : {}),
    };
  }

  private buildCallbackValueBuilder(params: {
    allowedActorIds: string[];
    bindingId?: string;
    channelRef: MessagingChannelRef;
    intent: MessagingSurfaceIntent;
  }): (action: MessagingSurfaceAction) => string {
    return (action) => {
      const handle = `${this.channel}:${createHash("sha256")
        .update(JSON.stringify([params.intent.id, action.id, action.value ?? null]))
        .digest("base64url")
        .slice(0, 18)}`;
      const issuedAt = this.now();
      const sig = this.signCallbackValue(handle, params.intent.id, issuedAt);
      void this.callbackHandleStore
        .upsertCallbackHandle({
          id: slackCallbackRecordId(handle, params),
          actionId: action.id,
          allowedActorIds: params.allowedActorIds,
          bindingId: params.bindingId,
          channel: params.channelRef,
          createdAt: issuedAt,
          updatedAt: issuedAt,
          expiresAt: issuedAt + SLACK_CALLBACK_TTL_MS,
          handle,
          pendingIntentId: params.intent.id,
          ...(action.value !== undefined ? { value: action.value } : {}),
        })
        .catch((error) => {
          this.logger.warn?.("slack callback handle persist failed", {
            error: error instanceof Error ? error.message : String(error),
            handle,
          });
        });
      return JSON.stringify({
        v: SLACK_SIGNED_VALUE_VERSION,
        h: handle,
        i: params.intent.id,
        t: issuedAt,
        s: sig,
      });
    };
  }

  private parseSignedCallbackValue(
    value: string,
  ): { handle: string; intentId: string; issuedAt: number } | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
    const record = parsed as {
      h?: unknown;
      i?: unknown;
      s?: unknown;
      t?: unknown;
      v?: unknown;
    };
    if (
      record.v !== SLACK_SIGNED_VALUE_VERSION
      || typeof record.h !== "string"
      || typeof record.i !== "string"
      || typeof record.s !== "string"
      || typeof record.t !== "number"
    ) {
      return undefined;
    }
    const expected = this.signCallbackValue(record.h, record.i, record.t);
    if (!safeEqual(expected, record.s)) {
      this.logger.warn?.("slack callback signature rejected", {
        handleHash: createHash("sha256").update(record.h).digest("hex").slice(0, 8),
      });
      return undefined;
    }
    return { handle: record.h, intentId: record.i, issuedAt: record.t };
  }

  private signCallbackValue(handle: string, intentId: string, issuedAt: number): string {
    return createHmac("sha256", this.signingSecret)
      .update(JSON.stringify([handle, intentId, issuedAt]))
      .digest("base64url")
      .slice(0, 32);
  }

  private validateInboundIds(params: {
    channelId: unknown;
    teamId?: unknown;
    ts?: unknown;
    userId: unknown;
  }): { channelId: string; teamId?: string; ts: string; userId: string } | undefined {
    const userValidation = validateSlackUserId(params.userId);
    if (!userValidation.ok) {
      logSlackInvalidIdentifier({
        field: "user_id",
        logger: this.logger,
        reason: userValidation.reason,
        value: params.userId,
      });
      return undefined;
    }
    const channelValidation = validateSlackChannelId(params.channelId);
    if (!channelValidation.ok) {
      logSlackInvalidIdentifier({
        field: "channel_id",
        logger: this.logger,
        reason: channelValidation.reason,
        value: params.channelId,
      });
      return undefined;
    }
    if (params.teamId !== undefined) {
      const teamValidation = validateSlackTeamId(params.teamId);
      if (!teamValidation.ok) {
        logSlackInvalidIdentifier({
          field: "team_id",
          logger: this.logger,
          reason: teamValidation.reason,
          value: params.teamId,
        });
        return undefined;
      }
    }
    const ts = typeof params.ts === "string" ? params.ts : `${this.now() / 1000}`;
    const tsValidation = validateSlackMessageTs(ts);
    if (!tsValidation.ok) {
      logSlackInvalidIdentifier({
        field: "message_ts",
        logger: this.logger,
        reason: tsValidation.reason,
        value: ts,
      });
      return undefined;
    }
    return {
      channelId: params.channelId as string,
      ...(params.teamId !== undefined ? { teamId: params.teamId as string } : {}),
      ts,
      userId: params.userId as string,
    };
  }

  private authorizeInbound(params: {
    actor: MessagingActorIdentity;
    channel: MessagingChannelRef;
    kind: MessagingInboundEvent["kind"];
    routingState?: MessagingAdapterState;
    teamId?: string;
  }): boolean {
    const allowedTeams = this.config.authorizedTeamIds?.map((item) => item.id);
    if (
      allowedTeams?.length
      && (!params.teamId || !allowedTeams.includes(params.teamId))
    ) {
      this.emitInboundRejected({
        id: this.newEventId("slack-rejected"),
        kind: params.kind,
        actor: params.actor,
        channel: params.channel,
        receivedAt: this.now(),
        reason: "unauthorized-conversation",
        ...(params.routingState ? { routingState: params.routingState } : {}),
      });
      return false;
    }
    if (!this.authorizedActorIds.includes(params.actor.platformUserId)) {
      this.emitInboundRejected({
        id: this.newEventId("slack-rejected"),
        kind: params.kind,
        actor: params.actor,
        channel: params.channel,
        receivedAt: this.now(),
        reason: "unauthorized-actor",
        ...(params.routingState ? { routingState: params.routingState } : {}),
      });
      return false;
    }
    const allowedConversations = this.config.authorizedConversationIds?.map((item) => item.id);
    if (
      allowedConversations?.length
      && !allowedConversations.includes(params.channel.conversation.id)
    ) {
      this.emitInboundRejected({
        id: this.newEventId("slack-rejected"),
        kind: params.kind,
        actor: params.actor,
        channel: params.channel,
        receivedAt: this.now(),
        reason: "unauthorized-conversation",
        ...(params.routingState ? { routingState: params.routingState } : {}),
      });
      return false;
    }
    return true;
  }

  private async channelRefForSlack(params: {
    channelId: string;
    channelName?: string;
    channelType?: string;
    peerTitle?: string;
    teamId?: string;
    threadTs?: string;
    ts: string;
  }): Promise<MessagingChannelRef> {
    const isThread = Boolean(params.threadTs && params.threadTs !== params.ts);
    const kind: MessagingConversationKind = isThread
      ? "thread"
      : params.channelType === "im" || params.channelId.startsWith("D")
        ? "dm"
        : "channel";
    const channelTitle =
      kind === "dm"
        ? params.peerTitle
        : normalizeSlackConversationTitle(params.channelName)
          ?? (await this.lookupSlackConversationTitle(params.channelId));
    const threadTitle = isThread && params.threadTs
      ? await this.lookupSlackThreadTitle(params.channelId, params.threadTs)
      : undefined;
    return {
      channel: this.channel,
      conversation: {
        id: params.channelId,
        kind,
        ...(kind === "dm" && channelTitle ? { title: channelTitle } : {}),
        ...(isThread && params.threadTs ? { parentId: params.threadTs } : {}),
        ...(kind === "channel" && channelTitle ? { title: channelTitle } : {}),
        ...(isThread && threadTitle ? { title: threadTitle } : {}),
        ...(isThread && channelTitle ? { parentTitle: channelTitle } : {}),
      },
    };
  }

  private routingStateForChannel(
    channel: MessagingChannelRef,
    ts?: string,
  ): MessagingAdapterState {
    return {
      opaque: {
        channelId: channel.conversation.id,
        ...(channel.conversation.parentId
          ? { threadTs: channel.conversation.parentId }
          : {}),
        ...(ts ? { ts } : {}),
      },
    };
  }

  private async actorForSlackUser(
    userId: string,
    username?: string,
  ): Promise<MessagingActorIdentity> {
    const contact = this.config.authorizedActorIds.find((item) => item.id === userId);
    const displayName =
      contact?.displayName
      || (await this.lookupSlackUserDisplayName(userId))
      || username;
    return {
      platformUserId: userId,
      ...(displayName ? { displayName } : {}),
      ...(username ? { username } : {}),
    };
  }

  private async lookupSlackUserDisplayName(
    userId: string,
  ): Promise<string | undefined> {
    if (this.userDisplayNameCache.has(userId)) {
      return this.userDisplayNameCache.get(userId);
    }
    if (this.userInfoLookupDisabled || !this.api.usersInfo) {
      this.userDisplayNameCache.set(userId, undefined);
      return undefined;
    }

    try {
      const user = await this.api.usersInfo({ user: userId });
      const displayName =
        user?.profile?.display_name?.trim()
        || user?.profile?.real_name?.trim()
        || user?.real_name?.trim()
        || user?.name?.trim()
        || undefined;
      this.userDisplayNameCache.set(userId, displayName);
      return displayName;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.includes("missing_scope")) {
        this.userInfoLookupDisabled = true;
        this.logger.warn?.("slack user profile lookup unavailable", {
          reason: "missing_scope",
          requiredScope: "users:read",
        });
      } else {
        this.logger.warn?.("slack user profile lookup failed", {
          reason,
          userHash: createHash("sha256").update(userId).digest("hex").slice(0, 8),
        });
      }
      this.userDisplayNameCache.set(userId, undefined);
      return undefined;
    }
  }

  private async lookupSlackConversationTitle(
    channelId: string,
  ): Promise<string | undefined> {
    if (this.conversationTitleCache.has(channelId)) {
      return this.conversationTitleCache.get(channelId);
    }
    if (this.conversationInfoLookupDisabled || !this.api.conversationsInfo) {
      this.conversationTitleCache.set(channelId, undefined);
      return undefined;
    }

    try {
      const conversation = await this.api.conversationsInfo({ channel: channelId });
      const title = normalizeSlackConversationTitle(conversation?.name);
      this.conversationTitleCache.set(channelId, title);
      return title;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.includes("missing_scope")) {
        this.conversationInfoLookupDisabled = true;
        this.logger.warn?.("slack conversation lookup unavailable", {
          reason: "missing_scope",
          requiredScopes: requiredConversationReadScopes(channelId),
        });
      } else {
        this.logger.warn?.("slack conversation lookup failed", {
          reason,
          channelHash: createHash("sha256").update(channelId).digest("hex").slice(0, 8),
        });
      }
      this.conversationTitleCache.set(channelId, undefined);
      return undefined;
    }
  }

  private async lookupSlackThreadTitle(
    channelId: string,
    threadTs: string,
  ): Promise<string | undefined> {
    const cacheKey = `${channelId}:${threadTs}`;
    if (this.threadTitleCache.has(cacheKey)) {
      return this.threadTitleCache.get(cacheKey);
    }
    if (this.threadInfoLookupDisabled || !this.api.conversationsReplies) {
      this.threadTitleCache.set(cacheKey, undefined);
      return undefined;
    }

    try {
      const messages = await this.api.conversationsReplies({
        channel: channelId,
        limit: 1,
        ts: threadTs,
      });
      const root = messages.find((message) => message.ts === threadTs) ?? messages[0];
      const title = normalizeSlackThreadTitle(root?.text);
      this.threadTitleCache.set(cacheKey, title);
      return title;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.includes("missing_scope")) {
        this.threadInfoLookupDisabled = true;
        this.logger.warn?.("slack thread root lookup unavailable", {
          reason: "missing_scope",
          requiredScope: requiredConversationHistoryScope(channelId),
        });
      } else {
        this.logger.warn?.("slack thread root lookup failed", {
          reason,
          channelHash: createHash("sha256").update(channelId).digest("hex").slice(0, 8),
          threadHash: createHash("sha256").update(threadTs).digest("hex").slice(0, 8),
        });
      }
      this.threadTitleCache.set(cacheKey, undefined);
      return undefined;
    }
  }

  private describeFile(file: SlackFileInfo): MessagingAttachmentDescriptor[] {
    const fileIdValidation = validateSlackFileId(file.id);
    if (!file.id) {
      logSlackInvalidIdentifier({
        field: "file_id",
        logger: this.logger,
        reason: "empty",
        value: file.id,
      });
      return [];
    }
    if (!fileIdValidation.ok) {
      logSlackInvalidIdentifier({
        field: "file_id",
        logger: this.logger,
        reason: fileIdValidation.reason,
        value: file.id,
      });
      return [];
    }
    const mimeType = file.mimetype;
    return [
      {
        id: file.id,
        kind: kindForSlackMime(mimeType),
        name: file.name ?? file.title ?? file.id,
        disposition: "available",
        ...(mimeType ? { mimeType } : {}),
        ...(file.size !== undefined ? { sizeBytes: file.size } : {}),
        state: {
          opaque: {
            fileId: file.id,
            ...(file.url_private_download || file.url_private
              ? { url: file.url_private_download ?? file.url_private }
              : {}),
            ...(mimeType ? { mimeType } : {}),
            ...(file.name ?? file.title ? { name: file.name ?? file.title } : {}),
            ...(file.size !== undefined ? { size: file.size } : {}),
          },
        },
      },
    ];
  }

  private async uploadOutboundFiles(params: {
    channelId: string;
    intent: MessagingSurfaceIntent;
    threadTs?: string;
  }): Promise<void> {
    if (!this.api.uploadFile || params.intent.kind !== "message") return;
    for (const part of params.intent.parts) {
      if (part.type !== "file" || !part.data) continue;
      await this.api.uploadFile({
        channel: params.channelId,
        data: part.data,
        filename: part.name,
        mimeType: part.mimeType,
        threadTs: params.threadTs,
        title: part.description ?? part.name,
      });
    }
  }

  private isDuplicateMessageEvent(
    event: SlackMessageEvent,
    ids: { channelId: string; teamId?: string; ts: string; userId: string },
  ): boolean {
    const now = this.now();
    this.pruneRecentInboundMessageEvents(now);
    const key = [
      ids.teamId ?? "",
      ids.channelId,
      ids.userId,
      ids.ts,
      event.thread_ts ?? "",
      event.text ?? "",
      (event.files ?? []).map((file) => file.id ?? "").join(","),
    ].join("\u001f");
    if (this.recentInboundMessageEvents.has(key)) {
      return true;
    }
    this.recentInboundMessageEvents.set(key, now);
    return false;
  }

  private pruneRecentInboundMessageEvents(now: number): void {
    for (const [key, seenAt] of this.recentInboundMessageEvents) {
      if (
        now - seenAt > SLACK_INBOUND_EVENT_DEDUPE_TTL_MS
        || this.recentInboundMessageEvents.size > SLACK_INBOUND_EVENT_DEDUPE_MAX
      ) {
        this.recentInboundMessageEvents.delete(key);
      }
    }
  }

  private newEventId(prefix: string): string {
    return `${prefix}:${this.now()}:${randomBytes(6).toString("hex")}`;
  }

  private emitInboundRejected(event: MessagingRejectedInboundEvent): void {
    for (const listener of this.inboundRejectedListeners) {
      void listener(event);
    }
  }
}

export function createSlackAdapter(
  config: SlackMessagingConfig,
  callbackHandleStore: MessagingCallbackHandleStore,
  logger: SlackProviderLogger,
): SlackAdapter {
  return new SlackAdapter({ config, callbackHandleStore, logger });
}

export function createSlackApi(botToken: string): SlackApi {
  const client = new WebClient(botToken);
  return {
    async authTest() {
      return (await client.auth.test()) as SlackAuthTestResult;
    },
    async conversationsInfo(params) {
      const response = await client.conversations.info(params);
      return response.channel as SlackConversationInfo | undefined;
    },
    async conversationsReplies(params) {
      const response = await client.conversations.replies(params);
      return (response.messages ?? []) as SlackThreadMessageInfo[];
    },
    async deleteMessage(params) {
      await client.chat.delete(params);
    },
    async downloadFile(params) {
      const response = await fetch(params.url, {
        headers: { Authorization: `Bearer ${botToken}` },
      });
      if (!response.ok) {
        throw new Error(`Slack file download failed: HTTP ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > params.maxBytes) {
        throw new Error("Slack file exceeds configured download limit");
      }
      return bytes;
    },
    async filesInfo(params) {
      const response = await client.files.info(params);
      return response.file as SlackFileInfo | undefined;
    },
    async postMessage(params) {
      return (await client.chat.postMessage(params)) as SlackMessageResult;
    },
    async updateMessage(params) {
      return (await client.chat.update(params)) as SlackMessageResult;
    },
    async usersInfo(params) {
      const response = await client.users.info(params);
      return response.user as SlackUserInfo | undefined;
    },
    async uploadFile(params) {
      const files = client.files as unknown as {
        uploadV2(input: Record<string, unknown>): Promise<unknown>;
      };
      await files.uploadV2({
        channel_id: params.channel,
        file: Buffer.from(params.data),
        filename: params.filename,
        ...(params.mimeType ? { filetype: params.mimeType } : {}),
        ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
        ...(params.title ? { title: params.title } : {}),
      });
    },
  };
}

export function createSlackSocketClient(
  appToken: string | undefined,
): SlackSocketClient | undefined {
  if (!appToken?.trim()) {
    return undefined;
  }
  return new SocketModeClient({
    appToken,
    autoReconnectEnabled: true,
  }) as SlackSocketClient;
}

export function stripBotMention(text: string, botUserId: string | undefined): string {
  if (!botUserId) return text;
  return text.replace(new RegExp(`^\\s*<@${escapeRegex(botUserId)}>\\s*`), "");
}

function parseCommand(text: string): { command: string; args: string[] } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [commandWithSlash, ...args] = trimmed.split(/\s+/);
  const command = commandWithSlash?.replace(/^\//, "");
  return command ? { command, args } : undefined;
}

function parseBareCommand(text: string): { command: string; args: string[] } | undefined {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9_]+(?:\s|$)/.test(trimmed)) return undefined;
  return parseCommand(`/${trimmed}`);
}

function normalizeSlackSlashCommand(
  command: string,
  prefix: string | undefined,
): string {
  const stripped = command.replace(/^\//, "").toLowerCase();
  const normalizedPrefix = prefix?.trim().toLowerCase() ?? "";
  if (normalizedPrefix && stripped.startsWith(normalizedPrefix)) {
    return stripped.slice(normalizedPrefix.length);
  }
  return stripped;
}

function readSlackSurfaceState(
  surface: MessagingSurfaceRef | undefined,
): SlackSurfaceOpaqueState | undefined {
  const opaque = surface?.state?.opaque;
  if (!opaque || typeof opaque !== "object" || Array.isArray(opaque)) {
    return undefined;
  }
  const record = opaque as Record<string, MessagingJsonValue>;
  return {
    ...(typeof record.channelId === "string" ? { channelId: record.channelId } : {}),
    ...(typeof record.threadTs === "string" ? { threadTs: record.threadTs } : {}),
    ...(typeof record.ts === "string" ? { ts: record.ts } : {}),
  };
}

function callbackAllowedActorIds(
  intent: MessagingSurfaceIntent,
  fallbackActorId: string,
): string[] {
  if (intent.allowedActorIds && intent.allowedActorIds.length > 0) {
    return intent.allowedActorIds;
  }
  const actorId = intent.audit?.actor.platformUserId ?? fallbackActorId;
  return actorId ? [actorId] : ["unknown"];
}

function callbackBindingId(intent: MessagingSurfaceIntent): string | undefined {
  return intent.audit?.bindingId ?? intent.bindingId;
}

function slackCallbackRecordId(
  handle: string,
  params: {
    bindingId?: string;
    channelRef: MessagingChannelRef;
  },
): string {
  const conversation = params.channelRef.conversation;
  const deliveryScope = createHash("sha256")
    .update(
      JSON.stringify([
        params.channelRef.channel,
        conversation.id,
        conversation.parentId ?? null,
        params.bindingId ?? null,
      ]),
    )
    .digest("base64url")
    .slice(0, 18);
  return `slack-callback:${handle}:${deliveryScope}`;
}

function readSlackAttachmentState(
  state: MessagingAdapterState | undefined,
):
  | {
      fileId?: string;
      mimeType?: string;
      name?: string;
      size?: number;
      url?: string;
    }
  | undefined {
  const opaque = state?.opaque;
  if (!opaque || typeof opaque !== "object" || Array.isArray(opaque)) {
    return undefined;
  }
  const record = opaque as Record<string, MessagingJsonValue>;
  return {
    ...(typeof record.fileId === "string" ? { fileId: record.fileId } : {}),
    ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.size === "number" ? { size: record.size } : {}),
    ...(typeof record.url === "string" ? { url: record.url } : {}),
  };
}

function kindForSlackMime(mimeType: string | undefined): MessagingAttachmentDescriptor["kind"] {
  if (!mimeType) return "unknown";
  if (mimeType.startsWith("image/gif")) return "gif";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}

function normalizeSlackConversationTitle(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const lower = normalized.toLowerCase();
  if (lower === "privategroup" || lower === "directmessage") return undefined;
  return normalized;
}

function normalizeSlackThreadTitle(value: string | undefined): string | undefined {
  const normalized = value
    ?.replace(/:[A-Za-z0-9_+-]+:/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function requiredConversationReadScopes(channelId: string): string {
  if (channelId.startsWith("C")) return "channels:read";
  if (channelId.startsWith("D")) return "im:read";
  if (channelId.startsWith("G")) return "groups:read or mpim:read";
  return "channels:read/groups:read/im:read/mpim:read";
}

function requiredConversationHistoryScope(channelId: string): string {
  if (channelId.startsWith("C")) return "channels:history";
  if (channelId.startsWith("D")) return "im:history";
  if (channelId.startsWith("G")) return "groups:history or mpim:history";
  return "channels:history/groups:history/im:history/mpim:history";
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.byteLength === rightBuffer.byteLength
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
