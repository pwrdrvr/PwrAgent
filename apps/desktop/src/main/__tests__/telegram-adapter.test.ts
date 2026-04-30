import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagingController, MessagingStore } from "@pwragnt/agent-core";
import type {
  MessagingInboundEvent,
  MessagingSurfaceIntent,
  NavigationSnapshot,
  StartTurnRequest,
} from "@pwragnt/shared";
import { TelegramAdapter } from "../messaging/telegram-adapter";
import type {
  TelegramApi,
  TelegramEditMessageTextRequest,
  TelegramPinChatMessageRequest,
  TelegramSendMessageRequest,
  TelegramSendPhotoRequest,
  TelegramUnpinChatMessageRequest,
} from "../messaging/telegram-api";
import { TELEGRAM_CALLBACK_DATA_LIMIT_BYTES } from "../messaging/telegram-formatting";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (tempDir) => {
      await rm(tempDir, { recursive: true, force: true });
    }),
  );
});

describe("TelegramAdapter", () => {
  it("normalizes /threads and renders a thread picker with inline keyboard handles", async () => {
    const harness = await createControllerHarness();

    await harness.adapter.start((event) => harness.controller.handleInboundEvent(event));
    await harness.adapter.handleUpdate({
      update_id: 1,
      message: {
        chat: {
          id: 777,
          type: "private",
        },
        date: 1,
        from: {
          first_name: "Ada",
          id: 42,
          is_bot: false,
          username: "mutable_username",
        },
        message_id: 100,
        text: "/threads",
      },
    });

    expect(harness.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: 777,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              expect.objectContaining({
                text: "1. Thread one",
              }),
            ],
            [
              expect.objectContaining({
                text: "2. Thread two",
              }),
            ],
            [
              expect.objectContaining({
                text: "Projects",
              }),
            ],
            [
              expect.objectContaining({
                text: "New",
              }),
            ],
            [
              expect.objectContaining({
                text: "Cancel",
              }),
            ],
          ],
        },
      }),
    );
    const request = harness.api.sendMessage.mock.calls.at(-1)?.[0];
    const callbackData = request?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data;
    const secondCallbackData =
      request?.reply_markup?.inline_keyboard[1]?.[0]?.callback_data;
    expect(callbackData).toMatch(/^tg:/);
    expect(Buffer.byteLength(callbackData ?? "", "utf8")).toBeLessThanOrEqual(
      TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
    );
    expect(callbackData).not.toContain("thread-1");
    expect(secondCallbackData).toMatch(/^tg:/);
    expect(secondCallbackData).not.toBe(callbackData);
  });

  it("clears an existing webhook before starting local long polling", async () => {
    const api = createApi();
    api.getWebhookInfo.mockResolvedValueOnce({
      url: "https://example.com/telegram-webhook",
    });
    const adapter = new TelegramAdapter({
      api: api as unknown as TelegramApi,
      config: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: ["42"],
      },
      pollOnStart: false,
    });

    await adapter.start(async () => {});

    expect(api.deleteWebhook).toHaveBeenCalledWith({
      drop_pending_updates: false,
    });
  });

  it("registers PwrAgnt bot commands on startup", async () => {
    const api = createApi();
    const adapter = new TelegramAdapter({
      api: api as unknown as TelegramApi,
      config: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: ["42"],
      },
      pollOnStart: false,
    });

    await adapter.start(async () => {});

    expect(api.setMyCommands).toHaveBeenCalledWith({
      commands: [
        {
          command: "resume",
          description: "Resume or start a PwrAgnt thread",
        },
        {
          command: "threads",
          description: "Choose a PwrAgnt thread",
        },
        {
          command: "status",
          description: "Show the current PwrAgnt binding",
        },
        {
          command: "detach",
          description: "Detach this chat from PwrAgnt",
        },
        {
          command: "bind",
          description: "Bind this chat to a PwrAgnt thread",
        },
      ],
    });
  });

  it("edits target Telegram messages for managed surface updates", async () => {
    const api = createApi();
    const adapter = new TelegramAdapter({
      api: api as unknown as TelegramApi,
      config: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: ["42"],
      },
      now: () => 1000,
      pollOnStart: false,
    });

    const result = await adapter.deliver({
      audit: {
        actor: {
          platformUserId: "42",
        },
        channel: {
          channel: "telegram",
          conversation: {
            id: "777",
            kind: "dm",
          },
        },
        occurredAt: 1000,
      },
      createdAt: 1000,
      delivery: {
        mode: "update",
        fallback: "present_new",
      },
      id: "intent-update",
      kind: "confirmation",
      targetSurface: {
        channel: "telegram",
        id: "200",
        state: {
          opaque: {
            chatId: 777,
            messageId: 200,
          },
        },
      },
      title: "Updated",
      body: "This was edited.",
      actions: [],
    });

    expect(api.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: 777,
        message_id: 200,
        text: expect.stringContaining("Updated"),
      }),
    );
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "updated",
      surface: {
        id: "200",
      },
    });
  });

  it("falls back to a new message when Telegram edit fails", async () => {
    const api = createApi();
    api.editMessageText.mockRejectedValueOnce(
      new Error("message is not editable anymore"),
    );
    const adapter = new TelegramAdapter({
      api: api as unknown as TelegramApi,
      config: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: ["42"],
      },
      now: () => 1000,
      pollOnStart: false,
    });

    const result = await adapter.deliver({
      audit: {
        actor: {
          platformUserId: "42",
        },
        channel: {
          channel: "telegram",
          conversation: {
            id: "777",
            kind: "dm",
          },
        },
        occurredAt: 1000,
      },
      createdAt: 1000,
      delivery: {
        mode: "update",
        fallback: "present_new",
      },
      id: "intent-update",
      kind: "confirmation",
      targetSurface: {
        channel: "telegram",
        id: "200",
        state: {
          opaque: {
            chatId: 777,
            messageId: 200,
          },
        },
      },
      title: "Updated",
      body: "This was reposted.",
      actions: [],
    });

    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: 777,
        text: expect.stringContaining("Updated"),
      }),
    );
    expect(result).toMatchObject({
      outcome: "presented_new",
      surface: {
        id: "200",
      },
    });
  });

  it("pins and unpins Telegram status surfaces when requested", async () => {
    const api = createApi();
    const adapter = new TelegramAdapter({
      api: api as unknown as TelegramApi,
      config: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: ["42"],
      },
      now: () => 1000,
      pollOnStart: false,
    });

    const pinResult = await adapter.deliver({
      audit: {
        actor: {
          platformUserId: "42",
        },
        channel: {
          channel: "telegram",
          conversation: {
            id: "777",
            kind: "dm",
          },
        },
        occurredAt: 1000,
      },
      createdAt: 1000,
      delivery: {
        pin: true,
      },
      id: "intent-status",
      kind: "status",
      status: "idle",
      text: "Binding: active",
    });

    expect(api.pinChatMessage).toHaveBeenCalledWith({
      chat_id: 777,
      disable_notification: true,
      message_id: 200,
    });
    expect(pinResult.outcome).toBe("pinned");

    const unpinResult = await adapter.deliver({
      createdAt: 1000,
      delivery: {
        unpin: true,
      },
      id: "intent-dismiss",
      kind: "dismiss",
      reason: "detached",
      targetSurface: {
        channel: "telegram",
        id: "200",
        state: {
          opaque: {
            chatId: 777,
            messageId: 200,
          },
        },
      },
    });

    expect(api.unpinChatMessage).toHaveBeenCalledWith({
      chat_id: 777,
      message_id: 200,
    });
    expect(unpinResult.outcome).toBe("unpinned");
  });

  it("resolves callback handles and acknowledges callback queries", async () => {
    const harness = await createControllerHarness();

    await harness.adapter.start((event) => harness.controller.handleInboundEvent(event));
    await harness.adapter.handleUpdate({
      update_id: 1,
      message: {
        chat: {
          id: 777,
          type: "private",
        },
        from: {
          id: 42,
          is_bot: false,
        },
        message_id: 100,
        text: "/threads",
      },
    });
    const callbackData =
      harness.api.sendMessage.mock.calls.at(-1)?.[0].reply_markup?.inline_keyboard[0]?.[0]
        ?.callback_data ?? "";

    await harness.adapter.handleUpdate({
      callback_query: {
        data: callbackData,
        from: {
          id: 42,
          is_bot: false,
        },
        id: "callback-1",
        message: {
          chat: {
            id: 777,
            type: "private",
          },
          message_id: 101,
        },
      },
      update_id: 2,
    });

    expect(harness.api.answerCallbackQuery).toHaveBeenCalledWith({
      callback_query_id: "callback-1",
    });
    await expect(
      harness.store.findActiveBindingForChannel({
        channel: "telegram",
        conversation: {
          id: "777",
          kind: "dm",
        },
      }),
    ).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
    });
  });

  it("resolves persisted callback handles after adapter restart", async () => {
    const harness = await createControllerHarness();

    await harness.adapter.start((event) => harness.controller.handleInboundEvent(event));
    await harness.adapter.handleUpdate({
      update_id: 1,
      message: {
        chat: {
          id: 777,
          type: "private",
        },
        from: {
          id: 42,
          is_bot: false,
        },
        message_id: 100,
        text: "/threads",
      },
    });
    const callbackData =
      harness.api.sendMessage.mock.calls.at(-1)?.[0].reply_markup?.inline_keyboard[0]?.[0]
        ?.callback_data ?? "";
    const restartedAdapter = new TelegramAdapter({
      api: harness.api as unknown as TelegramApi,
      config: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: ["42"],
      },
      now: () => 1000,
      pollOnStart: false,
      store: harness.store,
    });
    await restartedAdapter.start((event) => harness.controller.handleInboundEvent(event));

    await restartedAdapter.handleUpdate({
      callback_query: {
        data: callbackData,
        from: {
          id: 42,
          is_bot: false,
        },
        id: "callback-1",
        message: {
          chat: {
            id: 777,
            type: "private",
          },
          message_id: 101,
        },
      },
      update_id: 2,
    });

    await expect(
      harness.store.findActiveBindingForChannel({
        channel: "telegram",
        conversation: {
          id: "777",
          kind: "dm",
        },
      }),
    ).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
    });
  });

  it("routes free-form text from a persisted binding by stable Telegram user id", async () => {
    const harness = await createControllerHarness();

    await harness.store.upsertBinding({
      id: "binding:telegram:dm:777:codex:thread-1",
      authorizedActorIds: ["42"],
      backend: "codex",
      channel: {
        channel: "telegram",
        conversation: {
          id: "777",
          kind: "dm",
        },
      },
      createdAt: 1000,
      threadId: "thread-1",
      updatedAt: 1000,
    });
    await harness.adapter.start((event) => harness.controller.handleInboundEvent(event));
    await harness.adapter.handleUpdate({
      update_id: 3,
      message: {
        chat: {
          id: 777,
          type: "private",
        },
        from: {
          id: 42,
          is_bot: false,
          username: "new_username",
        },
        message_id: 102,
        text: "run the focused tests",
      },
    });

    expect(harness.startTurn).toHaveBeenCalledWith({
      backend: "codex",
      input: [
        {
          text: "run the focused tests",
          type: "text",
        },
      ],
      threadId: "thread-1",
    });
  });

  it("rejects matching usernames with different Telegram numeric ids through the controller", async () => {
    const harness = await createControllerHarness();

    await harness.adapter.start((event) => harness.controller.handleInboundEvent(event));
    await harness.adapter.handleUpdate({
      update_id: 4,
      message: {
        chat: {
          id: 777,
          type: "private",
        },
        from: {
          id: 99,
          is_bot: false,
          username: "mutable_username",
        },
        message_id: 103,
        text: "/threads",
      },
    });

    expect(harness.getNavigationSnapshot).not.toHaveBeenCalled();
    expect(harness.api.sendMessage.mock.calls.at(-1)?.[0].text).toContain(
      "Not authorized",
    );
  });

  it("normalizes inbound media as unsupported without downloading it", async () => {
    const events: MessagingInboundEvent[] = [];
    const api = createApi();
    const adapter = new TelegramAdapter({
      api: api as unknown as TelegramApi,
      config: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: ["42"],
      },
      pollOnStart: false,
    });

    await adapter.start(async (event) => {
      events.push(event);
    });
    await adapter.handleUpdate({
      update_id: 5,
      message: {
        chat: {
          id: 777,
          type: "private",
        },
        document: {
          file_id: "file-1",
          file_name: "secret.txt",
          mime_type: "text/plain",
        },
        from: {
          id: 42,
          is_bot: false,
        },
        message_id: 104,
      },
    });

    expect(events.at(-1)).toMatchObject({
      disposition: "unsupported",
      kind: "media",
      media: {
        name: "secret.txt",
      },
    });
    expect("getFile" in api).toBe(false);
  });

  it("sends image message intents through sendPhoto", async () => {
    const api = createApi();
    const adapter = new TelegramAdapter({
      api: api as unknown as TelegramApi,
      config: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: ["42"],
      },
      now: () => 1000,
      pollOnStart: false,
    });

    await adapter.deliver({
      audit: {
        actor: {
          platformUserId: "42",
        },
        channel: {
          channel: "telegram",
          conversation: {
            id: "777",
            kind: "dm",
          },
        },
        occurredAt: 1000,
      },
      createdAt: 1000,
      id: "intent-image",
      kind: "message",
      parts: [
        {
          type: "image",
          url: "https://example.com/image.png",
        },
        {
          markdown: "plain",
          text: "Rendered image",
          type: "text",
        },
      ],
    });

    expect(api.sendPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: "Rendered image",
        chat_id: 777,
        photo: "https://example.com/image.png",
      }),
    );
  });
});

