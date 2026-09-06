import type { AutomationRunOutputDecision } from "./automations";
import type { ScheduledThreadAction } from "./scheduled-thread-actions";
import type {
  MessagingChannelKind,
  MessagingConversationKind,
} from "./messaging";
import type { CelestialIconAssignment, CelestialIconId } from "./celestial";
import type { StarMapArrangementEntry, StarMapIntakePhase } from "./star-map";
import type {
  FederationConnectionState,
  FederationInstanceId,
  FederationTarget,
} from "./federation";
import type {
  PrSummary,
  ThreadPrAutoDispatchEventKind,
  ThreadPrAutoDispatchPending,
  ThreadSubAgentSummary,
} from "./navigation";
import type {
  ThreadPricingSummary,
  ThreadSpendAlert,
  ThreadUsageLineRecord,
} from "../token-usage-pricing";
import type { ThreadToolIncidentNoticeState } from "./tool-output-incidents";

export type AppServerBuiltinBackendKind = "codex";
export type AcpBackendId = `acp:${string}`;
export type AppServerBackendKind = AppServerBuiltinBackendKind | AcpBackendId;
export type AppServerBackendScope = AppServerBackendKind | "all";
export type ThreadExecutionMode = "default" | "full-access";

export type ThreadIdentifier = string;

export type AppServerTextInputItem = {
  type: "text";
  text: string;
};

export type AppServerImageInputItem = {
  type: "image";
  /** User-visible filename / attachment label when available. */
  name?: string;
  url: string;
};

export type AppServerLocalImageInputItem = {
  type: "localImage";
  /** User-visible filename / attachment label when available. */
  name?: string;
  path: string;
};

export type AppServerPdfRenderProfile = "low" | "medium" | "high" | "actual";

/**
 * Explicit local-file reference supplied by the desktop composer. The main
 * process may classify and consume supported document types before forwarding
 * the turn to a backend.
 */
export type AppServerLocalFileInputItem = {
  type: "localFile";
  /** User-visible filename / attachment label when available. */
  name?: string;
  path: string;
  /** Best-effort MIME type inferred without reading the full file. */
  mimeType?: string;
  /** Size observed from the explicitly referenced local file. */
  sizeBytes?: number;
  /** Bounded preview included only for a validated, small UTF-8 text file. */
  textPreview?: string;
  /** True when textPreview contains only a prefix of the validated file. */
  textPreviewTruncated?: boolean;
  /** Rendering preference when this local file is classified as a PDF. */
  pdfRenderProfile?: AppServerPdfRenderProfile;
};

export type AppServerFileInputItem = {
  type: "file";
  name: string;
  mimeType: string;
  data: string;
  sizeBytes?: number;
  /** Rendering preference when this file is classified as a PDF. */
  pdfRenderProfile?: AppServerPdfRenderProfile;
};

export type AppServerSkillSummary = {
  name: string;
  description?: string;
  shortDescription?: string;
  path?: string;
  enabled?: boolean;
  scope?: string;
};

export type AppServerAvailableCommandSummary = {
  name: string;
  description?: string;
  aliases?: string[];
  backend?: AppServerBackendKind;
  scope?: "backend" | "session";
  source?: "provider";
};

export type AppServerTurnInputItem =
  | AppServerTextInputItem
  | AppServerImageInputItem
  | AppServerLocalImageInputItem
  | AppServerLocalFileInputItem
  | AppServerFileInputItem;

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
  /**
   * The reviewer's own confidence, from 0 to 1, that `overall_correctness` is
   * the right verdict. Absent when the reviewer did not report one — readers
   * must render the verdict without a number rather than substituting zero.
   */
  overall_confidence_score?: number;
};

/**
 * Identity of the pull request a review was about. Deliberately carries no
 * check, review, or merge status: this is frozen at review start and a status
 * frozen alongside it would still be painting last month's CI result today.
 * Callers that want live status look the PR up by this identity.
 */
export type AppServerReviewPullRequest = {
  /** Forge host that owns the PR namespace, e.g. "github.com". */
  provider: string;
  org: string;
  repo: string;
  number: number;
  url: string;
  title?: string;
  headRefName?: string;
  baseRefName?: string;
};

/**
 * Where a review ran, captured when it started. A thread can link several Git
 * directories and a review runs in exactly one of them, so this belongs to the
 * review artifact rather than to the thread's ambient state — the same reason
 * `reviewer` does. Resolving it at render time would relabel a month-old card
 * with today's workspace and today's pull requests.
 */
