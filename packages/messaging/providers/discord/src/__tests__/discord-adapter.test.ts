import type { MessagingAuditContext } from "@pwragnt/messaging-interface";
import { describe, expect, it, vi } from "vitest";
import {
  DiscordAdapter,
  type DiscordApi,
} from "../discord-adapter.ts";
import type { DiscordApplicationCommand } from "../discord-commands.ts";

const unknownChannelError = new Error("DiscordAPIError[10003]: Unknown Channel");

describe("discord adapter", () => {
  it("returns a failed delivery when a stale channel rejects new messages", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const adapter = new DiscordAdapter({
      api: createApi({
        createMessage: vi.fn().mockRejectedValue(unknownChannelError),
      }),
      config: {
        authorizedActorIds: ["user-1"],
        botToken: "token",
        channel: "discord",
      },
      logger,
      now: () => 1234,
    });

    await expect(
      adapter.deliver({
        audit: discordAudit(),
        createdAt: 1234,
        id: "approval-1",
        kind: "approval",
        title: "Command Approval",
        body: "Approve this action?",
        decisions: [],
      }),
    ).resolves.toMatchObject({
      channel: "discord",
      deliveredAt: 1234,
      errorMessage: "DiscordAPIError[10003]: Unknown Channel",
      outcome: "failed",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("discord deliver failed kind=approval"),
    );
  });

  it("returns a failed delivery when updating a stale message fails", async () => {
    const adapter = new DiscordAdapter({
      api: createApi({
        updateMessage: vi.fn().mockRejectedValue(unknownChannelError),
      }),
      config: {
        authorizedActorIds: ["user-1"],
        botToken: "token",
        channel: "discord",
      },
      now: () => 1234,
    });

    await expect(
      adapter.deliver({
        audit: discordAudit(),
        createdAt: 1234,
        delivery: { mode: "update", fallback: "fail" },
        id: "status-1",
        kind: "status",
        status: "waiting",
        targetSurface: {
          channel: "discord",
          id: "message-1",
          state: {
            opaque: {
              channelId: "channel-1",
              messageId: "message-1",
            },
          },
        },
        text: "Waiting for approval",
      }),
    ).resolves.toMatchObject({
      channel: "discord",
      deliveredAt: 1234,
      errorMessage: "DiscordAPIError[10003]: Unknown Channel",
      outcome: "failed",
      surface: {
        channel: "discord",
        id: "message-1",
      },
    });
  });

  it("renames Discord threads without allowing plain channel renames", async () => {
    const updateChannelName = vi.fn(async () => {});
    const adapter = new DiscordAdapter({
      api: createApi({ updateChannelName }),
      config: {
        authorizedActorIds: ["user-1"],
        botToken: "token",
        channel: "discord",
      },
      now: () => 1234,
    });

    await expect(
      adapter.setConversationTitle({
        channel: {
          channel: "discord",
          conversation: {
            id: "thread-channel-1",
            kind: "channel",
            parentId: "guild-1",
          },
        },
        routingState: {
          opaque: {
            channelType: 11,
            isThread: true,
          },
        },
        title: "Thread one",
      }),
    ).resolves.toMatchObject({
      outcome: "updated",
      title: "Thread one",
    });
    expect(updateChannelName).toHaveBeenCalledWith("thread-channel-1", {
      name: "Thread one",
    });

    await expect(
      adapter.setConversationTitle({
        channel: {
          channel: "discord",
          conversation: {
            id: "plain-channel-1",
            kind: "channel",
            parentId: "guild-1",
          },
        },
        title: "Thread one",
      }),
    ).resolves.toMatchObject({
      outcome: "unsupported",
    });
    expect(updateChannelName).toHaveBeenCalledTimes(1);
  });

  it("sends file message intents as Discord upload files", async () => {
    const createMessage = vi.fn(async (channelId: string) => ({
      channel_id: channelId,
      id: "message-2",
    }));
    const adapter = new DiscordAdapter({
      api: createApi({ createMessage }),
      config: {
        authorizedActorIds: ["user-1"],
        botToken: "token",
        channel: "discord",
      },
      now: () => 1234,
    });
    const data = new Uint8Array([1, 2, 3]);

    await expect(
      adapter.deliver({
        audit: discordAudit(),
        createdAt: 1234,
        id: "message-file-1",
        kind: "message",
        parts: [
          {
            text: "Generated log",
            type: "text",
          },
          {
            data,
            mimeType: "text/plain",
            name: "streaming-logs.txt",
            sizeBytes: data.byteLength,
            type: "file",
          },
        ],
        role: "assistant",
      }),
    ).resolves.toMatchObject({
      channel: "discord",
      deliveredAt: 1234,
      outcome: "presented",
    });

    expect(createMessage).toHaveBeenCalledWith(
      "channel-1",
      expect.objectContaining({
        content: "Generated log",
        files: [
          {
            data,
            name: "streaming-logs.txt",
          },
        ],
      }),
    );
  });

  it("uploads data URL image message intents instead of embedding them", async () => {
    const createMessage = vi.fn(async (channelId: string) => ({
      channel_id: channelId,
      id: "message-2",
    }));
    const adapter = new DiscordAdapter({
      api: createApi({ createMessage }),
      config: {
        authorizedActorIds: ["user-1"],
        botToken: "token",
        channel: "discord",
      },
      now: () => 1234,
    });

    await adapter.deliver({
      audit: discordAudit(),
      createdAt: 1234,
      id: "message-image-data-url",
      kind: "message",
      parts: [
        {
          text: "Rendered image",
          type: "text",
        },
        {
          type: "image",
          url: "data:image/png;base64,AQID",
        },
      ],
      role: "assistant",
    });

    expect(createMessage).toHaveBeenCalledWith(
      "channel-1",
      expect.objectContaining({
        content: "Rendered image",
        embeds: undefined,
        files: [
          {
            data: new Uint8Array([1, 2, 3]),
            name: "assistant-image.png",
          },
        ],
      }),
    );
  });
});

function discordAudit(): MessagingAuditContext {
  return {
    action: "intent.deliver",
    actor: {
      displayName: "Harold",
      platformUserId: "user-1",
      username: "huntharo",
    },
    channel: {
      channel: "discord",
      conversation: {
        id: "channel-1",
        kind: "channel",
        parentId: "guild-1",
      },
    },
    occurredAt: 1234,
  };
}

function createApi(overrides: Partial<DiscordApi> = {}): DiscordApi {
  return {
    createApplicationCommand: async () => applicationCommand(),
    createInteractionResponse: async () => {},
    createMessage: async (channelId) => ({
      channel_id: channelId,
      id: "message-2",
    }),
    deleteApplicationCommand: async () => {},
    listApplicationCommands: async () => [],
    pinMessage: async () => {},
    sendTyping: async () => {},
    unpinMessage: async () => {},
    updateChannelName: async () => {},
    updateApplicationCommand: async () => applicationCommand(),
    updateInteractionOriginalResponse: async () => ({
      channel_id: "channel-1",
      id: "message-1",
    }),
    updateMessage: async (channelId, messageId) => ({
      channel_id: channelId,
      id: messageId,
    }),
    ...overrides,
  };
}

function applicationCommand(): DiscordApplicationCommand {
  return {
    description: "Choose a PwrAgnt thread to control from this conversation.",
    id: "command-1",
    name: "resume",
    type: 1,
  };
}
