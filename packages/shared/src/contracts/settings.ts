import type { MessagingToolUpdateMode } from "./messaging";
import type { FederationTarget } from "./federation";
import {
  TOOL_OUTPUT_WARNING_INVOCATIONS,
  TOOL_OUTPUT_WARNING_PERCENT,
} from "./tool-output-incidents";

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

/**
 * Background PR status polling is enabled by default. An explicit false value
 * remains a kill switch for operators who need to disable the poller.
 */
export const DEFAULT_BACKGROUND_PR_POLLING = true;

/**
 * Automatic pull-request repair is available by default whenever background
 * PR monitoring is enabled. An explicit false value is a separate operator
 * kill switch that preserves each thread's saved preference.
 */
export const DEFAULT_PR_AUTO_DISPATCH_ALLOWED = true;

/**
 * New ordinary threads and launchpads start with Auto-fix PR enabled by
 * default. Existing threads retain their saved per-thread preference.
 */
export const DEFAULT_PR_AUTO_DISPATCH_ENABLED_FOR_NEW_THREADS = true;
export const DEFAULT_PR_AUTO_DISPATCH_BUDGET_CAPACITY = 30;
export const DEFAULT_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE = 1;
export const DEFAULT_PAUSE_PR_AUTO_DISPATCH_WHEN_BUDGET_EMPTY = true;
export const MIN_PR_AUTO_DISPATCH_BUDGET_CAPACITY = 1;
export const MAX_PR_AUTO_DISPATCH_BUDGET_CAPACITY = 1_000;
export const MIN_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE = 1;
export const MAX_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE = 60;

export const DESKTOP_UPDATE_CHANNELS = ["latest", "prerelease"] as const;

export type DesktopUpdateChannel = (typeof DESKTOP_UPDATE_CHANNELS)[number];

export const DESKTOP_UPDATE_CHANNEL_DEFAULT: DesktopUpdateChannel = "latest";

/**
 * The managed Grok build follows the same two tracks as the application, and
 * defaults to Latest for the same reason: a build published for testing is
 * something an operator opts into, never something they inherit.
 */
export const MANAGED_GROK_BUILD_CHANNEL_DEFAULT: DesktopUpdateChannel =
  "latest";

export const DESKTOP_UPDATE_TRAINS = ["stable", "beta"] as const;

export type DesktopUpdateTrain = (typeof DESKTOP_UPDATE_TRAINS)[number];

export const DESKTOP_UPDATE_TRAIN_DEFAULT: DesktopUpdateTrain = "stable";

// Last 1.0 core that used `-beta.N` as the Stable prerelease line. Builds
// at this core stay on Stable so a website Beta download cannot be confused
// with `v1.0.0-beta.50`.
const LEGACY_STABLE_BETA_CORE: [number, number, number] = [1, 0, 0];

function parseDesktopUpdateVersion(
  version: string,
): { core: [number, number, number]; pre: string[] } | undefined {
  const trimmed = version.trim().replace(/^v/i, "");
  const match = trimmed.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) {
    return undefined;
  }
  const [, maj, min, patch, pre] = match;
  return {
    core: [Number(maj), Number(min), Number(patch)],
    pre: pre ? pre.split(".") : [],
  };
}

/**
 * Map a desktop app version onto the Settings update train/track.
 * Used only when both `updates.train` and `updates.channel` are unset so a
 * GitHub or website download of Beta/Prerelease follows that feed. A
 * pre-train config that only set `channel` stays on Stable.
 */
export function inferDesktopUpdateSelection(version: string): {
  channel: DesktopUpdateChannel;
  train: DesktopUpdateTrain;
} {
  const parsed = parseDesktopUpdateVersion(version);
  if (!parsed || parsed.pre.length === 0) {
    return {
      channel: DESKTOP_UPDATE_CHANNEL_DEFAULT,
      train: DESKTOP_UPDATE_TRAIN_DEFAULT,
    };
  }
  const id = parsed.pre[0];
  if (id === "alpha") {
    return { channel: "prerelease", train: "beta" };
  }
  if (id === "prerelease" || id === "rc") {
    return { channel: "prerelease", train: "stable" };
  }
  if (id === "beta") {
    const isLegacyStableBeta =
      parsed.core[0] === LEGACY_STABLE_BETA_CORE[0]
      && parsed.core[1] === LEGACY_STABLE_BETA_CORE[1]
      && parsed.core[2] === LEGACY_STABLE_BETA_CORE[2];
    if (isLegacyStableBeta) {
      return {
        channel: DESKTOP_UPDATE_CHANNEL_DEFAULT,
        train: DESKTOP_UPDATE_TRAIN_DEFAULT,
      };
    }
    return { channel: "latest", train: "beta" };
  }
  return { channel: "prerelease", train: DESKTOP_UPDATE_TRAIN_DEFAULT };
}

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

/**
 * Text-size notches shared by every per-surface text-size axis (sidebar
 * titles, transcript body). "md" is each surface's tuned default; each
 * notch moves that surface's text by 1px in either direction.
 * Deliberately a discrete scale rather than a free pixel value so every
 * notch is a size the surface was actually designed and reviewed at.
 */
export const DESKTOP_TEXT_SIZES = [
  "xs",
  "sm",
  "md",
  "lg",
  "xl",
] as const;
export type DesktopTextSize = (typeof DESKTOP_TEXT_SIZES)[number];
export const DESKTOP_TEXT_SIZE_DEFAULT: DesktopTextSize = "md";

export type DesktopToolOutputAlertPolicy = {
  outputCapHitsEnabled: boolean;
  repeatedLargeOutputsEnabled: boolean;
  repeatedLargeOutputMinimumCalls: number;
  repeatedLargeOutputMinimumPercent: number;
  repeatedQueuedChecksEnabled: boolean;
};

export const MIN_REPEATED_LARGE_OUTPUT_CALLS = 2;
export const MAX_REPEATED_LARGE_OUTPUT_CALLS = 100;
export const MIN_REPEATED_LARGE_OUTPUT_PERCENT = 1;
export const MAX_REPEATED_LARGE_OUTPUT_PERCENT = 100;

/**
 * Tool-output accounting remains available in thread diagnostics without
 * interrupting every operator by default. Operators who want live warnings
 * can opt into each trigger independently.
 */
export const DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT: DesktopToolOutputAlertPolicy = {
  outputCapHitsEnabled: false,
  repeatedLargeOutputsEnabled: false,
  repeatedLargeOutputMinimumCalls: TOOL_OUTPUT_WARNING_INVOCATIONS,
  repeatedLargeOutputMinimumPercent: TOOL_OUTPUT_WARNING_PERCENT,
  repeatedQueuedChecksEnabled: false,
};

export type DesktopSpendAlertPolicy = {
  activeTurnSpendEnabled: boolean;
  activeTurnSpendThresholdUsd: number;
  threadSpendEnabled: boolean;
  threadSpendThresholdUsd: number;
};

export const MIN_SPEND_ALERT_THRESHOLD_USD = 0.01;
export const MAX_SPEND_ALERT_THRESHOLD_USD = 10_000;

