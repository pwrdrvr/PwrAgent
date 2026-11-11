import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import { TelegramAdapter } from "@pwragent/messaging-provider-telegram";
import type {
  TelegramBotApi,
  TelegramEditMessageTextRequest,
  TelegramSendMessageRequest,
} from "@pwragent/messaging-provider-telegram";

// Rules for the Telegram adapter's own non-final stream throttle:
// - After Telegram answers 429 with `retry_after`, the adapter makes no send
//   or edit to that chat until Retry-After (plus its 100 ms buffer) passes,
//   whatever deliveries, reads and other chats' traffic run in between.
// - Non-final edits to one chat are at least 1 s apart.
// - A group chat makes at most 20 stream calls in any 60 s window.
// - Reads are pure: `resolveDeliveryScope`, which the controller calls before
//   every delivery, never changes when the adapter calls Telegram.

const RETRY_AFTER_BUFFER_MS = 100;
const MIN_INTERVAL_MS = 1_000;
const GROUP_WINDOW_MS = 60_000;
const GROUP_MAX_PER_WINDOW = 20;

type Chat = { chatId: number; conversation: { id: string; kind: "dm" | "topic"; parentId?: string } };

const CHATS: Chat[] = [
  { chatId: 777, conversation: { id: "777", kind: "dm" } },
  { chatId: -1003841603622, conversation: { id: "5642", kind: "topic", parentId: "-1003841603622" } },
];

type Op =
  | { kind: "advance"; ms: number }
  | { kind: "deliver"; chat: number }
  | { kind: "read"; chat: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.integer({ min: 0, max: 4_000 }).map((ms) => ({ kind: "advance" as const, ms })),
  fc.integer({ min: 0, max: 300 }).map((ms) => ({ kind: "advance" as const, ms })),
  fc.integer({ min: 900, max: 1_300 }).map((ms) => ({ kind: "advance" as const, ms })),
  fc.integer({ min: 0, max: CHATS.length - 1 }).map((chat) => ({ kind: "deliver" as const, chat })),
  fc.integer({ min: 0, max: CHATS.length - 1 }).map((chat) => ({ kind: "deliver" as const, chat })),
  fc.integer({ min: 0, max: CHATS.length - 1 }).map((chat) => ({ kind: "read" as const, chat })),
);

// Each Telegram call takes the next answer: 0 succeeds, n > 0 is a 429 with
// `retry_after: n` seconds. The plan cycles so long runs keep failing.
const answersArb = fc.array(
  fc.oneof({ weight: 4, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: 5 }) }),
  { minLength: 1, maxLength: 30 },
);

type Call = { chatId: number; at: number; retryAfterSeconds: number };

function streamIntent(chat: Chat, sequence: number): MessagingSurfaceIntent {
  return {
    audit: {
      actor: { platformUserId: "42" },
      channel: { channel: "telegram", conversation: chat.conversation },
      occurredAt: 1_000,
    },
    bindingId: `binding-${chat.chatId}`,
    createdAt: 1_000,
    id: `stream-${chat.chatId}-${sequence}`,
    kind: "stream_update",
    markdown: "plain",
    role: "assistant",
    stream: { isFinal: false, key: `stream-key-${chat.chatId}`, sequence },
    text: `Partial answer ${sequence}`,
  } satisfies MessagingSurfaceIntent;
}

