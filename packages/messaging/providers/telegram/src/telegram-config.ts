export type TelegramMessagingConfig = {
  authorizedActorIds: string[];
  botToken: string;
  channel: "telegram";
  enabled?: boolean;
};
