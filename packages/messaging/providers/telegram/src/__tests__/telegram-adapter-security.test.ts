import { describe, expect, it, vi } from "vitest";
import { TelegramAdapter, type TelegramBotLike } from "../telegram-adapter.ts";
import type { MessagingRejectedInboundEvent } from "@pwragent/messaging-interface";

describe("TelegramAdapter inbound security boundary", () => {
  it("dispatches pairing tokens from unauthorized actors before allowlist checks", async () => {
    const listener = vi.fn();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const adapter = new TelegramAdapter({
      bot: fakeBot(),
      config: {
        authorizedActorIds: [{ id: "42", displayName: "" }],
        authorizedSupergroupIds: [{ id: "-1001234567890", displayName: "" }],
        botToken: "token",
        channel: "telegram",
      },
      logger,
      pollOnStart: false,
    });
    const rejectedEvents: MessagingRejectedInboundEvent[] = [];
    adapter.onInboundRejected((event) => {
      rejectedEvents.push(event);
    });
    await adapter.start(listener);

    await adapter.handleUpdate({
      update_id: 99,
      message: {
        chat: {
          id: -1009999999999,
          title: "Untrusted",
          type: "supergroup",
        },
        from: {
          id: 99,
          first_name: "Mallory",
        },
        message_id: 199,
        text: "pair 123456789ABCDEFGHJKLMNPQRSTUVWXY",
      },
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ platformUserId: "99" }),
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "-1009999999999",
            kind: "channel",
          }),
        }),
        kind: "text",
        text: "pair 123456789ABCDEFGHJKLMNPQRSTUVWXY",
      }),
    );
    expect(rejectedEvents).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalledWith(
      "telegram inbound ignored unauthorized actor",
      expect.anything(),
    );
  });

  it("dispatches slash pairing commands from unauthorized actors before allowlist checks", async () => {
    const listener = vi.fn();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const adapter = new TelegramAdapter({
      bot: fakeBot(),
      config: {
        authorizedActorIds: [{ id: "42", displayName: "" }],
        authorizedSupergroupIds: [{ id: "-1001234567890", displayName: "" }],
        botToken: "token",
        channel: "telegram",
      },
      logger,
      pollOnStart: false,
    });
    const rejectedEvents: MessagingRejectedInboundEvent[] = [];
    adapter.onInboundRejected((event) => {
      rejectedEvents.push(event);
    });
    await adapter.start(listener);

    await adapter.handleUpdate({
      update_id: 100,
      message: {
        chat: {
          id: -1009999999999,
          title: "Untrusted",
          type: "supergroup",
        },
        from: {
          id: 99,
          first_name: "Mallory",
        },
        message_id: 200,
        text: "/pair 123456789ABCDEFGHJKLMNPQRSTUVWXY",
      },
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ platformUserId: "99" }),
        args: ["123456789ABCDEFGHJKLMNPQRSTUVWXY"],
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "-1009999999999",
            kind: "channel",
          }),
        }),
        command: "pair",
        kind: "command",
        rawText: "/pair 123456789ABCDEFGHJKLMNPQRSTUVWXY",
      }),
    );
    expect(rejectedEvents).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalledWith(
      "telegram inbound ignored unauthorized actor",
      expect.anything(),
    );
  });

  it("dispatches mention pairing commands from unauthorized actors before allowlist checks", async () => {
    const listener = vi.fn();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const adapter = new TelegramAdapter({
      bot: fakeBot(),
      config: {
        authorizedActorIds: [{ id: "42", displayName: "" }],
        authorizedSupergroupIds: [{ id: "-1001234567890", displayName: "" }],
        botToken: "token",
        channel: "telegram",
      },
      logger,
      pollOnStart: false,
    });
    const rejectedEvents: MessagingRejectedInboundEvent[] = [];
    adapter.onInboundRejected((event) => {
      rejectedEvents.push(event);
    });
    await adapter.start(listener);

    await adapter.handleUpdate({
      update_id: 101,
      message: {
        chat: {
          id: -1009999999999,
          title: "Untrusted",
          type: "supergroup",
        },
        from: {
          id: 99,
          first_name: "Mallory",
        },
        message_id: 201,
        text: "@PwrAgentBot pair 123456789ABCDEFGHJKLMNPQRSTUVWXY",
      },
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ platformUserId: "99" }),
        args: ["123456789ABCDEFGHJKLMNPQRSTUVWXY"],
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "-1009999999999",
            kind: "channel",
          }),
        }),
        command: "pair",
        kind: "command",
        rawText: "/pair 123456789ABCDEFGHJKLMNPQRSTUVWXY",
      }),
    );
    expect(rejectedEvents).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalledWith(
      "telegram inbound ignored unauthorized actor",
      expect.anything(),
    );
  });

  it("drops authorized actors in unauthorized supergroups before listener dispatch", async () => {
    const listener = vi.fn();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const adapter = new TelegramAdapter({
      bot: fakeBot(),
      config: {
        authorizedActorIds: [{ id: "42", displayName: "" }],
        authorizedSupergroupIds: [{ id: "-1001234567890", displayName: "" }],
        botToken: "token",
        channel: "telegram",
      },
      logger,
      pollOnStart: false,
    });
    const rejectedEvents: MessagingRejectedInboundEvent[] = [];
    adapter.onInboundRejected((event) => {
      rejectedEvents.push(event);
    });
    await adapter.start(listener);

    await adapter.handleUpdate({
      update_id: 100,
      message: {
        chat: {
          id: -1009999999999,
          title: "Untrusted",
          type: "supergroup",
        },
        from: {
          id: 42,
          first_name: "Harold",
        },
        message_id: 200,
        text: "/status",
      },
    });

    expect(listener).not.toHaveBeenCalled();
    expect(rejectedEvents).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({ platformUserId: "42" }),
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "-1009999999999",
            kind: "channel",
          }),
        }),
        kind: "command",
        reason: "unauthorized-conversation",
      }),
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      "telegram inbound ignored unauthorized conversation",
      expect.objectContaining({
        chatId: "-1009999999999",
      }),
    );
  });

  it("drops malformed callback data before answering the callback", async () => {
    const listener = vi.fn();
    const bot = fakeBot();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const adapter = new TelegramAdapter({
      bot,
      config: {
        authorizedActorIds: [{ id: "42", displayName: "" }],
        botToken: "token",
        channel: "telegram",
      },
      logger,
      pollOnStart: false,
    });
    await adapter.start(listener);

    await adapter.handleUpdate({
      update_id: 101,
      callback_query: {
        id: "callback-1",
        data: "bad\r\nhandle",
        from: {
          id: 42,
          first_name: "Harold",
        },
        message: {
          chat: {
            id: 42,
            type: "private",
          },
          from: {
            id: 42,
            first_name: "Harold",
          },
          message_id: 201,
          text: "Status",
        },
      },
    });

    expect(bot.api.answerCallbackQuery).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "messaging inbound identifier rejected",
      expect.objectContaining({
        platform: "telegram",
        identifier_field: "callback_query.data",
      }),
    );
  });

  it("answers valid callbacks from unauthorized actors before dropping them", async () => {
    const listener = vi.fn();
    const bot = fakeBot();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const adapter = new TelegramAdapter({
      bot,
      config: {
        authorizedActorIds: [{ id: "42", displayName: "" }],
        botToken: "token",
        channel: "telegram",
      },
      logger,
      pollOnStart: false,
    });
    const rejectedEvents: MessagingRejectedInboundEvent[] = [];
    adapter.onInboundRejected((event) => {
      rejectedEvents.push(event);
    });
    await adapter.start(listener);

    await adapter.handleUpdate({
      update_id: 102,
      callback_query: {
        id: "callback-1",
        data: "tg:abcdefghijklmnopqr",
        from: {
          id: 99,
          first_name: "Mallory",
        },
        message: {
          chat: {
            id: 99,
            type: "private",
          },
          from: {
            id: 42,
            first_name: "Harold",
          },
          message_id: 202,
          text: "Status",
        },
      },
    });

    expect(bot.api.answerCallbackQuery).toHaveBeenCalledWith({
      callback_query_id: "callback-1",
    });
    expect(listener).not.toHaveBeenCalled();
    expect(rejectedEvents).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({ platformUserId: "99" }),
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "99",
            kind: "dm",
          }),
        }),
        kind: "callback",
        reason: "unauthorized-actor",
      }),
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      "telegram callback ignored unauthorized actor",
      expect.objectContaining({
        actorId: "99",
        chatId: "99",
      }),
    );
  });
});

