import { describe, expect, it } from "vitest";
import { MattermostAdapter } from "../mattermost-adapter.ts";
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
  callbackPort: 47899,
  callbackHmacSecret: "test-secret",
  authorizedActorIds: ["user-1"],
};

/**
 * Stubs that satisfy the Client4 / WebSocketClient surface the adapter
 * touches at construction + delivery time. Cast through `unknown` because
 * the real classes have ~hundreds of methods and we only need a handful.
 */
function fakeWebSocketClient(): WebSocketClient {
  return {
    addMessageListener: () => {},
    addCloseListener: () => {},
    addErrorListener: () => {},
    initialize: () => {},
    close: () => {},
    userTyping: () => {},
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
