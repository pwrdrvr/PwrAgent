import type { MessagingToolUpdateMode } from "./messaging";

export const DESKTOP_CHAT_REPLY_COMPOSERS = [
  "textarea",
  "tiptap-chips",
  "tiptap-wysiwyg-markdown-chips",
  "custom-widget-chips",
] as const;

export type DesktopChatReplyComposer =
  (typeof DESKTOP_CHAT_REPLY_COMPOSERS)[number];

export const DESKTOP_CHAT_REPLY_COMPOSER_DEFAULT: DesktopChatReplyComposer =
  "tiptap-wysiwyg-markdown-chips";

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
  | "grokApiKey"
  | "mattermostBotToken"
  | "mattermostHmacSecret";

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

export type DesktopGhCandidateSource =
  | "env"
  | "config"
  | "path"
  | "homebrew"
  | "macports"
  | "user"
  | "windows";

export type DesktopGhDiscoveryCandidate = {
  command: string;
  source: DesktopGhCandidateSource;
  executable: boolean;
  selected: boolean;
  version?: string;
  versionFailureReason?: string;
  failureReason?: string;
};

export type DesktopGhDiscoverySnapshot = {
  selectedCommand?: string;
  selectedSource?: DesktopGhCandidateSource;
  candidates: DesktopGhDiscoveryCandidate[];
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
  gh: {
    path: DesktopSettingsValue<string>;
    discovery: DesktopGhDiscoverySnapshot;
  };
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
    /**
     * Diff condensation (a.k.a. "diff eliding") gates whether we send
     * focused-diff requests to xAI. When enabled, less-relevant diff
     * hunks are hidden via an xAI judgment call. When disabled, every
     * diff renders in full and no xAI request fires.
     *
     * model:
     *   - "auto" — use the backend's default condensation model
     *   - any other string — use that model id for every condensation
     *     request, regardless of which backend is active
     */
    diffCondensation: {
      enabled: DesktopSettingsValue<boolean>;
      model: DesktopSettingsValue<string>;
    };
  };
  messaging: {
    inputDebounceMs: DesktopSettingsValue<number>;
    toolUpdateMode: DesktopSettingsValue<MessagingToolUpdateMode>;
    attachments: DesktopMessagingAttachmentSettingsSnapshot;
    telegram: {
      enabled: DesktopSettingsValue<boolean>;
      streamingResponses: DesktopSettingsValue<boolean>;
      botToken: DesktopSettingsSecretState;
      authorizedUserIds: DesktopSettingsValue<string[]>;
      authorizedSupergroups: DesktopSettingsValue<string[]>;
    };
    discord: {
      enabled: DesktopSettingsValue<boolean>;
      streamingResponses: DesktopSettingsValue<boolean>;
      botToken: DesktopSettingsSecretState;
      applicationId: DesktopSettingsValue<string>;
      authorizedUserIds: DesktopSettingsValue<string[]>;
      authorizedGuilds: DesktopSettingsValue<string[]>;
    };
    mattermost: {
      enabled: DesktopSettingsValue<boolean>;
      streamingResponses: DesktopSettingsValue<boolean>;
      botToken: DesktopSettingsSecretState;
      hmacSecret: DesktopSettingsSecretState;
      serverUrl: DesktopSettingsValue<string>;
      callbackBaseUrl: DesktopSettingsValue<string>;
      slashCommandPrefix: DesktopSettingsValue<string>;
      registerSlashCommands: DesktopSettingsValue<boolean>;
      authorizedUserIds: DesktopSettingsValue<string[]>;
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
    diffCondensation?: {
      enabled?: boolean;
      /** "auto" or a specific model id. Empty string is coerced to "auto". */
      model?: string;
    };
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
      streamingResponses?: boolean;
      authorizedUserIds?: string[];
      authorizedSupergroups?: string[];
    };
    discord?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      applicationId?: string;
      authorizedUserIds?: string[];
      authorizedGuilds?: string[];
    };
    mattermost?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      serverUrl?: string;
      callbackBaseUrl?: string;
      slashCommandPrefix?: string;
      registerSlashCommands?: boolean;
      authorizedUserIds?: string[];
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
    gh?: {
      path?: string;
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

export type PickGhCommandResponse = {
  canceled: boolean;
  path?: string;
  error?: string;
  candidate?: DesktopGhDiscoveryCandidate;
};

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

/**
 * Credential-test surface — drives the per-credential "Test" buttons
 * on the Settings → Messaging and Settings → Models panels. Each kind
 * maps to a distinct main-process probe:
 *
 * - `telegram`  → HTTP GET https://api.telegram.org/bot<TOKEN>/getMe
 * - `discord`   → HTTP GET https://discord.com/api/v10/users/@me
 * - `grok`      → HTTP GET https://api.x.ai/v1/models
 * - `codex`     → spawn `<resolved-path> --version`
 * - `mattermost` → GET <serverUrl>/api/v4/users/me with bot token
 */
export const SETTINGS_CREDENTIAL_TEST_KINDS = [
  "telegram",
  "discord",
  "grok",
  "codex",
  "mattermost",
] as const;

export type SettingsCredentialTestKind =
  (typeof SETTINGS_CREDENTIAL_TEST_KINDS)[number];

export type SettingsCredentialTestStatus =
  /** Probe ran cleanly. */
  | "ok"
  /** Probe ran but reported a failure (auth rejected, timeout, etc.). */
  | "failed"
  /** Required credential / path is not configured. No probe was attempted. */
  | "unset";

export type SettingsCredentialTestResult = {
  kind: SettingsCredentialTestKind;
  status: SettingsCredentialTestStatus;
  /** Wall-clock ms when the test finished. */
  testedAt: number;
  /** Round-trip duration in ms (subprocess wall-clock or HTTP). */
  durationMs: number;
  /** Identity returned by the probe — bot username, account name, etc.
   *  Always already-public information; never a secret. */
  account?: string;
  /** Short human-readable detail to show under the row title.
   *  e.g. version string for codex, comma-joined model IDs for grok. */
  detail?: string;
  /** Failure detail when `status === "failed"`. Truncated by the
   *  tester to ~240 chars so we never surface a giant stack trace. */
  errorMessage?: string;
};

export type SettingsCredentialTestRequest = {
  kind: SettingsCredentialTestKind;
};
