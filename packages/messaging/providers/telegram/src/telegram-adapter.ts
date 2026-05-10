import { createHash } from "node:crypto";
import { Bot, InputFile } from "grammy";
import type {
  MessagingAdapterState,
  MessagingCapabilityProfile,
  MessagingAttachmentDescriptor,
  MessagingAttachmentDownloadRequest,
  MessagingAttachmentDownloadResult,
  MessagingCallbackHandleStore,
  MessagingConversationTitleUpdateRequest,
  MessagingConversationTitleUpdateResult,
  MessagingDeliveryResult,
  MessagingDeliveryScope,
  MessagingFilePart,
  MessagingClientRateLimitStrategy,
  MessagingInboundEvent,
  MessagingInboundRejectedListener,
  MessagingRateLimitInfo,
  MessagingRejectedInboundEvent,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import {
  extractMessagingPairingToken,
  layoutMessagingActionRows,
  MESSAGING_CALLBACK_HANDLE_TTL_MS,
} from "@pwragent/messaging-interface";
import type { TelegramMessagingConfig } from "./telegram-config.ts";
import {
  actionsForTelegramIntent,
  renderTelegramHtml,
  splitTelegramHtml,
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  TELEGRAM_MESSAGE_TEXT_LIMIT,
  type TelegramInlineKeyboardMarkup,
  textForTelegramIntent,
} from "./telegram-formatting.ts";
import {
  logTelegramInvalidIdentifier,
  validateTelegramCallbackData,
  validateTelegramCallbackQueryId,
  validateTelegramChatId,
  validateTelegramFileId,
  validateTelegramPositiveId,
  type TelegramIdentifierField,
} from "./validate-ids.ts";

const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query"];
const TELEGRAM_DEFAULT_TYPING_SIGNAL_LEASE_MS = 15_000;
const TELEGRAM_TYPING_SIGNAL_INTERVAL_MS = 4_000;
const TELEGRAM_STREAM_DM_MIN_INTERVAL_MS = 1_000;
const TELEGRAM_STREAM_GROUP_WINDOW_MS = 60_000;
const TELEGRAM_STREAM_GROUP_MAX_PER_WINDOW = 20;
const TELEGRAM_STREAM_GROUP_FAST_COUNT = 3;
const TELEGRAM_STREAM_GROUP_MEDIUM_COUNT = 6;
const TELEGRAM_STREAM_GROUP_FAST_INTERVAL_MS = 1_000;
const TELEGRAM_STREAM_GROUP_MEDIUM_INTERVAL_MS = 2_000;
const TELEGRAM_STREAM_GROUP_SLOW_INTERVAL_MS = 3_100;
const TELEGRAM_STREAM_RETRY_AFTER_BUFFER_MS = 100;

type TelegramDeliveryTarget = {
  chatId: number | string;
  messageId?: number;
  messageThreadId?: number;
};

type TelegramStreamRateLimitState = {
  blockedUntil?: number;
  timestamps: number[];
};

type TelegramStreamRateLimitDecision = {
  allowed: boolean;
  hard: boolean;
  policy: "dm" | "group";
  waitMs: number;
};

type FetchLike = (url: string) => Promise<{
  arrayBuffer(): Promise<ArrayBuffer>;
  ok: boolean;
  status: number;
  statusText: string;
}>;

type TelegramTypingSignal = {
  interval: ReturnType<typeof setInterval>;
  signalId: number;
  timeout: ReturnType<typeof setTimeout>;
};

export type TelegramProviderLogger = {
  debug(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
};

export type TelegramUser = {
  first_name?: string;
  id: number;
  is_bot?: boolean;
  last_name?: string;
  phone_number?: string;
  username?: string;
};

export type TelegramChat = {
  id: number;
  title?: string;
  type: "private" | "group" | "supergroup" | "channel";
};

export type TelegramMessage = {
  animation?: {
    file_id: string;
    file_name?: string;
    file_size?: number;
    height?: number;
    mime_type?: string;
    width?: number;
  };
  caption?: string;
  chat: TelegramChat;
  date?: number;
  document?: {
    file_id: string;
    file_name?: string;
    file_size?: number;
    height?: number;
    mime_type?: string;
    width?: number;
  };
  forum_topic_closed?: Record<string, never>;
  forum_topic_created?: {
    icon_color?: number;
    icon_custom_emoji_id?: string;
    name: string;
  };
  forum_topic_edited?: {
    icon_custom_emoji_id?: string;
    name?: string;
  };
  forum_topic_reopened?: Record<string, never>;
  from?: TelegramUser;
  general_forum_topic_hidden?: Record<string, never>;
  general_forum_topic_unhidden?: Record<string, never>;
  message_id: number;
  message_thread_id?: number;
  photo?: Array<{
    file_id: string;
    file_size?: number;
    height?: number;
    width?: number;
  }>;
  pinned_message?: TelegramMessage;
  text?: string;
  video?: {
    file_id: string;
    mime_type?: string;
  };
  voice?: {
    file_id: string;
    mime_type?: string;
  };
};

export type TelegramCallbackQuery = {
  data?: string;
  from: TelegramUser;
  id: string;
  message?: TelegramMessage;
};

export type TelegramUpdate = {
  callback_query?: TelegramCallbackQuery;
  message?: TelegramMessage;
  update_id: number;
};

export type TelegramSendMessageRequest = {
  chat_id: number | string;
  disable_web_page_preview?: boolean;
  message_thread_id?: number;
  parse_mode?: "HTML";
  reply_markup?: TelegramInlineKeyboardMarkup;
  text: string;
};

export type TelegramEditMessageTextRequest = TelegramSendMessageRequest & {
  message_id: number;
};

export type TelegramEditForumTopicRequest = {
  chat_id: number | string;
  message_thread_id: number;
  name: string;
};

export type TelegramSendPhotoRequest = {
  caption?: string;
  chat_id: number | string;
  message_thread_id?: number;
  parse_mode?: "HTML";
  filename?: string;
  photo: string | Uint8Array;
  reply_markup?: TelegramInlineKeyboardMarkup;
};

export type TelegramSendDocumentRequest = {
  caption?: string;
  chat_id: number | string;
  document: string | Uint8Array;
  filename?: string;
  message_thread_id?: number;
  parse_mode?: "HTML";
  reply_markup?: TelegramInlineKeyboardMarkup;
};

export type TelegramSendChatActionRequest = {
  action: "typing";
  chat_id: number | string;
  message_thread_id?: number;
};

export type TelegramSentMessage = {
  chat: TelegramChat;
  message_id: number;
};

export type TelegramPinChatMessageRequest = {
  chat_id: number | string;
  disable_notification?: boolean;
  message_id: number;
};

export type TelegramUnpinChatMessageRequest = {
  chat_id: number | string;
  message_id?: number;
};

export type TelegramBotApi = {
  answerCallbackQuery(params: {
    callback_query_id: string;
    text?: string;
  }): Promise<boolean>;
  deleteWebhook(params?: { drop_pending_updates?: boolean }): Promise<boolean>;
  editForumTopic(request: TelegramEditForumTopicRequest): Promise<boolean>;
  editMessageText(request: TelegramEditMessageTextRequest): Promise<TelegramSentMessage>;
  getMe(): Promise<{ id: number; is_bot: boolean; username?: string }>;
  getWebhookInfo(): Promise<{ url: string }>;
  getFile(fileId: string): Promise<{ file_path?: string }>;
  pinChatMessage(request: TelegramPinChatMessageRequest): Promise<boolean>;
  sendChatAction(request: TelegramSendChatActionRequest): Promise<boolean>;
  sendDocument(request: TelegramSendDocumentRequest): Promise<TelegramSentMessage>;
  sendMessage(request: TelegramSendMessageRequest): Promise<TelegramSentMessage>;
  sendPhoto(request: TelegramSendPhotoRequest): Promise<TelegramSentMessage>;
  setMyCommands(params: {
    commands: Array<{ command: string; description: string }>;
  }): Promise<boolean>;
  unpinChatMessage(request: TelegramUnpinChatMessageRequest): Promise<boolean>;
};

export type TelegramBotLike = {
  api: TelegramBotApi;
  catch?(handler: (error: unknown) => void): void;
  handleUpdate?(update: TelegramUpdate): Promise<void>;
  on?(filter: string, handler: (context: unknown) => void | Promise<void>): void;
  start?(options?: { allowed_updates?: string[] }): Promise<void>;
  stop?(): void | Promise<void>;
};

export type TelegramGrammyBotLike = {
  api: {
    answerCallbackQuery(
      callbackQueryId: string,
      other?: { text?: string },
    ): Promise<boolean>;
    deleteWebhook(params?: { drop_pending_updates?: boolean }): Promise<boolean>;
    editForumTopic(
      chatId: number | string,
      messageThreadId: number,
      other?: Omit<
        TelegramEditForumTopicRequest,
        "chat_id" | "message_thread_id"
      >,
    ): Promise<boolean>;
    editMessageText(
      chatId: number | string,
      messageId: number,
      text: string,
      other?: Omit<TelegramEditMessageTextRequest, "chat_id" | "message_id" | "text">,
    ): Promise<TelegramSentMessage | boolean>;
    // Telegram's `User` allows `username` to be absent (non-bot users
    // can omit it). Grammy returns `UserFromGetMe` which always has
    // it set for bot accounts, but we keep the type optional here to
    // match `TelegramBotApi.getMe` and avoid a structural narrowing
    // surprise if grammy ever loosens the type.
    getMe(): Promise<{ id: number; is_bot: boolean; username?: string }>;
    getWebhookInfo(): Promise<{ url: string }>;
    getFile(fileId: string): Promise<{ file_path?: string }>;
    pinChatMessage(
      chatId: number | string,
      messageId: number,
      other?: Omit<TelegramPinChatMessageRequest, "chat_id" | "message_id">,
    ): Promise<boolean>;
    sendChatAction(
      chatId: number | string,
      action: TelegramSendChatActionRequest["action"],
      other?: Omit<TelegramSendChatActionRequest, "chat_id" | "action">,
    ): Promise<boolean>;
    sendMessage(
      chatId: number | string,
      text: string,
      other?: Omit<TelegramSendMessageRequest, "chat_id" | "text">,
    ): Promise<TelegramSentMessage>;
    sendDocument(
      chatId: number | string,
      document: InputFile | string,
      other?: Omit<TelegramSendDocumentRequest, "chat_id" | "document" | "filename">,
    ): Promise<TelegramSentMessage>;
    sendPhoto(
      chatId: number | string,
      photo: InputFile | string,
      other?: Omit<TelegramSendPhotoRequest, "chat_id" | "photo" | "filename">,
    ): Promise<TelegramSentMessage>;
    setMyCommands(
      commands: Array<{ command: string; description: string }>,
    ): Promise<boolean>;
    unpinChatMessage(
      chatId: number | string,
      messageId?: number,
      other?: Omit<TelegramUnpinChatMessageRequest, "chat_id" | "message_id">,
    ): Promise<boolean>;
  };
  catch?(handler: (error: unknown) => void): void;
  handleUpdate?(update: TelegramUpdate): Promise<void>;
  on?(filter: string, handler: (context: unknown) => void | Promise<void>): void;
  start?(options?: { allowed_updates?: string[] }): Promise<void>;
  stop?(): void | Promise<void>;
};

export type TelegramProviderAdapter = {
  authorizedActorIds: readonly string[];
  capabilityProfile: MessagingCapabilityProfile;
  channel: "telegram";
  clientRateLimitStrategy: MessagingClientRateLimitStrategy;
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  resolveDeliveryScope?(intent: MessagingSurfaceIntent): MessagingDeliveryScope | undefined;
  onRateLimit?(listener: (info: MessagingRateLimitInfo) => void): () => void;
  downloadAttachment?(
    request: MessagingAttachmentDownloadRequest,
  ): Promise<MessagingAttachmentDownloadResult>;
  /**
   * Subscribe to fatal runtime errors that took the adapter offline
   * after a successful start — e.g. the long-poll loop exited because
   * Telegram returned a 409 Conflict (another bot instance is running).
   * Fired at most once per `start()` lifecycle and never on graceful
   * `stop()`. The host is expected to surface this to the user (e.g.
   * flip the platform status pill from green to red).
   */
  onRuntimeError?(listener: (reason: string) => void): () => void;
  onInboundRejected?(listener: MessagingInboundRejectedListener): () => void;
  setConversationTitle(
    request: MessagingConversationTitleUpdateRequest,
  ): Promise<MessagingConversationTitleUpdateResult>;
  start?(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void>;
  stop?(): Promise<void>;
};

export class TelegramAdapter implements TelegramProviderAdapter {
  readonly channel = "telegram" as const;
  readonly clientRateLimitStrategy: MessagingClientRateLimitStrategy = "direct";
  readonly capabilityProfile: MessagingCapabilityProfile = {
    actions: {
      maxActions: 100,
      maxActionsPerRow: 8,
      maxLabelLength: 64,
      supportsStyles: false,
      supportsDisabled: false,
      supportsLayoutHints: true,
      maxCallbackPayloadBytes: 64,
    },
    text: {
      maxLength: 4096,
      encoding: "utf8-bytes",
      markdownDialect: "html",
      supportsCodeBlocks: true,
      supportsBold: true,
      supportsItalic: true,
      supportsLinks: true,
      supportsInlineCode: true,
      maxCaptionLength: 1024,
      supportsMessageEdit: true,
    },
    inboundAttachments: {
      maxAttachmentCount: 10,
      maxDownloadBytes: 20 * 1024 * 1024,
      supportsDownload: true,
    },
    outboundAttachments: {
      maxUploadBytes: 50 * 1024 * 1024,
      supportsFileUpload: false,
      supportsImageUpload: true,
      supportsRemoteImageUrl: true,
    },
  };

  private defaultBot?: TelegramBotLike;
  /**
   * The bot's `@username` as returned by `getMe()`, lower-cased once
   * for case-insensitive prefix matching. Captured during `start()`.
   * Telegram usernames are derived from the bot's profile (not from
   * the bot token), so unlike `configuredBotId` this can't be
   * computed offline. Undefined when the adapter hasn't started yet
   * or `getMe()` failed at startup; in that case `@<bot> <verb>`
   * mention parsing is skipped (slash commands still work).
   */
  private botUsername?: string;
  private listener?: (event: MessagingInboundEvent) => Promise<void>;
  private streamRateLimits = new Map<string, TelegramStreamRateLimitState>();
  private streamSurfaces = new Map<string, TelegramDeliveryTarget>();
  /**
   * Per-process cache of forum topic names, keyed by
   * `${chatId}:${messageThreadId}`. Telegram's Bot API does not expose
   * a "fetch topic name" endpoint — the name only ships on the
   * `forum_topic_created` and `forum_topic_edited` service messages.
   * We capture those messages (which we otherwise ignore as service
   * traffic) so that subsequent regular messages in the same topic
   * can carry the topic name on their `MessagingChannelRef.title`.
   * This is what makes external renames-via-Telegram-client propagate
   * to the desktop chip.
   *
   * Bounded LRU (insertion-order Map + eviction at the cap). Cap is
   * generous — most users have under a few dozen active topics; the
   * cap protects against long-running sessions in extreme cases.
   * Worst case on eviction is one extra "Topic" placeholder until the
   * next `forum_topic_edited` message arrives.
   */
  private static readonly TOPIC_NAME_CACHE_CAP = 500;
  private readonly topicNameCache = new Map<string, string>();
  private readonly unauthorizedConversationLogKeys = new Set<string>();
  private readonly inboundRejectedListeners = new Set<MessagingInboundRejectedListener>();
  private readonly options: {
    api?: TelegramBotApi;
    bot?: TelegramBotLike;
    config: TelegramMessagingConfig;
    fetch?: FetchLike;
    logger?: TelegramProviderLogger;
    now?: () => number;
    pollOnStart?: boolean;
    store?: MessagingCallbackHandleStore;
  };
  private startPromise?: Promise<void>;
  /**
   * `true` once `stop()` has been called; suppresses the runtime-error
   * fan-out for the polling-loop rejection that grammy raises as part
   * of normal shutdown.
   */
  private stopping = false;
  private readonly runtimeErrorListeners = new Set<(reason: string) => void>();
  private readonly rateLimitListeners = new Set<(info: MessagingRateLimitInfo) => void>();
  private typingSignalSequence = 0;
  private typingSignals = new Map<string, TelegramTypingSignal>();

  constructor(options: TelegramAdapter["options"]) {
    this.options = options;
  }

  get authorizedActorIds(): readonly string[] {
    return this.options.config.authorizedActorIds.map((contact) => contact.id);
  }

  onInboundRejected(listener: MessagingInboundRejectedListener): () => void {
    this.inboundRejectedListeners.add(listener);
    return () => {
      this.inboundRejectedListeners.delete(listener);
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

  async start(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void> {
    this.listener = listener;

    this.registerBotErrorHandler();
    this.registerBotHandlers();

    const tokenDiagnostics = telegramBotTokenDiagnostics(this.options.config.botToken);
    this.options.logger?.debug("telegram startup token diagnostics", tokenDiagnostics);

    // Capture the bot's `@username` so the inbound path can recognize
    // `@<botusername> <verb>` text mentions. Telegram usernames live
    // on the bot profile (not the token), so this requires an actual
    // API call. Failure isn't fatal — slash commands still work; we
    // just skip mention parsing.
    try {
      const me = await this.bot.api.getMe();
      if (me.username) {
        this.botUsername = me.username.toLowerCase();
        this.options.logger?.debug(
          `telegram captured bot username for mention parsing: @${this.botUsername}`,
        );
      }
    } catch (error) {
      this.options.logger?.warn?.("telegram getMe failed; @-mention commands disabled", {
        error: errorMessage(error),
      });
    }

    let webhookInfo: { url: string };
    try {
      webhookInfo = await this.bot.api.getWebhookInfo();
    } catch (error) {
      this.options.logger?.warn?.("telegram getWebhookInfo failed", {
        error: errorMessage(error),
        ...telegramHttpErrorDiagnostics(error),
        token: tokenDiagnostics,
      });
      throw error;
    }
    if (webhookInfo.url) {
      await this.bot.api.deleteWebhook({
        drop_pending_updates: false,
      });
    }
    await this.bot.api.setMyCommands({
      commands: [
        {
          command: "resume",
          description: "Resume or start a PwrAgent thread",
        },
        {
          command: "status",
          description: "Show the current PwrAgent binding",
        },
        {
          command: "detach",
          description: "Detach this chat from PwrAgent",
        },
      ],
    });

    if (this.options.pollOnStart !== false) {
      this.startPromise = this.bot.start?.({
        allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
      });
      // Eagerly handle rejection so it doesn't become unhandled if the
      // process exits before stop() can await startPromise. A rejection
      // after startup is a fatal runtime error (most often Telegram's
      // 409 Conflict when a second bot instance starts polling and
      // kicks ours off) — fan it out to runtime-error listeners so the
      // host can flip the platform status indicator. Suppress the
      // fan-out when we're in the middle of `stop()` because grammy
      // resolves/rejects the start promise as part of normal shutdown.
      this.startPromise?.catch((error) => {
        const reason = errorMessage(error);
        this.options.logger?.warn?.("telegram polling loop exited with error", {
          error: reason,
        });
        if (!this.stopping) {
          this.emitRuntimeError(reason);
        }
      });
    }
  }

  onRuntimeError(listener: (reason: string) => void): () => void {
    this.runtimeErrorListeners.add(listener);
    return () => {
      this.runtimeErrorListeners.delete(listener);
    };
  }

  private emitRuntimeError(reason: string): void {
    for (const listener of this.runtimeErrorListeners) {
      try {
        listener(reason);
      } catch (error) {
        this.options.logger?.warn?.("telegram runtime-error listener threw", {
          error: errorMessage(error),
        });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopTypingSignals();
    await this.bot.stop?.();
    await this.startPromise?.catch(() => undefined);
    this.startPromise = undefined;
    this.listener = undefined;
    this.botUsername = undefined;
    this.runtimeErrorListeners.clear();
    this.stopping = false;
  }

  async downloadAttachment(
    request: MessagingAttachmentDownloadRequest,
  ): Promise<MessagingAttachmentDownloadResult> {
    const opaque = request.attachment.state?.opaque;
    if (!opaque || typeof opaque !== "object" || Array.isArray(opaque)) {
      throw new Error("Telegram attachment download state is missing.");
    }
    const fileId = opaque.fileId;
    if (typeof fileId !== "string" || !fileId) {
      throw new Error("Telegram attachment file id is missing.");
    }
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) {
      throw new Error("Telegram did not return a downloadable file path.");
    }
    const response = await this.fetch(
      `https://api.telegram.org/file/bot${this.options.config.botToken}/${file.file_path}`,
    );
    if (!response.ok) {
      throw new Error(
        `Telegram attachment download failed: ${response.status} ${response.statusText}`,
      );
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > request.maxBytes) {
      throw new Error("Telegram attachment exceeds the configured download limit.");
    }
    return {
      data,
      fileName: request.attachment.name,
      mimeType: request.attachment.mimeType,
      sizeBytes: data.byteLength,
    };
  }

  async deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult> {
    try {
      return await this.deliverSurface(intent);
    } catch (error) {
      const target = this.resolveTarget(intent);
      const rateLimit = target
        ? this.emitRateLimitFromError(error, target, { retryable: false })
        : undefined;
      this.options.logger?.warn?.(
        `telegram deliver failed kind=${intent.kind} target=${target ? this.compactTypingTarget(target) : "missing"} error=${errorMessage(error)}`,
      );
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        errorMessage: errorMessage(error),
        outcome: "failed",
        ...(rateLimit ? { rateLimit } : {}),
        surface: intent.targetSurface,
      };
    }
  }

  private async deliverSurface(
    intent: MessagingSurfaceIntent,
  ): Promise<MessagingDeliveryResult> {
    const target = this.resolveTarget(intent);
    if (!target) {
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        errorMessage: "Telegram delivery target is missing.",
        outcome: "failed",
      };
    }

    if (intent.kind === "activity") {
      return await this.deliverActivity(intent, target);
    }

    if (intent.kind === "stream_update") {
      return await this.deliverStreamUpdate(intent, target);
    }

    if (intent.kind === "dismiss") {
      if (intent.delivery?.unpin && target.messageId) {
        await this.bot.api.unpinChatMessage({
          chat_id: target.chatId,
          message_id: target.messageId,
        });
        return {
          channel: this.channel,
          deliveredAt: this.now(),
          outcome: "unpinned",
          surface: intent.targetSurface,
        };
      }
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "unsupported",
        surface: intent.targetSurface,
      };
    }

    const actions = actionsForTelegramIntent(intent);
    const replyMarkup = await this.buildReplyMarkup(intent, actions);
    const files = uploadableFileParts(intent);
    const text = files.length > 0 ? textForTelegramIntentWithoutFiles(intent) : textForTelegramIntent(intent);
    const image = this.firstImagePayload(intent);
    const sentMessages: TelegramSentMessage[] = [];
    let outcome: MessagingDeliveryResult["outcome"] = "presented";
    this.options.logger?.debug(
      `telegram deliver begin kind=${intent.kind} mode=${intent.delivery?.mode ?? "new"} target=${this.compactTypingTarget(target)} chars=${text.length} actions=${actions.length} image=${Boolean(image)} files=${files.length} preview="${compactPreview(text)}"`,
    );

    if (
      intent.delivery?.mode === "update" &&
      target.messageId &&
      !image &&
      files.length === 0 &&
      Buffer.byteLength(text || " ", "utf8") <= 4096
    ) {
      try {
        sentMessages.push(
      await this.bot.api.editMessageText({
        chat_id: target.chatId,
        disable_web_page_preview: true,
        message_id: target.messageId,
        message_thread_id: target.messageThreadId,
        parse_mode: "HTML",
        reply_markup: replyMarkup ?? (intent.delivery.replaceMarkup ? { inline_keyboard: [] } : undefined),
        text: text || " ",
      }),
        );
        outcome = "updated";
      } catch (error) {
        if (intent.delivery.fallback !== "present_new") {
          throw error;
        }
        sentMessages.push(
          await this.bot.api.sendMessage({
            chat_id: target.chatId,
            disable_web_page_preview: true,
            message_thread_id: target.messageThreadId,
            parse_mode: "HTML",
            reply_markup: replyMarkup,
            text: text || " ",
          }),
        );
        outcome = "presented_new";
      }
    } else if (files.length > 0) {
      const caption = text && Buffer.byteLength(text, "utf8") <= 1024 ? text : undefined;
      if (text && !caption) {
        const chunks = splitTelegramHtml(text);
        for (const chunk of chunks) {
          sentMessages.push(
            await this.bot.api.sendMessage({
              chat_id: target.chatId,
              disable_web_page_preview: true,
              message_thread_id: target.messageThreadId,
              parse_mode: "HTML",
              text: chunk,
            }),
          );
        }
      }

      const lastFileIndex = files.length - 1;
      for (const [index, file] of files.entries()) {
        sentMessages.push(
          await this.bot.api.sendDocument({
            caption: index === 0 ? caption : undefined,
            chat_id: target.chatId,
            document: file.url ?? file.data!,
            filename: file.name,
            message_thread_id: target.messageThreadId,
            parse_mode: caption && index === 0 ? "HTML" : undefined,
            reply_markup: index === lastFileIndex ? replyMarkup : undefined,
          }),
        );
      }
    } else if (image) {
      sentMessages.push(
        await this.bot.api.sendPhoto({
          caption: text.slice(0, 1024) || undefined,
          chat_id: target.chatId,
          message_thread_id: target.messageThreadId,
          parse_mode: text ? "HTML" : undefined,
          filename: image.filename,
          photo: image.source,
          reply_markup: replyMarkup,
        }),
      );
    } else {
      const chunks = splitTelegramHtml(text || " ");
      const lastChunkIndex = chunks.length - 1;
      for (const [index, chunk] of chunks.entries()) {
        sentMessages.push(
          await this.bot.api.sendMessage({
            chat_id: target.chatId,
            disable_web_page_preview: true,
            message_thread_id: target.messageThreadId,
            parse_mode: "HTML",
            reply_markup: index === lastChunkIndex ? replyMarkup : undefined,
            text: chunk,
          }),
        );
      }
    }

    const lastMessage = sentMessages.at(-1);
    if (intent.delivery?.pin && lastMessage) {
      try {
        await this.bot.api.pinChatMessage({
          chat_id: target.chatId,
          disable_notification: true,
          message_id: lastMessage.message_id,
        });
        outcome = "pinned";
      } catch {
        // Keep the visible status message even if the chat cannot pin it.
      }
    }

    this.options.logger?.debug(
      `telegram deliver done kind=${intent.kind} outcome=${outcome} target=${this.compactTypingTarget(target)} messages=${sentMessages.length} lastMessage=${lastMessage?.message_id ?? "none"}`,
    );

    return {
      channel: this.channel,
      deliveredAt: this.now(),
      outcome,
      surface: lastMessage
        ? {
            channel: this.channel,
            id: String(lastMessage.message_id),
            state: {
              opaque: {
                chatId: target.chatId,
                messageId: lastMessage.message_id,
                messageThreadId: target.messageThreadId ?? null,
              },
            },
          }
        : undefined,
    };
  }

  private async deliverStreamUpdate(
    intent: Extract<MessagingSurfaceIntent, { kind: "stream_update" }>,
    target: TelegramDeliveryTarget,
  ): Promise<MessagingDeliveryResult> {
    if (
      intent.policy === "disabled" ||
      (
        this.options.config.streamingResponses !== true &&
        intent.policy !== "enabled"
      )
    ) {
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "discarded",
      };
    }

    const text = renderTelegramHtml(intent.text, intent.markdown ?? "plain") || " ";
    if (Buffer.byteLength(text, "utf8") > TELEGRAM_MESSAGE_TEXT_LIMIT) {
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "discarded",
      };
    }

    const rateLimit = this.evaluateStreamRateLimit(target, intent.stream.isFinal);
    if (!rateLimit.allowed) {
      if (intent.stream.isFinal && rateLimit.hard) {
        await this.sleep(rateLimit.waitMs);
      } else {
        this.options.logger?.debug(
          `telegram stream update throttled final=${intent.stream.isFinal} sequence=${intent.stream.sequence} waitMs=${rateLimit.waitMs} policy=${rateLimit.policy} target=${this.compactTypingTarget(target)} stream=${intent.stream.key}`,
        );
        return {
          channel: this.channel,
          deliveredAt: this.now(),
          outcome: "discarded",
          surface: intent.targetSurface,
        };
      }
    }

    const existing =
      this.streamSurfaces.get(intent.stream.key) ??
      (target.messageId ? target : undefined);
    try {
      const message = existing?.messageId
        ? await this.bot.api.editMessageText({
            chat_id: existing.chatId,
            disable_web_page_preview: true,
            message_id: existing.messageId,
            message_thread_id: existing.messageThreadId,
            parse_mode: "HTML",
            text,
          })
        : await this.bot.api.sendMessage({
            chat_id: target.chatId,
            disable_web_page_preview: true,
            message_thread_id: target.messageThreadId,
            parse_mode: "HTML",
            text,
          });
      const surfaceTarget = {
        chatId: target.chatId,
        messageId: message.message_id,
        messageThreadId: target.messageThreadId,
      };
      if (intent.stream.isFinal) {
        this.streamSurfaces.delete(intent.stream.key);
      } else {
        this.streamSurfaces.set(intent.stream.key, surfaceTarget);
      }
      this.options.logger?.debug(
        `telegram stream update ${existing?.messageId ? "edited" : "sent"} final=${intent.stream.isFinal} sequence=${intent.stream.sequence} target=${this.compactTypingTarget(surfaceTarget)} stream=${intent.stream.key}`,
      );
      this.recordStreamRateLimitDelivery(surfaceTarget);
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: existing?.messageId ? "updated" : "presented",
        surface: {
          channel: this.channel,
          id: String(message.message_id),
          state: {
            opaque: {
              chatId: surfaceTarget.chatId,
              messageId: surfaceTarget.messageId,
              messageThreadId: surfaceTarget.messageThreadId ?? null,
            },
          },
        },
      };
    } catch (error) {
      if (existing?.messageId && isTelegramMessageNotModifiedError(error)) {
        if (intent.stream.isFinal) {
          this.streamSurfaces.delete(intent.stream.key);
        } else {
          this.streamSurfaces.set(intent.stream.key, existing);
        }
        this.options.logger?.debug(
          `telegram stream update unchanged final=${intent.stream.isFinal} sequence=${intent.stream.sequence} target=${this.compactTypingTarget(existing)} stream=${intent.stream.key}`,
        );
        return {
          channel: this.channel,
          deliveredAt: this.now(),
          outcome: "updated",
          surface: {
            channel: this.channel,
            id: String(existing.messageId),
            state: {
              opaque: {
                chatId: existing.chatId,
                messageId: existing.messageId,
                messageThreadId: existing.messageThreadId ?? null,
              },
            },
          },
        };
      }
      const retryAfterMs = telegramRetryAfterMs(error);
      let rateLimit: MessagingRateLimitInfo | undefined;
      if (retryAfterMs !== undefined) {
        this.blockStreamRateLimitTarget(target, retryAfterMs);
        rateLimit = {
          scope: this.rateLimitScopeForTarget(target),
          retryAfterMs,
          message: errorMessage(error),
          observedAt: this.now(),
          retryable: true,
        };
        this.emitRateLimit(rateLimit);
        this.options.logger?.warn?.(
          `telegram stream update rate limited retryAfterMs=${retryAfterMs} target=${this.compactTypingTarget(target)} stream=${intent.stream.key}`,
        );
      }
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        errorMessage: errorMessage(error),
        outcome: "failed",
        ...(rateLimit ? { rateLimit } : {}),
      };
    }
  }

  async setConversationTitle(
    request: MessagingConversationTitleUpdateRequest,
  ): Promise<MessagingConversationTitleUpdateResult> {
    const title = sanitizeTelegramTopicName(request.title);
    const conversation = request.channel.conversation;
    const target =
      this.telegramStateFromChannel(conversation) ??
      this.telegramStateFromSurface(request.routingState);

    if (conversation.kind !== "topic" || !target?.messageThreadId) {
      return {
        channel: this.channel,
        conversation,
        errorMessage: "Telegram name sync is only available inside forum topics.",
        outcome: "unsupported",
        title,
        updatedAt: this.now(),
      };
    }

    try {
      await this.bot.api.editForumTopic({
        chat_id: target.chatId,
        message_thread_id: target.messageThreadId,
        name: title,
      });
      // Pre-populate the topic-name cache with the value we just set.
      // The gateway will also send a `forum_topic_edited` echo that
      // would update the cache, but writing here avoids a brief
      // window where the chip still shows the old name.
      this.topicNameCache.delete(
        this.topicCacheKey(target.chatId, target.messageThreadId),
      );
      this.topicNameCache.set(
        this.topicCacheKey(target.chatId, target.messageThreadId),
        title,
      );
      return {
        channel: this.channel,
        conversation: {
          ...conversation,
          title,
        },
        outcome: "updated",
        title,
        updatedAt: this.now(),
      };
    } catch (error) {
      return {
        channel: this.channel,
        conversation,
        errorMessage: errorMessage(error),
        outcome: "failed",
        title,
        updatedAt: this.now(),
      };
    }
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      await this.handleMessage(update.update_id, update.message);
      return;
    }

    if (update.callback_query) {
      await this.handleCallbackQuery(update.update_id, update.callback_query);
    }
  }

  private async handleMessage(
    updateId: number,
    message: TelegramMessage,
  ): Promise<void> {
    const listener = this.listener;
    if (!listener || !message.from) {
      return;
    }
    if (!this.validateMessageIdentifiers(updateId, message)) {
      return;
    }

    const serviceMessageReason = telegramServiceMessageReason(message);
    if (serviceMessageReason || this.isOwnBotUser(message.from)) {
      // Forum topic create/edit service messages carry the topic name
      // — capture it before the early-return so the next regular
      // message in that topic can populate `channel.conversation.title`
      // for the binding chip. Telegram has no other API to fetch this.
      this.captureForumTopicNameIfPresent(message);
      this.options.logger?.debug(
        `telegram inbound ignored update=${updateId} message=${message.message_id} reason=${serviceMessageReason ?? "own_bot"} chat=${message.chat.id}`,
      );
      return;
    }

    // `@<botusername> <verb>` text mention → command. Run BEFORE the
    // attachment branch so captions like `@PwrAgentBot resume` on a
    // photo/file/voice upload route to the command pathway too — the
    // user typed a verb, that intent wins over the incidental
    // attachment. Mirrors the Mattermost / Discord paths so users on
    // Telegram can invoke commands without the slash menu (helpful
    // when a phone keyboard doesn't surface custom commands or when
    // typing into a topic the user hasn't sent a slash to before).
    // Username matching is case-insensitive — Telegram usernames are
    // case-insensitive.
    const mentionCandidate = message.text ?? message.caption;
    const isPairingMessage = mentionCandidate
      ? Boolean(extractMessagingPairingToken(mentionCandidate))
      : false;
    const mentionRemainder = mentionCandidate
      ? stripTelegramBotMention(mentionCandidate, this.botUsername)
      : undefined;
    if (
      !isPairingMessage &&
      !this.isAuthorizedMessageSource(message, {
        actionable:
          isPairingMessage
          || Boolean(mentionRemainder)
          || Boolean(message.text?.startsWith("/")),
      })
    ) {
      return;
    }
    if (mentionRemainder !== undefined && mentionCandidate !== undefined) {
      // If the remainder after the mention doesn't form a valid verb
      // (e.g. a second mention, or a digit-leading token), we
      // deliberately fall through to the attachment / slash / text
      // paths below so the user's original message is dispatched as
      // media or plain text rather than a half-recognized command.
      const synthRaw = `/${mentionRemainder}`;
      const mentionCommandMatch = /^\/([A-Za-z0-9_]+)(?:\s+(.*))?$/.exec(synthRaw);
      if (mentionCommandMatch) {
        this.options.logger?.debug(
          `telegram inbound mention-command update=${updateId} message=${message.message_id} chat=${message.chat.id} actor=${message.from.id} command=${mentionCommandMatch[1]} preview="${compactPreview(mentionCandidate)}"`,
        );
        await listener({
          id: `telegram:update:${updateId}:message:${message.message_id}`,
          kind: "command",
          actor: this.actorFromUser(message.from),
          args: mentionCommandMatch[2]?.split(/\s+/).filter(Boolean) ?? [],
          channel: this.channelFromMessage(message),
          command: mentionCommandMatch[1]?.toLowerCase() ?? "",
          rawText: synthRaw,
          receivedAt: this.messageReceivedAt(message),
          routingState: this.routingStateFromMessage(message),
        });
        return;
      }
    }

    const attachments = this.attachmentsFromMessage(message);
    if (attachments.length > 0) {
      await listener({
        id: `telegram:update:${updateId}:message:${message.message_id}`,
        kind: "media",
        actor: this.actorFromUser(message.from),
        attachments,
        channel: this.channelFromMessage(message),
        disposition: attachments.some((attachment) => attachment.disposition === "available")
          ? "available"
          : "unsupported",
        media: {
          type: "file",
          name: attachments[0]?.name ?? "telegram-media",
          mimeType:
            message.document?.mime_type ??
            message.animation?.mime_type ??
            message.voice?.mime_type ??
            message.video?.mime_type,
          sizeBytes: attachments[0]?.sizeBytes,
        },
        receivedAt: this.messageReceivedAt(message),
        routingState: this.routingStateFromMessage(message),
        text: message.caption,
      });
      return;
    }

    if (!message.text) {
      return;
    }

    const commandMatch = /^\/([A-Za-z0-9_]+)(?:@\S+)?(?:\s+(.*))?$/.exec(message.text);
    this.options.logger?.debug(
      `telegram inbound ${commandMatch ? "command" : "text"} update=${updateId} message=${message.message_id} chat=${message.chat.id} actor=${message.from.id} chars=${message.text.length} preview="${compactPreview(message.text)}"`,
    );
    await listener({
      id: `telegram:update:${updateId}:message:${message.message_id}`,
      kind: commandMatch ? "command" : "text",
      actor: this.actorFromUser(message.from),
      channel: this.channelFromMessage(message),
      ...(commandMatch
        ? {
            args: commandMatch[2]?.split(/\s+/).filter(Boolean) ?? [],
            command: commandMatch[1]?.toLowerCase() ?? "",
            rawText: message.text,
          }
        : {
            text: message.text,
          }),
      receivedAt: this.messageReceivedAt(message),
      routingState: this.routingStateFromMessage(message),
    } as MessagingInboundEvent);
  }

  private async handleCallbackQuery(
    updateId: number,
    callbackQuery: TelegramCallbackQuery,
  ): Promise<void> {
    const listener = this.listener;
    const message = callbackQuery.message;
    if (!listener || !message) {
      return;
    }
    if (!this.validateCallbackIdentifiers(updateId, callbackQuery)) {
      return;
    }
    if (!this.isAuthorizedCallbackSource(callbackQuery)) {
      await this.bot.api.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
      });
      return;
    }

    await this.bot.api.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
    });

    const channel = this.channelFromMessage(message);
    const persistedBinding =
      callbackQuery.data && this.options.store
        ? await this.options.store.resolveCallbackHandle({
            actorId: String(callbackQuery.from.id),
            channel,
            handle: callbackQuery.data,
            now: this.now(),
          })
        : undefined;
    this.options.logger?.debug(
      `telegram inbound callback update=${updateId} callback=${callbackQuery.id} chat=${message.chat.id} actor=${callbackQuery.from.id} action=${persistedBinding?.actionId ?? "unresolved"}`,
    );
    await listener({
      id: `telegram:update:${updateId}:callback:${callbackQuery.id}`,
      kind: "callback",
      actor: this.actorFromUser(callbackQuery.from),
      channel,
      interaction: {
        channel: this.channel,
        id: callbackQuery.data ?? "",
        state: {
          opaque: {
            callbackData: callbackQuery.data ?? null,
          },
        },
      },
      actionId: persistedBinding?.actionId,
      value: persistedBinding?.value,
      receivedAt: this.now(),
      routingState: this.routingStateFromMessage(message),
    });
  }

  private validateMessageIdentifiers(
    updateId: number,
    message: TelegramMessage,
    options: { requireActor: boolean } = { requireActor: true },
  ): boolean {
    return (
      this.validateIdentifier("update.update_id", updateId, validateTelegramPositiveId)
      && this.validateIdentifier("message.message_id", message.message_id, validateTelegramPositiveId)
      && this.validateIdentifier("chat.id", message.chat.id, validateTelegramChatId)
      && (!options.requireActor
        || this.validateIdentifier("user.id", message.from?.id, validateTelegramPositiveId))
      && (message.message_thread_id === undefined
        || this.validateIdentifier(
          "message.message_thread_id",
          message.message_thread_id,
          validateTelegramPositiveId,
        ))
      && this.validateMessageFileIds(message)
    );
  }

  private validateCallbackIdentifiers(
    updateId: number,
    callbackQuery: TelegramCallbackQuery,
  ): boolean {
    return (
      this.validateIdentifier("update.update_id", updateId, validateTelegramPositiveId)
      && this.validateIdentifier(
        "callback_query.id",
        callbackQuery.id,
        validateTelegramCallbackQueryId,
      )
      && this.validateIdentifier("user.id", callbackQuery.from.id, validateTelegramPositiveId)
      && this.validateIdentifier(
        "callback_query.data",
        callbackQuery.data,
        validateTelegramCallbackData,
      )
      && (!callbackQuery.message
        || this.validateMessageIdentifiers(updateId, callbackQuery.message, {
          requireActor: false,
        }))
    );
  }

  private validateMessageFileIds(message: TelegramMessage): boolean {
    const fileIds = [
      message.animation?.file_id,
      message.document?.file_id,
      message.video?.file_id,
      message.voice?.file_id,
      ...(message.photo?.map((photo) => photo.file_id) ?? []),
    ];
    for (const fileId of fileIds) {
      if (
        fileId !== undefined
        && !this.validateIdentifier("file_id", fileId, validateTelegramFileId)
      ) {
        return false;
      }
    }
    return true;
  }

  private validateIdentifier(
    field: TelegramIdentifierField,
    value: unknown,
    validator: (value: unknown) => ReturnType<typeof validateTelegramPositiveId>,
  ): boolean {
    const result = validator(value);
    if (result.ok) {
      return true;
    }
    logTelegramInvalidIdentifier({
      field,
      logger: this.options.logger,
      reason: result.reason,
      value,
    });
    return false;
  }

  private isAuthorizedMessageSource(
    message: TelegramMessage,
    options: { actionable: boolean },
  ): boolean {
    const actorId = String(message.from?.id ?? "");
    if (!this.isAuthorizedActor(actorId)) {
      if (message.chat.type === "private" || options.actionable) {
        this.options.logger?.warn?.("telegram inbound ignored unauthorized actor", {
          actorId,
          chatId: String(message.chat.id),
          chatType: message.chat.type,
          actionable: options.actionable,
        });
        this.emitInboundRejected(this.rejectedEventFromMessage(message, {
          kind: options.actionable ? "command" : "text",
          reason: "unauthorized-actor",
        }));
      }
      return false;
    }

    if (!this.isAuthorizedTelegramConversation(message.chat)) {
      this.logUnauthorizedConversationOnce("message", message.chat);
      this.emitInboundRejected(this.rejectedEventFromMessage(message, {
        kind: options.actionable ? "command" : "text",
        reason: "unauthorized-conversation",
      }));
      return false;
    }
    return true;
  }

  private isAuthorizedCallbackSource(callbackQuery: TelegramCallbackQuery): boolean {
    const actorId = String(callbackQuery.from.id);
    const chat = callbackQuery.message?.chat;
    if (!this.isAuthorizedActor(actorId)) {
      this.options.logger?.warn?.("telegram callback ignored unauthorized actor", {
        actorId,
        chatId: chat ? String(chat.id) : undefined,
      });
      if (chat) {
        this.emitInboundRejected(this.rejectedEventFromCallback(callbackQuery, {
          reason: "unauthorized-actor",
        }));
      }
      return false;
    }
    if (chat && !this.isAuthorizedTelegramConversation(chat)) {
      this.logUnauthorizedConversationOnce("callback", chat);
      this.emitInboundRejected(this.rejectedEventFromCallback(callbackQuery, {
        reason: "unauthorized-conversation",
      }));
      return false;
    }
    return true;
  }

  private isAuthorizedActor(actorId: string): boolean {
    return this.options.config.authorizedActorIds.some(
      (contact) => contact.id === actorId,
    );
  }

  private isAuthorizedTelegramConversation(chat: TelegramChat): boolean {
    if (chat.type !== "supergroup" && chat.type !== "group") {
      return true;
    }
    const authorized = this.options.config.authorizedSupergroupIds ?? [];
    return (
      authorized.length === 0
      || authorized.some((contact) => contact.id === String(chat.id))
    );
  }

  private logUnauthorizedConversationOnce(
    surface: "callback" | "message",
    chat: TelegramChat,
  ): void {
    const key = `${chat.type}:${chat.id}`;
    if (this.unauthorizedConversationLogKeys.has(key)) {
      return;
    }
    this.unauthorizedConversationLogKeys.add(key);
    this.options.logger?.warn?.("telegram inbound ignored unauthorized conversation", {
      chatId: String(chat.id),
      chatType: chat.type,
      surface,
    });
  }

  private attachmentsFromMessage(message: TelegramMessage): MessagingAttachmentDescriptor[] {
    const attachments: MessagingAttachmentDescriptor[] = [];
    if (message.document) {
      const mimeType = message.document.mime_type;
      const image = mimeType?.startsWith("image/");
      attachments.push({
        id: `telegram:file:${message.document.file_id}`,
        kind: image ? "image" : "file",
        name: message.document.file_name ?? "telegram-document",
        disposition: this.isDownloadableTelegramMimeType(mimeType) ? "available" : "rejected",
        height: message.document.height,
        mimeType,
        reason: this.isDownloadableTelegramMimeType(mimeType)
          ? undefined
          : "unsupported attachment type",
        sizeBytes: message.document.file_size,
        state: {
          opaque: {
            fileId: message.document.file_id,
            provider: "telegram",
          },
        },
        width: message.document.width,
      });
    }

    if (message.photo && message.photo.length > 0) {
      const photo = [...message.photo].sort(
        (left, right) => (right.file_size ?? 0) - (left.file_size ?? 0),
      )[0]!;
      attachments.push({
        id: `telegram:photo:${photo.file_id}`,
        kind: "image",
        name: "telegram-photo.jpg",
        disposition: "available",
        height: photo.height,
        mimeType: "image/jpeg",
        sizeBytes: photo.file_size,
        state: {
          opaque: {
            fileId: photo.file_id,
            provider: "telegram",
          },
        },
        width: photo.width,
      });
    }

    if (message.animation) {
      attachments.push({
        id: `telegram:animation:${message.animation.file_id}`,
        kind: "gif",
        name: message.animation.file_name ?? "telegram-animation.gif",
        disposition: "available",
        height: message.animation.height,
        mimeType: message.animation.mime_type ?? "image/gif",
        sizeBytes: message.animation.file_size,
        state: {
          opaque: {
            fileId: message.animation.file_id,
            provider: "telegram",
          },
        },
        width: message.animation.width,
      });
    }

    if (message.voice) {
      attachments.push({
        id: `telegram:voice:${message.voice.file_id}`,
        kind: "audio",
        name: message.voice.mime_type ?? "telegram-voice",
        disposition: "unsupported",
        mimeType: message.voice.mime_type,
        reason: "audio attachments are not supported",
        state: {
          opaque: {
            fileId: message.voice.file_id,
            provider: "telegram",
          },
        },
      });
    }

    if (message.video) {
      attachments.push({
        id: `telegram:video:${message.video.file_id}`,
        kind: "video",
        name: message.video.mime_type ?? "telegram-video",
        disposition: "unsupported",
        mimeType: message.video.mime_type,
        reason: "video attachments are not supported",
        state: {
          opaque: {
            fileId: message.video.file_id,
            provider: "telegram",
          },
        },
      });
    }

    return attachments;
  }

  private isDownloadableTelegramMimeType(mimeType: string | undefined): boolean {
    if (!mimeType) {
      return true;
    }
    return (
      mimeType.startsWith("text/") ||
      mimeType.startsWith("image/") ||
      [
        "application/json",
        "application/pdf",
        "application/toml",
        "application/x-yaml",
        "application/yaml",
        "text/csv",
      ].includes(mimeType)
    );
  }

  private async buildReplyMarkup(
    intent: MessagingSurfaceIntent,
    actions: MessagingSurfaceAction[],
  ): Promise<TelegramInlineKeyboardMarkup | undefined> {
    // Defensive caps from the adapter's own profile. Producers should
    // already have applied these via applyActionCapabilityLimits.
    const maxActions = this.capabilityProfile.actions?.maxActions ?? 100;
    const maxLabelLength = this.capabilityProfile.actions?.maxLabelLength ?? 64;
    const maxColumns = this.capabilityProfile.actions?.maxActionsPerRow ?? 8;
    const items = await Promise.all(
      actions
        .filter((action) => !action.disabled)
        .slice(0, maxActions)
        .map(async (action) => ({
          action,
          component: {
            text: action.label.length > maxLabelLength
              ? action.label.slice(0, maxLabelLength)
              : action.label,
            callback_data: await this.createCallbackData(intent, action),
          },
        })),
    );

    if (items.length === 0) {
      return undefined;
    }

    return {
      inline_keyboard: layoutMessagingActionRows(items, {
        defaultColumns: intent.actionLayout?.columns ?? 1,
        maxColumns,
      }),
    };
  }

  private async createCallbackData(
    intent: MessagingSurfaceIntent,
    action: MessagingSurfaceAction,
  ): Promise<string> {
    const handle = `tg:${createHash("sha256")
      .update(JSON.stringify([intent.id, action.id, action.value ?? null]))
      .digest("base64url")
      .slice(0, 18)}`;
    if (Buffer.byteLength(handle, "utf8") > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES) {
      throw new Error("Telegram callback handle exceeds callback_data limit.");
    }

    if (this.options.store && intent.audit) {
      const now = this.now();
      await this.options.store.upsertCallbackHandle({
        id: telegramCallbackRecordId(handle, intent),
        actionId: action.id,
        allowedActorIds: callbackAllowedActorIds(intent),
        bindingId: callbackBindingId(intent),
        channel: intent.audit.channel,
        createdAt: now,
        expiresAt: now + MESSAGING_CALLBACK_HANDLE_TTL_MS,
        handle,
        pendingIntentId: intent.id,
        browseSessionId: browseSessionIdForIntent(intent),
        surface: intent.targetSurface,
        updatedAt: now,
        value: action.value,
      });
    }
    return handle;
  }

  private resolveTarget(intent: MessagingSurfaceIntent): TelegramDeliveryTarget | undefined {
    if (intent.delivery?.mode === "update" || intent.kind === "dismiss") {
      return (
        this.telegramStateFromSurface(intent.targetSurface?.state) ??
        (intent.audit?.channel
          ? this.telegramStateFromChannel(intent.audit.channel.conversation)
          : undefined)
      );
    }

    return intent.audit?.channel
      ? this.telegramStateFromChannel(intent.audit.channel.conversation)
      : this.telegramStateFromSurface(intent.targetSurface?.state);
  }

  private telegramStateFromChannel(channel: {
    id: string;
    parentId?: string;
  }): TelegramDeliveryTarget | undefined {
    if (channel.parentId) {
      return {
        chatId: parseTelegramIdentifier(channel.parentId),
        messageThreadId: Number(channel.id),
      };
    }

    return {
      chatId: parseTelegramIdentifier(channel.id),
    };
  }

  private telegramStateFromSurface(
    state: MessagingAdapterState | undefined,
  ): TelegramDeliveryTarget | undefined {
    const opaque = state?.opaque;
    if (!opaque || typeof opaque !== "object" || Array.isArray(opaque)) {
      return undefined;
    }

    const chatId = opaque.chatId;
    const messageId = opaque.messageId;
    const messageThreadId = opaque.messageThreadId;
    if (typeof chatId !== "string" && typeof chatId !== "number") {
      return undefined;
    }

    return {
      chatId,
      messageId: typeof messageId === "number" ? messageId : undefined,
      messageThreadId:
        typeof messageThreadId === "number" ? messageThreadId : undefined,
    };
  }

  private firstImagePayload(
    intent: MessagingSurfaceIntent,
  ): { filename?: string; source: string | Uint8Array } | undefined {
    if (intent.kind !== "message") {
      return undefined;
    }

    const url = intent.parts.find((part) => part.type === "image" && "url" in part)?.url;
    if (!url) {
      return undefined;
    }

    const dataImage = parseDataImageUrl(url);
    if (dataImage) {
      return dataImage;
    }

    return { source: url };
  }

  private async deliverActivity(
    intent: Extract<MessagingSurfaceIntent, { kind: "activity" }>,
    target: TelegramDeliveryTarget,
  ): Promise<MessagingDeliveryResult> {
    if (intent.activity !== "typing") {
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "unsupported",
      };
    }

    try {
      if (intent.state === "active") {
        await this.startTypingSignal(target, intent.leaseMs);
      } else {
        this.stopTypingSignal(target);
      }
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "signaled",
      };
    } catch (error) {
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        errorMessage: error instanceof Error ? error.message : String(error),
        outcome: "failed",
      };
    }
  }

  private async startTypingSignal(
    target: TelegramDeliveryTarget,
    leaseMs = TELEGRAM_DEFAULT_TYPING_SIGNAL_LEASE_MS,
  ): Promise<void> {
    const key = this.typingSignalKey(target);
    const existing = this.typingSignals.get(key);
    if (existing) {
      this.refreshTypingSignalLease(target, leaseMs);
      return;
    }

    const signalId = ++this.typingSignalSequence;
    const timeout = this.createTypingSignalTimeout(target, leaseMs, signalId);
    const interval = setInterval(() => {
      const current = this.typingSignals.get(key);
      if (!current || current.signalId !== signalId) {
        return;
      }
      void this.sendTypingSignal(target, signalId, "interval").catch((error) => {
        this.options.logger?.warn?.(
          `telegram sendChatAction typing failed signal=${signalId} source=interval target=${this.compactTypingTarget(target)} error=${errorMessage(error)}`,
        );
      });
    }, TELEGRAM_TYPING_SIGNAL_INTERVAL_MS);
    (interval as { unref?: () => void }).unref?.();
    this.typingSignals.set(key, {
      interval,
      signalId,
      timeout,
    });
    this.options.logger?.debug(
      `telegram typing started signal=${signalId} leaseMs=${leaseMs} target=${this.compactTypingTarget(target)}`,
    );

    try {
      await this.sendTypingSignal(target, signalId, "start");
    } catch (error) {
      this.stopTypingSignal(target, "start_failed");
      throw error;
    }
  }

  private stopTypingSignal(
    target: TelegramDeliveryTarget,
    reason = "idle",
  ): void {
    const key = this.typingSignalKey(target);
    const signal = this.typingSignals.get(key);
    if (!signal) {
      this.options.logger?.debug(
        `telegram typing stop skipped reason=${reason} target=${this.compactTypingTarget(target)}`,
      );
      return;
    }
    clearInterval(signal.interval);
    clearTimeout(signal.timeout);
    this.typingSignals.delete(key);
    this.options.logger?.debug(
      `telegram typing stopped signal=${signal.signalId} reason=${reason} target=${this.compactTypingTarget(target)}`,
    );
  }

  private stopTypingSignals(): void {
    for (const signal of this.typingSignals.values()) {
      clearInterval(signal.interval);
      clearTimeout(signal.timeout);
    }
    if (this.typingSignals.size > 0) {
      this.options.logger?.debug("telegram typing signals stopped", {
        count: this.typingSignals.size,
      });
    }
    this.typingSignals.clear();
  }

  private refreshTypingSignalLease(
    target: TelegramDeliveryTarget,
    leaseMs: number,
  ): void {
    const key = this.typingSignalKey(target);
    const signal = this.typingSignals.get(key);
    if (!signal) {
      return;
    }
    clearTimeout(signal.timeout);
    signal.timeout = this.createTypingSignalTimeout(target, leaseMs, signal.signalId);
    this.options.logger?.debug(
      `telegram typing lease refreshed signal=${signal.signalId} leaseMs=${leaseMs} target=${this.compactTypingTarget(target)}`,
    );
  }

  private createTypingSignalTimeout(
    target: TelegramDeliveryTarget,
    leaseMs: number,
    signalId: number,
  ): ReturnType<typeof setTimeout> {
    const timeout = setTimeout(() => {
      const current = this.typingSignals.get(this.typingSignalKey(target));
      if (!current || current.signalId !== signalId) {
        this.options.logger?.debug(
          `telegram typing expiry skipped signal=${signalId} leaseMs=${leaseMs} target=${this.compactTypingTarget(target)}`,
        );
        return;
      }
      this.options.logger?.debug(
        `telegram typing expired signal=${signalId} leaseMs=${leaseMs} target=${this.compactTypingTarget(target)}`,
      );
      this.stopTypingSignal(target, "lease_expired");
    }, leaseMs);
    (timeout as { unref?: () => void }).unref?.();
    return timeout;
  }

  private async sendTypingSignal(
    target: TelegramDeliveryTarget,
    signalId: number,
    source: "interval" | "start",
  ): Promise<void> {
    this.options.logger?.debug(
      `telegram sendChatAction typing request signal=${signalId} source=${source} target=${this.compactTypingTarget(target)}`,
    );
    await this.bot.api.sendChatAction({
      action: "typing",
      chat_id: target.chatId,
      message_thread_id: target.messageThreadId,
    });
    this.options.logger?.debug(
      `telegram sendChatAction typing ok signal=${signalId} source=${source} target=${this.compactTypingTarget(target)}`,
    );
  }

  private typingSignalKey(target: TelegramDeliveryTarget): string {
    return `${target.chatId}:${target.messageThreadId ?? ""}`;
  }

  private evaluateStreamRateLimit(
    target: TelegramDeliveryTarget,
    isFinal: boolean,
  ): TelegramStreamRateLimitDecision {
    const now = this.now();
    const key = this.streamRateLimitKey(target);
    const policy = this.streamRateLimitPolicy(target);
    const state = this.streamRateLimitState(key, now);
    if (state.blockedUntil !== undefined && state.blockedUntil > now) {
      return {
        allowed: false,
        hard: true,
        policy,
        waitMs: state.blockedUntil - now,
      };
    }

    if (policy === "group" && state.timestamps.length >= TELEGRAM_STREAM_GROUP_MAX_PER_WINDOW) {
      const oldest = state.timestamps[0] ?? now;
      const waitMs = Math.max(
        0,
        oldest + TELEGRAM_STREAM_GROUP_WINDOW_MS - now + TELEGRAM_STREAM_RETRY_AFTER_BUFFER_MS,
      );
      if (waitMs > 0) {
        return {
          allowed: false,
          hard: true,
          policy,
          waitMs,
        };
      }
    }

    if (!isFinal) {
      const minIntervalMs =
        policy === "group"
          ? telegramGroupStreamMinIntervalMs(state.timestamps.length)
          : TELEGRAM_STREAM_DM_MIN_INTERVAL_MS;
      const last = state.timestamps.at(-1);
      const waitMs =
        last === undefined ? 0 : Math.max(0, last + minIntervalMs - now);
      if (waitMs > 0) {
        return {
          allowed: false,
          hard: false,
          policy,
          waitMs,
        };
      }
    }

    return {
      allowed: true,
      hard: false,
      policy,
      waitMs: 0,
    };
  }

  private recordStreamRateLimitDelivery(target: TelegramDeliveryTarget): void {
    const now = this.now();
    const key = this.streamRateLimitKey(target);
    const state = this.streamRateLimitState(key, now);
    state.timestamps.push(now);
  }

  private blockStreamRateLimitTarget(
    target: TelegramDeliveryTarget,
    retryAfterMs: number,
  ): void {
    const now = this.now();
    const key = this.streamRateLimitKey(target);
    const state = this.streamRateLimitState(key, now);
    state.blockedUntil = Math.max(
      state.blockedUntil ?? 0,
      now + retryAfterMs + TELEGRAM_STREAM_RETRY_AFTER_BUFFER_MS,
    );
  }

  private streamRateLimitState(
    key: string,
    now: number,
  ): TelegramStreamRateLimitState {
    let state = this.streamRateLimits.get(key);
    if (!state) {
      state = { timestamps: [] };
      this.streamRateLimits.set(key, state);
    }
    const cutoff = now - TELEGRAM_STREAM_GROUP_WINDOW_MS;
    state.timestamps = state.timestamps.filter((timestamp) => timestamp > cutoff);
    if (state.blockedUntil !== undefined && state.blockedUntil <= now) {
      state.blockedUntil = undefined;
    }
    return state;
  }

  private streamRateLimitKey(target: TelegramDeliveryTarget): string {
    return String(target.chatId);
  }

  private streamRateLimitPolicy(
    target: TelegramDeliveryTarget,
  ): TelegramStreamRateLimitDecision["policy"] {
    if (target.messageThreadId !== undefined) {
      return "group";
    }
    const chatId =
      typeof target.chatId === "number" ? target.chatId : Number(target.chatId);
    return Number.isFinite(chatId) && chatId < 0 ? "group" : "dm";
  }

  private rateLimitScopeForTarget(
    target: TelegramDeliveryTarget,
  ): MessagingDeliveryScope {
    const policy = this.streamRateLimitPolicy(target);
    const chatId = String(target.chatId);
    return {
      platform: this.channel,
      id: policy === "group" ? `telegram:group:${chatId}` : `telegram:dm:${chatId}`,
      kind: policy === "group" ? "group" : "dm",
      label:
        policy === "group"
          ? `Telegram group ${compactIdentifier(chatId)}`
          : "Telegram DM",
      budget:
        policy === "group"
          ? { limit: 20, intervalMs: 60_000, reserved: 5 }
          : { limit: 1, intervalMs: 1_000, reserved: 0 },
    };
  }

  private emitRateLimitFromError(
    error: unknown,
    target: TelegramDeliveryTarget,
    options?: { retryable?: boolean },
  ): MessagingRateLimitInfo | undefined {
    const retryAfterMs = telegramRetryAfterMs(error);
    if (retryAfterMs === undefined) {
      return undefined;
    }
    const info: MessagingRateLimitInfo = {
      scope: this.rateLimitScopeForTarget(target),
      retryAfterMs,
      message: errorMessage(error),
      observedAt: this.now(),
      retryable: options?.retryable ?? false,
    };
    this.emitRateLimit(info);
    return info;
  }

  private emitRateLimit(info: MessagingRateLimitInfo): void {
    for (const listener of this.rateLimitListeners) {
      try {
        listener(info);
      } catch {
        // Runtime listeners are observability. Delivery handling continues.
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private compactTypingTarget(target: TelegramDeliveryTarget): string {
    return target.messageThreadId
      ? `${target.chatId}/${target.messageThreadId}`
      : String(target.chatId);
  }

  private channelFromMessage(message: TelegramMessage): MessagingInboundEvent["channel"] {
    // Private DMs don't carry a chat title — synthesize one from the
    // sender's first/last name so the chip renders as "DM: Alice"
    // instead of "DM: ?".
    const senderName =
      [message.from?.first_name, message.from?.last_name]
        .filter(Boolean)
        .join(" ") || undefined;
    const chatTitle = message.chat.title ?? senderName;

    if (message.message_thread_id) {
      // Topic-bound messages: title slot belongs to the topic itself.
      // Look up the cached topic name (populated from
      // `forum_topic_created` / `forum_topic_edited` service messages
      // — see `captureForumTopicNameIfPresent`). When the cache misses
      // (bot joined the chat after topic creation, no rename has
      // happened since), title stays undefined and the renderer falls
      // back to a literal "Topic" placeholder.
      const topicTitle = this.lookupTopicName(
        message.chat.id,
        message.message_thread_id,
      );
      return {
        channel: this.channel,
        conversation: {
          id: String(message.message_thread_id),
          kind: "topic",
          parentId: String(message.chat.id),
          title: topicTitle,
          parentTitle: chatTitle,
        },
      };
    }

    return {
      channel: this.channel,
      conversation: {
        id: String(message.chat.id),
        kind: message.chat.type === "private" ? "dm" : "channel",
        title: chatTitle,
      },
    };
  }

  private actorFromUser(user: TelegramMessage["from"]): MessagingInboundEvent["actor"] {
    return {
      platformUserId: String(user?.id ?? "unknown"),
      displayName: [user?.first_name, user?.last_name].filter(Boolean).join(" ") || undefined,
      isBot: user?.is_bot,
      phoneNumber: user?.phone_number,
      username: user?.username,
    };
  }

  private rejectedEventFromMessage(
    message: TelegramMessage,
    options: Pick<MessagingRejectedInboundEvent, "kind" | "reason">,
  ): MessagingRejectedInboundEvent {
    return {
      id: `telegram:message:${message.message_id}:rejected`,
      kind: options.kind,
      actor: this.actorFromUser(message.from),
      channel: this.channelFromMessage(message),
      receivedAt: this.messageReceivedAt(message),
      reason: options.reason,
      routingState: this.routingStateFromMessage(message),
    };
  }

  private rejectedEventFromCallback(
    callbackQuery: TelegramCallbackQuery,
    options: Pick<MessagingRejectedInboundEvent, "reason">,
  ): MessagingRejectedInboundEvent {
    const message = callbackQuery.message;
    return {
      id: `telegram:callback:${callbackQuery.id}:rejected`,
      kind: "callback",
      actor: this.actorFromUser(callbackQuery.from),
      channel: message
        ? this.channelFromMessage(message)
        : {
            channel: this.channel,
            conversation: {
              id: String(callbackQuery.from.id),
              kind: "dm",
            },
          },
      receivedAt: this.now(),
      reason: options.reason,
      ...(message ? { routingState: this.routingStateFromMessage(message) } : {}),
    };
  }

  private emitInboundRejected(event: MessagingRejectedInboundEvent): void {
    for (const listener of this.inboundRejectedListeners) {
      void listener(event);
    }
  }

  private isOwnBotUser(user: TelegramMessage["from"]): boolean {
    const botId = this.configuredBotId();
    return Boolean(botId && user?.is_bot && String(user.id) === botId);
  }

  private configuredBotId(): string | undefined {
    const id = this.options.config.botToken.split(":", 1)[0];
    return /^\d+$/.test(id) ? id : undefined;
  }

  private routingStateFromMessage(message: TelegramMessage): MessagingAdapterState {
    return {
      opaque: {
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id ?? null,
      },
    };
  }

  /**
   * Cache the forum topic name when a `forum_topic_created` or
   * `forum_topic_edited` service message arrives. Both messages carry
   * the topic id in `message_thread_id` and the new name on the
   * service-message payload. `forum_topic_edited.name` is optional
   * because rename messages can also change just the icon — we skip
   * those (no name → nothing to cache).
   */
  private captureForumTopicNameIfPresent(message: TelegramMessage): void {
    if (!message.message_thread_id) return;
    const name =
      message.forum_topic_created?.name ??
      message.forum_topic_edited?.name;
    if (!name) return;
    const key = this.topicCacheKey(message.chat.id, message.message_thread_id);
    // LRU: re-insert on update so the cache picks the genuinely-coldest
    // entry on eviction, not the one we just refreshed.
    this.topicNameCache.delete(key);
    this.topicNameCache.set(key, name);
    while (this.topicNameCache.size > TelegramAdapter.TOPIC_NAME_CACHE_CAP) {
      const oldest = this.topicNameCache.keys().next();
      if (oldest.done) break;
      this.topicNameCache.delete(oldest.value);
    }
  }

  private lookupTopicName(
    chatId: number | string,
    messageThreadId: number,
  ): string | undefined {
    const key = this.topicCacheKey(chatId, messageThreadId);
    const cached = this.topicNameCache.get(key);
    if (cached !== undefined) {
      // LRU touch — re-insert at the back so frequently-active topics
      // aren't evicted ahead of cold ones.
      this.topicNameCache.delete(key);
      this.topicNameCache.set(key, cached);
    }
    return cached;
  }

  /**
   * Cache key is platform-agnostic stringification of chat id +
   * topic id. The Telegram adapter sometimes hands us numeric chat
   * ids (gateway path) and sometimes string ids (HTTP target path);
   * both stringify to the same key.
   */
  private topicCacheKey(
    chatId: number | string,
    messageThreadId: number,
  ): string {
    return `${chatId}:${messageThreadId}`;
  }

  private messageReceivedAt(message: TelegramMessage): number {
    return message.date ? message.date * 1000 : this.now();
  }

  private registerBotHandlers(): void {
    if (!this.bot.on) {
      return;
    }
    this.bot.on("message", async (context) => {
      const update = context as {
        message?: TelegramMessage;
        update?: { update_id?: number };
      };
      if (update.message) {
        await this.handleMessage(update.update?.update_id ?? this.now(), update.message);
      }
    });
    this.bot.on("callback_query:data", async (context) => {
      const update = context as {
        callbackQuery?: TelegramCallbackQuery;
        update?: { update_id?: number };
      };
      if (update.callbackQuery) {
        await this.handleCallbackQuery(
          update.update?.update_id ?? this.now(),
          update.callbackQuery,
        );
      }
    });
  }

  private registerBotErrorHandler(): void {
    this.bot.catch?.((error) => {
      this.options.logger?.warn?.("telegram bot middleware failed", {
        error: errorMessage(error),
      });
    });
  }

  private get bot(): TelegramBotLike {
    if (this.options.bot) {
      return this.options.bot;
    }
    if (this.options.api) {
      return {
        api: this.options.api,
      };
    }
    this.defaultBot ??= adaptGrammyBot(
      new Bot(this.options.config.botToken) as unknown as TelegramGrammyBotLike,
    );
    return this.defaultBot;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private get fetch(): FetchLike {
    return this.options.fetch ?? fetch;
  }

}

export function createTelegramAdapter(
  config: TelegramMessagingConfig,
  store?: MessagingCallbackHandleStore,
  logger?: TelegramProviderLogger,
): TelegramAdapter {
  return new TelegramAdapter({
    config,
    logger,
    store,
  });
}

function uploadableFileParts(intent: MessagingSurfaceIntent): MessagingFilePart[] {
  if (intent.kind !== "message") {
    return [];
  }

  return intent.parts.filter(
    (part): part is MessagingFilePart =>
      part.type === "file" && (part.data !== undefined || Boolean(part.url)),
  );
}

function textForTelegramIntentWithoutFiles(intent: MessagingSurfaceIntent): string {
  if (intent.kind !== "message") {
    return textForTelegramIntent(intent);
  }

  return textForTelegramIntent({
    ...intent,
    parts: intent.parts.filter((part) => part.type !== "file"),
  });
}

function parseDataImageUrl(
  url: string,
): { filename: string; source: Uint8Array } | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(url);
  if (!match) {
    return undefined;
  }

  const mimeType = match[1]?.toLowerCase();
  const extension =
    mimeType === "image/jpeg"
      ? "jpg"
      : mimeType === "image/png"
        ? "png"
        : mimeType === "image/gif"
          ? "gif"
          : "img";
  return {
    filename: `assistant-image.${extension}`,
    source: new Uint8Array(Buffer.from(match[2] ?? "", "base64")),
  };
}

export function adaptGrammyBot(bot: TelegramGrammyBotLike): TelegramBotLike {
  return {
    api: {
      answerCallbackQuery: async (params) =>
        await bot.api.answerCallbackQuery(params.callback_query_id, {
          text: params.text,
        }),
      deleteWebhook: async (params) => await bot.api.deleteWebhook(params),
      editForumTopic: async (request) =>
        await bot.api.editForumTopic(
          request.chat_id,
          request.message_thread_id,
          {
            name: request.name,
          },
        ),
      editMessageText: async (request) => {
        const { chat_id, message_id, text, ...other } = request;
        return coerceTelegramSentMessage(
          await bot.api.editMessageText(chat_id, message_id, text, other),
          request,
        );
      },
      getMe: async () => await bot.api.getMe(),
      getWebhookInfo: async () => await bot.api.getWebhookInfo(),
      getFile: async (fileId) => await bot.api.getFile(fileId),
      pinChatMessage: async (request) => {
        const { chat_id, message_id, ...other } = request;
        return await bot.api.pinChatMessage(chat_id, message_id, other);
      },
      sendChatAction: async (request) => {
        const { chat_id, action, ...other } = request;
        return await bot.api.sendChatAction(chat_id, action, other);
      },
      sendMessage: async (request) => {
        const { chat_id, text, ...other } = request;
        return await bot.api.sendMessage(chat_id, text, other);
      },
      sendDocument: async (request) => {
        const { chat_id, document, filename, ...other } = request;
        const upload =
          typeof document === "string"
            ? document
            : new InputFile(Buffer.from(document), filename);
        return await bot.api.sendDocument(chat_id, upload, other);
      },
      sendPhoto: async (request) => {
        const { chat_id, filename, photo, ...other } = request;
        const upload =
          typeof photo === "string" ? photo : new InputFile(Buffer.from(photo), filename);
        return await bot.api.sendPhoto(chat_id, upload, other);
      },
      setMyCommands: async (params) =>
        await bot.api.setMyCommands(params.commands),
      unpinChatMessage: async (request) => {
        const { chat_id, message_id, ...other } = request;
        return await bot.api.unpinChatMessage(chat_id, message_id, other);
      },
    },
    catch: bot.catch?.bind(bot),
    handleUpdate: bot.handleUpdate?.bind(bot),
    on: bot.on?.bind(bot),
    start: bot.start?.bind(bot),
    stop: bot.stop?.bind(bot),
  };
}

function coerceTelegramSentMessage(
  result: TelegramSentMessage | boolean,
  request: TelegramEditMessageTextRequest,
): TelegramSentMessage {
  if (result && typeof result === "object") {
    return result;
  }
  return {
    chat: {
      id: Number(request.chat_id),
      type: "private",
    },
    message_id: request.message_id,
  };
}

function parseTelegramIdentifier(value: string): number | string {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && String(numeric) === value ? numeric : value;
}

function browseSessionIdForIntent(intent: MessagingSurfaceIntent): string | undefined {
  return intent.kind === "thread_picker" ||
    intent.kind === "project_picker" ||
    intent.kind === "confirmation"
    ? intent.browseSessionId
    : undefined;
}

function callbackAllowedActorIds(intent: MessagingSurfaceIntent): string[] {
  return intent.allowedActorIds && intent.allowedActorIds.length > 0
    ? intent.allowedActorIds
    : [intent.audit?.actor.platformUserId ?? "unknown"];
}

function callbackBindingId(intent: MessagingSurfaceIntent): string | undefined {
  return intent.audit?.bindingId ?? intent.bindingId;
}

function telegramCallbackRecordId(
  handle: string,
  intent: MessagingSurfaceIntent,
): string {
  const conversation = intent.audit?.channel.conversation;
  const deliveryScope = createHash("sha256")
    .update(
      JSON.stringify([
        intent.audit?.channel.channel ?? "telegram",
        conversation?.id ?? null,
        conversation?.parentId ?? null,
        intent.audit?.bindingId ?? intent.bindingId ?? null,
      ]),
    )
    .digest("base64url")
    .slice(0, 18);
  return `telegram-callback:${handle}:${deliveryScope}`;
}

/**
 * If `text` starts with `@<botUsername>` (case-insensitive, optional
 * leading whitespace), return the rest of the message with that
 * prefix stripped and trimmed. Otherwise return `undefined`.
 *
 * Used to detect `@PwrAgent <verb>` text-mention commands so the
 * adapter can dispatch them through the same command pathway as
 * slash commands. Telegram usernames are case-insensitive (server
 * normalizes), so we lower-case both sides before comparing.
 *
 * Returns `undefined` when:
 *   - `botUsername` is unset (adapter hasn't `start()`'d yet, or
 *     `getMe()` failed at startup)
 *   - the message doesn't begin with the mention
 *   - a longer username token follows `@<botUsername>` (so
 *     `@pwragent2` doesn't match `@pwragent`)
 *   - the mention is the entire message (no command verb following)
 */
export function stripTelegramBotMention(
  text: string,
  botUsername: string | undefined,
): string | undefined {
  if (!botUsername) {
    return undefined;
  }
  const trimmedStart = text.replace(/^\s+/, "");
  const mention = `@${botUsername}`;
  if (trimmedStart.length < mention.length) {
    return undefined;
  }
  if (trimmedStart.slice(0, mention.length).toLowerCase() !== mention.toLowerCase()) {
    return undefined;
  }
  // Word-boundary check: anything after the mention prefix must be
  // whitespace or end-of-string. Telegram usernames are
  // [A-Za-z0-9_]{5,32}, so `@pwragent2` continuing with `2` would
  // be a different bot — not us.
  const after = trimmedStart.charAt(mention.length);
  if (after !== "" && !/\s/.test(after)) {
    return undefined;
  }
  const remainder = trimmedStart.slice(mention.length).trim();
  if (remainder.length === 0) {
    return undefined;
  }
  return remainder;
}

function sanitizeTelegramTopicName(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  return Array.from(normalized || "PwrAgent thread").slice(0, 128).join("");
}

function telegramGroupStreamMinIntervalMs(deliveriesInWindow: number): number {
  if (deliveriesInWindow < TELEGRAM_STREAM_GROUP_FAST_COUNT) {
    return TELEGRAM_STREAM_GROUP_FAST_INTERVAL_MS;
  }
  if (deliveriesInWindow < TELEGRAM_STREAM_GROUP_MEDIUM_COUNT) {
    return TELEGRAM_STREAM_GROUP_MEDIUM_INTERVAL_MS;
  }
  return TELEGRAM_STREAM_GROUP_SLOW_INTERVAL_MS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTelegramMessageNotModifiedError(error: unknown): boolean {
  const text = [
    errorMessage(error),
    diagnosticErrorMessage(readErrorProperty(error)),
    readStringProperty(error, "description"),
    readStringProperty(readErrorProperty(error), "description"),
  ]
    .filter((message): message is string => Boolean(message))
    .join("\n")
    .toLowerCase();
  return text.includes("message is not modified");
}

function telegramRetryAfterMs(error: unknown): number | undefined {
  const seconds =
    telegramRetryAfterSeconds(error) ??
    telegramRetryAfterSeconds(readErrorProperty(error));
  return seconds !== undefined && seconds > 0
    ? Math.ceil(seconds * 1000)
    : undefined;
}

function telegramRetryAfterSeconds(value: unknown): number | undefined {
  return (
    readNumberProperty(value, "retry_after") ??
    readNumberProperty(readObjectProperty(value, "parameters"), "retry_after") ??
    readNumberProperty(
      readObjectProperty(readObjectProperty(value, "payload"), "parameters"),
      "retry_after",
    ) ??
    readNumberProperty(
      readObjectProperty(readObjectProperty(value, "response"), "parameters"),
      "retry_after",
    )
  );
}

function compactIdentifier(value: string): string {
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function telegramBotTokenDiagnostics(token: string): Record<string, unknown> {
  const trimmed = token.trim();
  const [botId = "", secret = ""] = trimmed.split(":", 2);
  return {
    length: token.length,
    trimmedLength: trimmed.length,
    hasColon: trimmed.includes(":"),
    hasSurroundingWhitespace: token !== trimmed,
    hasAnyWhitespace: /\s/.test(token),
    botIdLength: botId.length,
    botIdIsNumeric: /^\d+$/.test(botId),
    secretLength: secret.length,
    secretPresent: secret.length > 0,
    matchesExpectedShape: /^\d+:[^\s:]+$/.test(trimmed),
  };
}

function telegramHttpErrorDiagnostics(error: unknown): Record<string, unknown> {
  const inner = readErrorProperty(error);
  const status = readNumberProperty(inner, "status") ?? readNumberProperty(error, "status");
  const statusText =
    readStringProperty(inner, "statusText") ?? readStringProperty(error, "statusText");
  const code = readStringProperty(inner, "code") ?? readStringProperty(error, "code");
  const innerMessage = diagnosticErrorMessage(inner);
  return {
    ...(status !== undefined ? { status } : {}),
    ...(statusText !== undefined ? { statusText } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(inner !== undefined ? { cause: innerMessage } : {}),
  };
}

function readErrorProperty(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("error" in error)) {
    return undefined;
  }
  return (error as { error?: unknown }).error;
}

function readObjectProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return property && typeof property === "object" ? property : undefined;
}

function diagnosticErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : undefined;
}

function readNumberProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "number" ? property : undefined;
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : undefined;
}

function compactPreview(text: string, limit = 96): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const preview = compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
  return preview.replace(/["\\]/g, "\\$&");
}

function telegramServiceMessageReason(message: TelegramMessage): string | undefined {
  if (message.pinned_message) {
    return "pin";
  }
  if (message.forum_topic_created) {
    return "forum_topic_created";
  }
  if (message.forum_topic_edited) {
    return "forum_topic_edited";
  }
  if (message.forum_topic_closed) {
    return "forum_topic_closed";
  }
  if (message.forum_topic_reopened) {
    return "forum_topic_reopened";
  }
  if (message.general_forum_topic_hidden) {
    return "general_forum_topic_hidden";
  }
  if (message.general_forum_topic_unhidden) {
    return "general_forum_topic_unhidden";
  }
  return undefined;
}
