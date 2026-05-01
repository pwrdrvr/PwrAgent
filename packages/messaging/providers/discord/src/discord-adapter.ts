import { createHash } from "node:crypto";
import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  type ButtonInteraction,
  type Interaction,
  type Message,
  type User,
} from "discord.js";
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
  actionsForDiscordIntent,
  buildDiscordComponents,
  DISCORD_COMPONENT_CUSTOM_ID_LIMIT_BYTES,
  type DiscordActionRowComponent,
  splitDiscordContent,
  textForDiscordIntent,
} from "./discord-formatting.ts";

const DISCORD_DEFAULT_TYPING_SIGNAL_LEASE_MS = 15_000;
const DISCORD_TYPING_SIGNAL_INTERVAL_MS = 4_000;

type DiscordComponentBinding = {
  actionId: string;
  value?: MessagingJsonValue;
};

type DiscordTypingSignal = {
  interval: ReturnType<typeof setInterval>;
  signalId: number;
  timeout: ReturnType<typeof setTimeout>;
};

export type DiscordProviderLogger = {
  debug(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
};

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

export type DiscordInteractionResponseRequest = {
  data?: DiscordCreateMessageRequest;
  type: 4 | 6 | 7;
};

export type DiscordMessage = {
  channel_id: string;
  content?: string;
  guild_id?: string;
  id: string;
};

export type DiscordUser = {
  bot?: boolean;
  discriminator?: string;
  global_name?: string | null;
  id: string;
  username: string;
};

export type DiscordMessageCreateDispatch = {
  attachments?: Array<{
    content_type?: string;
    filename: string;
    id: string;
    size?: number;
    url: string;
  }>;
  author: DiscordUser;
  channel_id: string;
  content?: string;
  guild_id?: string;
  id: string;
};

export type DiscordInteractionCreateDispatch = {
  channel_id: string;
  data?: {
    custom_id?: string;
  };
  guild_id?: string;
  id: string;
  member?: {
    nick?: string | null;
    user?: DiscordUser;
  };
  message?: {
    id: string;
  };
  token: string;
  type: number;
  user?: DiscordUser;
};

export type DiscordGatewayEvent =
  | {
      d: DiscordMessageCreateDispatch;
      op: 0;
      s?: number;
      t: "MESSAGE_CREATE";
    }
  | {
      d: DiscordInteractionCreateDispatch;
      op: 0;
      s?: number;
      t: "INTERACTION_CREATE";
    };

export type DiscordGatewayListener = (event: DiscordGatewayEvent) => void | Promise<void>;

export type DiscordGatewayConnection = {
  close(): Promise<void>;
  onEvent(listener: DiscordGatewayListener): () => void;
  start(): Promise<void>;
};

export type DiscordApi = {
  createInteractionResponse(
    interactionId: string,
    interactionToken: string,
    request: DiscordInteractionResponseRequest,
  ): Promise<void>;
  createMessage(
    channelId: string,
    request: DiscordCreateMessageRequest,
  ): Promise<DiscordMessage>;
  sendTyping(channelId: string): Promise<void>;
};

type DiscordAdapterOptions = {
  api?: DiscordApi;
  config: DiscordMessagingConfig;
  gateway?: DiscordGatewayConnection;
  logger?: DiscordProviderLogger;
  now?: () => number;
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
  private readonly options: DiscordAdapterOptions;
  private typingSignalSequence = 0;
  private typingSignals = new Map<string, DiscordTypingSignal>();
  private unsubscribeGateway?: () => void;

  constructor(options: DiscordAdapterOptions) {
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
    this.stopTypingSignals();
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

    if (intent.kind === "activity") {
      return await this.deliverActivity(intent, target);
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

  private async deliverActivity(
    intent: Extract<MessagingSurfaceIntent, { kind: "activity" }>,
    target: { channelId: string; guildId?: string },
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
        await this.startTypingSignal(target.channelId, intent.leaseMs);
      } else {
        this.stopTypingSignal(target.channelId);
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
    channelId: string,
    leaseMs = DISCORD_DEFAULT_TYPING_SIGNAL_LEASE_MS,
  ): Promise<void> {
    const existing = this.typingSignals.get(channelId);
    if (existing) {
      this.refreshTypingSignalLease(channelId, leaseMs);
      return;
    }

    const signalId = ++this.typingSignalSequence;
    const timeout = this.createTypingSignalTimeout(channelId, leaseMs, signalId);
    const interval = setInterval(() => {
      const current = this.typingSignals.get(channelId);
      if (!current || current.signalId !== signalId) {
        return;
      }
      void this.sendTypingSignal(channelId, signalId, "interval").catch((error) => {
        this.options.logger?.warn?.(
          `discord typing request failed signal=${signalId} source=interval channel=${channelId} error=${errorMessage(error)}`,
        );
      });
    }, DISCORD_TYPING_SIGNAL_INTERVAL_MS);
    (interval as { unref?: () => void }).unref?.();
    this.typingSignals.set(channelId, {
      interval,
      signalId,
      timeout,
    });
    this.options.logger?.debug(
      `discord typing started signal=${signalId} leaseMs=${leaseMs} channel=${channelId}`,
    );

    try {
      await this.sendTypingSignal(channelId, signalId, "start");
    } catch (error) {
      this.stopTypingSignal(channelId, "start_failed");
      throw error;
    }
  }

  private stopTypingSignal(channelId: string, reason = "idle"): void {
    const signal = this.typingSignals.get(channelId);
    if (!signal) {
      this.options.logger?.debug(
        `discord typing stop skipped reason=${reason} channel=${channelId}`,
      );
      return;
    }
    clearInterval(signal.interval);
    clearTimeout(signal.timeout);
    this.typingSignals.delete(channelId);
    this.options.logger?.debug(
      `discord typing stopped signal=${signal.signalId} reason=${reason} channel=${channelId}`,
    );
  }

  private stopTypingSignals(): void {
    for (const signal of this.typingSignals.values()) {
      clearInterval(signal.interval);
      clearTimeout(signal.timeout);
    }
    if (this.typingSignals.size > 0) {
      this.options.logger?.debug("discord typing signals stopped", {
        count: this.typingSignals.size,
      });
    }
    this.typingSignals.clear();
  }

  private refreshTypingSignalLease(channelId: string, leaseMs: number): void {
    const signal = this.typingSignals.get(channelId);
    if (!signal) {
      return;
    }
    clearTimeout(signal.timeout);
    signal.timeout = this.createTypingSignalTimeout(channelId, leaseMs, signal.signalId);
    this.options.logger?.debug(
      `discord typing lease refreshed signal=${signal.signalId} leaseMs=${leaseMs} channel=${channelId}`,
    );
  }

  private createTypingSignalTimeout(
    channelId: string,
    leaseMs: number,
    signalId: number,
  ): ReturnType<typeof setTimeout> {
    const timeout = setTimeout(() => {
      const current = this.typingSignals.get(channelId);
      if (!current || current.signalId !== signalId) {
        this.options.logger?.debug(
          `discord typing expiry skipped signal=${signalId} leaseMs=${leaseMs} channel=${channelId}`,
        );
        return;
      }
      this.options.logger?.debug(
        `discord typing expired signal=${signalId} leaseMs=${leaseMs} channel=${channelId}`,
      );
      this.stopTypingSignal(channelId, "lease_expired");
    }, leaseMs);
    (timeout as { unref?: () => void }).unref?.();
    return timeout;
  }

  private async sendTypingSignal(
    channelId: string,
    signalId: number,
    source: "interval" | "start",
  ): Promise<void> {
    this.options.logger?.debug(
      `discord typing request signal=${signalId} source=${source} channel=${channelId}`,
    );
    await this.api.sendTyping(channelId);
    this.options.logger?.debug(
      `discord typing ok signal=${signalId} source=${source} channel=${channelId}`,
    );
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
    this.defaultApi ??= new DiscordRestApi(this.options.config.botToken);
    return this.options.api ?? this.defaultApi;
  }

  private get gateway(): DiscordGatewayConnection {
    this.defaultGateway ??= new DiscordJsGatewayConnection(this.options.config);
    return this.options.gateway ?? this.defaultGateway;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function createDiscordAdapter(
  config: DiscordMessagingConfig,
  logger?: DiscordProviderLogger,
): DiscordAdapter {
  return new DiscordAdapter({
    config,
    logger,
  });
}

class DiscordRestApi implements DiscordApi {
  private readonly rest: REST;

  constructor(botToken: string) {
    this.rest = new REST({ version: "10" }).setToken(botToken);
  }

  async createMessage(
    channelId: string,
    request: DiscordCreateMessageRequest,
  ): Promise<DiscordMessage> {
    return (await this.rest.post(Routes.channelMessages(channelId), {
      body: request,
    })) as DiscordMessage;
  }

  async createInteractionResponse(
    interactionId: string,
    interactionToken: string,
    request: DiscordInteractionResponseRequest,
  ): Promise<void> {
    await this.rest.post(Routes.interactionCallback(interactionId, interactionToken), {
      body: request,
    });
  }

  async sendTyping(channelId: string): Promise<void> {
    await this.rest.post(`/channels/${channelId}/typing`, {
      body: {},
    });
  }
}

class DiscordJsGatewayConnection implements DiscordGatewayConnection {
  private readonly client: Client;
  private readonly config: DiscordMessagingConfig;
  private readonly listeners = new Set<DiscordGatewayListener>();

  constructor(config: DiscordMessagingConfig) {
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.registerHandlers();
  }

  async start(): Promise<void> {
    await this.client.login(this.config.botToken);
  }

  async close(): Promise<void> {
    this.client.removeAllListeners();
    this.client.destroy();
  }

  onEvent(listener: DiscordGatewayListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private registerHandlers(): void {
    this.client.on(Events.MessageCreate, (message) => {
      void this.emit({
        d: messageToDispatch(message),
        op: 0,
        t: "MESSAGE_CREATE",
      });
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      const dispatch = interactionToDispatch(interaction);
      if (!dispatch) {
        return;
      }
      void this.emit({
        d: dispatch,
        op: 0,
        t: "INTERACTION_CREATE",
      });
    });
  }

  private async emit(event: DiscordGatewayEvent): Promise<void> {
    await Promise.all([...this.listeners].map(async (listener) => listener(event)));
  }
}

function defensiveAllowedMentions(): DiscordAllowedMentions {
  return {
    parse: [],
    replied_user: false,
    roles: [],
    users: [],
  };
}

function messageToDispatch(message: Message): DiscordMessageCreateDispatch {
  return {
    attachments: [...message.attachments.values()].map((attachment) => ({
      content_type: attachment.contentType ?? undefined,
      filename: attachment.name,
      id: attachment.id,
      size: attachment.size,
      url: attachment.url,
    })),
    author: userToDiscordUser(message.author),
    channel_id: message.channelId,
    content: message.content,
    guild_id: message.guildId ?? undefined,
    id: message.id,
  };
}

function interactionToDispatch(
  interaction: Interaction,
): DiscordInteractionCreateDispatch | undefined {
  if (!interaction.isButton()) {
    return undefined;
  }

  const buttonInteraction = interaction as ButtonInteraction;
  return {
    channel_id: buttonInteraction.channelId,
    data: {
      custom_id: buttonInteraction.customId,
    },
    guild_id: buttonInteraction.guildId ?? undefined,
    id: buttonInteraction.id,
    member: buttonInteraction.inGuild()
      ? {
          nick:
            "nickname" in buttonInteraction.member
              ? buttonInteraction.member.nickname
              : null,
          user: userToDiscordUser(buttonInteraction.user),
        }
      : undefined,
    message: {
      id: buttonInteraction.message.id,
    },
    token: buttonInteraction.token,
    type: buttonInteraction.type,
    user: userToDiscordUser(buttonInteraction.user),
  };
}

function userToDiscordUser(user: User): DiscordUser {
  return {
    bot: user.bot,
    discriminator: user.discriminator,
    global_name: user.globalName,
    id: user.id,
    username: user.username,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
