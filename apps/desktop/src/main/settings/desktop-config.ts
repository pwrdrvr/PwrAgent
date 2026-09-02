import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DesktopAppearanceDensity,
  DesktopAppearanceTheme,
  DesktopChatReplyComposer,
  DesktopAuthorizedContact,
  DesktopCodexProfileModel,
  DesktopFederationMode,
  DesktopHotCpuProfileStartDelayMs,
  DesktopHotCpuProfileTriggerMode,
  DesktopIntegratedTerminalWindowsShell,
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
  DesktopSpendAlertPolicy,
  DesktopTextSize,
  DesktopToolOutputAlertPolicy,
  DesktopUpdateChannel,
  DesktopUpdateTrain,
  DesktopWorktreeStorageLocation,
  MessagingToolUpdateMode,
} from "@pwragent/shared";
import {
  DESKTOP_APPEARANCE_DENSITY_DEFAULT,
  DESKTOP_APPEARANCE_THEME_DEFAULT,
  DESKTOP_TEXT_SIZE_DEFAULT,
  DESKTOP_CODEX_PROFILE_MODEL_DEFAULT,
  DESKTOP_FEDERATION_MODE_DEFAULT,
  DESKTOP_INTEGRATED_TERMINAL_WINDOWS_SHELL_DEFAULT,
  isDesktopAppearanceDensity,
  isDesktopAppearanceTheme,
  isDesktopTextSize,
  isDesktopCodexProfileModel,
  isDesktopFederationMode,
  isFederationGatewayEndpointUrl,
  isDesktopHotCpuProfileStartDelayMs,
  isDesktopHotCpuProfileTriggerMode,
  isDesktopIntegratedTerminalWindowsShell,
  isDesktopOnboardingCompletedSource,
  isDesktopWorktreeStorageLocation,
  isDesktopUpdateChannel,
  isDesktopUpdateTrain,
  MANAGED_GROK_BUILD_CHANNEL_DEFAULT,
  sanitizeMessagingContactHandle,
  sanitizeMessagingContactLabel,
} from "@pwragent/shared";
import { DEFAULT_PASTED_IMAGE_MAX_PATCHES } from "../../shared/image-normalization";
import { resolveActiveProfilePath } from "../profile";
import {
  ACP_AGENTS_GEMINI_CLI_PATH_ENV,
  ACP_AGENTS_GROK_CLI_PATH_ENV,
  ACP_AGENTS_KIMI_CLI_PATH_ENV,
  ACP_AGENTS_QWEN_CLI_PATH_ENV,
} from "./desktop-settings-env";
import {
  applyTomlEdits,
  parseTomlTables,
  type TomlEdit,
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
    /** Legacy location used by Token Miser development builds. */
    tokenMiserEnabled?: boolean;
    toolOutputAlerts?: Partial<DesktopToolOutputAlertPolicy>;
    spendAlerts?: Partial<DesktopSpendAlertPolicy>;
    appearance?: {
      theme?: DesktopAppearanceTheme;
      density?: DesktopAppearanceDensity;
      sidebarTextSize?: DesktopTextSize;
      transcriptTextSize?: DesktopTextSize;
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
      authorizedUserIds?: AuthorizedContactConfig[];
      authorizedSupergroups?: AuthorizedContactConfig[];
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
  };
  worktrees?: {
    storage?: DesktopWorktreeStorageLocation;
  };
};

type TomlScalar = TomlValue;

const LEGACY_AUTHORIZED_CONTACT_LAST_VERSION = "1.0.0-alpha.9";
const LEGACY_SETTINGS_MARKER = "pwragent-legacy-settings";
const LEGACY_CHAT_REPLY_COMPOSER_LAST_VERSION = "1.0.0-alpha.8";
const LEGACY_BACKGROUND_PR_POLLING_LAST_VERSION = "1.0.0-beta.50";
const LEGACY_FEDERATION_GATEWAY_URL_LAST_VERSION = "1.0.0-beta.50";
const LEGACY_TOKEN_MISER_GENERAL_LAST_VERSION = "1.1.0-alpha.1";

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
 * Which grok-build track the managed runtime follows. Latest is the default:
 * an operator who never opens the control must not be handed a build that was
 * published for testing.
 */
