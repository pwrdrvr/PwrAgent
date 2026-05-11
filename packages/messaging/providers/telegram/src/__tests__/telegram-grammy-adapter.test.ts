import { describe, expect, it, vi } from "vitest";
import {
  adaptGrammyBot,
  TelegramAdapter,
  type TelegramEditMessageTextRequest,
  type TelegramGrammyBotLike,
  type TelegramBotApi,
  type TelegramPinChatMessageRequest,
  type TelegramSendChatActionRequest,
  type TelegramSendDocumentRequest,
  type TelegramSendMessageRequest,
  type TelegramSendPhotoRequest,
  type TelegramUnpinChatMessageRequest,
} from "../telegram-adapter.ts";
import {
  MESSAGING_CALLBACK_HANDLE_TTL_MS,
  type MessagingApprovalIntent,
  type MessagingCallbackHandleRecord,
  type MessagingCallbackHandleStore,
  type MessagingInboundEvent,
  type MessagingStatusIntent,
} from "@pwragent/messaging-interface";

describe("adaptGrammyBot", () => {
  it("maps object-shaped adapter calls to grammY positional API calls", async () => {
    const grammyBot = createGrammyBot();
    const bot = adaptGrammyBot(grammyBot);

    await bot.api.setMyCommands({
      commands: [
        {
          command: "resume",
          description: "Resume or start a PwrAgent thread",
        },
      ],
    });
    await bot.api.sendMessage({
      chat_id: 42,
      disable_web_page_preview: true,
      parse_mode: "HTML",
      text: "Choose a thread",
    });
    await bot.api.editMessageText({
      chat_id: 42,
      message_id: 7,
      parse_mode: "HTML",
      text: "Binding active",
    });
    await bot.api.editForumTopic({
      chat_id: 42,
      message_thread_id: 9,
      name: "Thread one",
    });
    await bot.api.sendPhoto({
      caption: "image",
      chat_id: 42,
      photo: "https://example.com/image.png",
    });
    await bot.api.sendDocument({
      caption: "file",
      chat_id: 42,
      document: new Uint8Array([1, 2, 3]),
      filename: "streaming-logs.txt",
    });
    await bot.api.answerCallbackQuery({
      callback_query_id: "callback-1",
      text: "Done",
    });
    await bot.api.pinChatMessage({
      chat_id: 42,
      disable_notification: true,
      message_id: 7,
    });
    await bot.api.sendChatAction({
      action: "typing",
      chat_id: 42,
      message_thread_id: 9,
    });
    await bot.api.unpinChatMessage({
      chat_id: 42,
      message_id: 7,
    });

    expect(grammyBot.api.setMyCommands).toHaveBeenCalledWith([
      {
        command: "resume",
        description: "Resume or start a PwrAgent thread",
      },
    ]);
    expect(grammyBot.api.sendMessage).toHaveBeenCalledWith(
      42,
      "Choose a thread",
      {
        disable_web_page_preview: true,
        parse_mode: "HTML",
      },
    );
    expect(grammyBot.api.editMessageText).toHaveBeenCalledWith(
      42,
      7,
      "Binding active",
      {
        parse_mode: "HTML",
      },
    );
    expect(grammyBot.api.editForumTopic).toHaveBeenCalledWith(
      42,
      9,
      {
        name: "Thread one",
      },
    );
    expect(grammyBot.api.sendPhoto).toHaveBeenCalledWith(
      42,
      "https://example.com/image.png",
      {
        caption: "image",
      },
    );
    expect(grammyBot.api.sendDocument).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        filename: "streaming-logs.txt",
      }),
      {
        caption: "file",
      },
    );
    expect(grammyBot.api.answerCallbackQuery).toHaveBeenCalledWith("callback-1", {
      text: "Done",
    });
    expect(grammyBot.api.pinChatMessage).toHaveBeenCalledWith(42, 7, {
      disable_notification: true,
    });
    expect(grammyBot.api.sendChatAction).toHaveBeenCalledWith(42, "typing", {
      message_thread_id: 9,
    });
    expect(grammyBot.api.unpinChatMessage).toHaveBeenCalledWith(42, 7, {});
  });
});

