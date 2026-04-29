import type { AppServerBackendKind, ThreadExecutionMode } from "./normalized-app-server";

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
  label: string;
  available: boolean;
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
