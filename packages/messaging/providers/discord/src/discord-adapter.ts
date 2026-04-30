import { createHash } from "node:crypto";
import type {
  MessagingAdapterState,
  MessagingDeliveryResult,
  MessagingInboundEvent,
  MessagingJsonValue,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
} from "@pwragnt/messaging-interface";
import type { DiscordMessagingConfig } from "./discord-config.ts";
import {
  defensiveAllowedMentions,
  DiscordApi,
  type DiscordCreateMessageRequest,
  type DiscordMessage,
} from "./discord-api.ts";
import {
  actionsForDiscordIntent,
  buildDiscordComponents,
  DISCORD_COMPONENT_CUSTOM_ID_LIMIT_BYTES,
  splitDiscordContent,
  textForDiscordIntent,
} from "./discord-formatting.ts";
import {
  DiscordGateway,
  type DiscordGatewayConnection,
  type DiscordGatewayEvent,
  type DiscordInteractionCreateDispatch,
  type DiscordMessageCreateDispatch,
  type DiscordUser,
} from "./discord-gateway.ts";

type DiscordComponentBinding = {
  actionId: string;
  value?: MessagingJsonValue;
};

export type DiscordProviderAdapter = {
  channel: "discord";
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  start?(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void>;
  stop?(): Promise<void>;
};

export class DiscordAdapter implements DiscordProviderAdapter {
  readonly channel = "discord" as const;

  private componentBindings = new Map<string, DiscordComponentBinding>();
  private defaultApi?: DiscordApi;
  private defaultGateway?: DiscordGatewayConnection;
  private listener?: (event: MessagingInboundEvent) => Promise<void>;
  private readonly options: {
    api?: DiscordApi;
    config: DiscordMessagingConfig;
    gateway?: DiscordGatewayConnection;
    now?: () => number;
  };
  private unsubscribeGateway?: () => void;

  constructor(options: DiscordAdapter["options"]) {
    this.options = options;
  }

  async start(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void> {
    if (this.options.config.messageContentIntent === false) {
      throw new Error(
        "Discord message content intent is required for free-form PwrAgnt control.",
      );
    }

    this.listener = listener;
    this.unsubscribeGateway = this.gateway.onEvent(async (event) => {
      await this.handleGatewayEvent(event);
    });
    await this.gateway.start();
  }

  async stop(): Promise<void> {
    this.unsubscribeGateway?.();
    this.unsubscribeGateway = undefined;
    this.listener = undefined;
    await this.gateway.close();
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
        errorMessage: "Discord delivery target is missing.",
        outcome: "failed",
      };
    }

    const components = buildDiscordComponents(
      actionsForDiscordIntent(intent),
      (action) => this.createCustomId(intent, action),
    );
    const imageUrl = this.firstImageUrl(intent);
    const chunks = splitDiscordContent(textForDiscordIntent(intent) || " ");
    const messages: DiscordMessage[] = [];

    for (const [index, chunk] of chunks.entries()) {
      const request: DiscordCreateMessageRequest = {
        allowed_mentions: defensiveAllowedMentions(),
        components: index === chunks.length - 1 ? components : undefined,
        content: chunk,
        embeds:
          index === chunks.length - 1 && imageUrl
            ? [
                {
                  image: {
                    url: imageUrl,
                  },
                },
              ]
            : undefined,
      };
      messages.push(await this.api.createMessage(target.channelId, request));
    }

    const lastMessage = messages.at(-1);
    return {
      channel: this.channel,
      deliveredAt: this.now(),
      outcome: "presented",
      surface: lastMessage
        ? {
            channel: this.channel,
            id: lastMessage.id,
            state: {
              opaque: {
                channelId: target.channelId,
                guildId: target.guildId ?? null,
                messageId: lastMessage.id,
              },
            },
          }
        : undefined,
    };
  }

  async handleGatewayEvent(event: DiscordGatewayEvent): Promise<void> {
    if (event.t === "MESSAGE_CREATE") {
      await this.handleMessageCreate(event.d);
      return;
    }

    if (event.t === "INTERACTION_CREATE") {
      await this.handleInteractionCreate(event.d);
    }
  }

  private async handleMessageCreate(message: DiscordMessageCreateDispatch): Promise<void> {
    const listener = this.listener;
    if (!listener || message.author.bot) {
      return;
    }

    const channel = this.channelFromDiscord(message.channel_id, message.guild_id);
    const receivedAt = this.now();
    const routingState = this.routingStateFromDiscord(message.channel_id, message.guild_id);

    if (message.attachments && message.attachments.length > 0) {
      const attachment = message.attachments[0]!;
      await listener({
        id: `discord:message:${message.id}`,
        kind: "media",
        actor: this.actorFromUser(message.author),
        channel,
        disposition: "unsupported",
        media: {
          type: "file",
          name: attachment.filename,
          mimeType: attachment.content_type,
          sizeBytes: attachment.size,
        },
        receivedAt,
        routingState,
      });
      return;
    }

    if (message.content === undefined) {
      throw new Error(
        "Discord message content is unavailable; enable the privileged message content intent.",
      );
    }

    const commandMatch = /^\/([A-Za-z0-9_]+)(?:\s+(.*))?$/.exec(message.content);
    await listener({
      id: `discord:message:${message.id}`,
      kind: commandMatch ? "command" : "text",
      actor: this.actorFromUser(message.author),
      channel,
      ...(commandMatch
        ? {
            args: commandMatch[2]?.split(/\s+/).filter(Boolean) ?? [],
            command: commandMatch[1]?.toLowerCase() ?? "",
            rawText: message.content,
          }
        : {
            text: message.content,
          }),
      receivedAt,
      routingState,
    } as MessagingInboundEvent);
  }

  private async handleInteractionCreate(
    interaction: DiscordInteractionCreateDispatch,
  ): Promise<void> {
    await this.api.createInteractionResponse(interaction.id, interaction.token, {
      type: 6,
    });

    const listener = this.listener;
    const actor = interaction.member?.user ?? interaction.user;
    if (!listener || !actor) {
      return;
    }

    const customId = interaction.data?.custom_id ?? "";
    const binding = this.componentBindings.get(customId);
    await listener({
      id: `discord:interaction:${interaction.id}`,
      kind: "callback",
      actor: this.actorFromUser(actor, interaction.member?.nick ?? undefined),
      channel: this.channelFromDiscord(interaction.channel_id, interaction.guild_id),
      interaction: {
        channel: this.channel,
        id: customId,
        state: {
          opaque: {
            customId,
            interactionId: interaction.id,
          },
        },
      },
      actionId: binding?.actionId,
      value: binding?.value,
      receivedAt: this.now(),
      routingState: this.routingStateFromDiscord(
        interaction.channel_id,
        interaction.guild_id,
      ),
    });
  }

  private createCustomId(
    intent: MessagingSurfaceIntent,
    action: MessagingSurfaceAction,
  ): string {
    const customId = `dc:${createHash("sha256")
      .update(JSON.stringify([intent.id, action.id, action.value ?? null]))
      .digest("base64url")
      .slice(0, 24)}`;
    if (Buffer.byteLength(customId, "utf8") > DISCORD_COMPONENT_CUSTOM_ID_LIMIT_BYTES) {
      throw new Error("Discord component custom_id exceeds limit.");
    }

    this.componentBindings.set(customId, {
      actionId: action.id,
      value: action.value,
    });
    return customId;
  }

  private resolveTarget(
    intent: MessagingSurfaceIntent,
  ): { channelId: string; guildId?: string } | undefined {
    const channel = intent.audit?.channel.conversation;
    if (channel) {
      return {
        channelId: channel.id,
        guildId: channel.parentId,
      };
    }

    const opaque = intent.targetSurface?.state?.opaque;
    if (!opaque || typeof opaque !== "object" || Array.isArray(opaque)) {
      return undefined;
    }

    return typeof opaque.channelId === "string"
      ? {
          channelId: opaque.channelId,
          guildId: typeof opaque.guildId === "string" ? opaque.guildId : undefined,
        }
      : undefined;
  }

  private firstImageUrl(intent: MessagingSurfaceIntent): string | undefined {
    if (intent.kind !== "message") {
      return undefined;
    }

    return intent.parts.find((part) => part.type === "image")?.url;
  }

  private channelFromDiscord(
    channelId: string,
    guildId: string | undefined,
  ): MessagingInboundEvent["channel"] {
    return {
      channel: this.channel,
      conversation: {
        id: channelId,
        kind: guildId ? "channel" : "dm",
        parentId: guildId,
      },
    };
  }

  private actorFromUser(
    user: DiscordUser,
    guildDisplayName?: string,
  ): MessagingInboundEvent["actor"] {
    return {
      platformUserId: user.id,
      displayName: guildDisplayName ?? user.global_name ?? user.username,
      isBot: user.bot,
      username: user.username,
    };
  }

  private routingStateFromDiscord(
    channelId: string,
    guildId: string | undefined,
  ): MessagingAdapterState {
    return {
      opaque: {
        channelId,
        guildId: guildId ?? null,
      },
    };
  }

  private get api(): DiscordApi {
    this.defaultApi ??= new DiscordApi({ botToken: this.options.config.botToken });
    return this.options.api ?? this.defaultApi;
  }

  private get gateway(): DiscordGatewayConnection {
    this.defaultGateway ??= new DiscordGateway({
      botToken: this.options.config.botToken,
    });
    return this.options.gateway ?? this.defaultGateway;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function createDiscordAdapter(config: DiscordMessagingConfig): DiscordAdapter {
  return new DiscordAdapter({
    config,
  });
}
