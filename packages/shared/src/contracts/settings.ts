import type { MessagingToolUpdateMode } from "./messaging";

export const DESKTOP_CHAT_REPLY_COMPOSERS = [
  "textarea",
  "tiptap-chips",
  "tiptap-wysiwyg-markdown-chips",
  "custom-widget-chips",
] as const;

export type DesktopChatReplyComposer =
  (typeof DESKTOP_CHAT_REPLY_COMPOSERS)[number];

export const DESKTOP_WORKTREE_STORAGE_LOCATIONS = [
  "in-repo",
  "user-home",
] as const;

export type DesktopWorktreeStorageLocation =
  (typeof DESKTOP_WORKTREE_STORAGE_LOCATIONS)[number];

export const DESKTOP_WORKTREE_STORAGE_DEFAULT: DesktopWorktreeStorageLocation =
  "user-home";

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

export type DesktopMessagingImageProfile = "low" | "medium" | "high" | "actual";

export type DesktopMessagingAttachmentSettingsSnapshot = {
  imageProfile: DesktopSettingsValue<DesktopMessagingImageProfile>;
  maxAttachmentBytes: DesktopSettingsValue<number>;
  maxAttachmentCount: DesktopSettingsValue<number>;
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

export type DesktopApplicationKind = "editor" | "terminal";

export type DesktopApplicationSource = "application" | "path";

export type DesktopApplicationDiscoveryCandidate = {
  id: string;
  kind: DesktopApplicationKind;
  name: string;
  source: DesktopApplicationSource;
  appPath?: string;
  executablePath?: string;
  iconDataUrl?: string;
  canOpenWorkspace: boolean;
};

export type DesktopApplicationsSnapshot = {
  editors: DesktopApplicationDiscoveryCandidate[];
  terminals: DesktopApplicationDiscoveryCandidate[];
  preferredEditorId: DesktopSettingsValue<string>;
  preferredTerminalId: DesktopSettingsValue<string>;
};

export type DesktopSettingsSnapshot = {
  fetchedAt: number;
  configPath: string;
  configError?: string;
  runtime: {
    messaging: {
      disabled: boolean;
      disabledReason?: string;
    };
  };
  secretStorage: DesktopSettingsSecretStorageState;
  experimental: {
    chatReplyComposer: DesktopSettingsValue<DesktopChatReplyComposer>;
  };
  messaging: {
    inputDebounceMs: DesktopSettingsValue<number>;
    toolUpdateMode: DesktopSettingsValue<MessagingToolUpdateMode>;
    attachments: DesktopMessagingAttachmentSettingsSnapshot;
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
  applications: DesktopApplicationsSnapshot;
  worktrees: {
    storage: DesktopSettingsValue<DesktopWorktreeStorageLocation>;
    effectivePath: string;
  };
};

export type DesktopSettingsConfigPatch = {
  experimental?: {
    chatReplyComposer?: DesktopChatReplyComposer;
  };
  messaging?: {
    inputDebounceMs?: number;
    toolUpdateMode?: MessagingToolUpdateMode;
    attachments?: {
      imageProfile?: DesktopMessagingImageProfile;
      maxAttachmentBytes?: number;
      maxAttachmentCount?: number;
    };
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
    };
  };
  models?: {
    codex?: {
      path?: string;
    };
  };
  applications?: {
    editor?: {
      preferredId?: string;
    };
    terminal?: {
      preferredId?: string;
    };
  };
  worktrees?: {
    storage?: DesktopWorktreeStorageLocation;
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

export type OpenDesktopApplicationRequest = {
  applicationId: string;
  kind: DesktopApplicationKind;
  targetPath: string;
};

export type OpenDesktopApplicationResponse = {
  opened: true;
};

export function isDesktopChatReplyComposer(
  value: string,
): value is DesktopChatReplyComposer {
  return DESKTOP_CHAT_REPLY_COMPOSERS.includes(
    value as DesktopChatReplyComposer,
  );
}

export function isDesktopWorktreeStorageLocation(
  value: string,
): value is DesktopWorktreeStorageLocation {
  return DESKTOP_WORKTREE_STORAGE_LOCATIONS.includes(
    value as DesktopWorktreeStorageLocation,
  );
}
