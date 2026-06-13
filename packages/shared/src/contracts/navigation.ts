import type {
  AcpBackendId,
  AppServerBackendScope,
  AppServerBuiltinBackendKind,
  AppServerBackendKind,
  AppServerThreadActivityEntry,
  AppServerThreadImagePart,
  AppServerThreadSummary,
  CodexEnvironmentAction,
  CodexEnvironmentExecutionTarget,
  CodexThreadEnvironmentRuntime,
  LinkedDirectorySummary,
  ThreadExecutionMode,
  ThreadGitWorkingState,
  ThreadIdentifier,
  WorktreeSnapshotSummary,
} from "./normalized-app-server";
import type {
  MessagingChannelKind,
  MessagingConversationKind,
} from "./messaging";
import type { DesktopGhDiscoverySnapshot } from "./settings";
import type { BackendAcpSessionRuntimeState } from "./backend";
import type { AutomationThreadSummary } from "./automations";
import type {
  TaskMonitorCompletionSource,
  TaskMonitorUsageSnapshot,
} from "./task-monitor-tools";

export type InboxReason = "new-thread" | "updated-since-seen";

export type ThreadInboxState = {
  inInbox: boolean;
  reason?: InboxReason;
  lastSeenAt?: number;
  lastSeenUpdatedAt?: number;
};

export const AGENT_PERSONA_INSTRUCTIONS_LINE_GUIDANCE = 200;

export type ThreadAgentMetadata = {
  name: string;
  instructions?: string;
  instructionLineCount: number;
  instructionsTooLong: boolean;
  updatedAt: number;
};

export type NavigationThreadSummary = AppServerThreadSummary & {
  inbox: ThreadInboxState;
  /**
   * Optional Agent/persona marker. When present, this thread is intended
   * to act as a personal Agent surface that automations can attach to.
   */
  agent?: ThreadAgentMetadata;
  /** User-curated position in the pinned section. Lower ranks sort first. */
  pinnedRank?: string;
  /**
   * UI-only sub-thread relationship. The child remains an independent
   * agent thread; this only controls sidebar grouping.
   */
  parentThreadId?: ThreadIdentifier;
  /** User-curated child order, stored on the parent thread overlay. */
  subthreadOrder?: ThreadIdentifier[];
  /** Persisted disclosure state for the parent's child section. */
  subthreadsCollapsed?: boolean;
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
  /**
   * Per-thread turn-failure audit log. Persisted via the overlay store,
   * capped at `MAX_TURN_FAILURE_LOG_ENTRIES`. Materialized into durable
   * `turn-failed:<turnId>` transcript entries so a failed turn stays
   * visible across reconciliation and restart.
   */
  turnFailureLog?: ThreadTurnFailure[];
  optimisticUserMessage?: {
    text: string;
    imageParts?: AppServerThreadImagePart[];
    createdAt?: number;
  };
  optimisticActiveTurn?: {
    id: ThreadIdentifier;
    statusText?: string;
    startedAt?: number;
    reviewDisplayText?: string;
  };
  /** Per-thread emoji reactions, ordered by insertion. */
  reactions?: string[];
  /** Pull requests known for this thread's linked directories + branch history. */
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
  /**
   * Compact automation state for the thread. Detailed records and run
   * history are fetched through automation IPC; this summary only keeps
   * navigation refreshes and thread chrome honest.
   */
  automationSummary?: AutomationThreadSummary;
  /**
   * Durable summaries of delegated sub-agents (task monitors) spawned from
   * this thread. Stored in the thread overlay so monitor status and cost
   * survive app restart exactly as reported by the monitor lifecycle.
   */
  subAgents?: ThreadSubAgentSummary[];
};

export type ThreadSubAgentStatus =
  | "pending"
  | "running"
  | "blocked"
  | "failed"
  | "success"
  | "failure"
  | "cancelled";

