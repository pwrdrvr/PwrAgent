import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { Client4, ClientError, type WebSocketClient } from "@mattermost/client";
import type {
  MessagingCallbackHandleStore,
  MessagingRateLimitInfo,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import {
  MATTERMOST_RATE_LIMIT_DEFAULT_RETRY_AFTER_MS,
  MattermostAdapter,
  MattermostRateLimitError,
  installMattermostRateLimitInterceptor,
} from "../mattermost-adapter.ts";

// These tests drive the real `Client4` over a stubbed `fetch`, because the
// defect is in how Client4 turns a 429 into an error. A fake client would
// assert whatever shape the fake was given.

const NOW = 1_800_000_000_000;
const CHANNEL_ID = "abcdefghijklmnopqrstuvwxyz";

const store: MessagingCallbackHandleStore = {
  resolveCallbackHandle: async () => undefined,
  upsertCallbackHandle: async (record) => record,
};

const logger = { info: () => {}, warn: () => {}, error: () => {} };

const config = {
  channel: "mattermost" as const,
  botToken: "test-token",
  serverUrl: "https://chat.example.com",
  callbackBaseUrl: "https://callback.example.com/cb",
  callbackHmacSecret: "test-secret",
  authorizedActorIds: [{ id: "user-1", displayName: "" }],
};

const websocketClient = {
  addMessageListener: () => {},
  addCloseListener: () => {},
  addErrorListener: () => {},
  initialize: () => {},
  close: () => {},
  userTyping: () => {},
} as unknown as WebSocketClient;

function messageIntent(text = "hello"): MessagingSurfaceIntent {
  return {
    id: "intent-1",
    kind: "message",
    role: "assistant",
    parts: [{ type: "text", text }],
    audit: {
      actor: { platformUserId: "user-1" },
      channel: {
        channel: "mattermost",
        conversation: { id: CHANNEL_ID, kind: "channel" },
      },
      occurredAt: NOW,
    },
    createdAt: NOW,
  } as unknown as MessagingSurfaceIntent;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// Mattermost's limiter answers with `http.Error(w, "limit exceeded", 429)`:
// a plain-text body, which Client4 cannot read a status or message from.
function rateLimitedResponse(headers: Record<string, string>) {
  return new Response("limit exceeded\n", {
    status: 429,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...headers },
  });
}

function createAdapter(fetchImpl: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => await fetchImpl(String(url))));
  const adapter = new MattermostAdapter({
    callbackHandleStore: store,
    callbackServer: { start: async () => {}, stop: async () => {} } as never,
    client: new Client4(),
    config,
    logger,
    now: () => NOW,
    websocketClient,
  });
  const emitted: MessagingRateLimitInfo[] = [];
  adapter.onRateLimit((info) => emitted.push(info));
  return { adapter, emitted };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Mattermost 429 handling", () => {
  it("reports Retry-After as a replayable rate limit on the delivery scope", async () => {
    const { adapter, emitted } = createAdapter(() =>
      rateLimitedResponse({ "Retry-After": "7", "X-Ratelimit-Reset": "30" }),
    );
    const intent = messageIntent();

    const result = await adapter.deliver(intent);

    expect(result.outcome).toBe("failed");
    expect(result.rateLimit).toMatchObject({
      retryAfterMs: 7_000,
      retryable: true,
      observedAt: NOW,
    });
    // The budget keys cool-offs by scope id; any other id is a silent no-op.
    expect(result.rateLimit?.scope).toEqual(adapter.resolveDeliveryScope(intent));
    expect(emitted).toEqual([result.rateLimit]);
  });

  it("falls back to X-RateLimit-Reset, then to the default", async () => {
    const reset = createAdapter(() => rateLimitedResponse({ "X-Ratelimit-Reset": "12" }));
    expect((await reset.adapter.deliver(messageIntent())).rateLimit?.retryAfterMs).toBe(12_000);

    vi.unstubAllGlobals();
    const bare = createAdapter(() => rateLimitedResponse({}));
    expect((await bare.adapter.deliver(messageIntent())).rateLimit?.retryAfterMs).toBe(
      MATTERMOST_RATE_LIMIT_DEFAULT_RETRY_AFTER_MS,
    );
  });

  it("does not mark a split message replayable once a chunk is visible", async () => {
    let calls = 0;
    const { adapter } = createAdapter(() => {
      calls += 1;
      return calls === 1
        ? jsonResponse(201, { id: "post-1" })
        : rateLimitedResponse({ "Retry-After": "3" });
    });

    const result = await adapter.deliver(messageIntent("x".repeat(40_000)));

    expect(calls).toBe(2);
    expect(result.outcome).toBe("failed");
    expect(result.rateLimit).toMatchObject({ retryAfterMs: 3_000, retryable: false });
  });

  it("leaves other HTTP failures as plain delivery failures", async () => {
    const { adapter, emitted } = createAdapter(() =>
      jsonResponse(403, { id: "api.context.permissions", message: "no permission", status_code: 403 }),
    );

    const result = await adapter.deliver(messageIntent());

    expect(result.outcome).toBe("failed");
    expect(result.errorMessage).toBe("no permission");
    expect(result.rateLimit).toBeUndefined();
    expect(emitted).toEqual([]);
  });
});

describe("installMattermostRateLimitInterceptor", () => {
  it("throws MattermostRateLimitError for every 429 and keeps ClientError otherwise", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(200, 201, 400, 401, 403, 404, 409, 413, 429, 500, 502, 503),
        fc.integer({ min: 0, max: 3_600 }),
        async (status, retryAfterSeconds) => {
          vi.stubGlobal("fetch", vi.fn(async () =>
            status === 429
              ? rateLimitedResponse({ "Retry-After": String(retryAfterSeconds) })
              : jsonResponse(status, { id: "post-1", message: "server said no", status_code: status }),
          ));
          const client = new Client4();
          client.setUrl(config.serverUrl);
          expect(installMattermostRateLimitInterceptor(client, () => NOW)).toBe(true);

          const outcome = await client.getPost("post-1").then(
            () => "ok" as const,
            (error: unknown) => error,
          );

          if (status >= 200 && status < 300) {
            expect(outcome).toBe("ok");
          } else if (status === 429) {
            expect(outcome).toBeInstanceOf(MattermostRateLimitError);
            expect((outcome as MattermostRateLimitError).retryAfterMs).toBe(
              retryAfterSeconds * 1000,
            );
          } else {
            expect(outcome).toBeInstanceOf(ClientError);
            expect((outcome as ClientError).message).toBe("server said no");
            expect((outcome as ClientError).status_code).toBe(status);
          }
          vi.unstubAllGlobals();
        },
      ),
      { numRuns: 100 },
    );
  });
});
