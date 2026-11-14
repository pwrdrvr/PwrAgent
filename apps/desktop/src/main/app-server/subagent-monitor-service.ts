import type { RegistryContext, RegistryHost } from "./registry-context";
import type { ForgeToolBridge } from "./forge-tool-bridge";
import type { ThreadMcpConnections } from "./thread-mcp-connections";
import type { ManagedReviewService } from "./managed-review-service";
import { buildPwrAgentTaskMonitorToolDefinitions } from "../agent-tools/pwragent-task-monitor-agent-tools";
import type { ClaudeSubAgentCard } from "../claude/claude-tasks";
import { withCodexRequestActivity } from "../codex-app-server/request-activity";
import { randomUUID } from "node:crypto";
import os from "node:os";
import type {
  ThreadSource as CodexThreadSource,
} from "@pwrdrvr/codex-app-server-protocol/v2";
import type { AcpMcpServerRegistration } from "../acp/acp-client";
import {
  type AcpBackendId,
  CLAUDE_NATIVE_SUBAGENT_MONITOR_ID_PREFIX,
  codexNativeSubAgentName,
  isClaudeNativeSubAgent,
  isCodexNativeSubAgentVisibleInNavigation,
  type AgentEvent,
  type ThreadLock,
  type AppServerNotification,
  type AppServerReadThreadRequest,
  type AppServerReadThreadResponse,
  type AppServerThreadActivityEntry,
  type AppServerThreadCommandDetail,
  type AppServerThreadMessageOrigin,
  type AppServerThreadReplay,
  type AppServerThreadSummary,
  CODEX_NATIVE_SUBAGENT_PANEL_RETENTION_MS,
  type AppServerTurnInputItem,
  type AppServerBackendKind,
  type AppServerCollaborationModeRequest,
  type BackendAcpSessionRuntimeState,
  type BackendModelOption,
  type StopSubAgentRequest,
  type StopSubAgentResponse,
  type ThreadExecutionMode,
  type ThreadOverlayState,
  type ThreadSubAgentSummary,
  type ThreadUsageLineRecord,
  buildThreadIdentityKey,
  isAcpBackendId,
  DEFAULT_TASK_MONITOR_POLL_INTERVAL_SECONDS,
  DEFAULT_TASK_MONITOR_STARTUP_TIMEOUT_SECONDS,
  resolveHelperModel,
  automaticProviderMonitorModel,
  isLightweightHelperModel,
  type DesktopHelperModelSettings,
  type DesktopTaskMonitorModelChoice,
  type CancelMonitorDelegationToolArgs,
  type CompleteMonitoringToolArgs,
  type CreateMonitorDelegationToolArgs,
  type InjectMonitorProgressToolArgs,
  type TaskMonitorCompletionSource,
  type TaskMonitorRequest,
  type TaskMonitorResponse,
  type TaskMonitorUsageSnapshot,
  threadLockRefusalMessage,
  type ProjectHeldWakeupSource,
} from "@pwragent/shared";
import {
  findAcpThoughtLevelConfigOption,
  withAcpModelRuntimeSelection,
} from "./acp-backend-adapter";
import {
  buildMonitorParentAgentGuidance,
  buildMonitorDelegationPrompt,
  findUnsupportedCodexExecSessionReference,
  normalizePollIntervalSeconds,
} from "./task-monitor-codex-tools";
import {
  AgentToolRouter,
} from "../agent-tools/agent-tool-router";
import { buildMcpGatewayToolDefinitions } from "../agent-tools/pwragent-mcp-gateway-tools";
import type { McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service";
import { getMainLogger } from "../log";
import {
  type BackendModelCatalogCallerReason,
} from "./backend-model-catalog";
import {
  type ThreadTurnQueueEntry,
  type ThreadTurnQueueOrigin,
  type ThreadTurnQueueSubmissionResult,
} from "@pwragent/owner-core/thread-turn-queue";
import {
  summarizeProjectHeldWakeup,
  type ProjectForgeAutomationResolution,
} from "./project-forge-automation-index";
import {
  readNotificationItemType,
  textFragmentsFromCodexNotification,
  turnIdFromTerminalNotification,
} from "./backend-registry-notifications";
import {
  type BackendClient,
  type CodexNativeSubAgentCall,
  type CodexNativeSubAgentReconciliation,
  type DerivedLiveThreadTokenUsage,
  type LiveCodexNativeSubAgentUsage,
  type ObservedContextReplayTally,
  type RecentlyCompletedThreadUsageTurn,
  type StartingTurnOrigin,
  type TaskMonitorCancellationState,
  type TaskMonitorDelegationRecord,
} from "./backend-registry-types";
import {
  TASK_MONITOR_RECOVERY_PROGRESS_LIMIT,
  TASK_MONITOR_STALE_GRACE_MS,
} from "./backend-registry-runtime-helpers";
import { executionModeSettings } from "./execution-mode-settings";
import {
  ActiveTurnKeySet,
  buildActiveTurnKey,
  buildActiveTurnModeKey,
  buildReviewSubAgentKey,
  reviewSubAgentId,
  taskMonitorThreadKey,
} from "./thread-turn-keys";
import {
  buildTaskMonitorMessageOrigin,
  buildTaskMonitorPromptOrigin,
  isCausalMessagingContext,
} from "./thread-transcript-helpers";
import {
  readBooleanLike,
  readNonEmptyString,
  readOptionalString,
  readRecord,
} from "./backend-registry-notification-values";
import {
  buildCodexConnectionMcpConfig,
  codexMcpIsolationUnavailableError,
} from "./codex-thread-config";
import {
  buildPersistedCodexNativeUsageBackfill,
  buildTaskMonitorUsageLine,
  buildTaskMonitorUsageSnapshot,
  readTaskMonitorTokenUsageRecords,
  readTaskMonitorUsageFastMode,
  readTaskMonitorUsageModel,
  readTaskMonitorUsageServiceTier,
  readUsageNumber,
  withLiveCodexNativeSubAgentUsage,
} from "./thread-usage-math";
import {
  OPENAI_REASONING_EFFORTS,
  buildLaunchpadOptions,
  isLightweightMonitorReasoningEffort,
  readAcpThoughtLevelValues,
  selectLowestMonitorReasoningEffort,
} from "./thread-model-options";
import {
  CODEX_NATIVE_MONITOR_ID_PREFIX,
  CODEX_NATIVE_SUBAGENT_ACTIVITY_STATUS_DELAY_MS,
  CODEX_NATIVE_SUBAGENT_FINAL_READ_LIMIT,
  CODEX_NATIVE_SUBAGENT_INITIAL_STATUS_DELAY_MS,
  CODEX_NATIVE_SUBAGENT_MAX_RECONCILE_AGE_MS,
  CODEX_NATIVE_SUBAGENT_MAX_RECONCILE_ATTEMPTS,
  codexNativeSubAgentId,
  codexNativeSubAgentIsTerminal,
  codexNativeSubAgentNextReconciliationDelayMs,
  codexNativeSubAgentOutcome,
  codexNativeSubAgentTask,
  codexNativeToolForOperation,
  extractCodexNativeSpawnedAgentNames,
  extractCodexNativeSubAgentNotifications,
  groupCodexNativeSubAgents,
  isCodexNativeSubAgentPlaceholderTask,
  isCodexNativeSubAgentTool,
  mapCodexNativeSubAgentStatus,
  nativeSubAgentRowFromCard,
  readCodexNativeAgentState,
  readCodexNativeSubAgentCalls,
  reliableSubAgentCompletionBoundary,
  truncateSubAgentText,
} from "./codex-native-subagents";
import {
  buildTaskMonitorFinalHandoffInput,
  buildTaskMonitorRecoveryPrompt,
  formatTaskMonitorCompletionMessage,
  formatTaskMonitorProgressMessage,
  taskMonitorFailure,
  taskMonitorRecentActivity,
} from "./task-monitor-helpers";
import { logUnpricedThreadUsageLine } from "./unpriced-usage-line-log";

const backendRegistryLog = getMainLogger("pwragent:backend-registry");

/** Collaborators the composition root builds for this module. */
export interface SubAgentMonitorServiceDependencies {
  readonly forgeToolBridge: ForgeToolBridge;
  readonly managedReviewService: ManagedReviewService;
  readonly threadMcpConnections: ThreadMcpConnections;
}

/**
 * Registry-owned state and turn operations the sub-agent and task monitor
 * service reads. The registry's construction ports satisfy it; this module
 * never imports the registry. The Codex turn-activity sets stay
 * registry-owned: a managed task monitor's start reserves and records them
 * alongside the registry's own turn paths.
 */
export interface SubAgentMonitorServiceHost {
  readonly activeCodexTurnModes: Map<string, ThreadExecutionMode>;
  readonly activeTurnKeys: ActiveTurnKeySet;
  readonly mcpGatewayTools: McpGatewayToolService | undefined;
  readonly recentlyCompletedThreadUsageTurns: ReadonlyMap<string, RecentlyCompletedThreadUsageTurn>;
  readonly registrySessionId: string;
  readonly registrySessionStartedAt: number;
  readonly reservedCodexStartThreadIds: Set<string>;
  readonly resolveHelperModelSettingsFn: () => DesktopHelperModelSettings;
  readonly resolveTaskMonitorModelsFn: () => Record<string, DesktopTaskMonitorModelChoice>;
  readonly runtimeInstanceId: string;
  readonly shutdownRequested: boolean;
  readonly stoppingRunningTurnsForShutdown: boolean;
  readonly subAgentStartupReconciliation: Promise<void>;
  beginStartingTurnOrigin(params: {
    backend: AppServerBackendKind;
    threadId: string;
    origin?: AppServerThreadMessageOrigin;
  }): StartingTurnOrigin | undefined;
  bindStartingTurnOrigin(
    entry: StartingTurnOrigin | undefined,
    turn: { threadId: string; turnId: string },
  ): void;
  canStartThreadTurnImmediately(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): boolean;
  deliverProjectPausedWakeup(params: {
    project: ProjectForgeAutomationResolution;
    queueEntryId: string;
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    origin: ThreadTurnQueueOrigin;
    messageOrigin?: AppServerThreadMessageOrigin;
    source: ProjectHeldWakeupSource;
    summary: string;
  }): Promise<
    | Extract<ThreadTurnQueueSubmissionResult, { status: "queued" }>
    | { status: "discarded" }
  >;
  deriveLiveThreadTokenUsage(params: {
    appendLatestUsage?: boolean;
    backend: AppServerBackendKind;
    observationSequence?: number;
    threadId: string;
    tokenUsage: unknown;
    turnId?: string;
  }): DerivedLiveThreadTokenUsage;
  dropStartingTurnOrigin(entry: StartingTurnOrigin | undefined): void;
  emitThreadPricingUpdated(params: {
    activeTurnIds?: readonly string[];
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<void>;
  getCachedThreadSummary(params: {
    backend?: AppServerBackendKind;
    threadId: string;
  }): AppServerThreadSummary | undefined;
  getClient(backend: AppServerBackendKind, executionMode?: ThreadExecutionMode): BackendClient;
  interruptTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }>;
  invalidateThreadListCache(
    backend?: AppServerBackendKind,
    workspaceChanged?: boolean,
    threadId?: string,
    paths?: readonly string[],
  ): void;
  isLiveDynamicToolCall(
    backend: AppServerBackendKind,
    call: { threadId: string; turnId?: string },
  ): boolean;
  liveProfileRuntimeInstanceIds(): string[] | undefined;
  observeLiveThreadContextReplay(params: {
    backend: AppServerBackendKind;
    threadId: string;
    tokenUsage: unknown;
    turnId?: string;
  }): ObservedContextReplayTally | undefined;
  persistStartingTurnOrigin(entry: StartingTurnOrigin | undefined): Promise<void>;
  readCausalMessagingContext(
    context: { backend: AppServerBackendKind; threadId: string; turnId?: string },
  ): Promise<
    Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">
  >;
  readCodexDefaultModelsOnce(
    callerReason: BackendModelCatalogCallerReason,
  ): Promise<BackendModelOption[]>;
  readDelegatedTurnAncestry(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId?: string;
  }): Promise<{ parentTurnId?: string; rootTurnId?: string }>;
  readThread(request: AppServerReadThreadRequest): Promise<AppServerReadThreadResponse>;
  readThreadLock(backend: AppServerBackendKind, threadId: string): Promise<ThreadLock | undefined>;
  readThreadUsageActivities(
    backend: AppServerBackendKind,
    threadIds: readonly string[],
  ): Promise<Record<string, AppServerThreadActivityEntry[]>>;
  resolveCodexThreadExecutionModeForActiveTurn(threadId: string): Promise<ThreadExecutionMode>;
  resolvePausedThreadProject(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): ProjectForgeAutomationResolution | undefined;
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
  startTurnWithoutHandoff(params: {
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
    messageOrigin?: AppServerThreadMessageOrigin;
    agentMessageOrigins?: AppServerThreadMessageOrigin[];
    agentMessages?: ThreadTurnQueueEntry["agentMessages"];
    invalidIdRecoveryAttempted?: boolean;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }>;
  submitHeldTurn(params: {
    queueEntryId: string;
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    holdReason: string;
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
    /** Names the entry in the queue and Waiting for, in place of its text. */
    title?: string;
  }): Promise<Extract<ThreadTurnQueueSubmissionResult, { status: "queued" }>>;
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
  }): Promise<ThreadTurnQueueSubmissionResult>;
  usageAccountForTurn(
    backend: AppServerBackendKind,
    threadId: string,
    turnId: string | undefined,
  ): Promise<string | undefined>;
  withArchiveWorkspaceWrite<T>(paths: readonly string[], work: () => Promise<T>): Promise<T>;
  withCodexThreadClient<T>(
    threadId: string,
    operation: (client: BackendClient, mode: ThreadExecutionMode) => Promise<T>,
    requestedMode?: ThreadExecutionMode,
    logRouting?: boolean,
  ): Promise<T>;
}

/**
 * The sub-agents and task monitors domain of the backend registry: monitor
 * delegations from create to completion, their recovery turns, the stale
 * monitor watchdog's check, and the sub-agent cards of task monitors, Codex
 * native workers and Claude sub-agents, including the startup repair of cards
 * left by an earlier session.
 */
export class SubAgentMonitorService {
  private readonly context: RegistryContext;
  private readonly host: RegistryHost<SubAgentMonitorServiceHost>;
  private readonly forgeToolBridge: ForgeToolBridge;
  private readonly managedReviewService: ManagedReviewService;
  private readonly threadMcpConnections: ThreadMcpConnections;

  constructor(
    context: RegistryContext,
    dependencies: SubAgentMonitorServiceDependencies,
    host: RegistryHost<SubAgentMonitorServiceHost>,
  ) {
    this.context = context;
    this.host = host;
    this.forgeToolBridge = dependencies.forgeToolBridge;
    this.managedReviewService = dependencies.managedReviewService;
    this.threadMcpConnections = dependencies.threadMcpConnections;
  }

  /** Running monitor delegations by monitor id, for the registry's reads. */
  get taskMonitorDelegationRecords(): ReadonlyMap<string, TaskMonitorDelegationRecord> {
    return this.taskMonitorDelegations;
  }

  /** Finished monitor delegations by monitor thread, for the registry's reads. */
  get completedTaskMonitorRecords(): ReadonlyMap<string, TaskMonitorDelegationRecord> {
    return this.completedTaskMonitorsByThread;
  }

  /** The visible parent of each Codex native worker thread, for the registry's reads. */
  get codexNativeSubAgentParentRecords(): ReadonlyMap<string, string> {
    return this.codexNativeSubAgentParents;
  }

  /** Native worker usage by parent thread, then monitor id, for the registry's reads. */
  get liveCodexNativeSubAgentUsageRecords(): ReadonlyMap<string, Map<string, LiveCodexNativeSubAgentUsage>> {
    return this.liveCodexNativeSubAgentUsage;
  }

  /** Records the parent a thread listing grouped a native worker under. */
  setCodexNativeSubAgentParent(threadId: string, parentThreadId: string): void {
    this.codexNativeSubAgentParents.set(threadId, parentThreadId);
  }

  /** Forgets finished monitor delegations; the registry calls it on close. */
  clearCompletedTaskMonitors(): void {
    this.completedTaskMonitorsByThread.clear();
  }

  /** Stops every pending native worker reconciliation; the registry calls it on close. */
  cancelCodexNativeSubAgentReconciliations(): void {
    for (const reconciliation of this.codexNativeSubAgentReconciliations.values()) {
      if (reconciliation.timer) {
        clearTimeout(reconciliation.timer);
      }
    }
    this.codexNativeSubAgentReconciliations.clear();
  }

  private readonly codexNativeSubAgentParents = new Map<string, string>();

  private readonly codexNativeSubAgentModelSettings = new Map<
    string,
    Promise<{ model?: string; reasoningEffort?: string } | undefined>
  >();

  /**
   * Persisted worker cards already handed to reconciliation this session. A
   * reconciliation that gives up deletes its entry, and without this every
   * later navigation snapshot would start it again.
   */
  private readonly codexNativeSubAgentPersistedProbes = new Set<string>();

  private readonly codexNativeSubAgentReconciliations = new Map<
    string,
    CodexNativeSubAgentReconciliation
  >();

  /**
   * Native worker usage by parent thread, then monitor id. A worker reports
   * usage once per model response, usually seconds apart, so neither the card
   * (a rewrite of the parent's whole overlay) nor the usage line is written
   * per report: both wait here for the worker's turn end or close. Reads go
   * through `mergeLiveTokenMiserSubAgents` and the live pricing merge, so the
   * rail and the cost panel stay live.
   */
  private readonly liveCodexNativeSubAgentUsage = new Map<
    string,
    Map<string, LiveCodexNativeSubAgentUsage>
  >();

  private readonly taskMonitorDelegations = new Map<
    string,
    TaskMonitorDelegationRecord
  >();

  private readonly completedTaskMonitorsByThread = new Map<
    string,
    TaskMonitorDelegationRecord
  >();

  async reconcileOrphanedThreadSubAgentsAtStartup(): Promise<void> {
    const reconcile = this.context.stores.subAgents.reconcileOrphanedThreadSubAgents;
    if (!reconcile) {
      return;
    }
    const liveRuntimeInstanceIds = this.host().liveProfileRuntimeInstanceIds();
    if (!liveRuntimeInstanceIds) {
      // The repair needs the live owners, but the one-time card move does not.
      await this.context.stores.subAgents.moveLegacyThreadSubAgents?.();
      return;
    }
    const result = await reconcile.call(this.context.stores.subAgents, {
      currentRuntimeInstanceId: this.host().runtimeInstanceId,
      currentRegistrySessionId: this.host().registrySessionId,
      liveRuntimeInstanceIds,
      sessionStartedAt: this.host().registrySessionStartedAt,
    });
    if (result.repairedSubAgents > 0) {
      backendRegistryLog.info("sub-agent-startup-reconciliation", result);
      this.host().invalidateThreadListCache();
    }
  }

