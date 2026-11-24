import {
  codexSkillProfileNameError,
  type CodexSkillProfile,
} from "@pwragent/shared/contracts/codex-skill-profiles";
import desktopPackage from "../../../package.json" with { type: "json" };
import {
  assertHotCpuCaptureRules,
  isHotCpuCaptureRules,
  migrateHotCpuCaptureRules,
  primaryHotCpuRule,
  type HotCpuCaptureRules,
} from "@pwragent/shared/hot-cpu-rules";
import type { DesktopCheckoutHibernationPolicy } from "@pwragent/shared/checkout-hibernation-policy";
import type { DesktopThreadArchiveConfig } from "@pwragent/shared/thread-archive-policy";
import type { FederationPeerRole } from "@pwragent/shared/contracts/federation";
import type { ThreadExecutionMode } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadTodoMergeMethod } from "@pwragent/shared/contracts/thread-todos";
import {
  FORGE_AGENT_TOOL_GROUPS,
  FORGE_AGENT_TOOL_RULE_GROUPS,
  isForgeAgentToolAccess,
  isForgeAgentToolRuleGroup,
  normalizeForgeAgentToolRules,
  normalizeForgeRuleRepository,
  validateForgeAgentToolRule,
  type ForgeAgentToolAccess,
  type ForgeAgentToolGroup,
  type ForgeAgentToolRule,
} from "@pwragent/shared/contracts/forge-agent-tools";
import { isAcpBackendId } from "@pwragent/shared/contracts/navigation";
import { isThreadTodoMergeMethod } from "@pwragent/shared/contracts/thread-todos";
import {
  normalizeTaskMonitorModelChoice,
  type DesktopTaskMonitorModelChoice,
} from "@pwragent/shared/helper-models";
import { normalizeModelProviderDefaults, providerPickerValue } from "@pwragent/shared/provider-picker";
import {
  validateCodexModelProviders,
  type CodexModelProviderSettings,
} from "@pwragent/shared/codex-model-providers";
import { validateLocalModelIds } from "@pwragent/shared/local-model-pricing";
import {
  MATHOS_PLATFORM_DEFAULT_ORIGIN,
  MATHOS_TEAM_ID,
  normalizeMathosPlatformOrigin,
  normalizeResearchHarnessConfig,
  type ResearchHarnessConfig,
} from "@pwragent/shared/research-harness";
import { GITHUB_ENTERPRISE_HOSTS_CONFLICT, isGithubEnterpriseLogin, mergeGithubEnterpriseHosts, normalizeGithubEnterpriseHost, validateGithubEnterpriseHosts } from "@pwragent/shared/github-enterprise-hosts";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { validateCodexConfigOverrides } from "./codex-config-overrides";
import { requireMessagingSafetyAcknowledgment } from "./messaging-safety";
import { parseTelegramConnections, telegramConnectionConfigRows } from "./telegram-connections-config";
import { normalizeOpenAIDecisionsAccountId } from "@pwragent/shared/openai-decisions";
import os from "node:os";
import path from "node:path";
import type {
  DesktopAppearanceDensity,
  DesktopDarkTheme,
  DesktopLightTheme,
  DesktopAppearanceTheme,
  DesktopChatReplyComposer,
  DesktopAuthorizedContact,
  DesktopTelegramConnection,
  DesktopCodexProfileModel,
  DesktopContextMoonStyle,
  DesktopOpenAIDecisionsSettings,
  DesktopFederationMode,
  DesktopGithubEnterpriseHostsSetting,
  GithubEnterpriseAccountPin,
  DesktopHotCpuProfileStartDelayMs,
  DesktopHotCpuProfileTriggerMode,
  DesktopIntegratedTerminalWindowsShell,
  DesktopLogsViewerPreferences,
  DesktopMessagingAcknowledgment,
  DesktopMessagingAuthorizationMode,
  DesktopMessagingFullAccessWarningGlobalPolicy,
  DesktopMessagingFullAccessWarningUserPolicy,
  DesktopMessagingImageProfile,
  DesktopMessagingResponseMode,
  DesktopMessagingSlackChannelUserAccessMode,
  DesktopMessagingSlackDmAccessMode,
  DesktopMessagingSlackGroupDmAccessMode,
  DesktopOnboardingCompletedSource,
  DesktopProviderModelDefaults,
  DesktopProviderThreadModelMigration,
  DesktopSettingsConfigPatch,
  DesktopAgentNotificationPolicy,
  DesktopSpendAlertPolicy,
  DesktopTextSize,
  DesktopToolOutputAlertPolicy,
  DesktopUpdateChannel,
  DesktopUpdateSelectionSource,
  DesktopUpdateTrain,
  DesktopWorktreeStorageLocation,
} from "@pwragent/shared/contracts/settings";
import type { DesktopDecisionModelSettings } from "@pwragent/shared/decision-models";
import type { DesktopHelperModelChoice, DesktopHelperModelSettings } from "@pwragent/shared/helper-models";
import type { MessagingToolUpdateMode } from "@pwragent/shared/contracts/messaging";
import {
  DESKTOP_APPEARANCE_DENSITY_DEFAULT,
  DESKTOP_DARK_THEME_DEFAULT,
  DESKTOP_LIGHT_THEME_DEFAULT,
  DESKTOP_APPEARANCE_THEME_DEFAULT,
  DESKTOP_TEXT_SIZE_DEFAULT,
  DESKTOP_CONTEXT_MOON_STYLE_DEFAULT,
  DESKTOP_CODEX_PROFILE_MODEL_DEFAULT,
  DESKTOP_FEDERATION_MODE_DEFAULT,
  DESKTOP_INTEGRATED_TERMINAL_WINDOWS_SHELL_DEFAULT,
  isDesktopAppearanceDensity,
  isDesktopDarkTheme,
  isDesktopLightTheme,
  isDesktopAppearanceTheme,
  isDesktopTextSize,
  isDesktopContextMoonStyle,
  isDesktopCodexProfileModel,
  isDesktopFederationMode,
  isDesktopHotCpuProfileStartDelayMs,
  isDesktopHotCpuProfileTriggerMode,
  isDesktopIntegratedTerminalWindowsShell,
  isDesktopLogsContextLines,
  isDesktopLogsSearchMode,
  isDesktopLogsStoredLevel,
  isDesktopOnboardingCompletedSource,
  DESKTOP_LOGS_VIEWER_DEFAULTS,
  isDesktopWorktreeStorageLocation,
  isDesktopUpdateSelectionSource,
  isDesktopUpdateTrain,
  parseDesktopUpdateChannel,
} from "@pwragent/shared/contracts/settings";
import { isFederationGatewayEndpointUrl } from "@pwragent/shared/contracts/federation";
import { normalizeDecisionModelSettings } from "@pwragent/shared/decision-models";
import {
  sanitizeMessagingContactHandle,
  sanitizeMessagingContactLabel,
} from "@pwragent/shared/messaging-contact-labels";
import { DEFAULT_PASTED_IMAGE_MAX_PATCHES } from "../../shared/image-normalization";
import { resolveActiveProfilePath } from "../profile";
import {
  ACP_AGENTS_ANTIGRAVITY_CLI_PATH_ENV,
  ACP_AGENTS_GEMINI_CLI_PATH_ENV,
  ACP_AGENTS_GROK_CLI_PATH_ENV,
  ACP_AGENTS_KIMI_CLI_PATH_ENV,
  ACP_AGENTS_QWEN_CLI_PATH_ENV,
} from "./desktop-settings-env";
import {
  applyTomlEdits,
  parseTomlTables,
  type TomlEdit,
  type TomlEditScalar,
  type TomlTables,
  type TomlValue,
} from "./toml-editor";

type DesktopConfigPathOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  xdgConfigHome?: string;
  cliProfile?: string;
  argv?: readonly string[];
};

type AuthorizedContactConfig = DesktopAuthorizedContact;
type LegacyChatReplyComposer =
  | "textarea"
  | "tiptap-chips"
  | "custom-widget-chips";
type StoredChatReplyComposer =
  | DesktopChatReplyComposer
  | LegacyChatReplyComposer;

export type DesktopSettingsConfig = {
  research?: {
    source?: import("@pwragent/shared/research-harness").ResearchHarnessSource;
    harness?: import("@pwragent/shared/research-harness").ResearchHarnessConfig;
    mathos?: import("@pwragent/shared/research-harness").ResearchMathosConfig;
  };
  general?: {
    confirmQuitWithInProgressThreads?: boolean;
    attentionPromoteOnTurnEnd?: boolean;
    pinnedThreadsOnTop?: boolean;
    autoFixReviews?: boolean;
    passSetupVariablesToAgents?: boolean;
    interactiveSvgSkipNotice?: boolean;
    interactiveSvgAutoOpen?: boolean;
    htmlPreviewRunScripts?: boolean;
    mcpGatewayEnabled?: boolean;
    pdfAnalysisEnabled?: boolean;
    developerMode?: boolean;
    hotCpuProfilingEnabled?: boolean;
    hotCpuProfilingStartDelayMs?: DesktopHotCpuProfileStartDelayMs;
    hotCpuProfilingCaptureRules?: HotCpuCaptureRules;
    hotCpuProfilingTriggerMode?: DesktopHotCpuProfileTriggerMode;
    hotCpuProfilingSlowburnThresholdPercent?: number;
    hotCpuProfilingCaptureChromiumTrace?: boolean;
    hotCpuProfilingCaptureHeapSnapshot?: boolean;
    hotCpuProfilingHeapSnapshotLimit?: number;
    notificationsEnabled?: boolean;
    /** Legacy location used by Token Miser development builds. */
    tokenMiserEnabled?: boolean;
    toolOutputAlerts?: Partial<DesktopToolOutputAlertPolicy>;
    spendAlerts?: Partial<DesktopSpendAlertPolicy>;
    agentNotifications?: Partial<DesktopAgentNotificationPolicy>;
    appearance?: {
      theme?: DesktopAppearanceTheme;
      darkTheme?: DesktopDarkTheme;
      lightTheme?: DesktopLightTheme;
      themedDockIcon?: boolean;
      terminalMinimumContrast?: boolean;
      calmMotion?: boolean;
      density?: DesktopAppearanceDensity;
      sidebarTextSize?: DesktopTextSize;
      transcriptTextSize?: DesktopTextSize;
      contextMoon?: DesktopContextMoonStyle;
    };
    markdown?: {
      incrementalRendering?: boolean;
      mathRendering?: boolean;
    };
    codexProfileModel?: DesktopCodexProfileModel;
    messagingAcknowledgment?: DesktopMessagingAcknowledgment | null;
  };
  onboarding?: {
    completed?: boolean;
    completedSource?: DesktopOnboardingCompletedSource;
  };
  experimental?: {
    chatReplyComposer?: StoredChatReplyComposer;
    fullAccessRiskWarningDismissed?: boolean;
    threadPricingSummary?: boolean;
    threadPricingDisplayUsd?: boolean;
    threadPricingDisplayCodexCredits?: boolean;
    tokenMiserEnabled?: boolean;
    tokenMiserDefaultEnabled?: boolean;
    codexToolDiscovery?: boolean;
    researchEnabled?: boolean;
    resourceCheckoutsEnabled?: boolean;
    tokenMiserFocusedSummariesEnabled?: boolean;
    tokenMiserPollingReviewsEnabled?: boolean;
    tokenMiserDiagnosticsEnabled?: boolean;
    codexDefaultModeRequestUserInput?: boolean;
    codexSkillQuestionsWarningDismissed?: boolean;
    codexConfigWarningsDismissed?: string[];
    managedReview?: boolean;
  };
  imageUploads?: {
    pastedImageMaxPatches?: number;
  };
  updates?: {
    channel?: DesktopUpdateChannel;
    train?: DesktopUpdateTrain;
    /** Derived by the write path, never accepted from a patch — see
     *  `DesktopUpdateSelectionSource`. Absent in every file written before
     *  this key existed; `resolveUpdateSelection` classifies those. */
    selectionSource?: DesktopUpdateSelectionSource;
  };
  integratedTerminal?: {
    windowsShell?: DesktopIntegratedTerminalWindowsShell;
  };
  ui?: {
    sidebarHidden?: boolean;
    contextRailPinned?: boolean;
    projectIndexHidden?: boolean;
    projectIndexWidth?: number;
    activeContextTab?: string;
    editedFilesDock?: string;
    actionRunsDock?: string;
    launchpadConnectionsDock?: string;
    logs?: Partial<DesktopLogsViewerPreferences>;
  };
  federation?: {
    mode?: DesktopFederationMode;
    /**
     * This instance's own containment (member-containment.ts). Contained
     * refuses its own outbound federation requests and limits its models'
     * agent tools. Absent means full.
     */
    memberRole?: FederationPeerRole;
    instanceLabel?: string;
    instanceNotes?: string;
    listenHost?: string;
    listenPort?: number;
    compressionEnabled?: boolean;
    allowRemoteShells?: boolean;
    allowPortForwarding?: boolean;
    allowFilePush?: boolean;
    allowFilePull?: boolean;
    allowFilePullOutsideThreadDirectories?: boolean;
    filePushDirectory?: string;
    publicUrl?: string;
    gatewayUrl?: string;
    gatewayEndpoints?: string[];
    advertisedEndpoints?: string[];
    cloudflareEndpoint?: string;
    cloudflareMtlsEnabled?: boolean;
    cloudflareAccessServiceAuthEnabled?: boolean;
    cloudflareAccessOAuthEnabled?: boolean;
    cloudflareGatewayEnabled?: boolean;
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
      authorizedUserIds?: AuthorizedContactConfig[];
      authorizedSupergroups?: AuthorizedContactConfig[];
      connections?: DesktopTelegramConnection[];
      invalidConnections?: true;
    };
    discord?: {
      enabled?: boolean;
      responseMode?: DesktopMessagingResponseMode;
      responseModeOverrides?: AuthorizedContactConfig[];
      streamingResponses?: boolean;
      applicationId?: string;
      authorizedUserIds?: AuthorizedContactConfig[];
      authorizedGuilds?: AuthorizedContactConfig[];
    };
    mattermost?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      serverUrl?: string;
      callbackBaseUrl?: string;
      slashCommandPrefix?: string;
      registerSlashCommands?: boolean;
      authorizedUserIds?: AuthorizedContactConfig[];
      authorizedTeams?: AuthorizedContactConfig[];
      authorizedConversations?: AuthorizedContactConfig[];
    };
    slack?: {
      enabled?: boolean;
      liveWorkingCards?: boolean;
      responseMode?: DesktopMessagingResponseMode;
      streamingResponses?: boolean;
      appName?: string;
      workspaceUrl?: string;
      inboundMode?: "socket" | "events";
      teamAuthorizationMode?: DesktopMessagingAuthorizationMode;
      channelAuthorizationMode?: DesktopMessagingAuthorizationMode;
      dmAccessMode?: DesktopMessagingSlackDmAccessMode;
      channelUserAccessMode?: DesktopMessagingSlackChannelUserAccessMode;
      groupDmAccessMode?: DesktopMessagingSlackGroupDmAccessMode;
      slashCommandPrefix?: string;
      registerSlashCommands?: boolean;
      authorizedUserIds?: AuthorizedContactConfig[];
      authorizedWorkspaces?: AuthorizedContactConfig[];
      authorizedChannels?: AuthorizedContactConfig[];
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
      authorizedUserIds?: AuthorizedContactConfig[];
      authorizedChats?: AuthorizedContactConfig[];
      authorizedTenants?: AuthorizedContactConfig[];
    };
    line?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      webhookUrl?: string;
      callbackBaseUrl?: string;
      botUserId?: string;
      authorizedUserIds?: AuthorizedContactConfig[];
      authorizedGroups?: AuthorizedContactConfig[];
      authorizedRooms?: AuthorizedContactConfig[];
    };
  };
  models?: {
    usageAccountGroups?: Record<string, string>;
    usageAccountNames?: Record<string, string>;
    providerDefaults?: Record<string, DesktopProviderModelDefaults>;
    providerThreadMigrations?: Record<
      string,
      DesktopProviderThreadModelMigration
    >;
    helperModels?: DesktopHelperModelSettings;
    taskMonitorModels?: Record<string, DesktopTaskMonitorModelChoice>;
    decisionModels?: DesktopDecisionModelSettings;
    openaiDecisions?: DesktopOpenAIDecisionsSettings;
    audioTranscriptionEnabled?: boolean;
    codex?: {
      path?: string;
      profile?: string;
      allowFast?: boolean;
      /** Download and use PwrAgent's own Codex build. Token Miser implies it. */
      managedBuilds?: boolean;
      /** Which pwrdrvr/codex track the managed runtime follows. */
      managedBuildChannel?: DesktopUpdateChannel;
      configOverrides?: string[];
      skillProfiles?: CodexSkillProfile[];
      localModelIds?: string[];
      providers?: CodexModelProviderSettings[];
      /**
       * `[models.codex.app_server_recycle]`: when an idle Codex app server is
       * replaced. Unset fields keep their defaults. Read only; no UI writes it.
       */
      appServerRecycle?: {
        enabled?: boolean;
        idleMinutes?: number;
        maxUptimeHours?: number;
        maxChildProcesses?: number;
        maxOpenFds?: number;
      };
    };
  };
  acpAgents?: {
    antigravity?: {
      cliPath?: string;
      enabled?: boolean;
    };
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
    watchMergeBuilds?: boolean;
    prAutoDispatchBudgetCapacity?: number;
    prAutoDispatchBudgetRefillPerMinute?: number;
    pausePrAutoDispatchWhenBudgetEmpty?: boolean;
    defaultMergeMethod?: ThreadTodoMergeMethod;
    /**
     * `[git] github_enterprise_hosts`: exact GitHub Enterprise hostnames an
     * agent-supplied CI run URL may name. Keep invalid strings for Settings.
     */
    githubEnterpriseHosts?: DesktopGithubEnterpriseHostsSetting;
    githubEnterpriseAccounts?: GithubEnterpriseAccountPin[];
    agentTools?: {
      enabled?: boolean;
      access?: Partial<Record<ForgeAgentToolGroup, ForgeAgentToolAccess>>;
      rules?: ForgeAgentToolRule[];
      /** Repositories named by a rule entry that could not be read. */
      unreadableRuleRepositories?: string[];
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
      enabled?: boolean;
      path?: string;
    };
    glab?: {
      enabled?: boolean;
      path?: string;
      host?: string;
    };
    git?: {
      path?: string;
      /** Downloaded PwrDrvr Git release chosen with Use (generation id). */
      managed?: string;
      /** What Roll back returns to: `bundled`, `managed:<id>` or `path:<path>`. */
      managedPrevious?: string;
      /** Build track Settings → Git → Updates offers releases from. */
      managedBuildChannel?: DesktopUpdateChannel;
    };
  };
  worktrees?: {
    archive?: DesktopThreadArchiveConfig;
    hibernate?: Partial<DesktopCheckoutHibernationPolicy>;
    storage?: DesktopWorktreeStorageLocation;
    /** `base_directory`: replaces the home folder for `user-home` worktrees. */
    baseDirectory?: string;
    /** `base_directory_includes_codex`: Codex threads use the folder too. */
    baseDirectoryIncludesCodex?: boolean;
  };
};

type TomlScalar = TomlValue;

const LEGACY_AUTHORIZED_CONTACT_LAST_VERSION = "1.0.0-alpha.9";
const LEGACY_SETTINGS_MARKER = "pwragent-legacy-settings";
const RETIRED_DIFF_CONDENSATION_HELPER_ID = "diff_condensation";
const LEGACY_PROVIDER_DEFAULTS_LAST_VERSION = "1.4.10";
const LEGACY_PROVIDER_DEFAULTS_SHAPE = "backend-table-array";
const LEGACY_CHAT_REPLY_COMPOSER_LAST_VERSION = "1.0.0-alpha.8";
const LEGACY_BACKGROUND_PR_POLLING_LAST_VERSION = "1.0.0-beta.50";
const LEGACY_FEDERATION_GATEWAY_URL_LAST_VERSION = "1.0.0-beta.50";
const LEGACY_TOKEN_MISER_GENERAL_LAST_VERSION = "1.1.0-alpha.1";
/** Last version whose hourly sweep archived threads by `[worktrees.archive] enabled`. */
const LEGACY_AUTOMATIC_ARCHIVE_LAST_VERSION = "1.3.13";
/** Last version that read Markdown rendering from `[experimental]`. */
const LEGACY_EXPERIMENTAL_MARKDOWN_LAST_VERSION = "1.4.10";

/**
 * Legacy keys moved to `[general.markdown]`. Saves keep each one updated while
 * it exists, so a downgrade reads the operator's choice; a 1.6+ launch copies
 * it forward and removes it (`LEGACY_SETTINGS_RETIREMENTS`).
 */
const LEGACY_HOT_CPU_TRIGGER = ["general", "hot_cpu_profiling_trigger_mode"] as const;
const LEGACY_HOT_CPU_TRIGGER_LAST_VERSION = "1.4.16";
const LEGACY_HOT_CPU_TRIGGER_KEPT_THROUGH = "1.5";
const HOT_CPU_RULE_KEYS = {
  highEnabled: "hot_cpu_profiling_high_enabled",
  highMode: "hot_cpu_profiling_high_mode",
  spikeThreshold: "hot_cpu_profiling_spike_threshold_percent",
  spikeDuration: "hot_cpu_profiling_spike_duration_ms",
  sustainedThreshold: "hot_cpu_profiling_sustained_threshold_percent",
  sustainedDuration: "hot_cpu_profiling_sustained_duration_ms",
  sustainedLegacyInterval: "hot_cpu_profiling_sustained_legacy_interval_timing",
  slowburnEnabled: "hot_cpu_profiling_slowburn_enabled",
  slowburnDuration: "hot_cpu_profiling_slowburn_duration_ms",
  slowburnLegacyInterval: "hot_cpu_profiling_slowburn_legacy_interval_timing",
} as const;
const HOT_CPU_SLOWBURN_THRESHOLD = "hot_cpu_profiling_slowburn_threshold_percent";

const LEGACY_EXPERIMENTAL_MARKDOWN_KEYS = {
  incrementalRendering: {
    legacy: ["experimental", "incremental_markdown_rendering"],
    current: ["general", "markdown", "incremental_rendering"],
  },
  mathRendering: {
    legacy: ["experimental", "markdown_math_rendering"],
    current: ["general", "markdown", "math_rendering"],
  },
} as const;

export function defaultDesktopConfigDir(
  options?: DesktopConfigPathOptions,
): string {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const xdgConfigHome =
    options?.xdgConfigHome?.trim() || env.XDG_CONFIG_HOME?.trim();

  return path.join(xdgConfigHome || path.join(homeDir, ".config"), "pwragent");
}

export function userHomeWorktreesRoot(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), ".pwragent", "worktrees");
}

export function resolveDesktopConfigPath(
  options?: DesktopConfigPathOptions,
): string {
  return resolveActiveProfilePath("config.toml", options);
}

export function readDesktopSettingsConfig(
  configPath: string,
): DesktopSettingsConfig {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  return parseDesktopSettingsToml(fs.readFileSync(configPath, "utf8"), configPath);
}

const ACP_CLI_PATH_ENV_BY_ID: Record<string, string> = {
  antigravity: ACP_AGENTS_ANTIGRAVITY_CLI_PATH_ENV,
  gemini: ACP_AGENTS_GEMINI_CLI_PATH_ENV,
  grok: ACP_AGENTS_GROK_CLI_PATH_ENV,
  kimi: ACP_AGENTS_KIMI_CLI_PATH_ENV,
  qwen: ACP_AGENTS_QWEN_CLI_PATH_ENV,
};

/**
 * Resolve an ACP agent's CLI-path override from an already-loaded config.
 * Order: env var > config (`acpAgents.<id>.cliPath`) > undefined. Prefer this
 * over {@link resolveAcpCliPathOverride} when resolving multiple agents so the
 * config is read once by the caller.
 */
export function acpCliPathOverrideFor(
  config: DesktopSettingsConfig,
  registryId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const envKey = ACP_CLI_PATH_ENV_BY_ID[registryId];
  const envOverride = envKey ? env[envKey]?.trim() || undefined : undefined;
  if (envOverride) {
    return envOverride;
  }
  const agents = config.acpAgents as
    | Record<string, { cliPath?: string } | undefined>
    | undefined;
  return agents?.[registryId]?.cliPath?.trim() || undefined;
}

/**
 * Whether an ACP agent is enabled, from an already-loaded config. Defaults to
 * **true** (agents are on unless explicitly disabled). Prefer this over
 * {@link resolveAcpAgentEnabled} when resolving multiple agents.
 */
