import { MessagingController } from "./core/messaging-controller";
import type { MessagingStore } from "./core/messaging-store";
import type { MessagingBackendBridge } from "./core/messaging-adapter";
import type { AgentEvent } from "@pwragnt/shared";
import type {
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
  channel: "telegram" | "discord";
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  start?(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void>;
  stop?(): Promise<void>;
};

export type DesktopMessagingAdapterFactory = (params: {
  config: DesktopMessagingConfig;
  store: MessagingStore;
}) => DesktopMessagingAdapter[] | Promise<DesktopMessagingAdapter[]>;

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
      config: DesktopMessagingConfig;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    const store = getDesktopMessagingStore();
    const configuredAdapters = await this.options.adapterFactory({
      config: this.options.config,
      store,
    });

    for (const adapter of configuredAdapters) {
      const authorizedActorIds =
        adapter.channel === "telegram"
          ? this.options.config.telegram?.authorizedActorIds ?? []
          : this.options.config.discord?.authorizedActorIds ?? [];
      const authorizedActorIdSet = new Set(authorizedActorIds);
      const controller = new MessagingController({
        adapter,
        authorizedActorIds,
        backend: this.options.backendBridge,
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
            await controller.handleBackendEvent(event);
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
      config: redactDesktopMessagingConfig(this.options.config),
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
}

let runtime: DesktopMessagingRuntime | null = null;

export function getDesktopMessagingRuntime(): DesktopMessagingRuntime {
  if (!runtime) {
    runtime = new DesktopMessagingRuntime({
      adapterFactory: createConfiguredAdapters,
      backendBridge: new DesktopMessagingBackendBridge(),
      config: loadDesktopMessagingConfig(),
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
