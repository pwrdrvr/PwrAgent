export type DiscordMessagingConfig = {
  applicationId?: string;
  authorizedActorIds: string[];
  authorizedGuildIds?: string[];
  botToken: string;
  channel: "discord";
  enabled?: boolean;
  streamingResponses?: boolean;
};
