import type {
  AppServerBackendScope,
  AppServerBackendKind,
  AppServerThreadImagePart,
  AppServerThreadSummary,
  CodexEnvironmentAction,
  CodexEnvironmentExecutionTarget,
  CodexThreadEnvironmentRuntime,
  LinkedDirectorySummary,
  ThreadExecutionMode,
  ThreadIdentifier,
  WorktreeSnapshotSummary,
} from "./normalized-app-server";
import type {
  MessagingChannelKind,
  MessagingConversationKind,
} from "./messaging";
import type { DesktopGhDiscoverySnapshot } from "./settings";

export type InboxReason = "new-thread" | "updated-since-seen";

export type ThreadInboxState = {
  inInbox: boolean;
  reason?: InboxReason;
  lastSeenAt?: number;
  lastSeenUpdatedAt?: number;
};

export type NavigationThreadSummary = AppServerThreadSummary & {
  inbox: ThreadInboxState;
  /** User-curated position in the pinned section. Lower ranks sort first. */
  pinnedRank?: string;
  retainedBranchDriftPairs?: ThreadBranchDriftPair[];
  /**
   * Pending permission mode change waiting for the active turn to end.
   * Populated only when a user toggled while a turn was running; the
   * registry queues the change and applies it at the resume boundary.
   * Lives in registry memory only — not persisted across app restart.
   */
  queuedExecutionMode?: ThreadExecutionMode;
  /** Wall-clock ms when the queue entry was created. */
  queuedExecutionModeAt?: number;
  /**
   * Per-thread permission-mode transition log (audit trail). Persisted
   * via the overlay store, capped at
   * `MAX_PERMISSION_TRANSITION_LOG_ENTRIES` with oldest-first eviction.
   */
  permissionTransitionLog?: ThreadPermissionTransition[];
  /**
   * Per-thread messaging binding transition log. Persisted via the
   * overlay store so bind/unbind actions appear inline in the chat
   * transcript after the navigation snapshot refreshes.
   */
  messagingBindingTransitionLog?: ThreadMessagingBindingTransition[];
  optimisticUserMessage?: {
    text: string;
    imageParts?: AppServerThreadImagePart[];
    createdAt?: number;
  };
  /** Per-thread emoji reactions, ordered by insertion. */
  reactions?: string[];
  /** GitHub pull requests detected for this thread's linked directories + branch. */
  prs?: PrSummary[];
  /** Codex environments discovered from the active thread workspace. */
  codexEnvironmentOptions?: CodexEnvironmentOption[];
  /**
   * Messaging platform conversations bound to this thread. Each binding
   * represents a single conversation (DM, channel, topic, etc.) on one
   * platform. The renderer renders one chip per active binding and lets
   * the user unbind from the desktop side via the chip menu.
   */
  messagingBindings?: MessagingThreadBindingSummary[];
};

/**
 * Renderer-facing slice of a single active messaging binding for a
 * thread. Carries enough to render the chip + the unbind action without
 * exposing the full `MessagingBindingRecord` (which has adapter-opaque
 * routing state the UI must not parse).
 */
