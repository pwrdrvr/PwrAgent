import type { MessagingResponseMode } from "@pwragent/messaging-interface";

export type TelegramAuthorizedContact = {
  id: string;
  displayName: string;
  responseMode?: MessagingResponseMode;
};

export type TelegramMessagingConfig = {
  authorizedActorIds: TelegramAuthorizedContact[];
  authorizedSupergroupIds?: TelegramAuthorizedContact[];
  botToken: string;
  channel: "telegram";
  enabled?: boolean;
  responseMode?: MessagingResponseMode;
  streamingResponses?: boolean;
};
