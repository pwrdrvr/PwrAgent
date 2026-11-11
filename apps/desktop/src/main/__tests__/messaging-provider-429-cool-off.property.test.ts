import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type {
  MessagingDeliveryResult,
  MessagingDeliveryScope,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import { LineAdapter } from "@pwragent/messaging-provider-line";
import { MattermostAdapter } from "@pwragent/messaging-provider-mattermost";
import {
  MessagingDeliveryBudget,
  type MessagingDeliveryPriority,
} from "../messaging/core/messaging-delivery-budget.js";

// Property: once a provider answers HTTP 429 with a Retry-After, the
// delivery budget admits no send to that scope until the wait has passed.
//
// The real adapters and the real budget are wired the way the runtime and
// controller wire them: `onRateLimit` and `result.rateLimit` both feed
// `recordRateLimit`. Only the HTTP boundary is faked, with the 429 each
// platform actually returns.

const PRIORITIES: MessagingDeliveryPriority[] = [
  "critical_interactive",
  "final_turn",
  "user_command",
  "routine_status",
  "tool_progress",
  "stream_partial",
];

// The budget pads every provider wait by this much. Admission is checked
// again only after the pad, so the property does not depend on its value
// being exactly this.
const SAFETY_BUFFER_MS = 2_000;

type Harness = {
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  intent: MessagingSurfaceIntent;
  scope: MessagingDeliveryScope | undefined;
};

type RetryAfterForm = "seconds" | "http-date";

function retryAfterHeader(form: RetryAfterForm, seconds: number, nowMs: number): string {
  return form === "seconds"
    ? String(seconds)
    : new Date(nowMs + seconds * 1000).toUTCString();
}

function lineHarness(clock: () => number, retryAfter: () => string, budget: MessagingDeliveryBudget): Harness {
  const userId = "U0123456789abcdef0123456789abcdef";
  const adapter = new LineAdapter({
    api: {
      downloadMessageContent: async () => new Uint8Array(),
      getBotInfo: async () => ({ userId: "Uffffffffffffffffffffffffffffffff" }),
      pushMessage: async () => {
        // The shape of the SDK's HTTPFetchError.
        throw Object.assign(new Error("Too Many Requests"), {
          status: 429,
          statusText: "Too Many Requests",
          headers: new Headers({ "Retry-After": retryAfter() }),
          body: '{"message":"The API rate limit has been exceeded. Try again later."}',
        });
      },
    },
    callbackHandleStore: {
      resolveCallbackHandle: async () => undefined,
      upsertCallbackHandle: async (record) => record,
    },
    config: {
      authorizedActorIds: [{ id: userId, displayName: "Operator" }],
      callbackBaseUrl: "http://127.0.0.1:47822/",
      channel: "line",
      channelAccessToken: "token",
      channelSecret: "secret",
    },
    now: clock,
  });
  // Optional, as on the runtime's adapter type. The property must also hold
  // through `result.rateLimit` alone.
  adapter.onRateLimit?.((info) => budget.recordRateLimit(info));
  const intent = {
    id: "intent-line",
    kind: "message",
    role: "assistant",
    parts: [{ type: "text", text: "hello" }],
    audit: {
      actor: { platformUserId: userId },
      channel: { channel: "line", conversation: { id: userId, kind: "dm" } },
      occurredAt: 0,
    },
    createdAt: 0,
  } as unknown as MessagingSurfaceIntent;
  return {
    deliver: (value) => adapter.deliver(value),
    intent,
    scope: adapter.resolveDeliveryScope(intent),
  };
}

function mattermostHarness(clock: () => number, retryAfter: () => string, budget: MessagingDeliveryBudget): Harness {
  // Mattermost's limiter answers 429 with a plain-text body.
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response("limit exceeded\n", {
      status: 429,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": retryAfter() },
    }),
  ));
  const adapter = new MattermostAdapter({
    callbackHandleStore: {
      resolveCallbackHandle: async () => undefined,
      upsertCallbackHandle: async (record) => record,
    },
    callbackServer: { start: async () => {}, stop: async () => {} } as never,
    config: {
      channel: "mattermost",
      botToken: "test-token",
      serverUrl: "https://chat.example.com",
      callbackBaseUrl: "https://callback.example.com/cb",
      callbackHmacSecret: "test-secret",
      authorizedActorIds: [{ id: "user-1", displayName: "" }],
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: clock,
    websocketClient: {
      addMessageListener: () => {},
      addCloseListener: () => {},
      addErrorListener: () => {},
      initialize: () => {},
      close: () => {},
      userTyping: () => {},
    } as never,
  });
  // Optional, as on the runtime's adapter type. The property must also hold
  // through `result.rateLimit` alone.
  adapter.onRateLimit?.((info) => budget.recordRateLimit(info));
  const intent = {
    id: "intent-mattermost",
    kind: "message",
    role: "assistant",
    parts: [{ type: "text", text: "hello" }],
    audit: {
      actor: { platformUserId: "user-1" },
      channel: {
        channel: "mattermost",
        conversation: { id: "abcdefghijklmnopqrstuvwxyz", kind: "channel" },
      },
      occurredAt: 0,
    },
    createdAt: 0,
  } as unknown as MessagingSurfaceIntent;
  return {
    deliver: (value) => adapter.deliver(value),
    intent,
    scope: adapter.resolveDeliveryScope(intent),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each([
  ["LINE", lineHarness],
  ["Mattermost", mattermostHarness],
] as const)("%s 429 cool-off", (_name, createHarness) => {
  it("admits no send to the scope before Retry-After expires", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3_600 }),
        fc.constantFrom<RetryAfterForm>("seconds", "http-date"),
        // Whole seconds, so an HTTP-date names the same instant.
        fc.integer({ min: 1_700_000_000, max: 1_900_000_000 }).map((s) => s * 1000),
        fc.array(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.constantFrom(...PRIORITIES),
        async (retryAfterSeconds, form, startMs, probeFractions, priority) => {
          let now = startMs;
          const clock = () => now;
          const budget = new MessagingDeliveryBudget({ now: clock });
          const harness = createHarness(
            clock,
            () => retryAfterHeader(form, retryAfterSeconds, startMs),
            budget,
          );
          expect(harness.scope).toBeDefined();
          expect(budget.admit({ priority: "final_turn", scope: harness.scope })).toMatchObject({
            outcome: "admitted",
          });

          const result = await harness.deliver(harness.intent);
          expect(result.outcome).toBe("failed");
          if (result.rateLimit) budget.recordRateLimit(result.rateLimit);

          const retryAfterMs = retryAfterSeconds * 1000;
          for (const fraction of probeFractions) {
            now = startMs + Math.floor(fraction * retryAfterMs);
            const admission = budget.admit({ priority, scope: harness.scope });
            expect(admission.outcome).not.toBe("admitted");
            if (admission.outcome === "deferred") {
              expect(admission.retryAt).toBeGreaterThanOrEqual(startMs + retryAfterMs);
            }
          }

          // The cool-off ends: a final answer goes out again.
          now = startMs + retryAfterMs + SAFETY_BUFFER_MS;
          expect(budget.admit({ priority: "final_turn", scope: harness.scope })).toMatchObject({
            outcome: "admitted",
          });
          vi.unstubAllGlobals();
        },
      ),
      { numRuns: 100 },
    );
  });
});