async function createControllerHarness(): Promise<{
  adapter: TelegramAdapter;
  api: ReturnType<typeof createApi>;
  controller: MessagingController;
  getNavigationSnapshot: ReturnType<typeof vi.fn>;
  startTurn: ReturnType<typeof vi.fn>;
  store: MessagingStore;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-telegram-"));
  tempDirs.push(tempDir);
  const store = new MessagingStore(path.join(tempDir, "messaging-state.json"));
  const api = createApi();
  const getNavigationSnapshot = vi.fn(async () => buildNavigationSnapshot());
  const startTurn = vi.fn(async (request: StartTurnRequest) => ({
    backend: request.backend,
    threadId: request.threadId,
    turnId: "turn-1",
  }));
  const adapter = new TelegramAdapter({
    api: api as unknown as TelegramApi,
    config: {
      channel: "telegram",
      botToken: "telegram-token",
      authorizedActorIds: ["42"],
    },
    now: () => 1000,
    pollOnStart: false,
    store,
  });
  const controller = new MessagingController({
    adapter,
    authorizedActorIds: ["42"],
    backend: {
      getNavigationSnapshot,
      startTurn,
    },
    now: () => 1000,
    store,
  });

  return {
    adapter,
    api,
    controller,
    getNavigationSnapshot,
    startTurn,
    store,
  };
}