export type AppServerReviewContext = {
  /** Absolute workspace the review ran in — the `cwd` on StartReviewRequest. */
  workspacePath: string;
  /** Linked-directory label for `workspacePath`, e.g. "PwrAgent". */
  projectLabel?: string;
  /** Repository checkout when `workspacePath` is one of its worktrees. */
  repositoryPath?: string;
  /**
   * Branch checked out in `workspacePath` at start. Absent when there was no
   * branch to read — a commit target, or a detached HEAD.
   */
  gitBranch?: string;
  /**
   * Base the diff was taken against, when the target named one. Lets a reader
   * tell a review against the PR's own base from one against an override.
   */
  baseBranch?: string;
  /**
   * The pull request open on `gitBranch` in this workspace at start.
   *
   * `null` means the branch was checked and carried none. Absent means no
   * check was possible — there was no branch, or no PR data had been fetched.
   * The two are not interchangeable: one is an answer, the other is a gap.
   *
   * Never a list. A pull request that is not on the reviewed branch is not
   * evidence about the reviewed diff, and printing the thread's other PRs here
   * would imply a connection that does not exist.
   */
  pullRequest?: AppServerReviewPullRequest | null;
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
  /** Best-effort branch observed for this linked directory/worktree. */
  gitBranch?: string;
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

/**
 * A single invocation of a Codex environment action. Multiple runs can be
 * alive at once on the same thread (e.g. "Start" + "E2E Tests" + "Unit
 * Tests" running in parallel). Each run has a unique `runId` so output
 * snapshots and exit events can be attributed to the right invocation
 * even when the run order interleaves.
 */
export type CodexEnvironmentActionRun = {
  /** Unique per invocation. Generated at action-start time in the backend. */
  runId: string;
  /** Which configured action this is a run of (matches CodexEnvironmentAction.id). */
  actionId: string;
  actionName: string;
  command: string;
  status: "started" | "exited" | "failed";
  pid?: number;
  startedAt: number;
  exitedAt?: number;
  exitCode?: number;
  exitSignal?: string;
  durationMs?: number;
  output?: string;
  /**
   * User-requested process-tree shutdown. While status remains "started",
   * this means PwrAgent has already sent a signal and is waiting for the
   * process close callback to report the final exit details.
   */
  terminationRequestedAt?: number;
  terminationMode?: "stop" | "terminate";
};

export type CodexThreadEnvironmentRuntime = {
  environmentId: string;
  environmentName: string;
  executionTarget: CodexEnvironmentExecutionTarget;
  selectedActionIdByEnvironmentId?: Record<string, string>;
  /**
   * CWD used when this environment runtime was selected or last launched.
   * This is persisted runtime state and can become stale after workspace
   * handoff. New commands should use the current thread workspace path
   * (LinkedDirectorySummary.worktreePath/path, or an explicit Run request cwd)
   * and then update this value.
   */
  cwd?: string;
  setupStatus?: "skipped" | "completed" | "failed";
  setupCommand?: string;
  setupOutput?: string;
  setupExitCode?: number;
  setupDurationMs?: number;
  /**
   * When the operator resolved the failure prompt this runtime raised — by
   * continuing anyway, or by the thread moving on without them.
   *
   * `setupStatus: "failed"` and a failed entry in `actionRuns` are permanent
   * historical facts: nothing ever rewrites them, and the transcript keeps its
   * own `codex-environment-setup-*` activity entry with the same output. The
   * decision prompt they raise is not permanent, so it needs its own state.
   * Without this the prompt was suppressed only by the thread having messages,
   * which is also false while a thread hydrates — so it came back on every
   * open, weeks later, until the transcript finished loading.
   *
   * A failure that happens *after* this timestamp raises the prompt again.
   */
  setupFailureAcknowledgedAt?: number;
  /**
   * Non-secret toolchain environment captured after a successful local
   * Codex environment setup. Used by PwrAgent to start local Codex
   * app-server threads with the same PATH/version-manager context.
   */
  shellEnvironment?: Record<string, string>;
  actions?: CodexEnvironmentAction[];
  /**
   * Live + recently-finished action invocations on this thread, oldest
   * first. Multiple runs can be present simultaneously when parallel
   * actions (Start + Test, E2E + Unit, etc.) are kicked off. Capped
   * server-side; oldest non-running entries are evicted first when the
   * cap is exceeded.
   */
  actionRuns?: CodexEnvironmentActionRun[];
  sourcePath?: string;

  // --- Legacy fields, preserved for read-compatibility with overlay rows
  // persisted before the multi-instance refactor. NEW code MUST NOT read
  // these; on read, BackendRegistry normalises them into a synthesised
  // single-element actionRuns array. They are not written by current
  // code, so they will eventually disappear from disk as runtimes get
  // rewritten.
  /** @deprecated read via `actionRuns` */
  actionId?: string;
  /** @deprecated read via `actionRuns` */
  actionName?: string;
  /** @deprecated read via `actionRuns` */
  actionCommand?: string;
  /** @deprecated read via `actionRuns` */
  actionStatus?: "started" | "exited" | "failed";
  /** @deprecated read via `actionRuns` */
  actionPid?: number;
  /** @deprecated read via `actionRuns` */
  actionStartedAt?: number;
  /** @deprecated read via `actionRuns` */
  actionExitedAt?: number;
  /** @deprecated read via `actionRuns` */
  actionExitCode?: number;
  /** @deprecated read via `actionRuns` */
  actionExitSignal?: string;
  /** @deprecated read via `actionRuns` */
  actionDurationMs?: number;
  /** @deprecated read via `actionRuns` */
  actionOutput?: string;
};

/** Maximum entries kept in `actionRuns`. Running entries are never evicted. */
export const CODEX_ENVIRONMENT_ACTION_RUNS_MAX = 10;

export type AppServerThreadTitleSource = "explicit" | "derived" | "fallback";

/**
 * The provenance a rename is allowed to announce.
 *
 * `fallback` is absent on purpose. In a thread summary it means "this thread
 * has no name yet", which is why `ThreadChip`, the quit dialog, and the
 * federated summary cache all read it as "show something else instead". A
 * rename carries a name, so announcing one as `fallback` tells every consumer
 * to discard the very title being announced. The ACP prompt-derived stopgap
 * does store `fallback` against its own session — there it means "replaceable
 * by a better title", a different question — and that value must not reach
 * the wire.
 */
export type AppServerRenamedTitleSource = Exclude<
  AppServerThreadTitleSource,
  "fallback"
>;

/**
 * Read the provenance off a rename notification.
 *
 * Both recorders need this and neither can trust its input: the renderer reads
 * payloads a federated peer built, and a peer on another build can send
 * anything. Silence means `explicit` — that is what every consumer assumed
 * before the field existed, and it is what a provider-forwarded rename still
 * means, since no provider reports provenance.
 */
export function normalizeRenamedTitleSource(
  value: unknown,
): AppServerRenamedTitleSource {
  return value === "derived" ? "derived" : "explicit";
}

export type AppServerThreadStatus = "active" | "idle" | "notLoaded" | "unknown";

/** Provider provenance carried by a native Codex `spawn_agent` thread. */
export type CodexNativeSubAgentProvenance = {
  parentThreadId: ThreadIdentifier;
  depth?: number;
  agentNickname?: string;
  agentRole?: string;
};

/**
 * A native Codex worker grouped under its ordinary parent for on-demand
 * navigation disclosure. It is intentionally not a navigable thread row.
 */
export type CodexNativeSubAgentSummary = {
  threadId: ThreadIdentifier;
  title: string;
  createdAt?: number;
  updatedAt?: number;
  threadStatus?: AppServerThreadStatus;
  depth?: number;
  agentNickname?: string;
  agentRole?: string;
};

export type AppServerAcpSessionRuntimeState = {
  configValues?: Record<string, string>;
  currentModeId?: string;
  currentModelId?: string;
  reasoningEffort?: string;
  updatedAt?: number;
};

/**
 * Snapshot of local git working-tree state for a thread's working
 * directory: uncommitted change totals plus commits that exist on no
 * remote ref. Computed by the thread directory enricher alongside
 * `observedGitBranch`; absent when the directory is not a git checkout
 * or the probe failed.
 */
export type ThreadGitWorkingState = {
  /** Files with staged or unstaged modifications vs HEAD. */
  dirtyFiles: number;
  /** Added lines across staged + unstaged changes vs HEAD. */
  dirtyAdditions: number;
  /** Removed lines across staged + unstaged changes vs HEAD. */
  dirtyDeletions: number;
  /** Untracked files. */
  untrackedFiles: number;
  /** Local commits not present on any remote ref (0 when no remotes). */
  unpushedCommits: number;
  /** Best-effort git-derived branch this work appears to be based on. */
  baseBranch?: string;
  /** Merge-base commit between HEAD and `baseBranch`. */
  baseCommit?: string;
  /** Current tip commit of `baseBranch` when probed. */
  baseTipCommit?: string;
  /** Commits on `baseBranch` after `baseCommit`; > 0 means this work is behind its base. */
  baseBehindCommitCount?: number;
  /** Commits on HEAD after `baseCommit`. */
  baseAheadCommitCount?: number;
  /** True when `baseBranch` has commits after `baseCommit`. */
  isBehindBase?: boolean;
};

export type AppServerThreadSummary = {
  id: ThreadIdentifier;
  title: string;
  titleSource: AppServerThreadTitleSource;
  /** Current backend runtime status when exposed by the thread-list protocol. */
  threadStatus?: AppServerThreadStatus;
  summary?: string;
  projectKey?: string;
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number;
  linkedDirectories: LinkedDirectorySummary[];
  gitBranch?: string;
  gitOriginUrl?: string;
  observedGitBranch?: string;
  gitWorkingState?: ThreadGitWorkingState;
  source: AppServerBackendKind;
  executionMode?: ThreadExecutionMode;
  model?: string;
  serviceTier?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  acpRuntime?: AppServerAcpSessionRuntimeState;
  workspaceHandoff?: {
    available: boolean;
    unavailableReason?: string;
  };
  codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
  worktreeSnapshots?: WorktreeSnapshotSummary[];
  /** Native Codex provenance when this summary itself is a spawned worker. */
  codexNativeSubAgent?: CodexNativeSubAgentProvenance;
  /**
   * Native Codex workers grouped below this ordinary parent. Rendered only
   * through the parent-scoped, on-demand Sub-agents disclosure.
   */
  codexNativeSubAgents?: CodexNativeSubAgentSummary[];
};

export type AppServerThreadMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  parts?: AppServerThreadMessagePart[];
  origin?: AppServerThreadMessageOrigin;
  createdAt?: number;
};

