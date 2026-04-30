import { createHash } from "node:crypto";
import type { MessagingStore } from "@pwragnt/agent-core";
import type {
  MessagingAdapterState,
  MessagingDeliveryResult,
  MessagingInboundEvent,
  MessagingJsonValue,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
} from "@pwragnt/shared";
import type { DesktopMessagingAdapter } from "./messaging-runtime";
import type { TelegramMessagingConfig } from "./messaging-config";
import {
  TelegramApi,
  TelegramApiError,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramSentMessage,
  type TelegramUpdate,
} from "./telegram-api";
import {
  actionsForTelegramIntent,
  splitTelegramHtml,
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  type TelegramInlineKeyboardMarkup,
  textForTelegramIntent,
} from "./telegram-formatting";

const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query"];
const TELEGRAM_LONG_POLL_TIMEOUT_SECONDS = 25;
const TRANSIENT_ERROR_BACKOFF_MS = 2_000;

type TelegramCallbackBinding = {
  actionId: string;
  value?: MessagingJsonValue;
};

type TelegramDeliveryTarget = {
  chatId: number | string;
  messageId?: number;
  messageThreadId?: number;
};

export class TelegramAdapter implements DesktopMessagingAdapter {
  readonly channel = "telegram" as const;

  private callbackBindings = new Map<string, TelegramCallbackBinding>();
  private defaultApi?: TelegramApi;
  private listener?: (event: MessagingInboundEvent) => Promise<void>;
  private nextOffset: number | undefined;
  private stopped = true;
  private pollLoop?: Promise<void>;

  constructor(
    private readonly options: {
      api?: TelegramApi;
      config: TelegramMessagingConfig;
      now?: () => number;
      pollOnStart?: boolean;
      sleep?: (ms: number) => Promise<void>;
      store?: MessagingStore;
    },
  ) {}

