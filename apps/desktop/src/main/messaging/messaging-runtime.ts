import { randomBytes, randomUUID } from "node:crypto";
import {
  MessagingController,
  type MessagingControllerDeliveryBudgetEvent,
} from "./core/messaging-controller";
import type { MessagingStoreLike } from "../state/messaging-store-sqlite";
import type {
  MessagingAdapter,
  MessagingBackendBridge,
  MessagingConversationTitleUpdateRequest,
  MessagingConversationTitleUpdateResult,
} from "./core/messaging-adapter";
import type {
  AgentEvent,
  AppServerPendingRequestNotification,
  GenerateMessagingPairingTokenRequest,
  GenerateMessagingPairingTokenResponse,
  ListMessagingPairingRequestsRequest,
  ListMessagingPairingRequestsResponse,
  MessagingDegradationReason,
  MessagingPairingEntry,
  MessagingPairingObservedActor,
  MessagingPairingObservedChat,
  MessagingPlatformHealth,
  MessagingPlatformStatus,
  MessagingPlatformStatusEvent,
} from "@pwragent/shared";
import type {
  MessagingBindingRecord,
  MessagingCapabilityProfile,
  MessagingChannelKind,
  MessagingClientRateLimitStrategy,
  MessagingCredentialValidationResult,
  MessagingDeliveryResult,
  MessagingDeliveryScope,
  MessagingInboundEvent,
  MessagingInboundRejectedListener,
  MessagingRateLimitInfo,
  MessagingReconnectInfo,
  MessagingRejectedInboundEvent,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import {
  extractMessagingPairingToken,
  isMessagingPairingCommand,
  MESSAGING_PAIRING_COMMAND,
  MESSAGING_PAIRING_TOKEN_PATTERN,
} from "@pwragent/messaging-interface";
import { getMainLogger } from "../log";
import { getDesktopMessagingStore } from "./desktop-messaging-store";
import {
  type DesktopMessagingConfigLoadOptions,
  loadDesktopMessagingConfig,
  redactDesktopMessagingConfig,
  type DesktopMessagingConfig,
} from "./messaging-config";
import { DesktopMessagingBackendBridge } from "./desktop-backend-bridge";
import { getDesktopMessagingActivityLog } from "./desktop-messaging-activity-log";
import { getDesktopMessagingPairingStore } from "./desktop-messaging-pairing-store";
import { loadConfiguredMessagingAdapters } from "./provider-loader";
import { MessagingDeliveryBudget } from "./core/messaging-delivery-budget";

export type DesktopMessagingAdapter = {
  authorizedActorIds: readonly string[];
  capabilityProfile: MessagingCapabilityProfile;
  channel: MessagingChannelKind;
  clientRateLimitStrategy?: MessagingClientRateLimitStrategy;
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  resolveDeliveryScope?(intent: MessagingSurfaceIntent): MessagingDeliveryScope | undefined;
  downloadAttachment?: MessagingAdapter["downloadAttachment"];
  /**
   * Optional subscription for fatal runtime errors that took the
   * adapter offline after a successful start (e.g. Telegram's 409
   * Conflict when a second bot instance starts polling). The runtime
   * subscribes after `start()` and flips the platform health to
   * `errored` so the renderer status pill turns red. Adapters that
   * cannot detect post-start failures may simply omit the method.
   */
  onRuntimeError?(listener: (reason: string) => void): () => void;
  onRateLimit?(listener: (info: MessagingRateLimitInfo) => void): () => void;
  onReconnect?(listener: (info: MessagingReconnectInfo) => void): () => void;
  onInboundRejected?(listener: MessagingInboundRejectedListener): () => void;
  setConversationTitle?(
    request: MessagingConversationTitleUpdateRequest,
  ): Promise<MessagingConversationTitleUpdateResult>;
  start?(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void>;
  stop?(): Promise<void>;
};

export type DesktopMessagingAdapterFactory = (params: {
  config: DesktopMessagingConfig;
  store: MessagingStoreLike;
}) => DesktopMessagingAdapter[] | Promise<DesktopMessagingAdapter[]>;

export type DesktopMessagingConfigLoader = (
  options?: DesktopMessagingConfigLoadOptions,
) =>
  | DesktopMessagingConfig
  | Promise<DesktopMessagingConfig>;

type RunningMessagingAdapter = {
  adapter: DesktopMessagingAdapter;
  controller: MessagingController;
  fingerprint: string;
  unsubscribeInboundRejected?: () => void;
  unsubscribeRateLimit?: () => void;
  unsubscribeReconnect?: () => void;
  unsubscribeRuntimeError?: () => void;
};

const messagingLog = getMainLogger("pwragent:messaging");
const PAIRING_INSTANCE_ID = "default";
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const MIN_PAIRING_TTL_MS = 60 * 1000;
const MAX_PAIRING_TTL_MS = 30 * 60 * 1000;
const MAX_OUTSTANDING_PAIRING_TOKENS = 5;
const PAIRING_TOKEN_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const RATE_LIMIT_HEALTH_BUFFER_MS = 2_000;
const DELIVERY_BUDGET_WARNING_TTL_MS = 30_000;
const DELIVERY_BUDGET_DIAGNOSTIC_THROTTLE_MS = 30_000;

export type MessagingPairingChangedEvent = {
  at: number;
  entry: MessagingPairingEntry;
};

/**
 * Origin tag carried on `requestBindingRevoke` /
 * `requestBindingRevokeAllForThread` so subscribers and observability
 * can distinguish UI-initiated detaches from archive flows or
 * platform-side commands. Adding a new origin must NOT introduce a
 * platform branch — origins are routing-neutral metadata.
 */
export type BindingRevokeOrigin =
  | "ui"
  | "platform-command"
  | "thread-archive"
  | "permanent-failure";

export type BindingRevokeRequest = {
  bindingId: string;
  origin: BindingRevokeOrigin;
};

export type BindingRevokeAllForThreadRequest = {
  backend: MessagingBindingRecord["backend"];
  threadId: MessagingBindingRecord["threadId"];
  origin: BindingRevokeOrigin;
};

export type BindingRevokeResult = {
  /** True if the binding existed and was either retired by a
   * controller or removed via the runtime fallback. */
  revoked: boolean;
  /** True if a controller's adapter scoped the binding's channel and
   * delivered the platform-side retirement + confirmation. False
   * means the binding was removed from the store but no platform
   * notification was sent (e.g., messaging is currently disabled). */
  notifiedPlatform: boolean;
};

export type BindingRevokeAllForThreadResult = {
  /** Number of bindings revoked in total. */
  revokedCount: number;
  /** Number that were retired through a controller's platform
   * notification flow. The remainder were store-only fallbacks. */
  notifiedCount: number;
};

/**
 * Request payload for `requestCredentialValidation`. The runtime
 * routes by `channel` and forwards `credential` to the matching
 * provider package's `validateCredentials` function.
 *
 * The runtime is channel-neutral: it does not parse the credential,
 * does not branch on platform, and does not know which library each
 * provider uses. Adding a new platform means adding a new
 * dynamic-import case to `dispatchCredentialValidation` below — no
 * other changes to the runtime.
 */
export type CredentialValidationRequest =
  | { channel: "telegram"; credential: { botToken: string } }
  | { channel: "discord"; credential: { botToken: string } }
  | {
      channel: "mattermost";
      credential: { botToken: string; serverUrl: string };
    }
  | { channel: "slack"; credential: { botToken: string } };

export class DesktopMessagingRuntime {
  private adapters: DesktopMessagingAdapter[] = [];
  private controllers: MessagingController[] = [];
  private readonly runningAdapters = new Map<
    MessagingChannelKind,
    RunningMessagingAdapter
  >();
  private unsubscribeBackendEvents?: () => void;
  private started = false;
  /**
   * Per-platform health snapshot. Keyed by `MessagingChannelKind`. Updated
   * by `setPlatformHealth` and read by `getPlatformStatuses` for the
   * renderer's initial paint. Survives `stop()` so a paused state shows
   * `suspended` in the UI rather than disappearing.
   */
  private readonly platformStatuses = new Map<
    MessagingChannelKind,
    MessagingPlatformStatus
  >();
  private readonly platformDegradationReasons = new Map<
    MessagingChannelKind,
    Map<string, MessagingDegradationReason>
  >();
  private readonly platformDegradationTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly deliveryBudgetDiagnosticLastLoggedAt = new Map<string, number>();
  private readonly platformStatusListeners = new Set<
    (event: MessagingPlatformStatusEvent) => void
  >();
  private lifecycleQueue: Promise<void> = Promise.resolve();
  /**
   * Listeners notified whenever any controller mutates a binding
   * (create / refresh metadata / sync title / detach / revoke). The
   * payload is intentionally empty — listeners refetch the navigation
   * snapshot rather than diffing per-binding changes themselves.
   */
  private readonly bindingsChangedListeners = new Set<() => void>();
  private readonly pairingChangedListeners = new Set<
    (event: MessagingPairingChangedEvent) => void
  >();

  constructor(
    private readonly options: {
      adapterFactory: DesktopMessagingAdapterFactory;
      backendBridge: MessagingBackendBridge & {
        onEvent?: (listener: (event: AgentEvent) => void | Promise<void>) => () => void;
      };
      config: DesktopMessagingConfig | DesktopMessagingConfigLoader;
    },
  ) {}

  async start(): Promise<void> {
    await this.enqueueLifecycle(async () => {
      const config = await this.loadConfig({ logStartupEligibility: true });
      await this.applyConfigNow(config);
    });
  }

  async stop(): Promise<void> {
    await this.enqueueLifecycle(async () => {
      await this.stopNow();
    });
  }

  private async stopNow(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;

    this.unsubscribeBackendEvents?.();
    this.unsubscribeBackendEvents = undefined;
    const stoppedChannels = [...this.runningAdapters.keys()];
    await Promise.all(
      [...this.runningAdapters.values()].map(async (running) =>
        this.stopRunningAdapter(running)
      ),
    );
    this.runningAdapters.clear();
    this.adapters = [];
    this.controllers = [];
    // Mark each previously-running platform as suspended (not removed),
    // so the renderer keeps the icon visible with a gray dot — the user
    // knows it's configured but currently off.
    for (const channel of stoppedChannels) {
      this.setPlatformHealth(channel, "suspended");
    }
  }

  async applyConfig(
    config: DesktopMessagingConfig,
    options: { allowStart?: boolean } = {},
  ): Promise<void> {
    await this.enqueueLifecycle(async () => {
      await this.applyConfigNow(config, options);
    });
  }

  private async applyConfigNow(
    config: DesktopMessagingConfig,
    options: { allowStart?: boolean } = {},
  ): Promise<void> {
    if (config.enabled === false) {
      await this.stopNow();
      return;
    }

    if (!this.started) {
      if (options.allowStart === false) {
        return;
      }
      this.started = true;
      this.subscribeBackendEvents();
    }

    const store = getDesktopMessagingStore();
    const configuredAdapters = await this.options.adapterFactory({
      config,
      store,
    });
    const nextAdapters = new Map<MessagingChannelKind, DesktopMessagingAdapter>();
    for (const adapter of configuredAdapters) {
      nextAdapters.set(adapter.channel, adapter);
    }

    const stoppedChannels: MessagingChannelKind[] = [];
    for (const [channel, running] of [...this.runningAdapters.entries()]) {
      const next = nextAdapters.get(channel);
      const nextFingerprint = next
        ? messagingAdapterConfigFingerprint(config, channel)
        : undefined;
      if (!next || running.fingerprint !== nextFingerprint) {
        await this.stopRunningAdapter(running);
        this.runningAdapters.delete(channel);
        stoppedChannels.push(channel);
      }
    }
    this.syncRunningAdapterLists();

    const startResults = await Promise.all(
      [...nextAdapters.entries()].map(async ([channel, adapter]) => {
        if (this.runningAdapters.has(channel)) {
          return { channel, started: false, unchanged: true };
        }

        const started = await this.startRunningAdapter({
          adapter,
          config,
          store,
        });
        return { channel, started, unchanged: false };
      }),
    );
    const startedChannels = startResults
      .filter((result) => result.started)
      .map((result) => result.channel);
    const failedChannels = startResults
      .filter((result) => !result.unchanged && !result.started)
      .map((result) => result.channel);

    this.syncRunningAdapterLists();

    const failedChannelSet = new Set<MessagingChannelKind>(failedChannels);
    for (const channel of stoppedChannels) {
      if (!this.runningAdapters.has(channel) && !failedChannelSet.has(channel)) {
        this.setPlatformHealth(channel, "suspended");
      }
    }

    if (
      startedChannels.length > 0
      || stoppedChannels.length > 0
      || failedChannels.length > 0
    ) {
      messagingLog.info("messaging runtime config applied", {
        started: startedChannels.length > 0 ? startedChannels : undefined,
        stopped: stoppedChannels.length > 0 ? stoppedChannels : undefined,
        failed: failedChannels.length > 0 ? failedChannels : undefined,
      });
    } else if (this.runningAdapters.size === 0) {
      messagingLog.info(
        "messaging runtime started with no adapters — no platforms configured",
      );
    }
  }

  async applyLatestConfig(
    options: { allowStart?: boolean } = {},
  ): Promise<void> {
    await this.enqueueLifecycle(async () => {
      await this.applyConfigNow(await this.loadConfig(), options);
    });
  }

  isEnabled(): boolean {
    return this.started;
  }

  /**
   * Subscribe to platform status transitions. Returns an unsubscribe.
   * Listeners receive every `health-changed` and `activity` event;
   * synchronous, off the runtime's event loop. The renderer uses this
   * to keep its `MessagingPlatformStatus[]` cache in sync without
   * polling.
   */
  onPlatformStatus(
    listener: (event: MessagingPlatformStatusEvent) => void,
  ): () => void {
    this.platformStatusListeners.add(listener);
    return () => {
      this.platformStatusListeners.delete(listener);
    };
  }

  /**
   * Snapshot of the current per-platform health. Used by the IPC
   * handler that backs the renderer's initial paint — the renderer
   * subscribes to the event stream right after to stay current.
   */
  getPlatformStatuses(): MessagingPlatformStatus[] {
    for (const platform of this.platformStatuses.keys()) {
      this.clearExpiredDegradationReasons(platform);
    }
    return [...this.platformStatuses.values()];
  }

  /**
   * Subscribe to bindings-changed events. Returns an unsubscribe.
   * Fires after any controller has mutated a binding (create, refresh
   * metadata, sync title, detach, revoke). Renderer-side IPC bridge
   * uses this to push a marker event so `useThreadNavigation`
   * refetches the navigation snapshot — that's where binding chips
   * live (issue #191).
   */
  onBindingsChanged(listener: () => void): () => void {
    this.bindingsChangedListeners.add(listener);
    return () => {
      this.bindingsChangedListeners.delete(listener);
    };
  }

  onPairingChanged(
    listener: (event: MessagingPairingChangedEvent) => void,
  ): () => void {
    this.pairingChangedListeners.add(listener);
    return () => {
      this.pairingChangedListeners.delete(listener);
    };
  }

  generatePairingToken(
    request: GenerateMessagingPairingTokenRequest,
  ): GenerateMessagingPairingTokenResponse {
    const now = Date.now();
    const ttlMs = clampPairingTtlMs(request.ttlMs);
    const instanceId = request.instanceId ?? PAIRING_INSTANCE_ID;
    const store = getDesktopMessagingPairingStore();
    const outstanding = store.countOutstanding({
      platform: request.platform,
      instanceId,
      now,
    });
    if (outstanding >= MAX_OUTSTANDING_PAIRING_TOKENS) {
      throw new Error(
        `Too many active pairing tokens for ${request.platform}. Wait for one to expire or approve/reject a pending request.`,
      );
    }
    const token = generatePairingToken();
    const entry = store.create({
      token,
      platform: request.platform,
      instanceId,
      scope: request.scope,
      generatedAt: now,
      expiresAt: now + ttlMs,
    });
    this.recordPairingActivity(entry, "Generated pairing token");
    this.broadcastPairingChanged(entry);
    return {
      entry,
      token,
      expiresAt: entry.expiresAt,
      message: `${MESSAGING_PAIRING_COMMAND} ${token}`,
    };
  }

  listPairingRequests(
    request: ListMessagingPairingRequestsRequest = {},
  ): ListMessagingPairingRequestsResponse {
    return {
      entries: getDesktopMessagingPairingStore().list({
        includeResolved: request.includeResolved,
        platform: request.platform,
        now: Date.now(),
      }),
    };
  }

  async deliverPairingOutcome(
    entry: MessagingPairingEntry,
    outcome: "approved" | "rejected" | "expired",
  ): Promise<void> {
    const running = this.runningAdapters.get(entry.platform);
    if (!running || !entry.observedActor || !entry.observedChat) return;
    const text = outcome === "approved"
      ? "PwrAgent pairing approved."
      : outcome === "expired"
        ? "PwrAgent pairing expired."
        : "PwrAgent pairing rejected.";
    await running.adapter.deliver({
      id: `pairing:${outcome}:${entry.id}`,
      kind: "message",
      createdAt: Date.now(),
      parts: [{ type: "text", text }],
      audit: {
        actor: {
          platformUserId: entry.observedActor.id,
          displayName: entry.observedActor.displayName,
          phoneNumber: entry.observedActor.phoneNumber,
          username: entry.observedActor.username,
        },
        action: `pairing.${outcome}`,
        channel: {
          channel: entry.platform,
          conversation: {
            id: entry.observedChat.id,
            kind: entry.observedChat.kind,
            parentId: entry.observedChat.parentId,
            title: entry.observedChat.title,
            parentTitle: entry.observedChat.parentTitle,
          },
        },
        occurredAt: Date.now(),
      },
    });
  }

  /**
   * Public emitter so non-controller code (the unbind IPC handler in
   * `messaging-status.ts`, future bind paths) can fan out the same
   * event without reaching into the listener set directly.
   */
  notifyBindingsChanged(): void {
    this.broadcastBindingsChanged();
  }

  /**
   * Bus entry point for "the user wants this binding revoked,
   * source-of-request agnostic." Used by the desktop unbind IPC
   * handler today; future archive flows and CLI tools route through
   * the same call.
   *
   * The runtime fans the request out to every running controller.
   * The controller whose adapter owns the binding's channel runs the
   * platform-agnostic detach pipeline (retire status surface →
   * revoke in store → "Thread detached" confirmation). This keeps
   * the IPC layer free of any per-platform knowledge — adding Slack
   * / Mattermost requires zero changes here.
   *
   * If no controller's scope matches (e.g., messaging is currently
   * disabled, or the platform's adapter failed to start), the
   * runtime still revokes the binding in the store so the renderer
   * chip clears. Best-effort platform notification, guaranteed local
   * state cleanup.
   */
  async requestBindingRevoke(
    request: BindingRevokeRequest,
  ): Promise<BindingRevokeResult> {
    const store = getDesktopMessagingStore();
    const binding = await store.getBinding(request.bindingId);
    if (!binding || binding.revokedAt) {
      return { revoked: false, notifiedPlatform: false };
    }

    const notifiedPlatform = await this.dispatchRevokeToControllers(binding);
    if (!notifiedPlatform) {
      await store.revokeBinding({ bindingId: binding.id });
      await this.recordBindingUnbound(binding);
      this.broadcastBindingsChanged();
    }

    messagingLog.info("messaging binding revoke handled", {
      bindingId: binding.id,
      origin: request.origin,
      backend: binding.backend,
      platform: binding.channel.channel,
      threadId: binding.threadId,
      notifiedPlatform,
    });

    return { revoked: true, notifiedPlatform };
  }

  /**
   * Bus entry point for "revoke every binding on this thread." Used
   * for the upcoming "Unbind all" context-menu item and for implicit
   * unbind-on-archive. Mirrors `requestBindingRevoke` semantics: per
   * binding, in-scope controller handles platform notification; any
   * unmatched binding falls back to store-only revoke.
   */
  async requestBindingRevokeAllForThread(
    request: BindingRevokeAllForThreadRequest,
  ): Promise<BindingRevokeAllForThreadResult> {
    const store = getDesktopMessagingStore();
    const bindings = await store.findActiveBindingsForThread({
      backend: request.backend,
      threadId: request.threadId,
    });
    if (bindings.length === 0) {
      return { revokedCount: 0, notifiedCount: 0 };
    }

    let notifiedCount = 0;
    const fallbackBindings: MessagingBindingRecord[] = [];
    for (const binding of bindings) {
      const notified = await this.dispatchRevokeToControllers(binding);
      if (notified) {
        notifiedCount++;
      } else {
        fallbackBindings.push(binding);
      }
    }

    for (const binding of fallbackBindings) {
      await store.revokeBinding({ bindingId: binding.id });
      await this.recordBindingUnbound(binding);
    }
    if (fallbackBindings.length > 0) {
      this.broadcastBindingsChanged();
    }

    messagingLog.info("messaging binding revoke-all handled", {
      backend: request.backend,
      threadId: request.threadId,
      origin: request.origin,
      revokedCount: bindings.length,
      notifiedCount,
    });

    return { revokedCount: bindings.length, notifiedCount };
  }

  /**
   * Bus entry point for the per-credential "Test" button on Settings →
   * Messaging. Routes to the matching provider package's
   * `validateCredentials(config)` via dynamic import — the provider is
   * loaded on first invocation and cached by Node's module registry,
   * so subsequent tests reuse the same imported module without
   * re-loading.
   *
   * The runtime stays channel-neutral: it does not import provider
   * packages statically, does not parse credentials, and does not
   * know which library (grammy / discord.js / etc.) each provider
   * uses for its smoke check. Adding a new platform means adding one
   * branch here and exporting `validateCredentials` from the new
   * provider package.
   *
   * NOTE: this path does NOT require the messaging runtime to be
   * `started()` — credential validation works regardless of whether
   * the platform is currently enabled. Loading the provider here also
   * does NOT spin up its full adapter (no polling, no gateway, no
   * store mutation). The provider's `validateCredentials` is a
   * stateless REST call.
   */
  async requestCredentialValidation(
    request: CredentialValidationRequest,
  ): Promise<MessagingCredentialValidationResult> {
    switch (request.channel) {
      case "telegram": {
        const telegramProvider = await import(
          "@pwragent/messaging-provider-telegram"
        );
        return await telegramProvider.validateCredentials(request.credential);
      }
      case "discord": {
        const discordProvider = await import(
          "@pwragent/messaging-provider-discord"
        );
        return await discordProvider.validateCredentials(request.credential);
      }
      case "mattermost": {
        const mattermostProvider = await import(
          "@pwragent/messaging-provider-mattermost"
        );
        return await mattermostProvider.validateCredentials(request.credential);
      }
      case "slack": {
        const slackProvider = await import("@pwragent/messaging-provider-slack");
        return await slackProvider.validateCredentials(request.credential);
      }
      default: {
        const exhaustive: never = request;
        throw new Error(
          `unknown credential validation channel: ${(exhaustive as { channel: string }).channel}`,
        );
      }
    }
  }

  private async enqueueLifecycle(
    operation: () => Promise<void>,
  ): Promise<void> {
    const run = this.lifecycleQueue.catch(() => undefined).then(operation);
    this.lifecycleQueue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private async startRunningAdapter(params: {
    adapter: DesktopMessagingAdapter;
    config: DesktopMessagingConfig;
    store: MessagingStoreLike;
  }): Promise<boolean> {
    const { adapter, config, store } = params;
    const authorizedActorIds = [...adapter.authorizedActorIds];
    const authorizedActorIdSet = new Set(authorizedActorIds);
    const deliveryBudget = new MessagingDeliveryBudget();
    if (adapter.clientRateLimitStrategy === "sdk-managed") {
      messagingLog.warn(`${adapter.channel}: SDK-managed rate-limit retries are enabled`, {
        channel: adapter.channel,
        clientRateLimitStrategy: adapter.clientRateLimitStrategy,
      });
    }
    const controller = new MessagingController({
      adapter,
      attachmentPolicy: config.attachmentPolicy,
      authorizedActorIds,
      backend: this.options.backendBridge,
      channel: adapter.channel,
      deliveryBudget,
      inputDebounceMs: config.inputDebounceMs,
      store,
      toolUpdateDefaultMode: async () =>
        (await this.loadConfig()).toolUpdateDefaultMode ?? "show_some",
      onBindingChanged: () => this.broadcastBindingsChanged(),
      onDeliveryBudgetEvent: (event) => this.handleDeliveryBudgetEvent(event),
    });

    let unsubscribeInboundRejected: (() => void) | undefined;
    try {
      unsubscribeInboundRejected = adapter.onInboundRejected?.((event) => {
        this.emitPlatformActivity(adapter.channel);
        this.recordActivityFromRejected(adapter.channel, event);
        messagingLog.warn("messaging event rejected before dispatch", {
          actorDisplayName: event.actor.displayName,
          actorId: event.actor.platformUserId,
          actorIsBot: event.actor.isBot,
          actorUsername: event.actor.username,
          channel: adapter.channel,
          conversationId: event.channel.conversation.id,
          conversationKind: event.channel.conversation.kind,
          eventId: event.id,
          eventKind: event.kind,
          reason: event.reason,
        });
      });
      this.setPlatformHealth(adapter.channel, "unknown");
      await adapter.start?.(async (event) => {
        // Activity ping fires on every inbound, before authorization checks.
        this.emitPlatformActivity(adapter.channel);
        if (await this.handlePairingInbound(adapter, event)) {
          return;
        }
        const authorized = authorizedActorIdSet.has(event.actor.platformUserId);
        this.recordActivityFromInbound(adapter.channel, event, authorized);
        try {
          if (!authorized) {
            messagingLog.warn("messaging event rejected by authorization", {
              actorDisplayName: event.actor.displayName,
              actorId: event.actor.platformUserId,
              actorIsBot: event.actor.isBot,
              actorUsername: event.actor.username,
              authorizedActorCount: authorizedActorIds.length,
              channel: adapter.channel,
              conversationId: event.channel.conversation.id,
              conversationKind: event.channel.conversation.kind,
              eventId: event.id,
              eventKind: event.kind,
            });
          }
          await controller.handleInboundEvent(event);
        } catch (error) {
          messagingLog.error("messaging controller failed to handle inbound event", {
            actorDisplayName: event.actor.displayName,
            actorId: event.actor.platformUserId,
            channel: adapter.channel,
            conversationId: event.channel.conversation.id,
            conversationKind: event.channel.conversation.kind,
            error,
            eventId: event.id,
            eventKind: event.kind,
          });
        }
      });
    } catch (error) {
      try {
        unsubscribeInboundRejected?.();
      } catch {
        // Best effort cleanup after startup failure.
      }
      controller.dispose();
      try {
        await adapter.stop?.();
      } catch (stopError) {
        messagingLog.warn(`${adapter.channel}: adapter stop after failed start threw`, {
          channel: adapter.channel,
          error: stopError instanceof Error ? stopError.message : String(stopError),
        });
      }
      messagingLog.error(`${adapter.channel}: failed to start adapter`, {
        channel: adapter.channel,
        error: error instanceof Error ? error.message : String(error),
      });
      this.setPlatformHealth(adapter.channel, "errored", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    const unsubscribeRuntimeError = adapter.onRuntimeError?.((reason) => {
      messagingLog.warn(`${adapter.channel}: adapter runtime error`, {
        channel: adapter.channel,
        reason,
      });
      this.setPlatformHealth(adapter.channel, "errored", { reason });
    });
    const unsubscribeRateLimit = adapter.onRateLimit?.((info) => {
      deliveryBudget.recordRateLimit(info);
      this.handleAdapterRateLimit(adapter.channel, info);
    });
    const unsubscribeReconnect = adapter.onReconnect?.((info) => {
      this.handleAdapterReconnect(adapter.channel, info);
    });

    this.runningAdapters.set(adapter.channel, {
      adapter,
      controller,
      fingerprint: messagingAdapterConfigFingerprint(config, adapter.channel),
      unsubscribeInboundRejected,
      unsubscribeRateLimit,
      unsubscribeReconnect,
      unsubscribeRuntimeError,
    });
    this.syncRunningAdapterLists();
    this.setPlatformHealth(adapter.channel, "enabled");
    messagingLog.info(`${adapter.channel}: adapter started successfully`, {
      channel: adapter.channel,
    });
    return true;
  }

  private async stopRunningAdapter(running: RunningMessagingAdapter): Promise<void> {
    try {
      running.unsubscribeRateLimit?.();
    } catch (error) {
      messagingLog.warn("messaging adapter rate-limit unsubscribe threw", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      running.unsubscribeReconnect?.();
    } catch (error) {
      messagingLog.warn("messaging adapter reconnect unsubscribe threw", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      running.unsubscribeRuntimeError?.();
    } catch (error) {
      messagingLog.warn("messaging adapter runtime-error unsubscribe threw", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      running.unsubscribeInboundRejected?.();
    } catch (error) {
      messagingLog.warn("messaging adapter inbound-rejected unsubscribe threw", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    running.controller.dispose();
    await running.adapter.stop?.();
  }

  private subscribeBackendEvents(): void {
    if (this.unsubscribeBackendEvents) {
      return;
    }

    this.unsubscribeBackendEvents = this.options.backendBridge.onEvent?.(async (event) => {
      await Promise.all(
        this.controllers.map(async (controller) => {
          try {
            if (isMessagingPendingRequest(event.notification)) {
              await controller.handleBackendPendingRequest(
                event.backend,
                event.notification,
              );
            } else {
              await controller.handleBackendEvent(event);
            }
          } catch (error) {
            messagingLog.error("messaging controller failed to handle backend event", {
              backend: event.backend,
              error,
              method: event.notification.method,
            });
          }
        }),
      );
    });
  }

  private syncRunningAdapterLists(): void {
    const running = [...this.runningAdapters.values()];
    this.adapters = running.map((record) => record.adapter);
    this.controllers = running.map((record) => record.controller);
  }

  private async dispatchRevokeToControllers(
    binding: MessagingBindingRecord,
  ): Promise<boolean> {
    for (const controller of this.controllers) {
      try {
        if (await controller.handleBindingRevokeRequest(binding)) {
          return true;
        }
      } catch (error) {
        messagingLog.error("messaging controller revoke handler threw", {
          bindingId: binding.id,
          platform: binding.channel.channel,
          error: error instanceof Error ? error.message : String(error),
        });
        // Swallow — try the next controller; if none handle, the
        // runtime fallback revokes from the store. We never want a
        // platform-side failure to leave the binding visibly attached
        // in the renderer.
      }
    }
    return false;
  }

  private async recordBindingUnbound(binding: MessagingBindingRecord): Promise<void> {
    const conversation = binding.channel.conversation;
    const occurredAt = Date.now();
    if (this.options.backendBridge.recordMessagingBindingTransition) {
      try {
        await this.options.backendBridge.recordMessagingBindingTransition({
          backend: binding.backend,
          threadId: binding.threadId,
          transition: {
            id: randomUUID(),
            action: "unbound",
            bindingId: binding.id,
            platform: binding.channel.channel,
            conversationKind: conversation.kind,
            conversationTitle: conversation.title,
            parentTitle: conversation.parentTitle,
            ancestorTitle: conversation.ancestorTitle,
            occurredAt,
          },
        });
      } catch (error) {
        messagingLog.warn("messaging binding-transition audit failed", {
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
          threadId: binding.threadId,
        });
      }
    }
    this.recordBindingActivity("unbound", binding, occurredAt);
  }

  private broadcastBindingsChanged(): void {
    for (const listener of this.bindingsChangedListeners) {
      try {
        listener();
      } catch (error) {
        messagingLog.error("messaging bindings-changed listener threw", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private broadcastPairingChanged(entry: MessagingPairingEntry): void {
    const event = { at: Date.now(), entry };
    for (const listener of this.pairingChangedListeners) {
      try {
        listener(event);
      } catch (error) {
        messagingLog.error("messaging pairing-changed listener threw", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private setPlatformHealth(
    platform: MessagingChannelKind,
    health: MessagingPlatformHealth,
    options: { reason?: string } = {},
  ): void {
    const at = Date.now();
    const previous = this.platformStatuses.get(platform);
    if (health === "enabled" || health === "suspended" || health === "errored") {
      if (health !== "enabled") {
        this.clearPlatformDegradationReasons(platform, { broadcast: false });
      } else {
        this.clearExpiredDegradationReasons(platform);
      }
    }
    const degradationReasons = this.currentDegradationReasons(platform);
    const effectiveHealth =
      health === "enabled" && degradationReasons.length > 0 ? "degraded" : health;
    const next: MessagingPlatformStatus = {
      ...previous,
      platform,
      health: effectiveHealth,
      changedAt: at,
      reason: options.reason,
      degradationReasons,
      // Preserve the existing activity timestamp through health
      // transitions; activity is independent of health and shouldn't
      // be reset just because the user toggled messaging off.
      lastActivityAt: previous?.lastActivityAt,
    };
    this.platformStatuses.set(platform, next);
    this.broadcastPlatformStatus({
      kind: "health-changed",
      platform,
      health: effectiveHealth,
      reason: options.reason,
      degradationReasons,
      at,
    });
  }

  private handleAdapterRateLimit(
    platform: MessagingChannelKind,
    info: MessagingRateLimitInfo,
  ): void {
    const startedAt = info.observedAt ?? Date.now();
    const retryAfterMs = Math.max(0, Math.floor(info.retryAfterMs ?? 0));
    const expiresAt = startedAt + retryAfterMs + RATE_LIMIT_HEALTH_BUFFER_MS;
    const key = degradationKey(platform, "rate-limited", info.scope.id);
    this.addPlatformDegradationReason(platform, {
      kind: "rate-limited",
      key,
      message: clipStatusText(
        info.message ?? `Cool Off active for ${formatDurationForStatus(retryAfterMs)}.`,
      ),
      scope: sanitizeDeliveryScope(info.scope),
      retryAfterMs,
      startedAt,
      expiresAt,
    });
    this.recordDiagnosticActivity({
      platform,
      summary: `Cool Off started: ${info.scope.id}`,
      createdAt: startedAt,
      payload: {
        type: "provider-cool-off",
        scope: sanitizeDeliveryScope(info.scope),
        retryAfterMs,
        expiresAt,
        message: clipStatusText(info.message),
      },
    });
  }

  private handleDeliveryBudgetEvent(
    event: MessagingControllerDeliveryBudgetEvent,
  ): void {
    const scopeId = event.scope?.id ?? "unknown";
    const reason = event.reason ?? (event.outcome === "deferred" ? "deferred" : "dropped");
    const retryDelayMs = event.retryAt !== undefined
      ? Math.max(0, event.retryAt - event.at)
      : undefined;
    const isCoolOff = reason === "cool-off";
    const modeLabel = isCoolOff ? "Cool Off" : "Slow Mode";

    const diagnosticKey = [
      event.channel,
      scopeId,
      event.outcome,
      event.reason ?? "deferred",
      event.priority,
      event.intentKind,
    ].join("\0");
    const lastLoggedAt = this.deliveryBudgetDiagnosticLastLoggedAt.get(diagnosticKey);
    if (
      lastLoggedAt !== undefined &&
      event.at - lastLoggedAt < DELIVERY_BUDGET_DIAGNOSTIC_THROTTLE_MS
    ) {
      return;
    }
    this.deliveryBudgetDiagnosticLastLoggedAt.set(diagnosticKey, event.at);

    messagingLog.info("messaging delivery budget constrained", {
      bindingId: event.bindingId,
      channel: event.channel,
      intentId: event.intentId,
      intentKind: event.intentKind,
      outcome: event.outcome,
      priority: event.priority,
      reason,
      retryAt: event.retryAt,
      retryDelayMs,
      scopeId,
      slowModeActive: event.slowMode,
      threadId: event.threadId,
    });

    const expiresAt = event.outcome === "deferred"
      ? event.retryAt
      : event.at + DELIVERY_BUDGET_WARNING_TTL_MS;
    const key = degradationKey(event.channel, "warning", `delivery-budget:${scopeId}`);
    this.addPlatformDegradationReason(event.channel, {
      kind: "warning",
      key,
      message: event.outcome === "deferred"
        ? `${modeLabel} active; holding ${event.priority} for ${formatDurationForStatus(retryDelayMs ?? 0)}.`
        : `${modeLabel} active; dropped ${event.priority} (${reason}).`,
      scope: event.scope ? sanitizeDeliveryScope(event.scope) : undefined,
      startedAt: event.at,
      expiresAt,
    });
    this.recordDiagnosticActivity({
      platform: event.channel,
      backend: event.backend,
      threadId: event.threadId,
      bindingId: event.bindingId,
      summary: event.outcome === "deferred"
        ? `${modeLabel} held ${event.priority} for ${formatDurationForStatus(retryDelayMs ?? 0)}`
        : `${modeLabel} dropped ${event.priority}: ${reason}`,
      createdAt: event.at,
      payload: {
        type: isCoolOff ? "cool-off" : "slow-mode",
        intentId: event.intentId,
        intentKind: event.intentKind,
        outcome: event.outcome,
        priority: event.priority,
        reason,
        retryAt: event.retryAt,
        retryDelayMs,
        scope: event.scope ? sanitizeDeliveryScope(event.scope) : undefined,
        slowModeActive: event.slowMode,
      },
    });
  }

  private handleAdapterReconnect(
    platform: MessagingChannelKind,
    info: MessagingReconnectInfo,
  ): void {
    const key = degradationKey(platform, "reconnecting", "adapter");
    if (info.state === "recovered") {
      this.clearPlatformDegradationReason(platform, key);
      return;
    }
    this.addPlatformDegradationReason(platform, {
      kind: "reconnecting",
      key,
      attemptCount: info.attemptCount,
      lastFailureReason: clipStatusText(info.lastFailureReason),
      startedAt: info.observedAt ?? Date.now(),
    });
  }

  private addPlatformDegradationReason(
    platform: MessagingChannelKind,
    reason: MessagingDegradationReason,
  ): void {
    this.clearExpiredDegradationReasons(platform);
    const reasons = this.platformDegradationReasonsFor(platform);
    reasons.set(reason.key, reason);
    this.scheduleDegradationExpiry(platform, reason);
    this.refreshDegradedPlatformHealth(platform);
  }

  private clearPlatformDegradationReason(
    platform: MessagingChannelKind,
    key: string,
  ): void {
    const reasons = this.platformDegradationReasons.get(platform);
    if (!reasons?.delete(key)) {
      return;
    }
    this.clearDegradationTimer(platform, key);
    this.refreshDegradedPlatformHealth(platform);
  }

  private clearPlatformDegradationReasons(
    platform: MessagingChannelKind,
    options: { broadcast: boolean },
  ): void {
    const reasons = this.platformDegradationReasons.get(platform);
    if (!reasons || reasons.size === 0) {
      return;
    }
    for (const key of reasons.keys()) {
      this.clearDegradationTimer(platform, key);
    }
    reasons.clear();
    if (options.broadcast) {
      this.refreshDegradedPlatformHealth(platform);
    }
  }

  private clearExpiredDegradationReasons(platform: MessagingChannelKind): void {
    const reasons = this.platformDegradationReasons.get(platform);
    if (!reasons || reasons.size === 0) {
      return;
    }
    const now = Date.now();
    let mutated = false;
    for (const [key, reason] of [...reasons.entries()]) {
      const expiresAt = degradationExpiresAt(reason);
      if (expiresAt !== undefined && expiresAt <= now) {
        reasons.delete(key);
        this.clearDegradationTimer(platform, key);
        mutated = true;
      }
    }
    if (mutated) {
      this.refreshDegradedPlatformHealth(platform);
    }
  }

  private refreshDegradedPlatformHealth(platform: MessagingChannelKind): void {
    const previous = this.platformStatuses.get(platform);
    if (!previous || previous.health === "errored" || previous.health === "suspended") {
      return;
    }
    const degradationReasons = this.currentDegradationReasons(platform);
    const nextHealth: MessagingPlatformHealth =
      degradationReasons.length > 0 ? "degraded" : "enabled";
    const at = Date.now();
    this.platformStatuses.set(platform, {
      ...previous,
      health: nextHealth,
      changedAt: at,
      reason: nextHealth === "degraded" ? previous.reason : undefined,
      degradationReasons,
    });
    this.broadcastPlatformStatus({
      kind: "health-changed",
      platform,
      health: nextHealth,
      reason: nextHealth === "degraded" ? previous.reason : undefined,
      degradationReasons,
      at,
    });
  }

  private currentDegradationReasons(
    platform: MessagingChannelKind,
  ): MessagingDegradationReason[] {
    return [...(this.platformDegradationReasons.get(platform)?.values() ?? [])];
  }

  private platformDegradationReasonsFor(
    platform: MessagingChannelKind,
  ): Map<string, MessagingDegradationReason> {
    let reasons = this.platformDegradationReasons.get(platform);
    if (!reasons) {
      reasons = new Map();
      this.platformDegradationReasons.set(platform, reasons);
    }
    return reasons;
  }

  private scheduleDegradationExpiry(
    platform: MessagingChannelKind,
    reason: MessagingDegradationReason,
  ): void {
    const expiresAt = degradationExpiresAt(reason);
    if (expiresAt === undefined) {
      return;
    }
    const timerKey = degradationTimerKey(platform, reason.key);
    this.clearDegradationTimer(platform, reason.key);
    const delayMs = Math.max(0, expiresAt - Date.now());
    this.platformDegradationTimers.set(
      timerKey,
      setTimeout(() => {
        this.platformDegradationTimers.delete(timerKey);
        this.clearPlatformDegradationReason(platform, reason.key);
      }, delayMs),
    );
  }

  private clearDegradationTimer(
    platform: MessagingChannelKind,
    key: string,
  ): void {
    const timerKey = degradationTimerKey(platform, key);
    const timer = this.platformDegradationTimers.get(timerKey);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.platformDegradationTimers.delete(timerKey);
  }

  private emitPlatformActivity(platform: MessagingChannelKind): void {
    const at = Date.now();
    const previous = this.platformStatuses.get(platform);
    if (previous) {
      this.platformStatuses.set(platform, { ...previous, lastActivityAt: at });
    }
    this.broadcastPlatformStatus({ kind: "activity", platform, at });
  }

  private async handlePairingInbound(
    adapter: DesktopMessagingAdapter,
    event: MessagingInboundEvent,
  ): Promise<boolean> {
    const token = tokenFromInboundEvent(event);
    if (!token) return false;

    const now = Date.now();
    const store = getDesktopMessagingPairingStore();
    const entry = store.findMatchingPending({
      token,
      platform: adapter.channel,
      instanceId: PAIRING_INSTANCE_ID,
      now,
    });
    if (!entry) {
      await this.deliverPairingReply(
        adapter,
        event,
        "That PwrAgent pairing token is invalid or expired.",
      );
      this.recordPairingAttemptActivity(adapter.channel, event, "Invalid pairing token");
      return true;
    }

    const scopeFailure = pairingScopeFailure(entry, event);
    if (scopeFailure) {
      const rejected = store.markStatus({
        entryId: entry.id,
        status: "rejected",
        failureReason: scopeFailure,
      }) ?? entry;
      this.recordPairingActivity(rejected, `Rejected pairing token: ${scopeFailure}`);
      this.broadcastPairingChanged(rejected);
      await this.deliverPairingReply(adapter, event, `Pairing rejected: ${scopeFailure}`);
      return true;
    }

    const observed = store.markObserved({
      entryId: entry.id,
      observedAt: now,
      actor: observedActorFromEvent(event),
      chat: observedChatFromEvent(event),
    }) ?? entry;
    this.recordPairingActivity(observed, "Observed pairing token");
    this.broadcastPairingChanged(observed);
    await this.deliverPairingReply(
      adapter,
      event,
      "Pairing request received. Approve it in PwrAgent to finish.",
    );
    return true;
  }

  private async deliverPairingReply(
    adapter: DesktopMessagingAdapter,
    event: MessagingInboundEvent,
    text: string,
  ): Promise<void> {
    try {
      await adapter.deliver({
        id: `pairing:reply:${event.id}:${Date.now()}`,
        kind: "message",
        createdAt: Date.now(),
        parts: [{ type: "text", text }],
        audit: {
          actor: event.actor,
          action: "pairing.reply",
          channel: event.channel,
          occurredAt: Date.now(),
        },
      });
    } catch (error) {
      messagingLog.warn("messaging pairing reply failed", {
        channel: adapter.channel,
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recordPairingActivity(entry: MessagingPairingEntry, summary: string): void {
    try {
      getDesktopMessagingActivityLog().record({
        platform: entry.platform,
        kind: "pairing",
        conversationId: entry.observedChat?.id,
        conversationTitle: entry.observedChat?.title,
        actorId: entry.observedActor?.id,
        actorDisplayName: entry.observedActor?.displayName,
        summary,
        payload: {
          pairingId: entry.id,
          scope: entry.scope,
          status: entry.status,
          instanceId: entry.instanceId,
          expiresAt: entry.expiresAt,
          failureReason: entry.failureReason,
          conversationKind: entry.observedChat?.kind,
          conversationParentId: entry.observedChat?.parentId,
          conversationParentTitle: entry.observedChat?.parentTitle,
          conversationBucketId: entry.observedChat?.bucketId,
          actorUsername: entry.observedActor?.username,
        },
      });
    } catch (error) {
      messagingLog.warn("messaging pairing activity write failed", {
        pairingId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recordPairingAttemptActivity(
    platform: MessagingChannelKind,
    event: MessagingInboundEvent,
    summary: string,
  ): void {
    try {
      getDesktopMessagingActivityLog().record({
        platform,
        kind: "pairing",
        conversationId: event.channel.conversation.id,
        conversationTitle: event.channel.conversation.title,
        actorId: event.actor.platformUserId,
        actorDisplayName: event.actor.displayName,
        summary,
        payload: {
          eventId: event.id,
          eventKind: event.kind,
          conversationKind: event.channel.conversation.kind,
        },
      });
    } catch {
      // Best effort only.
    }
  }

  private recordBindingActivity(
    action: "bound" | "unbound",
    binding: MessagingBindingRecord,
    occurredAt: number,
  ): void {
    try {
      const conversation = binding.channel.conversation;
      getDesktopMessagingActivityLog().record({
        platform: binding.channel.channel,
        kind: "binding",
        backend: binding.backend,
        threadId: binding.threadId,
        bindingId: binding.id,
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        summary: `Channel ${action}: ${describeConversation(conversation)} / ${binding.threadId}`,
        createdAt: occurredAt,
        payload: {
          action,
          conversationKind: conversation.kind,
          conversationParentId: conversation.parentId,
          parentTitle: conversation.parentTitle,
          ancestorTitle: conversation.ancestorTitle,
        },
      });
    } catch (error) {
      messagingLog.warn("messaging binding activity write failed", {
        action,
        bindingId: binding.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recordDiagnosticActivity(params: {
    platform: MessagingChannelKind;
    backend?: AgentEvent["backend"];
    threadId?: string;
    bindingId?: string;
    summary: string;
    createdAt: number;
    payload: Record<string, unknown>;
  }): void {
    try {
      getDesktopMessagingActivityLog().record({
        platform: params.platform,
        kind: "diagnostic",
        backend: params.backend,
        threadId: params.threadId,
        bindingId: params.bindingId,
        summary: params.summary,
        createdAt: params.createdAt,
        payload: params.payload,
      });
    } catch (error) {
      messagingLog.warn("messaging diagnostic activity write failed", {
        bindingId: params.bindingId,
        error: error instanceof Error ? error.message : String(error),
        platform: params.platform,
      });
    }
  }

  private recordActivityFromInbound(
    platform: MessagingChannelKind,
    event: MessagingInboundEvent,
    authorized: boolean,
  ): void {
    // Best-effort write — never throw out of the adapter listener path.
    // The activity log is observability, not the source of truth for
    // routing decisions, so a failed write means we lose a row, not a
    // misrouted message.
    try {
      const conversation = event.channel.conversation;
      const summary = authorized
        ? `Inbound from ${event.actor.displayName ?? event.actor.platformUserId}`
        : `Rejected inbound from ${event.actor.displayName ?? event.actor.platformUserId}`;
      getDesktopMessagingActivityLog().record({
        platform,
        kind: authorized ? "inbound-routed" : "inbound-rejected",
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        actorId: event.actor.platformUserId,
        actorDisplayName: event.actor.displayName,
        summary,
        payload: {
          eventId: event.id,
          eventKind: event.kind,
          conversationKind: conversation.kind,
          conversationParentId: conversation.parentId,
          actorUsername: event.actor.username,
          actorIsBot: event.actor.isBot,
        },
      });
    } catch (error) {
      messagingLog.warn("messaging activity log write failed", {
        platform,
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recordActivityFromRejected(
    platform: MessagingChannelKind,
    event: MessagingRejectedInboundEvent,
  ): void {
    try {
      const conversation = event.channel.conversation;
      getDesktopMessagingActivityLog().record({
        platform,
        kind: "inbound-rejected",
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        actorId: event.actor.platformUserId,
        actorDisplayName: event.actor.displayName,
        summary: `Rejected inbound from ${event.actor.displayName ?? event.actor.platformUserId}`,
        payload: {
          eventId: event.id,
          eventKind: event.kind,
          conversationKind: conversation.kind,
          conversationParentId: conversation.parentId,
          actorUsername: event.actor.username,
          actorIsBot: event.actor.isBot,
          rejectionReason: event.reason,
        },
      });
    } catch (error) {
      messagingLog.warn("messaging rejected activity log write failed", {
        platform,
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private broadcastPlatformStatus(event: MessagingPlatformStatusEvent): void {
    for (const listener of this.platformStatusListeners) {
      try {
        listener(event);
      } catch (error) {
        messagingLog.error("messaging platform status listener threw", {
          error: error instanceof Error ? error.message : String(error),
          platform: event.platform,
          kind: event.kind,
        });
      }
    }
  }

  private async loadConfig(
    options?: DesktopMessagingConfigLoadOptions,
  ): Promise<DesktopMessagingConfig> {
    return typeof this.options.config === "function"
      ? await this.options.config(options)
      : this.options.config;
  }
}

let runtime: DesktopMessagingRuntime | null = null;

export function getDesktopMessagingRuntime(
  config?: DesktopMessagingConfig | DesktopMessagingConfigLoader,
): DesktopMessagingRuntime {
  if (!runtime) {
    runtime = new DesktopMessagingRuntime({
      adapterFactory: createConfiguredAdapters,
      backendBridge: new DesktopMessagingBackendBridge(),
      config: config ?? (() => loadDesktopMessagingConfig()),
    });
  }

  return runtime;
}

export async function disposeDesktopMessagingRuntime(): Promise<void> {
  if (!runtime) {
    return;
  }

  const current = runtime;
  runtime = null;
  await current.stop();
}

export function resetDesktopMessagingRuntimeForTests(): void {
  runtime = null;
}

function createConfiguredAdapters(params: {
  config: DesktopMessagingConfig;
  store: MessagingStoreLike;
}): Promise<DesktopMessagingAdapter[]> {
  return loadConfiguredMessagingAdapters(params);
}

function messagingAdapterConfigFingerprint(
  config: DesktopMessagingConfig,
  channel: MessagingChannelKind,
): string {
  const channelConfig =
    channel === "telegram"
      ? config.telegram
      : channel === "discord"
        ? config.discord
        : channel === "mattermost"
          ? config.mattermost
          : channel === "slack"
            ? config.slack
            : undefined;

  return stableStringify({
    attachmentPolicy: config.attachmentPolicy,
    channelConfig,
    inputDebounceMs: config.inputDebounceMs,
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function clampPairingTtlMs(ttlMs: number | undefined): number {
  if (ttlMs === undefined) return DEFAULT_PAIRING_TTL_MS;
  if (!Number.isFinite(ttlMs)) return DEFAULT_PAIRING_TTL_MS;
  return Math.min(
    Math.max(Math.floor(ttlMs), MIN_PAIRING_TTL_MS),
    MAX_PAIRING_TTL_MS,
  );
}

function generatePairingToken(): string {
  const bytes = randomBytes(32);
  let token = "";
  for (let index = 0; token.length < 32; index += 1) {
    token += PAIRING_TOKEN_ALPHABET[bytes[index % bytes.length] % PAIRING_TOKEN_ALPHABET.length];
  }
  return token;
}

function tokenFromInboundEvent(event: MessagingInboundEvent): string | undefined {
  if (event.kind === "text") {
    return extractMessagingPairingToken(event.text);
  }
  if (event.kind === "command" && isMessagingPairingCommand(event.command)) {
    const candidate = event.args[0];
    return candidate && MESSAGING_PAIRING_TOKEN_PATTERN.test(candidate)
      ? candidate
      : undefined;
  }
  if (event.kind === "media" && event.text) {
    return extractMessagingPairingToken(event.text);
  }
  return undefined;
}

function pairingScopeFailure(
  entry: MessagingPairingEntry,
  event: MessagingInboundEvent,
): string | undefined {
  const isDm = event.channel.conversation.kind === "dm";
  if (entry.scope === "user_dm" && !isDm) {
    return "token was generated for a DM but was pasted in a group/channel";
  }
  if (entry.scope === "user_in_group" && isDm) {
    return "token was generated for a user-in-group flow but was pasted in a DM";
  }
  if (entry.scope === "bucket" && isDm) {
    return "token was generated for a group/guild bucket but was pasted in a DM";
  }
  return undefined;
}

function observedActorFromEvent(event: MessagingInboundEvent): MessagingPairingObservedActor {
  return {
    id: event.actor.platformUserId,
    displayName: event.actor.displayName,
    phoneNumber: event.actor.phoneNumber,
    username: event.actor.username,
  };
}

function observedChatFromEvent(event: MessagingInboundEvent): MessagingPairingObservedChat {
  const conversation = event.channel.conversation;
  return {
    id: conversation.id,
    kind: conversation.kind,
    title: conversation.title,
    parentId: conversation.parentId,
    parentTitle: conversation.parentTitle,
    bucketId: bucketIdFromEvent(event),
  };
}

function bucketIdFromEvent(event: MessagingInboundEvent): string | undefined {
  const opaque = event.routingState?.opaque;
  if (opaque && typeof opaque === "object" && !Array.isArray(opaque)) {
    const record = opaque as Record<string, unknown>;
    if (typeof record.guildId === "string" && record.guildId) {
      return record.guildId;
    }
    if (typeof record.chatId === "number" || typeof record.chatId === "string") {
      return String(record.chatId);
    }
    if (typeof record.teamId === "string" && record.teamId) {
      return record.teamId;
    }
  }
  return event.channel.conversation.parentId ?? event.channel.conversation.id;
}

function degradationKey(
  platform: MessagingChannelKind,
  kind: MessagingDegradationReason["kind"],
  id: string,
): string {
  return `${platform}:${kind}:${id}`;
}

function degradationTimerKey(
  platform: MessagingChannelKind,
  key: string,
): string {
  return `${platform}\0${key}`;
}

function degradationExpiresAt(
  reason: MessagingDegradationReason,
): number | undefined {
  return "expiresAt" in reason ? reason.expiresAt : undefined;
}

function sanitizeDeliveryScope(
  scope: MessagingDeliveryScope,
): MessagingDeliveryScope {
  return {
    ...scope,
    label: clipStatusText(scope.label),
    bucketId: clipStatusText(scope.bucketId),
  };
}

function clipStatusText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function describeConversation(
  conversation: MessagingBindingRecord["channel"]["conversation"],
): string {
  const pieces = [
    conversation.ancestorTitle,
    conversation.parentTitle,
    conversation.title,
  ].filter((piece): piece is string => Boolean(piece));
  return pieces.length > 0 ? pieces.join(" / ") : conversation.id;
}

function formatDurationForStatus(durationMs: number): string {
  const seconds = Math.max(0, Math.ceil(durationMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m`;
}

function isMessagingPendingRequest(
  notification: AgentEvent["notification"],
): notification is AppServerPendingRequestNotification {
  if (notification.method === "item/tool/requestUserInput") {
    return true;
  }

  return notification.method.toLowerCase().includes("requestapproval");
}
