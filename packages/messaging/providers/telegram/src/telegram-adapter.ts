import { createHash } from "node:crypto";
import { Bot, InputFile } from "grammy";
import type {
  MessagingAdapterState,
  MessagingAdapterCapabilities,
  MessagingAttachmentDescriptor,
  MessagingAttachmentDownloadRequest,
  MessagingAttachmentDownloadResult,
  MessagingCallbackHandleStore,
  MessagingConversationTitleUpdateRequest,
  MessagingConversationTitleUpdateResult,
  MessagingDeliveryResult,
  MessagingFilePart,
  MessagingInboundEvent,
  MessagingJsonValue,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
} from "@pwragnt/messaging-interface";
import { layoutMessagingActionRows } from "@pwragnt/messaging-interface";
import type { TelegramMessagingConfig } from "./telegram-config.ts";
import {
  actionsForTelegramIntent,
  splitTelegramHtml,
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  type TelegramInlineKeyboardMarkup,
  textForTelegramIntent,
} from "./telegram-formatting.ts";

const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query"];
const TELEGRAM_DEFAULT_TYPING_SIGNAL_LEASE_MS = 15_000;
const TELEGRAM_TYPING_SIGNAL_INTERVAL_MS = 4_000;

type TelegramCallbackBinding = {
  actionId: string;
  value?: MessagingJsonValue;
};

type TelegramDeliveryTarget = {
  chatId: number | string;
  messageId?: number;
  messageThreadId?: number;
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
  handleUpdate?(update: TelegramUpdate): Promise<void>;
  on?(filter: string, handler: (context: unknown) => void | Promise<void>): void;
  start?(options?: { allowed_updates?: string[] }): Promise<void>;
  stop?(): void | Promise<void>;
};

export type TelegramProviderAdapter = {
  authorizedActorIds: readonly string[];
  capabilities?: MessagingAdapterCapabilities;
  channel: "telegram";
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  downloadAttachment?(
    request: MessagingAttachmentDownloadRequest,
  ): Promise<MessagingAttachmentDownloadResult>;
  setConversationTitle(
    request: MessagingConversationTitleUpdateRequest,
  ): Promise<MessagingConversationTitleUpdateResult>;
  start?(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void>;
  stop?(): Promise<void>;
};

export class TelegramAdapter implements TelegramProviderAdapter {
  readonly channel = "telegram" as const;
  readonly capabilities: MessagingAdapterCapabilities = {
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

  private callbackBindings = new Map<string, TelegramCallbackBinding>();
  private defaultBot?: TelegramBotLike;
  private listener?: (event: MessagingInboundEvent) => Promise<void>;
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
  private typingSignalSequence = 0;
  private typingSignals = new Map<string, TelegramTypingSignal>();

  constructor(options: TelegramAdapter["options"]) {
    this.options = options;
  }

  get authorizedActorIds(): readonly string[] {
    return this.options.config.authorizedActorIds;
  }

  async start(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void> {
    this.listener = listener;

    this.registerBotHandlers();

    const webhookInfo = await this.bot.api.getWebhookInfo();
    if (webhookInfo.url) {
      await this.bot.api.deleteWebhook({
        drop_pending_updates: false,
      });
    }
    await this.bot.api.setMyCommands({
      commands: [
        {
          command: "resume",
          description: "Resume or start a PwrAgnt thread",
        },
        {
          command: "status",
          description: "Show the current PwrAgnt binding",
        },
        {
          command: "detach",
          description: "Detach this chat from PwrAgnt",
        },
      ],
    });

    if (this.options.pollOnStart !== false) {
      this.startPromise = this.bot.start?.({
        allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
      });
    }
  }

  async stop(): Promise<void> {
    this.stopTypingSignals();
    await this.bot.stop?.();
    await this.startPromise?.catch(() => undefined);
    this.startPromise = undefined;
    this.listener = undefined;
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

    const serviceMessageReason = telegramServiceMessageReason(message);
    if (serviceMessageReason || this.isOwnBotUser(message.from)) {
      this.options.logger?.debug(
        `telegram inbound ignored update=${updateId} message=${message.message_id} reason=${serviceMessageReason ?? "own_bot"} chat=${message.chat.id}`,
      );
      return;
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
    await this.bot.api.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
    });

    const listener = this.listener;
    const message = callbackQuery.message;
    if (!listener || !message) {
      return;
    }

    const channel = this.channelFromMessage(message);
    const binding = callbackQuery.data
      ? this.callbackBindings.get(callbackQuery.data)
      : undefined;
    const persistedBinding =
      !binding && callbackQuery.data && this.options.store
        ? await this.options.store.resolveCallbackHandle({
            actorId: String(callbackQuery.from.id),
            channel,
            handle: callbackQuery.data,
            now: this.now(),
          })
        : undefined;
    this.options.logger?.debug(
      `telegram inbound callback update=${updateId} callback=${callbackQuery.id} chat=${message.chat.id} actor=${callbackQuery.from.id} action=${binding?.actionId ?? persistedBinding?.actionId ?? "unresolved"}`,
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
      actionId: binding?.actionId ?? persistedBinding?.actionId,
      value: binding?.value ?? persistedBinding?.value,
      receivedAt: this.now(),
      routingState: this.routingStateFromMessage(message),
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
    const items = await Promise.all(
      actions
        .filter((action) => !action.disabled)
        .map(async (action) => ({
          action,
          component: {
            text: action.label,
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
        maxColumns: 8,
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

    this.callbackBindings.set(handle, {
      actionId: action.id,
      value: action.value,
    });
    if (this.options.store && intent.audit) {
      await this.options.store.upsertCallbackHandle({
        id: `telegram-callback:${handle}`,
        actionId: action.id,
        allowedActorIds: [intent.audit.actor.platformUserId],
        bindingId: intent.bindingId,
        channel: intent.audit.channel,
        createdAt: this.now(),
        expiresAt: this.now() + 15 * 60 * 1000,
        handle,
        pendingIntentId: intent.id,
        surface: intent.targetSurface,
        updatedAt: this.now(),
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

  private compactTypingTarget(target: TelegramDeliveryTarget): string {
    return target.messageThreadId
      ? `${target.chatId}/${target.messageThreadId}`
      : String(target.chatId);
  }

  private channelFromMessage(message: TelegramMessage): MessagingInboundEvent["channel"] {
    if (message.message_thread_id) {
      return {
        channel: this.channel,
        conversation: {
          id: String(message.message_thread_id),
          kind: "topic",
          parentId: String(message.chat.id),
          title: message.chat.title,
        },
      };
    }

    return {
      channel: this.channel,
      conversation: {
        id: String(message.chat.id),
        kind: message.chat.type === "private" ? "dm" : "channel",
        title: message.chat.title,
      },
    };
  }

  private actorFromUser(user: TelegramMessage["from"]): MessagingInboundEvent["actor"] {
    return {
      platformUserId: String(user?.id ?? "unknown"),
      displayName: [user?.first_name, user?.last_name].filter(Boolean).join(" ") || undefined,
      isBot: user?.is_bot,
      username: user?.username,
    };
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

function sanitizeTelegramTopicName(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  return Array.from(normalized || "PwrAgnt thread").slice(0, 128).join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