  /**
   * Collapse a worker thread onto the durable thread that owns it. Worker IDs
   * are intentionally absent from PwrAgent's navigation and title indexes, so
   * quit and alert-policy surfaces must resolve this relationship first.
   */
  resolveSubAgentThreadOwner(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): {
    backend: AppServerBackendKind;
    isSubAgent: boolean;
    threadId: string;
  } {
    let backend = params.backend;
    let threadId = params.threadId;
    let isSubAgent = false;
    const visited = new Set<string>();

    while (true) {
      const key = buildThreadIdentityKey(backend, threadId);
      if (visited.has(key)) {
        break;
      }
      visited.add(key);

      const taskMonitor = [...this.taskMonitorDelegations.values()].find(
        (record) =>
          record.backend === backend
          && record.monitorThreadId === threadId,
      );
      const reviewSubAgentCandidate = !taskMonitor
        ? [...this.managedReviewService.activeReviewSubAgentRecords.values()].find(
            (record) =>
              record.backend === backend
              && record.reviewThreadId === threadId,
          )
        : undefined;
      const reviewSubAgent =
        reviewSubAgentCandidate
        && (
          reviewSubAgentCandidate.parentBackend !== backend
          || reviewSubAgentCandidate.parentThreadId !== threadId
        )
          ? reviewSubAgentCandidate
          : undefined;
      const nativeParentThreadId =
        !taskMonitor && !reviewSubAgent && backend === "codex"
          ? this.codexNativeSubAgentParents.get(threadId)
          : undefined;
      const parent = taskMonitor
        ? {
            backend: taskMonitor.parentBackend,
            threadId: taskMonitor.parentThreadId,
          }
        : reviewSubAgent
          ? {
              backend: reviewSubAgent.parentBackend,
              threadId: reviewSubAgent.parentThreadId,
            }
          : nativeParentThreadId
            ? { backend: "codex" as const, threadId: nativeParentThreadId }
            : undefined;
      if (!parent) {
        break;
      }

      if (parent.backend === backend && parent.threadId === threadId) {
        break;
      }
      isSubAgent = true;
      backend = parent.backend;
      threadId = parent.threadId;
    }

    return { backend, isSubAgent, threadId };
  }

