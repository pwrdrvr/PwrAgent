import type { AppServerBackendKind, ThreadExecutionMode } from "./normalized-app-server";
import type { FederationTarget } from "./federation";

export type BackendSourceKind = "builtin" | "acp";

export type BackendAcpDistributionKind = "npx" | "uvx" | "binary" | "local";
export type BackendAcpInstallStatus =
  | "not-installed"
  | "installed"
  | "installing"
  | "install-failed"
  | "unavailable";
export type BackendAcpAuthStatus =
  | "not-required"
  | "required"
  | "in-progress"
  | "authenticated"
  | "failed";
export type BackendAcpVerificationStatus =
  | "verified"
  | "unverified-allowed"
  | "unverified-blocked"
  | "not-applicable";

export type BackendAcpRuntimeDiscoveryStatus =
  | "never-discovered"
  | "discovered"
  | "stale"
  | "failed";

export type BackendAcpRuntimeOptionSource = "configOption" | "mode" | "model";

export type BackendAcpRuntimeConfigOptionValue = {
  value: string;
  label?: string;
  description?: string;
};

export type BackendAcpRuntimeConfigOption = {
  id: string;
  label: string;
  description?: string;
  type: "select";
  category?: "mode" | "model" | "thought_level" | string;
  currentValue?: string;
  values: BackendAcpRuntimeConfigOptionValue[];
};

export type BackendAcpRuntimeMode = {
  id: string;
  label: string;
  description?: string;
};

export type BackendAcpRuntimeModeState = {
  currentModeId?: string;
  availableModes: BackendAcpRuntimeMode[];
};

export type BackendAcpRuntimeModel = {
  id: string;
  label?: string;
  description?: string;
  current?: boolean;
  defaultReasoningEffort?: string;
  reasoningEfforts?: string[];
  supportsReasoning?: boolean;
};

export type BackendAcpRuntimeModelState = {
  currentModelId?: string;
  availableModels: BackendAcpRuntimeModel[];
};

export type BackendAcpRuntimeAgentCapabilities = {
  loadSession?: boolean;
  sessionHistoryReplay?: boolean;
  session?: {
    close?: boolean;
    cancel?: boolean;
  };
  prompt?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  mcp?: {
    http?: boolean;
    sse?: boolean;
  };
  raw?: unknown;
};

export type BackendAcpRuntimeCapabilities = {
  schemaVersion: 1;
  status: BackendAcpRuntimeDiscoveryStatus;
  discoveredAt?: number;
  checkedAt?: number;
  source?: "initialize" | "session-new" | "session-load" | "local-probe";
  protocolVersion?: number;
  agentInfo?: {
    name?: string;
    title?: string;
    version?: string;
  };
  agentCapabilities?: BackendAcpRuntimeAgentCapabilities;
  configOptions?: BackendAcpRuntimeConfigOption[];
  modes?: BackendAcpRuntimeModeState;
  models?: BackendAcpRuntimeModelState;
  lastError?: string;
};

export type BackendAcpSessionRuntimeState = {
  configValues?: Record<string, string>;
  currentModeId?: string;
  currentModelId?: string;
  reasoningEffort?: string;
  updatedAt?: number;
};

export type BackendAcpSummary = {
  registryId: string;
  version?: string;
  license?: string;
  distributionKinds: BackendAcpDistributionKind[];
  installStatus: BackendAcpInstallStatus;
  authStatus: BackendAcpAuthStatus;
  verificationStatus: BackendAcpVerificationStatus;
  installedAt?: number;
  updatedAt?: number;
  repositoryUrl?: string;
  websiteUrl?: string;
  allowlistRuleId?: string;
  runtime?: BackendAcpRuntimeCapabilities;
};

export type BackendCapabilities = {
  listThreads: boolean;
  createThread: boolean;
  forkThread?: boolean;
  resumeThread: boolean;
  archiveThread?: boolean;
  restoreThread?: boolean;
  archiveWorktree?: boolean;
  restoreWorktree?: boolean;
  renameThread: boolean;
  readThread: boolean;
  startTurn: boolean;
  startReview?: boolean;
  interruptTurn: boolean;
  steerTurn: boolean;
  transcriptPagination: boolean;
  toolUse: boolean;
  approvalRequests: boolean;
  multiDirectoryThreads: boolean;
};

export type BackendModelOption = {
  id: string;
  label?: string;
  current?: boolean;
  defaultReasoningEffort?: string;
  reasoningEfforts?: string[];
  supportsReasoning?: boolean;
  supportsFast?: boolean;
  supportsSteering?: boolean;
  /**
   * Whether this model accepts image input. `undefined` means "assume
   * supported" (backward compatible); only an explicit `false` blocks image
   * attachments in the composer. Codex Spark reports `false`; ACP agents that
   * advertise `agentCapabilities.prompt.image: false` are gated separately on
   * the runtime capability.
   */
  supportsImage?: boolean;
};

export type BackendLaunchpadOptions = {
  models?: BackendModelOption[];
  reasoningEfforts?: string[];
  serviceTiers?: string[];
  supportsFastMode?: boolean;
};

