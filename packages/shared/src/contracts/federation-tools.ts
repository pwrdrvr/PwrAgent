import type {
  FederatedSearchInstanceSummary,
  FederatedSearchPeerFailure,
  FederationCapability,
  FederationConnectionState,
  FederationHostInfo,
  FederationInstanceId,
  FederationInstanceRole,
  FederationLoadStatus,
} from "./federation";
import type {
  DirectorySummaryKind,
  LaunchpadWorkMode,
} from "./navigation";
import type {
  AppServerBackendKind,
  ThreadExecutionMode,
  ThreadIdentifier,
} from "./normalized-app-server";
import type { CodexEnvironmentStartupFailure } from "./agent";

export const PWRAGENT_FEDERATION_OPERATION_NAMES = [
  "list_federation_instances",
  "list_instance_projects",
  "create_instance_thread",
  "search_federation_threads",
] as const;

export type PwrAgentFederationOperationName =
  (typeof PWRAGENT_FEDERATION_OPERATION_NAMES)[number];

export const PWRAGENT_FEDERATION_ERROR_CODES = [
  "invalid_arguments",
  "not_found",
  "peer_unavailable",
  "forbidden",
  "turn_start_failed",
  "internal_error",
] as const;

export type PwrAgentFederationErrorCode =
  (typeof PWRAGENT_FEDERATION_ERROR_CODES)[number];

export type PwrAgentFederationContext = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  callId?: string;
  turnId?: string;
};

/**
 * One row of the fleet directory an agent can route work across. The local
 * instance is always present (even with federation disabled) so agent flows
 * never fork on federation availability.
 */
export type FederationInstanceDescriptor = {
  instanceId: FederationInstanceId;
  label: string;
  isLocal: boolean;
  status: FederationConnectionState;
  capabilities: FederationCapability[];
  role?: FederationInstanceRole;
  /** Operator-written purpose notes ("Studio Mac — PwrSnap dev"). */
  notes?: string;
  /** Celestial icon token assigned by the Star Map surface. */
  icon?: string;
  profileName?: string;
  /**
   * Static host facts (OS, arch, CPU count, RAM, disk free, machineId).
   * Instances sharing a machineId run on the same hardware — their CPU/RAM
   * capacity must not be summed.
   */
  host?: FederationHostInfo;
  /**
   * Live load reading, present only when the caller asked for it via
   * `includeLoad` AND the instance answered within the short load-query
   * timeout. Instances sharing `host.machineId` report the same
   * underlying load — dedupe by machineId when aggregating.
   */
  load?: FederationLoadStatus;
  unavailableReason?: string;
};

export type ListFederationInstancesToolArgs = {
  /**
   * Case-insensitive substring filter matched against label, notes,
   * profile name, instance id, and host facts (hostname, platform, arch,
   * OS version). Ignored when continuing from a cursor.
   */
  query?: string;
  /** Page size, 1-100. Defaults to 25. */
  limit?: number;
  /** Continuation token from a previous truncated result. Short-lived. */
  cursor?: string;
  /**
   * When true, attach a live `load` block (CPU load averages, available
   * RAM, free disk) to each reachable instance via a short-timeout
   * on-demand query. Instances that fail to answer in time simply omit
   * `load`. Continuation pages reuse the loads sampled when the listing
   * was built.
   */
  includeLoad?: boolean;
};

export type ListFederationInstancesResult = {
  federationEnabled: boolean;
  instances: FederationInstanceDescriptor[];
  /** Total instances matching the query across all pages. */
  totalCount: number;
  /**
   * Present when more instances remain. Pass back as `cursor` promptly —
   * tokens expire after about a minute.
   */
  nextCursor?: string;
};

export type ListInstanceProjectsToolArgs = {
  instanceId: FederationInstanceId;
};

export type FederationInstanceProjectSummary = {
  /** Directory key to pass to create_instance_thread as projectKey. */
  key: string;
  label: string;
  kind: DirectorySummaryKind;
  path?: string;
  /**
   * Whether the project has a configured launchpad draft (environment,
   * model, execution-mode presets). Threads can be created either way;
   * without one, instance-level defaults apply.
   */
  hasLaunchpad: boolean;
  backend?: AppServerBackendKind;
  workMode?: LaunchpadWorkMode;
  model?: string;
  executionMode?: ThreadExecutionMode;
};

