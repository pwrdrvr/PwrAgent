import {
  isAcpBackendId,
  type AppServerBackendKind,
  type BackendSummary,
} from "@pwragent/shared";
import type {
  MessagingChannelRef,
  MessagingDefaultAgentScope,
} from "@pwragent/messaging-interface";

export type MessagingDefaultAgentScopeKind = MessagingDefaultAgentScope["kind"];
export type MessagingDefaultAgentBackendSupport =
  | "supported"
  | "unsupported"
  | "unknown";

export function defaultAgentBackendSupport(
  backend: AppServerBackendKind,
  summaries: readonly BackendSummary[] | undefined,
): MessagingDefaultAgentBackendSupport {
  if (backend === "codex") {
    return "supported";
  }
  if (!isAcpBackendId(backend)) {
    return "unsupported";
  }
  const summary = summaries?.find((candidate) => candidate.kind === backend);
  if (!summary) {
    return "unknown";
  }
  return summary.acp?.runtime?.agentCapabilities?.mcp?.http === true
    ? "supported"
    : "unsupported";
}

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
    // A conversation default selected on a parent channel also governs its
    // child threads/topics unless the child has a more-specific exact or
    // explicit parent assignment. Adapters provide parentConversationId so
    // core can reconstruct this normalized lookup without reading opaque IDs.
    scopes.push({
      kind: "conversation",
      channel: {
        channel: channel.channel,
        conversation: {
          id: channel.conversation.parentConversationId,
          kind: channel.conversation.isDirectMessage === true ? "dm" : "channel",
          ...(channel.conversation.isDirectMessage === true
            ? { isDirectMessage: true }
            : {}),
          ...(channel.conversation.parentConversationParentId
            ? { parentId: channel.conversation.parentConversationParentId }
            : {}),
          ...(channel.conversation.workspaceId
            ? { workspaceId: channel.conversation.workspaceId }
            : {}),
          ...(channel.conversation.parentTitle
            ? { title: channel.conversation.parentTitle }
            : {}),
        },
      },
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
