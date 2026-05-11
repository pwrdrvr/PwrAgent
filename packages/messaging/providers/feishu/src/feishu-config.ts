export type FeishuAuthorizedContact = {
  id: string;
  displayName: string;
};

export type FeishuTenantRegion = "feishu" | "lark";

export type FeishuMessagingConfig = {
  appId: string;
  appSecret: string;
  authorizedActorIds: FeishuAuthorizedContact[];
  authorizedChatIds?: FeishuAuthorizedContact[];
  authorizedTenantKeys?: FeishuAuthorizedContact[];
  callbackBaseUrl?: string;
  channel: "feishu";
  enabled?: boolean;
  encryptKey?: string;
  registerSlashCommands?: boolean;
  slashCommandPrefix?: string;
  streamingResponses?: boolean;
  tenantRegion?: FeishuTenantRegion;
  tenantUrl: string;
  verificationToken?: string;
};
