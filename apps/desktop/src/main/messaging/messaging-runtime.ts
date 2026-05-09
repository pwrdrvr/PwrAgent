import { MessagingController } from "./core/messaging-controller";
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
  MessagingPlatformHealth,
  MessagingPlatformStatus,
  MessagingPlatformStatusEvent,
} from "@pwragent/shared";
import type {
  MessagingBindingRecord,
  MessagingCapabilityProfile,
  MessagingChannelKind,
  MessagingCredentialValidationResult,
  MessagingDeliveryResult,
  MessagingInboundEvent,
  MessagingInboundRejectedListener,
  MessagingRejectedInboundEvent,
  MessagingSurfaceIntent,
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
import { loadConfiguredMessagingAdapters } from "./provider-loader";

export type DesktopMessagingAdapter = {
  authorizedActorIds: readonly string[];
  capabilityProfile: MessagingCapabilityProfile;
  channel: MessagingChannelKind;
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
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
  unsubscribeRuntimeError?: () => void;
};

const messagingLog = getMainLogger("pwragent:messaging");

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
    };

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
    const controller = new MessagingController({
      adapter,
      attachmentPolicy: config.attachmentPolicy,
      authorizedActorIds,
      backend: this.options.backendBridge,
      channel: adapter.channel,
      inputDebounceMs: config.inputDebounceMs,
      store,
      toolUpdateDefaultMode: async () =>
        (await this.loadConfig()).toolUpdateDefaultMode ?? "show_some",
      onBindingChanged: () => this.broadcastBindingsChanged(),
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

    this.runningAdapters.set(adapter.channel, {
      adapter,
      controller,
      fingerprint: messagingAdapterConfigFingerprint(config, adapter.channel),
      unsubscribeInboundRejected,
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

  private setPlatformHealth(
    platform: MessagingChannelKind,
    health: MessagingPlatformHealth,
    options: { reason?: string } = {},
  ): void {
    const at = Date.now();
    const previous = this.platformStatuses.get(platform);
    const next: MessagingPlatformStatus = {
      ...previous,
      platform,
      health,
      changedAt: at,
      reason: options.reason,
      // Preserve the existing activity timestamp through health
      // transitions; activity is independent of health and shouldn't
      // be reset just because the user toggled messaging off.
      lastActivityAt: previous?.lastActivityAt,
    };
    this.platformStatuses.set(platform, next);
    this.broadcastPlatformStatus({
      kind: "health-changed",
      platform,
      health,
      reason: options.reason,
      at,
    });
  }

  private emitPlatformActivity(platform: MessagingChannelKind): void {
    const at = Date.now();
    const previous = this.platformStatuses.get(platform);
    if (previous) {
      this.platformStatuses.set(platform, { ...previous, lastActivityAt: at });
    }
    this.broadcastPlatformStatus({ kind: "activity", platform, at });
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

function isMessagingPendingRequest(
  notification: AgentEvent["notification"],
): notification is AppServerPendingRequestNotification {
  if (notification.method === "item/tool/requestUserInput") {
    return true;
  }

  return notification.method.toLowerCase().includes("requestapproval");
}