export function managedGrokBuildChannelFor(
  config: DesktopSettingsConfig,
): DesktopUpdateChannel {
  return (
    config.acpAgents?.grok?.managedBuildChannel
    ?? MANAGED_GROK_BUILD_CHANNEL_DEFAULT
  );
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
): DesktopSettingsPatchWriteResult {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const source = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf8")
    : "";
  const edits = desktopSettingsPatchToEdits(
    patch,
    parseTomlTables(source, configPath),
  );
  if (edits.length === 0) {
    return { changed: false, text: source };
  }
  const next = applyTomlEdits(source, edits);
  if (next === source) {
    return { changed: false, text: source };
  }
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, next, "utf8");
  fs.renameSync(temporaryPath, configPath);
  return { changed: true, text: next };
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
  if (patch.general?.hotCpuProfilingTriggerMode !== undefined) {
    set(
      ["general", "hot_cpu_profiling_trigger_mode"],
      patch.general.hotCpuProfilingTriggerMode,
    );
  }
  if (patch.general?.hotCpuProfilingSlowburnThresholdPercent !== undefined) {
    set(
      ["general", "hot_cpu_profiling_slowburn_threshold_percent"],
      patch.general.hotCpuProfilingSlowburnThresholdPercent,
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

  if (patch.experimental?.diffCondensation?.enabled !== undefined) {
    set(
      ["experimental", "diff_condensation", "enabled"],
      patch.experimental.diffCondensation.enabled,
    );
  }
  if (patch.experimental?.fullAccessRiskWarningDismissed !== undefined) {
    set(
      ["experimental", "full_access_risk_warning_dismissed"],
      patch.experimental.fullAccessRiskWarningDismissed,
    );
  }
  if (patch.experimental?.liveTranscriptEventFiltering !== undefined) {
    set(
      ["experimental", "live_transcript_event_filtering"],
      patch.experimental.liveTranscriptEventFiltering,
    );
  }
  if (patch.experimental?.lightweightNavigationRefresh !== undefined) {
    set(
      ["experimental", "lightweight_navigation_refresh"],
      patch.experimental.lightweightNavigationRefresh,
    );
  }
  if (patch.experimental?.markdownMathRendering !== undefined) {
    set(
      ["experimental", "markdown_math_rendering"],
      patch.experimental.markdownMathRendering,
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
  if (patch.experimental?.tokenMiserDefaultEnabled !== undefined) {
    set(
      ["experimental", "token_miser_default_enabled"],
      patch.experimental.tokenMiserDefaultEnabled,
    );
  }
  if (patch.experimental?.threadToolAccounting !== undefined) {
    set(
      ["experimental", "thread_tool_accounting"],
      patch.experimental.threadToolAccounting,
    );
  }
  if (patch.experimental?.codexDefaultModeRequestUserInput !== undefined) {
    set(
      ["experimental", "codex_default_mode_request_user_input"],
      patch.experimental.codexDefaultModeRequestUserInput,
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

  if (patch.onboarding?.completed !== undefined) {
    // `false` is the default for fresh profiles; only persist when the
    // operator has actively cleared the first-run prompt.
    if (patch.onboarding.completed === false) {
      edits.push({ op: "delete", path: ["onboarding", "completed"] });
    } else {
      set(["onboarding", "completed"], patch.onboarding.completed);
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

  if (patch.federation?.mode !== undefined) {
    if (patch.federation.mode === DESKTOP_FEDERATION_MODE_DEFAULT) {
      edits.push({ op: "delete", path: ["federation", "mode"] });
    } else {
      set(["federation", "mode"], patch.federation.mode);
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

  if (patch.models?.codex?.path !== undefined) {
    set(["models", "codex", "path"], patch.models.codex.path);
  }
  if (patch.models?.codex?.profile !== undefined) {
    set(["models", "codex", "profile"], patch.models.codex.profile);
  }
  if (patch.models?.codex?.allowFast !== undefined) {
    set(["models", "codex", "allow_fast"], patch.models.codex.allowFast);
  }
  if (patch.models?.providerDefaults !== undefined) {
    const providerDefaults = normalizeProviderModelDefaults(
      patch.models.providerDefaults,
    );
    const entries = Object.entries(providerDefaults)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, defaults]) => ({
        provider,
        ...(defaults.model ? { model: defaults.model } : {}),
        reasoning_efforts: JSON.stringify(defaults.reasoningEffortsByModel),
      }));
    if (entries.length > 0) {
      edits.push({
        op: "setTableArray",
        path: ["models", "provider_defaults"],
        value: entries,
      });
    } else {
      edits.push({
        op: "deleteTableArray",
        path: ["models", "provider_defaults"],
      });
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
  if (patch.acpAgents?.gemini?.cliPath !== undefined) {
    set(["acp_agents", "gemini", "cli_path"], patch.acpAgents.gemini.cliPath);
  }
  if (patch.acpAgents?.gemini?.enabled !== undefined) {
    set(["acp_agents", "gemini", "enabled"], patch.acpAgents.gemini.enabled);
  }
  if (patch.acpAgents?.grok?.cliPath !== undefined) {
    set(["acp_agents", "grok", "cli_path"], patch.acpAgents.grok.cliPath);
  }
  if (patch.acpAgents?.grok?.enabled !== undefined) {
    set(["acp_agents", "grok", "enabled"], patch.acpAgents.grok.enabled);
  }
  if (patch.acpAgents?.grok?.managedBuilds !== undefined) {
    set(
      ["acp_agents", "grok", "managed_builds"],
      patch.acpAgents.grok.managedBuilds,
    );
  }
  if (patch.acpAgents?.grok?.managedBuildChannel !== undefined) {
    set(
      ["acp_agents", "grok", "managed_build_channel"],
      patch.acpAgents.grok.managedBuildChannel,
    );
  }
  if (patch.acpAgents?.kimi?.cliPath !== undefined) {
    set(["acp_agents", "kimi", "cli_path"], patch.acpAgents.kimi.cliPath);
  }
  if (patch.acpAgents?.kimi?.enabled !== undefined) {
    set(["acp_agents", "kimi", "enabled"], patch.acpAgents.kimi.enabled);
  }
  if (patch.acpAgents?.qwen?.cliPath !== undefined) {
    set(["acp_agents", "qwen", "cli_path"], patch.acpAgents.qwen.cliPath);
  }
  if (patch.acpAgents?.qwen?.enabled !== undefined) {
    set(["acp_agents", "qwen", "enabled"], patch.acpAgents.qwen.enabled);
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

  if (patch.applications?.editor?.preferredId !== undefined) {
    set(["applications", "editor", "preferred_id"], patch.applications.editor.preferredId);
  }
  if (patch.applications?.terminal?.preferredId !== undefined) {
    set(["applications", "terminal", "preferred_id"], patch.applications.terminal.preferredId);
  }
  if (patch.applications?.gh?.path !== undefined) {
    set(["applications", "gh", "path"], patch.applications.gh.path);
  }

  if (patch.worktrees?.storage !== undefined) {
    set(["worktrees", "storage"], patch.worktrees.storage);
  }

  return edits;
}

export function parseDesktopSettingsToml(
  contents: string,
  filePath: string,
): DesktopSettingsConfig {
  return normalizeDesktopConfig(parseTomlTables(contents, filePath));
}

function normalizeDesktopConfig(
  tables: Record<string, Record<string, TomlScalar>>,
): DesktopSettingsConfig {
  const general = tables["general"];
  const generalAppearance = tables["general.appearance"];
  const generalToolOutputAlerts = tables["general.tool_output_alerts"];
  const generalSpendAlerts = tables["general.spend_alerts"];
  const generalMessagingAck = tables["general.messaging_acknowledgment"];
  const onboarding = tables["onboarding"];
  const experimental = tables["experimental"];
  const diffCondensation = tables["experimental.diff_condensation"];
  const imageUploads = tables["image_uploads"];
  const updates = tables["updates"];
  const integratedTerminal = tables["integrated_terminal"];
  const ui = tables["ui"];
  const federation = tables["federation"];
  const messaging = tables["messaging"];
  const attachments = tables["messaging.attachments"];
  const telegram = tables["messaging.telegram"];
  const discord = tables["messaging.discord"];
  const mattermost = tables["messaging.mattermost"];
  const slack = tables["messaging.slack"];
  const feishu = tables["messaging.feishu"];
  const line = tables["messaging.line"];
  const models = tables["models"];
  const codex = tables["models.codex"];
  const acpAgentsGemini = tables["acp_agents.gemini"];
  const acpAgentsGrok = tables["acp_agents.grok"];
  const acpAgentsKimi = tables["acp_agents.kimi"];
  const acpAgentsQwen = tables["acp_agents.qwen"];
  const git = tables["git"];
  const editor = tables["applications.editor"];
  const terminal = tables["applications.terminal"];
  const gh = tables["applications.gh"];
  const worktrees = tables["worktrees"];

  return pruneEmptyConfig({
    general: {
      confirmQuitWithInProgressThreads: readBoolean(
        general?.confirm_quit_with_in_progress_threads,
      ),
      attentionPromoteOnTurnEnd: readBoolean(
        general?.attention_promote_on_turn_end,
      ),
      pdfAnalysisEnabled: readBoolean(general?.pdf_analysis_enabled),
      developerMode: readBoolean(general?.developer_mode),
      hotCpuProfilingEnabled: readBoolean(general?.hot_cpu_profiling_enabled),
      hotCpuProfilingStartDelayMs: readHotCpuProfileStartDelayMs(
        general?.hot_cpu_profiling_start_delay_ms,
      ),
      hotCpuProfilingTriggerMode: readHotCpuProfileTriggerMode(
        general?.hot_cpu_profiling_trigger_mode,
      ),
      hotCpuProfilingSlowburnThresholdPercent: readNumber(
        general?.hot_cpu_profiling_slowburn_threshold_percent,
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
      appearance: {
        theme: readAppearanceTheme(generalAppearance?.theme),
        density: readAppearanceDensity(generalAppearance?.density),
        sidebarTextSize: readTextSize(
          generalAppearance?.sidebar_text_size,
        ),
        transcriptTextSize: readTextSize(
          generalAppearance?.transcript_text_size,
        ),
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
      liveTranscriptEventFiltering: readBoolean(
        experimental?.live_transcript_event_filtering,
      ),
      lightweightNavigationRefresh: readBoolean(
        experimental?.lightweight_navigation_refresh,
      ),
      markdownMathRendering: readBoolean(
        experimental?.markdown_math_rendering,
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
      tokenMiserDefaultEnabled:
        readBoolean(experimental?.token_miser_default_enabled),
      threadToolAccounting: readBoolean(experimental?.thread_tool_accounting),
      codexDefaultModeRequestUserInput: readBoolean(
        experimental?.codex_default_mode_request_user_input,
      ),
      managedReview: readBoolean(experimental?.managed_review),
      diffCondensation: {
        enabled: readBoolean(diffCondensation?.enabled),
      },
    },
    imageUploads: {
      pastedImageMaxPatches: readNumber(
        imageUploads?.pasted_image_max_patches,
      ),
    },
    updates: {
      channel: readUpdateChannel(updates?.channel),
      train: readUpdateTrain(updates?.train),
    },
    integratedTerminal: {
      windowsShell: readIntegratedTerminalWindowsShell(
        integratedTerminal?.windows_shell,
      ),
    },
    ui: {
      sidebarHidden: readBoolean(ui?.sidebar_hidden),
      contextRailPinned: readBoolean(ui?.context_rail_pinned),
      activeContextTab: readString(ui?.active_context_tab),
      editedFilesDock: readString(ui?.edited_files_dock),
      actionRunsDock: readString(ui?.action_runs_dock),
    },
    federation: {
      mode: readFederationMode(federation?.mode),
      instanceLabel: readString(federation?.instance_label),
      instanceNotes: readString(federation?.instance_notes),
      listenHost: readString(federation?.listen_host),
      listenPort: readNumber(federation?.listen_port),
      publicUrl: readString(federation?.public_url),
      gatewayUrl: readString(federation?.gateway_url),
      gatewayEndpoints: readEndpointList(federation?.gateway_endpoints),
      advertisedEndpoints: readEndpointList(federation?.advertised_endpoints),
      cloudflareEndpoint: readString(federation?.cloudflare_endpoint),
      cloudflareMtlsEnabled: readBoolean(
        federation?.cloudflare_mtls_enabled,
      ),
      cloudflareAccessServiceAuthEnabled: readBoolean(
        federation?.cloudflare_access_service_auth_enabled,
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
      providerDefaults: readProviderModelDefaults(models?.provider_defaults),
      providerThreadMigrations: readProviderThreadModelMigrations(
        models?.provider_thread_migrations,
      ),
      codex: {
        path: readString(codex?.path),
        profile: readString(codex?.profile),
        allowFast: readBoolean(codex?.allow_fast),
      },
    },
    acpAgents: {
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
      prAutoDispatchBudgetCapacity: readNumber(
        git?.pr_auto_dispatch_budget_capacity,
      ),
      prAutoDispatchBudgetRefillPerMinute: readNumber(
        git?.pr_auto_dispatch_budget_refill_per_minute,
      ),
      pausePrAutoDispatchWhenBudgetEmpty: readBoolean(
        git?.pause_pr_auto_dispatch_when_budget_empty,
      ),
    },
    applications: {
      editor: {
        preferredId: readString(editor?.preferred_id),
      },
      terminal: {
        preferredId: readString(terminal?.preferred_id),
      },
      gh: {
        path: readString(gh?.path),
      },
    },
    worktrees: {
      storage: readWorktreeStorage(worktrees?.storage),
    },
  });
}

function pruneEmptyConfig(config: DesktopSettingsConfig): DesktopSettingsConfig {
  const pruned: DesktopSettingsConfig = {};

  const developerMode = config.general?.developerMode;
  const hotCpuProfilingEnabled = config.general?.hotCpuProfilingEnabled;
  const hotCpuProfilingStartDelayMs =
    config.general?.hotCpuProfilingStartDelayMs;
  const hotCpuProfilingTriggerMode =
    config.general?.hotCpuProfilingTriggerMode;
  const hotCpuProfilingSlowburnThresholdPercent =
    config.general?.hotCpuProfilingSlowburnThresholdPercent;
  const hotCpuProfilingCaptureHeapSnapshot =
    config.general?.hotCpuProfilingCaptureHeapSnapshot;
  const hotCpuProfilingHeapSnapshotLimit =
    config.general?.hotCpuProfilingHeapSnapshotLimit;
  const confirmQuitWithInProgressThreads =
    config.general?.confirmQuitWithInProgressThreads;
  const attentionPromoteOnTurnEnd = config.general?.attentionPromoteOnTurnEnd;
  const pdfAnalysisEnabled = config.general?.pdfAnalysisEnabled;
  const notificationsEnabled = config.general?.notificationsEnabled;
  const toolOutputAlerts = config.general?.toolOutputAlerts;
  const toolOutputAlertsDefined =
    toolOutputAlerts && hasDefinedValue(toolOutputAlerts);
  const spendAlerts = config.general?.spendAlerts;
  const spendAlertsDefined = spendAlerts && hasDefinedValue(spendAlerts);
  const appearance = config.general?.appearance;
  const appearanceDefined = appearance && hasDefinedValue(appearance);
  const codexProfileModel = config.general?.codexProfileModel;
  const messagingAcknowledgment = config.general?.messagingAcknowledgment;
  if (
    developerMode !== undefined ||
    hotCpuProfilingEnabled !== undefined ||
    hotCpuProfilingStartDelayMs !== undefined ||
    hotCpuProfilingTriggerMode !== undefined ||
    hotCpuProfilingSlowburnThresholdPercent !== undefined ||
    hotCpuProfilingCaptureHeapSnapshot !== undefined ||
    hotCpuProfilingHeapSnapshotLimit !== undefined ||
    confirmQuitWithInProgressThreads !== undefined ||
    attentionPromoteOnTurnEnd !== undefined ||
    pdfAnalysisEnabled !== undefined ||
    notificationsEnabled !== undefined ||
    toolOutputAlertsDefined ||
    spendAlertsDefined ||
    appearanceDefined ||
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
    if (hotCpuProfilingTriggerMode !== undefined) {
      pruned.general.hotCpuProfilingTriggerMode = hotCpuProfilingTriggerMode;
    }
    if (hotCpuProfilingSlowburnThresholdPercent !== undefined) {
      pruned.general.hotCpuProfilingSlowburnThresholdPercent =
        hotCpuProfilingSlowburnThresholdPercent;
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
    if (appearanceDefined) {
      pruned.general.appearance = appearance;
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
  if (
    (codex && hasDefinedValue(codex))
    || (providerDefaults && Object.keys(providerDefaults).length > 0)
    || (
      providerThreadMigrations
      && Object.keys(providerThreadMigrations).length > 0
    )
  ) {
    pruned.models = {
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

  const acpAgentsGemini = config.acpAgents?.gemini;
  const acpAgentsGrok = config.acpAgents?.grok;
  const acpAgentsKimi = config.acpAgents?.kimi;
  const acpAgentsQwen = config.acpAgents?.qwen;
  if (
    (acpAgentsGemini && hasDefinedValue(acpAgentsGemini)) ||
    (acpAgentsGrok && hasDefinedValue(acpAgentsGrok)) ||
    (acpAgentsKimi && hasDefinedValue(acpAgentsKimi)) ||
    (acpAgentsQwen && hasDefinedValue(acpAgentsQwen))
  ) {
    pruned.acpAgents = {
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
  if (
    (editor && hasDefinedValue(editor))
    || (terminal && hasDefinedValue(terminal))
    || (gh && hasDefinedValue(gh))
  ) {
    pruned.applications = {};
    if (editor && hasDefinedValue(editor)) {
      pruned.applications.editor = editor;
    }
    if (terminal && hasDefinedValue(terminal)) {
      pruned.applications.terminal = terminal;
    }
    if (gh && hasDefinedValue(gh)) {
      pruned.applications.gh = gh;
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
  return typeof value === "string" && isDesktopUpdateChannel(value)
    ? value
    : undefined;
}

function readUpdateTrain(
  value: TomlScalar | undefined,
): DesktopUpdateTrain | undefined {
  return typeof value === "string" && isDesktopUpdateTrain(value)
    ? value
    : undefined;
}

function readAppearanceTheme(
  value: TomlScalar | undefined,
): DesktopAppearanceTheme | undefined {
  return typeof value === "string" && isDesktopAppearanceTheme(value)
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

function normalizeProviderModelDefaults(
  value: Record<string, DesktopProviderModelDefaults>,
): Record<string, DesktopProviderModelDefaults> {
  return Object.fromEntries(
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
      if (!model && Object.keys(reasoningEffortsByModel).length === 0) {
        return [];
      }
      return [[
        normalizedProvider,
        {
          ...(model ? { model } : {}),
          reasoningEffortsByModel,
        },
      ]];
    }),
  );
}

function readProviderModelDefaults(
  value: TomlScalar | undefined,
): Record<string, DesktopProviderModelDefaults> | undefined {
  if (!Array.isArray(value)) return undefined;
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
    if (model || Object.keys(reasoningEffortsByModel).length > 0) {
      defaults[provider] = {
        ...(model ? { model } : {}),
        reasoningEffortsByModel,
      };
    }
  }
  return defaults;
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
        normalizedProvider,
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
    migrations[provider] = {
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

function readWorktreeStorage(
  value: TomlScalar | undefined,
): DesktopWorktreeStorageLocation | undefined {
  return typeof value === "string" && isDesktopWorktreeStorageLocation(value)
    ? value
    : undefined;
}
