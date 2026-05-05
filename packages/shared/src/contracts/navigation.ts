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
  /** Per-thread emoji reactions, ordered by insertion. */
  reactions?: string[];
  /** GitHub pull requests detected for this thread's linked directories + branch. */
  prs?: PrSummary[];
};

/**
 * Color states map directly to GitHub PR + check status:
 *   - merged   → state === MERGED              (purple chip)
 *   - failing  → any check FAILURE/CANCELLED/TIMED_OUT/STARTUP_FAILURE (red)
 *   - passing  → all checks SUCCESS, !isDraft  (green)
 *   - draft    → isDraft on an OPEN PR         (gray)
 *   - pending  → checks still running          (yellow)
 *   - closed   → CLOSED without merge          (gray)
 *   - unknown  → no checks reported yet, or shape we don't recognize (gray)
 */
export type PrChipState =
  | "merged"
  | "failing"
  | "passing"
  | "draft"
  | "pending"
  | "closed"
  | "unknown";

export type PrSummary = {
  number: number;
  /** Repo owner login, e.g. "pwrdrvr". */
  org: string;
  /** Repo name, e.g. "PwrAgent". */
  repo: string;
  state: PrChipState;
  url: string;
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
  /**
   * Tiptap JSON document for the rich-text composer. When present, the
   * renderer restores the editor state directly instead of re-parsing
   * `prompt` as markdown — round-tripping markdown is lossy for inline
   * marks and creates phantom blank lines for empty paragraphs.
   */
  editorDocument?: Record<string, unknown>;
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

export type SetThreadReactionRequest = {
  backend?: AppServerBackendKind;
  threadId: ThreadIdentifier;
  emoji: string;
  /** true → add the reaction; false → remove it */
  present: boolean;
};

export type SetThreadReactionResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  reactions: string[];
};

export type RefreshThreadPullRequestsRequest = {
  backend?: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /** Branch the renderer believes the thread is on. */
  branch: string;
  /**
   * Resolved cwds to ask `gh` about. The renderer pre-resolves
   * worktree-vs-local paths so the main process doesn't need to
   * re-walk the snapshot.
   */
  directoryPaths: string[];
};

export type RefreshThreadPullRequestsResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  prs: PrSummary[];
  /** True when the host doesn't have `gh` installed; degrade silently. */
  ghAvailable: boolean;
  /**
   * True when main short-circuited the gh fetch because at least one
   * PR for this thread is already in a terminal state (`merged` or
   * `closed`). Returned PRs are the persisted overlay snapshot.
   */
  shortCircuited?: boolean;
};

export type GhStatus = {
  /** `gh` binary present on PATH. */
  installed: boolean;
  /** Authenticated against github.com. */
  loggedIn: boolean;
  /** Login name parsed from `gh auth status`. */
  account?: string;
  /** OAuth/PAT scopes. */
  scopes: string[];
  /** True when scopes include `repo` (or `public_repo` for restricted). */
  hasRepoScope: boolean;
  /** Raw stderr/stdout from `gh auth status`, for displaying in the UI. */
  rawOutput?: string;
  /** Why we returned this result, for display in the UI. */
  reason?: string;
};

export type GetGhStatusRequest = {
  /** When true, invalidate the cached `gh --version` probe and re-check. */
  recheck?: boolean;
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
  /**
   * Per-thread emoji reactions. Single-user model: each emoji appears at
   * most once, ordered by insertion. Used as personal status markers
   * (e.g., "needs follow-up"), not multi-user voting.
   */
  reactions?: string[];
  /**
   * GitHub pull requests detected for this thread, persisted across
   * restarts so chips appear instantly on relaunch and so we can
   * short-circuit re-fetching once a PR reaches a terminal state
   * (`merged` / `closed`).
   */
  prs?: PrSummary[];
  /** Wall-clock ms when `prs` was last refreshed via gh. */
  prsFetchedAt?: number;
};

export type ThreadBranchDriftPair = {
  expectedBranch: string;
  observedBranch: string;
  retainedAt: number;
};

export type DirectoryLaunchpadOverlayState = NavigationLaunchpadDraft;
