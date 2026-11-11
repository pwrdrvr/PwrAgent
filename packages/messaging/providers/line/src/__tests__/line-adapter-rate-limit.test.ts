import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { HTTPFetchError } from "@line/bot-sdk";
import type {
  MessagingCallbackHandleStore,
  MessagingRateLimitInfo,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import {
  LINE_MONTHLY_QUOTA_RETRY_AFTER_MS,
  LINE_RATE_LIMIT_DEFAULT_RETRY_AFTER_MS,
  LineAdapter,
  lineRateLimitFromError,
  type LineApi,
} from "../line-adapter.ts";

// The fakes throw the SDK's own HTTPFetchError, which is what
// `MessagingApiClient.pushMessage` rejects with on a non-2xx response.

const NOW = 1_800_000_000_000;
const USER_ID = "U0123456789abcdef0123456789abcdef";

const store: MessagingCallbackHandleStore = {
  resolveCallbackHandle: async () => undefined,
  upsertCallbackHandle: async (record) => record,
};

function http429(headers: Record<string, string> = {}, body = '{"message":"The API rate limit has been exceeded. Try again later."}') {
  return new HTTPFetchError("Too Many Requests", {
    status: 429,
    statusText: "Too Many Requests",
    headers: new Headers(headers),
    body,
  });
}

function messageIntent(text = "hello"): MessagingSurfaceIntent {
  return {
    id: "intent-1",
    kind: "message",
    role: "assistant",
    parts: [{ type: "text", text }],
    audit: {
      actor: { platformUserId: USER_ID },
      channel: { channel: "line", conversation: { id: USER_ID, kind: "dm" } },
      occurredAt: NOW,
    },
    createdAt: NOW,
  } as unknown as MessagingSurfaceIntent;
}

function createAdapter(pushMessage: LineApi["pushMessage"]) {
  const api: LineApi = {
    downloadMessageContent: async () => new Uint8Array(),
    getBotInfo: async () => ({ userId: "Uffffffffffffffffffffffffffffffff" }),
    pushMessage: vi.fn(pushMessage),
    showLoadingAnimation: async () => {
      throw http429({ "Retry-After": "2" });
    },
  };
  const adapter = new LineAdapter({
    api,
    callbackHandleStore: store,
    config: {
      authorizedActorIds: [{ id: USER_ID, displayName: "Operator" }],
      callbackBaseUrl: "http://127.0.0.1:47822/",
      channel: "line",
      channelAccessToken: "token",
      channelSecret: "secret",
    },
    now: () => NOW,
  });
  const emitted: MessagingRateLimitInfo[] = [];
  adapter.onRateLimit((info) => emitted.push(info));
  return { adapter, api, emitted };
}

describe("LINE 429 handling", () => {
  it("reports Retry-After as a replayable rate limit on the delivery scope", async () => {
    const { adapter, emitted } = createAdapter(async () => {
      throw http429({ "Retry-After": "9" });
    });
    const intent = messageIntent();

    const result = await adapter.deliver(intent);

    expect(result.outcome).toBe("failed");
    expect(result.rateLimit).toMatchObject({
      retryAfterMs: 9_000,
      retryable: true,
      observedAt: NOW,
    });
    // The budget keys cool-offs by scope id; any other id is a silent no-op.
    expect(result.rateLimit?.scope).toEqual(adapter.resolveDeliveryScope(intent));
    expect(emitted).toEqual([result.rateLimit]);
  });

  it("uses the default when LINE sends no Retry-After", async () => {
    const { adapter } = createAdapter(async () => {
      throw http429();
    });

    const result = await adapter.deliver(messageIntent());

    expect(result.rateLimit?.retryAfterMs).toBe(LINE_RATE_LIMIT_DEFAULT_RETRY_AFTER_MS);
  });

  it("cools off longer and does not replay when the monthly quota is spent", async () => {
    const { adapter } = createAdapter(async () => {
      throw http429({}, '{"message":"You have reached your monthly limit."}');
    });

    const result = await adapter.deliver(messageIntent());

    expect(result.rateLimit).toMatchObject({
      retryAfterMs: LINE_MONTHLY_QUOTA_RETRY_AFTER_MS,
      retryable: false,
    });
  });

  it("does not mark a split message replayable once a push is visible", async () => {
    let calls = 0;
    const { adapter } = createAdapter(async () => {
      calls += 1;
      if (calls === 1) return { sentMessages: [{ id: "sent-1" }] };
      throw http429({ "Retry-After": "4" });
    });

    // Six 5,000-character chunks need two pushes of at most five messages.
    const result = await adapter.deliver(messageIntent("x".repeat(26_000)));

    expect(calls).toBe(2);
    expect(result.outcome).toBe("failed");
    expect(result.rateLimit).toMatchObject({ retryAfterMs: 4_000, retryable: false });
  });

  it("records a rate-limited typing signal without replaying it", async () => {
    const { adapter } = createAdapter(async () => ({}));

    const result = await adapter.deliver({
      ...messageIntent(),
      kind: "activity",
      activity: "typing",
      state: "active",
    } as unknown as MessagingSurfaceIntent);

    expect(result.outcome).toBe("discarded");
    expect(result.rateLimit).toMatchObject({ retryAfterMs: 2_000, retryable: false });
  });

  it("leaves other HTTP failures as plain delivery failures", async () => {
    const { adapter, emitted } = createAdapter(async () => {
      throw new HTTPFetchError("Bad Request", {
        status: 400,
        statusText: "Bad Request",
        headers: new Headers({ "Retry-After": "9" }),
        body: "{}",
      });
    });

    const result = await adapter.deliver(messageIntent());

    expect(result.outcome).toBe("failed");
    expect(result.rateLimit).toBeUndefined();
    expect(emitted).toEqual([]);
  });
});

describe("lineRateLimitFromError", () => {
  it("is defined exactly for HTTP 429 and honors any delta-seconds Retry-After", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 599 }),
        fc.option(fc.integer({ min: 0, max: 3_600 }), { nil: undefined }),
        (status, retryAfterSeconds) => {
          const error = new HTTPFetchError("failed", {
            status,
            statusText: "",
            headers: new Headers(
              retryAfterSeconds === undefined ? {} : { "Retry-After": String(retryAfterSeconds) },
            ),
            body: "{}",
          });
          const parsed = lineRateLimitFromError(error, NOW);
          if (status !== 429) {
            expect(parsed).toBeUndefined();
            return;
          }
          expect(parsed?.retryAfterMs).toBe(
            retryAfterSeconds === undefined
              ? LINE_RATE_LIMIT_DEFAULT_RETRY_AFTER_MS
              : retryAfterSeconds * 1000,
          );
        },
      ),
    );
  });
});
