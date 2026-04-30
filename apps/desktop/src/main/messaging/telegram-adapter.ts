import { createHash } from "node:crypto";
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
  buildTelegramKeyboard,
  splitTelegramHtml,
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  textForTelegramIntent,
} from "./telegram-formatting";

const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query"];
const TELEGRAM_LONG_POLL_TIMEOUT_SECONDS = 25;
const TRANSIENT_ERROR_BACKOFF_MS = 2_000;

type TelegramCallbackBinding = {
  actionId: string;
  value?: MessagingJsonValue;
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
    },
  ) {}

  async start(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void> {
    this.listener = listener;
    this.stopped = false;

    const webhookInfo = await this.api.getWebhookInfo();
    if (webhookInfo.url) {
      throw new Error(
        "Telegram webhook is configured; disable the webhook before using local long polling.",
      );
    }

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
    if (intent.kind === "dismiss") {
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "unsupported",
      };
    }

    const target = this.resolveTarget(intent);
    if (!target) {
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        errorMessage: "Telegram delivery target is missing.",
        outcome: "failed",
      };
    }

    const actions = actionsForTelegramIntent(intent);
    const replyMarkup = buildTelegramKeyboard(actions, (action) =>
      this.createCallbackData(intent, action),
    );
    const text = textForTelegramIntent(intent);
    const image = this.firstImageUrl(intent);
    const sentMessages: TelegramSentMessage[] = [];

    if (image) {
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
    return {
      channel: this.channel,
      deliveredAt: this.now(),
      outcome: "presented",
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

    const binding = callbackQuery.data
      ? this.callbackBindings.get(callbackQuery.data)
      : undefined;
    await listener({
      id: `telegram:update:${updateId}:callback:${callbackQuery.id}`,
      kind: "callback",
      actor: this.actorFromUser(callbackQuery.from),
      channel: this.channelFromMessage(message),
      interaction: {
        channel: this.channel,
        id: callbackQuery.data ?? "",
        state: {
          opaque: {
            callbackData: callbackQuery.data ?? null,
          },
        },
      },
      actionId: binding?.actionId,
      value: binding?.value,
      receivedAt: this.now(),
      routingState: this.routingStateFromMessage(message),
    });
  }

  private createCallbackData(
    intent: MessagingSurfaceIntent,
    action: MessagingSurfaceAction,
  ): string {
    const handle = `tg:${createHash("sha256")
      .update(`${intent.id}:${action.id}`)
      .digest("base64url")
      .slice(0, 18)}`;
    if (Buffer.byteLength(handle, "utf8") > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES) {
      throw new Error("Telegram callback handle exceeds callback_data limit.");
    }

    this.callbackBindings.set(handle, {
      actionId: action.id,
      value: action.value,
    });
    return handle;
  }

  private resolveTarget(
    intent: MessagingSurfaceIntent,
  ): { chatId: number | string; messageThreadId?: number } | undefined {
    const opaque = intent.audit?.channel
      ? this.telegramStateFromChannel(intent.audit.channel.conversation)
      : this.telegramStateFromSurface(intent.targetSurface?.state);
    return opaque;
  }

  private telegramStateFromChannel(channel: {
    id: string;
    parentId?: string;
  }): { chatId: number | string; messageThreadId?: number } | undefined {
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
  ): { chatId: number | string; messageThreadId?: number } | undefined {
    const opaque = state?.opaque;
    if (!opaque || typeof opaque !== "object" || Array.isArray(opaque)) {
      return undefined;
    }

    const chatId = opaque.chatId;
    const messageThreadId = opaque.messageThreadId;
    if (typeof chatId !== "string" && typeof chatId !== "number") {
      return undefined;
    }

    return {
      chatId,
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
): TelegramAdapter {
  return new TelegramAdapter({
    config,
  });
}

function parseTelegramIdentifier(value: string): number | string {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && String(numeric) === value ? numeric : value;
}