export function acpAgentEnabledFor(
  config: DesktopSettingsConfig,
  registryId: string,
): boolean {
  const agents = config.acpAgents as
    | Record<string, { enabled?: boolean } | undefined>
    | undefined;
  return agents?.[registryId]?.enabled !== false;
}

/** Whether PwrAgent should download and prefer its verified Grok fork build. */
export function managedGrokBuildsEnabledFor(
  config: DesktopSettingsConfig,
  defaultEnabled = true,
): boolean {
  return config.acpAgents?.grok?.managedBuilds ?? defaultEnabled;
}

/**
 * Apply runtime-only guards to the managed Grok preference. Replay-backed E2E
 * launches use an unpackaged Electron build but must remain offline and honor
 * their fake CLI fixtures. Packaged builds ignore the E2E-only environment
 * marker, matching the other dev-only escape hatches.
 */
export function managedGrokBuildsEnabledForRuntime(
  config: DesktopSettingsConfig,
  options: {
    env?: NodeJS.ProcessEnv;
    isPackaged: boolean;
  },
): boolean {
  if (
    !options.isPackaged
    && (options.env ?? process.env).PWRAGENT_E2E === "1"
  ) {
    return false;
  }
  return managedGrokBuildsEnabledFor(config, !options.isPackaged);
}

/**
 * Apply a settings patch to the on-disk config by editing only the keys named
 * in the patch. Sections, comments, blank lines, and unknown keys outside the
 * patch are preserved byte-for-byte. The file is never round-tripped through
 * a typed config, so unknown sections written by other builds survive a save.
 */
export function applyDesktopSettingsPatch(
  configPath: string,
  patch: DesktopSettingsConfigPatch,
  options?: { omitUnacknowledgedProviderEnables?: boolean },
): DesktopSettingsPatchWriteResult {
  const source = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf8")
    : "";
  const tables = parseTomlTables(source, configPath, { retainUnsupportedValuePaths: RETAIN_UNSUPPORTED_CONFIG_VALUES });
  const edits = desktopSettingsPatchToEdits(patch, tables);
  if (edits.length === 0) {
    return { changed: false, text: source };
  }
  const newProviderEnables = edits.filter((edit) =>
    edit.op === "set"
    && edit.path.length === 3
    && edit.path[0] === "messaging"
    && edit.path[2] === "enabled"
    && edit.value === true
    && tables[`messaging.${edit.path[1]}`]?.enabled !== true,
  );
  let next = applyTomlEdits(source, edits);
  if (newProviderEnables.length > 0) {
    // Duplicate-key repair can remove the timestamp that the source reader
    // found. Use the rendered file, which also includes any new record.
    const savedTables = parseTomlTables(next, configPath);
    const acknowledgment = readMessagingAcknowledgment(savedTables["general.messaging_acknowledgment"]);
    if (!acknowledgment && options?.omitUnacknowledgedProviderEnables) {
      next = applyTomlEdits(source, edits.filter((edit) => !newProviderEnables.includes(edit)));
    } else {
      requireMessagingSafetyAcknowledgment(acknowledgment?.acknowledgedAt);
    }
  }
  if (next === source) {
    return { changed: false, text: source };
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, next, "utf8");
  fs.renameSync(temporaryPath, configPath);
  return { changed: true, text: next };
}

/**
 * Legacy keys a later release series removes. Until then, saves keep them
 * updated beside their replacement so an older build still reads the
 * operator's choice. From the first version of a series past
 * `keptThroughSeries`, startup copies a value to its replacement when the
 * replacement is unset, then deletes the legacy key and its marker comment.
 *
 * Register a retirement when a key moves, so the cleanup ships with the move
 * instead of depending on someone remembering it.
 */
export type LegacySettingRetirement = Readonly<{
  legacy: readonly [table: string, key: string];
  /** Where the value lives now. Undefined when nothing replaces it. */
  current?: readonly string[];
  /** The last `major.minor` series that keeps the legacy key. */
  keptThroughSeries: string;
  migrate?: (tables: TomlTables) => TomlEdit[];
}>;

export const LEGACY_SETTINGS_RETIREMENTS: readonly LegacySettingRetirement[] = [
  { ...LEGACY_EXPERIMENTAL_MARKDOWN_KEYS.incrementalRendering, keptThroughSeries: "1.5" },
  { ...LEGACY_EXPERIMENTAL_MARKDOWN_KEYS.mathRendering, keptThroughSeries: "1.5" },
  {
    legacy: LEGACY_HOT_CPU_TRIGGER,
    keptThroughSeries: LEGACY_HOT_CPU_TRIGGER_KEPT_THROUGH,
    migrate: (tables) => {
      const general = tables.general;
      if (readHotCpuCaptureRules(general)) return [];
      const mode = readHotCpuProfileTriggerMode(general[LEGACY_HOT_CPU_TRIGGER[1]]);
      if (!mode) return [];
      const rules = migrateHotCpuCaptureRules(mode, readNumber(general[HOT_CPU_SLOWBURN_THRESHOLD]));
      if (mode !== "spike") rules[mode].legacyIntervalTiming = true;
      return hotCpuCaptureRulesEdits(rules);
    },
  },
];

/**
 * True when `version` belongs to a release series after `series`
 * (`major.minor`). Every 1.5.x, including prereleases, is not past "1.5";
 * 1.6.0-alpha.1 and 2.0.0 are. An unparseable version is never past, so a
 * malformed version string cannot delete settings.
 */
export function isPastReleaseSeries(version: string, series: string): boolean {
  const parse = (text: string) => {
    const match = /^v?(\d+)\.(\d+)(?:\.|$)/.exec(text.trim());
    return match ? [Number(match[1]), Number(match[2])] as const : undefined;
  };
  const current = parse(version);
  const kept = parse(series);
  if (!current || !kept) return false;
  return current[0] > kept[0] || (current[0] === kept[0] && current[1] > kept[1]);
}

/** Startup cleanup for `LEGACY_SETTINGS_RETIREMENTS`; see that catalog. */
export function retireLegacyDesktopSettings(
  configPath: string,
  appVersion: string,
  retirements: readonly LegacySettingRetirement[] = LEGACY_SETTINGS_RETIREMENTS,
): Readonly<{ changed: boolean; retired: readonly string[] }> {
  const due = retirements.filter((retirement) =>
    isPastReleaseSeries(appVersion, retirement.keptThroughSeries));
  if (due.length === 0 || !fs.existsSync(configPath)) {
    return { changed: false, retired: [] };
  }
  const source = fs.readFileSync(configPath, "utf8");
  const tables = parseTomlTables(source, configPath);
  const edits: TomlEdit[] = [];
  const retired: string[] = [];
  for (const { legacy, current, migrate } of due) {
    const legacyValue = tables[legacy[0]]?.[legacy[1]];
    if (legacyValue === undefined) continue;
    if (current) {
      const currentValue = tables[current.slice(0, -1).join(".")]?.[current[current.length - 1]];
      if (
        currentValue === undefined
        && (typeof legacyValue === "boolean"
          || typeof legacyValue === "string"
          || typeof legacyValue === "number")
      ) {
        edits.push({ op: "set", path: current, value: legacyValue });
      }
    }
    if (migrate) edits.push(...migrate(tables));
    // Match this key's own marker, not any legacy marker that happens to sit
    // above it in a hand-edited file.
    edits.push({
      op: "delete",
      path: legacy,
      marker: `${LEGACY_SETTINGS_MARKER} key=${legacy[1]} `,
    });
    retired.push(legacy.join("."));
  }
  if (edits.length === 0) {
    return { changed: false, retired: [] };
  }
  const next = applyTomlEdits(source, edits);
  if (next === source) {
    return { changed: false, retired: [] };
  }
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, next, "utf8");
  fs.renameSync(temporaryPath, configPath);
  return { changed: true, retired };
}

export type DesktopSettingsPatchWriteResult = Readonly<{
  changed: boolean;
  text: string;
}>;

