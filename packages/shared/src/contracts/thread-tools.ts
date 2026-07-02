import type {
  AppServerBackendKind,
  AppServerThreadActivityStatus,
  AppServerThreadMessage,
  AppServerThreadReplayPagination,
  AppServerThreadTurnMetadata,
  ThreadGitWorkingState,
  AppServerThreadStatus,
  ThreadExecutionMode,
  ThreadIdentifier,
  ThreadWorkspaceHandoffDirection,
  ThreadWorkspaceHandoffStrategy,
} from "./normalized-app-server";
import type { LinkedDirectorySummary } from "./normalized-app-server";
import type {
  MessagingThreadBindingSummary,
  PrSummary,
  RefreshThreadPullRequestsResponse,
  ThreadAgentMetadata,
} from "./navigation";
import type {
  HandoffTaskGroupingMode,
  HandoffTaskSeedMode,
  HandoffTaskWorkspaceMode,
  MoveThreadWorkspacePhase,
  MoveThreadWorkspaceStatus,
  ThreadHandoffOrigin,
  ThreadHandoffOriginWorkspace,
} from "./thread-orchestration-tools";
import type {
  ThreadSearchContentMode,
  ThreadSearchConfidenceBand,
  ThreadSearchMatchReason,
  ThreadSearchScopeName,
  ThreadSearchSemanticMode,
  ThreadSearchSnippet,
  ThreadSearchUnavailableScope,
} from "./thread-search";

/** @deprecated Use PWRAGENT_TOOL_NAMESPACE for advertised dynamic tools. */
export const PWRAGENT_THREAD_TOOL_NAMESPACE = "pwragent_threads";

export const PWRAGENT_THREAD_INSPECTION_OPERATION_NAMES = [
  "search_threads",
  "read_thread",
  "get_thread_status",
  "attach_thread_pull_request",
  "check_thread_pull_request_status",
  "mutate_thread",
] as const;

export type PwrAgentThreadInspectionOperationName =
  (typeof PWRAGENT_THREAD_INSPECTION_OPERATION_NAMES)[number];

export const DEFAULT_THREAD_INSPECTION_SEARCH_LIMIT = 10;
export const DEFAULT_THREAD_INSPECTION_RECENT_LIMIT = 100;
export const MAX_THREAD_INSPECTION_SEARCH_LIMIT = 100;

export const PWRAGENT_THREAD_INSPECTION_ERROR_CODES = [
  "invalid_arguments",
  "not_found",
  "forbidden",
  "unsupported_operation",
  "internal_error",
] as const;

export type PwrAgentThreadInspectionErrorCode =
  (typeof PWRAGENT_THREAD_INSPECTION_ERROR_CODES)[number];

export type PwrAgentThreadInspectionContext = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  now?: number;
};

export type SearchThreadsToolArgs = {
  query?: string;
  backend?: AppServerBackendKind | "all";
  includeArchived?: boolean;
  agentOnly?: boolean;
  projectKeys?: string[];
  directoryPaths?: string[];
  models?: string[];
  updatedAfter?: number;
  updatedBefore?: number;
  contentMode?: ThreadSearchContentMode;
  semanticMode?: ThreadSearchSemanticMode;
  limit?: number;
};

export type GetThreadStatusToolArgs = {
  /**
   * Defaults to the invoking PwrAgent thread's backend when omitted.
   */
  backend?: AppServerBackendKind;
  /**
   * Defaults to the invoking PwrAgent thread id when omitted.
   */
  threadId?: ThreadIdentifier;
};

export type ReadThreadToolArgs = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /**
   * Provider pagination cursor returned by a previous read_thread response.
   */
  before?: string;
  /**
   * Maximum transcript entries to return. Implementations clamp this to a
   * bounded product limit.
   */
  limit?: number;
  /**
   * Include normalized transcript messages in the response. Defaults to true.
   */
  includeMessages?: boolean;
  /**
   * Include normalized timeline entries in the response. Defaults to true.
   */
  includeEntries?: boolean;
  /**
   * Include current thread status when the backend can provide it.
   * Defaults to true.
   */
  includeStatus?: boolean;
  /**
   * Maximum characters retained in each text-like transcript field.
   * Implementations clamp this to a bounded product limit.
   */
  maxCharsPerEntry?: number;
};

export type MutateThreadToolArgs = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /**
   * Renames the PwrAgent thread itself. This does not rename any attached
   * Telegram topic, Discord thread, or other messaging surface.
   */
  title?: string;
  model?: string;
  serviceTier?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  executionMode?: ThreadExecutionMode;
  /**
   * Validate and report the requested mutations without applying them.
   */
  dryRun?: boolean;
};

