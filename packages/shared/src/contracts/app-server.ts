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

export type LinkedDirectorySummary = {
  id: string;
  label: string;
  path: string;
  worktreePath?: string;
  kind: "local" | "worktree";
};

export type AppServerThreadTitleSource = "explicit" | "derived" | "fallback";

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

export type AppServerThreadMessageEntry = AppServerThreadMessage & {
  type: "message";
  phase?: AppServerTranscriptPhase;
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

export type AppServerThreadActivityDetail = {
  id: string;
  kind: "read" | "write" | "command";
  label: string;
  path?: string;
  url?: string;
  status?: AppServerThreadActivityStatus;
  fileDiff?: AppServerThreadFileDiff;
};

export type AppServerThreadActivityEntry = {
  type: "activity";
  id: string;
  summary: string;
  createdAt?: number;
  status?: AppServerThreadActivityStatus;
  details: AppServerThreadActivityDetail[];
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
};

export type AppServerThreadEntry =
  | AppServerThreadMessageEntry
  | AppServerThreadActivityEntry
  | AppServerThreadPlanEntry;

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
  worktreePath: string;
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
    runId?: string;
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

export type AppServerNotification =
  | {
      method: "turn/started";
      params: {
        threadId: string;
        runId?: string;
        turn: {
          id: string;
          status?: string;
        };
      };
    }
  | {
      method: "item/agentMessage/delta";
      params: {
        threadId: string;
        turnId?: string;
        runId?: string;
        itemId: string;
        delta: string;
        stream?: "stdout" | "stderr";
        bytes?: number;
      };
    }
  | {
      method: "turn/completed";
      params: {
        threadId: string;
        runId: string;
        turn: {
          id: string;
          status: "completed";
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
        runId: string;
        turn: {
          id: string;
          status: "failed";
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
        runId: string;
        turn: {
          id: string;
          status: "cancelled";
        };
      };
    }
  | {
      method: "item/started" | "item/completed";
      params: {
        threadId: string;
        runId?: string;
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
        runId?: string;
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
        runId: string;
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
        runId?: string;
        diff: string;
      };
    }
  | {
      method: "turn/requestApproval" | "review/requestApproval";
      params: AppServerPendingRequestNotification["params"];
    }
  | AppServerToolRequestUserInputNotification
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
        runId?: string;
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
      method: "item/commandExecution/outputDelta";
      params: {
        threadId: string;
        turnId?: string;
        itemId: string;
        delta: string;
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
  | AppServerPendingRequestNotification;
