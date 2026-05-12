import type { MessagingToolUpdateMode } from "./messaging";

export const DESKTOP_CHAT_REPLY_COMPOSERS = [
  "tiptap-wysiwyg-markdown-chips",
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

export type DesktopAuthorizedContact = {
  id: string;
  displayName: string;
};

export type DesktopMessagingContactLookupPlatform =
  | "telegram"
  | "discord"
  | "mattermost"
  | "slack"
  | "line";

export type DesktopMessagingContactLookupKind =
  | "user"
  | "supergroup"
  | "guild"
  | "workspace"
  | "group"
  | "room";

export type DesktopMessagingContactLookupRequest = {
  platform: DesktopMessagingContactLookupPlatform;
  kind: DesktopMessagingContactLookupKind;
  id: string;
};

export type DesktopMessagingContactLookupStatus =
  | "ok"
  | "failed"
  | "not_found"
  | "unset"
  | "unsupported";

export type DesktopMessagingContactLookupResponse = {
  status: DesktopMessagingContactLookupStatus;
  id: string;
  displayName?: string;
  handle?: string;
  detail?: string;
  errorMessage?: string;
};

export type DesktopSettingsSecretName =
  | "telegramBotToken"
  | "discordBotToken"
  | "grokApiKey"
  | "mattermostBotToken"
  | "mattermostHmacSecret"
  | "slackBotToken"
  | "slackAppToken"
  | "slackSigningSecret"
  | "lineChannelAccessToken"
  | "lineChannelSecret";

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

export type DesktopCodexAuthProfileSource = "default" | "directory" | "config";

export type DesktopCodexAuthProfileCandidate = {
  name: string;
  displayName: string;
  codexHome: string;
  source: DesktopCodexAuthProfileSource;
  exists: boolean;
  selected: boolean;
  hasAuthFile: boolean;
  hasConfigFile: boolean;
};

export type DesktopCodexAuthProfileDiscoverySnapshot = {
  profileRoot: string;
  effectiveCodexHome: string;
  profiles: DesktopCodexAuthProfileCandidate[];
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

export type DesktopGitCandidateSource =
  | "env"
  | "path"
  | "homebrew"
  | "xcode"
  | "user";

export type DesktopGitDiscoveryCandidate = {
  command: string;
  source: DesktopGitCandidateSource;
  executable: boolean;
  selected: boolean;
  version?: string;
  versionFailureReason?: string;
  failureReason?: string;
};

export type DesktopGitDiscoverySnapshot = {
  selectedCommand?: string;
  selectedSource?: DesktopGitCandidateSource;
  candidates: DesktopGitDiscoveryCandidate[];
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
  git: {
    discovery: DesktopGitDiscoverySnapshot;
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
      overrideActive?: boolean;
    };
  };
  secretStorage: DesktopSettingsSecretStorageState;
  experimental: {
    chatReplyComposer: DesktopSettingsValue<DesktopChatReplyComposer>;
    fullAccessRiskWarningDismissed: DesktopSettingsValue<boolean>;
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
    enabled: DesktopSettingsValue<boolean>;
    inputDebounceMs: DesktopSettingsValue<number>;
    toolUpdateMode: DesktopSettingsValue<MessagingToolUpdateMode>;
    attachments: DesktopMessagingAttachmentSettingsSnapshot;
    telegram: {
      enabled: DesktopSettingsValue<boolean>;
      streamingResponses: DesktopSettingsValue<boolean>;
      botToken: DesktopSettingsSecretState;
      authorizedUserIds: DesktopSettingsValue<DesktopAuthorizedContact[]>;
      authorizedSupergroups: DesktopSettingsValue<DesktopAuthorizedContact[]>;
    };
    discord: {
      enabled: DesktopSettingsValue<boolean>;
      streamingResponses: DesktopSettingsValue<boolean>;
      botToken: DesktopSettingsSecretState;
      applicationId: DesktopSettingsValue<string>;
      authorizedUserIds: DesktopSettingsValue<DesktopAuthorizedContact[]>;
      authorizedGuilds: DesktopSettingsValue<DesktopAuthorizedContact[]>;
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
      authorizedUserIds: DesktopSettingsValue<DesktopAuthorizedContact[]>;
      authorizedTeams: DesktopSettingsValue<DesktopAuthorizedContact[]>;
      authorizedConversations: DesktopSettingsValue<DesktopAuthorizedContact[]>;
    };
    slack: {
      enabled: DesktopSettingsValue<boolean>;
      streamingResponses: DesktopSettingsValue<boolean>;
      botToken: DesktopSettingsSecretState;
      appToken: DesktopSettingsSecretState;
      signingSecret: DesktopSettingsSecretState;
      workspaceUrl: DesktopSettingsValue<string>;
      inboundMode: DesktopSettingsValue<"socket" | "events">;
      slashCommandPrefix: DesktopSettingsValue<string>;
      registerSlashCommands: DesktopSettingsValue<boolean>;
      authorizedUserIds: DesktopSettingsValue<DesktopAuthorizedContact[]>;
      authorizedWorkspaces: DesktopSettingsValue<DesktopAuthorizedContact[]>;
    };
    line: {
      enabled: DesktopSettingsValue<boolean>;
      streamingResponses: DesktopSettingsValue<boolean>;
      channelAccessToken: DesktopSettingsSecretState;
      channelSecret: DesktopSettingsSecretState;
      webhookUrl: DesktopSettingsValue<string>;
      callbackBaseUrl: DesktopSettingsValue<string>;
      botUserId: DesktopSettingsValue<string>;
      authorizedUserIds: DesktopSettingsValue<DesktopAuthorizedContact[]>;
      authorizedGroups: DesktopSettingsValue<DesktopAuthorizedContact[]>;
      authorizedRooms: DesktopSettingsValue<DesktopAuthorizedContact[]>;
    };
  };
  models: {
    codex: {
      path: DesktopSettingsValue<string>;
      profile: DesktopSettingsValue<string>;
      discovery: DesktopCodexDiscoverySnapshot;
      profiles: DesktopCodexAuthProfileDiscoverySnapshot;
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
    fullAccessRiskWarningDismissed?: boolean;
    diffCondensation?: {
      enabled?: boolean;
      /** "auto" or a specific model id. Empty string is coerced to "auto". */
      model?: string;
    };
  };
  messaging?: {
    enabled?: boolean;
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
      authorizedUserIds?: DesktopAuthorizedContact[];
      authorizedSupergroups?: DesktopAuthorizedContact[];
    };
    discord?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      applicationId?: string;
      authorizedUserIds?: DesktopAuthorizedContact[];
      authorizedGuilds?: DesktopAuthorizedContact[];
    };
    mattermost?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      serverUrl?: string;
      callbackBaseUrl?: string;
      slashCommandPrefix?: string;
      registerSlashCommands?: boolean;
      authorizedUserIds?: DesktopAuthorizedContact[];
      authorizedTeams?: DesktopAuthorizedContact[];
      authorizedConversations?: DesktopAuthorizedContact[];
    };
    slack?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      workspaceUrl?: string;
      inboundMode?: "socket" | "events";
      slashCommandPrefix?: string;
      registerSlashCommands?: boolean;
      authorizedUserIds?: DesktopAuthorizedContact[];
      authorizedWorkspaces?: DesktopAuthorizedContact[];
    };
    line?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      webhookUrl?: string;
      callbackBaseUrl?: string;
      botUserId?: string;
      authorizedUserIds?: DesktopAuthorizedContact[];
      authorizedGroups?: DesktopAuthorizedContact[];
      authorizedRooms?: DesktopAuthorizedContact[];
    };
  };
  models?: {
    codex?: {
      path?: string;
      profile?: string;
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

export type DesktopPwrAgentProfileSummary = {
  name: string;
  displayName?: string;
  lastUsed?: string;
  active: boolean;
};

export type ListDesktopPwrAgentProfilesResponse = {
  activeProfile: string;
  profiles: DesktopPwrAgentProfileSummary[];
};

export type OpenDesktopPwrAgentProfileRequest = {
  profile: string;
};

export type OpenDesktopPwrAgentProfileResponse = {
  opened: boolean;
  profile: string;
  reason?: "active";
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
 * - `slack`     → Slack Web API `auth.test` with bot token
 */
export const SETTINGS_CREDENTIAL_TEST_KINDS = [
  "telegram",
  "discord",
  "grok",
  "codex",
  "mattermost",
  "slack",
  "line",
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