export function desktopSettingsPatchToEdits(
  patch: DesktopSettingsConfigPatch,
  currentTables: TomlTables = {},
): TomlEdit[] {
  const edits: TomlEdit[] = [];

  const set = (
    pathSegments: readonly string[],
    value: string | number | boolean | readonly string[] | undefined,
  ): void => {
    if (value === undefined) return;
    edits.push({ op: "set", path: pathSegments, value });
  };
  if (currentTables.experimental?.chat_reply_composer !== undefined) {
    edits.push({
      op: "ensureCommentBefore",
      path: ["experimental", "chat_reply_composer"],
      marker: LEGACY_SETTINGS_MARKER,
      comment: legacyChatReplyComposerComment(),
    });
  }
  const setAuthorizedContacts = (
    tablePath: readonly string[],
    legacyKey: string,
    canonicalKey: string,
    value: readonly DesktopAuthorizedContact[] | undefined,
    oldTableArrayKeys: readonly string[] = [],
  ): void => {
    if (value === undefined) return;
    const tableName = tablePath.join(".");
    const listKey = `${canonicalKey}_list`;
    const table = currentTables[tableName];
    const hasLegacyScalar = readStringArray(table?.[legacyKey]) !== undefined;
    const hasListTable = readAuthorizedContactArray(table?.[listKey]) !== undefined;
    const tableArrayKey =
      (hasLegacyScalar && canonicalKey === legacyKey) || hasListTable
        ? listKey
        : canonicalKey;
    const tableArrayPath = [...tablePath, tableArrayKey];
    const normalizedContacts = normalizeAuthorizedContacts(value);

    for (const staleKey of [legacyKey, listKey, ...oldTableArrayKeys]) {
      if (staleKey === tableArrayKey) continue;
      if (staleKey === legacyKey && hasLegacyScalar) continue;
      edits.push({ op: "delete", path: [...tablePath, staleKey] });
      edits.push({ op: "deleteTableArray", path: [...tablePath, staleKey] });
    }

    if (hasLegacyScalar) {
      edits.push({
        op: "ensureCommentBefore",
        path: [...tablePath, legacyKey],
        marker: LEGACY_SETTINGS_MARKER,
        comment: legacyAuthorizedContactComment(legacyKey),
      });
      edits.push({
        op: "set",
        path: [...tablePath, legacyKey],
        value: normalizedContacts.map((contact) => contact.id),
      });
    }

    edits.push({ op: "delete", path: tableArrayPath });
    edits.push({ op: "deleteTableArray", path: tableArrayPath });
    if (normalizedContacts.length === 0) {
      return;
    }
    edits.push({
      op: "setTableArray",
      path: tableArrayPath,
      value: normalizedContacts.map((contact) => ({
        id: contact.id,
        display_name: contact.displayName,
        ...(contact.username ? { username: contact.username } : {}),
        ...(contact.fullAccessWarningOverride
          ? { full_access_warning: contact.fullAccessWarningOverride }
          : {}),
        ...(contact.fullAccessWarningDismissed === true
          ? { full_access_warning_dismissed: true }
          : {}),
        ...(contact.responseMode ? { response_mode: contact.responseMode } : {}),
      })),
    });
  };

  // `chat_reply_composer` is obsolete and intentionally ignored by current
  // clients. Preserve existing values for downgrade compatibility, but do not
  // write new values.
  if (patch.general?.developerMode !== undefined) {
    set(["general", "developer_mode"], patch.general.developerMode);
  }
  if (patch.general?.hotCpuProfilingEnabled !== undefined) {
    set(
      ["general", "hot_cpu_profiling_enabled"],
      patch.general.hotCpuProfilingEnabled,
    );
  }
  if (patch.general?.hotCpuProfilingStartDelayMs !== undefined) {
    set(
      ["general", "hot_cpu_profiling_start_delay_ms"],
      patch.general.hotCpuProfilingStartDelayMs,
    );
  }
  if (patch.general?.hotCpuProfilingCaptureRules !== undefined) {
    const rules = patch.general.hotCpuProfilingCaptureRules;
    assertHotCpuCaptureRules(rules);
    edits.push(...hotCpuCaptureRulesEdits(rules));
    if (readHotCpuProfileTriggerMode(currentTables.general?.[LEGACY_HOT_CPU_TRIGGER[1]])
      && !isPastReleaseSeries(desktopPackage.version, LEGACY_HOT_CPU_TRIGGER_KEPT_THROUGH)) {
      set(LEGACY_HOT_CPU_TRIGGER, primaryHotCpuRule(rules));
      edits.push({
        op: "ensureCommentBefore",
        path: LEGACY_HOT_CPU_TRIGGER,
        marker: LEGACY_SETTINGS_MARKER,
        comment: `# ${LEGACY_SETTINGS_MARKER} key=${LEGACY_HOT_CPU_TRIGGER[1]} shape=mode-string used_through=${LEGACY_HOT_CPU_TRIGGER_LAST_VERSION} kept_for_older_clients`,
      });
    }
  } else if (patch.general?.hotCpuProfilingTriggerMode !== undefined) {
    set(
      ["general", "hot_cpu_profiling_trigger_mode"],
      patch.general.hotCpuProfilingTriggerMode,
    );
  }
  if (patch.general?.hotCpuProfilingCaptureRules === undefined
    && patch.general?.hotCpuProfilingSlowburnThresholdPercent !== undefined) {
    set(
      ["general", "hot_cpu_profiling_slowburn_threshold_percent"],
      patch.general.hotCpuProfilingSlowburnThresholdPercent,
    );
  }
  if (typeof patch.general?.hotCpuProfilingCaptureChromiumTrace === "boolean") {
    set(
      ["general", "hot_cpu_profiling_capture_chromium_trace"],
      patch.general.hotCpuProfilingCaptureChromiumTrace,
    );
  }
  if (patch.general?.hotCpuProfilingCaptureHeapSnapshot !== undefined) {
    set(
      ["general", "hot_cpu_profiling_capture_heap_snapshot"],
      patch.general.hotCpuProfilingCaptureHeapSnapshot,
    );
  }
  if (patch.general?.hotCpuProfilingHeapSnapshotLimit !== undefined) {
    set(
      ["general", "hot_cpu_profiling_heap_snapshot_limit"],
      patch.general.hotCpuProfilingHeapSnapshotLimit,
    );
  }
  if (patch.general?.confirmQuitWithInProgressThreads !== undefined) {
    set(
      ["general", "confirm_quit_with_in_progress_threads"],
      patch.general.confirmQuitWithInProgressThreads,
    );
  }
  if (patch.general?.attentionPromoteOnTurnEnd !== undefined) {
    set(
      ["general", "attention_promote_on_turn_end"],
      patch.general.attentionPromoteOnTurnEnd,
    );
  }
  if (patch.general?.pinnedThreadsOnTop !== undefined) {
    set(
      ["general", "pinned_threads_on_top"],
      patch.general.pinnedThreadsOnTop,
    );
  }
  if (patch.general?.autoFixReviews !== undefined) {
    set(["general", "auto_fix_reviews"], patch.general.autoFixReviews);
  }
  if (patch.general?.passSetupVariablesToAgents !== undefined) {
    set(
      ["general", "pass_setup_variables_to_agents"],
      patch.general.passSetupVariablesToAgents,
    );
  }
  if (patch.general?.interactiveSvgSkipNotice !== undefined) {
    set(
      ["general", "interactive_svg_skip_notice"],
      patch.general.interactiveSvgSkipNotice,
    );
  }
  if (patch.general?.interactiveSvgAutoOpen !== undefined) {
    set(
      ["general", "interactive_svg_auto_open"],
      patch.general.interactiveSvgAutoOpen,
    );
  }
  for (const setting of ["incrementalRendering", "mathRendering"] as const) {
    const value = patch.general?.markdown?.[setting];
    if (value === undefined) continue;
    const { current, legacy } = LEGACY_EXPERIMENTAL_MARKDOWN_KEYS[setting];
    if (readBoolean(currentTables[legacy[0]]?.[legacy[1]]) !== undefined) {
      edits.push({
        op: "ensureCommentBefore",
        path: legacy,
        marker: LEGACY_SETTINGS_MARKER,
        comment: legacyExperimentalMarkdownComment(legacy[1]),
      });
      set(legacy, value);
    }
    set(current, value);
  }
  if (patch.general?.htmlPreviewRunScripts !== undefined) {
    set(
      ["general", "html_preview_run_scripts"],
      patch.general.htmlPreviewRunScripts,
    );
  }
  if (patch.general?.mcpGatewayEnabled !== undefined) {
    set(["general", "mcp_gateway_enabled"], patch.general.mcpGatewayEnabled);
  }
  if (patch.general?.pdfAnalysisEnabled !== undefined) {
    if (patch.general.pdfAnalysisEnabled) {
      edits.push({ op: "delete", path: ["general", "pdf_analysis_enabled"] });
    } else {
      set(["general", "pdf_analysis_enabled"], false);
    }
  }
  if (patch.general?.notificationsEnabled !== undefined) {
    set(["general", "notifications_enabled"], patch.general.notificationsEnabled);
  }
  if (patch.general?.toolOutputAlerts?.outputCapHitsEnabled !== undefined) {
    set(
      ["general", "tool_output_alerts", "output_cap_hits_enabled"],
      patch.general.toolOutputAlerts.outputCapHitsEnabled,
    );
  }
  if (
    patch.general?.toolOutputAlerts?.repeatedLargeOutputsEnabled !== undefined
  ) {
    set(
      ["general", "tool_output_alerts", "repeated_large_outputs_enabled"],
      patch.general.toolOutputAlerts.repeatedLargeOutputsEnabled,
    );
  }
  if (
    patch.general?.toolOutputAlerts?.repeatedLargeOutputMinimumCalls !== undefined
  ) {
    set(
      ["general", "tool_output_alerts", "repeated_large_output_minimum_calls"],
      patch.general.toolOutputAlerts.repeatedLargeOutputMinimumCalls,
    );
  }
  if (
    patch.general?.toolOutputAlerts?.repeatedLargeOutputMinimumPercent !== undefined
  ) {
    set(
      ["general", "tool_output_alerts", "repeated_large_output_minimum_percent"],
      patch.general.toolOutputAlerts.repeatedLargeOutputMinimumPercent,
    );
  }
  if (patch.general?.toolOutputAlerts?.monitorJobSuggestionsEnabled !== undefined) {
    set(
      ["general", "tool_output_alerts", "monitor_job_suggestions_enabled"],
      patch.general.toolOutputAlerts.monitorJobSuggestionsEnabled,
    );
  }
  if (
    patch.general?.toolOutputAlerts?.repeatedQueuedChecksEnabled !== undefined
  ) {
    set(
      ["general", "tool_output_alerts", "repeated_queued_checks_enabled"],
      patch.general.toolOutputAlerts.repeatedQueuedChecksEnabled,
    );
  }
  if (patch.general?.spendAlerts?.activeTurnSpendEnabled !== undefined) {
    set(
      ["general", "spend_alerts", "active_turn_spend_enabled"],
      patch.general.spendAlerts.activeTurnSpendEnabled,
    );
  }
  if (patch.general?.spendAlerts?.activeTurnSpendThresholdUsd !== undefined) {
    set(
      ["general", "spend_alerts", "active_turn_spend_threshold_usd"],
      patch.general.spendAlerts.activeTurnSpendThresholdUsd,
    );
  }
  if (patch.general?.spendAlerts?.threadSpendEnabled !== undefined) {
    set(
      ["general", "spend_alerts", "thread_spend_enabled"],
      patch.general.spendAlerts.threadSpendEnabled,
    );
  }
  if (patch.general?.spendAlerts?.threadSpendThresholdUsd !== undefined) {
    set(
      ["general", "spend_alerts", "thread_spend_threshold_usd"],
      patch.general.spendAlerts.threadSpendThresholdUsd,
    );
  }
  if (patch.general?.agentNotifications?.maxPerThreadPerDay !== undefined) {
    set(
      ["general", "agent_notifications", "max_per_thread_per_day"],
      patch.general.agentNotifications.maxPerThreadPerDay,
    );
  }
  if (patch.general?.agentNotifications?.maxPerProfilePerDay !== undefined) {
    set(
      ["general", "agent_notifications", "max_per_profile_per_day"],
      patch.general.agentNotifications.maxPerProfilePerDay,
    );
  }
  if (patch.general?.agentNotifications?.maxScheduledPerThread !== undefined) {
    set(
      ["general", "agent_notifications", "max_scheduled_per_thread"],
      patch.general.agentNotifications.maxScheduledPerThread,
    );
  }

  if (patch.experimental?.fullAccessRiskWarningDismissed !== undefined) {
    set(
      ["experimental", "full_access_risk_warning_dismissed"],
      patch.experimental.fullAccessRiskWarningDismissed,
    );
  }
  if (patch.experimental?.threadPricingSummary !== undefined) {
    set(
      ["experimental", "thread_pricing_summary"],
      patch.experimental.threadPricingSummary,
    );
  }
  if (patch.experimental?.threadPricingDisplayUsd !== undefined) {
    set(
      ["experimental", "thread_pricing_display_usd"],
      patch.experimental.threadPricingDisplayUsd,
    );
  }
  if (patch.experimental?.threadPricingDisplayCodexCredits !== undefined) {
    set(
      ["experimental", "thread_pricing_display_codex_credits"],
      patch.experimental.threadPricingDisplayCodexCredits,
    );
  }
  if (patch.experimental?.tokenMiserEnabled !== undefined) {
    const legacyValue = readBoolean(
      currentTables.general?.token_miser_enabled,
    );
    if (legacyValue !== undefined) {
      edits.push({
        op: "ensureCommentBefore",
        path: ["general", "token_miser_enabled"],
        marker: LEGACY_SETTINGS_MARKER,
        comment: legacyTokenMiserGeneralComment(),
      });
      set(
        ["general", "token_miser_enabled"],
        patch.experimental.tokenMiserEnabled,
      );
    }
    set(
      ["experimental", "token_miser_enabled"],
      patch.experimental.tokenMiserEnabled,
    );
  }
  if (patch.experimental?.tokenMiserFocusedSummariesEnabled !== undefined) {
    set(
      ["experimental", "token_miser_focused_summaries_enabled"],
      patch.experimental.tokenMiserFocusedSummariesEnabled,
    );
  }
  if (patch.experimental?.tokenMiserDiagnosticsEnabled !== undefined) {
    set(
      ["experimental", "token_miser_diagnostics_enabled"],
      patch.experimental.tokenMiserDiagnosticsEnabled,
    );
  }
  if (patch.experimental?.tokenMiserPollingReviewsEnabled !== undefined) {
    set(
      ["experimental", "token_miser_polling_reviews_enabled"],
      patch.experimental.tokenMiserPollingReviewsEnabled,
    );
  }
  if (patch.experimental?.tokenMiserDefaultEnabled !== undefined) {
    set(
      ["experimental", "token_miser_default_enabled"],
      patch.experimental.tokenMiserDefaultEnabled,
    );
  }
  if (patch.experimental?.codexToolDiscovery !== undefined) {
    set(
      ["experimental", "codex_tool_discovery"],
      patch.experimental.codexToolDiscovery,
    );
  }
  if (patch.experimental?.researchEnabled !== undefined) {
    set(["experimental", "research_enabled"], patch.experimental.researchEnabled);
  }
  if (patch.experimental?.resourceCheckoutsEnabled !== undefined) {
    set(
      ["experimental", "resource_checkouts_enabled"],
      patch.experimental.resourceCheckoutsEnabled,
    );
  }
  if (patch.research?.harness !== undefined) {
    edits.push(...researchHarnessEdits(patch.research.harness));
  }
  if (patch.research?.source !== undefined) {
    if (patch.research.source !== "mathos" && patch.research.source !== "bridge") throw new Error("Choose MathOS Platform or a custom bridge.");
    set(["research", "harness_source"], patch.research.source);
  }
  if (patch.research?.mathos !== undefined) {
    edits.push(...researchMathosEdits(patch.research.mathos));
  }
  if (patch.experimental?.codexDefaultModeRequestUserInput !== undefined) {
    set(
      ["experimental", "codex_default_mode_request_user_input"],
      patch.experimental.codexDefaultModeRequestUserInput,
    );
  }
  if (patch.experimental?.codexSkillQuestionsWarningDismissed !== undefined) {
    set(
      ["experimental", "codex_skill_questions_warning_dismissed"],
      patch.experimental.codexSkillQuestionsWarningDismissed,
    );
  }
  if (patch.experimental?.codexConfigWarningsDismissed !== undefined) {
    set(
      ["experimental", "codex_config_warnings_dismissed"],
      [...new Set(patch.experimental.codexConfigWarningsDismissed)],
    );
  }
  if (patch.experimental?.managedReview !== undefined) {
    set(
      ["experimental", "managed_review"],
      patch.experimental.managedReview,
    );
  }
  if (patch.general?.appearance?.theme !== undefined) {
    if (patch.general.appearance.theme === DESKTOP_APPEARANCE_THEME_DEFAULT) {
      edits.push({ op: "delete", path: ["general", "appearance", "theme"] });
    } else {
      set(["general", "appearance", "theme"], patch.general.appearance.theme);
    }
  }
  if (patch.general?.appearance?.darkTheme !== undefined) {
    if (patch.general.appearance.darkTheme === DESKTOP_DARK_THEME_DEFAULT) {
      edits.push({ op: "delete", path: ["general", "appearance", "dark_theme"] });
    } else {
      set(
        ["general", "appearance", "dark_theme"],
        patch.general.appearance.darkTheme,
      );
    }
  }
  if (patch.general?.appearance?.lightTheme !== undefined) {
    if (patch.general.appearance.lightTheme === DESKTOP_LIGHT_THEME_DEFAULT) {
      edits.push({ op: "delete", path: ["general", "appearance", "light_theme"] });
    } else {
      set(
        ["general", "appearance", "light_theme"],
        patch.general.appearance.lightTheme,
      );
    }
  }
  if (
    patch.general?.appearance?.darkTheme !== undefined
    || patch.general?.appearance?.lightTheme !== undefined
  ) {
    // `palette` was a development-only key that dark_theme / light_theme
    // replaced before any release read it. Drop it once the operator picks
    // a theme so it does not linger as a setting nothing reads.
    edits.push({ op: "delete", path: ["general", "appearance", "palette"] });
  }
  if (patch.general?.appearance?.themedDockIcon !== undefined) {
    // On by default, so only the opt-out is written.
    if (patch.general.appearance.themedDockIcon) {
      edits.push({
        op: "delete",
        path: ["general", "appearance", "themed_dock_icon"],
      });
    } else {
      set(["general", "appearance", "themed_dock_icon"], false);
    }
  }
  if (patch.general?.appearance?.terminalMinimumContrast !== undefined) {
    // Off by default, so only the opt-in is written.
    if (patch.general.appearance.terminalMinimumContrast) {
      set(["general", "appearance", "terminal_minimum_contrast"], true);
    } else {
      edits.push({
        op: "delete",
        path: ["general", "appearance", "terminal_minimum_contrast"],
      });
    }
  }
  if (patch.general?.appearance?.calmMotion !== undefined) {
    // Off by default, so only the opt-in is written.
    if (patch.general.appearance.calmMotion) {
      set(["general", "appearance", "calm_motion"], true);
    } else {
      edits.push({
        op: "delete",
        path: ["general", "appearance", "calm_motion"],
      });
    }
  }
  // Write the literal value. An absent key reads as a migrated profile, so a
  // `false` marker has to stay on disk rather than be deleted.
  if (patch.onboarding?.completed !== undefined) {
    set(["onboarding", "completed"], patch.onboarding.completed);
  }
  if (patch.onboarding?.completedSource !== undefined) {
    set(["onboarding", "completed_source"], patch.onboarding.completedSource);
  }

  if (patch.general?.appearance?.density !== undefined) {
    if (
      patch.general.appearance.density === DESKTOP_APPEARANCE_DENSITY_DEFAULT
    ) {
      edits.push({ op: "delete", path: ["general", "appearance", "density"] });
    } else {
      set(
        ["general", "appearance", "density"],
        patch.general.appearance.density,
      );
    }
  }

  if (patch.general?.appearance?.sidebarTextSize !== undefined) {
    if (
      patch.general.appearance.sidebarTextSize
        === DESKTOP_TEXT_SIZE_DEFAULT
    ) {
      edits.push({
        op: "delete",
        path: ["general", "appearance", "sidebar_text_size"],
      });
    } else {
      set(
        ["general", "appearance", "sidebar_text_size"],
        patch.general.appearance.sidebarTextSize,
      );
    }
  }

  if (patch.general?.appearance?.transcriptTextSize !== undefined) {
    if (
      patch.general.appearance.transcriptTextSize
        === DESKTOP_TEXT_SIZE_DEFAULT
    ) {
      edits.push({
        op: "delete",
        path: ["general", "appearance", "transcript_text_size"],
      });
    } else {
      set(
        ["general", "appearance", "transcript_text_size"],
        patch.general.appearance.transcriptTextSize,
      );
    }
  }

  if (patch.general?.appearance?.contextMoon !== undefined) {
    if (
      patch.general.appearance.contextMoon
        === DESKTOP_CONTEXT_MOON_STYLE_DEFAULT
    ) {
      edits.push({
        op: "delete",
        path: ["general", "appearance", "context_moon"],
      });
    } else {
      set(
        ["general", "appearance", "context_moon"],
        patch.general.appearance.contextMoon,
      );
    }
  }

  if (patch.general?.codexProfileModel !== undefined) {
    if (
      patch.general.codexProfileModel === DESKTOP_CODEX_PROFILE_MODEL_DEFAULT
    ) {
      edits.push({ op: "delete", path: ["general", "codex_profile_model"] });
    } else {
      set(["general", "codex_profile_model"], patch.general.codexProfileModel);
    }
  }

  if (patch.general?.messagingAcknowledgment !== undefined) {
    const ack = patch.general.messagingAcknowledgment;
    if (ack === null) {
      edits.push({
        op: "delete",
        path: ["general", "messaging_acknowledgment", "acknowledged_at"],
      });
      edits.push({
        op: "delete",
        path: ["general", "messaging_acknowledgment", "providers"],
      });
    } else {
      set(
        ["general", "messaging_acknowledgment", "acknowledged_at"],
        ack.acknowledgedAt,
      );
      set(
        ["general", "messaging_acknowledgment", "providers"],
        ack.providers,
      );
    }
  }

  if (patch.imageUploads?.pastedImageMaxPatches !== undefined) {
    const pastedImageMaxPatches = patch.imageUploads.pastedImageMaxPatches;
    if (pastedImageMaxPatches === DEFAULT_PASTED_IMAGE_MAX_PATCHES) {
      edits.push({
        op: "delete",
        path: ["image_uploads", "pasted_image_max_patches"],
      });
    } else {
      set(
        ["image_uploads", "pasted_image_max_patches"],
        pastedImageMaxPatches,
      );
    }
  }

  if (patch.updates?.channel !== undefined) {
    // Persist Latest/Stable too. A Beta/alpha binary infers those keys when
    // they are absent, so deleting the default would put the operator back
    // on the downloaded train after they chose Stable.
    set(["updates", "channel"], patch.updates.channel);
  }

  if (patch.updates?.train !== undefined) {
    set(["updates", "train"], patch.updates.train);
  }

  // `selection_source` is derived here rather than accepted from the patch:
  // naming EITHER axis is what makes a selection an operator's pin. Deriving
  // it means no call site can persist a slot that the next read would
  // silently re-infer away, and no renderer can pin (or un-pin) a selection
  // nobody picked — `DesktopSettingsConfigPatch["updates"]` has no such key,
  // and this writer only emits keys it names.
  if (
    patch.updates?.channel !== undefined
    || patch.updates?.train !== undefined
  ) {
    set(["updates", "selection_source"], "user");
  }

  if (patch.integratedTerminal?.windowsShell !== undefined) {
    if (
      patch.integratedTerminal.windowsShell ===
      DESKTOP_INTEGRATED_TERMINAL_WINDOWS_SHELL_DEFAULT
    ) {
      edits.push({
        op: "delete",
        path: ["integrated_terminal", "windows_shell"],
      });
    } else {
      set(
        ["integrated_terminal", "windows_shell"],
        patch.integratedTerminal.windowsShell,
      );
    }
  }

  // Window-layout prefs delete on default so the [ui] section only carries
  // non-default values.
  if (patch.ui?.sidebarHidden !== undefined) {
    if (patch.ui.sidebarHidden) {
      set(["ui", "sidebar_hidden"], true);
    } else {
      edits.push({ op: "delete", path: ["ui", "sidebar_hidden"] });
    }
  }
  // The context rail defaults to pinned-open (for discoverability), so the
  // non-default value we persist is `false` — an explicit unpin. Pinned is the
  // default, so we delete the key in that case.
  if (patch.ui?.contextRailPinned !== undefined) {
    if (patch.ui.contextRailPinned) {
      edits.push({ op: "delete", path: ["ui", "context_rail_pinned"] });
    } else {
      set(["ui", "context_rail_pinned"], false);
    }
  }
  // The project index defaults to shown, so only an explicit hide persists.
  if (patch.ui?.projectIndexHidden !== undefined) {
    if (patch.ui.projectIndexHidden) {
      set(["ui", "project_index_hidden"], true);
    } else {
      edits.push({ op: "delete", path: ["ui", "project_index_hidden"] });
    }
  }
  // `null` (a double-click on the grip) returns the column to the width of
  // its longest name, which is the absence of the key.
  if (patch.ui?.projectIndexWidth !== undefined) {
    const width = patch.ui.projectIndexWidth;
    if (width === null || !Number.isFinite(width) || width <= 0) {
      edits.push({ op: "delete", path: ["ui", "project_index_width"] });
    } else {
      set(["ui", "project_index_width"], Math.round(width));
    }
  }
  if (patch.ui?.activeContextTab !== undefined) {
    if (patch.ui.activeContextTab === "info") {
      edits.push({ op: "delete", path: ["ui", "active_context_tab"] });
    } else {
      set(["ui", "active_context_tab"], patch.ui.activeContextTab);
    }
  }
  if (patch.ui?.editedFilesDock !== undefined) {
    if (patch.ui.editedFilesDock === "above") {
      edits.push({ op: "delete", path: ["ui", "edited_files_dock"] });
    } else {
      set(["ui", "edited_files_dock"], patch.ui.editedFilesDock);
    }
  }
  if (patch.ui?.actionRunsDock !== undefined) {
    if (patch.ui.actionRunsDock === "above") {
      edits.push({ op: "delete", path: ["ui", "action_runs_dock"] });
    } else {
      set(["ui", "action_runs_dock"], patch.ui.actionRunsDock);
    }
  }
  if (patch.ui?.launchpadConnectionsDock !== undefined) {
    if (patch.ui.launchpadConnectionsDock === "launchpad") {
      edits.push({ op: "delete", path: ["ui", "launchpad_connections_dock"] });
    } else {
      set(["ui", "launchpad_connections_dock"], patch.ui.launchpadConnectionsDock);
    }
  }
  // Help → Logs viewer prefs: same delete-on-default rule, in [ui.logs].
  const logsPatch = patch.ui?.logs;
  if (logsPatch) {
    const setLogsKey = (
      key: string,
      value: boolean | number | string | readonly string[] | undefined,
      isDefault: boolean,
    ): void => {
      if (value === undefined) return;
      if (isDefault) {
        edits.push({ op: "delete", path: ["ui", "logs", key] });
      } else {
        set(["ui", "logs", key], value);
      }
    };
    setLogsKey(
      "wrap",
      logsPatch.wrap,
      logsPatch.wrap === DESKTOP_LOGS_VIEWER_DEFAULTS.wrap,
    );
    setLogsKey(
      "search_mode",
      logsPatch.searchMode,
      logsPatch.searchMode === DESKTOP_LOGS_VIEWER_DEFAULTS.searchMode,
    );
    setLogsKey(
      "context_lines",
      logsPatch.contextLines,
      logsPatch.contextLines === DESKTOP_LOGS_VIEWER_DEFAULTS.contextLines,
    );
    setLogsKey(
      "include_diagnostics",
      logsPatch.includeDiagnostics,
      logsPatch.includeDiagnostics
        === DESKTOP_LOGS_VIEWER_DEFAULTS.includeDiagnostics,
    );
    if (logsPatch.levels !== undefined) {
      const levels = DESKTOP_LOGS_VIEWER_DEFAULTS.levels.filter((level) =>
        logsPatch.levels?.includes(level),
      );
      setLogsKey(
        "levels",
        levels,
        levels.length === DESKTOP_LOGS_VIEWER_DEFAULTS.levels.length,
      );
    }
  }

  if (patch.federation?.mode !== undefined) {
    if (patch.federation.mode === DESKTOP_FEDERATION_MODE_DEFAULT) {
      edits.push({ op: "delete", path: ["federation", "mode"] });
    } else {
      set(["federation", "mode"], patch.federation.mode);
    }
  }
  if (patch.federation?.memberRole !== undefined) {
    // Full is the default, so a full member carries no key. Anything else
    // writes the one value this build reads as contained.
    if (patch.federation.memberRole === "full") {
      edits.push({ op: "delete", path: ["federation", "member_role"] });
    } else {
      set(["federation", "member_role"], "contained");
    }
  }
  if (patch.federation?.instanceLabel !== undefined) {
    if (patch.federation.instanceLabel.trim() === "") {
      edits.push({ op: "delete", path: ["federation", "instance_label"] });
    } else {
      set(["federation", "instance_label"], patch.federation.instanceLabel);
    }
  }
  if (patch.federation?.instanceNotes !== undefined) {
    if (patch.federation.instanceNotes.trim() === "") {
      edits.push({ op: "delete", path: ["federation", "instance_notes"] });
    } else {
      set(["federation", "instance_notes"], patch.federation.instanceNotes);
    }
  }
  if (patch.federation?.listenHost !== undefined) {
    if (patch.federation.listenHost.trim() === "") {
      edits.push({ op: "delete", path: ["federation", "listen_host"] });
    } else {
      set(["federation", "listen_host"], patch.federation.listenHost);
    }
  }
  if (patch.federation?.allowPortForwarding !== undefined) {
    set(["federation", "allow_port_forwarding"], patch.federation.allowPortForwarding);
  }
  if (patch.federation?.allowRemoteShells !== undefined) {
    set(["federation", "allow_remote_shells"], patch.federation.allowRemoteShells);
  }
  if (patch.federation?.allowFilePush !== undefined) {
    set(["federation", "allow_file_push"], patch.federation.allowFilePush);
  }
  if (patch.federation?.allowFilePull !== undefined) {
    set(["federation", "allow_file_pull"], patch.federation.allowFilePull);
  }
  if (patch.federation?.allowFilePullOutsideThreadDirectories !== undefined) {
    set(["federation", "allow_file_pull_outside_thread_directories"], patch.federation.allowFilePullOutsideThreadDirectories);
  }
  if (patch.federation?.filePushDirectory !== undefined) {
    const directory = patch.federation.filePushDirectory.trim();
    if (directory && !path.isAbsolute(directory)) {
      throw new Error("Incoming files folder must be an absolute path.");
    }
    set(["federation", "file_push_directory"], directory);
  }
  if (patch.federation?.compressionEnabled !== undefined) {
    set(["federation", "compression_enabled"], patch.federation.compressionEnabled);
  }
  if (patch.federation?.listenPort !== undefined) {
    if (patch.federation.listenPort === 0) {
      edits.push({ op: "delete", path: ["federation", "listen_port"] });
    } else {
      set(["federation", "listen_port"], patch.federation.listenPort);
    }
  }
  if (patch.federation?.publicUrl !== undefined) {
    if (patch.federation.publicUrl.trim() === "") {
      edits.push({ op: "delete", path: ["federation", "public_url"] });
    } else {
      set(["federation", "public_url"], patch.federation.publicUrl);
    }
  }
  if (patch.federation?.gatewayUrl !== undefined) {
    if (patch.federation.gatewayUrl.trim() === "") {
      edits.push({ op: "delete", path: ["federation", "gateway_url"] });
    } else {
      set(["federation", "gateway_url"], patch.federation.gatewayUrl);
    }
  }
  if (patch.federation?.gatewayEndpoints !== undefined) {
    const gatewayEndpoints = sanitizeEndpointList(
      patch.federation.gatewayEndpoints,
    );
    if (gatewayEndpoints.length === 0) {
      edits.push({ op: "delete", path: ["federation", "gateway_endpoints"] });
    } else {
      set(["federation", "gateway_endpoints"], gatewayEndpoints);
    }
    // Keep the legacy scalar in sync ONLY when the profile already has one, so
    // a downgraded build still finds a working path. Per
    // docs/config-file-evolution.md a brand-new config gets the canonical shape
    // only, and a preserved legacy scalar is never deleted out from under an
    // older client. An explicit gatewayUrl in the same patch wins.
    const hasLegacyGatewayUrl =
      readString(currentTables?.["federation"]?.gateway_url) !== undefined;
    if (patch.federation.gatewayUrl === undefined && hasLegacyGatewayUrl) {
      if (gatewayEndpoints.length > 0) {
        edits.push({
          op: "ensureCommentBefore",
          path: ["federation", "gateway_url"],
          marker: LEGACY_SETTINGS_MARKER,
          comment: legacyGatewayUrlComment(),
        });
        set(["federation", "gateway_url"], gatewayEndpoints[0]);
      }
    }
  }
  if (patch.federation?.advertisedEndpoints !== undefined) {
    const advertisedEndpoints = sanitizeEndpointList(
      patch.federation.advertisedEndpoints,
    );
    if (advertisedEndpoints.length === 0) {
      edits.push({
        op: "delete",
        path: ["federation", "advertised_endpoints"],
      });
    } else {
      set(["federation", "advertised_endpoints"], advertisedEndpoints);
    }
  }
  if (patch.federation?.cloudflareEndpoint !== undefined) {
    if (patch.federation.cloudflareEndpoint.trim() === "") {
      edits.push({ op: "delete", path: ["federation", "cloudflare_endpoint"] });
    } else {
      set(
        ["federation", "cloudflare_endpoint"],
        patch.federation.cloudflareEndpoint.trim(),
      );
    }
  }
  if (patch.federation?.cloudflareGatewayEnabled !== undefined) {
    set(["federation", "cloudflare_gateway_enabled"], patch.federation.cloudflareGatewayEnabled);
  }
  if (patch.federation?.cloudflareMtlsEnabled !== undefined) {
    if (patch.federation.cloudflareMtlsEnabled) {
      set(["federation", "cloudflare_mtls_enabled"], true);
    } else {
      edits.push({
        op: "delete",
        path: ["federation", "cloudflare_mtls_enabled"],
      });
    }
  }
  if (patch.federation?.cloudflareAccessServiceAuthEnabled !== undefined) {
    if (patch.federation.cloudflareAccessServiceAuthEnabled) {
      set(["federation", "cloudflare_access_service_auth_enabled"], true);
    } else {
      edits.push({
        op: "delete",
        path: ["federation", "cloudflare_access_service_auth_enabled"],
      });
    }
  }
  if (patch.federation?.cloudflareAccessOAuthEnabled !== undefined) {
    if (patch.federation.cloudflareAccessOAuthEnabled) {
      set(["federation", "cloudflare_access_oauth_enabled"], true);
    } else {
      edits.push({
        op: "delete",
        path: ["federation", "cloudflare_access_oauth_enabled"],
      });
    }
  }

  if (patch.messaging?.inputDebounceMs !== undefined) {
    set(["messaging", "input_debounce_ms"], patch.messaging.inputDebounceMs);
  }
  if (patch.messaging?.enabled !== undefined) {
    set(["messaging", "enabled"], patch.messaging.enabled);
  }
  if (patch.messaging?.allowFullAccessThreadResume !== undefined) {
    set(
      ["messaging", "allow_full_access_thread_resume"],
      patch.messaging.allowFullAccessThreadResume,
    );
  }
  if (patch.messaging?.allowFullAccessEscalation !== undefined) {
    set(
      ["messaging", "allow_full_access_escalation"],
      patch.messaging.allowFullAccessEscalation,
    );
  }
  if (patch.messaging?.fullAccessWarning !== undefined) {
    set(["messaging", "full_access_warning"], patch.messaging.fullAccessWarning);
  }
  if (patch.messaging?.toolUpdateMode !== undefined) {
    set(["messaging", "tool_update_mode"], patch.messaging.toolUpdateMode);
  }
  if (patch.messaging?.managerToolUpdateMode !== undefined) {
    set(
      ["messaging", "manager_tool_update_mode"],
      patch.messaging.managerToolUpdateMode,
    );
  }
  if (patch.messaging?.showStreamingOption !== undefined) {
    set(["messaging", "show_streaming_option"], patch.messaging.showStreamingOption);
  }

  const attachments = patch.messaging?.attachments;
  if (attachments?.imageProfile !== undefined) {
    if (attachments.imageProfile === "medium") {
      edits.push({
        op: "delete",
        path: ["messaging", "attachments", "image_profile"],
      });
    } else {
      set(["messaging", "attachments", "image_profile"], attachments.imageProfile);
    }
  }
  if (attachments?.pdfProfile !== undefined) {
    if (attachments.pdfProfile === "high") {
      edits.push({
        op: "delete",
        path: ["messaging", "attachments", "pdf_profile"],
      });
    } else {
      set(["messaging", "attachments", "pdf_profile"], attachments.pdfProfile);
    }
  }
  if (attachments?.maxAttachmentBytes !== undefined) {
    set(["messaging", "attachments", "max_attachment_bytes"], attachments.maxAttachmentBytes);
  }
  if (attachments?.maxAttachmentCount !== undefined) {
    set(["messaging", "attachments", "max_attachment_count"], attachments.maxAttachmentCount);
  }

  const telegram = patch.messaging?.telegram;
  if (telegram?.connections !== undefined) {
    const path = ["messaging", "telegram", "connections"];
    const rows = telegramConnectionConfigRows(telegram.connections);
    const normalized = parseTelegramConnections(rows);
    if (!normalized || normalized.length !== rows.length) throw new Error("Invalid Telegram connections configuration.");
    const stored = currentTables["messaging.telegram"]?.connections;
    const current = parseTelegramConnections(stored);
    if (current === null) throw new Error("Correct the malformed Telegram connections in config.toml before saving.");
    const previous = new Map(telegramConnectionConfigRows(current ?? []).map((row) => [row.id, row]));
    const storedRows = Array.isArray(stored) ? stored.filter((row) => typeof row === "object") : [];
    const previousStored = new Map(storedRows.map((row) => [row.id, row]));
    const editedRows = rows.map((row) => {
      const old = previous.get(row.id);
      const raw = previousStored.get(row.id);
      if (!old || !raw) return row;
      return Object.fromEntries(Object.entries(row).flatMap(([key, value]) => {
        if (JSON.stringify(value) !== JSON.stringify(old[key as keyof typeof old])) return [[key, value]];
        return Object.hasOwn(raw, key) ? [[key, raw[key]]] : [];
      }));
    });
    if (normalized.length === 0) {
      set(path, []);
    } else {
      edits.push({ op: "delete", path });
    }
    edits.push({
      op: "setTableArray", path, value: editedRows, identityKey: "id",
      comment: "# pwragent-legacy-settings: [messaging.telegram] keeps the first bot for older versions.",
    });
  }
  if (telegram?.enabled !== undefined) {
    set(["messaging", "telegram", "enabled"], telegram.enabled);
  }
  if (telegram?.responseMode !== undefined) {
    set(["messaging", "telegram", "response_mode"], telegram.responseMode);
  }
  if (telegram?.streamingResponses !== undefined) {
    set(["messaging", "telegram", "streaming_responses"], telegram.streamingResponses);
  }
  if (telegram?.authorizedUserIds !== undefined) {
    setAuthorizedContacts(
      ["messaging", "telegram"],
      "authorized_user_ids",
      "authorized_users",
      telegram.authorizedUserIds,
      ["authorized_user_ids_list"],
    );
  }
  if (telegram?.authorizedSupergroups !== undefined) {
    setAuthorizedContacts(
      ["messaging", "telegram"],
      "authorized_supergroups",
      "authorized_supergroups",
      telegram.authorizedSupergroups,
    );
  }

  const discord = patch.messaging?.discord;
  if (discord?.enabled !== undefined) {
    set(["messaging", "discord", "enabled"], discord.enabled);
  }
  if (discord?.responseMode !== undefined) {
    set(["messaging", "discord", "response_mode"], discord.responseMode);
  }
  if (discord?.responseModeOverrides !== undefined) {
    setAuthorizedContacts(
      ["messaging", "discord"],
      "response_mode_overrides",
      "response_mode_overrides",
      discord.responseModeOverrides,
    );
  }
  if (discord?.streamingResponses !== undefined) {
    set(["messaging", "discord", "streaming_responses"], discord.streamingResponses);
  }
  if (discord?.applicationId !== undefined) {
    set(["messaging", "discord", "application_id"], discord.applicationId);
  }
  if (discord?.authorizedUserIds !== undefined) {
    setAuthorizedContacts(
      ["messaging", "discord"],
      "authorized_user_ids",
      "authorized_users",
      discord.authorizedUserIds,
      ["authorized_user_ids_list"],
    );
  }
  if (discord?.authorizedGuilds !== undefined) {
    setAuthorizedContacts(
      ["messaging", "discord"],
      "authorized_guilds",
      "authorized_guilds",
      discord.authorizedGuilds,
    );
  }

  const mattermost = patch.messaging?.mattermost;
  if (mattermost?.enabled !== undefined) {
    set(["messaging", "mattermost", "enabled"], mattermost.enabled);
  }
  if (mattermost?.streamingResponses !== undefined) {
    set(
      ["messaging", "mattermost", "streaming_responses"],
      mattermost.streamingResponses,
    );
  }
  if (mattermost?.serverUrl !== undefined) {
    set(["messaging", "mattermost", "server_url"], mattermost.serverUrl);
  }
  if (mattermost?.callbackBaseUrl !== undefined) {
    set(
      ["messaging", "mattermost", "callback_base_url"],
      mattermost.callbackBaseUrl,
    );
  }
  if (mattermost?.slashCommandPrefix !== undefined) {
    set(
      ["messaging", "mattermost", "slash_command_prefix"],
      mattermost.slashCommandPrefix,
    );
  }
  if (mattermost?.registerSlashCommands !== undefined) {
    set(
      ["messaging", "mattermost", "register_slash_commands"],
      mattermost.registerSlashCommands,
    );
  }
  if (mattermost?.authorizedUserIds !== undefined) {
    setAuthorizedContacts(
      ["messaging", "mattermost"],
      "authorized_user_ids",
      "authorized_users",
      mattermost.authorizedUserIds,
      ["authorized_user_ids_list"],
    );
  }
  if (mattermost?.authorizedTeams !== undefined) {
    setAuthorizedContacts(
      ["messaging", "mattermost"],
      "authorized_team_ids",
      "authorized_teams",
      mattermost.authorizedTeams,
      ["authorized_team_ids_list"],
    );
  }
  if (mattermost?.authorizedConversations !== undefined) {
    setAuthorizedContacts(
      ["messaging", "mattermost"],
      "authorized_conversation_ids",
      "authorized_conversations",
      mattermost.authorizedConversations,
      ["authorized_conversation_ids_list"],
    );
  }

  const slack = patch.messaging?.slack;
  if (slack?.enabled !== undefined) {
    set(["messaging", "slack", "enabled"], slack.enabled);
  }
  if (slack?.liveWorkingCards !== undefined) {
    set(["messaging", "slack", "live_working_cards"], slack.liveWorkingCards);
  }
  if (slack?.responseMode !== undefined) {
    set(["messaging", "slack", "response_mode"], slack.responseMode);
  }
  if (slack?.streamingResponses !== undefined) {
    set(["messaging", "slack", "streaming_responses"], slack.streamingResponses);
  }
  if (slack?.appName !== undefined) {
    set(["messaging", "slack", "app_name"], slack.appName);
  }
  if (slack?.workspaceUrl !== undefined) {
    set(["messaging", "slack", "workspace_url"], slack.workspaceUrl);
  }
  if (slack?.inboundMode !== undefined) {
    set(["messaging", "slack", "inbound_mode"], slack.inboundMode);
  }
  if (slack?.teamAuthorizationMode !== undefined) {
    set(
      ["messaging", "slack", "team_authorization_mode"],
      slack.teamAuthorizationMode,
    );
  }
  if (slack?.channelAuthorizationMode !== undefined) {
    set(
      ["messaging", "slack", "channel_authorization_mode"],
      slack.channelAuthorizationMode,
    );
  }
  if (slack?.dmAccessMode !== undefined) {
    set(["messaging", "slack", "dm_access_mode"], slack.dmAccessMode);
  }
  if (slack?.groupDmAccessMode !== undefined) {
    set(["messaging", "slack", "group_dm_access_mode"], slack.groupDmAccessMode);
  }
  if (slack?.channelUserAccessMode !== undefined) {
    set(
      ["messaging", "slack", "channel_user_access_mode"],
      slack.channelUserAccessMode,
    );
  }
  if (slack?.slashCommandPrefix !== undefined) {
    set(["messaging", "slack", "slash_command_prefix"], slack.slashCommandPrefix);
  }
  if (slack?.registerSlashCommands !== undefined) {
    set(
      ["messaging", "slack", "register_slash_commands"],
      slack.registerSlashCommands,
    );
  }
  if (slack?.authorizedUserIds !== undefined) {
    setAuthorizedContacts(
      ["messaging", "slack"],
      "authorized_user_ids",
      "authorized_users",
      slack.authorizedUserIds,
      ["authorized_user_ids_list"],
    );
  }
  if (slack?.authorizedWorkspaces !== undefined) {
    setAuthorizedContacts(
      ["messaging", "slack"],
      "authorized_workspaces",
      "authorized_workspaces",
      slack.authorizedWorkspaces,
    );
  }
  if (slack?.authorizedChannels !== undefined) {
    setAuthorizedContacts(
      ["messaging", "slack"],
      "authorized_channels",
      "authorized_channels",
      slack.authorizedChannels,
    );
  }

  const feishu = patch.messaging?.feishu;
  if (feishu?.enabled !== undefined) {
    set(["messaging", "feishu", "enabled"], feishu.enabled);
  }
  if (feishu?.streamingResponses !== undefined) {
    set(["messaging", "feishu", "streaming_responses"], feishu.streamingResponses);
  }
  if (feishu?.inboundMode !== undefined) {
    set(["messaging", "feishu", "inbound_mode"], feishu.inboundMode);
  }
  if (feishu?.tenantRegion !== undefined) {
    set(["messaging", "feishu", "tenant_region"], feishu.tenantRegion);
  }
  if (feishu?.tenantUrl !== undefined) {
    set(["messaging", "feishu", "tenant_url"], feishu.tenantUrl);
  }
  if (feishu?.callbackBaseUrl !== undefined) {
    set(["messaging", "feishu", "callback_base_url"], feishu.callbackBaseUrl);
  }
  if (feishu?.slashCommandPrefix !== undefined) {
    set(["messaging", "feishu", "slash_command_prefix"], feishu.slashCommandPrefix);
  }
  if (feishu?.registerSlashCommands !== undefined) {
    set(
      ["messaging", "feishu", "register_slash_commands"],
      feishu.registerSlashCommands,
    );
  }
  if (feishu?.authorizedUserIds !== undefined) {
    setAuthorizedContacts(
      ["messaging", "feishu"],
      "authorized_user_ids",
      "authorized_users",
      feishu.authorizedUserIds,
      ["authorized_user_ids_list"],
    );
  }
  if (feishu?.authorizedChats !== undefined) {
    setAuthorizedContacts(
      ["messaging", "feishu"],
      "authorized_chats",
      "authorized_chats",
      feishu.authorizedChats,
    );
  }
  if (feishu?.authorizedTenants !== undefined) {
    setAuthorizedContacts(
      ["messaging", "feishu"],
      "authorized_tenants",
      "authorized_tenants",
      feishu.authorizedTenants,
    );
  }

  const line = patch.messaging?.line;
  if (line?.enabled !== undefined) {
    set(["messaging", "line", "enabled"], line.enabled);
  }
  if (line?.streamingResponses !== undefined) {
    set(["messaging", "line", "streaming_responses"], line.streamingResponses);
  }
  if (line?.webhookUrl !== undefined) {
    set(["messaging", "line", "webhook_url"], line.webhookUrl);
  }
  if (line?.callbackBaseUrl !== undefined) {
    set(["messaging", "line", "callback_base_url"], line.callbackBaseUrl);
  }
  if (line?.botUserId !== undefined) {
    set(["messaging", "line", "bot_user_id"], line.botUserId);
  }
  if (line?.authorizedUserIds !== undefined) {
    setAuthorizedContacts(
      ["messaging", "line"],
      "authorized_user_ids",
      "authorized_users",
      line.authorizedUserIds,
      ["authorized_user_ids_list"],
    );
  }
  if (line?.authorizedGroups !== undefined) {
    setAuthorizedContacts(
      ["messaging", "line"],
      "authorized_groups",
      "authorized_groups",
      line.authorizedGroups,
    );
  }
  if (line?.authorizedRooms !== undefined) {
    setAuthorizedContacts(
      ["messaging", "line"],
      "authorized_rooms",
      "authorized_rooms",
      line.authorizedRooms,
    );
  }

  if (patch.models?.audioTranscriptionEnabled !== undefined) {
    set(["models", "audio_transcription_enabled"], patch.models.audioTranscriptionEnabled);
  }
  appendCodexSettingsEdits(patch.models?.codex, set, edits);
  if (patch.models?.providerDefaults !== undefined) {
    const providerDefaults = normalizeProviderModelDefaults(
      patch.models.providerDefaults,
    );
    const toEntries = (defaultsByProvider: Record<string, DesktopProviderModelDefaults>) => Object.entries(defaultsByProvider)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, defaults]) => ({
        provider,
        ...(defaults.model ? { model: defaults.model } : {}),
        reasoning_efforts: JSON.stringify(defaults.reasoningEffortsByModel),
        ...(defaults.executionMode
          ? { execution_mode: defaults.executionMode }
          : {}),
      }));
    const entries = toEntries(providerDefaults);
    if (entries.length > 0) {
      edits.push({ op: "delete", path: ["models", "model_provider_defaults"] });
      edits.push({
        op: "setTableArray",
        path: ["models", "model_provider_defaults"],
        value: entries,
      });
    } else {
      edits.push({
        op: "deleteTableArray",
        path: ["models", "model_provider_defaults"],
      });
      edits.push({ op: "delete", path: ["models", "model_provider_defaults"] });
    }
    const legacyDefaults = readProviderModelDefaults(currentTables.models?.provider_defaults);
    if (legacyDefaults) {
      const legacyProjection = Object.fromEntries(Object.entries(providerDefaults)
        .filter(([key]) => !key.startsWith("codex-provider:")));
      const oldModel = legacyDefaults.codex?.model
        ?? Object.values(legacyDefaults).find((entry) => entry.model?.startsWith("@"))?.model;
      const oldProviderKey = oldModel ? providerPickerValue("codex", oldModel) : "codex";
      const codex = providerDefaults.codex;
      const compatibleModel = codex?.model ?? providerDefaults[oldProviderKey]?.model;
      const codexEntries = Object.entries(providerDefaults).filter(([key]) => key === "codex" || key.startsWith("codex-provider:"));
      if (codexEntries.length > 0) {
        legacyProjection.codex = {
          ...(compatibleModel ? { model: compatibleModel } : {}),
          reasoningEffortsByModel: Object.assign({}, ...codexEntries.map(([, entry]) => entry.reasoningEffortsByModel)),
          ...(codex?.executionMode ? { executionMode: codex.executionMode }
            : providerDefaults[oldProviderKey]?.executionMode ? { executionMode: providerDefaults[oldProviderKey].executionMode } : {}),
        };
      }
      const legacyEntries = toEntries(legacyProjection);
      edits.push(legacyEntries.length > 0 ? {
        op: "setTableArray", path: ["models", "provider_defaults"], value: legacyEntries,
        comment: `# ${LEGACY_SETTINGS_MARKER} key=provider_defaults shape=${LEGACY_PROVIDER_DEFAULTS_SHAPE} used_through=${LEGACY_PROVIDER_DEFAULTS_LAST_VERSION} kept_for_older_clients`,
      } : { op: "deleteTableArray", path: ["models", "provider_defaults"] });
    }
  }
  if (patch.models?.usageAccountGroups !== undefined) {
    const groups = readUsageAccountGroups(patch.models.usageAccountGroups);
    const entries = Object.entries(groups ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([backend, group]) => ({ backend, group }));
    edits.push(entries.length
      ? { op: "setTableArray", path: ["models", "usage_account_groups"], value: entries }
      : { op: "deleteTableArray", path: ["models", "usage_account_groups"] });
  }
  if (patch.models?.usageAccountNames !== undefined) {
    const names = readUsageAccountNames(patch.models.usageAccountNames);
    const entries = Object.entries(names ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([account, name]) => ({ account, name }));
    edits.push(entries.length
      ? { op: "setTableArray", path: ["models", "usage_account_names"], value: entries }
      : { op: "deleteTableArray", path: ["models", "usage_account_names"] });
  }
  if (patch.models?.helperModels !== undefined) {
    edits.push(...helperModelSettingsToEdits(
      patch.models.helperModels,
      currentTables.models?.helper_models,
    ));
  }
  if (patch.models?.taskMonitorModels !== undefined) {
    const entries = Object.entries(
      normalizeTaskMonitorModels(patch.models.taskMonitorModels),
    )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, choice]) => ({
        provider,
        source: choice.source,
        ...(choice.model ? { model: choice.model } : {}),
        ...(choice.reasoningEffort
          ? { reasoning_effort: choice.reasoningEffort }
          : {}),
      }));
    edits.push(entries.length
      ? { op: "setTableArray", path: ["models", "task_monitor_models"], value: entries }
      : { op: "deleteTableArray", path: ["models", "task_monitor_models"] });
  }
  if (patch.models?.decisionModels !== undefined) {
    // `[models.decision]`: new keys with no legacy shape. A key left at its
    // default is removed rather than written.
    const decision = patch.models.decisionModels;
    const normalized = normalizeDecisionModelSettings({
      model: decision.model,
      cameraCues: decision.cameraCues,
      localEndpoint: decision.local?.endpoint,
      localModel: decision.local?.model,
      jevModel: decision.jev?.model,
      localEnabled: decision.local?.enabled,
      jevEnabled: decision.jev?.enabled,
    });
    const keys: [string, string | boolean | undefined][] = [
      ["model", normalized?.model],
      ["camera_cues", normalized?.cameraCues],
      ["local_enabled", normalized?.local?.enabled],
      ["jev_enabled", normalized?.jev?.enabled],
      ["local_endpoint", normalized?.local?.endpoint],
      ["local_model", normalized?.local?.model],
      ["jev_model", normalized?.jev?.model],
    ];
    for (const [key, value] of keys) {
      if (value === undefined) edits.push({ op: "delete", path: ["models", "decision", key] });
      else set(["models", "decision", key], value);
    }
  }
  if (patch.models?.openaiDecisions !== undefined) {
    // `[models.openai_decisions]`: new keys with no legacy shape. Dashboard
    // ids only; the API key lives in the secret store, never in TOML.
    const ids = normalizeOpenAIDecisionsSettings(patch.models.openaiDecisions);
    const keys: [string, string | boolean | undefined][] = [
      ["enabled", ids?.enabled],
      ["organization_id", ids?.organizationId],
      ["project_id", ids?.projectId],
    ];
    for (const [key, value] of keys) {
      if (value === undefined) edits.push({ op: "delete", path: ["models", "openai_decisions", key] });
      else set(["models", "openai_decisions", key], value);
    }
  }
  if (patch.models?.providerThreadMigrations !== undefined) {
    const providerThreadMigrations = normalizeProviderThreadModelMigrations(
      patch.models.providerThreadMigrations,
    );
    const entries = Object.entries(providerThreadMigrations)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, migration]) => ({
        provider,
        revision: migration.revision,
        model: migration.model,
        ...(migration.reasoningEffort
          ? { reasoning_effort: migration.reasoningEffort }
          : {}),
        ...(migration.sourceModels
          ? { source_models: migration.sourceModels }
          : {}),
        ...(migration.includeThreadsWithoutModel
          ? { include_threads_without_model: true }
          : {}),
        created_at: migration.createdAt,
      }));
    if (entries.length > 0) {
      edits.push({
        op: "setTableArray",
        path: ["models", "provider_thread_migrations"],
        value: entries,
      });
    } else {
      edits.push({
        op: "deleteTableArray",
        path: ["models", "provider_thread_migrations"],
      });
    }
  }
  if (patch.acpAgents) {
    for (const registryId of ["antigravity", "gemini", "grok", "kimi", "qwen"] as const) {
      const agent = patch.acpAgents[registryId];
      if (!agent) continue;
      set(["acp_agents", registryId, "cli_path"], agent.cliPath);
      set(["acp_agents", registryId, "enabled"], agent.enabled);
      if (registryId === "grok") {
        set(["acp_agents", "grok", "managed_builds"], patch.acpAgents.grok?.managedBuilds);
        set(["acp_agents", "grok", "managed_build_channel"], patch.acpAgents.grok?.managedBuildChannel);
      }
    }
  }

  if (patch.git?.backgroundPrPolling !== undefined) {
    // `[experimental].background_pr_polling` was the pre-Git-settings shape.
    // Preserve a recognized old value for older clients, but write the stable
    // key for every current client. The reader prefers `[git]` when both are
    // present, so an older client can never override this canonical value.
    if (
      readBoolean(currentTables.experimental?.background_pr_polling)
      !== undefined
    ) {
      edits.push({
        op: "ensureCommentBefore",
        path: ["experimental", "background_pr_polling"],
        marker: LEGACY_SETTINGS_MARKER,
        comment: legacyBackgroundPrPollingComment(),
      });
      set(
        ["experimental", "background_pr_polling"],
        patch.git.backgroundPrPolling,
      );
    }
    set(["git", "background_pr_polling"], patch.git.backgroundPrPolling);
  }
  if (patch.git?.prAutoDispatchAllowed !== undefined) {
    set(
      ["git", "pr_auto_dispatch_allowed"],
      patch.git.prAutoDispatchAllowed,
    );
  }
  if (patch.git?.defaultPrAutoDispatchEnabled !== undefined) {
    set(
      ["git", "default_pr_auto_dispatch_enabled"],
      patch.git.defaultPrAutoDispatchEnabled,
    );
  }
  if (patch.git?.watchMergeBuilds !== undefined) {
    set(["git", "watch_merge_builds"], patch.git.watchMergeBuilds);
  }
  if (patch.git) edits.push(...githubEnterpriseSettingsEdits(patch.git, currentTables));
  if (patch.git?.prAutoDispatchBudgetCapacity !== undefined) {
    set(
      ["git", "pr_auto_dispatch_budget_capacity"],
      patch.git.prAutoDispatchBudgetCapacity,
    );
  }
  if (patch.git?.prAutoDispatchBudgetRefillPerMinute !== undefined) {
    set(
      ["git", "pr_auto_dispatch_budget_refill_per_minute"],
      patch.git.prAutoDispatchBudgetRefillPerMinute,
    );
  }
  if (patch.git?.pausePrAutoDispatchWhenBudgetEmpty !== undefined) {
    set(
      ["git", "pause_pr_auto_dispatch_when_budget_empty"],
      patch.git.pausePrAutoDispatchWhenBudgetEmpty,
    );
  }
  if (patch.git?.defaultMergeMethod !== undefined) {
    set(["git", "default_merge_method"], patch.git.defaultMergeMethod);
  }
  if (patch.git?.agentTools?.enabled !== undefined) {
    set(["git", "agent_tools", "enabled"], patch.git.agentTools.enabled);
  }
  for (const group of FORGE_AGENT_TOOL_GROUPS) {
    const access = patch.git?.agentTools?.access?.[group];
    if (access !== undefined) {
      set(["git", "agent_tools", group], access);
    }
  }
  if (patch.git?.agentTools?.rules !== undefined) {
    // `[[git.agent_tools.rules]]` is additive: older clients ignore it, so
    // there is no legacy shape to preserve. An entry this build cannot read
    // is written back as it was: dropping it could lift a restriction it
    // meant, and the operator still has to see and fix it.
    const entries: Record<string, TomlEditScalar | readonly string[]>[] = [
      ...forgeAgentToolRuleTomlEntries(patch.git.agentTools.rules),
      ...unreadableForgeAgentToolRuleEntries(currentTables["git.agent_tools"]?.rules),
    ];
    edits.push(entries.length
      ? { op: "setTableArray", path: ["git", "agent_tools", "rules"], value: entries }
      : { op: "deleteTableArray", path: ["git", "agent_tools", "rules"] });
  }

  if (patch.applications?.editor?.preferredId !== undefined) {
    set(["applications", "editor", "preferred_id"], patch.applications.editor.preferredId);
  }
  if (patch.applications?.terminal?.preferredId !== undefined) {
    set(["applications", "terminal", "preferred_id"], patch.applications.terminal.preferredId);
  }
  if (patch.applications?.glab?.enabled !== undefined) {
    set(["applications", "glab", "enabled"], patch.applications.glab.enabled);
  }
  if (patch.applications?.glab?.path !== undefined) {
    set(["applications", "glab", "path"], patch.applications.glab.path);
  }
  if (patch.applications?.glab?.host !== undefined) {
    set(["applications", "glab", "host"], patch.applications.glab.host);
  }
  if (patch.applications?.gh?.enabled !== undefined) {
    set(["applications", "gh", "enabled"], patch.applications.gh.enabled);
  }
  if (patch.applications?.gh?.path !== undefined) {
    set(["applications", "gh", "path"], patch.applications.gh.path);
  }
  if (patch.applications?.git?.path !== undefined) {
    set(["applications", "git", "path"], patch.applications.git.path);
  }
  if (patch.applications?.git?.managed !== undefined) {
    set(["applications", "git", "managed"], patch.applications.git.managed);
  }
  if (patch.applications?.git?.managedPrevious !== undefined) {
    set(["applications", "git", "managed_previous"], patch.applications.git.managedPrevious);
  }
  if (patch.applications?.git?.managedBuildChannel !== undefined) {
    set(["applications", "git", "managed_build_channel"], patch.applications.git.managedBuildChannel);
  }

  if (patch.worktrees?.archive) {
    const archive = patch.worktrees.archive;
    // `enabled` was the automatic-archive switch. This version never writes or
    // removes it, so an older build keeps its own behavior after a downgrade.
    if (readBoolean(currentTables["worktrees.archive"]?.enabled) !== undefined) {
      edits.push({
        op: "ensureCommentBefore",
        path: ["worktrees", "archive", "enabled"],
        marker: LEGACY_SETTINGS_MARKER,
        comment: legacyAutomaticArchiveComment(),
      });
    }
    for (const [property, key] of [
      ["mode", "mode"],
      ["inactivityDays", "inactivity_days"], ["keepPerProject", "keep_per_project"],
      ["retentionDays", "retention_days"],
    ] as const) {
      if (archive[property] !== undefined) set(["worktrees", "archive", key], archive[property]);
    }
  }

  if (patch.worktrees?.hibernate) {
    const hibernate = patch.worktrees.hibernate;
    for (const [property, key] of [
      ["enabled", "enabled"], ["idleDays", "idle_days"], ["maxSnapshotMb", "max_snapshot_mb"],
      ["removeRebuildableOutput", "remove_rebuildable_output"], ["restoreOn", "restore_on"],
    ] as const) {
      if (hibernate[property] !== undefined) set(["worktrees", "hibernate", key], hibernate[property]);
    }
  }

  if (patch.worktrees?.storage !== undefined) {
    set(["worktrees", "storage"], patch.worktrees.storage);
  }
  if (patch.worktrees) edits.push(...worktreeFolderEdits(patch.worktrees, currentTables));

  return edits;
}

