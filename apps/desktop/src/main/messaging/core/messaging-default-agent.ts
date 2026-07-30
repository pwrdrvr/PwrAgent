import type {
  MessagingChannelRef,
  MessagingDefaultAgentScope,
} from "@pwragent/messaging-interface";

export type MessagingDefaultAgentScopeKind = MessagingDefaultAgentScope["kind"];

export function buildMessagingDefaultAgentScopeKey(
  scope: MessagingDefaultAgentScope,
): string {
  switch (scope.kind) {
    case "conversation":
      return `conversation:${buildMessagingConversationKey(scope.channel)}`;
    case "parent":
      return `parent:${JSON.stringify([scope.channel, scope.conversationId])}`;
    case "workspace":
      return `workspace:${JSON.stringify([scope.channel, scope.workspaceId])}`;
    case "provider":
      return `provider:${scope.channel}`;
    case "profile":
      return "profile";
  }
}

export function buildDefaultAgentScopeLookup(
  channel: MessagingChannelRef,
): Array<{ key: string; scope: MessagingDefaultAgentScope }> {
  const scopes: MessagingDefaultAgentScope[] = [
    {
      kind: "conversation",
      channel: {
        ...channel,
        conversation: { ...channel.conversation },
      },
    },
  ];
  if (channel.conversation.parentConversationId) {
    scopes.push({
      kind: "parent",
      channel: channel.channel,
      conversationId: channel.conversation.parentConversationId,
    });
  }
  if (channel.conversation.workspaceId) {
    scopes.push({
      kind: "workspace",
      channel: channel.channel,
      workspaceId: channel.conversation.workspaceId,
    });
  }
  scopes.push(
    { kind: "provider", channel: channel.channel },
    { kind: "profile" },
  );
  return scopes.map((scope) => ({
    key: buildMessagingDefaultAgentScopeKey(scope),
    scope,
  }));
}

export function defaultAgentScopeForChannel(
  channel: MessagingChannelRef,
  kind: MessagingDefaultAgentScopeKind,
): MessagingDefaultAgentScope | undefined {
  return buildDefaultAgentScopeLookup(channel)
    .find((candidate) => candidate.scope.kind === kind)
    ?.scope;
}

function buildMessagingConversationKey(channel: MessagingChannelRef): string {
  return [
    channel.channel,
    channel.conversation.kind,
    channel.conversation.parentId ?? "",
    channel.conversation.id,
  ].join(":");
}