function createApi(): {
  answerCallbackQuery: ReturnType<typeof vi.fn>;
  deleteWebhook: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  getUpdates: ReturnType<typeof vi.fn>;
  getWebhookInfo: ReturnType<typeof vi.fn>;
  pinChatMessage: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  sendPhoto: ReturnType<typeof vi.fn>;
  setMyCommands: ReturnType<typeof vi.fn>;
  unpinChatMessage: ReturnType<typeof vi.fn>;
} {
  return {
    answerCallbackQuery: vi.fn(async () => true),
    deleteWebhook: vi.fn(async () => true),
    editMessageText: vi.fn(async (request: TelegramEditMessageTextRequest) => ({
      chat: {
        id: Number(request.chat_id),
        type: "private",
      },
      message_id: request.message_id,
    })),
    getUpdates: vi.fn(async () => []),
    getWebhookInfo: vi.fn(async () => ({ url: "" })),
    pinChatMessage: vi.fn(async (_request: TelegramPinChatMessageRequest) => true),
    sendMessage: vi.fn(async (request: TelegramSendMessageRequest) => ({
      chat: {
        id: Number(request.chat_id),
        type: "private",
      },
      message_id: 200,
    })),
    sendPhoto: vi.fn(async (request: TelegramSendPhotoRequest) => ({
      chat: {
        id: Number(request.chat_id),
        type: "private",
      },
      message_id: 201,
    })),
    setMyCommands: vi.fn(async () => true),
    unpinChatMessage: vi.fn(async (_request: TelegramUnpinChatMessageRequest) => true),
  };
}

function buildNavigationSnapshot(): NavigationSnapshot {
  return {
    backend: "all",
    directories: [],
    fetchedAt: 1000,
    inboxThreadKeys: [],
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
    },
    threads: [
      {
        id: "thread-1",
        inbox: {
          inInbox: false,
        },
        linkedDirectories: [],
        source: "codex",
        title: "Thread one",
        titleSource: "explicit",
      },
      {
        id: "thread-2",
        inbox: {
          inInbox: false,
        },
        linkedDirectories: [],
        source: "codex",
        title: "Thread two",
        titleSource: "explicit",
      },
    ],
    unchanged: false,
  };
}
