import {
  MessagingController,
  type MessagingBackendBridge,
} from "@pwragnt/agent-core";
import type {
  AgentEvent,
  MessagingDeliveryResult,
  MessagingInboundEvent,
  MessagingSurfaceIntent,
} from "@pwragnt/shared";
import { getMainLogger } from "../log";
import { getDesktopMessagingStore } from "./desktop-messaging-store";
import {
  loadDesktopMessagingConfig,
  redactDesktopMessagingConfig,
  type DesktopMessagingConfig,
} from "./messaging-config";
import { DesktopMessagingBackendBridge } from "./desktop-backend-bridge";
import { createDiscordAdapter } from "./discord-adapter";
import { createTelegramAdapter } from "./telegram-adapter";

export type DesktopMessagingAdapter = {
  channel: "telegram" | "discord";
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  start?(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void>;
  stop?(): Promise<void>;
};

export type DesktopMessagingAdapterFactory = (params: {
  config: DesktopMessagingConfig;
}) => DesktopMessagingAdapter[];

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

    const configuredAdapters = this.options.adapterFactory({
      config: this.options.config,
    });

    for (const adapter of configuredAdapters) {
      const controller = new MessagingController({
        adapter,
        authorizedActorIds:
          adapter.channel === "telegram"
            ? this.options.config.telegram?.authorizedActorIds ?? []
            : this.options.config.discord?.authorizedActorIds ?? [],
        backend: this.options.backendBridge,
        store: getDesktopMessagingStore(),
      });

      try {
        await adapter.start?.(async (event) => {
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
        this.controllers.map((controller) => controller.handleBackendEvent(event)),
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
}): DesktopMessagingAdapter[] {
  return [
    ...(params.config.telegram ? [createTelegramAdapter(params.config.telegram)] : []),
    ...(params.config.discord ? [createDiscordAdapter(params.config.discord)] : []),
  ];
}