/** `[worktrees]` folder keys, kept out of the patch function's bytecode budget. */
function worktreeFolderEdits(
  worktrees: NonNullable<DesktopSettingsConfigPatch["worktrees"]>,
  currentTables: TomlTables,
): TomlEdit[] {
  const edits: TomlEdit[] = [];
  if (worktrees.baseDirectory !== undefined) {
    const baseDirectory = worktrees.baseDirectory?.trim();
    if (baseDirectory) {
      edits.push({ op: "set", path: ["worktrees", "base_directory"], value: baseDirectory });
    } else {
      // Use home folder clears the Codex opt-in too, so a later folder
      // never moves Codex worktrees without being asked again.
      for (const key of ["base_directory", "base_directory_includes_codex"]) {
        if (currentTables["worktrees"]?.[key] !== undefined) edits.push({ op: "delete", path: ["worktrees", key] });
      }
    }
  }
  if (worktrees.baseDirectoryIncludesCodex !== undefined && worktrees.baseDirectory !== null) {
    edits.push({
      op: "set",
      path: ["worktrees", "base_directory_includes_codex"],
      value: worktrees.baseDirectoryIncludesCodex,
    });
  }
  return edits;
}

const RETAIN_UNSUPPORTED_CONFIG_VALUES = ["messaging.telegram.connections", "git.github_enterprise_hosts"];

export function parseDesktopSettingsToml(
  contents: string,
  filePath: string,
): DesktopSettingsConfig {
  return normalizeDesktopConfig(parseTomlTables(contents, filePath, {
    retainUnsupportedValuePaths: RETAIN_UNSUPPORTED_CONFIG_VALUES,
    requiredValuePaths: ["models.codex.config_overrides", "models.codex.local_model_ids", "research.harness.command", "research.harness.args", "research.harness.endpoint", "research.harness.model", "research.harness.api_key_env"],
  }));
}

