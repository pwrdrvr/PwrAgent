import { describe, expect, it } from "vitest";
import { FeishuAdapter, parseFeishuCommandText, type FeishuApi } from "../feishu-adapter.ts";
import type {
  MessagingCallbackHandleRecord,
  MessagingCallbackHandleStore,
  MessagingChannelRef,
  MessagingInboundEvent,
} from "@pwragent/messaging-interface";

const baseConfig = {
  appId: "cli_test",
  appSecret: "secret",
  authorizedActorIds: [{ id: "ou_user", displayName: "Alice" }],
  channel: "feishu" as const,
  tenantUrl: "https://open.feishu.cn",
  verificationToken: "verify-token",
};

function fakeStore(): MessagingCallbackHandleStore & {
  records: MessagingCallbackHandleRecord[];
} {
  const records: MessagingCallbackHandleRecord[] = [];
  return {
    records,
    resolveCallbackHandle: async (params) =>
      records.find(
        (record) =>
          record.handle === params.handle
          && record.allowedActorIds.includes(params.actorId)
          && conversationKey(record.channel) === conversationKey(params.channel),
      ),
    upsertCallbackHandle: async (record) => {
      records.push(record);
      return record;
    },
  };
}

function conversationKey(channel: MessagingChannelRef): string {
  return [
    channel.channel,
    channel.conversation.kind,
    channel.conversation.parentId ?? "",
    channel.conversation.id,
  ].join(":");
}

function fakeApi(spies: {
  deleted?: string[];
  sent?: unknown[];
  updated?: unknown[];
}): FeishuApi {
  return {
    deleteMessage: async ({ messageId }) => {
      spies.deleted?.push(messageId);
    },
    downloadFile: async () => new Uint8Array([1, 2, 3]),
    getBotInfo: async () => ({
      appName: "PwrAgent",
      openId: "ou_bot",
      tenantKey: "tenant_1",
    }),
    sendMessage: async (params) => {
      spies.sent?.push(params);
      return { messageId: "om_sent", chatId: params.receiveId };
    },
    updateMessage: async (params) => {
      spies.updated?.push(params);
      return { messageId: params.messageId };
    },
  };
}

describe("FeishuAdapter", () => {
  it("declares Feishu capabilities", () => {
    const adapter = new FeishuAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({}),
    });

    expect(adapter.channel).toBe("feishu");
    expect(adapter.authorizedActorIds).toEqual(["ou_user"]);
    expect(adapter.clientRateLimitStrategy).toBe("direct");
    expect(adapter.capabilityProfile.actions?.maxActions).toBe(20);
    expect(adapter.capabilityProfile.text.markdownDialect).toBe("feishu-md");
  });

  it("sends interactive cards with persisted callback handles", async () => {
    const store = fakeStore();
    const spies: { sent: unknown[] } = { sent: [] };
    const adapter = new FeishuAdapter({
      config: baseConfig,
      callbackHandleStore: store,
      api: fakeApi(spies),
      now: () => 1_700_000_000_000,
    });

    await expect(adapter.deliver({
      id: "status-1",
      kind: "status",
      createdAt: 1,
      status: "waiting",
      text: "Approve?",
      actions: [{ id: "approve", label: "Approve", value: "yes" }],
      audit: {
        actor: { platformUserId: "ou_user" },
        bindingId: "binding-1",
        channel: {
          channel: "feishu",
          conversation: { id: "ou_user", kind: "dm" },
        },
        occurredAt: 1,
      },
    })).resolves.toMatchObject({
      channel: "feishu",
      outcome: "presented",
      surface: { id: "om_sent" },
    });
    expect(store.records).toHaveLength(1);
    expect(spies.sent[0]).toMatchObject({
      receiveId: "ou_user",
      receiveIdType: "open_id",
      card: {
        elements: expect.arrayContaining([
          expect.objectContaining({ tag: "action" }),
        ]),
      },
    });
  });

  it("normalizes authorized webhook text events", async () => {
    const adapter = new FeishuAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({}),
      now: () => 1_700_000_000_000,
    });
    const events: MessagingInboundEvent[] = [];
    await adapter.start(async (event) => {
      events.push(event);
    });

    await adapter.handleWebhookPayload({
      header: {
        event_id: "evt_1",
        event_type: "im.message.receive_v1",
        tenant_key: "tenant_1",
        token: "verify-token",
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user" },
          tenant_key: "tenant_1",
        },
        message: {
          chat_id: "oc_chat",
          chat_type: "p2p",
          content: JSON.stringify({ text: "hello" }),
          message_id: "om_message",
          message_type: "text",
        },
      },
    });
    await adapter.stop();

    expect(events).toEqual([
      expect.objectContaining({
        kind: "text",
        text: "hello",
        actor: { platformUserId: "ou_user" },
      }),
    ]);
  });

  it("parses Feishu approval click command bodies", () => {
    expect(parseFeishuCommandText("/cas_click abc123")).toEqual({
      command: "cas_click",
      args: ["abc123"],
    });
    expect(parseFeishuCommandText("/help threads")).toEqual({
      command: "help",
      args: ["threads"],
    });
  });
});
