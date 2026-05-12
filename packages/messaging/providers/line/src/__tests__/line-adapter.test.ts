import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MESSAGING_CALLBACK_HANDLE_TTL_MS,
  type MessagingCallbackHandleRecord,
  type MessagingInboundEvent,
  type MessagingRejectedInboundEvent,
} from "@pwragent/messaging-interface";
import { LineAdapter, verifyLineSignature, type LineApi } from "../line-adapter.ts";
import type { LineMessagingConfig } from "../line-config.ts";

describe("LineAdapter", () => {
  const adapters: LineAdapter[] = [];

  afterEach(async () => {
    await Promise.all(adapters.map((adapter) => adapter.stop().catch(() => undefined)));
    adapters.length = 0;
  });

  it("verifies X-Line-Signature before processing webhook bodies", () => {
    const body = Buffer.from(JSON.stringify({ events: [] }));
    const signature = createHmac("sha256", "secret").update(body).digest("base64");
    expect(verifyLineSignature(body, signature, "secret")).toBe(true);
    expect(verifyLineSignature(body, signature, "wrong")).toBe(false);
  });

  it("rejects unsigned webhook bodies before JSON parsing", async () => {
    const port = await getFreePort();
    const listener = vi.fn();
    const adapter = new LineAdapter({
      api: createApi(),
      callbackHandleStore: createCallbackStore(),
      config: createConfig({ callbackBaseUrl: `http://127.0.0.1:${port}/` }),
    });
    adapters.push(adapter);
    await adapter.start(listener);

    const response = await fetch(`http://127.0.0.1:${port}/`, {
      body: "{",
      method: "POST",
      headers: { "x-line-signature": "bad" },
    });

    expect(response.status).toBe(401);
    expect(listener).not.toHaveBeenCalled();
  });

  it("starts the webhook listener with only a channel secret", async () => {
    const port = await getFreePort();
    const adapter = new LineAdapter({
      callbackHandleStore: createCallbackStore(),
      config: createConfig({
        callbackBaseUrl: `http://127.0.0.1:${port}/`,
        channelAccessToken: undefined,
      }),
    });
    adapters.push(adapter);
    await adapter.start(async () => {});

    const rawBody = JSON.stringify({ events: [] });
    const signature = createHmac("sha256", "secret").update(rawBody).digest("base64");
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      body: rawBody,
      method: "POST",
      headers: { "x-line-signature": signature },
    });

    expect(response.status).toBe(200);
  });

  it("binds the webhook listener to the configured local host and port", async () => {
    const port = await getFreePort();
    const logger = { info: vi.fn() };
    const adapter = new LineAdapter({
      callbackHandleStore: createCallbackStore(),
      config: createConfig({
        callbackBaseUrl: `http://0.0.0.0:${port}/`,
        channelAccessToken: undefined,
      }),
      logger,
    });
    adapters.push(adapter);
    await adapter.start(async () => {});

    expect(logger.info).toHaveBeenCalledWith(
      "line webhook listener started",
      expect.objectContaining({
        host: "0.0.0.0",
        port,
      }),
    );
  });

  it("hot-applies authorization and rendering preferences", async () => {
    const adapter = new LineAdapter({
      callbackHandleStore: createCallbackStore(),
      config: createConfig({
        authorizedGroupIds: [
          { id: "C0123456789abcdef0123456789abcdef", displayName: "Old group" },
        ],
        authorizedRoomIds: [
          { id: "R0123456789abcdef0123456789abcdef", displayName: "Old room" },
        ],
        streamingResponses: false,
      }),
    });
    adapters.push(adapter);

    await adapter.updateAuthorization({
      authorizedActorIds: ["U22222222222222222222222222222222"],
      authorizedConversationIds: [
        "C22222222222222222222222222222222",
        "R22222222222222222222222222222222",
      ],
    });
    await adapter.updateRenderingPreferences({ streamingResponses: true });

    expect(adapter.authorizedActorIds).toEqual([
      "U22222222222222222222222222222222",
    ]);
    expect(lineAdapterConfig(adapter)).toMatchObject({
      authorizedActorIds: [
        { id: "U22222222222222222222222222222222", displayName: "" },
      ],
      authorizedGroupIds: [
        { id: "C22222222222222222222222222222222", displayName: "" },
      ],
      authorizedRoomIds: [
        { id: "R22222222222222222222222222222222", displayName: "" },
      ],
      streamingResponses: true,
    });
  });

  it("reports outbound delivery as failed until a channel access token is configured", async () => {
    const adapter = new LineAdapter({
      callbackHandleStore: createCallbackStore(),
      config: createConfig({ channelAccessToken: undefined }),
      now: () => 1234,
    });
    adapters.push(adapter);

    const result = await adapter.deliver({
      id: "intent-1",
      kind: "message",
      role: "assistant",
      parts: [{ type: "text", text: "Ready" }],
      audit: {
        actor: { platformUserId: "U0123456789abcdef0123456789abcdef" },
        channel: {
          channel: "line",
          conversation: {
            id: "U0123456789abcdef0123456789abcdef",
            kind: "dm",
          },
        },
        occurredAt: 1234,
      },
      createdAt: 1234,
    });

    expect(result).toMatchObject({
      channel: "line",
      outcome: "failed",
      errorMessage: "LINE channel access token is required to send messages",
    });
  });

  it("rejects attachment downloads until a channel access token is configured", async () => {
    const adapter = new LineAdapter({
      callbackHandleStore: createCallbackStore(),
      config: createConfig({ channelAccessToken: undefined }),
    });
    adapters.push(adapter);

    await expect(adapter.downloadAttachment({
      attachment: {
        id: "123",
        kind: "file",
        name: "file.bin",
        disposition: "available",
      },
      maxBytes: 10,
    })).rejects.toThrow(/channel access token/);
  });

  it("delivers text and action chips as LINE push messages", async () => {
    const api = createApi();
    const store = createCallbackStore();
    const adapter = new LineAdapter({
      api,
      callbackHandleStore: store,
      config: createConfig(),
      now: () => 1234,
    });
    adapters.push(adapter);

    const result = await adapter.deliver({
      id: "intent-1",
      kind: "confirmation",
      browseSessionId: "browse-1",
      title: "Confirm",
      body: "Run it?",
      actions: [{ id: "confirm:yes", label: "Approve" }],
      allowedActorIds: ["U0123456789abcdef0123456789abcdef"],
      audit: {
        actor: { platformUserId: "U0123456789abcdef0123456789abcdef" },
        channel: {
          channel: "line",
          conversation: {
            id: "U0123456789abcdef0123456789abcdef",
            kind: "dm",
          },
        },
        occurredAt: 1234,
      },
      createdAt: 1234,
    });

    expect(result.outcome).toBe("presented");
    expect(api.pushMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "U0123456789abcdef0123456789abcdef",
        messages: expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "Confirm\n\nRun it?" }),
          expect.objectContaining({ type: "flex" }),
        ]),
      }),
    );
    expect(store.upsertCallbackHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "confirm:yes",
        allowedActorIds: ["U0123456789abcdef0123456789abcdef"],
        bindingId: undefined,
        browseSessionId: "browse-1",
        expiresAt: 1234 + MESSAGING_CALLBACK_HANDLE_TTL_MS,
        handle: expect.stringMatching(/^line:[A-Za-z0-9_-]{18}$/),
      }),
    );
  });

  it("uses concise LINE flex titles instead of repeating full picker fallback text", async () => {
    const api = createApi();
    const adapter = new LineAdapter({
      api,
      callbackHandleStore: createCallbackStore(),
      config: createConfig(),
      now: () => 1234,
    });
    adapters.push(adapter);

    await adapter.deliver({
      id: "intent-picker",
      kind: "thread_picker",
      createdAt: 1234,
      fallbackText: [
        "Showing recent PwrAgent threads. Page 1/7.",
        "1. First thread",
        "Reply with a number, or reply next, projects, new, or cancel.",
      ].join("\n"),
      navigation: {
        backend: "all",
        fetchedAt: 1234,
        unchanged: false,
      },
      page: {
        actions: [{ id: "browse:select-thread", label: "1. First thread" }],
        items: [],
        pageIndex: 0,
        pageSize: 8,
        totalItems: 1,
      },
      prompt: "Showing recent PwrAgent threads. Page 1/7.",
      audit: lineDmAudit(),
    });

    const messages = api.pushMessage.mock.calls[0]?.[0].messages ?? [];
    const textMessage = messages.find((message) => message.type === "text");
    const flexMessage = messages.find((message) => message.type === "flex");
    const title = flexMessage?.type === "flex"
      ? flexMessage.contents.body?.contents[0]
      : undefined;

    expect(textMessage?.type === "text" ? textMessage.text : "").toBe([
      "Showing recent PwrAgent threads. Page 1/7.",
      "1. First thread",
      "Reply with a number, or reply next, projects, new, or cancel.",
    ].join("\n"));
    expect(title?.type === "text" ? title.text : "").toBe(
      "Showing recent PwrAgent threads. Page 1/7.",
    );
  });

  it("discards LINE status updates that would require editing an old message", async () => {
    const api = createApi();
    const adapter = new LineAdapter({
      api,
      callbackHandleStore: createCallbackStore(),
      config: createConfig(),
      now: () => 1234,
    });
    adapters.push(adapter);

    const result = await adapter.deliver({
      id: "status-update",
      kind: "status",
      status: "working",
      text: "Turn: working",
      actions: [{ id: "status:refresh", label: "Refresh" }],
      createdAt: 1234,
      delivery: {
        mode: "update",
        fallback: "present_new",
      },
      targetSurface: {
        channel: "line",
        id: "sent-1",
        state: {
          opaque: {
            conversationId: "U0123456789abcdef0123456789abcdef",
            conversationKind: "dm",
          },
        },
      },
      audit: lineDmAudit(),
    });

    expect(result).toMatchObject({
      channel: "line",
      outcome: "discarded",
    });
    expect(api.pushMessage).not.toHaveBeenCalled();
  });

  it("uses LINE loading animation for DM activity instead of sending Working text", async () => {
    const api = createApi();
    const adapter = new LineAdapter({
      api,
      callbackHandleStore: createCallbackStore(),
      config: createConfig(),
      now: () => 1234,
    });
    adapters.push(adapter);

    const result = await adapter.deliver({
      id: "activity-1",
      kind: "activity",
      activity: "typing",
      state: "active",
      leaseMs: 11_000,
      createdAt: 1234,
      audit: lineDmAudit(),
    });

    expect(result).toMatchObject({
      channel: "line",
      outcome: "signaled",
    });
    expect(api.showLoadingAnimation).toHaveBeenCalledWith({
      chatId: "U0123456789abcdef0123456789abcdef",
      loadingSeconds: 15,
    });
    expect(api.pushMessage).not.toHaveBeenCalled();
  });

  it("discards LINE group activity because loading animation is DM-only", async () => {
    const api = createApi();
    const adapter = new LineAdapter({
      api,
      callbackHandleStore: createCallbackStore(),
      config: createConfig(),
      now: () => 1234,
    });
    adapters.push(adapter);

    const result = await adapter.deliver({
      id: "activity-1",
      kind: "activity",
      activity: "typing",
      state: "active",
      createdAt: 1234,
      audit: lineGroupAudit(),
    });

    expect(result).toMatchObject({
      channel: "line",
      outcome: "discarded",
    });
    expect(api.showLoadingAnimation).not.toHaveBeenCalled();
    expect(api.pushMessage).not.toHaveBeenCalled();
  });

  it("persists callback handles with audit fallback actor and binding scope", async () => {
    const api = createApi();
    const store = createCallbackStore();
    const adapter = new LineAdapter({
      api,
      callbackHandleStore: store,
      config: createConfig(),
      now: () => 1234,
    });
    adapters.push(adapter);

    await adapter.deliver({
      id: "intent-1",
      bindingId: "stale-binding",
      kind: "confirmation",
      browseSessionId: "browse-2",
      title: "Confirm",
      body: "Run it?",
      actions: [{ id: "confirm:yes", label: "Approve" }],
      audit: {
        actor: { platformUserId: "U0123456789abcdef0123456789abcdef" },
        bindingId: "binding-1",
        channel: {
          channel: "line",
          conversation: {
            id: "C0123456789abcdef0123456789abcdef",
            kind: "channel",
            parentId: "parent-1",
          },
        },
        occurredAt: 1234,
      },
      createdAt: 1234,
    });

    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      allowedActorIds: ["U0123456789abcdef0123456789abcdef"],
      bindingId: "binding-1",
      browseSessionId: "browse-2",
      channel: {
        conversation: {
          id: "C0123456789abcdef0123456789abcdef",
          kind: "channel",
          parentId: "parent-1",
        },
      },
    });
    expect(store.records[0]?.id).toContain(store.records[0]?.handle);
  });

  it("resolves persisted postbacks across adapter restarts", async () => {
    const port = await getFreePort();
    const config = createConfig({ callbackBaseUrl: `http://127.0.0.1:${port}/` });
    const store = createCallbackStore();
    const firstApi = createApi();
    const firstAdapter = new LineAdapter({
      api: firstApi,
      callbackHandleStore: store,
      config,
      now: () => 1234,
    });
    adapters.push(firstAdapter);
    await firstAdapter.deliver({
      id: "intent-1",
      kind: "confirmation",
      title: "Confirm",
      body: "Run it?",
      actions: [{ id: "confirm:yes", label: "Approve", value: "yes" }],
      audit: {
        actor: { platformUserId: "U0123456789abcdef0123456789abcdef" },
        channel: {
          channel: "line",
          conversation: {
            id: "U0123456789abcdef0123456789abcdef",
            kind: "dm",
          },
        },
        occurredAt: 1234,
      },
      createdAt: 1234,
    });
    await firstAdapter.stop();

    const postbackData = extractFirstPostbackData(firstApi);
    const secondAdapter = new LineAdapter({
      api: createApi(),
      callbackHandleStore: store,
      config,
      now: () => 2234,
    });
    adapters.push(secondAdapter);
    const events: MessagingInboundEvent[] = [];
    await secondAdapter.start(async (event) => {
      events.push(event);
    });

    await postLineWebhook(port, config.channelSecret, {
      events: [{
        type: "postback",
        webhookEventId: "event-1",
        source: {
          type: "user",
          userId: "U0123456789abcdef0123456789abcdef",
        },
        postback: { data: postbackData },
      }],
    });
    await waitFor(() => events.length === 1);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "callback",
      actionId: "confirm:yes",
      value: "yes",
    });
  });

  it("rejects shared conversation events when no group allowlist is configured", async () => {
    const port = await getFreePort();
    const config = createConfig({ callbackBaseUrl: `http://127.0.0.1:${port}/` });
    const adapter = new LineAdapter({
      api: createApi(),
      callbackHandleStore: createCallbackStore(),
      config,
    });
    adapters.push(adapter);
    const events: MessagingInboundEvent[] = [];
    const rejections: MessagingRejectedInboundEvent[] = [];
    adapter.onInboundRejected((event) => {
      rejections.push(event);
    });
    await adapter.start(async (event) => {
      events.push(event);
    });

    await postLineWebhook(port, config.channelSecret, {
      events: [lineGroupTextEvent({ text: "/status" })],
    });
    await waitFor(() => rejections.length === 1);

    expect(events).toHaveLength(0);
    expect(rejections[0]).toMatchObject({
      kind: "text",
      reason: "unauthorized-conversation",
      channel: {
        conversation: {
          id: "C0123456789abcdef0123456789abcdef",
          kind: "channel",
        },
      },
    });
  });

  it("dispatches LINE /monitor text as a generic command event", async () => {
    const port = await getFreePort();
    const config = createConfig({
      authorizedGroupIds: [
        { id: "C0123456789abcdef0123456789abcdef", displayName: "Team" },
      ],
      callbackBaseUrl: `http://127.0.0.1:${port}/`,
    });
    const adapter = new LineAdapter({
      api: createApi(),
      callbackHandleStore: createCallbackStore(),
      config,
    });
    adapters.push(adapter);
    const events: MessagingInboundEvent[] = [];
    await adapter.start(async (event) => {
      events.push(event);
    });

    await postLineWebhook(port, config.channelSecret, {
      events: [lineGroupTextEvent({ text: "/monitor refresh" })],
    });
    await waitFor(() => events.length === 1);

    expect(events).toEqual([
      expect.objectContaining({
        kind: "command",
        command: "monitor",
        args: ["refresh"],
        rawText: "/monitor refresh",
      }),
    ]);
  });

  it("allows pairing tokens from shared conversations before group authorization", async () => {
    const port = await getFreePort();
    const config = createConfig({ callbackBaseUrl: `http://127.0.0.1:${port}/` });
    const adapter = new LineAdapter({
      api: createApi(),
      callbackHandleStore: createCallbackStore(),
      config,
    });
    adapters.push(adapter);
    const events: MessagingInboundEvent[] = [];
    await adapter.start(async (event) => {
      events.push(event);
    });

    const token = "123456789ABCDEFGHJKLMNPQRSTUVWXY";
    await postLineWebhook(port, config.channelSecret, {
      events: [lineGroupTextEvent({ text: `pair ${token}` })],
    });
    await waitFor(() => events.length === 1);

    expect(events[0]).toMatchObject({
      kind: "text",
      text: `pair ${token}`,
      channel: {
        conversation: {
          id: "C0123456789abcdef0123456789abcdef",
          kind: "channel",
        },
      },
    });
  });

  it("drops group join lifecycle events without a source user id", async () => {
    const port = await getFreePort();
    const config = createConfig({
      authorizedGroupIds: [
        { id: "C0123456789abcdef0123456789abcdef", displayName: "Team" },
      ],
      callbackBaseUrl: `http://127.0.0.1:${port}/`,
    });
    const logger = { debug: vi.fn() };
    const adapter = new LineAdapter({
      api: createApi(),
      callbackHandleStore: createCallbackStore(),
      config,
      logger,
      now: () => 1234,
    });
    adapters.push(adapter);
    const events: MessagingInboundEvent[] = [];
    await adapter.start(async (event) => {
      events.push(event);
    });

    await postLineWebhook(port, config.channelSecret, {
      events: [{
        type: "join",
        webhookEventId: "event-join",
        source: {
          type: "group",
          groupId: "C0123456789abcdef0123456789abcdef",
        },
      }],
    });
    await waitFor(() => events.length > 0 || logger.debug.mock.calls.length > 0);

    expect(events).toHaveLength(0);
    expect(logger.debug).toHaveBeenCalledWith(
      "line lifecycle event ignored without source user",
      {
        conversationId: "C0123456789abcdef0123456789abcdef",
        eventType: "join",
      },
    );
  });

  it("rejects attachments over the request download limit before fetching", async () => {
    const api = createApi();
    const adapter = new LineAdapter({
      api,
      callbackHandleStore: createCallbackStore(),
      config: createConfig(),
    });
    adapters.push(adapter);

    await expect(adapter.downloadAttachment({
      attachment: {
        id: "123",
        kind: "file",
        name: "large.bin",
        disposition: "available",
        sizeBytes: 11,
      },
      maxBytes: 10,
    })).rejects.toThrow(/download limit/);
    expect(api.downloadMessageContent).not.toHaveBeenCalled();
  });

  it("rejects downloaded attachments over the request limit when LINE omits size", async () => {
    const api = createApi();
    api.downloadMessageContent.mockResolvedValueOnce(new Uint8Array(11));
    const adapter = new LineAdapter({
      api,
      callbackHandleStore: createCallbackStore(),
      config: createConfig(),
    });
    adapters.push(adapter);

    await expect(adapter.downloadAttachment({
      attachment: {
        id: "123",
        kind: "file",
        name: "large.bin",
        disposition: "available",
      },
      maxBytes: 10,
    })).rejects.toThrow(/download limit/);
    expect(api.downloadMessageContent).toHaveBeenCalledWith("123");
  });

  it("allows attachments under the request download limit", async () => {
    const api = createApi();
    api.downloadMessageContent.mockResolvedValueOnce(new Uint8Array(10));
    const adapter = new LineAdapter({
      api,
      callbackHandleStore: createCallbackStore(),
      config: createConfig(),
    });
    adapters.push(adapter);

    await expect(adapter.downloadAttachment({
      attachment: {
        id: "123",
        kind: "file",
        name: "small.bin",
        disposition: "available",
        sizeBytes: 10,
      },
      maxBytes: 10,
    })).resolves.toMatchObject({
      fileName: "small.bin",
      sizeBytes: 10,
    });
  });

  it("rejects attachments over the advertised download cap before fetching", async () => {
    const api = createApi();
    const adapter = new LineAdapter({
      api,
      callbackHandleStore: createCallbackStore(),
      config: createConfig(),
    });
    adapters.push(adapter);

    await expect(adapter.downloadAttachment({
      attachment: {
        id: "123",
        kind: "file",
        name: "large.bin",
        disposition: "available",
        sizeBytes: 201 * 1024 * 1024,
      },
      maxBytes: 200 * 1024 * 1024,
    })).rejects.toThrow(/download limit/);
    expect(api.downloadMessageContent).not.toHaveBeenCalled();
  });
});