function normalizeDesktopConfig(
  tables: Record<string, Record<string, TomlScalar>>,
): DesktopSettingsConfig {
  const general = tables["general"];
  const generalAppearance = tables["general.appearance"];
  const generalMarkdown = tables["general.markdown"];
  const generalToolOutputAlerts = tables["general.tool_output_alerts"];
  const generalSpendAlerts = tables["general.spend_alerts"];
  const generalAgentNotifications = tables["general.agent_notifications"];
  const generalMessagingAck = tables["general.messaging_acknowledgment"];
  const onboarding = tables["onboarding"];
  const experimental = tables["experimental"];
  const imageUploads = tables["image_uploads"];
  const updates = tables["updates"];
  const integratedTerminal = tables["integrated_terminal"];
  const ui = tables["ui"];
  const uiLogs = tables["ui.logs"];
  const federation = tables["federation"];
  const messaging = tables["messaging"];
  const attachments = tables["messaging.attachments"];
  const telegram = tables["messaging.telegram"];
  const telegramConnections = parseTelegramConnections(telegram?.connections);
  const discord = tables["messaging.discord"];
  const mattermost = tables["messaging.mattermost"];
  const slack = tables["messaging.slack"];
  const feishu = tables["messaging.feishu"];
  const line = tables["messaging.line"];
  const models = tables["models"];
  const codex = tables["models.codex"];
  const codexAppServerRecycle = tables["models.codex.app_server_recycle"];
  const decision = tables["models.decision"];
  const openaiDecisions = tables["models.openai_decisions"];
  const acpAgentsAntigravity = tables["acp_agents.antigravity"];
  const acpAgentsGemini = tables["acp_agents.gemini"];
  const acpAgentsGrok = tables["acp_agents.grok"];
  const acpAgentsKimi = tables["acp_agents.kimi"];
  const acpAgentsQwen = tables["acp_agents.qwen"];
  const git = tables["git"];
  const gitAgentTools = tables["git.agent_tools"];
  const editor = tables["applications.editor"];
  const terminal = tables["applications.terminal"];
  const gh = tables["applications.gh"];
  const glab = tables["applications.glab"];
  const gitApplication = tables["applications.git"];
  const worktrees = tables["worktrees"];
  const archive = tables["worktrees.archive"];
  const hibernate = tables["worktrees.hibernate"];

  return pruneEmptyConfig({
    research: readResearchSettings(tables["research"], tables["research.harness"], tables["research.mathos"]),
    general: {
      confirmQuitWithInProgressThreads: readBoolean(
        general?.confirm_quit_with_in_progress_threads,
      ),
      attentionPromoteOnTurnEnd: readBoolean(
        general?.attention_promote_on_turn_end,
      ),
      pinnedThreadsOnTop: readBoolean(general?.pinned_threads_on_top),
      autoFixReviews: readBoolean(general?.auto_fix_reviews),
      passSetupVariablesToAgents: readBoolean(
        general?.pass_setup_variables_to_agents,
      ),
      interactiveSvgSkipNotice: readBoolean(
        general?.interactive_svg_skip_notice,
      ),
      interactiveSvgAutoOpen: readBoolean(general?.interactive_svg_auto_open),
      htmlPreviewRunScripts: readBoolean(general?.html_preview_run_scripts),
      mcpGatewayEnabled: readBoolean(general?.mcp_gateway_enabled),
      pdfAnalysisEnabled: readBoolean(general?.pdf_analysis_enabled),
      developerMode: readBoolean(general?.developer_mode),
      hotCpuProfilingEnabled: readBoolean(general?.hot_cpu_profiling_enabled),
      hotCpuProfilingStartDelayMs: readHotCpuProfileStartDelayMs(
        general?.hot_cpu_profiling_start_delay_ms,
      ),
      hotCpuProfilingCaptureRules: readHotCpuCaptureRules(general),
      hotCpuProfilingTriggerMode: readHotCpuProfileTriggerMode(
        general?.hot_cpu_profiling_trigger_mode,
      ),
      hotCpuProfilingSlowburnThresholdPercent: readNumber(
        general?.hot_cpu_profiling_slowburn_threshold_percent,
      ),
      hotCpuProfilingCaptureChromiumTrace: readBoolean(
        general?.hot_cpu_profiling_capture_chromium_trace,
      ),
      hotCpuProfilingCaptureHeapSnapshot: readBoolean(
        general?.hot_cpu_profiling_capture_heap_snapshot,
      ),
      hotCpuProfilingHeapSnapshotLimit: readNumber(
        general?.hot_cpu_profiling_heap_snapshot_limit,
      ),
      notificationsEnabled: readBoolean(general?.notifications_enabled),
      toolOutputAlerts: {
        outputCapHitsEnabled: readBoolean(
          generalToolOutputAlerts?.output_cap_hits_enabled,
        ),
        repeatedLargeOutputsEnabled: readBoolean(
          generalToolOutputAlerts?.repeated_large_outputs_enabled,
        ),
        repeatedLargeOutputMinimumCalls: readNumber(
          generalToolOutputAlerts?.repeated_large_output_minimum_calls,
        ),
        repeatedLargeOutputMinimumPercent: readNumber(
          generalToolOutputAlerts?.repeated_large_output_minimum_percent,
        ),
        monitorJobSuggestionsEnabled: readBoolean(
          generalToolOutputAlerts?.monitor_job_suggestions_enabled,
        ),
        repeatedQueuedChecksEnabled: readBoolean(
          generalToolOutputAlerts?.repeated_queued_checks_enabled,
        ),
      },
      spendAlerts: {
        activeTurnSpendEnabled: readBoolean(
          generalSpendAlerts?.active_turn_spend_enabled,
        ),
        activeTurnSpendThresholdUsd: readNumber(
          generalSpendAlerts?.active_turn_spend_threshold_usd,
        ),
        threadSpendEnabled: readBoolean(
          generalSpendAlerts?.thread_spend_enabled,
        ),
        threadSpendThresholdUsd: readNumber(
          generalSpendAlerts?.thread_spend_threshold_usd,
        ),
      },
      agentNotifications: {
        maxPerThreadPerDay: readNumber(
          generalAgentNotifications?.max_per_thread_per_day,
        ),
        maxPerProfilePerDay: readNumber(
          generalAgentNotifications?.max_per_profile_per_day,
        ),
        maxScheduledPerThread: readNumber(
          generalAgentNotifications?.max_scheduled_per_thread,
        ),
      },
      appearance: {
        theme: readAppearanceTheme(generalAppearance?.theme),
        darkTheme: readDarkTheme(generalAppearance?.dark_theme),
        lightTheme: readLightTheme(generalAppearance?.light_theme),
        themedDockIcon: readBoolean(generalAppearance?.themed_dock_icon),
        terminalMinimumContrast: readBoolean(
          generalAppearance?.terminal_minimum_contrast,
        ),
        calmMotion: readBoolean(generalAppearance?.calm_motion),
        density: readAppearanceDensity(generalAppearance?.density),
        sidebarTextSize: readTextSize(
          generalAppearance?.sidebar_text_size,
        ),
        transcriptTextSize: readTextSize(
          generalAppearance?.transcript_text_size,
        ),
        contextMoon: readContextMoonStyle(generalAppearance?.context_moon),
      },
      // The current key wins; a profile last saved by an older build still
      // holds its choice under [experimental].
      markdown: {
        incrementalRendering:
          readBoolean(generalMarkdown?.incremental_rendering)
          ?? readBoolean(experimental?.incremental_markdown_rendering),
        mathRendering:
          readBoolean(generalMarkdown?.math_rendering)
          ?? readBoolean(experimental?.markdown_math_rendering),
      },
      codexProfileModel: readCodexProfileModel(general?.codex_profile_model),
      messagingAcknowledgment: readMessagingAcknowledgment(
        generalMessagingAck,
      ),
    },
    onboarding: {
      completed: readBoolean(onboarding?.completed),
      completedSource: readOnboardingCompletedSource(
        onboarding?.completed_source,
      ),
    },
    experimental: {
      chatReplyComposer: readComposer(experimental?.chat_reply_composer),
      fullAccessRiskWarningDismissed: readBoolean(
        experimental?.full_access_risk_warning_dismissed,
      ),
      threadPricingSummary: readBoolean(experimental?.thread_pricing_summary),
      threadPricingDisplayUsd: readBoolean(
        experimental?.thread_pricing_display_usd,
      ),
      threadPricingDisplayCodexCredits: readBoolean(
        experimental?.thread_pricing_display_codex_credits,
      ),
      tokenMiserEnabled:
        readBoolean(experimental?.token_miser_enabled)
        ?? readBoolean(general?.token_miser_enabled),
      tokenMiserFocusedSummariesEnabled:
        readBoolean(experimental?.token_miser_focused_summaries_enabled),
      tokenMiserDiagnosticsEnabled:
        readBoolean(experimental?.token_miser_diagnostics_enabled),
      tokenMiserPollingReviewsEnabled:
        readBoolean(experimental?.token_miser_polling_reviews_enabled),
      tokenMiserDefaultEnabled:
        readBoolean(experimental?.token_miser_default_enabled),
      codexToolDiscovery: readBoolean(experimental?.codex_tool_discovery),
      researchEnabled: readBoolean(experimental?.research_enabled),
      resourceCheckoutsEnabled: readBoolean(
        experimental?.resource_checkouts_enabled,
      ),
      codexDefaultModeRequestUserInput: readBoolean(
        experimental?.codex_default_mode_request_user_input,
      ),
      codexSkillQuestionsWarningDismissed: readBoolean(
        experimental?.codex_skill_questions_warning_dismissed,
      ),
      codexConfigWarningsDismissed: readStringArray(
        experimental?.codex_config_warnings_dismissed,
      ),
      managedReview: readBoolean(experimental?.managed_review),
    },
    imageUploads: {
      pastedImageMaxPatches: readNumber(
        imageUploads?.pasted_image_max_patches,
      ),
    },
    updates: {
      channel: readUpdateChannel(updates?.channel),
      train: readUpdateTrain(updates?.train),
      selectionSource: readUpdateSelectionSource(updates?.selection_source),
    },
    integratedTerminal: {
      windowsShell: readIntegratedTerminalWindowsShell(
        integratedTerminal?.windows_shell,
      ),
    },
    ui: {
      sidebarHidden: readBoolean(ui?.sidebar_hidden),
      contextRailPinned: readBoolean(ui?.context_rail_pinned),
      projectIndexHidden: readBoolean(ui?.project_index_hidden),
      projectIndexWidth: readPositiveWidth(ui?.project_index_width),
      activeContextTab: readString(ui?.active_context_tab),
      editedFilesDock: readString(ui?.edited_files_dock),
      actionRunsDock: readString(ui?.action_runs_dock),
      launchpadConnectionsDock: readString(ui?.launchpad_connections_dock),
      logs: readLogsViewerConfig(uiLogs),
    },
    federation: {
      mode: readFederationMode(federation?.mode),
      memberRole: readFederationMemberRole(federation?.member_role),
      instanceLabel: readString(federation?.instance_label),
      instanceNotes: readString(federation?.instance_notes),
      listenHost: readString(federation?.listen_host),
      listenPort: readNumber(federation?.listen_port),
      compressionEnabled: readBoolean(federation?.compression_enabled),
      allowRemoteShells: readBoolean(federation?.allow_remote_shells),
      allowPortForwarding: readBoolean(federation?.allow_port_forwarding),
      allowFilePush: readBoolean(federation?.allow_file_push),
      allowFilePull: readBoolean(federation?.allow_file_pull),
      allowFilePullOutsideThreadDirectories: readBoolean(federation?.allow_file_pull_outside_thread_directories),
      filePushDirectory: readString(federation?.file_push_directory),
      publicUrl: readString(federation?.public_url),
      gatewayUrl: readString(federation?.gateway_url),
      gatewayEndpoints: readEndpointList(federation?.gateway_endpoints),
      advertisedEndpoints: readEndpointList(federation?.advertised_endpoints),
      cloudflareEndpoint: readString(federation?.cloudflare_endpoint),
      // Missing preserves the lifecycle of gateways created before the toggle.
      cloudflareGatewayEnabled: readBoolean(federation?.cloudflare_gateway_enabled),
      cloudflareMtlsEnabled: readBoolean(
        federation?.cloudflare_mtls_enabled,
      ),
      cloudflareAccessServiceAuthEnabled: readBoolean(
        federation?.cloudflare_access_service_auth_enabled,
      ),
      cloudflareAccessOAuthEnabled: readBoolean(
        federation?.cloudflare_access_oauth_enabled,
      ),
    },
    messaging: {
      enabled: readBoolean(messaging?.enabled),
      allowFullAccessEscalation: readBoolean(
        messaging?.allow_full_access_escalation,
      ),
      allowFullAccessThreadResume: readBoolean(
        messaging?.allow_full_access_thread_resume,
      ),
      fullAccessWarning: readFullAccessWarningGlobalPolicy(
        messaging?.full_access_warning,
      ),
      inputDebounceMs: readNumber(messaging?.input_debounce_ms),
      toolUpdateMode: readToolUpdateMode(messaging?.tool_update_mode),
      managerToolUpdateMode: readToolUpdateMode(
        messaging?.manager_tool_update_mode,
      ),
      showStreamingOption: readBoolean(messaging?.show_streaming_option),
      attachments: {
        imageProfile: readImageProfile(attachments?.image_profile),
        pdfProfile: readImageProfile(attachments?.pdf_profile),
        maxAttachmentBytes: readNumber(attachments?.max_attachment_bytes),
        maxAttachmentCount: readNumber(attachments?.max_attachment_count),
      },
      telegram: {
        connections: telegramConnections ?? undefined,
        ...(telegramConnections === null ? { invalidConnections: true } : {}),
        enabled: readBoolean(telegram?.enabled),
        responseMode: readMessagingResponseMode(telegram?.response_mode),
        streamingResponses: readBoolean(telegram?.streaming_responses),
        authorizedUserIds: readAuthorizedContacts(
          telegram?.authorized_users,
          telegram?.authorized_user_ids_list,
          telegram?.authorized_user_ids,
        ),
        authorizedSupergroups: readAuthorizedContacts(
          telegram?.authorized_supergroups_list,
          telegram?.authorized_supergroups,
        ),
      },
      discord: {
        enabled: readBoolean(discord?.enabled),
        responseMode: readMessagingResponseMode(discord?.response_mode),
        responseModeOverrides: readAuthorizedContacts(
          discord?.response_mode_overrides,
        ),
        streamingResponses: readBoolean(discord?.streaming_responses),
        applicationId: readString(discord?.application_id),
        authorizedUserIds: readAuthorizedContacts(
          discord?.authorized_users,
          discord?.authorized_user_ids_list,
          discord?.authorized_user_ids,
        ),
        authorizedGuilds: readAuthorizedContacts(
          discord?.authorized_guilds_list,
          discord?.authorized_guilds,
        ),
      },
      mattermost: {
        enabled: readBoolean(mattermost?.enabled),
        streamingResponses: readBoolean(mattermost?.streaming_responses),
        serverUrl: readString(mattermost?.server_url),
        callbackBaseUrl: readString(mattermost?.callback_base_url),
        slashCommandPrefix: readString(mattermost?.slash_command_prefix),
        registerSlashCommands: readBoolean(mattermost?.register_slash_commands),
        authorizedUserIds: readAuthorizedContacts(
          mattermost?.authorized_users,
          mattermost?.authorized_user_ids_list,
          mattermost?.authorized_user_ids,
        ),
        authorizedTeams: readAuthorizedContacts(
          mattermost?.authorized_teams,
          mattermost?.authorized_teams_list,
          mattermost?.authorized_team_ids_list,
          mattermost?.authorized_team_ids,
        ),
        authorizedConversations: readAuthorizedContacts(
          mattermost?.authorized_conversations,
          mattermost?.authorized_conversations_list,
          mattermost?.authorized_conversation_ids_list,
          mattermost?.authorized_conversation_ids,
        ),
      },
      slack: {
        enabled: readBoolean(slack?.enabled),
        liveWorkingCards: readBoolean(slack?.live_working_cards),
        responseMode: readMessagingResponseMode(slack?.response_mode),
        streamingResponses: readBoolean(slack?.streaming_responses),
        appName: readString(slack?.app_name),
        workspaceUrl: readString(slack?.workspace_url),
        inboundMode: readSlackInboundMode(slack?.inbound_mode),
        teamAuthorizationMode: readMessagingAuthorizationMode(
          slack?.team_authorization_mode,
        ),
        channelAuthorizationMode: readMessagingAuthorizationMode(
          slack?.channel_authorization_mode,
        ),
        dmAccessMode: readSlackDmAccessMode(slack?.dm_access_mode),
        groupDmAccessMode: readSlackGroupDmAccessMode(slack?.group_dm_access_mode),
        channelUserAccessMode: readSlackChannelUserAccessMode(
          slack?.channel_user_access_mode,
        ),
        slashCommandPrefix: readString(slack?.slash_command_prefix),
        registerSlashCommands: readBoolean(slack?.register_slash_commands),
        authorizedUserIds: readAuthorizedContacts(
          slack?.authorized_users,
          slack?.authorized_user_ids_list,
          slack?.authorized_user_ids,
        ),
        authorizedWorkspaces: readAuthorizedContacts(
          slack?.authorized_workspaces_list,
          slack?.authorized_workspaces,
        ),
        authorizedChannels: readAuthorizedContacts(
          slack?.authorized_channels_list,
          slack?.authorized_channels,
        ),
      },
      feishu: {
        enabled: readBoolean(feishu?.enabled),
        streamingResponses: readBoolean(feishu?.streaming_responses),
        inboundMode: readFeishuInboundMode(feishu?.inbound_mode),
        tenantRegion: readFeishuTenantRegion(feishu?.tenant_region),
        tenantUrl: readString(feishu?.tenant_url),
        callbackBaseUrl: readString(feishu?.callback_base_url),
        slashCommandPrefix: readString(feishu?.slash_command_prefix),
        registerSlashCommands: readBoolean(feishu?.register_slash_commands),
        authorizedUserIds: readAuthorizedContacts(
          feishu?.authorized_users,
          feishu?.authorized_user_ids_list,
          feishu?.authorized_user_ids,
        ),
        authorizedChats: readAuthorizedContacts(
          feishu?.authorized_chats,
          feishu?.authorized_chats_list,
        ),
        authorizedTenants: readAuthorizedContacts(
          feishu?.authorized_tenants,
          feishu?.authorized_tenants_list,
        ),
      },
      line: {
        enabled: readBoolean(line?.enabled),
        streamingResponses: readBoolean(line?.streaming_responses),
        webhookUrl: readString(line?.webhook_url),
        callbackBaseUrl: readString(line?.callback_base_url),
        botUserId: readString(line?.bot_user_id),
        authorizedUserIds: readAuthorizedContacts(
          line?.authorized_users,
          line?.authorized_user_ids_list,
          line?.authorized_user_ids,
        ),
        authorizedGroups: readAuthorizedContacts(
          line?.authorized_groups_list,
          line?.authorized_groups,
        ),
        authorizedRooms: readAuthorizedContacts(
          line?.authorized_rooms_list,
          line?.authorized_rooms,
        ),
      },
    },
    models: {
      usageAccountGroups: readUsageAccountGroups(models?.usage_account_groups),
      usageAccountNames: readUsageAccountNames(models?.usage_account_names),
      providerDefaults: readProviderModelDefaults(models?.model_provider_defaults)
        ?? readProviderModelDefaults(models?.provider_defaults),
      providerThreadMigrations: readProviderThreadModelMigrations(
        models?.provider_thread_migrations,
      ),
      helperModels: readHelperModelSettings(
        models?.helper_default_model,
        models?.helper_default_reasoning_effort,
        models?.helper_models,
      ),
      taskMonitorModels: readTaskMonitorModels(models?.task_monitor_models),
      decisionModels: normalizeDecisionModelSettings({
        model: decision?.model,
        cameraCues: decision?.camera_cues,
        localEndpoint: decision?.local_endpoint,
        localModel: decision?.local_model,
        jevModel: decision?.jev_model,
        localEnabled: decision?.local_enabled,
        jevEnabled: decision?.jev_enabled,
      }),
      openaiDecisions: normalizeOpenAIDecisionsSettings({
        enabled: readBoolean(openaiDecisions?.enabled),
        organizationId: readString(openaiDecisions?.organization_id),
        projectId: readString(openaiDecisions?.project_id),
      }),
      audioTranscriptionEnabled: readBoolean(models?.audio_transcription_enabled),
      codex: {
        path: readString(codex?.path),
        profile: readString(codex?.profile),
        allowFast: readBoolean(codex?.allow_fast),
        managedBuilds: readBoolean(codex?.managed_builds),
        managedBuildChannel: readUpdateChannel(codex?.managed_build_channel),
        localModelIds: codex?.local_model_ids === undefined ? undefined : validateLocalModelIds(codex.local_model_ids),
        providers: readCodexModelProviders(codex?.providers, codex?.provider_rates, codex?.provider_model_metadata),
        configOverrides: codex?.config_overrides === undefined
          ? undefined
          : validateCodexConfigOverrides(codex.config_overrides),
        skillProfiles: readCodexSkillProfiles(codex?.skill_profiles),
        ...(codexAppServerRecycle
          ? {
              appServerRecycle: {
                enabled: readBoolean(codexAppServerRecycle.enabled),
                idleMinutes: readPositiveNumber(codexAppServerRecycle.idle_minutes),
                maxUptimeHours: readPositiveNumber(codexAppServerRecycle.max_uptime_hours),
                maxChildProcesses: readPositiveNumber(
                  codexAppServerRecycle.max_child_processes,
                ),
                maxOpenFds: readPositiveNumber(codexAppServerRecycle.max_open_fds),
              },
            }
          : {}),
      },
    },
    acpAgents: {
      antigravity: {
        cliPath: readString(acpAgentsAntigravity?.cli_path),
        enabled: readBoolean(acpAgentsAntigravity?.enabled),
      },
      gemini: {
        cliPath: readString(acpAgentsGemini?.cli_path),
        enabled: readBoolean(acpAgentsGemini?.enabled),
      },
      grok: {
        cliPath: readString(acpAgentsGrok?.cli_path),
        enabled: readBoolean(acpAgentsGrok?.enabled),
        managedBuilds: readBoolean(acpAgentsGrok?.managed_builds),
        managedBuildChannel: readUpdateChannel(
          acpAgentsGrok?.managed_build_channel,
        ),
      },
      kimi: {
        cliPath: readString(acpAgentsKimi?.cli_path),
        enabled: readBoolean(acpAgentsKimi?.enabled),
      },
      qwen: {
        cliPath: readString(acpAgentsQwen?.cli_path),
        enabled: readBoolean(acpAgentsQwen?.enabled),
      },
    },
    git: {
      backgroundPrPolling:
        readBoolean(git?.background_pr_polling)
        ?? readBoolean(experimental?.background_pr_polling),
      prAutoDispatchAllowed: readBoolean(git?.pr_auto_dispatch_allowed),
      defaultPrAutoDispatchEnabled: readBoolean(
        git?.default_pr_auto_dispatch_enabled,
      ),
      watchMergeBuilds: readBoolean(git?.watch_merge_builds),
      prAutoDispatchBudgetCapacity: readNumber(
        git?.pr_auto_dispatch_budget_capacity,
      ),
      prAutoDispatchBudgetRefillPerMinute: readNumber(
        git?.pr_auto_dispatch_budget_refill_per_minute,
      ),
      pausePrAutoDispatchWhenBudgetEmpty: readBoolean(
        git?.pause_pr_auto_dispatch_when_budget_empty,
      ),
      defaultMergeMethod: readMergeMethod(git?.default_merge_method),
      githubEnterpriseHosts: readGithubEnterpriseHostsFromTables(tables),
      githubEnterpriseAccounts: readGithubEnterpriseAccounts(git?.github_enterprise_accounts),
      agentTools: {
        enabled: readBoolean(gitAgentTools?.enabled),
        access: readForgeAgentToolAccess(gitAgentTools),
        ...readForgeAgentToolRules(gitAgentTools?.rules),
      },
    },
    applications: {
      editor: {
        preferredId: readString(editor?.preferred_id),
      },
      terminal: {
        preferredId: readString(terminal?.preferred_id),
      },
      gh: {
        enabled: readBoolean(gh?.enabled),
        path: readString(gh?.path),
      },
      glab: {
        enabled: readBoolean(glab?.enabled),
        path: readString(glab?.path),
        host: readString(glab?.host),
      },
      git: {
        path: readString(gitApplication?.path),
        managed: readString(gitApplication?.managed),
        managedPrevious: readString(gitApplication?.managed_previous),
        managedBuildChannel: readUpdateChannel(gitApplication?.managed_build_channel),
      },
    },
    worktrees: {
      archive: archive ? {
        legacyEnabled: readBoolean(archive?.enabled),
        mode: archive?.mode === "age" || archive?.mode === "count" ? archive.mode : undefined,
        inactivityDays: readNumber(archive?.inactivity_days),
        keepPerProject: readNumber(archive?.keep_per_project),
        retentionDays: readNumber(archive?.retention_days),
      } : undefined,
      hibernate: hibernate ? {
        enabled: readBoolean(hibernate.enabled),
        idleDays: readNumber(hibernate.idle_days),
        maxSnapshotMb: readNumber(hibernate.max_snapshot_mb),
        removeRebuildableOutput: readBoolean(hibernate.remove_rebuildable_output),
        restoreOn: hibernate.restore_on === "send" || hibernate.restore_on === "open" ? hibernate.restore_on : undefined,
      } : undefined,
      storage: readWorktreeStorage(worktrees?.storage),
      baseDirectory: readWorktreeBaseDirectory(worktrees?.base_directory),
      baseDirectoryIncludesCodex: readBoolean(worktrees?.base_directory_includes_codex),
    },
  });
}

