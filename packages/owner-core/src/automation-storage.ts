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
  AutomationRunArtifact,
  AutomationRunOutputDecision,
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
  status?: AutomationStatus;
  nextRunAt?: number | null;
  now?: number;
};

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
  now?: number;
};

export type StartupReconciliationInput = {
  now?: number;
  nextRunAtByAutomationId?: Record<string, number | undefined>;
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
  createRun(input: CreateAutomationRunInput): AutomationRunSummary | undefined;
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
    coalescedCount?: number;
    now?: number;
  }): AutomationRunSummary | undefined;
  coalesceRateLimitedRun(params: {
    runId: string;
    coalescedCount: number;
    errorMessage: string;
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
  reconcileStartup(input?: StartupReconciliationInput): void;
  buildThreadSummaries(): Record<string, AutomationThreadSummary>;
  setRunUsage(params: {
    runId: string;
    usage: AutomationRunUsage;
    now?: number;
  }): AutomationRunSummary | undefined;
}