export const DESKTOP_SPEND_ALERT_POLICY_DEFAULT: DesktopSpendAlertPolicy = {
  activeTurnSpendEnabled: false,
  activeTurnSpendThresholdUsd: 5,
  threadSpendEnabled: true,
  threadSpendThresholdUsd: 25,
};

export const DESKTOP_INTEGRATED_TERMINAL_WINDOWS_SHELLS = [
  "auto",
  "pwsh",
  "powershell",
  "cmd",
] as const;
export type DesktopIntegratedTerminalWindowsShell =
  (typeof DESKTOP_INTEGRATED_TERMINAL_WINDOWS_SHELLS)[number];
export const DESKTOP_INTEGRATED_TERMINAL_WINDOWS_SHELL_DEFAULT: DesktopIntegratedTerminalWindowsShell =
  "auto";

export const DESKTOP_CODEX_PROFILE_MODELS = [
  "shared",
  "isolated",
  "multiple",
] as const;
export type DesktopCodexProfileModel =
  (typeof DESKTOP_CODEX_PROFILE_MODELS)[number];
export const DESKTOP_CODEX_PROFILE_MODEL_DEFAULT: DesktopCodexProfileModel =
  "shared";

export const DESKTOP_HOT_CPU_PROFILE_START_DELAYS_MS = [
  0,
  5_000,
  10_000,
] as const;
export type DesktopHotCpuProfileStartDelayMs =
  (typeof DESKTOP_HOT_CPU_PROFILE_START_DELAYS_MS)[number];
export const DESKTOP_HOT_CPU_PROFILE_START_DELAY_DEFAULT_MS: DesktopHotCpuProfileStartDelayMs =
  0;

export const DESKTOP_HOT_CPU_PROFILE_TRIGGER_MODES = [
  "spike",
  "sustained",
  "slowburn",
] as const;
export type DesktopHotCpuProfileTriggerMode =
  (typeof DESKTOP_HOT_CPU_PROFILE_TRIGGER_MODES)[number];
export const DESKTOP_HOT_CPU_PROFILE_TRIGGER_MODE_DEFAULT: DesktopHotCpuProfileTriggerMode =
  "sustained";
export const DESKTOP_HOT_CPU_PROFILE_SLOWBURN_THRESHOLD_DEFAULT_PERCENT = 15;

export const DESKTOP_FEDERATION_MODES = [
  "disabled",
  "gateway",
  "client",
  "dual",
] as const;

export type DesktopFederationMode = (typeof DESKTOP_FEDERATION_MODES)[number];

export const DESKTOP_FEDERATION_MODE_DEFAULT: DesktopFederationMode =
  "disabled";

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

export type PrAutoDispatchBudgetConfig = {
  capacity: number;
  refillPerMinute: number;
  pauseWhenEmpty: boolean;
};

export type PrAutoDispatchBudgetStatus = {
  availableTokens: number;
  capacity: number;
  refillPerMinute: number;
  paused: boolean;
  pausedAt?: number;
};

/**
 * Explicit launchpad baseline for one backend in the active PwrAgent profile.
 * Reasoning is remembered per model so switching models never overwrites the
 * operator's preference for another model.
 */
export type DesktopProviderModelDefaults = {
  model?: string;
  reasoningEffortsByModel: Record<string, string>;
};

/**
 * One operator-created migration generation for existing threads belonging to
 * a provider. Threads acknowledge a revision once, when next opened.
 */
export type DesktopProviderThreadModelMigration = {
  revision: string;
  model: string;
  reasoningEffort?: string;
  /** Existing thread models eligible to adopt this migration. Missing = all. */
  sourceModels?: string[];
  /** Whether threads with no reported current model are eligible. */
  includeThreadsWithoutModel?: boolean;
  createdAt: number;
};

export type DesktopAuthorizedContact = {
  id: string;
  displayName: string;
  /** Provider username without presentation punctuation such as a leading `@`. */
  username?: string;
  fullAccessWarningDismissed?: boolean;
  fullAccessWarningOverride?: DesktopMessagingFullAccessWarningUserPolicy;
  responseMode?: DesktopMessagingResponseMode;
};

export type DesktopMessagingResponseMode = "every_message" | "mention_only";
export type DesktopMessagingAuthorizationMode = "approved_only" | "allow_all";
export type DesktopMessagingSlackDmAccessMode =
  | "any_workspace_user"
  | "authorized_users"
  | "none";
export type DesktopMessagingSlackChannelUserAccessMode =
  | "any_channel_user"
  | "authorized_users"
  | "none";
export type DesktopMessagingSlackGroupDmAccessMode = "none" | "authorized_users";

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
  | "channel"
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
  | "lineChannelSecret"
  | "federationInstancePrivateKey"
  | "federationNoiseStaticPrivateKey"
  | "federationCloudflareClientCertificate"
  | "federationCloudflareClientPrivateKey"
  | "federationCloudflareAccessClientId"
  | "federationCloudflareAccessClientSecret"
  | "pwrsnapMcpCredential";

/**
 * Predicate: does writing or clearing this secret affect the
 * messaging runtime? The runtime's "runnable adapters" check
 * combines `messaging.<provider>.enabled = true` with a present
 * bot token / per-provider auth secret, so changes to any of these
 * names need to re-evaluate the runtime (start, stop, or reload).
 *
 * Kept here in shared (not in main-process code) so the renderer's
 * onboarding wizard can reuse the same predicate when deciding
 * which secret fields must be persisted *live* during the wizard
 * vs. buffered for graduation-time write. The main process has its
 * own `messagingSecretTouchesRuntime()` for the IPC layer; they
 * must agree, and a unit test under shared keeps both honest.
 */
export function isMessagingRuntimeSecret(
  name: DesktopSettingsSecretName,
): boolean {
  switch (name) {
    case "telegramBotToken":
    case "discordBotToken":
    case "mattermostBotToken":
    case "mattermostHmacSecret":
    case "slackBotToken":
    case "slackAppToken":
    case "slackSigningSecret":
    case "feishuAppId":
    case "feishuAppSecret":
    case "feishuEncryptKey":
    case "feishuVerificationToken":
    case "lineChannelAccessToken":
    case "lineChannelSecret":
      return true;
    case "federationInstancePrivateKey":
    case "federationNoiseStaticPrivateKey":
    case "federationCloudflareClientCertificate":
    case "federationCloudflareClientPrivateKey":
    case "federationCloudflareAccessClientId":
    case "federationCloudflareAccessClientSecret":
    case "pwrsnapMcpCredential":
      return false;
  }
}

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
  pdfProfile: DesktopSettingsValue<DesktopMessagingImageProfile>;
  maxAttachmentBytes: DesktopSettingsValue<number>;
  maxAttachmentCount: DesktopSettingsValue<number>;
};

export type DesktopImageUploadSettingsSnapshot = {
  pastedImageMaxPatches: DesktopSettingsValue<number>;
};

export type DesktopUpdateSettingsSnapshot = {
  channel: DesktopSettingsValue<DesktopUpdateChannel>;
  train: DesktopSettingsValue<DesktopUpdateTrain>;
};

