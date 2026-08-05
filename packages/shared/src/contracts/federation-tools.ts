import type {
  FederatedSearchInstanceSummary,
  FederatedSearchPeerFailure,
  FederationCapability,
  FederationConnectionState,
  FederationInstanceId,
  FederationInstanceRole,
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
  unavailableReason?: string;
};

export type ListFederationInstancesToolArgs = Record<string, never>;

export type ListFederationInstancesResult = {
  federationEnabled: boolean;
  instances: FederationInstanceDescriptor[];
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
  workMode?: LaunchpadWorkMode;
  /** Existing base branch/ref for workMode=worktree, e.g. `origin/main`. */
  branchName?: string;
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
  /**
   * Present for local-instance threads only: the pwragent:// link scheme
   * has no cross-instance addressing yet, so a link to a remote thread
   * would resolve against the wrong instance.
   */
  threadUrl?: string;
  threadLink?: string;
  message: string;
  turnStartFailure?: {
    message: string;
    phase: "turn" | "review";
  };
  codexEnvironmentStartupFailure?: CodexEnvironmentStartupFailure;
};

export type SearchFederationThreadsToolArgs = {
  query: string;
  /** Restrict the search to one instance; omitted searches the whole fleet. */
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
  projectKey?: string;
  gitBranch?: string;
  score: number;
  /** Local-instance results only; see CreateInstanceThreadResult.threadLink. */
  threadLink?: string;
};

export type SearchFederationThreadsResult = {
  query: string;
  results: FederationThreadSearchResultSummary[];
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
