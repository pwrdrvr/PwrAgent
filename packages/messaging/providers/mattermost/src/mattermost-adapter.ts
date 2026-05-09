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
  MessagingClientRateLimitStrategy,
  MessagingConversationKind,
  MessagingDeliveryScope,
  MessagingDeliveryResult,
  MessagingInboundEvent,
  MessagingInboundRejectedListener,
  MessagingJsonValue,
  MessagingRejectedInboundEvent,
  MessagingReconnectInfo,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
  MessagingSurfaceRef,
} from "@pwragent/messaging-interface";
import { extractMessagingPairingToken } from "@pwragent/messaging-interface";
import type { MattermostMessagingConfig } from "./mattermost-config.ts";
import {
  createMattermostCallbackServer,
  generateMattermostHmacSecret,
  type MattermostCallbackHandlerResult,
  type MattermostCallbackServer,
  type MattermostInteractiveCallbackBody,
  type MattermostSlashCommandBody,
  type MattermostSlashCommandResult,
} from "./mattermost-callback-server.ts";
import {
  baseTriggerForPrefixed,
  desiredMattermostCommands,
  reconcileMattermostCommands,
  sanitizeMattermostCommandPrefix,
  type MattermostCommandsApi,
  type MattermostReconcileResult,
} from "./mattermost-commands.ts";
import {
  actionsForMattermostIntent,
  buildMattermostActions,
  clampMattermostMessage,
  textForMattermostIntent,
  type MattermostMessageAttachment,
  type MattermostPostBody,
} from "./mattermost-formatting.ts";
import {
  logMattermostInvalidIdentifier,
  validateMattermostCallbackHandle,
  validateMattermostId,
  type MattermostIdentifierField,
} from "./validate-ids.ts";

const DEFAULT_CALLBACK_PORT = 47821;

/**
 * Minimum consecutive websocket failures before we declare the adapter
 * runtime-errored. The Mattermost `WebSocketClient` auto-reconnects
 * with exponential backoff and fires its close listener once per
 * attempt; we don't want a single hiccup to flap the status indicator.
 *
 * 3 attempts at the default backoff ≈ 12s of sustained failure before
 * the user sees red — long enough to ride out a brief blip, short
 * enough that bad-token / bad-URL setups surface quickly.
 */
const MATTERMOST_WS_FAIL_THRESHOLD = 3;

/**
 * Derive the local HTTP listener port from the public callback URL.
 *
 * - `http://localhost:47821/cb`        → 47821 (localhost-direct mode)
 * - `http://host.docker.internal:1234/` → 1234  (Docker-on-host)
 * - `https://chat.example.com/mm/cb`   → 47821 (tunnel mode — public TLS)
 *
 * The URL Mattermost dials and the local bind port are separate
 * concerns ONLY when a tunnel terminates TLS and forwards to localhost.
 * In every other deployment Mattermost dials the URL directly, so the
 * URL's port and the bind port MUST match. Deriving from the URL makes
 * that guarantee structural rather than aspirational.
 *
 * Unparsable URLs fall through to the default; the higher-level
 * `loadDesktopMessagingConfigFromSettings` already gates startup on
 * a non-empty `callbackBaseUrl`, so an unparsable URL means the
 * runtime config layer made a mistake.
 */
