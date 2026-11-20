import type {
  AppServerBackendKind,
  AutomationBacklogPolicy,
  AutomationExecutionProfile,
  AutomationPriorRunLookback,
  AutomationRunUsage,
  AutomationGateConfig,
  AutomationLoadIssue,
  AutomationOutputActionDefinition,
  AutomationOutputActionResult,
  AutomationPauseReason,
  AutomationRunArtifact,
  AutomationRunFailureReason,
  AutomationRunOutputDecision,
  AutomationRunOwner,
  AutomationRunSkipReason,
  AutomationRunSourceMetadata,
  AutomationRunStatus,
  AutomationRunSummary,
  AutomationRunTranscriptEvent,
  AutomationRunTrigger,
  AutomationRunWindow,
  AutomationScheduleDefinition,
  AutomationStatus,
  AutomationTriggerDefinition,
  AutomationThreadSummary,
  ThreadIdentifier,
} from "@pwragent/shared";

export type AutomationRecord = {
  id: string;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  name: string;
  taskPrompt: string;
  gate?: AutomationGateConfig;
  status: AutomationStatus;
  triggers: AutomationTriggerDefinition[];
  schedule?: AutomationScheduleDefinition;
  scheduleSummary: string;
  backlogPolicy: AutomationBacklogPolicy;
  executionProfile?: AutomationExecutionProfile;
  priorRunLookback?: AutomationPriorRunLookback;
  outputActions: AutomationOutputActionDefinition[];
  inboundCoalesceWindowMs?: number;
  maxRunsPerHour?: number | null;
  runTimeoutMs?: number;
  dailyRunLimit?: number;
  /** Set while PwrAgent holds the automation paused; cleared by any status change. */
  pausedReason?: AutomationPauseReason;
  /** When PwrAgent paused it; names the pause's skipped-trigger marker. */
  pausedAt?: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastRunStatus?: AutomationRunStatus;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
};

export type CreateAutomationInput = {
  id?: string;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  name: string;
  taskPrompt: string;
  gate?: AutomationGateConfig;
  triggers?: AutomationTriggerDefinition[];
  schedule?: AutomationScheduleDefinition;
  backlogPolicy?: AutomationBacklogPolicy;
  executionProfile?: AutomationExecutionProfile;
  priorRunLookback?: AutomationPriorRunLookback;
  outputActions?: AutomationOutputActionDefinition[];
  inboundCoalesceWindowMs?: number;
  maxRunsPerHour?: number | null;
  runTimeoutMs?: number | null;
  dailyRunLimit?: number | null;
  status?: AutomationStatus;
  nextRunAt?: number;
  now?: number;
};

export type UpdateAutomationInput = {
  backend?: AppServerBackendKind;
  threadId?: ThreadIdentifier;
  name?: string;
  taskPrompt?: string;
  gate?: AutomationGateConfig | null;
  triggers?: AutomationTriggerDefinition[];
  schedule?: AutomationScheduleDefinition;
  backlogPolicy?: AutomationBacklogPolicy;
  executionProfile?: AutomationExecutionProfile | null;
  priorRunLookback?: AutomationPriorRunLookback | null;
  outputActions?: AutomationOutputActionDefinition[];
  inboundCoalesceWindowMs?: number;
  maxRunsPerHour?: number | null;
  /** Null clears the timeout. */
  runTimeoutMs?: number | null;
  /** Null clears the limit. */
  dailyRunLimit?: number | null;
  status?: AutomationStatus;
  nextRunAt?: number | null;
  now?: number;
};

/**
 * The answer to asking for a new run. `refused`: the automation has a daily
 * run limit and had already started that many runs in the rolling 24 hours,
 * so no run was created.
 */
export type AutomationRunAdmission =
  | { status: "admitted"; run: AutomationRunSummary }
  | { status: "refused"; reason: "daily_limit"; runsInWindow: number; limit: number };

