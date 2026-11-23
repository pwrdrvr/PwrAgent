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
  configuredConnectionId?: string;
  /** Require getMe to attest this bot before starting a configured connection. */
  expectedBotAccountId?: string;
  channel: "telegram";
  enabled?: boolean;
  responseMode?: MessagingResponseMode;
  streamingResponses?: boolean;
};