export type MessagingThreadBindingSummary = {
  /** Stable id of the binding row in sqlite — pass back to unbind. */
  bindingId: string;
  platform: MessagingChannelKind;
  /**
   * Conversation kind (DM / channel / topic / thread). Drives the chip
   * label prefix: `DM:` for dm, `SG:` for Telegram topic+channel,
   * `SRV:` for Discord channel/thread, etc.
   */
  conversationKind?: MessagingConversationKind;
  /**
   * Title of this conversation node itself (DM peer name, channel
   * name, topic name when known). Renderer-only — not used for routing.
   */
  conversationTitle?: string;
  /**
   * Title of the immediate parent. For Telegram topics this is the
   * supergroup name; for Discord channels it's the guild name; for
   * Discord threads it's the parent channel name.
   */
  parentTitle?: string;
  /**
   * Two levels up. Today: Discord threads — the guild name.
   */
  ancestorTitle?: string;
  /** Wall-clock ms when the binding last had inbound or outbound activity. */
  activeAt?: number;
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

export type CodexEnvironmentOption = {
  id: string;
  name: string;
  sourcePath: string;
  setupScript?: string;
  cleanupScript?: string;
  actions: CodexEnvironmentAction[];
};

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
  registeredAt?: number;
  settingsTouchedAt?: number;
  workMode: LaunchpadWorkMode;
  branchName?: string;
  codexEnvironmentId?: string;
  codexEnvironmentExecutionTarget?: CodexEnvironmentExecutionTarget;
  codexEnvironmentSetupEnabled?: boolean;
  codexEnvironmentActionId?: string;
  codexEnvironmentOptions?: CodexEnvironmentOption[];
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

export type NavigationDirectoryGitStatusUpdatedNotification = {
  method: "navigation/directoryGitStatus/updated";
  params: {
    directoryKey: string;
    gitStatus: NavigationDirectoryGitStatus | null;
    fetchedAt: number;
  };
};

export type RefreshDirectoryGitStatusesRequest = {
  directoryKeys: string[];
  force?: boolean;
};

export type RefreshDirectoryGitStatusesResponse = {
  scheduledCount: number;
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

export type SetThreadPinRequest = {
  backend?: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /** Rank within the pinned section. Null/undefined removes the pin. */
  pinnedRank?: string | null;
};

export type SetThreadPinResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  pinnedRank?: string;
};

export type ReorderThreadPinsRequest = {
  backend?: AppServerBackendKind;
  /** Complete pinned order for this backend, first item at the top. */
  threadIds: ThreadIdentifier[];
};

export type ReorderThreadPinsResponse = {
  backend: AppServerBackendKind;
  pinnedRanks: Record<ThreadIdentifier, string>;
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
  /** `gh` binary discovered. */
  installed: boolean;
  /** Resolved command path PwrAgent will spawn. */
  command?: string;
  /** Version parsed from `gh --version`. */
  version?: string;
  /** Discovery candidates checked while resolving gh. */
  discovery?: DesktopGhDiscoverySnapshot;
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
  codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
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
  /** User-curated position in the pinned section. Undefined means unpinned. */
  pinnedRank?: string;
  /**
   * GitHub pull requests detected for this thread, persisted across
   * restarts so chips appear instantly on relaunch and so we can
   * short-circuit re-fetching once a PR reaches a terminal state
   * (`merged` / `closed`).
   */
  prs?: PrSummary[];
  /** Wall-clock ms when `prs` was last refreshed via gh. */
  prsFetchedAt?: number;
  /**
   * Stable key for the branch + directory inputs used by the last PR
   * refresh. Main only reuses a recent `prs` result when the current
   * request matches this key.
   */
  prsRefreshKey?: string;
  /**
   * Pending permission mode change waiting for the active turn to end.
   * Lives in registry memory only — the overlay store does NOT serialize
   * these two fields across app restart. Surfaced on the navigation
   * snapshot so renderer + messaging can render the queued state.
   */
  queuedExecutionMode?: ThreadExecutionMode;
  queuedExecutionModeAt?: number;
  /**
   * Per-thread permission-mode transition audit log. Persisted to the
   * overlay store, capped at `MAX_PERMISSION_TRANSITION_LOG_ENTRIES`
   * (oldest-first eviction). Each entry records a `queued`, `applied`,
   * or `cancelled` transition; entries linked by the same `queueId`
   * represent the lifecycle of one queued change.
   */
  permissionTransitionLog?: ThreadPermissionTransition[];
  /**
   * Per-thread messaging binding transition audit log. Persisted to
   * the overlay store and rendered as synthetic transcript activity
   * entries for channel bind/unbind actions.
   */
  messagingBindingTransitionLog?: ThreadMessagingBindingTransition[];
};

/**
 * Maximum number of permission-mode transition entries retained per
 * thread in the audit log. Older entries are evicted oldest-first when
 * the cap is exceeded.
 */
export const MAX_PERMISSION_TRANSITION_LOG_ENTRIES = 100;

export type ThreadPermissionTransitionStatus =
  | "queued"
  | "applied"
  | "cancelled";

/**
 * One entry in the per-thread permission-mode audit log. `queueId`
 * links the queued / applied|cancelled pair belonging to a single
 * user-initiated queue lifecycle.
 */
export type ThreadPermissionTransition = {
  /** ULID-shaped id, used as React key + dedupe. */
  id: string;
  fromExecutionMode: ThreadExecutionMode;
  toExecutionMode: ThreadExecutionMode;
  status: ThreadPermissionTransitionStatus;
  /** Epoch ms. */
  occurredAt: number;
  /**
   * Stable id linking the entries that belong to a single queue
   * lifecycle. Present on `queued` entries and propagated to the
   * matching `applied` / `cancelled` entry. Absent for
   * apply-immediately transitions (no queue lifecycle to link).
   */
  queueId?: string;
  /**
   * Optional human-readable note attached to the transition. Used to
   * record edge-case reasons such as auto-cancellation after repeated
   * flush failures.
   */
  note?: string;
};

/**
 * Maximum number of messaging binding transition entries retained per
 * thread. Kept separate from permission transitions so either audit
 * stream can roll independently without evicting the other.
 */
export const MAX_MESSAGING_BINDING_TRANSITION_LOG_ENTRIES = 100;

export type ThreadMessagingBindingTransitionAction = "bound" | "unbound";

/**
 * One entry in the per-thread messaging binding audit log. The title
 * fields mirror `MessagingThreadBindingSummary` so renderer code can
 * format the same conversation breadcrumb without inspecting adapter
 * routing state.
 */
export type ThreadMessagingBindingTransition = {
  id: string;
  action: ThreadMessagingBindingTransitionAction;
  bindingId: string;
  platform: MessagingChannelKind;
  conversationKind?: MessagingConversationKind;
  conversationTitle?: string;
  parentTitle?: string;
  ancestorTitle?: string;
  /** Epoch ms. */
  occurredAt: number;
};

export type ThreadBranchDriftPair = {
  expectedBranch: string;
  observedBranch: string;
  retainedAt: number;
};

export type DirectoryLaunchpadOverlayState = NavigationLaunchpadDraft;
