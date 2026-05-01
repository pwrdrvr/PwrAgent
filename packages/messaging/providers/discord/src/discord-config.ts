export type DiscordMessagingConfig = {
  applicationId?: string;
  authorizedActorIds: string[];
  botToken: string;
  channel: "discord";
  enabled?: boolean;
};
