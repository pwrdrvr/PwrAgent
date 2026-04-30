import type { TelegramInlineKeyboardMarkup } from "./telegram-formatting";

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
  chat: TelegramChat;
  date?: number;
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
  };
  from?: TelegramUser;
  message_id: number;
  message_thread_id?: number;
  photo?: Array<{
    file_id: string;
    file_size?: number;
  }>;
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

export type TelegramWebhookInfo = {
  url: string;
};

export type TelegramBotCommand = {
  command: string;
  description: string;
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

export type TelegramSendPhotoRequest = {
  caption?: string;
  chat_id: number | string;
  message_thread_id?: number;
  parse_mode?: "HTML";
  photo: string;
  reply_markup?: TelegramInlineKeyboardMarkup;
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

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly details: {
      description?: string;
      errorCode?: number;
      method: string;
      retryAfterSeconds?: number;
    },
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export type TelegramApiFetch = typeof fetch;

export class TelegramApi {
  private readonly baseUrl: string;

  constructor(
    private readonly options: {
      botToken: string;
      fetch?: TelegramApiFetch;
      baseUrl?: string;
    },
  ) {
    this.baseUrl =
      options.baseUrl?.replace(/\/$/, "") ??
      `https://api.telegram.org/bot${options.botToken}`;
  }

  async getWebhookInfo(): Promise<TelegramWebhookInfo> {
    return await this.request<TelegramWebhookInfo>("getWebhookInfo", {});
  }

  async deleteWebhook(params: { drop_pending_updates?: boolean } = {}): Promise<boolean> {
    return await this.request<boolean>("deleteWebhook", params);
  }

  async setMyCommands(params: { commands: TelegramBotCommand[] }): Promise<boolean> {
    return await this.request<boolean>("setMyCommands", params);
  }

  async getUpdates(params: {
    allowed_updates?: string[];
    limit?: number;
    offset?: number;
    timeout?: number;
  }): Promise<TelegramUpdate[]> {
    return await this.request<TelegramUpdate[]>("getUpdates", params);
  }

  async sendMessage(
    request: TelegramSendMessageRequest,
  ): Promise<TelegramSentMessage> {
    return await this.request<TelegramSentMessage>("sendMessage", request);
  }

  async editMessageText(
    request: TelegramEditMessageTextRequest,
  ): Promise<TelegramSentMessage> {
    return await this.request<TelegramSentMessage>("editMessageText", request);
  }

  async editMessageReplyMarkup(
    request: Pick<
      TelegramEditMessageTextRequest,
      "chat_id" | "message_id" | "message_thread_id" | "reply_markup"
    >,
  ): Promise<TelegramSentMessage> {
    return await this.request<TelegramSentMessage>("editMessageReplyMarkup", request);
  }

  async sendPhoto(request: TelegramSendPhotoRequest): Promise<TelegramSentMessage> {
    return await this.request<TelegramSentMessage>("sendPhoto", request);
  }

  async pinChatMessage(request: TelegramPinChatMessageRequest): Promise<boolean> {
    return await this.request<boolean>("pinChatMessage", request);
  }

  async unpinChatMessage(request: TelegramUnpinChatMessageRequest): Promise<boolean> {
    return await this.request<boolean>("unpinChatMessage", request);
  }

  async answerCallbackQuery(params: {
    callback_query_id: string;
    text?: string;
  }): Promise<boolean> {
    return await this.request<boolean>("answerCallbackQuery", params);
  }

  private async request<T>(method: string, body: unknown): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}/${method}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    const payload = (await response.json()) as {
      description?: string;
      error_code?: number;
      ok: boolean;
      parameters?: {
        retry_after?: number;
      };
      result?: T;
    };

    if (!response.ok || !payload.ok) {
      throw new TelegramApiError(payload.description ?? `Telegram ${method} failed`, {
        description: payload.description,
        errorCode: payload.error_code ?? response.status,
        method,
        retryAfterSeconds: payload.parameters?.retry_after,
      });
    }

    return payload.result as T;
  }
}
