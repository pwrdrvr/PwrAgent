import { describe, expect, it } from "vitest";
import { MattermostAdapter, stripBotMention, summarizeThreadRoot } from "../mattermost-adapter.ts";
import type {
  MessagingCallbackHandleRecord,
  MessagingCallbackHandleStore,
  MessagingChannelRef,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import type { Client4, WebSocketClient } from "@mattermost/client";

const fakeStore: MessagingCallbackHandleStore = {
  resolveCallbackHandle: async () => undefined,
  upsertCallbackHandle: async (record) => record,
};

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const baseConfig = {
  channel: "mattermost" as const,
  botToken: "test-token",
  serverUrl: "https://chat.example.com",
  callbackBaseUrl: "https://callback.example.com/cb",
  callbackHmacSecret: "test-secret",
  authorizedActorIds: ["user-1"],
};

/**
 * Stubs that satisfy the Client4 / WebSocketClient surface the adapter
 * touches at construction + delivery time. Cast through `unknown` because
 * the real classes have ~hundreds of methods and we only need a handful.
 */
type WebSocketHooks = {
  fireMessage(message: { event: string; data?: Record<string, unknown> }): void;
  /** Simulate a websocket close. The adapter latches `wsErroredLatched`
   *  and fires `onRuntimeError` once `connectFailCount` reaches the
   *  threshold; tests fire incrementally to exercise both paths. */
  fireClose(connectFailCount: number): void;
};

function fakeWebSocketClient(
  spies?: { userTyping: string[] },
  hooks?: WebSocketHooks,
): WebSocketClient {
  let messageListener: ((m: { event: string; data?: Record<string, unknown> }) => void) | undefined;
  let closeListener: ((connectFailCount: number) => void) | undefined;
  if (hooks) {
    hooks.fireMessage = (m) => {
      messageListener?.(m);
    };
    hooks.fireClose = (count) => {
      closeListener?.(count);
    };
  }
  return {
    addMessageListener: (listener: typeof messageListener) => {
      messageListener = listener;
    },
    addCloseListener: (listener: typeof closeListener) => {
      closeListener = listener;
    },
    addErrorListener: () => {},
    initialize: () => {},
    close: () => {},
    userTyping: (channelId: string) => {
      spies?.userTyping.push(channelId);
    },
  } as unknown as WebSocketClient;
}

type CreatedPost = {
  channel_id: string;
  message: string;
  root_id?: string;
  props?: { attachments?: unknown[] };
  file_ids?: string[];
};

type PatchedPost = {
  id: string;
  message: string;
  props?: { attachments?: unknown[] };
  file_ids?: string[];
};

function fakeClient4(spies: {
  createdPosts: CreatedPost[];
  patchedPosts: PatchedPost[];
  postsSinceResults?: Array<{
    id: string;
    user_id: string;
    root_id?: string;
    create_at: number;
  }>;
}): Client4 {
  return {
    setUrl: () => {},
    setToken: () => {},
    setUserAgent: () => {},
    getMe: async () => ({ id: "bot-user-id" }),
    createPost: async (post: CreatedPost) => {
      spies.createdPosts.push(post);
      return { id: `post-${spies.createdPosts.length}` };
    },
    patchPost: async (post: PatchedPost) => {
      spies.patchedPosts.push(post);
      return { id: post.id };
    },
    pinPost: async () => undefined,
    getPostsSince: async () => ({
      posts: Object.fromEntries(
        (spies.postsSinceResults ?? []).map((p) => [p.id, p]),
      ),
      order: (spies.postsSinceResults ?? []).map((p) => p.id),
    }),
    // Stubs sufficient for `adapter.start()` to complete without
    // throwing — slash-command reconciliation runs against an empty
    // team list, the WS init is no-op'd by the websocket fake.
    getMyTeams: async () => [],
    getCustomTeamCommands: async () => [],
    addCommand: async (cmd: { trigger: string }) => ({
      id: `cmd-${cmd.trigger}`,
      token: `token-${cmd.trigger}`,
      ...cmd,
    }),
    editCommand: async (cmd: { id: string }) => cmd,
    deleteCommand: async () => ({ status: "OK" }),
  } as unknown as Client4;
}

describe("MattermostAdapter — capability profile", () => {
  it("declares Mattermost capability profile with documented limits", () => {
    const adapter = new MattermostAdapter({
      callbackHandleStore: fakeStore,
      config: baseConfig,
      logger: silentLogger,
      websocketClient: fakeWebSocketClient(),
    });

    const profile = adapter.capabilityProfile;
    expect(profile.actions?.maxActions).toBe(25);
    expect(profile.actions?.supportsLayoutHints).toBe(false);
    expect(profile.actions?.supportsDisabled).toBe(false);
    expect(profile.actions?.supportsStyles).toBe(true);
    expect(profile.text.maxLength).toBe(16_383);
    expect(profile.text.encoding).toBe("characters");
    expect(profile.text.markdownDialect).toBe("markdown");
    expect(profile.outboundAttachments?.supportsFileUpload).toBe(true);
    expect(profile.outboundAttachments?.maxUploadBytes).toBe(100 * 1024 * 1024);
    expect(profile.inboundAttachments?.maxAttachmentCount).toBe(10);
  });

  it("exposes the configured authorized actor IDs", () => {
    const adapter = new MattermostAdapter({
      callbackHandleStore: fakeStore,
      config: { ...baseConfig, authorizedActorIds: ["alice", "bob"] },
      logger: silentLogger,
      websocketClient: fakeWebSocketClient(),
    });
    expect(adapter.authorizedActorIds).toEqual(["alice", "bob"]);
  });

  it("declares the channel kind 'mattermost'", () => {
    const adapter = new MattermostAdapter({
      callbackHandleStore: fakeStore,
      config: baseConfig,
      logger: silentLogger,
      websocketClient: fakeWebSocketClient(),
    });
    expect(adapter.channel).toBe("mattermost");
  });
});

/**
 * Regression coverage for `resolveTarget` — the audit-channel path was
 * previously reading from a nonexistent `intent.requestContext.channel`
 * field. Telegram and Discord both read from `intent.audit?.channel`;
 * Mattermost must too.
 */
describe("MattermostAdapter — outbound deliver", () => {
  function makeAdapter(spies: {
    createdPosts: CreatedPost[];
    patchedPosts: PatchedPost[];
  }) {
    return new MattermostAdapter({
      callbackHandleStore: fakeStore,
      client: fakeClient4(spies),
      config: baseConfig,
      logger: silentLogger,
      websocketClient: fakeWebSocketClient(),
      now: () => 1_700_000_000_000,
    });
  }

  function dmChannel(id = "dm-channel-id"): MessagingChannelRef {
    return {
      channel: "mattermost",
      conversation: { id, kind: "dm" },
    };
  }

  function threadChannel(): MessagingChannelRef {
    return {
      channel: "mattermost",
      conversation: {
        id: "channel-id",
        kind: "thread",
        parentId: "root-post-id",
      },
    };
  }

  function makeMessageIntent(
    audit: { channel: MessagingChannelRef; actor?: { platformUserId: string } },
  ): MessagingSurfaceIntent {
    return {
      id: "intent-msg-1",
      kind: "message",
      createdAt: 1_700_000_000_000,
      capabilityProfile: { text: { maxLength: 16_383, encoding: "characters" } },
      parts: [{ type: "text", text: "hello" }],
      audit,
    } as unknown as MessagingSurfaceIntent;
  }

  it("resolves outbound target via intent.audit.channel (regression: f0974752)", async () => {
    const spies = { createdPosts: [] as CreatedPost[], patchedPosts: [] as PatchedPost[] };
    const adapter = makeAdapter(spies);

    const result = await adapter.deliver(
      makeMessageIntent({
        channel: dmChannel("dm-1"),
        actor: { platformUserId: "user-1" },
      }),
    );

    expect(result.outcome).toBe("presented");
    expect(spies.createdPosts).toHaveLength(1);
    expect(spies.createdPosts[0].channel_id).toBe("dm-1");
    expect(spies.createdPosts[0].message).toBe("hello");
    expect(spies.createdPosts[0].root_id).toBeUndefined();
  });

  it("returns failed outcome when neither audit.channel nor opaque postId is present", async () => {
    const spies = { createdPosts: [] as CreatedPost[], patchedPosts: [] as PatchedPost[] };
    const adapter = makeAdapter(spies);

    const result = await adapter.deliver({
      id: "intent-orphan",
      kind: "message",
      createdAt: 1_700_000_000_000,
      capabilityProfile: { text: { maxLength: 16_383, encoding: "characters" } },
      parts: [{ type: "text", text: "orphan" }],
    } as unknown as MessagingSurfaceIntent);

    expect(result.outcome).toBe("failed");
    expect(spies.createdPosts).toHaveLength(0);
  });

  it("threads replies under root_id when conversation.kind is thread", async () => {
    const spies = { createdPosts: [] as CreatedPost[], patchedPosts: [] as PatchedPost[] };
    const adapter = makeAdapter(spies);

    await adapter.deliver(
      makeMessageIntent({
        channel: threadChannel(),
        actor: { platformUserId: "user-1" },
      }),
    );

    expect(spies.createdPosts[0].channel_id).toBe("channel-id");
    expect(spies.createdPosts[0].root_id).toBe("root-post-id");
  });

  it("clears attachments on patchPost when delivery.replaceMarkup is true and intent has no buttons", async () => {
    const spies = { createdPosts: [] as CreatedPost[], patchedPosts: [] as PatchedPost[] };
    const adapter = makeAdapter(spies);

    // First, produce a surface to update — gives us a targetSurface with opaque state.
    const initial = await adapter.deliver(
      makeMessageIntent({
        channel: dmChannel(),
        actor: { platformUserId: "user-1" },
      }),
    );
    expect(initial.outcome).toBe("presented");
    expect(initial.surface).toBeDefined();

    // Now an update intent with replaceMarkup: true — our patch must
    // explicitly send props.attachments=[] so Mattermost actually drops
    // the existing buttons (PATCH semantics keep missing fields as-is).
    const update: MessagingSurfaceIntent = {
      id: "intent-update-1",
      kind: "message",
      createdAt: 1_700_000_000_000,
      capabilityProfile: { text: { maxLength: 16_383, encoding: "characters" } },
      parts: [{ type: "text", text: "edited" }],
      delivery: { mode: "update", replaceMarkup: true },
      targetSurface: initial.surface,
    } as unknown as MessagingSurfaceIntent;

    const patched = await adapter.deliver(update);
    expect(patched.outcome).toBe("updated");
    expect(spies.patchedPosts).toHaveLength(1);
    expect(spies.patchedPosts[0].props).toBeDefined();
    expect(spies.patchedPosts[0].props?.attachments).toEqual([]);
  });
});

describe("MattermostAdapter — typing indicator", () => {
  it("emits userTyping using audit.channel when the producer omits targetSurface", async () => {
    const wsSpies = { userTyping: [] as string[] };
    const adapter = new MattermostAdapter({
      callbackHandleStore: fakeStore,
      client: fakeClient4({ createdPosts: [], patchedPosts: [] }),
      config: baseConfig,
      logger: silentLogger,
      websocketClient: fakeWebSocketClient(wsSpies),
      now: () => 1_700_000_000_000,
    });

    const result = await adapter.deliver({
      id: "intent-typing-1",
      kind: "activity",
      activity: "typing",
      state: "active",
      createdAt: 1_700_000_000_000,
      audit: {
        channel: { channel: "mattermost", conversation: { id: "dm-typing", kind: "dm" } },
      },
    } as unknown as MessagingSurfaceIntent);

    expect(result.outcome).toBe("signaled");
    expect(wsSpies.userTyping).toEqual(["dm-typing"]);
  });

  it("does not call userTyping when state is idle (Mattermost has no stop-typing RPC)", async () => {
    const wsSpies = { userTyping: [] as string[] };
    const adapter = new MattermostAdapter({
      callbackHandleStore: fakeStore,
      client: fakeClient4({ createdPosts: [], patchedPosts: [] }),
      config: baseConfig,
      logger: silentLogger,
      websocketClient: fakeWebSocketClient(wsSpies),
      now: () => 1_700_000_000_000,
    });

    const result = await adapter.deliver({
      id: "intent-typing-idle",
      kind: "activity",
      activity: "typing",
      state: "idle",
      createdAt: 1_700_000_000_000,
      audit: {
        channel: { channel: "mattermost", conversation: { id: "dm-typing", kind: "dm" } },
      },
    } as unknown as MessagingSurfaceIntent);

    expect(result.outcome).toBe("signaled");
    expect(wsSpies.userTyping).toEqual([]);
  });
});

/**
 * Regression coverage for the conversation-kind round-trip. Mattermost's
 * interactive callback body has `channel_id` but no channel type; the
 * handle store keys on `channel:kind:parentId:id`, so we stash the kind
 * in `integration.context.channelKind` at delivery time and read it back
 * at callback time. (Commit 7e9c2a2d.)
 */
describe("MattermostAdapter — conversation kind round-trip", () => {
  it("persists callback handle with the correct conversation kind for DMs", async () => {
    const persisted: MessagingCallbackHandleRecord[] = [];
    const trackingStore: MessagingCallbackHandleStore = {
      resolveCallbackHandle: async () => undefined,
      upsertCallbackHandle: async (record) => {
        persisted.push(record);
        return record;
      },
    };

    const spies = { createdPosts: [] as CreatedPost[], patchedPosts: [] as PatchedPost[] };
    const adapter = new MattermostAdapter({
      callbackHandleStore: trackingStore,
      client: fakeClient4(spies),
      config: baseConfig,
      logger: silentLogger,
      websocketClient: fakeWebSocketClient(),
      now: () => 1_700_000_000_000,
    });

    // confirmation intent has actions[] — that drives a button render
    // which exercises the callback context builder.
    const intent: MessagingSurfaceIntent = {
      id: "intent-confirm-1",
      kind: "confirmation",
      createdAt: 1_700_000_000_000,
      capabilityProfile: {
        text: { maxLength: 16_383, encoding: "characters" },
        actions: { maxActions: 25, maxLabelLength: 40 },
      },
      title: "Choose",
      body: "Pick one",
      actions: [{ id: "action-resume", label: "Resume" }],
      audit: {
        channel: { channel: "mattermost", conversation: { id: "dm-id", kind: "dm" } },
        actor: { platformUserId: "user-1" },
      },
    } as unknown as MessagingSurfaceIntent;

    await adapter.deliver(intent);

    // Allow the fire-and-forget upsert to settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(persisted).toHaveLength(1);
    expect(persisted[0].channel.conversation.kind).toBe("dm");
    expect(persisted[0].channel.conversation.id).toBe("dm-id");
    expect(persisted[0].actionId).toBe("action-resume");
  });
});

/**
 * Regression coverage for the slash-command response_url path.
 * Mattermost v10.11 doesn't propagate `root_id` to outgoing webhook
 * bodies, so we route the first delivery in response to a slash
 * command via Mattermost's `response_url` endpoint instead — the
 * server posts our payload with `RootId = args.RootId` set
 * server-side, preserving thread context.
 */
describe("MattermostAdapter — slash command response_url", () => {
  it("posts to response_url and recovers post_id + root_id from getPostsSince", async () => {
    const fetchCalls: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      fetchCalls.push({
        url: String(url),
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;

    try {
      const spies = {
        createdPosts: [] as CreatedPost[],
        patchedPosts: [] as PatchedPost[],
        // Simulate Mattermost having posted our payload server-side
        // to a thread reply. Mattermost stamps the post with
        // `args.UserId` (invoker = harold), not the bot, and adds
        // `from_webhook = "true"` because we override `username` in
        // the response_url payload.
        postsSinceResults: [
          {
            id: "picker-post-1",
            user_id: "harold-user-id",
            root_id: "thread-root-1",
            create_at: 1_700_000_000_500,
            props: { from_webhook: "true" },
          },
        ],
      };
      const adapter = new MattermostAdapter({
        callbackHandleStore: fakeStore,
        client: fakeClient4(spies),
        config: { ...baseConfig, authorizedActorIds: ["harold-user-id"] },
        logger: silentLogger,
        websocketClient: fakeWebSocketClient(),
        callbackServer: { start: async () => {}, stop: async () => {}, signContext: () => ({ hmac: "x", issuedAt: 0 }) } as never,
        now: () => 1_700_000_000_000,
      });
      // start() populates botUserId via getMe() — required because
      // the response_url post-recovery filters by bot user id.
      await adapter.start(async () => {});
      // Simulate the controller delivering an intent whose
      // targetSurface carries the response_url stash from the slash
      // command. handleSlashCommand → routingState → controller →
      // intent.targetSurface.state.opaque.responseUrl.
      const intent: MessagingSurfaceIntent = {
        id: "intent-picker-1",
        kind: "thread_picker",
        createdAt: 1_700_000_000_000,
        capabilityProfile: { text: { maxLength: 16_383, encoding: "characters" } },
        prompt: "Choose a thread",
        page: { actions: [], items: [], pageIndex: 0, pageSize: 10, totalItems: 0 },
        audit: {
          channel: { channel: "mattermost", conversation: { id: "channel-1", kind: "channel" } },
          actor: { platformUserId: "harold-user-id" },
        },
        targetSurface: {
          channel: "mattermost",
          id: "slashcmd-event-1",
          state: {
            opaque: {
              responseUrl: "https://mattermost.example.com/hooks/commands/abc123",
              responseUrlInvokerUserId: "harold-user-id",
            },
          },
        },
      } as unknown as MessagingSurfaceIntent;

      const result = await adapter.deliver(intent);

      expect(result.outcome).toBe("presented");
      expect(spies.createdPosts).toHaveLength(0); // did NOT use createPost
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe(
        "https://mattermost.example.com/hooks/commands/abc123",
      );
      expect(fetchCalls[0].body).toMatchObject({
        response_type: "in_channel",
      });
      // Surface ref should reflect the recovered post_id + root_id
      // so subsequent updates target the right post in the thread.
      const opaque = (result.surface?.state?.opaque ?? {}) as Record<string, unknown>;
      expect(opaque.postId).toBe("picker-post-1");
      expect(opaque.rootId).toBe("thread-root-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to createPost when response_url POST returns non-2xx", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: false, status: 410 } as Response)) as typeof fetch;

    try {
      const spies = {
        createdPosts: [] as CreatedPost[],
        patchedPosts: [] as PatchedPost[],
      };
      const adapter = new MattermostAdapter({
        callbackHandleStore: fakeStore,
        client: fakeClient4(spies),
        config: baseConfig,
        logger: silentLogger,
        websocketClient: fakeWebSocketClient(),
        callbackServer: { start: async () => {}, stop: async () => {}, signContext: () => ({ hmac: "x", issuedAt: 0 }) } as never,
        now: () => 1_700_000_000_000,
      });
      await adapter.start(async () => {});
      const intent: MessagingSurfaceIntent = {
        id: "intent-fallback-1",
        kind: "thread_picker",
        createdAt: 1_700_000_000_000,
        capabilityProfile: { text: { maxLength: 16_383, encoding: "characters" } },
        prompt: "Choose a thread",
        page: { actions: [], items: [], pageIndex: 0, pageSize: 10, totalItems: 0 },
        audit: {
          channel: { channel: "mattermost", conversation: { id: "channel-1", kind: "channel" } },
          actor: { platformUserId: "user-1" },
        },
        targetSurface: {
          channel: "mattermost",
          id: "slashcmd-event-2",
          state: {
            opaque: {
              responseUrl: "https://mattermost.example.com/hooks/commands/expired",
            },
          },
        },
      } as unknown as MessagingSurfaceIntent;

      const result = await adapter.deliver(intent);

      expect(result.outcome).toBe("presented");
      expect(spies.createdPosts).toHaveLength(1); // fallback fired
      expect(spies.createdPosts[0].channel_id).toBe("channel-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("summarizeThreadRoot", () => {
  it("returns short messages unchanged", () => {
    expect(summarizeThreadRoot("Wood chuck joke")).toBe("Wood chuck joke");
  });

  it("collapses internal whitespace and newlines to single spaces", () => {
    expect(summarizeThreadRoot("Wood chuck\n\njoke   how much")).toBe(
      "Wood chuck joke how much",
    );
  });

  it("trims leading and trailing whitespace", () => {
    expect(summarizeThreadRoot("   spaced   ")).toBe("spaced");
  });

  it("truncates messages over 50 chars with an ellipsis", () => {
    const long = "How much wood would a woodchuck chuck if a woodchuck could chuck wood?";
    const result = summarizeThreadRoot(long);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it("returns empty string for empty / whitespace-only input", () => {
    expect(summarizeThreadRoot("")).toBe("");
    expect(summarizeThreadRoot("   \n\n\t  ")).toBe("");
  });
});

describe("stripBotMention", () => {
  it("returns undefined when text doesn't start with the mention", () => {
    expect(stripBotMention("hello world", "pwragent")).toBeUndefined();
    expect(stripBotMention("user said: @pwragent resume", "pwragent")).toBeUndefined();
  });

  it("strips the @<botUsername> prefix and returns the remainder", () => {
    expect(stripBotMention("@pwragent resume", "pwragent")).toBe("resume");
    expect(stripBotMention("@pwragent status with args", "pwragent")).toBe(
      "status with args",
    );
  });

  it("is case-insensitive on the username", () => {
    expect(stripBotMention("@PwrAgent resume", "pwragent")).toBe("resume");
    expect(stripBotMention("@pwragent resume", "PwrAgent")).toBe("resume");
  });

  it("ignores leading whitespace before the mention", () => {
    expect(stripBotMention("  @pwragent help", "pwragent")).toBe("help");
  });

  it("requires a word boundary so similar usernames don't false-match", () => {
    // `@pwragent2` is a DIFFERENT user; must not match `@pwragent`.
    expect(stripBotMention("@pwragent2 resume", "pwragent")).toBeUndefined();
  });

  it("returns undefined when only the mention appears (no verb)", () => {
    expect(stripBotMention("@pwragent", "pwragent")).toBeUndefined();
    expect(stripBotMention("@pwragent   ", "pwragent")).toBeUndefined();
  });

  it("returns undefined when botUsername is not yet set", () => {
    expect(stripBotMention("@pwragent resume", undefined)).toBeUndefined();
  });

  it("trims trailing whitespace from the remainder", () => {
    expect(stripBotMention("@pwragent  resume   ", "pwragent")).toBe("resume");
  });
});

/**
 * Regression coverage for the response_url echo loop. Mattermost's
 * server-side response_url handler stamps the resulting post with
 * the **invoking user's** user_id (not the bot's). When that post
 * broadcasts back via the WebSocket `posted` event, the standard
 * `post.user_id === botUserId` filter misses it — without additional
 * dedup, the bot's own status surface gets routed back into the
 * bound thread as inbound user text and the agent starts a turn
 * responding to its own status block.
 *
 * Verified against Mattermost release-10.11 source
 * (server/channels/app/command.go):
 *   post.UserId = args.UserId   // invoker, not bot
 *   if isBotPost { post.AddProp(PostPropsFromWebhook, "true") }
 */
describe("MattermostAdapter — response_url echo dedup", () => {
  it("does not dispatch a text event for posts we created via response_url", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, status: 200 } as Response)) as typeof fetch;

    try {
      const spies = {
        createdPosts: [] as CreatedPost[],
        patchedPosts: [] as PatchedPost[],
        // Mattermost's response_url posts have user_id = invoker
        // (harold), not the bot. Recovery filter must accommodate.
        postsSinceResults: [
          {
            id: "echoed-post-1",
            user_id: "harold-user-id",
            root_id: "thread-root-1",
            create_at: 1_700_000_000_500,
          },
        ],
      };
      const wsHooks: WebSocketHooks = {
        fireMessage: () => {},
        fireClose: () => {},
      };
      const inboundEvents: Array<{ kind: string }> = [];
      const adapter = new MattermostAdapter({
        callbackHandleStore: fakeStore,
        client: fakeClient4(spies),
        config: { ...baseConfig, authorizedActorIds: ["harold-user-id"] },
        logger: silentLogger,
        websocketClient: fakeWebSocketClient(undefined, wsHooks),
        callbackServer: {
          start: async () => {},
          stop: async () => {},
          signContext: () => ({ hmac: "x", issuedAt: 0 }),
        } as never,
        now: () => 1_700_000_000_000,
      });
      await adapter.start(async (event) => {
        inboundEvents.push({ kind: event.kind });
      });

      // Step 1: deliver a status surface via response_url.
      // Mattermost creates a post server-side with
      // UserId = invoker (harold).
      const intent: MessagingSurfaceIntent = {
        id: "intent-status-1",
        kind: "status",
        createdAt: 1_700_000_000_000,
        capabilityProfile: { text: { maxLength: 16_383, encoding: "characters" } },
        text: "Binding: Wood chuck joke (codex)",
        audit: {
          channel: { channel: "mattermost", conversation: { id: "channel-1", kind: "channel" } },
          actor: { platformUserId: "harold-user-id" },
        },
        targetSurface: {
          channel: "mattermost",
          id: "slashcmd-event-1",
          state: {
            opaque: {
              responseUrl: "https://mattermost.example.com/hooks/commands/abc123",
              responseUrlInvokerUserId: "harold-user-id",
            },
          },
        },
      } as unknown as MessagingSurfaceIntent;
      await adapter.deliver(intent);

      // Step 2: Mattermost broadcasts the post via WS posted. The
      // post is attributed to harold (not the bot). props.from_webhook
      // is "true" because the response_url payload set the username
      // override (which Mattermost recognizes as a bot post).
      wsHooks.fireMessage({
        event: "posted",
        data: {
          channel_type: "O",
          channel_display_name: "Development",
          sender_name: "harold",
          post: JSON.stringify({
            id: "echoed-post-1",
            channel_id: "channel-1",
            user_id: "harold-user-id",
            message: "Binding: Wood chuck joke (codex)",
            root_id: "thread-root-1",
            props: { from_webhook: "true" },
          }),
        },
      });
      // Allow the async listener path to settle.
      await new Promise((r) => setTimeout(r, 5));

      // Step 3: we should NOT have dispatched a text event for the
      // echoed post — it's our own response, not user input.
      const textEvents = inboundEvents.filter((e) => e.kind === "text");
      expect(textEvents).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Runtime-error fan-out — sustained websocket disconnect (bad URL,
 * server unreachable, mid-run network drop) drives `onRuntimeError`,
 * which the desktop runtime uses to flip platform health to `errored`.
 * The renderer then turns the status-bar dot red. The Mattermost icon
 * itself stays unaltered (brand guidelines require it) — that's an
 * `<img>`-vs-`<svg>` render-shape concern handled in the renderer.
 */
describe("MattermostAdapter — onRuntimeError", () => {
  function buildHooks(): WebSocketHooks {
    return {
      fireMessage: () => {},
      fireClose: () => {},
    };
  }

  async function startedAdapter(hooks: WebSocketHooks) {
    const adapter = new MattermostAdapter({
      callbackHandleStore: fakeStore,
      config: baseConfig,
      logger: silentLogger,
      // Stub the callback server so adapter.start() doesn't try to
      // bind a real HTTP listener. The cast is intentional — we only
      // exercise the websocket lifecycle here.
      callbackServer: {
        start: async () => {},
        stop: async () => {},
      } as unknown as ConstructorParameters<
        typeof MattermostAdapter
      >[0]["callbackServer"],
      websocketClient: fakeWebSocketClient(undefined, hooks),
      client: fakeClient4({ createdPosts: [], patchedPosts: [] }),
    });
    await adapter.start(async () => {});
    return adapter;
  }

  it("does not fire on transient closes below the failure threshold", async () => {
    const hooks = buildHooks();
    const adapter = await startedAdapter(hooks);
    const reasons: string[] = [];
    adapter.onRuntimeError((reason) => reasons.push(reason));

    hooks.fireClose(1);
    hooks.fireClose(2);

    expect(reasons).toEqual([]);
    await adapter.stop();
  });

  it("fires once with a descriptive reason at the threshold", async () => {
    const hooks = buildHooks();
    const adapter = await startedAdapter(hooks);
    const reasons: string[] = [];
    adapter.onRuntimeError((reason) => reasons.push(reason));

    hooks.fireClose(1);
    hooks.fireClose(2);
    hooks.fireClose(3);

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("websocket disconnected");
    expect(reasons[0]).toContain("3");
    await adapter.stop();
  });

  it("latches — does not double-fire when retries continue past the threshold", async () => {
    const hooks = buildHooks();
    const adapter = await startedAdapter(hooks);
    const reasons: string[] = [];
    adapter.onRuntimeError((reason) => reasons.push(reason));

    hooks.fireClose(3);
    hooks.fireClose(4);
    hooks.fireClose(8);

    expect(reasons).toHaveLength(1);
    await adapter.stop();
  });

  it("suppresses fan-out for closes that happen as part of stop()", async () => {
    const hooks = buildHooks();
    const adapter = await startedAdapter(hooks);
    const reasons: string[] = [];
    adapter.onRuntimeError((reason) => reasons.push(reason));

    // Real WebSocketClient.close() during stop() fires the close
    // listener too; we don't want stop()-induced closes to flap the
    // health indicator.
    let closedDuringStop = false;
    const stopPromise = adapter.stop().then(() => {
      closedDuringStop = true;
    });
    hooks.fireClose(7); // happens after stopping = true
    await stopPromise;
    expect(closedDuringStop).toBe(true);
    expect(reasons).toEqual([]);
  });

  it("re-arms after stop + start so a subsequent run can flip to errored again", async () => {
    const hooks = buildHooks();
    const adapter = await startedAdapter(hooks);
    const reasons: string[] = [];
    adapter.onRuntimeError((reason) => reasons.push(reason));

    hooks.fireClose(3);
    expect(reasons).toHaveLength(1);

    await adapter.stop();
    // stop() clears the listener set, so we must re-subscribe.
    await adapter.start(async () => {});
    adapter.onRuntimeError((reason) => reasons.push(reason));
    hooks.fireClose(3);

    expect(reasons).toHaveLength(2);
    await adapter.stop();
  });
});
