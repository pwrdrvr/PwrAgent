export const DESKTOP_CHAT_REPLY_COMPOSERS = [
  "textarea",
  "tiptap-chips",
  "custom-widget-chips",
] as const;

export type DesktopChatReplyComposer =
  (typeof DESKTOP_CHAT_REPLY_COMPOSERS)[number];

export type DesktopSettingsNonSecretSource = "default" | "config" | "env";
export type DesktopSettingsSecretSource = "unset" | "keychain" | "env";
export type DesktopSettingsSource =
  | DesktopSettingsNonSecretSource
  | DesktopSettingsSecretSource;

export type DesktopSettingsValue<T> = {
  value: T;
  source: DesktopSettingsNonSecretSource;
  overriddenByEnv?: boolean;
  error?: string;
};

export type DesktopSettingsSecretName =
  | "telegramBotToken"
  | "discordBotToken"
  | "grokApiKey";

export type DesktopSettingsSecretState = {
  configured: boolean;
  source: DesktopSettingsSecretSource;
  writable: boolean;
  overriddenByEnv?: boolean;
  unavailableReason?: string;
  error?: string;
};

export type DesktopSettingsSecretStorageState = {
  available: boolean;
  backend: "safeStorage" | "memory" | "unavailable";
  encrypted: boolean;
  unavailableReason?: string;
};

export type DesktopCodexCandidateSource =
  | "env"
  | "config"
  | "path"
  | "application";

export type DesktopCodexDiscoveryCandidate = {
  command: string;
  source: DesktopCodexCandidateSource;
  executable: boolean;
  selected: boolean;
  version?: string;
  versionFailureReason?: string;
  failureReason?: string;
};

export type DesktopCodexDiscoverySnapshot = {
  selectedCommand?: string;
  selectedSource?: DesktopCodexCandidateSource;
  candidates: DesktopCodexDiscoveryCandidate[];
  error?: string;
};

export type DesktopSettingsSnapshot = {
  fetchedAt: number;
  configPath: string;
  configError?: string;
  secretStorage: DesktopSettingsSecretStorageState;
  experimental: {
    chatReplyComposer: DesktopSettingsValue<DesktopChatReplyComposer>;
  };
  messaging: {
    telegram: {
      enabled: DesktopSettingsValue<boolean>;
      botToken: DesktopSettingsSecretState;
      authorizedUserIds: DesktopSettingsValue<string[]>;
      authorizedSupergroups: DesktopSettingsValue<string[]>;
    };
    discord: {
      enabled: DesktopSettingsValue<boolean>;
      botToken: DesktopSettingsSecretState;
      applicationId: DesktopSettingsValue<string>;
      authorizedUserIds: DesktopSettingsValue<string[]>;
      authorizedGuilds: DesktopSettingsValue<string[]>;
      messageContentIntent: DesktopSettingsValue<boolean>;
    };
  };
  models: {
    codex: {
      path: DesktopSettingsValue<string>;
      discovery: DesktopCodexDiscoverySnapshot;
    };
    grok: {
      apiKey: DesktopSettingsSecretState;
    };
  };
};

export type DesktopSettingsConfigPatch = {
  experimental?: {
    chatReplyComposer?: DesktopChatReplyComposer;
  };
  messaging?: {
    telegram?: {
      enabled?: boolean;
      authorizedUserIds?: string[];
      authorizedSupergroups?: string[];
    };
    discord?: {
      enabled?: boolean;
      applicationId?: string;
      authorizedUserIds?: string[];
      authorizedGuilds?: string[];
      messageContentIntent?: boolean;
    };
  };
  models?: {
    codex?: {
      path?: string;
    };
  };
};

export type ReadDesktopSettingsRequest = Record<string, never>;

export type ReadDesktopSettingsResponse = {
  snapshot: DesktopSettingsSnapshot;
};

export type WriteDesktopSettingsConfigRequest = {
  patch: DesktopSettingsConfigPatch;
};

export type ReplaceDesktopSettingsSecretRequest = {
  secret: DesktopSettingsSecretName;
  value: string;
};

export type ClearDesktopSettingsSecretRequest = {
  secret: DesktopSettingsSecretName;
};

export type RefreshDesktopCodexDiscoveryRequest = Record<string, never>;

export type DesktopSettingsWriteResponse = {
  snapshot: DesktopSettingsSnapshot;
};

export function isDesktopChatReplyComposer(
  value: string,
): value is DesktopChatReplyComposer {
  return DESKTOP_CHAT_REPLY_COMPOSERS.includes(
    value as DesktopChatReplyComposer,
  );
}
