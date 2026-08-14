import { describe, expect, it, vi } from "vitest";
import {
  SlackAdapter,
  SlackSocketModeConnection,
  type SlackApi,
  type SlackStreamChunk,
  type SlackSocketClient,
} from "../slack-adapter.ts";
import type { SlackHomeView } from "../slack-home.ts";
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

function slackWorkingCardIntent(
  sequence: number,
  options: { isFinal?: boolean; key?: string; phase?: "completed" | "failed" } = {},
): MessagingSurfaceIntent {
  const isFinal = options.isFinal ?? false;
  return {
    id: `working-card-${sequence}`,
    kind: "working_card",
    bindingId: "slack-binding-1",
    createdAt: sequence,
    fallbackText: `Tool update: activity ${sequence}`,
    card: {
      displayHint: "plan",
      isFinal,
      key: options.key ?? "slack-binding-1\0turn-1",
      phase: options.phase ?? (isFinal ? "completed" : "working"),
      sequence,
      tasks: [{ id: `task-${sequence}`, title: `Activity ${sequence}`, status: "complete" }],
    },
    audit: {
      actor: { platformUserId: "U012ABCDEF0" },
      bindingId: "slack-binding-1",
      channel: {
        channel: "slack",
        conversation: {
          id: "C012ABCDEF0",
          kind: "thread",
          parentId: "1700000000.000001",
          workspaceId: "T012ABCDEF0",
        },
      },
      occurredAt: sequence,
    },
  };
}

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
  appendedStreams?: unknown[];
  bots?: Record<string, string>;
  botsInfoCalls?: string[];
  conversations?: Record<string, string>;
  mpimChannels?: string[];
  permalinks?: Record<string, string>;
  deleted?: Array<{ channel: string; ts: string }>;
  deleteErrors?: Error[];
  publishedHomes?: Array<{ userId: string; view: SlackHomeView }>;
  posted?: unknown[];
  postedChannel?: string;
  postedTimestamps?: string[];
  replies?: Record<string, string>;
  updated?: unknown[];
  startedStreams?: unknown[];
  stoppedStreams?: unknown[];
  users?: Record<string, { displayName?: string; realName?: string; username?: string }>;
}): SlackApi {
  return {
    startStream: async (params) => {
      spies.startedStreams?.push(params);
      return { channel: params.channel, ts: "1700000000.900001" };
    },
    appendStream: async (params) => {
      spies.appendedStreams?.push(params);
    },
    stopStream: async (params) => {
      spies.stoppedStreams?.push(params);
    },
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
    getPermalink: async (params) =>
      spies.permalinks?.[`${params.channel}:${params.messageTs}`],
    deleteMessage: async (params) => {
      const error = spies.deleteErrors?.shift();
      if (error) {
        throw error;
      }
      spies.deleted?.push(params);
    },
    downloadFile: async () => new Uint8Array([1, 2, 3]),
    filesInfo: async () => undefined,
    postMessage: async (params) => {
      spies.posted?.push(params);
      return {
        channel: spies.postedChannel ?? params.channel,
        ts: spies.postedTimestamps?.shift() ?? "1712023032.123456",
      };
    },
    publishHomeView: async (params) => {
      spies.publishedHomes?.push(params);
    },
    updateMessage: async (params) => {
      spies.updated?.push(params);
      return { channel: params.channel, ts: params.ts };
    },
    botsInfo: async (params) => {
      spies.botsInfoCalls?.push(params.bot);
      const name = spies.bots?.[params.bot];
      return name ? { name } : undefined;
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
  it("cancels URL discovery before a stopped Socket Mode client can connect", async () => {
    let resolveUrl!: (value: string) => void;
    const pendingUrl = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });
    const connect = vi.fn();
    const retrieveWSSURL = vi.fn(async () => await pendingUrl);
    const client = {
      disconnect: vi.fn(async () => undefined),
      off: vi.fn(),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
      retrieveWSSURL,
      start: vi.fn(async function(this: { retrieveWSSURL(): Promise<string> }) {
        const url = await this.retrieveWSSURL();
        connect(url);
      }),
    };
    const socket = new SlackSocketModeConnection(client);

    const startPromise = socket.start();
    await vi.waitFor(() => {
      expect(retrieveWSSURL).toHaveBeenCalledTimes(1);
    });
    await socket.disconnect();
    resolveUrl("wss://socket-mode.example.test");

    await expect(startPromise).rejects.toThrow(
      "Slack Socket Mode startup was cancelled.",
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("detaches socket listeners when startup is stopped before connecting", async () => {
    let rejectStart!: (reason?: unknown) => void;
    const pendingStart = new Promise<never>((_resolve, reject) => {
      rejectStart = reject;
    });
    const socket: SlackSocketClient = {
      disconnect: vi.fn(async () => undefined),
      off: vi.fn(),
      on: vi.fn(),
      start: vi.fn(async () => await pendingStart),
    };
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({}),
      socketClient: socket,
    });

    const startPromise = adapter.start(async () => undefined);
    await vi.waitFor(() => {
      expect(socket.start).toHaveBeenCalledTimes(1);
    });
    await adapter.stop();

    expect(socket.off).toHaveBeenCalledTimes(3);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    rejectStart(new Error("socket rejected after stop"));
    await expect(startPromise).rejects.toThrow("socket rejected after stop");
  });

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
    expect(adapter.capabilityProfile.text.markdownDialect).toBe("markdown");
  });

  it("publishes App Home for authorized users during startup", async () => {
    const publishedHomes: Array<{ userId: string; view: SlackHomeView }> = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ publishedHomes }),
      socketClient: fakeSocket(),
    });

    await adapter.start(async () => undefined);

    expect(publishedHomes).toHaveLength(1);
    expect(publishedHomes[0]).toMatchObject({
      userId: "U012ABCDEF0",
      view: { type: "home" },
    });
    expect(JSON.stringify(publishedHomes[0]?.view)).toContain(
      "https://pwragent.ai/assets/logo.png",
    );
  });

  it("skips authorized bot actors when publishing App Homes", async () => {
    const publishedHomes: Array<{ userId: string; view: SlackHomeView }> = [];
    const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedActorIds: [
          ...baseConfig.authorizedActorIds,
          { id: "B012DATADOG", displayName: "Datadog" },
        ],
      },
      callbackHandleStore: fakeStore(),
      api: fakeApi({ publishedHomes }),
      logger: {
        warn: (message, data) => {
          warnings.push({ message, data });
        },
      },
      socketClient: fakeSocket(),
    });

    await adapter.start(async () => undefined);

    expect(publishedHomes.map((home) => home.userId)).toEqual([
      "U012ABCDEF0",
    ]);
    expect(warnings).toEqual([]);
  });

  it("acknowledges App Home opens and refreshes the user's Home tab", async () => {
    const publishedHomes: Array<{ userId: string; view: SlackHomeView }> = [];
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ publishedHomes }),
      socketClient: socket,
    });
    const events: MessagingInboundEvent[] = [];
    await adapter.start(async (event) => {
      events.push(event);
    });
    publishedHomes.length = 0;
    let acknowledged = false;

    await socket.emitEvent("slack_event", {
      ack: async () => {
        acknowledged = true;
      },
      event: {
        type: "app_home_opened",
        tab: "home",
        user: "U012ABCDEF0",
      },
    });

    expect(acknowledged).toBe(true);
    expect(events).toEqual([]);
    expect(publishedHomes).toHaveLength(1);
    expect(publishedHomes[0]?.userId).toBe("U012ABCDEF0");
  });

  it("keeps Slack messaging available when App Home publishing fails", async () => {
    const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const api = fakeApi({});
    api.publishHomeView = async () => {
      throw new Error("not_enabled");
    };
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api,
      logger: {
        warn: (message, data) => {
          warnings.push({ message, data });
        },
      },
      socketClient: fakeSocket(),
    });

    await expect(adapter.start(async () => undefined)).resolves.toBeUndefined();
    expect(warnings).toContainEqual({
      message: "slack App Home publish failed",
      data: { reason: "not_enabled" },
    });
  });

  it("posts assistant Markdown tables through Slack's native Markdown block", async () => {
    const posted: unknown[] = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ posted }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const text = [
      "The Ruby cluster has recovered.",
      "",
      "| Signal | Alert period | Current/post-recovery |",
      "|---|---:|---:|",
      "| Search rejections | Two sharp increments | [Monitor](https://example.com) is `OK` |",
      "| Ruby CPU | Hottest node 80% | Hottest node 63% |",
      "",
      "No immediate resource adjustment is needed.",
    ].join("\n");

    await expect(
      adapter.deliver({
        id: "assistant-table",
        kind: "message",
        createdAt: 1,
        role: "assistant",
        parts: [{ type: "text", text, markdown: "markdown" }],
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

    expect(posted).toEqual([
      expect.objectContaining({
        channel: "D012ABCDEF0",
        blocks: [{ type: "markdown", text }],
      }),
    ]);
  });

  it("creates a bindable Slack thread from the invoking root message", async () => {
    const posted: unknown[] = [];
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({
        conversations: { C012ABCDEF0: "signals-chat" },
        permalinks: {
          "C012ABCDEF0:1712023030.000000":
            "https://pwrdrvr.slack.com/archives/C012ABCDEF0/p1712023030000000",
        },
        posted,
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
        type: "app_mention",
        channel: "C012ABCDEF0",
        channel_type: "channel",
        team: "T012ABCDEF0",
        ts: "1712023030.000000",
        user: "U012ABCDEF0",
        text: "<@U0BOTUSERID> inspect my open PRs",
      },
    });

    const source = events[0]!;
    expect(source.sourceUrl).toBe(
      "https://pwrdrvr.slack.com/archives/C012ABCDEF0/p1712023030000000",
    );
    await expect(adapter.getManagedConversationRights({
      actor: source.actor,
      channel: source.channel,
      routingState: source.routingState,
    })).resolves.toMatchObject({
      channel: "slack",
      operations: [
        {
          operation: "create_child",
          supported: true,
        },
      ],
      outcome: "ok",
    });

    const created = await adapter.createManagedConversation({
      actor: source.actor,
      parent: source.channel,
      routingState: source.routingState,
      title: "CATALOG API PR status",
    });
    expect(created).toMatchObject({
      channel: "slack",
      conversation: {
        id: "C012ABCDEF0",
        kind: "thread",
        parentId: "1712023030.000000",
        parentConversationId: "C012ABCDEF0",
        parentTitle: "signals-chat",
        title: "CATALOG API PR status",
        workspaceId: "T012ABCDEF0",
      },
      outcome: "created",
      routingState: {
        opaque: {
          channelId: "C012ABCDEF0",
          teamId: "T012ABCDEF0",
          threadTs: "1712023030.000000",
        },
      },
    });

    await adapter.deliver({
      id: "thread-status",
      kind: "status",
      createdAt: 1,
      status: "working",
      text: "Working on recent PRs",
      targetSurface: {
        channel: "slack",
        id: "slack-thread",
        state: created.routingState!,
      },
    });

    expect(posted).toEqual([
      expect.objectContaining({
        channel: "C012ABCDEF0",
        text: "Working on recent PRs",
        thread_ts: "1712023030.000000",
      }),
    ]);
  });

  it("resolves and delivers a private response to an inbound Slack actor", async () => {
    const posted: unknown[] = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ posted, postedChannel: "D012PRIVATE0" }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const source = {
      channel: "slack" as const,
      conversation: {
        id: "C012ABCDEF0",
        kind: "channel" as const,
        title: "signals-chat",
        workspaceId: "T012ABCDEF0",
      },
    };

    const resolved = await adapter.resolvePrivateConversation({
      actor: {
        platformUserId: "U012ABCDEF0",
        displayName: "Alice",
      },
      source,
      routingState: {
        opaque: {
          channelId: "C012ABCDEF0",
          teamId: "T012ABCDEF0",
        },
      },
    });

    expect(resolved).toEqual({
      channel: "slack",
      conversation: {
        id: "U012ABCDEF0",
        isDirectMessage: true,
        kind: "dm",
        title: "Alice",
        workspaceId: "T012ABCDEF0",
      },
      outcome: "resolved",
      routingState: {
        opaque: {
          channelId: "U012ABCDEF0",
          teamId: "T012ABCDEF0",
        },
      },
      updatedAt: 1_700_000_000_000,
    });
    if (resolved.outcome !== "resolved" || !resolved.conversation) {
      throw new Error("Expected a resolved private Slack conversation");
    }

    const privateIntent = {
      id: "private-response",
      kind: "message",
      createdAt: 1,
      role: "assistant",
      attribution: {
        label: "Signals Agent",
        hint: "Private Request · Reply in Thread to Respond to this Agent",
      },
      parts: [{ type: "text", text: "Private details", markdown: "markdown" }],
      audit: {
        actor: { platformUserId: "U012ABCDEF0" },
        channel: {
          channel: "slack",
          conversation: resolved.conversation,
        },
        occurredAt: 1,
      },
      targetSurface: {
        channel: "slack",
        id: "private-response-target",
        state: resolved.routingState,
      },
    } satisfies MessagingSurfaceIntent;
    expect(adapter.resolveDeliveryScope(privateIntent)).toMatchObject({
      budget: { limit: 60, reserved: 0 },
      kind: "dm",
      label: "Slack DM",
    });

    await expect(adapter.deliver(privateIntent)).resolves.toMatchObject({
      channel: "slack",
      continuation: {
        channel: {
          channel: "slack",
          conversation: {
            id: "D012PRIVATE0",
            isDirectMessage: true,
            kind: "thread",
            parentConversationId: "D012PRIVATE0",
            parentId: "1712023032.123456",
            workspaceId: "T012ABCDEF0",
          },
        },
        routingState: {
          opaque: {
            channelId: "D012PRIVATE0",
            teamId: "T012ABCDEF0",
            threadTs: "1712023032.123456",
          },
        },
      },
      outcome: "presented",
    });

    expect(posted).toEqual([
      expect.objectContaining({
        channel: "U012ABCDEF0",
        text: "Private details",
        blocks: expect.arrayContaining([
          {
            type: "context",
            elements: [{
              type: "plain_text",
              text:
                "Signals Agent · Private Request · Reply in Thread to Respond to this Agent",
              emoji: true,
            }],
          },
        ]),
      }),
    ]);
  });

  it("rejects reply continuations that Slack DM policy would reject", async () => {
    const source = {
      channel: "slack" as const,
      conversation: {
        id: "C012ABCDEF0",
        kind: "channel" as const,
        workspaceId: "T012ABCDEF0",
      },
    };
    const unlistedActor = {
      platformUserId: "U999UNLISTED",
      displayName: "Unlisted User",
    };
    const restrictedAdapter = new SlackAdapter({
      config: {
        ...baseConfig,
        channelUserAccessMode: "any_channel_user",
        dmAccessMode: "authorized_users",
      },
      callbackHandleStore: fakeStore(),
      api: fakeApi({}),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });

    await expect(restrictedAdapter.resolvePrivateConversation({
      actor: unlistedActor,
      replyContinuationRequired: true,
      source,
    })).resolves.toMatchObject({
      outcome: "unsupported",
      errorMessage: expect.stringContaining("DM access policy"),
    });
    await expect(restrictedAdapter.resolvePrivateConversation({
      actor: unlistedActor,
      source,
    })).resolves.toMatchObject({ outcome: "resolved" });

    const closedAdapter = new SlackAdapter({
      config: { ...baseConfig, dmAccessMode: "none" },
      callbackHandleStore: fakeStore(),
      api: fakeApi({}),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    await expect(closedAdapter.resolvePrivateConversation({
      actor: { platformUserId: "U012ABCDEF0", displayName: "Alice" },
      replyContinuationRequired: true,
      source,
    })).resolves.toMatchObject({
      outcome: "unsupported",
      errorMessage: expect.stringContaining("DM access policy"),
    });
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

  it("uploads data images and renders remote images as Slack blocks", async () => {
    const posted: unknown[] = [];
    const uploads: Array<{
      channel: string;
      data: Uint8Array;
      filename: string;
      mimeType?: string;
      threadTs?: string;
      title?: string;
    }> = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: {
        ...fakeApi({ posted }),
        uploadFile: async (params) => {
          uploads.push(params);
        },
      },
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });

    await adapter.deliver({
      id: "message-images",
      kind: "message",
      createdAt: 1,
      role: "assistant",
      parts: [
        { type: "text", text: "Final screenshots" },
        {
          type: "image",
          url: "data:image/png;base64,AQID",
          alt: "Local screenshot",
        },
        {
          type: "image",
          url: "https://example.com/remote.png",
          alt: "Remote screenshot",
        },
      ],
      audit: {
        actor: { platformUserId: "U012ABCDEF0" },
        channel: {
          channel: "slack",
          conversation: { id: "D012ABCDEF0", kind: "dm" },
        },
        occurredAt: 1,
      },
    });

    expect(posted).toEqual([
      expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: "image",
            image_url: "https://example.com/remote.png",
            alt_text: "Remote screenshot",
          }),
        ]),
      }),
    ]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      channel: "D012ABCDEF0",
      filename: "image-2.png",
      mimeType: "image/png",
      title: "Local screenshot",
    });
    expect(Array.from(uploads[0]?.data ?? [])).toEqual([1, 2, 3]);
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

  it("updates a project picker in place without repeating its prompt", async () => {
    const posted: unknown[] = [];
    const updated: Array<{
      blocks?: Array<{ text?: { text?: string } }>;
      channel: string;
      text?: string;
      ts: string;
    }> = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ posted, updated }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const prompt =
      "Choose a project for the new PwrAgent thread. Page 1/2.\n"
      + "Tap a project to start a fresh thread there.";
    const fallbackText =
      `${prompt}\n1. pwragent (11)\nReply with a number, or reply next or cancel.`;

    await expect(
      adapter.deliver({
        id: "project-picker-1",
        kind: "project_picker",
        browseSessionId: "browse-1",
        createdAt: 1,
        delivery: {
          mode: "update",
          fallback: "present_new",
        },
        fallbackText,
        navigation: {
          backend: "all",
          fetchedAt: 1,
          unchanged: false,
        },
        page: {
          actions: [
            {
              id: "browse:select-project",
              label: "1. pwragent (11)",
              value: { directoryKey: "directory:pwragent", label: "pwragent" },
            },
          ],
          items: [],
          pageIndex: 0,
          pageSize: 8,
          totalItems: 11,
        },
        prompt,
        targetSurface: {
          channel: "slack",
          id: "1712023032.123456",
          state: {
            opaque: {
              channelId: "C012ABCDEF0",
              ts: "1712023032.123456",
            },
          },
        },
      } satisfies MessagingSurfaceIntent),
    ).resolves.toMatchObject({
      channel: "slack",
      outcome: "updated",
    });

    expect(posted).toEqual([]);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      channel: "C012ABCDEF0",
      text: fallbackText,
      ts: "1712023032.123456",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: prompt,
          },
        },
        expect.objectContaining({ type: "actions" }),
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

  it("fetches recent channel messages for preview, oldest-first", async () => {
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: {
        ...fakeApi({}),
        conversationsHistory: async () => [
          { ts: "1712023032.000200", text: "newest", bot_id: "B012DATADOG" },
          { ts: "1712023032.000100", text: "older", user: "U2", username: "alice" },
          { ts: "1712023032.000050", subtype: "channel_join", text: "joined" },
        ],
      },
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });

    const events = await adapter.fetchRecentMessages({
      conversationId: "C012ABCDEF0",
    });

    expect(
      events.map((event) => (event.kind === "text" ? event.text : undefined)),
    ).toEqual(["older", "newest"]);
    expect(events[0]).toMatchObject({
      kind: "text",
      actor: { platformUserId: "U2" },
      channel: {
        channel: "slack",
        conversation: { id: "C012ABCDEF0", kind: "channel" },
      },
    });
    expect(events[1]?.actor).toMatchObject({
      platformUserId: "B012DATADOG",
      isBot: true,
    });
  });

  it("returns no preview messages when history scope is missing", async () => {
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: {
        ...fakeApi({}),
        conversationsHistory: async () => {
          throw new Error("missing_scope");
        },
      },
      socketClient: fakeSocket(),
      now: () => 1,
    });

    expect(
      await adapter.fetchRecentMessages({ conversationId: "C012ABCDEF0" }),
    ).toEqual([]);
  });

  it("preview mirrors the live message filter (skips own posts, keeps file_share and bot_message)", async () => {
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: {
        ...fakeApi({}),
        conversationsHistory: async () => [
          { ts: "1712023032.000500", text: "own bot post", bot_id: "B0PWRAGENT" },
          { ts: "1712023032.000400", text: "own user post", user: "U0BOTUSERID" },
          {
            ts: "1712023032.000300",
            subtype: "bot_message",
            text: "other bot via bot_message",
            bot_id: "B012DATADOG",
          },
          {
            ts: "1712023032.000200",
            subtype: "file_share",
            text: "shared a file",
            user: "U2",
            username: "alice",
          },
          { ts: "1712023032.000100", text: "normal message", user: "U3", username: "bob" },
        ],
      },
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    // start() runs authTest, setting botId=B0PWRAGENT / botUserId=U0BOTUSERID.
    await adapter.start(async () => undefined);

    const events = await adapter.fetchRecentMessages({
      conversationId: "C012ABCDEF0",
    });

    // Own posts stay filtered. Other bots' bot_message posts survive — they
    // are the alert senders inbound automations exist to watch — alongside
    // file_share and plain user messages, oldest-first.
    expect(
      events.map((event) => (event.kind === "text" ? event.text : undefined)),
    ).toEqual([
      "normal message",
      "shared a file",
      "other bot via bot_message",
    ]);
  });

  it("delivers classic bot_message posts with attachment text folded in", async () => {
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
    // The channel-user gate defaults to authorized_users, and the bot isn't an
    // authorized actor — the desktop runtime marks the conversation observed
    // because an enabled automation watches it, which is what lets the alert
    // through (flagged observedOnly).
    adapter.updateObservedConversations(["C012ABCDEF0"]);

    // A classic integration alert: subtype bot_message, empty top-level text,
    // content entirely in attachments — the exact shape Spinnaker and Datadog
    // post. The actor must be the B… bot id, because that is what the event
    // carries (sender filters must be able to match it).
    await socket.emitEvent("slack_event", {
      ack: async () => undefined,
      event: {
        type: "message",
        subtype: "bot_message",
        channel: "C012ABCDEF0",
        channel_type: "channel",
        team: "T012ABCDEF0",
        bot_id: "B012SPINNKR",
        ts: "1712023032.000600",
        text: "",
        attachments: [
          {
            title: "Pipeline failed for CATALOGAPI",
            text: "Catalog API's catalog-api-prod pipeline has failed",
          },
        ],
      },
    });

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.kind).toBe("text");
    expect(event?.actor.platformUserId).toBe("B012SPINNKR");
    expect(event?.actor.isBot).toBe(true);
    expect(event?.observedOnly).toBe(true);
    if (event?.kind === "text") {
      expect(event.text).toContain("Pipeline failed for CATALOGAPI");
      expect(event.text).toContain("catalog-api-prod pipeline has failed");
    }
  });

  it("names bot senders from the event's bot_profile without an API lookup", async () => {
    const socket = fakeSocket();
    const botsInfoCalls: string[] = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ botsInfoCalls }),
      socketClient: socket,
      now: () => 1_700_000_000_000,
    });
    const events: MessagingInboundEvent[] = [];
    await adapter.start(async (event) => {
      events.push(event);
    });
    adapter.updateObservedConversations(["C012ABCDEF0"]);

    await socket.emitEvent("slack_event", {
      ack: async () => undefined,
      event: {
        type: "message",
        subtype: "bot_message",
        channel: "C012ABCDEF0",
        channel_type: "channel",
        team: "T012ABCDEF0",
        bot_id: "B012SPINNKR",
        bot_profile: { name: "Spinnaker" },
        ts: "1712023032.000800",
        text: "Pipeline complete",
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.actor.platformUserId).toBe("B012SPINNKR");
    expect(events[0]?.actor.displayName).toBe("Spinnaker");
    expect(botsInfoCalls).toEqual([]);
  });

  it("falls back to bots.info for bot names and caches the answer", async () => {
    const socket = fakeSocket();
    const botsInfoCalls: string[] = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ bots: { B012DATADOG: "Datadog" }, botsInfoCalls }),
      socketClient: socket,
      now: () => 1_700_000_000_000,
    });
    const events: MessagingInboundEvent[] = [];
    await adapter.start(async (event) => {
      events.push(event);
    });
    adapter.updateObservedConversations(["C012ABCDEF0"]);

    for (const ts of ["1712023032.000900", "1712023032.001000"]) {
      await socket.emitEvent("slack_event", {
        ack: async () => undefined,
        event: {
          type: "message",
          subtype: "bot_message",
          channel: "C012ABCDEF0",
          channel_type: "channel",
          team: "T012ABCDEF0",
          bot_id: "B012DATADOG",
          ts,
          text: "Monitor triggered",
        },
      });
    }

    expect(events).toHaveLength(2);
    expect(events[0]?.actor.displayName).toBe("Datadog");
    expect(events[1]?.actor.displayName).toBe("Datadog");
    // One lookup, then the cache answers — bots.info is rate-limited and the
    // same integrations post repeatedly.
    expect(botsInfoCalls).toEqual(["B012DATADOG"]);
  });

  it("drops unauthorized-sender messages in conversations nothing observes", async () => {
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
        subtype: "bot_message",
        channel: "C012ABCDEF0",
        channel_type: "channel",
        team: "T012ABCDEF0",
        bot_id: "B012SPINNKR",
        ts: "1712023032.000700",
        text: "unwatched alert",
      },
    });

    // Fail-closed stands: no observation grant means no forwarding.
    expect(events).toEqual([]);
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
        sourceUrl:
          "https://slack.com/app_redirect?channel=C012ABCDEF0&team=T012ABCDEF0",
      }),
    ]);
  });

  it("uses the Socket Mode envelope team ID to authorize file shares", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedConversationIds: [{ id: "C012ABCDEF0", displayName: "dev" }],
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
      body: {
        type: "event_callback",
        team_id: "T012ABCDEF0",
        event: {
          type: "message",
          subtype: "file_share",
          channel: "C012ABCDEF0",
          channel_type: "channel",
          thread_ts: "1712023031.123456",
          ts: "1712023032.123456",
          user: "U012ABCDEF0",
          text: "Please inspect this screenshot",
          files: [{
            id: "F012ABCDEF0",
            mimetype: "image/png",
            name: "screenshot.png",
          }],
        },
      },
    });

    expect(rejected).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "media",
        text: "Please inspect this screenshot",
        attachments: [
          expect.objectContaining({
            id: "F012ABCDEF0",
            kind: "image",
            name: "screenshot.png",
          }),
        ],
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "C012ABCDEF0",
            kind: "thread",
            parentId: "1712023031.123456",
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

  it("routes app mentions that appear after other message content", async () => {
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
        text: ":thread: <@U0BOTUSERID> attach the search thread",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "text",
        botMention: true,
        text: ":thread: attach the search thread",
      }),
    ]);
  });

  it("preserves line breaks around a mid-message app mention", async () => {
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
        text: "context:\n<@U0BOTUSERID> explain this",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "text",
        botMention: true,
        text: "context:\nexplain this",
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

  it("preserves mention detection when message arrives before app_mention", async () => {
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
      text: "show `<@U0BOTUSERID>` literally, then <@U0BOTUSERID> help",
    };

    await socket.emitEvent("slack_event", {
      ack: async () => undefined,
      event: {
        ...event,
        type: "message",
      },
    });
    await socket.emitEvent("slack_event", {
      ack: async () => undefined,
      event: {
        ...event,
        type: "app_mention",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "text",
        botMention: true,
        text: "show `<@U0BOTUSERID>` literally, then help",
      }),
    ]);
  });

  it.each([
    ["inline", "show `<@U0BOTUSERID>` literally"],
    ["fenced", "```\n<@U0BOTUSERID>\n```"],
  ])("does not treat bot tokens in %s code as mentions", async (_kind, text) => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: { ...baseConfig, responseMode: "mention_only" },
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
        text,
      },
    });

    expect(events).toEqual([
      expect.objectContaining({ kind: "text", text }),
    ]);
    expect(events[0]).not.toHaveProperty("botMention");
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

  it("normalizes an operator-configured Slack schedule command", async () => {
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
        command: "/pwragent_schedule",
        team_id: "T012ABCDEF0",
        text: "2h Follow up",
        user_id: "U012ABCDEF0",
        user_name: "alice",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "command",
        command: "schedule",
        args: ["2h", "Follow", "up"],
        rawText: "/pwragent_schedule 2h Follow up",
      }),
    ]);
  });

  it("uses users.info full names and handles for DM origins", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedActorIds: [{ id: "U012ABCDEF0", displayName: "Harold" }],
      },
      callbackHandleStore: fakeStore(),
      api: fakeApi({
        users: {
          U012ABCDEF0: {
            displayName: "Harold",
            realName: "Harold Hunt",
            username: "hhunt",
          },
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
          username: "hhunt",
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

  it("preserves a configured name when users.info only resolves a handle", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedActorIds: [{
          id: "U012ABCDEF0",
          displayName: "Harold Hunt",
        }],
      },
      callbackHandleStore: fakeStore(),
      api: fakeApi({
        users: {
          U012ABCDEF0: { username: "hhunt" },
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
          username: "hhunt",
        }),
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            kind: "dm",
            title: "Harold Hunt",
          }),
        }),
      }),
    ]);
  });

  it("uses a persisted username when users.info is unavailable", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedActorIds: [{
          id: "U012ABCDEF0",
          displayName: "Harold Hunt",
          username: "hhunt",
        }],
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
          username: "hhunt",
        }),
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            kind: "dm",
            title: "Harold Hunt",
          }),
        }),
      }),
    ]);
  });

  it("uses contact metadata received through a hot authorization update", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedActorIds: [{
          id: "U012ABCDEF0",
          displayName: "Harold",
        }],
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
    await adapter.updateAuthorization({
      authorizedActorIds: ["U012ABCDEF0"],
      authorizedActors: [{
        platformUserId: "U012ABCDEF0",
        displayName: "Harold Hunt",
        username: "hhunt",
      }],
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
          username: "hhunt",
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

  it("ignores ambient channel chatter from unauthorized actors", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({
        conversations: { C012ABCDEF0: "p-search-signals-projects" },
      }),
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
        user: "U099ZZZZZZZ",
        text: "ordinary conversation between channel members",
      },
    });

    expect(events).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it("ignores ambient file shares from unauthorized channel actors", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: baseConfig,
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
        subtype: "file_share",
        channel: "C012ABCDEF0",
        channel_type: "channel",
        team: "T012ABCDEF0",
        ts: "1712023032.123456",
        user: "U099ZZZZZZZ",
        text: "sharing this with the channel",
        files: [{
          id: "F012ABCDEF0",
          mimetype: "image/png",
          name: "chart.png",
        }],
      },
    });

    expect(events).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it("marks unauthorized bot mentions with the resolved channel title", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({
        conversations: { C012ABCDEF0: "p-search-signals-projects" },
      }),
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
        type: "app_mention",
        channel: "C012ABCDEF0",
        channel_type: "channel",
        team: "T012ABCDEF0",
        ts: "1712023032.123456",
        user: "U099ZZZZZZZ",
        text: "<@U0BOTUSERID> can you help?",
      },
    });

    expect(rejected).toEqual([
      expect.objectContaining({
        botMention: true,
        kind: "text",
        reason: "unauthorized-actor",
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "C012ABCDEF0",
            title: "p-search-signals-projects",
          }),
        }),
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

  it("does not treat a regular channel named mpdm-… as a group DM (no name-based gate bypass)", async () => {
    const socket = fakeSocket();
    // Lock the team/channel gates with empty allowlists and open group DMs, so
    // a channel classified as a group DM would be accepted (authorized user)
    // while a channel subject to the team/channel gates is rejected. The slash
    // payload carries only a *name* — "mpdm-…" here — which is attacker-
    // influenceable and must NOT drive classification: conversations.info
    // (is_mpim: false) is authoritative, so this stays a channel and is gated.
    const adapter = new SlackAdapter({
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

    await socket.emitEvent("slash_commands", {
      ack: async () => undefined,
      body: {
        channel_id: "C0SPOOFCHAN",
        channel_name: "mpdm-spoof-not-a-group-dm",
        command: "/status",
        team_id: "T012ABCDEF0",
        text: "",
        user_id: "U012ABCDEF0",
        user_name: "alice",
      },
    });

    expect(events).toEqual([]);
    expect(rejected).toEqual([
      expect.objectContaining({ reason: "unauthorized-conversation" }),
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
            isDirectMessage: true,
            kind: "dm",
          }),
        }),
      }),
    ]);
  });

  it("preserves direct-message access for replies in a DM thread", async () => {
    const socket = fakeSocket();
    const adapter = new SlackAdapter({
      config: {
        ...baseConfig,
        authorizedConversationIds: [],
        authorizedTeamIds: [],
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
        channel: "D012ABCDEF0",
        channel_type: "im",
        team: "T012ABCDEF0",
        thread_ts: "1712023032.123456",
        ts: "1712023033.123456",
        user: "U012ABCDEF0",
        text: "reply without mentioning the bot",
      },
    });

    expect(rejected).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "text",
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "D012ABCDEF0",
            isDirectMessage: true,
            kind: "thread",
            parentConversationId: "D012ABCDEF0",
            parentId: "1712023032.123456",
          }),
        }),
      }),
    ]);
    expect(events[0]).not.toHaveProperty("botMention");
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
        type: "app_mention",
        channel: "C012ABCDEF0",
        channel_type: "channel",
        team: "TEXTERNAL",
        ts: "1712023032.123456",
        user: "U012ABCDEF0",
        text: "<@U0BOTUSERID> blocked shared channel request",
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
        type: "app_mention",
        channel: "C012ABCDEF0",
        channel_type: "channel",
        team: "T012ABCDEF0",
        ts: "1712023036.123456",
        user: "UNOTLISTED0",
        text: "<@U0BOTUSERID> unlisted user in an approved channel",
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
        sourceSurface: {
          channel: "slack",
          id: "1712023032.123456",
          state: {
            opaque: expect.objectContaining({
              channelId: "D012ABCDEF0",
              ts: "1712023032.123456",
            }),
          },
        },
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

  it("edits streaming Markdown tables through Slack's native Markdown block", async () => {
    const posted: unknown[] = [];
    const updated: unknown[] = [];
    const adapter = new SlackAdapter({
      config: { ...baseConfig, streamingResponses: true },
      callbackHandleStore: fakeStore(),
      api: fakeApi({ posted, updated }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const text = [
      "Current state:",
      "",
      "| Signal | Current |",
      "|---|---:|",
      "| Search queue | 1 |",
      "| Ruby CPU | 50% |",
    ].join("\n");

    await expect(
      adapter.deliver({
        id: "assistant-stream-table",
        kind: "stream_update",
        bindingId: "slack-binding-1",
        createdAt: 1,
        role: "assistant",
        markdown: "markdown",
        policy: "enabled",
        text,
        stream: { isFinal: true, key: "codex:thread-1:turn-1", sequence: 1 },
        targetSurface: {
          channel: "slack",
          id: "1712023032.123456",
          state: {
            opaque: { channelId: "C012ABCDEF0", ts: "1712023032.123456" },
          },
        },
      } satisfies MessagingSurfaceIntent),
    ).resolves.toMatchObject({ channel: "slack", outcome: "updated" });

    expect(posted).toEqual([]);
    expect(updated).toEqual([
      expect.objectContaining({
        channel: "C012ABCDEF0",
        ts: "1712023032.123456",
        blocks: [{ type: "markdown", text }],
      }),
    ]);
  });

  it("posts the first stream chunk then edits it for the rest of the turn", async () => {
    const posted: Array<{ channel: string; text?: string }> = [];
    const updated: Array<{
      blocks?: Array<{ text?: string; type: string }>;
      channel: string;
      ts: string;
      text?: string;
    }> = [];
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

    // Final chunk has the same text but changes from plain streaming text to
    // canonical Markdown. It must still edit the message to replace the legacy
    // mrkdwn section with Slack's native Markdown block.
    await expect(
      adapter.deliver({
        id: "assistant-stream-final",
        kind: "stream_update",
        bindingId: "slack-binding-1",
        createdAt: 3,
        role: "assistant",
        markdown: "markdown",
        policy: "enabled",
        text: "Partial answer",
        stream: { isFinal: true, key: "codex:thread-1:turn-1", sequence: 3 },
        audit,
      } satisfies MessagingSurfaceIntent),
    ).resolves.toMatchObject({ channel: "slack", outcome: "updated" });

    // Exactly one post (the first chunk) and two edits — one Slack message.
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ channel: "D012ABCDEF0" });
    expect(updated).toHaveLength(2);
    expect(updated.every((u) => u.ts === "1712023032.123456")).toBe(true);
    expect(updated[1]?.blocks).toEqual([
      { type: "markdown", text: "Partial answer" },
    ]);
  });

  it("rolls a streaming Markdown response longer than a Markdown block onto extra messages", async () => {
    const posted: Array<{
      blocks?: Array<{ text?: string; type: string }>;
      channel: string;
      text?: string;
    }> = [];
    const updated: Array<{ channel: string; ts: string; text?: string }> = [];
    const adapter = new SlackAdapter({
      config: { ...baseConfig, streamingResponses: true },
      callbackHandleStore: fakeStore(),
      api: fakeApi({ posted, updated }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    // > 12,000 chars (Slack standard-Markdown block limit), split at sentence
    // boundaries without falling back to legacy 3,000-char sections.
    const longText = "This is a full sentence that keeps going. ".repeat(320);

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
    for (const post of posted) {
      expect(post.blocks).toEqual([
        expect.objectContaining({ type: "markdown" }),
      ]);
      expect(post.blocks?.[0]?.text?.length ?? 0).toBeLessThanOrEqual(12_000);
    }
  });

  it("consolidates interim stream messages when final Markdown needs fewer blocks", async () => {
    const deleted: Array<{ channel: string; ts: string }> = [];
    const posted: unknown[] = [];
    const updated: Array<{
      blocks?: Array<{ text?: string; type: string }>;
      channel: string;
      ts: string;
      text?: string;
    }> = [];
    const adapter = new SlackAdapter({
      config: { ...baseConfig, streamingResponses: true },
      callbackHandleStore: fakeStore(),
      api: fakeApi({ deleted, posted, updated }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const text = "This is a full sentence that keeps going. ".repeat(220);
    const audit = {
      actor: { platformUserId: "U012ABCDEF0" },
      bindingId: "slack-binding-1",
      channel: {
        channel: "slack" as const,
        conversation: { id: "D012ABCDEF0", kind: "dm" as const },
      },
      occurredAt: 1,
    };

    await adapter.deliver({
      id: "assistant-stream-interim",
      kind: "stream_update",
      bindingId: "slack-binding-1",
      createdAt: 1,
      role: "assistant",
      markdown: "plain",
      policy: "enabled",
      text,
      stream: { isFinal: false, key: "codex:thread-1:turn-1", sequence: 1 },
      audit,
    } satisfies MessagingSurfaceIntent);
    const interimPostCount = posted.length;
    expect(interimPostCount).toBeGreaterThan(1);

    await expect(
      adapter.deliver({
        id: "assistant-stream-final",
        kind: "stream_update",
        bindingId: "slack-binding-1",
        createdAt: 2,
        role: "assistant",
        markdown: "markdown",
        policy: "enabled",
        text,
        stream: { isFinal: true, key: "codex:thread-1:turn-1", sequence: 2 },
        audit,
      } satisfies MessagingSurfaceIntent),
    ).resolves.toMatchObject({ channel: "slack", outcome: "updated" });

    expect(updated.at(-1)?.blocks).toEqual([
      { type: "markdown", text },
    ]);
    expect(deleted).toHaveLength(interimPostCount - 1);
  });

  it("retains obsolete stream anchors when final-message cleanup fails", async () => {
    const deleted: Array<{ channel: string; ts: string }> = [];
    const deleteErrors = [new Error("temporary delete failure")];
    const posted: unknown[] = [];
    const updated: unknown[] = [];
    const adapter = new SlackAdapter({
      config: { ...baseConfig, streamingResponses: true },
      callbackHandleStore: fakeStore(),
      api: fakeApi({ deleted, deleteErrors, posted, updated }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const text = "This is a full sentence that keeps going. ".repeat(220);
    const audit = {
      actor: { platformUserId: "U012ABCDEF0" },
      bindingId: "slack-binding-1",
      channel: {
        channel: "slack" as const,
        conversation: { id: "D012ABCDEF0", kind: "dm" as const },
      },
      occurredAt: 1,
    };

    await adapter.deliver({
      id: "assistant-stream-interim",
      kind: "stream_update",
      bindingId: "slack-binding-1",
      createdAt: 1,
      role: "assistant",
      markdown: "plain",
      policy: "enabled",
      text,
      stream: { isFinal: false, key: "codex:thread-1:turn-1", sequence: 1 },
      audit,
    } satisfies MessagingSurfaceIntent);
    const interimPostCount = posted.length;
    expect(interimPostCount).toBeGreaterThan(1);

    const finalIntent = {
      id: "assistant-stream-final",
      kind: "stream_update",
      bindingId: "slack-binding-1",
      createdAt: 2,
      role: "assistant",
      markdown: "markdown",
      policy: "enabled",
      text,
      stream: { isFinal: true, key: "codex:thread-1:turn-1", sequence: 2 },
      audit,
    } satisfies MessagingSurfaceIntent;

    await expect(adapter.deliver(finalIntent)).resolves.toMatchObject({
      channel: "slack",
      outcome: "failed",
      errorMessage: "temporary delete failure",
    });
    expect(deleted).toEqual([]);

    await expect(adapter.deliver(finalIntent)).resolves.toMatchObject({
      channel: "slack",
      outcome: "updated",
    });
    expect(deleted).toHaveLength(interimPostCount - 1);
  });

  it("splits a long Markdown message across native Markdown posts", async () => {
    const deleted: Array<{ channel: string; ts: string }> = [];
    const posted: Array<{
      blocks?: Array<{ text?: string; type: string }>;
      channel: string;
      text?: string;
    }> = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({
        deleted,
        posted,
        postedTimestamps: [
          "1712023032.000001",
          "1712023032.000002",
          "1712023032.000003",
        ],
      }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const longText = "This is a full sentence that keeps going. ".repeat(320);

    const result = await adapter.deliver({
      id: "assistant-message-1",
      kind: "message",
      createdAt: 1,
      role: "assistant",
      parts: [{ type: "text", text: longText, markdown: "markdown" }],
      audit: {
        actor: { platformUserId: "U012ABCDEF0" },
        bindingId: "slack-binding-1",
        channel: {
          channel: "slack",
          conversation: { id: "D012ABCDEF0", kind: "dm" },
        },
        occurredAt: 1,
      },
    } as unknown as MessagingSurfaceIntent);

    expect(result).toMatchObject({
      channel: "slack",
      outcome: "presented",
      surface: {
        state: {
          opaque: {
            messageTimestamps: [
              "1712023032.000001",
              "1712023032.000002",
            ],
          },
        },
      },
    });

    expect(posted.length).toBeGreaterThan(1);
    for (const post of posted) {
      expect(post.blocks).toEqual([
        expect.objectContaining({ type: "markdown" }),
      ]);
      expect(post.blocks?.[0]?.text?.length ?? 0).toBeLessThanOrEqual(12_000);
    }

    await expect(adapter.deliver({
      id: "dismiss-assistant-message-1",
      kind: "dismiss",
      createdAt: 2,
      reason: "terminal_private_response",
      targetSurface: result.surface!,
    })).resolves.toMatchObject({ outcome: "dismissed" });
    expect(deleted).toEqual(
      (result.surface!.state!.opaque as { messageTimestamps: string[] })
        .messageTimestamps
        .map((ts) => ({ channel: "D012ABCDEF0", ts })),
    );
  });

  it("streams one sequenced Thinking Steps card and drops stale updates", async () => {
    const appendedStreams: unknown[] = [];
    const startedStreams: unknown[] = [];
    const stoppedStreams: unknown[] = [];
    const adapter = new SlackAdapter({
      config: { ...baseConfig, liveWorkingCards: true },
      callbackHandleStore: fakeStore(),
      api: fakeApi({ appendedStreams, startedStreams, stoppedStreams }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const intent = (sequence: number, isFinal = false): MessagingSurfaceIntent => ({
      id: `working-card-${sequence}`,
      kind: "working_card",
      bindingId: "slack-binding-1",
      createdAt: sequence,
      fallbackText: "Tool update: searched files",
      card: {
        displayHint: "plan",
        isFinal,
        key: "slack-binding-1\0turn-1",
        phase: isFinal ? "completed" : "working",
        sequence,
        tasks: Array.from({ length: sequence }, (_, index) => ({
          detail: "0ms",
          id: `task-${index + 1}`,
          title: `Activity ${index + 1}: ${"x".repeat(300)}`,
          status: "complete" as const,
        })),
      },
      audit: {
        actor: { platformUserId: "U012ABCDEF0" },
        bindingId: "slack-binding-1",
        channel: {
          channel: "slack",
          conversation: {
            id: "C012ABCDEF0",
            kind: "thread",
            parentId: "1700000000.000001",
            workspaceId: "T012ABCDEF0",
          },
        },
        occurredAt: sequence,
      },
    });

    await expect(adapter.deliver(intent(1))).resolves.toMatchObject({ outcome: "presented" });
    await expect(adapter.deliver(intent(1))).resolves.toMatchObject({ outcome: "discarded" });
    await expect(adapter.deliver(intent(2))).resolves.toMatchObject({ outcome: "updated" });
    await expect(adapter.deliver(intent(3, true))).resolves.toMatchObject({ outcome: "updated" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(startedStreams).toHaveLength(1);
    expect(appendedStreams).toHaveLength(1);
    expect(stoppedStreams).toHaveLength(1);
    expect(JSON.stringify(startedStreams[0])).not.toContain("x".repeat(257));
    expect((startedStreams[0] as { chunks: SlackStreamChunk[] }).chunks)
      .toEqual([expect.objectContaining({
        id: expect.stringMatching(/^pwragent:[a-f0-9]{16}:1$/),
        details: "0ms",
      })]);
    expect((appendedStreams[0] as { chunks: SlackStreamChunk[] }).chunks)
      .toEqual([expect.objectContaining({
        id: expect.stringMatching(/^pwragent:[a-f0-9]{16}:2$/),
        details: "0ms",
      })]);
    expect((stoppedStreams[0] as { chunks: SlackStreamChunk[] }).chunks)
      .toEqual([expect.objectContaining({
        id: expect.stringMatching(/^pwragent:[a-f0-9]{16}:3$/),
        details: "0ms",
      })]);
  });

  it("anchors a channel-root Agent Route card to its inbound user message", async () => {
    const startedStreams: unknown[] = [];
    const adapter = new SlackAdapter({
      config: { ...baseConfig, liveWorkingCards: true },
      callbackHandleStore: fakeStore(),
      api: fakeApi({ startedStreams }),
      socketClient: fakeSocket(),
    });
    const intent = slackWorkingCardIntent(1);
    if (intent.kind !== "working_card") throw new Error("expected working card");
    intent.audit = {
      ...intent.audit!,
      channel: {
        channel: "slack",
        conversation: {
          id: "C012ABCDEF0",
          kind: "channel",
          workspaceId: "T012ABCDEF0",
        },
      },
    };
    intent.targetSurface = {
      channel: "slack",
      id: "slack-inbound-1",
      state: {
        opaque: {
          channelId: "C012ABCDEF0",
          teamId: "T012ABCDEF0",
          ts: "1700000000.000099",
        },
      },
    };

    await expect(adapter.deliver(intent)).resolves.toMatchObject({
      outcome: "presented",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(startedStreams).toEqual([
      expect.objectContaining({
        channel: "C012ABCDEF0",
        recipientTeamId: "T012ABCDEF0",
        recipientUserId: "U012ABCDEF0",
        threadTs: "1700000000.000099",
      }),
    ]);
  });

  it("renders waiting visibly and closes cancelled tasks without an error state", async () => {
    const appendedStreams: unknown[] = [];
    const startedStreams: unknown[] = [];
    const adapter = new SlackAdapter({
      config: { ...baseConfig, liveWorkingCards: true },
      callbackHandleStore: fakeStore(),
      api: fakeApi({ appendedStreams, startedStreams }),
      socketClient: fakeSocket(),
    });
    const first = slackWorkingCardIntent(1);
    if (first.kind !== "working_card") throw new Error("expected working card");
    first.card.tasks = [{
      detail: "Cancelled · 1.2s",
      id: "task-cancelled",
      status: "cancelled",
      title: "Deploy production",
    }];
    const waiting = {
      ...first,
      id: "working-card-waiting",
      card: {
        ...first.card,
        phase: "waiting" as const,
        sequence: 2,
      },
    };

    await adapter.deliver(first);
    await adapter.deliver(waiting);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const startedChunks = (startedStreams[0] as {
      chunks: SlackStreamChunk[];
    }).chunks;
    expect(startedChunks).toContainEqual(expect.objectContaining({
      details: "Cancelled · 1.2s",
      status: "complete",
      title: "Deploy production",
      type: "task_update",
    }));
    const appendedChunks = (appendedStreams[0] as {
      chunks: SlackStreamChunk[];
    }).chunks;
    expect(appendedChunks).toContainEqual({
      markdown_text: "*Waiting for your input*",
      type: "markdown_text",
    });
  });

  it("falls back to the classic text Working Update without stream APIs", async () => {
    const posted: unknown[] = [];
    const api = fakeApi({ posted });
    api.startStream = undefined;
    api.appendStream = undefined;
    api.stopStream = undefined;
    const adapter = new SlackAdapter({
      config: { ...baseConfig, liveWorkingCards: true },
      callbackHandleStore: fakeStore(),
      api,
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });

    await expect(adapter.deliver({
      id: "working-card-fallback",
      kind: "working_card",
      createdAt: 1,
      fallbackText: "Tool update: searched files",
      card: {
        displayHint: "plan",
        isFinal: false,
        key: "fallback-turn",
        phase: "working",
        sequence: 1,
        tasks: [{ id: "task-1", title: "Searched files", status: "complete" }],
      },
      audit: {
        actor: { platformUserId: "U012ABCDEF0" },
        channel: {
          channel: "slack",
          conversation: {
            id: "C012ABCDEF0",
            kind: "thread",
            parentId: "1700000000.000001",
          },
        },
        occurredAt: 1,
      },
    })).resolves.toMatchObject({ outcome: "presented" });

    expect(posted).toHaveLength(1);
    expect(JSON.stringify(posted[0])).toContain("Tool update: searched files");
  });

  it("keeps Live Working Cards opt-in and uses classic updates when unspecified", async () => {
    const posted: unknown[] = [];
    const startedStreams: unknown[] = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ posted, startedStreams }),
      socketClient: fakeSocket(),
    });

    await expect(adapter.deliver(slackWorkingCardIntent(1))).resolves.toMatchObject({
      outcome: "presented",
    });

    expect(posted).toHaveLength(1);
    expect(startedStreams).toEqual([]);
  });

  it("keeps native card calls off the ordinary message budget but budgets fallback text", () => {
    const nativeAdapter = new SlackAdapter({
      config: { ...baseConfig, liveWorkingCards: true },
      callbackHandleStore: fakeStore(),
      api: fakeApi({}),
      socketClient: fakeSocket(),
    });
    const fallbackApi = fakeApi({});
    fallbackApi.startStream = undefined;
    fallbackApi.appendStream = undefined;
    fallbackApi.stopStream = undefined;
    const fallbackAdapter = new SlackAdapter({
      config: { ...baseConfig, liveWorkingCards: true },
      callbackHandleStore: fakeStore(),
      api: fallbackApi,
      socketClient: fakeSocket(),
    });
    const intent = slackWorkingCardIntent(1);

    expect(nativeAdapter.resolveDeliveryScope(intent)).toBeUndefined();
    expect(fallbackAdapter.resolveDeliveryScope(intent)).toMatchObject({
      id: "slack:channel:C012ABCDEF0",
      budget: { limit: 30, intervalMs: 60_000, reserved: 5 },
    });
  });

  it("does not post empty waiting or terminal text fallbacks", async () => {
    const posted: unknown[] = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ posted }),
      socketClient: fakeSocket(),
    });
    const waiting = slackWorkingCardIntent(2);
    if (waiting.kind !== "working_card") throw new Error("expected working card");
    waiting.card.phase = "waiting";
    waiting.fallbackText = "";

    await expect(adapter.deliver(waiting)).resolves.toMatchObject({
      outcome: "discarded",
    });
    const terminal = {
      ...waiting,
      id: "working-card-terminal-fallback",
      card: {
        ...waiting.card,
        isFinal: true,
        phase: "completed",
        sequence: 3,
      },
    } satisfies MessagingSurfaceIntent;
    expect(adapter.resolveDeliveryScope(terminal)).toBeUndefined();
    await expect(adapter.deliver(terminal)).resolves.toMatchObject({
      outcome: "discarded",
    });
    expect(posted).toEqual([]);
  });

  it("moves native-degraded cards back onto the channel budget", async () => {
    const posted: unknown[] = [];
    const api = fakeApi({ posted });
    api.startStream = async () => {
      throw new Error("missing_scope");
    };
    const adapter = new SlackAdapter({
      config: { ...baseConfig, liveWorkingCards: true },
      callbackHandleStore: fakeStore(),
      api,
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const first = slackWorkingCardIntent(1, { key: "degraded-turn" });

    expect(adapter.resolveDeliveryScope(first)).toBeUndefined();
    await adapter.deliver(first);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(posted).toHaveLength(1);

    const second = slackWorkingCardIntent(2, { key: "degraded-turn" });
    expect(adapter.resolveDeliveryScope(second)).toMatchObject({
      id: "slack:channel:C012ABCDEF0",
      budget: { limit: 30, intervalMs: 60_000, reserved: 5 },
    });
    await expect(adapter.deliver(second)).resolves.toMatchObject({
      outcome: "presented",
    });
    expect(posted).toHaveLength(2);

    const terminal = slackWorkingCardIntent(3, {
      isFinal: true,
      key: "degraded-turn",
    });
    expect(adapter.resolveDeliveryScope(terminal)).toBeUndefined();

    await adapter.deliver(slackWorkingCardIntent(1, { key: "second-degraded-turn" }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(posted).toHaveLength(2);
  });

  it("falls back with the latest snapshot when a pending start fails", async () => {
    const posted: Array<{ text?: string }> = [];
    let rejectStart!: (error: Error) => void;
    const startResult = new Promise<never>((_resolve, reject) => {
      rejectStart = reject;
    });
    const api = fakeApi({ posted });
    api.startStream = async () => await startResult;
    const adapter = new SlackAdapter({
      config: { ...baseConfig, liveWorkingCards: true },
      callbackHandleStore: fakeStore(),
      api,
      socketClient: fakeSocket(),
    });

    await adapter.deliver(slackWorkingCardIntent(1, { key: "slow-start" }));
    await adapter.deliver(slackWorkingCardIntent(2, { key: "slow-start" }));
    rejectStart(new Error("missing_scope"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(posted).toHaveLength(1);
    expect(posted[0]?.text).toContain("activity 2");
    expect(posted[0]?.text).not.toContain("activity 1");
  });

  it("preserves assistant standard Markdown in classic card fallbacks", async () => {
    const posted: Array<{
      blocks?: Array<{ type: string }>;
      text?: string;
    }> = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ posted }),
      socketClient: fakeSocket(),
    });
    const intent = slackWorkingCardIntent(1);
    if (intent.kind !== "working_card") throw new Error("expected working card");
    intent.fallbackText = "| Result |\n| --- |\n| Passed |";
    intent.card.fallbackPresentation = {
      markdown: "markdown",
      role: "assistant",
    };

    await adapter.deliver(intent);

    expect(posted[0]?.blocks).toEqual([
      expect.objectContaining({ type: "markdown" }),
    ]);
  });

  it("returns a retractable surface and cancels an open working card", async () => {
    const deleted: Array<{ channel: string; ts: string }> = [];
    const adapter = new SlackAdapter({
      config: { ...baseConfig, liveWorkingCards: true },
      callbackHandleStore: fakeStore(),
      api: fakeApi({ deleted }),
      socketClient: fakeSocket(),
    });

    const result = await adapter.deliver(slackWorkingCardIntent(1));
    await Promise.resolve();
    await Promise.resolve();

    expect(result).toMatchObject({
      outcome: "presented",
      surface: {
        state: { opaque: { workingCardKey: "slack-binding-1\0turn-1" } },
      },
    });
    await expect(adapter.deliver({
      id: "dismiss-working-card",
      kind: "dismiss",
      createdAt: 2,
      reason: "terminal_private_response",
      targetSurface: result.surface!,
    })).resolves.toMatchObject({ outcome: "dismissed" });
    expect(deleted).toEqual([{
      channel: "C012ABCDEF0",
      ts: "1700000000.900001",
    }]);
  });

  it("retracts a card whose queued start resolves after cancellation", async () => {
    const deleted: Array<{ channel: string; ts: string }> = [];
    let resolveStart!: () => void;
    const startRelease = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const api = fakeApi({ deleted });
    api.startStream = async (params) => {
      await startRelease;
      return { channel: params.channel, ts: "1700000000.900002" };
    };
    const adapter = new SlackAdapter({
      config: { ...baseConfig, liveWorkingCards: true },
      callbackHandleStore: fakeStore(),
      api,
      socketClient: fakeSocket(),
    });

    const result = await adapter.deliver(slackWorkingCardIntent(1, {
      key: "pending-start-turn",
    }));
    await expect(adapter.deliver({
      id: "dismiss-pending-working-card",
      kind: "dismiss",
      createdAt: 2,
      reason: "terminal_private_response",
      targetSurface: result.surface!,
    })).resolves.toMatchObject({ outcome: "dismissed" });
    expect(deleted).toEqual([]);

    resolveStart();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(deleted).toEqual([{
      channel: "C012ABCDEF0",
      ts: "1700000000.900002",
    }]);
  });

  it("keeps a terminal sequence tombstone and renders failed turns as errors", async () => {
    const startedStreams: unknown[] = [];
    const stoppedStreams: Array<{ chunks?: Array<{ status: string; title: string }> }> = [];
    const adapter = new SlackAdapter({
      config: { ...baseConfig, liveWorkingCards: true },
      callbackHandleStore: fakeStore(),
      api: fakeApi({ startedStreams, stoppedStreams }),
      socketClient: fakeSocket(),
    });

    await adapter.deliver(slackWorkingCardIntent(1));
    await adapter.deliver(slackWorkingCardIntent(3, {
      isFinal: true,
      phase: "failed",
    }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(stoppedStreams[0]?.chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "error", title: "Turn failed" }),
      ]),
    );
    await expect(adapter.deliver(slackWorkingCardIntent(2))).resolves.toMatchObject({
      outcome: "discarded",
    });
    expect(startedStreams).toHaveLength(1);
  });

  it("deletes and tombstones a card after bounded terminal stop failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const deleted: Array<{ channel: string; ts: string }> = [];
      let stopAttempts = 0;
      const api = fakeApi({ deleted });
      api.stopStream = async () => {
        stopAttempts += 1;
        throw new Error("service_unavailable");
      };
      const adapter = new SlackAdapter({
        config: { ...baseConfig, liveWorkingCards: true },
        callbackHandleStore: fakeStore(),
        api,
        socketClient: fakeSocket(),
      });

      await adapter.deliver(slackWorkingCardIntent(1));
      await Promise.resolve();
      await Promise.resolve();
      await adapter.deliver(slackWorkingCardIntent(2, { isFinal: true }));
      await Promise.resolve();
      expect(stopAttempts).toBe(1);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(stopAttempts).toBe(2);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(stopAttempts).toBe(3);
      expect(deleted).toEqual([{
        channel: "C012ABCDEF0",
        ts: "1700000000.900001",
      }]);
      await expect(adapter.deliver(slackWorkingCardIntent(1))).resolves
        .toMatchObject({ outcome: "discarded" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops rate-limited card appends without retrying or posting text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const posted: unknown[] = [];
      let appendAttempts = 0;
      const api = fakeApi({ posted });
      api.appendStream = async () => {
        appendAttempts += 1;
        throw Object.assign(new Error("rate_limited"), {
          status: 429,
          retryAfterMs: 60_000,
        });
      };
      const adapter = new SlackAdapter({
        config: { ...baseConfig, liveWorkingCards: true },
        callbackHandleStore: fakeStore(),
        api,
        socketClient: fakeSocket(),
      });

      await adapter.deliver(slackWorkingCardIntent(1));
      await Promise.resolve();
      await Promise.resolve();
      await adapter.deliver(slackWorkingCardIntent(2));
      await Promise.resolve();
      await Promise.resolve();
      expect(appendAttempts).toBe(1);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(appendAttempts).toBe(1);
      expect(posted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses twelve mounted task slots when older card history is collapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const appendedStreams: Array<{ chunks: SlackStreamChunk[] }> = [];
      const startedStreams: Array<{ chunks: SlackStreamChunk[] }> = [];
      const adapter = new SlackAdapter({
        config: { ...baseConfig, liveWorkingCards: true },
        callbackHandleStore: fakeStore(),
        api: fakeApi({ appendedStreams, startedStreams }),
        socketClient: fakeSocket(),
      });

      for (let sequence = 1; sequence <= 13; sequence += 1) {
        const intent = slackWorkingCardIntent(sequence, { key: "bounded-card" });
        if (intent.kind !== "working_card") throw new Error("expected working card");
        const firstVisible = Math.max(1, sequence - 11);
        intent.card.tasks = Array.from(
          { length: sequence - firstVisible + 1 },
          (_, index) => ({
            id: `activity-${firstVisible + index}`,
            title: `Activity ${firstVisible + index}`,
            status: "complete" as const,
            ...(sequence > 12 && index === 0
              ? { detail: `${sequence - 12} earlier step` }
              : {}),
          }),
        );
        await adapter.deliver(intent);
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1_000);
      }

      const allChunks = [
        ...(startedStreams[0]?.chunks ?? []),
        ...appendedStreams.flatMap((call) => call.chunks),
      ].filter((chunk) => chunk.type === "task_update");
      expect(new Set(allChunks.map((chunk) => chunk.id)).size).toBe(12);
      expect(appendedStreams.at(-1)?.chunks).toHaveLength(12);
      expect(appendedStreams.at(-1)?.chunks[0]).toMatchObject({
        details: "1 earlier step",
        title: "Activity 2",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues a rate-limited card start while approvals and questionnaires bypass it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const posted: unknown[] = [];
      let startAttempts = 0;
      const api = fakeApi({ posted });
      api.startStream = async (params) => {
        startAttempts += 1;
        if (startAttempts === 1) {
          throw Object.assign(new Error("rate_limited"), {
            status: 429,
            retryAfterMs: 5_000,
          });
        }
        return { channel: params.channel, ts: "1700000000.900001" };
      };
      const adapter = new SlackAdapter({
        config: { ...baseConfig, liveWorkingCards: true },
        callbackHandleStore: fakeStore(),
        api,
        socketClient: fakeSocket(),
      });

      await adapter.deliver(slackWorkingCardIntent(1));
      await Promise.resolve();
      await Promise.resolve();
      expect(startAttempts).toBe(1);

      await adapter.deliver({
        id: "approval-during-card-cooldown",
        kind: "approval",
        bindingId: "slack-binding-1",
        createdAt: 2,
        title: "Approve command",
        body: "Run the requested command?",
        decisions: [{
          id: "approve",
          label: "Approve",
          decision: "accept",
        }],
        audit: slackWorkingCardIntent(1).audit,
      });
      await adapter.deliver({
        id: "questionnaire-during-card-cooldown",
        kind: "questionnaire",
        bindingId: "slack-binding-1",
        createdAt: 3,
        answers: [null],
        currentIndex: 0,
        phase: "answering",
        questions: [{
          id: "mode",
          question: "Which mode?",
          options: [{ id: "safe", label: "Safe" }],
        }],
        audit: slackWorkingCardIntent(1).audit,
      });

      expect(posted).toHaveLength(2);
      expect(startAttempts).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(startAttempts).toBe(2);
      await adapter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops locally throttled card updates and lets terminal stop supersede them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const appendedStreams: Array<{
        chunks: Array<{ id: string }>;
      }> = [];
      const stoppedStreams: unknown[] = [];
      const adapter = new SlackAdapter({
        config: { ...baseConfig, liveWorkingCards: true },
        callbackHandleStore: fakeStore(),
        api: fakeApi({ appendedStreams, stoppedStreams }),
        socketClient: fakeSocket(),
      });

      await adapter.deliver(slackWorkingCardIntent(1));
      await Promise.resolve();
      await Promise.resolve();
      await adapter.deliver(slackWorkingCardIntent(2));
      await Promise.resolve();
      await Promise.resolve();
      await adapter.deliver(slackWorkingCardIntent(3));
      await adapter.deliver(slackWorkingCardIntent(4));

      expect(appendedStreams).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(appendedStreams).toHaveLength(1);

      await adapter.deliver(slackWorkingCardIntent(5));
      await Promise.resolve();
      await Promise.resolve();
      expect(appendedStreams).toHaveLength(2);
      await adapter.deliver(slackWorkingCardIntent(6, { isFinal: true }));
      await Promise.resolve();
      await Promise.resolve();
      expect(stoppedStreams).toHaveLength(1);
      expect(appendedStreams).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares method budgets across simultaneous working cards", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const startedStreams: Array<{
        chunks: Array<{ id: string }>;
      }> = [];
      const appendedStreams: Array<{
        chunks: Array<{ id: string }>;
      }> = [];
      const stoppedStreams: Array<{
        chunks: Array<{ id: string }>;
      }> = [];
      const adapter = new SlackAdapter({
        config: { ...baseConfig, liveWorkingCards: true },
        callbackHandleStore: fakeStore(),
        api: fakeApi({ appendedStreams, startedStreams, stoppedStreams }),
        socketClient: fakeSocket(),
      });
      const first = (sequence: number, isFinal = false) =>
        slackWorkingCardIntent(sequence, {
          isFinal,
          key: "slack-binding-1\0turn-1",
        });
      const second = (sequence: number, isFinal = false) =>
        slackWorkingCardIntent(sequence, {
          isFinal,
          key: "slack-binding-1\0turn-2",
        });

      await adapter.deliver(first(1));
      await adapter.deliver(second(1));
      await Promise.resolve();
      await Promise.resolve();

      expect(startedStreams).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(startedStreams).toHaveLength(2);

      await adapter.deliver(first(2));
      await adapter.deliver(second(2));
      await Promise.resolve();
      await Promise.resolve();

      expect(appendedStreams).toHaveLength(1);

      await adapter.deliver(first(3, true));
      await adapter.deliver(second(3, true));
      await Promise.resolve();
      await Promise.resolve();

      // Stop has its own workspace budget, so one terminal call proceeds even
      // though the second append was discarded. Each lifecycle method still
      // serializes calls shared by all cards on this adapter.
      expect(stoppedStreams).toHaveLength(1);
      expect(appendedStreams).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(stoppedStreams).toHaveLength(2);
      expect(appendedStreams).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("splits long Markdown with images and attaches them to the final post", async () => {
    const posted: Array<{
      blocks?: Array<{ image_url?: string; text?: string; type: string }>;
      channel: string;
      text?: string;
    }> = [];
    const uploads: Array<{ threadTs?: string }> = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: {
        ...fakeApi({ posted }),
        uploadFile: async (params) => {
          uploads.push(params);
        },
      },
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const longText = `${"This is a full sentence that keeps going. ".repeat(320)}END`;

    await expect(adapter.deliver({
      id: "assistant-message-with-images",
      kind: "message",
      createdAt: 1,
      role: "assistant",
      parts: [
        { type: "text", text: longText, markdown: "markdown" },
        { type: "image", url: "https://example.com/remote.png", alt: "Remote" },
        { type: "image", url: "data:image/png;base64,AQID", alt: "Local" },
      ],
      audit: {
        actor: { platformUserId: "U012ABCDEF0" },
        bindingId: "slack-binding-1",
        channel: {
          channel: "slack",
          conversation: { id: "D012ABCDEF0", kind: "dm" },
        },
        occurredAt: 1,
      },
    } satisfies MessagingSurfaceIntent)).resolves.toMatchObject({
      channel: "slack",
      outcome: "presented",
    });

    expect(posted.length).toBeGreaterThan(1);
    expect(posted.at(-1)?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "image",
        image_url: "https://example.com/remote.png",
      }),
    ]));
    expect(
      posted.slice(0, -1).flatMap((post) => post.blocks ?? [])
        .some((block) => block.type === "image"),
    ).toBe(false);
    expect(posted.at(-1)?.blocks?.[0]?.text).toContain("END");
    expect(uploads).toHaveLength(1);
  });

  it("keeps oversized Markdown tables renderable across native Markdown posts", async () => {
    const posted: Array<{
      blocks?: Array<{ text?: string; type: string }>;
      channel: string;
      text?: string;
    }> = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ posted }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const header = "| Signal | Alert period | Current/post-recovery |";
    const delimiter = "|---|---|---|";
    const rows = Array.from(
      { length: 240 },
      (_, index) =>
        `| Signal ${index + 1} | Alert detail ${"high ".repeat(6)}| Recovery detail |`,
    );
    const text = [header, delimiter, ...rows].join("\n");

    await expect(
      adapter.deliver({
        id: "assistant-long-table",
        kind: "message",
        createdAt: 1,
        role: "assistant",
        parts: [{ type: "text", text, markdown: "markdown" }],
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

    expect(posted.length).toBeGreaterThan(1);
    for (const post of posted) {
      const markdown = post.blocks?.[0]?.text ?? "";
      expect(post.blocks?.[0]?.type).toBe("markdown");
      expect(markdown.split("\n").slice(0, 2)).toEqual([header, delimiter]);
      expect(markdown.length).toBeLessThanOrEqual(12_000);
    }
  });

  it("splits legacy messages by encoded mrkdwn length without truncation", async () => {
    const posted: Array<{
      blocks?: Array<{ text?: { text?: string }; type: string }>;
      channel: string;
      text?: string;
    }> = [];
    const adapter = new SlackAdapter({
      config: baseConfig,
      callbackHandleStore: fakeStore(),
      api: fakeApi({ posted }),
      socketClient: fakeSocket(),
      now: () => 1_700_000_000_000,
    });
    const text = "<".repeat(3_000);

    await expect(
      adapter.deliver({
        id: "assistant-legacy-escaped",
        kind: "message",
        createdAt: 1,
        role: "assistant",
        parts: [{ type: "text", text, markdown: "plain" }],
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

    expect(posted.length).toBeGreaterThan(1);
    const rendered = posted.map((post) => post.blocks?.[0]?.text?.text ?? "");
    expect(rendered.join("")).toBe("&lt;".repeat(3_000));
    for (const chunk of rendered) {
      expect(chunk.length).toBeLessThanOrEqual(3_000);
    }
  });
});
