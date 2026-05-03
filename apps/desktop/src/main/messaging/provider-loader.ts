import type { MessagingChannelKind } from "@pwragent/messaging-interface";
import { getMainLogger } from "../log";
import type { MessagingStoreLike } from "../state/messaging-store-sqlite";
import type { DesktopMessagingConfig } from "./messaging-config";
import type { DesktopMessagingAdapter } from "./messaging-runtime";

export type DesktopMessagingProviderId = Extract<
  MessagingChannelKind,
  "telegram" | "discord"
>;

export type DesktopMessagingProviderModule = {
  createAdapter(params: {
    config: DesktopMessagingConfig;
    logger: typeof messagingLog;
    store: MessagingStoreLike;
  }): DesktopMessagingAdapter | undefined;
};

export type DesktopMessagingProviderRegistry = Record<
  DesktopMessagingProviderId,
  {
    load(): Promise<DesktopMessagingProviderModule>;
  }
>;

const messagingLog = getMainLogger("pwragent:messaging");
const providerModuleCache = new Map<
  DesktopMessagingProviderId,
  Promise<DesktopMessagingProviderModule>
>();

export async function loadConfiguredMessagingAdapters(params: {
  config: DesktopMessagingConfig;
  registry?: DesktopMessagingProviderRegistry;
  store: MessagingStoreLike;
}): Promise<DesktopMessagingAdapter[]> {
  const registry = params.registry ?? defaultMessagingProviderRegistry;
  const adapters: DesktopMessagingAdapter[] = [];

  for (const providerId of configuredMessagingProviderIds(params.config)) {
    try {
      const provider = await loadMessagingProviderModule(providerId, registry);
      const adapter = provider.createAdapter({
        config: params.config,
        logger: messagingLog,
        store: params.store,
      });
      if (adapter) {
        adapters.push(adapter);
      }
    } catch (error) {
      messagingLog.error("messaging provider failed to load", {
        provider: providerId,
        error,
      });
    }
  }

  return adapters;
}

export function configuredMessagingProviderIds(
  config: DesktopMessagingConfig,
): DesktopMessagingProviderId[] {
  return [
    ...(config.telegram && config.telegram.enabled !== false
      ? (["telegram"] as const)
      : []),
    ...(config.discord && config.discord.enabled !== false ? (["discord"] as const) : []),
  ];
}

export function resetMessagingProviderLoaderForTests(): void {
  providerModuleCache.clear();
}

async function loadMessagingProviderModule(
  providerId: DesktopMessagingProviderId,
  registry: DesktopMessagingProviderRegistry,
): Promise<DesktopMessagingProviderModule> {
  const cached = providerModuleCache.get(providerId);
  if (cached) {
    return await cached;
  }

  const loadPromise = registry[providerId].load();
  providerModuleCache.set(providerId, loadPromise);
  return await loadPromise;
}

const defaultMessagingProviderRegistry: DesktopMessagingProviderRegistry = {
  discord: {
    async load() {
      const module = await import("@pwragent/messaging-provider-discord");
      return {
        createAdapter({ config, logger }) {
          return config.discord
            ? module.createDiscordAdapter(config.discord, logger)
            : undefined;
        },
      };
    },
  },
  telegram: {
    async load() {
      const module = await import("@pwragent/messaging-provider-telegram");
      return {
        createAdapter({ config, logger, store }) {
          return config.telegram
            ? module.createTelegramAdapter(config.telegram, store, logger)
            : undefined;
        },
      };
    },
  },
};