export type ThreadSubAgentSummary = {
  monitorId: string;
  task: string;
  status: ThreadSubAgentStatus;
  createdAt: number;
  updatedAt: number;
  preferredModel?: string;
  preferredReasoningEffort?: string;
  monitorThreadId?: ThreadIdentifier;
  monitorTurnId?: ThreadIdentifier;
  lastMessage?: string;
  outcome?: "success" | "failure" | "cancelled";
  completedAt?: number;
  completionSource?: TaskMonitorCompletionSource;
  monitorUsage?: TaskMonitorUsageSnapshot;
  pollIntervalSeconds?: number;
  heartbeatIntervalSeconds?: number;
  startupTimeoutSeconds?: number;
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

/** Check states drive the PR chip dot color only. */
export type PrChipState =
  | "failing"
  | "passing"
  | "pending"
  | "unknown";

export type PrLegacyChipState = "merged" | "draft" | "closed";

export type PrLifecycleState = "open" | "merged" | "closed";
export type PrReviewState = "draft" | "ready_for_review";
export type PrMergeState = "mergeable" | "conflicting" | "unknown";

export const DEFAULT_PULL_REQUEST_PROVIDER = "github.com";
export type PullRequestProvider = string;

export type PrSummary = {
  /**
   * Forge host that owns the PR namespace, e.g. "github.com" or a future
   * GitHub Enterprise/GitLab host. Owner/repo/number are only unique inside
   * this provider.
   */
  provider: PullRequestProvider;
  number: number;
  /** Repo owner login, e.g. "pwrdrvr". */
  org: string;
  /** Repo name, e.g. "PwrAgent". */
  repo: string;
  /** Last observed pull request title, when the provider returns one. */
  title?: string;
  /**
   * Deprecated compatibility alias for `checkState`. New writers keep this
   * check-only so review/lifecycle/mergeability never collide with checks.
   */
  state: PrChipState | PrLegacyChipState;
  checkState?: PrChipState;
  lifecycleState?: PrLifecycleState;
  reviewState?: PrReviewState;
  mergeState?: PrMergeState;
  url: string;
};

export type DirectorySummaryKind = "directory" | "workspace" | "unlinked";
export type NavigationBrowseMode = "inbox" | "recents" | "directories";
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
  acpRuntime?: BackendAcpSessionRuntimeState;
  providerSettings?: Partial<
    Record<AppServerBackendKind, NavigationLaunchpadProviderSettings>
  >;
};

export type NavigationLaunchpadProviderSettings = {
  executionMode?: ThreadExecutionMode;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  fastMode?: boolean;
  acpRuntime?: BackendAcpSessionRuntimeState;
};

const NAVIGATION_LAUNCHPAD_PROVIDER_SETTING_KEYS = [
  "executionMode",
  "model",
  "reasoningEffort",
  "serviceTier",
  "fastMode",
  "acpRuntime",
] as const satisfies readonly (keyof NavigationLaunchpadProviderSettings)[];

export function extractNavigationLaunchpadProviderSettings(
  source: Partial<NavigationLaunchpadDefaults>,
): NavigationLaunchpadProviderSettings {
  const settings: NavigationLaunchpadProviderSettings = {};
  for (const key of NAVIGATION_LAUNCHPAD_PROVIDER_SETTING_KEYS) {
    if (key in source) {
      settings[key] = source[key] as never;
    }
  }
  return settings;
}

function hasNavigationLaunchpadProviderSettingPatch(
  patch: Partial<NavigationLaunchpadDefaults>,
): boolean {
  return NAVIGATION_LAUNCHPAD_PROVIDER_SETTING_KEYS.some((key) => key in patch);
}

function mergeNavigationLaunchpadProviderSettings(
  current: NavigationLaunchpadProviderSettings,
  patch: NavigationLaunchpadProviderSettings,
): NavigationLaunchpadProviderSettings {
  const next: NavigationLaunchpadProviderSettings = { ...current };
  for (const key of NAVIGATION_LAUNCHPAD_PROVIDER_SETTING_KEYS) {
    if (key in patch) {
      const value = patch[key];
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value as never;
      }
    }
  }
  return next;
}

function isEmptyNavigationLaunchpadProviderSettings(
  settings: NavigationLaunchpadProviderSettings | undefined,
): boolean {
  return !settings || Object.keys(settings).length === 0;
}

