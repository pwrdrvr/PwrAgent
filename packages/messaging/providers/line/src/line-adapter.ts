import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { messagingApi } from "@line/bot-sdk";
import type {
  MessagingActorIdentity,
  MessagingAdapterAuthorizationUpdate,
  MessagingAdapterRenderingPreferencesUpdate,
  MessagingAdapterState,
  MessagingAttachmentDescriptor,
  MessagingAttachmentDownloadRequest,
  MessagingAttachmentDownloadResult,
  MessagingCallbackHandleStore,
  MessagingCapabilityProfile,
  MessagingChannelRef,
  MessagingClientRateLimitStrategy,
  MessagingConversationKind,
  MessagingDeliveryResult,
  MessagingDeliveryScope,
  MessagingInboundEvent,
  MessagingInboundRejectedListener,
  MessagingJsonValue,
  MessagingRejectedInboundEvent,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
  MessagingSurfaceRef,
} from "@pwragent/messaging-interface";
import {
  extractMessagingPairingToken,
  MESSAGING_CALLBACK_HANDLE_TTL_MS,
} from "@pwragent/messaging-interface";
import type { LineMessagingConfig } from "./line-config.ts";
import {
  LINE_MESSAGE_TEXT_LIMIT,
  LINE_POSTBACK_DATA_LIMIT_CHARS,
  actionsForLineIntent,
  buildLineActionBubble,
  clampLineMessage,
  imageMessagesForLineIntent,
  textForLineIntent,
  type LineMessage,
} from "./line-formatting.ts";
import {
  logLineInvalidIdentifier,
  validateLineCallbackHandle,
  validateLineConversationId,
  validateLineGroupId,
  validateLineMessageId,
  validateLineRoomId,
  validateLineUserId,
  validateLineWebhookEventId,
} from "./validate-ids.ts";

const DEFAULT_CALLBACK_PORT = 47822;
const DEFAULT_CALLBACK_HOST = "127.0.0.1";
const LINE_SIGNED_VALUE_VERSION = 1;
const LINE_WEBHOOK_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

export type LineProviderLogger = {
  debug?: (message: string, data?: Record<string, unknown>) => void;
  info?: (message: string, data?: Record<string, unknown>) => void;
  warn?: (message: string, data?: Record<string, unknown>) => void;
  error?: (message: string, data?: Record<string, unknown>) => void;
};

export type LineBotInfo = {
  basicId?: string;
  displayName?: string;
  userId?: string;
};

export type LineApi = {
  downloadMessageContent(messageId: string): Promise<Uint8Array>;
  getBotInfo(): Promise<LineBotInfo>;
  pushMessage(params: { messages: LineMessage[]; to: string }): Promise<LineSendResult>;
  showLoadingAnimation?(
    params: { chatId: string; loadingSeconds?: number },
  ): Promise<unknown>;
};

export type LineSendResult = {
  sentMessages?: Array<{ id?: string }>;
};

