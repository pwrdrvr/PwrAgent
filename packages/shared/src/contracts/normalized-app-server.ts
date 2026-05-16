export type AppServerBackendKind = "codex" | "grok";
export type AppServerBackendScope = AppServerBackendKind | "all";
export type ThreadExecutionMode = "default" | "full-access";

export type ThreadIdentifier = string;

export type AppServerTextInputItem = {
  type: "text";
  text: string;
};

export type AppServerImageInputItem = {
  type: "image";
  url: string;
};

export type AppServerLocalImageInputItem = {
  type: "localImage";
  path: string;
};

export type AppServerSkillSummary = {
  name: string;
  description?: string;
  shortDescription?: string;
  path?: string;
  enabled?: boolean;
  scope?: string;
};

export type AppServerTurnInputItem =
  | AppServerTextInputItem
  | AppServerImageInputItem
  | AppServerLocalImageInputItem;

export type AppServerReviewTarget =
  | {
      type: "uncommittedChanges";
    }
  | {
      type: "baseBranch";
      branch: string;
    }
  | {
      type: "commit";
      sha: string;
      title: string | null;
    }
  | {
      type: "custom";
      instructions: string;
    };

export type AppServerReviewDelivery = "inline" | "detached";

export type AppServerReviewFinding = {
  title: string;
  body: string;
  confidence_score: number;
  priority?: number;
  code_location: {
    absolute_file_path: string;
    line_range: {
      start: number;
      end: number;
    };
  };
};

export type AppServerReviewOutput = {
  findings: AppServerReviewFinding[];
  overall_correctness: "patch is correct" | "patch is incorrect";
  overall_explanation: string;
  overall_confidence_score: number;
};

export type LinkedDirectorySummary = {
  id: string;
  label: string;
  /**
   * Canonical repository/local checkout path used for grouping and Local mode.
   * For Worktree entries this is the repository checkout, not the current
   * thread command CWD.
   */
  path: string;
  /**
   * Active worktree checkout path when kind is "worktree". Thread-scoped
   * commands, VS Code, and terminal launches should prefer this over path.
   */
  worktreePath?: string;
  kind: "local" | "worktree";
};

export type WorktreeSnapshotState =
  | "present"
  | "archived"
  | "restored"
  | "unavailable";

export type WorktreeSnapshotSummary = {
  id: string;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  worktreePath: string;
  repositoryPath: string;
  snapshotRef: string;
  snapshotCommit: string;
  sourceBranch?: string;
  sourceHead?: string;
  createdAt: number;
  archivedAt?: number;
  restoredAt?: number;
  state: WorktreeSnapshotState;
  ignoredFilesExcluded: boolean;
  unavailableReason?: string;
};

export type CodexEnvironmentExecutionTarget = "local" | "remote";

export type CodexEnvironmentAction = {
  id: string;
  name: string;
  icon?: string;
  command: string;
};

export type CodexThreadEnvironmentRuntime = {
  environmentId: string;
  environmentName: string;
  executionTarget: CodexEnvironmentExecutionTarget;
  /**
   * CWD used when this environment runtime was selected or last launched.
   * This is persisted runtime state and can become stale after workspace
   * handoff. New commands should use the current thread workspace path
   * (LinkedDirectorySummary.worktreePath/path, or an explicit Run request cwd)
   * and then update this value.
   */
  cwd?: string;
  setupEnabled?: boolean;
  setupStatus?: "skipped" | "completed" | "failed";
  setupCommand?: string;
  setupOutput?: string;
  setupExitCode?: number;
  setupDurationMs?: number;
  actions?: CodexEnvironmentAction[];
  actionId?: string;
  actionName?: string;
  actionCommand?: string;
  actionStatus?: "started" | "failed";
  actionPid?: number;
  sourcePath?: string;
};

export type AppServerThreadTitleSource = "explicit" | "derived" | "fallback";
export type AppServerThreadStatus = "active" | "idle" | "notLoaded" | "unknown";

