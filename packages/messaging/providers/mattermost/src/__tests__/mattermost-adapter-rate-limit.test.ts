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

function createAdapter(
  fetchImpl: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) =>
    await fetchImpl(String(url), init),
  ));
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

const RESPONSE_URL = "https://chat.example.com/hooks/commands/response-token";

function isCreatePost(url: string, init?: RequestInit): boolean {
  return url.endsWith("/api/v4/posts") && init?.method?.toLowerCase() === "post";
}

function responseUrlIntent(): MessagingSurfaceIntent {
  return {
    ...messageIntent("picker"),
    targetSurface: {
      channel: "mattermost",
      id: "slash-command",
      state: { opaque: { responseUrl: RESPONSE_URL, responseUrlInvokerUserId: "user-1" } },
    },
  } as unknown as MessagingSurfaceIntent;
}

describe("Mattermost 429 on a slash-command response_url", () => {
  it("replays a refused response_url post and never falls back to createPost", async () => {
    const urls: string[] = [];
    const { adapter } = createAdapter((url, init) => {
      urls.push(url);
      expect(isCreatePost(url, init)).toBe(false);
      return rateLimitedResponse({ "Retry-After": "6" });
    });

    const result = await adapter.deliver(responseUrlIntent());

    expect(urls).toEqual([RESPONSE_URL]);
    expect(result.outcome).toBe("failed");
    expect(result.rateLimit).toMatchObject({ retryAfterMs: 6_000, retryable: true });
  });

  it("does not replay once the response_url post is visible", async () => {
    const { adapter } = createAdapter((url, init) => {
      expect(isCreatePost(url, init)).toBe(false);
      if (url === RESPONSE_URL) return jsonResponse(200, { ok: true });
      // The follow-up lookup of the post just created is refused.
      return rateLimitedResponse({ "Retry-After": "4" });
    });

    const result = await adapter.deliver(responseUrlIntent());

    expect(result.outcome).toBe("failed");
    expect(result.rateLimit).toMatchObject({ retryAfterMs: 4_000, retryable: false });
  });
});

describe("Mattermost stream update interrupted by a 429", () => {
  function streamIntent(text: string, sequence: number): MessagingSurfaceIntent {
    return {
      ...messageIntent(),
      id: `stream-${sequence}`,
      kind: "stream_update",
      markdown: "plain",
      policy: "enabled",
      text,
      stream: { key: "codex:thread-1:turn-1", isFinal: false, sequence },
    } as unknown as MessagingSurfaceIntent;
  }

  it("keeps the posts it created, so the next snapshot does not post them again", async () => {
    const created: string[] = [];
    let refuseNextCreate = false;
    const { adapter } = createAdapter((url, init) => {
      if (isCreatePost(url, init)) {
        if (refuseNextCreate) {
          refuseNextCreate = false;
          return rateLimitedResponse({ "Retry-After": "1" });
        }
        const { message } = JSON.parse(String(init?.body)) as { message: string };
        created.push(message.slice(0, 1));
        // The second chunk of this snapshot is refused.
        refuseNextCreate = created.length === 1;
        return jsonResponse(201, { id: `post-${created.length}` });
      }
      return jsonResponse(200, { id: "post-1" });
    });
    // Two chunks: Mattermost splits at 16,383 characters.
    const text = `${"a".repeat(16_000)}\n\n${"b".repeat(10_000)}`;

    const first = await adapter.deliver(streamIntent(text, 1));
    expect(first.outcome).toBe("discarded");
    expect(first.rateLimit?.retryable).toBe(false);

    await adapter.deliver(streamIntent(text, 2));

    // Chunk "a" once, then chunk "b" once on the next snapshot.
    expect(created).toEqual(["a", "b"]);
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