export type CreateAutomationRunInput = {
  id?: string;
  automationId: string;
  trigger: AutomationRunTrigger;
  status?: AutomationRunStatus;
  scheduledFor?: number;
  scheduledWindows?: AutomationRunWindow[];
  source?: AutomationRunSourceMetadata;
  queuedAt?: number;
  queueEntryId?: string;
  /** The dispatch path persists running before beginning execution. */
  recoverOnRestart?: boolean;
  /**
   * With a terminal `status`, the run is recorded finished in one insert. A
   * skipped marker never passes through `pending`, so it cannot collide with
   * the one pending scheduled run an automation may hold.
   */
  completedAt?: number;
  errorMessage?: string;
  skipReason?: AutomationRunSkipReason;
  /** With a terminal `status`: how many triggers a skipped marker stands for. */
  coalescedCount?: number;
  now?: number;
};

export type StartupReconciliationInput = {
  now?: number;
  resumeUnstartedRuns?: boolean;
  /**
   * Next run for each enabled schedule, computed from now. Written only where
   * the stored time is missing, already due, or later than this value, so a
   * launch with nothing missed writes nothing and a second instance cannot
   * move a live instance's schedule.
   */
  nextRunAtByAutomationId?: Record<string, number | undefined>;
  /**
   * Whether the process that created a run is still running. Runs of a live
   * owner are left alone. Absent, every recorded owner counts as dead. A run
   * with no recorded owner is always dead.
   */
  isOwnerAlive?: (owner: AutomationRunOwner) => boolean;
};

export type StartupReconciliationResult = {
  /** Runs adopted and queued by this call. */
  resumedRuns: AutomationRunSummary[];
  /** Runs this call moved from pending, queued or running to interrupted. */
  interruptedRuns: AutomationRunSummary[];
  /** Unfinished runs left alone because their owner is alive. */
  liveOwnerRunCount: number;
  /** Schedules whose stored next run was missing, due or too late. */
  rescheduledAutomationCount: number;
};

export type UpsertAutomationRunArtifactInput = {
  runId: string;
  status: AutomationRunStatus;
  finalText?: string;
  errorMessage?: string;
  outputDecision?: AutomationRunOutputDecision;
  actionResults?: AutomationOutputActionResult[];
  transcriptEvents?: AutomationRunTranscriptEvent[];
  now?: number;
};