  async start(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void> {
    this.listener = listener;
    this.stopped = false;

    const webhookInfo = await this.api.getWebhookInfo();
    if (webhookInfo.url) {
      await this.api.deleteWebhook({
        drop_pending_updates: false,
      });
    }
    await this.api.setMyCommands({
      commands: [
        {
          command: "resume",
          description: "Resume or start a PwrAgnt thread",
        },
        {
          command: "threads",
          description: "Choose a PwrAgnt thread",
        },
        {
          command: "status",
          description: "Show the current PwrAgnt binding",
        },
        {
          command: "detach",
          description: "Detach this chat from PwrAgnt",
        },
        {
          command: "bind",
          description: "Bind this chat to a PwrAgnt thread",
        },
      ],
    });

    if (this.options.pollOnStart !== false) {
      this.pollLoop = this.runPollLoop();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.pollLoop;
    this.pollLoop = undefined;
    this.listener = undefined;
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

    if (intent.kind === "dismiss") {
      if (intent.delivery?.unpin && target.messageId) {
        await this.api.unpinChatMessage({
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
    const text = textForTelegramIntent(intent);
    const image = this.firstImageUrl(intent);
    const sentMessages: TelegramSentMessage[] = [];
    let outcome: MessagingDeliveryResult["outcome"] = "presented";

    if (
      intent.delivery?.mode === "update" &&
      target.messageId &&
      !image &&
      Buffer.byteLength(text || " ", "utf8") <= 4096
    ) {
      try {
        sentMessages.push(
          await this.api.editMessageText({
            chat_id: target.chatId,
            disable_web_page_preview: true,
            message_id: target.messageId,
            message_thread_id: target.messageThreadId,
            parse_mode: "HTML",
            reply_markup: replyMarkup,
            text: text || " ",
          }),
        );
        outcome = "updated";
      } catch (error) {
        if (intent.delivery.fallback !== "present_new") {
          throw error;
        }
        sentMessages.push(
          await this.api.sendMessage({
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
    } else if (image) {
      sentMessages.push(
        await this.api.sendPhoto({
          caption: text.slice(0, 1024) || undefined,
          chat_id: target.chatId,
          message_thread_id: target.messageThreadId,
          parse_mode: text ? "HTML" : undefined,
          photo: image,
          reply_markup: replyMarkup,
        }),
      );
    } else {
      const chunks = splitTelegramHtml(text || " ");
      const lastChunkIndex = chunks.length - 1;
      for (const [index, chunk] of chunks.entries()) {
        sentMessages.push(
          await this.api.sendMessage({
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
        await this.api.pinChatMessage({
          chat_id: target.chatId,
          disable_notification: true,
          message_id: lastMessage.message_id,
        });
        outcome = "pinned";
      } catch {
        // Keep the visible status message even if the chat cannot pin it.
      }
    }

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

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      await this.handleMessage(update.update_id, update.message);
      return;
    }

    if (update.callback_query) {
      await this.handleCallbackQuery(update.update_id, update.callback_query);
    }
  }

  private async runPollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.api.getUpdates({
          allowed_updates: TELEGRAM_ALLOWED_UPDATES,
          offset: this.nextOffset,
          timeout: TELEGRAM_LONG_POLL_TIMEOUT_SECONDS,
        });

        for (const update of updates) {
          this.nextOffset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (this.stopped) {
          return;
        }
        const retryAfterMs =
          error instanceof TelegramApiError && error.details.retryAfterSeconds
            ? error.details.retryAfterSeconds * 1000
            : TRANSIENT_ERROR_BACKOFF_MS;
        await this.sleep(retryAfterMs);
      }
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

    if (message.pinned_message || this.isOwnBotUser(message.from)) {
      return;
    }

    if (!message.text) {
      await listener({
        id: `telegram:update:${updateId}:message:${message.message_id}`,
        kind: "media",
        actor: this.actorFromUser(message.from),
        channel: this.channelFromMessage(message),
        disposition: "unsupported",
        media: {
          type: "file",
          name:
            message.document?.file_name ??
            message.voice?.mime_type ??
            message.video?.mime_type ??
            "telegram-media",
          mimeType:
            message.document?.mime_type ??
            message.voice?.mime_type ??
            message.video?.mime_type,
        },
        receivedAt: this.messageReceivedAt(message),
        routingState: this.routingStateFromMessage(message),
      });
      return;
    }

    const commandMatch = /^\/([A-Za-z0-9_]+)(?:@\S+)?(?:\s+(.*))?$/.exec(message.text);
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
    await this.api.answerCallbackQuery({
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

  private async buildReplyMarkup(
    intent: MessagingSurfaceIntent,
    actions: MessagingSurfaceAction[],
  ): Promise<TelegramInlineKeyboardMarkup | undefined> {
    const buttons = await Promise.all(
      actions
        .filter((action) => !action.disabled)
        .map(async (action) => ({
          text: action.label,
          callback_data: await this.createCallbackData(intent, action),
        })),
    );

    if (buttons.length === 0) {
      return undefined;
    }

    return {
      inline_keyboard: buttons.map((button) => [button]),
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

  private firstImageUrl(intent: MessagingSurfaceIntent): string | undefined {
    if (intent.kind !== "message") {
      return undefined;
    }

    return intent.parts.find((part) => part.type === "image" && "url" in part)?.url;
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

  private get api(): TelegramApi {
    this.defaultApi ??= new TelegramApi({ botToken: this.options.config.botToken });
    return this.options.api ?? this.defaultApi;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async sleep(ms: number): Promise<void> {
    await (this.options.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms)));
  }
}

export function createTelegramAdapter(
  config: TelegramMessagingConfig,
  store?: MessagingStore,
): TelegramAdapter {
  return new TelegramAdapter({
    config,
    store,
  });
}

function parseTelegramIdentifier(value: string): number | string {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && String(numeric) === value ? numeric : value;
}
