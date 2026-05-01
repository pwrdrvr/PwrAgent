import type {
  AppServerBackendScope,
  AppServerBackendKind,
  AppServerThreadImagePart,
  AppServerThreadSummary,
  LinkedDirectorySummary,
  ThreadExecutionMode,
  ThreadIdentifier,
  WorktreeSnapshotSummary,
} from "./normalized-app-server";

export type InboxReason = "new-thread" | "updated-since-seen";

export type ThreadInboxState = {
  inInbox: boolean;
  reason?: InboxReason;
  lastSeenAt?: number;
  lastSeenUpdatedAt?: number;
};

export type NavigationThreadSummary = AppServerThreadSummary & {
  inbox: ThreadInboxState;
  retainedBranchDriftPairs?: ThreadBranchDriftPair[];
  optimisticUserMessage?: {
    text: string;
    imageParts?: AppServerThreadImagePart[];
    createdAt?: number;
  };
};

export type DirectorySummaryKind = "directory" | "workspace" | "unlinked";
export type LaunchpadWorkMode = "local" | "worktree";

export type NavigationLaunchpadDefaults = {
  backend: AppServerBackendKind;
  executionMode: ThreadExecutionMode;
  workMode?: LaunchpadWorkMode;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  fastMode?: boolean;
};

export type NavigationLaunchpadDraft = NavigationLaunchpadDefaults & {
  directoryKey: string;
  directoryKind: DirectorySummaryKind;
  directoryLabel: string;
  directoryPath?: string;
  imageAttachments?: NavigationLaunchpadImageAttachment[];
  prompt: string;
  settingsTouchedAt?: number;
  workMode: LaunchpadWorkMode;
  branchName?: string;
  createdAt: number;
  updatedAt: number;
};

export type NavigationLaunchpadImageAttachment = {
  id: string;
  height?: number;
  name: string;
  size: number;
  type: string;
  url: string;
  width?: number;
};

export type NavigationDirectoryGitStatus = {
  currentBranch?: string;
  defaultBranch?: string;
  upstreamBranch?: string;
  ahead?: number;
  behind?: number;
  branches?: string[];
  handoffBranches?: string[];
  syncState?:
    | "in-sync"
    | "ahead"
    | "behind"
    | "diverged"
    | "untracked"
    | "status-unavailable";
  statusUnavailableReason?: string;
};

export type NavigationDirectorySummary = {
  key: string;
  kind: DirectorySummaryKind;
  label: string;
  path?: string;
  threadKeys: string[];
  needsAttentionCount: number;
  latestUpdatedAt?: number;
  gitStatus?: NavigationDirectoryGitStatus;
  launchpad?: NavigationLaunchpadDraft;
};

export function buildThreadIdentityKey(
  backend: AppServerBackendKind,
  threadId: ThreadIdentifier,
): string {
  return `${backend}:${threadId}`;
}

export type NavigationSnapshot = {
  backend: AppServerBackendScope;
  fetchedAt: number;
  unchanged: boolean;
  threads: NavigationThreadSummary[];
  inboxThreadKeys: string[];
  directories: NavigationDirectorySummary[];
  launchpadDefaults: NavigationLaunchpadDefaults;
};

export type GetNavigationSnapshotRequest = {
  backend?: AppServerBackendScope;
  filter?: string;
};

export type MarkThreadSeenRequest = {
  backend?: AppServerBackendKind;
  threadId: ThreadIdentifier;
  seenAt?: number;
  seenUpdatedAt?: number;
};

export type MarkThreadSeenResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  seenAt: number;
  seenUpdatedAt?: number;
};

export type ThreadOverlayState = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  executionMode?: ThreadExecutionMode;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  fastMode?: boolean;
  gitBranch?: string;
  observedGitBranch?: string;
  lastSeenAt?: number;
  lastSeenUpdatedAt?: number;
  dismissedAt?: number;
  snoozedUntil?: number;
  retainedBranchDriftPairs?: ThreadBranchDriftPair[];
  extraLinkedDirectories: LinkedDirectorySummary[];
  worktreeSnapshots?: WorktreeSnapshotSummary[];
};

export type ThreadBranchDriftPair = {
  expectedBranch: string;
  observedBranch: string;
  retainedAt: number;
};

export type DirectoryLaunchpadOverlayState = NavigationLaunchpadDraft;