function bindPortFromCallbackUrl(callbackBaseUrl: string): number {
  try {
    const parsed = new URL(callbackBaseUrl);
    if (parsed.port) {
      const port = Number(parsed.port);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        return port;
      }
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_CALLBACK_PORT;
}

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
  clientRateLimitStrategy: MessagingClientRateLimitStrategy;
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  resolveDeliveryScope?(intent: MessagingSurfaceIntent): MessagingDeliveryScope | undefined;
  downloadAttachment(
    request: MessagingAttachmentDownloadRequest,
  ): Promise<MessagingAttachmentDownloadResult>;
  /**
   * Subscribe to fatal post-start runtime errors. Fires once per
   * runtime-error episode, NOT per transient websocket retry.
   * The desktop runtime subscribes after `start()` and flips platform
   * health to `errored`, which turns the status-bar dot red.
   *
   * The Mattermost icon stays unaltered (brand guidelines forbid
   * recoloring the mark, so the renderer reds the dot only — not the
   * `<img>` icon, which is structurally insulated from `currentColor`).
   */
  onRuntimeError?(listener: (reason: string) => void): () => void;
  onReconnect?(listener: (info: MessagingReconnectInfo) => void): () => void;
  onInboundRejected?(listener: MessagingInboundRejectedListener): () => void;
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
 *
 * Two shapes share this slot:
 *
 * 1. **Post-tracking** (after delivery): `postId`, `channelId`, and
 *    optionally `rootId` are populated from the server's response. Used
 *    by `resolveTarget` to drive `patchPost` / `pinPost` lookups for
 *    follow-up updates to the same surface.
 *
 * 2. **Slash-command response_url hint** (before first delivery): the
 *    slash-command path stashes `responseUrl` here so `deliverPostIntent`
 *    can route the FIRST outbound delivery via Mattermost's
 *    `response_url` integration endpoint instead of `Client4.createPost`.
 *    This is the workaround for Mattermost's missing `root_id` field on
 *    custom slash-command webhook bodies (v10.11 and earlier — fixed on
 *    `master`). See `docs/messaging-platform-integration.md` for details.
 *    Mattermost preserves thread context server-side when posting via
 *    response_url, so the picker renders in-thread without us ever
 *    knowing the root_id directly.
 */
type MattermostSurfaceOpaqueState = {
  postId?: string;
  channelId?: string;
  rootId?: string;
  responseUrl?: string;
  /**
   * Mattermost's response_url handler stamps the resulting post with
   * `args.UserId` (the invoking user) rather than the bot's user_id.
   * We need this id to recover the just-created post in
   * `getPostsSince` (filtered by user_id) and to correlate the WS
   * `posted` echo back to our delivery for dedup.
   */
  responseUrlInvokerUserId?: string;
};

export class MattermostAdapter implements MattermostProviderAdapter {
  readonly channel = "mattermost" as const;
  readonly clientRateLimitStrategy: MessagingClientRateLimitStrategy = "direct";
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
  private botUsername: string | undefined;
  private started = false;
  /**
   * `true` once `stop()` has been called. Suppresses the runtime-error
   * fan-out for any websocket-close / -error events that fire as part
   * of normal shutdown (the WebSocketClient closes the socket, which
   * fires the close listener with no `connectFailCount`-honoring
   * caller). Mirrors the pattern in `telegram-adapter.ts`.
   */
  private stopping = false;
  /**
   * Latched once the websocket has fired `onRuntimeError` for sustained
   * disconnect. Prevents multi-fire across each retry attempt — once
   * the platform health is `errored` there's nothing more for the
   * runtime to do, and additional fan-outs would just be noise.
   * Reset on `stop()` so a subsequent `start()` can re-arm.
   */
  private wsErroredLatched = false;
  private readonly runtimeErrorListeners = new Set<(reason: string) => void>();
  private readonly reconnectListeners = new Set<
    (info: MessagingReconnectInfo) => void
  >();
  private websocketReconnectActive = false;
  /**
   * Live token set, owned by the adapter and shared by reference with
   * the callback server. The reconciler mutates this on every
   * `start()` (and any future re-reconcile tick) — the server reads
   * fresh state on each command POST.
   */
  private readonly slashCommandTokens = new Set<string>();
  /**
   * Cache of `rootId → truncated root message`, used to populate
   * `MessagingConversationRef.title` for thread-bound conversations
   * so the binding chip shows the thread's actual subject instead of
   * a bare "Thread" label. Populated lazily on first inbound thread
   * reply per root.
   */
  private readonly threadRootMessageCache = new Map<string, string>();
  /**
   * Post ids we created via `response_url` (the slash-command delayed
   * response endpoint). Mattermost's response_url handler stamps the
   * resulting post with the **invoking user's** `user_id` (with a
   * `[BOT]` UI tag) instead of the bot's user_id — so when Mattermost
   * broadcasts the post via the `posted` WS event, our normal
   * `post.user_id === this.botUserId` filter misses it. Without this
   * dedup, the bot's own status surface echoes back as inbound user
   * text, gets routed to a bound thread, and Codex starts a turn
   * "responding" to the bot's own status block.
   *
   * Entries are removed lazily by `setTimeout`; 60s is generous
   * compared to typical WS round-trip but avoids unbounded growth.
   */
  private readonly responseUrlPostIds = new Set<string>();
  private readonly unauthorizedConversationLogKeys = new Set<string>();
  private readonly inboundRejectedListeners = new Set<MessagingInboundRejectedListener>();
  /**
   * Last reconciliation result per team, kept for diagnostics + future
   * re-reconcile passes (e.g. on team-membership change).
   */
  private slashCommandReconciliations: MattermostReconcileResult[] = [];

  constructor(options: MattermostAdapterOptions) {
    this.config = options.config;
    this.authorizedActorIds = options.config.authorizedActorIds.map(
      (contact) => contact.id,
    );
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
        port: bindPortFromCallbackUrl(options.config.callbackBaseUrl),
        hmacSecret:
          options.config.callbackHmacSecret ?? generateMattermostHmacSecret(),
        handler: (body, rawBody) =>
          this.handleInteractiveCallback(body, rawBody),
        slashCommandHandler: (body, rawBody) =>
          this.handleSlashCommand(body, rawBody),
        validSlashCommandTokens: this.slashCommandTokens,
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
      const me = (await this.client.getMe()) as { id: string; username?: string };
      this.botUserId = me.id;
      this.botUsername = me.username;
    } catch (error) {
      this.logger.error("mattermost client getMe failed", {
        error: error instanceof Error ? error.message : String(error),
        serverUrl: this.config.serverUrl,
      });
      throw error;
    }

    // Strip any trailing slash before appending the websocket path —
    // `http://host:port/` would otherwise become `ws://host:port//api/v4/websocket`
    // and Mattermost rejects that with a 1006 close. The runtime
    // config layer normalizes URLs at the boundary, but defend here
    // too in case a caller constructs the adapter directly.
    const wsUrl = `${this.config.serverUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/api/v4/websocket`;
    this.websocketClient.addMessageListener((message) => {
      if (this.websocketReconnectActive) {
        this.websocketReconnectActive = false;
        this.emitReconnect({ state: "recovered", observedAt: this.now() });
      }
      this.handleWebsocketMessage(message).catch((error) => {
        this.logger.error("mattermost websocket message handler crashed", {
          error: error instanceof Error ? error.message : String(error),
          event: message.event,
        });
      });
    });
    this.websocketClient.addCloseListener((connectFailCount) => {
      this.logger.warn("mattermost websocket closed", { connectFailCount });
      // Mattermost's WebSocketClient auto-reconnects with backoff and
      // fires this listener once per failed reconnect attempt. We don't
      // want a single transient blip to flap the platform health, so
      // wait until the retry counter shows sustained failure.
      //
      // The same path covers two failure modes the user-visible status
      // dot needs to reflect:
      //   - startup ws failure (bad token, bad URL, server unreachable)
      //     — `initialize()` doesn't throw; the ws lifecycle just keeps
      //     closing
      //   - mid-run disconnect (network drop, server shutdown)
      //
      // Both manifest as connectFailCount climbing past the threshold.
      if (
        !this.stopping
        && !this.wsErroredLatched
        && connectFailCount >= MATTERMOST_WS_FAIL_THRESHOLD
      ) {
        this.wsErroredLatched = true;
        this.emitRuntimeError(
          `websocket disconnected (${connectFailCount} consecutive failures)`,
        );
      } else if (!this.stopping && connectFailCount > 0) {
        this.websocketReconnectActive = true;
        this.emitReconnect({
          state: "started",
          attemptCount: connectFailCount,
          observedAt: this.now(),
        });
      }
    });
    this.websocketClient.addErrorListener((event) => {
      this.logger.warn("mattermost websocket error", {
        type: (event as { type?: string } | undefined)?.type ?? "unknown",
      });
    });
    this.websocketClient.initialize(wsUrl, this.config.botToken);

    // Reconcile slash commands against every team the bot is a member
    // of. Mattermost commands are team-scoped — `addCommand` requires
    // a `team_id`, and the Mattermost UI's autocomplete is per-team.
    // We list teams once at start and reconcile each; if the bot is
    // added to a new team mid-session, the user can restart the
    // adapter to pick it up. (A team-membership webhook listener is
    // a future improvement.)
    //
    // Defensive: any failure here doesn't fail adapter start — slash
    // commands are an autocomplete UX nicety, not a correctness
    // requirement. `@<bot> resume` text-mentions still work without
    // them.
    //
    // Off by default. Mattermost 10.x slash-command bodies omit
    // `root_id`, so the response can't thread — the recommended path
    // is `@<bot> help` text-mentions. Operators can opt in via the
    // settings toggle when they accept the v10.x channel-reply
    // tradeoff.
    if (this.config.registerSlashCommands === true) {
      await this.reconcileSlashCommandsAcrossTeams();
    } else {
      this.logger.info(
        "mattermost adapter: slash-command registration disabled (registerSlashCommands=false)",
      );
    }

    this.started = true;
    this.logger.info("mattermost adapter started", {
      serverUrl: this.config.serverUrl,
      botUserId: this.botUserId,
      authorizedActorCount: this.authorizedActorIds.length,
      slashCommandTeams: this.slashCommandReconciliations.length,
      slashCommandTokens: this.slashCommandTokens.size,
    });
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.stopping = true;
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
    // Reset latch + drop listeners so a subsequent `start()` re-arms.
    this.runtimeErrorListeners.clear();
    this.reconnectListeners.clear();
    this.wsErroredLatched = false;
    this.websocketReconnectActive = false;
    this.stopping = false;
    this.logger.info("mattermost adapter stopped", {});
  }

  /**
   * Subscribe to fatal post-start runtime errors. The desktop runtime
   * uses this to flip platform health to `errored` after the websocket
   * has failed to (re)connect for `MATTERMOST_WS_FAIL_THRESHOLD`
   * consecutive attempts. Returns an unsubscribe.
   */
  onRuntimeError(listener: (reason: string) => void): () => void {
    this.runtimeErrorListeners.add(listener);
    return () => {
      this.runtimeErrorListeners.delete(listener);
    };
  }

  onReconnect(listener: (info: MessagingReconnectInfo) => void): () => void {
    this.reconnectListeners.add(listener);
    return () => {
      this.reconnectListeners.delete(listener);
    };
  }

  private emitRuntimeError(reason: string): void {
    for (const listener of this.runtimeErrorListeners) {
      try {
        listener(reason);
      } catch (error) {
        this.logger.warn("mattermost runtime-error listener threw", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private emitReconnect(info: MessagingReconnectInfo): void {
    for (const listener of this.reconnectListeners) {
      try {
        listener(info);
      } catch (error) {
        this.logger.warn("mattermost reconnect listener threw", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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

  resolveDeliveryScope(intent: MessagingSurfaceIntent): MessagingDeliveryScope | undefined {
    const targetSurface = (intent as { targetSurface?: MessagingSurfaceRef }).targetSurface;
    const targetOpaque = targetSurface?.state?.opaque as
      | MattermostSurfaceOpaqueState
      | undefined;
    const audit = (intent as { audit?: { channel?: MessagingChannelRef } }).audit;
    const channelRef = audit?.channel;
    const channelId = targetOpaque?.channelId ?? channelRef?.conversation.id;
    if (!channelId) {
      return undefined;
    }
    const rootId =
      targetOpaque?.rootId
      ?? (channelRef?.conversation.kind === "thread"
        ? channelRef.conversation.parentId
        : undefined);
    return {
      platform: this.channel,
      id: rootId
        ? `mattermost:thread:${channelId}:${rootId}`
        : `mattermost:channel:${channelId}`,
      kind: rootId ? "thread" : "channel",
      label: rootId ? "Mattermost thread" : "Mattermost channel",
      ...(rootId ? { parentId: channelId } : {}),
      budget: { limit: 1, intervalMs: 1_000, reserved: 0 },
    };
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

  onInboundRejected(listener: MessagingInboundRejectedListener): () => void {
    this.inboundRejectedListeners.add(listener);
    return () => {
      this.inboundRejectedListeners.delete(listener);
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
    if (!this.validatePostIdentifiers(post)) {
      return;
    }
    if (this.botUserId && post.user_id === this.botUserId) {
      // Don't react to our own posts.
      return;
    }
    // Defense against the response_url echo loop: posts we just
    // created via Mattermost's slash-command delayed response endpoint
    // come back to us via the WS broadcast with the **invoking user's**
    // user_id (Mattermost's response_url handler attributes the post
    // to the invoker, not the bot, even when the bot owns the
    // command). The user_id-based filter above misses them. Without
    // this dedup, our own status surface echoes back as inbound user
    // text and Codex starts a turn responding to the bot's own block.
    if (this.responseUrlPostIds.has(post.id)) {
      this.logger.debug?.(
        "mattermost: ignoring posted echo of our own response_url delivery",
        { postId: post.id },
      );
      return;
    }
    // Defense-in-depth (catches response_url echoes whose post.id we
    // didn't track for any reason, plus any other bot-attributed
    // webhook integrations on the same channel): Mattermost stamps
    // posts originating from `username`-overriding integrations with
    // `props.from_webhook = "true"`. Treat those as bot-authored
    // regardless of post.user_id.
    const fromWebhook = (post.props ?? {})["from_webhook"];
    if (fromWebhook === "true" || fromWebhook === true) {
      this.logger.debug?.("mattermost: ignoring webhook-attributed posted event", {
        postId: post.id,
        userId: post.user_id,
      });
      return;
    }
    const messageText = post.message ?? "";
    const isPairingMessage = Boolean(extractMessagingPairingToken(messageText));
    if (!isPairingMessage && !this.authorizedActorIds.includes(post.user_id)) {
      this.logUnauthorizedPostIfActionable(post, data);
      return;
    }

    const rootSummary =
      post.root_id && post.root_id !== post.id
        ? await this.fetchThreadRootSummary(post.root_id)
        : undefined;
    const channelRef = this.channelRefForPost(post, data, rootSummary);
    const actor: MessagingActorIdentity = {
      platformUserId: post.user_id,
      displayName: data.sender_name,
      username: data.sender_name,
      isBot: false,
    };

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

    // `@<botUsername> <verb>` text mention → command. Works on every
    // Mattermost server version (the WS `posted` event always carries
    // full thread context via `post.root_id`), unlike v10.x slash
    // commands which need the response_url workaround. Users get a
    // path that "just works" in threads without depending on server
    // version. The mention prefix is case-insensitive because
    // Mattermost's autocomplete inserts the canonical username but
    // users may type-correct or use shell-style tab completion.
    const stripped = stripBotMention(messageText, this.botUsername);
    if (stripped !== undefined) {
      await this.dispatchCommandEvent({
        actor,
        channel: channelRef,
        eventId: post.id,
        // Synthesize the slash form so `dispatchCommandEvent`'s
        // existing parser strips the leading `/` and produces a
        // standard `MessagingInboundCommandEvent` — the controller
        // sees the same shape regardless of slash-vs-mention origin.
        rawText: `/${stripped}`,
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
    if (!this.validateIdentifier("channel_id", channelId, validateMattermostId)) {
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

  private validatePostIdentifiers(
    post: NonNullable<ReturnType<typeof parseEmbeddedPost>>,
  ): boolean {
    return (
      this.validateIdentifier("post_id", post.id, validateMattermostId)
      && this.validateIdentifier("channel_id", post.channel_id, validateMattermostId)
      && this.validateIdentifier("user_id", post.user_id, validateMattermostId)
      && (post.root_id === undefined
        || this.validateIdentifier("root_id", post.root_id, validateMattermostId))
      && this.validateFileIds(post.file_ids ?? [])
    );
  }

  private validateFileIds(fileIds: string[]): boolean {
    for (const fileId of fileIds) {
      if (!this.validateIdentifier("file_id", fileId, validateMattermostId)) {
        return false;
      }
    }
    return true;
  }

  private validateIdentifier(
    field: MattermostIdentifierField,
    value: unknown,
    validator: (value: unknown) => ReturnType<typeof validateMattermostId>,
  ): boolean {
    const result = validator(value);
    if (result.ok) {
      return true;
    }
    logMattermostInvalidIdentifier({
      field,
      logger: this.logger,
      reason: result.reason,
      value,
    });
    return false;
  }

  private logUnauthorizedPostIfActionable(
    post: NonNullable<ReturnType<typeof parseEmbeddedPost>>,
    data: {
      channel_type?: string;
      sender_name?: string;
      channel_display_name?: string;
    },
  ): void {
    const messageText = post.message ?? "";
    const actionable =
      messageText.startsWith("/") ||
      stripBotMention(messageText, this.botUsername) !== undefined;
    const isDm = data.channel_type === "D";
    if (!isDm && !actionable) {
      return;
    }
    const key = isDm ? `dm:${post.channel_id}:${post.user_id}` : `action:${post.id}`;
    if (this.unauthorizedConversationLogKeys.has(key)) {
      return;
    }
    this.unauthorizedConversationLogKeys.add(key);
    this.logger.warn("mattermost ignored unauthorized actor", {
      actorId: post.user_id,
      channelId: post.channel_id,
      eventId: post.id,
      actionable,
      conversationKind: isDm ? "dm" : "channel",
    });
    this.emitInboundRejected({
      id: `mattermost:post:${post.id}:rejected`,
      kind: actionable ? "command" : "text",
      actor: {
        platformUserId: post.user_id,
        displayName: data.sender_name,
        username: data.sender_name,
        isBot: false,
      },
      channel: this.channelRefForPost(post, data),
      receivedAt: this.now(),
      reason: "unauthorized-actor",
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
    if (
      !this.validateIdentifier("user_id", body.user_id, validateMattermostId)
      || !this.validateIdentifier("channel_id", body.channel_id, validateMattermostId)
      || (body.team_id !== undefined
        && !this.validateIdentifier("team_id", body.team_id, validateMattermostId))
      || (body.post_id !== undefined
        && !this.validateIdentifier("post_id", body.post_id, validateMattermostId))
      || (body.trigger_id !== undefined
        && !this.validateIdentifier("trigger_id", body.trigger_id, validateMattermostId))
    ) {
      return;
    }
    if (!this.authorizedActorIds.includes(body.user_id)) {
      this.logger.warn("mattermost ignored unauthorized callback actor", {
        actorId: body.user_id,
        channelId: body.channel_id,
      });
      this.emitInboundRejected({
        id: this.newEventId("callback-rejected"),
        kind: "callback",
        actor: {
          platformUserId: body.user_id,
          displayName: body.user_name,
          username: body.user_name,
          isBot: false,
        },
        channel: {
          channel: this.channel,
          conversation: {
            id: body.channel_id,
            kind: "channel",
            ...(body.channel_name ? { title: body.channel_name } : {}),
          },
        },
        receivedAt: this.now(),
        reason: "unauthorized-actor",
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
    if (
      !this.validateIdentifier(
        "callback.context.handle",
        handle,
        validateMattermostCallbackHandle,
      )
    ) {
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
    if (
      contextRootId
      && !this.validateIdentifier("root_id", contextRootId, validateMattermostId)
    ) {
      return;
    }
    // Interactive callback bodies do include `channel_name`, but it's
    // the slug ("development"), not display name ("Development").
    // Better than the bare kind label in the binding chip; use it for
    // `title` (channel) or `parentTitle` (thread). For threads we
    // also fetch the root-post summary for `title` — same path the
    // inbound `posted` flow uses, sharing the cache.
    const isThread = conversationKind === "thread";
    const rootSummary =
      isThread && contextRootId
        ? await this.fetchThreadRootSummary(contextRootId)
        : undefined;
    const titleForRef = isThread ? rootSummary : body.channel_name;
    const parentTitleForRef = isThread ? body.channel_name : undefined;
    const channelRef: MessagingChannelRef = {
      channel: this.channel,
      conversation: {
        id: body.channel_id,
        kind: conversationKind,
        ...(contextRootId ? { parentId: contextRootId } : {}),
        ...(titleForRef ? { title: titleForRef } : {}),
        ...(parentTitleForRef ? { parentTitle: parentTitleForRef } : {}),
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

  // -------------------------------------------------------------
  // Slash commands
  // -------------------------------------------------------------

  /**
   * List teams the bot belongs to, then reconcile our canonical
   * command set against each team. Any per-team failure (no
   * permission, network blip) is logged and skipped — slash commands
   * are an autocomplete UX nicety, not a correctness requirement.
   *
   * The reconciler returns the post-reconcile token map per team; we
   * union them into `this.slashCommandTokens` so the callback server
   * accepts any of the issued tokens. The set is shared by reference
   * with the server, so writes here take effect immediately.
   */
  private async reconcileSlashCommandsAcrossTeams(): Promise<void> {
    let teams: Array<{ id: string; name?: string }> = [];
    try {
      teams = (await this.client.getMyTeams()) as Array<{ id: string; name?: string }>;
    } catch (error) {
      this.logger.warn("mattermost commands: getMyTeams failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    this.slashCommandTokens.clear();
    this.slashCommandReconciliations = [];

    const api: MattermostCommandsApi = {
      getCustomTeamCommands: (teamId) =>
        // Cast through unknown — @mattermost/types' Command shape has
        // optional fields ours doesn't enumerate; we read only the
        // fields declared in `MattermostCommandRecord`.
        this.client.getCustomTeamCommands(teamId) as unknown as Promise<
          import("./mattermost-commands.ts").MattermostCommandRecord[]
        >,
      addCommand: (cmd) =>
        this.client.addCommand(cmd as never) as unknown as Promise<
          import("./mattermost-commands.ts").MattermostCommandRecord
        >,
      editCommand: (cmd) =>
        this.client.editCommand(cmd as never) as unknown as Promise<
          import("./mattermost-commands.ts").MattermostCommandRecord
        >,
      deleteCommand: (id) => this.client.deleteCommand(id),
    };

    const prefix = sanitizeMattermostCommandPrefix(
      this.config.slashCommandPrefix,
      (msg, extra) => this.logger.warn(msg, extra),
    );
    const desired = desiredMattermostCommands(prefix);
    for (const team of teams) {
      const result = await reconcileMattermostCommands({
        api,
        teamId: team.id,
        callbackBaseUrl: this.callbackUrl,
        desired,
        log: (msg, extra) => this.logger.warn(msg, extra),
      });
      this.slashCommandReconciliations.push(result);
      for (const token of result.tokensByTrigger.values()) {
        this.slashCommandTokens.add(token);
      }
      if (
        result.created.length > 0
        || result.updated.length > 0
        || result.deleted.length > 0
        || result.tokensByTrigger.size > 0
      ) {
        this.logger.info("mattermost slash commands reconciled", {
          teamId: team.id,
          teamName: team.name,
          created: result.created,
          updated: result.updated,
          deleted: result.deleted,
          tokenCount: result.tokensByTrigger.size,
        });
      }
    }
  }

  /**
   * Translate a Mattermost slash-command POST into our
   * channel-neutral `MessagingInboundCommandEvent`. The token has
   * already been verified by the callback server before this is
   * called; we just need to enforce actor authorization, build the
   * event, and dispatch.
   */
  private async handleSlashCommand(
    body: MattermostSlashCommandBody,
    rawBody: string,
  ): Promise<MattermostSlashCommandResult | void> {
    void rawBody;
    if (!this.listener) {
      return;
    }
    if (
      !this.validateIdentifier("team_id", body.team_id, validateMattermostId)
      || !this.validateIdentifier("channel_id", body.channel_id, validateMattermostId)
      || !this.validateIdentifier("user_id", body.user_id, validateMattermostId)
      || (body.root_id !== undefined
        && !this.validateIdentifier("root_id", body.root_id, validateMattermostId))
      || (body.trigger_id !== undefined
        && !this.validateIdentifier("trigger_id", body.trigger_id, validateMattermostId))
    ) {
      return;
    }
    // Diagnostic for thread-routing bugs: the picker rendering in the
    // parent channel instead of the invoking thread is a `root_id`
    // propagation problem; logging the raw `root_id` (along with
    // channel id and command) lets us bisect whether Mattermost sent
    // it in the body, whether we parsed it, and whether the resulting
    // channel ref carries the right kind/parentId. Pair this log with
    // the `mattermost createPost outbound` log in `deliverPostIntent`
    // — if the slash log shows `root_id` set but the createPost log
    // shows `root_id: undefined`, the loss is in the
    // controller/audit-channel layer.
    this.logger.info("mattermost slash command received", {
      command: body.command,
      userId: body.user_id,
      channelId: body.channel_id,
      channelName: body.channel_name,
      teamId: body.team_id,
      rootId: body.root_id ?? "(none — not a thread reply)",
      hasArgs: body.text.length > 0,
    });
    if (!this.authorizedActorIds.includes(body.user_id)) {
      this.logger.warn("mattermost ignored unauthorized slash-command actor", {
        actorId: body.user_id,
        command: body.command,
        channelId: body.channel_id,
      });
      this.emitInboundRejected({
        id: this.newEventId("slashcmd-rejected"),
        kind: "command",
        actor: {
          platformUserId: body.user_id,
          displayName: body.user_name,
          username: body.user_name,
          isBot: false,
        },
        channel: {
          channel: this.channel,
          conversation: {
            id: body.channel_id,
            kind: body.root_id ? "thread" : "channel",
            ...(body.root_id ? { parentId: body.root_id } : {}),
            ...(body.channel_name ? { title: body.channel_name } : {}),
          },
        },
        receivedAt: this.now(),
        reason: "unauthorized-actor",
      });
      return undefined;
    }

    const actor: MessagingActorIdentity = {
      platformUserId: body.user_id,
      displayName: body.user_name,
      username: body.user_name,
      isBot: false,
    };

    // Slash commands invoked from a thread reply carry `root_id`
    // (Mattermost ≥ v6.1.0). Treat that exactly like an inbound
    // `posted` event from a thread reply so the bot's response
    // (typically the picker) renders in-thread instead of escaping
    // to the parent channel.
    const isThread = Boolean(body.root_id);
    const rootSummary = isThread && body.root_id
      ? await this.fetchThreadRootSummary(body.root_id)
      : undefined;
    // Slash-command bodies have `channel_name` (slug) but no
    // `channel_type` field — we can't disambiguate DM vs channel
    // here without an extra `getChannel` call. Treat non-thread
    // commands as `kind: "channel"`; DM-from-slash-command is rare
    // (most users hit DMs by direct messaging the bot, which
    // arrives via the `posted` WS path that has `channel_type`).
    const kind: MessagingConversationKind = isThread ? "thread" : "channel";
    const title = isThread ? rootSummary : body.channel_name;
    const parentTitle = isThread ? body.channel_name : undefined;
    const channelRef: MessagingChannelRef = {
      channel: this.channel,
      conversation: {
        id: body.channel_id,
        kind,
        ...(isThread && body.root_id ? { parentId: body.root_id } : {}),
        ...(title ? { title } : {}),
        ...(parentTitle ? { parentTitle } : {}),
      },
    };

    // Reuse the existing text-prefix command dispatch — it's
    // channel-neutral and already wired to the controller. Build a
    // raw-text payload that matches the shape `@bot <cmd> <args>`
    // would have produced via the inbound `posted` path so the
    // controller doesn't need a separate code path. The prefixed
    // trigger is collapsed to its base verb here so the controller
    // sees `resume`/`status`/`detach` regardless of namespace.
    const baseTrigger = baseTriggerForPrefixed(
      body.command,
      sanitizeMattermostCommandPrefix(this.config.slashCommandPrefix),
    );
    const cmdToken = baseTrigger ? `/${baseTrigger}` : body.command;
    const rawText = body.text.length > 0
      ? `${cmdToken} ${body.text}`
      : cmdToken;

    // Stash `response_url` on the inbound event's `routingState` so the
    // controller propagates it onto the FIRST outbound intent's
    // `targetSurface.state.opaque`. `deliverPostIntent` consumes it
    // there and routes the delivery via Mattermost's response_url
    // endpoint instead of `Client4.createPost` — which lets Mattermost
    // post the response with `RootId = args.RootId` server-side,
    // preserving thread context that v10.11 doesn't propagate to
    // outgoing webhook bodies. See `deliverPostIntent` for the
    // consumer side and `docs/messaging-platform-integration.md` for
    // the upstream context.
    const routingState: MessagingAdapterState | undefined = body.response_url
      ? {
          opaque: {
            responseUrl: body.response_url,
            // Mattermost stamps the response_url post with the
            // invoker's user_id (not the bot's). Needed for the
            // recovery filter in `deliverViaResponseUrl` and for the
            // echo-dedup check in `handlePostedEvent`.
            responseUrlInvokerUserId: body.user_id,
          } satisfies MattermostSurfaceOpaqueState as MessagingJsonValue,
        }
      : undefined;

    await this.dispatchCommandEvent({
      actor,
      channel: channelRef,
      eventId: this.newEventId("slashcmd"),
      rawText,
      ...(routingState ? { routingState } : {}),
    });
    return undefined;
  }

  private async dispatchCommandEvent(params: {
    actor: MessagingActorIdentity;
    channel: MessagingChannelRef;
    eventId: string;
    rawText: string;
    routingState?: MessagingAdapterState;
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
      ...(params.routingState ? { routingState: params.routingState } : {}),
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
      allowedActorIds: callbackAllowedActorIds(intent, target.actorId),
      bindingId: callbackBindingId(intent),
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

    // response_url path — first delivery in response to a slash
    // command. Mattermost's webhook body for v10.11 doesn't include
    // `root_id`, but it DOES include `response_url`, and posts
    // created via response_url inherit the server-side `args.RootId`
    // (which Mattermost has but didn't propagate to us). Posting via
    // response_url is the only way to make `/pwragent_resume` from a
    // thread land its picker in the same thread on v10.11.
    if (target.responseUrl) {
      this.logger.info("mattermost response_url outbound", {
        intentId: intent.id,
        intentKind: intent.kind,
        channelId: target.channelId,
        hasButtons: post.props !== undefined,
        messagePreview: post.message.slice(0, 60),
      });
      const recovered = await this.deliverViaResponseUrl({
        channelId: target.channelId,
        message: post.message,
        attachment,
        responseUrl: target.responseUrl,
        invokerUserId: target.responseUrlInvokerUserId,
      });
      if (!recovered) {
        // response_url POST or post_id recovery failed — fall through
        // to createPost so the picker still renders, just in the
        // parent channel (the v10.11 channel-scoped behavior). User
        // sees something rather than nothing.
        this.logger.warn("mattermost response_url delivery failed; falling back to createPost", {
          intentId: intent.id,
          intentKind: intent.kind,
        });
      } else {
        const surface: MessagingSurfaceRef = surfaceRefForPost(
          recovered.postId,
          recovered.channelId,
          recovered.rootId,
        );
        return {
          channel: this.channel,
          deliveredAt: this.now(),
          outcome: "presented",
          surface,
        };
      }
    }

    // Diagnostic for thread-routing bugs (paired with the
    // `mattermost slash command received` log on the inbound side).
    // If `rootId` is `(none)` here for a picker that should have
    // landed in a thread, we lost the thread context somewhere
    // between handleSlashCommand and resolveTarget — most likely an
    // audit-channel override from an existing channel-scoped binding.
    this.logger.info("mattermost createPost outbound", {
      intentId: intent.id,
      intentKind: intent.kind,
      channelId: target.channelId,
      rootId: target.rootId ?? "(none — top-level post)",
      channelKind: target.channelRef.conversation.kind,
      channelRefParentId: target.channelRef.conversation.parentId ?? "(none)",
      hasButtons: post.props !== undefined,
      messagePreview: post.message.slice(0, 60),
    });
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

  /**
   * POST a slash-command delayed response to Mattermost's response_url
   * endpoint, then look up the resulting post to recover its `postId`
   * and (server-set) `root_id`.
   *
   * Why this exists: Mattermost v10.11's outgoing webhook body for
   * custom slash commands omits `root_id`, so we can't tell whether
   * the user invoked the command from a channel or a thread reply.
   * Mattermost's server-side `args.RootId` IS available — they use it
   * when posting integration responses via response_url. Routing
   * through response_url lets Mattermost handle thread context for
   * us; we just need to recover the post_id afterward so the
   * surface ref returned to the controller targets the right post
   * for follow-up updates.
   *
   * Failure modes are bubbled up via `undefined` return so the caller
   * can fall back to `createPost`. The picker will land in the
   * parent channel rather than the thread (the pre-fix behavior),
   * which is degraded but functional.
   */
  private async deliverViaResponseUrl(params: {
    channelId: string;
    message: string;
    attachment: MattermostMessageAttachment | undefined;
    responseUrl: string;
    /**
     * Mattermost's response_url handler stamps the resulting post
     * with this user_id (the slash-command invoker) instead of the
     * bot's. We use it as the recovery filter and to dedup the WS
     * echo. Falls back to bot-user_id matching if undefined (legacy
     * call path; shouldn't fire in production).
     */
    invokerUserId?: string;
  }): Promise<{ postId: string; channelId: string; rootId?: string } | undefined> {
    const payload: Record<string, unknown> = {
      // `in_channel` makes the response visible to everyone (vs.
      // `ephemeral` = invoker only). Pickers and status surfaces
      // are channel-scoped by design — same as createPost behavior.
      response_type: "in_channel",
      text: params.message,
      // Setting `username` triggers Mattermost's "isBotPost" branch
      // server-side, which adds `props.from_webhook = "true"` to the
      // resulting post. Two benefits: (1) the post displays as the
      // bot in the UI instead of "<invoker> [BOT]"; (2) the
      // from_webhook prop gives us a defensive filter in
      // `handlePostedEvent` even if the post-id dedup misses.
      ...(this.botUsername ? { username: this.botUsername } : {}),
      ...(params.attachment ? { attachments: [params.attachment] } : {}),
    };
    const before = this.now();
    try {
      const res = await fetch(params.responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        this.logger.warn("mattermost response_url POST returned non-2xx", {
          status: res.status,
        });
        return undefined;
      }
    } catch (error) {
      this.logger.warn("mattermost response_url POST threw", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }

    // Recover the post we just created. response_url POSTs don't
    // echo the resulting post object, so we query for posts in the
    // channel since slightly before our request and pick the most
    // recent one matching the invoker (Mattermost stamps response_url
    // posts with `args.UserId`, not the bot's user_id).
    try {
      const since = before - 2_000; // 2s of slop for clock skew + mid-flight latency
      const list = (await this.client.getPostsSince(
        params.channelId,
        since,
      )) as { posts?: Record<string, { id: string; user_id: string; root_id?: string; create_at: number; props?: Record<string, unknown> }> };
      const expectedUserId = params.invokerUserId ?? this.botUserId;
      const candidates = Object.values(list.posts ?? {})
        .filter((p) => p.user_id === expectedUserId)
        // Tighten the match: response_url posts always have
        // `from_webhook = "true"` because we override username above.
        // Filtering on this avoids picking up an unrelated post the
        // invoker happened to type within the 2s window.
        .filter((p) => (p.props ?? {})["from_webhook"] === "true");
      const ours = candidates.sort((a, b) => b.create_at - a.create_at)[0];
      if (!ours) {
        this.logger.warn("mattermost response_url getPostsSince found no matching post", {
          channelId: params.channelId,
          since,
          expectedUserId,
          candidateCount: Object.keys(list.posts ?? {}).length,
        });
        return undefined;
      }
      // Track the post id for the WS echo dedup. Lazy eviction
      // (60s TTL) keeps the set bounded.
      this.responseUrlPostIds.add(ours.id);
      const postId = ours.id;
      setTimeout(() => {
        this.responseUrlPostIds.delete(postId);
      }, 60_000).unref?.();
      return {
        postId: ours.id,
        channelId: params.channelId,
        rootId: ours.root_id && ours.root_id.length > 0 ? ours.root_id : undefined,
      };
    } catch (error) {
      this.logger.warn("mattermost response_url getPostsSince failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
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
    // Resolve channel the same way `resolveTarget` does for posts:
    // `intent.audit?.channel` is what the controller populates for
    // producer-issued typing (`signalTurnActivity` doesn't set
    // `targetSurface`); the opaque slot is the fallback for typing on
    // an existing surface. Reading only the opaque slot was a silent
    // no-op (mirrors regression f0974752 on the post path).
    const auditChannelId = (intent as { audit?: { channel?: MessagingChannelRef } })
      .audit?.channel?.conversation.id;
    const opaqueChannelId =
      ((intent.targetSurface as MessagingSurfaceRef | undefined)?.state?.opaque as
        | { channelId?: string }
        | undefined)?.channelId;
    const channelId = auditChannelId ?? opaqueChannelId;
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
    // Mattermost has no "typing stopped" RPC; the typing indicator
    // expires server-side via implicit lease (~3-5s).
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
    if (
      intent.policy === "disabled" ||
      (this.config.streamingResponses !== true && intent.policy !== "enabled")
    ) {
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
        /**
         * Set when the FIRST delivery in response to a slash command
         * should be routed via Mattermost's response_url endpoint.
         * Mattermost preserves thread context server-side (sets
         * `RootId` from `args.RootId`) when posting via this URL —
         * required because v10.11 doesn't include `root_id` in
         * outgoing slash-command webhook bodies.
         */
        responseUrl?: string;
        /**
         * Invoking user's user_id from the slash command body.
         * Mattermost stamps the response_url post with this id (not
         * the bot's), so we use it to recover the post and to dedup
         * the WS echo.
         */
        responseUrlInvokerUserId?: string;
      }
  > {
    // Three sources of truth, in priority order:
    // 1. `intent.targetSurface.state.opaque.responseUrl` — slash-command
    //    response_url stash (one-shot, only set on the first delivery
    //    in response to a slash command). When present, route via
    //    response_url so Mattermost preserves thread context.
    // 2. `intent.targetSurface.state.opaque.channelId/postId` —
    //    populated when we previously delivered a post and want to
    //    update / thread off of it. Tracks Mattermost channel/post/
    //    root IDs across restarts via `MessagingAdapterState.opaque`.
    // 3. `intent.audit?.channel` — populated by the controller for
    //    fresh intents replying to an inbound message; primary
    //    routing signal for everything not covered by (1) or (2).
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

    // (1) response_url path: stash from slash command, fresh delivery.
    // The audit channel must also be present (controller always sets
    // it for command-initiated intents); we use it for channelId.
    if (targetOpaque?.responseUrl && channelRefFromAudit) {
      const conv = channelRefFromAudit.conversation;
      return {
        channelId: conv.id,
        // root_id will be discovered server-side; we don't have it
        // until after the response_url POST + getPostsSince lookup.
        rootId: undefined,
        actorId,
        channelRef: channelRefFromAudit,
        canUpdate: false,
        responseUrl: targetOpaque.responseUrl,
        responseUrlInvokerUserId: targetOpaque.responseUrlInvokerUserId,
      };
    }

    // (2) post-tracking path: existing surface, follow-up update.
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
    // (3) audit channel path: fresh intent on a known channel.
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
    allowedActorIds: string[];
    bindingId?: string;
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
          id: mattermostCallbackRecordId(handle, params),
          actionId: action.id,
          allowedActorIds: params.allowedActorIds,
          bindingId: params.bindingId,
          channel: params.channelRef,
          createdAt: now,
          updatedAt: now,
          // 30-day handle TTL: Mattermost posts and their buttons live
          // indefinitely server-side, so the handle store needs to match
          // user expectations (click a button from days ago, it works).
          // Old short TTLs were copy-pasted from Telegram/Discord
          // patterns where the *platform* enforces short token lifetimes;
          // Mattermost has no such constraint. DB growth at this TTL is
          // bounded at single-digit MB for typical use; the existing
          // `cleanupExpiredCallbackHandles` reaper trims older entries.
          expiresAt: now + 30 * 24 * 60 * 60 * 1000,
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
    data: {
      channel_type?: string;
      team_id?: string;
      sender_name?: string;
      channel_display_name?: string;
    },
    threadRootSummary?: string,
  ): MessagingChannelRef {
    const isThread = Boolean(post.root_id && post.root_id !== post.id);
    const kind: MessagingConversationKind = isThread
      ? "thread"
      : data.channel_type === "D" || data.channel_type === "G"
        ? "dm"
        : "channel";
    // Title selection (mirrors Discord's adapter):
    //   1:1 DM (`channel_type === "D"`)  → the peer's username. Mattermost
    //     filters out our bot from the inbound stream above, so
    //     `sender_name` on a `posted` event is always the peer.
    //   Group DM (`channel_type === "G"`) → server-side
    //     `channel_display_name` is the comma-separated peer list,
    //     which is what the user expects to see in the binding chip.
    //   Public/private channel       → `channel_display_name` is the
    //     human-readable channel name (e.g., "Town Square").
    //   Thread reply                 → truncated root-post message
    //     (fetched + cached via `fetchThreadRootSummary`). Falls back
    //     to undefined when the API lookup failed; the chip then
    //     shows just the kind label, same as before.
    const title = isThread
      ? threadRootSummary
      : data.channel_type === "D"
        ? data.sender_name
        : data.channel_display_name;
    // For thread refs, surface the channel name as `parentTitle` so
    // breadcrumb-style chip displays read "Channel › Thread title".
    // Discord's adapter does the same with guild→channel.
    const parentTitle = isThread ? data.channel_display_name : undefined;
    return {
      channel: this.channel,
      conversation: {
        id: post.channel_id,
        kind,
        ...(isThread && post.root_id ? { parentId: post.root_id } : {}),
        ...(title ? { title } : {}),
        ...(parentTitle ? { parentTitle } : {}),
      },
    };
  }

  /**
   * Resolve a stable display string for a thread's root post.
   *
   * Mattermost's WS `posted` event for a thread reply doesn't echo the
   * root post's content — only its id (`root_id`). To populate the
   * binding chip with something more meaningful than "Thread", fetch
   * the root once via `Client4.getPost` and cache the truncated
   * summary by root id for the adapter's lifetime.
   *
   * Cache lifetime: process scope. Bounded by the number of distinct
   * threads the bot is bound to / interacting with — typically small.
   * On adapter restart we re-fetch on first reply. Cost per thread:
   * one `getPost` call.
   *
   * Failure mode: a permission error or network blip returns
   * `undefined`. The chip falls back to no title (kind label only),
   * matching pre-thread-binding behavior. Not a correctness concern.
   */
  private async fetchThreadRootSummary(
    rootId: string,
  ): Promise<string | undefined> {
    const cached = this.threadRootMessageCache.get(rootId);
    if (cached !== undefined) {
      return cached.length > 0 ? cached : undefined;
    }
    try {
      const root = (await this.client.getPost(rootId)) as { message?: string };
      const summary = summarizeThreadRoot(root.message ?? "");
      // Cache empty strings too so we don't keep retrying a root
      // whose body was deleted or unavailable.
      this.threadRootMessageCache.set(rootId, summary);
      return summary.length > 0 ? summary : undefined;
    } catch (error) {
      this.logger.debug?.("mattermost: getPost(root) failed", {
        rootId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private newEventId(prefix: string): string {
    return `mattermost-${prefix}-${this.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private emitInboundRejected(event: MessagingRejectedInboundEvent): void {
    for (const listener of this.inboundRejectedListeners) {
      void listener(event);
    }
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

/**
 * Render a thread's root-post message as a short, single-line title
 * for use in `MessagingConversationRef.title`. Collapses any embedded
 * whitespace (Mattermost markdown allows multi-line root posts), then
 * truncates to ~50 chars with a trailing ellipsis when the message is
 * longer. Empty input yields an empty string — the caller treats that
 * as "no title available."
 */
/**
 * If `text` starts with `@<botUsername>` (case-insensitive, optional
 * leading whitespace), return the rest of the message with that
 * prefix stripped and trimmed. Otherwise return `undefined`.
 *
 * Used to detect `@pwragent <verb>` text-mention commands so the
 * adapter can dispatch them through the same command pathway as
 * slash commands. Works on every Mattermost server version because
 * the WS `posted` event always carries full thread context — unlike
 * v10.x slash commands which need the `response_url` workaround.
 *
 * Returns `undefined` when:
 *   - `botUsername` is unset (adapter hasn't `start()`'d yet)
 *   - the message doesn't begin with the mention
 *   - the mention is the entire message (no command verb following)
 */
export function stripBotMention(
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
  if (
    trimmedStart.slice(0, mention.length).toLowerCase()
    !== mention.toLowerCase()
  ) {
    return undefined;
  }
  // Require a word boundary after the mention so `@pwragent2` doesn't
  // match `@pwragent`. Either whitespace or end-of-string qualifies.
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

export function summarizeThreadRoot(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length === 0) {
    return "";
  }
  const max = 50;
  if (single.length <= max) {
    return single;
  }
  // -1 to leave room for the ellipsis without overshooting `max`.
  return `${single.slice(0, max - 1)}…`;
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

function callbackAllowedActorIds(
  intent: MessagingSurfaceIntent,
  fallbackActorId: string,
): string[] {
  if (intent.allowedActorIds && intent.allowedActorIds.length > 0) {
    return intent.allowedActorIds;
  }
  const actorId = intent.audit?.actor.platformUserId ?? fallbackActorId;
  return actorId ? [actorId] : ["unknown"];
}

function callbackBindingId(intent: MessagingSurfaceIntent): string | undefined {
  return intent.audit?.bindingId ?? intent.bindingId;
}

function mattermostCallbackRecordId(
  handle: string,
  params: {
    bindingId?: string;
    channelRef: MessagingChannelRef;
  },
): string {
  const conversation = params.channelRef.conversation;
  const deliveryScope = createHash("sha256")
    .update(
      JSON.stringify([
        params.channelRef.channel,
        conversation.id,
        conversation.parentId ?? null,
        params.bindingId ?? null,
      ]),
    )
    .digest("base64url")
    .slice(0, 18);
  return `mattermost-callback:${handle}:${deliveryScope}`;
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
