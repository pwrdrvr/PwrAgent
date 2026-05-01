import { MessagingController } from "./core/messaging-controller";
import type { MessagingStore } from "./core/messaging-store";
import type { MessagingBackendBridge } from "./core/messaging-adapter";
import type { AgentEvent, AppServerPendingRequestNotification } from "@pwragnt/shared";
import type {
  MessagingChannelKind,
  MessagingDeliveryResult,
  MessagingInboundEvent,
  MessagingSurfaceIntent,
} from "@pwragnt/messaging-interface";
import { getMainLogger } from "../log";
import { getDesktopMessagingStore } from "./desktop-messaging-store";
import {
  loadDesktopMessagingConfig,
  redactDesktopMessagingConfig,
  type DesktopMessagingConfig,
} from "./messaging-config";
import { DesktopMessagingBackendBridge } from "./desktop-backend-bridge";
import { loadConfiguredMessagingAdapters } from "./provider-loader";

export type DesktopMessagingAdapter = {
  authorizedActorIds: readonly string[];
  channel: MessagingChannelKind;
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  start?(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void>;
  stop?(): Promise<void>;
};

export type DesktopMessagingAdapterFactory = (params: {
  config: DesktopMessagingConfig;
  store: MessagingStore;
}) => DesktopMessagingAdapter[] | Promise<DesktopMessagingAdapter[]>;

export type DesktopMessagingConfigLoader = () =>
  | DesktopMessagingConfig
  | Promise<DesktopMessagingConfig>;

const messagingLog = getMainLogger("pwragnt:messaging");

export class DesktopMessagingRuntime {
  private adapters: DesktopMessagingAdapter[] = [];
  private controllers: MessagingController[] = [];
  private unsubscribeBackendEvents?: () => void;
  private started = false;

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
    const config = await this.loadConfig();
    const configuredAdapters = await this.options.adapterFactory({
      config,
      store,
    });

    for (const adapter of configuredAdapters) {
      const authorizedActorIds = [...adapter.authorizedActorIds];
      const authorizedActorIdSet = new Set(authorizedActorIds);
      const controller = new MessagingController({
        adapter,
        authorizedActorIds,
        backend: this.options.backendBridge,
        channel: adapter.channel,
        store,
      });

      try {
        await adapter.start?.(async (event) => {
          if (!authorizedActorIdSet.has(event.actor.platformUserId)) {
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
        });
      } catch (error) {
        messagingLog.error("messaging adapter failed to start", {
          channel: adapter.channel,
          error,
        });
        continue;
      }

      this.adapters.push(adapter);
      this.controllers.push(controller);
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

    messagingLog.info("messaging runtime started", {
      adapters: this.adapters.map((adapter) => adapter.channel),
      config: redactDesktopMessagingConfig(config),
    });
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;

    this.unsubscribeBackendEvents?.();
    this.unsubscribeBackendEvents = undefined;
    await Promise.all(this.adapters.map(async (adapter) => adapter.stop?.()));
    this.adapters = [];
    this.controllers = [];
  }

  private async loadConfig(): Promise<DesktopMessagingConfig> {
    return typeof this.options.config === "function"
      ? await this.options.config()
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
      config: config ?? loadDesktopMessagingConfig,
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
  store: MessagingStore;
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