  /**
   * The live monitor delegations whose handoff will wake this thread, from
   * memory. One that is finishing or being cancelled is no longer waiting.
   */
  listPendingTaskMonitorWakes(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Array<{
    monitorId: string;
    task: string;
    backend: AppServerBackendKind;
    monitorThreadId?: string;
    model?: string;
    createdAt: number;
    lastActivityAt: number;
    pollIntervalSeconds: number;
  }> {
    return [...this.taskMonitorDelegations.values()]
      .filter((record) => record.parentBackend === params.backend
        && record.parentThreadId === params.threadId
        && !record.finalizationStarted
        && !record.cancellation)
      .map((record) => ({
        monitorId: record.monitorId,
        task: record.task,
        backend: record.backend,
        ...(record.monitorThreadId ? { monitorThreadId: record.monitorThreadId } : {}),
        ...(record.runtimeModel ?? record.preferredModel
          ? { model: record.runtimeModel ?? record.preferredModel }
          : {}),
        createdAt: record.createdAt,
        lastActivityAt: record.lastActivityAt,
        pollIntervalSeconds: record.pollIntervalSeconds,
      }));
  }

  async stopSubAgent(
    params: StopSubAgentRequest,
  ): Promise<StopSubAgentResponse> {
    await this.host().subAgentStartupReconciliation;
    const subAgent = await this.context.stores.subAgents.getThreadSubAgent({
      backend: params.backend,
      threadId: params.threadId,
      monitorId: params.monitorId,
    });
    if (!subAgent) {
      throw new Error("Sub-agent was not found on this thread.");
    }
    if (
      subAgent.status !== "pending"
      && subAgent.status !== "running"
      && subAgent.status !== "blocked"
    ) {
      throw new Error("Sub-agent is no longer running.");
    }
    const taskMonitor = this.taskMonitorDelegations.get(params.monitorId);
    if (
      taskMonitor
      && taskMonitor.parentBackend === params.backend
      && taskMonitor.parentThreadId === params.threadId
    ) {
      if (taskMonitor.finalizationStarted || taskMonitor.cancellation) {
        throw new Error("Sub-agent is already completing.");
      }
      if (!taskMonitor.monitorThreadId || !taskMonitor.monitorTurnId) {
        throw new Error("Sub-agent does not expose an active turn to stop.");
      }
      // A terminal notification from an interrupted monitor normally starts a
      // recovery turn. Remove an intentionally stopped monitor first so the
      // terminal handler cannot mistake this user action for a crash.
      this.taskMonitorDelegations.delete(params.monitorId);
      try {
        await this.interruptManagedTaskMonitor(taskMonitor);
        this.releaseTaskMonitorThread(taskMonitor);
      } catch (error) {
        this.taskMonitorDelegations.set(params.monitorId, taskMonitor);
        throw error;
      }

      const stoppedAt = Date.now();
      await this.persistTaskMonitorSubAgent(taskMonitor, {
        completedAt: stoppedAt,
        lastMessage: "Stopped by user.",
        outcome: "cancelled",
        status: "cancelled",
        updatedAt: stoppedAt,
      });
      return {
        backend: params.backend,
        threadId: params.threadId,
        monitorId: params.monitorId,
        stoppedAt,
      };
    }

    const ownerRuntimeInstanceId = subAgent.ownerRuntimeInstanceId?.trim();
    const resolvedLiveRuntimeInstanceIds =
      this.host().liveProfileRuntimeInstanceIds();
    if (!resolvedLiveRuntimeInstanceIds) {
      throw new Error(
        "PwrAgent could not determine which runtime owns this sub-agent. Try again after checking the other PwrAgent instances using this profile.",
      );
    }
    const liveRuntimeInstanceIds = new Set(resolvedLiveRuntimeInstanceIds);
    const hasOtherLiveRuntime = Array.from(liveRuntimeInstanceIds).some(
      (instanceId) => instanceId !== this.host().runtimeInstanceId,
    );
    if (
      ownerRuntimeInstanceId
      && ownerRuntimeInstanceId !== this.host().runtimeInstanceId
      && liveRuntimeInstanceIds.has(ownerRuntimeInstanceId)
    ) {
      throw new Error(
        "Sub-agent is controlled by another live PwrAgent instance.",
      );
    }
    if (!ownerRuntimeInstanceId && hasOtherLiveRuntime) {
      throw new Error(
        "Sub-agent predates runtime ownership tracking, and another PwrAgent instance is live. Close the other instance and try again.",
      );
    }
    const ownerIsOrphaned = ownerRuntimeInstanceId
      ? !liveRuntimeInstanceIds.has(ownerRuntimeInstanceId)
      : true;
    if (ownerIsOrphaned) {
      const stoppedAt = Date.now();
      const completedAt = reliableSubAgentCompletionBoundary(subAgent);
      await this.context.stores.subAgents.upsertThreadSubAgent({
        backend: params.backend,
        threadId: params.threadId,
        subAgent: {
          ...subAgent,
          status: "cancelled",
          outcome: "cancelled",
          completedAt,
          updatedAt: completedAt,
          lastMessage:
            "Stop was requested after its owning PwrAgent runtime had already stopped.",
          completionSource: {
            type: "parent_cancel",
          },
        },
      });
      if (
        subAgent.monitorId.startsWith("codex-native:")
        && subAgent.monitorThreadId
      ) {
        this.clearCodexNativeSubAgentReconciliation(subAgent.monitorThreadId);
      }
      this.host().invalidateThreadListCache(params.backend);
      await this.context.emit({
        backend: params.backend,
        notification: {
          method: "thread/subAgents/updated",
          params: {
            threadId: params.threadId,
          },
        },
      });
      return {
        backend: params.backend,
        threadId: params.threadId,
        monitorId: params.monitorId,
        stoppedAt,
      };
    }

    if (isClaudeNativeSubAgent(subAgent)) {
      const taskId = subAgent.monitorId.slice(CLAUDE_NATIVE_SUBAGENT_MONITOR_ID_PREFIX.length);
      if (this.context.providers.claude.runsTask(params.threadId, taskId)) {
        // Claude stops the task; its notification then settles the card.
        await this.context.providers.claude.stopBackgroundTask(params.threadId, taskId);
      } else {
        // Claude's process is gone and the card missed its end. Nothing runs
        // to stop, so end the card here rather than refuse forever.
        await this.recordClaudeSubAgents({ threadId: params.threadId, subAgents: [{
          monitorId: subAgent.monitorId, taskId, task: subAgent.task, status: "cancelled",
          lastMessage: "Stopped by user.",
          ...(subAgent.agentName ? { agentName: subAgent.agentName } : {}),
        }] });
      }
      return {
        backend: params.backend,
        threadId: params.threadId,
        monitorId: params.monitorId,
        stoppedAt: Date.now(),
      };
    }

    if (!subAgent.monitorThreadId || !subAgent.monitorTurnId) {
      throw new Error("Sub-agent does not expose an active turn to stop.");
    }

    let turnId = subAgent.monitorTurnId;
    if (subAgent.monitorId.startsWith("codex-native:")) {
      try {
        const child = await this.host().readThread({
          backend: "codex",
          threadId: subAgent.monitorThreadId,
          includeTurns: true,
          viewOnly: true,
        });
        const activeEntry = [...child.replay.entries]
          .reverse()
          .find((entry) => entry.turn?.status === "in_progress");
        turnId = activeEntry?.turn?.id ?? turnId;
      } catch (error) {
        backendRegistryLog.debug("native sub-agent active turn read failed", {
          error: error instanceof Error ? error.message : String(error),
          monitorId: subAgent.monitorId,
          monitorThreadId: subAgent.monitorThreadId,
        });
      }
    }

    await this.host().interruptTurn({
      backend: subAgent.backend ?? params.backend,
      threadId: subAgent.monitorThreadId,
      turnId,
    });

    const stoppedAt = Date.now();
    await this.context.stores.subAgents.upsertThreadSubAgent({
      backend: params.backend,
      threadId: params.threadId,
      subAgent: {
        ...subAgent,
        status: "cancelled",
        outcome: "cancelled",
        completedAt: stoppedAt,
        updatedAt: stoppedAt,
        lastMessage: "Stopped by user.",
      },
    });
    if (subAgent.monitorId.startsWith("codex-native:")) {
      this.clearCodexNativeSubAgentReconciliation(subAgent.monitorThreadId);
    }
    this.host().invalidateThreadListCache(params.backend);
    await this.context.emit({
      backend: params.backend,
      notification: {
        method: "thread/subAgents/updated",
        params: {
          threadId: params.threadId,
        },
      },
    });
    return {
      backend: params.backend,
      threadId: params.threadId,
      monitorId: params.monitorId,
      stoppedAt,
    };
  }

  async reconcilePersistedCodexNativeSubAgents(
    threads: AppServerThreadSummary[],
    nativeCardsByThreadId: Record<string, ThreadSubAgentSummary[]>,
  ): Promise<void> {
    for (const parent of threads) {
      const probes: Promise<void>[] = [];
      for (const card of nativeCardsByThreadId[parent.id] ?? []) {
        if (
          !card.monitorId.startsWith("codex-native:")
          || !card.monitorThreadId
          || codexNativeSubAgentIsTerminal(card.status)
          || this.codexNativeSubAgentReconciliations.has(card.monitorThreadId)
          || this.codexNativeSubAgentPersistedProbes.has(card.monitorThreadId)
        ) {
          continue;
        }
        this.codexNativeSubAgentPersistedProbes.add(card.monitorThreadId);
        this.codexNativeSubAgentParents.set(card.monitorThreadId, parent.id);
        this.scheduleCodexNativeSubAgentReconciliation({
          parentThreadId: parent.id,
          receiverThreadId: card.monitorThreadId,
          delayMs: CODEX_NATIVE_SUBAGENT_INITIAL_STATUS_DELAY_MS,
        });
        // Each probe replaces only its own card, so they run together rather
        // than holding the snapshot for one round trip per worker.
        probes.push(this.reconcileCodexNativeSubAgent(card.monitorThreadId));
      }
      if (probes.length > 0) {
        await Promise.all(probes);
        const refreshed = await this.context.stores.subAgents.listThreadSubAgentsByMonitorIdPrefix({
          backend: "codex",
          threadIds: [parent.id],
          monitorIdPrefix: CODEX_NATIVE_MONITOR_ID_PREFIX,
        });
        nativeCardsByThreadId[parent.id] = refreshed[parent.id] ?? [];
      }
    }
  }

  persistedCodexNativeSubAgentDisclosure(
    thread: AppServerThreadSummary,
    nativeCards: readonly ThreadSubAgentSummary[] | undefined,
  ): Pick<AppServerThreadSummary, "codexNativeSubAgents"> {
    const agents = new Map(
      (thread.codexNativeSubAgents ?? []).map((agent) => [agent.threadId, agent]),
    );
    for (const card of nativeCards ?? []) {
      if (
        !card.monitorId.startsWith("codex-native:")
        || !card.monitorThreadId
        || agents.has(card.monitorThreadId)
      ) {
        continue;
      }
      const agent = nativeSubAgentRowFromCard(card, card.monitorThreadId);
      if (isCodexNativeSubAgentVisibleInNavigation(agent, Date.now())) {
        agents.set(agent.threadId, agent);
      }
    }
    return agents.size > 0 ? { codexNativeSubAgents: [...agents.values()] } : {};
  }

  /** Repair workers omitted by bounded global discovery when their parent is opened. */
  async restoreCodexNativeSubAgentsFromReplay(
    threadId: string,
    replay: AppServerThreadReplay,
  ): Promise<void> {
    const observed = new Map<string, {
      agent: NonNullable<AppServerThreadCommandDetail["subAgent"]>["agents"][number];
      operation: NonNullable<AppServerThreadCommandDetail["subAgent"]>["operation"];
      turnId?: string;
      observedAt?: number;
    }>();
    for (const entry of replay.entries) {
      if (entry.type !== "activity") {
        continue;
      }
      for (const detail of entry.details) {
        const call = detail.command?.subAgent;
        if (call?.origin !== "codex-native") {
          continue;
        }
        for (const agent of call.agents) {
          observed.set(agent.threadId, {
            agent,
            operation: call.operation,
            turnId: entry.turn?.id,
            observedAt: entry.turn?.completedAt ?? entry.createdAt,
          });
        }
      }
    }
    if (observed.size === 0) {
      return;
    }
    const nativeCards = (await this.context.stores.subAgents.listThreadSubAgentsByMonitorIdPrefix({
      backend: "codex",
      threadIds: [threadId],
      monitorIdPrefix: CODEX_NATIVE_MONITOR_ID_PREFIX,
    }))[threadId] ?? [];
    const pending = [...observed.keys()].filter((id) => {
      const activity = observed.get(id)!;
      const terminal = ["completed", "interrupted", "errored", "shutdown"].includes(activity.agent.status ?? "");
      const recent = !activity.observedAt
        || activity.observedAt >= Date.now() - CODEX_NATIVE_SUBAGENT_PANEL_RETENTION_MS;
      const existing = nativeCards.find((card) => card.monitorId === codexNativeSubAgentId(id));
      const replayStatus = mapCodexNativeSubAgentStatus({
        agentState: activity.agent.status,
        itemStatus: "completed",
        tool: codexNativeToolForOperation(activity.operation),
      });
      return existing
        ? !codexNativeSubAgentIsTerminal(existing.status) || (terminal && existing.status !== replayStatus)
        : (!terminal || recent);
    });
    // A card made from lifecycle reports alone has no model, and its usage
    // stays unpriced until discovery reads one. Global discovery is one page
    // and can miss a fresh worker; this parent-scoped read cannot.
    const needsDiscovery = [...observed.keys()].some((id) => {
      const existing = nativeCards.find(
        (card) => card.monitorId === codexNativeSubAgentId(id),
      );
      return existing !== undefined && !existing.preferredModel;
    });
    if (pending.length === 0 && !needsDiscovery) {
      return;
    }
    const nativeThreads = this.context.providers.codex.listNativeSubAgentThreads
      ? await this.context.providers.codex.listNativeSubAgentThreads({
          ancestorThreadId: threadId,
        }).catch((error) => {
          backendRegistryLog.debug("parent-scoped native Codex sub-agent discovery failed", {
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        })
      : [];
    const parent = this.host().getCachedThreadSummary({ backend: "codex", threadId }) ?? {
      id: threadId,
      source: "codex" as const,
      title: "",
      titleSource: "fallback" as const,
      linkedDirectories: [],
    };
    const grouped = groupCodexNativeSubAgents({
      nativeThreads,
      now: Date.now(),
      parentThreads: [parent],
    });
    // Explicit replay outcomes must land before discovery infers success from
    // an idle worker. Discovery then enriches the authoritative card.
    for (const receiverThreadId of pending) {
      const activity = observed.get(receiverThreadId)!;
      const discovered = nativeThreads.find((thread) => thread.id === receiverThreadId)?.codexNativeSubAgent;
      const name = (discovered ? codexNativeSubAgentName(discovered) : undefined)
        ?? activity.agent.name;
      await this.persistCodexNativeSubAgent({
        authoritativeReplayOutcome: true,
        parentThreadId: threadId,
        receiverThreadId,
        observedAt: activity.observedAt,
        call: {
          activityBoundary: true,
          parentTurnId: activity.turnId,
          receiverThreadIds: [receiverThreadId],
          receiverThreadNames: name ? new Map([[receiverThreadId, name]]) : new Map(),
          tool: codexNativeToolForOperation(activity.operation),
          item: { status: "completed", agentsStates: { [receiverThreadId]: activity.agent } },
        },
      });
    }
    // The reconcile reads listing metadata only (a worker's handoff origin);
    // usage activities are read from their own table below.
    const overlayRequest = {
      backend: "codex" as const,
      threadIds: [threadId, ...nativeThreads.map((thread) => thread.id)],
    };
    const overlays = this.context.stores.threads.getThreadListingOverlayStates
      ? await this.context.stores.threads.getThreadListingOverlayStates(overlayRequest)
      : await this.context.stores.threads.getThreadOverlayStates(overlayRequest);
    await this.reconcileDiscoveredCodexNativeSubAgents({
      nativeCardsByThreadId: await this.context.stores.subAgents.listThreadSubAgentsByMonitorIdPrefix({
        backend: "codex",
        threadIds: grouped.map((parent) => parent.id),
        monitorIdPrefix: CODEX_NATIVE_MONITOR_ID_PREFIX,
      }),
      nativeThreads,
      overlaysByThreadId: overlays,
      parentThreads: grouped,
      usageActivitiesByThreadId: await this.host().readThreadUsageActivities(
        "codex",
        nativeThreads.map((thread) => thread.id),
      ),
    });
  }

  async reconcileDiscoveredCodexNativeSubAgents(params: {
    nativeCardsByThreadId: Record<string, ThreadSubAgentSummary[]>;
    nativeThreads: AppServerThreadSummary[];
    overlaysByThreadId: Record<string, ThreadOverlayState | undefined>;
    parentThreads: AppServerThreadSummary[];
    usageActivitiesByThreadId: Record<string, AppServerThreadActivityEntry[]>;
  }): Promise<void> {
    if (params.nativeThreads.length === 0) {
      return;
    }
    const nativeThreadsById = new Map(
      params.nativeThreads.map((thread) => [thread.id, thread]),
    );

    for (const parent of params.parentThreads) {
      let parentPricingLines: ThreadUsageLineRecord[] = [];
      let parentPricingSettings: ThreadUsageLineRecord | undefined;
      let parentPricingLoaded = false;
      let parentPricingRepaired = false;
      const readParentPricingLines = async (): Promise<ThreadUsageLineRecord[]> => {
        if (
          !parentPricingLoaded
          && typeof this.context.stores.usage.readThreadPricing === "function"
        ) {
          parentPricingLoaded = true;
          const pricing = await this.context.stores.usage.readThreadPricing({
            backend: "codex",
            threadId: parent.id,
          });
          parentPricingLines = pricing.lines;
          parentPricingSettings = pricing.lines.find(
            (line) => line.threadId === parent.id && Boolean(line.model),
          );
        }
        return parentPricingLines;
      };
      for (const discovered of parent.codexNativeSubAgents ?? []) {
        const nativeThread = nativeThreadsById.get(discovered.threadId);
        if (!nativeThread) {
          continue;
        }
        const childOverlay = params.overlaysByThreadId[nativeThread.id];
        if (childOverlay?.handoffOrigin?.groupingMode === "subthread") {
          // Codex can report an ordinary PwrAgent handoff through its native
          // worker metadata. Keep the durable handoff in navigation and do
          // not let thread-list discovery recreate the stale worker card.
          this.codexNativeSubAgentParents.delete(nativeThread.id);
          this.clearCodexNativeSubAgentReconciliation(nativeThread.id);
          continue;
        }
        // Both global and ancestor-scoped discovery flatten descendants under
        // this ordinary parent; usage must follow the same visible owner.
        this.codexNativeSubAgentParents.set(nativeThread.id, parent.id);
        const monitorId = codexNativeSubAgentId(nativeThread.id);
        const existing = params.nativeCardsByThreadId[parent.id]?.find(
          (subAgent) => subAgent.monitorId === monitorId,
        );
        // The worker's own model and effort, or none. A worker can run on a
        // model its parent does not, so the parent's is never a stand-in:
        // usage with no known model stays unpriced until the usage path reads
        // the worker's settings from Codex.
        const preferredModel =
          nativeThread.model
          ?? existing?.preferredModel
          ?? existing?.monitorUsage?.model
          ?? existing?.monitorUsage?.cost?.model;
        const preferredReasoningEffort =
          nativeThread.reasoningEffort
          ?? existing?.preferredReasoningEffort;
        // Codex reports neither per worker; both follow the account and the
        // parent's configuration, which the worker inherits.
        let preferredFastMode =
          nativeThread.fastMode
          ?? existing?.preferredFastMode
          ?? existing?.monitorUsage?.fastMode
          ?? parent.fastMode;
        let serviceTier =
          nativeThread.serviceTier
          ?? existing?.monitorUsage?.serviceTier
          ?? parent.serviceTier;
        const childUsageActivities = params.usageActivitiesByThreadId[nativeThread.id];
        const hasPersistedTurnUsage = Boolean(
          childUsageActivities?.some(
            (activity) =>
              activity.status === "completed"
              && (
                activity.id.startsWith("live-turn-usage-")
                || activity.summary.startsWith("Turn usage:")
              ),
          ),
        );
        if (
          hasPersistedTurnUsage
          && (preferredFastMode === undefined || !serviceTier)
          && typeof this.context.stores.usage.readThreadPricing === "function"
        ) {
          await readParentPricingLines();
          preferredFastMode ??= parentPricingSettings?.fastMode;
          serviceTier ??= parentPricingSettings?.serviceTier;
        }
        const persistedUsageBackfill = buildPersistedCodexNativeUsageBackfill({
          activities: childUsageActivities,
          fastMode: preferredFastMode,
          model: preferredModel,
          serviceTier,
        });
        // A running worker's usage can be live in memory, off its card and
        // out of the pricing table until its turn ends. It is not missing.
        const liveUsage = this.liveCodexNativeSubAgentUsage.get(parent.id)?.get(monitorId);
        const knownUsage = existing?.monitorUsage ?? liveUsage?.monitorUsage;
        const usageBackfill = knownUsage
          ? undefined
          : persistedUsageBackfill;
        const monitorTurnId =
          existing?.monitorTurnId
          ?? persistedUsageBackfill?.monitorTurnId;
        const pricingUsage =
          knownUsage
          ?? persistedUsageBackfill?.usage;
        const pricingLine = pricingUsage
          ? buildTaskMonitorUsageLine({
              backend: "codex",
              fastMode: preferredFastMode,
              model: preferredModel,
              monitorId,
              monitorThreadId: nativeThread.id,
              monitorTurnId,
              parentThreadId: parent.id,
              reasoningEffort: preferredReasoningEffort,
              serviceTier,
              source: "monitor",
              usage: pricingUsage,
            })
          : undefined;
        const needsPricingWrite = pricingLine && !liveUsage
          ? usageBackfill
            ? true
            : typeof this.context.stores.usage.readThreadPricing === "function"
              && !(await readParentPricingLines()).some(
                (line) =>
                  line.sourceItemId === monitorId
                  && line.threadId === nativeThread.id
                  && line.scope === "monitor",
              )
          : false;
        // A line written before anything named the worker's model keeps its
        // own identity and tokens; only the settings are filled. Building a
        // fresh line would key it by the card's turn, which is the parent's,
        // and count the worker twice. The store reprices what it is handed.
        const modelRepairs =
          preferredModel && typeof this.context.stores.usage.readThreadPricing === "function"
            ? (await readParentPricingLines())
              .filter(
                (line) =>
                  line.sourceItemId === monitorId
                  && line.threadId === nativeThread.id
                  && line.scope === "monitor"
                  && !line.model,
              )
              .map((line): ThreadUsageLineRecord => ({
                ...line,
                model: preferredModel,
                ...(!line.reasoningEffort && preferredReasoningEffort
                  ? { reasoningEffort: preferredReasoningEffort }
                  : {}),
                ...(!line.serviceTier && serviceTier ? { serviceTier } : {}),
                ...(line.fastMode === undefined && preferredFastMode !== undefined
                  ? { fastMode: preferredFastMode }
                  : {}),
              }))
            : [];
        const discoveredStatus =
          nativeThread.threadStatus === "active"
            ? "running"
            : nativeThread.threadStatus === "idle" || usageBackfill
              ? "success"
              : existing?.status ?? "running";
        const status =
          existing && codexNativeSubAgentIsTerminal(existing.status)
            ? existing.status
            : discoveredStatus;
        const outcome = codexNativeSubAgentOutcome(status);
        const agentName =
          (nativeThread.codexNativeSubAgent
            ? codexNativeSubAgentName(nativeThread.codexNativeSubAgent)
            : undefined)
          ?? existing?.agentName;
        // A fallback title says nothing the placeholder does not.
        const discoveredTitle = nativeThread.titleSource === "fallback"
          ? undefined
          : nativeThread.title?.trim();
        const task =
          existing
          && !(
            discoveredTitle
            && isCodexNativeSubAgentPlaceholderTask(existing.task, nativeThread.id)
          )
            ? existing.task
            : discoveredTitle || existing?.task || nativeThread.title;
        const completedAt =
          status === "success"
            ? existing?.completedAt
              ?? usageBackfill?.completedAt
              ?? nativeThread.updatedAt
              ?? Date.now()
            : existing?.completedAt;
        const needsCardWrite =
          !existing
          || Boolean(usageBackfill)
          || Boolean(agentName && agentName !== existing.agentName)
          || task !== existing.task
          // Codex's report replaces whatever the card held, including a
          // parent's model stored by an earlier build that guessed.
          || Boolean(preferredModel && preferredModel !== existing.preferredModel)
          || Boolean(
            preferredReasoningEffort
            && preferredReasoningEffort !== existing.preferredReasoningEffort,
          )
          || Boolean(
            preferredFastMode !== undefined
            && existing.preferredFastMode === undefined,
          )
          || (
            !codexNativeSubAgentIsTerminal(existing.status)
            && status !== existing.status
          );
        if (!needsCardWrite && !needsPricingWrite) {
          continue;
        }

        try {
          const subAgent: ThreadSubAgentSummary = {
            monitorId,
            task,
            status,
            createdAt:
              existing?.createdAt
              ?? nativeThread.createdAt
              ?? nativeThread.updatedAt
              ?? Date.now(),
            updatedAt: Math.max(
              existing?.updatedAt ?? 0,
              nativeThread.updatedAt ?? 0,
              usageBackfill?.completedAt ?? 0,
              Date.now(),
            ),
            ownerRuntimeInstanceId:
              existing?.ownerRuntimeInstanceId ?? this.host().runtimeInstanceId,
            ownerRegistrySessionId:
              existing?.ownerRegistrySessionId ?? this.host().registrySessionId,
            backend: "codex",
            monitorThreadId: nativeThread.id,
            ...(existing?.lastMessage
              ? { lastMessage: existing.lastMessage }
              : {}),
            ...(agentName ? { agentName } : {}),
            ...(preferredModel ? { preferredModel } : {}),
            ...(preferredReasoningEffort ? { preferredReasoningEffort } : {}),
            ...(preferredFastMode !== undefined ? { preferredFastMode } : {}),
            ...(monitorTurnId ? { monitorTurnId } : {}),
            ...(outcome ? { outcome } : {}),
            ...(completedAt !== undefined ? { completedAt } : {}),
            ...(usageBackfill ? { monitorUsage: usageBackfill.usage } : {}),
          };

          // Pricing and the card are independently repairable. Persist pricing
          // first for a missing card, while an already-present card can supply
          // its durable usage snapshot if a prior pricing write failed.
          if (needsPricingWrite && pricingLine) {
            logUnpricedThreadUsageLine(pricingLine);
            await this.context.stores.usage.upsertThreadUsageLine({ line: pricingLine });
            parentPricingLines.push(pricingLine);
          }
          for (const line of modelRepairs) {
            const { line: repaired } = await this.context.stores.usage.upsertThreadUsageLine({ line });
            logUnpricedThreadUsageLine(repaired);
            const index = parentPricingLines.findIndex(
              (candidate) => candidate.usageLineId === repaired.usageLineId,
            );
            if (index >= 0) {
              parentPricingLines[index] = repaired;
            }
            parentPricingRepaired = true;
          }

          if (needsCardWrite) {
            await this.context.stores.subAgents.upsertThreadSubAgent({
              backend: "codex",
              threadId: parent.id,
              subAgent,
            });
            params.nativeCardsByThreadId[parent.id] = [
              subAgent,
              ...(params.nativeCardsByThreadId[parent.id] ?? []).filter(
                (card) => card.monitorId !== subAgent.monitorId,
              ),
            ];
          }
          if (!codexNativeSubAgentIsTerminal(status)) {
            this.scheduleCodexNativeSubAgentReconciliation({
              delayMs: CODEX_NATIVE_SUBAGENT_INITIAL_STATUS_DELAY_MS,
              parentThreadId: parent.id,
              receiverThreadId: nativeThread.id,
            });
          }
        } catch (error) {
          backendRegistryLog.warn(
            "native Codex sub-agent discovery reconciliation failed",
            {
              error: error instanceof Error ? error.message : String(error),
              parentThreadId: parent.id,
              receiverThreadId: nativeThread.id,
            },
          );
        }
      }
      if (parentPricingRepaired) {
        // A repriced worker moves the thread total and every running total
        // after it; open panels refetch on this event.
        await this.host().emitThreadPricingUpdated({ backend: "codex", threadId: parent.id });
      }
    }
  }

  async recordTaskMonitorUsage(event: AgentEvent): Promise<void> {
    const notification = event.notification;
    if (notification.method !== "thread/tokenUsage/updated") {
      return;
    }

    if (notification.params.turnId) {
      const reviewKey = buildReviewSubAgentKey(
        event.backend,
        notification.params.threadId,
        notification.params.turnId,
      );
      const reviewRecord = this.managedReviewService.activeReviewSubAgentRecords.get(reviewKey);
      const completedReviewRecord = this.managedReviewService.reviewSubAgentRecordsByReviewTurn.get(reviewKey);
      const model =
        readTaskMonitorUsageModel({
          notificationModel: notification.params.model,
          tokenUsage: notification.params.tokenUsage,
        }) ??
        reviewRecord?.model ??
        completedReviewRecord?.model;
      const serviceTier =
        readTaskMonitorUsageServiceTier(notification.params.tokenUsage) ??
        reviewRecord?.serviceTier ??
        completedReviewRecord?.serviceTier;
      const fastMode =
        readTaskMonitorUsageFastMode(notification.params.tokenUsage) ??
        reviewRecord?.fastMode ??
        completedReviewRecord?.fastMode;
      const usageSnapshot = this.buildIncrementalSubAgentUsageSnapshot({
        backend: event.backend,
        fastMode,
        model,
        serviceTier,
        threadId: notification.params.threadId,
        tokenUsage: notification.params.tokenUsage,
        turnId: notification.params.turnId,
      });
      if (!usageSnapshot) {
        return;
      }
      if (reviewRecord) {
        reviewRecord.latestUsage = usageSnapshot;
        const observedReplays = this.host().observeLiveThreadContextReplay({
          backend: event.backend,
          threadId: notification.params.threadId,
          tokenUsage: notification.params.tokenUsage,
          turnId: notification.params.turnId,
        });
        await this.managedReviewService.persistReviewSubAgent(reviewRecord, {
          monitorUsage: usageSnapshot,
        });
        if (typeof this.context.stores.usage.upsertThreadUsageLine === "function") {
          const line = buildTaskMonitorUsageLine({
            backend: reviewRecord.parentBackend,
            accountKey: await this.host().usageAccountForTurn(event.backend, notification.params.threadId, notification.params.turnId),
            fastMode,
            model,
            monitorId: reviewSubAgentId(reviewRecord.turnId),
            monitorThreadId: reviewRecord.reviewThreadId,
            monitorTurnId: reviewRecord.turnId,
            observedReplays,
            parentThreadId: reviewRecord.parentThreadId,
            reasoningEffort: reviewRecord.reasoningEffort,
            serviceTier,
            source: "monitor",
            usage: usageSnapshot,
          });
          logUnpricedThreadUsageLine(line);
          await this.context.stores.usage.upsertThreadUsageLine({ line });
          await this.host().emitThreadPricingUpdated({
            backend: reviewRecord.parentBackend,
            threadId: line.parentThreadId ?? line.threadId,
          });
        }
        return;
      }
      const reviewUsagePersisted = await this.managedReviewService.persistFinishedReviewUsage({
        backend: completedReviewRecord?.parentBackend ?? event.backend,
        reviewBackend: event.backend,
        parentThreadId:
          completedReviewRecord?.parentThreadId ?? notification.params.threadId,
        reviewThreadId:
          completedReviewRecord?.reviewThreadId ?? notification.params.threadId,
        turnId: notification.params.turnId,
        usage: usageSnapshot,
      });
      if (reviewUsagePersisted) {
        const observedReplays = this.host().observeLiveThreadContextReplay({
          backend: event.backend,
          threadId: notification.params.threadId,
          tokenUsage: notification.params.tokenUsage,
          turnId: notification.params.turnId,
        });
        if (typeof this.context.stores.usage.upsertThreadUsageLine === "function") {
          const line = buildTaskMonitorUsageLine({
            backend: completedReviewRecord?.parentBackend ?? event.backend,
            accountKey: await this.host().usageAccountForTurn(event.backend, notification.params.threadId, notification.params.turnId),
            fastMode,
            model,
            monitorId: reviewSubAgentId(notification.params.turnId),
            monitorThreadId:
              completedReviewRecord?.reviewThreadId ?? notification.params.threadId,
            monitorTurnId: notification.params.turnId,
            observedReplays,
            parentThreadId:
              completedReviewRecord?.parentThreadId ?? notification.params.threadId,
            reasoningEffort: completedReviewRecord?.reasoningEffort,
            serviceTier,
            source: "monitor",
            usage: usageSnapshot,
          });
          logUnpricedThreadUsageLine(line);
          await this.context.stores.usage.upsertThreadUsageLine({ line });
          await this.host().emitThreadPricingUpdated({
            backend: completedReviewRecord?.parentBackend ?? event.backend,
            threadId: line.parentThreadId ?? line.threadId,
          });
        }
        return;
      }
    }

    const monitorRecord =
      Array.from(this.taskMonitorDelegations.values()).find(
        (record) =>
          record.backend === event.backend
          && record.monitorThreadId === notification.params.threadId,
      ) ??
      this.completedTaskMonitorsByThread.get(
        taskMonitorThreadKey(event.backend, notification.params.threadId),
      );
    if (!monitorRecord) {
      if (event.backend === "codex") {
        await this.recordCodexNativeSubAgentUsage(event);
      }
      return;
    }

    monitorRecord.lastActivityAt = Date.now();
    const model =
      readTaskMonitorUsageModel({
        notificationModel: notification.params.model,
        tokenUsage: notification.params.tokenUsage,
      }) ?? monitorRecord.preferredModel;
    const usageSnapshot =
      event.backend === "codex"
        ? buildTaskMonitorUsageSnapshot({
            model,
            tokenUsage: notification.params.tokenUsage,
          })
        : this.buildIncrementalSubAgentUsageSnapshot({
            backend: event.backend,
            model,
            threadId: notification.params.threadId,
            tokenUsage: notification.params.tokenUsage,
            turnId:
              notification.params.turnId ?? monitorRecord.monitorTurnId,
          });
    if (usageSnapshot) {
      monitorRecord.latestUsage = usageSnapshot;
      const shouldPersistUsage =
        event.backend === "codex"
        || !readTaskMonitorTokenUsageRecords(
          notification.params.tokenUsage,
        )?.totalUsage;
      if (!shouldPersistUsage) {
        return;
      }
      const observedReplays = this.host().observeLiveThreadContextReplay({
        backend: event.backend,
        threadId: notification.params.threadId,
        tokenUsage: notification.params.tokenUsage,
        turnId: notification.params.turnId ?? monitorRecord.monitorTurnId,
      });
      await this.persistTaskMonitorSubAgent(monitorRecord, {
        monitorUsage: usageSnapshot,
      });
      if (typeof this.context.stores.usage.upsertThreadUsageLine === "function") {
        const line = buildTaskMonitorUsageLine({
          backend: monitorRecord.backend,
          accountKey: await this.host().usageAccountForTurn(event.backend, notification.params.threadId,
            notification.params.turnId ?? monitorRecord.monitorTurnId),
          model,
          monitorId: monitorRecord.monitorId,
          monitorThreadId: monitorRecord.monitorThreadId ?? notification.params.threadId,
          monitorTurnId: monitorRecord.monitorTurnId,
          observedReplays,
          parentThreadId: monitorRecord.parentThreadId,
          source: "monitor",
          usage: usageSnapshot,
        });
        logUnpricedThreadUsageLine(line);
        await this.context.stores.usage.upsertThreadUsageLine({ line });
        await this.host().emitThreadPricingUpdated({
          backend: monitorRecord.parentBackend,
          threadId: line.parentThreadId ?? line.threadId,
        });
      }
    }
  }

  /**
   * Build usage for a forked sub-agent turn without charging the child for the
   * cumulative history inherited from its parent. Codex reports both the
   * session-wide `total` and the latest request; the first observation seeds a
   * stable `total - latest` baseline, and subsequent observations report only
   * the child turn's growth beyond that baseline.
   *
   * When the protocol cannot provide a latest-request breakdown, derivation
   * retains the existing whole-total fallback rather than inventing a fork
   * baseline that cannot be measured safely.
   */
  private buildIncrementalSubAgentUsageSnapshot(params: {
    backend: AppServerBackendKind;
    fastMode?: boolean;
    model?: string;
    serviceTier?: string;
    threadId: string;
    tokenUsage: unknown;
    turnId?: string;
  }): TaskMonitorUsageSnapshot | undefined {
    const derivedUsage = this.host().deriveLiveThreadTokenUsage({
      backend: params.backend,
      threadId: params.threadId,
      tokenUsage: params.tokenUsage,
      turnId: params.turnId,
    });
    return buildTaskMonitorUsageSnapshot({
      fastMode: params.fastMode,
      model: params.model,
      providerCostUsd: params.backend === "claude"
        ? readUsageNumber(params.tokenUsage, ["claudeCostUSD"])
        : undefined,
      serviceTier: params.serviceTier,
      tokenUsage: derivedUsage.turnTokenUsage,
    });
  }

  /**
   * One `thread/read` per worker, shared by the usage notifications that race
   * to ask. A failure is not cached, so the next notification asks again. A
   * model, once read, lives on the card, so only a read that found none is
   * kept, to stop every later notification asking again.
   */
  private readCodexNativeSubAgentModelSettings(
    threadId: string,
  ): Promise<{ model?: string; reasoningEffort?: string } | undefined> {
    if (!this.context.providers.codex.readThreadModelSettings) {
      return Promise.resolve(undefined);
    }
    const cached = this.codexNativeSubAgentModelSettings.get(threadId);
    if (cached) {
      return cached;
    }
    const pending = this.context.providers.codex.readThreadModelSettings({ threadId }).then(
      (settings) => {
        if (settings?.model) {
          this.codexNativeSubAgentModelSettings.delete(threadId);
        }
        return settings;
      },
      (error) => {
        this.codexNativeSubAgentModelSettings.delete(threadId);
        backendRegistryLog.debug("codex native subagent model read failed", {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      },
    );
    this.codexNativeSubAgentModelSettings.set(threadId, pending);
    return pending;
  }

  /**
   * Moves live worker usage into sqlite: the usage lines in one commit, then
   * the cards in one commit per parent, each applied to the card as stored
   * now so a status written meanwhile survives. Without a worker, every
   * parent is written (close).
   */
  async persistLiveCodexNativeSubAgentUsage(
    receiverThreadId?: string,
  ): Promise<void> {
    const only = receiverThreadId ? codexNativeSubAgentId(receiverThreadId) : undefined;
    for (const [parentThreadId, lives] of [...this.liveCodexNativeSubAgentUsage]) {
      const pending = [...lives].filter(([monitorId]) => !only || monitorId === only);
      if (pending.length === 0) {
        continue;
      }
      const lines = pending.flatMap(([, live]) => [...live.lines.values()]);
      try {
        if (lines.length > 0 && typeof this.context.stores.usage.upsertThreadUsageLines === "function") {
          await this.context.stores.usage.upsertThreadUsageLines({ lines });
        }
        const cards: ThreadSubAgentSummary[] = [];
        for (const [monitorId, live] of pending) {
          const card = await this.context.stores.subAgents.getThreadSubAgent({
            backend: "codex",
            threadId: parentThreadId,
            monitorId,
          });
          if (card) cards.push(withLiveCodexNativeSubAgentUsage(card, live));
        }
        if (cards.length > 0) {
          if (typeof this.context.stores.subAgents.upsertThreadSubAgents === "function") {
            await this.context.stores.subAgents.upsertThreadSubAgents({
              backend: "codex",
              threadId: parentThreadId,
              subAgents: cards,
            });
          } else {
            for (const subAgent of cards) {
              await this.context.stores.subAgents.upsertThreadSubAgent({
                backend: "codex",
                threadId: parentThreadId,
                subAgent,
              });
            }
          }
          this.host().invalidateThreadListCache("codex");
        }
      } catch (error) {
        // The usage stays live and is retried at the next boundary.
        backendRegistryLog.warn("codex native subagent usage write failed", {
          parentThreadId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      for (const [monitorId, live] of pending) {
        // A newer notification may have replaced the entry during the write.
        if (lives.get(monitorId) === live) {
          lives.delete(monitorId);
        }
      }
      if (lives.size === 0) {
        this.liveCodexNativeSubAgentUsage.delete(parentThreadId);
      }
      if (lines.length > 0 && !this.context.lifecycle.closed) {
        // The store prices what it writes; open panels take its copy.
        await this.host().emitThreadPricingUpdated({ backend: "codex", threadId: parentThreadId });
      }
    }
  }

  private async recordCodexNativeSubAgentUsage(event: AgentEvent): Promise<void> {
    if (
      event.backend !== "codex" ||
      event.notification.method !== "thread/tokenUsage/updated"
    ) {
      return;
    }
    const parentThreadId = this.codexNativeSubAgentParents.get(
      event.notification.params.threadId,
    );
    if (!parentThreadId) {
      return;
    }
    const monitorId = codexNativeSubAgentId(event.notification.params.threadId);
    const readCard = async (): Promise<ThreadSubAgentSummary | undefined> =>
      await this.context.stores.subAgents.getThreadSubAgent({
        backend: "codex",
        threadId: parentThreadId,
        monitorId,
      });
    let existing = await readCard();
    if (!existing) {
      backendRegistryLog.warn("codex native subagent usage had no matching card", {
        monitorId,
        parentThreadId,
        threadId: event.notification.params.threadId,
      });
      return;
    }
    const notificationParams = readRecord(event.notification.params);
    const notificationModel = readTaskMonitorUsageModel({
      notificationModel: event.notification.params.model,
      tokenUsage: event.notification.params.tokenUsage,
    });
    const serviceTier = readTaskMonitorUsageServiceTier(
      event.notification.params.tokenUsage,
    );
    const fastMode = readTaskMonitorUsageFastMode(
      event.notification.params.tokenUsage,
    );
    const live = this.liveCodexNativeSubAgentUsage.get(parentThreadId)?.get(monitorId);
    const knownModel = existing.preferredModel ?? live?.preferredModel;
    const knownReasoningEffort =
      existing.preferredReasoningEffort ?? live?.preferredReasoningEffort;
    // A path-based worker's card starts from a subAgentActivity report, which
    // names no model, and Codex usage notifications carry none either. Ask
    // Codex for the worker's own settings once, or its usage stays unpriced.
    let workerSettings: { model?: string; reasoningEffort?: string } | undefined;
    if (!notificationModel && !knownModel) {
      workerSettings = await this.readCodexNativeSubAgentModelSettings(
        event.notification.params.threadId,
      );
      // The card may be written back whole below. Anything persisted while
      // the read was in flight, such as the worker finishing, must survive it.
      existing = await readCard();
      if (!existing) {
        return;
      }
    }
    const model = notificationModel ?? knownModel ?? workerSettings?.model;
    const reasoningEffort = knownReasoningEffort ?? workerSettings?.reasoningEffort;
    const settingsForCard = {
      ...(!existing.preferredModel && (knownModel ?? workerSettings?.model)
        ? { preferredModel: knownModel ?? workerSettings?.model }
        : {}),
      ...(!existing.preferredReasoningEffort && reasoningEffort
        ? { preferredReasoningEffort: reasoningEffort }
        : {}),
    };
    const monitorTurnId =
      readOptionalString(notificationParams, ["turnId", "turn_id"]) ??
      existing.monitorTurnId;
    const usageSnapshot = this.buildIncrementalSubAgentUsageSnapshot({
      backend: "codex",
      fastMode,
      model,
      serviceTier,
      threadId: event.notification.params.threadId,
      tokenUsage: event.notification.params.tokenUsage,
      turnId: monitorTurnId,
    });
    if (!usageSnapshot) {
      return;
    }
    const observedReplays = this.host().observeLiveThreadContextReplay({
      backend: "codex",
      threadId: event.notification.params.threadId,
      tokenUsage: event.notification.params.tokenUsage,
      turnId: monitorTurnId,
    });
    const line = buildTaskMonitorUsageLine({
      backend: "codex",
      fastMode,
      accountKey: await this.host().usageAccountForTurn("codex", event.notification.params.threadId, monitorTurnId),
      model,
      monitorId,
      monitorThreadId: event.notification.params.threadId,
      monitorTurnId,
      observedReplays,
      parentThreadId,
      reasoningEffort,
      serviceTier,
      source: "monitor",
      usage: usageSnapshot,
    });

    if (typeof this.context.stores.usage.upsertThreadUsageLines === "function") {
      // Usage notifications arrive once per model response for the life of
      // the worker. The card's copy and the line both wait in memory for the
      // worker's turn end; see `liveCodexNativeSubAgentUsage`.
      const lives = this.liveCodexNativeSubAgentUsage.get(parentThreadId)
        ?? new Map<string, LiveCodexNativeSubAgentUsage>();
      const lines = new Map(lives.get(monitorId)?.lines ?? []);
      lines.set(line.usageLineId, line);
      lives.set(monitorId, {
        ...settingsForCard,
        lines,
        monitorUsage: usageSnapshot,
        updatedAt: Date.now(),
      });
      this.liveCodexNativeSubAgentUsage.set(parentThreadId, lives);
      logUnpricedThreadUsageLine(line);
      // Codex can report usage after the turn it belongs to has ended. That
      // boundary has passed, and the worker may never run again.
      const completedTurn = this.host().recentlyCompletedThreadUsageTurns.get(
        ["codex", event.notification.params.threadId].join(":"),
      );
      const reportedTurnId = readOptionalString(notificationParams, ["turnId", "turn_id"]);
      if (completedTurn && (!reportedTurnId || reportedTurnId === completedTurn.turnId)) {
        await this.persistLiveCodexNativeSubAgentUsage(event.notification.params.threadId);
      } else {
        await this.host().emitThreadPricingUpdated({
          backend: "codex",
          threadId: parentThreadId,
        });
      }
    } else {
      await this.context.stores.subAgents.upsertThreadSubAgent({
        backend: "codex",
        threadId: parentThreadId,
        subAgent: {
          ...existing,
          ...settingsForCard,
          monitorUsage: usageSnapshot,
          updatedAt: Date.now(),
        },
      });
      this.host().invalidateThreadListCache("codex");
      if (typeof this.context.stores.usage.upsertThreadUsageLine === "function") {
        logUnpricedThreadUsageLine(line);
        await this.context.stores.usage.upsertThreadUsageLine({ line });
        await this.host().emitThreadPricingUpdated({
          backend: "codex",
          threadId: parentThreadId,
        });
      }
    }
    await this.context.emit({
      backend: "codex",
      notification: {
        method: "thread/subAgents/updated",
        params: {
          navigationChanged: false,
          threadId: parentThreadId,
        },
      },
    });
    if (!codexNativeSubAgentIsTerminal(existing.status)) {
      this.scheduleCodexNativeSubAgentReconciliation({
        delayMs: CODEX_NATIVE_SUBAGENT_ACTIVITY_STATUS_DELAY_MS,
        parentThreadId,
        receiverThreadId: event.notification.params.threadId,
      });
    }
  }

  async recordCodexNativeSubAgentActivity(event: AgentEvent): Promise<void> {
    if (event.backend !== "codex") {
      return;
    }
    const params = readRecord(event.notification.params);
    const threadId = readOptionalString(params, ["threadId", "thread_id"]);
    if (!threadId) {
      return;
    }
    const calls = readCodexNativeSubAgentCalls(event.notification);
    if (calls.length === 0) {
      return;
    }

    for (const call of calls) {
      if (!isCodexNativeSubAgentTool(call.tool)) {
        backendRegistryLog.warn("unhandled codex native subagent tool", {
          itemId: call.itemId,
          method: event.notification.method,
          threadId,
          tool: call.tool,
        });
        continue;
      }
      if (call.receiverThreadIds.length === 0) {
        // Codex also uses receiverless waits as timed yield operations. There
        // is no native sub-agent card to update in that case.
        if (call.tool === "wait") {
          continue;
        }
        backendRegistryLog.warn("codex native subagent call missing receiver thread ids", {
          itemId: call.itemId,
          method: event.notification.method,
          threadId,
          tool: call.tool,
        });
        continue;
      }

      for (const receiverThreadId of call.receiverThreadIds) {
        await this.persistCodexNativeSubAgent({
          call,
          parentThreadId: threadId,
          receiverThreadId,
        });
      }
    }
  }

  async recordCodexNativeSubAgentNames(event: AgentEvent): Promise<void> {
    if (event.backend !== "codex") {
      return;
    }
    const params = readRecord(event.notification.params);
    if (!params) {
      return;
    }
    const parentThreadId = readOptionalString(params, ["threadId", "thread_id"]);
    const turn = readRecord(params.turn);
    const turnId =
      readOptionalString(params, ["turnId", "turn_id"]) ?? readOptionalString(turn, ["id"]);
    if (!parentThreadId || !turnId) {
      return;
    }
    const names = textFragmentsFromCodexNotification(event.notification).flatMap(
      (text) => extractCodexNativeSpawnedAgentNames(text),
    );
    if (names.length === 0) {
      return;
    }

    const nativeCards = (await this.context.stores.subAgents.listThreadSubAgentsByMonitorIdPrefix({
      backend: "codex",
      threadIds: [parentThreadId],
      monitorIdPrefix: CODEX_NATIVE_MONITOR_ID_PREFIX,
    }))[parentThreadId] ?? [];
    const candidates = nativeCards
      .filter(
        (subAgent) =>
          subAgent.monitorTurnId === turnId &&
          !subAgent.agentName,
      )
      .sort((left, right) => left.createdAt - right.createdAt);
    if (candidates.length === 0) {
      return;
    }

    const count = Math.min(candidates.length, names.length);
    const now = Date.now();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates[index];
      const agentName = names[index];
      if (!candidate || !agentName) {
        continue;
      }
      await this.context.stores.subAgents.upsertThreadSubAgent({
        backend: "codex",
        threadId: parentThreadId,
        subAgent: {
          ...candidate,
          agentName,
          updatedAt: now,
        },
      });
    }
    this.host().invalidateThreadListCache("codex");
    await this.context.emit({
      backend: "codex",
      notification: {
        method: "thread/subAgents/updated",
        params: {
          threadId: parentThreadId,
        },
      },
    });
  }

  async recordCodexNativeSubAgentNotifications(
    event: AgentEvent,
  ): Promise<void> {
    if (event.backend !== "codex") {
      return;
    }
    const notifications = textFragmentsFromCodexNotification(event.notification).flatMap(
      (text) => extractCodexNativeSubAgentNotifications(text),
    );
    if (notifications.length === 0) {
      return;
    }

    const now = Date.now();
    for (const notification of notifications) {
      const parentThreadId =
        this.codexNativeSubAgentParents.get(notification.receiverThreadId) ??
        readOptionalString(readRecord(event.notification.params), [
          "threadId",
          "thread_id",
        ]);
      if (!parentThreadId) {
        continue;
      }
      const monitorId = codexNativeSubAgentId(notification.receiverThreadId);
      const existing = await this.context.stores.subAgents.getThreadSubAgent({
        backend: "codex",
        threadId: parentThreadId,
        monitorId,
      });
      if (!existing) {
        continue;
      }

      const outcome = codexNativeSubAgentOutcome(notification.status);
      const terminal = codexNativeSubAgentIsTerminal(notification.status);
      await this.context.stores.subAgents.upsertThreadSubAgent({
        backend: "codex",
        threadId: parentThreadId,
        subAgent: {
          ...existing,
          status: codexNativeSubAgentIsTerminal(existing.status)
            ? existing.status
            : notification.status,
          updatedAt: now,
          ...(notification.lastMessage
            ? { lastMessage: notification.lastMessage }
            : {}),
          ...(outcome && !existing.outcome ? { outcome } : {}),
          ...(terminal ? { completedAt: existing.completedAt ?? now } : {}),
        },
      });
      if (terminal) {
        this.clearCodexNativeSubAgentReconciliation(notification.receiverThreadId);
      }
      this.host().invalidateThreadListCache("codex");
      await this.context.emit({
        backend: "codex",
        notification: {
          method: "thread/subAgents/updated",
          params: {
            threadId: parentThreadId,
          },
        },
      });
    }
  }

  /**
   * Saves the cards for sub-agents Claude Code runs with its Agent tool, the
   * way native Codex workers are saved. They have no thread of their own: the
   * card names the task, and Claude stops it by the task id. A card that
   * already ended keeps its end.
   */
  async recordClaudeSubAgents(params: {
    threadId: string;
    subAgents: readonly ClaudeSubAgentCard[];
  }): Promise<void> {
    const existing = new Map((await this.context.stores.subAgents.getThreadSubAgents({
      backend: "claude",
      threadId: params.threadId,
      monitorIds: params.subAgents.map((card) => card.monitorId),
    })).map((card) => [card.monitorId, card]));
    const now = Date.now();
    const subAgents = params.subAgents.flatMap((card): ThreadSubAgentSummary[] => {
      const previous = existing.get(card.monitorId);
      if (previous && codexNativeSubAgentIsTerminal(previous.status)) return [];
      const outcome = codexNativeSubAgentOutcome(card.status);
      const createdAt = previous?.createdAt ?? card.startedAt ?? now;
      return [{
        ...previous,
        monitorId: card.monitorId,
        task: card.task,
        status: card.status,
        createdAt,
        updatedAt: Math.max(now, createdAt),
        ownerRuntimeInstanceId: previous?.ownerRuntimeInstanceId ?? this.host().runtimeInstanceId,
        ownerRegistrySessionId: previous?.ownerRegistrySessionId ?? this.host().registrySessionId,
        backend: "claude",
        ...(card.agentName ? { agentName: card.agentName } : {}),
        ...(card.lastMessage ? { lastMessage: truncateSubAgentText(card.lastMessage, 360) } : {}),
        ...(outcome ? { outcome, completedAt: previous?.completedAt ?? Math.max(now, createdAt) } : {}),
      }];
    });
    if (subAgents.length === 0) return;
    // One transaction for the batch where the store offers it.
    if (this.context.stores.subAgents.upsertThreadSubAgents) {
      await this.context.stores.subAgents.upsertThreadSubAgents({ backend: "claude", threadId: params.threadId, subAgents });
    } else {
      for (const subAgent of subAgents) {
        await this.context.stores.subAgents.upsertThreadSubAgent({ backend: "claude", threadId: params.threadId, subAgent });
      }
    }
    this.host().invalidateThreadListCache("claude");
    await this.context.emit({
      backend: "claude",
      notification: { method: "thread/subAgents/updated", params: { threadId: params.threadId } },
    });
  }

  /**
   * The thread list's sub-agent tray for Claude threads, from their saved
   * sub-agent cards: running ones, and ones that ended within the hour.
   */
  async withClaudeNativeSubAgents(
    threads: AppServerThreadSummary[],
  ): Promise<AppServerThreadSummary[]> {
    if (threads.length === 0) return threads;
    const cardsByThreadId = await this.context.stores.subAgents.listThreadSubAgentsByMonitorIdPrefix({
      backend: "claude",
      threadIds: threads.map((thread) => thread.id),
      monitorIdPrefix: CLAUDE_NATIVE_SUBAGENT_MONITOR_ID_PREFIX,
    });
    const now = Date.now();
    return threads.map((thread) => {
      // A Claude sub-agent has no thread; its row is keyed by its card.
      const agents = (cardsByThreadId[thread.id] ?? [])
        .map((card) => nativeSubAgentRowFromCard(card, card.monitorId))
        .filter((agent) => isCodexNativeSubAgentVisibleInNavigation(agent, now))
        .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0)
          || left.threadId.localeCompare(right.threadId));
      if (agents.length === 0) {
        if (!thread.codexNativeSubAgents) return thread;
        const { codexNativeSubAgents: _stale, ...rest } = thread;
        return rest;
      }
      return { ...thread, codexNativeSubAgents: agents };
    });
  }

  private async persistCodexNativeSubAgent(params: {
    authoritativeReplayOutcome?: boolean;
    call: CodexNativeSubAgentCall;
    observedAt?: number;
    parentThreadId: string;
    receiverThreadId: string;
  }): Promise<void> {
    const receiverOverlay = await this.context.stores.threads.getThreadOverlayState({
      backend: "codex",
      threadId: params.receiverThreadId,
    });
    if (receiverOverlay?.handoffOrigin?.groupingMode === "subthread") {
      // A monitor can wait on or inspect an ordinary PwrAgent handoff. Codex
      // reports that collaboration item with receiver thread IDs just like a
      // native worker call, but the receiver remains a durable navigation
      // thread. Never project it into the monitor's sub-agent cards.
      this.codexNativeSubAgentParents.delete(params.receiverThreadId);
      this.clearCodexNativeSubAgentReconciliation(params.receiverThreadId);
      return;
    }

    const now = params.observedAt ?? Date.now();
    this.codexNativeSubAgentParents.set(params.receiverThreadId, params.parentThreadId);
    const monitorId = codexNativeSubAgentId(params.receiverThreadId);
    const existing = await this.context.stores.subAgents.getThreadSubAgent({
      backend: "codex",
      threadId: params.parentThreadId,
      monitorId,
    });
    const prompt = readOptionalString(params.call.item, ["prompt"]);
    const itemStatus = readOptionalString(params.call.item, ["status"]);
    const agentState = readCodexNativeAgentState(
      params.call.item,
      params.receiverThreadId,
    );
    const mappedStatus = mapCodexNativeSubAgentStatus({
      agentState: agentState.status,
      itemStatus,
      tool: params.call.tool,
    });
    const status =
      existing && codexNativeSubAgentIsTerminal(existing.status)
      && !(params.authoritativeReplayOutcome && codexNativeSubAgentIsTerminal(mappedStatus))
        ? existing.status
        : mappedStatus;
    const completedAt =
      codexNativeSubAgentIsTerminal(status) && !existing?.completedAt
        ? now
        : existing?.completedAt;
    const model = readOptionalString(params.call.item, ["model"]);
    const reasoningEffort = readOptionalString(params.call.item, [
      "reasoningEffort",
      "reasoning_effort",
    ]);
    const fastMode = readBooleanLike(params.call.item, ["fastMode", "fast_mode"]);
    // Every source resolves `pathName || nickname`, so the reported name is
    // never a step down from the stored one.
    const agentName =
      params.call.receiverThreadNames.get(params.receiverThreadId)
      ?? existing?.agentName;
    if (
      params.call.activityBoundary
      && existing
      && existing.status === status
      && existing.agentName === agentName
      && (!model || existing.preferredModel === model)
      && (!reasoningEffort || existing.preferredReasoningEffort === reasoningEffort)
      && (!params.call.parentTurnId || existing.monitorTurnId === params.call.parentTurnId)
    ) {
      return;
    }
    const outcome = codexNativeSubAgentOutcome(status);
    // Only the worker's own words. The lifecycle event itself is already the
    // card's status, and narrating it ("Observed … state: completed.") put
    // implementation detail where the worker's message belongs.
    const lastMessage = agentState.message
      ? truncateSubAgentText(agentState.message, 360)
      : existing?.lastMessage;
    const subAgent: ThreadSubAgentSummary = {
      monitorId,
      task:
        existing?.task ??
        codexNativeSubAgentTask({
          prompt,
          threadId: params.receiverThreadId,
        }),
      status,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ownerRuntimeInstanceId:
        existing?.ownerRuntimeInstanceId ?? this.host().runtimeInstanceId,
      ownerRegistrySessionId:
        existing?.ownerRegistrySessionId ?? this.host().registrySessionId,
      backend: "codex",
      monitorThreadId: params.receiverThreadId,
      ...(params.call.parentTurnId
        ? { monitorTurnId: params.call.parentTurnId }
        : existing?.monitorTurnId
          ? { monitorTurnId: existing.monitorTurnId }
          : {}),
      ...(agentName ? { agentName } : {}),
      ...(model
        ? { preferredModel: model }
        : existing?.preferredModel
          ? { preferredModel: existing.preferredModel }
          : {}),
      ...(reasoningEffort
        ? { preferredReasoningEffort: reasoningEffort }
        : existing?.preferredReasoningEffort
          ? { preferredReasoningEffort: existing.preferredReasoningEffort }
          : {}),
      ...(fastMode !== undefined
        ? { preferredFastMode: fastMode }
        : existing?.preferredFastMode !== undefined
          ? { preferredFastMode: existing.preferredFastMode }
          : {}),
      ...(lastMessage ? { lastMessage } : {}),
      ...(outcome
        ? { outcome }
        : existing?.outcome
          ? { outcome: existing.outcome }
          : {}),
      ...(completedAt ? { completedAt } : {}),
      ...(existing?.monitorUsage ? { monitorUsage: existing.monitorUsage } : {}),
    };

    await this.context.stores.subAgents.upsertThreadSubAgent({
      backend: "codex",
      threadId: params.parentThreadId,
      subAgent,
    });
    this.host().invalidateThreadListCache("codex");
    await this.context.emit({
      backend: "codex",
      notification: {
        method: "thread/subAgents/updated",
        params: {
          threadId: params.parentThreadId,
        },
      },
    });
    if (codexNativeSubAgentIsTerminal(status)) {
      this.clearCodexNativeSubAgentReconciliation(params.receiverThreadId);
    } else {
      this.scheduleCodexNativeSubAgentReconciliation({
        delayMs: CODEX_NATIVE_SUBAGENT_INITIAL_STATUS_DELAY_MS,
        parentThreadId: params.parentThreadId,
        receiverThreadId: params.receiverThreadId,
      });
    }
  }

  private scheduleCodexNativeSubAgentReconciliation(params: {
    delayMs: number;
    parentThreadId: string;
    receiverThreadId: string;
  }): void {
    const existing = this.codexNativeSubAgentReconciliations.get(
      params.receiverThreadId,
    );
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }
    const reconciliation: CodexNativeSubAgentReconciliation = existing ?? {
      attempts: 0,
      parentThreadId: params.parentThreadId,
      receiverThreadId: params.receiverThreadId,
      startedAt: Date.now(),
    };
    reconciliation.parentThreadId = params.parentThreadId;
    const timer = setTimeout(() => {
      const scheduled = this.codexNativeSubAgentReconciliations.get(
        params.receiverThreadId,
      );
      if (scheduled) {
        scheduled.timer = undefined;
      }
      void withCodexRequestActivity({ countsAsActivity: false }, () =>
        this.reconcileCodexNativeSubAgent(params.receiverThreadId));
    }, params.delayMs);
    timer.unref?.();
    reconciliation.timer = timer;
    this.codexNativeSubAgentReconciliations.set(
      params.receiverThreadId,
      reconciliation,
    );
  }

  private clearCodexNativeSubAgentReconciliation(receiverThreadId: string): void {
    const reconciliation =
      this.codexNativeSubAgentReconciliations.get(receiverThreadId);
    if (reconciliation?.timer) {
      clearTimeout(reconciliation.timer);
    }
    this.codexNativeSubAgentReconciliations.delete(receiverThreadId);
  }

  private async reconcileCodexNativeSubAgent(
    receiverThreadId: string,
  ): Promise<void> {
    const reconciliation =
      this.codexNativeSubAgentReconciliations.get(receiverThreadId);
    if (!reconciliation) {
      return;
    }

    const monitorId = codexNativeSubAgentId(receiverThreadId);
    const existing = await this.context.stores.subAgents.getThreadSubAgent({
      backend: "codex",
      threadId: reconciliation.parentThreadId,
      monitorId,
    });
    if (!existing || codexNativeSubAgentIsTerminal(existing.status)) {
      this.clearCodexNativeSubAgentReconciliation(receiverThreadId);
      return;
    }

    const now = Date.now();
    if (
      reconciliation.attempts >= CODEX_NATIVE_SUBAGENT_MAX_RECONCILE_ATTEMPTS ||
      now - reconciliation.startedAt > CODEX_NATIVE_SUBAGENT_MAX_RECONCILE_AGE_MS
    ) {
      this.clearCodexNativeSubAgentReconciliation(receiverThreadId);
      return;
    }

    try {
      const probe = await this.host().withCodexThreadClient(
        receiverThreadId,
        async (client) =>
          await client.readThread({
            threadId: receiverThreadId,
            includeTurns: false,
            limit: 0,
          }),
        undefined,
        false,
      );
      reconciliation.attempts += 1;
      const status = probe.threadStatus;

      if (probe.agentName && probe.agentName !== existing.agentName) {
        await this.context.stores.subAgents.upsertThreadSubAgent({
          backend: "codex",
          threadId: reconciliation.parentThreadId,
          subAgent: {
            ...existing,
            agentName: probe.agentName,
            updatedAt: now,
          },
        });
        this.host().invalidateThreadListCache("codex");
        await this.context.emit({
          backend: "codex",
          notification: {
            method: "thread/subAgents/updated",
            params: {
              threadId: reconciliation.parentThreadId,
            },
          },
        });
      }

      if (status === "idle") {
        const completed = await this.completeCodexNativeSubAgentFromThread({
          existing,
          parentThreadId: reconciliation.parentThreadId,
          receiverThreadId,
        });
        if (completed) {
          this.clearCodexNativeSubAgentReconciliation(receiverThreadId);
          return;
        }
      }
    } catch (error) {
      backendRegistryLog.debug("codex native subagent reconciliation failed", {
        error: error instanceof Error ? error.message : String(error),
        parentThreadId: reconciliation.parentThreadId,
        receiverThreadId,
      });
    }

    const latest = this.codexNativeSubAgentReconciliations.get(receiverThreadId);
    if (!latest) {
      return;
    }
    this.scheduleCodexNativeSubAgentReconciliation({
      delayMs: codexNativeSubAgentNextReconciliationDelayMs(latest.attempts),
      parentThreadId: latest.parentThreadId,
      receiverThreadId,
    });
  }

  private async completeCodexNativeSubAgentFromThread(params: {
    existing: ThreadSubAgentSummary;
    parentThreadId: string;
    receiverThreadId: string;
  }): Promise<boolean> {
    const replay = await this.host().withCodexThreadClient(
      params.receiverThreadId,
      async (client) =>
        await client.readThread({
          threadId: params.receiverThreadId,
          includeTurns: true,
          limit: CODEX_NATIVE_SUBAGENT_FINAL_READ_LIMIT,
        }),
      undefined,
      false,
    );
    if (replay.threadStatus === "active") {
      return false;
    }

    const monitorId = codexNativeSubAgentId(params.receiverThreadId);
    const existing =
      await this.context.stores.subAgents.getThreadSubAgent({
        backend: "codex",
        threadId: params.parentThreadId,
        monitorId,
      }) ??
      params.existing;
    if (codexNativeSubAgentIsTerminal(existing.status)) {
      return true;
    }

    const now = Date.now();
    const lastMessage = replay.lastAssistantMessage
      ? truncateSubAgentText(replay.lastAssistantMessage, 360)
      : existing.lastMessage;
    await this.context.stores.subAgents.upsertThreadSubAgent({
      backend: "codex",
      threadId: params.parentThreadId,
      subAgent: {
        ...existing,
        status: "success",
        outcome: "success",
        completedAt: existing.completedAt ?? now,
        ...(lastMessage ? { lastMessage } : {}),
        ...(replay.agentName ? { agentName: replay.agentName } : {}),
        updatedAt: now,
      },
    });
    this.host().invalidateThreadListCache("codex");
    await this.context.emit({
      backend: "codex",
      notification: {
        method: "thread/subAgents/updated",
        params: {
          threadId: params.parentThreadId,
        },
      },
    });
    return true;
  }

  private async persistTaskMonitorSubAgent(
    record: TaskMonitorDelegationRecord,
    patch: Partial<
      Pick<
        ThreadSubAgentSummary,
        | "completedAt"
        | "completionSource"
        | "lastMessage"
        | "monitorUsage"
        | "outcome"
        | "status"
        | "updatedAt"
      >
    > = {},
  ): Promise<void> {
    const existing = await this.context.stores.subAgents.getThreadSubAgent({
      backend: record.parentBackend,
      threadId: record.parentThreadId,
      monitorId: record.monitorId,
    });
    const subAgent: ThreadSubAgentSummary = {
      ...record.causalContext,
      monitorId: record.monitorId,
      task: record.task,
      status:
        patch.status ??
        existing?.status ??
        (record.monitorThreadId ? "running" : "pending"),
      createdAt: record.createdAt,
      updatedAt: patch.updatedAt ?? Date.now(),
      ownerRuntimeInstanceId:
        existing?.ownerRuntimeInstanceId ?? this.host().runtimeInstanceId,
      ownerRegistrySessionId:
        existing?.ownerRegistrySessionId ?? this.host().registrySessionId,
      backend: record.backend,
      preferredModel: record.preferredModel,
      preferredReasoningEffort: record.preferredReasoningEffort,
      ...(record.monitorThreadId ? { monitorThreadId: record.monitorThreadId } : {}),
      ...(record.monitorTurnId ? { monitorTurnId: record.monitorTurnId } : {}),
      ...(patch.lastMessage ?? existing?.lastMessage
        ? { lastMessage: patch.lastMessage ?? existing?.lastMessage }
        : {}),
      ...(patch.outcome ?? existing?.outcome
        ? { outcome: patch.outcome ?? existing?.outcome }
        : {}),
      ...(patch.completedAt ?? existing?.completedAt
        ? { completedAt: patch.completedAt ?? existing?.completedAt }
        : {}),
      ...(patch.completionSource ?? existing?.completionSource
        ? { completionSource: patch.completionSource ?? existing?.completionSource }
        : {}),
      ...(patch.monitorUsage ?? record.latestUsage ?? existing?.monitorUsage
        ? {
            monitorUsage:
              patch.monitorUsage ?? record.latestUsage ?? existing?.monitorUsage,
          }
        : {}),
      pollIntervalSeconds: record.pollIntervalSeconds,
      heartbeatIntervalSeconds: record.heartbeatIntervalSeconds,
      startupTimeoutSeconds: record.startupTimeoutSeconds,
    };
    await this.context.stores.subAgents.upsertThreadSubAgent({
      backend: record.parentBackend,
      threadId: record.parentThreadId,
      subAgent,
    });
    record.persistedStatus = subAgent.status;
    this.host().invalidateThreadListCache(record.parentBackend);
    await this.context.emit({
      backend: record.parentBackend,
      notification: {
        method: "thread/subAgents/updated",
        params: {
          threadId: record.parentThreadId,
        },
      },
    });
  }

  recordTaskMonitorActivity(event: AgentEvent): void {
    const notification = event.notification;
    const params = readRecord(notification.params);
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    if (!threadId) {
      return;
    }

    const monitorRecord = Array.from(this.taskMonitorDelegations.values()).find(
      (record) =>
        record.backend === event.backend && record.monitorThreadId === threadId,
    );
    if (!monitorRecord) {
      return;
    }

    monitorRecord.lastActivityAt = Date.now();
    // Claude answers a finished or printing watcher with a native turn of its
    // own. That turn is now the monitor's.
    const startedTurnId = notification.method === "turn/started"
      ? readNonEmptyString(params?.turnId) ?? readNonEmptyString(readRecord(params?.turn)?.id)
      : undefined;
    if (monitorRecord.backend === "claude" && startedTurnId) {
      monitorRecord.monitorTurnId = startedTurnId;
      monitorRecord.awaitingClaudeTaskWake = false;
    }
    const itemType = readNotificationItemType(notification);
    if (itemType !== "commandExecution") {
      return;
    }

    if (notification.method === "item/started") {
      monitorRecord.activeCommandCount += 1;
    } else if (notification.method === "item/completed") {
      monitorRecord.activeCommandCount = Math.max(
        0,
        monitorRecord.activeCommandCount - 1,
      );
    }
  }

  isTaskMonitorThread(context: { backend: AppServerBackendKind; threadId: string }): boolean {
    return Boolean(this.taskMonitorForThread(context))
      || this.completedTaskMonitorsByThread.has(taskMonitorThreadKey(context.backend, context.threadId));
  }

  taskMonitorForThread(context: { backend: AppServerBackendKind; threadId: string }): TaskMonitorDelegationRecord | undefined {
    return [...this.taskMonitorDelegations.values()].find((record) =>
      record.backend === context.backend && record.monitorThreadId === context.threadId);
  }

  private async handleTaskMonitorRequest(
    request: TaskMonitorRequest,
  ): Promise<TaskMonitorResponse> {
    if (request.operation === "create_monitor_delegation") {
      return await this.createTaskMonitorDelegation(
        request.context,
        request.args as CreateMonitorDelegationToolArgs,
      );
    }
    if (request.operation === "cancel_monitor_delegation") {
      return await this.cancelTaskMonitorDelegation(
        request.context,
        request.args as CancelMonitorDelegationToolArgs,
      );
    }
    if (request.operation === "inject_progress") {
      return await this.injectTaskMonitorProgress(
        request.context,
        request.args as InjectMonitorProgressToolArgs,
      );
    }
    return await this.completeTaskMonitoring(
      request.context,
      request.args as CompleteMonitoringToolArgs,
    );
  }

  async handleAgentTaskMonitorRequest(
    request: TaskMonitorRequest,
  ): Promise<TaskMonitorResponse> {
    if (request.operation === "create_monitor_delegation") {
      return await this.handleCreateMonitorAgentRequest(request);
    }
    if (request.operation === "cancel_monitor_delegation") {
      return await this.handleCancelMonitorAgentRequest(request);
    }
    return await this.handleTaskMonitorRequest(request);
  }

  private async handleCreateMonitorAgentRequest(
    request: TaskMonitorRequest<"create_monitor_delegation">,
  ): Promise<TaskMonitorResponse<"create_monitor_delegation">> {
    if (
      !this.host().isLiveDynamicToolCall(request.context.backend, {
        threadId: request.context.threadId,
        turnId: request.context.turnId,
      })
    ) {
      backendRegistryLog.warn("rejecting task monitor tool call", {
        backend: request.context.backend,
        threadId: request.context.threadId,
        tool: request.operation,
        turnId: request.context.turnId,
      });
      return taskMonitorFailure(
        "create_monitor_delegation",
        "forbidden",
        "Task monitor delegations must originate from an active turn.",
      );
    }
    return await this.createTaskMonitorDelegation(
      request.context,
      request.args,
    );
  }

  private async handleCancelMonitorAgentRequest(
    request: TaskMonitorRequest<"cancel_monitor_delegation">,
  ): Promise<TaskMonitorResponse<"cancel_monitor_delegation">> {
    if (
      !this.host().isLiveDynamicToolCall(request.context.backend, {
        threadId: request.context.threadId,
        turnId: request.context.turnId,
      })
    ) {
      backendRegistryLog.warn("rejecting task monitor cancellation tool call", {
        backend: request.context.backend,
        threadId: request.context.threadId,
        tool: request.operation,
        turnId: request.context.turnId,
      });
      return taskMonitorFailure(
        "cancel_monitor_delegation",
        "forbidden",
        "Task monitor cancellation must originate from an active parent turn.",
      );
    }
    return await this.cancelTaskMonitorDelegation(
      request.context,
      request.args,
    );
  }

  private async createTaskMonitorDelegation(
    context: TaskMonitorRequest<"create_monitor_delegation">["context"],
    args: CreateMonitorDelegationToolArgs,
  ): Promise<TaskMonitorResponse<"create_monitor_delegation">> {
    const parentThreadId = context.threadId;
    const causalContext = await this.host().readCausalMessagingContext(context);
    const task = args.task?.trim();
    if (!task) {
      return taskMonitorFailure("create_monitor_delegation", "invalid_arguments", "task is required.");
    }
    const unsupportedSessionReference = findUnsupportedCodexExecSessionReference({
      task,
      monitorContext: args.monitorContext,
    });
    if (unsupportedSessionReference) {
      return taskMonitorFailure(
        "create_monitor_delegation",
        "invalid_arguments",
        [
          `Task monitor delegations cannot use a parent-scoped ${unsupportedSessionReference} as the local-command polling handle.`,
          "Keep polling that already-started Codex exec session in the parent turn, or create a fresh monitor delegation with the command text, cwd, terminal criteria, and desired stdout/stderr capture-file paths so the monitor child starts the command in its own session.",
        ].join(" "),
      );
    }

    const mcpAccess = await this.threadMcpConnections.taskMonitorMcpAccess({ ...context, transport: "codex_dynamic_tool" });
    if (mcpAccess.connectionIds.length && !this.host().mcpGatewayTools) {
      return taskMonitorFailure("create_monitor_delegation", "internal_error",
        "Selected MCP connections cannot be delegated because the MCP gateway is unavailable. Keep the cloud task in the parent.");
    }
    const monitorId = `monitor-${randomUUID()}`;
    const pollIntervalSeconds =
      normalizePollIntervalSeconds(args.pollIntervalSeconds) ??
      DEFAULT_TASK_MONITOR_POLL_INTERVAL_SECONDS;
    const heartbeatIntervalSeconds = pollIntervalSeconds;
    const requestedModel = args.preferredModel?.trim() || undefined;
    const requestedReasoningEffort =
      args.preferredReasoningEffort?.trim() || undefined;
    let monitorBackend: AppServerBackendKind;
    let preferredModel: string;
    let preferredReasoningEffort: string;
    let runtimeModel: string | undefined;
    try {
      const resolved = await this.resolveTaskMonitorModelSettings({
        backend: context.backend,
        parentThreadId,
        preferredModel: requestedModel,
        preferredReasoningEffort: requestedReasoningEffort,
      });
      monitorBackend = resolved.monitorBackend;
      preferredModel = resolved.preferredModel;
      preferredReasoningEffort = resolved.preferredReasoningEffort;
      runtimeModel = resolved.runtimeModel;
    } catch (error) {
      return taskMonitorFailure(
        "create_monitor_delegation",
        "internal_error",
        `Task monitor delegation could not select a runtime model: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const startupTimeoutSeconds = DEFAULT_TASK_MONITOR_STARTUP_TIMEOUT_SECONDS;
    const parentAgentGuidance = buildMonitorParentAgentGuidance({
      pollIntervalSeconds,
      preferredModel,
      preferredReasoningEffort,
      startupTimeoutSeconds,
    });
    const prompt = buildMonitorDelegationPrompt({
      mcpConnectionIds: mcpAccess.connectionIds,
      claudeCode: monitorBackend === "claude",
      finalHandoffPrompt: args.finalHandoffPrompt,
      monitorContext: args.monitorContext,
      monitorId,
      parentThreadId,
      pollIntervalSeconds,
      preferredModel,
      preferredReasoningEffort,
      task,
    });
    if (
      preferredModel !== requestedModel ||
      preferredReasoningEffort !== requestedReasoningEffort
    ) {
      const codexMonitor = monitorBackend === "codex";
      backendRegistryLog.info("adjusted task monitor model settings", {
        monitorBackend,
        monitorId,
        parentThreadId,
        preferredModel,
        preferredReasoningEffort,
        requestedModel,
        requestedReasoningEffort,
        ...(codexMonitor && requestedModel && !isLightweightHelperModel(requestedModel)
          ? { declinedRequestedModel: true }
          : {}),
        ...(codexMonitor
          && requestedReasoningEffort
          && !isLightweightMonitorReasoningEffort(requestedReasoningEffort)
          ? { declinedRequestedReasoningEffort: true }
          : {}),
      });
    }
    const ancestry = await this.host().readDelegatedTurnAncestry(context);
    const record: TaskMonitorDelegationRecord = {
      causalContext,
      ...(ancestry.rootTurnId ? { rootTurnId: ancestry.rootTurnId } : {}),
      activeCommandCount: 0,
      // The monitor thread's provider. A Claude parent's monitor may run on
      // Codex, and every lookup by monitor thread matches this backend.
      backend: monitorBackend,
      // Only a Claude recovery repeats the brief.
      ...(monitorBackend === "claude" ? { brief: prompt } : {}),
      createdAt: Date.now(),
      finalHandoffPrompt: args.finalHandoffPrompt?.trim() || undefined,
      heartbeatIntervalSeconds,
      lastActivityAt: Date.now(),
      mcpAccess,
      monitorId,
      parentBackend: context.backend,
      parentThreadId,
      parentTurnId: context.turnId,
      pollIntervalSeconds,
      preferredModel,
      preferredReasoningEffort,
      runtimeModel,
      startupTimeoutSeconds,
      task,
    };
    this.taskMonitorDelegations.set(monitorId, record);
    backendRegistryLog.info("created task monitor delegation", {
      heartbeatIntervalSeconds,
      monitorId,
      monitorBackend,
      parentThreadId,
      pollIntervalSeconds,
      startupTimeoutSeconds,
    });

    let startedMonitor: {
      cwd?: string;
      executionMode: ThreadExecutionMode;
      threadId: string;
      turnId: string;
    };
    try {
      startedMonitor = await this.startManagedTaskMonitor({
        context,
        ...(record.rootTurnId ? { rootTurnId: record.rootTurnId } : {}),
        causalContext,
        cwd: args.cwd,
        monitorBackend,
        monitorId,
        preferredModel,
        preferredReasoningEffort,
        runtimeModel,
        prompt,
      });
    } catch (error) {
      this.taskMonitorDelegations.delete(monitorId);
      backendRegistryLog.error("failed to start managed task monitor", {
        error: error instanceof Error ? error.message : String(error),
        monitorId,
        parentThreadId,
      });
      return taskMonitorFailure(
        "create_monitor_delegation",
        "internal_error",
        `Failed to start managed task monitor: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    record.cwd = startedMonitor.cwd;
    record.executionMode = startedMonitor.executionMode;
    record.lastActivityAt = Date.now();
    record.monitorThreadId = startedMonitor.threadId;
    record.monitorTurnId = startedMonitor.turnId;
    await this.persistTaskMonitorSubAgent(record, { status: "running" });
    await this.context.emit({
      backend: record.parentBackend,
      notification: {
        method: "item/completed",
        params: {
          threadId: record.parentThreadId,
          turnId: `monitor:${monitorId}`,
          item: {
            id: `${monitorId}:created`,
            type: "taskMonitorCreated",
            data: {
              source: "pwragent_task_monitor",
              monitorId,
              parentTurnId: record.parentTurnId,
              task: record.task,
            },
          },
        },
      },
    });

    return {
      ok: true,
      operation: "create_monitor_delegation",
      data: {
        monitorId,
        parentThreadId,
        preferredModel,
        preferredReasoningEffort,
        pollIntervalSeconds,
        heartbeatIntervalSeconds,
        startupTimeoutSeconds,
        startedByPwrAgent: true,
        startupConfirmed: true,
        parentShouldPoll: false,
        completionWakesParentByDefault: true,
        monitorThreadId: startedMonitor.threadId,
        monitorTurnId: startedMonitor.turnId,
        parentAgentGuidance,
        prompt,
      },
    };
  }

  private async cancelTaskMonitorDelegation(
    context: TaskMonitorRequest<"cancel_monitor_delegation">["context"],
    args: CancelMonitorDelegationToolArgs,
  ): Promise<TaskMonitorResponse<"cancel_monitor_delegation">> {
    const monitorId = args.monitorId?.trim();
    if (!monitorId) {
      return taskMonitorFailure(
        "cancel_monitor_delegation",
        "invalid_arguments",
        "monitorId is required.",
      );
    }

    const record = this.taskMonitorDelegations.get(monitorId);
    if (!record) {
      const card = await this.context.stores.subAgents.getThreadSubAgent({
        backend: context.backend,
        threadId: context.threadId,
        monitorId,
      });
      const completedCancellation = card
        && card.outcome === "cancelled"
        && card.completionSource?.type === "parent_cancel"
        ? card : undefined;
      if (completedCancellation) {
        return {
          ok: true,
          operation: "cancel_monitor_delegation",
          data: {
            monitorId,
            parentThreadId: context.threadId,
            injected: true,
            outcome: "cancelled",
            completionSource: { type: "parent_cancel" },
            ...(completedCancellation.monitorUsage
              ? { monitorUsage: completedCancellation.monitorUsage }
              : {}),
          },
        };
      }
      return taskMonitorFailure(
        "cancel_monitor_delegation",
        "not_found",
        "Unknown, completed, or non-cancellable monitorId.",
      );
    }
    if (
      record.parentBackend !== context.backend
      || record.parentThreadId !== context.threadId
    ) {
      return taskMonitorFailure(
        "cancel_monitor_delegation",
        "forbidden",
        "Only the parent thread that created a monitor may cancel it.",
      );
    }
    if (record.cancellation) {
      return await record.cancellation.promise;
    }
    if (record.finalizationStarted) {
      return taskMonitorFailure(
        "cancel_monitor_delegation",
        "not_found",
        "The monitor is already completing and can no longer be cancelled.",
      );
    }
    if (!record.monitorThreadId || !record.monitorTurnId) {
      return taskMonitorFailure(
        "cancel_monitor_delegation",
        "internal_error",
        "The monitor turn has not started and cannot be interrupted yet.",
      );
    }

    const summary =
      args.reason?.trim()
      || "Monitoring cancelled by the parent agent.";
    let resolveCancellation!: TaskMonitorCancellationState["resolve"];
    const cancellationPromise = new Promise<
      TaskMonitorResponse<"cancel_monitor_delegation">
    >((resolve) => {
      resolveCancellation = resolve;
    });
    const cancellation: TaskMonitorCancellationState = {
      finalizing: false,
      promise: cancellationPromise,
      requestPersisted: Promise.resolve(),
      resolve: resolveCancellation,
      summary,
    };
    // Own cancellation before the first await so overlapping tool calls share
    // one interrupt and one terminal completion.
    record.cancellation = cancellation;
    record.lastActivityAt = Date.now();
    cancellation.requestPersisted = this.persistTaskMonitorSubAgent(record, {
      lastMessage: "Cancellation requested; waiting for the monitor turn to stop.",
      status: "cancelling",
    });
    try {
      await cancellation.requestPersisted;
      if (
        cancellation.finalizing
        || this.taskMonitorDelegations.get(monitorId) !== record
      ) {
        return await cancellation.promise;
      }
      await this.interruptManagedTaskMonitor(record);
      // A Claude monitor waiting on its watcher has no turn to stop, so no
      // terminal event would ever finish the cancellation.
      if (record.awaitingClaudeTaskWake && !cancellation.finalizing) {
        await this.finalizeTaskMonitorCancellation(record, "cancelled");
      }
    } catch (error) {
      if (
        record.cancellation !== cancellation
        || cancellation.finalizing
        || !this.taskMonitorDelegations.has(monitorId)
      ) {
        return await cancellation.promise;
      }
      record.cancellation = undefined;
      backendRegistryLog.error("failed to cancel task monitor", {
        error: error instanceof Error ? error.message : String(error),
        monitorId,
        monitorThreadId: record.monitorThreadId,
        monitorTurnId: record.monitorTurnId,
        parentThreadId: record.parentThreadId,
      });
      const failure = taskMonitorFailure(
        "cancel_monitor_delegation",
        "internal_error",
        `Failed to interrupt task monitor: ${error instanceof Error ? error.message : String(error)}`,
      );
      cancellation.resolve(failure);
      await this.persistTaskMonitorSubAgent(record, {
        lastMessage: "Cancellation could not be requested; the monitor is still running.",
        status: "running",
      });
      return failure;
    }

    return await cancellation.promise;
  }

  private async finalizeTaskMonitorCancellation(
    record: TaskMonitorDelegationRecord,
    terminalStatus: "completed" | "failed" | "cancelled",
  ): Promise<void> {
    const cancellation = record.cancellation;
    if (!cancellation || cancellation.finalizing) {
      return;
    }
    cancellation.finalizing = true;
    const completionSource: TaskMonitorCompletionSource = {
      type: "parent_cancel",
    };
    try {
      await cancellation.requestPersisted;
      await this.finishTaskMonitorDelegation({
        completionSource,
        details: `Monitor turn reached terminal status: ${terminalStatus}.`,
        outcome: "cancelled",
        record,
        summary: cancellation.summary,
        triggerParentTurn: false,
      });
      cancellation.resolve({
        ok: true,
        operation: "cancel_monitor_delegation",
        data: {
          monitorId: record.monitorId,
          parentThreadId: record.parentThreadId,
          injected: true,
          outcome: "cancelled",
          completionSource,
          ...(record.latestUsage ? { monitorUsage: record.latestUsage } : {}),
        },
      });
    } catch (error) {
      cancellation.finalizing = false;
      if (this.taskMonitorDelegations.get(record.monitorId) === record) {
        record.cancellation = undefined;
      }
      backendRegistryLog.error("failed to finalize task monitor cancellation", {
        error: error instanceof Error ? error.message : String(error),
        monitorId: record.monitorId,
        monitorThreadId: record.monitorThreadId,
        monitorTurnId: record.monitorTurnId,
        parentThreadId: record.parentThreadId,
        terminalStatus,
      });
      cancellation.resolve(taskMonitorFailure(
        "cancel_monitor_delegation",
        "internal_error",
        `Monitor stopped, but cancellation could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  /**
   * Where a monitor runs and on which model. A Codex parent's monitor runs on
   * the Helper model. Another provider's runs on its own lightweight model
   * (Automatic), on a model the operator chose for that provider, or on the
   * Helper model when the operator chose it.
   */
  private async resolveTaskMonitorModelSettings(params: {
    backend: AppServerBackendKind;
    parentThreadId: string;
    preferredModel?: string;
    preferredReasoningEffort?: string;
  }): Promise<{
    monitorBackend: AppServerBackendKind;
    preferredModel: string;
    preferredReasoningEffort: string;
    runtimeModel?: string;
  }> {
    const choice = params.backend === "codex"
      ? undefined
      : this.host().resolveTaskMonitorModelsFn()[params.backend];
    if (choice?.source !== "helper" && isAcpBackendId(params.backend)) {
      return {
        monitorBackend: params.backend,
        ...this.resolveAcpTaskMonitorModelSettings({
          ...params,
          backend: params.backend,
          // The operator's choice outranks the agent's request.
          preferredModel: choice?.model ?? params.preferredModel,
          preferredReasoningEffort: choice?.reasoningEffort ?? params.preferredReasoningEffort,
        }),
      };
    }
    if (choice?.source !== "helper" && params.backend === "claude") {
      return {
        monitorBackend: "claude",
        ...this.resolveClaudeTaskMonitorModelSettings({ ...params, choice }),
      };
    }

    const discoveredModels = await this.host().readCodexDefaultModelsOnce("task-monitor");
    const options = buildLaunchpadOptions("codex", discoveredModels, {
      allowFallbackModels: false,
    });
    const models = options?.models ?? [];
    if (models.length === 0) {
      throw new Error(
        "No available Codex models were discovered for task monitor delegation.",
      );
    }
    // An agent may steer a monitor only toward a cheaper setting: a
    // lightweight model, at medium effort or lower. A parent on GPT-6-Astra
    // xhigh once passed its own settings to every monitor it created. A
    // request Codex offers wins; otherwise the Helper model setting decides,
    // and the operator's Task monitors row may still name any model.
    const requestedModel =
      params.preferredModel && isLightweightHelperModel(params.preferredModel)
        ? params.preferredModel
        : undefined;
    const requestedReasoningEffort =
      params.preferredReasoningEffort
      && isLightweightMonitorReasoningEffort(params.preferredReasoningEffort)
        ? params.preferredReasoningEffort
        : undefined;
    const selection = resolveHelperModel({
      helper: "task_monitors",
      settings: this.host().resolveHelperModelSettingsFn(),
      models: models.map((model) => ({
        ...model,
        reasoningEfforts: model.reasoningEfforts
          ?? options?.reasoningEfforts
          ?? OPENAI_REASONING_EFFORTS,
      })),
      requestedModel,
      requestedReasoningEffort,
    });

    return {
      monitorBackend: "codex",
      preferredModel: selection.model ?? models[0].id,
      preferredReasoningEffort: selection.reasoningEffort ?? "provider-default",
    };
  }

  /**
   * A Claude parent's monitor: the operator's model, else a lightweight model
   * the agent asked for, else Claude's newest lightweight model. The `haiku`
   * alias stands in until model discovery has run.
   */
  private resolveClaudeTaskMonitorModelSettings(params: {
    choice?: DesktopTaskMonitorModelChoice;
    preferredModel?: string;
    preferredReasoningEffort?: string;
  }): { preferredModel: string; preferredReasoningEffort: string; runtimeModel: string } {
    const models = this.context.providers.claude.summary().launchpadOptions?.models ?? [];
    // A model Claude offers. Before discovery, only a Claude name: an agent
    // may ask for a Codex model it read about.
    const offered = (id: string | undefined): string | undefined =>
      id && (models.length > 0
        ? models.some((candidate) => candidate.id === id)
        : /(?:^|[^a-z])(?:claude|haiku|sonnet|opus)(?:$|[^a-z])/iu.test(id))
        ? id
        : undefined;
    const chosenModel = offered(params.choice?.model);
    const requestedModel =
      params.preferredModel && isLightweightHelperModel(params.preferredModel)
        ? offered(params.preferredModel)
        : undefined;
    const model = chosenModel
      ?? requestedModel
      ?? automaticProviderMonitorModel(models)
      ?? "haiku";
    const entry = models.find((candidate) => candidate.id === model);
    const requestedEffort = (chosenModel ? params.choice?.reasoningEffort : undefined)
      ?? (params.preferredReasoningEffort
        && isLightweightMonitorReasoningEffort(params.preferredReasoningEffort)
        ? params.preferredReasoningEffort
        : undefined);
    const preferredReasoningEffort =
      requestedEffort && entry?.reasoningEfforts?.includes(requestedEffort)
        ? requestedEffort
        : "provider-default";
    return { preferredModel: model, preferredReasoningEffort, runtimeModel: model };
  }

  private resolveAcpTaskMonitorModelSettings(params: {
    backend: AcpBackendId;
    parentThreadId: string;
    preferredModel?: string;
    preferredReasoningEffort?: string;
  }): {
    preferredModel: string;
    preferredReasoningEffort: string;
    runtimeModel?: string;
  } {
    const options = this.context.providers.acp.getLaunchpadOptions(params.backend);
    const models = options?.models ?? [];
    const parentSession = this.context.providers.acp.getSession(
      params.backend,
      params.parentThreadId,
    );
    const requestedModel = params.preferredModel?.trim();
    const selectedModel =
      (requestedModel
        ? models.find((model) => model.id === requestedModel)
        : undefined) ??
      // Settings labels Automatic with this same pick.
      models.find((model) => model.id === automaticProviderMonitorModel(models)) ??
      models.find(
        (model) => model.id === parentSession?.acpRuntime?.currentModelId,
      ) ??
      models.find((model) => model.current) ??
      models[0];
    const preferredModel =
      selectedModel?.id ??
      requestedModel ??
      parentSession?.acpRuntime?.currentModelId ??
      `${params.backend.slice("acp:".length)}-default`;
    const runtimeModel =
      selectedModel?.id ??
      requestedModel ??
      parentSession?.acpRuntime?.currentModelId;
    // The catalog answers for a model it says has no reasoning levels. The
    // agent-wide thought-level menu below is whichever session wrote last: on
    // Kimi, a K3 thread's levels, which K2.7 Coding refuses.
    if (selectedModel?.supportsReasoning === false) {
      return {
        preferredModel,
        preferredReasoningEffort: "provider-default",
        runtimeModel,
      };
    }
    const reasoningEfforts =
      selectedModel?.reasoningEfforts ??
      options?.reasoningEfforts ??
      readAcpThoughtLevelValues(
        this.context.providers.acp.getInstalledAgent(params.backend)?.runtimeCapabilities,
      );
    const requestedReasoningEffort = params.preferredReasoningEffort?.trim();
    const preferredReasoningEffort =
      (requestedReasoningEffort && reasoningEfforts.includes(requestedReasoningEffort)
        ? requestedReasoningEffort
        : undefined) ??
      selectLowestMonitorReasoningEffort(reasoningEfforts) ??
      requestedReasoningEffort ??
      parentSession?.acpRuntime?.reasoningEffort ??
      "provider-default";

    return { preferredModel, preferredReasoningEffort, runtimeModel };
  }

  private bindTaskMonitorMcpThread(monitorId: string, threadId: string, executionMode: ThreadExecutionMode): void {
    const record = this.taskMonitorDelegations.get(monitorId);
    if (!record) throw new Error("Task monitor delegation no longer exists.");
    record.monitorThreadId = threadId;
    record.executionMode = executionMode;
  }

  private async startCodexTaskMonitorTurn(params: {
    causalContext: TaskMonitorDelegationRecord["causalContext"];
    threadId: string;
    start: () => Promise<{ threadId: string; turnId: string }>;
    afterStart: (turn: { threadId: string; turnId: string }) => void;
  }): Promise<{ threadId: string; turnId: string }> {
    const startingOrigin = isCausalMessagingContext(params.causalContext)
      ? this.host().beginStartingTurnOrigin({ backend: "codex", threadId: params.threadId,
        origin: buildTaskMonitorPromptOrigin(params.causalContext) })
      : undefined;
    let turn: { threadId: string; turnId: string };
    try {
      turn = await params.start();
      this.host().bindStartingTurnOrigin(startingOrigin, turn);
      params.afterStart(turn);
    } catch (error) {
      this.host().dropStartingTurnOrigin(startingOrigin);
      throw error;
    }
    await this.host().persistStartingTurnOrigin(startingOrigin);
    return turn;
  }

  private async startManagedTaskMonitor(params: {
    rootTurnId?: string;
    causalContext?: Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">;
    context: TaskMonitorRequest<"create_monitor_delegation">["context"];
    cwd?: string;
    /** The provider the monitor thread runs on. */
    monitorBackend: AppServerBackendKind;
    monitorId: string;
    preferredModel: string;
    preferredReasoningEffort: string;
    runtimeModel?: string;
    prompt: string;
  }): Promise<{
    cwd?: string;
    executionMode: ThreadExecutionMode;
    threadId: string;
    turnId: string;
  }> {
    const sourceOverlay = await this.context.stores.threads.getThreadOverlayState({
      backend: params.context.backend,
      threadId: params.context.threadId,
    });
    const executionMode =
      (params.context.backend === "codex"
        ? this.host().activeCodexTurnModes.get(
            buildActiveTurnModeKey(params.context.threadId, params.context.turnId),
          )
        : undefined) ??
      sourceOverlay?.executionMode ??
      (params.context.backend === "codex"
        ? await this.host().resolveCodexThreadExecutionModeForActiveTurn(
            params.context.threadId,
          )
        : isAcpBackendId(params.context.backend)
          ? this.context.providers.acp.getSession(
              params.context.backend,
              params.context.threadId,
            )?.executionMode ?? "default"
          : "default");
    const modeSettings = executionModeSettings(executionMode);
    const cwd =
      params.cwd?.trim() ||
      (await this.host().resolveThreadEnvironmentCwd(
        params.context.backend,
        params.context.threadId,
        sourceOverlay,
      ));
    // A Codex monitor reports through its dynamic tools whatever provider
    // its parent runs on. Claude and ACP monitors use PwrAgent's MCP server.
    const dynamicTools =
      params.monitorBackend === "codex"
        ? new AgentToolRouter([
            ...buildPwrAgentTaskMonitorToolDefinitions(undefined, "monitor"),
            ...buildMcpGatewayToolDefinitions(this.host().mcpGatewayTools),
            ...this.forgeToolBridge.buildTaskMonitorForgeToolDefinitions(this.forgeToolBridge.resolveForgeToolPolicy()),
          ]).buildDynamicToolSpecs()
        : [];

    backendRegistryLog.info("starting managed task monitor thread", {
      cwd: cwd ?? null,
      executionMode,
      hasCodexEnvironmentRuntime: Boolean(
        sourceOverlay?.codexEnvironmentRuntime,
      ),
      shellEnvironmentKeyCount:
        sourceOverlay?.codexEnvironmentRuntime?.shellEnvironment
          ? Object.keys(
              sourceOverlay.codexEnvironmentRuntime.shellEnvironment,
            ).length
          : 0,
      monitorBackend: params.monitorBackend,
      monitorId: params.monitorId,
      model: params.preferredModel,
      parentThreadId: params.context.threadId,
      provider: params.context.backend,
      reasoningEffort: params.preferredReasoningEffort,
      toolCount: dynamicTools.length,
    });

    if (params.monitorBackend === "claude") {
      const thread = await this.host().withArchiveWorkspaceWrite([cwd ?? os.homedir()], async () => await this.context.providers.claude.startThread({
        cwd: cwd ?? os.homedir(),
        executionMode,
        model: params.runtimeModel ?? params.preferredModel,
        ephemeral: { title: "Task monitor" },
      }));
      this.bindTaskMonitorMcpThread(params.monitorId, thread.threadId, executionMode);
      const turn = await this.host().startTurnWithoutHandoff({
        backend: "claude",
        threadId: thread.threadId,
        input: [{ type: "text", text: params.prompt }],
        executionMode,
        model: params.runtimeModel ?? params.preferredModel,
        ...(params.preferredReasoningEffort === "provider-default"
          ? {}
          : { reasoningEffort: params.preferredReasoningEffort }),
        messageOrigin: buildTaskMonitorPromptOrigin(params.causalContext),
      }).catch((error: unknown) => {
        this.context.providers.claude.releaseEphemeralThread(thread.threadId);
        throw error;
      });
      return { cwd, executionMode, threadId: turn.threadId, turnId: turn.turnId };
    }

    if (isAcpBackendId(params.monitorBackend) && isAcpBackendId(params.context.backend)) {
      const parentSession = this.context.providers.acp.getSession(
        params.context.backend,
        params.context.threadId,
      );
      const runtimeCapabilities = this.context.providers.acp.getInstalledAgent(
        params.context.backend,
      )?.runtimeCapabilities;
      const reasoningEffort =
        params.preferredReasoningEffort === "provider-default"
          ? undefined
          : params.preferredReasoningEffort;
      const thoughtLevelOption = findAcpThoughtLevelConfigOption(
        runtimeCapabilities,
      );
      const selectedRuntime = params.runtimeModel
        ? withAcpModelRuntimeSelection({
            runtime: parentSession?.acpRuntime,
            runtimeCapabilities,
            model: params.runtimeModel,
            reasoningEffort,
            now: Date.now(),
          })
        : reasoningEffort && thoughtLevelOption
          ? {
              ...parentSession?.acpRuntime,
              configValues: {
                ...(parentSession?.acpRuntime?.configValues ?? {}),
                [thoughtLevelOption.id]: reasoningEffort,
              },
              reasoningEffort,
              updatedAt: Date.now(),
            }
          : parentSession?.acpRuntime;
      const thread = await this.host().startAcpSession({
        backend: params.context.backend,
        cwd,
        executionMode,
        acpRuntime: selectedRuntime,
        reasoningEffort,
        hidden: true,
      });
      this.bindTaskMonitorMcpThread(params.monitorId, thread.threadId, executionMode);
      const startingOrigin = this.host().beginStartingTurnOrigin({ backend: params.context.backend,
        threadId: thread.threadId, origin: buildTaskMonitorPromptOrigin(params.causalContext) });
      let turn: { threadId: string; turnId: string };
      try {
        turn = await this.host().startAcpTurn({
          backend: params.context.backend,
          threadId: thread.threadId,
          input: [{ type: "text", text: params.prompt }],
          model: params.runtimeModel,
          reasoningEffort,
        });
        this.host().bindStartingTurnOrigin(startingOrigin, turn);
        await this.host().persistStartingTurnOrigin(startingOrigin);
      } finally {
        this.host().dropStartingTurnOrigin(startingOrigin);
      }
      return {
        cwd,
        executionMode,
        threadId: turn.threadId,
        turnId: turn.turnId,
      };
    }

    const client = this.host().getClient("codex", executionMode);
    const inheritedNames = await this.threadMcpConnections.readConfiguredCodexMcpServerNames(cwd);
    if (inheritedNames === undefined) throw codexMcpIsolationUnavailableError();
    const config = buildCodexConnectionMcpConfig([], inheritedNames, { isolateFromInherited: true });
    const thread = await this.host().withArchiveWorkspaceWrite(cwd ? [cwd] : [], async () => await client.startThread({
      config,
      ...(cwd ? { cwd } : {}),
      approvalPolicy: modeSettings.approvalPolicy,
      dynamicTools,
      // Do not persist managed workers in the shared Codex history: other
      // profiles and the Codex app cannot rely on our local navigation filter.
      // Progress, results, and usage remain on the parent's sub-agent record.
      ephemeral: true,
      model: params.preferredModel,
      reasoningEffort: params.preferredReasoningEffort,
      approvalsReviewer: modeSettings.approvalsReviewer,
      sandbox: modeSettings.sandbox,
      threadSource: "subagent" as CodexThreadSource,
      ...(sourceOverlay?.codexEnvironmentRuntime
        ? { codexEnvironmentRuntime: sourceOverlay.codexEnvironmentRuntime }
        : {}),
    }));
    this.bindTaskMonitorMcpThread(params.monitorId, thread.threadId, executionMode);
    this.host().reservedCodexStartThreadIds.add(thread.threadId);
    let ownsStartReservation = true;
    const releaseStartReservation = () => {
      if (!ownsStartReservation) return;
      ownsStartReservation = false;
      this.host().reservedCodexStartThreadIds.delete(thread.threadId);
    };
    let turn: { threadId: string; turnId: string };
    try {
      turn = await this.startCodexTaskMonitorTurn({
        causalContext: params.causalContext,
        threadId: thread.threadId,
        start: () => client.startTurn({
          threadId: thread.threadId,
          parentTurnId: params.context.turnId,
          ...(params.rootTurnId ? { rootTurnId: params.rootTurnId } : {}),
          input: [{ type: "text", text: params.prompt }],
          ...(cwd ? { cwd } : {}),
          approvalPolicy: modeSettings.approvalPolicy,
          model: params.preferredModel,
          reasoningEffort: params.preferredReasoningEffort,
          approvalsReviewer: modeSettings.approvalsReviewer,
          sandbox: modeSettings.sandbox,
          ...(sourceOverlay?.codexEnvironmentRuntime
            ? {
                codexEnvironmentRuntime:
                  sourceOverlay.codexEnvironmentRuntime,
              }
            : {}),
        }),
        afterStart: (startedTurn) => {
          this.host().activeTurnKeys.add(
            buildActiveTurnKey("codex", startedTurn.threadId, startedTurn.turnId),
          );
          this.host().activeCodexTurnModes.set(
            buildActiveTurnModeKey(startedTurn.threadId, startedTurn.turnId),
            executionMode,
          );
          releaseStartReservation();
          backendRegistryLog.info("managed task monitor turn started", {
            executionMode,
            hasCodexEnvironmentRuntime: Boolean(sourceOverlay?.codexEnvironmentRuntime),
            monitorId: params.monitorId,
            monitorThreadId: startedTurn.threadId,
            monitorTurnId: startedTurn.turnId,
            parentThreadId: params.context.threadId,
          });
        },
      });
    } finally {
      releaseStartReservation();
    }

    return {
      cwd,
      executionMode,
      threadId: turn.threadId,
      turnId: turn.turnId,
    };
  }

  private async injectTaskMonitorProgress(
    caller: TaskMonitorRequest["context"],
    args: InjectMonitorProgressToolArgs,
  ): Promise<TaskMonitorResponse<"inject_progress">> {
    const bound = this.bindTaskMonitorCaller(args.monitorId, caller);
    if (!bound.ok) {
      return taskMonitorFailure("inject_progress", bound.code, bound.message);
    }
    const message = args.message?.trim();
    if (!message) {
      return taskMonitorFailure("inject_progress", "invalid_arguments", "message is required.");
    }

    bound.record.lastActivityAt = Date.now();
    bound.record.recentProgress = [
      ...(bound.record.recentProgress ?? []),
      args.status ? `[${args.status}] ${message}` : message,
    ].slice(-TASK_MONITOR_RECOVERY_PROGRESS_LIMIT);
    const nextStatus = args.status ?? "running";
    if (nextStatus !== bound.record.persistedStatus) {
      await this.persistTaskMonitorSubAgent(bound.record, {
        lastMessage: message,
        status: nextStatus,
      });
    }
    await this.emitTaskMonitorProgressMessage({
      monitorId: bound.record.monitorId,
      parentBackend: bound.record.parentBackend,
      parentThreadId: bound.record.parentThreadId,
      text: formatTaskMonitorProgressMessage({
        message,
        status: args.status,
        task: bound.record.task,
      }),
      usage: bound.record.latestUsage,
    });

    return {
      ok: true,
      operation: "inject_progress",
      data: {
        monitorId: bound.record.monitorId,
        parentThreadId: bound.record.parentThreadId,
        injected: true,
        ...(bound.record.latestUsage
          ? { monitorUsage: bound.record.latestUsage }
          : {}),
      },
    };
  }

  private async completeTaskMonitoring(
    caller: TaskMonitorRequest["context"],
    args: CompleteMonitoringToolArgs,
  ): Promise<TaskMonitorResponse<"complete_monitoring">> {
    const bound = this.bindTaskMonitorCaller(args.monitorId, caller);
    if (!bound.ok) {
      return taskMonitorFailure("complete_monitoring", bound.code, bound.message);
    }
    if (bound.record.cancellation) {
      return taskMonitorFailure(
        "complete_monitoring",
        "forbidden",
        "The parent has requested cancellation; wait for the monitor turn to stop.",
      );
    }
    if (bound.record.finalizationStarted) {
      return taskMonitorFailure(
        "complete_monitoring",
        "forbidden",
        "Monitor completion is already in progress.",
      );
    }
    const summary = args.summary?.trim();
    if (!summary) {
      return taskMonitorFailure("complete_monitoring", "invalid_arguments", "summary is required.");
    }

    bound.record.lastActivityAt = Date.now();
    bound.record.finalizationStarted = true;
    let parentTurn:
      | {
          status: "started" | "queued";
          turnId?: string;
          queueEntryId?: string;
          position?: number;
        }
      | undefined;
    try {
      parentTurn = await this.finishTaskMonitorDelegation({
        completionSource: { type: "monitor_tool" },
        details: args.details,
        outcome: args.outcome,
        record: bound.record,
        summary,
        triggerParentTurn: args.triggerParentTurn !== false,
      });
    } catch (error) {
      bound.record.finalizationStarted = false;
      throw error;
    }

    return {
      ok: true,
      operation: "complete_monitoring",
      data: {
        monitorId: bound.record.monitorId,
        parentThreadId: bound.record.parentThreadId,
        injected: true,
        outcome: args.outcome,
        completionSource: { type: "monitor_tool" },
        ...(bound.record.latestUsage
          ? { monitorUsage: bound.record.latestUsage }
          : {}),
        ...(parentTurn ? { parentTurn } : {}),
      },
    };
  }

  private async finishTaskMonitorDelegation(params: {
    completionSource: TaskMonitorCompletionSource;
    details?: string;
    outcome: CompleteMonitoringToolArgs["outcome"];
    record: TaskMonitorDelegationRecord;
    summary: string;
    triggerParentTurn: boolean;
  }): Promise<
    | {
        status: "started" | "queued";
        turnId?: string;
        queueEntryId?: string;
        position?: number;
      }
    | undefined
  > {
    const finalText = formatTaskMonitorCompletionMessage({
      completionSource: params.completionSource,
      details: params.details,
      outcome: params.outcome,
      summary: params.summary,
      task: params.record.task,
    });
    await this.persistTaskMonitorSubAgent(params.record, {
      completedAt: Date.now(),
      completionSource: params.completionSource,
      lastMessage: params.summary,
      monitorUsage: params.record.latestUsage,
      outcome: params.outcome,
      status: params.outcome,
    });
    const canInjectCodexCompletion =
      params.record.parentBackend === "codex"
      && !params.triggerParentTurn
      && this.host().canStartThreadTurnImmediately({
        backend: "codex",
        threadId: params.record.parentThreadId,
      });
    if (params.record.parentBackend !== "codex" || canInjectCodexCompletion) {
      await this.injectTaskMonitorCompletionMessage({
        backend: params.record.parentBackend,
        monitorId: params.record.monitorId,
        parentThreadId: params.record.parentThreadId,
        text: finalText,
      });
    }
    if (params.record.latestUsage) {
      await this.emitTaskMonitorUsageActivity({
        monitorId: params.record.monitorId,
        parentBackend: params.record.parentBackend,
        parentThreadId: params.record.parentThreadId,
        phase: "completion",
        usage: params.record.latestUsage,
      });
    }
    await this.emitTaskMonitorCompletionState({
      completionSource: params.completionSource,
      monitorId: params.record.monitorId,
      outcome: params.outcome,
      parentBackend: params.record.parentBackend,
      parentThreadId: params.record.parentThreadId,
      parentTurnId: params.record.parentTurnId,
      task: params.record.task,
    });

    let parentTurn:
      | {
          status: "started" | "queued";
          turnId?: string;
          queueEntryId?: string;
          position?: number;
        }
      | undefined;
    if (params.triggerParentTurn) {
      const messageOrigin = buildTaskMonitorMessageOrigin({
        monitorId: params.record.monitorId,
        monitorThreadId: params.record.monitorThreadId,
        outcome: params.outcome,
        summary: params.summary,
        task: params.record.task,
      });
      Object.assign(messageOrigin, params.record.causalContext);
      const parentWake = {
        backend: params.record.parentBackend,
        threadId: params.record.parentThreadId,
        input: [
          {
            type: "text" as const,
            text: buildTaskMonitorFinalHandoffInput({
              completionSource: params.completionSource,
              details: params.details,
              finalHandoffPrompt: params.record.finalHandoffPrompt,
              outcome: params.outcome,
              summary: params.summary,
              task: params.record.task,
            }),
          },
        ],
        origin: "manual" as const,
        messageOrigin,
      };
      const parentLock = await this.host().readThreadLock(parentWake.backend, parentWake.threadId);
      // A paused project holds or discards the wake by its policy. A lock
      // already holds everything, so it wins.
      const pausedProject = parentLock ? undefined : this.host().resolvePausedThreadProject(parentWake);
      // A locked parent holds the result rather than refusing it: the monitor
      // finishes either way, and an unlock delivers what it found.
      const submitted = parentLock
        ? await this.host().submitHeldTurn({
            ...parentWake,
            queueEntryId: `task-monitor:${params.record.monitorId}`,
            holdReason: threadLockRefusalMessage(parentLock),
          })
        : pausedProject
          ? await this.host().deliverProjectPausedWakeup({
              ...parentWake,
              project: pausedProject,
              queueEntryId: `task-monitor:${params.record.monitorId}`,
              source: "monitor",
              summary: summarizeProjectHeldWakeup(`Monitor finished: "${params.record.task}"`),
            })
          : await this.host().submitTurn(parentWake);
      parentTurn =
        submitted.status === "discarded"
          ? undefined
          : submitted.status === "started"
            ? {
                status: "started",
                turnId: submitted.turnId,
                queueEntryId: submitted.entry.id,
              }
            : {
                status: "queued",
                queueEntryId: submitted.entry.id,
                position: submitted.position,
              };
    }

    this.taskMonitorDelegations.delete(params.record.monitorId);
    this.releaseTaskMonitorThread(params.record);
    if (
      params.completionSource.type === "monitor_tool"
      && params.record.monitorThreadId
    ) {
      this.completedTaskMonitorsByThread.set(
        taskMonitorThreadKey(
          params.record.backend,
          params.record.monitorThreadId,
        ),
        params.record,
      );
    }
    return parentTurn;
  }

  async handleTaskMonitorTerminalNotification(
    backend: AppServerBackendKind,
    notification: Extract<
      AppServerNotification,
      { method: "turn/completed" | "turn/failed" | "turn/cancelled" }
    >,
  ): Promise<void> {
    const threadId = notification.params.threadId;
    const turnId = turnIdFromTerminalNotification(notification);
    const terminalStatus =
      notification.method === "turn/completed"
        ? "completed"
        : notification.method === "turn/failed"
          ? "failed"
          : "cancelled";
    const completedMonitorKey = taskMonitorThreadKey(backend, threadId);
    const completedRecord = this.completedTaskMonitorsByThread.get(
      completedMonitorKey,
    );
    if (
      completedRecord
      && (
        !completedRecord.monitorTurnId
        || !turnId
        || completedRecord.monitorTurnId === turnId
      )
    ) {
      this.completedTaskMonitorsByThread.delete(completedMonitorKey);
      return;
    }
    const record = Array.from(this.taskMonitorDelegations.values()).find(
      (candidate) =>
        candidate.backend === backend &&
        candidate.monitorThreadId === threadId &&
        (!candidate.monitorTurnId || !turnId || candidate.monitorTurnId === turnId),
    );
    if (!record) {
      return;
    }

    if (record.cancellation) {
      if (!turnId || !record.monitorTurnId || turnId !== record.monitorTurnId) {
        return;
      }
      await this.finalizeTaskMonitorCancellation(record, terminalStatus);
      return;
    }

    const shuttingDown =
      this.host().stoppingRunningTurnsForShutdown || this.host().shutdownRequested || this.context.lifecycle.closed;
    const taskCount = this.claudeMonitorTaskCount(record);
    if (
      !record.recoveryAttempted
      && !shuttingDown
      && terminalStatus === "completed"
      && taskCount > 0
    ) {
      // Claude Code blocks a long foreground sleep, so a Claude monitor waits
      // in a background watcher and ends its turn. The watcher's output starts
      // its next turn; a recovery turn now would end monitoring early.
      record.awaitingClaudeTaskWake = true;
      record.lastActivityAt = Date.now();
      backendRegistryLog.info("Claude task monitor waiting on its background watcher", {
        monitorId: record.monitorId,
        monitorThreadId: record.monitorThreadId,
        monitorTurnId: record.monitorTurnId,
        parentThreadId: record.parentThreadId,
        taskCount,
      });
      return;
    }

    if (!record.recoveryAttempted) {
      if (shuttingDown) {
        // Quit ends the monitor process. A recovery turn has no owner to keep
        // running and can otherwise race the closing Claude session store.
        this.taskMonitorDelegations.delete(record.monitorId);
        this.releaseTaskMonitorThread(record);
        return;
      }
      await this.startTaskMonitorRecoveryTurn({
        record,
        terminalStatus,
      });
      return;
    }

    await this.synthesizeTaskMonitorFallbackCompletion({
      record,
      reason: "monitor_recovery_turn_ended_without_completion",
      terminalStatus,
    });
  }

  async checkStaleTaskMonitors(now = Date.now()): Promise<void> {
    for (const record of Array.from(this.taskMonitorDelegations.values())) {
      if (!record.monitorThreadId || !record.monitorTurnId) {
        continue;
      }
      if (record.cancellation) {
        continue;
      }
      if (record.activeCommandCount > 0 || (record.pendingMcpApprovalCount ?? 0) > 0) {
        continue;
      }
      // A Claude monitor's watcher is its running command.
      if (this.claudeMonitorTaskCount(record) > 0) {
        continue;
      }

      const staleAfterMs =
        Math.max(
          record.heartbeatIntervalSeconds * 2,
          record.pollIntervalSeconds * 2,
          record.startupTimeoutSeconds,
        ) *
          1000 +
        TASK_MONITOR_STALE_GRACE_MS;
      const idleMs = now - record.lastActivityAt;
      if (idleMs < staleAfterMs) {
        continue;
      }

      // The watcher ended and Claude never answered it, so no turn is left
      // to interrupt.
      if (record.awaitingClaudeTaskWake) {
        record.awaitingClaudeTaskWake = false;
        await this.startTaskMonitorRecoveryTurn({ record, terminalStatus: "completed" });
        continue;
      }

      if (record.recoveryAttempted) {
        await this.synthesizeTaskMonitorFallbackCompletion({
          record,
          reason: "monitor_recovery_turn_stale_without_completion",
        });
        continue;
      }

      if (record.staleInterruptAttempted) {
        await this.synthesizeTaskMonitorFallbackCompletion({
          record,
          reason: "monitor_stale_interrupt_no_terminal",
        });
        continue;
      }

      await this.interruptStaleTaskMonitor(record, idleMs);
    }
  }

  private async interruptStaleTaskMonitor(
    record: TaskMonitorDelegationRecord,
    idleMs: number,
  ): Promise<void> {
    if (!record.monitorThreadId || !record.monitorTurnId) {
      await this.synthesizeTaskMonitorFallbackCompletion({
        record,
        reason: "monitor_thread_missing_for_stale_recovery",
      });
      return;
    }

    record.lastActivityAt = Date.now();
    record.staleInterruptAttempted = true;
    backendRegistryLog.warn("task monitor stale; interrupting for recovery", {
      idleMs,
      monitorId: record.monitorId,
      monitorThreadId: record.monitorThreadId,
      monitorTurnId: record.monitorTurnId,
      parentThreadId: record.parentThreadId,
    });

    try {
      await this.interruptManagedTaskMonitor(record);
    } catch (error) {
      backendRegistryLog.error("failed to interrupt stale task monitor", {
        error: error instanceof Error ? error.message : String(error),
        monitorId: record.monitorId,
        monitorThreadId: record.monitorThreadId,
        monitorTurnId: record.monitorTurnId,
        parentThreadId: record.parentThreadId,
      });
      await this.synthesizeTaskMonitorFallbackCompletion({
        record,
        reason: "monitor_stale_interrupt_failed",
      });
    }
  }

  /** Background tasks a Claude monitor's session runs, such as its watcher or a sub-agent. */
  private claudeMonitorTaskCount(record: TaskMonitorDelegationRecord): number {
    if (record.backend !== "claude" || !record.monitorThreadId) return 0;
    return this.context.providers.claude.activeTaskCount(record.monitorThreadId);
  }

  /**
   * A Claude monitor thread lives in memory until its delegation ends; its
   * process exits after each turn, and a recovery turn reuses the thread.
   */
  private releaseTaskMonitorThread(record: TaskMonitorDelegationRecord): void {
    if (record.backend === "claude" && record.monitorThreadId) {
      this.context.providers.claude.releaseEphemeralThread(record.monitorThreadId);
    }
  }

  /**
   * A Claude monitor's process exits after each settled turn, and an
   * ephemeral session cannot be resumed, so its recovery turn starts with no
   * memory. Its transcript is still held in memory until the delegation ends.
   */
  private async claudeTaskMonitorMemory(
    record: TaskMonitorDelegationRecord,
  ): Promise<{ brief?: string; recentActivity: string[]; recentProgress: string[] }> {
    let recentActivity: string[] = [];
    try {
      if (record.monitorThreadId) {
        recentActivity = taskMonitorRecentActivity(
          (await this.context.providers.claude.readThread(record.monitorThreadId)).entries,
        );
      }
    } catch (error) {
      backendRegistryLog.warn("could not read Claude task monitor transcript for recovery", {
        error: error instanceof Error ? error.message : String(error),
        monitorId: record.monitorId,
        monitorThreadId: record.monitorThreadId,
      });
    }
    return {
      ...(record.brief ? { brief: record.brief } : {}),
      recentActivity,
      recentProgress: record.recentProgress ?? [],
    };
  }

  private async startTaskMonitorRecoveryTurn(params: {
    record: TaskMonitorDelegationRecord;
    terminalStatus: "completed" | "failed" | "cancelled";
  }): Promise<void> {
    const { record } = params;
    if (!record.monitorThreadId) {
      await this.synthesizeTaskMonitorFallbackCompletion({
        record,
        reason: "monitor_thread_missing_for_recovery",
        terminalStatus: params.terminalStatus,
      });
      return;
    }

    record.recoveryAttempted = true;
    record.activeCommandCount = 0;
    record.lastActivityAt = Date.now();
    record.staleInterruptAttempted = false;
    const executionMode = record.executionMode ?? "default";
    const modeSettings = executionModeSettings(executionMode);
    const overlay = await this.context.stores.threads.getThreadOverlayState({
      backend: record.parentBackend,
      threadId: record.parentThreadId,
    });

    try {
      if (record.backend === "claude") {
        const turn = await this.host().startTurnWithoutHandoff({
          backend: "claude",
          threadId: record.monitorThreadId,
          input: [{
            type: "text",
            text: buildTaskMonitorRecoveryPrompt({
              monitorId: record.monitorId,
              task: record.task,
              terminalStatus: params.terminalStatus,
              memory: await this.claudeTaskMonitorMemory(record),
            }),
          }],
          executionMode,
          model: record.runtimeModel ?? record.preferredModel,
          ...(record.preferredReasoningEffort === "provider-default"
            ? {}
            : { reasoningEffort: record.preferredReasoningEffort }),
          messageOrigin: buildTaskMonitorPromptOrigin(record.causalContext),
        });
        record.monitorTurnId = turn.turnId;
        record.lastActivityAt = Date.now();
        backendRegistryLog.warn("started Claude task monitor recovery turn", {
          monitorId: record.monitorId,
          monitorThreadId: record.monitorThreadId,
          monitorTurnId: record.monitorTurnId,
          parentThreadId: record.parentThreadId,
          terminalStatus: params.terminalStatus,
        });
        return;
      }
      if (isAcpBackendId(record.backend)) {
        const startingOrigin = this.host().beginStartingTurnOrigin({ backend: record.backend,
          threadId: record.monitorThreadId, origin: buildTaskMonitorPromptOrigin(record.causalContext) });
        let turn: { threadId: string; turnId: string };
        try {
          turn = await this.host().startAcpTurn({
            backend: record.backend,
            threadId: record.monitorThreadId,
            input: [
              {
                type: "text",
                text: buildTaskMonitorRecoveryPrompt({
                  monitorId: record.monitorId,
                  task: record.task,
                  terminalStatus: params.terminalStatus,
                }),
              },
            ],
            model: record.runtimeModel,
            reasoningEffort:
              record.preferredReasoningEffort === "provider-default"
                ? undefined
                : record.preferredReasoningEffort,
          });
          this.host().bindStartingTurnOrigin(startingOrigin, turn);
          record.monitorTurnId = turn.turnId;
          record.lastActivityAt = Date.now();
          await this.host().persistStartingTurnOrigin(startingOrigin);
        } finally {
          this.host().dropStartingTurnOrigin(startingOrigin);
        }
        backendRegistryLog.warn("started ACP task monitor recovery turn", {
          backend: record.backend,
          monitorId: record.monitorId,
          monitorThreadId: record.monitorThreadId,
          monitorTurnId: record.monitorTurnId,
          parentThreadId: record.parentThreadId,
          terminalStatus: params.terminalStatus,
        });
        return;
      }

      const client = this.host().getClient("codex", executionMode);
      // Like the monitor's first turn, a recovery turn delegated from a
      // messaging turn carries that turn's origin, so its tool calls stay
      // gated by the messaging user's role.
      const monitorThreadId = record.monitorThreadId;
      await this.startCodexTaskMonitorTurn({
        causalContext: record.causalContext,
        threadId: monitorThreadId,
        start: () => client.startTurn({
          threadId: monitorThreadId,
          parentTurnId: record.parentTurnId,
          ...(record.rootTurnId ? { rootTurnId: record.rootTurnId } : {}),
          input: [
            {
              type: "text",
              text: buildTaskMonitorRecoveryPrompt({
                monitorId: record.monitorId,
                task: record.task,
                terminalStatus: params.terminalStatus,
              }),
            },
          ],
          ...(record.cwd ? { cwd: record.cwd } : {}),
          approvalPolicy: modeSettings.approvalPolicy,
          model: record.preferredModel,
          reasoningEffort: record.preferredReasoningEffort,
          approvalsReviewer: modeSettings.approvalsReviewer,
          sandbox: modeSettings.sandbox,
          ...(overlay?.codexEnvironmentRuntime
            ? { codexEnvironmentRuntime: overlay.codexEnvironmentRuntime }
            : {}),
        }),
        afterStart: (turn) => {
          record.monitorTurnId = turn.turnId;
          record.lastActivityAt = Date.now();
        },
      });
      backendRegistryLog.warn("started task monitor recovery turn", {
        monitorId: record.monitorId,
        monitorThreadId: record.monitorThreadId,
        monitorTurnId: record.monitorTurnId,
        parentThreadId: record.parentThreadId,
        terminalStatus: params.terminalStatus,
      });
    } catch (error) {
      backendRegistryLog.error("failed to start task monitor recovery turn", {
        error: error instanceof Error ? error.message : String(error),
        monitorId: record.monitorId,
        monitorThreadId: record.monitorThreadId,
        parentThreadId: record.parentThreadId,
      });
      await this.synthesizeTaskMonitorFallbackCompletion({
        record,
        reason: "monitor_recovery_turn_start_failed",
        terminalStatus: params.terminalStatus,
      });
    }
  }

  private async interruptManagedTaskMonitor(
    record: TaskMonitorDelegationRecord,
  ): Promise<void> {
    if (!record.monitorThreadId || !record.monitorTurnId) {
      throw new Error("Task monitor does not expose an active turn.");
    }
    if (isAcpBackendId(record.backend) || record.backend === "claude") {
      await this.host().interruptTurn({
        backend: record.backend,
        threadId: record.monitorThreadId,
        turnId: record.monitorTurnId,
      });
      return;
    }
    const executionMode = record.executionMode ?? "default";
    await this.host().getClient("codex", executionMode).interruptTurn({
      threadId: record.monitorThreadId,
      turnId: record.monitorTurnId,
    });
  }

  private async synthesizeTaskMonitorFallbackCompletion(params: {
    record: TaskMonitorDelegationRecord;
    reason: string;
    terminalStatus?: "completed" | "failed" | "cancelled";
  }): Promise<void> {
    if (params.record.cancellation || params.record.finalizationStarted) {
      return;
    }
    params.record.finalizationStarted = true;
    const completionSource: TaskMonitorCompletionSource = {
      type: "pwragent_fallback",
      reason: params.reason,
      recoveryAttempted: Boolean(params.record.recoveryAttempted),
      ...(params.terminalStatus ? { terminalStatus: params.terminalStatus } : {}),
    };
    const outcome =
      params.terminalStatus === "cancelled" ? "cancelled" : "failure";
    try {
      await this.finishTaskMonitorDelegation({
        completionSource,
        details: [
          "PwrAgent generated this fallback because the monitor subagent stopped without invoking pwragent.complete_monitoring.",
          `Fallback reason: ${params.reason}.`,
          params.terminalStatus
            ? `Last monitor turn status: ${params.terminalStatus}.`
            : "No terminal monitor turn status was observed.",
        ].join("\n"),
        outcome,
        record: params.record,
        summary:
          "Monitor subagent stopped without reporting a final result through the required completion tool.",
        triggerParentTurn: true,
      });
    } catch (error) {
      params.record.finalizationStarted = false;
      throw error;
    }
  }

  private bindTaskMonitorCaller(
    monitorId: string,
    caller: TaskMonitorRequest["context"],
  ):
    | { ok: true; record: TaskMonitorDelegationRecord }
    | { ok: false; code: "forbidden" | "invalid_arguments" | "not_found"; message: string } {
    const normalizedMonitorId = monitorId?.trim();
    if (!normalizedMonitorId) {
      return { ok: false, code: "invalid_arguments", message: "monitorId is required." };
    }
    const record = this.taskMonitorDelegations.get(normalizedMonitorId);
    if (!record) {
      return { ok: false, code: "not_found", message: "Unknown or completed monitorId." };
    }
    if (record.backend !== caller.backend) {
      return {
        ok: false,
        code: "forbidden",
        message: "This monitorId belongs to another provider runtime.",
      };
    }
    if (record.monitorThreadId && record.monitorThreadId !== caller.threadId) {
      return {
        ok: false,
        code: "forbidden",
        message: "This monitorId is already bound to another monitor thread.",
      };
    }
    if (!record.monitorThreadId) {
      record.monitorThreadId = caller.threadId;
    }
    return { ok: true, record };
  }

  private async emitTaskMonitorProgressMessage(params: {
    monitorId: string;
    parentBackend: AppServerBackendKind;
    parentThreadId: string;
    text: string;
    usage?: TaskMonitorUsageSnapshot;
  }): Promise<void> {
    const now = Date.now();
    await this.context.emit({
      backend: params.parentBackend,
      notification: {
        method: "item/completed",
        params: {
          threadId: params.parentThreadId,
          turnId: `monitor:${params.monitorId}`,
          item: {
            id: `${params.monitorId}:progress:${now}`,
            type: "agentMessage",
            text: params.text,
            data: {
              source: "pwragent_task_monitor",
              monitorId: params.monitorId,
              ...(params.usage
                ? {
                    monitorUsage: {
                      ...params.usage,
                      phase: "progress",
                    },
                  }
                : {}),
              transient: true,
            },
          },
        },
      },
    });
  }

  private async emitTaskMonitorUsageActivity(params: {
    monitorId: string;
    parentBackend: AppServerBackendKind;
    parentThreadId: string;
    phase: "completion" | "progress";
    usage: TaskMonitorUsageSnapshot;
  }): Promise<void> {
    const now = Date.now();
    await this.context.emit({
      backend: params.parentBackend,
      notification: {
        method: "item/completed",
        params: {
          threadId: params.parentThreadId,
          turnId: `monitor:${params.monitorId}`,
          item: {
            id: `${params.monitorId}:usage:${params.phase}:${now}`,
            type: "taskMonitorUsage",
            data: {
              source: "pwragent_task_monitor",
              monitorId: params.monitorId,
              monitorUsage: {
                ...params.usage,
                phase: params.phase,
              },
              transient: params.phase !== "completion",
            },
          },
        },
      },
    });
  }

  private async emitTaskMonitorCompletionState(params: {
    completionSource: TaskMonitorCompletionSource;
    monitorId: string;
    outcome: CompleteMonitoringToolArgs["outcome"];
    parentBackend: AppServerBackendKind;
    parentThreadId: string;
    parentTurnId: string;
    task: string;
  }): Promise<void> {
    const now = Date.now();
    await this.context.emit({
      backend: params.parentBackend,
      notification: {
        method: "item/completed",
        params: {
          threadId: params.parentThreadId,
          turnId: `monitor:${params.monitorId}`,
          item: {
            id: `${params.monitorId}:completion:${now}`,
            type: "taskMonitorCompletion",
            data: {
              source: "pwragent_task_monitor",
              monitorId: params.monitorId,
              parentTurnId: params.parentTurnId,
              task: params.task,
              outcome: params.outcome,
              completionSource: params.completionSource,
              fallbackGenerated:
                params.completionSource.type === "pwragent_fallback",
              transient: false,
            },
          },
        },
      },
    });
  }

  async injectTaskMonitorCompletionMessage(params: {
    backend: AppServerBackendKind;
    monitorId: string;
    parentThreadId: string;
    text: string;
  }): Promise<void> {
    const receivedAt = Date.now();
    const messageId = `${params.monitorId}:message:${receivedAt}`;
    if (isAcpBackendId(params.backend)) {
      const persisted = this.context.providers.acp.persistSyntheticAssistantMessage({
        backend: params.backend,
        messageId,
        receivedAt,
        sessionId: params.parentThreadId,
        source: "pwragent_task_monitor",
        text: params.text,
      });
      if (!persisted) {
        backendRegistryLog.warn(
          "ACP task monitor completion could not be persisted",
          {
            backend: params.backend,
            monitorId: params.monitorId,
            threadId: params.parentThreadId,
          },
        );
      }
    }
    if (params.backend !== "codex") {
      await this.context.emit({
        backend: params.backend,
        notification: {
          method: "item/completed",
          params: {
            threadId: params.parentThreadId,
            turnId: `monitor:${params.monitorId}`,
            item: {
              id: messageId,
              type: "agentMessage",
              text: params.text,
              data: {
                source: "pwragent_task_monitor",
                monitorId: params.monitorId,
                transient: false,
              },
            },
          },
        },
      });
      return;
    }
    await this.host().withCodexThreadClient(params.parentThreadId, async (client) => {
      if (!client.injectThreadItems) {
        throw new Error("Codex thread item injection is not available.");
      }
      await client.injectThreadItems({
        threadId: params.parentThreadId,
        items: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: params.text }],
          },
        ],
      });
    });
  }
}
