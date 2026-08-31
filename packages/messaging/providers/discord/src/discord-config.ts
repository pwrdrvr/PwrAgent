import type { MessagingResponseMode } from "@pwragent/messaging-interface";

export type DiscordAuthorizedContact = {
  id: string;
  displayName: string;
  responseMode?: MessagingResponseMode;
};

export type DiscordMessagingConfig = {
  applicationId?: string;
  authorizedActorIds: DiscordAuthorizedContact[];
  authorizedGuildIds?: DiscordAuthorizedContact[];
  botToken: string;
  channel: "discord";
  enabled?: boolean;
  responseMode?: MessagingResponseMode;
  responseModeOverrides?: DiscordAuthorizedContact[];
  streamingResponses?: boolean;
};
