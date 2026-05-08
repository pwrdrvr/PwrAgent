export type TelegramAuthorizedContact = {
  id: string;
  displayName: string;
};

export type TelegramMessagingConfig = {
  authorizedActorIds: TelegramAuthorizedContact[];
  authorizedSupergroupIds?: TelegramAuthorizedContact[];
  botToken: string;
  channel: "telegram";
  enabled?: boolean;
  streamingResponses?: boolean;
};