async function runOps(ops: Op[], answers: number[], withReads: boolean): Promise<Call[]> {
  let now = 1_000_000;
  const calls: Call[] = [];
  const answer = (chatId: number) => {
    const retryAfterSeconds = answers[calls.length % answers.length] ?? 0;
    calls.push({ chatId, at: now, retryAfterSeconds });
    if (retryAfterSeconds > 0) {
      throw { error: { parameters: { retry_after: retryAfterSeconds } } };
    }
  };
  const api = {
    editMessageText: async (request: TelegramEditMessageTextRequest) => {
      answer(Number(request.chat_id));
      return { chat: { id: Number(request.chat_id), type: "private" }, message_id: request.message_id };
    },
    sendMessage: async (request: TelegramSendMessageRequest) => {
      answer(Number(request.chat_id));
      return { chat: { id: Number(request.chat_id), type: "private" }, message_id: 200 };
    },
    sendChatAction: async () => true,
  };
  const adapter = new TelegramAdapter({
    api: api as unknown as TelegramBotApi,
    config: {
      channel: "telegram",
      botToken: "12345:test-token",
      authorizedActorIds: [{ id: "42", displayName: "" }],
      streamingResponses: true,
    },
    now: () => now,
  });
  const sequences = CHATS.map(() => 0);
  for (const op of ops) {
    if (op.kind === "advance") {
      now += op.ms;
    } else if (op.kind === "read") {
      if (withReads) adapter.resolveDeliveryScope(streamIntent(CHATS[op.chat]!, sequences[op.chat]! + 1));
    } else {
      sequences[op.chat] = sequences[op.chat]! + 1;
      const intent = streamIntent(CHATS[op.chat]!, sequences[op.chat]!);
      if (withReads) adapter.resolveDeliveryScope(intent);
      await adapter.deliver(intent);
    }
  }
  return calls;
}

describe("TelegramAdapter stream throttle model", () => {
  it("never calls a chat before its Retry-After, faster than 1 s, or over the group window", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 120 }), answersArb, async (ops, answers) => {
        const calls = await runOps(ops, answers, true);
        for (const chat of CHATS) {
          const chatCalls = calls.filter((call) => call.chatId === chat.chatId);
          let blockedUntil = 0;
          chatCalls.forEach((call, index) => {
            expect(call.at).toBeGreaterThanOrEqual(blockedUntil);
            const previous = chatCalls[index - 1];
            if (previous) {
              expect(call.at - previous.at).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
            }
            if (chat.chatId < 0) {
              const inWindow = chatCalls.filter(
                (other) => other.at <= call.at && other.at > call.at - GROUP_WINDOW_MS,
              ).length;
              expect(inWindow).toBeLessThanOrEqual(GROUP_MAX_PER_WINDOW);
            }
            if (call.retryAfterSeconds > 0) {
              blockedUntil = Math.max(
                blockedUntil,
                call.at + call.retryAfterSeconds * 1_000 + RETRY_AFTER_BUFFER_MS,
              );
            }
          });
        }
      }),
      { numRuns: 60 },
    );
  });

  it("sends nothing to a chat until a 429's Retry-After has passed", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: CHATS.length - 1 }),
        fc.integer({ min: 1, max: 5 }),
        fc.array(fc.integer({ min: 0, max: 1_500 }), { minLength: 1, maxLength: 12 }),
        async (chat, retryAfterSeconds, gaps) => {
          const ops: Op[] = [{ kind: "deliver", chat }];
          for (const ms of gaps) {
            ops.push({ kind: "advance", ms }, { kind: "deliver", chat });
          }
          const calls = await runOps(ops, [retryAfterSeconds, 0], true);
          const [limited, ...later] = calls;
          for (const call of later) {
            expect(call.at).toBeGreaterThanOrEqual(
              limited!.at + retryAfterSeconds * 1_000 + RETRY_AFTER_BUFFER_MS,
            );
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("holds a group to 20 stream calls per minute under a steady stream of edits", async () => {
    // Random gaps rarely keep a group at its spacing floor for a whole
    // minute, so poll a long group stream every 50-250 ms.
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 50, max: 250 }), { minLength: 400, maxLength: 600 }),
        async (gaps) => {
          const ops: Op[] = gaps.flatMap((ms) => [
            { kind: "deliver" as const, chat: 1 },
            { kind: "advance" as const, ms },
          ]);
          const calls = await runOps(ops, [0], false);
          for (const call of calls) {
            const inWindow = calls.filter(
              (other) => other.at <= call.at && other.at > call.at - GROUP_WINDOW_MS,
            ).length;
            expect(inWindow).toBeLessThanOrEqual(GROUP_MAX_PER_WINDOW);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("calls Telegram at the same moments whether or not scope reads run in between", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 120 }), answersArb, async (ops, answers) => {
        expect(await runOps(ops, answers, true)).toEqual(await runOps(ops, answers, false));
      }),
      { numRuns: 60 },
    );
  });
});
