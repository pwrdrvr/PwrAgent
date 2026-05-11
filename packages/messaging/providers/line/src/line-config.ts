export type LineAuthorizedContact = {
  id: string;
  displayName: string;
};

export type LineMessagingConfig = {
  authorizedActorIds: LineAuthorizedContact[];
  authorizedGroupIds?: LineAuthorizedContact[];
  authorizedRoomIds?: LineAuthorizedContact[];
  botUserId?: string;
  callbackBaseUrl: string;
  channel: "line";
  channelAccessToken?: string;
  channelSecret: string;
  enabled?: boolean;
  streamingResponses?: boolean;
  webhookUrl?: string;
  webhookPath?: string;
};