export type BackendAccountSummary = {
  type?: "apiKey" | "chatgpt" | "provider";
  label?: string;
  email?: string;
  planType?: string;
  requiresOpenaiAuth?: boolean;
};

export type BackendRateLimitSummary = {
  name: string;
  limitId?: string;
  remaining?: number;
  limit?: number;
  used?: number;
  usedPercent?: number;
  resetAt?: number;
  windowSeconds?: number;
  windowMinutes?: number;
};

export type BackendSummary = {
  kind: AppServerBackendKind;
  source?: BackendSourceKind;
  label: string;
  available: boolean;
  acp?: BackendAcpSummary;
  account?: BackendAccountSummary;
  rateLimits?: BackendRateLimitSummary[];
  serverName?: string;
  serverVersion?: string;
  methods: string[];
  capabilities: BackendCapabilities;
  executionModes: Array<{
    mode: ThreadExecutionMode;
    label: string;
    available: boolean;
    isDefault?: boolean;
    unavailableReason?: string;
  }>;
  launchpadOptions?: BackendLaunchpadOptions;
  unavailableReason?: string;
};

export type ListBackendsRequest = {
  includeUnavailable?: boolean;
  /**
   * Re-read model capabilities before describing providers. A backend id
   * refreshes one provider; `true` refreshes every provider.
   */
  refreshModels?: true | AppServerBackendKind;
  federationTarget?: FederationTarget;
};

export type ListBackendsResponse = {
  fetchedAt: number;
  backends: BackendSummary[];
};

export type AcpAgentSettingsEntry = {
  backendId: AppServerBackendKind;
  registryId: string;
  name: string;
  description?: string;
  version?: string;
  license?: string;
  authors: string[];
  repositoryUrl?: string;
  websiteUrl?: string;
  distributionKind: BackendAcpDistributionKind;
  distributionSource: string;
  installable: boolean;
  installed: boolean;
  installStatus: BackendAcpInstallStatus;
  authStatus: BackendAcpAuthStatus;
  verificationStatus: BackendAcpVerificationStatus;
  allowlistRuleId?: string;
  installedAt?: number;
  updatedAt?: number;
  unavailableReason?: string;
  lastError?: string;
  lastDiscoveredAt?: number;
  lastDiscoveryError?: string;
  runtime?: BackendAcpRuntimeCapabilities;
  update?: AcpAgentUpdateStatus;
  // Multi-install (Wave 2 / agent-acp). Every installed executable of this
  // agent found on the machine (PATH matches + fallbacks + a passing override),
  // the one currently in effect, the user's enable toggle, and their path
  // preference. Populated from the kit's `discoverLocalAcpAgentInstances`.
  instances?: AcpAgentInstance[];
  /** Executables that matched the provider command but belong to an
   *  unsupported predecessor product. They are shown for remediation but are
   *  never eligible for launch or model discovery. */
  incompatibleInstances?: AcpAgentInstance[];
  activeCommand?: string;
  enabled?: boolean;
  preference?: AcpAgentPreference;
};

export type AcpAgentUpdateStatus = {
  status: "available" | "up-to-date" | "failed";
  checkedAt: number;
  currentVersion: string;
  latestVersion?: string;
  channel?: string;
  installer?: string;
  autoUpdate?: boolean;
  error?: string;
  dismissedAt?: number;
  snoozedUntil?: number;
};

/** How a discovered ACP instance's executable path was located. Mirrors the
 *  kit's `AcpAgentInstanceSource`. */
export type AcpAgentInstanceSource = "override" | "path" | "fallback";

/** One installed executable of an ACP agent that passed discovery. A single
 *  agent can have several (e.g. `qwen` under nvm AND Homebrew), each a distinct
 *  binary the user can pick between. */
export type AcpAgentInstance = {
  /** Resolved command/path that passed the probe. */
  command: string;
  /** Parsed CLI version, when the version probe yielded one. */
  version?: string;
  /** How the path was found: user override, a `PATH` match, or a fallback path. */
  source: AcpAgentInstanceSource;
};

/** A user's per-agent path choice. `overridePath` is a manual absolute path
 *  (highest priority — probed even if outside `PATH`/fallbacks). `selectedPath`
 *  is a discovered instance command the user clicked to pin. Both unset = auto
 *  (first discovered instance). */
export type AcpAgentPreference = {
  overridePath?: string;
  selectedPath?: string;
};

export type ListAcpAgentSettingsRequest = {
  refresh?: boolean;
  /**
   * Force a re-probe of every discovered agent's runtime capabilities,
   * bypassing the freshness window. The "Discover new" button sets this so a
   * user can always re-probe on demand. When omitted, a refresh only launches
   * the (expensive) capability probe for agents that are undiscovered, stale,
   * or whose CLI version changed — otherwise cached capabilities are reused.
   */
  force?: boolean;
};

export type ListAcpAgentSettingsResponse = {
  fetchedAt: number;
  entries: AcpAgentSettingsEntry[];
  error?: string;
};

export type AcknowledgeAcpAgentUpdateRequest = {
  action: "dismiss" | "snooze";
  backendId: AppServerBackendKind;
  latestVersion: string;
};

export type AcknowledgeAcpAgentUpdateResponse = {
  applied: boolean;
  update?: AcpAgentUpdateStatus;
};
