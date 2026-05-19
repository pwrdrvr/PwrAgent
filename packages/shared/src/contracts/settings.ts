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

export const DESKTOP_UPDATE_CHANNELS = ["latest", "prerelease"] as const;

export type DesktopUpdateChannel = (typeof DESKTOP_UPDATE_CHANNELS)[number];

export const DESKTOP_UPDATE_CHANNEL_DEFAULT: DesktopUpdateChannel = "latest";

export const DESKTOP_APPEARANCE_THEMES = ["system", "dark", "light"] as const;
export type DesktopAppearanceTheme = (typeof DESKTOP_APPEARANCE_THEMES)[number];
export const DESKTOP_APPEARANCE_THEME_DEFAULT: DesktopAppearanceTheme = "system";

export const DESKTOP_APPEARANCE_DENSITIES = [
  "mission-control",
  "compact",
] as const;
export type DesktopAppearanceDensity =
  (typeof DESKTOP_APPEARANCE_DENSITIES)[number];
export const DESKTOP_APPEARANCE_DENSITY_DEFAULT: DesktopAppearanceDensity =
  "mission-control";

export const DESKTOP_CODEX_PROFILE_MODELS = [
  "shared",
  "isolated",
  "multiple",
] as const;
export type DesktopCodexProfileModel =
  (typeof DESKTOP_CODEX_PROFILE_MODELS)[number];
export const DESKTOP_CODEX_PROFILE_MODEL_DEFAULT: DesktopCodexProfileModel =
  "shared";

/**
 * Persisted record that the operator acknowledged the messaging-safety
 * preamble in the first-run wizard. Audit-trail oriented: timestamp + the
 * provider keys the operator chose to set up. `null` means the preamble
 * was never accepted (Skip path or wizard not yet run).
 */
export type DesktopMessagingAcknowledgment = {
  acknowledgedAt: string;
  providers: readonly string[];
};

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
  fullAccessWarningDismissed?: boolean;
  fullAccessWarningOverride?: DesktopMessagingFullAccessWarningUserPolicy;
};

export type DesktopMessagingFullAccessWarningGlobalPolicy =
  | "always"
  | "dismissable"
  | "never";

export type DesktopMessagingFullAccessWarningUserPolicy =
  | "default"
  | "always"
  | "dismissable"
  | "never";

export type DesktopMessagingContactLookupPlatform =
  | "telegram"
  | "discord"
  | "feishu"
  | "mattermost"
  | "slack"
  | "line";

export type DesktopMessagingContactLookupKind =
  | "user"
  | "supergroup"
  | "guild"
  | "workspace"
  | "chat"
  | "tenant"
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
  | "feishuAppId"
  | "feishuAppSecret"
  | "feishuEncryptKey"
  | "feishuVerificationToken"
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

export type DesktopImageUploadSettingsSnapshot = {
  pastedImageMaxPatches: DesktopSettingsValue<number>;
};

export type DesktopUpdateSettingsSnapshot = {
  channel: DesktopSettingsValue<DesktopUpdateChannel>;
};

export type DesktopAppearanceSnapshot = {
  theme: DesktopSettingsValue<DesktopAppearanceTheme>;
  density: DesktopSettingsValue<DesktopAppearanceDensity>;
};

export type DesktopGeneralSettingsSnapshot = {
  developerMode: DesktopSettingsValue<boolean>;
  appearance: DesktopAppearanceSnapshot;
  codexProfileModel: DesktopSettingsValue<DesktopCodexProfileModel>;
  messagingAcknowledgment: DesktopSettingsValue<DesktopMessagingAcknowledgment | null>;
};

export const DESKTOP_ONBOARDING_COMPLETED_SOURCES = [
  "wizard",
  "migrated",
] as const;
export type DesktopOnboardingCompletedSource =
  (typeof DESKTOP_ONBOARDING_COMPLETED_SOURCES)[number];

/**
 * Per-profile onboarding state. `completed` gates the initial Codex
 * `listThreads` probe at app startup so a brand-new PwrAgent profile shows
 * an empty sidebar until the first-run wizard picks a Codex profile model
 * (Shared / Isolated / Multiple). `completedSource` distinguishes a profile
 * that ran the wizard from one that existed before this gate landed —
 * pre-existing profiles are treated as `"migrated"` so they keep loading
 * Codex threads on launch with no regression.
 */