export type AppServerThreadMessageOriginKind =
  | "agent"
  | "automation"
  | "messaging"
  | "pwragent"
  | "sub-agent";

export type AppServerThreadMessageOrigin = {
  kind: AppServerThreadMessageOriginKind;
  sourceThread?: {
    /** Sender correspondence message, when PwrAgent has a durable breadcrumb. */
    messageId?: string;
    backend: AppServerBackendKind;
    /** Durable owner identity when the source thread belongs to another instance. */
    instanceId?: FederationInstanceId;
    /** Hydrated owner label so provenance stays useful without mounting the source thread. */
    instanceLabel?: string;
    /** Hydrated owner identity icon, matching remote thread rows. */
    celestialIcon?: CelestialIconId;
    threadId: ThreadIdentifier;
    title?: string;
  };
  messaging?: {
    platform: MessagingChannelKind;
    sourceUrl?: string;
    surface: {
      id: string;
      kind: MessagingConversationKind;
      title?: string;
      parentTitle?: string;
      ancestorTitle?: string;
    };
    actor: {
      platformUserId: string;
      displayName?: string;
      phoneNumber?: string;
      username?: string;
    };
  };
  subAgent?: {
    kind: "monitor";
    monitorId: string;
    task: string;
    outcome: "success" | "failure" | "cancelled";
    summary: string;
  };
  prAutomation?: {
    kind: "auto-fix" | "watch";
    prKey: string;
    prNumber: number;
    prTitle?: string;
    failedCheckUrl?: string;
    headSha: string;
    eventKinds?: ThreadPrAutoDispatchEventKind[];
    outcome?: "success" | "failure";
  };
};

