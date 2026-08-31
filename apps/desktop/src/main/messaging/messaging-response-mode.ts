import type {
  MessagingChannelKind,
  MessagingChannelRef,
  MessagingResponseMode,
} from "@pwragent/messaging-interface";
import type { DesktopMessagingConfig } from "./messaging-config";

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
  if (params.bindingResponseMode) {
    return params.bindingResponseMode;
  }

  const conversation = params.channelRef.conversation;
  switch (params.channel) {
    case "discord": {
      const conversationMode = responseModeForIds(
        params.config.discord?.responseModeOverrides,
        [conversation.id, conversation.parentConversationId],
      );
      const guildMode = responseModeForIds(
        params.config.discord?.authorizedGuildIds,
        [conversation.workspaceId ?? conversation.parentId],
      );
      return conversationMode
        ?? guildMode
        ?? params.config.discord?.responseMode
        ?? "every_message";
    }
    case "slack": {
      const specificMode = responseModeForIds(
        params.config.slack?.authorizedConversationIds,
        [
          conversation.id,
          conversation.parentConversationId,
          conversation.parentId,
        ],
      );
      return specificMode ?? params.config.slack?.responseMode ?? "mention_only";
    }
    case "telegram": {
      const specificMode = responseModeForIds(
        params.config.telegram?.authorizedSupergroupIds,
        [conversation.id, conversation.parentId],
      );
      return specificMode ?? params.config.telegram?.responseMode ?? "every_message";
    }
    default:
      return "every_message";
  }
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
