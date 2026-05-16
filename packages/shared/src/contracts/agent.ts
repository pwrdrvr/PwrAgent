import type {
  AppServerBackendKind,
  AppServerMcpElicitationResponse,
  AppServerNotification,
  LinkedDirectorySummary,
  ThreadExecutionMode,
  AppServerReviewDelivery,
  AppServerReviewTarget,
  AppServerTurnInputItem,
  CodexThreadEnvironmentRuntime,
  ThreadIdentifier,
} from "./normalized-app-server";
import type {
  DirectorySummaryKind,
  LaunchpadWorkMode,
  NavigationLaunchpadDraft,
  NavigationLaunchpadDefaults,
} from "./navigation";

export type StartThreadRequest = {
  backend: AppServerBackendKind;
  executionMode?: ThreadExecutionMode;
  cwd?: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
  serviceTier?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  workMode?: LaunchpadWorkMode;
  branchName?: string;
  codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
};

export type StartThreadResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  executionMode: ThreadExecutionMode;
  codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
};

export type StartTurnRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  input: AppServerTurnInputItem[];
  executionMode?: ThreadExecutionMode;
  approvalPolicy?: string;
  sandbox?: string;
  model?: string;
  collaborationMode?: AppServerCollaborationModeRequest;
  serviceTier?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
};

export type StartTurnResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId: string;
};

export type StartReviewRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  target: AppServerReviewTarget;
  delivery?: AppServerReviewDelivery;
};

export type StartReviewResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  reviewThreadId: ThreadIdentifier;
  turnId: string;
};

export type InterruptTurnRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId: string;
};

export type InterruptTurnResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId: string;
};

export type CompactThreadRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
};

export type CompactThreadResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId: string;
  itemId?: string;
};

export type SteerTurnRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  input: AppServerTurnInputItem[];
  expectedTurnId: string;
};

export type SteerTurnResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId: string;
};

export type SetThreadExecutionModeRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  executionMode: ThreadExecutionMode;
};

export type SetThreadExecutionModeResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  executionMode: ThreadExecutionMode;
};

export type QueueThreadExecutionModeRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  executionMode: ThreadExecutionMode;
};

export type QueueThreadExecutionModeResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /**
   * The mode that is now queued. Mirrors the request field name on
   * `ThreadOverlayState` / `NavigationThreadSummary` so the renderer can
   * apply the response straight onto its snapshot.
   */
  queuedExecutionMode: ThreadExecutionMode;
  queuedAt: number;
};

export type CancelThreadExecutionModeQueueRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
};

export type CancelThreadExecutionModeQueueResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /**
   * The currently-applied execution mode. Returned so the renderer
   * doesn't need a separate read to refresh after cancel.
   */
  executionMode: ThreadExecutionMode;
};

export type SetThreadModelSettingsRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  model?: string;
  serviceTier?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
};

export type SetThreadModelSettingsResponse = SetThreadModelSettingsRequest;

export type CheckThreadBranchDriftRequest = {
  backend: AppServerBackendKind;
  expectedBranch?: string;
  threadId: ThreadIdentifier;
};

export type CheckThreadBranchDriftResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  expectedBranch?: string;
  observedBranch?: string;
  drifted: boolean;
  checkedAt: number;
};

export type UpdateThreadExpectedBranchRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  branch: string;
};

export type UpdateThreadExpectedBranchResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  branch: string;
  updatedAt: number;
};

export type RetainThreadBranchDriftRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  expectedBranch: string;
  observedBranch: string;
};

export type RetainThreadBranchDriftResponse = RetainThreadBranchDriftRequest & {
  retainedAt: number;
};

export type SubmitServerRequestRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId?: string;
  requestId: string;
  response: Record<string, unknown> | AppServerMcpElicitationResponse;
};

export type SubmitServerRequestResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId?: string;
  requestId: string;
};

export type EnsureDirectoryLaunchpadRequest = {
  directoryKey: string;
  directoryKind: DirectorySummaryKind;
  directoryLabel: string;
  directoryPath?: string;
  currentBranch?: string;
  preferredBackend?: AppServerBackendKind;
  registeredAt?: number;
};

export type EnsureDirectoryLaunchpadResponse = {
  launchpad: NavigationLaunchpadDraft;
  defaults: NavigationLaunchpadDefaults;
};