export type DesktopIntegratedTerminalSettingsSnapshot = {
  windowsShell: DesktopSettingsValue<DesktopIntegratedTerminalWindowsShell>;
};

export type DesktopAppearanceSnapshot = {
  theme: DesktopSettingsValue<DesktopAppearanceTheme>;
  density: DesktopSettingsValue<DesktopAppearanceDensity>;
  sidebarTextSize: DesktopSettingsValue<DesktopTextSize>;
  transcriptTextSize: DesktopSettingsValue<DesktopTextSize>;
};

export type DesktopGeneralSettingsSnapshot = {
  confirmQuitWithInProgressThreads: DesktopSettingsValue<boolean>;
  /**
   * Attention-lens ordering is pinned to the start of a thread's turn so a
   * streaming turn cannot re-sort the queue under the operator. This controls
   * the one exception: whether a finished turn earns one last move to the top.
   */
  attentionPromoteOnTurnEnd: DesktopSettingsValue<boolean>;
  /**
   * Prefer PwrAgent's bounded, visual PDF analysis flow over handing a raw
   * local PDF reference to the model.
   */
  pdfAnalysisEnabled: DesktopSettingsValue<boolean>;
  developerMode: DesktopSettingsValue<boolean>;
  hotCpuProfilingEnabled: DesktopSettingsValue<boolean>;
  hotCpuProfilingStartDelayMs: DesktopSettingsValue<DesktopHotCpuProfileStartDelayMs>;
  hotCpuProfilingTriggerMode: DesktopSettingsValue<DesktopHotCpuProfileTriggerMode>;
  hotCpuProfilingSlowburnThresholdPercent: DesktopSettingsValue<number>;
  hotCpuProfilingCaptureHeapSnapshot: DesktopSettingsValue<boolean>;
  hotCpuProfilingHeapSnapshotLimit: DesktopSettingsValue<number>;
  notificationsEnabled: DesktopSettingsValue<boolean>;
  toolOutputAlerts: {
    outputCapHitsEnabled: DesktopSettingsValue<boolean>;
    repeatedLargeOutputsEnabled: DesktopSettingsValue<boolean>;
    repeatedLargeOutputMinimumCalls: DesktopSettingsValue<number>;
    repeatedLargeOutputMinimumPercent: DesktopSettingsValue<number>;
    repeatedQueuedChecksEnabled: DesktopSettingsValue<boolean>;
  };
  spendAlerts: {
    activeTurnSpendEnabled: DesktopSettingsValue<boolean>;
    activeTurnSpendThresholdUsd: DesktopSettingsValue<number>;
    threadSpendEnabled: DesktopSettingsValue<boolean>;
    threadSpendThresholdUsd: DesktopSettingsValue<number>;
  };
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

/**
 * Whether a discovered command is safe to launch.
 *
 * `executable` alone is not that test. Discovery derives it from
 * `fs.access(X_OK)`, which succeeds for any existing file on Windows, so an
 * npm sh shim scores `true` while being unstartable. Selection in the main
 * process and the Use affordance in Settings must agree on this, so the
 * predicate lives beside the type both sides already import rather than being
 * hand-copied into each.
 */
export function isValidatedDiscoveryCandidate(candidate: {
  executable: boolean;
  failureReason?: string;
  version?: string;
  versionFailureReason?: string;
}): boolean {
  return (
    candidate.executable
    && Boolean(candidate.version)
    && !candidate.failureReason
    && !candidate.versionFailureReason
  );
}

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
  | "config"
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
    path: DesktopSettingsValue<string>;
    discovery: DesktopGitDiscoverySnapshot;
  };
};

export type DesktopFederationSettingsSnapshot = {
  mode: DesktopSettingsValue<DesktopFederationMode>;
  /**
   * Human-readable name this instance advertises to federation peers.
   * Empty means "use the machine hostname" — peers should never have to
   * recognize a raw instance GUID.
   */
  instanceLabel: DesktopSettingsValue<string>;
  /**
   * Operator-written purpose notes for this instance ("Studio Mac — PwrSnap
   * dev + screen recording"). Advertised to federation peers and read by
   * orchestration agents when routing work to an instance. Empty means no
   * notes.
   */
  instanceNotes: DesktopSettingsValue<string>;
  listenHost: DesktopSettingsValue<string>;
  listenPort: DesktopSettingsValue<number>;
  publicUrl: DesktopSettingsValue<string>;
  gatewayUrl: DesktopSettingsValue<string>;
  /**
   * Ordered client-mode gateway endpoints for one pinned gateway identity.
   * Resolved from `gateway_endpoints`, falling back to `[gateway_url]`.
   */
  gatewayEndpoints: DesktopSettingsValue<string[]>;
  /** Ordered endpoints a gateway advertises in enrollment invites. */
  advertisedEndpoints: DesktopSettingsValue<string[]>;
  /**
   * The one endpoint that is Cloudflare-fronted. Access tokens and mTLS client
   * keys are sent only to this host, because they travel in the WebSocket
   * upgrade before any pinned key is verified.
   */
  cloudflareEndpoint: DesktopSettingsValue<string>;
  cloudflareMtlsEnabled: DesktopSettingsValue<boolean>;
  cloudflareAccessServiceAuthEnabled: DesktopSettingsValue<boolean>;
  instancePrivateKey: DesktopSettingsSecretState;
  noiseStaticPrivateKey: DesktopSettingsSecretState;
  cloudflareClientCertificate: DesktopSettingsSecretState;
  cloudflareClientPrivateKey: DesktopSettingsSecretState;
  cloudflareAccessClientId: DesktopSettingsSecretState;
  cloudflareAccessClientSecret: DesktopSettingsSecretState;
};

