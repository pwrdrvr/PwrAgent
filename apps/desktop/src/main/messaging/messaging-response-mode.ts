import type {
  MessagingChannelKind,
  MessagingChannelRef,
  MessagingResponseMode,
} from "@pwragent/messaging-interface";
import type { DesktopMessagingConfig } from "./messaging-config";

type MessagingResponseModeEntry = {
  id: string;
  responseMode: MessagingResponseMode;
};

export type MessagingResponseModeSnapshot = {
  resolve(params: {
    bindingResponseMode?: MessagingResponseMode;
    channelRef: MessagingChannelRef;
  }): MessagingResponseMode;
};

/**
 * Capture only the live response-routing policy needed by an inbound message.
 *
 * The full desktop messaging config carries credentials and is loaded from the
 * Settings service. Admission must not reload that config: `readSettings()`
 * also discovers agent runtimes, Git/GitHub commands, and desktop apps. The
 * runtime owns this narrow snapshot and replaces it when it hot-applies a
 * response-mode configuration change.
 */
export function createMessagingResponseModeSnapshot(params: {
  channel: MessagingChannelKind;
  config: DesktopMessagingConfig;
}): MessagingResponseModeSnapshot {
  const policy = responseModePolicy(params);
  return {
    resolve: ({ bindingResponseMode, channelRef }) => {
      if (bindingResponseMode) {
        return bindingResponseMode;
      }

      const conversation = channelRef.conversation;
      switch (policy.channel) {
        case "discord": {
          const conversationMode = responseModeForIds(
            policy.conversationModes,
            [conversation.id, conversation.parentConversationId],
          );
          const guildMode = responseModeForIds(
            policy.workspaceModes,
            [conversation.workspaceId ?? conversation.parentId],
          );
          return conversationMode ?? guildMode ?? policy.defaultMode;
        }
        case "slack":
          return responseModeForIds(
            policy.conversationModes,
            [
              conversation.id,
              conversation.parentConversationId,
              conversation.parentId,
            ],
          ) ?? policy.defaultMode;
        case "telegram":
          return responseModeForIds(
            policy.conversationModes,
            [conversation.id, conversation.parentId],
          ) ?? policy.defaultMode;
        default:
          return "every_message";
      }
    },
  };
}

/**
 * Resolve shared-conversation response behavior from most specific to least:
 * bound PwrAgent thread, exact Discord native thread/channel, containing
 * Discord channel, Discord guild/server, then provider global default.
 */
export function resolveMessagingResponseModeForChannel(params: {
  bindingResponseMode?: MessagingResponseMode;
  channel: MessagingChannelKind;
  channelRef: MessagingChannelRef;
  config: DesktopMessagingConfig;
}): MessagingResponseMode {
  return createMessagingResponseModeSnapshot(params).resolve({
    bindingResponseMode: params.bindingResponseMode,
    channelRef: params.channelRef,
  });
}

function responseModePolicy(params: {
  channel: MessagingChannelKind;
  config: DesktopMessagingConfig;
}): {
  channel: MessagingChannelKind;
  conversationModes: MessagingResponseModeEntry[];
  defaultMode: MessagingResponseMode;
  workspaceModes: MessagingResponseModeEntry[];
} {
  switch (params.channel) {
    case "discord":
      return {
        channel: params.channel,
        conversationModes: responseModeEntries(
          params.config.discord?.responseModeOverrides,
        ),
        defaultMode: params.config.discord?.responseMode ?? "every_message",
        workspaceModes: responseModeEntries(
          params.config.discord?.authorizedGuildIds,
        ),
      };
    case "slack":
      return {
        channel: params.channel,
        conversationModes: responseModeEntries(
          params.config.slack?.authorizedConversationIds,
        ),
        defaultMode: params.config.slack?.responseMode ?? "mention_only",
        workspaceModes: [],
      };
    case "telegram":
      return {
        channel: params.channel,
        conversationModes: responseModeEntries(
          params.config.telegram?.authorizedSupergroupIds,
        ),
        defaultMode: params.config.telegram?.responseMode ?? "every_message",
        workspaceModes: [],
      };
    default:
      return {
        channel: params.channel,
        conversationModes: [],
        defaultMode: "every_message",
        workspaceModes: [],
      };
  }
}

function responseModeEntries(
  entries: readonly {
    id: string;
    responseMode?: MessagingResponseMode;
  }[] | undefined,
): MessagingResponseModeEntry[] {
  return entries?.flatMap((entry) =>
    entry.responseMode
      ? [{ id: entry.id, responseMode: entry.responseMode }]
      : [],
  ) ?? [];
}

function responseModeForIds(
  entries: readonly {
    id: string;
    responseMode?: MessagingResponseMode;
  }[] | undefined,
  ids: readonly (string | undefined)[],
): MessagingResponseMode | undefined {
  for (const id of ids) {
    if (!id) continue;
    const mode = entries?.find((entry) => entry.id === id)?.responseMode;
    if (mode) return mode;
  }
  return undefined;
}
