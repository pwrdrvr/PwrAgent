import type { UsageLimitObservation } from "@pwragent/shared/contracts/usage-activity";
import type { TurnInputSource } from "@pwragent/owner-core/turn-input-source";
import type {
  AcpBackendId,
  AppServerBackendKind,
  AppServerPendingRequestNotification,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  AppServerThreadMessageOrigin,
  AppServerThreadSummary,
  AppServerTurnInputItem,
  ArchiveThreadRequest,
  ArchiveThreadResponse,
  CodexThreadEnvironmentRuntime,
  LinkedDirectorySummary,
  RenameThreadRequest,
  RenameThreadResponse,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import type {
  AgentEvent,
  AppServerCollaborationModeRequest,
  StartThreadRequest,
  StartThreadResponse,
} from "@pwragent/shared/contracts/agent";
import type {
  BackendAcpSessionRuntimeState,
  BackendLaunchpadOptions,
  BackendModelOption,
} from "@pwragent/shared/contracts/backend";
import type { MessagingDynamicToolCategory } from "@pwragent/shared/contracts/rbac";
import type { NavigationLaunchpadDraft, ThreadOverlayState } from "@pwragent/shared/contracts/navigation";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import type {
  BackendClient,
  BackendRegistryForkThreadRequest,
  PendingThreadStartDescriptor,
  PendingThreadStartReporter,
  PendingThreadStartSource,
  ModelSettings,
  TaskMonitorDelegationRecord,
  ThreadListCallerReason,
} from "./backend-registry-types";
import type {
  ThreadTurnQueueOrigin,
  ThreadTurnQueueSubmissionResult,
} from "@pwragent/owner-core/thread-turn-queue";
import type { AcpMcpServerRegistration } from "../acp/acp-client";
import type { BackendModelCatalogCallerReason } from "./backend-model-catalog";
import type { ThreadRenameOptions } from "@pwragent/owner-core/thread-naming-lifecycle";
import type { WorktreeBaseSource } from "./git-directory-service";

/**
 * A registry read. Renderer and federation reads rebuild the request field
 * by field, so neither can set `preserveAutomaticArchive`; main-process
 * callers and the local Outpost CLI's `show` can.
 */
export type RegistryReadThreadRequest = AppServerReadThreadRequest & {
  /**
   * A background evaluation read, such as a Continue After prerequisite or
   * idle check, is not use of the thread. It leaves a pending automatic
   * archive in place; every other read cancels it.
   */
  preserveAutomaticArchive?: true;
};

/**
 * Shared registry operations. Module hosts pick only the capabilities they use;
 * this contract must stay independent of the registry and its domain modules.
 */
export interface RegistryHostPorts {
  withGoalHibernation<T>(
    identity: { backend: AppServerBackendKind; threadId: string },
    work: () => Promise<T>,
  ): Promise<T>;
  admitNewThreadModelSettings(
    backend: AppServerBackendKind,
    settings: ModelSettings & { acpRuntime?: BackendAcpSessionRuntimeState },
  ): Promise<ModelSettings>;
  archiveThread(request: ArchiveThreadRequest & { preserveWorktrees?: boolean }): Promise<ArchiveThreadResponse>;
  assertNotBootstrap(method: string): void;
  assertThreadNotLocked(backend: AppServerBackendKind, threadId: string): Promise<void>;
  assertThreadOwnership(): void;
  dynamicToolPermissionDenied(
    backend: AppServerBackendKind,
    category: MessagingDynamicToolCategory,
    call: { threadId: string; turnId?: string; tool: string; arguments?: unknown },
  ): Promise<string | null>;
  findHeadlessAutomationTurnForRequest(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
  ): {
    agentThreadId: string;
    automationName?: string;
    automationRunId: string;
    executionMode: ThreadExecutionMode;
    queueEntryId: string;
    mcpConnectionIds?: string[];
    mcpGrantedConnectionIds?: string[];
    mcpServerAliases?: Record<string, string[]>;
    mcpAllowedServerNames?: string[];
    toolAllowlist?: string[];
  } | undefined;
  findThreadForWorkspaceHandoff(params: {
    backend: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    freshness?: "last-known" | "provider";
    threadId: string;
  }): Promise<AppServerThreadSummary | undefined>;
  getActiveTurnForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): { backend: AppServerBackendKind; threadId: string; turnId: string } | undefined;
  getBackendLaunchpadOptions(
    backend: AppServerBackendKind,
    callerReason: BackendModelCatalogCallerReason,
  ): Promise<BackendLaunchpadOptions | undefined>;
  getCachedThreadSummary(params: {
    backend?: AppServerBackendKind;
    threadId: string;
  }): AppServerThreadSummary | undefined;
  getClient(backend: AppServerBackendKind, executionMode?: ThreadExecutionMode): BackendClient;
  invalidateThreadListCache(
    backend?: AppServerBackendKind,
    workspaceChanged?: boolean,
    threadId?: string,
    paths?: readonly string[],
  ): void;
  isLiveDynamicToolCall(backend: AppServerBackendKind, call: { threadId: string; turnId?: string }): boolean;
  isTaskMonitorThread(context: { backend: AppServerBackendKind; threadId: string }): boolean;
  listThreads(params?: {
    archived?: boolean;
    backend?: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    enrichDirectories?: boolean;
    skipPendingDirectoryEnrichment?: boolean;
    filter?: string;
    forceRefresh?: boolean;
    limit?: number;
    maxPages?: number;
    skipArchivedMetadataRefresh?: boolean;
  }): Promise<AppServerThreadSummary[]>;
  liveProfileRuntimeInstanceIds(): string[] | undefined;
  liveSubAgentMonitorIds(backend: AppServerBackendKind, threadId: string): string[];
  prepareTokenMiserRuntime(): Promise<void>;
  publishLocalEvent(event: AgentEvent): Promise<void>;
  readCausalMessagingContext(
    context: { backend: AppServerBackendKind; threadId: string; turnId?: string },
  ): Promise<
    Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">
  >;
  readTurnCausalMessagingOrigin(
    context: { backend: AppServerBackendKind; threadId: string; turnId?: string },
  ): Promise<AppServerThreadMessageOrigin | undefined>;
  readCodexDefaultModelsOnce(callerReason: BackendModelCatalogCallerReason): Promise<BackendModelOption[]>;
  readDelegatedTurnAncestry(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId?: string;
  }): Promise<{ parentTurnId?: string; rootTurnId?: string }>;
  readThread(request: RegistryReadThreadRequest): Promise<AppServerReadThreadResponse>;
  recordCodexWorktreeOwnerThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    worktreePath?: string;
  }): Promise<void>;
  renameThread(request: RenameThreadRequest, options?: ThreadRenameOptions): Promise<RenameThreadResponse>;
  resolveAgentCallerExecutionMode(context: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId?: string;
    overlay?: ThreadOverlayState;
  }): Promise<ThreadExecutionMode>;
  resolveClaudeToolCallExecutionMode(
    threadId: string,
    automationMode?: ThreadExecutionMode,
  ): Promise<ThreadExecutionMode | undefined>;
  resolveCodexThreadExecutionModeForActiveTurn(threadId: string): Promise<ThreadExecutionMode>;
  resolveCodexToolCallExecutionMode(
    context: AgentToolCallContext,
    automationMode?: ThreadExecutionMode,
  ): Promise<ThreadExecutionMode | undefined>;
  resolveModelSettings(
    backend: AppServerBackendKind,
    settings: ModelSettings,
    callerReason?: BackendModelCatalogCallerReason,
  ): Promise<ModelSettings>;
  resolveThreadEnvironmentCwd(
    backend: AppServerBackendKind,
    threadId: string,
    overlay?: ThreadOverlayState,
  ): Promise<string | undefined>;
  startAcpSession(params: {
    backend: AcpBackendId;
    cwd?: string;
    executionMode: ThreadExecutionMode;
    acpRuntime?: BackendAcpSessionRuntimeState;
    reasoningEffort?: string;
    mcpRegistration?: AcpMcpServerRegistration;
    hidden?: boolean;
  }): Promise<{ threadId: string }>;
  startAcpTurn(params: {
    backend: AcpBackendId;
    threadId: string;
    input: AppServerTurnInputItem[];
    model?: string;
    reasoningEffort?: string;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }>;
  /** A missing or local instance id resolves to the local owner. */
  ownerRelativeInstanceId(instanceId: string | undefined): string | undefined;
  startThread(params: {
    backend: AppServerBackendKind;
    executionMode?: ThreadExecutionMode;
    cwd?: string;
    directoryKey?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    mcpConnectionIds?: string[];
    mcpProviderServersEnabled?: boolean;
    agent?: StartThreadRequest["agent"];
    acpRuntime?: BackendAcpSessionRuntimeState;
    workMode?: NavigationLaunchpadDraft["workMode"];
    branchName?: string;
    worktreeBranchMode?: BackendRegistryForkThreadRequest["worktreeBranchMode"];
    /** Base for a new worktree when `branchName` is unset. */
    worktreeBase?: WorktreeBaseSource;
    requiredWorkMode?: NavigationLaunchpadDraft["workMode"];
    parentThreadId?: string;
    parentThreadBackend?: AppServerBackendKind;
    parentThreadInstanceId?: string;
    prAutoDispatchEnabled?: boolean;
    tokenMiserEnabled?: boolean;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    /**
     * Run the environment's setup in the new workspace even when it is not a
     * new worktree. A named environment has never run there.
     */
    rerunCodexEnvironmentSetup?: boolean;
    linkedDirectories?: LinkedDirectorySummary[];
    /**
     * Report the start to every list while its workspace is prepared, as a
     * starting row (`thread/start/pending`). For callers with no row of
     * their own: a launchpad draws its own.
     */
    pendingStart?: PendingThreadStartDescriptor;
  }, preparedStart?: PendingThreadStartReporter): Promise<StartThreadResponse>;
  withPendingThreadStart<T>(
    source: PendingThreadStartSource,
    descriptor: PendingThreadStartDescriptor | undefined,
    run: (pending?: PendingThreadStartReporter) => Promise<T>,
  ): Promise<T>;
  startTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    executionMode?: ThreadExecutionMode;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    messageOrigin?: AppServerThreadMessageOrigin;
  }, turnInputSource?: TurnInputSource): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }>;
  submitTurn(params: {
    queueEntryId?: string;
    backend: AppServerBackendKind;
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
    automationRunId?: string;
    messageOrigin?: AppServerThreadMessageOrigin;
    delivery?: "new_turn";
  }, turnInputSource?: TurnInputSource): Promise<ThreadTurnQueueSubmissionResult>;
  taskMonitorForThread(context: { backend: AppServerBackendKind; threadId: string }): TaskMonitorDelegationRecord | undefined;
  threadHasActiveTurn(
    threadId: string,
    backend?: AppServerBackendKind,
    ignoreCodexStartReservation?: boolean,
  ): boolean;
  turnLimitObservation(backend: AppServerBackendKind): UsageLimitObservation | undefined;
  withArchiveWorkspaceWrite<T>(paths: readonly string[], work: () => Promise<T>): Promise<T>;
  withCodexThreadClient<T>(
    threadId: string,
    operation: (client: BackendClient, mode: ThreadExecutionMode) => Promise<T>,
    requestedMode?: ThreadExecutionMode,
    // Whether to emit the routing diagnostic. Reads (readThread) are
    // execution-mode-agnostic and get called once per thread by content
    // search, so they opt out — otherwise a single thread search spews one
    // routing line per thread. Turn/execution paths keep it on (the #203
    // security cross-check in messaging-controller relies on it).
    logRouting?: boolean,
  ): Promise<T>;
}

/** Keep a query's smaller result view while sharing its complete parameter list. */
export type RegistryHostQueryResult<
  Operation extends "findHeadlessAutomationTurnForRequest" | "getActiveTurnForThread",
  Fields extends keyof NonNullable<ReturnType<RegistryHostPorts[Operation]>>,
  Optional extends boolean = false,
> = (...args: Parameters<RegistryHostPorts[Operation]>) => (
  Optional extends true
    ? Partial<Pick<NonNullable<ReturnType<RegistryHostPorts[Operation]>>, Fields>>
    : Pick<NonNullable<ReturnType<RegistryHostPorts[Operation]>>, Fields>
) | undefined;
