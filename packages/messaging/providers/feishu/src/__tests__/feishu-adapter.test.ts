import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFeishuApi,
  FeishuAdapter,
  parseFeishuCommandText,
  type FeishuApi,
} from "../feishu-adapter.ts";
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
  inboundMode: "webhook" as const,
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("uses Lark persistent connection events by default", async () => {
    let started = false;
    let closed = false;
    let dispatcher: { invoke(data: unknown, params?: { needCheck?: boolean }): Promise<unknown> }
      | undefined;
    const { inboundMode: _inboundMode, ...persistentConfig } = baseConfig;
    const adapter = new FeishuAdapter({
      config: persistentConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({}),
      now: () => 1_700_000_000_000,
      wsClientFactory: () => ({
        close: () => {
          closed = true;
        },
        start: async (params) => {
          started = true;
          dispatcher = params.eventDispatcher;
        },
      }),
    });
    const events: MessagingInboundEvent[] = [];
    await adapter.start(async (event) => {
      events.push(event);
    });

    await dispatcher?.invoke({
      schema: "2.0",
      header: {
        event_id: "evt_ws",
        event_type: "im.message.receive_v1",
        tenant_key: "tenant_1",
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user" },
          tenant_key: "tenant_1",
        },
        message: {
          chat_id: "oc_chat",
          chat_type: "p2p",
          content: JSON.stringify({ text: "/help" }),
          message_id: "om_message",
          message_type: "text",
        },
      },
    }, { needCheck: false });
    await adapter.stop();

    expect(started).toBe(true);
    expect(closed).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "command",
        command: "help",
        rawText: "/help",
      }),
    ]);
  });

  it("strips bot mentions before parsing group chat commands", async () => {
    const adapter = new FeishuAdapter({
      config: {
        ...baseConfig,
        authorizedChatIds: [{ id: "oc_chat", displayName: "Ops" }],
      },
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
        event_id: "evt_mention",
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
          chat_type: "group",
          content: JSON.stringify({ text: "@_user_1 /help threads" }),
          mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "PwrAgent" }],
          message_id: "om_message",
          message_type: "text",
        },
      },
    });
    await adapter.stop();

    expect(events).toEqual([
      expect.objectContaining({
        kind: "command",
        command: "help",
        args: ["threads"],
        rawText: "/help threads",
      }),
    ]);
  });

  it("resolves group chat card callbacks against the delivered chat channel", async () => {
    const store = fakeStore();
    const spies: { sent: Array<{ card?: { elements?: unknown[] } }> } = { sent: [] };
    const adapter = new FeishuAdapter({
      config: {
        ...baseConfig,
        authorizedChatIds: [{ id: "oc_chat", displayName: "Ops" }],
      },
      callbackHandleStore: store,
      api: fakeApi(spies),
      now: () => 1_700_000_000_000,
    });
    await adapter.deliver({
      id: "approval-1",
      kind: "status",
      createdAt: 1,
      status: "waiting",
      text: "Ship it?",
      actions: [{ id: "approve", label: "Approve", value: "yes" }],
      audit: {
        actor: { platformUserId: "ou_user" },
        bindingId: "binding-1",
        channel: {
          channel: "feishu",
          conversation: { id: "oc_chat", kind: "channel", parentId: "tenant_1" },
        },
        occurredAt: 1,
      },
    });

    const card = spies.sent[0]?.card as {
      elements: Array<{ actions?: Array<{ value?: { handle?: string } }> }>;
    };
    const actionElement = card.elements.find((element) => Array.isArray(element.actions));
    const handle = actionElement?.actions?.[0]?.value?.handle;
    expect(handle).toEqual(expect.any(String));

    const events: MessagingInboundEvent[] = [];
    await adapter.start(async (event) => {
      events.push(event);
    });
    await adapter.handleWebhookPayload({
      header: {
        event_id: "evt_card",
        event_type: "card.action.trigger",
        tenant_key: "tenant_1",
        token: "verify-token",
      },
      event: {
        operator: { open_id: "ou_user" },
        tenant_key: "tenant_1",
        context: {
          open_chat_id: "oc_chat",
          open_message_id: "om_sent",
        },
        action: {
          value: { handle },
        },
      },
    });
    await adapter.stop();

    expect(events).toEqual([
      expect.objectContaining({
        kind: "callback",
        actionId: "approve",
        channel: {
          channel: "feishu",
          conversation: { id: "oc_chat", kind: "channel", parentId: "tenant_1" },
        },
      }),
    ]);
  });

  it("requests low-permission bot identity on startup", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
        return new Response(JSON.stringify({
          code: 0,
          tenant_access_token: "tenant-token",
        }));
      }
      if (url.endsWith("/open-apis/bot/v3/info")) {
        return new Response(JSON.stringify({
          code: 0,
          bot: {
            app_name: "PwrAgent",
            avatar_url: "https://example.com/avatar.png",
            open_id: "ou_bot",
          },
        }));
      }
      return new Response(JSON.stringify({ code: 99992402, msg: "unexpected URL" }), {
        status: 400,
      });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(createFeishuApi(baseConfig).getBotInfo()).resolves.toEqual({
      appName: "PwrAgent",
      avatarUrl: "https://example.com/avatar.png",
      openId: "ou_bot",
      tenantKey: undefined,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/bot/v3/info",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer tenant-token",
        }),
      }),
    );
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
