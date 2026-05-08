export type TelegramMessagingConfig = {
  authorizedActorIds: string[];
  authorizedSupergroupIds?: string[];
  botToken: string;
  channel: "telegram";
  enabled?: boolean;
  streamingResponses?: boolean;
};
