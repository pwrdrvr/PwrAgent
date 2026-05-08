import type {
  MessagingAuditContext,
  MessagingInboundEvent,
  MessagingRejectedInboundEvent,
} from "@pwragent/messaging-interface";
import { describe, expect, it, vi } from "vitest";
import {
  DiscordAdapter,
  stripDiscordBotMention,
  type DiscordApi,
  type DiscordGatewayConnection,
  type DiscordGatewayEvent,
  type DiscordGatewayListener,
  type DiscordMessageCreateDispatch,
} from "../discord-adapter.ts";
import type { DiscordApplicationCommand } from "../discord-commands.ts";

const unknownChannelError = new Error("DiscordAPIError[10003]: Unknown Channel");
const TEST_CHANNEL_ID = "1480556454498009352";
const TEST_GUILD_ID = "1480556454498009353";
const TEST_MESSAGE_ID = "1480556454498009354";
const TEST_USER_ID = "1480556454498009355";

describe("discord adapter", () => {
  it("returns a failed delivery when a stale channel rejects new messages", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const adapter = new DiscordAdapter({
      api: createApi({
        createMessage: vi.fn().mockRejectedValue(unknownChannelError),
      }),
      config: {
        authorizedActorIds: [TEST_USER_ID],
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
        authorizedActorIds: [TEST_USER_ID],
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
        authorizedActorIds: [TEST_USER_ID],
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
        authorizedActorIds: [TEST_USER_ID],
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
        authorizedActorIds: [TEST_USER_ID],
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

  describe("stripDiscordBotMention", () => {
    const BOT_ID = "1480556454498009352";

    it("strips a leading <@id> mention and returns the verb remainder", () => {
      expect(stripDiscordBotMention(`<@${BOT_ID}> help`, BOT_ID)).toBe("help");
    });

    it("accepts the legacy <@!id> nickname-alias form", () => {
      expect(stripDiscordBotMention(`<@!${BOT_ID}> resume`, BOT_ID)).toBe("resume");
    });

    it("preserves args after the verb", () => {
      expect(stripDiscordBotMention(`<@${BOT_ID}> resume thread-42`, BOT_ID)).toBe(
        "resume thread-42",
      );
    });

    it("tolerates leading whitespace before the mention", () => {
      expect(stripDiscordBotMention(`   <@${BOT_ID}> help`, BOT_ID)).toBe("help");
    });

    it("returns undefined when the mention is the entire message", () => {
      expect(stripDiscordBotMention(`<@${BOT_ID}>`, BOT_ID)).toBeUndefined();
      expect(stripDiscordBotMention(`<@${BOT_ID}>   `, BOT_ID)).toBeUndefined();
    });

    it("returns undefined when the message doesn't start with the mention", () => {
      expect(stripDiscordBotMention(`hi <@${BOT_ID}> help`, BOT_ID)).toBeUndefined();
      expect(stripDiscordBotMention("just text", BOT_ID)).toBeUndefined();
    });

    it("returns undefined when a different user is mentioned", () => {
      expect(stripDiscordBotMention("<@9999999> help", BOT_ID)).toBeUndefined();
    });

    it("returns undefined when botUserId is unset", () => {
      expect(stripDiscordBotMention(`<@${BOT_ID}> help`, undefined)).toBeUndefined();
    });
  });

  describe("text mention dispatch", () => {
    it("drops messages from unauthorized guilds before listener dispatch", async () => {
      const events: MessagingInboundEvent[] = [];
      const rejectedEvents: MessagingRejectedInboundEvent[] = [];
      const gateway = new TestDiscordGateway();
      const logger = { debug: vi.fn(), warn: vi.fn() };
      const adapter = new DiscordAdapter({
        api: createApi(),
        config: {
          authorizedActorIds: [TEST_USER_ID],
          authorizedGuildIds: ["1480556454498009999"],
          botToken: "token",
          channel: "discord",
        },
        gateway,
        logger,
        now: () => 1234,
      });

      await adapter.start(async (event) => {
        events.push(event);
      });
      adapter.onInboundRejected((event) => {
        rejectedEvents.push(event);
      });
      await gateway.emit({
        op: 0,
        t: "MESSAGE_CREATE",
        d: messageDispatch({
          authorBot: false,
          content: "/status",
          id: "unauthorized-guild-msg",
        }),
      });

      expect(events).toHaveLength(0);
      expect(rejectedEvents).toEqual([
        expect.objectContaining({
          actor: expect.objectContaining({ platformUserId: TEST_USER_ID }),
          channel: expect.objectContaining({
            conversation: expect.objectContaining({
              id: TEST_CHANNEL_ID,
              parentId: TEST_GUILD_ID,
            }),
          }),
          kind: "command",
          reason: "unauthorized-conversation",
        }),
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        "discord inbound ignored unauthorized guild",
        expect.objectContaining({ guildId: TEST_GUILD_ID }),
      );
      await adapter.stop();
    });

    it("drops malformed component IDs before acknowledging the interaction", async () => {
      const events: MessagingInboundEvent[] = [];
      const createInteractionResponse = vi.fn(async () => {});
      const gateway = new TestDiscordGateway();
      const logger = { debug: vi.fn(), warn: vi.fn() };
      const adapter = new DiscordAdapter({
        api: createApi({ createInteractionResponse }),
        config: {
          applicationId: TEST_CHANNEL_ID,
          authorizedActorIds: [TEST_USER_ID],
          botToken: "token",
          channel: "discord",
        },
        gateway,
        logger,
        now: () => 1234,
      });

      await adapter.start(async (event) => {
        events.push(event);
      });
      await gateway.emit({
        op: 0,
        t: "INTERACTION_CREATE",
        d: {
          channel_id: TEST_CHANNEL_ID,
          data: {
            custom_id: "bad\r\ncustom-id",
          },
          guild_id: TEST_GUILD_ID,
          id: TEST_MESSAGE_ID,
          token: "token_ABC.123",
          type: 3,
          user: {
            id: TEST_USER_ID,
            username: "huntharo",
          },
        },
      });

      expect(createInteractionResponse).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        "messaging inbound identifier rejected",
        expect.objectContaining({
          platform: "discord",
          identifier_field: "custom_id",
        }),
      );
      await adapter.stop();
    });

    it("acknowledges valid component interactions from unauthorized guilds before dropping them", async () => {
      const events: MessagingInboundEvent[] = [];
      const rejectedEvents: MessagingRejectedInboundEvent[] = [];
      const createInteractionResponse = vi.fn(async () => {});
      const gateway = new TestDiscordGateway();
      const logger = { debug: vi.fn(), warn: vi.fn() };
      const adapter = new DiscordAdapter({
        api: createApi({ createInteractionResponse }),
        config: {
          applicationId: TEST_CHANNEL_ID,
          authorizedActorIds: [TEST_USER_ID],
          authorizedGuildIds: ["1480556454498009999"],
          botToken: "token",
          channel: "discord",
        },
        gateway,
        logger,
        now: () => 1234,
      });

      await adapter.start(async (event) => {
        events.push(event);
      });
      adapter.onInboundRejected((event) => {
        rejectedEvents.push(event);
      });
      await gateway.emit({
        op: 0,
        t: "INTERACTION_CREATE",
        d: {
          channel_id: TEST_CHANNEL_ID,
          data: {
            custom_id: "dc:abcdefghijklmnopqrstuvwx",
          },
          guild_id: TEST_GUILD_ID,
          id: TEST_MESSAGE_ID,
          token: "token_ABC.123",
          type: 3,
          user: {
            id: TEST_USER_ID,
            username: "huntharo",
          },
        },
      });

      expect(createInteractionResponse).toHaveBeenCalledWith(TEST_MESSAGE_ID, "token_ABC.123", {
        type: 6,
      });
      expect(events).toHaveLength(0);
      expect(rejectedEvents).toEqual([
        expect.objectContaining({
          actor: expect.objectContaining({ platformUserId: TEST_USER_ID }),
          channel: expect.objectContaining({
            conversation: expect.objectContaining({
              id: TEST_CHANNEL_ID,
              parentId: TEST_GUILD_ID,
            }),
          }),
          kind: "callback",
          reason: "unauthorized-conversation",
        }),
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        "discord inbound ignored unauthorized guild",
        expect.objectContaining({ guildId: TEST_GUILD_ID, surface: "interaction" }),
      );
      await adapter.stop();
    });

    it("defers valid slash commands from unauthorized actors before dropping them", async () => {
      const events: MessagingInboundEvent[] = [];
      const createInteractionResponse = vi.fn(async () => {});
      const gateway = new TestDiscordGateway();
      const logger = { debug: vi.fn(), warn: vi.fn() };
      const adapter = new DiscordAdapter({
        api: createApi({ createInteractionResponse }),
        config: {
          applicationId: TEST_CHANNEL_ID,
          authorizedActorIds: ["1480556454498009999"],
          botToken: "token",
          channel: "discord",
        },
        gateway,
        logger,
        now: () => 1234,
      });

      await adapter.start(async (event) => {
        events.push(event);
      });
      await gateway.emit({
        op: 0,
        t: "INTERACTION_CREATE",
        d: {
          channel_id: TEST_CHANNEL_ID,
          data: {
            name: "resume",
          },
          guild_id: TEST_GUILD_ID,
          id: TEST_MESSAGE_ID,
          token: "token_ABC.123",
          type: 2,
          user: {
            id: TEST_USER_ID,
            username: "huntharo",
          },
        },
      });

      expect(createInteractionResponse).toHaveBeenCalledWith(TEST_MESSAGE_ID, "token_ABC.123", {
        type: 5,
      });
      expect(events).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        "discord interaction ignored unauthorized actor",
        expect.objectContaining({
          actorId: TEST_USER_ID,
          interactionKind: "command",
        }),
      );
      await adapter.stop();
    });

    it("dispatches `<@bot> resume` as a command event", async () => {
      const BOT_ID = "1480556454498009352";
      const events: MessagingInboundEvent[] = [];
      const gateway = new TestDiscordGateway();
      const adapter = new DiscordAdapter({
        api: createApi(),
        config: {
          applicationId: BOT_ID,
          authorizedActorIds: [TEST_USER_ID],
          botToken: "token",
          channel: "discord",
        },
        gateway,
        now: () => 1234,
      });

      await adapter.start(async (event) => {
        events.push(event);
      });

      await gateway.emit({
        op: 0,
        t: "MESSAGE_CREATE",
        d: messageDispatch({
          authorBot: false,
          content: `<@${BOT_ID}> resume`,
          id: "msg-1",
        }),
      });

      expect(events).toHaveLength(1);
      const dispatched = events[0];
      expect(dispatched).toMatchObject({
        kind: "command",
        command: "resume",
        rawText: "/resume",
      });
      await adapter.stop();
    });

    it("dispatches `<@bot> help args` with args parsed from the remainder", async () => {
      const BOT_ID = "1480556454498009352";
      const events: MessagingInboundEvent[] = [];
      const gateway = new TestDiscordGateway();
      const adapter = new DiscordAdapter({
        api: createApi(),
        config: {
          applicationId: BOT_ID,
          authorizedActorIds: [TEST_USER_ID],
          botToken: "token",
          channel: "discord",
        },
        gateway,
        now: () => 1234,
      });

      await adapter.start(async (event) => {
        events.push(event);
      });
      await gateway.emit({
        op: 0,
        t: "MESSAGE_CREATE",
        d: messageDispatch({
          authorBot: false,
          content: `<@${BOT_ID}> help foo bar`,
          id: "msg-2",
        }),
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "command",
        command: "help",
        args: ["foo", "bar"],
        rawText: "/help foo bar",
      });
      await adapter.stop();
    });

    it("routes a caption like `<@bot> resume` on an attachment to a command, not media", async () => {
      const BOT_ID = "1480556454498009352";
      const events: MessagingInboundEvent[] = [];
      const gateway = new TestDiscordGateway();
      const adapter = new DiscordAdapter({
        api: createApi(),
        config: {
          applicationId: BOT_ID,
          authorizedActorIds: [TEST_USER_ID],
          botToken: "token",
          channel: "discord",
        },
        gateway,
        now: () => 1234,
      });

      await adapter.start(async (event) => {
        events.push(event);
      });
      await gateway.emit({
        op: 0,
        t: "MESSAGE_CREATE",
        d: messageDispatch({
          attachments: [
            {
              filename: "screenshot.png",
              id: "att-1",
              size: 100,
              url: "https://cdn.discordapp.com/.../screenshot.png",
            },
          ],
          authorBot: false,
          content: `<@${BOT_ID}> resume`,
          id: "msg-cap-1",
        }),
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "command",
        command: "resume",
        rawText: "/resume",
      });
      await adapter.stop();
    });

    it("preserves media dispatch when the caption isn't a recognized mention command", async () => {
      const BOT_ID = "1480556454498009352";
      const events: MessagingInboundEvent[] = [];
      const gateway = new TestDiscordGateway();
      const adapter = new DiscordAdapter({
        api: createApi(),
        config: {
          applicationId: BOT_ID,
          authorizedActorIds: [TEST_USER_ID],
          botToken: "token",
          channel: "discord",
        },
        gateway,
        now: () => 1234,
      });

      await adapter.start(async (event) => {
        events.push(event);
      });
      await gateway.emit({
        op: 0,
        t: "MESSAGE_CREATE",
        d: messageDispatch({
          attachments: [
            {
              filename: "logs.txt",
              id: "att-2",
              size: 12,
              url: "https://cdn.discordapp.com/.../logs.txt",
            },
          ],
          authorBot: false,
          content: "see the attached logs",
          id: "msg-cap-2",
        }),
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "media",
        text: "see the attached logs",
      });
      await adapter.stop();
    });

    it("falls through to a text event when the mention isn't ours", async () => {
      const BOT_ID = "1480556454498009352";
      const events: MessagingInboundEvent[] = [];
      const gateway = new TestDiscordGateway();
      const adapter = new DiscordAdapter({
        api: createApi(),
        config: {
          applicationId: BOT_ID,
          authorizedActorIds: [TEST_USER_ID],
          botToken: "token",
          channel: "discord",
        },
        gateway,
        now: () => 1234,
      });

      await adapter.start(async (event) => {
        events.push(event);
      });
      await gateway.emit({
        op: 0,
        t: "MESSAGE_CREATE",
        d: messageDispatch({
          authorBot: false,
          content: "hey <@9999999> what's up",
          id: "msg-3",
        }),
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "text",
        text: "hey <@9999999> what's up",
      });
      await adapter.stop();
    });
  });
});

class TestDiscordGateway implements DiscordGatewayConnection {
  private readonly listeners = new Set<DiscordGatewayListener>();

  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.listeners.clear();
  }
  onEvent(listener: DiscordGatewayListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async emit(event: DiscordGatewayEvent): Promise<void> {
    await Promise.all([...this.listeners].map(async (listener) => listener(event)));
  }
}

function messageDispatch(params: {
  attachments?: DiscordMessageCreateDispatch["attachments"];
  authorBot: boolean;
  content: string;
  id: string;
}): DiscordMessageCreateDispatch {
  return {
    attachments: params.attachments?.map((attachment) => ({
      ...attachment,
      id: snowflakeForTestId(attachment.id),
    })),
    author: {
      bot: params.authorBot,
      id: TEST_USER_ID,
      username: "huntharo",
    },
    channel_id: TEST_CHANNEL_ID,
    channel_type: 0,
    content: params.content,
    guild_id: TEST_GUILD_ID,
    id: snowflakeForTestId(params.id),
    is_thread: false,
  };
}

function snowflakeForTestId(id: string): string {
  let hash = 0n;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31n + BigInt(id.charCodeAt(index))) & 0xfffffn;
  }
  return String(1480556454498009352n + hash);
}

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
    getChannel: async (id: string) => ({ id }),
    getGuild: async (id: string) => ({ id }),
    listApplicationCommands: async () => [],
    pinMessage: async () => {},
    sendTyping: async () => {},
    unpinMessage: async () => {},
    updateChannelName: async () => {},
    updateApplicationCommand: async () => applicationCommand(),
    updateInteractionOriginalResponse: async () => ({
      channel_id: TEST_CHANNEL_ID,
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
    description: "Choose a PwrAgent thread to control from this conversation.",
    id: "command-1",
    name: "resume",
    type: 1,
  };
}