export type AppServerThreadTextPart = {
  type: "text";
  text: string;
};

export type AppServerThreadImagePart = {
  type: "image";
  url: string;
  alt?: string;
  /**
   * Canonical local source URL when this image was discovered from a Markdown
   * link. The renderer uses it to make the original link open the same image
   * in PwrAgent rather than delegating it to an external editor.
   */
  sourceUrl?: string;
};

export type AppServerThreadFilePart = {
  type: "file";
  name: string;
  mimeType?: string;
  sizeBytes?: number;
};

export type AppServerThreadMessagePart =
  | AppServerThreadTextPart
  | AppServerThreadImagePart
  | AppServerThreadFilePart;

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

/**
 * A live transcript message that must never be added to a thread replay.
 * Consumers may replace its active value or retain bounded, in-memory settled
 * segments alongside replay entries. They must discard those segments on
 * reload, compaction, or cache eviction.
 */
export type AppServerTransientThreadMessageEntry = AppServerThreadMessage & {
  type: "transientMessage";
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

export type AppServerThreadFileDiffRef = {
  source: "live" | "thread";
  key: string;
  threadId: string;
  entryId: string;
  detailId: string;
  backend?: AppServerBackendKind;
};

export type AppServerThreadFileDiff = {
  kind: AppServerThreadFileChangeKind;
  diff: string;
  diffRef?: AppServerThreadFileDiffRef;
  diffRefs?: AppServerThreadFileDiffRef[];
  additions: number;
  removals: number;
  omittedReason?: string;
  originalLength?: number;
};

export type AppServerThreadCommandDetail = {
  displayCommand: string;
  rawCommand?: string;
  source?: "shell" | "tool" | "agent";
  cwd?: string;
  output?: string;
  exitCode?: number;
  durationMs?: number;
  /** Structured lifecycle data for delegated agent work. */
  subAgent?: AppServerThreadSubAgentCallDetail;
};

export type AppServerThreadSubAgentCallDetail = {
  backend: AppServerBackendKind;
  origin: "codex-native" | "pwragent";
  operation: "spawn" | "wait" | "send_input" | "resume" | "close" | "unknown";
  agents: Array<{
    threadId: string;
    name?: string;
    status?: string;
    message?: string;
  }>;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
};

export type AppServerThreadActivityDetail = {
  id: string;
  kind: "read" | "write" | "command";
  label: string;
  images?: AppServerThreadImagePart[];
  markdown?: string;
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
  usageLine?: ThreadUsageLineRecord;
};

export type GetThreadFileDiffRequest = {
  ref: AppServerThreadFileDiffRef;
};

export type GetThreadFileDiffResponse = {
  diff?: string;
  omittedReason?: string;
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
  /**
   * The provider runtime that produced this review. Reviews may run on a
   * different provider than their parent thread, so this belongs to the
   * review artifact rather than to the thread's ambient settings.
   */
  reviewer?: {
    backend: AppServerBackendKind;
    model?: string;
    reasoningEffort?: string;
  };
  /**
   * Workspace, branch, and pull request this review was about, frozen at
   * start. Absent on reviews that predate the capture — render nothing rather
   * than an "unknown" row on every historical card.
   */
  context?: AppServerReviewContext;
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
  /** Native Codex nickname when a replay belongs to a delegated sub-agent. */
  agentName?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  pagination: AppServerThreadReplayPagination;
  threadStatus?: AppServerThreadStatus;
};

export type AppServerListThreadsRequest = {
  backend?: AppServerBackendKind;
  archived?: boolean;
  federationTarget?: FederationTarget;
  filter?: string;
};

export type AppServerListThreadsResponse = {
  backend: AppServerBackendScope;
  fetchedAt: number;
  threads: AppServerThreadSummary[];
  workspaceRoots?: string[];
};

export type ResolveThreadRequest = {
  backend?: AppServerBackendKind;
  threadId: ThreadIdentifier;
};

export type ResolveThreadResponse = {
  thread?: AppServerThreadSummary;
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
  federationTarget?: FederationTarget;
};

export type ArchiveThreadResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  archivedAt: number;
  cleanup: ArchiveThreadCleanupResult[];
};

/**
 * Answers a `codex/missingThreads/updated` confirmation prompt. `archive`
 * tombstones the threads Codex lost; `keep` leaves them in place and stops
 * PwrAgent from re-asking for the rest of the session, which is the right
 * answer when this PwrAgent profile is pointed at the wrong Codex profile.
 */
export type ResolveMissingCodexThreadsRequest = {
  action: "archive" | "keep";
  threadIds: ThreadIdentifier[];
};

export type ResolveMissingCodexThreadsResponse = {
  action: "archive" | "keep";
  archivedThreadIds: ThreadIdentifier[];
  failedThreadIds: ThreadIdentifier[];
};

export type RestoreThreadRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
};

export type RestoreThreadWorktreeResult = {
  worktreePath: string;
  repositoryPath?: string;
  snapshotRef?: string;
  restored: boolean;
  snapshot?: WorktreeSnapshotSummary;
  skippedReason?: string;
  error?: string;
};

export type RestoreThreadResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  restoredAt: number;
  worktrees?: RestoreThreadWorktreeResult[];
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

export const THREAD_WORKSPACE_HANDOFF_DIRECTIONS = [
  "local-to-worktree",
  "worktree-to-local",
] as const;

export type ThreadWorkspaceHandoffDirection =
  (typeof THREAD_WORKSPACE_HANDOFF_DIRECTIONS)[number];

