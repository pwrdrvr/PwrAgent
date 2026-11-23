import { scopeMessagingRoutingKey, type MessagingChannelRef } from "@pwragent/messaging-interface";

export function buildMessagingConversationKey(channel: MessagingChannelRef): string {
  return scopeMessagingRoutingKey(channel.connectionId, [
    channel.channel,
    channel.conversation.kind,
    channel.conversation.parentId ?? "",
    channel.conversation.id,
  ].join(":"));
}

export function buildMessagingConversationLookupKeys(channel: MessagingChannelRef): string[] {
  const keys = new Set<string>([buildMessagingConversationKey(channel)]);
  if (channel.conversation.kind === "thread") {
    keys.add(buildMessagingConversationKey({
      ...channel,
      conversation: { ...channel.conversation, kind: "channel" },
    }));
    // Only DM threads may inherit a root identified by their own id. Slack
    // channel threads also share their root's id, but have independent bindings.
    if (channel.conversation.isDirectMessage) {
      keys.add(buildMessagingConversationKey({
        ...channel,
        conversation: { id: channel.conversation.id, kind: "dm" },
      }));
    }
    const parentId = channel.conversation.parentConversationId;
    if (parentId && parentId !== channel.conversation.id) {
      keys.add(buildMessagingConversationKey({
        ...channel,
        conversation: {
          id: parentId,
          kind: channel.conversation.isDirectMessage ? "dm" : "channel",
          parentId: channel.conversation.parentConversationParentId,
        },
      }));
    }
  }
  return [...keys];
}