export type DesktopOnboardingSnapshot = {
  completed: DesktopSettingsValue<boolean>;
  completedSource: DesktopSettingsValue<DesktopOnboardingCompletedSource | "">;
};

export function isDesktopOnboardingCompletedSource(
  value: string,
): value is DesktopOnboardingCompletedSource {
  return DESKTOP_ONBOARDING_COMPLETED_SOURCES.includes(
    value as DesktopOnboardingCompletedSource,
  );
}

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
  accountEmail?: string;
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
      disabledReasonKind?:
        | "explicit_override"
        | "lease_held"
        | "no_runnable_adapters"
        | "runtime_stopped"
        | "startup_error"
        | "saved_disabled";
      overrideActive?: boolean;
      leaseHolder?: {
        instanceId: string;
        processId?: number;
        cwdHint?: string;
        startedAt?: number;
        expiresAt: number;
      };
    };
  };
  secretStorage: DesktopSettingsSecretStorageState;
  general: DesktopGeneralSettingsSnapshot;
  onboarding: DesktopOnboardingSnapshot;
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
  imageUploads: DesktopImageUploadSettingsSnapshot;
  updates: DesktopUpdateSettingsSnapshot;
  messaging: {
    enabled: DesktopSettingsValue<boolean>;
    allowFullAccessEscalation: DesktopSettingsValue<boolean>;
    allowFullAccessThreadResume: DesktopSettingsValue<boolean>;
    fullAccessWarning: DesktopSettingsValue<DesktopMessagingFullAccessWarningGlobalPolicy>;
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
    feishu: {
      enabled: DesktopSettingsValue<boolean>;
      streamingResponses: DesktopSettingsValue<boolean>;
      appId: DesktopSettingsSecretState;
      appSecret: DesktopSettingsSecretState;
      encryptKey: DesktopSettingsSecretState;
      verificationToken: DesktopSettingsSecretState;
      inboundMode: DesktopSettingsValue<"persistent" | "webhook">;
      tenantRegion: DesktopSettingsValue<"feishu" | "lark">;
      tenantUrl: DesktopSettingsValue<string>;
      callbackBaseUrl: DesktopSettingsValue<string>;
      slashCommandPrefix: DesktopSettingsValue<string>;
      registerSlashCommands: DesktopSettingsValue<boolean>;
      authorizedUserIds: DesktopSettingsValue<DesktopAuthorizedContact[]>;
      authorizedChats: DesktopSettingsValue<DesktopAuthorizedContact[]>;
      authorizedTenants: DesktopSettingsValue<DesktopAuthorizedContact[]>;
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
  general?: {
    developerMode?: boolean;
    appearance?: {
      theme?: DesktopAppearanceTheme;
      density?: DesktopAppearanceDensity;
    };
    codexProfileModel?: DesktopCodexProfileModel;
    /** `null` clears the persisted acknowledgement. */
    messagingAcknowledgment?: DesktopMessagingAcknowledgment | null;
  };
  onboarding?: {
    completed?: boolean;
    completedSource?: DesktopOnboardingCompletedSource;
  };
  experimental?: {
    fullAccessRiskWarningDismissed?: boolean;
    diffCondensation?: {
      enabled?: boolean;
      /** "auto" or a specific model id. Empty string is coerced to "auto". */
      model?: string;
    };
  };
  imageUploads?: {
    pastedImageMaxPatches?: number;
  };
  updates?: {
    channel?: DesktopUpdateChannel;
  };
  messaging?: {
    enabled?: boolean;
    allowFullAccessEscalation?: boolean;
    allowFullAccessThreadResume?: boolean;
    fullAccessWarning?: DesktopMessagingFullAccessWarningGlobalPolicy;
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
    feishu?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      inboundMode?: "persistent" | "webhook";
      tenantRegion?: "feishu" | "lark";
      tenantUrl?: string;
      callbackBaseUrl?: string;
      slashCommandPrefix?: string;
      registerSlashCommands?: boolean;
      authorizedUserIds?: DesktopAuthorizedContact[];
      authorizedChats?: DesktopAuthorizedContact[];
      authorizedTenants?: DesktopAuthorizedContact[];
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

/**
 * Wizard-issued signal that the operator picked a Codex profile model
 * and the deferred Codex `listThreads` probe may now run. The IPC handler
 * persists `onboarding.completed = true` and `onboarding.completed_source =
 * "wizard"` (idempotently) and kicks off the same thread-list prefetch the
 * app startup path would have done.
 *
 * `connect` defaults to `true`; setting `false` is reserved for skip/exit
 * paths that mark onboarding done without triggering an immediate Codex
 * connect (e.g. the operator chose to skip the wizard and we want to
 * defer the connect to the renderer's next explicit request).
 */
export type CompleteOnboardingCodexBootstrapRequest = {
  connect?: boolean;
};

export type CompleteOnboardingCodexBootstrapResponse = {
  snapshot: DesktopSettingsSnapshot;
  connectInitiated: boolean;
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

export type CreateDesktopCodexAuthProfileRequest = {
  profile: string;
};

export type CreateDesktopCodexAuthProfileResponse = {
  profile: string;
  codexHome: string;
  created: boolean;
};

export type StartDesktopCodexAuthProfileLoginRequest = {
  profile: string;
};

export type StartDesktopCodexAuthProfileLoginResponse = {
  profile: string;
  codexHome: string;
  started: boolean;
  authenticated?: boolean;
  pid?: number;
  loginUrl?: string;
  detail?: string;
};

export type CheckDesktopCodexAuthProfileStatusRequest = {
  profile: string;
};

export type CheckDesktopCodexAuthProfileStatusResponse = {
  profile: string;
  codexHome: string;
  authenticated: boolean;
  status: "authenticated" | "unauthenticated" | "failed";
  detail?: string;
};

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
  default: boolean;
  profileDir: string;
  canDelete: boolean;
  codexProfile: DesktopCodexAuthProfileCandidate;
};

export type ListDesktopPwrAgentProfilesResponse = {
  activeProfile: string;
  defaultProfile: string;
  profiles: DesktopPwrAgentProfileSummary[];
};

export type OpenDesktopPwrAgentProfileRequest = {
  profile: string;
};

export type OpenDesktopPwrAgentProfileResponse = {
  opened: boolean;
  profile: string;
  reason?: "active" | "focused";
};

export type CreateDesktopPwrAgentProfileRequest = {
  profile: string;
  /**
   * When `true`, seed `[onboarding] completed = true` +
   * `completed_source = "wizard"` into the newly-created profile's
   * `config.toml`. The first-run wizard uses this when provisioning
   * paired profiles so the operator doesn't get re-onboarded the
   * moment they switch into the freshly-created profile — they just
   * went through the wizard to *create* it.
   *
   * Default: false (current behavior — new profiles start ungated
   * and the wizard auto-fires on their first open per #500).
   */
  seedOnboardingCompleted?: boolean;
};

export type CreateDesktopPwrAgentProfileResponse = {
  profile: string;
  profileDir: string;
  created: boolean;
};

export type SetDefaultDesktopPwrAgentProfileRequest = {
  profile: string;
};

export type SetDefaultDesktopPwrAgentProfileResponse = {
  profile: string;
};

export type DeleteDesktopPwrAgentProfileRequest = {
  profile: string;
};

export type DeleteDesktopPwrAgentProfileResponse = {
  deleted: boolean;
  movedToTrash?: boolean;
  profile: string;
};

export type SetDesktopPwrAgentProfileCodexProfileRequest = {
  profile: string;
  codexProfile: string;
};

export type SetDesktopPwrAgentProfileCodexProfileResponse = {
  profile: string;
  codexProfile: string;
};

export type OpenDesktopApplicationRequest = {
  applicationId: string;
  kind: DesktopApplicationKind;
  targetPath: string;
  targetLine?: number;
  targetColumn?: number;
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

export function isDesktopUpdateChannel(
  value: string,
): value is DesktopUpdateChannel {
  return DESKTOP_UPDATE_CHANNELS.includes(value as DesktopUpdateChannel);
}

export function isDesktopAppearanceTheme(
  value: string,
): value is DesktopAppearanceTheme {
  return DESKTOP_APPEARANCE_THEMES.includes(value as DesktopAppearanceTheme);
}

export function isDesktopAppearanceDensity(
  value: string,
): value is DesktopAppearanceDensity {
  return DESKTOP_APPEARANCE_DENSITIES.includes(
    value as DesktopAppearanceDensity,
  );
}

export function isDesktopCodexProfileModel(
  value: string,
): value is DesktopCodexProfileModel {
  return DESKTOP_CODEX_PROFILE_MODELS.includes(
    value as DesktopCodexProfileModel,
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
  "feishu",
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