export type AttachThreadPullRequestToolArgs = {
  /**
   * Defaults to the invoking PwrAgent thread's backend when omitted.
   */
  backend?: AppServerBackendKind;
  /**
   * Defaults to the invoking PwrAgent thread id when omitted.
   */
  threadId?: ThreadIdentifier;
  /**
   * Full PR/MR URL. Supports GitHub/GHE `/pull/<number>` and GitLab
   * `/merge_requests/<number>` URL shapes.
   */
  url?: string;
  /** Forge host, e.g. github.com, ghe.example.com, gitlab.example.com. */
  provider?: string;
  /** Repo owner or group. For nested GitLab groups, use the slash-separated group path. */
  org?: string;
  repo?: string;
  /**
   * PR/MR number. If provider/org/repo are omitted, the implementation may
   * infer them when the thread has exactly one primary/linked repo.
   */
  number?: number;
  /** Optional title to show until the next provider refresh can hydrate status. */
  title?: string;
};

export type AttachThreadPullRequestResult = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  pr: PrSummary;
  prs: PrSummary[];
};

export type CheckThreadPullRequestStatusToolArgs = {
  /**
   * Defaults to the invoking PwrAgent thread's backend when omitted.
   */
  backend?: AppServerBackendKind;
  /**
   * Defaults to the invoking PwrAgent thread id when omitted.
   */
  threadId?: ThreadIdentifier;
  /** Forge host for this lookup. Defaults to github.com when omitted. */
  provider?: string;
  /** Optional branch override. Defaults to the thread's observed/expected branch or HEAD. */
  branch?: string;
  /**
   * Optional cwd list for provider lookups. Defaults to the thread's linked
   * worktree/local directories, or a neutral cwd when only attached PR URLs
   * need to be refreshed.
   */
  directoryPaths?: string[];
};

export type CheckThreadPullRequestStatusResult =
  RefreshThreadPullRequestsResponse & {
    requestedAt: number;
    branch: string;
    directoryPaths: string[];
  };

export type ThreadMutationField =
  | "title"
  | "model_settings"
  | "execution_mode";

export type ThreadMutationChangeStatus =
  | "would_apply"
  | "applied";

export type ThreadMutationAppliedChange = {
  field: ThreadMutationField;
  status: ThreadMutationChangeStatus;
  to?: unknown;
};

export type ThreadMutationResult = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  dryRun: boolean;
  changes: ThreadMutationAppliedChange[];
};

export type ThreadInspectionSummary = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  title: string;
  summary?: string;
  projectKey?: string;
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number;
  agent?: ThreadAgentMetadata;
  handoffOrigin?: ThreadHandoffOrigin;
  executionMode?: ThreadExecutionMode;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  fastMode?: boolean;
  gitWorkingState?: ThreadGitWorkingState;
  linkedDirectories: LinkedDirectorySummary[];
  linkedRepositories?: ThreadLinkedRepositorySummary[];
  pullRequests?: PrSummary[];
  score?: number;
  confidence?: ThreadSearchConfidenceBand;
  matchReasons?: ThreadSearchMatchReason[];
  messagingBindings?: MessagingThreadBindingSummary[];
  snippets?: ThreadSearchSnippet[];
};

export type ThreadLinkedRepositorySummary = {
  /** Canonical parent checkout/repository path for this group. */
  repositoryPath: string;
  /** Directory ids whose repository/local checkout path maps to this group. */
  directoryIds: string[];
  labels: string[];
  worktreePaths: string[];
};

export type ThreadStatusInspectionSummary = ThreadInspectionSummary & {
  status?: AppServerThreadStatus;
  queuedExecutionMode?: ThreadExecutionMode;
  queuedExecutionModeAt?: number;
  pendingHandoffs?: PendingThreadHandoffSummary[];
  pendingWorkspaceMoves?: PendingThreadWorkspaceMoveSummary[];
};

export type PendingThreadHandoffStatus = "starting" | "completed" | "failed";

export type PendingThreadHandoffPhase =
  | "resolving_source"
  | "awaiting_input"
  | "preparing_workspace"
  | "starting_thread"
  | "starting_turn"
  | "attaching_messaging"
  | "completed"
  | "failed";

export type PendingThreadHandoffSummary = {
  handoffId: string;
  status: PendingThreadHandoffStatus;
  phase: PendingThreadHandoffPhase;
  sourceBackend: AppServerBackendKind;
  sourceThreadId: ThreadIdentifier;
  sourceTurnId?: ThreadIdentifier;
  backend: AppServerBackendKind;
  threadId?: ThreadIdentifier;
  turnId?: ThreadIdentifier;
  title: string;
  taskPreview: string;
  seedMode: HandoffTaskSeedMode;
  groupingMode: HandoffTaskGroupingMode;
  workspaceMode: HandoffTaskWorkspaceMode;
  branchName?: string;
  workspace?: ThreadHandoffOriginWorkspace;
  createdAt: number;
  updatedAt: number;
  message?: string;
  error?: string;
};

