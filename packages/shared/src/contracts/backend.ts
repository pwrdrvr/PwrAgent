import type { AppServerBackendKind, ThreadExecutionMode } from "./normalized-app-server";
import type { FederationTarget } from "./federation";
import type { DesktopUpdateChannel } from "./settings";

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
  /**
   * This backend can honor `delivery: "detached"` either through its native
   * review method or through a managed review child.
   */
  startDetachedReview?: boolean;
  /**
   * This backend can run a PwrAgent-managed review on behalf of a thread that
   * lives on a different provider, so it can be offered as a reviewer
   * override. Doubles as the feature probe for the override itself: an
   * instance that predates reviewer overrides never sets it, so a viewer
   * federated to an older owner sees no eligible reviewers and keeps the
   * picker hidden rather than sending a `reviewBackend` the owner would
   * silently ignore.
   */
  reviewRunner?: boolean;
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
  /** Provider label retained so a sparse update cannot erase it. */
  limitName?: string;
  /** Provider slot used to merge sparse rolling updates with a full snapshot. */
  windowKey?: "primary" | "secondary" | "individual" | "credits";
  remaining?: number;
  limit?: number;
  used?: number;
  usedPercent?: number;
  resetAt?: number;
  windowSeconds?: number;
  windowMinutes?: number;
  /**
   * Codex CreditsSnapshot.hasCredits. Set only on the account credits row.
   * Sparse updates omit this object rather than clearing a previously observed
   * balance, so a false value is an explicit "no credits" observation.
   */
  hasCredits?: boolean;
  /**
   * Codex CreditsSnapshot.unlimited. Set only on the account credits row.
   */
  unlimited?: boolean;
};

/**
 * Which channel published the provider runtime PwrAgent is talking to.
 * `vendor` is the provider's own release; `pwragent` is a build PwrAgent
 * downloads, verifies and installs itself.
 *
 * Two products can answer to one provider name — an OpenAI Codex release and a
 * `-pwragent` Codex build carry different version strings and different
 * release pages — so a surface that cannot tell them apart ends up describing
 * one in the other's terms.
 */
export type BackendRuntimeBuildChannel = "vendor" | "pwragent";

export type BackendRuntimeBuild = {
  channel: BackendRuntimeBuildChannel;
  /** Who publishes this channel's builds, e.g. `OpenAI` or `PwrDrvr`. */
  publisher: string;
};

export type BackendSummary = {
  kind: AppServerBackendKind;
  source?: BackendSourceKind;
  label: string;
  available: boolean;
  /**
   * This backend is unavailable only because the one permitted startup
   * discovery has not published a selection yet. A surface that decides
   * whether the profile has any usable provider must keep that decision
   * pending instead of reading `available: false` as "not configured" — the
   * durable last-known-good it is derived from is legitimately empty on a cold
   * profile and for the whole window between process start and first
   * discovery. Never set alongside `available: true`.
   */
  discoveryPending?: boolean;
  acp?: BackendAcpSummary;
  /**
   * Provenance of the executable serving this backend. Absent until PwrAgent
   * has resolved one — never guessed, because "vendor" is a claim about a
   * specific binary, not a default.
   */
  runtimeBuild?: BackendRuntimeBuild;
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
  /** Required when `refreshModels` can launch provider model discovery. */
  discoveryIntent?: ProviderDiscoveryUserIntent;
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
  /** Detected executables that did not pass the Agent Kit ACP discovery probe.
   *  They are diagnostic-only and must never be offered as launch targets.
   *  `probe-timed-out` is retryable; the other reasons are definitive failures. */
  rejectedInstances?: AcpRejectedAgentInstance[];
  activeCommand?: string;
  /** The active install is a PwrAgent-supplied build (managed download or app
   *  bundle) rather than a vendor install. Those runtimes follow the verified
   *  PwrAgent release feed, so vendor update notices never apply to them. */
  pwrAgentManagedRuntime?: boolean;
  /** State of the PwrAgent-managed build channel for this agent (Grok only
   *  today). Present whenever the channel is enabled, whether or not the
   *  active runtime happens to be one of its builds. */
  managedBuild?: AcpManagedBuildStatus;
  enabled?: boolean;
  preference?: AcpAgentPreference;
};

/**
 * The PwrAgent-managed build channel, as the settings pane needs to describe
 * it. Distinct from `AcpAgentUpdateStatus`, which reports the *vendor*
 * updater's answer about a vendor install: the two channels publish different
 * artifacts under different version strings, and a surface must never describe
 * one in the other's terms.
 */
export type AcpManagedBuildStatus = {
  /** GitHub repository the channel publishes from, e.g. `pwrdrvr/grok-build`. */
  repository: string;
  /** Track this profile follows: promoted releases only, or the newest build
   *  whether or not it has been promoted. */
  channel: DesktopUpdateChannel;
  /** Newest promoted tag the last check saw. Absent until a check has run, or
   *  when the check fell back to a source that cannot report promotion. */
  latestTag?: string;
  /** Newest tag overall the last check saw. Equal to `latestTag` whenever the
   *  newest build has been promoted — the state both tracks share. */
  prereleaseTag?: string;
  /** Newest verified build installed on this machine by the last check. */
  installedTag?: string;
  /** Release tag of the active runtime, when that runtime is a managed build.
   *  Absent when a vendor install or the app-bundled copy is active. */
  activeTag?: string;
  /** When the last release check ran. */
  checkedAt?: number;
  /** When `installedTag` was installed. */
  installedAt?: number;
  /** `installedTag` is installed and ready but something is holding an older
   *  managed build in place for new threads — in practice a manual path
   *  override pinning one version directory. The one managed-channel state
   *  that never resolves on its own. */
  pinnedBehind?: boolean;
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
  /** PwrAgent supplied this executable — a managed download or the copy inside
   *  the app bundle. A vendor install leaves it unset. Independent of whether
   *  this is the *newest* build: provenance does not change when the channel
   *  publishes a newer tag. */
  pwrAgentBuild?: boolean;
  /** Release tag of a managed download, when the executable is one. */
  pwrAgentBuildTag?: string;
};

/** An executable that was found but did not pass ACP discovery. A timed-out
 *  probe is retryable, unlike the other definitive verification failures. */
export type AcpRejectedAgentInstance = AcpAgentInstance & {
  reason:
    | "version-probe-failed"
    | "acp-probe-failed"
    | "acp-help-mismatch"
    | "probe-timed-out";
};

/** A user's per-agent path choice. `overridePath` is a manual absolute path
 *  (highest priority — probed even if outside `PATH`/fallbacks). `selectedPath`
 *  is a discovered instance command the user clicked to pin. Both unset = auto
 *  (first discovered instance). */
export type AcpAgentPreference = {
  overridePath?: string;
  selectedPath?: string;
};

export type ProviderDiscoveryUserIntent =
  | "settings-user-action"
  | "setup-user-action";

export type ListAcpAgentSettingsRequest = {
  refresh?: boolean;
  /** Required when `refresh` can launch local provider discovery. */
  discoveryIntent?: ProviderDiscoveryUserIntent;
  /**
   * Restrict local discovery and capability probing to these provider ids.
   * Omit for every configured provider. Used by explicit onboarding login
   * actions so starting Gemini never starts another CLI as a side effect.
   */
  registryIds?: string[];
  /**
   * When false, refresh executable paths and versions without launching an
   * ACP runtime. Safe for background discovery surfaces such as onboarding,
   * where an agent launch can begin an interactive browser login.
   */
  probeCapabilities?: boolean;
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