function fakeBot(): TelegramBotLike & {
  api: TelegramBotLike["api"] & { answerCallbackQuery: ReturnType<typeof vi.fn> };
} {
  const sentMessage = { chat: { id: 42, type: "private" as const }, message_id: 1 };
  return {
    api: {
      answerCallbackQuery: vi.fn(async () => true),
      closeForumTopic: vi.fn(async () => true),
      createForumTopic: vi.fn(async () => ({
        message_thread_id: 44,
        name: "Topic",
      })),
      deleteWebhook: vi.fn(async () => true),
      deleteForumTopic: vi.fn(async () => true),
      editForumTopic: vi.fn(async () => true),
      editMessageText: vi.fn(async () => sentMessage),
      getFile: vi.fn(async () => ({})),
      getChatMember: vi.fn(async () => ({
        can_delete_messages: true,
        can_manage_topics: true,
        status: "administrator" as const,
      })),
      getMe: vi.fn(async () => ({ id: 999, is_bot: true, username: "PwrAgentBot" })),
      getWebhookInfo: vi.fn(async () => ({ url: "" })),
      pinChatMessage: vi.fn(async () => true),
      sendChatAction: vi.fn(async () => true),
      sendDocument: vi.fn(async () => sentMessage),
      sendMessage: vi.fn(async () => sentMessage),
      sendPhoto: vi.fn(async () => sentMessage),
      reopenForumTopic: vi.fn(async () => true),
      setMyCommands: vi.fn(async () => true),
      unpinChatMessage: vi.fn(async () => true),
    },
  };
}
