import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Client4, WebSocketClient, type WebSocketMessage } from "@mattermost/client";

// Note on `window` access in `@mattermost/client`'s `WebSocketClient`: prior
// to @mattermost/client@11.4.0 the WS code touched bare `window` references
// at startup (`window.addEventListener('online'/'offline', …)` and
// `window.navigator.userAgent`), which threw "window is not defined" in
// Node/Electron-main. That was a known upstream bug — see
// https://github.com/mattermost/mattermost/issues/33581 and PR #35195
// (MM-67137) — fixed in 11.4.0 by switching to `globalThis.window?.…` with
// optional chaining. We pin `^11.4.0` in package.json so no polyfill is
// needed; if you ever downgrade below 11.4.0, you'll need to stub
// `globalThis.window` before importing this module.
import type {
  MessagingActorIdentity,
  MessagingAdapterState,
  MessagingAttachmentDescriptor,
  MessagingAttachmentDownloadRequest,
  MessagingAttachmentDownloadResult,
  MessagingCallbackHandleRecord,
  MessagingCallbackHandleStore,
  MessagingCapabilityProfile,
  MessagingChannelRef,
  MessagingConversationKind,
  MessagingDeliveryResult,
  MessagingInboundEvent,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
  MessagingSurfaceRef,
} from "@pwragent/messaging-interface";
import type { MattermostMessagingConfig } from "./mattermost-config.ts";
import {
  createMattermostCallbackServer,
  generateMattermostHmacSecret,
  type MattermostCallbackHandlerResult,
  type MattermostCallbackServer,
  type MattermostInteractiveCallbackBody,
} from "./mattermost-callback-server.ts";
import {
  actionsForMattermostIntent,
  buildMattermostActions,
  clampMattermostMessage,
  textForMattermostIntent,
  type MattermostMessageAttachment,
  type MattermostPostBody,
} from "./mattermost-formatting.ts";

const DEFAULT_CALLBACK_PORT = 47821;

/**
 * Conversation title (channel header) limit per Mattermost product limits.
 */
const MATTERMOST_CHANNEL_HEADER_LIMIT = 1024;

export type MattermostProviderLogger = {
  debug?: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
};