describe("TelegramAdapter callback persistence", () => {
  it("persists routed actor and binding metadata in callback handles", async () => {
    const store = fakeCallbackStore();
    const adapter = new TelegramAdapter({
      api: fakeTelegramApi(),
      config: {
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
        botToken: "token",
        channel: "telegram",
      },
      now: () => 1_700_000_000_000,
      store,
    });

    await adapter.deliver({
      id: "status-1",
      kind: "status",
      createdAt: 1,
      status: "waiting",
      text: "Choose",
      allowedActorIds: ["user-1", "user-2"],
      audit: {
        actor: { platformUserId: "user-1" },
        bindingId: "binding-1",
        channel: {
          channel: "telegram",
          conversation: { id: "chat-1", kind: "dm" },
        },
        occurredAt: 1,
      },
      actions: [{ id: "permissions", label: "Permissions" }],
    });

    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      actionId: "permissions",
      allowedActorIds: ["user-1", "user-2"],
      bindingId: "binding-1",
      channel: {
        conversation: { id: "chat-1" },
      },
      expiresAt: 1_700_000_000_000 + MESSAGING_CALLBACK_HANDLE_TTL_MS,
    });
  });

  it("uses long-lived sqlite callback handles for approval buttons", async () => {
    const store = fakeCallbackStore();
    const adapter = new TelegramAdapter({
      api: fakeTelegramApi(),
      config: {
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
        botToken: "token",
        channel: "telegram",
      },
      now: () => 1_700_000_000_000,
      store,
    });
    const intent = {
      id: "approval-1",
      kind: "approval",
      createdAt: 1,
      title: "Command Approval",
      body: "Approve?",
      audit: {
        actor: { platformUserId: "user-1" },
        bindingId: "binding-1",
        channel: {
          channel: "telegram",
          conversation: { id: "chat-1", kind: "dm" },
        },
        occurredAt: 1,
      },
      decisions: [{ id: "approval:accept", label: "Approve", decision: "accept" }],
    } satisfies MessagingApprovalIntent;

    await adapter.deliver(intent);

    expect(store.records[0]).toMatchObject({
      actionId: "approval:accept",
      expiresAt: 1_700_000_000_000 + MESSAGING_CALLBACK_HANDLE_TTL_MS,
      pendingIntentId: "approval-1",
    });
  });

  it("keeps fan-out callback records scoped per routed binding", async () => {
    const store = fakeCallbackStore();
    const adapter = new TelegramAdapter({
      api: fakeTelegramApi(),
      config: {
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
        botToken: "token",
        channel: "telegram",
      },
      now: () => 1_700_000_000_000,
      store,
    });
    const baseIntent: Omit<MessagingStatusIntent, "audit" | "bindingId"> = {
      id: "fanout-status",
      kind: "status",
      createdAt: 1,
      status: "waiting",
      text: "Queued",
      allowedActorIds: ["user-1"],
      actions: [{ id: "cancel", label: "Cancel" }],
    };

    await adapter.deliver({
      ...baseIntent,
      audit: {
        actor: { platformUserId: "user-1" },
        bindingId: "binding-1",
        channel: {
          channel: "telegram",
          conversation: { id: "chat-1", kind: "dm" },
        },
        occurredAt: 1,
      },
    });
    await adapter.deliver({
      ...baseIntent,
      audit: {
        actor: { platformUserId: "user-1" },
        bindingId: "binding-2",
        channel: {
          channel: "telegram",
          conversation: { id: "chat-2", kind: "dm" },
        },
        occurredAt: 1,
      },
    });

    expect(store.records).toHaveLength(2);
    expect(store.records[0]?.handle).toBe(store.records[1]?.handle);
    expect(store.records[0]?.id).not.toBe(store.records[1]?.id);
    expect(store.records.map((record) => record.bindingId)).toEqual([
      "binding-1",
      "binding-2",
    ]);
  });

  it("validates live callbacks against persisted callback actor scope", async () => {
    const store = fakeCallbackStore();
    let sentRequest: TelegramSendMessageRequest | undefined;
    const api: TelegramBotApi = {
      ...fakeTelegramApi(),
      sendMessage: async (request) => {
        sentRequest = request;
        return {
          chat: {
            id: Number(request.chat_id),
            type: "private",
          },
          message_id: 200,
        };
      },
    };
    const adapter = new TelegramAdapter({
      api,
      config: {
        authorizedActorIds: [
          { id: "42", displayName: "" },
          { id: "99", displayName: "" },
        ],
        botToken: "token",
        channel: "telegram",
      },
      now: () => 1_700_000_000_000,
      store,
    });

    await adapter.deliver({
      id: "status-1",
      kind: "status",
      createdAt: 1,
      status: "waiting",
      text: "Choose",
      allowedActorIds: ["42"],
      audit: {
        actor: { platformUserId: "42" },
        bindingId: "binding-1",
        channel: {
          channel: "telegram",
          conversation: { id: "42", kind: "dm" },
        },
        occurredAt: 1,
      },
      actions: [{ id: "permissions", label: "Permissions" }],
    });

    const callbackData =
      sentRequest?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data;
    expect(callbackData).toMatch(/^tg:/);

    const events: MessagingInboundEvent[] = [];
    await adapter.start(async (event) => {
      events.push(event);
    });

    await adapter.handleUpdate({
      update_id: 99,
      callback_query: {
        id: "callback-1",
        data: callbackData,
        from: {
          id: 99,
          first_name: "Other",
        },
        message: {
          chat: {
            id: 42,
            type: "private",
          },
          message_id: 200,
          text: "Choose",
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        actionId: undefined,
        kind: "callback",
        value: undefined,
      }),
    ]);
  });

  it("rejects supergroup messages after hot-removing the authorized supergroup", async () => {
    const adapter = new TelegramAdapter({
      api: fakeTelegramApi(),
      config: {
        authorizedActorIds: [{ id: "42", displayName: "" }],
        authorizedSupergroupIds: [{ id: "-100123", displayName: "Claw Dev" }],
        botToken: "token",
        channel: "telegram",
      },
      now: () => 1_700_000_000_000,
      store: fakeCallbackStore(),
    });
    const events: MessagingInboundEvent[] = [];
    const rejected: string[] = [];
    adapter.onInboundRejected?.((event) => {
      rejected.push(event.reason);
    });
    await adapter.start(async (event) => {
      events.push(event);
    });

    await adapter.handleUpdate({
      update_id: 100,
      message: {
        chat: {
          id: -100123,
          title: "Claw Dev",
          type: "supergroup",
        },
        date: 1_700_000_000,
        from: {
          first_name: "Harold",
          id: 42,
          username: "huntharo",
        },
        message_id: 500,
        text: "before",
      },
    });
    await adapter.updateAuthorization({
      authorizedActorIds: ["42"],
      authorizedConversationIds: [],
    });
    await adapter.handleUpdate({
      update_id: 101,
      message: {
        chat: {
          id: -100123,
          title: "Claw Dev",
          type: "supergroup",
        },
        date: 1_700_000_001,
        from: {
          first_name: "Harold",
          id: 42,
          username: "huntharo",
        },
        message_id: 501,
        text: "after",
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "text",
      text: "before",
    });
    expect(rejected).toEqual(["unauthorized-conversation"]);
  });
});