export const THREAD_WORKSPACE_HANDOFF_STRATEGIES = [
  "move-branch",
  "detached-changes",
  "new-branch",
] as const;

export type ThreadWorkspaceHandoffStrategy =
  (typeof THREAD_WORKSPACE_HANDOFF_STRATEGIES)[number];

export type ThreadWorkspaceHandoffStashSummary = {
  ref?: string;
  message: string;
  path: string;
  applied: boolean;
  dropped: boolean;
};

export type HandoffThreadWorkspaceRequest = {
  backend: AppServerBackendKind;
  federationTarget?: FederationTarget;
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
  federationTarget?: FederationTarget;
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
  federationTarget?: FederationTarget;
  threadId: ThreadIdentifier;
  includeTurns?: boolean;
  before?: string;
  limit?: number;
  /**
   * Return every persisted tool invocation instead of the ordinary 200-row
   * thread-snapshot cap. Reserved for the thread-scoped incident explorer,
   * which must agree with explicit full-history analysis coverage.
   */
  includeAllToolInvocations?: boolean;
  /**
   * Reads transcript data without applying PwrAgent's normal selected-thread
   * enrichment writes. Used by inspection-only secondary windows such as the
   * native sub-agent transcript viewer.
   */
  viewOnly?: boolean;
};

export type AppServerReadThreadResponse = {
  backend: AppServerBackendKind;
  fetchedAt: number;
  /**
   * Wall-clock time spent by the owning backend registry producing this
   * thread read. Renderers may retain the first successful value in memory as
   * the thread's initial-load duration.
   */
  readDurationMs?: number;
  threadId: ThreadIdentifier;
  /** Effective Token Miser state after applying the owning profile's gate and default. */
  tokenMiserEnabled?: boolean;
  /** Persisted per-thread Token Miser override; absent follows the default. */
  tokenMiserOverride?: boolean;
  replay: AppServerThreadReplay;
  /**
   * A server request still awaiting an operator response. This lets a freshly
   * loaded renderer recover an input or approval prompt that arrived while it
   * was restarting or disconnected from main-process events.
   */
  pendingRequest?: AppServerPendingRequestNotification;
  pricing?: {
    /** Observed context compactions, oldest first. */
    compactions?: ThreadCompactionRecord[];
    lines: ThreadUsageLineRecord[];
    summaries: ThreadPricingSummary[];
  };
  toolAccounting?: ThreadToolAccounting;
  threadStatus?: AppServerThreadStatus;
};

export type ThreadToolInvocationCategory =
  | "build-test"
  | "file-io"
  | "git"
  | "mcp"
  | "package-manager"
  | "polling"
  | "search"
  | "shell"
  | "sub-agent"
  | "unknown";

export type ThreadToolInvocationStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type ThreadToolInvocationSource = "history" | "live";

export type ThreadToolInvocationOutputState =
  | "available"
  | "compacted"
  | "truncated"
  | "unavailable";

/**
 * One observed context compaction.
 *
 * Compaction is the boundary that ends a preserved tool payload's replay life,
 * and the first request after it re-sends the whole surviving context uncached.
 * The replay fold already classifies that request as a cold replay, but a cold
 * replay can equally be prompt-cache expiry or a long gap between turns — the
 * `cold*` fields exist to name the ones compaction actually caused.
 */
export type ThreadCompactionRecord = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId?: string;
  /** Compaction marker item, when the backend reports one. */
  itemId?: string;
  compactionId: string;
  observedAt: number;
  /** The first priced request observed after this compaction, once it lands. */
  coldUsageLineId?: string;
  coldUncachedTokens?: number;
  coldCostMicros?: number;
  updatedAt: number;
};

export type ThreadToolInvocationRecord = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId?: string;
  itemId: string;
  invocationId: string;
  /** Stable finding identity. Historical IDs are deterministic across rescans. */
  findingId?: string;
  toolName: string;
  normalizedCommand?: string;
  category: ThreadToolInvocationCategory;
  status: ThreadToolInvocationStatus;
  startedAt?: number;
  completedAt?: number;
  observedAt: number;
  updatedAt: number;
  sessionId?: string;
  processId?: string;
  exitCode?: number;
  outputChars: number;
  outputLines: number;
  estimatedOutputTokens: number;
  warningLines: number;
  errorLines: number;
  infoLines: number;
  debugLines: number;
  outputTruncated: boolean;
  outputState?: ThreadToolInvocationOutputState;
  source?: ThreadToolInvocationSource;
  noisy: boolean;
  noisyReason?: string;
  suggestedPrompt?: string;
};

export type ThreadToolInvocationSummary = {
  category: ThreadToolInvocationCategory;
  toolName: string;
  invocationCount: number;
  outputChars: number;
  outputLines: number;
  estimatedOutputTokens: number;
  warningLines: number;
  errorLines: number;
  infoLines: number;
  debugLines: number;
  noisyInvocationCount: number;
  lastObservedAt: number;
};

export type ThreadToolInvocationAlert = {
  alertId: string;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId?: string;
  kind: "large-output" | "noisy-polling";
  severity: "warning" | "critical";
  toolName: string;
  sessionId?: string;
  processId?: string;
  firstObservedAt: number;
  lastObservedAt: number;
  invocationCount: number;
  invocationIds?: string[];
  totalOutputChars: number;
  estimatedOutputTokens: number;
  worstInvocationId?: string;
  worstOutputChars?: number;
  averageIntervalMs?: number;
  message: string;
  suggestedPrompt: string;
  createdAt: number;
  updatedAt: number;
};

