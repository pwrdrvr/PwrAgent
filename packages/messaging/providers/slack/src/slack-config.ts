import type {
  MessagingAuthorizationMode,
  MessagingChannelUserAccessMode,
  MessagingDmAccessMode,
  MessagingResponseMode,
} from "@pwragent/messaging-interface";

export type SlackAuthorizedContact = {
  id: string;
  displayName: string;
  responseMode?: MessagingResponseMode;
};

export type SlackInboundMode = "socket" | "events";

export type SlackMessagingConfig = {
  appToken?: string;
  authorizedActorIds: SlackAuthorizedContact[];
  authorizedConversationIds?: SlackAuthorizedContact[];
  authorizedTeamIds?: SlackAuthorizedContact[];
  channelAuthorizationMode?: MessagingAuthorizationMode;
  channelUserAccessMode?: MessagingChannelUserAccessMode;
  dmAccessMode?: MessagingDmAccessMode;
  botToken: string;
  channel: "slack";
  enabled?: boolean;
  inboundMode?: SlackInboundMode;
  registerSlashCommands?: boolean;
  responseMode?: MessagingResponseMode;
  signingSecret?: string;
  slashCommandPrefix?: string;
  streamingResponses?: boolean;
  teamAuthorizationMode?: MessagingAuthorizationMode;
  workspaceUrl?: string;
};