function createGrammyBot(): TelegramGrammyBotLike & {
  api: {
    answerCallbackQuery: ReturnType<typeof vi.fn>;
    deleteWebhook: ReturnType<typeof vi.fn>;
    editForumTopic: ReturnType<typeof vi.fn>;
    editMessageText: ReturnType<typeof vi.fn>;
    getFile: ReturnType<typeof vi.fn>;
    getMe: ReturnType<typeof vi.fn>;
    getWebhookInfo: ReturnType<typeof vi.fn>;
    pinChatMessage: ReturnType<typeof vi.fn>;
    sendChatAction: ReturnType<typeof vi.fn>;
    sendDocument: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    sendPhoto: ReturnType<typeof vi.fn>;
    setMyCommands: ReturnType<typeof vi.fn>;
    unpinChatMessage: ReturnType<typeof vi.fn>;
  };
} {
  return {
    api: {
      answerCallbackQuery: vi.fn(async () => true),
      deleteWebhook: vi.fn(async () => true),
      editForumTopic: vi.fn(async () => true),
      editMessageText: vi.fn(
        async (
          chatId: number | string,
          messageId: number,
          _text: string,
          _other?: Omit<
            TelegramEditMessageTextRequest,
            "chat_id" | "message_id" | "text"
          >,
        ) => ({
          chat: {
            id: Number(chatId),
            type: "private" as const,
          },
          message_id: messageId,
        }),
      ),
      getFile: vi.fn(async () => ({ file_path: "documents/file.txt" })),
      getMe: vi.fn(async () => ({ id: 123, is_bot: true, username: "TestBot" })),
      getWebhookInfo: vi.fn(async () => ({ url: "" })),
      pinChatMessage: vi.fn(
        async (
          _chatId: number | string,
          _messageId: number,
          _other?: Omit<TelegramPinChatMessageRequest, "chat_id" | "message_id">,
        ) => true,
      ),
      sendChatAction: vi.fn(
        async (
          _chatId: number | string,
          _action: TelegramSendChatActionRequest["action"],
          _other?: Omit<TelegramSendChatActionRequest, "chat_id" | "action">,
        ) => true,
      ),
      sendDocument: vi.fn(
        async (
          chatId: number | string,
          _document: unknown,
          _other?: Omit<
            TelegramSendDocumentRequest,
            "chat_id" | "document" | "filename"
          >,
        ) => ({
          chat: {
            id: Number(chatId),
            type: "private" as const,
          },
          message_id: 202,
        }),
      ),
      sendMessage: vi.fn(
        async (
          chatId: number | string,
          _text: string,
          _other?: Omit<TelegramSendMessageRequest, "chat_id" | "text">,
        ) => ({
          chat: {
            id: Number(chatId),
            type: "private" as const,
          },
          message_id: 200,
        }),
      ),
      sendPhoto: vi.fn(
        async (
          chatId: number | string,
          _photo: string,
          _other?: Omit<TelegramSendPhotoRequest, "chat_id" | "photo" | "filename">,
        ) => ({
          chat: {
            id: Number(chatId),
            type: "private" as const,
          },
          message_id: 201,
        }),
      ),
      setMyCommands: vi.fn(async () => true),
      unpinChatMessage: vi.fn(
        async (
          _chatId: number | string,
          _messageId?: number,
          _other?: Omit<TelegramUnpinChatMessageRequest, "chat_id" | "message_id">,
        ) => true,
      ),
    },
  };
}

