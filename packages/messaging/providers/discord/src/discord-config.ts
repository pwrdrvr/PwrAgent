export type DiscordAuthorizedContact = {
  id: string;
  displayName: string;
};

export type DiscordMessagingConfig = {
  applicationId?: string;
  authorizedActorIds: DiscordAuthorizedContact[];
  authorizedGuildIds?: DiscordAuthorizedContact[];
  botToken: string;
  channel: "discord";
  enabled?: boolean;
  streamingResponses?: boolean;
};