export type UpdateDirectoryLaunchpadRequest = {
  directoryKey: string;
  patch: Partial<
    Pick<
      NavigationLaunchpadDraft,
      | "imageAttachments"
      | "prompt"
      | "editorDocument"
      | "backend"
      | "executionMode"
      | "model"
      | "reasoningEffort"
      | "serviceTier"
      | "fastMode"
      | "workMode"
      | "branchName"
      | "codexEnvironmentId"
      | "codexEnvironmentExecutionTarget"
      | "codexEnvironmentSetupEnabled"
      | "codexEnvironmentActionId"
      | "directoryLabel"
      | "directoryPath"
    >
  >;
  stickySettingsChanged?: boolean;
};

export type UpdateDirectoryLaunchpadResponse = {
  launchpad: NavigationLaunchpadDraft;
  defaults: NavigationLaunchpadDefaults;
};

export type ResetDirectoryLaunchpadRequest = {
  directoryKey: string;
};

export type ResetDirectoryLaunchpadResponse = {
  directoryKey: string;
  defaults: NavigationLaunchpadDefaults;
};

export type MaterializeDirectoryLaunchpadRequest = {
  directoryKey: string;
  launchpad?: NavigationLaunchpadDraft;
  input?: AppServerTurnInputItem[];
  collaborationMode?: AppServerCollaborationModeRequest;
  reviewTarget?: AppServerReviewTarget;
};

export type MaterializeDirectoryLaunchpadResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId?: string;
  executionMode: ThreadExecutionMode;
  linkedDirectory?: LinkedDirectorySummary;
  workMode: LaunchpadWorkMode;
  codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
  codexEnvironmentStartupFailure?: {
    message: string;
    phase: "setup" | "action";
    worktreeCleanupAvailable: boolean;
  };
};

export type CodexEnvironmentSetupProgressEvent = {
  directoryKey: string;
  environmentId: string;
  environmentName: string;
  command: string;
  cwd?: string;
  phase: "started" | "stdout" | "stderr" | "completed" | "failed";
  chunk?: string;
  output?: string;
  exitCode?: number;
  durationMs?: number;
  error?: string;
  at: number;
};

export type RunCodexEnvironmentActionRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  actionId: string;
  /**
   * Current thread workspace CWD. Renderer callers should pass the same path
   * they use to open VS Code/terminal: worktreePath for Worktree threads, path
   * for Local threads. Main process re-resolves this when omitted.
   */
  cwd?: string;
};

export type RunCodexEnvironmentActionResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  codexEnvironmentRuntime: CodexThreadEnvironmentRuntime;
};

export type SetCodexThreadEnvironmentRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  environmentId?: string;
};

export type SetCodexThreadEnvironmentResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
};

/**
 * Ask the main process to open the system "choose folder" dialog. The
 * renderer never sees the path until the user confirms — `canceled: true`
 * signals the user dismissed the dialog and the renderer should treat it
 * as a no-op (no error). The returned `path` is whatever the OS dialog
 * yielded; validation (is-this-a-git-repo, accessibility) happens in the
 * follow-up `registerDirectoryFromDisk` call so the picker can show a
 * useful error inline rather than blocking inside the dialog.
 */
export type PickDirectoryFromDiskResponse =
  | { canceled: true }
  | { canceled: false; path: string };

export type RegisterDirectoryFromDiskRequest = {
  /** Absolute path the user picked from the system dialog. */
  path: string;
  /**
   * Backend the new directory's launchpad should default to. The launchpad
   * defaults are otherwise loaded from the overlay store.
   */
  preferredBackend?: AppServerBackendKind;
};

/** Why a registration attempt failed — drives the inline error copy. */
export type RegisterDirectoryFromDiskFailureReason =
  | "inaccessible"
  | "not-a-directory"
  | "not-a-git-repo";

export type RegisterDirectoryFromDiskResponse =
  | {
      ok: true;
      /**
       * Canonical filesystem path (resolved via `git rev-parse
       * --show-toplevel` so symlinked roots normalize). The directoryKey
       * is derived from this path with the `directory:` prefix.
       */
      directoryPath: string;
      directoryKey: string;
      directoryLabel: string;
      currentBranch?: string;
      launchpad: NavigationLaunchpadDraft;
      defaults: NavigationLaunchpadDefaults;
    }
  | {
      ok: false;
      reason: RegisterDirectoryFromDiskFailureReason;
      /** Human-readable reason for surfacing in the picker UI. */
      message: string;
    };

export type AgentEvent = {
  backend: AppServerBackendKind;
  notification: AppServerNotification;
};

export type AppServerCollaborationModeRequest = {
  mode: "default" | "plan";
  settings?: {
    model?: string;
    reasoningEffort?: string;
    developerInstructions?: string | null;
  };
};
