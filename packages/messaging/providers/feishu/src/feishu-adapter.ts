import {
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type {
  MessagingActorIdentity,
  MessagingAdapterAuthorizationUpdate,
  MessagingAdapterDiagnosticEvent,
  MessagingAdapterDiagnosticListener,
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
  MessagingInboundCallbackEvent,
  MessagingInboundEvent,
  MessagingInboundRejectedListener,
  MessagingJsonValue,
  MessagingRateLimitInfo,
  MessagingRejectedInboundEvent,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import {
  extractMessagingPairingToken,
  MESSAGING_CALLBACK_HANDLE_TTL_MS,
} from "@pwragent/messaging-interface";
import type { FeishuMessagingConfig } from "./feishu-config.ts";
import {
  FEISHU_BUTTON_VALUE_LIMIT,
  actionsForFeishuIntent,
  buildFeishuActionElements,
  buildFeishuCardForIntent,
  clampFeishuMessage,
  textForFeishuIntent,
  type FeishuInteractiveCard,
} from "./feishu-formatting.ts";
import {
  logFeishuInvalidIdentifier,
  validateFeishuCallbackHandle,
  validateFeishuChatId,
  validateFeishuMessageId,
  validateFeishuOpenId,
  validateFeishuTenantKey,
} from "./validate-ids.ts";

const DEFAULT_CALLBACK_PORT = 47823;
const DEFAULT_CALLBACK_HOST = "127.0.0.1";
const FEISHU_SIGNED_VALUE_VERSION = 1;
const FEISHU_WEBHOOK_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

export type FeishuProviderLogger = {
  debug?: (message: string, data?: Record<string, unknown>) => void;
  info?: (message: string, data?: Record<string, unknown>) => void;
  warn?: (message: string, data?: Record<string, unknown>) => void;
  error?: (message: string, data?: Record<string, unknown>) => void;
};

export type FeishuBotInfo = {
  appName?: string;
  avatarUrl?: string;
  openId?: string;
  tenantKey?: string;
};

export type FeishuSendMessageParams = {
  card?: FeishuInteractiveCard;
  receiveId: string;
  receiveIdType: "chat_id" | "open_id";
  text?: string;
};

export type FeishuSendMessageResult = {
  chatId?: string;
  messageId?: string;
};

type FeishuMessageResourceType = "file" | "image";

export type FeishuApi = {
  deleteMessage(params: { messageId: string }): Promise<void>;
  downloadFile(params: {
    fileKey: string;
    maxBytes: number;
    messageId: string;
    resourceType: FeishuMessageResourceType;
  }): Promise<Uint8Array>;
  getBotInfo(): Promise<FeishuBotInfo>;
  sendMessage(params: FeishuSendMessageParams): Promise<FeishuSendMessageResult>;
  updateMessage(params: { card: FeishuInteractiveCard; messageId: string }): Promise<FeishuSendMessageResult>;
};

export type FeishuProviderAdapter = {
  authorizedActorIds: readonly string[];
  capabilityProfile: MessagingCapabilityProfile;
  channel: "feishu";
  clientRateLimitStrategy: MessagingClientRateLimitStrategy;
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  downloadAttachment(
    request: MessagingAttachmentDownloadRequest,
  ): Promise<MessagingAttachmentDownloadResult>;
  onInboundRejected?(listener: MessagingInboundRejectedListener): () => void;
  onDiagnostic?(listener: MessagingAdapterDiagnosticListener): () => void;
  onRateLimit?(listener: (info: MessagingRateLimitInfo) => void): () => void;
  readCredentialMetadata?(): { account?: string; detail?: string } | undefined;
  resolveDeliveryScope?(intent: MessagingSurfaceIntent): MessagingDeliveryScope | undefined;
  start(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  updateAuthorization?(update: MessagingAdapterAuthorizationUpdate): Promise<void>;
  updateRenderingPreferences?(update: MessagingAdapterRenderingPreferencesUpdate): Promise<void>;
};

export type FeishuAdapterOptions = {
  api?: FeishuApi;
  callbackHandleStore: MessagingCallbackHandleStore;
  config: FeishuMessagingConfig;
  logger?: FeishuProviderLogger;
  now?: () => number;
  wsClientFactory?: FeishuWsClientFactory;
};

type FeishuInboundListener = (event: MessagingInboundEvent) => Promise<void>;

type FeishuEventDispatcher = {
  invoke(data: unknown, params?: { needCheck?: boolean }): Promise<unknown>;
};

type FeishuWsClient = {
  close(params?: { force?: boolean }): void;
  start(params: { eventDispatcher: FeishuEventDispatcher }): Promise<void>;
};

type FeishuWsClientFactory = (params: {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
}) => FeishuWsClient | Promise<FeishuWsClient>;

type LarkSdkLogger = {
  debug: (...msg: unknown[]) => void;
  error: (...msg: unknown[]) => void;
  info: (...msg: unknown[]) => void;
  trace: (...msg: unknown[]) => void;
  warn: (...msg: unknown[]) => void;
};

type FeishuRoutingOpaqueState = {
  chatId?: string;
  conversationId: string;
  conversationKind: MessagingConversationKind;
  messageId?: string;
  openId?: string;
  tenantKey?: string;
};

type FeishuEventEnvelope = {
  challenge?: string;
  event?: FeishuReceiveMessageEvent | FeishuCardActionEvent;
  header?: {
    event_id?: string;
    event_type?: string;
    token?: string;
    tenant_key?: string;
  };
  schema?: string;
  token?: string;
  type?: string;
};

type FeishuReceiveMessageEvent = {
  message?: {
    chat_id?: string;
    chat_type?: "group" | "p2p";
    content?: string;
    create_time?: string;
    mentions?: Array<{ id?: { open_id?: string }; key?: string; name?: string; tenant_key?: string }>;
    message_id?: string;
    message_type?: string;
  };
  sender?: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
};

type FeishuCardActionEvent = {
  action?: {
    tag?: string;
    value?: Record<string, unknown>;
  };
  context?: {
    open_chat_id?: string;
    open_message_id?: string;
  };
  operator?: {
    open_id?: string;
    union_id?: string;
    user_id?: string;
  };
  tenant_key?: string;
  token?: string;
};

type FeishuCardActionResponse = {
  toast: {
    content: string;
    type: "error" | "info" | "success" | "warning";
  };
};

type FeishuSignedCallbackChannel = {
  i: string;
  k: "dm" | "channel";
  p?: string;
};

const FEISHU_CARD_ACTION_ACK: FeishuCardActionResponse = {
  toast: {
    content: "PwrAgent received this action.",
    type: "info",
  },
};

const FEISHU_CARD_ACTION_UNAVAILABLE: FeishuCardActionResponse = {
  toast: {
    content: "This PwrAgent action is no longer available.",
    type: "warning",
  },
};

export class FeishuAdapter implements FeishuProviderAdapter {
  readonly channel = "feishu" as const;
  readonly clientRateLimitStrategy: MessagingClientRateLimitStrategy = "direct";
  readonly capabilityProfile: MessagingCapabilityProfile = {
    actions: {
      // Feishu cards support button elements inside action modules. The
      // public docs describe card module/component ceilings but not a
      // concise cross-version button total, so keep a conservative v1
      // budget and cite this as implementation policy in docs.
      maxActions: 20,
      maxActionsPerRow: 4,
      maxRows: 5,
      maxLabelLength: 20,
      supportsStyles: true,
      supportsDisabled: false,
      supportsLayoutHints: true,
      maxCallbackPayloadBytes: FEISHU_BUTTON_VALUE_LIMIT,
    },
    text: {
      maxLength: 30_000,
      encoding: "characters",
      markdownDialect: "feishu-md",
      supportsCodeBlocks: true,
      supportsBold: true,
      supportsItalic: true,
      supportsInlineCode: true,
      supportsLinks: true,
      supportsMessageEdit: true,
    },
    conversationInput: {
      sharedConversationRequiresMention: true,
      sharedConversationMentionInstruction:
        "In this Feishu / Lark group, @mention this bot for messages to reach the bound thread.",
      sharedConversationStatusLine:
        "Input: @mention this bot for messages to reach this bound thread.",
    },
    inboundAttachments: {
      maxAttachmentCount: 4,
      maxDownloadBytes: 30 * 1024 * 1024,
      supportsDownload: true,
    },
    outboundAttachments: {
      maxUploadBytes: 30 * 1024 * 1024,
      supportsFileUpload: false,
      supportsImageUpload: false,
      supportsRemoteImageUrl: false,
    },
  };

  private readonly api: FeishuApi;
  private readonly callbackHandleStore: MessagingCallbackHandleStore;
  private readonly config: FeishuMessagingConfig;
  private readonly logger: FeishuProviderLogger;
  private readonly now: () => number;
  private readonly server: Server;
  private readonly signingSecret: string;
  private readonly wsClientFactory: FeishuWsClientFactory;
  private authorizedActorIdsValue: string[];
  private botAccount: string | undefined;
  private botAccountDetail: string | undefined;
  private listener: FeishuInboundListener | undefined;
  private started = false;
  private webhookListening = false;
  private wsClient: FeishuWsClient | undefined;
  private readonly diagnosticListeners = new Set<MessagingAdapterDiagnosticListener>();
  private readonly inboundRejectedListeners = new Set<MessagingInboundRejectedListener>();
  private readonly rateLimitListeners = new Set<(info: MessagingRateLimitInfo) => void>();

  constructor(options: FeishuAdapterOptions) {
    this.config = options.config;
    this.api = options.api ?? createFeishuApi(options.config);
    this.callbackHandleStore = options.callbackHandleStore;
    this.logger = options.logger ?? {};
    this.now = options.now ?? Date.now;
    this.authorizedActorIdsValue = options.config.authorizedActorIds.map((actor) => actor.id);
    this.signingSecret =
      options.config.verificationToken?.trim()
      || options.config.appSecret.trim()
      || randomBytes(32).toString("hex");
    this.wsClientFactory = options.wsClientFactory ?? (async (params) => {
      const lark = await import("@larksuiteoapi/node-sdk");
      return new lark.WSClient({
        appId: params.appId,
        appSecret: params.appSecret,
        domain: params.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
        logger: larkLoggerFromProviderLogger(this.logger),
        loggerLevel: lark.LoggerLevel.info,
        source: "pwragent",
      });
    });
    this.server = createServer((request, response) => {
      void this.handleWebhookRequest(request, response);
    });
  }

  get authorizedActorIds(): readonly string[] {
    return this.authorizedActorIdsValue;
  }

  readCredentialMetadata(): { account?: string; detail?: string } | undefined {
    if (!this.botAccount && !this.botAccountDetail) return undefined;
    return {
      ...(this.botAccount ? { account: this.botAccount } : {}),
      ...(this.botAccountDetail ? { detail: this.botAccountDetail } : {}),
    };
  }

  async updateAuthorization(update: MessagingAdapterAuthorizationUpdate): Promise<void> {
    this.authorizedActorIdsValue = [...update.authorizedActorIds];
    this.config.authorizedActorIds = feishuContactsFromIds(
      update.authorizedActorIds,
      this.config.authorizedActorIds,
    );
    this.config.authorizedChatIds = feishuContactsFromIds(
      update.authorizedConversationIds ?? [],
      this.config.authorizedChatIds,
    );
    this.config.authorizedTenantKeys = feishuContactsFromIds(
      update.authorizedWorkspaceIds ?? [],
      this.config.authorizedTenantKeys,
    );
  }

  async updateRenderingPreferences(
    update: MessagingAdapterRenderingPreferencesUpdate,
  ): Promise<void> {
    if (update.streamingResponses !== undefined) {
      this.config.streamingResponses = update.streamingResponses;
    }
  }

  onInboundRejected(listener: MessagingInboundRejectedListener): () => void {
    this.inboundRejectedListeners.add(listener);
    return () => {
      this.inboundRejectedListeners.delete(listener);
    };
  }

  onDiagnostic(listener: MessagingAdapterDiagnosticListener): () => void {
    this.diagnosticListeners.add(listener);
    return () => {
      this.diagnosticListeners.delete(listener);
    };
  }

  onRateLimit(listener: (info: MessagingRateLimitInfo) => void): () => void {
    this.rateLimitListeners.add(listener);
    return () => {
      this.rateLimitListeners.delete(listener);
    };
  }

  resolveDeliveryScope(intent: MessagingSurfaceIntent): MessagingDeliveryScope | undefined {
    const target = this.resolveTarget(intent);
    return target ? this.rateLimitScopeForTarget(target) : undefined;
  }

  async start(listener: FeishuInboundListener): Promise<void> {
    if (this.started) return;
    this.listener = listener;
    const botInfo = await this.api.getBotInfo();
    this.botAccount = botInfo.appName ?? botInfo.openId;
    this.botAccountDetail = botInfo.tenantKey ?? hostFromUrl(this.config.tenantUrl);
    if (this.config.inboundMode === "webhook") {
      await this.listenForCallbacks();
    } else {
      await this.startPersistentConnection();
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.wsClient?.close({ force: true });
    this.wsClient = undefined;
    if (this.webhookListening) {
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }).catch((error) => {
        this.logger.warn?.("feishu webhook listener close failed", { error });
      });
      this.webhookListening = false;
    }
    this.listener = undefined;
    this.started = false;
  }

  async deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult> {
    const deliveredAt = this.now();
    if (intent.kind === "activity") {
      return { outcome: "discarded", channel: this.channel, deliveredAt };
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
        errorMessage: "Feishu delivery target is missing",
      };
    }

    const rawText = textForFeishuIntent(intent);
    const actions = actionsForFeishuIntent(intent);
    const callbackBuilder = this.buildCallbackValueBuilder({
      allowedActorIds: callbackAllowedActorIds(intent, this.authorizedActorIds[0] ?? ""),
      bindingId: callbackBindingId(intent),
      channelRef: target.channelRef,
      intent,
    });
    const actionElements = buildFeishuActionElements({
      actions,
      buildCallbackValue: callbackBuilder,
      capabilityProfile: this.capabilityProfile,
      layout: intent.actionLayout,
    });
    const card = buildFeishuCardForIntent({
      actionElements,
      intent,
      text: rawText,
    });

    try {
      const updated =
        intent.delivery?.mode === "update" && target.messageId
          ? await this.api.updateMessage({ card, messageId: target.messageId })
          : undefined;
      const shouldSendCard = shouldSendFeishuCard(intent, rawText, actionElements.length);
      const result = updated ?? (await this.api.sendMessage({
        card: shouldSendCard ? card : undefined,
        receiveId: target.receiveId,
        receiveIdType: target.receiveIdType,
        text: shouldSendCard
          ? undefined
          : clampFeishuMessage(rawText || intent.fallbackText || "PwrAgent"),
      }));
      const messageId = result.messageId ?? target.messageId;
      if (!messageId) {
        return {
          outcome: "failed",
          channel: this.channel,
          deliveredAt: this.now(),
          errorMessage: "Feishu did not return a message id",
        };
      }

      return {
        outcome: updated ? "updated" : "presented",
        channel: this.channel,
        deliveredAt: this.now(),
        surface: {
          channel: this.channel,
          id: messageId,
          state: {
            opaque: {
              messageId,
              receiveId: target.receiveId,
              receiveIdType: target.receiveIdType,
              ...(target.tenantKey ? { tenantKey: target.tenantKey } : {}),
            },
          },
        },
      };
    } catch (error) {
      const rateLimit = this.emitRateLimitFromError(error, target, { retryable: true });
      return {
        outcome: "failed",
        channel: this.channel,
        deliveredAt: this.now(),
        errorMessage: error instanceof Error ? error.message : String(error),
        ...(rateLimit ? { rateLimit } : {}),
      };
    }
  }

  async downloadAttachment(
    request: MessagingAttachmentDownloadRequest,
  ): Promise<MessagingAttachmentDownloadResult> {
    const opaque = request.attachment.state?.opaque;
    const fileKey =
      opaque && typeof opaque === "object" && !Array.isArray(opaque)
        ? (opaque as Record<string, unknown>).fileKey
        : undefined;
    const messageId =
      opaque && typeof opaque === "object" && !Array.isArray(opaque)
        ? (opaque as Record<string, unknown>).messageId
        : undefined;
    if (typeof fileKey !== "string") {
      throw new Error("Feishu attachment is missing file key");
    }
    if (typeof messageId !== "string") {
      throw new Error("Feishu attachment is missing message id");
    }
    const data = await this.api.downloadFile({
      fileKey,
      maxBytes: request.maxBytes,
      messageId,
      resourceType: readAttachmentResourceType(request.attachment),
    });
    return {
      data,
      fileName: request.attachment.name,
      ...(request.attachment.mimeType ? { mimeType: request.attachment.mimeType } : {}),
      sizeBytes: data.byteLength,
    };
  }

  async handleWebhookPayload(payload: FeishuEventEnvelope): Promise<unknown> {
    this.logReceivedEvent("webhook", payload);
    if (payload.type === "url_verification" && typeof payload.challenge === "string") {
      if (!this.isValidWebhookToken(payload.token)) {
        return { status: 401 };
      }
      return { challenge: payload.challenge };
    }

    if (!this.isValidWebhookToken(payload.header?.token ?? payload.token)) {
      return { status: 401 };
    }

    const eventType = payload.header?.event_type;
    if (eventType === "im.message.receive_v1") {
      await this.handleMessageEvent(payload);
    } else if (eventType === "card.action.trigger" || isFeishuCardActionEnvelope(payload)) {
      return {
        body: await this.handleCardActionEvent(payload),
        status: 200,
      };
    } else if (eventType === "im.chat.access_event.bot_p2p_chat_entered_v1") {
      await this.handleBotP2pChatEnteredEvent(payload);
    } else if (eventType === "im.message.message_read_v1") {
      await this.emitDiagnostic({
        id: payload.header?.event_id ?? `feishu:message-read:${this.now()}`,
        platform: this.channel,
        summary: "Feishu / Lark message read event received; no action needed.",
        observedAt: this.now(),
        payload: {
          eventType,
          tenantKey: payload.header?.tenant_key ?? null,
        },
      });
    } else if (eventType) {
      await this.emitDiagnostic({
        id: payload.header?.event_id ?? `feishu:unsupported:${this.now()}`,
        platform: this.channel,
        summary: `Unsupported Feishu / Lark event received: ${eventType}`,
        observedAt: this.now(),
        payload: {
          eventType,
          tenantKey: payload.header?.tenant_key ?? null,
        },
      });
    }
    return { status: 200 };
  }

  private async deliverDismiss(intent: Extract<MessagingSurfaceIntent, { kind: "dismiss" }>): Promise<MessagingDeliveryResult> {
    const deliveredAt = this.now();
    const opaque = intent.targetSurface.state?.opaque;
    const messageId =
      opaque && typeof opaque === "object" && !Array.isArray(opaque)
        ? (opaque as Record<string, unknown>).messageId
        : intent.targetSurface.id;
    if (typeof messageId !== "string") {
      return {
        outcome: "failed",
        channel: this.channel,
        deliveredAt,
        errorMessage: "Feishu dismiss target is missing message id",
      };
    }
    try {
      await this.api.deleteMessage({ messageId });
      return { outcome: "dismissed", channel: this.channel, deliveredAt: this.now() };
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
    if (this.config.streamingResponses !== true && intent.policy !== "enabled") {
      return {
        outcome: "discarded",
        channel: this.channel,
        deliveredAt: this.now(),
      };
    }
    const target = this.resolveTarget(intent);
    if (!target?.messageId) {
      return {
        outcome: "discarded",
        channel: this.channel,
        deliveredAt: this.now(),
      };
    }
    const card = buildFeishuCardForIntent({
      intent,
      text: intent.text,
    });
    try {
      await this.api.updateMessage({ card, messageId: target.messageId });
      return {
        outcome: "updated",
        channel: this.channel,
        deliveredAt: this.now(),
        surface: {
          channel: this.channel,
          id: target.messageId,
          state: {
            opaque: {
              messageId: target.messageId,
              receiveId: target.receiveId,
              receiveIdType: target.receiveIdType,
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

  private async handleMessageEvent(payload: FeishuEventEnvelope): Promise<void> {
    const event = payload.event as FeishuReceiveMessageEvent | undefined;
    const message = event?.message;
    const senderId = event?.sender?.sender_id?.open_id;
    const chatId = message?.chat_id;
    const messageId = message?.message_id;
    const tenantKey = payload.header?.tenant_key ?? event?.sender?.tenant_key;
    const ids = this.validateInboundIds({ chatId, messageId, openId: senderId, tenantKey });
    if (!ids || !message) return;

    const conversationKind: MessagingConversationKind =
      message.chat_type === "p2p" ? "dm" : "channel";
    const channelRef: MessagingChannelRef = {
      channel: this.channel,
      conversation: {
        id: conversationKind === "dm" ? ids.openId : ids.chatId,
        kind: conversationKind,
        ...(conversationKind !== "dm" ? { parentId: ids.tenantKey } : {}),
      },
    };
    const actor: MessagingActorIdentity = {
      platformUserId: ids.openId,
    };
    const routingState: MessagingAdapterState = {
      opaque: {
        chatId: ids.chatId,
        conversationId: channelRef.conversation.id,
        conversationKind,
        messageId: ids.messageId,
        openId: ids.openId,
        ...(ids.tenantKey ? { tenantKey: ids.tenantKey } : {}),
      } satisfies FeishuRoutingOpaqueState,
    };

    const content = parseFeishuMessageContent(message.content);
    const text = extractFeishuText(content);
    const messageText = stripBotMentions(text, message.mentions);
    const attachments = feishuAttachmentsFromMessage({
      content,
      message,
      messageId: ids.messageId,
    });
    const eventBase = {
      id: payload.header?.event_id ?? ids.messageId,
      actor,
      channel: channelRef,
      receivedAt: this.now(),
      routingState,
    };
    const command = parseFeishuCommandText(messageText);
    const pairingToken = extractMessagingPairingToken(messageText);
    const inboundKind: MessagingInboundEvent["kind"] =
      command || pairingToken ? "command" : attachments.length > 0 ? "media" : "text";
    this.logger.info?.("feishu inbound message received", {
      attachmentCount: attachments.length,
      chatType: message.chat_type,
      hasPairingToken: Boolean(pairingToken),
      inboundKind,
      messageType: message.message_type,
    });

    if (!(await this.authorizeInbound({
      actor,
      channel: channelRef,
      kind: inboundKind,
      pairing: Boolean(pairingToken),
      routingState,
    }))) {
      return;
    }

    const inbound: MessagingInboundEvent = command
      ? {
          ...eventBase,
          kind: "command",
          command: command.command,
          args: command.args,
          rawText: messageText,
        }
      : pairingToken
        ? {
            ...eventBase,
            kind: "command",
            command: "pair",
            args: [pairingToken],
            rawText: messageText,
          }
        : attachments.length > 0
          ? {
              ...eventBase,
              kind: "media",
              attachments,
              disposition: attachments.some((attachment) => attachment.disposition === "available")
                ? "available"
                : "unsupported",
              ...(messageText ? { text: messageText } : {}),
            }
        : {
            ...eventBase,
            kind: "text",
            text: messageText,
          };
    await this.listener?.(inbound);
  }

  private async handleBotP2pChatEnteredEvent(payload: FeishuEventEnvelope): Promise<void> {
    const event = objectRecord(payload.event);
    const operatorId = objectRecord(
      event.operator_id ?? event.user_id ?? event.sender_id,
    );
    const openId =
      stringField(operatorId.open_id)
      ?? stringField(event.open_id)
      ?? stringField(event.operator_open_id);
    const chatId =
      stringField(event.chat_id)
      ?? stringField(event.open_chat_id);
    const tenantKey =
      payload.header?.tenant_key
      ?? stringField(event.tenant_key)
      ?? stringField(operatorId.tenant_key);

    const openIdValidation = validateFeishuOpenId(openId);
    const actor = openIdValidation.ok
      ? { platformUserId: openId as string }
      : undefined;
    const channel = openIdValidation.ok
      ? {
          channel: this.channel,
          conversation: {
            id: openId as string,
            kind: "dm" as const,
            ...(tenantKey ? { parentId: tenantKey } : {}),
          },
        }
      : undefined;

    await this.emitDiagnostic({
      id: payload.header?.event_id ?? `feishu:p2p-entered:${this.now()}`,
      platform: this.channel,
      summary: openIdValidation.ok
        ? "Feishu / Lark DM opened; waiting for message receive event."
        : "Feishu / Lark DM opened, but the event did not include a valid open_id.",
      observedAt: this.now(),
      ...(actor ? { actor } : {}),
      ...(channel ? { channel } : {}),
      payload: {
        eventType: payload.header?.event_type ?? "im.chat.access_event.bot_p2p_chat_entered_v1",
        hasChatId: Boolean(chatId),
        hasOpenId: Boolean(openId),
        hasTenantKey: Boolean(tenantKey),
      },
    });
  }

  private async handleCardActionEvent(
    payload: FeishuEventEnvelope,
  ): Promise<FeishuCardActionResponse> {
    const event = payload.event as FeishuCardActionEvent | undefined;
    const openId = event?.operator?.open_id;
    const tenantKey = payload.header?.tenant_key ?? event?.tenant_key;
    const messageId = event?.context?.open_message_id;
    const handle = event?.action?.value?.handle;
    const cardActionLogContext = {
      actionTag: event?.action?.tag,
      actorId: openId,
      chatId: event?.context?.open_chat_id,
      eventId: payload.header?.event_id,
      eventType: payload.header?.event_type ?? "card.action.trigger",
      hasHandle: typeof handle === "string",
      messageId,
      tenantKey,
    };
    this.logger.info?.("feishu card callback received", cardActionLogContext);
    if (typeof handle !== "string") {
      return this.cardActionUnavailable("missing-handle", cardActionLogContext);
    }
    const openIdValidation = validateFeishuOpenId(openId);
    if (!openIdValidation.ok) {
      logFeishuInvalidIdentifier({
        field: "open_id",
        logger: this.logger,
        reason: openIdValidation.reason,
        value: openId,
      });
      return this.cardActionUnavailable("invalid-open-id", cardActionLogContext);
    }
    if (messageId !== undefined) {
      const messageValidation = validateFeishuMessageId(messageId);
      if (!messageValidation.ok) {
        logFeishuInvalidIdentifier({
          field: "message_id",
          logger: this.logger,
          reason: messageValidation.reason,
          value: messageId,
        });
        return this.cardActionUnavailable("invalid-message-id", cardActionLogContext);
      }
    }
    const signed = this.parseSignedCallbackValue(handle);
    if (!signed) {
      return this.cardActionUnavailable("invalid-signed-handle", cardActionLogContext);
    }
    const handleValidation = validateFeishuCallbackHandle(signed.handle);
    if (!handleValidation.ok) {
      logFeishuInvalidIdentifier({
        field: "callback.value",
        logger: this.logger,
        reason: handleValidation.reason,
        value: signed.handle,
      });
      return this.cardActionUnavailable("invalid-callback-handle", cardActionLogContext);
    }

    const actorId = openId as string;
    const actor = { platformUserId: actorId };
    const channelRef =
      signed.channel
      ?? this.cardActionChannelRef({
        actorId,
        chatId: event?.context?.open_chat_id,
        tenantKey,
      });
    if (!channelRef) {
      return this.cardActionUnavailable("missing-channel", cardActionLogContext);
    }
    const record = await this.callbackHandleStore.resolveCallbackHandle({
      actorId,
      channel: channelRef,
      handle: signed.handle,
      now: this.now(),
    });
    if (!record) {
      this.logger.warn?.("feishu callback handle rejected", {
        handleHash: createHash("sha256").update(signed.handle).digest("hex").slice(0, 8),
        ...cardActionLogContext,
      });
      return this.cardActionUnavailable("handle-not-found", cardActionLogContext);
    }

    this.logger.info?.("feishu card callback accepted", {
      ...cardActionLogContext,
      actionId: record.actionId,
      bindingId: record.bindingId,
      conversationId: record.channel.conversation.id,
      conversationKind: record.channel.conversation.kind,
    });
    this.dispatchInboundCallback({
      id: payload.header?.event_id ?? `${signed.handle}:${this.now()}`,
      kind: "callback",
      actor,
      channel: record.channel,
      interaction: {
        channel: this.channel,
        id: signed.handle,
        ...(record.surface?.state ? { state: record.surface.state } : {}),
      },
      actionId: record.actionId,
      ...(record.value !== undefined ? { value: record.value } : {}),
      receivedAt: this.now(),
      ...(record.surface?.state ? { routingState: record.surface.state } : {}),
    });
    return FEISHU_CARD_ACTION_ACK;
  }

  private dispatchInboundCallback(event: MessagingInboundCallbackEvent): void {
    const listener = this.listener;
    if (!listener) {
      this.logger.warn?.("feishu callback dispatch skipped", {
        actionId: event.actionId,
        eventId: event.id,
        reason: "adapter-listener-missing",
      });
      return;
    }
    void Promise.resolve()
      .then(() => listener(event))
      .catch((error) => {
        this.logger.warn?.("feishu callback dispatch failed", {
          actionId: event.actionId,
          eventId: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async authorizeInbound(params: {
    actor: MessagingActorIdentity;
    channel: MessagingChannelRef;
    kind: MessagingInboundEvent["kind"];
    pairing?: boolean;
    routingState?: MessagingAdapterState;
  }): Promise<boolean> {
    if (params.pairing) return true;

    if (!this.authorizedActorIdsValue.includes(params.actor.platformUserId)) {
      await this.emitInboundRejected({
        id: `${params.actor.platformUserId}:${this.now()}`,
        kind: params.kind,
        actor: params.actor,
        channel: params.channel,
        receivedAt: this.now(),
        reason: "unauthorized-actor",
        ...(params.routingState ? { routingState: params.routingState } : {}),
      });
      return false;
    }
    if (params.channel.conversation.kind !== "dm") {
      const chatAllowed = contactIds(this.config.authorizedChatIds).includes(
        params.channel.conversation.id,
      );
      const tenantAllowed =
        params.channel.conversation.parentId !== undefined
        && contactIds(this.config.authorizedTenantKeys).includes(
          params.channel.conversation.parentId,
        );
      if (!chatAllowed && !tenantAllowed) {
        await this.emitInboundRejected({
          id: `${params.channel.conversation.id}:${this.now()}`,
          kind: params.kind,
          actor: params.actor,
          channel: params.channel,
          receivedAt: this.now(),
          reason: "unauthorized-conversation",
          ...(params.routingState ? { routingState: params.routingState } : {}),
        });
        return false;
      }
    }
    return true;
  }

  private async emitInboundRejected(event: MessagingRejectedInboundEvent): Promise<void> {
    for (const listener of this.inboundRejectedListeners) {
      await listener(event);
    }
  }

  private async emitDiagnostic(event: MessagingAdapterDiagnosticEvent): Promise<void> {
    this.logger.info?.("feishu adapter diagnostic", {
      eventId: event.id,
      summary: event.summary,
    });
    for (const listener of this.diagnosticListeners) {
      await listener(event);
    }
  }

  private cardActionUnavailable(
    reason: string,
    context: Record<string, unknown>,
  ): FeishuCardActionResponse {
    this.logger.warn?.("feishu card callback unavailable", {
      ...context,
      reason,
    });
    return FEISHU_CARD_ACTION_UNAVAILABLE;
  }

  private logReceivedEvent(transport: "persistent" | "webhook", data: unknown): void {
    this.logger.info?.("feishu event received", {
      ...feishuEventMetadata(data),
      transport,
    });
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
      const signedChannel = signedCallbackChannelFor(params.channelRef);
      const sig = this.signCallbackValue(handle, params.intent.id, issuedAt, signedChannel);
      const surface = {
        channel: this.channel,
        id: params.intent.id,
        state: {
          opaque: {
            intentId: params.intent.id,
          },
        },
      };
      void this.callbackHandleStore
        .upsertCallbackHandle({
          id: feishuCallbackRecordId(handle, params),
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
          surface,
          ...(action.value !== undefined ? { value: action.value } : {}),
        })
        .catch((error) => {
          this.logger.warn?.("feishu callback handle persist failed", {
            error: error instanceof Error ? error.message : String(error),
            handle,
          });
        });
      return JSON.stringify({
        v: FEISHU_SIGNED_VALUE_VERSION,
        h: handle,
        i: params.intent.id,
        c: signedChannel,
        t: issuedAt,
        s: sig,
      });
    };
  }

  private parseSignedCallbackValue(
    value: string,
  ): {
    channel?: MessagingChannelRef;
    handle: string;
    intentId: string;
    issuedAt: number;
  } | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
    const record = parsed as {
      h?: unknown;
      c?: unknown;
      i?: unknown;
      s?: unknown;
      t?: unknown;
      v?: unknown;
    };
    if (
      record.v !== FEISHU_SIGNED_VALUE_VERSION
      || typeof record.h !== "string"
      || typeof record.i !== "string"
      || typeof record.s !== "string"
      || typeof record.t !== "number"
    ) {
      return undefined;
    }
    const signedChannel = parseSignedCallbackChannel(record.c);
    if (record.c !== undefined && !signedChannel) return undefined;
    const expected = this.signCallbackValue(record.h, record.i, record.t, signedChannel);
    if (!safeEqual(expected, record.s)) {
      this.logger.warn?.("feishu callback signature rejected", {
        handleHash: createHash("sha256").update(record.h).digest("hex").slice(0, 8),
      });
      return undefined;
    }
    return {
      handle: record.h,
      intentId: record.i,
      issuedAt: record.t,
      ...(signedChannel ? { channel: channelRefFromSignedCallbackChannel(signedChannel) } : {}),
    };
  }

  private signCallbackValue(
    handle: string,
    intentId: string,
    issuedAt: number,
    channel?: FeishuSignedCallbackChannel,
  ): string {
    return createHmac("sha256", this.signingSecret)
      .update(JSON.stringify(channel
        ? [handle, intentId, issuedAt, channel]
        : [handle, intentId, issuedAt]))
      .digest("base64url")
      .slice(0, 32);
  }

  private cardActionChannelRef(params: {
    actorId: string;
    chatId?: unknown;
    tenantKey?: unknown;
  }): MessagingChannelRef | undefined {
    if (params.chatId !== undefined) {
      const chatValidation = validateFeishuChatId(params.chatId);
      if (!chatValidation.ok) {
        logFeishuInvalidIdentifier({
          field: "chat_id",
          logger: this.logger,
          reason: chatValidation.reason,
          value: params.chatId,
        });
        return undefined;
      }
      if (params.tenantKey !== undefined) {
        const tenantValidation = validateFeishuTenantKey(params.tenantKey);
        if (!tenantValidation.ok) {
          logFeishuInvalidIdentifier({
            field: "tenant_key",
            logger: this.logger,
            reason: tenantValidation.reason,
            value: params.tenantKey,
          });
          return undefined;
        }
      }
      return {
        channel: this.channel,
        conversation: {
          id: params.chatId as string,
          kind: "channel",
          ...(params.tenantKey ? { parentId: params.tenantKey as string } : {}),
        },
      };
    }

    return {
      channel: this.channel,
      conversation: {
        id: params.actorId,
        kind: "dm",
      },
    };
  }

  private validateInboundIds(params: {
    chatId: unknown;
    messageId: unknown;
    openId: unknown;
    tenantKey?: unknown;
  }): { chatId: string; messageId: string; openId: string; tenantKey?: string } | undefined {
    const openValidation = validateFeishuOpenId(params.openId);
    if (!openValidation.ok) {
      logFeishuInvalidIdentifier({
        field: "open_id",
        logger: this.logger,
        reason: openValidation.reason,
        value: params.openId,
      });
      return undefined;
    }
    const chatValidation = validateFeishuChatId(params.chatId);
    if (!chatValidation.ok) {
      logFeishuInvalidIdentifier({
        field: "chat_id",
        logger: this.logger,
        reason: chatValidation.reason,
        value: params.chatId,
      });
      return undefined;
    }
    const messageValidation = validateFeishuMessageId(params.messageId);
    if (!messageValidation.ok) {
      logFeishuInvalidIdentifier({
        field: "message_id",
        logger: this.logger,
        reason: messageValidation.reason,
        value: params.messageId,
      });
      return undefined;
    }
    if (params.tenantKey !== undefined) {
      const tenantValidation = validateFeishuTenantKey(params.tenantKey);
      if (!tenantValidation.ok) {
        logFeishuInvalidIdentifier({
          field: "tenant_key",
          logger: this.logger,
          reason: tenantValidation.reason,
          value: params.tenantKey,
        });
        return undefined;
      }
      return {
        chatId: params.chatId as string,
        messageId: params.messageId as string,
        openId: params.openId as string,
        tenantKey: params.tenantKey as string,
      };
    }
    return {
      chatId: params.chatId as string,
      messageId: params.messageId as string,
      openId: params.openId as string,
    };
  }

  private resolveTarget(intent: MessagingSurfaceIntent): {
    channelRef: MessagingChannelRef;
    messageId?: string;
    receiveId: string;
    receiveIdType: "chat_id" | "open_id";
    tenantKey?: string;
  } | undefined {
    const state = intent.targetSurface?.state ?? intent.audit?.channel
      ? intent.targetSurface?.state
      : undefined;
    const opaque = state?.opaque;
    const surface =
      opaque && typeof opaque === "object" && !Array.isArray(opaque)
        ? (opaque as Record<string, unknown>)
        : {};
    const auditConversation = intent.audit?.channel.conversation;
    const receiveId =
      typeof surface.receiveId === "string"
        ? surface.receiveId
        : typeof surface.chatId === "string"
          ? surface.chatId
          : auditConversation?.id;
    if (!receiveId) return undefined;
    const receiveIdType =
      typeof surface.receiveIdType === "string" && surface.receiveIdType === "open_id"
        ? "open_id"
        : auditConversation?.kind === "dm"
          ? "open_id"
          : "chat_id";
    const channelRef: MessagingChannelRef = intent.audit?.channel ?? {
      channel: this.channel,
      conversation: {
        id: receiveId,
        kind: receiveIdType === "open_id" ? "dm" : "channel",
      },
    };
    return {
      channelRef,
      receiveId,
      receiveIdType,
      ...(typeof surface.messageId === "string"
        ? { messageId: surface.messageId }
        : typeof intent.targetSurface?.id === "string"
          ? { messageId: intent.targetSurface.id }
          : {}),
      ...(typeof surface.tenantKey === "string" ? { tenantKey: surface.tenantKey } : {}),
    };
  }

  private rateLimitScopeForTarget(target: {
    channelRef: MessagingChannelRef;
    receiveId: string;
    receiveIdType: "chat_id" | "open_id";
  }): MessagingDeliveryScope {
    return {
      platform: this.channel,
      id: `feishu:${target.receiveIdType}:${target.receiveId}`,
      kind: target.receiveIdType === "open_id" ? "dm" : "channel",
      label: target.channelRef.conversation.title,
    };
  }

  private emitRateLimitFromError(
    error: unknown,
    target: {
      channelRef: MessagingChannelRef;
      receiveId: string;
      receiveIdType: "chat_id" | "open_id";
    },
    options?: { retryable?: boolean },
  ): MessagingRateLimitInfo | undefined {
    const retryAfterMs = retryAfterMsFromError(error);
    if (retryAfterMs === undefined) return undefined;
    const info: MessagingRateLimitInfo = {
      scope: this.rateLimitScopeForTarget(target),
      retryAfterMs,
      message: error instanceof Error ? error.message : String(error),
      observedAt: this.now(),
      retryable: options?.retryable ?? false,
    };
    for (const listener of this.rateLimitListeners) {
      listener(info);
    }
    return info;
  }

  private async listenForCallbacks(): Promise<void> {
    if (!this.config.callbackBaseUrl) return;
    const url = new URL(this.config.callbackBaseUrl);
    const port = url.port ? Number(url.port) : DEFAULT_CALLBACK_PORT;
    const host = url.hostname || DEFAULT_CALLBACK_HOST;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.webhookListening = true;
  }

  private async startPersistentConnection(): Promise<void> {
    const lark = await import("@larksuiteoapi/node-sdk");
    const sdkEventDispatcher = new lark.EventDispatcher({
      ...(this.config.encryptKey ? { encryptKey: this.config.encryptKey } : {}),
      logger: larkLoggerFromProviderLogger(this.logger),
      loggerLevel: lark.LoggerLevel.info,
      ...(this.config.verificationToken
        ? { verificationToken: this.config.verificationToken }
        : {}),
    }).register({
      "card.action.trigger": async (data: unknown) => {
        return await this.handleCardActionEvent(
          feishuCardActionEnvelopeFromPersistentEvent(data),
        );
      },
      "im.chat.access_event.bot_p2p_chat_entered_v1": async (data: unknown) => {
        await this.handleBotP2pChatEnteredEvent(
          feishuEnvelopeFromPersistentEvent(
            data,
            "im.chat.access_event.bot_p2p_chat_entered_v1",
          ),
        );
      },
      "im.message.receive_v1": async (data: unknown) => {
        await this.handleMessageEvent(feishuMessageEnvelopeFromPersistentEvent(data));
      },
    });
    const eventDispatcher: FeishuEventDispatcher = {
      invoke: async (data, params) => {
        this.logReceivedEvent("persistent", data);
        return await sdkEventDispatcher.invoke(data, params);
      },
    };
    const wsClient = await this.wsClientFactory({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.config.tenantRegion === "lark" ? "lark" : "feishu",
    });
    this.wsClient = wsClient;
    await wsClient.start({ eventDispatcher });
  }

  private async handleWebhookRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    try {
      const body = await readRequestBody(request, FEISHU_WEBHOOK_BODY_LIMIT_BYTES);
      const payload = parseFeishuWebhookPayload(body, this.config.encryptKey);
      const result = await this.handleWebhookPayload(payload);
      if (
        result
        && typeof result === "object"
        && "status" in result
        && typeof result.status === "number"
      ) {
        const body = "body" in result ? result.body : undefined;
        if (body !== undefined) {
          response.writeHead(result.status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        } else {
          response.writeHead(result.status).end();
        }
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result ?? { code: 0 }));
    } catch (error) {
      this.logger.warn?.("feishu webhook request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      response.writeHead(400).end();
    }
  }

  private isValidWebhookToken(token: unknown): boolean {
    if (!this.config.verificationToken) return true;
    return typeof token === "string" && safeEqual(token, this.config.verificationToken);
  }
}

export function createFeishuAdapter(
  config: FeishuMessagingConfig,
  callbackHandleStore: MessagingCallbackHandleStore,
  logger?: FeishuProviderLogger,
): FeishuAdapter {
  return new FeishuAdapter({ config, callbackHandleStore, logger });
}

export function createFeishuApi(config: FeishuMessagingConfig): FeishuApi {
  return new DirectFeishuApi(config);
}

class DirectFeishuApi implements FeishuApi {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;
  private tenantAccessToken: { expiresAt: number; value: string } | undefined;

  constructor(config: FeishuMessagingConfig) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.baseUrl = normalizeTenantUrl(config.tenantUrl);
  }

  async getBotInfo(): Promise<FeishuBotInfo> {
    const data = await this.request<{ bot?: { app_name?: string; avatar_url?: string; open_id?: string }; tenant_key?: string }>(
      "/open-apis/bot/v3/info",
      { method: "GET" },
    );
    return {
      appName: data.bot?.app_name,
      avatarUrl: data.bot?.avatar_url,
      openId: data.bot?.open_id,
      tenantKey: data.tenant_key,
    };
  }

  async sendMessage(params: FeishuSendMessageParams): Promise<FeishuSendMessageResult> {
    const body = {
      receive_id: params.receiveId,
      msg_type: params.card ? "interactive" : "text",
      content: JSON.stringify(params.card ?? { text: params.text ?? "" }),
    };
    const data = await this.request<{
      chat_id?: string;
      message_id?: string;
    }>(`/open-apis/im/v1/messages?receive_id_type=${params.receiveIdType}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return {
      chatId: data.chat_id,
      messageId: data.message_id,
    };
  }

  async updateMessage(params: { card: FeishuInteractiveCard; messageId: string }): Promise<FeishuSendMessageResult> {
    const data = await this.request<{ message_id?: string }>(
      `/open-apis/im/v1/messages/${encodeURIComponent(params.messageId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          content: JSON.stringify(params.card),
        }),
      },
    );
    return { messageId: data.message_id ?? params.messageId };
  }

  async deleteMessage(params: { messageId: string }): Promise<void> {
    await this.request<unknown>(
      `/open-apis/im/v1/messages/${encodeURIComponent(params.messageId)}`,
      { method: "DELETE" },
    );
  }

  async downloadFile(params: {
    fileKey: string;
    maxBytes: number;
    messageId: string;
    resourceType: FeishuMessageResourceType;
  }): Promise<Uint8Array> {
    const token = await this.getTenantAccessToken();
    const response = await fetch(
      `${this.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(params.messageId)}/resources/${encodeURIComponent(params.fileKey)}?type=${params.resourceType}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    if (!response.ok) {
      throw new Error(`Feishu file download failed: ${response.status}`);
    }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > params.maxBytes) {
      throw new Error("Feishu attachment exceeds download limit");
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of Readable.fromWeb(response.body as never)) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
      total += bytes.byteLength;
      if (total > params.maxBytes) {
        throw new Error("Feishu attachment exceeds download limit");
      }
      chunks.push(bytes);
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return data;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const token = await this.getTenantAccessToken();
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let parsed: { bot?: unknown; code?: number; data?: T; msg?: string } = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // Keep raw text below for error reporting.
    }
    if (!response.ok || (parsed.code !== undefined && parsed.code !== 0)) {
      const error = new Error(parsed.msg || text || `Feishu request failed: ${response.status}`);
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) {
        Object.assign(error, { retryAfter: Number(retryAfter) });
      }
      throw error;
    }
    return (parsed.data ?? (parsed.bot ? { bot: parsed.bot } : {}) as T) as T;
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tenantAccessToken && this.tenantAccessToken.expiresAt > now + 60_000) {
      return this.tenantAccessToken.value;
    }
    const response = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
      }),
    });
    const payload = await response.json() as {
      code?: number;
      expire?: number;
      msg?: string;
      tenant_access_token?: string;
    };
    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(payload.msg || `Feishu tenant token request failed: ${response.status}`);
    }
    this.tenantAccessToken = {
      value: payload.tenant_access_token,
      expiresAt: now + Math.max(1, payload.expire ?? 3600) * 1000,
    };
    return this.tenantAccessToken.value;
  }
}

export function parseFeishuCommandText(
  text: string,
): { command: string; args: string[] } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const first = tokens[0]?.slice(1);
  if (!first) return undefined;
  if (first === "cas_click" && tokens[1]) {
    return { command: "cas_click", args: [tokens[1], ...tokens.slice(2)] };
  }
  return { command: first, args: tokens.slice(1) };
}

function parseFeishuMessageContent(content: string | undefined): Record<string, unknown> {
  if (!content) return {};
  try {
    const parsed = JSON.parse(content) as unknown;
    return objectRecord(parsed);
  } catch {
    return { text: content };
  }
}

function extractFeishuText(content: Record<string, unknown>): string {
  if (typeof content.text === "string") return content.text;
  if (typeof content.title === "string") return content.title;
  return "";
}

function feishuAttachmentsFromMessage(params: {
  content: Record<string, unknown>;
  message: FeishuReceiveMessageEvent["message"];
  messageId: string;
}): MessagingAttachmentDescriptor[] {
  const messageType = params.message?.message_type;
  if (messageType === "image") {
    const imageKey = stringField(params.content.image_key);
    if (!imageKey) return [];
    return [
      {
        id: `feishu:image:${imageKey}`,
        kind: "image",
        name: "lark-image",
        disposition: "available",
        state: {
          opaque: {
            fileKey: imageKey,
            messageId: params.messageId,
            provider: "feishu",
            resourceType: "image",
          },
        },
      },
    ];
  }
  if (messageType === "file") {
    const fileKey = stringField(params.content.file_key);
    if (!fileKey) return [];
    return [
      {
        id: `feishu:file:${fileKey}`,
        kind: "file",
        name: stringField(params.content.file_name) ?? "lark-file",
        disposition: "available",
        state: {
          opaque: {
            fileKey,
            messageId: params.messageId,
            provider: "feishu",
            resourceType: "file",
          },
        },
      },
    ];
  }
  if (messageType === "audio" || messageType === "media" || messageType === "video") {
    const fileKey = stringField(params.content.file_key);
    return [
      {
        id: `feishu:${messageType}:${fileKey ?? params.messageId}`,
        kind: messageType === "audio" ? "audio" : "video",
        name: stringField(params.content.file_name) ?? `lark-${messageType}`,
        disposition: "unsupported",
        reason: `${messageType} attachments are not supported`,
        state: {
          opaque: {
            ...(fileKey ? { fileKey } : {}),
            messageId: params.messageId,
            provider: "feishu",
            resourceType: "file",
          },
        },
      },
    ];
  }
  return [];
}

function readAttachmentResourceType(
  attachment: MessagingAttachmentDescriptor,
): FeishuMessageResourceType {
  const opaque = attachment.state?.opaque;
  if (opaque && typeof opaque === "object" && !Array.isArray(opaque)) {
    const resourceType = (opaque as Record<string, unknown>).resourceType;
    if (resourceType === "image" || resourceType === "file") {
      return resourceType;
    }
  }
  return attachment.kind === "image" ? "image" : "file";
}

function shouldSendFeishuCard(
  intent: MessagingSurfaceIntent,
  text: string,
  actionCount: number,
): boolean {
  if (actionCount > 0 || intent.kind !== "message") return true;
  return intent.parts.some((part) =>
    part.type === "text"
    && part.markdown === "markdown"
    && containsMarkdownTable(part.text || text)
  );
}

function containsMarkdownTable(text: string): boolean {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (
      isMarkdownTableRow(lines[index] ?? "")
      && isMarkdownTableSeparator(lines[index + 1] ?? "")
    ) {
      return true;
    }
  }
  return false;
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.split("|").length >= 4;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = line.trim().split("|").map((cell) => cell.trim()).filter(Boolean);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function stripBotMentions(
  text: string,
  mentions: FeishuReceiveMessageEvent["message"] extends infer M
    ? M extends { mentions?: infer T } ? T | undefined : never
    : never,
): string {
  let stripped = text;
  for (const mention of mentions ?? []) {
    if (mention.key) stripped = stripped.replaceAll(mention.key, "");
  }
  return stripped.trim();
}

function signedCallbackChannelFor(channelRef: MessagingChannelRef): FeishuSignedCallbackChannel {
  return {
    i: channelRef.conversation.id,
    k: channelRef.conversation.kind === "dm" ? "dm" : "channel",
    ...(channelRef.conversation.parentId ? { p: channelRef.conversation.parentId } : {}),
  };
}

function parseSignedCallbackChannel(value: unknown): FeishuSignedCallbackChannel | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { i?: unknown; k?: unknown; p?: unknown };
  if (
    typeof record.i !== "string"
    || (record.k !== "dm" && record.k !== "channel")
    || (record.p !== undefined && typeof record.p !== "string")
  ) {
    return undefined;
  }
  const idValidation =
    record.k === "dm" ? validateFeishuOpenId(record.i) : validateFeishuChatId(record.i);
  if (!idValidation.ok) return undefined;
  if (record.p !== undefined && !validateFeishuTenantKey(record.p).ok) return undefined;
  return {
    i: record.i,
    k: record.k,
    ...(record.p !== undefined ? { p: record.p } : {}),
  };
}

function channelRefFromSignedCallbackChannel(
  channel: FeishuSignedCallbackChannel,
): MessagingChannelRef {
  return {
    channel: "feishu",
    conversation: {
      id: channel.i,
      kind: channel.k,
      ...(channel.p ? { parentId: channel.p } : {}),
    },
  };
}

function feishuMessageEnvelopeFromPersistentEvent(data: unknown): FeishuEventEnvelope {
  const { event, header, record } = feishuEnvelopePartsFromPersistentEvent(data);
  return {
    header: {
      event_id: stringField(header.event_id) ?? stringField(record.event_id),
      event_type: "im.message.receive_v1",
      tenant_key: stringField(header.tenant_key) ?? stringField(record.tenant_key),
      token: stringField(header.token) ?? stringField(record.token),
    },
    event: {
      message: objectRecord(event.message) as FeishuReceiveMessageEvent["message"],
      sender: objectRecord(event.sender) as FeishuReceiveMessageEvent["sender"],
    },
    schema: "2.0",
  };
}

function feishuCardActionEnvelopeFromPersistentEvent(data: unknown): FeishuEventEnvelope {
  const { event, header, record } = feishuEnvelopePartsFromPersistentEvent(data);
  return {
    header: {
      event_id: stringField(header.event_id) ?? stringField(record.event_id),
      event_type: "card.action.trigger",
      tenant_key: stringField(header.tenant_key) ?? stringField(record.tenant_key),
      token: stringField(header.token) ?? stringField(record.token),
    },
    event: {
      action: objectRecord(event.action) as FeishuCardActionEvent["action"],
      context: objectRecord(event.context) as FeishuCardActionEvent["context"],
      operator: objectRecord(event.operator) as FeishuCardActionEvent["operator"],
      tenant_key: stringField(event.tenant_key) ?? stringField(record.tenant_key),
      token: stringField(event.token) ?? stringField(record.token),
    },
    schema: "2.0",
  };
}

function feishuEnvelopeFromPersistentEvent(
  data: unknown,
  eventType: string,
): FeishuEventEnvelope {
  const { event, header, record } = feishuEnvelopePartsFromPersistentEvent(data);
  return {
    header: {
      event_id: stringField(header.event_id) ?? stringField(record.event_id),
      event_type: eventType,
      tenant_key: stringField(header.tenant_key) ?? stringField(record.tenant_key),
      token: stringField(header.token) ?? stringField(record.token),
    },
    event: event as FeishuEventEnvelope["event"],
    schema: "2.0",
  };
}

function feishuEnvelopePartsFromPersistentEvent(data: unknown): {
  event: Record<string, unknown>;
  header: Record<string, unknown>;
  record: Record<string, unknown>;
} {
  const record = objectRecord(data);
  const header = objectRecord(record.header);
  const event = objectRecord(record.event);
  return {
    record,
    header,
    event: Object.keys(event).length > 0 ? event : record,
  };
}

function isFeishuCardActionEnvelope(payload: FeishuEventEnvelope): boolean {
  const event = payload.event as FeishuCardActionEvent | undefined;
  return Boolean(event?.action || event?.operator || event?.context);
}

function feishuEventMetadata(data: unknown): Record<string, unknown> {
  const record = objectRecord(data);
  const header = objectRecord(record.header);
  const event = objectRecord(record.event);
  const body = Object.keys(event).length > 0 ? event : record;
  const message = objectRecord(body.message);
  const sender = objectRecord(body.sender);
  const senderId = objectRecord(sender.sender_id);
  const action = objectRecord(body.action);
  const actionValue = objectRecord(action.value);
  const context = objectRecord(body.context);
  const operator = objectRecord(body.operator);
  const operatorId = objectRecord(body.operator_id);
  const metadata: Record<string, unknown> = {
    eventKeys: Object.keys(event),
    headerKeys: Object.keys(header),
    topLevelKeys: Object.keys(record),
  };
  setMetadataField(
    metadata,
    "eventId",
    stringField(header.event_id) ?? stringField(record.event_id),
  );
  setMetadataField(
    metadata,
    "eventType",
    stringField(header.event_type) ?? stringField(record.event_type)
      ?? stringField(record.type) ?? stringField(objectRecord(record.event).type),
  );
  setMetadataField(
    metadata,
    "tenantKey",
    stringField(header.tenant_key) ?? stringField(body.tenant_key)
      ?? stringField(sender.tenant_key) ?? stringField(operator.tenant_key),
  );
  setMetadataField(
    metadata,
    "actorId",
    stringField(senderId.open_id) ?? stringField(operator.open_id)
      ?? stringField(operatorId.open_id),
  );
  setMetadataField(
    metadata,
    "chatId",
    stringField(message.chat_id) ?? stringField(context.open_chat_id)
      ?? stringField(body.chat_id),
  );
  setMetadataField(metadata, "chatType", stringField(message.chat_type));
  setMetadataField(metadata, "messageId", stringField(message.message_id));
  setMetadataField(metadata, "messageType", stringField(message.message_type));
  setMetadataField(metadata, "actionTag", stringField(action.tag));
  if (Object.keys(actionValue).length > 0) {
    metadata.actionValueKeys = Object.keys(actionValue);
  }
  metadata.hasCallbackHandle = typeof actionValue.handle === "string";
  metadata.hasMessageContent = typeof message.content === "string";
  return metadata;
}

function setMetadataField(
  metadata: Record<string, unknown>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) metadata[key] = value;
}

function parseFeishuWebhookPayload(
  body: Buffer,
  encryptKey: string | undefined,
): FeishuEventEnvelope {
  const parsed = JSON.parse(body.toString("utf8")) as unknown;
  const envelope = objectRecord(parsed);
  const encryptedPayload = stringField(envelope.encrypt);
  if (!encryptedPayload) {
    return parsed as FeishuEventEnvelope;
  }
  if (!encryptKey) {
    throw new Error("Feishu encrypted webhook payload requires an encryption key.");
  }

  const decrypted = JSON.parse(
    decryptFeishuEncryptedPayload(encryptedPayload, encryptKey),
  ) as unknown;
  const decryptedEnvelope = objectRecord(decrypted);
  const passthrough = { ...envelope };
  delete passthrough.encrypt;
  return {
    ...decryptedEnvelope,
    ...passthrough,
  } as FeishuEventEnvelope;
}

function decryptFeishuEncryptedPayload(
  encryptedPayload: string,
  encryptKey: string,
): string {
  const keyHash = createHash("sha256");
  keyHash.update(encryptKey);
  const key = keyHash.digest();
  const encryptedBuffer = Buffer.from(encryptedPayload, "base64");
  const decipher = createDecipheriv("aes-256-cbc", key, encryptedBuffer.subarray(0, 16));
  let decrypted = decipher.update(
    encryptedBuffer.subarray(16).toString("hex"),
    "hex",
    "utf8",
  );
  decrypted += decipher.final("utf8");
  return decrypted;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function larkLoggerFromProviderLogger(logger: FeishuProviderLogger): LarkSdkLogger {
  return {
    debug: (...msg: unknown[]) => {
      logger.debug?.("feishu sdk", { message: msg.map(String).join(" ") });
    },
    error: (...msg: unknown[]) => {
      logger.error?.("feishu sdk", { message: msg.map(String).join(" ") });
    },
    info: (...msg: unknown[]) => {
      logger.info?.("feishu sdk", { message: msg.map(String).join(" ") });
    },
    trace: (...msg: unknown[]) => {
      logger.debug?.("feishu sdk trace", { message: msg.map(String).join(" ") });
    },
    warn: (...msg: unknown[]) => {
      logger.warn?.("feishu sdk", { message: msg.map(String).join(" ") });
    },
  };
}

function callbackAllowedActorIds(
  intent: MessagingSurfaceIntent,
  fallbackActorId: string,
): string[] {
  return intent.allowedActorIds && intent.allowedActorIds.length > 0
    ? intent.allowedActorIds
    : intent.audit?.actor.platformUserId
      ? [intent.audit.actor.platformUserId]
      : fallbackActorId
        ? [fallbackActorId]
        : [];
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

function feishuCallbackRecordId(
  handle: string,
  params: { channelRef: MessagingChannelRef; intent: MessagingSurfaceIntent },
): string {
  return createHash("sha256")
    .update(JSON.stringify([handle, params.channelRef, params.intent.id]))
    .digest("hex");
}

function contactIds(contacts: readonly { id: string }[] | undefined): string[] {
  return contacts?.map((contact) => contact.id) ?? [];
}

function feishuContactsFromIds(
  ids: readonly string[],
  previous: readonly { id: string; displayName: string }[] | undefined,
): Array<{ id: string; displayName: string }> {
  return ids.map((id) => ({
    id,
    displayName: previous?.find((contact) => contact.id === id)?.displayName ?? "",
  }));
}

function normalizeTenantUrl(url: string): string {
  const parsed = new URL(url);
  const canonical = parsed.toString();
  return canonical.endsWith("/") ? canonical.slice(0, -1) : canonical;
}

function hostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function retryAfterMsFromError(error: unknown): number | undefined {
  const retryAfter = (error as { retryAfter?: unknown })?.retryAfter;
  return typeof retryAfter === "number" && Number.isFinite(retryAfter)
    ? retryAfter * 1000
    : undefined;
}

function readRequestBody(
  request: IncomingMessage,
  limitBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > limitBytes) {
        reject(new Error("Feishu webhook body exceeds limit"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