export type LineProviderAdapter = {
  authorizedActorIds: readonly string[];
  capabilityProfile: MessagingCapabilityProfile;
  channel: "line";
  clientRateLimitStrategy: MessagingClientRateLimitStrategy;
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  resolveDeliveryScope?(intent: MessagingSurfaceIntent): MessagingDeliveryScope | undefined;
  downloadAttachment(
    request: MessagingAttachmentDownloadRequest,
  ): Promise<MessagingAttachmentDownloadResult>;
  onInboundRejected?(listener: MessagingInboundRejectedListener): () => void;
  start(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  updateAuthorization?(update: MessagingAdapterAuthorizationUpdate): Promise<void>;
  updateRenderingPreferences?(update: MessagingAdapterRenderingPreferencesUpdate): Promise<void>;
};

export type LineAdapterOptions = {
  api?: LineApi;
  callbackHandleStore: MessagingCallbackHandleStore;
  config: LineMessagingConfig;
  logger?: LineProviderLogger;
  now?: () => number;
};

type LineInboundListener = (event: MessagingInboundEvent) => Promise<void>;

type LineWebhookBody = {
  destination?: string;
  events?: LineWebhookEvent[];
};

type LineWebhookEvent = {
  deliveryContext?: { isRedelivery?: boolean };
  mode?: string;
  message?: {
    fileName?: string;
    fileSize?: number;
    id?: string;
    mention?: {
      mentionees?: Array<{
        isSelf?: boolean;
        type?: string;
        userId?: string;
      }>;
    };
    text?: string;
    type?: "audio" | "file" | "image" | "location" | "sticker" | "text" | "video";
  };
  postback?: {
    data?: string;
  };
  replyToken?: string;
  source?: {
    groupId?: string;
    roomId?: string;
    type?: "group" | "room" | "user";
    userId?: string;
  };
  timestamp?: number;
  type?: "follow" | "join" | "leave" | "message" | "postback" | "unfollow";
  webhookEventId?: string;
};

type LineRoutingOpaqueState = {
  conversationId: string;
  conversationKind: MessagingConversationKind;
  groupId?: string;
  messageId?: string;
  replyToken?: string;
  roomId?: string;
};

export class LineAdapter implements LineProviderAdapter {
  readonly channel = "line" as const;
  readonly clientRateLimitStrategy: MessagingClientRateLimitStrategy = "direct";
  readonly capabilityProfile: MessagingCapabilityProfile = {
    actions: {
      maxActions: 13,
      maxActionsPerRow: 4,
      maxRows: 7,
      maxLabelLength: 20,
      supportsStyles: true,
      supportsDisabled: false,
      supportsLayoutHints: true,
      maxCallbackPayloadBytes: LINE_POSTBACK_DATA_LIMIT_CHARS,
    },
    text: {
      maxLength: LINE_MESSAGE_TEXT_LIMIT,
      encoding: "characters",
      markdownDialect: "plain",
      supportsCodeBlocks: false,
      supportsBold: false,
      supportsItalic: false,
      supportsLinks: false,
      supportsInlineCode: false,
      supportsMessageEdit: false,
    },
    inboundAttachments: {
      maxAttachmentCount: 1,
      maxDownloadBytes: 200 * 1024 * 1024,
      supportsDownload: true,
    },
    outboundAttachments: {
      maxUploadBytes: 10 * 1024 * 1024,
      supportsFileUpload: false,
      supportsImageUpload: false,
      supportsRemoteImageUrl: true,
    },
  };
  private readonly api?: LineApi;
  private readonly callbackHandleStore: MessagingCallbackHandleStore;
  private readonly config: LineMessagingConfig;
  private readonly logger: LineProviderLogger;
  private readonly now: () => number;
  private readonly server: Server;
  private readonly signingSecret: string;
  private authorizedActorIdsValue: string[];
  private listener: LineInboundListener | undefined;
  private botUserId: string | undefined;
  private started = false;
  private readonly inboundRejectedListeners = new Set<MessagingInboundRejectedListener>();

  constructor(options: LineAdapterOptions) {
    this.config = options.config;
    this.api = options.api ??
      (options.config.channelAccessToken
        ? createLineApi(options.config.channelAccessToken)
        : undefined);
    this.callbackHandleStore = options.callbackHandleStore;
    this.logger = options.logger ?? {};
    this.now = options.now ?? Date.now;
    this.authorizedActorIdsValue = options.config.authorizedActorIds.map((actor) => actor.id);
    this.signingSecret = createHash("sha256")
      .update(options.config.channelSecret)
      .digest("hex");
    this.botUserId = options.config.botUserId;
    this.server = createServer((request, response) => {
      void this.handleWebhookRequest(request, response);
    });
  }

  get authorizedActorIds(): readonly string[] {
    return this.authorizedActorIdsValue;
  }

  async updateAuthorization(update: MessagingAdapterAuthorizationUpdate): Promise<void> {
    this.authorizedActorIdsValue = [...update.authorizedActorIds];
    this.config.authorizedActorIds = lineContactsFromIds(
      update.authorizedActorIds,
      this.config.authorizedActorIds,
    );
    this.config.authorizedGroupIds = lineContactsFromIds(
      (update.authorizedConversationIds ?? []).filter((id) => id.startsWith("C")),
      this.config.authorizedGroupIds,
    );
    this.config.authorizedRoomIds = lineContactsFromIds(
      (update.authorizedConversationIds ?? []).filter((id) => id.startsWith("R")),
      this.config.authorizedRoomIds,
    );
  }

  async updateRenderingPreferences(
    update: MessagingAdapterRenderingPreferencesUpdate,
  ): Promise<void> {
    if (update.streamingResponses !== undefined) {
      this.config.streamingResponses = update.streamingResponses;
    }
  }

  async start(listener: LineInboundListener): Promise<void> {
    if (this.started) return;
    this.listener = listener;
    if (!this.botUserId && this.api) {
      try {
        const botInfo = await this.api.getBotInfo();
        this.botUserId = botInfo.userId;
      } catch (error) {
        this.logger.warn?.("line getBotInfo failed during startup", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const bindAddress = bindAddressFromCallbackUrl(this.config.callbackBaseUrl);
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(bindAddress.port, bindAddress.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.started = true;
    this.logger.info?.("line webhook listener started", {
      host: bindAddress.host,
      port: bindAddress.port,
      callbackBaseUrl: this.config.callbackBaseUrl,
      botUserId: this.botUserId,
      authorizedActorCount: this.authorizedActorIds.length,
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    this.listener = undefined;
    this.started = false;
  }

  onInboundRejected(listener: MessagingInboundRejectedListener): () => void {
    this.inboundRejectedListeners.add(listener);
    return () => {
      this.inboundRejectedListeners.delete(listener);
    };
  }

  resolveDeliveryScope(intent: MessagingSurfaceIntent): MessagingDeliveryScope | undefined {
    const channel = intent.audit?.channel;
    if (!channel) return undefined;
    return {
      platform: "line",
      id: channel.conversation.id,
      kind: channel.conversation.kind === "dm" ? "dm" : "group",
      label: channel.conversation.title,
    };
  }

  async deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult> {
    const deliveredAt = this.now();
    if (intent.kind === "dismiss") {
      return { channel: "line", deliveredAt, outcome: "unsupported" };
    }
    const target = this.resolveTarget(intent);
    if (!target) {
      return {
        channel: "line",
        deliveredAt,
        outcome: "failed",
        errorMessage: "missing LINE conversation target",
      };
    }

    const text = clampLineMessage(textForLineIntent(intent));
    const actions = actionsForLineIntent(intent);
    const callbackHandleWrites: Promise<void>[] = [];
    const messages: LineMessage[] = [];
    if (!this.api) {
      return {
        channel: "line",
        deliveredAt,
        outcome: "failed",
        errorMessage: "LINE channel access token is required to send messages",
      };
    }
    if (intent.kind === "activity") {
      return await this.deliverActivity(intent, target, deliveredAt);
    }
    if (text) {
      messages.push({ type: "text", text });
    }
    messages.push(...imageMessagesForLineIntent(intent));
    if (shouldDiscardLineStatusUpdate(intent)) {
      return { channel: "line", deliveredAt, outcome: "discarded" };
    }
    let actionMessage: LineMessage | undefined;
    try {
      actionMessage = buildLineActionBubble({
        actions,
        buildPostbackData: this.buildPostbackDataBuilder({
          allowedActorIds: callbackAllowedActorIds(intent),
          bindingId: callbackBindingId(intent),
          callbackHandleWrites,
          channelRef: target.channelRef,
          intent,
        }),
        capabilityProfile: this.capabilityProfile,
        layout: intent.actionLayout,
        title: titleForLineActionBubble(intent, text),
      });
      await Promise.all(callbackHandleWrites);
    } catch (error) {
      return {
        channel: "line",
        deliveredAt: this.now(),
        outcome: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    if (actionMessage) {
      messages.push(actionMessage);
    }
    if (messages.length === 0) {
      return { channel: "line", deliveredAt, outcome: "discarded" };
    }

    try {
      const result = await this.api.pushMessage({
        to: target.conversationId,
        messages: messages.slice(0, 5),
      });
      const messageId = result.sentMessages?.find((message) => message.id)?.id
        ?? `${target.conversationId}:${intent.id}`;
      return {
        channel: "line",
        deliveredAt: this.now(),
        outcome: intent.targetSurface ? "presented_new" : "presented",
        surface: {
          channel: "line",
          id: messageId,
          state: {
            opaque: {
              conversationId: target.conversationId,
              conversationKind: target.channelRef.conversation.kind,
              messageId,
            } satisfies LineRoutingOpaqueState,
          },
        },
      };
    } catch (error) {
      return {
        channel: "line",
        deliveredAt: this.now(),
        outcome: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async downloadAttachment(
    request: MessagingAttachmentDownloadRequest,
  ): Promise<MessagingAttachmentDownloadResult> {
    const messageId = readAttachmentMessageId(request.attachment);
    if (!messageId) {
      throw new Error("LINE attachment is missing a message id");
    }
    if (!this.api) {
      throw new Error("LINE channel access token is required to download attachments");
    }
    const providerMaxBytes = this.capabilityProfile.inboundAttachments?.maxDownloadBytes;
    const maxBytes = providerMaxBytes === undefined
      ? request.maxBytes
      : Math.min(request.maxBytes, providerMaxBytes);
    if (
      maxBytes !== undefined
      && request.attachment.sizeBytes !== undefined
      && request.attachment.sizeBytes > maxBytes
    ) {
      throw new Error("LINE attachment exceeds the configured download limit");
    }
    const data = await this.api.downloadMessageContent(messageId);
    if (maxBytes !== undefined && data.byteLength > maxBytes) {
      throw new Error("LINE attachment exceeds the configured download limit");
    }
    return {
      data,
      fileName: request.attachment.name || `${messageId}.bin`,
      mimeType: request.attachment.mimeType,
      sizeBytes: data.byteLength,
    };
  }

  private async deliverActivity(
    intent: MessagingSurfaceIntent & { kind: "activity" },
    target: { channelRef: MessagingChannelRef; conversationId: string },
    deliveredAt: number,
  ): Promise<MessagingDeliveryResult> {
    if (
      intent.activity !== "typing"
      || intent.state !== "active"
      || target.channelRef.conversation.kind !== "dm"
      || !this.api?.showLoadingAnimation
    ) {
      return { channel: "line", deliveredAt, outcome: "discarded" };
    }

    try {
      await this.api.showLoadingAnimation({
        chatId: target.conversationId,
        loadingSeconds: lineLoadingSecondsForLease(intent.leaseMs),
      });
      return { channel: "line", deliveredAt: this.now(), outcome: "signaled" };
    } catch (error) {
      return {
        channel: "line",
        deliveredAt: this.now(),
        outcome: "discarded",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async handleWebhookRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }

    let body: Buffer;
    try {
      body = await readRequestBody(request, LINE_WEBHOOK_BODY_LIMIT_BYTES);
    } catch (error) {
      response.statusCode = 413;
      response.end();
      this.logger.warn?.("line webhook body rejected", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const signature = request.headers["x-line-signature"];
    if (
      typeof signature !== "string"
      || !verifyLineSignature(body, signature, this.config.channelSecret)
    ) {
      response.statusCode = 401;
      response.end();
      this.logger.warn?.("line webhook signature rejected", {
        bodyLength: body.byteLength,
        signaturePresent: typeof signature === "string",
      });
      return;
    }

    let parsed: LineWebhookBody;
    try {
      parsed = JSON.parse(body.toString("utf8")) as LineWebhookBody;
    } catch {
      response.statusCode = 400;
      response.end();
      return;
    }

    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end("{}");

    if (!Array.isArray(parsed.events)) return;
    for (const event of parsed.events) {
      await this.handleWebhookEvent(event);
    }
  }

  private async handleWebhookEvent(event: LineWebhookEvent): Promise<void> {
    if (!this.listener) return;
    const ids = this.validateInboundIds(event);
    if (!ids) return;
    const actor = ids.userId
      ? this.actorForLineUser(ids.userId)
      : this.actorForLifecycleEvent();
    const channel = this.channelRefForSource(event.source!, ids);
    const routingState = this.routingStateForChannel(channel, {
      messageId: ids.messageId,
      replyToken: event.replyToken,
    });

    switch (event.type) {
      case "message":
        await this.handleMessageEvent(event, actor, channel, routingState);
        return;
      case "postback":
        await this.handlePostbackEvent(event, actor, channel, routingState);
        return;
      case "follow":
      case "unfollow":
        if (!ids.userId) return;
        if (!this.authorizeInbound({ actor, channel, kind: "lifecycle", routingState })) {
          return;
        }
        await this.listener({
          id: ids.eventId,
          kind: "lifecycle",
          actor,
          channel,
          receivedAt: this.now(),
          routingState,
          lifecycle: event.type === "follow" ? "bound" : "detached",
        });
        return;
      case "join":
      case "leave":
        if (!this.isAuthorizedConversation(channel)) {
          return;
        }
        if (!ids.userId) {
          this.logger.debug?.("line lifecycle event ignored without source user", {
            conversationId: channel.conversation.id,
            eventType: event.type,
          });
          return;
        }
        if (!this.authorizeInbound({ actor, channel, kind: "lifecycle", routingState })) {
          return;
        }
        await this.listener({
          id: ids.eventId,
          kind: "lifecycle",
          actor,
          channel,
          receivedAt: this.now(),
          routingState,
          lifecycle:
            event.type === "join"
              ? "bound"
              : "detached",
        });
        return;
      default:
        return;
    }
  }

  private async handleMessageEvent(
    event: LineWebhookEvent,
    actor: MessagingActorIdentity,
    channel: MessagingChannelRef,
    routingState: MessagingAdapterState,
  ): Promise<void> {
    if (!this.listener || !event.message) return;
    const text = event.message.type === "text" ? event.message.text ?? "" : "";
    const isPairing = Boolean(extractMessagingPairingToken(text));
    if (!isPairing && !this.shouldAcceptTextEvent(event, channel, text)) {
      return;
    }
    if (!this.authorizeInbound({
      actor,
      channel,
      kind: event.message.type === "text" ? "text" : "media",
      pairing: isPairing,
      routingState,
    })) {
      return;
    }
    if (event.message.type === "text") {
      if (text.startsWith("/")) {
        await this.listener({
          id: this.eventIdFor(event),
          kind: "command",
          actor,
          channel,
          receivedAt: this.now(),
          routingState,
          rawText: text,
          command: text.slice(1).split(/\s+/)[0] ?? "",
          args: text.trim().split(/\s+/).slice(1),
        });
        return;
      }
      await this.listener({
        id: this.eventIdFor(event),
        kind: "text",
        actor,
        channel,
        receivedAt: this.now(),
        routingState,
        text: stripSelfMention(text, event.message.mention),
      });
      return;
    }

    const attachment = this.attachmentForMessage(event.message);
    if (!attachment) return;
    await this.listener({
      id: this.eventIdFor(event),
      kind: "media",
      actor,
      channel,
      receivedAt: this.now(),
      routingState,
      attachments: [attachment],
      disposition: attachment.disposition,
      text,
    });
  }

  private async handlePostbackEvent(
    event: LineWebhookEvent,
    actor: MessagingActorIdentity,
    channel: MessagingChannelRef,
    routingState: MessagingAdapterState,
  ): Promise<void> {
    if (!this.listener) return;
    const signed = this.parseSignedPostbackData(event.postback?.data);
    if (!signed) return;
    const handleValidation = validateLineCallbackHandle(signed.handle);
    if (!handleValidation.ok) {
      logLineInvalidIdentifier({
        field: "callback.data",
        logger: this.logger,
        reason: handleValidation.reason,
        value: signed.handle,
      });
      return;
    }
    if (!this.authorizeInbound({ actor, channel, kind: "callback", routingState })) {
      return;
    }
    const record = await this.callbackHandleStore.resolveCallbackHandle({
      actorId: actor.platformUserId,
      channel,
      handle: signed.handle,
      now: this.now(),
    });
    if (!record) {
      this.logger.warn?.("line callback handle unresolved", {
        actorId: actor.platformUserId,
        channelId: channel.conversation.id,
        handleHash: createHash("sha256").update(signed.handle).digest("hex").slice(0, 8),
      });
      return;
    }
    await this.listener({
      id: this.eventIdFor(event),
      kind: "callback",
      actor,
      channel,
      receivedAt: this.now(),
      routingState,
      interaction: {
        channel: "line",
        id: record.actionId,
        state: record.surface?.state ?? routingState,
      },
      actionId: record.actionId,
      ...(record.value !== undefined ? { value: record.value } : {}),
    });
  }

  private authorizeInbound(params: {
    actor: MessagingActorIdentity;
    channel: MessagingChannelRef;
    kind: MessagingInboundEvent["kind"];
    pairing?: boolean;
    routingState?: MessagingAdapterState;
  }): boolean {
    if (params.pairing) return true;
    if (!this.authorizedActorIds.includes(params.actor.platformUserId)) {
      this.emitInboundRejected({
        id: this.newEventId("line-rejected"),
        kind: params.kind,
        actor: params.actor,
        channel: params.channel,
        receivedAt: this.now(),
        reason: "unauthorized-actor",
        ...(params.routingState ? { routingState: params.routingState } : {}),
      });
      return false;
    }
    if (!this.isAuthorizedConversation(params.channel)) {
      this.emitInboundRejected({
        id: this.newEventId("line-rejected"),
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

  private isAuthorizedConversation(channel: MessagingChannelRef): boolean {
    if (channel.conversation.kind === "dm") return true;
    const groupIds = this.config.authorizedGroupIds?.map((entry) => entry.id) ?? [];
    const roomIds = this.config.authorizedRoomIds?.map((entry) => entry.id) ?? [];
    if (channel.conversation.id.startsWith("C")) {
      return groupIds.includes(channel.conversation.id);
    }
    if (channel.conversation.id.startsWith("R")) {
      return roomIds.includes(channel.conversation.id);
    }
    return false;
  }

  private shouldAcceptTextEvent(
    event: LineWebhookEvent,
    channel: MessagingChannelRef,
    text: string,
  ): boolean {
    if (channel.conversation.kind === "dm") return true;
    if (text.startsWith("/")) return true;
    const mentionees = event.message?.mention?.mentionees ?? [];
    return mentionees.some((mention) => mention.isSelf === true || mention.userId === this.botUserId);
  }

  private validateInboundIds(event: LineWebhookEvent): {
    eventId: string;
    groupId?: string;
    messageId?: string;
    roomId?: string;
    userId?: string;
  } | undefined {
    if (!event.source) {
      return undefined;
    }
    const eventValidation = validateLineWebhookEventId(event.webhookEventId);
    if (!eventValidation.ok) {
      logLineInvalidIdentifier({
        field: "webhook_event_id",
        logger: this.logger,
        reason: eventValidation.reason,
        value: event.webhookEventId,
      });
      return undefined;
    }
    let userId: string | undefined;
    if (event.source?.userId !== undefined || lineEventRequiresUserId(event)) {
      const userValidation = validateLineUserId(event.source?.userId);
      if (!userValidation.ok) {
        logLineInvalidIdentifier({
          field: "user_id",
          logger: this.logger,
          reason: userValidation.reason,
          value: event.source?.userId,
        });
        return undefined;
      }
      userId = event.source?.userId;
    }
    let groupId: string | undefined;
    let roomId: string | undefined;
    if (event.source?.type === "group") {
      const validation = validateLineGroupId(event.source.groupId);
      if (!validation.ok) {
        logLineInvalidIdentifier({
          field: "group_id",
          logger: this.logger,
          reason: validation.reason,
          value: event.source.groupId,
        });
        return undefined;
      }
      groupId = event.source.groupId;
    }
    if (event.source?.type === "room") {
      const validation = validateLineRoomId(event.source.roomId);
      if (!validation.ok) {
        logLineInvalidIdentifier({
          field: "room_id",
          logger: this.logger,
          reason: validation.reason,
          value: event.source.roomId,
        });
        return undefined;
      }
      roomId = event.source.roomId;
    }
    let messageId: string | undefined;
    if (event.message?.id !== undefined) {
      const validation = validateLineMessageId(event.message.id);
      if (!validation.ok) {
        logLineInvalidIdentifier({
          field: "message_id",
          logger: this.logger,
          reason: validation.reason,
          value: event.message.id,
        });
        return undefined;
      }
      messageId = event.message.id;
    }
    return {
      eventId: event.webhookEventId!,
      ...(userId ? { userId } : {}),
      ...(groupId ? { groupId } : {}),
      ...(roomId ? { roomId } : {}),
      ...(messageId ? { messageId } : {}),
    };
  }

  private actorForLineUser(userId: string): MessagingActorIdentity {
    const contact = this.config.authorizedActorIds.find((item) => item.id === userId);
    return {
      platformUserId: userId,
      displayName: contact?.displayName,
      isBot: false,
    };
  }

  private actorForLifecycleEvent(): MessagingActorIdentity {
    return {
      platformUserId: this.botUserId ?? "line:bot",
      displayName: this.botUserId ? undefined : "LINE bot",
      isBot: true,
    };
  }

  private channelRefForSource(
    source: NonNullable<LineWebhookEvent["source"]>,
    ids: { groupId?: string; roomId?: string; userId?: string },
  ): MessagingChannelRef {
    if (source.type === "group" && ids.groupId) {
      const contact = this.config.authorizedGroupIds?.find((item) => item.id === ids.groupId);
      return {
        channel: "line",
        conversation: {
          id: ids.groupId,
          kind: "channel",
          title: contact?.displayName,
        },
      };
    }
    if (source.type === "room" && ids.roomId) {
      const contact = this.config.authorizedRoomIds?.find((item) => item.id === ids.roomId);
      return {
        channel: "line",
        conversation: {
          id: ids.roomId,
          kind: "channel",
          title: contact?.displayName,
        },
      };
    }
    return {
      channel: "line",
      conversation: {
        id: ids.userId ?? "line:unknown-user",
        kind: "dm",
        title: this.config.authorizedActorIds.find((item) => item.id === ids.userId)
          ?.displayName,
      },
    };
  }

  private routingStateForChannel(
    channel: MessagingChannelRef,
    params: { messageId?: string; replyToken?: string },
  ): MessagingAdapterState {
    return {
      opaque: {
        conversationId: channel.conversation.id,
        conversationKind: channel.conversation.kind,
        ...(channel.conversation.id.startsWith("C")
          ? { groupId: channel.conversation.id }
          : {}),
        ...(channel.conversation.id.startsWith("R")
          ? { roomId: channel.conversation.id }
          : {}),
        ...(params.messageId ? { messageId: params.messageId } : {}),
        ...(params.replyToken ? { replyToken: params.replyToken } : {}),
      } satisfies LineRoutingOpaqueState,
    };
  }

  private attachmentForMessage(
    message: NonNullable<LineWebhookEvent["message"]>,
  ): MessagingAttachmentDescriptor | undefined {
    if (!message.id || !message.type || message.type === "text") return undefined;
    const kind =
      message.type === "image" || message.type === "video" || message.type === "audio"
        ? message.type
        : message.type === "file"
          ? "file"
          : "unknown";
    return {
      id: message.id,
      kind,
      name: message.fileName ?? `${message.type}-${message.id}`,
      disposition: kind === "unknown" ? "unsupported" : "available",
      ...(message.fileSize ? { sizeBytes: message.fileSize } : {}),
      state: {
        opaque: {
          conversationId: "",
          conversationKind: "dm",
          messageId: message.id,
        } satisfies LineRoutingOpaqueState,
      },
    };
  }

  private buildPostbackDataBuilder(params: {
    allowedActorIds: string[];
    bindingId?: string;
    callbackHandleWrites: Promise<void>[];
    channelRef: MessagingChannelRef;
    intent: MessagingSurfaceIntent;
  }): (action: MessagingSurfaceAction) => string {
    return (action) => {
      const handle = `${this.channel}:${createHash("sha256")
        .update(JSON.stringify([params.intent.id, action.id, action.value ?? null]))
        .digest("base64url")
        .slice(0, 18)}`;
      const issuedAt = this.now();
      const sig = this.signPostbackData(handle, issuedAt);
      const write = this.callbackHandleStore
        .upsertCallbackHandle({
          id: lineCallbackRecordId(handle, params),
          actionId: action.id,
          allowedActorIds: params.allowedActorIds,
          bindingId: params.bindingId,
          browseSessionId: browseSessionIdForIntent(params.intent),
          channel: params.channelRef,
          createdAt: issuedAt,
          updatedAt: issuedAt,
          expiresAt: issuedAt + MESSAGING_CALLBACK_HANDLE_TTL_MS,
          handle,
          pendingIntentId: params.intent.id,
          ...(action.value !== undefined ? { value: action.value } : {}),
        })
        .then(() => undefined);
      params.callbackHandleWrites.push(write);
      return JSON.stringify({
        v: LINE_SIGNED_VALUE_VERSION,
        h: handle,
        t: issuedAt,
        s: sig,
      });
    };
  }

  private parseSignedPostbackData(
    value: unknown,
  ): { handle: string; issuedAt: number } | undefined {
    if (typeof value !== "string") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
    const record = parsed as {
      h?: unknown;
      s?: unknown;
      t?: unknown;
      v?: unknown;
    };
    if (
      record.v !== LINE_SIGNED_VALUE_VERSION
      || typeof record.h !== "string"
      || typeof record.s !== "string"
      || typeof record.t !== "number"
    ) {
      return undefined;
    }
    const expected = this.signPostbackData(record.h, record.t);
    if (!safeEqual(expected, record.s)) {
      this.logger.warn?.("line callback signature rejected", {
        handleHash: createHash("sha256").update(record.h).digest("hex").slice(0, 8),
      });
      return undefined;
    }
    return { handle: record.h, issuedAt: record.t };
  }

  private signPostbackData(handle: string, issuedAt: number): string {
    return createHmac("sha256", this.signingSecret)
      .update(JSON.stringify([handle, issuedAt]))
      .digest("base64url")
      .slice(0, 32);
  }

  private resolveTarget(
    intent: MessagingSurfaceIntent,
  ): { channelRef: MessagingChannelRef; conversationId: string } | undefined {
    const opaque = readLineOpaque(intent.targetSurface?.state);
    const conversationId = opaque?.conversationId ?? intent.audit?.channel.conversation.id;
    if (!conversationId) return undefined;
    const validation = validateLineConversationId(conversationId);
    if (!validation.ok) {
      logLineInvalidIdentifier({
        field: conversationId.startsWith("R") ? "room_id" : conversationId.startsWith("C") ? "group_id" : "user_id",
        logger: this.logger,
        reason: validation.reason,
        value: conversationId,
      });
      return undefined;
    }
    const channelRef = intent.audit?.channel ?? {
      channel: "line" as const,
      conversation: {
        id: conversationId,
        kind: opaque?.conversationKind ?? "dm",
      },
    };
    return { channelRef, conversationId };
  }

  private eventIdFor(event: LineWebhookEvent): string {
    return event.webhookEventId ?? this.newEventId("line-event");
  }

  private newEventId(prefix: string): string {
    return `${prefix}:${this.now()}:${randomBytes(6).toString("hex")}`;
  }

  private emitInboundRejected(event: MessagingRejectedInboundEvent): void {
    for (const listener of this.inboundRejectedListeners) {
      try {
        void listener(event);
      } catch {
        // Observability only; webhook handling continues.
      }
    }
  }
}

export function createLineAdapter(
  config: LineMessagingConfig,
  callbackHandleStore: MessagingCallbackHandleStore,
  logger?: LineProviderLogger,
): LineAdapter {
  return new LineAdapter({ config, callbackHandleStore, logger });
}

export function createLineApi(channelAccessToken: string): LineApi {
  const client = new messagingApi.MessagingApiClient({ channelAccessToken });
  const blobClient = new messagingApi.MessagingApiBlobClient({ channelAccessToken });
  return {
    async getBotInfo() {
      return await client.getBotInfo();
    },
    async pushMessage(params) {
      return await client.pushMessage(params);
    },
    async showLoadingAnimation(params) {
      return await client.showLoadingAnimation(params);
    },
    async downloadMessageContent(messageId) {
      const content = await blobClient.getMessageContent(messageId);
      return await readableToUint8Array(content);
    },
  };
}

export function verifyLineSignature(
  body: Buffer,
  signature: string,
  channelSecret: string,
): boolean {
  const expected = createHmac("sha256", channelSecret).update(body).digest("base64");
  return safeEqual(expected, signature);
}

function bindAddressFromCallbackUrl(callbackBaseUrl: string): {
  host: string;
  port: number;
} {
  try {
    const parsed = new URL(callbackBaseUrl);
    const host = parsed.hostname || DEFAULT_CALLBACK_HOST;
    const port = parsed.port
      ? Number(parsed.port)
      : DEFAULT_CALLBACK_PORT;
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return { host, port };
    }
  } catch {
    /* fall through */
  }
  return { host: DEFAULT_CALLBACK_HOST, port: DEFAULT_CALLBACK_PORT };
}

function readAttachmentMessageId(
  attachment: MessagingAttachmentDescriptor,
): string | undefined {
  const opaque = readLineOpaque(attachment.state);
  return opaque?.messageId ?? attachment.id;
}

function readLineOpaque(
  state: MessagingAdapterState | undefined,
): LineRoutingOpaqueState | undefined {
  const opaque = state?.opaque;
  if (!opaque || typeof opaque !== "object" || Array.isArray(opaque)) {
    return undefined;
  }
  const record = opaque as Partial<LineRoutingOpaqueState>;
  if (typeof record.conversationId !== "string") return undefined;
  return {
    conversationId: record.conversationId,
    conversationKind: record.conversationKind ?? "dm",
    ...(typeof record.groupId === "string" ? { groupId: record.groupId } : {}),
    ...(typeof record.messageId === "string" ? { messageId: record.messageId } : {}),
    ...(typeof record.replyToken === "string" ? { replyToken: record.replyToken } : {}),
    ...(typeof record.roomId === "string" ? { roomId: record.roomId } : {}),
  };
}

function stripSelfMention(
  text: string,
  mention: NonNullable<LineWebhookEvent["message"]>["mention"],
): string {
  const selfMention = mention?.mentionees?.find((entry) => entry.isSelf);
  if (!selfMention) return text;
  return text.replace(/^@\S+\s*/, "").trimStart();
}

function shouldDiscardLineStatusUpdate(intent: MessagingSurfaceIntent): boolean {
  return (
    intent.kind === "status"
    && intent.delivery?.mode === "update"
    && intent.targetSurface !== undefined
  );
}

function titleForLineActionBubble(
  intent: MessagingSurfaceIntent,
  text: string,
): string {
  switch (intent.kind) {
    case "thread_picker":
    case "project_picker":
    case "single_select":
    case "multi_select":
      return intent.prompt;
    case "approval":
    case "confirmation":
      return intent.title;
    case "status":
      return "Thread status";
    case "questionnaire": {
      const question = intent.questions[intent.currentIndex] ?? intent.questions[0];
      return question?.header || question?.question || "PwrAgent";
    }
    default:
      return text || intent.fallbackText || "PwrAgent";
  }
}

function lineLoadingSecondsForLease(leaseMs: number | undefined): number {
  if (leaseMs === undefined) {
    return 5;
  }
  const seconds = Math.ceil(leaseMs / 1000);
  const rounded = Math.ceil(seconds / 5) * 5;
  return Math.max(5, Math.min(60, rounded));
}

function lineEventRequiresUserId(event: LineWebhookEvent): boolean {
  return (
    event.type === "message"
    || event.type === "postback"
    || event.type === "follow"
    || event.type === "unfollow"
    || event.source?.type === "user"
  );
}

function callbackAllowedActorIds(intent: MessagingSurfaceIntent): string[] {
  return intent.allowedActorIds && intent.allowedActorIds.length > 0
    ? intent.allowedActorIds
    : [intent.audit?.actor.platformUserId ?? "unknown"];
}

function lineContactsFromIds(
  ids: readonly string[],
  previous: readonly { id: string; displayName: string }[] | undefined,
): { id: string; displayName: string }[] {
  const previousById = new Map((previous ?? []).map((contact) => [contact.id, contact]));
  return ids.map((id) => previousById.get(id) ?? { id, displayName: "" });
}

function callbackBindingId(intent: MessagingSurfaceIntent): string | undefined {
  return intent.audit?.bindingId ?? intent.bindingId;
}

function browseSessionIdForIntent(intent: MessagingSurfaceIntent): string | undefined {
  return intent.kind === "thread_picker" ||
    intent.kind === "project_picker" ||
    intent.kind === "confirmation"
    ? intent.browseSessionId
    : undefined;
}

function lineCallbackRecordId(
  handle: string,
  params: {
    bindingId?: string;
    channelRef: MessagingChannelRef;
    intent: MessagingSurfaceIntent;
  },
): string {
  const deliveryScope = createHash("sha256")
    .update(
      JSON.stringify([
        params.channelRef.channel,
        params.channelRef.conversation.kind,
        params.channelRef.conversation.id,
        params.channelRef.conversation.parentId ?? null,
        params.bindingId ?? null,
      ]),
    )
    .digest("base64url")
    .slice(0, 16);
  return `line-callback:${handle}:${deliveryScope}`;
}

async function readRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readableToUint8Array(input: unknown): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  if (input instanceof Readable) {
    for await (const chunk of input) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input && typeof input === "object" && Symbol.asyncIterator in input) {
    for await (const chunk of input as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  throw new Error("unsupported LINE content stream");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.byteLength !== rightBuffer.byteLength) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