export type AppServerThreadSummary = {
  id: ThreadIdentifier;
  title: string;
  titleSource: AppServerThreadTitleSource;
  summary?: string;
  projectKey?: string;
  createdAt?: number;
  updatedAt?: number;
  linkedDirectories: LinkedDirectorySummary[];
  gitBranch?: string;
  observedGitBranch?: string;
  source: AppServerBackendKind;
  executionMode?: ThreadExecutionMode;
  model?: string;
  serviceTier?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
  worktreeSnapshots?: WorktreeSnapshotSummary[];
};

export type AppServerThreadMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  parts?: AppServerThreadMessagePart[];
  createdAt?: number;
};

export type AppServerThreadTextPart = {
  type: "text";
  text: string;
};

export type AppServerThreadImagePart = {
  type: "image";
  url: string;
  alt?: string;
};

export type AppServerThreadMessagePart =
  | AppServerThreadTextPart
  | AppServerThreadImagePart;

export type AppServerTranscriptPhase = "commentary" | "final";

export type AppServerThreadTurnStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type AppServerThreadTurnMetadata = {
  id: string;
  status?: AppServerThreadTurnStatus;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
};

export type AppServerThreadMessageEntry = AppServerThreadMessage & {
  type: "message";
  phase?: AppServerTranscriptPhase;
  turn?: AppServerThreadTurnMetadata;
};

export type AppServerThreadActivityStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type AppServerCommandAction =
  | "read"
  | "listFiles"
  | "search"
  | "unknown";

export type AppServerSource = {
  id?: string;
  sourceType?: string;
  url?: string;
  title?: string;
  providerMetadata?: Record<string, unknown>;
};

export type AppServerThreadFileChangeKind = "add" | "delete" | "update";

export type AppServerThreadFileDiff = {
  kind: AppServerThreadFileChangeKind;
  diff: string;
  additions: number;
  removals: number;
};

export type AppServerThreadCommandDetail = {
  displayCommand: string;
  rawCommand?: string;
  cwd?: string;
  output?: string;
  exitCode?: number;
  durationMs?: number;
};

export type AppServerThreadActivityDetail = {
  id: string;
  kind: "read" | "write" | "command";
  label: string;
  path?: string;
  url?: string;
  status?: AppServerThreadActivityStatus;
  command?: AppServerThreadCommandDetail;
  fileDiff?: AppServerThreadFileDiff;
};

export type AppServerThreadActivityEntry = {
  type: "activity";
  id: string;
  summary: string;
  createdAt?: number;
  tone?: "warning";
  status?: AppServerThreadActivityStatus;
  details: AppServerThreadActivityDetail[];
  turn?: AppServerThreadTurnMetadata;
};

export type AppServerThreadPlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed";

export type AppServerThreadPlanStep = {
  step: string;
  status: AppServerThreadPlanStepStatus;
};

export type AppServerThreadPlanEntry = {
  type: "plan";
  id: string;
  createdAt?: number;
  explanation?: string;
  markdown?: string;
  steps: AppServerThreadPlanStep[];
  turn?: AppServerThreadTurnMetadata;
};

export type AppServerThreadReviewEntry = {
  type: "review";
  id: string;
  createdAt?: number;
  status?: AppServerThreadActivityStatus;
  review: string;
  displayText?: string;
  output?: AppServerReviewOutput;
  turn?: AppServerThreadTurnMetadata;
};

export type AppServerThreadEntry =
  | AppServerThreadMessageEntry
  | AppServerThreadActivityEntry
  | AppServerThreadPlanEntry
  | AppServerThreadReviewEntry;

export type AppServerThreadReplayPagination = {
  supportsPagination: boolean;
  hasPreviousPage: boolean;
  previousCursor?: string;
};