function seedNavigationLaunchpadProviderSettings<T extends NavigationLaunchpadDefaults>(
  launchpad: T,
): Partial<Record<AppServerBackendKind, NavigationLaunchpadProviderSettings>> {
  const providerSettings = { ...(launchpad.providerSettings ?? {}) };
  providerSettings[launchpad.backend] = mergeNavigationLaunchpadProviderSettings(
    providerSettings[launchpad.backend] ?? {},
    extractNavigationLaunchpadProviderSettings(launchpad),
  );
  return providerSettings;
}

function clearNavigationLaunchpadProviderFields<T extends NavigationLaunchpadDefaults>(
  launchpad: T,
): T {
  return {
    ...launchpad,
    executionMode: "default",
    model: undefined,
    reasoningEffort: undefined,
    serviceTier: undefined,
    fastMode: undefined,
    acpRuntime: undefined,
  };
}

export function projectNavigationLaunchpadProviderSettings<
  T extends NavigationLaunchpadDefaults,
>(launchpad: T): T {
  const legacySettings = extractNavigationLaunchpadProviderSettings(launchpad);
  const providerSettings = launchpad.providerSettings?.[launchpad.backend];
  const settings = {
    ...legacySettings,
    ...(providerSettings ?? {}),
  };
  return {
    ...launchpad,
    executionMode: settings.executionMode ?? "default",
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    serviceTier: settings.serviceTier,
    fastMode: settings.fastMode,
    acpRuntime: settings.acpRuntime,
  };
}

export function applyNavigationLaunchpadProviderSettingsPatch<
  T extends NavigationLaunchpadDefaults,
>(launchpad: T, patch: Partial<T>): T {
  const providerPatch = extractNavigationLaunchpadProviderSettings(patch);
  const backend = patch.backend ?? launchpad.backend;
  const providerSettings = seedNavigationLaunchpadProviderSettings(launchpad);

  if (hasNavigationLaunchpadProviderSettingPatch(patch)) {
    providerSettings[backend] = mergeNavigationLaunchpadProviderSettings(
      providerSettings[backend] ?? {},
      providerPatch,
    );
    if (isEmptyNavigationLaunchpadProviderSettings(providerSettings[backend])) {
      delete providerSettings[backend];
    }
  }

  const base =
    backend === launchpad.backend
      ? { ...launchpad, ...patch, providerSettings }
      : {
          ...clearNavigationLaunchpadProviderFields(launchpad),
          ...patch,
          backend,
          providerSettings,
        };
  return projectNavigationLaunchpadProviderSettings(base as T);
}

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
  parentThreadId?: string;
  parentThreadTitle?: string;
  /**
   * The thread card this launchpad was spawned from. May differ from
   * `parentThreadId`: forking/sub-threading a child re-parents the new thread to
   * the group root (`parentThreadId`), but the new thread is inserted directly
   * below this source card and the source card renders as the orange "composing"
   * highlight. Undefined for the plain directory new-thread launchpad.
   */
  sourceThreadId?: string;
  codexEnvironmentId?: string;
  codexEnvironmentExecutionTarget?: CodexEnvironmentExecutionTarget;
  /**
   * @deprecated Environment setup execution is config-driven from the selected
   * environment's setup script. This field is kept only so old persisted
   * launchpad rows can deserialize.
   */
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
  /**
   * User-curated position in the pinned section of the Directories
   * lens. Lower numeric ranks (parsed from the string) sort first;
   * undefined means unpinned. Only `kind: "directory"` summaries can
   * carry a `pinnedRank` — the synthesized `workspace` and `unlinked`
   * pseudo-directories are filtered at both the snapshot builder
   * (`buildDirectorySummaries`) and the IPC handler
   * (`setDirectoryPin`) so this field stays meaningful.
   */
  pinnedRank?: string;
};

export type NavigationDirectoryGitStatusUpdatedNotification = {
  method: "navigation/directoryGitStatus/updated";
  params: {
    directoryKey: string;
    gitStatus: NavigationDirectoryGitStatus | null;
    fetchedAt: number;
  };
};

/**
 * Live update for a thread's per-worktree git working state (the
 * dirty/unpushed thread-row chips). Keyed by the thread's working
 * directory (`projectKey` — the worktree path for worktree threads,
 * the checkout path for local threads), so every thread that shares
 * that working directory refreshes together. Published by the main
 * process whenever the background working-state probe lands a fresh
 * result or invalidates a worktree after a git-mutating turn, so chips
 * update without waiting for the next navigation snapshot re-fetch.
 * Mirrors `navigation/directoryGitStatus/updated` for the per-repo
 * directory status row.
 */
