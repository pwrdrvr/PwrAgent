import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import type { MessagingStore } from "../messaging/core/messaging-store";
import type { DesktopMessagingConfig } from "../messaging/messaging-config";
import type {
  DesktopMessagingAdapter,
} from "../messaging/messaging-runtime";
import {
  configuredMessagingProviderIds,
  loadConfiguredMessagingAdapters,
  resetMessagingProviderLoaderForTests,
  type DesktopMessagingProviderRegistry,
} from "../messaging/provider-loader";

const messagingLog = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => messagingLog),
}));

beforeEach(() => {
  messagingLog.error.mockReset();
  resetMessagingProviderLoaderForTests();
});

describe("messaging provider loader", () => {
  it("does not load providers when no channel is configured", async () => {
    const registry = createRegistry();

    await expect(
      loadConfiguredMessagingAdapters({
        config: {},
        registry,
        store: createStore(),
      }),
    ).resolves.toEqual([]);

    expect(registry.telegram.load).not.toHaveBeenCalled();
    expect(registry.discord.load).not.toHaveBeenCalled();
  });

  it("loads only enabled configured providers and caches modules", async () => {
    const registry = createRegistry();
    const store = createStore();
    const config: DesktopMessagingConfig = {
      discord: {
        authorizedActorIds: ["discord-user"],
        botToken: "discord-token",
        channel: "discord",
        enabled: false,
      },
      telegram: {
        authorizedActorIds: ["telegram-user"],
        botToken: "telegram-token",
        channel: "telegram",
      },
    };

    await expect(
      loadConfiguredMessagingAdapters({ config, registry, store }),
    ).resolves.toMatchObject([
      {
        channel: "telegram",
      },
    ]);
    await loadConfiguredMessagingAdapters({ config, registry, store });

    expect(configuredMessagingProviderIds(config)).toEqual(["telegram"]);
    expect(registry.telegram.load).toHaveBeenCalledTimes(1);
    expect(registry.discord.load).not.toHaveBeenCalled();
  });

  it("continues loading other configured providers after an import failure", async () => {
    const registry = createRegistry({
      telegram: {
        load: vi.fn(async () => {
          throw new Error("telegram import failed");
        }),
      },
    });
    const config: DesktopMessagingConfig = {
      discord: {
        authorizedActorIds: ["discord-user"],
        botToken: "discord-token",
        channel: "discord",
      },
      telegram: {
        authorizedActorIds: ["telegram-user"],
        botToken: "telegram-token",
        channel: "telegram",
      },
    };

    await expect(
      loadConfiguredMessagingAdapters({
        config,
        registry,
        store: createStore(),
      }),
    ).resolves.toMatchObject([
      {
        channel: "discord",
      },
    ]);

    expect(messagingLog.error).toHaveBeenCalledWith(
      "messaging provider failed to load",
      expect.objectContaining({
        provider: "telegram",
      }),
    );
  });
});

function createRegistry(
  overrides: Partial<DesktopMessagingProviderRegistry> = {},
): DesktopMessagingProviderRegistry {
  return {
    discord: {
      load: vi.fn(async () => ({
        createAdapter: ({ config }: { config: DesktopMessagingConfig }) =>
          config.discord ? createAdapter("discord") : undefined,
      })),
    },
    telegram: {
      load: vi.fn(async () => ({
        createAdapter: ({ config }: { config: DesktopMessagingConfig }) =>
          config.telegram ? createAdapter("telegram") : undefined,
      })),
    },
    ...overrides,
  };
}

function createAdapter(channel: "telegram" | "discord"): DesktopMessagingAdapter {
  return {
    authorizedActorIds: [`${channel}-user`],
    channel,
    deliver: vi.fn(async (intent: MessagingSurfaceIntent) => ({
      channel,
      deliveredAt: Date.now(),
      outcome: "presented" as const,
      surface: {
        channel,
        id: intent.id,
      },
    })),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

function createStore(): MessagingStore {
  return {} as MessagingStore;
}
