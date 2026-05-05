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
  MessagingCapabilityProfile,
  MessagingChannelKind,
  MessagingDeliveryResult,
  MessagingInboundEvent,
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

const messagingLog = getMainLogger("pwragent:messaging");

export class DesktopMessagingRuntime {
  private adapters: DesktopMessagingAdapter[] = [];
  private controllers: MessagingController[] = [];
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
    if (this.started) {
      return;
    }
    this.started = true;

    const store = getDesktopMessagingStore();
    const config = await this.loadConfig({ logStartupEligibility: true });
    const configuredAdapters = await this.options.adapterFactory({
      config,
      store,
    });

    const failedChannels: string[] = [];
    for (const adapter of configuredAdapters) {
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

      try {
        await adapter.start?.(async (event) => {
          // Activity ping fires on every inbound, *before* authorization
          // checks — the platform is active even when the message is
          // rejected, and the user wants the dot to reflect that.
          this.emitPlatformActivity(adapter.channel);
          const authorized = authorizedActorIdSet.has(
            event.actor.platformUserId,
          );
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
        messagingLog.error(`${adapter.channel}: failed to start adapter`, {
          channel: adapter.channel,
          error: error instanceof Error ? error.message : String(error),
        });
        failedChannels.push(adapter.channel);
        this.setPlatformHealth(adapter.channel, "errored", {
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      messagingLog.info(`${adapter.channel}: adapter started successfully`, {
        channel: adapter.channel,
      });
      this.adapters.push(adapter);
      this.controllers.push(controller);
      this.setPlatformHealth(adapter.channel, "enabled");
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

    const startedChannels = this.adapters.map((adapter) => adapter.channel);
    if (startedChannels.length > 0 || failedChannels.length > 0) {
      messagingLog.info("messaging runtime started", {
        started: startedChannels,
        failed: failedChannels.length > 0 ? failedChannels : undefined,
      });
    } else {
      messagingLog.info(
        "messaging runtime started with no adapters — no platforms configured",
      );
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;

    this.unsubscribeBackendEvents?.();
    this.unsubscribeBackendEvents = undefined;
    this.controllers.forEach((controller) => controller.dispose());
    const stoppedChannels = this.adapters.map((adapter) => adapter.channel);
    await Promise.all(this.adapters.map(async (adapter) => adapter.stop?.()));
    this.adapters = [];
    this.controllers = [];
    // Mark each previously-running platform as suspended (not removed),
    // so the renderer keeps the icon visible with a gray dot — the user
    // knows it's configured but currently off.
    for (const channel of stoppedChannels) {
      this.setPlatformHealth(channel, "suspended");
    }
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

function isMessagingPendingRequest(
  notification: AgentEvent["notification"],
): notification is AppServerPendingRequestNotification {
  if (notification.method === "item/tool/requestUserInput") {
    return true;
  }

  return notification.method.toLowerCase().includes("requestapproval");
}
