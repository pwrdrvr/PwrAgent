import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagingMessageIntent } from "@pwragent/messaging-interface";
import { TelegramAdapter, type TelegramBotApi } from "../telegram-adapter.ts";

const CHAT = -100123;
const WINDOW_MS = 60_000;
const MIN_INTERVAL_MS = 1_100;
const GROUP_LIMIT = 20;
const SAFETY_BUFFER_MS = 2_000;

function message(topic: number, text: string): MessagingMessageIntent {
  return {
    id: `reply-${topic}`, bindingId: `binding-${topic}`,
    kind: "message", createdAt: 1, role: "assistant",
    parts: [{ type: "text", text, markdown: "plain" }],
    audit: {
      actor: { platformUserId: "42" },
      channel: {
        channel: "telegram",
        conversation: { id: String(topic), kind: "topic", parentId: String(CHAT) },
      },
      occurredAt: 1,
    },
  };
}

type Call = { method: string; topic?: number; at: number; text?: string };

function harness(onSend?: (call: Call, index: number) => void, botId = "123") {
  const calls: Call[] = [];
  const request = (method: string, topic?: number, text?: string) => {
    const call = { method, topic, at: Date.now(), text };
    calls.push(call);
    onSend?.(call, calls.length - 1);
    return { chat: { id: CHAT, type: "supergroup" as const }, message_id: calls.length };
  };
  const api = {
    sendMessage: async (value) => request("text", value.message_thread_id, value.text),
    sendPhoto: async (value) => request("photo", value.message_thread_id),
    sendDocument: async (value) => request("document", value.message_thread_id),
  } satisfies Partial<TelegramBotApi>;
  return {
    calls,
    api,
    adapter: new TelegramAdapter({
      api: api as TelegramBotApi,
      config: { botToken: `${botId}:test-token`, channel: "telegram", authorizedActorIds: [], streamingResponses: true },
      waitForReplyDelay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }),
  };
}

describe("Telegram reply request admission", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1000 }));
  afterEach(() => vi.useRealTimers());

  it("paces every request against the parent chat's shared rolling window", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 19, max: 23 }),
      fc.integer({ min: 3, max: 6 }),
      async (preceding, chunks) => {
        vi.setSystemTime(1000);
        const { adapter, calls } = harness();
        const pending = (async () => {
          // A preview and replies in other topics spend the same chat's slots.
          await adapter.deliver({
            id: "preview", kind: "stream_update", createdAt: 1,
            audit: message(10, "").audit, text: "Working", markdown: "plain",
            stream: { key: "preview", sequence: 1, isFinal: false },
          });
          for (let index = 0; index < preceding; index += 1) {
            await adapter.deliver(message(10 + index % 2, `Reply ${index}`));
          }
          return await adapter.deliver(message(12, "x".repeat(4096 * chunks)));
        })();
        await vi.advanceTimersByTimeAsync(2 * WINDOW_MS);
        expect((await pending).outcome).toBe("presented");
        expect(calls).toHaveLength(1 + preceding + chunks);
        const expected: number[] = [];
        for (const call of calls) {
          expected.push(Math.max(
            (expected.at(-1) ?? (1000 - MIN_INTERVAL_MS)) + MIN_INTERVAL_MS,
            (expected.at(-GROUP_LIMIT) ?? -WINDOW_MS) + WINDOW_MS,
          ));
          expect(call.at).toBe(expected.at(-1));
        }
        expect(calls.slice(-chunks).map((call) => call.topic)).toEqual(Array(chunks).fill(12));
      },
    ), { numRuns: 10 });
  });

  it.each([true, false])("preserves the accepted prefix after a later rejection (429=%s)", async (limited) => {
    const { adapter, calls } = harness((_call, index) => {
      if (index !== 1) return;
      if (limited) throw { error_code: 429, parameters: { retry_after: 2 } };
      throw new Error("Connection closed after sending");
    });
    const onRateLimit = vi.fn();
    adapter.onRateLimit(onRateLimit);
    const pending = adapter.deliver(message(12, "a".repeat(4096) + "b".repeat(4096) + "c"));
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(calls.map((call) => call.text?.[0])).toEqual(limited ? ["a", "b", "b", "c"] : ["a", "b"]);
    if (limited) {
      expect(result).toMatchObject({ outcome: "presented", surface: { id: "4" } });
      expect(calls[2]!.at - calls[1]!.at).toBe(2_000 + SAFETY_BUFFER_MS);
      expect(onRateLimit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ retryable: false, retryAfterMs: 2000 }));
    } else {
      expect(result).toMatchObject({ outcome: "failed", fallbackUnsafe: true });
      expect(onRateLimit).not.toHaveBeenCalled();
    }
  });

  it("admits the rejected rich request, then sends fallback media in order", async () => {
    const { adapter, api, calls } = harness();
    const rich = vi.fn(async () => {
      calls.push({ method: "rich", at: Date.now() });
      throw { error_code: 400, description: "Unsupported rich message" };
    });
    Object.assign(api, { sendRichMessage: rich });
    const base = message(12, "");
    const pending = adapter.deliver({
      ...base,
      parts: [
        { type: "text", text: "# Evidence", markdown: "markdown" },
        { type: "image", url: "data:image/png;base64,AQID" },
        { type: "file", name: "report.txt", data: new Uint8Array([1]) },
      ],
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toMatchObject({ outcome: "presented", surface: { id: "3" } });
    expect(calls.map(({ method, at }) => [method, at])).toEqual([
      ["rich", 1000], ["photo", 2100], ["document", 3200],
    ]);
  });

  it("keeps cooldown across topics and adapter replacement for the same bot", async () => {
    const limited = harness(() => { throw { error_code: 429, parameters: { retry_after: 2 } }; });
    const failed = await limited.adapter.deliver(message(10, "Before replacement"));
    const carryover = limited.adapter.exportRateLimitCarryover();
    const replacement = harness();
    const otherBot = harness(undefined, "321");
    replacement.adapter.restoreRateLimitCarryover(carryover);
    otherBot.adapter.restoreRateLimitCarryover(carryover);
    const topic = message(20, "After replacement");
    expect(failed.rateLimit).toMatchObject({ scope: replacement.adapter.resolveDeliveryScope(topic), retryable: true });
    expect(otherBot.adapter.resolveDeliveryScope(topic)?.id).not.toBe(failed.rateLimit?.scope.id);
    const pending = replacement.adapter.deliver(topic);
    await otherBot.adapter.deliver(topic);
    expect(otherBot.calls[0]?.at).toBe(1000);
    expect(replacement.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(4000);
    expect((await pending).outcome).toBe("presented");
    expect(replacement.calls[0]?.at).toBe(5000);
  });

  it("does not resume a stream after a chunk with an unknown outcome", async () => {
    const { adapter, calls } = harness((_call, index) => {
      if (index === 1) throw new Error("Connection closed after sending");
    });
    const stream = {
      id: "preview", kind: "stream_update" as const, createdAt: 1,
      audit: message(12, "").audit, text: "x".repeat(4200), markdown: "plain" as const,
      stream: { key: "preview", sequence: 1, isFinal: false },
    };
    const pending = adapter.deliver(stream);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ outcome: "failed", fallbackUnsafe: true });
    const final = { ...stream, stream: { ...stream.stream, isFinal: true, sequence: 2 } };
    expect(await adapter.deliver(final)).toMatchObject({ outcome: "failed", fallbackUnsafe: true });
    expect(calls).toHaveLength(2);
  });
});
