import { REST, Routes } from "discord.js";
import type { DiscordActionRowComponent } from "./discord-formatting.ts";

export type DiscordAllowedMentions = {
  parse: string[];
  replied_user?: boolean;
  roles?: string[];
  users?: string[];
};

export type DiscordCreateMessageRequest = {
  allowed_mentions: DiscordAllowedMentions;
  components?: DiscordActionRowComponent[];
  content: string;
  embeds?: Array<{
    image?: {
      url: string;
    };
  }>;
};

export type DiscordMessage = {
  channel_id: string;
  content?: string;
  guild_id?: string;
  id: string;
};

export type DiscordInteractionResponseRequest = {
  data?: DiscordCreateMessageRequest;
  type: 4 | 6 | 7;
};

export class DiscordApiError extends Error {
  readonly details: {
    errorCode?: number;
    method: string;
    retryAfterSeconds?: number;
  };

  constructor(
    message: string,
    details: {
      errorCode?: number;
      method: string;
      retryAfterSeconds?: number;
    },
  ) {
    super(message);
    this.name = "DiscordApiError";
    this.details = details;
  }
}

export type DiscordApiFetch = typeof fetch;

export class DiscordApi {
  private readonly baseUrl: string;
  private readonly options: {
    botToken: string;
    fetch?: DiscordApiFetch;
    baseUrl?: string;
  };
  private readonly rest?: REST;

  constructor(options: DiscordApi["options"]) {
    this.options = options;
    this.baseUrl = options.baseUrl?.replace(/\/$/, "") ?? "https://discord.com/api/v10";
    this.rest =
      options.fetch || options.baseUrl
        ? undefined
        : new REST({ version: "10" }).setToken(options.botToken);
  }

  async createMessage(
    channelId: string,
    request: DiscordCreateMessageRequest,
  ): Promise<DiscordMessage> {
    if (this.rest) {
      return (await this.rest.post(Routes.channelMessages(channelId), {
        body: request,
      })) as DiscordMessage;
    }

    return await this.request<DiscordMessage>(
      "POST",
      `/channels/${encodeURIComponent(channelId)}/messages`,
      request,
    );
  }

  async createInteractionResponse(
    interactionId: string,
    interactionToken: string,
    request: DiscordInteractionResponseRequest,
  ): Promise<void> {
    if (this.rest) {
      await this.rest.post(Routes.interactionCallback(interactionId, interactionToken), {
        body: request,
      });
      return;
    }

    await this.request<void>(
      "POST",
      `/interactions/${encodeURIComponent(interactionId)}/${encodeURIComponent(
        interactionToken,
      )}/callback`,
      request,
      { emptyOk: true },
    );
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    options: { emptyOk?: boolean } = {},
  ): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}${path}`, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bot ${this.options.botToken}`,
        "content-type": "application/json",
      },
      method,
    });
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;

    if (!response.ok) {
      throw new DiscordApiError(
        typeof payload?.message === "string"
          ? payload.message
          : `Discord ${method} ${path} failed`,
        {
          errorCode:
            typeof payload?.code === "number" ? payload.code : response.status,
          method: `${method} ${path}`,
          retryAfterSeconds:
            typeof payload?.retry_after === "number"
              ? payload.retry_after
              : undefined,
        },
      );
    }

    if (!text && options.emptyOk) {
      return undefined as T;
    }

    return payload as T;
  }
}

export function defensiveAllowedMentions(): DiscordAllowedMentions {
  return {
    parse: [],
    replied_user: false,
    roles: [],
    users: [],
  };
}