export type AppServerThreadReplay = {
  entries: AppServerThreadEntry[];
  messages: AppServerThreadMessage[];
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  pagination: AppServerThreadReplayPagination;
  threadStatus?: AppServerThreadStatus;
};

export type AppServerListThreadsRequest = {
  backend?: AppServerBackendKind;
  archived?: boolean;
  filter?: string;
};

export type AppServerListThreadsResponse = {
  backend: AppServerBackendScope;
  fetchedAt: number;
  threads: AppServerThreadSummary[];
};

export type ArchiveThreadCleanupResult = {
  worktreePath?: string;
  branch?: string;
  removedWorktree: boolean;
  deletedBranch: boolean;
  skippedReason?: string;
  error?: string;
};

export type ArchiveThreadRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
};

export type ArchiveThreadResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  archivedAt: number;
  cleanup: ArchiveThreadCleanupResult[];
};

export type RestoreThreadRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
};

export type RestoreThreadResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  restoredAt: number;
};

export type ArchiveWorktreeRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  worktreePath: string;
  repositoryPath?: string;
};

export type ArchiveWorktreeResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  archivedAt: number;
  snapshot: WorktreeSnapshotSummary;
};

export type ThreadWorkspaceHandoffDirection =
  | "local-to-worktree"
  | "worktree-to-local";

export type ThreadWorkspaceHandoffStrategy =
  | "move-branch"
  | "detached-changes"
  | "new-branch";

export type ThreadWorkspaceHandoffStashSummary = {
  ref?: string;
  message: string;
  path: string;
  applied: boolean;
  dropped: boolean;
};

export type HandoffThreadWorkspaceRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  direction: ThreadWorkspaceHandoffDirection;
  strategy?: ThreadWorkspaceHandoffStrategy;
  /** Repository/local checkout path that owns the worktree relationship. */
  repositoryPath?: string;
  /**
   * Current workspace path before handoff: local path for Local, worktreePath
   * for Worktree.
   */
  sourcePath?: string;
  sourceBranch?: string;
  leaveLocalBranch?: string;
  newBranchName?: string;
};

export type HandoffThreadWorkspaceResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  direction: ThreadWorkspaceHandoffDirection;
  strategy?: ThreadWorkspaceHandoffStrategy;
  workMode: "local" | "worktree";
  branch?: string;
  baseSha?: string;
  repositoryPath: string;
  targetPath: string;
  linkedDirectory: LinkedDirectorySummary;
  archivedSourceWorktree?: WorktreeSnapshotSummary;
  sourceStash?: ThreadWorkspaceHandoffStashSummary;
  destinationStash?: ThreadWorkspaceHandoffStashSummary;
  warnings: string[];
  completedAt: number;
};

export type RestoreWorktreeRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  worktreePath: string;
  repositoryPath?: string;
  snapshotRef?: string;
};

export type RestoreWorktreeResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  restoredAt: number;
  snapshot: WorktreeSnapshotSummary;
};

export type RenameThreadRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  name: string;
};

export type RenameThreadResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  renamedAt: number;
};

export type AppServerReadThreadRequest = {
  backend?: AppServerBackendKind;
  threadId: ThreadIdentifier;
  before?: string;
  limit?: number;
};

export type AppServerReadThreadResponse = {
  backend: AppServerBackendKind;
  fetchedAt: number;
  threadId: ThreadIdentifier;
  replay: AppServerThreadReplay;
  threadStatus?: AppServerThreadStatus;
};

export type AppServerListSkillsRequest = {
  backend?: AppServerBackendKind;
  cwd?: string;
  cwds?: string[];
};

export type AppServerListSkillsResponse = {
  backend: AppServerBackendKind;
  fetchedAt: number;
  data: Array<{
    cwd?: string;
    skills: AppServerSkillSummary[];
  }>;
};

export type AppServerPendingRequestNotification = {
  method: string;
  params: {
    threadId: string;
    turnId?: string | null;
    requestId: string;
    prompt?: string;
    options?: string[];
    [key: string]: unknown;
  };
};

