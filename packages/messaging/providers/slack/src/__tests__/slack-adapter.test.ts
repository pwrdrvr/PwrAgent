import { describe, expect, it } from "vitest";
import { SlackAdapter, type SlackApi, type SlackSocketClient } from "../slack-adapter.ts";
import type {
  MessagingChannelRef,
  MessagingCallbackHandleRecord,
  MessagingCallbackHandleStore,
  MessagingInboundEvent,
  MessagingRejectedInboundEvent,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";

const baseConfig = {
  channel: "slack" as const,
  botToken: "xoxb-test",
  appToken: "xapp-test",
  signingSecret: "test-signing-secret",
  authorizedActorIds: [{ id: "U012ABCDEF0", displayName: "Alice" }],
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
          record.handle === params.handle &&
          record.allowedActorIds.includes(params.actorId) &&
          conversationKey(record.channel) === conversationKey(params.channel),
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
  deleted?: Array<{ channel: string; ts: string }>;
  posted?: unknown[];
  updated?: unknown[];
}): SlackApi {
  return {
    authTest: async () => ({
      user: "pwragent",
      user_id: "U0BOTUSERID",
      team: "PwrDrvr",
      team_id: "T012ABCDEF0",
    }),
    deleteMessage: async (params) => {
      spies.deleted?.push(params);
    },
    downloadFile: async () => new Uint8Array([1, 2, 3]),
    filesInfo: async () => undefined,
    postMessage: async (params) => {
      spies.posted?.push(params);
      return { channel: params.channel, ts: "1712023032.123456" };
    },
    updateMessage: async (params) => {
      spies.updated?.push(params);
      return { channel: params.channel, ts: params.ts };
    },
  };
}

function fakeSocket(): SlackSocketClient & {
  emitEvent(event: string, payload: unknown): Promise<void>;
} {
  const listeners = new Map<string, (payload: unknown) => void | Promise<void>>();
  return {
    on: (event, listener) => {
      listeners.set(event, listener);
    },
    off: (event) => {
      listeners.delete(event);
    },
    start: async () => undefined,
    disconnect: async () => undefined,
    emitEvent: async (event, payload) => {
      await listeners.get(event)?.(payload);
    },
  };
}

describe("SlackAdapter", () => {
  it("declares Slack capabilities", () => {
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({}),
      socketClient: fakeSocket(),
    });

    expect(adapter.channel).toBe("slack");
    expect(adapter.authorizedActorIds).toEqual(["U012ABCDEF0"]);
    expect(adapter.capabilityProfile.actions?.maxActions).toBe(25);
    expect(adapter.capabilityProfile.actions?.supportsLayoutHints).toBe(true);
    expect(adapter.capabilityProfile.text.markdownDialect).toBe("slack-mrkdwn");
  });

  it("delivers interactive status cards as Block Kit messages", async () => {
    const store = fakeStore();
    const spies: { posted: unknown[] } = { posted: [] };
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: store,
      api: fakeApi(spies),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const intent: MessagingSurfaceIntent = {
      id: "status-1",
      kind: "status",
      createdAt: 1,
      status: "waiting",
      text: "Pick **one**",
      audit: {
        actor: { platformUserId: "U012ABCDEF0" },
        channel: {
          channel: "slack",
          conversation: { id: "C012ABCDEF0", kind: "channel" },
        },
        occurredAt: 1,
      },
      actions: [{ id: "resume-thread", label: "Resume", style: "primary" }],
    };

    await expect(adapter.deliver(intent)).resolves.toMatchObject({
      outcome: "presented",
      surface: {
        channel: "slack",
        id: "1712023032.123456",
      },
    });
    expect(store.records).toHaveLength(1);
    expect(spies.posted[0]).toMatchObject({
      channel: "C012ABCDEF0",
      text: "Pick *one*",
      blocks: [
        expect.objectContaining({ type: "section" }),
        expect.objectContaining({
          type: "actions",
          elements: [
            expect.objectContaining({
              action_id: "resume_thread_0",
              style: "primary",
            }),
          ],
        }),
      ],
    });
  });

  it("normalizes Socket Mode message events", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({}),
      socketClient: socket,
      now: () => 1_700_000_000_000,
    });
    const events: MessagingInboundEvent[] = [];
    await adapter.start(async (event) => {
      events.push(event);
    });

    await socket.emitEvent("slack_event", {
      ack: async () => undefined,
      event: {
        type: "message",
        channel: "C012ABCDEF0",
        channel_type: "channel",
        team: "T012ABCDEF0",
        ts: "1712023032.123456",
        user: "U012ABCDEF0",
        text: "hello",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "text",
        text: "hello",
        actor: expect.objectContaining({ platformUserId: "U012ABCDEF0" }),
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "C012ABCDEF0",
            kind: "channel",
          }),
        }),
      }),
    ]);
  });

  it("emits rejected activity for unauthorized actors", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({}),
      socketClient: socket,
      now: () => 1_700_000_000_000,
    });
    const rejected: MessagingRejectedInboundEvent[] = [];
    adapter.onInboundRejected((event) => {
      rejected.push(event);
    });
    await adapter.start(async () => undefined);

    await socket.emitEvent("slack_event", {
      ack: async () => undefined,
      event: {
        type: "message",
        channel: "C012ABCDEF0",
        channel_type: "channel",
        team: "T012ABCDEF0",
        ts: "1712023032.123456",
        user: "U099ZZZZZZZ",
        text: "/status",
      },
    });

    expect(rejected).toEqual([
      expect.objectContaining({
        kind: "command",
        reason: "unauthorized-actor",
        actor: expect.objectContaining({ platformUserId: "U099ZZZZZZZ" }),
      }),
    ]);
  });

  it("routes Block Kit callbacks from DMs back to the original DM handle", async () => {
    const socket = fakeSocket();
    const store = fakeStore();
    const spies: { posted: unknown[] } = { posted: [] };
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: store,
      api: fakeApi(spies),
      socketClient: socket,
      now: () => 1_700_000_000_000,
    });
    const delivered: MessagingInboundEvent[] = [];
    await adapter.start(async (event) => {
      delivered.push(event);
    });

    await adapter.deliver({
      id: "resume-prompt",
      kind: "status",
      createdAt: 1,
      status: "waiting",
      text: "Resume?",
      audit: {
        actor: { platformUserId: "U012ABCDEF0" },
        channel: {
          channel: "slack",
          conversation: { id: "D012ABCDEF0", kind: "dm" },
        },
        occurredAt: 1,
      },
      actions: [{ id: "resume", label: "Resume", style: "primary" }],
    });
    const posted = spies.posted[0] as {
      blocks: Array<{
        elements?: Array<{ action_id?: string; value?: string }>;
      }>;
    };
    const button = posted.blocks.flatMap((block) => block.elements ?? [])[0]!;

    await socket.emitEvent("interactive", {
      ack: async () => undefined,
      body: {
        type: "block_actions",
        user: { id: "U012ABCDEF0", username: "alice" },
        team: { id: "T012ABCDEF0" },
        channel: { id: "D012ABCDEF0" },
        message: { ts: "1712023032.123456" },
        actions: [button],
      },
    });

    expect(delivered).toEqual([
      expect.objectContaining({
        kind: "callback",
        actionId: "resume",
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "D012ABCDEF0",
            kind: "dm",
          }),
        }),
      }),
    ]);
  });
});
