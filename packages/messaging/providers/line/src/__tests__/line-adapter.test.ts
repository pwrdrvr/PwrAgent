import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagingCallbackHandleRecord } from "@pwragent/messaging-interface";
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
        handle: expect.stringMatching(/^line:/),
      }),
    );
  });
});

function createConfig(): LineMessagingConfig {
  return {
    authorizedActorIds: [
      { id: "U0123456789abcdef0123456789abcdef", displayName: "Operator" },
    ],
    callbackBaseUrl: "http://127.0.0.1:47822/",
    channel: "line",
    channelAccessToken: "token",
    channelSecret: "secret",
  };
}

function createApi(): LineApi & {
  pushMessage: ReturnType<typeof vi.fn<LineApi["pushMessage"]>>;
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
  };
}

function createCallbackStore() {
  return {
    resolveCallbackHandle: vi.fn(
      async (): Promise<MessagingCallbackHandleRecord | undefined> => undefined,
    ),
    upsertCallbackHandle: vi.fn(
      async (record: MessagingCallbackHandleRecord) => record,
    ),
  };
}