function createConfig(overrides: Partial<LineMessagingConfig> = {}): LineMessagingConfig {
  return {
    authorizedActorIds: [
      { id: "U0123456789abcdef0123456789abcdef", displayName: "Operator" },
    ],
    callbackBaseUrl: "http://127.0.0.1:47822/",
    channel: "line",
    channelAccessToken: "token",
    channelSecret: "secret",
    ...overrides,
  };
}

function createApi(): LineApi & {
  downloadMessageContent: ReturnType<typeof vi.fn<LineApi["downloadMessageContent"]>>;
  pushMessage: ReturnType<typeof vi.fn<LineApi["pushMessage"]>>;
  showLoadingAnimation: ReturnType<
    typeof vi.fn<NonNullable<LineApi["showLoadingAnimation"]>>
  >;
} {
  return {
    downloadMessageContent: vi.fn(async () => new Uint8Array([1, 2, 3])),
    getBotInfo: vi.fn(async () => ({
      userId: "Uffffffffffffffffffffffffffffffff",
      displayName: "PwrAgent",
    })),
    pushMessage: vi.fn(async () => ({
      sentMessages: [{ id: "sent-1" }],
    })),
    showLoadingAnimation: vi.fn(async () => undefined),
  };
}

function lineDmAudit() {
  return {
    actor: { platformUserId: "U0123456789abcdef0123456789abcdef" },
    channel: {
      channel: "line" as const,
      conversation: {
        id: "U0123456789abcdef0123456789abcdef",
        kind: "dm" as const,
      },
    },
    occurredAt: 1234,
  };
}