export type NavigationThreadGitWorkingStateUpdatedNotification = {
  method: "navigation/threadGitWorkingState/updated";
  params: {
    /** Thread working directory the state was probed for. */
    worktreePath: string;
    gitWorkingState: ThreadGitWorkingState | null;
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

/**
 * One accumulated edited-file group to resolve git commit state for. `key`
 * is the rail's stable group key; `paths` are the absolute file paths the
 * group edited.
 */
export type EditGroupCommitInput = {
  key: string;
  paths: string[];
};

/**
 * Git lifecycle of an edited-file group, resolved against the live worktree
 * (not the agent's command transcript). A group is `committed` when none of
 * its files still have uncommitted working-tree changes; `commitSha` is the
 * most recent commit touching those files, and `pushed` reflects whether that
 * commit is reachable from any remote ref (omitted when it can't be told).
 */
export type EditGroupCommitState = {
  committed: boolean;
  commitSha?: string;
  shortSha?: string;
  pushed?: boolean;
};

export type ResolveEditCommitStatesRequest = {
  worktreePath: string;
  groups: EditGroupCommitInput[];
};

export type ResolveEditCommitStatesResponse = {
  states: Record<string, EditGroupCommitState>;
};

const ACP_BACKEND_ID_PREFIX = "acp:";
const ACP_REGISTRY_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isAppServerBuiltinBackendKind(
  value: string,
): value is AppServerBuiltinBackendKind {
  return value === "codex" || value === "grok";
}

export function buildAcpBackendId(registryId: string): AcpBackendId {
  const normalizedRegistryId = registryId.trim();
  if (!ACP_REGISTRY_ID_PATTERN.test(normalizedRegistryId)) {
    throw new Error(`Invalid ACP registry id: ${registryId}`);
  }
  return `${ACP_BACKEND_ID_PREFIX}${normalizedRegistryId}`;
}

export function isAcpBackendId(value: string): value is AcpBackendId {
  if (!value.startsWith(ACP_BACKEND_ID_PREFIX)) {
    return false;
  }
  return ACP_REGISTRY_ID_PATTERN.test(value.slice(ACP_BACKEND_ID_PREFIX.length));
}

export function isAppServerBackendKind(
  value: string,
): value is AppServerBackendKind {
  return isAppServerBuiltinBackendKind(value) || isAcpBackendId(value);
}

export type ThreadIdentityKeyParts = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
};

export function buildThreadIdentityKey(
  backend: AppServerBackendKind,
  threadId: ThreadIdentifier,
): string {
  return `${encodeURIComponent(backend)}:${threadId}`;
}

export function parseThreadIdentityKey(
  threadKey: string,
): ThreadIdentityKeyParts | undefined {
  const separatorIndex = threadKey.indexOf(":");
  if (separatorIndex <= 0) {
    return undefined;
  }

  let backend: string;
  try {
    backend = decodeURIComponent(threadKey.slice(0, separatorIndex));
  } catch {
    return undefined;
  }

  if (!isAppServerBackendKind(backend)) {
    return undefined;
  }

  return {
    backend,
    threadId: threadKey.slice(separatorIndex + 1),
  };
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

export type SetNavigationBrowseModeRequest = {
  browseMode: NavigationBrowseMode;
};

export type SetNavigationBrowseModeResponse = {
  browseMode: NavigationBrowseMode;
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

export type SetThreadAgentRequest = {
  backend?: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /**
   * Null removes the Agent marker. Non-null marks this thread as an
   * Agent/persona thread with compact instructions.
   */
  agent: {
    name: string;
    instructions?: string;
  } | null;
};

export type SetThreadAgentResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  agent?: ThreadAgentMetadata;
};

export type ReorderThreadPinsRequest = {
  /**
   * Complete pinned order across ALL backends, first item at the top.
   * Entries are thread identity keys (`buildThreadIdentityKey`), so a Codex
   * pin and an ACP pin can be interleaved in any order — pin order is global,
   * not per-backend (mirrors directory pinning).
   */
  threadKeys: string[];
};

export type ReorderThreadPinsResponse = {
  /** Thread identity key -> pin rank. */
  pinnedRanks: Record<string, string>;
};

export type SetThreadParentRequest = {
  backend?: AppServerBackendKind;
  threadId: ThreadIdentifier;
  parentThreadId?: ThreadIdentifier | null;
};

export type SetThreadParentResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  parentThreadId?: ThreadIdentifier;
};

export type UpdateSubthreadOrderRequest = {
  backend?: AppServerBackendKind;
  parentThreadId: ThreadIdentifier;
  threadIds: ThreadIdentifier[];
};

export type UpdateSubthreadOrderResponse = {
  backend: AppServerBackendKind;
  parentThreadId: ThreadIdentifier;
  threadIds: ThreadIdentifier[];
};

export type SetSubthreadsCollapsedRequest = {
  backend?: AppServerBackendKind;
  parentThreadId: ThreadIdentifier;
  collapsed: boolean;
};

export type SetSubthreadsCollapsedResponse = {
  backend: AppServerBackendKind;
  parentThreadId: ThreadIdentifier;
  collapsed: boolean;
};

/**
 * Directory pinning (mirror of thread pinning, sans the `backend`
 * dimension). Directory keys are globally unique — a directory
 * contains threads from any backend, so the pin order is global, not
 * per-backend. The IPC handler additionally rejects non-`directory`
 * `kind` summaries (workspace / unlinked pseudo-directories cannot
 * be pinned).
 */
export type SetDirectoryPinRequest = {
  directoryKey: string;
  /** Rank within the pinned section. Null/undefined removes the pin. */
  pinnedRank?: string | null;
};

export type SetDirectoryPinResponse = {
  directoryKey: string;
  pinnedRank?: string;
};

export type ReorderDirectoryPinsRequest = {
  /** Complete pinned order, first item at the top. */
  directoryKeys: string[];
};

export type ReorderDirectoryPinsResponse = {
  pinnedRanks: Record<string, string>;
};

export type RefreshThreadPullRequestsRequest = {
  backend?: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /** Forge host for this lookup. Defaults to github.com while GitHub is the only provider. */
  provider?: PullRequestProvider;
  /**
   * Refresh intent controls main-process coalescing. Scheduled polling is
   * rate-limited globally and per PR; direct user interaction gets a much
   * shorter per-PR cooldown and bypasses the global GitHub token bucket.
   */
  trigger?: "scheduled" | "user";
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
  provider: PullRequestProvider;
  prs: PrSummary[];
  /** True when the host doesn't have `gh` installed; degrade silently. */
  ghAvailable: boolean;
  /**
   * True when main short-circuited the gh fetch because the lookup's
   * known PRs are already in terminal lifecycle states (`merged` or
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

/**
 * Persisted per-directory overlay. Today this only carries
 * `pinnedRank` (directory pinning), but the shape is intentionally
 * extensible so future per-directory state (e.g., a user-curated
 * label, a tracked-only-when-active flag, etc.) lands here rather
 * than in scattered tables. Mirrors `ThreadOverlayState`'s "single
 * JSON payload per row, keyed by identity" pattern.
 */
export type DirectoryOverlayState = {
  /**
   * Stable directory key from the navigation snapshot. Matches the
   * `key` field on `NavigationDirectorySummary`. For `kind:
   * "directory"` summaries this is `"directory:<path>"`; the pin
   * IPC handler rejects any non-directory key so workspace /
   * unlinked summaries never land here.
   */
  directoryKey: string;
  /** User-curated position in the pinned section. Undefined = unpinned. */
  pinnedRank?: string;
};

export type ThreadOverlayState = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  agent?: ThreadAgentMetadata;
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
   * Cached repository resolution for an ACP worktree thread. ACP sessions
   * only report their working directory; mapping a tool-managed worktree cwd
   * to its parent repository checkout requires following the worktree's `.git`
   * gitdir link (filesystem only — we never spawn git for this). That mapping
   * is immutable for a given worktree path, so we resolve it once and persist
   * it here, then reuse it on every later thread-list read instead of touching
   * the filesystem again. `cwd` records the session directory the resolution
   * was computed for, so a session rebind to a different workspace re-resolves.
   * `directory` is repo-rooted (`path` = repo, `worktreePath` = the worktree),
   * which is what lets the thread group under its repository row alongside
   * Codex threads of the same repo. Only successful resolutions are stored;
   * a non-worktree / vanished cwd is left uncached so it is retried cheaply.
   */
  acpWorktreeDirectory?: {
    cwd: string;
    directory: LinkedDirectorySummary;
  };
  /**
   * Per-thread emoji reactions. Single-user model: each emoji appears at
   * most once, ordered by insertion. Used as personal status markers
   * (e.g., "needs follow-up"), not multi-user voting.
   */
  reactions?: string[];
  /** User-curated position in the pinned section. Undefined means unpinned. */
  pinnedRank?: string;
  /**
   * UI-only parent relationship. This does not grant the child agent
   * access to the parent transcript or state.
   */
  parentThreadId?: ThreadIdentifier;
  /** Child thread ids in user-curated order, stored on the parent. */
  subthreadOrder?: ThreadIdentifier[];
  /** Persisted disclosure state for the parent's child section. */
  subthreadsCollapsed?: boolean;
  /**
   * Pull requests known for this thread, persisted across restarts so chips
   * appear instantly on relaunch. The list is append-only by PR identity for
   * sidebar/history purposes; status refreshes replace matching entries.
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
   * PwrAgent-authored finalized token usage rows. These are immutable
   * transcript activities because provider hydration can later report a
   * narrower per-request usage payload for the same completed turn.
   */
  immutableUsageActivities?: AppServerThreadActivityEntry[];
  /** Durable delegated sub-agent/task-monitor summaries for this thread. */
  subAgents?: ThreadSubAgentSummary[];
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
  /**
   * Per-thread turn-failure audit log. Persisted to the overlay store,
   * capped at `MAX_TURN_FAILURE_LOG_ENTRIES` (oldest-first eviction).
   * Each entry records a backend `turn/failed` outcome and is rendered as
   * a synthetic `turn-failed:<turnId>` transcript activity entry.
   */
  turnFailureLog?: ThreadTurnFailure[];
};

/**
 * Maximum number of permission-mode transition entries retained per
 * thread in the audit log. Older entries are evicted oldest-first when
 * the cap is exceeded.
 */
export const MAX_PERMISSION_TRANSITION_LOG_ENTRIES = 100;

export const MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES = 100;

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
  /**
   * Optional provider-native labels for non-Codex access modes. Codex
   * transitions continue to derive labels from the execution-mode enum.
   */
  fromLabel?: string;
  toLabel?: string;
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

/**
 * Maximum number of turn-failure entries retained per thread in the
 * audit log. Older entries are evicted oldest-first when the cap is
 * exceeded. Kept separate from the permission/messaging audit streams
 * so each rolls independently.
 */
export const MAX_TURN_FAILURE_LOG_ENTRIES = 100;

/**
 * One entry in the per-thread turn-failure audit log. Persisted via the
 * overlay store and materialized by the renderer into a durable
 * `turn-failed:<turnId>` transcript activity entry at the moment the
 * turn failed. This is how a backend `turn/failed` outcome survives both
 * `readThread` reconciliation and app restart — Codex does not persist a
 * failure marker in its own transcript, so we keep our own.
 */
export type ThreadTurnFailure = {
  /** Stable id, used as a React key + dedupe handle. */
  id: string;
  /**
   * The failed turn's id. The renderer derives the synthetic transcript
   * entry id (`turn-failed:<turnId>`) from this, which also lets it dedupe
   * against backends (e.g. ACP) that already emit their own failure entry.
   */
  turnId: string;
  /** Human-readable failure reason surfaced from the backend event. */
  error: string;
  /**
   * Epoch ms when the failure was observed. Preserved verbatim as the
   * transcript entry timestamp so the warning lands where it happened.
   */
  occurredAt: number;
};

export type ThreadBranchDriftPair = {
  expectedBranch: string;
  observedBranch: string;
  retainedAt: number;
};

export type DirectoryLaunchpadOverlayState = NavigationLaunchpadDraft;