export type MattermostProviderAdapter = {
  authorizedActorIds: readonly string[];
  capabilityProfile: MessagingCapabilityProfile;
  channel: "mattermost";
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  downloadAttachment(
    request: MessagingAttachmentDownloadRequest,
  ): Promise<MessagingAttachmentDownloadResult>;
  setConversationTitle?(request: {
    actor?: MessagingActorIdentity;
    channel: MessagingChannelRef;
    routingState?: MessagingAdapterState;
    title: string;
  }): Promise<{
    channel: "mattermost";
    conversation: MessagingChannelRef["conversation"];
    errorMessage?: string;
    outcome: "updated" | "unsupported" | "failed";
    title: string;
    updatedAt: number;
  }>;
  start(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
};

export type MattermostAdapterOptions = {
  client?: Client4;
  config: MattermostMessagingConfig;
  callbackServer?: MattermostCallbackServer;
  callbackHandleStore: MessagingCallbackHandleStore;
  logger: MattermostProviderLogger;
  now?: () => number;
  websocketClient?: WebSocketClient;
};

type MattermostInboundListener = (event: MessagingInboundEvent) => Promise<void>;

/**
 * Internal post-state we persist in `MessagingAdapterState.opaque` so the
 * controller can echo it back on update / dismiss / pin operations.
 */
type MattermostSurfaceOpaqueState = {
  postId: string;
  channelId: string;
  rootId?: string;
};

export class MattermostAdapter implements MattermostProviderAdapter {
  readonly channel = "mattermost" as const;
  readonly capabilityProfile: MessagingCapabilityProfile = {
    actions: {
      // Mattermost docs are silent on the per-attachment / per-post hard
      // limit. 25 is chosen conservatively to mirror Discord's 5×5 grid;
      // verify empirically against the deployed server before raising.
      // ASSUMED — docs silent.
      maxActions: 25,
      // Advisory only — Mattermost auto-flows buttons by viewport width.
      maxActionsPerRow: 5,
      maxRows: 5,
      // ASSUMED — visually clamped by webapp around 30 chars but not
      // documented as a server-rejected limit. 40 is a safe budget.
      maxLabelLength: 40,
      // good | warning | danger | default | primary | success
      supportsStyles: true,
      // No documented `disabled` field on action schema.
      supportsDisabled: false,
      // Mattermost auto-flows; explicit row/column hints are not honored.
      supportsLayoutHints: false,
      // Per-action ceiling under MaximumPayloadSizeBytes (300 KB total
      // post body, Mattermost ≥9.7.2). ~16 KB leaves headroom for
      // many buttons in a single post.
      maxCallbackPayloadBytes: 16_000,
    },
    text: {
      // Mattermost product-limits page.
      maxLength: 16_383,
      encoding: "characters",
      // CommonMark + GFM superset.
      markdownDialect: "markdown",
      supportsCodeBlocks: true,
      supportsBold: true,
      supportsItalic: true,
      supportsLinks: true,
      supportsInlineCode: true,
      // PUT /api/v4/posts/{id}/patch supports message edit, including
      // preserving interactive attachments.
      supportsMessageEdit: true,
    },
    inboundAttachments: {
      maxAttachmentCount: 10,
      // FileSettings.MaxFileSize default per file. Self-hosted can raise.
      maxDownloadBytes: 100 * 1024 * 1024,
      supportsDownload: true,
    },
    outboundAttachments: {
      maxUploadBytes: 100 * 1024 * 1024,
      supportsFileUpload: true,
      supportsImageUpload: true,
      // attachment.image_url renders inline previews without uploading.
      supportsRemoteImageUrl: true,
    },
  };

  readonly authorizedActorIds: readonly string[];

  private readonly client: Client4;
  private readonly websocketClient: WebSocketClient;
  private readonly callbackServer: MattermostCallbackServer;
  private readonly callbackHandleStore: MessagingCallbackHandleStore;
  private readonly callbackUrl: string;
  private readonly config: MattermostMessagingConfig;
  private readonly logger: MattermostProviderLogger;
  private readonly now: () => number;
  private listener: MattermostInboundListener | undefined;
  private botUserId: string | undefined;
  private started = false;

  constructor(options: MattermostAdapterOptions) {
    this.config = options.config;
    this.authorizedActorIds = [...options.config.authorizedActorIds];
    this.callbackHandleStore = options.callbackHandleStore;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.callbackUrl = options.config.callbackBaseUrl;

    this.client = options.client ?? new Client4();
    this.client.setUrl(options.config.serverUrl);
    this.client.setToken(options.config.botToken);
    this.client.setUserAgent("PwrAgent");

    // @mattermost/client@11.4.0+ defaults `newWebSocketFn` to
    // `(url) => new WebSocket(url)`, which resolves to Node's global
    // `WebSocket` (stable since Node 22; Electron 41 ships Node 22+). No
    // explicit injection needed.
    this.websocketClient = options.websocketClient ?? new WebSocketClient();

    this.callbackServer =
      options.callbackServer ??
      createMattermostCallbackServer({
        port: options.config.callbackPort ?? DEFAULT_CALLBACK_PORT,
        hmacSecret:
          options.config.callbackHmacSecret ?? generateMattermostHmacSecret(),
        handler: (body, rawBody) =>
          this.handleInteractiveCallback(body, rawBody),
        logger: this.logger,
      });
  }

  async start(listener: MattermostInboundListener): Promise<void> {
    if (this.started) {
      return;
    }
    this.listener = listener;
    await this.callbackServer.start();

    try {
      const me = await this.client.getMe();
      this.botUserId = me.id;
    } catch (error) {
      this.logger.error("mattermost client getMe failed", {
        error: error instanceof Error ? error.message : String(error),
        serverUrl: this.config.serverUrl,
      });
      throw error;
    }

    const wsUrl = `${this.config.serverUrl.replace(/^http/, "ws")}/api/v4/websocket`;
    this.websocketClient.addMessageListener((message) => {
      this.handleWebsocketMessage(message).catch((error) => {
        this.logger.error("mattermost websocket message handler crashed", {
          error: error instanceof Error ? error.message : String(error),
          event: message.event,
        });
      });
    });
    this.websocketClient.addCloseListener((connectFailCount) => {
      this.logger.warn("mattermost websocket closed", { connectFailCount });
    });
    this.websocketClient.addErrorListener((event) => {
      this.logger.warn("mattermost websocket error", {
        type: (event as { type?: string } | undefined)?.type ?? "unknown",
      });
    });
    this.websocketClient.initialize(wsUrl, this.config.botToken);

    this.started = true;
    this.logger.info("mattermost adapter started", {
      serverUrl: this.config.serverUrl,
      botUserId: this.botUserId,
      authorizedActorCount: this.authorizedActorIds.length,
    });
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.listener = undefined;
    try {
      this.websocketClient.close();
    } catch (error) {
      this.logger.warn("mattermost websocket close failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await this.callbackServer.stop();
    this.logger.info("mattermost adapter stopped", {});
  }

  async deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult> {
    try {
      switch (intent.kind) {
        case "activity":
          return await this.deliverActivity(intent);
        case "dismiss":
          return await this.deliverDismiss(intent);
        case "stream_update":
          return await this.deliverStreamUpdate(intent);
        case "message":
        case "status":
        case "progress":
        case "thread_picker":
        case "project_picker":
        case "single_select":
        case "multi_select":
        case "questionnaire":
        case "approval":
        case "confirmation":
        case "error":
          return await this.deliverPostIntent(intent);
        default: {
          const exhaustive: never = intent;
          void exhaustive;
          return {
            channel: this.channel,
            deliveredAt: this.now(),
            outcome: "unsupported",
          };
        }
      }
    } catch (error) {
      this.logger.error("mattermost deliver failed", {
        error: error instanceof Error ? error.message : String(error),
        intentKind: intent.kind,
        intentId: intent.id,
      });
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async downloadAttachment(
    request: MessagingAttachmentDownloadRequest,
  ): Promise<MessagingAttachmentDownloadResult> {
    const opaque = (request.attachment.state?.opaque ?? null) as
      | { fileId?: string }
      | null;
    const fileId = opaque?.fileId;
    if (!fileId) {
      throw new Error("mattermost attachment missing opaque fileId");
    }

    const url = `${this.config.serverUrl.replace(/\/+$/, "")}/api/v4/files/${encodeURIComponent(fileId)}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        "User-Agent": "PwrAgent",
      },
    });
    if (!response.ok) {
      throw new Error(
        `mattermost file download failed: ${response.status} ${response.statusText}`,
      );
    }
    const arrayBuffer = await response.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    const maxBytes = this.capabilityProfile.inboundAttachments?.maxDownloadBytes;
    if (typeof maxBytes === "number" && data.byteLength > maxBytes) {
      throw new Error(
        `mattermost attachment exceeds inbound size limit (${data.byteLength} > ${maxBytes})`,
      );
    }
    return {
      data,
      fileName: request.attachment.name,
      mimeType: request.attachment.mimeType,
      sizeBytes: data.byteLength,
    };
  }

  async setConversationTitle(request: {
    actor?: MessagingActorIdentity;
    channel: MessagingChannelRef;
    routingState?: MessagingAdapterState;
    title: string;
  }): Promise<{
    channel: "mattermost";
    conversation: MessagingChannelRef["conversation"];
    errorMessage?: string;
    outcome: "updated" | "unsupported" | "failed";
    title: string;
    updatedAt: number;
  }> {
    const channelId = request.channel.conversation.id;
    const header = clampHeader(request.title);
    try {
      await this.client.patchChannel(channelId, { header });
      return {
        channel: this.channel,
        conversation: request.channel.conversation,
        outcome: "updated",
        title: header,
        updatedAt: this.now(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn("mattermost patchChannel failed", {
        channelId,
        error: errorMessage,
      });
      return {
        channel: this.channel,
        conversation: request.channel.conversation,
        outcome: "failed",
        title: header,
        updatedAt: this.now(),
        errorMessage,
      };
    }
  }

  // -------------------------------------------------------------
  // Inbound: WebSocket message handling
  // -------------------------------------------------------------

  private async handleWebsocketMessage(
    message: WebSocketMessage,
  ): Promise<void> {
    if (!this.listener) {
      return;
    }
    switch (message.event) {
      case "posted":
        await this.handlePostedEvent(message);
        return;
      case "direct_added":
        await this.handleDirectAddedEvent(message);
        return;
      // post_edited, post_deleted, channel_updated, typing — not surfaced
      // to the controller today; reactions to them belong in follow-up
      // work if needed.
      default:
        return;
    }
  }

  private async handlePostedEvent(message: WebSocketMessage): Promise<void> {
    const data = (message.data ?? {}) as {
      post?: string;
      sender_name?: string;
      channel_display_name?: string;
      channel_name?: string;
      channel_type?: string;
      team_id?: string;
    };
    const post = parseEmbeddedPost(data.post);
    if (!post) {
      return;
    }
    if (this.botUserId && post.user_id === this.botUserId) {
      // Don't react to our own posts.
      return;
    }
    if (!this.authorizedActorIds.includes(post.user_id)) {
      this.logger.warn("mattermost ignored unauthorized actor", {
        actorId: post.user_id,
        channelId: post.channel_id,
        eventId: post.id,
      });
      return;
    }

    const channelRef = this.channelRefForPost(post, data);
    const actor: MessagingActorIdentity = {
      platformUserId: post.user_id,
      displayName: data.sender_name,
      username: data.sender_name,
      isBot: false,
    };

    const messageText = post.message ?? "";
    const fileIds: string[] = Array.isArray(post.file_ids) ? post.file_ids : [];

    if (fileIds.length > 0) {
      await this.dispatchMediaEvent({
        actor,
        channel: channelRef,
        eventId: post.id,
        fileIds,
        messageText,
      });
      return;
    }

    if (messageText.startsWith("/")) {
      await this.dispatchCommandEvent({
        actor,
        channel: channelRef,
        eventId: post.id,
        rawText: messageText,
      });
      return;
    }

    await this.dispatchTextEvent({
      actor,
      channel: channelRef,
      eventId: post.id,
      text: messageText,
    });
  }

  private async handleDirectAddedEvent(
    message: WebSocketMessage,
  ): Promise<void> {
    if (!this.listener) {
      return;
    }
    const data = (message.data ?? {}) as { channel_id?: string };
    const channelId = data.channel_id;
    if (!channelId) {
      return;
    }
    await this.listener({
      kind: "lifecycle",
      id: this.newEventId("lifecycle"),
      receivedAt: this.now(),
      actor: {
        platformUserId: this.botUserId ?? "bot",
        isBot: true,
      },
      channel: {
        channel: this.channel,
        conversation: {
          id: channelId,
          kind: "dm",
        },
      },
      lifecycle: "bound",
    });
  }

  // -------------------------------------------------------------
  // Inbound: HTTP callback handling
  // -------------------------------------------------------------

  private async handleInteractiveCallback(
    body: MattermostInteractiveCallbackBody,
    rawBody: string,
  ): Promise<MattermostCallbackHandlerResult | void> {
    if (!this.listener) {
      return;
    }
    void rawBody;
    if (!this.authorizedActorIds.includes(body.user_id)) {
      this.logger.warn("mattermost ignored unauthorized callback actor", {
        actorId: body.user_id,
        channelId: body.channel_id,
      });
      return;
    }
    const handle = stringField((body.context ?? {})["handle"]);
    if (!handle) {
      this.logger.warn("mattermost callback missing handle", {
        actorId: body.user_id,
        channelId: body.channel_id,
      });
      return;
    }
    // Mattermost interactive callbacks tell us the channel_id but not its
    // type — and we can't infer it from the id (DM channel ids look like
    // any other 26-char base32 id; `__` only appears in DM channel
    // *names*, not ids). The handle store keys on
    // `channel:kind:parentId:id`, so guessing wrong here causes a silent
    // resolve miss.
    //
    // We sign `(intentId, actionId, issuedAt)` in the HMAC; everything
    // else in `integration.context` is opaque routing metadata that
    // travels back to us untouched. Stash the conversation kind there at
    // delivery time and read it back here. Tampering can't change the
    // stored kind on the handle, so a forged value just makes the
    // resolve fail — same as no tampering.
    const contextKind = stringField((body.context ?? {})["channelKind"]);
    const conversationKind: MessagingConversationKind =
      contextKind === "dm"
        || contextKind === "channel"
        || contextKind === "thread"
        || contextKind === "topic"
        ? contextKind
        : "channel";
    const contextRootId = stringField((body.context ?? {})["rootId"]);
    const channelRef: MessagingChannelRef = {
      channel: this.channel,
      conversation: {
        id: body.channel_id,
        kind: conversationKind,
        ...(contextRootId ? { parentId: contextRootId } : {}),
      },
    };
    let resolvedHandle: MessagingCallbackHandleRecord | undefined;
    try {
      resolvedHandle = await this.callbackHandleStore.resolveCallbackHandle({
        actorId: body.user_id,
        channel: channelRef,
        handle,
        now: this.now(),
      });
    } catch (error) {
      this.logger.error("mattermost callback handle resolve failed", {
        error: error instanceof Error ? error.message : String(error),
        handle,
      });
      return;
    }
    if (!resolvedHandle) {
      this.logger.warn("mattermost callback handle unknown or expired", {
        handle,
        actorId: body.user_id,
      });
      return;
    }
    await this.listener({
      kind: "callback",
      id: this.newEventId("callback"),
      receivedAt: this.now(),
      actor: {
        platformUserId: body.user_id,
        displayName: body.user_name,
        username: body.user_name,
        isBot: false,
      },
      channel: channelRef,
      actionId: resolvedHandle.actionId,
      value: resolvedHandle.value,
      interaction: {
        channel: this.channel,
        id: body.trigger_id ?? body.post_id ?? handle,
        state: {
          opaque: {
            postId: body.post_id ?? null,
            triggerId: body.trigger_id ?? null,
          },
        },
      },
    });

    // Channel-neutral principle: the producer (controller) is the
    // single source of truth for what a post looks like after a click.
    // We do NOT issue an inline `update` here — that would be wrong for
    // refresh-style buttons (the producer re-renders with fresh data
    // and we'd race it), and it requires fetching the existing post to
    // preserve `message` text (Mattermost's `update` field treats a
    // missing `message` as "set to empty"). Keep the response a bare
    // ack and let the producer's update intent rewrite the surface the
    // same way it does on Telegram and Discord.
    return undefined;
  }

  private async dispatchTextEvent(params: {
    actor: MessagingActorIdentity;
    channel: MessagingChannelRef;
    eventId: string;
    text: string;
  }): Promise<void> {
    if (!this.listener) {
      return;
    }
    await this.listener({
      kind: "text",
      id: params.eventId,
      receivedAt: this.now(),
      actor: params.actor,
      channel: params.channel,
      text: params.text,
    });
  }

  private async dispatchCommandEvent(params: {
    actor: MessagingActorIdentity;
    channel: MessagingChannelRef;
    eventId: string;
    rawText: string;
  }): Promise<void> {
    if (!this.listener) {
      return;
    }
    const trimmed = params.rawText.trim();
    const [head, ...rest] = trimmed.split(/\s+/);
    const command = (head ?? "").replace(/^\//, "").toLowerCase();
    await this.listener({
      kind: "command",
      id: params.eventId,
      receivedAt: this.now(),
      actor: params.actor,
      channel: params.channel,
      command,
      args: rest,
      rawText: params.rawText,
    });
  }

  private async dispatchMediaEvent(params: {
    actor: MessagingActorIdentity;
    channel: MessagingChannelRef;
    eventId: string;
    fileIds: string[];
    messageText: string;
  }): Promise<void> {
    if (!this.listener) {
      return;
    }
    const attachments = await Promise.all(
      params.fileIds.map(async (fileId) => this.describeFile(fileId)),
    );
    const descriptors = attachments.filter(
      (value): value is MessagingAttachmentDescriptor => Boolean(value),
    );
    await this.listener({
      kind: "media",
      id: params.eventId,
      receivedAt: this.now(),
      actor: params.actor,
      channel: params.channel,
      text: params.messageText || undefined,
      attachments: descriptors,
      disposition: descriptors.length > 0 ? "available" : "unsupported",
    });
  }

  private async describeFile(
    fileId: string,
  ): Promise<MessagingAttachmentDescriptor | undefined> {
    try {
      const url = `${this.config.serverUrl.replace(/\/+$/, "")}/api/v4/files/${encodeURIComponent(fileId)}/info`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.config.botToken}`,
          "User-Agent": "PwrAgent",
        },
      });
      if (!response.ok) {
        this.logger.warn("mattermost file info fetch failed", {
          fileId,
          status: response.status,
        });
        return undefined;
      }
      const info = (await response.json()) as {
        name?: string;
        mime_type?: string;
        size?: number;
        width?: number;
        height?: number;
      };
      const isImage =
        typeof info.mime_type === "string" && info.mime_type.startsWith("image/");
      const descriptor: MessagingAttachmentDescriptor = {
        id: fileId,
        kind: isImage ? "image" : "file",
        name: info.name ?? `file-${fileId}`,
        sizeBytes: typeof info.size === "number" ? info.size : 0,
        ...(info.mime_type ? { mimeType: info.mime_type } : {}),
        ...(typeof info.width === "number" ? { width: info.width } : {}),
        ...(typeof info.height === "number" ? { height: info.height } : {}),
        disposition: "available",
        state: {
          opaque: { fileId },
        },
      };
      return descriptor;
    } catch (error) {
      this.logger.warn("mattermost file info fetch crashed", {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  // -------------------------------------------------------------
  // Outbound delivery
  // -------------------------------------------------------------

  private async deliverPostIntent(
    intent: Exclude<
      MessagingSurfaceIntent,
      | { kind: "activity" }
      | { kind: "dismiss" }
      | { kind: "stream_update" }
    >,
  ): Promise<MessagingDeliveryResult> {
    const target = await this.resolveTarget(intent);
    if (!target) {
      this.logger.warn("mattermost deliver: no channel resolved for intent", {
        intentKind: intent.kind,
        intentId: intent.id,
        hasAudit: Boolean(
          (intent as { audit?: unknown }).audit,
        ),
        hasTargetSurface: Boolean(
          (intent as { targetSurface?: unknown }).targetSurface,
        ),
      });
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "failed",
        errorMessage: "no Mattermost channel resolved for intent",
      };
    }

    const text = clampMattermostMessage(textForMattermostIntent(intent));
    const actions = actionsForMattermostIntent(intent);
    const callbackContextBuilder = await this.buildCallbackContextBuilder({
      intent,
      channelRef: target.channelRef,
      actorId: target.actorId,
    });

    const buttons = buildMattermostActions({
      actions,
      buildCallbackContext: callbackContextBuilder,
      callbackUrl: this.callbackUrl,
      capabilityProfile: this.capabilityProfile,
      layout: intent.actionLayout,
    });

    const attachment: MattermostMessageAttachment | undefined = buttons
      ? { actions: buttons }
      : undefined;

    const fileIds = await this.uploadOutboundFiles({
      channelId: target.channelId,
      intent,
    });

    const post: MattermostPostBody = {
      message: text || " ",
      ...(target.rootId ? { root_id: target.rootId } : {}),
      ...(fileIds.length > 0 ? { file_ids: fileIds } : {}),
      ...(attachment ? { props: { attachments: [attachment] } } : {}),
    };

    if (target.existingPostId && target.canUpdate) {
      // Mattermost's PATCH /posts only updates fields you provide — a
      // missing `props` key keeps the old props (and old buttons). When
      // the producer says "this update has no buttons" or
      // `delivery.replaceMarkup: true`, we must actively send
      // `props: { attachments: [] }` to clear them. This mirrors
      // Telegram (`reply_markup: { inline_keyboard: [] }`) and Discord
      // (`components: []`).
      const replaceMarkup =
        Boolean((intent as { delivery?: { replaceMarkup?: boolean } }).delivery?.replaceMarkup);
      const propsForPatch =
        post.props
          ? post.props
          : replaceMarkup
            ? { attachments: [] as MattermostMessageAttachment[] }
            : undefined;
      const patched = await this.client.patchPost({
        id: target.existingPostId,
        message: post.message,
        ...(propsForPatch ? { props: propsForPatch } : {}),
        ...(fileIds.length > 0 ? { file_ids: fileIds } : {}),
      });
      const surface: MessagingSurfaceRef = surfaceRefForPost(
        patched.id,
        target.channelId,
        target.rootId,
      );
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "updated",
        surface,
      };
    }

    const created = await this.client.createPost({
      channel_id: target.channelId,
      message: post.message,
      ...(post.root_id ? { root_id: post.root_id } : {}),
      ...(post.props ? { props: post.props } : {}),
      ...(post.file_ids ? { file_ids: post.file_ids } : {}),
    });

    let outcome: MessagingDeliveryResult["outcome"] = "presented";
    if (intent.kind === "status" && intent.delivery?.pin === true) {
      try {
        await this.client.pinPost(created.id);
        outcome = "pinned";
      } catch (error) {
        this.logger.warn("mattermost pinPost failed", {
          postId: created.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const surface: MessagingSurfaceRef = surfaceRefForPost(
      created.id,
      target.channelId,
      target.rootId,
    );
    return {
      channel: this.channel,
      deliveredAt: this.now(),
      outcome,
      surface,
    };
  }

  private async deliverActivity(
    intent: MessagingSurfaceIntent & { kind: "activity" },
  ): Promise<MessagingDeliveryResult> {
    if (intent.activity !== "typing") {
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "discarded",
      };
    }
    const channelRef = (intent.targetSurface as MessagingSurfaceRef | undefined)
      ?.state?.opaque as { channelId?: string } | undefined;
    const channelId = channelRef?.channelId;
    if (intent.state === "active" && channelId) {
      try {
        this.websocketClient.userTyping(channelId, "");
      } catch (error) {
        this.logger.debug?.("mattermost userTyping failed", {
          channelId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Mattermost has no "typing stopped" signal; idle is implicit (lease).
    return {
      channel: this.channel,
      deliveredAt: this.now(),
      outcome: "signaled",
    };
  }

  private async deliverDismiss(
    intent: MessagingSurfaceIntent & { kind: "dismiss" },
  ): Promise<MessagingDeliveryResult> {
    const target = intent.targetSurface;
    const opaque = target.state?.opaque as MattermostSurfaceOpaqueState | undefined;
    if (!opaque?.postId) {
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "discarded",
      };
    }
    if (intent.delivery?.unpin === true) {
      try {
        await this.client.unpinPost(opaque.postId);
      } catch (error) {
        this.logger.debug?.("mattermost unpinPost failed", {
          postId: opaque.postId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await this.client.deletePost(opaque.postId);
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "dismissed",
      };
    } catch (error) {
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async deliverStreamUpdate(
    intent: MessagingSurfaceIntent & { kind: "stream_update" },
  ): Promise<MessagingDeliveryResult> {
    if (this.config.streamingResponses === false) {
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "discarded",
      };
    }
    const target = intent.targetSurface as MessagingSurfaceRef | undefined;
    const opaque = target?.state?.opaque as MattermostSurfaceOpaqueState | undefined;
    if (!opaque?.postId) {
      // No prior post to edit — let the controller present a new one
      // through the regular `message` path next.
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "discarded",
      };
    }
    try {
      await this.client.patchPost({
        id: opaque.postId,
        message: clampMattermostMessage(intent.text),
      });
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "updated",
        surface: target!,
      };
    } catch (error) {
      this.logger.debug?.("mattermost stream update patch failed", {
        postId: opaque.postId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        channel: this.channel,
        deliveredAt: this.now(),
        outcome: "discarded",
      };
    }
  }

  // -------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------

  private async resolveTarget(intent: MessagingSurfaceIntent): Promise<
    | undefined
    | {
        channelId: string;
        rootId?: string;
        actorId: string;
        channelRef: MessagingChannelRef;
        existingPostId?: string;
        canUpdate: boolean;
      }
  > {
    // Two sources of truth, mirroring Telegram/Discord:
    // 1. `intent.audit?.channel` — populated by the controller for fresh
    //    intents replying to an inbound message; this is the primary
    //    routing signal.
    // 2. `intent.targetSurface.state.opaque` — populated when we
    //    previously delivered a post and want to update or thread off of
    //    it. Tracks Mattermost channel/post/root IDs across restarts via
    //    `MessagingAdapterState.opaque`.
    const targetSurface = (intent as { targetSurface?: MessagingSurfaceRef })
      .targetSurface;
    const targetOpaque = targetSurface?.state?.opaque as
      | MattermostSurfaceOpaqueState
      | undefined;
    const auditChannel = (intent as { audit?: { channel?: MessagingChannelRef; actor?: MessagingActorIdentity } })
      .audit;
    const channelRefFromAudit = auditChannel?.channel;
    const actorId =
      auditChannel?.actor?.platformUserId
      ?? this.authorizedActorIds[0]
      ?? "";

    if (targetOpaque?.channelId) {
      const canUpdate =
        ((intent as { delivery?: { mode?: string } }).delivery?.mode === "update");
      return {
        channelId: targetOpaque.channelId,
        rootId: targetOpaque.rootId,
        actorId,
        channelRef:
          channelRefFromAudit ?? {
            channel: this.channel,
            conversation: {
              id: targetOpaque.channelId,
              kind: "channel",
            },
          },
        existingPostId: targetOpaque.postId,
        canUpdate,
      };
    }
    if (!channelRefFromAudit) {
      return undefined;
    }
    // Encoding from `channelRefForPost`:
    //   conversation.id        = Mattermost channel_id (always)
    //   conversation.parentId  = root post id (thread replies only)
    // Mattermost's createPost takes (channel_id, root_id?), so this
    // mapping is direct — unlike Discord where the thread *is* a
    // channel, or Telegram where parentId is the chat id.
    const conv = channelRefFromAudit.conversation;
    const rootId = conv.kind === "thread" ? conv.parentId : undefined;
    return {
      channelId: conv.id,
      rootId,
      actorId,
      channelRef: channelRefFromAudit,
      canUpdate: false,
    };
  }

  private async buildCallbackContextBuilder(params: {
    intent: MessagingSurfaceIntent;
    channelRef: MessagingChannelRef;
    actorId: string;
  }): Promise<(action: MessagingSurfaceAction) => Record<string, unknown>> {
    return (action: MessagingSurfaceAction) => {
      const handle = `${this.channel}:${createHash("sha256")
        .update(
          JSON.stringify([params.intent.id, action.id, action.value ?? null]),
        )
        .digest("base64url")
        .slice(0, 18)}`;
      const { hmac, issuedAt } = this.callbackServer.signContext({
        intentId: params.intent.id,
        actionId: action.id,
      });
      const now = this.now();
      void this.callbackHandleStore
        .upsertCallbackHandle({
          id: `mattermost-callback:${handle}`,
          actionId: action.id,
          allowedActorIds: [params.actorId],
          channel: params.channelRef,
          createdAt: now,
          updatedAt: now,
          expiresAt: now + 15 * 60 * 1000,
          handle,
          pendingIntentId: params.intent.id,
          ...(action.value !== undefined ? { value: action.value } : {}),
        })
        .catch((error) => {
          this.logger.warn("mattermost callback handle persist failed", {
            error: error instanceof Error ? error.message : String(error),
            handle,
          });
        });
      // `channelKind` and `rootId` are not part of the HMAC — they're
      // routing breadcrumbs the callback handler needs because Mattermost
      // doesn't echo conversation-type or thread-root in the callback
      // body, and the handle store keys on `channel:kind:parentId:id`.
      // See `handleInteractiveCallback` for the consumer side.
      return {
        handle,
        intentId: params.intent.id,
        actionId: action.id,
        issuedAt,
        hmac,
        channelKind: params.channelRef.conversation.kind,
        ...(params.channelRef.conversation.parentId
          ? { rootId: params.channelRef.conversation.parentId }
          : {}),
      };
    };
  }

  private async uploadOutboundFiles(params: {
    channelId: string;
    intent: MessagingSurfaceIntent;
  }): Promise<string[]> {
    if (params.intent.kind !== "message") {
      return [];
    }
    const fileParts = params.intent.parts.filter(
      (part): part is import("@pwragent/messaging-interface").MessagingFilePart =>
        part.type === "file",
    );
    if (fileParts.length === 0) {
      return [];
    }
    const maxBytes =
      this.capabilityProfile.outboundAttachments?.maxUploadBytes ?? Infinity;
    const ids: string[] = [];
    for (const part of fileParts) {
      try {
        if (!part.data && !part.url) {
          continue;
        }
        const bytes = part.data ?? (await fetchRemoteBytes(part.url!));
        if (bytes.byteLength > maxBytes) {
          this.logger.warn("mattermost outbound file exceeds size cap", {
            name: part.name,
            sizeBytes: bytes.byteLength,
            maxBytes,
          });
          continue;
        }
        const formData = new FormData();
        formData.append("channel_id", params.channelId);
        // Copy into a fresh ArrayBuffer-backed view to satisfy `Blob`'s
        // BlobPart type (Uint8Array<ArrayBufferLike> is not assignable
        // to ArrayBufferView<ArrayBuffer> on Node 22's lib types).
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        formData.append(
          "files",
          new Blob([buffer], { type: part.mimeType ?? "application/octet-stream" }),
          part.name,
        );
        const response = await this.client.uploadFile(formData);
        for (const fileInfo of response.file_infos ?? []) {
          if (fileInfo?.id) {
            ids.push(fileInfo.id);
          }
        }
      } catch (error) {
        this.logger.warn("mattermost outbound file upload failed", {
          name: part.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return ids;
  }

  private channelRefForPost(
    post: { channel_id: string; root_id?: string; id: string },
    data: { channel_type?: string; team_id?: string },
  ): MessagingChannelRef {
    const isThread = Boolean(post.root_id && post.root_id !== post.id);
    return {
      channel: this.channel,
      conversation: {
        id: post.channel_id,
        kind: isThread
          ? "thread"
          : data.channel_type === "D" || data.channel_type === "G"
          ? "dm"
          : "channel",
        ...(isThread && post.root_id ? { parentId: post.root_id } : {}),
      },
    };
  }

  private newEventId(prefix: string): string {
    return `mattermost-${prefix}-${this.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/**
 * Factory mirror of `createDiscordAdapter` / `createTelegramAdapter`. Used
 * by the desktop provider loader.
 */
export function createMattermostAdapter(
  config: MattermostMessagingConfig,
  callbackHandleStore: MessagingCallbackHandleStore,
  logger: MattermostProviderLogger,
): MattermostAdapter {
  return new MattermostAdapter({
    callbackHandleStore,
    config,
    logger,
  });
}

function clampHeader(text: string): string {
  return text.length > MATTERMOST_CHANNEL_HEADER_LIMIT
    ? text.slice(0, MATTERMOST_CHANNEL_HEADER_LIMIT)
    : text;
}

function parseEmbeddedPost(
  raw: string | undefined,
): { id: string; channel_id: string; user_id: string; message: string; root_id?: string; file_ids?: string[]; props?: Record<string, unknown> } | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as {
      id?: string;
      channel_id?: string;
      user_id?: string;
      message?: string;
      root_id?: string;
      file_ids?: string[];
      props?: Record<string, unknown>;
    };
    if (!parsed.id || !parsed.channel_id || !parsed.user_id) {
      return undefined;
    }
    return {
      id: parsed.id,
      channel_id: parsed.channel_id,
      user_id: parsed.user_id,
      message: parsed.message ?? "",
      ...(parsed.root_id ? { root_id: parsed.root_id } : {}),
      ...(parsed.file_ids ? { file_ids: parsed.file_ids } : {}),
      ...(parsed.props ? { props: parsed.props } : {}),
    };
  } catch {
    return undefined;
  }
}

function surfaceRefForPost(
  postId: string,
  channelId: string,
  rootId: string | undefined,
): MessagingSurfaceRef {
  const opaque: Record<string, string> = {
    postId,
    channelId,
    ...(rootId ? { rootId } : {}),
  };
  return {
    channel: "mattermost",
    id: postId,
    state: { opaque },
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function fetchRemoteBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `remote file fetch failed: ${response.status} ${response.statusText}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}