/**
 * `[research.mathos]` holds only identifiers; the Platform key is a secret. A
 * team must be a MathOS team id and the origin a plain HTTPS origin. The hosted
 * platform's origin is the default and is not written.
 */
function researchMathosEdits(mathos: { team?: string | null; origin?: string | null }): TomlEdit[] {
  const table = ["research", "mathos"];
  const edits: TomlEdit[] = [];
  if (mathos.team !== undefined) {
    const team = mathos.team?.trim();
    if (!team) edits.push({ op: "delete", path: [...table, "team"] });
    else if (!MATHOS_TEAM_ID.test(team)) throw new Error("Choose a MathOS team.");
    else edits.push({ op: "set", path: [...table, "team"], value: team });
  }
  if (mathos.origin !== undefined) {
    const normalized = normalizeMathosPlatformOrigin(mathos.origin ?? undefined);
    if (!normalized.ok) throw new Error(normalized.error);
    edits.push(normalized.origin === MATHOS_PLATFORM_DEFAULT_ORIGIN
      ? { op: "delete", path: [...table, "origin"] }
      : { op: "set", path: [...table, "origin"], value: normalized.origin });
  }
  return edits;
}

const RESEARCH_HARNESS_OPTIONAL_KEYS = [
  ["endpoint", "endpoint"],
  ["model", "model"],
  ["apiKeyEnv", "api_key_env"],
] as const;

/**
 * `[research.harness]` is additive and keeps its shape: Settings writes the
 * same keys an operator types, one path at a time, so comments and keys it does
 * not own stay. A blank optional value deletes its key; `null` deletes them all.
 * The value is validated first, so a save can never leave a table the reader
 * rejects.
 */
function researchHarnessEdits(harness: ResearchHarnessConfig | null): TomlEdit[] {
  const table = ["research", "harness"];
  if (harness === null) {
    return RESEARCH_HARNESS_KEYS.map((key) => ({ op: "delete" as const, path: [...table, key] }));
  }
  const normalized = normalizeResearchHarnessConfig(harness);
  if (!normalized.ok) throw new Error(normalized.error);
  const value = normalized.value;
  const edits: TomlEdit[] = [
    { op: "set", path: [...table, "command"], value: value.command },
    { op: "set", path: [...table, "args"], value: value.args },
  ];
  for (const [field, key] of RESEARCH_HARNESS_OPTIONAL_KEYS) {
    const entry = value[field];
    edits.push(entry === undefined ? { op: "delete", path: [...table, key] } : { op: "set", path: [...table, key], value: entry });
  }
  return edits;
}

const RESEARCH_HARNESS_KEYS = ["command", "args", ...RESEARCH_HARNESS_OPTIONAL_KEYS.map(([, key]) => key)];

/**
 * Removing the bridge in Settings deletes the keys it owns. The path-based
 * editor cannot delete a table header and keeps keys it does not own, so a
 * `[research.harness]` holding none of the bridge's keys reads as no bridge
 * rather than as an invalid one. A table with any of them still needs a command.
 */
function readResearchSettings(
  research: Record<string, TomlScalar> | undefined,
  harnessTable: Record<string, TomlScalar> | undefined,
  mathosTable: Record<string, TomlScalar> | undefined,
): DesktopSettingsConfig["research"] {
  const harness = harnessTable && RESEARCH_HARNESS_KEYS.some((key) => harnessTable[key] !== undefined)
    ? readResearchHarnessConfig(harnessTable)
    : undefined;
  // An unrecognized source or a non-string MathOS value is ignored, not fatal:
  // the owner then resolves the default source and reports what is missing.
  const sourceValue = research?.harness_source;
  const source = sourceValue === "mathos" || sourceValue === "bridge" ? sourceValue : undefined;
  const team = readString(mathosTable?.team);
  const origin = readString(mathosTable?.origin);
  const mathos = team !== undefined || origin !== undefined
    ? { ...(team !== undefined ? { team } : {}), ...(origin !== undefined ? { origin } : {}) }
    : undefined;
  if (!harness && !source && !mathos) return undefined;
  return { ...(source ? { source } : {}), ...(harness ? { harness } : {}), ...(mathos ? { mathos } : {}) };
}

function readResearchHarnessConfig(table: Record<string, TomlScalar>): import("@pwragent/shared/research-harness").ResearchHarnessConfig {
  if (typeof table.command !== "string" || !table.command.trim()) throw new Error("research.harness.command must name an installed executable");
  const args = table.args ?? [];
  if (!Array.isArray(args) || args.length > 64 || !args.every((v): v is string => typeof v === "string") || JSON.stringify(args).length > 16_000) throw new Error("research.harness.args must be a bounded string array");
  for (const key of ["endpoint", "model", "api_key_env"]) if (table[key] !== undefined && typeof table[key] !== "string") throw new Error(`research.harness.${key} must be a string`);
  return { command: table.command, args, endpoint: readString(table.endpoint), model: readString(table.model), apiKeyEnv: readString(table.api_key_env) };
}

function pruneEmptyConfig(config: DesktopSettingsConfig): DesktopSettingsConfig {
  const pruned: DesktopSettingsConfig = {};
  if (config.research) pruned.research = config.research;

  const developerMode = config.general?.developerMode;
  const hotCpuProfilingEnabled = config.general?.hotCpuProfilingEnabled;
  const hotCpuProfilingStartDelayMs =
    config.general?.hotCpuProfilingStartDelayMs;
  const hotCpuProfilingCaptureRules = config.general?.hotCpuProfilingCaptureRules;
  const hotCpuProfilingTriggerMode =
    config.general?.hotCpuProfilingTriggerMode;
  const hotCpuProfilingSlowburnThresholdPercent =
    config.general?.hotCpuProfilingSlowburnThresholdPercent;
  const hotCpuProfilingCaptureChromiumTrace =
    config.general?.hotCpuProfilingCaptureChromiumTrace;
  const hotCpuProfilingCaptureHeapSnapshot =
    config.general?.hotCpuProfilingCaptureHeapSnapshot;
  const hotCpuProfilingHeapSnapshotLimit =
    config.general?.hotCpuProfilingHeapSnapshotLimit;
  const confirmQuitWithInProgressThreads =
    config.general?.confirmQuitWithInProgressThreads;
  const attentionPromoteOnTurnEnd = config.general?.attentionPromoteOnTurnEnd;
  const pinnedThreadsOnTop = config.general?.pinnedThreadsOnTop;
  const autoFixReviews = config.general?.autoFixReviews;
  const passSetupVariablesToAgents = config.general?.passSetupVariablesToAgents;
  const interactiveSvgSkipNotice = config.general?.interactiveSvgSkipNotice;
  const interactiveSvgAutoOpen = config.general?.interactiveSvgAutoOpen;
  const htmlPreviewRunScripts = config.general?.htmlPreviewRunScripts;
  const pdfAnalysisEnabled = config.general?.pdfAnalysisEnabled;
  const notificationsEnabled = config.general?.notificationsEnabled;
  const toolOutputAlerts = config.general?.toolOutputAlerts;
  const toolOutputAlertsDefined =
    toolOutputAlerts && hasDefinedValue(toolOutputAlerts);
  const spendAlerts = config.general?.spendAlerts;
  const spendAlertsDefined = spendAlerts && hasDefinedValue(spendAlerts);
  const agentNotifications = config.general?.agentNotifications;
  const agentNotificationsDefined = agentNotifications && hasDefinedValue(agentNotifications);
  const appearance = config.general?.appearance;
  const appearanceDefined = appearance && hasDefinedValue(appearance);
  const markdown = config.general?.markdown;
  const markdownDefined = markdown && hasDefinedValue(markdown);
  const codexProfileModel = config.general?.codexProfileModel;
  const messagingAcknowledgment = config.general?.messagingAcknowledgment;
  if (
    developerMode !== undefined ||
    hotCpuProfilingEnabled !== undefined ||
    hotCpuProfilingStartDelayMs !== undefined ||
    hotCpuProfilingCaptureRules !== undefined ||
    hotCpuProfilingTriggerMode !== undefined ||
    hotCpuProfilingSlowburnThresholdPercent !== undefined ||
    hotCpuProfilingCaptureChromiumTrace !== undefined ||
    hotCpuProfilingCaptureHeapSnapshot !== undefined ||
    hotCpuProfilingHeapSnapshotLimit !== undefined ||
    confirmQuitWithInProgressThreads !== undefined ||
    attentionPromoteOnTurnEnd !== undefined ||
    pinnedThreadsOnTop !== undefined ||
    autoFixReviews !== undefined ||
    passSetupVariablesToAgents !== undefined ||
    interactiveSvgSkipNotice !== undefined ||
    interactiveSvgAutoOpen !== undefined ||
    htmlPreviewRunScripts !== undefined ||
    pdfAnalysisEnabled !== undefined ||
    notificationsEnabled !== undefined ||
    toolOutputAlertsDefined ||
    spendAlertsDefined ||
    agentNotificationsDefined ||
    appearanceDefined ||
    markdownDefined ||
    codexProfileModel !== undefined ||
    messagingAcknowledgment !== undefined
  ) {
    pruned.general = {};
    if (developerMode !== undefined) {
      pruned.general.developerMode = developerMode;
    }
    if (hotCpuProfilingEnabled !== undefined) {
      pruned.general.hotCpuProfilingEnabled = hotCpuProfilingEnabled;
    }
    if (hotCpuProfilingStartDelayMs !== undefined) {
      pruned.general.hotCpuProfilingStartDelayMs = hotCpuProfilingStartDelayMs;
    }
    if (hotCpuProfilingCaptureRules !== undefined) {
      pruned.general.hotCpuProfilingCaptureRules = hotCpuProfilingCaptureRules;
    }
    if (hotCpuProfilingTriggerMode !== undefined) {
      pruned.general.hotCpuProfilingTriggerMode = hotCpuProfilingTriggerMode;
    }
    if (hotCpuProfilingSlowburnThresholdPercent !== undefined) {
      pruned.general.hotCpuProfilingSlowburnThresholdPercent =
        hotCpuProfilingSlowburnThresholdPercent;
    }
    if (hotCpuProfilingCaptureChromiumTrace !== undefined) {
      pruned.general.hotCpuProfilingCaptureChromiumTrace = hotCpuProfilingCaptureChromiumTrace;
    }
    if (hotCpuProfilingCaptureHeapSnapshot !== undefined) {
      pruned.general.hotCpuProfilingCaptureHeapSnapshot =
        hotCpuProfilingCaptureHeapSnapshot;
    }
    if (hotCpuProfilingHeapSnapshotLimit !== undefined) {
      pruned.general.hotCpuProfilingHeapSnapshotLimit =
        hotCpuProfilingHeapSnapshotLimit;
    }
    if (confirmQuitWithInProgressThreads !== undefined) {
      pruned.general.confirmQuitWithInProgressThreads =
        confirmQuitWithInProgressThreads;
    }
    if (attentionPromoteOnTurnEnd !== undefined) {
      pruned.general.attentionPromoteOnTurnEnd = attentionPromoteOnTurnEnd;
    }
    if (pinnedThreadsOnTop !== undefined) {
      pruned.general.pinnedThreadsOnTop = pinnedThreadsOnTop;
    }
    if (autoFixReviews !== undefined) {
      pruned.general.autoFixReviews = autoFixReviews;
    }
    if (passSetupVariablesToAgents !== undefined) {
      pruned.general.passSetupVariablesToAgents = passSetupVariablesToAgents;
    }
    if (interactiveSvgSkipNotice !== undefined) {
      pruned.general.interactiveSvgSkipNotice = interactiveSvgSkipNotice;
    }
    if (interactiveSvgAutoOpen !== undefined) {
      pruned.general.interactiveSvgAutoOpen = interactiveSvgAutoOpen;
    }
    if (htmlPreviewRunScripts !== undefined) {
      pruned.general.htmlPreviewRunScripts = htmlPreviewRunScripts;
    }
    if (pdfAnalysisEnabled !== undefined) {
      pruned.general.pdfAnalysisEnabled = pdfAnalysisEnabled;
    }
    if (notificationsEnabled !== undefined) {
      pruned.general.notificationsEnabled = notificationsEnabled;
    }
    if (toolOutputAlertsDefined) {
      pruned.general.toolOutputAlerts = toolOutputAlerts;
    }
    if (spendAlertsDefined) {
      pruned.general.spendAlerts = spendAlerts;
    }
    if (agentNotificationsDefined) {
      pruned.general.agentNotifications = agentNotifications;
    }
    if (appearanceDefined) {
      pruned.general.appearance = appearance;
    }
    if (markdownDefined) {
      pruned.general.markdown = markdown;
    }
    if (codexProfileModel !== undefined) {
      pruned.general.codexProfileModel = codexProfileModel;
    }
    if (messagingAcknowledgment !== undefined) {
      pruned.general.messagingAcknowledgment = messagingAcknowledgment;
    }
  }

  if (config.onboarding?.completed !== undefined) {
    pruned.onboarding = { completed: config.onboarding.completed };
  }

  const onboarding = config.onboarding;
  if (onboarding && hasDefinedValue(onboarding)) {
    pruned.onboarding = {};
    if (onboarding.completed !== undefined) {
      pruned.onboarding.completed = onboarding.completed;
    }
    if (onboarding.completedSource !== undefined) {
      pruned.onboarding.completedSource = onboarding.completedSource;
    }
  }

  if (config.experimental && hasDefinedValue(config.experimental)) {
    pruned.experimental = config.experimental;
  }

  if (config.git && hasDefinedValue(config.git)) {
    pruned.git = config.git;
  }

  if (config.imageUploads && hasDefinedValue(config.imageUploads)) {
    pruned.imageUploads = config.imageUploads;
  }

  if (config.updates && hasDefinedValue(config.updates)) {
    pruned.updates = config.updates;
  }

  if (
    config.integratedTerminal &&
    hasDefinedValue(config.integratedTerminal)
  ) {
    pruned.integratedTerminal = config.integratedTerminal;
  }

  if (config.ui && hasDefinedValue(config.ui)) {
    pruned.ui = config.ui;
  }

  if (config.federation && hasDefinedValue(config.federation)) {
    pruned.federation = config.federation;
  }

  const attachments = config.messaging?.attachments;
  const telegram = config.messaging?.telegram;
  const discord = config.messaging?.discord;
  const mattermost = config.messaging?.mattermost;
  const slack = config.messaging?.slack;
  const feishu = config.messaging?.feishu;
  const line = config.messaging?.line;
  const inputDebounceMs = config.messaging?.inputDebounceMs;
  const enabled = config.messaging?.enabled;
  const allowFullAccessEscalation = config.messaging?.allowFullAccessEscalation;
  const allowFullAccessThreadResume = config.messaging?.allowFullAccessThreadResume;
  const fullAccessWarning = config.messaging?.fullAccessWarning;
  const toolUpdateMode = config.messaging?.toolUpdateMode;
  const managerToolUpdateMode = config.messaging?.managerToolUpdateMode;
  const showStreamingOption = config.messaging?.showStreamingOption;
  if (
    enabled !== undefined ||
    allowFullAccessEscalation !== undefined ||
    allowFullAccessThreadResume !== undefined ||
    fullAccessWarning !== undefined ||
    inputDebounceMs !== undefined ||
    toolUpdateMode !== undefined ||
    managerToolUpdateMode !== undefined ||
    showStreamingOption !== undefined ||
    (attachments && hasDefinedValue(attachments))
    || (telegram && hasDefinedValue(telegram))
    || (discord && hasDefinedValue(discord))
    || (mattermost && hasDefinedValue(mattermost))
    || (slack && hasDefinedValue(slack))
    || (feishu && hasDefinedValue(feishu))
    || (line && hasDefinedValue(line))
  ) {
    pruned.messaging = {};
    if (enabled !== undefined) {
      pruned.messaging.enabled = enabled;
    }
    if (allowFullAccessEscalation !== undefined) {
      pruned.messaging.allowFullAccessEscalation = allowFullAccessEscalation;
    }
    if (allowFullAccessThreadResume !== undefined) {
      pruned.messaging.allowFullAccessThreadResume = allowFullAccessThreadResume;
    }
    if (fullAccessWarning !== undefined) {
      pruned.messaging.fullAccessWarning = fullAccessWarning;
    }
    if (inputDebounceMs !== undefined) {
      pruned.messaging.inputDebounceMs = inputDebounceMs;
    }
    if (showStreamingOption !== undefined) {
      pruned.messaging.showStreamingOption = showStreamingOption;
    }
    if (toolUpdateMode !== undefined) {
      pruned.messaging.toolUpdateMode = toolUpdateMode;
    }
    if (managerToolUpdateMode !== undefined) {
      pruned.messaging.managerToolUpdateMode = managerToolUpdateMode;
    }
    if (attachments && hasDefinedValue(attachments)) {
      pruned.messaging.attachments = attachments;
    }
    if (telegram && hasDefinedValue(telegram)) {
      pruned.messaging.telegram = telegram;
    }
    if (discord && hasDefinedValue(discord)) {
      pruned.messaging.discord = discord;
    }
    if (mattermost && hasDefinedValue(mattermost)) {
      pruned.messaging.mattermost = mattermost;
    }
    if (slack && hasDefinedValue(slack)) {
      pruned.messaging.slack = slack;
    }
    if (feishu && hasDefinedValue(feishu)) {
      pruned.messaging.feishu = feishu;
    }
    if (line && hasDefinedValue(line)) {
      pruned.messaging.line = line;
    }
  }

  const codex = config.models?.codex;
  const providerDefaults = config.models?.providerDefaults;
  const providerThreadMigrations = config.models?.providerThreadMigrations;
  const helperModels = config.models?.helperModels;
  const taskMonitorModels = config.models?.taskMonitorModels;
  const hasTaskMonitorModels = Boolean(
    taskMonitorModels && Object.keys(taskMonitorModels).length > 0,
  );
  const usageAccountGroups = config.models?.usageAccountGroups;
  const usageAccountNames = config.models?.usageAccountNames;
  const decisionModels = config.models?.decisionModels;
  const openaiDecisions = config.models?.openaiDecisions;
  const audioTranscriptionEnabled = config.models?.audioTranscriptionEnabled;
  const hasHelperModels = Boolean(
    helperModels
    && (
      helperModels.defaultModel
      || helperModels.defaultReasoningEffort
      || Object.keys(helperModels.helpers).length > 0
    ),
  );
  if (
    (codex && hasDefinedValue(codex))
    || (providerDefaults && Object.keys(providerDefaults).length > 0)
    || (
      providerThreadMigrations
      && Object.keys(providerThreadMigrations).length > 0
    )
    || hasHelperModels
    || hasTaskMonitorModels
    || (usageAccountGroups && Object.keys(usageAccountGroups).length > 0)
    || (usageAccountNames && Object.keys(usageAccountNames).length > 0)
    || decisionModels
    || openaiDecisions
    || audioTranscriptionEnabled !== undefined
  ) {
    pruned.models = {
      ...(usageAccountGroups && Object.keys(usageAccountGroups).length > 0 ? { usageAccountGroups } : {}),
      ...(usageAccountNames && Object.keys(usageAccountNames).length > 0 ? { usageAccountNames } : {}),
      ...(hasHelperModels ? { helperModels } : {}),
      ...(hasTaskMonitorModels ? { taskMonitorModels } : {}),
      ...(decisionModels ? { decisionModels } : {}),
      ...(openaiDecisions ? { openaiDecisions } : {}),
      ...(audioTranscriptionEnabled !== undefined ? { audioTranscriptionEnabled } : {}),
      ...(providerDefaults && Object.keys(providerDefaults).length > 0
        ? { providerDefaults }
        : {}),
      ...(
        providerThreadMigrations
        && Object.keys(providerThreadMigrations).length > 0
          ? { providerThreadMigrations }
          : {}
      ),
      ...(codex && hasDefinedValue(codex) ? { codex } : {}),
    };
  }

  const acpAgentsAntigravity = config.acpAgents?.antigravity;
  const acpAgentsGemini = config.acpAgents?.gemini;
  const acpAgentsGrok = config.acpAgents?.grok;
  const acpAgentsKimi = config.acpAgents?.kimi;
  const acpAgentsQwen = config.acpAgents?.qwen;
  if (
    (acpAgentsAntigravity && hasDefinedValue(acpAgentsAntigravity)) ||
    (acpAgentsGemini && hasDefinedValue(acpAgentsGemini)) ||
    (acpAgentsGrok && hasDefinedValue(acpAgentsGrok)) ||
    (acpAgentsKimi && hasDefinedValue(acpAgentsKimi)) ||
    (acpAgentsQwen && hasDefinedValue(acpAgentsQwen))
  ) {
    pruned.acpAgents = {
      ...(acpAgentsAntigravity && hasDefinedValue(acpAgentsAntigravity)
        ? { antigravity: acpAgentsAntigravity }
        : {}),
      ...(acpAgentsGemini && hasDefinedValue(acpAgentsGemini)
        ? { gemini: acpAgentsGemini }
        : {}),
      ...(acpAgentsGrok && hasDefinedValue(acpAgentsGrok)
        ? { grok: acpAgentsGrok }
        : {}),
      ...(acpAgentsKimi && hasDefinedValue(acpAgentsKimi)
        ? { kimi: acpAgentsKimi }
        : {}),
      ...(acpAgentsQwen && hasDefinedValue(acpAgentsQwen)
        ? { qwen: acpAgentsQwen }
        : {}),
    };
  }

  const editor = config.applications?.editor;
  const terminal = config.applications?.terminal;
  const gh = config.applications?.gh;
  const glab = config.applications?.glab;
  const gitApplication = config.applications?.git;
  if (
    (editor && hasDefinedValue(editor))
    || (terminal && hasDefinedValue(terminal))
    || (gh && hasDefinedValue(gh))
    || (glab && hasDefinedValue(glab))
    || (gitApplication && hasDefinedValue(gitApplication))
  ) {
    pruned.applications = {};
    if (editor && hasDefinedValue(editor)) {
      pruned.applications.editor = editor;
    }
    if (terminal && hasDefinedValue(terminal)) {
      pruned.applications.terminal = terminal;
    }
    if (glab && hasDefinedValue(glab)) {
      pruned.applications.glab = glab;
    }
    if (gh && hasDefinedValue(gh)) {
      pruned.applications.gh = gh;
    }
    if (gitApplication && hasDefinedValue(gitApplication)) {
      pruned.applications.git = gitApplication;
    }
  }

  const worktrees = config.worktrees;
  if (worktrees && hasDefinedValue(worktrees)) {
    pruned.worktrees = worktrees;
  }

  return pruned;
}

function hasDefinedValue(values: object): boolean {
  return Object.values(values).some((value) => value !== undefined);
}

function readComposer(value: TomlScalar | undefined): StoredChatReplyComposer | undefined {
  return typeof value === "string" && isDesktopChatReplyComposer(value)
    ? value
    : undefined;
}

function isDesktopChatReplyComposer(
  value: string,
): value is StoredChatReplyComposer {
  return (
    value === "textarea"
    || value === "tiptap-chips"
    || value === "tiptap-wysiwyg-markdown-chips"
    || value === "custom-widget-chips"
  );
}

function readToolUpdateMode(
  value: TomlScalar | undefined,
): MessagingToolUpdateMode | undefined {
  return typeof value === "string" && isMessagingToolUpdateMode(value)
    ? value
    : undefined;
}

function readUpdateChannel(
  value: TomlScalar | undefined,
): DesktopUpdateChannel | undefined {
  return parseDesktopUpdateChannel(value);
}

function readUpdateTrain(
  value: TomlScalar | undefined,
): DesktopUpdateTrain | undefined {
  return typeof value === "string" && isDesktopUpdateTrain(value)
    ? value
    : undefined;
}

