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
  authorizedTeamIds: [{ id: "T012ABCDEF0", displayName: "PwrDrvr" }],
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
  conversations?: Record<string, string>;
  deleted?: Array<{ channel: string; ts: string }>;
  posted?: unknown[];
  replies?: Record<string, string>;
  updated?: unknown[];
  users?: Record<string, { displayName?: string; realName?: string; username?: string }>;
}): SlackApi {
  return {
    authTest: async () => ({
      user: "pwragent",
      user_id: "U0BOTUSERID",
      team: "PwrDrvr",
      team_id: "T012ABCDEF0",
    }),
    conversationsInfo: async (params) => ({
      id: params.channel,
      name: spies.conversations?.[params.channel],
    }),
    conversationsReplies: async (params) => [{
      ts: params.ts,
      text: spies.replies?.[`${params.channel}:${params.ts}`],
    }],
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
    usersInfo: async (params) => {
      const user = spies.users?.[params.user];
      if (!user) return undefined;
      return {
        id: params.user,
        name: user.username,
        real_name: user.realName,
        profile: {
          display_name: user.displayName,
          real_name: user.realName,
        },
      };
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
    expect(adapter.clientRateLimitStrategy).toBe("externalized");
    expect(adapter.capabilityProfile.actions?.maxActions).toBe(25);
    expect(adapter.capabilityProfile.actions?.supportsLayoutHints).toBe(true);
    expect(adapter.capabilityProfile.text.markdownDialect).toBe("slack-mrkdwn");
  });

  it("returns structured rate-limit feedback when Slack rejects a send", async () => {
    const store = fakeStore();
    const rateLimitError = Object.assign(new Error("rate_limited"), {
      retryAfter: 3,
    });
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: store,
      api: {
        ...fakeApi({}),
        postMessage: async () => {
          throw rateLimitError;
        },
      },
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const observed: unknown[] = [];
    adapter.onRateLimit((info) => {
      observed.push(info);
    });

    await expect(adapter.deliver({
      id: "message-1",
      kind: "message",
      createdAt: 1,
      role: "assistant",
      parts: [{ type: "text", text: "Final answer" }],
      audit: {
        actor: { platformUserId: "U012ABCDEF0" },
        bindingId: "slack-binding-1",
        channel: {
          channel: "slack",
          conversation: { id: "C012ABCDEF0", kind: "channel" },
        },
        occurredAt: 1,
      },
    })).resolves.toMatchObject({
      channel: "slack",
      deliveredAt: 1_700_000_000_000,
      errorMessage: "rate_limited",
      outcome: "failed",
      rateLimit: {
        retryAfterMs: 3000,
        retryable: true,
        scope: {
          id: "slack:channel:C012ABCDEF0",
        },
      },
    });
    expect(observed).toEqual([
      expect.objectContaining({
        retryAfterMs: 3000,
        retryable: true,
        scope: expect.objectContaining({
          id: "slack:channel:C012ABCDEF0",
        }),
      }),
    ]);
  });

  it("marks Slack file-upload rate limits non-retryable after posting the message", async () => {
    const rateLimitError = Object.assign(new Error("rate_limited"), {
      retryAfter: 3,
    });
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: {
        ...fakeApi({}),
        uploadFile: async () => {
          throw rateLimitError;
        },
      },
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });

    await expect(adapter.deliver({
      id: "message-1",
      kind: "message",
      createdAt: 1,
      role: "assistant",
      parts: [
        { type: "text", text: "Final answer" },
        {
          type: "file",
          data: new Uint8Array([1, 2, 3]),
          mimeType: "text/plain",
          name: "answer.txt",
        },
      ],
      audit: {
        actor: { platformUserId: "U012ABCDEF0" },
        bindingId: "slack-binding-1",
        channel: {
          channel: "slack",
          conversation: { id: "C012ABCDEF0", kind: "channel" },
        },
        occurredAt: 1,
      },
    })).resolves.toMatchObject({
      channel: "slack",
      outcome: "failed",
      rateLimit: {
        retryAfterMs: 3000,
        retryable: false,
      },
    });
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
        bindingId: "slack-binding-1",
        channel: {
          channel: "slack",
          conversation: { id: "C012ABCDEF0", kind: "channel" },
        },
        occurredAt: 1,
      },
      allowedActorIds: ["U012ABCDEF0", "U099OTHER"],
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
    expect(store.records[0]).toMatchObject({
      actionId: "resume-thread",
      allowedActorIds: ["U012ABCDEF0", "U099OTHER"],
      bindingId: "slack-binding-1",
    });
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

  it("keeps fan-out callback records scoped per routed binding", async () => {
    const store = fakeStore();
    const spies: { posted: unknown[] } = { posted: [] };
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: store,
      api: fakeApi(spies),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const baseIntent: MessagingSurfaceIntent = {
      id: "fanout-status",
      kind: "status",
      createdAt: 1,
      status: "waiting",
      text: "Queued",
      allowedActorIds: ["U012ABCDEF0"],
      actions: [{ id: "cancel", label: "Cancel" }],
    };

    await adapter.deliver({
      ...baseIntent,
      audit: {
        actor: { platformUserId: "U012ABCDEF0" },
        bindingId: "binding-1",
        channel: {
          channel: "slack",
          conversation: { id: "C012ABCDEF0", kind: "channel" },
        },
        occurredAt: 1,
      },
    });
    await adapter.deliver({
      ...baseIntent,
      audit: {
        actor: { platformUserId: "U012ABCDEF0" },
        bindingId: "binding-2",
        channel: {
          channel: "slack",
          conversation: { id: "C099OTHER", kind: "channel" },
        },
        occurredAt: 1,
      },
    });

    expect(store.records).toHaveLength(2);
    expect(store.records[0]?.handle).toBe(store.records[1]?.handle);
    expect(store.records[0]?.id).not.toBe(store.records[1]?.id);
    expect(store.records.map((record) => record.bindingId)).toEqual([
      "binding-1",
      "binding-2",
    ]);
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
        routingState: expect.objectContaining({
          opaque: expect.objectContaining({
            channelId: "C012ABCDEF0",
            teamId: "T012ABCDEF0",
          }),
        }),
      }),
    ]);
  });

  it("routes leading app mentions as commands", async () => {
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
        type: "app_mention",
        channel: "C012ABCDEF0",
        channel_type: "channel",
        team: "T012ABCDEF0",
        ts: "1712023032.123456",
        user: "U012ABCDEF0",
        text: "<@U0BOTUSERID> help status",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "command",
        command: "help",
        args: ["status"],
        rawText: "/help status",
      }),
    ]);
  });

  it("routes bare leading app mentions as the help command", async () => {
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
        type: "app_mention",
        channel: "C012ABCDEF0",
        channel_type: "channel",
        team: "T012ABCDEF0",
        ts: "1712023032.123456",
        user: "U012ABCDEF0",
        text: "<@U0BOTUSERID>",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "command",
        command: "help",
        args: [],
        rawText: "/help",
      }),
    ]);
  });

  it("deduplicates app_mention and message events for the same Slack post", async () => {
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
    const event = {
      channel: "C012ABCDEF0",
      channel_type: "channel",
      team: "T012ABCDEF0",
      ts: "1712023032.123456",
      user: "U012ABCDEF0",
      text: "<@U0BOTUSERID> help",
    };

    await socket.emitEvent("slack_event", {
      ack: async () => undefined,
      event: {
        ...event,
        type: "app_mention",
      },
    });
    await socket.emitEvent("slack_event", {
      ack: async () => undefined,
      event: {
        ...event,
        type: "message",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "command",
        command: "help",
        rawText: "/help",
      }),
    ]);
  });

  it("strips the configured prefix from Slack slash commands", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        slashCommandPrefix: "pwragent_",
      },
      callbackHandleStore: fakeStore(),
      api: fakeApi({}),
      socketClient: socket,
      now: () => 1_700_000_000_000,
    });
    const events: MessagingInboundEvent[] = [];
    await adapter.start(async (event) => {
      events.push(event);
    });

    await socket.emitEvent("slash_commands", {
      ack: async () => undefined,
      body: {
        channel_id: "C012ABCDEF0",
        channel_name: "signals-chat",
        command: "/pwragent_monitor",
        team_id: "T012ABCDEF0",
        text: "refresh",
        user_id: "U012ABCDEF0",
        user_name: "alice",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "command",
        command: "monitor",
        args: ["refresh"],
        rawText: "/pwragent_monitor refresh",
      }),
    ]);
  });

  it("normalizes an operator-configured Slack new slash command", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        slashCommandPrefix: "pwragent_",
      },
      callbackHandleStore: fakeStore(),
      api: fakeApi({}),
      socketClient: socket,
      now: () => 1_700_000_000_000,
    });
    const events: MessagingInboundEvent[] = [];
    await adapter.start(async (event) => {
      events.push(event);
    });

    await socket.emitEvent("slash_commands", {
      ack: async () => undefined,
      body: {
        channel_id: "C012ABCDEF0",
        channel_name: "signals-chat",
        command: "/pwragent_new",
        team_id: "T012ABCDEF0",
        text: "--fast",
        user_id: "U012ABCDEF0",
        user_name: "alice",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "command",
        command: "new",
        args: ["--fast"],
        rawText: "/pwragent_new --fast",
      }),
    ]);
  });

  it("uses users.info display names for DM labels when users:read is granted", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedActorIds: [{ id: "U012ABCDEF0", displayName: "" }],
      },
      callbackHandleStore: fakeStore(),
      api: fakeApi({
        users: {
          U012ABCDEF0: { displayName: "Harold Hunt", username: "hhunt" },
        },
      }),
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
        channel: "D012ABCDEF0",
        channel_type: "im",
        team: "T012ABCDEF0",
        ts: "1712023032.123456",
        user: "U012ABCDEF0",
        text: "hello",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({
          displayName: "Harold Hunt",
          platformUserId: "U012ABCDEF0",
        }),
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "D012ABCDEF0",
            kind: "dm",
            title: "Harold Hunt",
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

  it("rejects events from workspaces outside the authorized team list", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedTeamIds: [{ id: "TALLOWED123", displayName: "Allowed" }],
      },
      callbackHandleStore: fakeStore(),
      api: fakeApi({}),
      socketClient: socket,
      now: () => 1_700_000_000_000,
    });
    const events: MessagingInboundEvent[] = [];
    const rejected: MessagingRejectedInboundEvent[] = [];
    adapter.onInboundRejected((event) => {
      rejected.push(event);
    });
    await adapter.start(async (event) => {
      events.push(event);
    });

    await socket.emitEvent("slack_event", {
      ack: async () => undefined,
      event: {
        type: "message",
        channel: "C012ABCDEF0",
        channel_type: "channel",
        team: "TOTHER12345",
        ts: "1712023032.123456",
        user: "U012ABCDEF0",
        text: "/status",
      },
    });

    expect(events).toEqual([]);
    expect(rejected).toEqual([
      expect.objectContaining({
        reason: "unauthorized-conversation",
        actor: expect.objectContaining({ platformUserId: "U012ABCDEF0" }),
      }),
    ]);
  });

  it("rejects group DM events when the authorized workspace list is empty", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: { ...baseConfig, authorizedTeamIds: [] },
      callbackHandleStore: fakeStore(),
      api: fakeApi({}),
      socketClient: socket,
      now: () => 1_700_000_000_000,
    });
    const events: MessagingInboundEvent[] = [];
    const rejected: MessagingRejectedInboundEvent[] = [];
    adapter.onInboundRejected((event) => {
      rejected.push(event);
    });
    await adapter.start(async (event) => {
      events.push(event);
    });

    await socket.emitEvent("slack_event", {
      ack: async () => undefined,
      event: {
        type: "message",
        channel: "G012ABCDEF0",
        channel_type: "mpim",
        team: "T012ABCDEF0",
        ts: "1712023032.123456",
        user: "U012ABCDEF0",
        text: "/status",
      },
    });

    expect(events).toEqual([]);
    expect(rejected).toEqual([
      expect.objectContaining({
        reason: "unauthorized-conversation",
        actor: expect.objectContaining({ platformUserId: "U012ABCDEF0" }),
      }),
    ]);
  });

  it("allows DMs from authorized actors when the authorized workspace list is empty", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: { ...baseConfig, authorizedTeamIds: [] },
      callbackHandleStore: fakeStore(),
      api: fakeApi({}),
      socketClient: socket,
      now: () => 1_700_000_000_000,
    });
    const events: MessagingInboundEvent[] = [];
    const rejected: MessagingRejectedInboundEvent[] = [];
    adapter.onInboundRejected((event) => {
      rejected.push(event);
    });
    await adapter.start(async (event) => {
      events.push(event);
    });

    await socket.emitEvent("slack_event", {
      ack: async () => undefined,
      event: {
        type: "message",
        channel: "D012ABCDEF0",
        channel_type: "im",
        team: "T012ABCDEF0",
        ts: "1712023032.123456",
        user: "U012ABCDEF0",
        text: "hello",
      },
    });

    expect(rejected).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "text",
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "D012ABCDEF0",
            kind: "dm",
          }),
        }),
      }),
    ]);
  });

  it("allows authorized conversations without authorizing the whole workspace", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedConversationIds: [{ id: "C012ABCDEF0", displayName: "dev" }],
        authorizedTeamIds: [],
      },
      callbackHandleStore: fakeStore(),
      api: fakeApi({}),
      socketClient: socket,
      now: () => 1_700_000_000_000,
    });
    const events: MessagingInboundEvent[] = [];
    const rejected: MessagingRejectedInboundEvent[] = [];
    adapter.onInboundRejected((event) => {
      rejected.push(event);
    });
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
        text: "/status",
      },
    });

    expect(rejected).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "command",
        command: "status",
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
        channel: { id: "D012ABCDEF0", name: "directmessage" },
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
            title: "Alice",
          }),
        }),
      }),
    ]);
  });

  it("resolves callback buttons after restart when no Slack signing secret is configured", async () => {
    const { signingSecret: _signingSecret, ...config } = baseConfig;
    const store = fakeStore();
    const spies: { posted: unknown[] } = { posted: [] };
    const firstAdapter = new SlackAdapter({
      config,
      callbackHandleStore: store,
      api: fakeApi(spies),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });

    await firstAdapter.deliver({
      id: "status-after-restart",
      kind: "status",
      createdAt: 1,
      status: "waiting",
      text: "Still valid?",
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

    const socket = fakeSocket();
    const secondAdapter = new SlackAdapter({
      config,
      callbackHandleStore: store,
      api: fakeApi({}),
      socketClient: socket,
      now: () => 1_700_000_000_000,
    });
    const delivered: MessagingInboundEvent[] = [];
    await secondAdapter.start(async (event) => {
      delivered.push(event);
    });

    await socket.emitEvent("interactive", {
      ack: async () => undefined,
      body: {
        type: "block_actions",
        user: { id: "U012ABCDEF0", username: "alice" },
        team: { id: "T012ABCDEF0" },
        channel: { id: "D012ABCDEF0", name: "directmessage" },
        message: { ts: "1712023032.123456" },
        actions: [button],
      },
    });

    expect(delivered).toEqual([
      expect.objectContaining({
        kind: "callback",
        actionId: "resume",
      }),
    ]);
  });

  it("uses conversations.info names for private-channel threads", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({
        conversations: {
          G012ABCDEF0: "agents-private",
        },
        replies: {
          "G012ABCDEF0:1712023030.000000": ":thread: Root message for this Slack thread",
        },
      }),
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
        channel: "G012ABCDEF0",
        channel_type: "group",
        team: "T012ABCDEF0",
        thread_ts: "1712023030.000000",
        ts: "1712023032.123456",
        user: "U012ABCDEF0",
        text: "thread reply",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "G012ABCDEF0",
            kind: "thread",
            parentId: "1712023030.000000",
            parentTitle: "agents-private",
            title: "Root message for this Slack thread",
          }),
        }),
      }),
    ]);
  });
});