export type ThreadToolAnalysisCoverage = {
  analyzerVersion: string;
  analyzedAt: number;
  completeness: "complete" | "partial";
  entryCount: number;
  invocationCount: number;
  missingOutputCount: number;
  pageCount: number;
  scannedThrough?: string;
  explanation?: string;
};

/**
 * Thread-level dollar accounting for the gate, aggregated from the same
 * per-gate terms the Pricing rail shows so the two views cannot disagree.
 *
 * A gate is only priced once its own usage line lands and the parent turn has a
 * known model and rate, so `pricedGateCount` can trail `gateCount` — the token
 * counts are always available, the dollars are not.
 */
export type ThreadTokenMiserSavings = {
  currency: "USD";
  /** Gates whose dollar terms are complete; the rest contribute tokens only. */
  pricedGateCount: number;
  gateCount: number;
  /** Decisions that deliberately returned the ordinary original result. */
  passThroughCount?: number;
  policyPassThroughCount?: number;
  helperPassThroughCount?: number;
  helperDecisionCount?: number;
  /** 1 — the gated payloads at parent rates, uncached once plus later replays. */
  withoutGateCostMicros: number;
  /** 2 — what the helper actually charged. */
  gateCostMicros: number;
  /** 3 — summaries and retrievals the parent did receive, and their replays. */
  revealedCostMicros: number;
  /** 1 − 2 − 3. Negative when the gate cost more than it saved. */
  savingsMicros: number;
  /** Replays counted at an observed request boundary. */
  directlyObservedReplayCount: number;
  /**
   * Replays inferred from later tool invocations on pre-v2 gates. Cannot see
   * cross-turn replays or compaction boundaries, so it is a floor, not a count.
   */
  reconstructedReplayCount: number;
  gateModel?: string;
  parentModel?: string;
};

export type ThreadTokenMiserAccounting = {
  savings?: ThreadTokenMiserSavings;
  interceptionCount: number;
  passThroughCount?: number;
  policyPassThroughCount?: number;
  helperPassThroughCount?: number;
  helperDecisionCount?: number;
  originalCharacters: number;
  baselineParentTokens: number;
  replacementTokens: number;
  retrievedTokens: number;
  estimatedParentTokensSaved: number;
  cachedReplayCount?: number;
  cachedBaselineTokens?: number;
  cachedRevealedTokens?: number;
  estimatedCachedReplayTokensSaved?: number;
  interceptions?: ThreadTokenMiserInterceptionAccounting[];
  codeMode?: ThreadTokenMiserCodeModeAccounting;
};

export type ThreadTokenMiserCodeModeObservation = {
  observationId: string;
  turnId: string;
  callId: string;
  cellId: string;
  createdAt: number;
  outputCharacters: number;
  outputPreview?: string;
  outputPreviewTruncated?: boolean;
  maxOutputTokens: number;
  scriptStatus: string;
  script?: string;
  retrieval: boolean;
  /** Null means the runtime supplied no nested invocation capture. */
  capturedNestedInvocationCount: number | null;
  capturedCommandInvocationCount?: number;
  capturedPollingInvocationCount?: number;
  capturedPatchInvocationCount?: number;
  capturedOtherInvocationCount?: number;
  disposition: "direct" | "summarized" | "passed_through" | "retrieval";
};

export type ThreadTokenMiserCodeModeAccounting = {
  /** Cells without nested capture; classification counts cover only captured cells. */
  unclassifiedCellCount?: number;
  callCount: number;
  commandCellCount: number | null;
  directCommandCellCount: number | null;
  dispatchClusterCount: number | null;
  multiInvocationClusterCount: number | null;
  largestDispatchCluster: number | null;
  nestedCommandInvocationCount: number | null;
  patchCellCount: number | null;
  otherCellCount: number | null;
  pollingCellCount: number | null;
  directCount: number;
  summarizedCount: number;
  passThroughCount: number;
  retrievalCount: number;
  /** Null means the runtime supplied no nested invocation capture. */
  capturedNestedInvocationCount: number | null;
  observations: ThreadTokenMiserCodeModeObservation[];
};

export type ThreadTokenMiserInterceptionAccounting = {
  objectId: string;
  /** Temporary owner-process availability; eviction may make it unavailable earlier. */
  originalOutputAvailableUntil?: number;
  turnId: string;
  toolUseId: string;
  toolName: string;
  createdAt: number;
  originalCharacters: number;
  baselineParentTokens: number;
  /** Exact replacement size delivered to Codex before token estimation. */
  replacementCharacters?: number;
  replacementTokens: number;
  /** Exact later retrieval size delivered to the parent. */
  retrievedCharacters?: number;
  retrievedTokens: number;
  estimatedParentTokensSaved: number;
  cachedReplayCount?: number;
  cachedBaselineTokens?: number;
  cachedRevealedTokens?: number;
  estimatedCachedReplayTokensSaved?: number;
  replayTrackingVersion?: 2;
  disposition?: "summarized" | "passed_through";
  /** Whether Luna evaluated this decision or deterministic policy selected it. */
  decisionSource?: "helper" | "policy";
  /** Nested Code Mode calls represented by this outer reducer decision. */
  groupMembers?: Array<{
    objectId: string;
    toolCallId: string;
    toolName: string;
    summary: string;
  }>;
  /**
   * Fixed accounting decision note. Original helper text is not retained.
   */
  summary?: {
    summary: string;
    usefulDetails: string[];
    suggestedNextStep?: string;
  };
};

export type ThreadToolAccounting = {
  analysis?: ThreadToolAnalysisCoverage;
  alerts: ThreadToolInvocationAlert[];
  invocations: ThreadToolInvocationRecord[];
  summaries: ThreadToolInvocationSummary[];
  /** Actual Token Miser gate activity for this thread, not raw-output risk. */
  tokenMiser?: ThreadTokenMiserAccounting;
};

export type PersistThreadUsageActivityRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  activity: AppServerThreadActivityEntry;
};

export type PersistThreadUsageActivityResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  activityId: string;
  persisted: boolean;
};

export type AppServerListSkillsRequest = {
  backend?: AppServerBackendKind;
  cwd?: string;
  cwds?: string[];
  federationTarget?: FederationTarget;
  threadId?: ThreadIdentifier;
};

export type AppServerListSkillsResponse = {
  backend: AppServerBackendKind;
  fetchedAt: number;
  data: Array<{
    commands?: AppServerAvailableCommandSummary[];
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

export type FederationPeerStatusChangedNotification = {
  method: "federation/peerStatus/changed";
  params: {
    instanceId: string;
    status: FederationConnectionState;
    unavailableReason?: string;
  };
};

export type FederationCelestialIconsChangedNotification = {
  method: "federation/celestialIcons/changed";
  params: {
    assignments: CelestialIconAssignment[];
  };
};

export type StarMapArrangementChangedNotification = {
  method: "starMap/arrangement/changed";
  params: {
    entries: StarMapArrangementEntry[];
  };
};

export type StarMapIntakeStatusNotification = {
  method: "starMap/intake/status";
  params: {
    requestId: string;
    phase: StarMapIntakePhase;
    message?: string;
    backend?: string;
    threadId?: string;
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
      method: "error";
      params: {
        threadId: string;
        turnId: string;
        willRetry: boolean;
        error: {
          message: string;
          codexErrorInfo?: unknown;
          additionalDetails?: string | null;
        };
      };
    }
  | {
      method: "warning";
      params: { threadId?: string | null; message: string };
    }
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
      method: "item/transientMessage/updated";
      params: {
        threadId: string;
        turnId?: string;
        itemId: string;
        role: AppServerThreadMessage["role"];
        /** Full replacement text; an empty value clears the active segment. */
        text: string;
        phase?: AppServerTranscriptPhase;
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
      method: "thread/codexInvalidIdRecovery/updated";
      params: {
        threadId: string;
        turnId?: string;
        status: "repairing" | "succeeded" | "failed";
        failureMessage: string;
        recoveryError?: string;
        removedMessageIdCount?: number;
        backupPath?: string;
      };
    }
  | {
      /**
       * Codex reported `thread not found` for threads that its `thread/list`
       * still returns. `archived` reports the cleanup PwrAgent already
       * performed; `confirmationRequired` means the missing share was large
       * enough to look like a Codex profile mismatch, so the operator decides.
       */
      method: "codex/missingThreads/updated";
      params: {
        status: "archived" | "confirmationRequired";
        threadIds: string[];
        missingCount: number;
        totalCount: number;
        /** Active PwrAgent profile, so the prompt can name what is affected. */
        profileName: string;
        archivedCount?: number;
        failedCount?: number;
        failures?: { threadId: string; error: string }[];
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
          origin?: AppServerThreadMessageOrigin;
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
      method: "thread/questionnaireActivity/updated";
      params: {
        threadId: string;
        requestId: string;
      };
    }
  | {
      method: "thread/tokenUsage/updated";
      params: {
        threadId: string;
        turnId?: string;
        model?: string;
        tokenUsage: unknown;
      };
    }
  | {
      method: "thread/pricing/updated";
      params: {
        threadId: string;
        pricing: {
          /** Observed context compactions, oldest first. */
          compactions?: ThreadCompactionRecord[];
          lines: ThreadUsageLineRecord[];
          summaries: ThreadPricingSummary[];
        };
        triggeredSpendAlerts?: ThreadSpendAlert[];
      };
    }
  | {
      method: "thread/toolAccounting/updated";
      params: {
        threadId: string;
        toolAccounting: ThreadToolAccounting;
        /**
         * The operator's persisted disposition for this thread's incident
         * card. Carried here so a renderer that just launched knows what was
         * dismissed or muted before it existed, without a per-thread read.
         */
        incidentNotice?: ThreadToolIncidentNoticeState;
        triggeredAlerts?: ThreadToolInvocationAlert[];
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
      method: "backend/acpRuntimeCapabilities/updated";
      params: {
        backend: AppServerBackendKind;
      };
    }
  | {
      method: "backend/providerStatus/updated";
      params: {
        backend: AppServerBackendKind;
      };
    }
  | {
      method: "navigation/providerThreads/refreshed";
      params: {
        failedProviders: number;
      };
    }
  | {
      method: "backend/acpUpdateStatus/updated";
      params: {
        backend: AppServerBackendKind;
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
      method: "configWarning";
      params: {
        summary: string;
        details?: string | null;
        path?: string;
        range?: unknown;
        trustedProjectPath?: string;
        configPath?: string;
      };
    }
  | {
      method: "thread/name/updated";
      params: {
        threadId: string;
        threadName?: string;
        /**
         * Where the new name came from, when the emitter knows. A rename
         * carries no provenance of its own, so a recorder that guesses calls
         * every generated title an operator rename. Optional because a
         * provider-forwarded or federated rename genuinely does not know;
         * absent means "assume an operator", which is what every consumer
         * assumed before this existed. Read it with
         * `normalizeRenamedTitleSource` — the type is a compile-time contract
         * and a federated payload is another instance's JSON.
         */
        titleSource?: AppServerRenamedTitleSource;
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
      method: "thread/rewound";
      params: {
        threadId: string;
        targetPromptIndex: number;
        updatedAt: number;
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
      method: "thread/reviewStart/updated";
      params: {
        threadId: string;
        pendingReviewId: string;
        status: "started" | "cancelled" | "failed";
        reviewThreadId?: string;
        reviewTurnId?: string;
        error?: string;
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
      method: "thread/prAutoDispatch/updated";
      params: {
        threadId: string;
        enabled: boolean;
      };
    }
  | {
      method: "thread/prAutoDispatch/pendingUpdated";
      params: {
        threadId: string;
        pending: ThreadPrAutoDispatchPending | null;
      };
    }
  | {
      method: "thread/codexSettings/observed";
      params: {
        threadId: string;
        model?: string;
        fastMode?: boolean;
        reasoningEffort?: string;
        serviceTier?: string | null;
        rawServiceTier?: string | null;
      };
    }
  | {
      method: "thread/acpRuntime/updated";
      params: {
        threadId: string;
        acpRuntime?: AppServerAcpSessionRuntimeState;
      };
    }
  | {
      method: "thread/availableCommands/updated";
      params: {
        threadId: string;
        commands: AppServerAvailableCommandSummary[];
      };
    }
  | {
      method: "skills/changed";
      params: {
        cwd?: string;
        cwds?: string[];
        reason?: string;
        [key: string]: unknown;
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
      method: "thread/agent/updated";
      params: {
        threadId: string;
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
      method: "thread/automations/updated";
      params: {
        threadId: string;
      };
    }
  | {
      method: "thread/subAgents/updated";
      params: {
        threadId: string;
        subAgents?: ThreadSubAgentSummary[];
      };
    }
  | {
      method: "automation/run/updated";
      params: {
        threadId: string;
        automationId: string;
        automationName?: string;
        finalText?: string;
        outputDecision?: AutomationRunOutputDecision;
        runId: string;
        status:
          | "pending"
          | "queued"
          | "running"
          | "completed"
          | "failed"
          | "cancelled"
          | "skipped";
      };
    }
  | {
      method: "automation/run/transcript/updated";
      params: {
        runId: string;
      };
    }
  | {
      method: "thread/turnQueue/updated";
      params: {
        threadId: string;
        queueEntryId: string;
        /** Owner-clock creation time for ordering against navigation snapshots. */
        queueEntryCreatedAt?: number;
        origin: "manual" | "automation" | "messaging" | "scheduled";
        status:
          | "queued"
          | "started"
          | "blocked"
          | "held"
          | "failed"
          | "cancelled"
          | "terminal";
        /**
         * Truncated first text of the queued input on "queued" events, so
         * windows that did not submit the entry can mirror a chip without
         * waiting for the next navigation snapshot.
         */
        displayText?: string;
        /** The owner replaced pending input, so existing previews must refresh. */
        inputUpdated?: boolean;
        position?: number;
        turnId?: string;
        automationRunId?: string;
        automationName?: string;
        errorMessage?: string;
        manualReleaseRequired?: boolean;
        finalText?: string;
        terminalStatus?: string;
      };
    }
  | {
      method: "thread/scheduledAction/updated";
      params: {
        action: ScheduledThreadAction;
      };
    }
  | {
      method: "thread/reactions/updated";
      params: {
        threadId: string;
        /** Complete reaction set, ordered by insertion. */
        reactions: string[];
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
  | {
      method: "navigation/remoteThreadPins/changed";
      params: {
        /** Instance the pinned/unpinned thread lives on. */
        instanceId: string;
        /**
         * Absent for instance-wide changes: a background pinned-summary
         * refresh landing, or peer-revocation pin cleanup.
         */
        threadId?: string;
        pinned?: boolean;
      };
    }
  | {
      method: "thread/parent/set";
      params: {
        threadId: string;
        parentThreadId: string;
        parentThreadBackend?: AppServerBackendKind;
        parentThreadInstanceId?: string;
      };
    }
  | {
      method: "thread/parent/cleared";
      params: {
        threadId: string;
      };
    }
  | {
      method: "thread/subthreadOrder/updated";
      params: {
        parentThreadId: string;
        threadIds: string[];
      };
    }
  | {
      method: "thread/subthreadsCollapsed/updated";
      params: {
        parentThreadId: string;
        collapsed: boolean;
      };
    }
  | {
      method: "thread/pullRequests/updated";
      params: {
        threadId: string;
        prs: PrSummary[];
      };
    }
  | {
      method: "pullRequest/status/updated";
      params: {
        prKey: string;
        pr: PrSummary;
      };
    }
  /**
   * Directory pin lifecycle — mirror of `thread/pin/*` minus the
   * implicit per-backend dimension (directories are
   * backend-agnostic, so pin order is global). Emitted by the IPC
   * handlers in `app-server.ts` after the overlay store write
   * succeeds. The renderer's `useThreadNavigation` listens for these
   * and patches the local snapshot in place so cross-window pin
   * mutations propagate within one bus tick.
   * See plan: 2026-05-09-002-feat-directory-pinning-plan.md Unit F.
   */
  | {
      method: "directory/pin/added";
      params: {
        directoryKey: string;
        pinnedRank: string;
      };
    }
  | {
      method: "directory/pin/removed";
      params: {
        directoryKey: string;
      };
    }
  | {
      method: "directory/pin/reordered";
      params: {
        pinnedRanks: Record<string, string>;
      };
    }
  | {
      method: "directory/threadsCollapsed/updated";
      params: {
        directoryKey: string;
        collapsed: boolean;
      };
    }
  | FederationPeerStatusChangedNotification
  | FederationCelestialIconsChangedNotification
  | StarMapArrangementChangedNotification
  | StarMapIntakeStatusNotification
  | AppServerPendingRequestNotification;