function readUpdateSelectionSource(
  value: TomlScalar | undefined,
): DesktopUpdateSelectionSource | undefined {
  return isDesktopUpdateSelectionSource(value) ? value : undefined;
}

function readAppearanceTheme(
  value: TomlScalar | undefined,
): DesktopAppearanceTheme | undefined {
  return typeof value === "string" && isDesktopAppearanceTheme(value)
    ? value
    : undefined;
}

function readDarkTheme(
  value: TomlScalar | undefined,
): DesktopDarkTheme | undefined {
  return typeof value === "string" && isDesktopDarkTheme(value)
    ? value
    : undefined;
}

function readLightTheme(
  value: TomlScalar | undefined,
): DesktopLightTheme | undefined {
  return typeof value === "string" && isDesktopLightTheme(value)
    ? value
    : undefined;
}

function readAppearanceDensity(
  value: TomlScalar | undefined,
): DesktopAppearanceDensity | undefined {
  return typeof value === "string" && isDesktopAppearanceDensity(value)
    ? value
    : undefined;
}

function readTextSize(
  value: TomlScalar | undefined,
): DesktopTextSize | undefined {
  return typeof value === "string" && isDesktopTextSize(value)
    ? value
    : undefined;
}

function readContextMoonStyle(
  value: TomlScalar | undefined,
): DesktopContextMoonStyle | undefined {
  return typeof value === "string" && isDesktopContextMoonStyle(value)
    ? value
    : undefined;
}

function readIntegratedTerminalWindowsShell(
  value: TomlScalar | undefined,
): DesktopIntegratedTerminalWindowsShell | undefined {
  const normalized = typeof value === "string" ? value.trim() : undefined;
  return normalized && isDesktopIntegratedTerminalWindowsShell(normalized)
    ? normalized
    : undefined;
}

function readOnboardingCompletedSource(
  value: TomlScalar | undefined,
): DesktopOnboardingCompletedSource | undefined {
  return typeof value === "string" && isDesktopOnboardingCompletedSource(value)
    ? value
    : undefined;
}

function readCodexProfileModel(
  value: TomlScalar | undefined,
): DesktopCodexProfileModel | undefined {
  return typeof value === "string" && isDesktopCodexProfileModel(value)
    ? value
    : undefined;
}

function readHotCpuProfileStartDelayMs(
  value: TomlScalar | undefined,
): DesktopHotCpuProfileStartDelayMs | undefined {
  return typeof value === "number" && isDesktopHotCpuProfileStartDelayMs(value)
    ? value
    : undefined;
}

function readForgeAgentToolAccess(
  table: Record<string, TomlScalar> | undefined,
): Partial<Record<ForgeAgentToolGroup, ForgeAgentToolAccess>> {
  const access: Partial<Record<ForgeAgentToolGroup, ForgeAgentToolAccess>> = {};
  for (const group of FORGE_AGENT_TOOL_GROUPS) {
    const value = table?.[group];
    if (isForgeAgentToolAccess(group, value)) {
      access[group] = value;
    }
  }
  return access;
}

type ForgeAgentToolRuleEntryRead =
  | { ok: true; rule: ForgeAgentToolRule }
  | { ok: false; problems: string[]; repository?: string };

/**
 * Read one `[[git.agent_tools.rules]]` table. Any problem makes the whole
 * entry unreadable: a misspelled agent or group, a bad level, a provider or
 * model where none is allowed. Applying part of it, or dropping it, could
 * let a broader rule or the global level give an agent what the entry meant
 * to withhold.
 */
function readForgeAgentToolRuleEntry(item: unknown): ForgeAgentToolRuleEntryRead {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return { ok: false, problems: ["expected a table"] };
  }
  const entry = item as Record<string, unknown>;
  const repository = typeof entry.repository === "string"
    ? normalizeForgeRuleRepository(entry.repository)
    : undefined;
  const problems: string[] = [];
  const access: Record<string, unknown> = {};
  for (const [key, level] of Object.entries(entry)) {
    if (FORGE_AGENT_TOOL_RULE_TOML_KEYS.has(key)) continue;
    if (!isForgeAgentToolRuleGroup(key)) {
      problems.push(
        `unknown key ${key}; rules set only ${FORGE_AGENT_TOOL_RULE_GROUPS.join(", ")}`,
      );
    } else if (isForgeAgentToolAccess(key, level)) {
      access[key] = level;
    } else {
      problems.push(`${key} has unknown level ${JSON.stringify(level)}`);
    }
  }
  const result = validateForgeAgentToolRule({
    repository: entry.repository,
    agent: {
      backend: entry.agent,
      codexModelProvider: entry.codex_model_provider,
      model: entry.model,
    },
    access,
  });
  if (!result.ok) problems.push(result.reason);
  else problems.push(...result.problems);
  if (problems.length > 0 || !result.ok) {
    return { ok: false, problems, ...(repository ? { repository } : {}) };
  }
  return { ok: true, rule: result.rule };
}

/**
 * `[[git.agent_tools.rules]]`. An entry that cannot be read is left out of
 * the rules with a warning, and its repository is reported so every call
 * there is capped at Ask until the entry is fixed: a mistake never widens
 * access. Duplicate entries for one repository and agent merge.
 */
function readForgeAgentToolRules(
  value: TomlScalar | undefined,
): { rules?: ForgeAgentToolRule[]; unreadableRuleRepositories?: string[] } {
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    console.warn("Ignoring git.agent_tools.rules: expected [[git.agent_tools.rules]] tables.");
    return { rules: [] };
  }
  const rules: ForgeAgentToolRule[] = [];
  const unreadable = new Set<string>();
  (value as readonly unknown[]).forEach((item, index) => {
    const read = readForgeAgentToolRuleEntry(item);
    if (read.ok) {
      rules.push(read.rule);
      return;
    }
    if (read.repository) unreadable.add(read.repository);
    const effect = read.repository
      ? `every agent asks before writing in ${read.repository} until it is fixed`
      : "it names no repository, so it applies nowhere";
    console.warn(
      `git.agent_tools.rules entry ${index + 1} cannot be read (${read.problems.join("; ")}); ${effect}.`,
    );
  });
  return {
    rules: normalizeForgeAgentToolRules(rules),
    ...(unreadable.size > 0 ? { unreadableRuleRepositories: [...unreadable] } : {}),
  };
}

/** The raw tables of the entries `readForgeAgentToolRules` could not read. */
function unreadableForgeAgentToolRuleEntries(
  value: TomlValue | undefined,
): Record<string, TomlEditScalar | readonly string[]>[] {
  if (!Array.isArray(value)) return [];
  return (value as readonly unknown[]).filter((item): item is Record<string, TomlEditScalar | string[]> =>
    typeof item === "object" && item !== null && !Array.isArray(item)
    && !readForgeAgentToolRuleEntry(item).ok);
}

const FORGE_AGENT_TOOL_RULE_TOML_KEYS = new Set([
  "repository",
  "agent",
  "codex_model_provider",
  "model",
]);

function forgeAgentToolRuleTomlEntries(
  rules: readonly ForgeAgentToolRule[],
): Record<string, string>[] {
  return normalizeForgeAgentToolRules(rules, (problem, index) => {
    throw new Error(`Invalid forge tool rule ${index + 1}: ${problem}.`);
  }).map((rule) => {
    const entry: Record<string, string> = {
      repository: rule.repository,
      agent: rule.agent.backend,
    };
    if (rule.agent.codexModelProvider) {
      entry.codex_model_provider = rule.agent.codexModelProvider;
    }
    if (rule.agent.model) entry.model = rule.agent.model;
    for (const group of FORGE_AGENT_TOOL_RULE_GROUPS) {
      const level = rule.access[group];
      if (level !== undefined) entry[group] = level;
    }
    return entry;
  });
}

function readMergeMethod(
  value: TomlScalar | undefined,
): ThreadTodoMergeMethod | undefined {
  return isThreadTodoMergeMethod(value) ? value : undefined;
}

function readHotCpuCaptureRules(general?: TomlTables[string]): HotCpuCaptureRules | undefined {
  if (!general || !Object.values(HOT_CPU_RULE_KEYS).some((key) => general[key] !== undefined)) {
    return undefined;
  }
  const keys = HOT_CPU_RULE_KEYS;
  const defaults = migrateHotCpuCaptureRules();
  // Hand-edited profiles may omit fields. A present malformed field invalidates
  // this representation so the settings reader and retirement can use legacy data.
  const rules = {
    highEnabled: general[keys.highEnabled] ?? defaults.highEnabled,
    highMode: general[keys.highMode] ?? defaults.highMode,
    spike: {
      thresholdPercent: general[keys.spikeThreshold] ?? defaults.spike.thresholdPercent,
      durationMs: general[keys.spikeDuration] ?? defaults.spike.durationMs,
    },
    sustained: {
      thresholdPercent: general[keys.sustainedThreshold] ?? defaults.sustained.thresholdPercent,
      durationMs: general[keys.sustainedDuration] ?? defaults.sustained.durationMs,
      ...(general[keys.sustainedLegacyInterval] === undefined ? {} : {
        legacyIntervalTiming: general[keys.sustainedLegacyInterval],
      }),
    },
    slowburn: {
      enabled: general[keys.slowburnEnabled] ?? defaults.slowburn.enabled,
      thresholdPercent: general[HOT_CPU_SLOWBURN_THRESHOLD] ?? defaults.slowburn.thresholdPercent,
      durationMs: general[keys.slowburnDuration] ?? defaults.slowburn.durationMs,
      ...(general[keys.slowburnLegacyInterval] === undefined ? {} : {
        legacyIntervalTiming: general[keys.slowburnLegacyInterval],
      }),
    },
  };
  return isHotCpuCaptureRules(rules) ? rules : undefined;
}

function hotCpuCaptureRulesEdits(rules: HotCpuCaptureRules): TomlEdit[] {
  const keys = HOT_CPU_RULE_KEYS;
  const edits: TomlEdit[] = Object.entries({
    [keys.highEnabled]: rules.highEnabled,
    [keys.highMode]: rules.highMode,
    [keys.spikeThreshold]: rules.spike.thresholdPercent,
    [keys.spikeDuration]: rules.spike.durationMs,
    [keys.sustainedThreshold]: rules.sustained.thresholdPercent,
    [keys.sustainedDuration]: rules.sustained.durationMs,
    [keys.slowburnEnabled]: rules.slowburn.enabled,
    [keys.slowburnDuration]: rules.slowburn.durationMs,
    [HOT_CPU_SLOWBURN_THRESHOLD]: rules.slowburn.thresholdPercent,
  }).map(([key, value]) => ({ op: "set", path: ["general", key], value }));
  for (const [key, legacyTiming] of [
    [keys.sustainedLegacyInterval, rules.sustained.legacyIntervalTiming],
    [keys.slowburnLegacyInterval, rules.slowburn.legacyIntervalTiming],
  ] as const) {
    const path = ["general", key];
    edits.push(legacyTiming ? { op: "set", path, value: true } : { op: "delete", path });
  }
  return edits;
}

function readHotCpuProfileTriggerMode(
  value: TomlScalar | undefined,
): DesktopHotCpuProfileTriggerMode | undefined {
  return typeof value === "string" && isDesktopHotCpuProfileTriggerMode(value)
    ? value
    : undefined;
}

// Endpoints are dialed by the main process, so the scheme allowlist is
// enforced here rather than trusting the renderer (config.toml is
// hand-editable, and invite-supplied endpoints never pass through the UI).
function sanitizeEndpointList(endpoints: readonly string[]): string[] {
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const endpoint of endpoints) {
    const trimmed = endpoint.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    if (!isFederationGatewayEndpointUrl(trimmed)) continue;
    seen.add(trimmed);
    sanitized.push(trimmed);
  }
  return sanitized;
}

// Drops entries a hand-edited config may contain that the transport must never
// dial (wrong scheme, embedded password, option-like host).
function readEndpointList(
  value: TomlScalar | undefined,
): string[] | undefined {
  const raw = readStringArray(value);
  if (raw === undefined) return undefined;
  const sanitized = sanitizeEndpointList(raw);
  return sanitized.length > 0 ? sanitized : undefined;
}

function legacyGatewayUrlComment(): string {
  return [
    "#",
    LEGACY_SETTINGS_MARKER,
    "key=gateway_url",
    "shape=string",
    `used_through=${LEGACY_FEDERATION_GATEWAY_URL_LAST_VERSION}`,
    "kept_for_older_clients",
  ].join(" ");
}

/**
 * Containment fails closed: a value the operator wrote but this build does
 * not recognize, such as `"trusted"` or `true`, contains the instance.
 */
export function readFederationMemberRole(
  value: TomlScalar | undefined,
): FederationPeerRole | undefined {
  if (value === undefined || value === "") return undefined;
  return typeof value === "string" && value.trim().toLowerCase() === "full" ? "full" : "contained";
}

function readFederationMode(
  value: TomlScalar | undefined,
): DesktopFederationMode | undefined {
  if (value === "child") {
    return "client";
  }
  return typeof value === "string" && isDesktopFederationMode(value)
    ? value
    : undefined;
}

function readMessagingAcknowledgment(
  table: Record<string, TomlScalar> | undefined,
): DesktopMessagingAcknowledgment | undefined {
  if (!table) return undefined;
  const acknowledgedAt = readString(table.acknowledged_at);
  if (!acknowledgedAt) return undefined;
  const providers = readStringArray(table.providers) ?? [];
  return { acknowledgedAt, providers };
}


function isMessagingToolUpdateMode(
  value: string,
): value is MessagingToolUpdateMode {
  return (
    value === "show_none"
    || value === "show_less"
    || value === "show_some"
    || value === "show_more"
    || value === "show_all"
  );
}

function readSlackInboundMode(
  value: TomlScalar | undefined,
): "socket" | "events" | undefined {
  return value === "socket" || value === "events" ? value : undefined;
}

function readMessagingAuthorizationMode(
  value: TomlScalar | undefined,
): DesktopMessagingAuthorizationMode | undefined {
  return value === "approved_only" || value === "allow_all" ? value : undefined;
}

function readSlackDmAccessMode(
  value: TomlScalar | undefined,
): DesktopMessagingSlackDmAccessMode | undefined {
  return value === "any_workspace_user"
    || value === "authorized_users"
    || value === "none"
    ? value
    : undefined;
}

function readSlackGroupDmAccessMode(
  value: TomlScalar | undefined,
): DesktopMessagingSlackGroupDmAccessMode | undefined {
  return value === "none" || value === "authorized_users" ? value : undefined;
}

function readSlackChannelUserAccessMode(
  value: TomlScalar | undefined,
): DesktopMessagingSlackChannelUserAccessMode | undefined {
  return value === "any_channel_user"
    || value === "authorized_users"
    || value === "none"
    ? value
    : undefined;
}

function readFeishuInboundMode(
  value: TomlScalar | undefined,
): "persistent" | "webhook" | undefined {
  return value === "persistent" || value === "webhook" ? value : undefined;
}

function readFeishuTenantRegion(
  value: TomlScalar | undefined,
): "feishu" | "lark" | undefined {
  return value === "feishu" || value === "lark" ? value : undefined;
}

function readFullAccessWarningGlobalPolicy(
  value: TomlScalar | undefined,
): DesktopMessagingFullAccessWarningGlobalPolicy | undefined {
  return value === "always" || value === "dismissable" || value === "never"
    ? value
    : undefined;
}

function readMessagingResponseMode(
  value: TomlScalar | undefined,
): DesktopMessagingResponseMode | undefined {
  return isMessagingResponseMode(value) ? value : undefined;
}

function isMessagingResponseMode(
  value: unknown,
): value is DesktopMessagingResponseMode {
  return value === "every_message" || value === "mention_only";
}

function isFullAccessWarningUserPolicy(
  value: unknown,
): value is DesktopMessagingFullAccessWarningUserPolicy {
  return (
    value === "default" ||
    value === "always" ||
    value === "dismissable" ||
    value === "never"
  );
}

function readLogsViewerConfig(
  table: Record<string, TomlScalar> | undefined,
): Partial<DesktopLogsViewerPreferences> | undefined {
  if (!table) return undefined;
  const logs: Partial<DesktopLogsViewerPreferences> = {};
  const wrap = readBoolean(table.wrap);
  if (wrap !== undefined) logs.wrap = wrap;
  const searchMode = readString(table.search_mode);
  if (isDesktopLogsSearchMode(searchMode)) logs.searchMode = searchMode;
  if (isDesktopLogsContextLines(table.context_lines)) {
    logs.contextLines = table.context_lines;
  }
  const includeDiagnostics = readBoolean(table.include_diagnostics);
  if (includeDiagnostics !== undefined) {
    logs.includeDiagnostics = includeDiagnostics;
  }
  const levels = readStringArray(table.levels);
  if (levels !== undefined) {
    logs.levels = levels.filter(isDesktopLogsStoredLevel);
  }
  return hasDefinedValue(logs) ? logs : undefined;
}

function readBoolean(value: TomlScalar | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readString(value: TomlScalar | undefined): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function readStringArray(value: TomlScalar | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item): item is string => typeof item === "string")) {
    return undefined;
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

export const DEFAULT_GITHUB_ENTERPRISE_HOSTS: DesktopGithubEnterpriseHostsSetting = {
  value: [],
  source: "default",
  revision: "unset",
};

const GITHUB_ENTERPRISE_HOSTS_TABLE = /^(?:git|"git"|'git')\s*\.\s*(?:github_enterprise_hosts|"github_enterprise_hosts"|'github_enterprise_hosts')(?=\s*(?:\.|$))/;
const HOST_TABLE_ERROR = "config.toml declares GitHub Enterprise hosts as a TOML table. Replace that table with a list under [git].";

function readGithubEnterpriseHostsFromTables(tables: TomlTables): DesktopGithubEnterpriseHostsSetting {
  if (Object.keys(tables).some((section) => GITHUB_ENTERPRISE_HOSTS_TABLE.test(section))) {
    return { value: [], source: "config", revision: "conflicting-table", error: HOST_TABLE_ERROR, repairable: false };
  }
  return readGithubEnterpriseHostsSetting(tables.git?.github_enterprise_hosts);
}

function githubEnterpriseSettingsEdits(
  git: NonNullable<DesktopSettingsConfigPatch["git"]>,
  tables: TomlTables,
): TomlEdit[] {
  const edits: TomlEdit[] = [];
  const current = tables.git ?? {};
  if (git.githubEnterpriseHosts !== undefined) {
    const update = git.githubEnterpriseHosts;
    if (!Array.isArray(update?.hosts)) {
      throw new Error("GitHub Enterprise hosts must be a list of hostnames.");
    }
    const raw = current.github_enterprise_hosts;
    const saved = readGithubEnterpriseHostsFromTables(tables);
    if (saved.repairable === false) throw new Error(HOST_TABLE_ERROR);
    if (saved.revision !== update.expectedRevision) {
      throw new Error(GITHUB_ENTERPRISE_HOSTS_CONFLICT);
    }
    const { hosts, error } = validateGithubEnterpriseHosts(update.hosts, URL);
    const before = mergeGithubEnterpriseHosts(saved.value, [], URL);
    const after = mergeGithubEnterpriseHosts(update.hosts, [], URL);
    // Removing one bad row must preserve every other hand-edited entry.
    // Only previously ignored entries can survive a write.
    const retained = before.unused.map(({ entry }) => entry);
    for (const { entry } of after.unused) {
      const index = retained.indexOf(entry);
      if (index < 0) throw new Error(error ?? "Only previously saved unused entries may remain.");
      retained.splice(index, 1);
    }
    if (before.unused.some(({ overflowHost }) => overflowHost
      && after.servers.some((server) => server.host === overflowHost && server.allowed))) {
      throw new Error("Remove the unused hosts before changing the allowed hosts.");
    }
    if (Array.isArray(raw) && raw.some((entry) => typeof entry !== "string")) {
      edits.push({ op: "deleteTableArray", path: ["git", "github_enterprise_hosts"] });
    }
    edits.push({
      op: "set", path: ["git", "github_enterprise_hosts"],
      value: after.unused.length ? update.hosts : hosts,
    });
  }
  if (git.githubEnterpriseAccounts?.length) {
    const pins = new Map(readGithubEnterpriseAccounts(current.github_enterprise_accounts)
      .map((pin) => [pin.host, pin]));
    for (const { host, login } of git.githubEnterpriseAccounts) {
      if (!host || normalizeGithubEnterpriseHost(host) !== host || URL.parse(`https://${host}`)?.host !== host
        || (login !== "" && !isGithubEnterpriseLogin(login))) {
        throw new Error("Choose an account for an exact GitHub Enterprise hostname.");
      }
      if (login) pins.set(host, { host, login });
      else pins.delete(host);
    }
    const path = ["git", "github_enterprise_accounts"];
    edits.push({ op: "delete", path });
    edits.push({ op: "setTableArray", path, value: [...pins.values()], identityKey: "host" });
  }
  return edits;
}

function readGithubEnterpriseAccounts(raw: TomlScalar | undefined): GithubEnterpriseAccountPin[] {
  if (!Array.isArray(raw)) return [];
  const pins = new Map<string, GithubEnterpriseAccountPin>();
  for (const entry of raw) {
    if (typeof entry !== "object") continue;
    const host = normalizeGithubEnterpriseHost(entry.host);
    if (!host) continue;
    // An incomplete pin remains unusable until the operator clears it.
    pins.set(host, { host, login: typeof entry.login === "string" ? entry.login : "" });
  }
  return [...pins.values()];
}

export function readGithubEnterpriseHostsSetting(raw: TomlScalar | undefined): DesktopGithubEnterpriseHostsSetting {
  if (raw === undefined) return DEFAULT_GITHUB_ENTERPRISE_HOSTS;
  const value = readStringArray(raw);
  return {
    value: value ?? [],
    source: "config",
    revision: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
    ...(value === undefined
      ? { error: "GitHub Enterprise hosts must be an array of strings in config.toml. Enter a replacement list or save an empty list to clear it." }
      : {}),
  };
}

function normalizeHelperModelChoice(
  value: {
    backend?: unknown;
    model?: unknown;
    reasoningEffort?: unknown;
  },
): DesktopHelperModelChoice | undefined {
  const trim = (field: unknown) =>
    typeof field === "string" && field.trim() ? field.trim() : undefined;
  const backend = trim(value.backend);
  const model = trim(value.model);
  const reasoningEffort = trim(value.reasoningEffort);
  if (!model && !reasoningEffort) return undefined;
  return {
    ...(backend ? { backend } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/**
 * `[[models.codex.providers]]` holds endpoints and `[[models.codex.provider_rates]]`
 * their per-model prices, because a table-array entry cannot nest tables.
 * Malformed entries fail the read, as config overrides do, so Codex keeps the
 * last-known-good providers instead of losing one.
 */
function readCodexModelProviders(
  value: unknown,
  ratesValue: unknown,
  metadataValue?: unknown,
): CodexModelProviderSettings[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("models.codex.providers must be a table array.");
  }
  const rateRows = Array.isArray(ratesValue) ? ratesValue : [];
  const metadataRows = Array.isArray(metadataValue) ? metadataValue : [];
  return validateCodexModelProviders(value.map((row) => {
    const entry = row && typeof row === "object" ? row as Record<string, unknown> : {};
    const id = typeof entry.id === "string" ? entry.id.trim() : entry.id;
    const modelMetadata = metadataRows.filter((row) => row?.provider === id && row.base_url === entry.base_url);
    const rates = rateRows
      .filter((rate) => rate && typeof rate === "object" && (rate as Record<string, unknown>).provider === id)
      .map((rate) => {
        const fields = rate as Record<string, unknown>;
        return {
          model: fields.model,
          inputPerMillion: fields.input,
          outputPerMillion: fields.output,
          cachedInputPerMillion: fields.cached_input,
        };
      });
    return {
      id,
      name: entry.name,
      baseUrl: entry.base_url,
      ...(entry.models === undefined ? {} : { models: entry.models }),
      ...(entry.discover_models === undefined ? {} : { discoverModels: entry.discover_models }),
      ...(entry.local === undefined ? {} : { local: entry.local }),
      ...(entry.compatibility === undefined ? {} : { compatibility: entry.compatibility }),
      ...(entry.tool_discovery === undefined ? {} : { toolDiscovery: entry.tool_discovery }),
      ...(entry.catalog_path === undefined ? {} : { catalogPath: entry.catalog_path }),
      ...(entry.context_window_cap === undefined ? {} : { contextWindowCap: entry.context_window_cap }),
      ...(modelMetadata.length ? { modelMetadata: modelMetadata.map((row) => ({
        id: row.model,
        ...(row.label === undefined ? {} : { label: row.label }),
        ...(row.context_window === undefined ? {} : { contextWindow: row.context_window }),
        ...(row.supports_image === undefined ? {} : { supportsImage: row.supports_image }),
        ...(row.reasoning_efforts === undefined ? {} : { reasoningEfforts: row.reasoning_efforts }),
        ...(row.default_reasoning_effort === undefined ? {} : { defaultReasoningEffort: row.default_reasoning_effort }),
        ...(row.supports_search_tool === undefined ? {} : { supportsSearchTool: row.supports_search_tool }),
        ...(row.supports_portable_discovery === undefined ? {} : { supportsPortableDiscovery: row.supports_portable_discovery }),
      })) } : {}),
      ...(rates.length ? { rates } : {}),
    };
  }));
}

function appendCodexSettingsEdits(
  codex: NonNullable<DesktopSettingsConfigPatch["models"]>["codex"],
  set: (path: readonly string[], value: string | number | boolean | readonly string[] | undefined) => void,
  edits: TomlEdit[],
): void {
  if (codex?.path !== undefined) {
    set(["models", "codex", "path"], codex.path);
  }
  if (codex?.profile !== undefined) {
    set(["models", "codex", "profile"], codex.profile);
  }
  if (codex?.configOverrides !== undefined) {
    set(
      ["models", "codex", "config_overrides"],
      validateCodexConfigOverrides(codex.configOverrides),
    );
  }
  if (codex?.skillProfiles !== undefined) {
    const profiles = normalizeCodexSkillProfiles(codex.skillProfiles, true);
    const path = ["models", "codex", "skill_profiles"];
    edits.push(profiles.length
      ? {
          op: "setTableArray",
          path,
          value: profiles.map(({ id, name, hiddenSkills }) => ({ id, name, hidden_skills: hiddenSkills })),
        }
      : { op: "deleteTableArray", path });
  }
  if (codex?.localModelIds !== undefined) {
    set(["models", "codex", "local_model_ids"], validateLocalModelIds(codex.localModelIds));
  }
  if (codex?.providers !== undefined) {
    const providers = validateCodexModelProviders(codex.providers);
    edits.push(...codexModelProviderTableEdits(providers));
  }
  if (codex?.allowFast !== undefined) {
    set(["models", "codex", "allow_fast"], codex.allowFast);
  }
  if (codex?.managedBuilds !== undefined) {
    set(["models", "codex", "managed_builds"], codex.managedBuilds);
  }
  if (codex?.managedBuildChannel !== undefined) {
    set(
      ["models", "codex", "managed_build_channel"],
      codex.managedBuildChannel,
    );
  }
}

function normalizeCodexSkillProfiles(value: unknown, strict: boolean): CodexSkillProfile[] {
  const profiles: CodexSkillProfile[] = [];
  const invalid = "Invalid Codex skill profile.";
  if (!Array.isArray(value)) {
    if (strict) throw new Error(invalid);
    return profiles;
  }
  for (const row of value) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    const error = codexSkillProfileNameError(name, profiles, id);
    const hiddenSkills: unknown = row?.hiddenSkills;
    if (!id || profiles.some((profile) => profile.id === id) || error
      || !Array.isArray(hiddenSkills) || hiddenSkills.some((skill) => typeof skill !== "string" || !skill.trim())) {
      if (strict) throw new Error(error ?? invalid);
      continue;
    }
    profiles.push({ id, name, hiddenSkills: [...new Set(hiddenSkills.map((skill: string) => skill.trim()))] });
  }
  return profiles;
}

function readCodexSkillProfiles(value: unknown): CodexSkillProfile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return normalizeCodexSkillProfiles(value.map((row) => ({
    id: row?.id,
    name: row?.name,
    hiddenSkills: row?.hidden_skills ?? [],
  })), false);
}

function codexModelProviderTableEdits(
  providers: readonly CodexModelProviderSettings[],
): TomlEdit[] {
  const providerRows = providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    base_url: provider.baseUrl,
    ...(provider.models?.length ? { models: provider.models } : {}),
    ...(provider.discoverModels === undefined ? {} : { discover_models: provider.discoverModels }),
    ...(provider.local ? { local: true } : {}),
    ...(provider.compatibility ? { compatibility: provider.compatibility } : {}),
    ...(provider.toolDiscovery ? { tool_discovery: provider.toolDiscovery } : {}),
    ...(provider.catalogPath ? { catalog_path: provider.catalogPath } : {}),
    ...(provider.contextWindowCap === undefined ? {} : { context_window_cap: provider.contextWindowCap }),
  }));
  const rateRows = providers.flatMap((provider) => (provider.rates ?? []).map((rate) => ({
    provider: provider.id,
    model: rate.model,
    ...(rate.inputPerMillion === undefined ? {} : { input: rate.inputPerMillion }),
    ...(rate.outputPerMillion === undefined ? {} : { output: rate.outputPerMillion }),
    ...(rate.cachedInputPerMillion === undefined ? {} : { cached_input: rate.cachedInputPerMillion }),
  })));
  const metadataRows = providers.flatMap((provider) => (provider.modelMetadata ?? []).map((model) => ({
    provider: provider.id, base_url: provider.baseUrl, model: model.id,
    ...(model.label === undefined ? {} : { label: model.label }),
    ...(model.contextWindow === undefined ? {} : { context_window: model.contextWindow }),
    ...(model.supportsImage === undefined ? {} : { supports_image: model.supportsImage }),
    ...(model.reasoningEfforts === undefined ? {} : { reasoning_efforts: model.reasoningEfforts }),
    ...(model.defaultReasoningEffort === undefined ? {} : { default_reasoning_effort: model.defaultReasoningEffort }),
    ...(model.supportsSearchTool === undefined ? {} : { supports_search_tool: model.supportsSearchTool }),
    ...(model.supportsPortableDiscovery === undefined ? {} : { supports_portable_discovery: model.supportsPortableDiscovery }),
  })));
  return [
    providerRows.length
      ? { op: "setTableArray", path: ["models", "codex", "providers"], value: providerRows }
      : { op: "deleteTableArray", path: ["models", "codex", "providers"] },
    rateRows.length
      ? { op: "setTableArray", path: ["models", "codex", "provider_rates"], value: rateRows }
      : { op: "deleteTableArray", path: ["models", "codex", "provider_rates"] },
    metadataRows.length
      ? { op: "setTableArray", path: ["models", "codex", "provider_model_metadata"], value: metadataRows }
      : { op: "deleteTableArray", path: ["models", "codex", "provider_model_metadata"] },
  ];
}