function lineGroupAudit() {
  return {
    actor: { platformUserId: "U0123456789abcdef0123456789abcdef" },
    channel: {
      channel: "line" as const,
      conversation: {
        id: "C0123456789abcdef0123456789abcdef",
        kind: "channel" as const,
      },
    },
    occurredAt: 1234,
  };
}

function lineAdapterConfig(adapter: LineAdapter): LineMessagingConfig {
  return (adapter as unknown as { config: LineMessagingConfig }).config;
}

function createCallbackStore() {
  const records: MessagingCallbackHandleRecord[] = [];
  return {
    records,
    resolveCallbackHandle: vi.fn(async ({ actorId, channel, handle, now }) =>
      records.find((record) =>
        record.handle === handle
        && record.allowedActorIds.includes(actorId)
        && record.channel.channel === channel.channel
        && record.channel.conversation.id === channel.conversation.id
        && (!record.expiresAt || record.expiresAt > (now ?? Date.now())),
      ),
    ),
    upsertCallbackHandle: vi.fn(
      async (record: MessagingCallbackHandleRecord) => {
        records.push(record);
        return record;
      },
    ),
  };
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("failed to allocate a port"));
      });
    });
  });
}

async function postLineWebhook(
  port: number,
  channelSecret: string,
  body: unknown,
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const signature = createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  return await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "x-line-signature": signature,
    },
  });
}

function lineGroupTextEvent(params: { text: string }): unknown {
  return {
    type: "message",
    webhookEventId: "event-group-text",
    source: {
      type: "group",
      groupId: "C0123456789abcdef0123456789abcdef",
      userId: "U0123456789abcdef0123456789abcdef",
    },
    message: {
      id: "12345",
      type: "text",
      text: params.text,
    },
  };
}

function extractFirstPostbackData(api: ReturnType<typeof createApi>): string {
  const messages = api.pushMessage.mock.calls[0]?.[0].messages ?? [];
  const flex = messages.find((message) => message.type === "flex");
  const row = flex?.type === "flex" ? flex.contents.footer?.contents[0] : undefined;
  const button = row?.type === "box" ? row.contents[0] : undefined;
  const data = button?.type === "button" ? button.action.data : undefined;
  if (!data) throw new Error("missing LINE postback data");
  return data;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for LINE webhook event");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
