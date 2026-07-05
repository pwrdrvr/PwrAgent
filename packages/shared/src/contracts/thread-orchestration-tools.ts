import type {
  AppServerBackendKind,
  CodexThreadEnvironmentRuntime,
  LinkedDirectorySummary,
  ThreadExecutionMode,
  ThreadIdentifier,
  ThreadWorkspaceHandoffDirection,
  ThreadWorkspaceHandoffStrategy,
} from "./normalized-app-server";
import type { CodexEnvironmentStartupFailure } from "./agent";
import type {
  MessagingChannelKind,
  MessagingConversationKind,
} from "./messaging";

export const PWRAGENT_THREAD_ORCHESTRATION_OPERATION_NAMES = [
  "attach_thread_directory",
  "detach_thread_directory",
  "handoff_task",
  "move_thread_workspace",
  "send_message_to_thread",
] as const;

export type PwrAgentThreadOrchestrationOperationName =
  (typeof PWRAGENT_THREAD_ORCHESTRATION_OPERATION_NAMES)[number];

export const PWRAGENT_THREAD_ORCHESTRATION_ERROR_CODES = [
  "invalid_arguments",
  "not_found",
  "forbidden",
  "unsupported_backend",
  "unsupported_workspace",
  "unsupported_operation",
  "ambiguous_workspace",
  "requires_confirmation",
  "turn_start_failed",
  "internal_error",
] as const;

export type PwrAgentThreadOrchestrationErrorCode =
  (typeof PWRAGENT_THREAD_ORCHESTRATION_ERROR_CODES)[number];

export const DEFAULT_MOVE_THREAD_WORKSPACE_STRATEGY =
  "detached-changes" satisfies ThreadWorkspaceHandoffStrategy;

export type PwrAgentThreadOrchestrationContext = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  callId?: string;
  turnId?: string;
  now?: number;
};

export type HandoffTaskSeedMode = "clean" | "fork";
export const HANDOFF_TASK_SEED_MODES = ["clean", "fork"] as const;

export type HandoffTaskGroupingMode = "none" | "subthread";
export const HANDOFF_TASK_GROUPING_MODES = ["none", "subthread"] as const;

export type HandoffTaskWorkspaceMode =
  | "same"
  | "same_workspace"
  | "project_local"
  | "new_worktree"
  | "none";
export const HANDOFF_TASK_WORKSPACE_MODES = [
  "same",
  "same_workspace",
  "project_local",
  "new_worktree",
  "none",
] as const;

export type HandoffTaskMessagingAttachmentMode =
  | "none"
  | "auto"
  | "current_conversation"
  | "new_child";
export const HANDOFF_TASK_MESSAGING_ATTACHMENT_MODES = [
  "none",
  "auto",
  "current_conversation",
  "new_child",
] as const;

export type HandoffTaskToolArgs = {
  task: string;
  title?: string;
  context?: string;
  seedMode?: HandoffTaskSeedMode;
  groupingMode?: HandoffTaskGroupingMode;
  workspaceMode?: HandoffTaskWorkspaceMode;
  /**
   * Optional source project/repository directory for workspace-backed handoffs.
   * When omitted, the invoking thread's current workspace is used.
   */
  cwd?: string;
  messagingAttachment?: HandoffTaskMessagingAttachmentMode;
  backend?: AppServerBackendKind;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  fastMode?: boolean;
  executionMode?: ThreadExecutionMode;
  approvalPolicy?: string;
  sandbox?: string;
  /**
   * Existing base branch/ref used when workspaceMode is "new_worktree".
   * This is not the delegated thread's new feature branch name.
   */
  branchName?: string;
};

export type SendMessageToThreadToolArgs = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  fastMode?: boolean;
  executionMode?: ThreadExecutionMode;
  approvalPolicy?: string;
  sandbox?: string;
};

export type MoveThreadWorkspaceToolArgs = {
  /**
   * Optional backend override. Omitted defaults to the invoking thread backend.
   * The first implementation supports Codex self-move only.
   */
  backend?: AppServerBackendKind;
  direction?: ThreadWorkspaceHandoffDirection;
  strategy?: ThreadWorkspaceHandoffStrategy;
  /** Repository/local checkout path that owns the worktree relationship. */
  repositoryPath?: string;
  /** Current workspace path before handoff. */
  sourcePath?: string;
  sourceBranch?: string;
  leaveLocalBranch?: string;
  newBranchName?: string;
};

export type AttachThreadDirectoryWorkspaceMode = "local" | "new_worktree";
export const ATTACH_THREAD_DIRECTORY_WORKSPACE_MODES = [
  "local",
  "new_worktree",
] as const;

export type AttachThreadDirectoryWorktreeBranchMode = "attached" | "detached";
export const ATTACH_THREAD_DIRECTORY_WORKTREE_BRANCH_MODES = [
  "attached",
  "detached",
] as const;

export type AttachThreadDirectoryToolArgs = {
  /**
   * Optional backend override. Omitted defaults to the invoking thread backend.
   * The first implementation supports current-thread attachment only.
   */
  backend?: AppServerBackendKind;
  /**
   * Repository/local checkout path to attach, or to use as the parent repo for a
   * new worktree. In Default Access, untrusted paths require operator
   * confirmation before they grant agent read/write/delete scope.
   */
  path: string;
  /**
   * `local` attaches the repository directory itself. `new_worktree` asks
   * PwrAgent to allocate a managed worktree for that repository and attach it
   * after the source repo path is trusted.
   */
  workspaceMode?: AttachThreadDirectoryWorkspaceMode;
  /**
   * Existing base branch/ref used when workspaceMode is "new_worktree".
   * This is not the new feature branch name.
   */
  branchName?: string;
  /**
   * Whether the allocated worktree should be checked out on an attached branch
   * or as a detached HEAD. Defaults to detached.
   */
  worktreeBranchMode?: AttachThreadDirectoryWorktreeBranchMode;
};

