import { MessagingController } from "./core/messaging-controller";
import type { MessagingStoreLike } from "../state/messaging-store-sqlite";
import type {
  MessagingAdapter,
  MessagingBackendBridge,
  MessagingConversationTitleUpdateRequest,
  MessagingConversationTitleUpdateResult,
} from "./core/messaging-adapter";
import type { AgentEvent, AppServerPendingRequestNotification } from "@pwragent/shared";
import type {
  MessagingChannelKind,
  MessagingDeliveryResult,
  MessagingInboundEvent,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
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

export type DesktopMessagingConfigLoader = () =>
  | DesktopMessagingConfig
  | Promise<DesktopMessagingConfig>;

const messagingLog = getMainLogger("pwragent:messaging");

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
      });

      try {
        await adapter.start?.(async (event) => {
          try {
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
        continue;
      }

      messagingLog.info(`${adapter.channel}: adapter started successfully`, {
        channel: adapter.channel,
      });
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
