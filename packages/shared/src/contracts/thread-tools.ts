import type {
  AppServerBackendKind,
  AppServerThreadStatus,
  ThreadExecutionMode,
  ThreadIdentifier,
} from "./normalized-app-server";
import type { LinkedDirectorySummary } from "./normalized-app-server";
import type { ThreadAgentMetadata } from "./navigation";
import type {
  ThreadSearchContentMode,
  ThreadSearchConfidenceBand,
  ThreadSearchMatchReason,
  ThreadSearchScopeName,
  ThreadSearchSemanticMode,
  ThreadSearchSnippet,
  ThreadSearchUnavailableScope,
} from "./thread-search";

export const PWRAGENT_THREAD_TOOL_NAMESPACE = "pwragent_threads";

export const PWRAGENT_THREAD_INSPECTION_OPERATION_NAMES = [
  "search_threads",
  "get_thread_status",
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
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
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
  executionMode?: ThreadExecutionMode;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  fastMode?: boolean;
  linkedDirectories: LinkedDirectorySummary[];
  score?: number;
  confidence?: ThreadSearchConfidenceBand;
  matchReasons?: ThreadSearchMatchReason[];
  snippets?: ThreadSearchSnippet[];
};

export type ThreadStatusInspectionSummary = ThreadInspectionSummary & {
  status?: AppServerThreadStatus;
  queuedExecutionMode?: ThreadExecutionMode;
  queuedExecutionModeAt?: number;
};

export type PwrAgentThreadInspectionToolArgsByOperation = {
  search_threads: SearchThreadsToolArgs;
  get_thread_status: GetThreadStatusToolArgs;
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
            query?: string;
            searchedScopes?: ThreadSearchScopeName[];
            unavailableScopes?: ThreadSearchUnavailableScope[];
            contentMode?: ThreadSearchContentMode;
            semanticMode?: ThreadSearchSemanticMode;
          }
        | {
            thread: ThreadStatusInspectionSummary;
          };
    }
  | {
      ok: false;
      error: {
        code: PwrAgentThreadInspectionErrorCode;
        message: string;
      };
    };
