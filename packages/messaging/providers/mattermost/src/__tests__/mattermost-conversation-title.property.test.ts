import type { Client4 } from "@mattermost/client";
import type { MessagingChannelRef } from "@pwragent/messaging-interface";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { MattermostAdapter } from "../mattermost-adapter.ts";

function setup() {
  const patchChannel = vi.fn<(id: string, patch: { header: string }) => Promise<void>>()
    .mockResolvedValue(undefined);
  const adapter = new MattermostAdapter({
    client: {
      setUrl: () => {},
      setToken: () => {},
      setUserAgent: () => {},
      patchChannel,
    } as unknown as Client4,
    callbackHandleStore: {
      resolveCallbackHandle: async () => undefined,
      upsertCallbackHandle: async (record) => record,
    },
    config: {
      channel: "mattermost",
      botToken: "test-token",
      serverUrl: "https://chat.example.com",
      callbackBaseUrl: "https://callback.example.com/cb",
      callbackHmacSecret: "test-secret",
      authorizedActorIds: [],
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { adapter, patchChannel };
}

function threadUnder(channel: MessagingChannelRef, rootPostId: string): MessagingChannelRef {
  return {
    channel: "mattermost",
    conversation: {
      id: channel.conversation.id,
      kind: "thread",
      parentId: rootPostId,
      parentConversationId: channel.conversation.id,
      ...(channel.conversation.isDirectMessage ? { isDirectMessage: true } : {}),
    },
  };
}

const conversationId = fc.stringMatching(/^[a-z0-9]{26}$/);

describe("Mattermost conversation title scope", () => {
  it("does not change a parent channel header when asked to name its thread", async () => {
    const { adapter, patchChannel } = setup();
    const channel: MessagingChannelRef = {
      channel: "mattermost",
      conversation: { id: "channel-id", kind: "channel" },
    };
    const thread = threadUnder(channel, "root-post-id");
    const result = await adapter.setConversationTitle({
      channel: thread,
      title: "Wood chuck joke",
    });

    expect(patchChannel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ conversation: thread.conversation, outcome: "unsupported" });
  });

  it("updates the header of a top-level Mattermost DM", async () => {
    const { adapter, patchChannel } = setup();
    const id = "0aaaaaaa0000aaa0a00aa00000";
    const channel: MessagingChannelRef = {
      channel: "mattermost",
      conversation: { id, kind: "dm", isDirectMessage: true },
    };

    const result = await adapter.setConversationTitle({ channel, title: "A" });

    expect(patchChannel).toHaveBeenCalledExactlyOnceWith(id, { header: "A" });
    expect(result).toMatchObject({ outcome: "updated", title: "A" });
  });

  it("updates top-level channel and DM headers and leaves their threads untouched", async () => {
    await fc.assert(fc.asyncProperty(
      conversationId,
      conversationId,
      fc.stringMatching(/^[A-Z][a-z0-9 ]{0,40}$/),
      async (id, rootPostId, title) => {
        const { adapter, patchChannel } = setup();
        const channel: MessagingChannelRef = {
          channel: "mattermost",
          conversation: { id, kind: "channel" },
        };
        const dm: MessagingChannelRef = {
          channel: "mattermost",
          conversation: { id, kind: "dm", isDirectMessage: true },
        };
        const thread = threadUnder(channel, rootPostId);
        const legacyThread: MessagingChannelRef = {
          ...thread,
          conversation: { ...thread.conversation, kind: "channel" },
        };
        for (const [destination, supported] of [
          [thread, false],
          [legacyThread, false],
          [threadUnder(dm, rootPostId), false],
          [channel, true],
          [dm, true],
        ] satisfies [MessagingChannelRef, boolean][]) {
          patchChannel.mockClear();

          const result = await adapter.setConversationTitle({ channel: destination, title });

          expect(patchChannel.mock.calls).toEqual(supported ? [[id, { header: title }]] : []);
          expect(adapter.supportsConversationTitle({ channel: destination })).toBe(supported);
          expect(result.outcome).toBe(supported ? "updated" : "unsupported");
        }
      },
    ));
  });
});