/** Automation persistence at the owner/application boundary; contains no database handles. */
export interface AutomationStorage {
  getAutomationLoadIssues(): AutomationLoadIssue[];
  createAutomation(input: CreateAutomationInput): AutomationRecord;
  updateAutomation(id: string, input: UpdateAutomationInput): AutomationRecord | undefined;
  pauseAutomation(id: string, now?: number): AutomationRecord | undefined;
  resumeAutomation(id: string, params?: {
    nextRunAt?: number;
    now?: number;
  }): AutomationRecord | undefined;
  deleteAutomation(id: string, now?: number): AutomationRecord | undefined;
  cancelPendingRunsForAutomation(params: {
    automationId: string;
    now: number;
    errorMessage: string;
  }): void;
  getAutomation(id: string, options?: {
    includeDeleted?: boolean;
  }): AutomationRecord | undefined;
  listAutomations(options?: {
    includeDeleted?: boolean;
  }): AutomationRecord[];
  listEnabledInboundAutomations(): AutomationRecord[];
  listAutomationsForThread(params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
    includeDeleted?: boolean;
  }): AutomationRecord[];
  listEnabledDueAutomations(now: number): AutomationRecord[];
  /** Paused automations PwrAgent paused at their daily run limit. */
  listDailyLimitPausedAutomations(): AutomationRecord[];
  /**
   * Pause an enabled automation at its daily run limit, keeping its schedule
   * so later triggers can be recorded as skipped. `paused` is false when it
   * was not enabled, so only one caller raises the pause's card.
   */
  pauseAutomationForDailyLimit(id: string, now: number): {
    automation: AutomationRecord;
    paused: boolean;
  } | undefined;
  createRun(input: CreateAutomationRunInput): AutomationRunSummary | undefined;
  commitScheduledEvaluation<T>(
    params: { automationId: string; dueAt?: number; nextRunAt: number | null; now: number },
    recordWindow: () => T,
  ): T | undefined;
  /**
   * Create a run only if the automation's daily run limit allows it. The
   * count and the insert share one write transaction, so two instances on a
   * profile cannot both take the last slot. Undefined: no such automation.
   */
  admitRun(input: CreateAutomationRunInput): AutomationRunAdmission | undefined;
  /** Runs created at or after `sinceMs` that started or will start a turn. */
  countRunsSince(params: { automationId: string; sinceMs: number }): number;
  coalescePendingScheduledRun(params: {
    automationId: string;
    scheduledWindows: AutomationRunWindow[];
    now?: number;
  }): AutomationRunSummary | undefined;
  findPendingScheduledRun(automationId: string): AutomationRunSummary | undefined;
  listPendingOrQueuedRunsForAutomation(automationId: string): AutomationRunSummary[];
  findActiveRunForAutomation(automationId: string): AutomationRunSummary | undefined;
  findRunBySourceEventKey(params: {
    automationId: string;
    sourceEventKey: string;
  }): AutomationRunSummary | undefined;
  countRecentInboundRuns(params: {
    automationId: string;
    sinceMs: number;
  }): number;
  findPendingRunForAutomation(automationId: string): AutomationRunSummary | undefined;
  claimRunForDispatch(runId: string, now: number): AutomationRunSummary | undefined;
  markRunQueued(params: {
    runId: string;
    queueEntryId: string;
    queuedAt?: number;
    now?: number;
  }): AutomationRunSummary | undefined;
  markRunStarted(params: {
    runId: string;
    backendThreadId?: string;
    backendTurnId: string;
    queueEntryId?: string;
    startedAt?: number;
    now?: number;
  }): AutomationRunSummary | undefined;
  markRunTerminal(params: {
    runId: string;
    status: Extract<AutomationRunStatus, "completed" | "failed" | "cancelled" | "skipped">;
    completedAt?: number;
    errorMessage?: string;
    skipReason?: AutomationRunSkipReason;
    failureReason?: AutomationRunFailureReason;
    coalescedCount?: number;
    now?: number;
  }): AutomationRunSummary | undefined;
  coalesceRateLimitedRun(params: {
    runId: string;
    coalescedCount: number;
    errorMessage: string;
    /** The marker's skip reason. Defaults to `rate_limited`. */
    skipReason?: AutomationRunSkipReason;
    now: number;
  }): AutomationRunSummary | undefined;
  getRun(runId: string): AutomationRunSummary | undefined;
  getLatestRunForAutomation(automationId: string): AutomationRunSummary | undefined;
  findRunningRunByBackendTurnId(params: {
    backend: AppServerBackendKind;
    backendTurnId: string;
  }): AutomationRunSummary | undefined;
  findRunByBackendTurnId(params: {
    backend: AppServerBackendKind;
    backendTurnId: string;
  }): AutomationRunSummary | undefined;
  findRunsByBackendTurnIds(params: {
    backend: AppServerBackendKind;
    backendTurnIds: readonly string[];
  }): Map<string, AutomationRunSummary>;
  upsertRunArtifact(input: UpsertAutomationRunArtifactInput): AutomationRunArtifact | undefined;
  appendRunTranscriptEvent(params: {
    runId: string;
    event: AutomationRunTranscriptEvent;
    now?: number;
  }): AutomationRunArtifact | undefined;
  appendRunTranscriptEvents(params: {
    runId: string;
    events: AutomationRunTranscriptEvent[];
    now?: number;
  }): AutomationRunArtifact | undefined;
  getRunArtifact(runId: string): AutomationRunArtifact | undefined;
  listRunsForAutomation(automationId: string, limit?: number): AutomationRunSummary[];
  listRunsForThread(params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
    limit?: number;
  }): AutomationRunSummary[];
  reconcileStartup(input?: StartupReconciliationInput): StartupReconciliationResult;
  /**
   * Interrupted runs whose report never finished: no artifact records the
   * failed outcome. A launch that stopped between interrupting a run and
   * reporting it leaves these for the next one.
   */
  listUnreportedInterruptedRuns(): AutomationRunSummary[];
  buildThreadSummaries(): Record<string, AutomationThreadSummary>;
  setRunUsage(params: {
    runId: string;
    usage: AutomationRunUsage;
    now?: number;
  }): AutomationRunSummary | undefined;
}
