import type { OwnerThreadRegistry } from "@pwragent/owner-core/thread-storage";
import { delegatedTurnAttribution } from "./delegated-turn-attribution";
import type { MaintenanceDiscoveryProgress } from "./unreferenced-worktrees";
import { ArchiveWorkspaceAdmission } from "./archive-cleanup-workspace-scope";
import {
  type TokenMiserCachedReplayIndex,
  type TokenMiserPricingIndex,
} from "./token-miser-ledger-index";
import {
  type ForgeAgentToolAccess,
  type McpProjectToolApprovalOffer,
} from "@pwragent/shared";
import {
  type ForgeAgentRuleAgent,
  type ForgeAgentToolRuleApprovalNote,
  type ForgeAgentToolRuleGroup,
} from "@pwragent/shared";
import type { ListBackgroundTerminalsResponse } from "@pwragent/shared";
import { type ArchiveCleanupContext } from "./archive-cleanup-queue";
import type { ProjectHeldWakeupStorage } from "../storage/desktop-runtime-storage";
import type { RestartContinuationStorage } from "../storage/desktop-runtime-storage";
import {
  type ResolveProjectHeldWakeupsRequest,
  type ResolveProjectHeldWakeupsResponse,
  type ListProjectHeldWakeupsRequest,
  type ListProjectHeldWakeupsResponse,
  type SetProjectForgeAutomationRequest,
  type SetProjectForgeAutomationResponse,
} from "@pwragent/shared";
import { type PullRequestReferenceIdentity } from "../pr-status/forge-reference";
import type { ThreadPrAutoDispatchPreferenceChange } from "../pr-status/pr-auto-dispatch";
import type {
  DynamicToolSpec as CodexDynamicToolSpec,
  ThreadForkParams as CodexThreadForkParams,
  ThreadStartParams as CodexThreadStartParams,
  ThreadSource as CodexThreadSource,
} from "@pwrdrvr/codex-app-server-protocol/v2";
import type {
  OverlayStoreLike,
  DesktopOwnerStorage,
} from "../storage/desktop-overlay-store";
import { type McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import {
  type ArchiveThreadRequest,
  type ArchiveThreadCleanupResult,
  type ArchiveThreadResponse,
  type MarkThreadSeenRequest,
  type MarkThreadSeenResponse,
  type SetThreadPinRequest,
  type SetThreadParentRequest,
  type SetThreadParentResponse,
  type SetThreadPinResponse,
  type AppServerListSkillsResponse,
  type AppServerNotification,
  type AppServerPendingRequestNotification,
  type AppServerReadThreadResponse,
  type AppServerThreadActivityEntry,
  type AppServerThreadActivityDetail,
  type AppServerReviewContext,
  type AppServerThreadImagePart,
  type AppServerThreadMessageOrigin,
  type AppServerThreadReplay,
  type AppServerThreadSummary,
  type AppServerTurnInputItem,
  type AppServerBackendKind,
  type AppServerCollaborationModeRequest,
  type BackendAccountSummary,
  type CodexEnvironmentSetupProgressEvent,
  type CodexThreadEnvironmentRuntime,
  type BackendModelOption,
  type BackendRateLimitSummary,
  type CodexAppServerRestartStatus,
  type ControlActiveTurnResponse,
  type ForkThreadRequest,
  type ListThreadMcpServersResponse,
  type NavigationDirectoryGitStatus,
  type NavigationDirectorySummary,
  type NavigationLaunchpadDefaults,
  type CancelThreadPrAutoDispatchRequest,
  type SendThreadPrAutoDispatchNowRequest,
  type DetachThreadPullRequestRequest,
  type DetachThreadPullRequestResponse,
  type RefreshOwnedThreadGitWorkingStateRequest,
  type RefreshOwnedThreadPullRequestsRequest,
  type RefreshThreadGitWorkingStateResponse,
  type RefreshThreadPullRequestsResponse,
  type ThreadCodexInvalidIdRecovery,
  type MarkProjectReadToolArgs,
  type MarkProjectReadResult,
  type CheckThreadPullRequestStatusToolArgs,
  type WatchThreadPullRequestToolArgs,
  type ThreadPullRequestAutomationStatus,
  type PwrAgentThreadInspectionRequest,
  type PwrAgentThreadInspectionResponse,
  type ThreadMaintenanceApplyRequest,
  type ThreadMaintenanceCoverage,
  type ThreadMaintenanceKeptThread,
  type ThreadMaintenanceRules,
  type ThreadMaintenanceRun,
  type ThreadMaintenanceScan,
  type PwrAgentThreadOrchestrationResponse,
  type StartReviewRequest,
  type SubmitServerRequestRequest,
  type ThreadExecutionMode,
  type ThreadOverlayState,
  type ThreadSubAgentSummary,
  type ThreadUsageLineRecord,
  type PrSummary,
  type WorktreeSnapshotSummary,
  type HelperModelId,
  type HelperModelResolution,
  type TaskMonitorResponse,
  type TaskMonitorUsageSnapshot,
} from "@pwragent/shared";
import {
  CodexAppServerClient,
  type CodexPwrdrvrTokenMiserActivation,
  type CodexServerCapabilities,
  type HelperThreadToolCallHandler,
} from "../codex-app-server/desktop-client";
import {
  type CodexAppServerProcessSample,
  type CodexAppServerRecycleOutcome,
  type CodexAppServerRecycleSettings,
  type CodexAppServerRecycleStatus,
} from "../codex-app-server/app-server-recycle-policy";
import {
  type CodexInvalidResponseMessageIdRecoveryResult,
  type CodexRecoveryBlockingTurn,
} from "../codex-app-server/invalid-response-message-id-recovery";
import { type DirectoryEnrichmentCaller } from "./thread-directory-enricher";
import { type WorktreeContainerCleanup } from "./worktree-container-service";
import { type ThreadArchiveCandidate } from "./thread-archive-sweeper";
import {
  ThreadTitleGenerationService,
  type ThreadTitleGenerator,
  type ThreadTitleGenerationResult,
} from "@pwragent/owner-core/thread-title-generation-service";
import {
  type ThreadTurnQueueEntry,
  type ThreadTurnQueueOrigin,
} from "@pwragent/owner-core/thread-turn-queue";
import type { MessagingStoreLike } from "../storage/desktop-runtime-storage";



export type InitializeResult = {
  serverInfo?: {
    name?: string;
    version?: string;
  };
  methods?: string[];
  userAgent?: string;
};

/** Saves one group of one (repository, agent) forge project rule. */
export type ForgeToolRuleWriter = (update: {
  repository: string;
  agent: ForgeAgentRuleAgent;
  group: ForgeAgentToolRuleGroup;
  level: ForgeAgentToolAccess | undefined;
}) => Promise<unknown>;

/** What the agent is told about how a forge write was approved. */
export type ForgeWriteApprovalNotes = {
  /** A project rule set to Allow ran the call without a card. */
  approval?: ForgeAgentToolRuleApprovalNote;
  /** The card's "Always allow" choice, and whether its rule was saved. */
  rememberedRule?:
    | { rule: string; saved: true }
    | { rule: string; saved: false; error: string };
};

export type BackendClient = {
  listBackgroundTerminals?(threadId: string): Promise<ListBackgroundTerminalsResponse>;
  terminateBackgroundTerminal?(threadId: string, processId: string): Promise<boolean>;
  exportThreadForHandoff?(threadId: string): Promise<import("@pwragent/shared").ThreadHandoffExport>;
  startRealtime?: CodexAppServerClient["startRealtime"];
  stopRealtime?: CodexAppServerClient["stopRealtime"];
  appendRealtimeText?: CodexAppServerClient["appendRealtimeText"];
  onRealtimeEvent?: CodexAppServerClient["onRealtimeEvent"];
  onRealtimeDisconnect?: CodexAppServerClient["onRealtimeDisconnect"];
  close(): Promise<void>;
  getInitializeResult(): Promise<InitializeResult>;
  readServerCapabilities?(): Promise<CodexServerCapabilities>;
  isTokenMiserActivationNegotiated?(): boolean;
  readCodexHome?(): Promise<string>;
  readConfiguredMcpServerNames?(params?: {
    cwd?: string;
  }): Promise<string[]>;
  invalidateThreadListings?(notification?: AppServerNotification): void;
  listThreads(
    params?: {
      archived?: boolean;
      enrichDirectories?: boolean;
      filter?: string;
      limit?: number;
      maxPages?: number;
      requireComplete?: boolean;
      skipArchivedMetadataRefresh?: boolean;
      deadlineAt?: number;
    },
    diagnostics?: { callerReason?: string; ownerId?: string },
  ): Promise<AppServerThreadSummary[]>;
  listArchiveCleanupThreadsPage?: CodexAppServerClient["listArchiveCleanupThreadsPage"];
  /** The listing above honors `sortKey: "updated_at"`. */
  archiveCleanupRecencyReads?: boolean;
  readArchiveCleanupThreadSummary?: CodexAppServerClient["readArchiveCleanupThreadSummary"];
  enrichArchiveCleanupThreads?: CodexAppServerClient["enrichArchiveCleanupThreads"];
  listNativeSubAgentThreads?(
    params?: {
      ancestorThreadId?: string;
      filter?: string;
      limit?: number;
      all?: boolean;
      archived?: boolean;
    },
    diagnostics?: { callerReason?: string; ownerId?: string },
  ): Promise<AppServerThreadSummary[]>;
  /** A thread's configured model, without reading its turns. */
  readThreadModelSettings?(params: {
    threadId: string;
  }): Promise<{ model?: string; reasoningEffort?: string } | undefined>;
  readThreadPricingSnapshot?: CodexAppServerClient["readThreadPricingSnapshot"];
  /** The configured Codex model provider a thread runs on, if Codex reported one. */
  modelProviderForThread?(threadId: string): string | undefined;
  /** Any model provider Codex reported for a thread, `openai` for its default. */
  reportedModelProviderForThread?(threadId: string): string | undefined;
  enrichThreadDirectories?(
    threads: AppServerThreadSummary[],
    caller?: DirectoryEnrichmentCaller,
  ): Promise<AppServerThreadSummary[]>;
  deleteThread?(params: { threadId: string }): Promise<{ threadId: string }>;
  archiveThread?(params: { threadId: string }): Promise<{ threadId: string }>;
  retireReviewThread?: CodexAppServerClient["retireReviewThread"];
  restoreThread?(params: { threadId: string }): Promise<{ threadId: string }>;
  renameThread?(params: { threadId: string; name: string }): Promise<{ threadId: string }>;
  updateThreadMetadata?(params: {
    threadId: string;
    gitInfo?: {
      branch?: string | null;
      originUrl?: string | null;
      sha?: string | null;
    } | null;
  }): Promise<{ threadId: string }>;
  updateThreadWorkspace?(params: {
    threadId: string;
    cwd: string;
  }): Promise<{ threadId: string }>;
  generateTitle?: ThreadTitleGenerator["generateTitle"];
  resolveHelperModelSelection?(params: {
    helper: HelperModelId;
    model?: string;
    reasoningEffort?: string;
  }): Promise<HelperModelResolution>;
  generateStructuredObject?(params: {
    helper: HelperModelId;
    model?: string;
    reasoningEffort?: string;
    prompt: string;
    schema: Record<string, unknown>;
    system?: string;
    disableExecution?: boolean;
    isMatch: (record: Record<string, unknown>) => boolean;
    timeoutMs?: number;
    /** Model answering budget, separate from the protocol round-trips. */
    turnTimeoutMs?: number;
  }): ReturnType<ThreadTitleGenerator["generateTitle"]>;
  /**
   * One ephemeral helper turn that may call the supplied PwrAgent dynamic
   * tools. Optional: only Codex advertises dynamic tools, so a backend
   * without it simply has no agent-driven intake path.
   */
  runHelperToolTurn?(params: {
    helper: HelperModelId;
    model?: string;
    reasoningEffort?: string;
    prompt: string;
    system?: string;
    dynamicTools: CodexDynamicToolSpec[];
    onToolCall: HelperThreadToolCallHandler;
    timeoutMs?: number;
    turnTimeoutMs?: number;
  }): Promise<{ status: "ok" } | { status: "failed"; reason: string }>;
  listSkills(params?: {
    cwd?: string;
    cwds?: string[];
  }): Promise<AppServerListSkillsResponse["data"]>;
  onNotification(
    listener: (notification: AppServerNotification) => void | Promise<void>
  ): () => void;
  onRequest?(
    listener: (
      request: AppServerPendingRequestNotification
    ) => Promise<unknown> | unknown
  ): () => void;
  readThread(params: {
    threadId: string;
    includeTurns?: boolean;
    before?: string;
    limit?: number;
  }): Promise<AppServerReadThreadResponse["replay"]>;
  readThreadSummary?(threadId: string): Promise<AppServerThreadSummary>;
  readThreadName?(threadId: string): Promise<string | undefined>;
  readThreadActivity?(params: { threadId: string; turnId: string; entryId: string; itemIds?: string[] }): Promise<AppServerThreadActivityEntry>;
  readThreadToolInvocation?(params: { threadId: string; turnId: string; itemId: string }): Promise<AppServerThreadActivityDetail[]>;
  readThreadTurn?(params: { threadId: string; turnId: string }): Promise<AppServerThreadReplay>;
  prepareFreshNativeVoiceThread?(params: Parameters<CodexAppServerClient["refreshThreadTools"]>[0]): Promise<boolean>;
  resumeNativeVoiceThread?(params: Parameters<CodexAppServerClient["resumeNativeVoiceThread"]>[0]): Promise<void>;
  refreshThreadTools?(params: Parameters<CodexAppServerClient["refreshThreadTools"]>[0]): Promise<void>;
  injectThreadItems?(params: { threadId: string; items: unknown[] }): Promise<void>;
  startThread(params: {
    cwd?: string;
    ephemeral?: boolean;
    model?: string;
    approvalPolicy?: string;
    approvalsReviewer?: "user" | "auto_review";
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    config?: CodexThreadStartParams["config"];
    defaultModeRequestUserInput?: boolean;
    dynamicTools?: CodexDynamicToolSpec[];
    threadSource?: CodexThreadSource;
    pwrdrvrTokenMiser?: CodexPwrdrvrTokenMiserActivation;
  }): Promise<{ threadId: string }>;
  forkThread?(params: {
    threadId: string;
    path?: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    approvalsReviewer?: "user" | "auto_review";
    sandbox?: string;
    serviceTier?: string;
    fastMode?: boolean;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    config?: CodexThreadForkParams["config"];
  }): Promise<{ threadId: string }>;
  readTurnRoot?(params: { threadId: string; turnId: string }): Promise<string | undefined>;
  startTurn(params: {
    threadId: string;
    parentTurnId?: string;
    rootTurnId?: string;
    input: AppServerTurnInputItem[];
    onInputTextPrepared?: (text: string | undefined) => void;
    cwd?: string;
    approvalPolicy?: string;
    approvalsReviewer?: "user" | "auto_review";
    sandbox?: string;
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    config?: CodexThreadStartParams["config"];
    defaultModeRequestUserInput?: boolean;
    dynamicTools?: CodexDynamicToolSpec[];
    pwrdrvrTokenMiser?: CodexPwrdrvrTokenMiserActivation | null;
  }): Promise<{
    threadId: string;
    turnId: string;
  }>;
  recoverInvalidPersistedResponseMessageIds?(params: {
    failureMessage: string;
    forkLineageThreadIds?: string[];
    onWaitingForTurns?: (
      turns: CodexRecoveryBlockingTurn[],
    ) => void | Promise<void>;
    signal?: AbortSignal;
    threadId: string;
  }): Promise<CodexInvalidResponseMessageIdRecoveryResult>;
  startReview?(params: {
    threadId: string;
    target: StartReviewRequest["target"];
    delivery?: StartReviewRequest["delivery"];
    model?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    cwd?: string;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    config?: CodexThreadStartParams["config"];
    dynamicTools?: CodexDynamicToolSpec[];
  }): Promise<{ threadId: string; reviewThreadId: string; turnId: string }>;
  listModels?(diagnostics?: {
    callerReason?: string;
    ownerId?: string;
  }): Promise<BackendModelOption[]>;
  isAuthenticationRequired?(): boolean;
  getAppServerRestartStatus?(): CodexAppServerRestartStatus;
  onAppServerRestartStatusChanged?(
    listener: (status: CodexAppServerRestartStatus) => void,
  ): () => void;
  onAppServerUnexpectedExit?(listener: (threadIds?: ReadonlySet<string>) => void): () => void;
  restartAppServer?(): Promise<void>;
  unsubscribeIdleThreads?(params: {
    idleMs: number;
    isThreadBusy: (threadId: string) => boolean;
  }): Promise<string[] | void>;
  resetAppServerRestarts?(reason: string): void;
  readAppServerProcessSample?(): Promise<CodexAppServerProcessSample | undefined>;
  getAppServerRecycleStatus?(): CodexAppServerRecycleStatus;
  maybeRecycleIdleAppServer?(params: {
    settings: CodexAppServerRecycleSettings;
    isQuiescent: () => boolean;
  }): Promise<CodexAppServerRecycleOutcome | void>;
  readAccount?(): Promise<BackendAccountSummary>;
  readRateLimits?(): Promise<BackendRateLimitSummary[]>;
  interruptTurn(params: {
    threadId: string;
    turnId: string;
  }): Promise<{ threadId: string; turnId: string }>;
  revertThread?(params: {
    threadId: string;
    beforeTurnId: string;
  }): Promise<void>;
  compactThread?(params: {
    threadId: string;
    model?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string; turnId: string; itemId?: string }>;
  listMcpServers?(params: {
    threadId?: string;
    detail: ListThreadMcpServersResponse["detail"];
  }): Promise<ListThreadMcpServersResponse["servers"]>;
  reloadMcpConfig?(): Promise<void>;
  startMcpServerOAuthLogin?(params: {
    name: string;
  }): Promise<{ authorizationUrl: string }>;
  removeMcpServer?(params: { name: string }): Promise<void>;
  steerTurn?(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    onInputTextPrepared?: (text: string | undefined) => void;
    expectedTurnId: string;
  }): Promise<{ threadId: string; turnId: string }>;
  setTurnApprovalReviewer?(params: {
    threadId: string;
    turnId: string;
    approvalsReviewer: "user" | "auto_review";
  }): Promise<{ status: "applied" | "targetUnavailable" }>;
  setThreadPermissions?(params: {
    threadId: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    approvalsReviewer?: "user" | "auto_review";
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string }>;
  trustProject?(params: {
    projectPath: string;
    configPath?: string;
  }): Promise<{ projectPath: string; configPath?: string }>;
};

export type BackendRegistryForkThreadRequest = ForkThreadRequest & {
  importedWorktree?: { repositoryPath: string; worktreePath: string };
  codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
  /** Run the environment's setup even when the fork is not a new worktree. */
  rerunCodexEnvironmentSetup?: boolean;
  onPreparedWorkspaceRollback?: (rollback: (() => Promise<void>) | undefined) => void;
  onCodexEnvironmentSetupProgress?: (
    event: CodexEnvironmentSetupProgressEvent,
  ) => void;
  sourceThreadPath?: string;
};

export type QuitThreadSource = {
  backend: AppServerBackendKind;
  threadId: string;
  threadKey: string;
  source: string;
  turnId?: string;
};

/** A started Codex tool item; `itemType` is lowercased with separators removed. */
export type LiveCodexToolItem = { turnId: string; itemType: string; turnEnded?: boolean };

export type PendingServerRequest = {
  owner?: { backend: AppServerBackendKind; threadId: string; turnId?: string };
  backend: AppServerBackendKind;
  notification: AppServerPendingRequestNotification;
  resolve: (response: SubmitServerRequestRequest["response"]) => void;
  reject: (error: Error) => void;
};

export type ThreadTitleService = Pick<ThreadTitleGenerationService, "generateTitle"> & {
  canGenerateTitle?: (backend: AppServerBackendKind) => boolean;
};

export type ThreadPullRequestStatusToolHandler = (
  args: CheckThreadPullRequestStatusToolArgs,
  context: PwrAgentThreadInspectionRequest["context"],
) => PwrAgentThreadInspectionResponse | Promise<PwrAgentThreadInspectionResponse>;

export type ThreadPullRequestCanonicalizer = (
  prs: PrSummary[],
) => PrSummary[] | Promise<PrSummary[]>;

export type LocalPullRequestAuthorityResolver = (prKey: string) => boolean;

/**
 * Asks the forge which repository a PR URL names now. A renamed repository's
 * old URL still resolves, and the answer carries the current name. Undefined
 * means the forge could not say (offline, no CLI, budget, not found).
 */
export type PullRequestReferenceResolver = (params: {
  url: string;
  cwd?: string;
}) => Promise<Pick<PullRequestReferenceIdentity, "provider" | "org" | "repo" | "url"> | undefined>;

export type ThreadPullRequestWatchToolHandler = (
  args: WatchThreadPullRequestToolArgs,
) => PwrAgentThreadInspectionResponse | Promise<PwrAgentThreadInspectionResponse>;

export type DirectoryGitStatusWriter = (params: {
  directory?: NavigationDirectorySummary;
  directoryKey: string;
  fetchedAt: number;
  gitStatus?: NavigationDirectoryGitStatus;
}) => void | Promise<void>;

export type ThreadPullRequestDetachHandler = (
  request: DetachThreadPullRequestRequest,
) => Promise<DetachThreadPullRequestResponse>;

export type ThreadPrWatchesPeerHandler = (
  request: import("@pwragent/shared").FederationThreadPrWatchesRequestV1,
) => Promise<import("@pwragent/shared").ThreadPrWatchesResponse>;

/** The desktop app-server service's owner-side Forge Automation requests. */
export type ProjectForgeAutomationHandler = {
  set(
    request: Omit<SetProjectForgeAutomationRequest, "federationTarget">,
  ): Promise<SetProjectForgeAutomationResponse>;
  listHeldWakeups(
    request: Omit<ListProjectHeldWakeupsRequest, "federationTarget">,
  ): Promise<ListProjectHeldWakeupsResponse>;
  resolveHeldWakeups(
    request: Omit<ResolveProjectHeldWakeupsRequest, "federationTarget">,
  ): Promise<ResolveProjectHeldWakeupsResponse>;
};

export type ThreadPullRequestRefreshHandler = (
  request: RefreshOwnedThreadPullRequestsRequest,
) => Promise<RefreshThreadPullRequestsResponse>;

export type ThreadGitWorkingStateRefreshHandler = (
  request: RefreshOwnedThreadGitWorkingStateRequest,
) => Promise<RefreshThreadGitWorkingStateResponse>;

export type ThreadPrAutoDispatchHandler = {
  preferenceChanged: (change: ThreadPrAutoDispatchPreferenceChange) => Promise<void>;
  preferencesChanged?: (
    changes: ThreadPrAutoDispatchPreferenceChange[],
  ) => Promise<void>;
  cancelPending: (request: CancelThreadPrAutoDispatchRequest) => Promise<boolean>;
  /** A lock or unlock moves the thread out of or back into the Auto-fix election. */
  lockChanged?: (request: {
    backend: AppServerBackendKind;
    threadId: string;
    locked: boolean;
  }) => Promise<void>;
  sendPendingNow: (
    request: SendThreadPrAutoDispatchNowRequest,
  ) => Promise<boolean>;
  inspect?: (
    request: {
      backend: AppServerBackendKind;
      threadId: string;
    },
    context?: PwrAgentThreadInspectionRequest["context"],
  ) => Promise<ThreadPullRequestAutomationStatus>;
};

export type ThreadTitleGenerationLogStatus =
  | ThreadTitleGenerationResult["status"]
  | "applied"
  | "requesting"
  | "skipped";

export type ThreadTitleHelperResult = Extract<
  ThreadTitleGenerationResult,
  { status: "generated" | "invalid" }
>;

export type WorktreeArchiveCandidate = {
  repositoryPath: string;
  worktreePath: string;
};

export type ProjectHeldWakeupStoreLike = ProjectHeldWakeupStorage;
export type RestartContinuationStoreLike = RestartContinuationStorage;

/** A running turn a quiet restart stops and continues after the restart. */
export type QuietRestartTarget = {
  backend: AppServerBackendKind;
  threadId: string;
  turnId: string;
};

export type ArchiveCleanupMetadata = {
  workspaceRevision?: number;
  activeThreads: AppServerThreadSummary[];
  archivedThreads: AppServerThreadSummary[];
  thread: AppServerThreadSummary;
  overlaysByThreadKey?: Map<string, ThreadOverlayState | undefined>;
  activeChildren?: AppServerThreadSummary[];
  legacyParentBackends?: Set<AppServerBackendKind>;
  worktreeEvidence?: {
    externalPaths: Set<string>;
    activeByPath: Map<string, AppServerThreadSummary[]>;
    archivedByPath: Map<string, AppServerThreadSummary[]>;
  };
  /** The paths of each listed thread that can relate to the listed scopes.
   * Absent for a thread: every one of its paths. */
  ownershipPaths?: WeakMap<AppServerThreadSummary, readonly string[]>;
};

export type ArchiveCleanupDiscoveryRequest = {
  backend: AppServerBackendKind;
  threadId: string;
  context?: ArchiveCleanupContext;
  targetThread?: AppServerThreadSummary;
  codexRolloutMissing?: boolean;
  /** Complete membership/overlays before candidate discovery; no Git probes. */
  identityOnly?: boolean;
  /** Fresh global membership/overlays, with Git probes limited to this scope. */
  ownershipScope?: string;
  removalAdmission?: ArchiveWorkspaceAdmission;
  /** Collects each identity row before overlay merging, for the fleet index. */
  fleetRows?: Array<{ backend: AppServerBackendKind; base: AppServerThreadSummary; overlay?: ThreadOverlayState; archived: boolean }>;
  onDiscoveryProgress?: (progress: MaintenanceDiscoveryProgress) => void;
};

export type ArchiveWorktreeRemovalAdmission = {
  backend: AppServerBackendKind;
  threadId: string;
  worktreePath: string;
  containerPath?: string;
  scope: ArchiveWorkspaceAdmission;
};

export type ArchivedWorktreeRepairReport = {
  archivedThreads: number;
  discoveredWorktrees: number;
  missingWorktrees: number;
  protectedWorktrees: number;
  protectedWorktreeDetails: Array<{
    worktreePath: string;
    externallyManaged: boolean;
    activeThreads: Array<{ backend: AppServerBackendKind; threadId: string; projectKey?: string }>;
  }>;
  candidates: Array<{ backend: AppServerBackendKind; threadId: string; worktreePath: string }>;
  cleanup: ArchiveThreadCleanupResult[];
  emptyContainerCandidates: Array<{ backend: AppServerBackendKind; threadId: string; worktreePath: string; containerIdentity: NonNullable<WorktreeContainerCleanup["identity"]> }>;
  containerCleanup: WorktreeContainerCleanup[];
  /** Read-only audits only: PwrAgent worktrees no thread refers to. */
  unreferencedWorktrees?: string[];
  unreferencedTruncated?: boolean;
  /** Why unreferenced checkouts could not be listed this time. */
  unreferencedUnavailable?: string;
  inventory?: { roots: string[]; paths: string[]; repositories?: string[]; providers: NonNullable<ThreadMaintenanceCoverage["providers"]>;
    keptPaths?: { path: string; reason: string }[];
    owners?: { path: string; threads: ThreadMaintenanceKeptThread[]; candidates: ThreadArchiveCandidate[] }[] };
};

export type WorktreeRestoreCandidate = {
  branch?: string;
  repositoryPath?: string;
  snapshot?: WorktreeSnapshotSummary;
  worktreePath: string;
};

export type TaskMonitorCancellationState = {
  finalizing: boolean;
  promise: Promise<TaskMonitorResponse<"cancel_monitor_delegation">>;
  requestPersisted: Promise<void>;
  resolve: (
    response: TaskMonitorResponse<"cancel_monitor_delegation">,
  ) => void;
  summary: string;
};

export type TaskMonitorMcpAccess = {
  connectionIds: string[];
  selectionOwner: { backend: AppServerBackendKind; threadId: string };
  automation?: {
    grantedConnectionIds?: string[];
    serverAliases?: Record<string, string[]>;
    toolAllowlist?: string[];
  };
};

export type TaskMonitorDelegationRecord = {
  causalContext?: Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">;
  activeCommandCount: number;
  backend: AppServerBackendKind;
  /**
   * The prompt that started the monitor. A Claude recovery turn can start in
   * a fresh session, so it repeats the brief.
   */
  brief?: string;
  createdAt: number;
  cwd?: string;
  executionMode?: ThreadExecutionMode;
  finalHandoffPrompt?: string;
  lastActivityAt: number;
  latestUsage?: TaskMonitorUsageSnapshot;
  monitorId: string;
  mcpAccess?: TaskMonitorMcpAccess;
  pendingMcpApprovalCount?: number;
  deniedMcpTools?: Set<string>;
  monitorThreadId?: string;
  monitorTurnId?: string;
  parentBackend: AppServerBackendKind;
  parentThreadId: string;
  parentTurnId: string;
  rootTurnId?: string;
  heartbeatIntervalSeconds: number;
  pollIntervalSeconds: number;
  preferredModel: string;
  preferredReasoningEffort: string;
  persistedStatus?: ThreadSubAgentSummary["status"];
  /** The latest progress the monitor reported, oldest first. */
  recentProgress?: string[];
  runtimeModel?: string;
  cancellation?: TaskMonitorCancellationState;
  finalizationStarted?: boolean;
  recoveryAttempted?: boolean;
  staleInterruptAttempted?: boolean;
  /**
   * A Claude monitor ended its turn while a background watcher ran. The
   * watcher's notification starts the next turn, so no recovery runs.
   */
  awaitingClaudeTaskWake?: boolean;
  startupTimeoutSeconds: number;
  task: string;
};

export type ReviewSubAgentRecord = {
  /** Backend running the review child. */
  backend: AppServerBackendKind;
  /**
   * Workspace, branch, and pull request the review was started against,
   * resolved once at start. Held on the record so the completion entry reports
   * the same facts as the start entry rather than re-deriving them from a
   * thread that may have moved on.
   */
  context?: AppServerReviewContext;
  createdAt: number;
  displayText: string;
  fastMode?: boolean;
  latestUsage?: TaskMonitorUsageSnapshot;
  mode: "managed" | "native";
  model?: string;
  reasoningEffort?: string;
  /** Backend owning the thread being reviewed. */
  parentBackend: AppServerBackendKind;
  parentThreadId: string;
  serviceTier?: string;
  reviewThreadId: string;
  task: string;
  turnId: string;
};

export type ReviewTerminal = {
  backend: AppServerBackendKind;
  completedAt?: number;
  errorMessage?: string;
  method: "turn/completed" | "turn/failed" | "turn/cancelled";
  threadId: string;
  turnId: string;
};

export type PendingReviewStartRecord = {
  turnAttribution?: ReturnType<typeof delegatedTurnAttribution>;
  pendingReviewId: string;
  backend: AppServerBackendKind;
  threadId: string;
  invokingTurnId: string;
  request: StartReviewRequest;
  createdAt: number;
  updatedAt: number;
  idempotencyKey?: string;
  status: "scheduled" | "starting" | "started" | "cancelled" | "failed";
  reviewThreadId?: string;
  reviewTurnId?: string;
  error?: string;
};

export type CodexNativeSubAgentTool =
  | "spawnAgent"
  | "sendInput"
  | "resumeAgent"
  | "wait"
  | "closeAgent";

export type CodexNativeSubAgentCall = {
  activityBoundary?: boolean;
  item: Record<string, unknown>;
  itemId?: string;
  parentTurnId?: string;
  receiverThreadIds: string[];
  receiverThreadNames: Map<string, string>;
  tool: string;
};

export type CodexNativeSubAgentReconciliation = {
  attempts: number;
  parentThreadId: string;
  receiverThreadId: string;
  startedAt: number;
  timer?: NodeJS.Timeout;
};

export type CodexNativeSubAgentNotification = {
  lastMessage?: string;
  receiverThreadId: string;
  status: ThreadSubAgentSummary["status"];
};

export type TaskMonitorTokenUsageBreakdown = {
  cacheWriteInputTokens?: number;
  cachedInputTokens?: number;
  inputTokens?: number;
  uncachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

export type TaskMonitorTokenUsageRecords = {
  currentUsage?: TaskMonitorTokenUsageBreakdown;
  latestUsage?: TaskMonitorTokenUsageBreakdown;
  totalUsage?: TaskMonitorTokenUsageBreakdown;
};

// Running tally of observed context replays within one live turn. Each model
// request inside a turn resubmits the working context (one "replay"); the
// protocol reports it as a fresh `last` breakdown while `total.inputTokens`
// grows by that request's input. A replay is "hot" when its input was
// predominantly cache-served, else "cold" (cache miss).
export type ObservedContextReplayTally = {
  coldReplayCount: number;
  coldReplayUncachedTokens: number;
  hotReplayCachedTokens: number;
  hotReplayCount: number;
};

export type LiveThreadContextWindowObservation = {
  finalContextTokens: number;
  modelContextWindow: number;
  peakContextTokens: number;
};

// Per-thread replay-observation cursor.
export type ObservedContextReplayCursor = {
  // High-water mark of the session's cumulative `total.inputTokens`. A replay is
  // counted only when this grows, which makes duplicate re-emissions and a
  // forked thread's inherited baseline no-ops.
  cumulativeInputTokens: number;
  // Approximate working-context size after the most recent observed request
  // (its input plus its output). Used to cap COLD replay attribution: a cold
  // request's uncached tokens include both the replayed context AND any fresh
  // prompt/tool content submitted with it — only the portion up to the prior
  // context size is replay overhead; the rest would have been paid regardless.
  // Absent until the thread's first observed request (e.g. right after app
  // start), in which case cold attribution falls back to the full uncached.
  lastContextTokens?: number;
};

export type ThreadCompactionBoundary = {
  itemId?: string;
  threadId: string;
  turnId?: string;
};

export type ObservedContextWindowDrop = {
  cumulativeInputTokens: number;
  currentContextTokens: number;
  previousCumulativeInputTokens: number;
  previousContextTokens: number;
};

export type ReportedCompactionRequestBoundary = {
  cumulativeInputTokens?: number;
  itemId?: string;
  observedAt: number;
  turnId?: string;
};

export type TaskMonitorTokenUsage = TaskMonitorUsageSnapshot["tokenUsage"];

/** A snapshot without its summary; every count except cache writes is set. */
export type TaskMonitorUsageTotals = Omit<TaskMonitorUsageSnapshot, "summary" | "tokenUsage"> & {
  tokenUsage: Required<Omit<TaskMonitorTokenUsage, "cacheWriteInputTokens">>
    & Pick<TaskMonitorTokenUsage, "cacheWriteInputTokens">;
};

export type PersistedCodexNativeUsageBackfill = {
  completedAt?: number;
  monitorTurnId?: string;
  usage: TaskMonitorUsageSnapshot;
};

export type TokenMiserLedgerIndexes = {
  pricing: TokenMiserPricingIndex;
  replays: TokenMiserCachedReplayIndex;
};

export type ThreadPricingLedger = NonNullable<AppServerReadThreadResponse["pricing"]>;

export type ClaudeTurnTimes = { completedAt?: number; startedAt?: number };

export type CodexDiscoveryObserver = {
  /**
   * Codex answered `initialize`. Its model, account, and rate-limit reads all
   * wait on that handshake, so what remains after it is those reads.
   */
  onCodexConnected?: () => void;
};

export type ModelSettings = {
  model?: string;
  reasoningEffort?: string;
  reasoningEffortsByModel?: Record<string, string>;
  serviceTier?: string;
  fastMode?: boolean;
  providerSettings?: NavigationLaunchpadDefaults["providerSettings"];
};

export type CodexFastModeMismatchWarning = {
  threadId: string;
  turnId: string;
  expectedFastMode: boolean;
  observedFastMode: boolean;
  observedServiceTier?: string | null;
};

export type ObservedCodexSettings = {
  fastMode?: boolean;
  serviceTier?: string | null;
  rawServiceTier?: string | null;
  observedAt: number;
};

export type ThreadListCallerReason =
  | "archive-cleanup"
  | "branch-drift"
  | "ipc-list-threads"
  | "messaging-navigation-snapshot"
  | "navigation-snapshot"
  | "startup-prewarm"
  | "title-generation"
  | "workspace-handoff"
  | (string & {});

export type StartupProviderThreadRefresh = Readonly<{
  backends: readonly AppServerBackendKind[];
  threads: readonly AppServerThreadSummary[];
}>;

export type McpGatewayConversationConsent = {
  readOnlyOnly?: boolean;
  schemaRevision: string;
  selectionRevision?: string;
  approved: boolean;
};

export type ThreadListCacheState = {
  archived: boolean;
  expiresAt?: number;
  promise?: Promise<AppServerThreadSummary[]>;
  threads?: AppServerThreadSummary[];
};

export type ThreadListCacheHit = {
  cacheKey: string;
  expiresInMs?: number;
  pending: boolean;
  source: "exact" | "navigation-shared";
  threadCount?: number;
  value: Promise<AppServerThreadSummary[]> | AppServerThreadSummary[];
};

/**
 * One row of a directory, reduced to what deciding a new thread's visibility
 * needs: how to reach its top-level ancestor, whether that ancestor renders,
 * and how to address it for a pin.
 */
export type CreatedThreadVisibilityRow = {
  backend: AppServerBackendKind;
  /** Absent once the walk reaches a row this directory renders top-level. */
  parentKey?: string;
  pinned: boolean;
  /**
   * True when this directory renders the row as a peer's thread. Its pin lives
   * in `remote_thread_pins`, not the local thread overlay, so the local
   * mutators must not be aimed at it.
   */
  remote: boolean;
  subthreadsCollapsed: boolean;
  threadId: string;
};

export type CreatedThreadDirectoryVisibility = Pick<
  NavigationDirectorySummary,
  "key" | "kind" | "path"
> & {
  directoryThreadsCollapsed: boolean;
  hasPinnedTopLevelThread: boolean;
  /** Keyed exactly as `directory.threadKeys` names each row. */
  rowsByThreadKey: ReadonlyMap<string, CreatedThreadVisibilityRow>;
  /**
   * `<backend>:<threadId>` for every row above, including the peer-owned ones
   * that `rowsByThreadKey` files under a federated key. A creation request
   * names its parent by backend and id alone, so this is the only way to find
   * a remote parent's row from one.
   */
  rowKeysByLocalKey: ReadonlyMap<string, string>;
};

export type MessagingArchiveCleanupStore = Pick<
  MessagingStoreLike,
  | "deletePendingIntentsForThread"
  | "findActiveBindingsForBackend"
  | "findActiveBindingsForThread"
  | "revokeBinding"
>;

export type MessagingArchiveCleaner = {
  requestBindingRevokeAllForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    origin: "thread-archive";
  }): Promise<{
    notifiedCount: number;
    revokedCount: number;
  }>;
};

export type MessagingArchiveCleanupResult = {
  error?: string;
  notifiedCount?: number;
  pendingIntentCount: number;
  revokedCount: number;
};

/**
 * What the backend registry needs from the MCP connection gateway.
 *
 * Named rather than inlined because it is no longer one method: the registry
 * registers bridges for a turn, records when a selection reached the agent,
 * and answers the agent tool's read operations. Tests supply a stub for
 * exactly this shape.
 */
/** A project grant a tool approval card offers, and what accepting it writes. */
export type McpProjectToolApprovalCardOffer = {
  connectionId: string;
  repository: string;
  offer: McpProjectToolApprovalOffer;
};

export type BackendRegistryMcpConnectionService =
  Pick<McpConnectionGatewayService, "registerBridge">
  // Everything past bridge registration is optional so a test can stub the
  // one method it exercises. A runtime that supplies only `registerBridge`
  // still starts turns; it just cannot answer the agent tool's reads, which
  // the handler reports rather than crashing on.
  & Partial<
    Pick<
      McpConnectionGatewayService,
      | "noteThreadHandover"
      | "threadHandoverAt"
      | "peekThreadBridge"
      | "listConnections"
      | "setConnectionProjectToolApproval"
      | "createConnection"
      | "probeConnection"
      | "requestGatewayToolOperation"
      | "closeThreadSessions"
      | "readThreadSessionStates"
      | "reconnectThreadConnection"
      | "setThreadRootsResolver"
      | "noteThreadDirectoriesChanged"
    >
  >;

/** See `DesktopBackendRegistry.readThreadHandoffSettings`. */
export type HandoffSourceSettings = {
  executionMode: ThreadExecutionMode;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  fastMode?: boolean;
  /** The thread's environment, when it runs one locally. */
  codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
};

/** See `DesktopBackendRegistry.setAgentThreadActions`. */
export type AgentThreadActions = {
  markProjectRead?: (args: MarkProjectReadToolArgs) => Promise<MarkProjectReadResult>;
  archiveThread: (request: ArchiveThreadRequest) => Promise<ArchiveThreadResponse>;
  setThreadPin: (request: SetThreadPinRequest) => Promise<SetThreadPinResponse>;
  markThreadSeen: (
    request: MarkThreadSeenRequest,
  ) => Promise<MarkThreadSeenResponse>;
  /** The sidebar's own path, so every window hears the new grouping. */
  setThreadParent?: (
    request: SetThreadParentRequest,
  ) => Promise<SetThreadParentResponse>;
};

/** The app-level Thread maintenance service, injected so the registry never
 * imports the runtime that constructs it. */
export type ThreadMaintenanceToolHandler = {
  /** Runs a scan the service retains under `scanId`. */
  scan: (request: { rules?: Partial<ThreadMaintenanceRules>; projectKey?: string; scanId: string }) => Promise<ThreadMaintenanceScan>;
  getScan: (scanId: string) => ThreadMaintenanceScan | undefined;
  getRun: () => ThreadMaintenanceRun | undefined;
  start: (request: ThreadMaintenanceApplyRequest) => { run: ThreadMaintenanceRun; done: Promise<ThreadMaintenanceRun> };
  open: (request: { projectKey?: string }) => boolean;
};

/**
 * A turn's origin while its `user:<turnId>` row is not yet written. `turnId`
 * is unset until the provider's start call returns it.
 */
export type StartingTurnOrigin = {
  backend: AppServerBackendKind;
  threadId: string;
  origin: AppServerThreadMessageOrigin;
  turnId?: string;
};

export type PendingThreadMessageContext = {
  backend: AppServerBackendKind;
  createdAt: number;
  admittedCodexTurnSequence?: number;
  id: string;
  messageId?: string;
  imageParts?: AppServerThreadImagePart[];
  retainedInput?: AppServerTurnInputItem[];
  origin?: AppServerThreadMessageOrigin;
  text?: string;
  threadId: string;
  turnId?: string;
  turnEnded?: boolean;
};

export type AcceptedThreadControlRequest = {
  promise: Promise<PwrAgentThreadOrchestrationResponse>;
  signature: string;
};

export type AcceptedDynamicToolCall = {
  promise: Promise<unknown>;
  signature: string;
};

export type AcceptedActiveTurnControlRequest = {
  promise: Promise<ControlActiveTurnResponse>;
  signature: string;
};

export type CodexRetryableTurnStart = {
  kind: "turn";
  params: {
    backend: "codex";
    threadId: string;
    input: AppServerTurnInputItem[];
    origin?: ThreadTurnQueueOrigin;
    executionMode?: ThreadExecutionMode;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    messageOrigin?: AppServerThreadMessageOrigin;
    agentMessageOrigins?: AppServerThreadMessageOrigin[];
    agentMessages?: ThreadTurnQueueEntry["agentMessages"];
  };
  terminalObserved?: boolean;
  turnId?: string;
};

export type BackendRegistryOverlayStoreLike = OverlayStoreLike & Partial<Pick<OwnerThreadRegistry, "getThreadMetadata" | "updateThreadMetadata">> & Partial<
  Pick<
    DesktopOwnerStorage,
    | "acknowledgeThreadEnvironmentFailure"
    | "adoptLegacyRemoteDirectoryLaunchpad"
    | "readThreadGitWorkingStateCache"
    | "completeThreadUsageTurn"
    | "completeThreadUsageTurns"
    | "repairUnfinishedThreadUsageTurns"
    | "readThreadUsageTurnTimeRepairCandidates"
    | "repairThreadUsageTurnTimes"
    | "readUsageActivity"
    | "listRemoteThreadPins"
    | "listThreadCompactions"
    | "recordThreadCompaction"
    | "readTokenMiserGatePricingLines"
    | "reconcileOrphanedThreadSubAgents"
    | "moveLegacyThreadSubAgents"
    | "moveLegacyThreadUsageActivities"
    | "readThreadUsageActivities"
    | "readThreadUsageActivityForTurn"
    | "readThreadUsageSettings"
    | "markThreadToolInvocationsNoisy"
    | "setThreadSpendAlertPending"
    | "persistThreadToolInvocationBoundary"
    | "upsertThreadSubAgents"
    | "upsertThreadUsageLines"
    | "writeThreadGitWorkingStateCacheEntry"
    | "getVoiceManagerThread"
    | "getArchiveCleanupOverlayStates"
    | "readArchiveCleanupChangeToken"
  >
>;

export type CodexRetryableCompaction = {
  kind: "compact";
  params: { backend: "codex"; threadId: string };
  invalidIdRecoveryAttempted?: boolean;
  lifecycleStarted?: boolean;
  terminalObserved?: boolean;
  turnId?: string;
};

export type CodexRetryableOperation = CodexRetryableTurnStart | CodexRetryableCompaction;

export type PendingCodexInvalidIdRecovery = CodexRetryableOperation & {
  audit: ThreadCodexInvalidIdRecovery;
  failureMessage: string;
  /** The last status told to the operator was `waiting`. */
  reportedWaiting: boolean;
  completion: Promise<{
    backend: "codex";
    threadId: string;
    turnId: string;
  }>;
  reject: (error: unknown) => void;
  resolve: (result: {
    backend: "codex";
    threadId: string;
    turnId: string;
  }) => void;
};

/** A pricing publish a flush held back for its caller to send. */
export type DeferredThreadPricing = {
  activeTurnIds: string[];
};

export type PendingLiveThreadUsageLine = {
  backend: AppServerBackendKind;
  line: ThreadUsageLineRecord;
  observationSequence: number;
};

export type LiveThreadUsageBatch = {
  deferredPricing?: DeferredThreadPricing;
  pricingTargets: { activeTurnIds: Set<string>; backend: AppServerBackendKind; threadId: string }[];
};

/**
 * A running native worker's latest usage, not yet in sqlite: the card's copy,
 * and its priced usage lines by id (one per worker turn).
 */
export type LiveCodexNativeSubAgentUsage = Pick<
  ThreadSubAgentSummary,
  "monitorUsage" | "preferredModel" | "preferredReasoningEffort" | "updatedAt"
> & {
  lines: ReadonlyMap<string, ThreadUsageLineRecord>;
};

export type LiveThreadUsageEmitWork = {
  backend: AppServerBackendKind;
  derivationFinished: boolean;
  derivationKey: string;
  derivationTail: Promise<void>;
  observationSequence: number;
  precedingDerivation: Promise<void>;
  settleDerivation: () => void;
  settled: Promise<void>;
  settle: () => void;
  threadId: string;
};

export type RecentlyCompletedThreadUsageTurn = {
  completedAt?: number;
  startedAt?: number;
  turnId: string;
};

export type LiveThreadUsageAggregate = {
  latestUsage?: TaskMonitorTokenUsageBreakdown;
  usage: TaskMonitorTokenUsageBreakdown;
};

export type LiveThreadRequestUsage = {
  cumulativeInputTokens: number;
  requests: TaskMonitorTokenUsageBreakdown[];
};

export type RequestComponentsCost = {
  cacheWriteInputCostMicros: number;
  cachedInputCostMicros: number;
  catalogId: string;
  catalogVersion: string;
  currency: "USD";
  outputCostMicros: number;
  provider: string;
  rateId?: string;
  serviceTier: string;
  totalCostMicros: number;
  uncachedInputCostMicros: number;
};

export type DerivedLiveThreadTokenUsage = {
  // Whether turnTokenUsage is a real measurement of this turn — a per-turn
  // delta or a per-request "last" snapshot — vs a fallback to a whole-thread
  // total we could not decompose.
  attributed: boolean;
  cumulativeTokenUsage?: TaskMonitorTokenUsageBreakdown;
  turnTokenUsage: TaskMonitorTokenUsageBreakdown | unknown;
  /**
   * The `total - latest` baseline, set only on the call that first seeds it
   * for a `(thread, turn)`. For a fork's first observed turn this equals the
   * context copied in at the fork point.
   */
  seededBaselineTokenUsage?: TaskMonitorTokenUsageBreakdown;
};