export type DetachThreadDirectoryToolArgs = {
  /**
   * Optional backend override. Omitted defaults to the invoking thread backend.
   * The first implementation supports current-thread detachment only.
   */
  backend?: AppServerBackendKind;
  /** Preferred exact linked-directory identifier to detach. */
  directoryId?: string;
  /** Repository/local checkout path to detach. */
  path?: string;
  /** Managed worktree path to detach. */
  worktreePath?: string;
};

export type AttachThreadDirectoryResult = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  directory: LinkedDirectorySummary;
  workspaceMode: AttachThreadDirectoryWorkspaceMode;
  branch?: string;
  message: string;
};

export type DetachThreadDirectoryResult = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  detachedDirectory: LinkedDirectorySummary;
  directories: LinkedDirectorySummary[];
  message: string;
};

export type MoveThreadWorkspaceStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type MoveThreadWorkspacePhase =
  | "waiting_for_turn_boundary"
  | "preparing_workspace"
  | "updating_metadata"
  | "starting_continuation"
  | "completed"
  | "failed";

export type MoveThreadWorkspaceResult = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  workspaceMoveId: string;
  status: MoveThreadWorkspaceStatus;
  phase: MoveThreadWorkspacePhase;
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
  message: string;
  error?: string;
};

export type ThreadHandoffOriginWorkspace = {
  mode: HandoffTaskWorkspaceMode;
  cwd?: string;
  branch?: string;
  linkedDirectory?: LinkedDirectorySummary;
  git:
    | {
        kind: "none";
        worktreeCreationAvailable: false;
        unavailableReason: string;
      }
    | {
        kind: "non_git";
        worktreeCreationAvailable: false;
        unavailableReason: string;
      }
    | {
        kind: "git_local" | "git_worktree";
        worktreeCreationAvailable: boolean;
        unavailableReason?: string;
      };
};

export type ThreadHandoffOrigin = {
  sourceBackend: AppServerBackendKind;
  sourceThreadId: ThreadIdentifier;
  sourceTurnId?: string;
  sourceTitle?: string;
  taskTitle?: string;
  seedMode: HandoffTaskSeedMode;
  groupingMode: HandoffTaskGroupingMode;
  createdAt: number;
  workspace: ThreadHandoffOriginWorkspace;
};

export type HandoffTaskInheritedSettings = {
  backend: AppServerBackendKind;
  executionMode?: ThreadExecutionMode;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  fastMode?: boolean;
  approvalPolicy?: string;
  sandbox?: string;
  codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
};

export type HandoffTaskMessagingAttachment =
  | {
      requested: false;
      outcome: "not_requested";
    }
  | {
      requested: true;
      outcome: "attached" | "created_and_attached";
      channel: MessagingChannelKind;
      conversation: {
        id: string;
        kind: MessagingConversationKind;
        title?: string;
      };
      createdConversation?: {
        id: string;
        kind: MessagingConversationKind;
        title?: string;
      };
    }
  | {
      requested: true;
      outcome: "not_available" | "forbidden" | "unsupported" | "failed";
      reason: string;
    };

export type HandoffTaskResult = {
  backend: AppServerBackendKind;
  handoffId?: string;
  threadId: ThreadIdentifier;
  turnId?: string;
  title?: string;
  seedMode: HandoffTaskSeedMode;
  groupingMode: HandoffTaskGroupingMode;
  groupedUnderThreadId?: ThreadIdentifier;
  inheritedSettings: HandoffTaskInheritedSettings;
  origin: ThreadHandoffOrigin;
  workspace: ThreadHandoffOriginWorkspace;
  messagingAttachment: HandoffTaskMessagingAttachment;
  codexEnvironmentStartupFailure?: CodexEnvironmentStartupFailure;
  turnStartFailure?: {
    message: string;
    phase: "turn";
  };
};

export type SendMessageToThreadResult = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId: string;
  promptPreview: string;
  settings: {
    executionMode?: ThreadExecutionMode;
    model?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    fastMode?: boolean;
    approvalPolicy?: string;
    sandbox?: string;
  };
};

export type PwrAgentThreadOrchestrationToolArgsByOperation = {
  attach_thread_directory: AttachThreadDirectoryToolArgs;
  detach_thread_directory: DetachThreadDirectoryToolArgs;
  handoff_task: HandoffTaskToolArgs;
  move_thread_workspace: MoveThreadWorkspaceToolArgs;
  send_message_to_thread: SendMessageToThreadToolArgs;
};

export type PwrAgentThreadOrchestrationToolArgs<
  TOperation extends PwrAgentThreadOrchestrationOperationName =
    PwrAgentThreadOrchestrationOperationName,
> = PwrAgentThreadOrchestrationToolArgsByOperation[TOperation];

export type PwrAgentThreadOrchestrationRequest<
  TOperation extends PwrAgentThreadOrchestrationOperationName =
    PwrAgentThreadOrchestrationOperationName,
> = {
  [TOperationKey in TOperation]: {
    operation: TOperationKey;
    context: PwrAgentThreadOrchestrationContext;
    args: PwrAgentThreadOrchestrationToolArgs<TOperationKey>;
  };
}[TOperation];

export type PwrAgentThreadOrchestrationResponse =
  | {
      ok: true;
      data:
        | AttachThreadDirectoryResult
        | DetachThreadDirectoryResult
        | HandoffTaskResult
        | MoveThreadWorkspaceResult
        | SendMessageToThreadResult;
    }
  | {
      ok: false;
      error: {
        code: PwrAgentThreadOrchestrationErrorCode;
        message: string;
        data?: unknown;
      };
    };
