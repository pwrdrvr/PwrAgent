import type {
  MessagingAuditContext,
  MessagingCallbackHandleRecord,
  MessagingCallbackHandleStore,
  MessagingInboundEvent,
  MessagingRejectedInboundEvent,
  MessagingStatusIntent,
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
const TEST_OTHER_USER_ID = "1480556454498009356";

describe("discord adapter", () => {
  it("returns a failed delivery when a stale channel rejects new messages", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const adapter = new DiscordAdapter({
      api: createApi({
        createMessage: vi.fn().mockRejectedValue(unknownChannelError),
      }),
      config: {
        authorizedActorIds: [{ id: TEST_USER_ID, displayName: "" }],
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
        authorizedActorIds: [{ id: TEST_USER_ID, displayName: "" }],
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
        authorizedActorIds: [{ id: TEST_USER_ID, displayName: "" }],
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
        authorizedActorIds: [{ id: TEST_USER_ID, displayName: "" }],
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
        authorizedActorIds: [{ id: TEST_USER_ID, displayName: "" }],
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

  it("resolves persisted component handles after an adapter restart", async () => {
    const store = createCallbackHandleStore();
    let createdRequest: Parameters<DiscordApi["createMessage"]>[1] | undefined;
    const createMessage = vi.fn(async (channelId: string, request) => {
      createdRequest = request;
      return {
        channel_id: channelId,
        id: "message-2",
      };
    });
    const adapter = new DiscordAdapter({
      api: createApi({ createMessage }),
      config: {
        authorizedActorIds: [{ id: TEST_USER_ID, displayName: "" }],
        botToken: "token",
        channel: "discord",
      },
      now: () => 1234,
      store,
    });

    await adapter.deliver({
      audit: {
        action: "intent.deliver",
        actor: {
          displayName: "Harold",
          platformUserId: TEST_USER_ID,
          username: "huntharo",
        },
        channel: {
          channel: "discord",
          conversation: {
            id: TEST_CHANNEL_ID,
            kind: "channel",
            parentId: TEST_GUILD_ID,
          },
        },
        bindingId: "binding-1",
        occurredAt: 1234,
      },
      allowedActorIds: [TEST_USER_ID, TEST_OTHER_USER_ID],
      actions: [
        {
          id: "permissions",
          label: "Permissions",
          value: { mode: "review" },
        },
      ],
      createdAt: 1234,
      id: "status-1",
      kind: "status",
      status: "waiting",
      text: "Ready",
    });

    const customId = createdRequest?.components?.[0]?.components[0]?.custom_id;
    expect(customId).toMatch(/^dc:/);
    expect(store.upsertCallbackHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "permissions",
        allowedActorIds: [TEST_USER_ID, TEST_OTHER_USER_ID],
        bindingId: "binding-1",
        handle: customId,
        value: { mode: "review" },
      }),
    );

    const events: MessagingInboundEvent[] = [];
    const gateway = new TestDiscordGateway();
    const createInteractionResponse = vi.fn(async () => {});
    const restartedAdapter = new DiscordAdapter({
      api: createApi({ createInteractionResponse }),
      config: {
        authorizedActorIds: [
          { id: TEST_USER_ID, displayName: "" },
          { id: TEST_OTHER_USER_ID, displayName: "" },
        ],
        botToken: "token",
        channel: "discord",
      },
      gateway,
      now: () => 1235,
      store,
    });
    await restartedAdapter.start(async (event) => {
      events.push(event);
    });

    await gateway.emit({
      op: 0,
      t: "INTERACTION_CREATE",
      d: {
        channel_id: TEST_CHANNEL_ID,
        data: {
          custom_id: customId,
        },
        guild_id: TEST_GUILD_ID,
        id: TEST_MESSAGE_ID,
        token: "token_ABC.123",
        type: 3,
        user: {
          id: TEST_OTHER_USER_ID,
          username: "pwrdrvr",
        },
      },
    });

    expect(createInteractionResponse).toHaveBeenCalledWith(TEST_MESSAGE_ID, "token_ABC.123", {
      type: 6,
    });
    expect(events).toEqual([
      expect.objectContaining({
        actionId: "permissions",
        kind: "callback",
        value: { mode: "review" },
      }),
    ]);
    await restartedAdapter.stop();
  });

  it("validates live component clicks against persisted callback actor scope", async () => {
    const store = createCallbackHandleStore();
    let createdRequest: Parameters<DiscordApi["createMessage"]>[1] | undefined;
    const createMessage = vi.fn(async (channelId: string, request) => {
      createdRequest = request;
      return {
        channel_id: channelId,
        id: "message-2",
      };
    });
    const gateway = new TestDiscordGateway();
    const createInteractionResponse = vi.fn(async () => {});
    const adapter = new DiscordAdapter({
      api: createApi({ createInteractionResponse, createMessage }),
      config: {
        authorizedActorIds: [
          { id: TEST_USER_ID, displayName: "" },
          { id: TEST_OTHER_USER_ID, displayName: "" },
        ],
        botToken: "token",
        channel: "discord",
      },
      gateway,
      now: () => 1235,
      store,
    });

    await adapter.deliver({
      audit: {
        action: "intent.deliver",
        actor: {
          platformUserId: TEST_USER_ID,
        },
        channel: {
          channel: "discord",
          conversation: {
            id: TEST_CHANNEL_ID,
            kind: "channel",
            parentId: TEST_GUILD_ID,
          },
        },
        bindingId: "binding-1",
        occurredAt: 1234,
      },
      allowedActorIds: [TEST_USER_ID],
      actions: [
        {
          id: "permissions",
          label: "Permissions",
          value: { mode: "review" },
        },
      ],
      createdAt: 1234,
      id: "status-1",
      kind: "status",
      status: "waiting",
      text: "Ready",
    });

    const customId = createdRequest?.components?.[0]?.components[0]?.custom_id;
    expect(customId).toMatch(/^dc:/);

    const events: MessagingInboundEvent[] = [];
    await adapter.start(async (event) => {
      events.push(event);
    });

    await gateway.emit({
      op: 0,
      t: "INTERACTION_CREATE",
      d: {
        channel_id: TEST_CHANNEL_ID,
        data: {
          custom_id: customId,
        },
        guild_id: TEST_GUILD_ID,
        id: TEST_MESSAGE_ID,
        token: "token_ABC.123",
        type: 3,
        user: {
          id: TEST_OTHER_USER_ID,
          username: "pwrdrvr",
        },
      },
    });

    expect(store.resolveCallbackHandle).toHaveBeenCalledWith({
      actorId: TEST_OTHER_USER_ID,
      channel: expect.objectContaining({
        conversation: expect.objectContaining({ id: TEST_CHANNEL_ID }),
      }),
      handle: customId,
      now: 1235,
    });
    expect(createInteractionResponse).toHaveBeenCalledWith(TEST_MESSAGE_ID, "token_ABC.123", {
      type: 6,
    });
    expect(events).toEqual([
      expect.objectContaining({
        actionId: undefined,
        kind: "callback",
        value: undefined,
      }),
    ]);
    await adapter.stop();
  });

  it("keeps persisted handles for fan-out deliveries in separate conversations", async () => {
    const store = createCallbackHandleStore();
    const firstChannelId = TEST_CHANNEL_ID;
    const secondChannelId = "1480556454498009360";
    const createdRequests = new Map<string, Parameters<DiscordApi["createMessage"]>[1]>();
    const createMessage = vi.fn(async (channelId: string, request) => {
      createdRequests.set(channelId, request);
      return {
        channel_id: channelId,
        id: `message-${channelId}`,
      };
    });
    const adapter = new DiscordAdapter({
      api: createApi({ createMessage }),
      config: {
        authorizedActorIds: [{ id: TEST_USER_ID, displayName: "" }],
        botToken: "token",
        channel: "discord",
      },
      now: () => 1234,
      store,
    });
    const baseIntent: Omit<MessagingStatusIntent, "audit" | "bindingId"> = {
      allowedActorIds: [TEST_USER_ID],
      actions: [
        {
          id: "cancel",
          label: "Cancel",
          value: { queue: "permissions" },
        },
      ],
      createdAt: 1234,
      id: "queued-permissions-1",
      kind: "status",
      status: "waiting",
      text: "Permissions change queued",
    };

    await adapter.deliver({
      ...baseIntent,
      audit: {
        action: "intent.deliver",
        actor: { platformUserId: TEST_USER_ID },
        bindingId: "binding-1",
        channel: {
          channel: "discord",
          conversation: {
            id: firstChannelId,
            kind: "channel",
            parentId: TEST_GUILD_ID,
          },
        },
        occurredAt: 1234,
      },
    });
    await adapter.deliver({
      ...baseIntent,
      audit: {
        action: "intent.deliver",
        actor: { platformUserId: TEST_USER_ID },
        bindingId: "binding-2",
        channel: {
          channel: "discord",
          conversation: {
            id: secondChannelId,
            kind: "channel",
            parentId: TEST_GUILD_ID,
          },
        },
        occurredAt: 1234,
      },
    });

    const firstCustomId =
      createdRequests.get(firstChannelId)?.components?.[0]?.components[0]?.custom_id;
    const secondCustomId =
      createdRequests.get(secondChannelId)?.components?.[0]?.components[0]?.custom_id;
    expect(firstCustomId).toMatch(/^dc:/);
    expect(secondCustomId).toBe(firstCustomId);
    expect(store.upsertCallbackHandle).toHaveBeenCalledTimes(2);
    expect(store.upsertCallbackHandle).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        bindingId: "binding-1",
      }),
    );
    expect(store.upsertCallbackHandle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        bindingId: "binding-2",
      }),
    );

    const events: MessagingInboundEvent[] = [];
    const gateway = new TestDiscordGateway();
    const restartedAdapter = new DiscordAdapter({
      api: createApi(),
      config: {
        authorizedActorIds: [{ id: TEST_USER_ID, displayName: "" }],
        botToken: "token",
        channel: "discord",
      },
      gateway,
      now: () => 1235,
      store,
    });
    await restartedAdapter.start(async (event) => {
      events.push(event);
    });

    await gateway.emit({
      op: 0,
      t: "INTERACTION_CREATE",
      d: {
        channel_id: firstChannelId,
        data: {
          custom_id: firstCustomId,
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

    expect(events).toEqual([
      expect.objectContaining({
        actionId: "cancel",
        channel: expect.objectContaining({
          conversation: expect.objectContaining({ id: firstChannelId }),
        }),
        kind: "callback",
        value: { queue: "permissions" },
      }),
    ]);
    await restartedAdapter.stop();
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
          authorizedActorIds: [{ id: TEST_USER_ID, displayName: "" }],
          authorizedGuildIds: [{ id: "1480556454498009999", displayName: "" }],
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
          authorizedActorIds: [{ id: TEST_USER_ID, displayName: "" }],
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
          authorizedActorIds: [{ id: TEST_USER_ID, displayName: "" }],
          authorizedGuildIds: [{ id: "1480556454498009999", displayName: "" }],
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
          authorizedActorIds: [{ id: "1480556454498009999", displayName: "" }],
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
          authorizedActorIds: [{ id: TEST_USER_ID, displayName: "" }],
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
          authorizedActorIds: [{ id: TEST_USER_ID, displayName: "" }],
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
          authorizedActorIds: [{ id: TEST_USER_ID, displayName: "" }],
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
          authorizedActorIds: [{ id: TEST_USER_ID, displayName: "" }],
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
          authorizedActorIds: [{ id: TEST_USER_ID, displayName: "" }],
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

function createCallbackHandleStore(): MessagingCallbackHandleStore {
  const records = new Map<string, MessagingCallbackHandleRecord>();
  return {
    resolveCallbackHandle: vi.fn(async ({ actorId, channel, handle, now = Date.now() }) => {
      const record = [...records.values()]
        .filter(
          (candidate) =>
            candidate.handle === handle
            && candidate.expiresAt > now
            && candidate.allowedActorIds.includes(actorId)
            && candidate.channel.channel === channel.channel
            && candidate.channel.conversation.id === channel.conversation.id,
        )
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (!record || record.expiresAt <= now) {
        return undefined;
      }
      return record;
    }),
    upsertCallbackHandle: vi.fn(async (record: MessagingCallbackHandleRecord) => {
      records.set(record.id, record);
      return record;
    }),
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