function readUsageAccountGroups(value: unknown): Record<string, string> | undefined {
  const entries = Array.isArray(value)
    ? value.map((row) => [readString(row?.backend), readString(row?.group)])
    : value && typeof value === "object"
      ? Object.entries(value)
      : [];
  const groups: Record<string, string> = {};
  for (const [backend, group] of entries) {
    if (typeof backend !== "string" || (backend !== "codex" && !isAcpBackendId(backend))
      || typeof group !== "string" || !group.trim() || group.trim().length > 120) continue;
    groups[backend] = group.trim();
  }
  return Object.keys(groups).length ? groups : undefined;
}

// Additive setting, like account groups. Names are local presentation only:
// keyed by provider and opaque account key, and never sent to peers.
function readUsageAccountNames(value: unknown): Record<string, string> | undefined {
  const entries = Array.isArray(value)
    ? value.map((row) => [readString(row?.account), readString(row?.name)])
    : value && typeof value === "object"
      ? Object.entries(value)
      : [];
  const names: Record<string, string> = {};
  for (const [account, name] of entries) {
    if (typeof account !== "string" || !/^[a-z0-9_-]+:[A-Za-z0-9_-]{1,64}$/.test(account)
      || typeof name !== "string" || !name.trim() || name.trim().length > 60) continue;
    names[account] = name.trim();
  }
  return Object.keys(names).length ? names : undefined;
}

function helperModelSettingsToEdits(
  patch: DesktopHelperModelSettings,
  existingRows: TomlScalar | undefined,
): TomlEdit[] {
  const { defaultModel, defaultReasoningEffort, helpers } = normalizeHelperModelSettings(patch);
  const entries = Object.entries(helpers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([helper, choice]) => ({
      helper,
      ...(choice.backend ? { backend: choice.backend } : {}),
      ...(choice.model ? { model: choice.model } : {}),
      ...(choice.reasoningEffort ? { reasoning_effort: choice.reasoningEffort } : {}),
    }));
  // Keep existing overrides for this retired helper when rewriting the
  // array, so a downgrade can still recover the operator's choice.
  const retiredRows = Array.isArray(existingRows)
    ? existingRows.flatMap((row) => (
      typeof row === "object" && readString(row.helper) === RETIRED_DIFF_CONDENSATION_HELPER_ID
        ? [row]
        : []
    ))
    : [];
  const rows = [...entries, ...retiredRows];
  const defaultModelPath = ["models", "helper_default_model"];
  const defaultEffortPath = ["models", "helper_default_reasoning_effort"];
  const rowsPath = ["models", "helper_models"];
  return [
    defaultModel
      ? { op: "set", path: defaultModelPath, value: defaultModel }
      : { op: "delete", path: defaultModelPath },
    defaultReasoningEffort
      ? { op: "set", path: defaultEffortPath, value: defaultReasoningEffort }
      : { op: "delete", path: defaultEffortPath },
    // An inline array and an array of tables cannot define the same key.
    { op: "delete", path: rowsPath },
    rows.length > 0
      ? { op: "setTableArray", path: rowsPath, value: rows }
      : { op: "deleteTableArray", path: rowsPath },
  ];
}

function normalizeHelperModelSettings(
  value: DesktopHelperModelSettings,
): DesktopHelperModelSettings {
  const defaultModel = value.defaultModel?.trim();
  const defaultReasoningEffort = value.defaultReasoningEffort?.trim();
  const helpers: Record<string, DesktopHelperModelChoice> = {};
  for (const [helper, choice] of Object.entries(value.helpers)) {
    const id = helper.trim();
    if (id === RETIRED_DIFF_CONDENSATION_HELPER_ID) continue;
    const normalized = id ? normalizeHelperModelChoice(choice) : undefined;
    if (normalized) helpers[id] = normalized;
  }
  return {
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    helpers,
  };
}

/**
 * `[models] helper_default_model` and `helper_default_reasoning_effort`, plus
 * `[[models.helper_models]]` rows. New keys with no legacy shape: a malformed
 * row is skipped, never the section.
 */
function readHelperModelSettings(
  defaultModelValue: TomlScalar | undefined,
  defaultReasoningEffortValue: TomlScalar | undefined,
  rowsValue: TomlScalar | undefined,
): DesktopHelperModelSettings | undefined {
  const defaultModel = readString(defaultModelValue);
  const defaultReasoningEffort = readString(defaultReasoningEffortValue);
  const helpers: Record<string, DesktopHelperModelChoice> = {};
  if (Array.isArray(rowsValue)) {
    for (const item of rowsValue) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        continue;
      }
      const helper = typeof item.helper === "string" ? item.helper.trim() : "";
      if (!helper || helper === RETIRED_DIFF_CONDENSATION_HELPER_ID || helpers[helper]) continue;
      const choice = normalizeHelperModelChoice({
        backend: item.backend,
        model: item.model,
        reasoningEffort: item.reasoning_effort,
      });
      if (choice) helpers[helper] = choice;
    }
  }
  if (
    !defaultModel
    && !defaultReasoningEffort
    && Object.keys(helpers).length === 0
  ) {
    return undefined;
  }
  return {
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    helpers,
  };
}

function normalizeTaskMonitorModels(
  value: Record<string, DesktopTaskMonitorModelChoice>,
): Record<string, DesktopTaskMonitorModelChoice> {
  return Object.fromEntries(Object.entries(value).flatMap(([provider, choice]) => {
    const normalizedProvider = provider.trim();
    const normalized = normalizeTaskMonitorModelChoice(choice);
    return normalizedProvider && normalized ? [[normalizedProvider, normalized]] : [];
  }));
}

/**
 * `[[models.task_monitor_models]]` rows. A new key with no legacy shape: a
 * malformed row is skipped, never the section.
 */
function readTaskMonitorModels(
  value: TomlScalar | undefined,
): Record<string, DesktopTaskMonitorModelChoice> | undefined {
  if (!Array.isArray(value)) return undefined;
  const choices: Record<string, DesktopTaskMonitorModelChoice> = {};
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const provider = typeof item.provider === "string" ? item.provider.trim() : "";
    if (!provider || choices[provider]) continue;
    const choice = normalizeTaskMonitorModelChoice({
      source: item.source,
      model: item.model,
      reasoningEffort: item.reasoning_effort,
    });
    if (choice) choices[provider] = choice;
  }
  return Object.keys(choices).length > 0 ? choices : undefined;
}

function normalizeProviderModelDefaults(
  value: Record<string, DesktopProviderModelDefaults>,
): Record<string, DesktopProviderModelDefaults> {
  return normalizeModelProviderDefaults(Object.fromEntries(
    Object.entries(value).flatMap(([provider, defaults]) => {
      const normalizedProvider = provider.trim();
      if (!normalizedProvider) return [];
      const model = defaults.model?.trim() || undefined;
      const reasoningEffortsByModel = Object.fromEntries(
        Object.entries(defaults.reasoningEffortsByModel ?? {}).flatMap(
          ([modelId, effort]) => {
            const normalizedModel = modelId.trim();
            const normalizedEffort = effort.trim();
            return normalizedModel && normalizedEffort
              ? [[normalizedModel, normalizedEffort]]
              : [];
          },
        ),
      );
      const executionMode = readThreadExecutionMode(defaults.executionMode);
      if (
        !model
        && Object.keys(reasoningEffortsByModel).length === 0
        && !executionMode
      ) {
        return [];
      }
      return [[
        normalizedProvider,
        {
          ...(model ? { model } : {}),
          reasoningEffortsByModel,
          ...(executionMode ? { executionMode } : {}),
        },
      ]];
    }),
  ));
}

/** Unknown or misspelled values read as unset, so the built-in default applies. */
function readThreadExecutionMode(
  value: unknown,
): ThreadExecutionMode | undefined {
  return value === "default" || value === "auto" || value === "full-access"
    ? value
    : undefined;
}

function readProviderModelDefaults(
  value: TomlScalar | undefined,
): Record<string, DesktopProviderModelDefaults> | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.some((item) => typeof item !== "object" || item === null || Array.isArray(item) || typeof item.provider !== "string")) return undefined;
  const defaults: Record<string, DesktopProviderModelDefaults> = {};
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const provider =
      typeof item.provider === "string" ? item.provider.trim() : "";
    if (!provider) continue;
    const model = typeof item.model === "string" ? item.model.trim() : "";
    let reasoningEffortsByModel: Record<string, string> = {};
    if (typeof item.reasoning_efforts === "string") {
      try {
        const parsed = JSON.parse(item.reasoning_efforts) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          reasoningEffortsByModel = Object.fromEntries(
            Object.entries(parsed).flatMap(([modelId, effort]) =>
              typeof effort === "string" && modelId.trim() && effort.trim()
                ? [[modelId.trim(), effort.trim()]]
                : [],
            ),
          );
        }
      } catch {
        reasoningEffortsByModel = {};
      }
    }
    const executionMode = readThreadExecutionMode(item.execution_mode);
    if (
      model
      || Object.keys(reasoningEffortsByModel).length > 0
      || executionMode
    ) {
      defaults[provider] = {
        ...(model ? { model } : {}),
        reasoningEffortsByModel,
        ...(executionMode ? { executionMode } : {}),
      };
    }
  }
  return normalizeModelProviderDefaults(defaults);
}

function normalizeProviderThreadModelMigrations(
  value: Record<string, DesktopProviderThreadModelMigration>,
): Record<string, DesktopProviderThreadModelMigration> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([provider, migration]) => {
      const normalizedProvider = provider.trim();
      const revision = migration.revision.trim();
      const model = migration.model.trim();
      const reasoningEffort = migration.reasoningEffort?.trim() || undefined;
      const sourceModels = migration.sourceModels
        ?.map((sourceModel) => sourceModel.trim())
        .filter(Boolean);
      if (
        !normalizedProvider
        || !revision
        || !model
        || !Number.isFinite(migration.createdAt)
      ) {
        return [];
      }
      return [[
        normalizedProvider === "codex" ? providerPickerValue("codex", model) : normalizedProvider,
        {
          revision,
          model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(sourceModels ? { sourceModels: [...new Set(sourceModels)] } : {}),
          ...(migration.includeThreadsWithoutModel
            ? { includeThreadsWithoutModel: true }
            : {}),
          createdAt: migration.createdAt,
        },
      ]];
    }),
  );
}

function readProviderThreadModelMigrations(
  value: TomlScalar | undefined,
): Record<string, DesktopProviderThreadModelMigration> | undefined {
  if (!Array.isArray(value)) return undefined;
  const migrations: Record<string, DesktopProviderThreadModelMigration> = {};
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const provider =
      typeof item.provider === "string" ? item.provider.trim() : "";
    const revision =
      typeof item.revision === "string" ? item.revision.trim() : "";
    const model = typeof item.model === "string" ? item.model.trim() : "";
    const reasoningEffort =
      typeof item.reasoning_effort === "string"
        ? item.reasoning_effort.trim()
        : "";
    const sourceModels = readStringArray(item.source_models)
      ?.map((sourceModel) => sourceModel.trim())
      .filter(Boolean);
    const includeThreadsWithoutModel =
      item.include_threads_without_model === true;
    const createdAt =
      typeof item.created_at === "number" && Number.isFinite(item.created_at)
        ? item.created_at
        : undefined;
    if (!provider || !revision || !model || createdAt === undefined) {
      continue;
    }
    migrations[provider === "codex" ? providerPickerValue("codex", model) : provider] = {
      revision,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(sourceModels ? { sourceModels: [...new Set(sourceModels)] } : {}),
      ...(includeThreadsWithoutModel
        ? { includeThreadsWithoutModel: true }
        : {}),
      createdAt,
    };
  }
  return migrations;
}

function readAuthorizedContacts(
  ...values: Array<TomlScalar | undefined>
): DesktopAuthorizedContact[] | undefined {
  for (const value of values) {
    const contacts = readAuthorizedContactArray(value);
    if (contacts !== undefined) {
      return contacts;
    }
  }
  for (const value of values) {
    const legacy = readStringArray(value);
    if (legacy !== undefined) {
      return legacy.map((id) => ({ id, displayName: "" }));
    }
  }
  return undefined;
}

function readAuthorizedContactArray(
  value: TomlScalar | undefined,
): DesktopAuthorizedContact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return [];
  if (
    !value.every(
      (item): item is Record<string, string | number | boolean> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    )
  ) {
    return undefined;
  }
  return normalizeAuthorizedContacts(
    value.map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : "",
      displayName:
        typeof entry.display_name === "string"
          ? entry.display_name
          : typeof entry.displayName === "string"
            ? entry.displayName
            : "",
      username:
        typeof entry.username === "string"
          ? entry.username
          : typeof entry.handle === "string"
            ? entry.handle
            : undefined,
      fullAccessWarningOverride: isFullAccessWarningUserPolicy(
        entry.full_access_warning,
      )
        ? entry.full_access_warning
        : isFullAccessWarningUserPolicy(entry.fullAccessWarningOverride)
          ? entry.fullAccessWarningOverride
          : undefined,
      fullAccessWarningDismissed:
        entry.full_access_warning_dismissed === true ||
        entry.fullAccessWarningDismissed === true,
      responseMode: isMessagingResponseMode(entry.response_mode)
        ? entry.response_mode
        : isMessagingResponseMode(entry.responseMode)
          ? entry.responseMode
          : undefined,
    })),
  );
}

function normalizeAuthorizedContacts(
  contacts: readonly DesktopAuthorizedContact[],
): DesktopAuthorizedContact[] {
  return contacts
    .map((contact) => {
      const username = sanitizeMessagingContactHandle(contact.username);
      return {
        id: contact.id.trim(),
        displayName: sanitizeMessagingContactLabel(contact.displayName),
        ...(username ? { username } : {}),
        ...(isFullAccessWarningUserPolicy(contact.fullAccessWarningOverride) &&
        contact.fullAccessWarningOverride !== "default"
          ? { fullAccessWarningOverride: contact.fullAccessWarningOverride }
          : {}),
        ...(contact.fullAccessWarningDismissed === true
          ? { fullAccessWarningDismissed: true }
          : {}),
        ...(isMessagingResponseMode(contact.responseMode)
          ? { responseMode: contact.responseMode }
          : {}),
      };
    })
    .filter((contact) => contact.id.length > 0);
}

function legacyAuthorizedContactComment(key: string): string {
  return [
    "#",
    LEGACY_SETTINGS_MARKER,
    `key=${key}`,
    "shape=string-array",
    `used_through=${LEGACY_AUTHORIZED_CONTACT_LAST_VERSION}`,
    "kept_for_older_clients",
  ].join(" ");
}

function legacyChatReplyComposerComment(): string {
  return [
    "#",
    LEGACY_SETTINGS_MARKER,
    "key=chat_reply_composer",
    "shape=string-enum",
    `used_through=${LEGACY_CHAT_REPLY_COMPOSER_LAST_VERSION}`,
    "kept_for_older_clients",
    "obsolete_no_replacement",
    "ignored_by_current_clients",
    "remove_when_convenient",
  ].join(" ");
}

function legacyBackgroundPrPollingComment(): string {
  return [
    "#",
    LEGACY_SETTINGS_MARKER,
    "key=background_pr_polling",
    "shape=boolean",
    `used_through=${LEGACY_BACKGROUND_PR_POLLING_LAST_VERSION}`,
    "kept_for_older_clients",
  ].join(" ");
}

function legacyAutomaticArchiveComment(): string {
  return [
    "#",
    LEGACY_SETTINGS_MARKER,
    "key=enabled",
    "shape=boolean",
    `used_through=${LEGACY_AUTOMATIC_ARCHIVE_LAST_VERSION}`,
    "kept_for_older_clients",
  ].join(" ");
}

function legacyExperimentalMarkdownComment(key: string): string {
  return [
    "#",
    LEGACY_SETTINGS_MARKER,
    `key=${key}`,
    "shape=boolean",
    `used_through=${LEGACY_EXPERIMENTAL_MARKDOWN_LAST_VERSION}`,
    "kept_for_older_clients",
  ].join(" ");
}

function legacyTokenMiserGeneralComment(): string {
  return [
    "#",
    LEGACY_SETTINGS_MARKER,
    "key=token_miser_enabled",
    "shape=boolean",
    `used_through=${LEGACY_TOKEN_MISER_GENERAL_LAST_VERSION}`,
    "kept_for_older_clients",
  ].join(" ");
}

function readNumber(value: TomlScalar | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPositiveNumber(value: TomlScalar | undefined): number | undefined {
  const number = readNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

/** A remembered pane width: a positive whole number of px, or nothing. */
function readPositiveWidth(value: TomlScalar | undefined): number | undefined {
  const width = readNumber(value);
  return width !== undefined && width > 0 ? Math.round(width) : undefined;
}

function readImageProfile(
  value: TomlScalar | undefined,
): DesktopMessagingImageProfile | undefined {
  return typeof value === "string" && isDesktopMessagingImageProfile(value)
    ? value
    : undefined;
}

function isDesktopMessagingImageProfile(
  value: string,
): value is DesktopMessagingImageProfile {
  return value === "low" || value === "medium" || value === "high" || value === "actual";
}

/** Only an absolute folder; a relative one would follow the process cwd. */
function readWorktreeBaseDirectory(value: TomlScalar | undefined): string | undefined {
  const directory = typeof value === "string" ? value.trim() : "";
  return directory && path.isAbsolute(directory) ? directory : undefined;
}

function readWorktreeStorage(
  value: TomlScalar | undefined,
): DesktopWorktreeStorageLocation | undefined {
  return typeof value === "string" && isDesktopWorktreeStorageLocation(value)
    ? value
    : undefined;
}

/**
 * Trimmed dashboard ids and `enabled: false`, or undefined when nothing is
 * left. On is the default, so it is never written.
 */
function normalizeOpenAIDecisionsSettings(
  value: DesktopOpenAIDecisionsSettings | undefined,
): DesktopOpenAIDecisionsSettings | undefined {
  const organizationId = normalizeOpenAIDecisionsAccountId(value?.organizationId);
  const projectId = normalizeOpenAIDecisionsAccountId(value?.projectId);
  const off = value?.enabled === false;
  return organizationId || projectId || off
    ? {
        ...(off ? { enabled: false } : {}),
        ...(organizationId ? { organizationId } : {}),
        ...(projectId ? { projectId } : {}),
      }
    : undefined;
}