export type PendingThreadWorkspaceMoveSummary = {
  workspaceMoveId: string;
  status: MoveThreadWorkspaceStatus;
  phase: MoveThreadWorkspacePhase;
  sourceBackend: AppServerBackendKind;
  sourceThreadId: ThreadIdentifier;
  sourceTurnId?: ThreadIdentifier;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  direction: ThreadWorkspaceHandoffDirection;
  strategy?: ThreadWorkspaceHandoffStrategy;
  repositoryPath?: string;
  sourcePath?: string;
  sourceBranch?: string;
  leaveLocalBranch?: string;
  newBranchName?: string;
  targetPath?: string;
  branch?: string;
  linkedDirectory?: LinkedDirectorySummary;
  warnings?: string[];
  continuationTurnId?: string;
  createdAt: number;
  updatedAt: number;
  message?: string;
  error?: string;
};

export type ThreadReadMessageSummary = Pick<
  AppServerThreadMessage,
  "id" | "role" | "createdAt"
> & {
  text: string;
  truncated?: boolean;
};

export type ThreadReadEntrySummary =
  | {
      type: "message";
      id: string;
      role: AppServerThreadMessage["role"];
      text: string;
      createdAt?: number;
      phase?: "commentary" | "final";
      turn?: AppServerThreadTurnMetadata;
      truncated?: boolean;
    }
  | {
      type: "activity";
      id: string;
      summary: string;
      createdAt?: number;
      status?: AppServerThreadActivityStatus;
      turn?: AppServerThreadTurnMetadata;
      details: Array<{
        id: string;
        kind: "read" | "write" | "command";
        label: string;
        markdown?: string;
        path?: string;
        url?: string;
        status?: AppServerThreadActivityStatus;
        command?: {
          displayCommand: string;
          rawCommand?: string;
          cwd?: string;
          output?: string;
          exitCode?: number;
          durationMs?: number;
        };
        truncated?: boolean;
      }>;
      truncated?: boolean;
    }
  | {
      type: "plan";
      id: string;
      createdAt?: number;
      explanation?: string;
      markdown?: string;
      turn?: AppServerThreadTurnMetadata;
      steps: Array<{ step: string; status: string }>;
      truncated?: boolean;
    }
  | {
      type: "review";
      id: string;
      createdAt?: number;
      status?: AppServerThreadActivityStatus;
      review: string;
      displayText?: string;
      turn?: AppServerThreadTurnMetadata;
      truncated?: boolean;
    };

export type ThreadReadResult = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  limit: number;
  before?: string;
  maxCharsPerEntry: number;
  entries?: ThreadReadEntrySummary[];
  messages?: ThreadReadMessageSummary[];
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  pagination: AppServerThreadReplayPagination;
  status?: AppServerThreadStatus;
};

export type PwrAgentThreadInspectionToolArgsByOperation = {
  search_threads: SearchThreadsToolArgs;
  read_thread: ReadThreadToolArgs;
  get_thread_status: GetThreadStatusToolArgs;
  attach_thread_pull_request: AttachThreadPullRequestToolArgs;
  check_thread_pull_request_status: CheckThreadPullRequestStatusToolArgs;
  mutate_thread: MutateThreadToolArgs;
};

export type PwrAgentThreadInspectionToolArgs<
  TOperation extends PwrAgentThreadInspectionOperationName =
    PwrAgentThreadInspectionOperationName,
> = PwrAgentThreadInspectionToolArgsByOperation[TOperation];

export type PwrAgentThreadInspectionRequest<
  TOperation extends PwrAgentThreadInspectionOperationName =
    PwrAgentThreadInspectionOperationName,
> = {
  [TOperationKey in TOperation]: {
    operation: TOperationKey;
    context: PwrAgentThreadInspectionContext;
    args: PwrAgentThreadInspectionToolArgs<TOperationKey>;
  };
}[TOperation];

export type PwrAgentThreadInspectionResponse =
  | {
      ok: true;
      data:
        | {
            threads: ThreadInspectionSummary[];
            totalCount: number;
            limit: number;
            truncated: boolean;
            pendingHandoffs?: PendingThreadHandoffSummary[];
            pendingWorkspaceMoves?: PendingThreadWorkspaceMoveSummary[];
            query?: string;
            searchedScopes?: ThreadSearchScopeName[];
            unavailableScopes?: ThreadSearchUnavailableScope[];
            contentMode?: ThreadSearchContentMode;
            semanticMode?: ThreadSearchSemanticMode;
          }
        | {
            read: ThreadReadResult;
          }
        | {
            thread: ThreadStatusInspectionSummary;
          }
        | {
            pullRequestReference: AttachThreadPullRequestResult;
          }
        | {
            pullRequestStatus: CheckThreadPullRequestStatusResult;
          }
        | {
            mutation: ThreadMutationResult;
          };
    }
  | {
      ok: false;
      error: {
        code: PwrAgentThreadInspectionErrorCode;
        message: string;
      };
    };
