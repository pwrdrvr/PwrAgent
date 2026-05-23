import type { AppServerBackendKind, ThreadExecutionMode } from "./normalized-app-server";

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
};

export type BackendAcpRuntimeModelState = {
  currentModelId?: string;
  availableModels: BackendAcpRuntimeModel[];
};

export type BackendAcpRuntimeAgentCapabilities = {
  loadSession?: boolean;
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
  supportsReasoning?: boolean;
  supportsFast?: boolean;
  supportsSteering?: boolean;
};

export type BackendLaunchpadOptions = {
  models?: BackendModelOption[];
  reasoningEfforts?: string[];
  serviceTiers?: string[];
  supportsFastMode?: boolean;
};

export type BackendAccountSummary = {
  type?: "apiKey" | "chatgpt";
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
};

export type ListAcpAgentSettingsRequest = {
  refresh?: boolean;
};

export type ListAcpAgentSettingsResponse = {
  fetchedAt: number;
  entries: AcpAgentSettingsEntry[];
  error?: string;
};
