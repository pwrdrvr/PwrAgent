import { describe, expect, it } from "vitest";
import type { DesktopMessagingConfig } from "../messaging/messaging-config";
import { resolveMessagingResponseModeForChannel } from "../messaging/messaging-response-mode";

const GUILD_ID = "1480556454498009351";
const CHANNEL_ID = "1480556454498009352";
const THREAD_ID = "1480556454498009353";

describe("resolveMessagingResponseModeForChannel", () => {
  it("applies Discord response modes from bound thread through global default", () => {
    const config = discordConfig({
      responseMode: "mention_only",
      authorizedGuildIds: [
        {
          id: GUILD_ID,
          displayName: "Test server",
          responseMode: "every_message",
        },
      ],
      responseModeOverrides: [
        {
          id: CHANNEL_ID,
          displayName: "parent-channel",
          responseMode: "mention_only",
        },
        {
          id: THREAD_ID,
          displayName: "native-thread",
          responseMode: "every_message",
        },
      ],
    });
    const channelRef = discordThreadRef();

    expect(resolve(config, channelRef, "mention_only")).toBe("mention_only");
    expect(resolve(config, channelRef)).toBe("every_message");
    expect(resolve(discordConfig({
      ...config.discord,
      responseModeOverrides: config.discord?.responseModeOverrides?.filter(
        (entry) => entry.id !== THREAD_ID,
      ),
    }), channelRef)).toBe("mention_only");
    expect(resolve(discordConfig({
      ...config.discord,
      responseModeOverrides: [],
    }), channelRef)).toBe("every_message");
    expect(resolve(discordConfig({
      ...config.discord,
      authorizedGuildIds: [{ id: GUILD_ID, displayName: "Test server" }],
      responseModeOverrides: [],
    }), channelRef)).toBe("mention_only");
    expect(resolve(discordConfig({
      authorizedGuildIds: [],
      responseModeOverrides: [],
    }), channelRef)).toBe("every_message");
  });

  it("inherits past an override row that carries no response mode", () => {
    // An override row with no `response_mode` is the "Default" state the
    // Routes picker offers. It must fall through to the server row, and a
    // server row with no mode of its own must fall through to the Discord-wide
    // default — this is what the Routes empty state promises operators.
    const withoutModes = discordConfig({
      responseMode: "mention_only",
      authorizedGuildIds: [{ id: GUILD_ID, displayName: "Test server" }],
      responseModeOverrides: [
        { id: THREAD_ID, displayName: "native-thread" },
        { id: CHANNEL_ID, displayName: "parent-channel" },
      ],
    });

    expect(resolve(withoutModes, discordThreadRef())).toBe("mention_only");

    const serverOnly = discordConfig({
      ...withoutModes.discord,
      authorizedGuildIds: [
        {
          id: GUILD_ID,
          displayName: "Test server",
          responseMode: "every_message",
        },
      ],
    });

    expect(resolve(serverOnly, discordThreadRef())).toBe("every_message");
  });
});

function discordConfig(
  discord: Partial<NonNullable<DesktopMessagingConfig["discord"]>>,
): DesktopMessagingConfig {
  return {
    discord: {
      authorizedActorIds: [],
      botToken: "token",
      channel: "discord",
      ...discord,
    },
  };
}

function discordThreadRef() {
  return {
    channel: "discord" as const,
    conversation: {
      id: THREAD_ID,
      kind: "thread" as const,
      parentId: GUILD_ID,
      parentConversationId: CHANNEL_ID,
      workspaceId: GUILD_ID,
    },
  };
}

function resolve(
  config: DesktopMessagingConfig,
  channelRef: ReturnType<typeof discordThreadRef>,
  bindingResponseMode?: "every_message" | "mention_only",
) {
  return resolveMessagingResponseModeForChannel({
    bindingResponseMode,
    channel: "discord",
    channelRef,
    config,
  });
}