function fakeCallbackStore(): MessagingCallbackHandleStore & {
  records: MessagingCallbackHandleRecord[];
} {
  const records: MessagingCallbackHandleRecord[] = [];
  return {
    records,
    resolveCallbackHandle: async (params) =>
      records.find(
        (record) =>
          record.handle === params.handle
          && record.allowedActorIds.includes(params.actorId)
          && record.channel.conversation.id === params.channel.conversation.id,
      ),
    upsertCallbackHandle: async (record) => {
      records.push(record);
      return record;
    },
  };
}

function fakeTelegramApi(): TelegramBotApi {
  return {
    answerCallbackQuery: async () => true,
    deleteWebhook: async () => true,
    editForumTopic: async () => true,
    editMessageText: async (request) => ({
      chat: {
        id: Number(request.chat_id),
        type: "private",
      },
      message_id: request.message_id,
    }),
    getFile: async () => ({ file_path: "documents/file.txt" }),
    getMe: async () => ({ id: 123, is_bot: true, username: "TestBot" }),
    getWebhookInfo: async () => ({ url: "" }),
    pinChatMessage: async () => true,
    sendChatAction: async () => true,
    sendDocument: async (request) => ({
      chat: {
        id: Number(request.chat_id),
        type: "private",
      },
      message_id: 202,
    }),
    sendMessage: async (request) => ({
      chat: {
        id: Number(request.chat_id),
        type: "private",
      },
      message_id: 200,
    }),
    sendPhoto: async (request) => ({
      chat: {
        id: Number(request.chat_id),
        type: "private",
      },
      message_id: 201,
    }),
    setMyCommands: async () => true,
    unpinChatMessage: async () => true,
  };
}