export type ListInstanceProjectsResult = {
  instanceId: FederationInstanceId;
  instanceLabel: string;
  isLocal: boolean;
  projects: FederationInstanceProjectSummary[];
};

export type CreateInstanceThreadToolArgs = {
  instanceId: FederationInstanceId;
  /** Directory key from list_instance_projects. */
  projectKey: string;
  /** Initial prompt for the created thread's first turn. */
  input?: string;
  model?: string;
  reasoningEffort?: string;
  executionMode?: ThreadExecutionMode;
  fastMode?: boolean;
  /**
   * Explicit Token Miser choice for the created thread. The owning instance
   * applies this launchpad override before the initial turn starts. Supported
   * only when the selected project's effective backend is Codex.
   */
  tokenMiserEnabled?: boolean;
  workMode?: LaunchpadWorkMode;
  /** Existing base branch/ref for workMode=worktree, e.g. `origin/main`. */
  branchName?: string;
  /**
   * Group the created thread beneath the calling thread, even when the two
   * threads live on different federation instances. Defaults to ungrouped.
   */
  groupingMode?: "none" | "subthread";
};

export type CreateInstanceThreadResult = {
  instanceId: FederationInstanceId;
  instanceLabel: string;
  isLocal: boolean;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  executionMode: ThreadExecutionMode;
  workMode: LaunchpadWorkMode;
  turnId?: string;
  groupingMode: "none" | "subthread";
  groupedUnderThreadId?: ThreadIdentifier;
  /** Canonical link, including instanceId for a remote owner on newer peers. */
  threadUrl?: string;
  threadLink?: string;
  message: string;
  turnStartFailure?: {
    message: string;
    phase: "turn" | "review";
  };
  codexEnvironmentStartupFailure?: CodexEnvironmentStartupFailure;
};

export const FEDERATION_SEARCH_SCOPES = ["all", "local", "remote"] as const;

export type FederationSearchScope = (typeof FEDERATION_SEARCH_SCOPES)[number];

export type SearchFederationThreadsToolArgs = {
  query: string;
  backend?: AppServerBackendKind | "all";
  includeArchived?: boolean;
  projectKeys?: string[];
  updatedAfter?: number;
  updatedBefore?: number;
  /**
   * Which instances to search: `all` (default) is local plus every
   * connected peer, `local` is this instance only, `remote` is every
   * connected peer excluding local. Intersects with `instanceId` when both
   * are given.
   */
  scope?: FederationSearchScope;
  /** Restrict the search to one instance; omitted searches the whole scope. */
  instanceId?: FederationInstanceId;
  limit?: number;
};

export type FederationThreadSearchResultSummary = {
  instanceId: FederationInstanceId;
  instanceLabel: string;
  isLocal: boolean;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  title: string;
  updatedAt?: number;
  archivedAt?: number;
  projectKey?: string;
  gitBranch?: string;
  score: number;
  /** Canonical link, including instanceId for a remote owner on newer peers. */
  threadLink?: string;
};

export type SearchFederationThreadsResult = {
  query: string;
  results: FederationThreadSearchResultSummary[];
  totalCount: number;
  truncated: boolean;
  searchedInstances: FederatedSearchInstanceSummary[];
  failures: FederatedSearchPeerFailure[];
};

export type PwrAgentFederationToolArgs<
  TOperation extends PwrAgentFederationOperationName,
> = {
  list_federation_instances: ListFederationInstancesToolArgs;
  list_instance_projects: ListInstanceProjectsToolArgs;
  create_instance_thread: CreateInstanceThreadToolArgs;
  search_federation_threads: SearchFederationThreadsToolArgs;
}[TOperation];

export type PwrAgentFederationRequest<
  TOperation extends PwrAgentFederationOperationName =
    PwrAgentFederationOperationName,
> = {
  [TOperationKey in TOperation]: {
    operation: TOperationKey;
    context: PwrAgentFederationContext;
    args: PwrAgentFederationToolArgs<TOperationKey>;
  };
}[TOperation];

export type PwrAgentFederationResponse =
  | {
      ok: true;
      data:
        | ListFederationInstancesResult
        | ListInstanceProjectsResult
        | CreateInstanceThreadResult
        | SearchFederationThreadsResult;
    }
  | {
      ok: false;
      error: {
        code: PwrAgentFederationErrorCode;
        message: string;
        data?: unknown;
      };
    };
