import type {
  AppServerBackendKind,
  AppServerMcpElicitationResponse,
  AppServerNotification,
  ThreadExecutionMode,
  AppServerReviewDelivery,
  AppServerReviewTarget,
  AppServerTurnInputItem,
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
};

export type StartThreadResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  executionMode: ThreadExecutionMode;
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
  workMode: LaunchpadWorkMode;
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
