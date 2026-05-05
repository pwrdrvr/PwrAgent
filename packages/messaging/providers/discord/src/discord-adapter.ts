import { createHash } from "node:crypto";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type User,
} from "discord.js";
import type {
  MessagingCapabilityProfile,
  MessagingAdapterState,
  MessagingAttachmentDescriptor,
  MessagingAttachmentDownloadRequest,
  MessagingAttachmentDownloadResult,
  MessagingConversationTitleUpdateRequest,
  MessagingConversationTitleUpdateResult,
  MessagingDeliveryResult,
  MessagingFilePart,
  MessagingInboundEvent,
  MessagingJsonValue,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import type { DiscordMessagingConfig } from "./discord-config.ts";
import type {
  DiscordApplicationCommand,
  DiscordApplicationCommandApi,
  DiscordApplicationCommandBody,
} from "./discord-commands.ts";
import { reconcileDiscordApplicationCommands } from "./discord-commands.ts";
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

type FetchLike = (url: string) => Promise<{
  arrayBuffer(): Promise<ArrayBuffer>;
  ok: boolean;
  status: number;
  statusText: string;
}>;

type DiscordTypingSignal = {
  interval: ReturnType<typeof setInterval>;
  signalId: number;
  timeout: ReturnType<typeof setTimeout>;
};

type DiscordInteractionCommandOption = {
  name: string;
  value?: string | number | boolean;
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
  files?: Array<{
    data: Uint8Array;
    name: string;
  }>;
};

export type DiscordInteractionResponseRequest = {
  data?: DiscordCreateMessageRequest;
  type: 4 | 5 | 6 | 7;
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
  channel_type?: number;
  content?: string;
  guild_id?: string;
  id: string;
  is_thread?: boolean;
};

export type DiscordInteractionCreateDispatch = {
  channel_id: string;
  channel_type?: number;
  data?: {
    custom_id?: string;
    name?: string;
    options?: DiscordInteractionCommandOption[];
  };
  guild_id?: string;
  id: string;
  is_thread?: boolean;
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

export type DiscordApi = DiscordApplicationCommandApi & {
  updateChannelName(channelId: string, request: { name: string }): Promise<void>;
  createInteractionResponse(
    interactionId: string,
    interactionToken: string,
    request: DiscordInteractionResponseRequest,
  ): Promise<void>;
  updateInteractionOriginalResponse(
    applicationId: string,
    interactionToken: string,
    request: DiscordCreateMessageRequest,
  ): Promise<DiscordMessage>;
  createMessage(
    channelId: string,
    request: DiscordCreateMessageRequest,
  ): Promise<DiscordMessage>;
  pinMessage(channelId: string, messageId: string): Promise<void>;
  sendTyping(channelId: string): Promise<void>;
  unpinMessage(channelId: string, messageId: string): Promise<void>;
  updateMessage(
    channelId: string,
    messageId: string,
    request: DiscordCreateMessageRequest,
  ): Promise<DiscordMessage>;
};

type DiscordAdapterOptions = {
  api?: DiscordApi;
  config: DiscordMessagingConfig;
  fetch?: FetchLike;
  gateway?: DiscordGatewayConnection;
  logger?: DiscordProviderLogger;
  now?: () => number;
};

export type DiscordProviderAdapter = {
  authorizedActorIds: readonly string[];
  capabilityProfile: MessagingCapabilityProfile;
  channel: "discord";
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

export class DiscordAdapter implements DiscordProviderAdapter {
  readonly channel = "discord" as const;
  readonly capabilityProfile: MessagingCapabilityProfile = {
    actions: {
      maxActions: 25,
      maxActionsPerRow: 5,
      maxRows: 5,
      maxLabelLength: 80,
      supportsStyles: true,
      supportsDisabled: true,
      supportsLayoutHints: true,
      maxCallbackPayloadBytes: 100,
    },
    text: {
      maxLength: 2000,
      encoding: "characters",
      markdownDialect: "discord-markdown",
      supportsCodeBlocks: true,
      supportsBold: true,
      supportsItalic: true,
      supportsLinks: true,
      supportsInlineCode: true,
      supportsMessageEdit: true,
    },
    inboundAttachments: {
      maxAttachmentCount: 10,
      maxDownloadBytes: 25 * 1024 * 1024,
      supportsDownload: true,
    },
    outboundAttachments: {
      maxUploadBytes: 25 * 1024 * 1024,
      supportsFileUpload: true,
      supportsImageUpload: true,
      supportsRemoteImageUrl: true,
    },
  };

  private componentBindings = new Map<string, DiscordComponentBinding>();
  private defaultApi?: DiscordApi;
  private defaultGateway?: DiscordGatewayConnection;
  private listener?: (event: MessagingInboundEvent) => Promise<void>;
  private readonly options: DiscordAdapterOptions;
  private streamSurfaces = new Map<string, string>();
  private typingSignalSequence = 0;
  private typingSignals = new Map<string, DiscordTypingSignal>();
  private unsubscribeGateway?: () => void;

  constructor(options: DiscordAdapterOptions) {
    this.options = options;
  }

  get authorizedActorIds(): readonly string[] {
    return this.options.config.authorizedActorIds;
  }

  async start(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void> {
    await this.reconcileApplicationCommands();
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

  async downloadAttachment(
    request: MessagingAttachmentDownloadRequest,
  ): Promise<MessagingAttachmentDownloadResult> {
    const opaque = request.attachment.state?.opaque;
    if (!opaque || typeof opaque !== "object" || Array.isArray(opaque)) {
      throw new Error("Discord attachment download state is missing.");
    }
    const url = opaque.url;
    if (typeof url !== "string" || !url) {
      throw new Error("Discord attachment URL is missing.");
    }
    const response = await this.fetch(url);
    if (!response.ok) {
      throw new Error(
        `Discord attachment download failed: ${response.status} ${response.statusText}`,
      );
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > request.maxBytes) {
      throw new Error("Discord attachment exceeds the configured download limit.");
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
        errorMessage: "Discord delivery target is missing.",
        outcome: "failed",
      };
    }

    if (intent.kind === "dismiss") {
      if (intent.delivery?.unpin && target.messageId) {
        try {
          await this.api.unpinMessage(target.channelId, target.messageId);
          return {
            channel: this.channel,
            deliveredAt: this.now(),
            outcome: "unpinned",
            surface: intent.targetSurface,
          };
        } catch (error) {
          return {
            channel: this.channel,
            deliveredAt: this.now(),
            errorMessage: errorMessage(error),
            outcome: "failed",
            surface: intent.targetSurface,
          };
        }
      }
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "unsupported",
        surface: intent.targetSurface,
      };
    }

    if (intent.kind === "activity") {
      return await this.deliverActivity(intent, target);
    }

    if (intent.kind === "stream_update") {
      return await this.deliverStreamUpdate(intent, target);
    }

    try {
      const components = buildDiscordComponents(
        actionsForDiscordIntent(intent),
        (action) => this.createCustomId(intent, action),
        intent.actionLayout,
        this.capabilityProfile,
      );
      const imageUpload = uploadableImagePart(intent);
      const imageUrl = imageUpload ? undefined : this.firstImageUrl(intent);
      const files = [...uploadableFileParts(intent), ...(imageUpload ? [imageUpload] : [])];
      const chunks = splitDiscordContent(
        (files.length > 0
          ? textForDiscordIntentWithoutUploads(intent)
          : textForDiscordIntent(intent)) || " ",
      );
      const componentPayload =
        components ?? (intent.delivery?.replaceMarkup ? [] : undefined);

      if (
        target.applicationId &&
        target.interactionToken &&
        chunks.length === 1 &&
        !imageUrl &&
        files.length === 0
      ) {
        const message = await this.api.updateInteractionOriginalResponse(
          target.applicationId,
          target.interactionToken,
          {
            allowed_mentions: defensiveAllowedMentions(),
            components: componentPayload,
            content: chunks[0] ?? " ",
          },
        );
        const pinned = await this.pinMessageIfRequested(intent, message, target);
        return {
          channel: this.channel,
          deliveredAt: this.now(),
          outcome: pinned ? "pinned" : "updated",
          surface: this.surfaceForMessage(message, target),
        };
      }

      if (
        intent.delivery?.mode === "update" &&
        target.messageId &&
        chunks.length === 1 &&
        !imageUrl
      ) {
        try {
          const message = await this.api.updateMessage(
            target.channelId,
            target.messageId,
            {
              allowed_mentions: defensiveAllowedMentions(),
              components: componentPayload,
              content: chunks[0] ?? " ",
              files: filesForDiscordRequest(files),
            },
          );
          const pinned = await this.pinMessageIfRequested(intent, message, target);
          return {
            channel: this.channel,
            deliveredAt: this.now(),
            outcome: pinned ? "pinned" : "updated",
            surface: this.surfaceForMessage(message, target),
          };
        } catch (error) {
          if (intent.delivery.fallback !== "present_new") {
            throw error;
          }
        }
      }

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
          files: index === chunks.length - 1 ? filesForDiscordRequest(files) : undefined,
        };
        messages.push(await this.api.createMessage(target.channelId, request));
      }

      const lastMessage = messages.at(-1);
      const pinned = lastMessage
        ? await this.pinMessageIfRequested(intent, lastMessage, target)
        : false;
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: pinned
          ? "pinned"
          : intent.delivery?.mode === "update" ? "presented_new" : "presented",
        surface: lastMessage ? this.surfaceForMessage(lastMessage, target) : undefined,
      };
    } catch (error) {
      const message = errorMessage(error);
      this.options.logger?.warn?.(
        `discord deliver failed kind=${intent.kind} channel=${target.channelId} error=${message}`,
      );
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        errorMessage: message,
        outcome: "failed",
        surface: intent.targetSurface,
      };
    }
  }

  private async pinMessageIfRequested(
    intent: MessagingSurfaceIntent,
    message: DiscordMessage,
    target: { channelId: string },
  ): Promise<boolean> {
    if (!intent.delivery?.pin) {
      return false;
    }
    try {
      await this.api.pinMessage(message.channel_id || target.channelId, message.id);
      return true;
    } catch (error) {
      this.options.logger?.warn?.(
        `discord pin failed channel=${message.channel_id || target.channelId} message=${message.id} error=${errorMessage(error)}`,
      );
      return false;
    }
  }

  private async deliverStreamUpdate(
    intent: Extract<MessagingSurfaceIntent, { kind: "stream_update" }>,
    target: { channelId: string; guildId?: string; messageId?: string },
  ): Promise<MessagingDeliveryResult> {
    if (
      this.options.config.streamingResponses !== true ||
      intent.policy === "disabled"
    ) {
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "discarded",
      };
    }

    const chunks = splitDiscordContent(intent.text || " ");
    if (chunks.length !== 1) {
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "discarded",
      };
    }

    try {
      const existingMessageId =
        this.streamSurfaces.get(intent.stream.key) ?? target.messageId;
      const request: DiscordCreateMessageRequest = {
        allowed_mentions: defensiveAllowedMentions(),
        content: chunks[0] ?? " ",
      };
      const message = existingMessageId
        ? await this.api.updateMessage(target.channelId, existingMessageId, request)
        : await this.api.createMessage(target.channelId, request);
      if (intent.stream.isFinal) {
        this.streamSurfaces.delete(intent.stream.key);
      } else {
        this.streamSurfaces.set(intent.stream.key, message.id);
      }
      this.options.logger?.debug(
        `discord stream update ${existingMessageId ? "edited" : "sent"} final=${intent.stream.isFinal} sequence=${intent.stream.sequence} channel=${target.channelId} message=${message.id} stream=${intent.stream.key}`,
      );
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: existingMessageId ? "updated" : "presented",
        surface: this.surfaceForMessage(message, target),
      };
    } catch (error) {
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        errorMessage: errorMessage(error),
        outcome: "failed",
      };
    }
  }

  async setConversationTitle(
    request: MessagingConversationTitleUpdateRequest,
  ): Promise<MessagingConversationTitleUpdateResult> {
    const title = sanitizeDiscordThreadName(request.title);
    const conversation = request.channel.conversation;
    if (!isDiscordThreadConversation(request)) {
      return {
        channel: this.channel,
        conversation,
        errorMessage: "Discord name sync is only available inside Discord threads.",
        outcome: "unsupported",
        title,
        updatedAt: this.now(),
      };
    }

    try {
      await this.api.updateChannelName(conversation.id, { name: title });
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
    const routingState = this.routingStateFromDiscord(message.channel_id, message.guild_id, {
      channelType: message.channel_type,
      isThread: message.is_thread,
    });

    if (message.attachments && message.attachments.length > 0) {
      const attachments = message.attachments.map((attachment) =>
        this.attachmentFromDiscord(attachment),
      );
      await listener({
        id: `discord:message:${message.id}`,
        kind: "media",
        attachments,
        actor: this.actorFromUser(message.author),
        channel,
        disposition: attachments.some((attachment) => attachment.disposition === "available")
          ? "available"
          : "unsupported",
        media: {
          type: "file",
          name: attachments[0]?.name ?? "discord-attachment",
          mimeType: attachments[0]?.mimeType,
          sizeBytes: attachments[0]?.sizeBytes,
        },
        receivedAt,
        routingState,
        text: message.content,
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
    const listener = this.listener;
    const actor = interaction.member?.user ?? interaction.user;
    if (!listener || !actor) {
      return;
    }

    const customId = interaction.data?.custom_id ?? "";
    if (customId) {
      await this.api.createInteractionResponse(interaction.id, interaction.token, {
        type: 6,
      });
      await this.handleComponentInteraction(interaction, actor, customId);
      return;
    }

    const commandName = interaction.data?.name?.toLowerCase();
    if (commandName) {
      await this.api.createInteractionResponse(interaction.id, interaction.token, {
        type: 5,
      });
      await this.handleApplicationCommandInteraction(interaction, actor, commandName);
    }
  }

  private async handleComponentInteraction(
    interaction: DiscordInteractionCreateDispatch,
    actor: DiscordUser,
    customId: string,
  ): Promise<void> {
    const listener = this.listener;
    if (!listener) {
      return;
    }

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
        {
          channelType: interaction.channel_type,
          isThread: interaction.is_thread,
        },
      ),
    });
  }

  private async handleApplicationCommandInteraction(
    interaction: DiscordInteractionCreateDispatch,
    actor: DiscordUser,
    commandName: string,
  ): Promise<void> {
    const listener = this.listener;
    if (!listener) {
      return;
    }

    const args = commandArgsFromOptions(interaction.data?.options);
    await listener({
      id: `discord:command:${interaction.id}`,
      kind: "command",
      actor: this.actorFromUser(actor, interaction.member?.nick ?? undefined),
      args,
      channel: this.channelFromDiscord(interaction.channel_id, interaction.guild_id),
      command: commandName,
      rawText: [`/${commandName}`, ...args].join(" ").trim(),
      receivedAt: this.now(),
      routingState: this.routingStateFromDiscord(
        interaction.channel_id,
        interaction.guild_id,
        {
          channelType: interaction.channel_type,
          interactionToken: interaction.token,
          isThread: interaction.is_thread,
        },
      ),
    });
  }

  private async reconcileApplicationCommands(): Promise<void> {
    const applicationId = this.options.config.applicationId;
    if (!applicationId) {
      this.options.logger?.warn?.(
        "discord slash command registration skipped because applicationId is not configured",
      );
      return;
    }

    const result = await reconcileDiscordApplicationCommands({
      api: this.api,
      applicationId,
    });

    this.options.logger?.debug("discord slash commands reconciled", result);
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
  ):
    | {
        applicationId?: string;
        channelId: string;
        guildId?: string;
        interactionToken?: string;
        messageId?: string;
      }
    | undefined {
    const channel = intent.audit?.channel.conversation;
    const opaque = intent.targetSurface?.state?.opaque;
    if (channel) {
      const surfaceState =
        opaque && typeof opaque === "object" && !Array.isArray(opaque)
          ? opaque
          : undefined;
      return {
        applicationId:
          typeof surfaceState?.applicationId === "string"
            ? surfaceState.applicationId
            : undefined,
        channelId: channel.id,
        guildId: channel.parentId,
        interactionToken:
          typeof surfaceState?.interactionToken === "string"
            ? surfaceState.interactionToken
            : undefined,
        messageId:
          typeof surfaceState?.messageId === "string"
            ? surfaceState.messageId
            : undefined,
      };
    }

    if (!opaque || typeof opaque !== "object" || Array.isArray(opaque)) {
      return undefined;
    }

    return typeof opaque.channelId === "string"
      ? {
          applicationId:
            typeof opaque.applicationId === "string" ? opaque.applicationId : undefined,
          channelId: opaque.channelId,
          guildId: typeof opaque.guildId === "string" ? opaque.guildId : undefined,
          interactionToken:
            typeof opaque.interactionToken === "string"
              ? opaque.interactionToken
              : undefined,
          messageId: typeof opaque.messageId === "string" ? opaque.messageId : undefined,
        }
      : undefined;
  }

  private surfaceForMessage(
    message: DiscordMessage,
    target: { channelId: string; guildId?: string },
  ): MessagingDeliveryResult["surface"] {
    return {
      channel: this.channel,
      id: message.id,
      state: {
        opaque: {
          channelId: target.channelId,
          guildId: target.guildId ?? null,
          messageId: message.id,
        },
      },
    };
  }

  private firstImageUrl(intent: MessagingSurfaceIntent): string | undefined {
    if (intent.kind !== "message") {
      return undefined;
    }

    return intent.parts.find((part) => part.type === "image")?.url;
  }

  private async deliverActivity(
    intent: Extract<MessagingSurfaceIntent, { kind: "activity" }>,
    target: { channelId: string; guildId?: string; messageId?: string },
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
    options?: {
      channelType?: number;
      interactionToken?: string;
      isThread?: boolean;
    },
  ): MessagingAdapterState {
    return {
      opaque: {
        applicationId: options?.interactionToken
          ? (this.options.config.applicationId ?? null)
          : null,
        channelId,
        channelType: options?.channelType ?? null,
        guildId: guildId ?? null,
        interactionToken: options?.interactionToken ?? null,
        isThread: options?.isThread ?? null,
      },
    };
  }

  private attachmentFromDiscord(attachment: {
    content_type?: string;
    filename: string;
    id: string;
    size?: number;
    url: string;
  }): MessagingAttachmentDescriptor {
    const mimeType = attachment.content_type;
    const kind = attachmentKindFromDiscordMimeType(mimeType, attachment.filename);
    const available =
      kind === "file" || kind === "image" || kind === "gif";
    return {
      id: `discord:attachment:${attachment.id}`,
      kind,
      name: attachment.filename,
      disposition: available ? "available" : "unsupported",
      mimeType,
      reason: available ? undefined : "unsupported attachment type",
      sizeBytes: attachment.size,
      state: {
        opaque: {
          attachmentId: attachment.id,
          provider: "discord",
          url: attachment.url,
        },
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

  private get fetch(): FetchLike {
    return this.options.fetch ?? fetch;
  }
}

function uploadableFileParts(intent: MessagingSurfaceIntent): MessagingFilePart[] {
  if (intent.kind !== "message") {
    return [];
  }

  return intent.parts.filter(
    (part): part is MessagingFilePart =>
      part.type === "file" && part.data !== undefined,
  );
}

function uploadableImagePart(intent: MessagingSurfaceIntent): MessagingFilePart | undefined {
  if (intent.kind !== "message") {
    return undefined;
  }

  const url = intent.parts.find((part) => part.type === "image")?.url;
  if (!url) {
    return undefined;
  }

  const dataImage = parseDataImageUrl(url);
  if (!dataImage) {
    return undefined;
  }

  return {
    data: dataImage.data,
    mimeType: dataImage.mimeType,
    name: dataImage.name,
    sizeBytes: dataImage.data.byteLength,
    type: "file",
  };
}

function textForDiscordIntentWithoutUploads(intent: MessagingSurfaceIntent): string {
  if (intent.kind !== "message") {
    return textForDiscordIntent(intent);
  }

  return textForDiscordIntent({
    ...intent,
    parts: intent.parts.filter(
      (part) =>
        !(part.type === "file" && part.data !== undefined) &&
        !(part.type === "image" && part.url.startsWith("data:image/")),
    ),
  });
}

function filesForDiscordRequest(
  files: MessagingFilePart[],
): DiscordCreateMessageRequest["files"] | undefined {
  if (files.length === 0) {
    return undefined;
  }

  return files.map((file) => ({
    data: file.data!,
    name: file.name,
  }));
}

function parseDataImageUrl(
  url: string,
): { data: Uint8Array; mimeType: string; name: string } | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(url);
  if (!match) {
    return undefined;
  }

  const mimeType = match[1]?.toLowerCase() ?? "image/png";
  const extension =
    mimeType === "image/jpeg"
      ? "jpg"
      : mimeType === "image/png"
        ? "png"
        : mimeType === "image/gif"
          ? "gif"
          : "img";
  return {
    data: new Uint8Array(Buffer.from(match[2] ?? "", "base64")),
    mimeType,
    name: `assistant-image.${extension}`,
  };
}

function attachmentKindFromDiscordMimeType(
  mimeType: string | undefined,
  filename: string,
): MessagingAttachmentDescriptor["kind"] {
  const lowerName = filename.toLowerCase();
  if (mimeType?.startsWith("image/gif") || lowerName.endsWith(".gif")) {
    return "gif";
  }
  if (mimeType?.startsWith("image/")) {
    return "image";
  }
  if (mimeType?.startsWith("audio/")) {
    return "audio";
  }
  if (mimeType?.startsWith("video/")) {
    return "video";
  }
  return "file";
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

  async createApplicationCommand(
    applicationId: string,
    command: DiscordApplicationCommandBody,
  ): Promise<DiscordApplicationCommand> {
    return (await this.rest.post(Routes.applicationCommands(applicationId), {
      body: command,
    })) as DiscordApplicationCommand;
  }

  async createMessage(
    channelId: string,
    request: DiscordCreateMessageRequest,
  ): Promise<DiscordMessage> {
    const { files, ...body } = request;
    return (await this.rest.post(Routes.channelMessages(channelId), {
      body,
      files: files?.map((file) => ({
        data: Buffer.from(file.data),
        name: file.name,
      })),
    })) as DiscordMessage;
  }

  async updateChannelName(
    channelId: string,
    request: { name: string },
  ): Promise<void> {
    await this.rest.patch(Routes.channel(channelId), {
      body: request,
    });
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

  async updateInteractionOriginalResponse(
    applicationId: string,
    interactionToken: string,
    request: DiscordCreateMessageRequest,
  ): Promise<DiscordMessage> {
    const { files, ...body } = request;
    return (await this.rest.patch(
      `/webhooks/${applicationId}/${interactionToken}/messages/@original`,
      {
        body,
        files: files?.map((file) => ({
          data: Buffer.from(file.data),
          name: file.name,
        })),
      },
    )) as DiscordMessage;
  }

  async deleteApplicationCommand(
    applicationId: string,
    commandId: string,
  ): Promise<void> {
    await this.rest.delete(Routes.applicationCommand(applicationId, commandId));
  }

  async listApplicationCommands(
    applicationId: string,
  ): Promise<DiscordApplicationCommand[]> {
    return (await this.rest.get(
      Routes.applicationCommands(applicationId),
    )) as DiscordApplicationCommand[];
  }

  async sendTyping(channelId: string): Promise<void> {
    await this.rest.post(`/channels/${channelId}/typing`, {
      body: {},
    });
  }

  async pinMessage(channelId: string, messageId: string): Promise<void> {
    await this.rest.put(`/channels/${channelId}/pins/${messageId}`, {
      body: {},
    });
  }

  async unpinMessage(channelId: string, messageId: string): Promise<void> {
    await this.rest.delete(`/channels/${channelId}/pins/${messageId}`);
  }

  async updateApplicationCommand(
    applicationId: string,
    commandId: string,
    command: DiscordApplicationCommandBody,
  ): Promise<DiscordApplicationCommand> {
    return (await this.rest.patch(
      Routes.applicationCommand(applicationId, commandId),
      {
        body: command,
      },
    )) as DiscordApplicationCommand;
  }

  async updateMessage(
    channelId: string,
    messageId: string,
    request: DiscordCreateMessageRequest,
  ): Promise<DiscordMessage> {
    const { files, ...body } = request;
    return (await this.rest.patch(Routes.channelMessage(channelId, messageId), {
      body,
      files: files?.map((file) => ({
        data: Buffer.from(file.data),
        name: file.name,
      })),
    })) as DiscordMessage;
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
      partials: [Partials.Channel],
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
    channel_type: message.channel.type,
    content: message.content,
    guild_id: message.guildId ?? undefined,
    id: message.id,
    is_thread: discordChannelIsThread(message.channel),
  };
}

function interactionToDispatch(
  interaction: Interaction,
): DiscordInteractionCreateDispatch | undefined {
  if (interaction.isButton()) {
    const buttonInteraction = interaction as ButtonInteraction;
    return {
      channel_id: buttonInteraction.channelId,
      channel_type: buttonInteraction.channel?.type,
      data: {
        custom_id: buttonInteraction.customId,
      },
      guild_id: buttonInteraction.guildId ?? undefined,
      id: buttonInteraction.id,
      is_thread: buttonInteraction.channel
        ? discordChannelIsThread(buttonInteraction.channel)
        : undefined,
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

  if (interaction.isChatInputCommand()) {
    const commandInteraction = interaction as ChatInputCommandInteraction;
    return {
      channel_id: commandInteraction.channelId,
      channel_type: commandInteraction.channel?.type,
      data: {
        name: commandInteraction.commandName,
        options: commandInteraction.options.data.map((option) => ({
          name: option.name,
          value:
            typeof option.value === "string"
            || typeof option.value === "number"
            || typeof option.value === "boolean"
              ? option.value
              : undefined,
        })),
      },
      guild_id: commandInteraction.guildId ?? undefined,
      id: commandInteraction.id,
      is_thread: commandInteraction.channel
        ? discordChannelIsThread(commandInteraction.channel)
        : undefined,
      member: commandInteraction.inGuild()
        ? {
            nick:
              "nickname" in commandInteraction.member
                ? commandInteraction.member.nickname
                : null,
            user: userToDiscordUser(commandInteraction.user),
          }
        : undefined,
      token: commandInteraction.token,
      type: commandInteraction.type,
      user: userToDiscordUser(commandInteraction.user),
    };
  }

  return undefined;
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

function isDiscordThreadConversation(
  request: MessagingConversationTitleUpdateRequest,
): boolean {
  if (request.channel.conversation.kind === "thread") {
    return true;
  }

  const opaque = request.routingState?.opaque;
  if (!opaque || typeof opaque !== "object" || Array.isArray(opaque)) {
    return false;
  }

  if (opaque.isThread === true) {
    return true;
  }

  return (
    opaque.channelType === 10 ||
    opaque.channelType === 11 ||
    opaque.channelType === 12
  );
}

function sanitizeDiscordThreadName(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  return Array.from(normalized || "PwrAgent thread").slice(0, 100).join("");
}

function discordChannelIsThread(channel: unknown): boolean {
  if (!channel || typeof channel !== "object" || !("isThread" in channel)) {
    return false;
  }
  const isThread = (channel as { isThread?: unknown }).isThread;
  return typeof isThread === "function" && Boolean(isThread.call(channel));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandArgsFromOptions(
  options: DiscordInteractionCommandOption[] | undefined,
): string[] {
  const args = options?.find((option) => option.name === "args")?.value;
  return typeof args === "string" ? args.split(/\s+/).filter(Boolean) : [];
}