export type AppServerToolRequestUserInputOption = {
  label: string;
  description: string;
};

export type AppServerToolRequestUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: AppServerToolRequestUserInputOption[] | null;
};

export type AppServerToolRequestUserInputAnswer = {
  answers: string[];
};

export type AppServerToolRequestUserInputResponse = {
  answers: Record<string, AppServerToolRequestUserInputAnswer | undefined>;
};

export type AppServerToolRequestUserInputNotification = {
  method: "item/tool/requestUserInput";
  params: AppServerPendingRequestNotification["params"] & {
    turnId?: string;
    itemId?: string;
    questions: AppServerToolRequestUserInputQuestion[];
  };
};

export type AppServerMcpElicitationAction = "accept" | "decline" | "cancel";

export type AppServerMcpElicitationSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export type AppServerMcpElicitationResponse = {
  action: AppServerMcpElicitationAction;
  content: Record<string, unknown> | null;
  _meta: Record<string, unknown> | null;
};

export type AppServerMcpElicitationRequestNotification = {
  method: "mcpServer/elicitation/request";
  params: AppServerPendingRequestNotification["params"] & {
    turnId: string | null;
    serverName: string;
    mode: "form" | "url";
    _meta: Record<string, unknown> | null;
    message: string;
    requestedSchema?: AppServerMcpElicitationSchema;
    url?: string;
    elicitationId?: string;
  };
};

