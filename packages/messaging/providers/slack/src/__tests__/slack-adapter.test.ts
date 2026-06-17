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
  responseMode: "every_message" as const,
  // Open the team/channel gates by default so tests focused on delivery and
  // parsing aren't blocked by the locked-down defaults; authorization tests
  // override these explicitly.
  teamAuthorizationMode: "allow_all" as const,
  channelAuthorizationMode: "allow_all" as const,
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
  assistantStatusError?: Error;
  assistantStatuses?: Array<{ channelId: string; status: string; threadTs: string }>;
  conversations?: Record<string, string>;
  mpimChannels?: string[];
  deleted?: Array<{ channel: string; ts: string }>;
  posted?: unknown[];
  replies?: Record<string, string>;
  updated?: unknown[];
  users?: Record<string, { displayName?: string; realName?: string; username?: string }>;
}): SlackApi {
  return {
    authTest: async () => ({
      bot_id: "B0PWRAGENT",
      user: "pwragent",
      user_id: "U0BOTUSERID",
      team: "PwrDrvr",
      team_id: "T012ABCDEF0",
    }),
    setAssistantThreadStatus: async (params) => {
      if (spies.assistantStatusError) {
        throw spies.assistantStatusError;
      }
      spies.assistantStatuses?.push(params);
    },
    conversationsInfo: async (params) => ({
      id: params.channel,
      name: spies.conversations?.[params.channel],
      is_mpim: spies.mpimChannels?.includes(params.channel) ?? false,
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

  it("signals Slack Assistant thread status for active typing activity", async () => {
    const assistantStatuses: Array<{ channelId: string; status: string; threadTs: string }> = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ assistantStatuses }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });

    await expect(adapter.deliver({
      id: "activity-1",
      kind: "activity",
      activity: "typing",
      createdAt: 1,
      leaseMs: 10_000,
      state: "active",
      targetSurface: {
        channel: "slack",
        id: "binding-1",
        state: {
          opaque: {
            channelId: "C012ABCDEF0",
            threadTs: "1712023030.000000",
          },
        },
      },
    })).resolves.toMatchObject({
      channel: "slack",
      deliveredAt: 1_700_000_000_000,
      outcome: "signaled",
    });

    expect(assistantStatuses).toEqual([{
      channelId: "C012ABCDEF0",
      status: "is working on your request...",
      threadTs: "1712023030.000000",
    }]);
  });

  it("clears Slack Assistant thread status for idle typing activity", async () => {
    const assistantStatuses: Array<{ channelId: string; status: string; threadTs: string }> = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ assistantStatuses }),
      socketClient: fakeSocket(),
    });

    await expect(adapter.deliver({
      id: "activity-2",
      kind: "activity",
      activity: "typing",
      createdAt: 1,
      state: "idle",
      targetSurface: {
        channel: "slack",
        id: "binding-1",
        state: {
          opaque: {
            channelId: "C012ABCDEF0",
            ts: "1712023030.000000",
          },
        },
      },
    })).resolves.toMatchObject({
      channel: "slack",
      outcome: "signaled",
    });

    expect(assistantStatuses).toEqual([{
      channelId: "C012ABCDEF0",
      status: "",
      threadTs: "1712023030.000000",
    }]);
  });

  it("discards Slack typing activity when no thread timestamp is available", async () => {
    const assistantStatuses: Array<{ channelId: string; status: string; threadTs: string }> = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ assistantStatuses }),
      socketClient: fakeSocket(),
    });

    await expect(adapter.deliver({
      id: "activity-3",
      kind: "activity",
      activity: "typing",
      createdAt: 1,
      state: "active",
      targetSurface: {
        channel: "slack",
        id: "binding-1",
        state: {
          opaque: {
            channelId: "C012ABCDEF0",
          },
        },
      },
    })).resolves.toMatchObject({
      channel: "slack",
      outcome: "discarded",
    });

    expect(assistantStatuses).toEqual([]);
  });

  it("disables Slack Assistant status after unsupported scope errors", async () => {
    let attempts = 0;
    const missingScopeError = Object.assign(
      new Error("An API error occurred: missing_scope"),
      {
        data: {
          error: "missing_scope",
          needed: "chat:write",
        },
      },
    );
    const api = fakeApi({});
    api.setAssistantThreadStatus = async () => {
      attempts += 1;
      throw missingScopeError;
    };
    const warnings: unknown[] = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api,
      socketClient: fakeSocket(),
      logger: {
        warn: (_message, data) => {
          warnings.push(data);
        },
      },
    });
    const activity = {
      id: "activity-unsupported",
      kind: "activity" as const,
      activity: "typing" as const,
      createdAt: 1,
      state: "active" as const,
      targetSurface: {
        channel: "slack" as const,
        id: "binding-1",
        state: {
          opaque: {
            channelId: "C012ABCDEF0",
            threadTs: "1712023030.000000",
          },
        },
      },
    };

    await expect(adapter.deliver(activity)).resolves.toMatchObject({
      channel: "slack",
      outcome: "discarded",
    });
    await expect(adapter.deliver({
      ...activity,
      id: "activity-after-disable",
    })).resolves.toMatchObject({
      channel: "slack",
      outcome: "discarded",
    });

    expect(attempts).toBe(1);
    expect(warnings).toEqual([
      expect.objectContaining({
        requiredScope: "chat:write or assistant:write",
      }),
    ]);
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
          kind: "channel",
          // Per-minute sliding window (not the legacy 1/sec) so an agent turn's
          // burst is admitted. Channels mirror Discord: 30/min, 5 reserved.
          budget: { limit: 30, intervalMs: 60_000, reserved: 5 },
        },
      },
    });
    expect(observed).toEqual([
      expect.objectContaining({
        retryAfterMs: 3000,
        retryable: true,
        scope: expect.objectContaining({
          id: "slack:channel:C012ABCDEF0",
          budget: { limit: 30, intervalMs: 60_000, reserved: 5 },
        }),
      }),
    ]);
  });

  it("budgets Slack DMs over a per-minute window like Telegram DMs", async () => {
    const rateLimitError = Object.assign(new Error("rate_limited"), {
      retryAfter: 3,
    });
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: {
        ...fakeApi({}),
        postMessage: async () => {
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
      parts: [{ type: "text", text: "Final answer" }],
      audit: {
        actor: { platformUserId: "U012ABCDEF0" },
        bindingId: "slack-binding-1",
        channel: {
          channel: "slack",
          conversation: { id: "D012ABCDEF0", kind: "dm" },
        },
        occurredAt: 1,
      },
    })).resolves.toMatchObject({
      outcome: "failed",
      rateLimit: {
        scope: {
          id: "slack:channel:D012ABCDEF0",
          kind: "dm",
          budget: { limit: 60, intervalMs: 60_000, reserved: 0 },
        },
      },
    });
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

  it("maps source-relative thread broadcast delivery to Slack post fields", async () => {
    const spies: { posted: unknown[] } = { posted: [] };
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi(spies),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });

    await adapter.deliver({
      id: "automation-source-reply",
      kind: "message",
      createdAt: 1,
      role: "assistant",
      delivery: {
        sourceRelative: "source_thread",
        broadcastThreadReply: true,
      },
      parts: [{ type: "text", text: "Investigated alert" }],
      targetSurface: {
        channel: "slack",
        id: "slack-text",
        state: {
          opaque: {
            channelId: "C012ABCDEF0",
            ts: "1712023032.123456",
          },
        },
      },
    });

    expect(spies.posted[0]).toMatchObject({
      channel: "C012ABCDEF0",
      thread_ts: "1712023032.123456",
      reply_broadcast: true,
      text: "Investigated alert",
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

  it("routes authorized non-self bot message events for automation triggers", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedActorIds: [
          ...baseConfig.authorizedActorIds,
          { id: "B012DATADOG", displayName: "Datadog" },
        ],
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

    await socket.emitEvent("slack_event", {
      ack: async () => undefined,
      event: {
        type: "message",
        bot_id: "B012DATADOG",
        channel: "C012ABCDEF0",
        channel_type: "channel",
        team: "T012ABCDEF0",
        ts: "1712023032.123456",
        text: "ERROR api latency high",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "text",
        text: "ERROR api latency high",
        actor: expect.objectContaining({
          platformUserId: "B012DATADOG",
          displayName: "Datadog",
          isBot: true,
        }),
        routingState: expect.objectContaining({
          opaque: expect.objectContaining({
            channelId: "C012ABCDEF0",
            ts: "1712023032.123456",
          }),
        }),
      }),
    ]);
  });

  it("ignores Slack events authored by the configured PwrAgent bot", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedActorIds: [
          ...baseConfig.authorizedActorIds,
          { id: "B0PWRAGENT", displayName: "PwrAgent" },
        ],
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

    await socket.emitEvent("slack_event", {
      ack: async () => undefined,
      event: {
        type: "message",
        bot_id: "B0PWRAGENT",
        channel: "C012ABCDEF0",
        channel_type: "channel",
        team: "T012ABCDEF0",
        ts: "1712023032.123456",
        text: "Automation completed",
      },
    });

    expect(events).toEqual([]);
  });

  it("routes leading app mentions as mentioned text", async () => {
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
        kind: "text",
        botMention: true,
        text: "help status",
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

  it("routes non-mention channel text for controller response-mode handling", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: { ...baseConfig, responseMode: "mention_only" },
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
        text: "general channel chatter",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "text",
        text: "general channel chatter",
      }),
    ]);
    expect(rejected).toEqual([]);
  });

  it("uses a Slack channel response-mode override before the workspace default", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        responseMode: "mention_only",
        authorizedConversationIds: [
          {
            id: "C012ABCDEF0",
            displayName: "alerts",
            responseMode: "every_message",
          },
        ],
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

    await socket.emitEvent("slack_event", {
      ack: async () => undefined,
      event: {
        type: "message",
        channel: "C012ABCDEF0",
        channel_type: "channel",
        team: "T012ABCDEF0",
        ts: "1712023032.123456",
        user: "U012ABCDEF0",
        text: "alert details",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "text",
        text: "alert details",
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
        kind: "text",
        botMention: true,
        text: "help",
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
        teamAuthorizationMode: "approved_only",
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

  it("answers group DM @mentions from an authorized user regardless of team/channel gates", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      // Group DMs are driven by their own access mode, not team/channel gates:
      // restrict both gates, leave the allowlists empty, and open group DMs.
      config: {
        ...baseConfig,
        authorizedTeamIds: [],
        teamAuthorizationMode: "approved_only",
        channelAuthorizationMode: "approved_only",
        groupDmAccessMode: "authorized_users",
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
        channel: "G012ABCDEF0",
        channel_type: "mpim",
        team: "T012ABCDEF0",
        ts: "1712023032.123456",
        user: "U012ABCDEF0",
        text: "<@U0BOTUSERID> status?",
      },
    });

    expect(rejected).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "text",
        botMention: true,
        text: "status?",
        actor: expect.objectContaining({ platformUserId: "U012ABCDEF0" }),
      }),
    ]);
  });

  it("rejects group DM messages by default (group DM access closed)", async () => {
    const socket = fakeSocket();
    // No groupDmAccessMode set → defaults to "none".
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
        text: "<@U0BOTUSERID> status?",
      },
    });

    expect(events).toEqual([]);
    expect(rejected).toEqual([
      expect.objectContaining({ reason: "unauthorized-conversation" }),
    ]);
  });

  it("ignores group DM messages that don't @mention the bot", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedTeamIds: [],
        groupDmAccessMode: "authorized_users",
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
        channel: "G012ABCDEF0",
        channel_type: "mpim",
        team: "T012ABCDEF0",
        ts: "1712023032.123456",
        user: "U012ABCDEF0",
        text: "just chatting, not to the bot",
      },
    });

    expect(events).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it("rejects group DM messages from an unauthorized user", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedTeamIds: [],
        groupDmAccessMode: "authorized_users",
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
        channel: "G012ABCDEF0",
        channel_type: "mpim",
        team: "T012ABCDEF0",
        ts: "1712023032.123456",
        user: "U999UNKNOWN0",
        text: "<@U0BOTUSERID> let me in",
      },
    });

    expect(events).toEqual([]);
    expect(rejected).toEqual([
      expect.objectContaining({
        reason: "unauthorized-actor",
        actor: expect.objectContaining({ platformUserId: "U999UNKNOWN0" }),
      }),
    ]);
  });

  it("ignores (does not reject) a non-mention group DM message from a non-authorized participant", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedTeamIds: [],
        groupDmAccessMode: "authorized_users",
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

    // A non-authorized participant chatting in the group DM (mentioning another
    // human, not the bot) must be ignored silently — no scary "rejected" event.
    await socket.emitEvent("slack_event", {
      ack: async () => undefined,
      event: {
        type: "message",
        channel: "G012ABCDEF0",
        channel_type: "mpim",
        team: "T012ABCDEF0",
        ts: "1712023032.123456",
        user: "U999UNKNOWN0",
        text: "<@U777HUMAN00> did you see this?",
      },
    });

    expect(events).toEqual([]);
    expect(rejected).toEqual([]);
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

  it("requires both authorized team and channel when both Slack gates are restricted", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedConversationIds: [{ id: "C012ABCDEF0", displayName: "dev" }],
        authorizedTeamIds: [{ id: "TAPPROVED", displayName: "Approved" }],
        channelAuthorizationMode: "approved_only",
        teamAuthorizationMode: "approved_only",
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
        team: "TEXTERNAL",
        ts: "1712023032.123456",
        user: "U012ABCDEF0",
        text: "blocked shared channel chatter",
      },
    });

    expect(events).toEqual([]);
    expect(rejected).toEqual([
      expect.objectContaining({
        reason: "unauthorized-conversation",
      }),
    ]);
  });

  it("allows DMs from any workspace user when the DM access mode is open", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: { ...baseConfig, dmAccessMode: "any_workspace_user" },
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
        channel: "D999AAA111",
        channel_type: "im",
        team: "T012ABCDEF0",
        ts: "1712023033.123456",
        user: "UNOTLISTED0",
        text: "hi from an unlisted user",
      },
    });

    expect(rejected).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("blocks DMs entirely when the DM access mode is none", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: { ...baseConfig, dmAccessMode: "none" },
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
        ts: "1712023034.123456",
        user: "U012ABCDEF0",
        text: "even an authorized user is blocked",
      },
    });

    expect(events).toEqual([]);
    expect(rejected).toEqual([
      expect.objectContaining({ reason: "unauthorized-conversation" }),
    ]);
  });

  it("responds to any channel user when channel user access is open", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedConversationIds: [{ id: "C012ABCDEF0", displayName: "dev" }],
        channelAuthorizationMode: "approved_only",
        teamAuthorizationMode: "allow_all",
        channelUserAccessMode: "any_channel_user",
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
        ts: "1712023035.123456",
        user: "UNOTLISTED0",
        text: "unlisted user in an approved channel",
      },
    });

    expect(rejected).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("rejects an unlisted channel user when channel user access is authorized-only", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedConversationIds: [{ id: "C012ABCDEF0", displayName: "dev" }],
        channelAuthorizationMode: "approved_only",
        teamAuthorizationMode: "allow_all",
        channelUserAccessMode: "authorized_users",
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
        ts: "1712023036.123456",
        user: "UNOTLISTED0",
        text: "unlisted user in an approved channel",
      },
    });

    expect(events).toEqual([]);
    expect(rejected).toEqual([
      expect.objectContaining({ reason: "unauthorized-actor" }),
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

  it("routes group DM Block Kit callbacks for an authorized user despite restricted gates", async () => {
    const socket = fakeSocket();
    const store = fakeStore();
    // The block-action payload doesn't reliably carry the mpdm name, so the
    // adapter classifies the group DM via conversations.info is_mpim.
    const spies: { posted: unknown[]; mpimChannels: string[] } = {
      posted: [],
      mpimChannels: ["C0BETJEH87L"],
    };
    // Lock the team/channel gates and leave the allowlists empty: a group DM
    // must still work for an authorized user (callbacks, not just messages).
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedTeamIds: [],
        teamAuthorizationMode: "approved_only",
        channelAuthorizationMode: "approved_only",
        groupDmAccessMode: "authorized_users",
      },
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
      id: "resume-prompt-gdm",
      kind: "status",
      createdAt: 1,
      status: "waiting",
      text: "Resume?",
      audit: {
        actor: { platformUserId: "U012ABCDEF0" },
        channel: {
          channel: "slack",
          conversation: { id: "C0BETJEH87L", kind: "channel" },
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
        channel: { id: "C0BETJEH87L", name: "" },
        message: { ts: "1712023032.123456" },
        actions: [button],
      },
    });

    expect(delivered).toEqual([
      expect.objectContaining({
        kind: "callback",
        actionId: "resume",
        channel: expect.objectContaining({
          conversation: expect.objectContaining({ id: "C0BETJEH87L" }),
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

  it("discards stream updates when the thread policy is disabled without calling Slack", async () => {
    const posted: unknown[] = [];
    const updated: unknown[] = [];
    const adapter = new SlackAdapter({
      // Global streaming on: the per-thread `disabled` policy must still win.
      config: { ...baseConfig, streamingResponses: true },
      callbackHandleStore: fakeStore(),
      api: fakeApi({ posted, updated }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });

    await expect(
      adapter.deliver({
        id: "assistant-stream-1",
        kind: "stream_update",
        bindingId: "slack-binding-1",
        createdAt: 1,
        role: "assistant",
        markdown: "plain",
        policy: "disabled",
        text: "partial answer",
        stream: { isFinal: false, key: "codex:thread-1:turn-1", sequence: 1 },
        targetSurface: {
          channel: "slack",
          id: "1712023032.123456",
          state: {
            opaque: { channelId: "C012ABCDEF0", ts: "1712023032.123456" },
          },
        },
      } satisfies MessagingSurfaceIntent),
    ).resolves.toMatchObject({ channel: "slack", outcome: "discarded" });

    expect(posted).toEqual([]);
    expect(updated).toEqual([]);
  });

  it("discards stream updates when streaming is globally off and the thread inherits", async () => {
    const posted: unknown[] = [];
    const updated: unknown[] = [];
    const adapter = new SlackAdapter({
      // No `streamingResponses` in config → global default off. Inherit follows.
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ posted, updated }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });

    await expect(
      adapter.deliver({
        id: "assistant-stream-1",
        kind: "stream_update",
        bindingId: "slack-binding-1",
        createdAt: 1,
        role: "assistant",
        markdown: "plain",
        policy: "inherit",
        text: "partial answer",
        stream: { isFinal: false, key: "codex:thread-1:turn-1", sequence: 1 },
        targetSurface: {
          channel: "slack",
          id: "1712023032.123456",
          state: {
            opaque: { channelId: "C012ABCDEF0", ts: "1712023032.123456" },
          },
        },
      } satisfies MessagingSurfaceIntent),
    ).resolves.toMatchObject({ channel: "slack", outcome: "discarded" });

    expect(posted).toEqual([]);
    expect(updated).toEqual([]);
  });

  it("edits the existing surface for stream updates when streaming is enabled", async () => {
    const posted: unknown[] = [];
    const updated: Array<{ channel: string; ts: string; text?: string }> = [];
    const adapter = new SlackAdapter({
      config: { ...baseConfig, streamingResponses: true },
      callbackHandleStore: fakeStore(),
      api: fakeApi({ posted, updated }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });

    await expect(
      adapter.deliver({
        id: "assistant-stream-1",
        kind: "stream_update",
        bindingId: "slack-binding-1",
        createdAt: 1,
        role: "assistant",
        markdown: "plain",
        policy: "enabled",
        text: "partial answer",
        stream: { isFinal: false, key: "codex:thread-1:turn-1", sequence: 1 },
        targetSurface: {
          channel: "slack",
          id: "1712023032.123456",
          state: {
            opaque: { channelId: "C012ABCDEF0", ts: "1712023032.123456" },
          },
        },
      } satisfies MessagingSurfaceIntent),
    ).resolves.toMatchObject({
      channel: "slack",
      outcome: "updated",
      surface: { channel: "slack", id: "1712023032.123456" },
    });

    // Edits the one surface in place — no fresh post that would ping the channel.
    expect(posted).toEqual([]);
    expect(updated).toEqual([
      expect.objectContaining({ channel: "C012ABCDEF0", ts: "1712023032.123456" }),
    ]);
  });

  it("posts the first stream chunk then edits it for the rest of the turn", async () => {
    const posted: Array<{ channel: string; text?: string }> = [];
    const updated: Array<{ channel: string; ts: string; text?: string }> = [];
    const adapter = new SlackAdapter({
      config: { ...baseConfig, streamingResponses: true },
      callbackHandleStore: fakeStore(),
      api: fakeApi({ posted, updated }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const audit = {
      actor: { platformUserId: "U012ABCDEF0" },
      bindingId: "slack-binding-1",
      channel: {
        channel: "slack" as const,
        conversation: { id: "D012ABCDEF0", kind: "dm" as const },
      },
      occurredAt: 1,
    };

    // First chunk has no target surface (the turn hasn't posted yet). Slack has
    // no create-or-edit call, so it must POST a new message instead of failing
    // with "Slack stream update target is missing".
    await expect(
      adapter.deliver({
        id: "assistant-stream-1",
        kind: "stream_update",
        bindingId: "slack-binding-1",
        createdAt: 1,
        role: "assistant",
        markdown: "plain",
        policy: "enabled",
        text: "Partial",
        stream: { isFinal: false, key: "codex:thread-1:turn-1", sequence: 1 },
        audit,
      } satisfies MessagingSurfaceIntent),
    ).resolves.toMatchObject({ channel: "slack", outcome: "presented" });

    // Second chunk (same stream key) edits the message the first chunk posted.
    await expect(
      adapter.deliver({
        id: "assistant-stream-2",
        kind: "stream_update",
        bindingId: "slack-binding-1",
        createdAt: 2,
        role: "assistant",
        markdown: "plain",
        policy: "enabled",
        text: "Partial answer",
        stream: { isFinal: false, key: "codex:thread-1:turn-1", sequence: 2 },
        audit,
      } satisfies MessagingSurfaceIntent),
    ).resolves.toMatchObject({ channel: "slack", outcome: "updated" });

    // Final chunk edits the same message and clears the per-stream surface.
    await expect(
      adapter.deliver({
        id: "assistant-stream-final",
        kind: "stream_update",
        bindingId: "slack-binding-1",
        createdAt: 3,
        role: "assistant",
        markdown: "markdown",
        policy: "enabled",
        text: "Partial answer, done.",
        stream: { isFinal: true, key: "codex:thread-1:turn-1", sequence: 3 },
        audit,
      } satisfies MessagingSurfaceIntent),
    ).resolves.toMatchObject({ channel: "slack", outcome: "updated" });

    // Exactly one post (the first chunk) and two edits — one Slack message.
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ channel: "D012ABCDEF0" });
    expect(updated).toHaveLength(2);
    expect(updated.every((u) => u.ts === "1712023032.123456")).toBe(true);
  });

  it("rolls a streaming response longer than a section block onto extra messages", async () => {
    const posted: Array<{ channel: string; text?: string }> = [];
    const updated: Array<{ channel: string; ts: string; text?: string }> = [];
    const adapter = new SlackAdapter({
      config: { ...baseConfig, streamingResponses: true },
      callbackHandleStore: fakeStore(),
      api: fakeApi({ posted, updated }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    // > 3000 chars (Slack section-block limit) split at sentence boundaries.
    const longText = "This is a full sentence that keeps going. ".repeat(90);

    await expect(
      adapter.deliver({
        id: "assistant-stream-final",
        kind: "stream_update",
        bindingId: "slack-binding-1",
        createdAt: 1,
        role: "assistant",
        markdown: "markdown",
        policy: "enabled",
        text: longText,
        stream: { isFinal: true, key: "codex:thread-1:turn-1", sequence: 1 },
        audit: {
          actor: { platformUserId: "U012ABCDEF0" },
          bindingId: "slack-binding-1",
          channel: {
            channel: "slack",
            conversation: { id: "D012ABCDEF0", kind: "dm" },
          },
          occurredAt: 1,
        },
      } satisfies MessagingSurfaceIntent),
    ).resolves.toMatchObject({ channel: "slack", outcome: "presented" });

    // Rolled onto more than one message, and no single block was truncated.
    expect(posted.length).toBeGreaterThan(1);
  });

  it("splits a long text-only message across multiple posts", async () => {
    const posted: Array<{ channel: string; text?: string }> = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ posted }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const longText = "This is a full sentence that keeps going. ".repeat(90);

    await expect(
      adapter.deliver({
        id: "assistant-message-1",
        kind: "message",
        createdAt: 1,
        role: "assistant",
        parts: [{ type: "text", text: longText }],
        audit: {
          actor: { platformUserId: "U012ABCDEF0" },
          bindingId: "slack-binding-1",
          channel: {
            channel: "slack",
            conversation: { id: "D012ABCDEF0", kind: "dm" },
          },
          occurredAt: 1,
        },
      } as unknown as MessagingSurfaceIntent),
    ).resolves.toMatchObject({ channel: "slack", outcome: "presented" });

    expect(posted.length).toBeGreaterThan(1);
    for (const post of posted) {
      expect((post.text ?? "").length).toBeLessThanOrEqual(3000);
    }
  });
});