export type DesktopSettingsSnapshot = {
  fetchedAt: number;
  configPath: string;
  configError?: string;
  runtime: {
    tokenMiser?: {
      managedCodex?: {
        state: "pending-switch" | "ready" | "unavailable";
        reason?: string;
        version?: string;
      };
      /**
       * Whether the Codex-side gate is actually installed. The feature fails
       * open by design, so an activation failure otherwise looks identical to
       * a thread that simply had nothing worth gating.
       */
      activation?: {
        state: "active" | "unavailable";
        reason?: string;
        observedAt: number;
      };
      interceptionCount: number;
      originalCharacters: number;
      baselineParentTokens: number;
      replacementTokens: number;
      retrievedTokens: number;
      estimatedParentTokensSaved: number;
    };
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
     * Gates renderer-side live transcript event reductions. When disabled,
     * every thread event is handled as before. When enabled, unrelated
     * thread-local transcript events are ignored and duplicate live activity
     * updates become no-ops.
     */
    liveTranscriptEventFiltering: DesktopSettingsValue<boolean>;
    /**
     * Gates the lightweight navigation refresh experiment. When disabled,
     * background navigation refreshes keep using broad forced snapshots.
     * When enabled, foreground polling uses the one-page active-recent
     * snapshot and focus refreshes are coalesced.
     */
    lightweightNavigationRefresh: DesktopSettingsValue<boolean>;
    /**
     * Renders LaTeX delimiters in thread Markdown with KaTeX. Disabled by
     * default so the renderer does not load the math runtime until an operator
     * explicitly opts into the experiment.
     */
    markdownMathRendering?: DesktopSettingsValue<boolean>;
    /**
     * Controls whether the released thread context-rail Pricing tab is visible.
     * The pricing ledger continues collecting usage while the tab is hidden.
     */
    threadPricingSummary?: DesktopSettingsValue<boolean>;
    /**
     * Shows provider API list-price estimates in USD when the thread Pricing
     * tab is visible.
     */
    threadPricingDisplayUsd?: DesktopSettingsValue<boolean>;
    /**
     * Shows Codex Credits estimates when the thread Pricing tab is visible.
     * Credits use Codex's token-based credit rate card rather than
     * a currency conversion from USD.
     */
    threadPricingDisplayCodexCredits?: DesktopSettingsValue<boolean>;
    /**
     * Replace oversized Codex tool results with a bounded summary and preserve
     * the exact model-facing response for deliberate retrieval. This is the
     * outer experiment gate; per-thread controls may only opt out while it is
     * enabled.
     */
    tokenMiserEnabled: DesktopSettingsValue<boolean>;
    /**
     * Inherited Token Miser state for Codex threads without a per-thread
     * override. This only has an effect while the experiment gate is enabled.
     */
    tokenMiserDefaultEnabled?: DesktopSettingsValue<boolean>;
    /**
     * Shows the experimental Tool calls tab in the thread context rail.
     * The desktop app may still collect tool metrics while this is disabled;
     * this only gates the operator-facing panel. Replay-risk safety notices
     * remain active because their cost grows while the turn is running.
     */
    threadToolAccounting?: DesktopSettingsValue<boolean>;
    /**
     * Enables Codex's upstream default-mode request_user_input feature for
     * ordinary turns, allowing skills to pause and ask structured questions
     * outside Plan mode when the installed Codex build supports it.
     */
    codexDefaultModeRequestUserInput: DesktopSettingsValue<boolean>;
    /**
     * Retained so settings snapshots can round-trip configurations written by
     * the former global managed-review experiment. Review requests now choose
     * their run mode explicitly.
     */
    managedReview?: DesktopSettingsValue<boolean>;
    /**
     * Diff condensation (a.k.a. "diff eliding") gates whether the configured
     * backend may classify less-relevant diff hunks. When disabled, every diff
     * renders in full and no structured-generation request fires.
     */
    diffCondensation: {
      enabled: DesktopSettingsValue<boolean>;
    };
  };
  imageUploads: DesktopImageUploadSettingsSnapshot;
  updates: DesktopUpdateSettingsSnapshot;
  integratedTerminal: DesktopIntegratedTerminalSettingsSnapshot;
  /**
   * Window-layout preferences remembered across launches: whether the
   * left sidebar is hidden, whether the right context rail is pinned
   * open, and which context-rail tab was last active. `activeContextTab`
   * is a plain string here; the renderer validates it against its known
   * tab ids and falls back to the default when unrecognized.
   * `editedFilesDock` and `actionRunsDock` follow the same plain-string +
   * renderer-validated
   * pattern: "above" (default, edited files render above the composer)
   * or "sidebar" (the content only shows in its context-rail tab).
   */
  ui: {
    sidebarHidden: DesktopSettingsValue<boolean>;
    contextRailPinned: DesktopSettingsValue<boolean>;
    activeContextTab: DesktopSettingsValue<string>;
    editedFilesDock: DesktopSettingsValue<string>;
    actionRunsDock: DesktopSettingsValue<string>;
  };
  federation: DesktopFederationSettingsSnapshot;
  messaging: {
    enabled: DesktopSettingsValue<boolean>;
    allowFullAccessEscalation: DesktopSettingsValue<boolean>;
    allowFullAccessThreadResume: DesktopSettingsValue<boolean>;
    fullAccessWarning: DesktopSettingsValue<DesktopMessagingFullAccessWarningGlobalPolicy>;
    inputDebounceMs: DesktopSettingsValue<number>;
    toolUpdateMode: DesktopSettingsValue<MessagingToolUpdateMode>;
    managerToolUpdateMode: DesktopSettingsValue<MessagingToolUpdateMode>;
    showStreamingOption: DesktopSettingsValue<boolean>;
    attachments: DesktopMessagingAttachmentSettingsSnapshot;
    telegram: {
      enabled: DesktopSettingsValue<boolean>;
      responseMode: DesktopSettingsValue<DesktopMessagingResponseMode>;
      streamingResponses: DesktopSettingsValue<boolean>;
      botToken: DesktopSettingsSecretState;
      authorizedUserIds: DesktopSettingsValue<DesktopAuthorizedContact[]>;
      authorizedSupergroups: DesktopSettingsValue<DesktopAuthorizedContact[]>;
    };
    discord: {
      enabled: DesktopSettingsValue<boolean>;
      responseMode: DesktopSettingsValue<DesktopMessagingResponseMode>;
      responseModeOverrides: DesktopSettingsValue<DesktopAuthorizedContact[]>;
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
      liveWorkingCards: DesktopSettingsValue<boolean>;
      responseMode: DesktopSettingsValue<DesktopMessagingResponseMode>;
      streamingResponses: DesktopSettingsValue<boolean>;
      botToken: DesktopSettingsSecretState;
      appToken: DesktopSettingsSecretState;
      signingSecret: DesktopSettingsSecretState;
      workspaceUrl: DesktopSettingsValue<string>;
      inboundMode: DesktopSettingsValue<"socket" | "events">;
      teamAuthorizationMode: DesktopSettingsValue<DesktopMessagingAuthorizationMode>;
      channelAuthorizationMode: DesktopSettingsValue<DesktopMessagingAuthorizationMode>;
      dmAccessMode: DesktopSettingsValue<DesktopMessagingSlackDmAccessMode>;
      channelUserAccessMode: DesktopSettingsValue<DesktopMessagingSlackChannelUserAccessMode>;
      groupDmAccessMode: DesktopSettingsValue<DesktopMessagingSlackGroupDmAccessMode>;
      slashCommandPrefix: DesktopSettingsValue<string>;
      registerSlashCommands: DesktopSettingsValue<boolean>;
      authorizedUserIds: DesktopSettingsValue<DesktopAuthorizedContact[]>;
      authorizedWorkspaces: DesktopSettingsValue<DesktopAuthorizedContact[]>;
      authorizedChannels: DesktopSettingsValue<DesktopAuthorizedContact[]>;
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
    providerDefaults?: Record<string, DesktopProviderModelDefaults>;
    providerThreadMigrations?: Record<
      string,
      DesktopProviderThreadModelMigration
    >;
    codex: {
      path: DesktopSettingsValue<string>;
      profile: DesktopSettingsValue<string>;
      allowFast?: DesktopSettingsValue<boolean>;
      discovery: DesktopCodexDiscoverySnapshot;
      profiles: DesktopCodexAuthProfileDiscoverySnapshot;
    };
  };
  acpAgents: {
    gemini: {
      /**
       * Optional override for the Gemini CLI executable path. When empty,
       * the kit's discovery probes $PATH + well-known bin dirs.
       */
      cliPath: DesktopSettingsValue<string>;
      /**
       * Whether this agent is enabled as a chat backend. Defaults to `true`
       * (on-by-default); disabling hides it from the model picker and the
       * chat-launch discovery path.
       */
      enabled: boolean;
    };
    grok: {
      /**
       * Optional override for the Grok CLI executable path. When empty,
       * discovery probes the standard locations ($PATH, ~/.grok/bin/grok,
       * /opt/homebrew/bin/grok, /usr/local/bin/grok).
       */
      cliPath: DesktopSettingsValue<string>;
      /**
       * Whether this agent is enabled as a chat backend. Defaults to `true`
       * (on-by-default); disabling hides it from the model picker and the
       * chat-launch discovery path.
       */
      enabled: boolean;
      /** Download and prefer PwrAgent's verified Grok fork build. */
      managedBuilds?: boolean;
      /** Which grok-build track the managed runtime follows. */
      managedBuildChannel?: DesktopUpdateChannel;
    };
    kimi: {
      /**
       * Optional override for the Kimi Code executable path. When empty,
       * the kit's discovery probes $PATH + ~/.kimi-code/bin + well-known dirs.
       */
      cliPath: DesktopSettingsValue<string>;
      /**
       * Whether this agent is enabled as a chat backend. Defaults to `true`
       * (on-by-default); disabling hides it from the model picker and the
       * chat-launch discovery path.
       */
      enabled: boolean;
    };
    qwen: {
      /**
       * Optional override for the Qwen Code executable path. When empty,
       * discovery probes the standard locations ($PATH, ~/.qwen/bin/qwen,
       * /opt/homebrew/bin/qwen, /usr/local/bin/qwen).
       */
      cliPath: DesktopSettingsValue<string>;
      /**
       * Whether this agent is enabled as a chat backend. Defaults to `true`
       * (on-by-default); disabling hides it from the model picker and the
       * chat-launch discovery path.
       */
      enabled: boolean;
    };
  };
  git: {
    /**
     * Controls background pull-request status polling. When disabled, PR
     * chips refresh only on the pre-existing triggers (selecting a thread,
     * hovering a row, or a turn finishing). When enabled, a main-process
     * poller keeps every open project's non-terminal PRs fresh on a
     * priority-tiered cadence, and a slow rotation looks for newly opened
     * pull requests.
     */
    backgroundPrPolling: DesktopSettingsValue<boolean>;
    /**
     * Global permission for automatic repair turns. Background PR monitoring
     * remains the prerequisite kill switch for this behavior.
     */
    prAutoDispatchAllowed: DesktopSettingsValue<boolean>;
    /** Default Auto-fix PR preference seeded only onto newly created threads. */
    defaultPrAutoDispatchEnabled: DesktopSettingsValue<boolean>;
    prAutoDispatchBudgetCapacity: DesktopSettingsValue<number>;
    prAutoDispatchBudgetRefillPerMinute: DesktopSettingsValue<number>;
    pausePrAutoDispatchWhenBudgetEmpty: DesktopSettingsValue<boolean>;
  };
  applications: DesktopApplicationsSnapshot;
  worktrees: {
    storage: DesktopSettingsValue<DesktopWorktreeStorageLocation>;
    effectivePath: string;
  };
};

export type DesktopSettingsConfigPatch = {
  general?: {
    confirmQuitWithInProgressThreads?: boolean;
    attentionPromoteOnTurnEnd?: boolean;
    pdfAnalysisEnabled?: boolean;
    developerMode?: boolean;
    hotCpuProfilingEnabled?: boolean;
    hotCpuProfilingStartDelayMs?: DesktopHotCpuProfileStartDelayMs;
    hotCpuProfilingTriggerMode?: DesktopHotCpuProfileTriggerMode;
    hotCpuProfilingSlowburnThresholdPercent?: number;
    hotCpuProfilingCaptureHeapSnapshot?: boolean;
    hotCpuProfilingHeapSnapshotLimit?: number;
    notificationsEnabled?: boolean;
    toolOutputAlerts?: Partial<DesktopToolOutputAlertPolicy>;
    spendAlerts?: Partial<DesktopSpendAlertPolicy>;
    appearance?: {
      theme?: DesktopAppearanceTheme;
      density?: DesktopAppearanceDensity;
      sidebarTextSize?: DesktopTextSize;
      transcriptTextSize?: DesktopTextSize;
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
    liveTranscriptEventFiltering?: boolean;
    lightweightNavigationRefresh?: boolean;
    markdownMathRendering?: boolean;
    threadPricingSummary?: boolean;
    threadPricingDisplayUsd?: boolean;
    threadPricingDisplayCodexCredits?: boolean;
    tokenMiserEnabled?: boolean;
    tokenMiserDefaultEnabled?: boolean;
    threadToolAccounting?: boolean;
    codexDefaultModeRequestUserInput?: boolean;
    managedReview?: boolean;
    diffCondensation?: {
      enabled?: boolean;
    };
  };
  imageUploads?: {
    pastedImageMaxPatches?: number;
  };
  updates?: {
    channel?: DesktopUpdateChannel;
    train?: DesktopUpdateTrain;
  };
  integratedTerminal?: {
    windowsShell?: DesktopIntegratedTerminalWindowsShell;
  };
  ui?: {
    sidebarHidden?: boolean;
    contextRailPinned?: boolean;
    activeContextTab?: string;
    editedFilesDock?: string;
    actionRunsDock?: string;
  };
  federation?: {
    mode?: DesktopFederationMode;
    instanceLabel?: string;
    instanceNotes?: string;
    listenHost?: string;
    listenPort?: number;
    publicUrl?: string;
    gatewayUrl?: string;
    gatewayEndpoints?: string[];
    advertisedEndpoints?: string[];
    cloudflareEndpoint?: string;
    cloudflareMtlsEnabled?: boolean;
    cloudflareAccessServiceAuthEnabled?: boolean;
  };
  messaging?: {
    enabled?: boolean;
    allowFullAccessEscalation?: boolean;
    allowFullAccessThreadResume?: boolean;
    fullAccessWarning?: DesktopMessagingFullAccessWarningGlobalPolicy;
    inputDebounceMs?: number;
    toolUpdateMode?: MessagingToolUpdateMode;
    managerToolUpdateMode?: MessagingToolUpdateMode;
    showStreamingOption?: boolean;
    attachments?: {
      imageProfile?: DesktopMessagingImageProfile;
      pdfProfile?: DesktopMessagingImageProfile;
      maxAttachmentBytes?: number;
      maxAttachmentCount?: number;
    };
    telegram?: {
      enabled?: boolean;
      responseMode?: DesktopMessagingResponseMode;
      streamingResponses?: boolean;
      authorizedUserIds?: DesktopAuthorizedContact[];
      authorizedSupergroups?: DesktopAuthorizedContact[];
    };
    discord?: {
      enabled?: boolean;
      responseMode?: DesktopMessagingResponseMode;
      responseModeOverrides?: DesktopAuthorizedContact[];
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
      liveWorkingCards?: boolean;
      responseMode?: DesktopMessagingResponseMode;
      streamingResponses?: boolean;
      workspaceUrl?: string;
      inboundMode?: "socket" | "events";
      teamAuthorizationMode?: DesktopMessagingAuthorizationMode;
      channelAuthorizationMode?: DesktopMessagingAuthorizationMode;
      dmAccessMode?: DesktopMessagingSlackDmAccessMode;
      channelUserAccessMode?: DesktopMessagingSlackChannelUserAccessMode;
      groupDmAccessMode?: DesktopMessagingSlackGroupDmAccessMode;
      slashCommandPrefix?: string;
      registerSlashCommands?: boolean;
      authorizedUserIds?: DesktopAuthorizedContact[];
      authorizedWorkspaces?: DesktopAuthorizedContact[];
      authorizedChannels?: DesktopAuthorizedContact[];
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
    providerDefaults?: Record<string, DesktopProviderModelDefaults>;
    providerThreadMigrations?: Record<
      string,
      DesktopProviderThreadModelMigration
    >;
    codex?: {
      path?: string;
      profile?: string;
      allowFast?: boolean;
    };
  };
  acpAgents?: {
    gemini?: {
      cliPath?: string;
      enabled?: boolean;
    };
    grok?: {
      cliPath?: string;
      enabled?: boolean;
      managedBuilds?: boolean;
      managedBuildChannel?: DesktopUpdateChannel;
    };
    kimi?: {
      cliPath?: string;
      enabled?: boolean;
    };
    qwen?: {
      cliPath?: string;
      enabled?: boolean;
    };
  };
  git?: {
    backgroundPrPolling?: boolean;
    prAutoDispatchAllowed?: boolean;
    defaultPrAutoDispatchEnabled?: boolean;
    prAutoDispatchBudgetCapacity?: number;
    prAutoDispatchBudgetRefillPerMinute?: number;
    pausePrAutoDispatchWhenBudgetEmpty?: boolean;
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
    git?: {
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

/**
 * Credential-free startup projection. Reading it is an in-memory config-store
 * lookup and must never trigger provider, application, Git, or secret
 * discovery.
 */
export type DesktopConfigBootstrapSnapshot = {
  version: number;
  configRevision: string;
  configError?: string;
  appearance: {
    theme: DesktopAppearanceTheme;
    density: DesktopAppearanceDensity;
    sidebarTextSize: DesktopTextSize;
    transcriptTextSize: DesktopTextSize;
  };
  onboarding: {
    completed: boolean;
    completedSource: DesktopOnboardingCompletedSource | "";
  };
};

export type ReadDesktopConfigBootstrapResponse = {
  snapshot: DesktopConfigBootstrapSnapshot;
};

/** Credential-free messaging projection for runtime renderer surfaces. */
export type DesktopMessagingSettingsProjection = {
  fetchedAt: number;
  messaging: DesktopSettingsSnapshot["messaging"];
  runtime: DesktopSettingsSnapshot["runtime"]["messaging"];
};

export type ReadDesktopMessagingSettingsResponse = {
  snapshot: DesktopMessagingSettingsProjection;
};

/** Single-key policy projection used by every Full Access confirmation. */
export type ReadDesktopFullAccessPolicyResponse = {
  fullAccessRiskWarningDismissed: boolean;
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

export type RefreshDesktopCodexDiscoveryRequest = {
  discoveryIntent: "settings-user-action" | "setup-user-action";
};

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
  /** ChatGPT account email extracted from the JWT in `auth.json`,
   *  when present. The onboarding wizard surfaces this after login so
   *  the operator can confirm they signed in with the right account. */
  email?: string;
  /** ChatGPT plan type ("free", "plus", "pro", "team", "enterprise", …)
   *  pulled from the JWT's OpenAI-namespaced auth claim. Best-effort —
   *  if the claim shape changes we fall back to `undefined` rather than
   *  surfacing wrong info. */
  planType?: string;
};

export type PickGhCommandResponse = {
  canceled: boolean;
  path?: string;
  error?: string;
  candidate?: DesktopGhDiscoveryCandidate;
};

export type PickGitCommandResponse = {
  canceled: boolean;
  path?: string;
  error?: string;
  candidate?: DesktopGitDiscoveryCandidate;
};

/**
 * How much a platform's code-signing system vouches for an executable,
 * ordered strongest to weakest. Rendered as a chip beside every external
 * program PwrAgent runs but does not ship.
 *
 * `adhoc` is deliberately not a warning: a Homebrew bottle is relinked at
 * install, which invalidates any upstream signature, so ad-hoc is the
 * overwhelmingly common state of a developer machine's `git`. A chip that
 * cried wolf there would teach operators to ignore the chip.
 */
export type DesktopCodeSignatureTrust =
  /** Signed by the platform vendor itself (macOS `Software Signing`). */
  | "platform"
  /** Developer ID signed and accepted by Apple's notary service. */
  | "notarized"
  /** A real publisher signature: Developer ID, or a valid Authenticode chain. */
  | "publisher"
  /** Signed with no identity — integrity only, no origin. */
  | "adhoc"
  /** No signature at all. */
  | "unsigned"
  /** A signature exists but does not verify. */
  | "invalid"
  /** The probe could not classify the file (spawn failed, timed out). */
  | "unknown"
  /** The platform has no code-signing system to report (Linux). */
  | "unsupported";

export type DesktopCodeSignature = {
  /** Absolute path the signature was read from. */
  path: string;
  trust: DesktopCodeSignatureTrust;
  /**
   * Who signed it, when the platform names them — the macOS leaf authority
   * ("Developer ID Application: Microsoft Corporation (UBF8T346G9)") or the
   * Authenticode signer's common name. Shown on hover, never in the chip.
   */
  signer?: string;
  /** macOS Team Identifier, when the signature carries one. */
  teamId?: string;
  /** Why the probe produced `unknown` or `invalid`, for the hover title. */
  detail?: string;
};

export type InspectCodeSignaturesRequest = {
  paths: string[];
};

export type InspectCodeSignaturesResponse = {
  signatures: DesktopCodeSignature[];
};

export type DesktopConfigDomainKey =
  | "general"
  | "onboarding"
  | "experimental"
  | "messaging"
  | "federation"
  | "models"
  | "providers"
  | "applications"
  | "git"
  | "updates"
  | "worktrees"
  | "ui"
  | "integratedTerminal"
  | "imageUploads";

export type DesktopSettingsConfigUpdate = {
  version: number;
  configRevision: string;
  changedDomains: readonly DesktopConfigDomainKey[];
  normalizedPatch: DesktopSettingsConfigPatch;
  scheduledProviderRefreshes: readonly string[];
};

/** Main-to-renderer notification that the normalized in-memory config store
 * advanced. The renderer re-reads the cache-backed Settings projection; the
 * notification itself carries no secrets and grants no discovery authority. */
export type DesktopSettingsRuntimeChangedEvent = {
  version: number;
  configRevision: string;
  changedDomains: readonly DesktopConfigDomainKey[];
};

export type DesktopSettingsWriteResponse = {
  update: DesktopSettingsConfigUpdate;
  snapshot: DesktopSettingsSnapshot;
};

export type DesktopSettingsSecretWriteResponse = {
  secret: DesktopSettingsSecretName;
  state: DesktopSettingsSecretState;
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

/**
 * Graduate ONLY THE CONFIG of the bootstrap profile (`.bootstrap/`)
 * into a real profile — the `config.toml` payload (theme, density,
 * messaging acknowledgment, etc) plus the registry's
 * `default_profile` pointer.
 *
 * **Does NOT graduate secrets.** The wizard buffers secrets in
 * renderer memory and graduates them via the separate
 * `writeSecretsToProfile` IPC. This IPC's name is intentionally
 * scoped (`Config`, not just `Bootstrap`) so a future caller can't
 * accidentally graduate config and lose secrets by calling only
 * this primitive. The wizard's Finish path calls
 * `writeSecretsToProfile` THEN `graduateBootstrapConfigToProfile`
 * in that order; reverse it and secrets land in `.bootstrap/`
 * before it gets reaped.
 *
 * **Does NOT close the bootstrap window or open a new window for the
 * target profile** — the caller still does that via
 * `openPwrAgentProfile`. Splitting those responsibilities keeps
 * the IPC purely about data graduation.
 *
 * Semantics:
 *   - When the main process is NOT in bootstrap mode, this is a
 *     no-op (`graduated: false`, `reason: "not-bootstrap-mode"`).
 *     The wizard can safely call it unconditionally on Finish.
 *   - When in bootstrap mode: copy the bootstrap profile's
 *     `config.toml` into `<targetProfile>/config.toml` (replacing
 *     bootstrap-only fields like `onboarding.completed`), set
 *     `profiles.toml::default_profile = targetProfile`, and mark
 *     the `.bootstrap/` dir for cleanup on the next boot.
 */
/**
 * Write one or more secrets to a specific profile's keychain. Used by
 * the onboarding wizard's Finish path in bootstrap mode: the wizard
 * collects messaging tokens in renderer memory (it
 * doesn't write to the bootstrap profile's keychain — those values
 * would be stranded on `.bootstrap/state.db` and never reach the
 * operator's chosen real profile), and at graduation it writes the
 * buffered values to each created profile's keychain via this IPC.
 *
 * Multiple-profile mode supports per-profile messaging credentials. The
 * caller invokes this IPC once per profile.
 */
export type WriteDesktopSecretsToProfileRequest = {
  /** Target PwrAgent profile name. Must exist (the wizard creates it
   *  before calling this IPC) and pass `isValidProfileName`. */
  profile: string;
  /** Secrets to write. Empty-string values are treated as "delete the
   *  secret" so the same payload can clear stale entries on Replay. */
  secrets: Record<string, string>;
};

export type WriteDesktopSecretsToProfileResponse = {
  profile: string;
  /** Names that were actually written / cleared (skips empty noop
   *  inputs for unknown secret names). Useful for telemetry. */
  written: string[];
};

/**
 * Boot info surfaced from the main process to the renderer so the
 * onboarding wizard can adjust its entry point. Returned by the
 * `getBootInfo` IPC. The `mode` distinguishes "the operator's
 * existing profile" from "the throwaway .bootstrap/ session"; the
 * optional `requestedProfileName` is populated when the boot
 * decision was `missing-named-profile` (CLI/env named a non-existent
 * profile) — the wizard surfaces it as "PwrAgent doesn't know `foo`
 * yet. Set it up, or quit?".
 */
/**
 * Wait for another PwrAgent process to be alive on a target profile.
 *
 * Used by the onboarding wizard's Finish path: after spawning the
 * new profile's Electron via `openPwrAgentProfile`, the wizard
 * polls this IPC until the spawned process writes its first runtime
 * heartbeat marker — proving its app state initialized and its
 * renderer mounted. Only then does the wizard call `quitApp` to
 * close the bootstrap window. Critical for dev mode, where the
 * parent `electron-vite` process kills the Vite dev server when
 * the bootstrap Electron exits; waiting lets the new process load
 * its renderer assets first.
 */
export type WaitForDesktopProfileAliveRequest = {
  profile: string;
  /** Maximum wait, in ms. Defaults to 10_000 in the handler.
   *  Caller should set it tight enough that a UI hang doesn't
   *  feel broken (the wizard's Done screen is showing). */
  timeoutMs?: number;
};

export type WaitForDesktopProfileAliveResponse = {
  profile: string;
  alive: boolean;
  /** How long we waited before the marker showed up (or the
   *  timeout fired). For telemetry / debugging only. */
  waitedMs: number;
};

export type DesktopBootInfo = {
  mode: "active-profile" | "bootstrap";
  /** Boot decision kind, mirrored to the renderer so the wizard can
   *  pick the right entry mode without rebuilding the decision
   *  tree client-side. */
  decisionKind:
    | "open"
    | "missing-named-profile"
    | "missing-default-profile"
    | "no-profile-configured";
  /** Populated when `decisionKind === "missing-named-profile"`. Echoes
   *  the name from `--profile=foo` or `PWRAGENT_PROFILE=foo` so the
   *  wizard can pre-populate the naming step. */
  requestedProfileName?: string;
  /** Populated for `missing-default-profile` only — the name the
   *  registry pointed at that no longer exists on disk. */
  configuredDefaultName?: string;
  /** Populated in `active-profile` mode — the profile this renderer
   *  is bound to. Used by the wizard's Finish path to graduate
   *  buffered messaging credentials to the right
   *  target profile when the operator picks Shared mode or runs
   *  via Help → Replay Onboarding. Bootstrap mode leaves it
   *  undefined; the wizard graduates per-profile through the
   *  Multiple/Isolated path instead. */
  activeProfileName?: string;
};

export type GraduateDesktopBootstrapConfigToProfileRequest = {
  targetProfile: string;
};

export type GraduateDesktopBootstrapConfigToProfileResponse = {
  graduated: boolean;
  /** Populated when `graduated === false` to explain why. The wizard
   *  uses this to log diagnostics; operator-facing UI just ignores
   *  it (a no-op graduation is always recoverable). */
  reason?: "not-bootstrap-mode" | "no-bootstrap-config";
  targetProfile: string;
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
  federationTarget?: FederationTarget;
  kind: DesktopApplicationKind;
  targetPath: string;
  targetLine?: number;
  targetColumn?: number;
};

export type OpenDesktopApplicationResponse = {
  opened: true;
};

export type ReadDesktopApplicationsRequest = {
  federationTarget?: FederationTarget;
};

export type ReadDesktopApplicationsResponse = {
  applications: DesktopApplicationsSnapshot;
};

/**
 * Open a filesystem path with the OS default handler (`shell.openPath`). The
 * fallback for "open this edited file" when no editor application is
 * configured/available. `opened` is false with an `error` message when the OS
 * could not open it.
 */
export type OpenPathRequest = {
  path: string;
};

export type OpenPathResponse = {
  opened: boolean;
  error?: string;
};

export type ReadMarkdownFileRequest = {
  path: string;
};

export type ReadMarkdownFileResponse = {
  path: string;
  content?: string;
  error?: string;
};

export type MarkdownFileViewerFile = {
  path: string;
  label: string;
  line?: number;
  column?: number;
};

export type MarkdownFileViewerContext = {
  key: string;
  title: string;
  threadTitle?: string;
  projectPath?: string;
};

export type OpenMarkdownFileViewerRequest = {
  context: MarkdownFileViewerContext;
  file: MarkdownFileViewerFile;
  editorApplication?: DesktopApplicationDiscoveryCandidate;
};

export type OpenMarkdownFileViewerResponse = {
  opened: true;
};

export type MarkdownFileViewerSnapshot = {
  context: MarkdownFileViewerContext;
  files: MarkdownFileViewerFile[];
  selectedPath: string;
  editorApplication?: DesktopApplicationDiscoveryCandidate;
};

export type ReadMarkdownFileViewerSnapshotRequest = {
  contextKey: string;
};

export type ReadMarkdownFileViewerSnapshotResponse = {
  snapshot?: MarkdownFileViewerSnapshot;
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

/**
 * Read a persisted update channel from an unvalidated source — a TOML scalar,
 * a JSON field on disk. One parser for both, so a channel that stops being
 * accepted stops being accepted everywhere at once.
 */
export function parseDesktopUpdateChannel(
  value: unknown,
): DesktopUpdateChannel | undefined {
  return typeof value === "string" && isDesktopUpdateChannel(value)
    ? value
    : undefined;
}

export function isDesktopUpdateTrain(
  value: string,
): value is DesktopUpdateTrain {
  return DESKTOP_UPDATE_TRAINS.includes(value as DesktopUpdateTrain);
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

export function isDesktopTextSize(value: string): value is DesktopTextSize {
  return DESKTOP_TEXT_SIZES.includes(value as DesktopTextSize);
}

export function isDesktopIntegratedTerminalWindowsShell(
  value: string,
): value is DesktopIntegratedTerminalWindowsShell {
  return DESKTOP_INTEGRATED_TERMINAL_WINDOWS_SHELLS.includes(
    value as DesktopIntegratedTerminalWindowsShell,
  );
}

export function isDesktopCodexProfileModel(
  value: string,
): value is DesktopCodexProfileModel {
  return DESKTOP_CODEX_PROFILE_MODELS.includes(
    value as DesktopCodexProfileModel,
  );
}

export function isDesktopHotCpuProfileStartDelayMs(
  value: number,
): value is DesktopHotCpuProfileStartDelayMs {
  return DESKTOP_HOT_CPU_PROFILE_START_DELAYS_MS.includes(
    value as DesktopHotCpuProfileStartDelayMs,
  );
}

export function isDesktopHotCpuProfileTriggerMode(
  value: string,
): value is DesktopHotCpuProfileTriggerMode {
  return DESKTOP_HOT_CPU_PROFILE_TRIGGER_MODES.includes(
    value as DesktopHotCpuProfileTriggerMode,
  );
}

export function isDesktopFederationMode(
  value: string,
): value is DesktopFederationMode {
  return DESKTOP_FEDERATION_MODES.includes(value as DesktopFederationMode);
}

/**
 * Credential-test surface — drives the per-credential "Test" buttons
 * on the Settings → Messaging and Settings → Models panels. Each kind
 * maps to a distinct main-process probe:
 *
 * - `telegram`  → HTTP GET https://api.telegram.org/bot<TOKEN>/getMe
 * - `discord`   → HTTP GET https://discord.com/api/v10/users/@me
 * - `codex`     → spawn `<resolved-path> --version`
 * - `mattermost` → GET <serverUrl>/api/v4/users/me with bot token
 * - `slack`     → Slack Web API `auth.test` plus Socket Mode `apps.connections.open`
 */
export const SETTINGS_CREDENTIAL_TEST_KINDS = [
  "telegram",
  "discord",
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
   *  e.g. the version string reported by codex. */
  detail?: string;
  /** Failure detail when `status === "failed"`. Truncated by the
   *  tester to ~240 chars so we never surface a giant stack trace. */
  errorMessage?: string;
};

export type SettingsCredentialTestRequest = {
  kind: SettingsCredentialTestKind;
};

/** Prepare the current Slack manifest for a new or existing app. */
export type SlackCreateAppRequest = {
  /** When true (default), also open the URL via the OS browser. */
  open?: boolean;
  /** Create a new app from the manifest, or open Slack Apps to update one. */
  mode?: "create" | "update";
};

export type SlackCreateAppResponse = {
  url: string;
  oversized: boolean;
  /** Raw official manifest JSON. Present so an oversized URL can still be pasted. */
  manifestJson: string;
  opened: boolean;
};

/**
 * Permissions PwrAgent commonly needs to post rich replies and turn a
 * user-selected Discord message into a public thread.
 */
export const DISCORD_THREAD_REPLY_PERMISSIONS = [
  {
    id: "view_channel",
    label: "View Channel",
  },
  {
    id: "send_messages",
    label: "Send Messages",
  },
  {
    id: "embed_links",
    label: "Embed Links",
  },
  {
    id: "attach_files",
    label: "Attach Files",
  },
  {
    id: "read_message_history",
    label: "Read Message History",
  },
  {
    id: "create_public_threads",
    label: "Create Public Threads",
  },
  {
    id: "send_messages_in_threads",
    label: "Send Messages in Threads",
  },
] as const;

export type DiscordThreadReplyPermissionId =
  (typeof DISCORD_THREAD_REPLY_PERMISSIONS)[number]["id"];

export type DiscordThreadPermissionStatus = "ok" | "failed" | "unset";

export type ListDiscordThreadPermissionChannelsRequest = {
  guildId: string;
};

export type ListDiscordThreadPermissionChannelsResponse = {
  channels: Array<{
    categoryName?: string;
    id: string;
    kind: "announcement" | "text";
    name: string;
  }>;
  errorMessage?: string;
  guildId: string;
  guildName?: string;
  status: DiscordThreadPermissionStatus;
};

export type InspectDiscordThreadPermissionsRequest = {
  channelId: string;
  guildId: string;
};

export type InspectDiscordThreadPermissionsResponse = {
  botId?: string;
  channelId: string;
  checkedAt: number;
  durationMs: number;
  errorMessage?: string;
  guildId: string;
  permissions: Array<{
    granted: boolean;
    id: DiscordThreadReplyPermissionId;
    label: string;
  }>;
  status: DiscordThreadPermissionStatus;
};

/**
 * Open an OAuth authorization request that includes PwrAgent's suggested
 * least-privilege Discord permissions. Discord still requires an administrator
 * to approve the request.
 */
export type OpenDiscordThreadPermissionRequest = {
  guildId?: string;
  /** When false, return the URL without opening it. */
  open?: boolean;
};

export type OpenDiscordThreadPermissionResponse = {
  opened: boolean;
  url: string;
};