export type AppServerNotification =
  | {
      method: "turn/started";
      params: {
        threadId: string;
        turnId?: string;
        turn: {
          id: string;
          status?: string;
          startedAt?: number | null;
          completedAt?: number | null;
          durationMs?: number | null;
        };
      };
    }
  | {
      method: "item/agentMessage/delta";
      params: {
        threadId: string;
        turnId?: string;
        itemId: string;
        delta: string;
        phase?: AppServerTranscriptPhase;
        stream?: "stdout" | "stderr";
        bytes?: number;
      };
    }
  | {
      method: "turn/completed";
      params: {
        threadId: string;
        turnId: string;
        turn: {
          id: string;
          status: "completed";
          startedAt?: number | null;
          completedAt?: number | null;
          durationMs?: number | null;
          output: Array<{
            type: "text";
            text: string;
          }>;
        };
      };
    }
  | {
      method: "turn/failed";
      params: {
        threadId: string;
        turnId: string;
        turn: {
          id: string;
          status: "failed";
          startedAt?: number | null;
          completedAt?: number | null;
          durationMs?: number | null;
          error: {
            message: string;
          };
        };
      };
    }
  | {
      method: "turn/cancelled";
      params: {
        threadId: string;
        turnId: string;
        turn: {
          id: string;
          status: "cancelled";
          startedAt?: number | null;
          completedAt?: number | null;
          durationMs?: number | null;
        };
      };
    }
  | {
      method: "item/started" | "item/completed";
      params: {
        threadId: string;
        turnId?: string;
        item: {
          id: string;
          type: string;
          text?: string;
          review?: string;
          command?: string;
          commandAction?: AppServerCommandAction;
          toolName?: string;
          success?: boolean;
          arguments?: Record<string, unknown>;
          data?: Record<string, unknown>;
          sources?: AppServerSource[];
        };
      };
    }
  | {
      method: "item/plan/delta";
      params: {
        threadId: string;
        turnId?: string;
        item: {
          id: string;
          type: "plan";
        };
        delta: string;
      };
    }
  | {
      method: "turn/plan/updated";
      params: {
        threadId: string;
        turnId: string;
        plan: {
          explanation?: string;
          steps: Array<{
            step: string;
            status: "pending" | "in_progress" | "completed";
          }>;
        };
      };
    }
  | {
      method: "turn/diff/updated";
      params: {
        threadId: string;
        turnId?: string;
        diff: string;
      };
    }
  | {
      method: "turn/requestApproval" | "review/requestApproval";
      params: AppServerPendingRequestNotification["params"];
    }
  | AppServerToolRequestUserInputNotification
  | AppServerMcpElicitationRequestNotification
  | {
      method: "thread/status/changed";
      params: {
        threadId: string;
        status: {
          type: string;
        };
      };
    }
  | {
      method: "thread/archived";
      params: {
        threadId: string;
      };
    }
  | {
      method: "thread/unarchived";
      params: {
        threadId: string;
      };
    }
  | {
      method: "serverRequest/resolved";
      params: {
        threadId: string;
        turnId?: string;
        requestId: string;
      };
    }
  | {
      method: "thread/tokenUsage/updated";
      params: {
        threadId: string;
        turnId?: string;
        tokenUsage: unknown;
      };
    }
  | {
      method: "account/rateLimits/updated";
      params: {
        rateLimits: unknown;
      };
    }
  | {
      method: "account/updated";
      params: {
        account?: unknown;
      };
    }
  | {
      method: "item/commandExecution/outputDelta";
      params: {
        threadId: string;
        turnId?: string;
        itemId: string;
        delta: string;
      };
    }
  | {
      method: "item/commandExecution/terminalInteraction";
      params: {
        threadId: string;
        turnId?: string;
        itemId: string;
        processId?: string;
        stdin?: string;
      };
    }
  | {
      method: "item/fileChange/outputDelta";
      params: {
        threadId: string;
        turnId?: string;
        itemId: string;
        delta: string;
      };
    }
  | {
      method: "item/mcpToolCall/progress";
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        message: string;
      };
    }
  | {
      method: "mcpServer/startupStatus/updated";
      params: {
        name?: string;
        serverName?: string;
        status?: "starting" | "ready" | "failed" | "cancelled";
        error?: string | null;
        [key: string]: unknown;
      };
    }
  | {
      method: "mcpServer/oauthLogin/completed";
      params: {
        name?: string;
        serverName?: string;
        success?: boolean;
        error?: string;
        [key: string]: unknown;
      };
    }
  | {
      method: "thread/started";
      params: {
        threadId?: string;
        thread?: Record<string, unknown>;
      };
    }
  | {
      method: "warning";
      params: {
        threadId?: string;
        message: string;
      };
    }
  | {
      method: "thread/name/updated";
      params: {
        threadId: string;
        threadName?: string;
      };
    }
  | {
      method: "thread/compacted";
      params: {
        threadId: string;
        itemId?: string;
      };
    }
  | {
      method: "thread/executionMode/updated";
      params: {
        threadId: string;
        executionMode: ThreadExecutionMode;
      };
    }
  | {
      method: "thread/executionMode/queued";
      params: {
        threadId: string;
        queuedExecutionMode: ThreadExecutionMode;
        queuedAt: number;
      };
    }
  | {
      method: "thread/executionMode/queueCleared";
      params: {
        threadId: string;
        reason: "applied" | "cancelled";
      };
    }
  | {
      method: "thread/modelSettings/updated";
      params: {
        threadId: string;
        model?: string;
        fastMode?: boolean;
        reasoningEffort?: string;
        serviceTier?: string;
      };
    }
  | {
      method: "thread/codexEnvironment/updated";
      params: {
        threadId: string;
        codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
      };
    }
  | {
      method: "navigation/threadDirectories/updated";
      params: {
        reason: "selected-thread" | "full-reconcile";
        threadIds: string[];
      };
    }
  | {
      method: "thread/pin/added";
      params: {
        threadId: string;
        pinnedRank: string;
      };
    }
  | {
      method: "thread/pin/removed";
      params: {
        threadId: string;
      };
    }
  | {
      method: "thread/pin/reordered";
      params: {
        pinnedRanks: Record<string, string>;
      };
    }
  | AppServerPendingRequestNotification;
