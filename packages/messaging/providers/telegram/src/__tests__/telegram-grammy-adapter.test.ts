import { describe, expect, it, vi } from "vitest";
import {
  adaptGrammyBot,
  type TelegramEditMessageTextRequest,
  type TelegramGrammyBotLike,
  type TelegramPinChatMessageRequest,
  type TelegramSendChatActionRequest,
  type TelegramSendMessageRequest,
  type TelegramSendPhotoRequest,
  type TelegramUnpinChatMessageRequest,
} from "../telegram-adapter.ts";

describe("adaptGrammyBot", () => {
  it("maps object-shaped adapter calls to grammY positional API calls", async () => {
    const grammyBot = createGrammyBot();
    const bot = adaptGrammyBot(grammyBot);

    await bot.api.setMyCommands({
      commands: [
        {
          command: "resume",
          description: "Resume or start a PwrAgnt thread",
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
        description: "Resume or start a PwrAgnt thread",
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

function createGrammyBot(): TelegramGrammyBotLike & {
  api: {
    answerCallbackQuery: ReturnType<typeof vi.fn>;
    deleteWebhook: ReturnType<typeof vi.fn>;
    editForumTopic: ReturnType<typeof vi.fn>;
    editMessageText: ReturnType<typeof vi.fn>;
    getWebhookInfo: ReturnType<typeof vi.fn>;
    pinChatMessage: ReturnType<typeof vi.fn>;
    sendChatAction: ReturnType<typeof vi.fn>;
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
          _other?: Omit<TelegramSendPhotoRequest, "chat_id" | "photo">,
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
