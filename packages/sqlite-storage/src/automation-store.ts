import { randomUUID } from "node:crypto";
import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "@pwragent/shared/contracts/normalized-app-server";
import type {
  AutomationBacklogPolicy,
  AutomationExecutionProfile,
  AutomationPriorRunLookback,
  AutomationRunUsage,
  AutomationGateConfig,
  AutomationInboundMessageTriggerDefinition,
  AutomationListItemSummary,
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
} from "@pwragent/shared/contracts/automations";
import {
  AUTOMATION_SCHEDULE_KINDS,
  DEFAULT_AUTOMATION_BACKLOG_POLICY,
  DEFAULT_AUTOMATION_INBOUND_COALESCE_WINDOW_MS,
  formatAutomationConversationList,
  formatAutomationScheduleSummary,
  isSupportedAutomationInboundConditionGroup,
  AUTOMATION_DAILY_RUN_LIMIT_WINDOW_MS,
  normalizeAutomationPriorRunLookback,
  resolveAutomationDailyRunLimit,
  resolveAutomationRunTimeoutMs,
  resolveAutomationRunsPerHour,
} from "@pwragent/shared/contracts/automations";
import {
  buildLegacyEncodedThreadIdentityKey,
  buildThreadIdentityKey,
} from "@pwragent/shared/contracts/navigation";
import type { StateDb } from "./state-db.js";
import { mergeTranscriptEvents } from "@pwragent/owner-core/automation-transcript-merge";
import type { AutomationRunAdmission, AutomationStorage, AutomationRecord, CreateAutomationInput, UpdateAutomationInput, CreateAutomationRunInput, StartupReconciliationInput, StartupReconciliationResult, UpsertAutomationRunArtifactInput } from "@pwragent/owner-core/automation-storage";
export type { AutomationRunAdmission, AutomationRecord, CreateAutomationInput, UpdateAutomationInput, CreateAutomationRunInput, StartupReconciliationInput, StartupReconciliationResult, UpsertAutomationRunArtifactInput } from "@pwragent/owner-core/automation-storage";

const DEFAULT_RUN_HISTORY_LIMIT = 200;

const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled", "skipped"] as const;
const RUN_STATUS_TRANSITIONS: Record<AutomationRunStatus, readonly AutomationRunStatus[]> = {
  pending: ["queued", "running", ...TERMINAL_RUN_STATUSES],
  queued: ["running", ...TERMINAL_RUN_STATUSES],
  running: TERMINAL_RUN_STATUSES,
  completed: [],
  failed: [],
  cancelled: [],
  skipped: [],
};

/** Shown in run history and on the Agent thread for a run a restart ended. */
export const AUTOMATION_RUN_INTERRUPTED_MESSAGE =
  "PwrAgent stopped before this automation run finished. The run was not resumed.";

export type AutomationStoreOptions = {
  runHistoryLimit?: number;
  /** Recorded on each run this store creates, for startup reconciliation. */
  runOwner?: AutomationRunOwner;
  warn?: (message: string, details: Record<string, unknown>) => void;
};

const UNDERSTOOD_SCHEDULE_KINDS = new Set<string>(AUTOMATION_SCHEDULE_KINDS);

/**
 * True only when `schedule` is a shape this build can actually run. Anything
 * else — missing schedule (e.g. a trigger-only automation written by a newer
 * build), a non-object, or an unrecognized `kind` — is something we must skip
 * rather than dereference. Never throws; safe to call on untrusted JSON.
 */
function isUnderstoodSchedule(
  schedule: unknown,
): schedule is AutomationScheduleDefinition {
  if (!schedule || typeof schedule !== "object") return false;
  const kind = (schedule as { kind?: unknown }).kind;
  return typeof kind === "string" && UNDERSTOOD_SCHEDULE_KINDS.has(kind);
}

type AutomationRow = {
  automation_id: string;
  backend: AppServerBackendKind;
  thread_id: string;
  name: string;
  status: AutomationStatus;
  backlog_policy: AutomationBacklogPolicy;
  next_run_at: number | null;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  cost_since: number | null;
  total_cost_micros: number | null;
  payload: string;
};

type AutomationRunRow = {
  run_id: string;
  automation_id: string;
  backend: AppServerBackendKind;
  thread_id: string;
  status: AutomationRunStatus;
  trigger: AutomationRunTrigger;
  scheduled_for: number | null;
  queued_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  backend_turn_id: string | null;
  queue_entry_id: string | null;
  created_at: number;
  updated_at: number;
  accounted_cost_micros: number | null;
  payload: string;
};

type PrunedRunCostRow = {
  run_id: string;
  automation_id: string;
  backend_turn_id: string;
  total_cost_micros: number | null;
};

type AutomationRunArtifactRow = {
  run_id: string;
  automation_id: string;
  backend: AppServerBackendKind;
  thread_id: string;
  status: AutomationRunStatus;
  created_at: number;
  updated_at: number;
  payload: string;
};

type AutomationPayload = {
  taskPrompt: string;
  gate?: AutomationGateConfig;
  triggers?: AutomationTriggerDefinition[];
  schedule?: AutomationScheduleDefinition;
  scheduleSummary: string;
  executionProfile?: AutomationExecutionProfile;
  priorRunLookback?: AutomationPriorRunLookback;
  outputActions?: AutomationOutputActionDefinition[];
  inboundCoalesceWindowMs?: number;
  maxRunsPerHour?: number | null;
  // Additive: a build that predates these ignores them on read, so it runs the
  // automation with no timeout and no daily limit, and reads a limit pause as
  // an ordinary pause. Its own rewrite of the automation drops them.
  runTimeoutMs?: number;
  dailyRunLimit?: number;
  pausedReason?: AutomationPauseReason;
  pausedAt?: number;
  lastRunStatus?: AutomationRunStatus;
};

type AutomationRunPayload = {
  scheduledWindows: AutomationRunWindow[];
  backendThreadId?: string;
  errorMessage?: string;
  skipReason?: AutomationRunSkipReason;
  // Additive: a build that predates these ignores them on read. Its own
  // rewrite of a run drops them, which reads as a run with no owner.
  failureReason?: AutomationRunFailureReason;
  owner?: AutomationRunOwner;
  recoverOnRestart?: boolean;
  resumedAt?: number;
  coalescedCount?: number;
  source?: AutomationRunSourceMetadata;
  usage?: AutomationRunUsage;
};

type StoredAutomationRun = AutomationRunSummary & { recoverOnRestart?: boolean };

type AutomationRunArtifactPayload = {
  finalText?: string;
  errorMessage?: string;
  outputDecision?: AutomationRunOutputDecision;
  actionResults?: AutomationOutputActionResult[];
  transcriptEvents: AutomationRunTranscriptEvent[];
};

export class AutomationStore implements AutomationStorage {
  /**
   * Automations that couldn't be loaded this process lifetime, keyed by id.
   * Populated as a side effect of `recordFromRow` whenever a row's payload is
   * unparseable. Surfaced (read-only) via `getAutomationLoadIssues` so the UI
   * can warn the user; the underlying rows are never mutated.
   */
  private readonly loadIssues = new Map<string, { name: string; reason: string }>();

  constructor(
    private readonly stateDb: StateDb,
    private readonly options: AutomationStoreOptions = {},
  ) {}

  /** Snapshot of automation rows skipped because this build can't load them. */
  getAutomationLoadIssues(): AutomationLoadIssue[] {
    return [...this.loadIssues.entries()].map(([id, value]) => ({
      id,
      name: value.name,
      reason: value.reason,
    }));
  }

  private noteAutomationLoadIssue(row: AutomationRow, reason: string): void {
    // Don't warn about soft-deleted rows — they never run and aren't shown.
    if (row.deleted_at != null || row.status === "deleted") {
      this.loadIssues.delete(row.automation_id);
      return;
    }
    if (this.loadIssues.get(row.automation_id)?.reason !== reason) {
      this.options.warn?.("skipping automation that could not be loaded", {
        automationId: row.automation_id,
        name: row.name,
        reason,
      });
    }
    this.loadIssues.set(row.automation_id, { name: row.name, reason });
  }

  createAutomation(input: CreateAutomationInput): AutomationRecord {
    const now = input.now ?? Date.now();
    const triggers = normalizeAutomationTriggers({
      schedule: input.schedule,
      triggers: input.triggers,
    }, this.options.warn);
    const schedule = scheduleFromTriggers(triggers);
    const record: AutomationRecord = {
      id: input.id ?? `automation:${randomUUID()}`,
      backend: input.backend,
      threadId: input.threadId,
      name: input.name,
      taskPrompt: input.taskPrompt,
      gate: input.gate,
      status: input.status ?? "enabled",
      triggers,
      schedule,
      scheduleSummary: schedule
        ? formatAutomationScheduleSummary(schedule)
        : formatAutomationTriggerSummary(triggers),
      backlogPolicy: input.backlogPolicy ?? DEFAULT_AUTOMATION_BACKLOG_POLICY,
      executionProfile: input.executionProfile,
      priorRunLookback: normalizeAutomationPriorRunLookback(input.priorRunLookback),
      outputActions: normalizeAutomationOutputActions(input.outputActions),
      maxRunsPerHour: resolveAutomationRunsPerHour(input.maxRunsPerHour),
      runTimeoutMs: resolveAutomationRunTimeoutMs(input.runTimeoutMs),
      dailyRunLimit: resolveAutomationDailyRunLimit(input.dailyRunLimit),
      inboundCoalesceWindowMs: normalizeInboundCoalesceWindowMs(
        input.inboundCoalesceWindowMs,
      ),
      nextRunAt: input.nextRunAt,
      createdAt: now,
      updatedAt: now,
    };

    this.upsertAutomationRecord(record);
    return record;
  }

  updateAutomation(id: string, input: UpdateAutomationInput): AutomationRecord | undefined {
    const current = this.getAutomation(id, { includeDeleted: true });
    if (!current) return undefined;
    const now = input.now ?? Date.now();
    const triggers =
      input.triggers ?? (
        input.schedule
          ? normalizeAutomationTriggers({ schedule: input.schedule }, this.options.warn)
          : current.triggers
      );
    const schedule = scheduleFromTriggers(triggers);
    const nextRunAt =
      input.nextRunAt === null ? undefined : input.nextRunAt ?? current.nextRunAt;
    const record: AutomationRecord = {
      ...current,
      backend: input.backend ?? current.backend,
      threadId: input.threadId ?? current.threadId,
      name: input.name ?? current.name,
      taskPrompt: input.taskPrompt ?? current.taskPrompt,
      gate: input.gate === null ? undefined : input.gate ?? current.gate,
      status: input.status ?? current.status,
      triggers,
      schedule,
      scheduleSummary: schedule
        ? formatAutomationScheduleSummary(schedule)
        : formatAutomationTriggerSummary(triggers),
      backlogPolicy: input.backlogPolicy ?? current.backlogPolicy,
      executionProfile:
        input.executionProfile === null
          ? undefined
          : input.executionProfile ?? current.executionProfile,
      priorRunLookback:
        input.priorRunLookback === null
          ? undefined
          : normalizeAutomationPriorRunLookback(input.priorRunLookback)
            ?? current.priorRunLookback,
      outputActions: input.outputActions ?? current.outputActions,
      maxRunsPerHour:
        input.maxRunsPerHour === undefined
          ? current.maxRunsPerHour
          : resolveAutomationRunsPerHour(input.maxRunsPerHour),
      runTimeoutMs:
        input.runTimeoutMs === undefined
          ? current.runTimeoutMs
          : resolveAutomationRunTimeoutMs(input.runTimeoutMs),
      dailyRunLimit:
        input.dailyRunLimit === undefined
          ? current.dailyRunLimit
          : resolveAutomationDailyRunLimit(input.dailyRunLimit),
      inboundCoalesceWindowMs:
        input.inboundCoalesceWindowMs === undefined
          ? current.inboundCoalesceWindowMs
          : normalizeInboundCoalesceWindowMs(input.inboundCoalesceWindowMs),
      // Any status the operator sets replaces a pause PwrAgent made.
      pausedReason: input.status === undefined ? current.pausedReason : undefined,
      pausedAt: input.status === undefined ? current.pausedAt : undefined,
      nextRunAt,
      updatedAt: now,
    };

    this.upsertAutomationRecord(record);
    return record;
  }

  pauseAutomation(id: string, now = Date.now()): AutomationRecord | undefined {
    return this.updateAutomation(id, { status: "paused", now });
  }

  pauseAutomationForDailyLimit(
    id: string,
    now: number,
  ): { automation: AutomationRecord; paused: boolean } | undefined {
    return this.stateDb.raw.transaction(() => {
      const current = this.getAutomation(id);
      if (!current) return undefined;
      if (current.status !== "enabled") return { automation: current, paused: false };
      const record: AutomationRecord = {
        ...current,
        status: "paused",
        pausedReason: "daily_run_limit",
        pausedAt: now,
        updatedAt: now,
      };
      this.upsertAutomationRecord(record);
      return { automation: record, paused: true };
    }).immediate();
  }

  listDailyLimitPausedAutomations(): AutomationRecord[] {
    const rows = this.stateDb.raw
      .prepare(
        "SELECT * FROM automations WHERE status = 'paused' AND json_valid(payload) AND json_extract(payload, '$.pausedReason') = 'daily_run_limit' ORDER BY updated_at DESC",
      )
      .all() as AutomationRow[];
    return rows
      .map((row) => this.recordFromRow(row))
      .filter((record): record is AutomationRecord => Boolean(record));
  }

  resumeAutomation(
    id: string,
    params: { nextRunAt?: number; now?: number } = {},
  ): AutomationRecord | undefined {
    return this.updateAutomation(id, {
      status: "enabled",
      nextRunAt: params.nextRunAt,
      now: params.now,
    });
  }

  deleteAutomation(id: string, now = Date.now()): AutomationRecord | undefined {
    const current = this.getAutomation(id, { includeDeleted: true });
    if (!current) return undefined;
    const record: AutomationRecord = {
      ...current,
      status: "deleted",
      deletedAt: now,
      updatedAt: now,
    };
    this.upsertAutomationRecord(record);
    this.cancelPendingRunsForAutomation({
      automationId: id,
      now,
      errorMessage: "Automation deleted before the run started.",
    });
    return record;
  }

  cancelPendingRunsForAutomation(params: {
    automationId: string;
    now: number;
    errorMessage: string;
  }): void {
    this.stateDb.raw.transaction(() => {
      const rows = this.stateDb.raw
        .prepare(
          "SELECT * FROM automation_runs WHERE automation_id = ? AND status IN ('pending', 'queued')",
        )
        .all(params.automationId) as AutomationRunRow[];
      for (const row of rows) {
        const run = this.runFromRow(row);
        if (!run) continue;
        this.upsertRun(
          {
            ...run,
            status: "cancelled",
            completedAt: params.now,
            errorMessage: params.errorMessage,
          },
          {
            backend: row.backend,
            threadId: row.thread_id,
            queueEntryId: row.queue_entry_id ?? undefined,
            createdAt: row.created_at,
            updatedAt: params.now,
          },
        );
      }
    }).immediate();
  }

  getAutomation(
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): AutomationRecord | undefined {
    const row = this.stateDb.raw
      .prepare("SELECT * FROM automations WHERE automation_id = ?")
      .get(id) as AutomationRow | undefined;
    if (!row) return undefined;
    const record = this.recordFromRow(row);
    if (!record) return undefined;
    if (!options.includeDeleted && record.status === "deleted") return undefined;
    return record;
  }

  listAutomations(options: { includeDeleted?: boolean } = {}): AutomationRecord[] {
    const rows = this.stateDb.raw
      .prepare("SELECT * FROM automations ORDER BY updated_at DESC")
      .all() as AutomationRow[];
    return rows
      .map((row) => this.recordFromRow(row))
      .filter((record): record is AutomationRecord =>
        Boolean(record && (options.includeDeleted || record.status !== "deleted")),
      );
  }

  /**
   * Inbound matching runs on every inbound message (a hot path). Pre-filter at
   * the SQL layer to enabled automations whose payload could carry an inbound
   * trigger, so the common case (only scheduled automations, or a busy channel)
   * does not JSON-parse every automation row per message. The LIKE can admit a
   * false positive (e.g. the literal appears in a task prompt); recordFromRow
   * plus matchAutomationInboundEvent then ignore non-inbound triggers, so the
   * resulting match set is identical to filtering listAutomations().
   */
  listEnabledInboundAutomations(): AutomationRecord[] {
    const rows = this.stateDb.raw
      .prepare(
        "SELECT * FROM automations WHERE status = 'enabled' AND payload LIKE '%inbound_message%' ORDER BY updated_at DESC",
      )
      .all() as AutomationRow[];
    return rows
      .map((row) => this.recordFromRow(row))
      .filter((record): record is AutomationRecord => Boolean(record));
  }

  listAutomationsForThread(params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
    includeDeleted?: boolean;
  }): AutomationRecord[] {
    const rows = this.stateDb.raw
      .prepare(
        "SELECT * FROM automations WHERE backend = ? AND thread_id = ? ORDER BY updated_at DESC",
      )
      .all(params.backend, params.threadId) as AutomationRow[];
    return rows
      .map((row) => this.recordFromRow(row))
      .filter((record): record is AutomationRecord =>
        Boolean(record && (params.includeDeleted || record.status !== "deleted")),
      );
  }

  listEnabledDueAutomations(now: number): AutomationRecord[] {
    const rows = this.stateDb.raw
      .prepare(
        "SELECT * FROM automations WHERE status = 'enabled' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC",
      )
      .all(now) as AutomationRow[];
    return rows
      .map((row) => this.recordFromRow(row))
      .filter((record): record is AutomationRecord => Boolean(record));
  }

  createRun(input: CreateAutomationRunInput): AutomationRunSummary | undefined {
    const automation = this.getAutomation(input.automationId);
    if (!automation) return undefined;
    return this.insertRun(automation, input);
  }

  admitRun(input: CreateAutomationRunInput): AutomationRunAdmission | undefined {
    const now = input.now ?? Date.now();
    // IMMEDIATE takes the write lock before the count, so another instance
    // cannot admit a run between this count and this insert.
    const admission = this.stateDb.raw.transaction(():
      | { automation: AutomationRecord; result: AutomationRunAdmission }
      | undefined => {
      const automation = this.getAutomation(input.automationId);
      if (!automation) return undefined;
      const limit = automation.dailyRunLimit;
      if (limit !== undefined) {
        const runsInWindow = this.countRunsSince({
          automationId: automation.id,
          sinceMs: now - AUTOMATION_DAILY_RUN_LIMIT_WINDOW_MS,
        });
        if (runsInWindow >= limit) {
          return {
            automation,
            result: { status: "refused", reason: "daily_limit", runsInWindow, limit },
          };
        }
      }
      const run = this.insertRun(automation, { ...input, now }, { prune: false });
      return { automation, result: { status: "admitted", run } };
    }).immediate();
    if (!admission) return undefined;
    if (admission.result.status === "admitted") this.pruneRuns(admission.automation, now);
    return admission.result;
  }

  /**
   * Count runs of this automation created at or after `sinceMs` that started,
   * or will start, a headless turn: every run but a `skipped` one. Backs the
   * daily run limit. A run created later than now, which a clock set back
   * leaves behind, is counted too, so setting the clock back never frees a
   * slot.
   */
  countRunsSince(params: { automationId: string; sinceMs: number }): number {
    const row = this.stateDb.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM automation_runs WHERE automation_id = ? AND status != 'skipped' AND created_at >= ?",
      )
      .get(params.automationId, params.sinceMs) as { count: number };
    return row.count;
  }

  private insertRun(
    automation: AutomationRecord,
    input: CreateAutomationRunInput,
    options: { prune?: boolean } = {},
  ): AutomationRunSummary {
    const now = input.now ?? Date.now();
    const scheduledWindows = input.scheduledWindows ?? (
      input.scheduledFor === undefined ? [] : [{ scheduledFor: input.scheduledFor }]
    );
    const run: StoredAutomationRun = {
      id: input.id ?? `automation-run:${randomUUID()}`,
      automationId: automation.id,
      trigger: input.trigger,
      status: input.status ?? "pending",
      scheduledFor: input.scheduledFor ?? scheduledWindows[0]?.scheduledFor,
      scheduledWindows,
      source: input.source,
      queuedAt: input.queuedAt,
      queueEntryId: input.queueEntryId,
      owner: this.options.runOwner,
      recoverOnRestart: input.recoverOnRestart === true ? true : undefined,
    };
    const terminal = (TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status);
    if (terminal) {
      run.completedAt = input.completedAt ?? now;
      run.errorMessage = input.errorMessage;
      run.skipReason = input.skipReason;
      if (input.coalescedCount !== undefined) run.coalescedCount = input.coalescedCount;
    }

    this.stateDb.raw.transaction(() => {
      this.upsertRun(run, {
        backend: automation.backend,
        threadId: automation.threadId,
        queueEntryId: input.queueEntryId,
        createdAt: now,
        updatedAt: now,
      });
      if (terminal) {
        this.updateAutomationLastRun(automation.id, {
          lastRunAt: run.completedAt!,
          lastRunStatus: run.status,
          now,
        });
      }
    })();
    if (options.prune !== false) this.pruneRuns(automation, now);
    return run;
  }

  commitScheduledEvaluation<T>(
    params: { automationId: string; dueAt?: number; nextRunAt: number | null; now: number },
    recordWindow: () => T,
  ): T | undefined {
    return this.stateDb.raw.transaction(() => {
      const current = this.getAutomation(params.automationId);
      // Another evaluation or a schedule edit may have consumed this snapshot.
      if (current?.status !== "enabled" || current.nextRunAt !== params.dueAt) return undefined;
      const run = recordWindow();
      this.updateAutomation(current.id, { nextRunAt: params.nextRunAt, now: params.now });
      return run;
    }).immediate();
  }

  coalescePendingScheduledRun(params: {
    automationId: string;
    scheduledWindows: AutomationRunWindow[];
    now?: number;
  }): AutomationRunSummary | undefined {
    const existing = this.findPendingScheduledRun(params.automationId);
    if (!existing) return undefined;
    const byScheduledFor = new Map<number, AutomationRunWindow>();
    for (const window of existing.scheduledWindows) {
      byScheduledFor.set(window.scheduledFor, window);
    }
    for (const window of params.scheduledWindows) {
      byScheduledFor.set(window.scheduledFor, window);
    }
    const nextRun: StoredAutomationRun = {
      ...existing,
      scheduledWindows: [...byScheduledFor.values()].sort(
        (left, right) => left.scheduledFor - right.scheduledFor,
      ),
    };
    const row = this.getRunRow(existing.id);
    if (!row) return undefined;
    this.upsertRun(nextRun, {
      backend: row.backend,
      threadId: row.thread_id,
      queueEntryId: row.queue_entry_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: params.now ?? Date.now(),
    });
    return nextRun;
  }

  findPendingScheduledRun(automationId: string): AutomationRunSummary | undefined {
    const row = this.stateDb.raw
      .prepare(
        "SELECT * FROM automation_runs WHERE automation_id = ? AND trigger = 'scheduled' AND status IN ('pending', 'queued') ORDER BY updated_at DESC LIMIT 1",
      )
      .get(automationId) as AutomationRunRow | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  listPendingOrQueuedRunsForAutomation(automationId: string): AutomationRunSummary[] {
    const rows = this.stateDb.raw
      .prepare(
        "SELECT * FROM automation_runs WHERE automation_id = ? AND status IN ('pending', 'queued') ORDER BY updated_at DESC, rowid DESC",
      )
      .all(automationId) as AutomationRunRow[];
    return rows
      .map((row) => this.runFromRow(row))
      .filter((run): run is AutomationRunSummary => Boolean(run));
  }

  findActiveRunForAutomation(automationId: string): AutomationRunSummary | undefined {
    const row = this.stateDb.raw
      .prepare(
        "SELECT * FROM automation_runs WHERE automation_id = ? AND status IN ('pending', 'queued', 'running') ORDER BY (status = 'running') DESC, updated_at DESC, rowid DESC LIMIT 1",
      )
      .get(automationId) as AutomationRunRow | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  findRunBySourceEventKey(params: {
    automationId: string;
    sourceEventKey: string;
  }): AutomationRunSummary | undefined {
    const row = this.stateDb.raw
      .prepare(
        "SELECT * FROM automation_runs WHERE automation_id = ? AND source_event_key = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(params.automationId, params.sourceEventKey) as
      | AutomationRunRow
      | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  /**
   * Count inbound-triggered runs created for this automation at or after
   * `sinceMs` that consumed (or will consume) a headless turn — everything
   * except `skipped` runs (a busy-lane / drop_missed skip never started).
   * Backs the per-automation inbound run-rate limit: a rolling-hour count from
   * the run history survives process restarts (unlike an in-memory bucket) and
   * makes "N per hour" a hard cap rather than a burstable token bucket.
   */
  countRecentInboundRuns(params: {
    automationId: string;
    sinceMs: number;
  }): number {
    const row = this.stateDb.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM automation_runs WHERE automation_id = ? AND trigger = 'inbound_message' AND status != 'skipped' AND created_at >= ?",
      )
      .get(params.automationId, params.sinceMs) as { count: number };
    return row.count;
  }

  findPendingRunForAutomation(automationId: string): AutomationRunSummary | undefined {
    const row = this.stateDb.raw
      .prepare(
        "SELECT * FROM automation_runs WHERE automation_id = ? AND status IN ('pending', 'queued') ORDER BY created_at ASC, rowid ASC LIMIT 1",
      )
      .get(automationId) as AutomationRunRow | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  claimRunForDispatch(runId: string, now: number): AutomationRunSummary | undefined {
    return this.stateDb.raw.transaction(() => {
      const row = this.getRunRow(runId);
      const run = row ? this.runFromRow(row) : undefined;
      if (!row || !run || (run.status !== "pending" && run.status !== "queued")) return undefined;
      const running = this.stateDb.raw.prepare(
        "SELECT 1 FROM automation_runs WHERE automation_id = ? AND status = 'running' LIMIT 1",
      ).get(run.automationId);
      if (running) return undefined;
      const claimed: StoredAutomationRun = {
        ...run,
        status: "running",
        startedAt: now,
        owner: this.options.runOwner ?? run.owner,
        recoverOnRestart: undefined,
      };
      this.upsertRun(claimed, {
        backend: row.backend,
        threadId: row.thread_id,
        queueEntryId: run.queueEntryId,
        createdAt: row.created_at,
        updatedAt: now,
      });
      return claimed;
    }).immediate();
  }

  markRunQueued(params: {
    runId: string;
    queueEntryId: string;
    queuedAt?: number;
    now?: number;
  }): AutomationRunSummary | undefined {
    return this.updateRun(params.runId, {
      status: "queued",
      queuedAt: params.queuedAt ?? params.now ?? Date.now(),
      queueEntryId: params.queueEntryId,
      now: params.now,
    });
  }

  markRunStarted(params: {
    runId: string;
    backendThreadId?: string;
    backendTurnId: string;
    queueEntryId?: string;
    startedAt?: number;
    now?: number;
  }): AutomationRunSummary | undefined {
    return this.updateRun(params.runId, {
      status: "running",
      backendThreadId: params.backendThreadId,
      backendTurnId: params.backendTurnId,
      queueEntryId: params.queueEntryId,
      startedAt: params.startedAt ?? params.now ?? Date.now(),
      now: params.now,
    });
  }

  markRunTerminal(params: {
    runId: string;
    status: Extract<AutomationRunStatus, "completed" | "failed" | "cancelled" | "skipped">;
    completedAt?: number;
    errorMessage?: string;
    skipReason?: AutomationRunSkipReason;
    failureReason?: AutomationRunFailureReason;
    coalescedCount?: number;
    now?: number;
  }): AutomationRunSummary | undefined {
    const current = this.getRun(params.runId);
    if (!current || !RUN_STATUS_TRANSITIONS[current.status].includes(params.status)) {
      return current;
    }
    const completedAt = params.completedAt ?? params.now ?? Date.now();
    const run = this.updateRun(params.runId, {
      status: params.status,
      completedAt,
      errorMessage: params.errorMessage,
      skipReason: params.skipReason,
      failureReason: params.status === "failed" ? params.failureReason : undefined,
      coalescedCount: params.coalescedCount,
      now: params.now,
    });
    if (!run) return undefined;
    this.updateAutomationLastRun(run.automationId, {
      lastRunAt: completedAt,
      lastRunStatus: params.status,
      now: params.now ?? completedAt,
    });
    return run;
  }

  /** A throttle marker aggregates distinct drops; it is not another terminal event. */
  coalesceRateLimitedRun(params: {
    runId: string;
    coalescedCount: number;
    errorMessage: string;
    skipReason?: AutomationRunSkipReason;
    now: number;
  }): AutomationRunSummary | undefined {
    const row = this.getRunRow(params.runId);
    if (!row) return undefined;
    const current = this.runFromRow(row);
    if (
      !current
      || current.status !== "skipped"
      || current.skipReason !== (params.skipReason ?? "rate_limited")
      || params.coalescedCount <= (current.coalescedCount ?? 0)
    ) return current;
    const run = {
      ...current,
      coalescedCount: params.coalescedCount,
      errorMessage: params.errorMessage,
      completedAt: params.now,
    };
    // One commit for the marker and the automation's last-run fields.
    this.stateDb.raw.transaction(() => {
      this.upsertRun(run, {
        backend: row.backend,
        threadId: row.thread_id,
        queueEntryId: row.queue_entry_id ?? undefined,
        createdAt: row.created_at,
        updatedAt: params.now,
      });
      this.updateAutomationLastRun(run.automationId, {
        lastRunAt: params.now,
        lastRunStatus: run.status,
        now: params.now,
      });
    })();
    return run;
  }

  getRun(runId: string): AutomationRunSummary | undefined {
    const row = this.getRunRow(runId);
    return row ? this.runFromRow(row) : undefined;
  }

  getLatestRunForAutomation(automationId: string): AutomationRunSummary | undefined {
    const row = this.stateDb.raw
      .prepare(
        "SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1",
      )
      .get(automationId) as AutomationRunRow | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  findRunningRunByBackendTurnId(params: {
    backend: AppServerBackendKind;
    backendTurnId: string;
  }): AutomationRunSummary | undefined {
    const row = this.stateDb.raw
      .prepare(
        "SELECT * FROM automation_runs WHERE backend = ? AND backend_turn_id = ? AND status = 'running' ORDER BY updated_at DESC, rowid DESC LIMIT 1",
      )
      .get(params.backend, params.backendTurnId) as AutomationRunRow | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  findRunByBackendTurnId(params: {
    backend: AppServerBackendKind;
    backendTurnId: string;
  }): AutomationRunSummary | undefined {
    const row = this.stateDb.raw
      .prepare(
        "SELECT * FROM automation_runs WHERE backend = ? AND backend_turn_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1",
      )
      .get(params.backend, params.backendTurnId) as AutomationRunRow | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  /**
   * Look up a thread ledger's turn ids in one query. Choose the newest
   * running row for each turn, falling back to the newest row in any status.
   * Decode only the chosen row, so corrupt payloads do not expose stale runs.
   */
  findRunsByBackendTurnIds(params: {
    backend: AppServerBackendKind;
    backendTurnIds: readonly string[];
  }): Map<string, AutomationRunSummary> {
    const runs = new Map<string, AutomationRunSummary>();
    if (params.backendTurnIds.length === 0) return runs;
    const rows = this.stateDb.raw
      .prepare(
        `SELECT * FROM automation_runs
         WHERE backend = ?
           AND backend_turn_id IN (SELECT value FROM json_each(?))
         ORDER BY updated_at DESC, rowid DESC`,
      )
      .all(params.backend, JSON.stringify(params.backendTurnIds)) as AutomationRunRow[];
    const chosen = new Map<string, AutomationRunRow>();
    for (const row of rows) {
      const turnId = row.backend_turn_id;
      if (!turnId) continue;
      const current = chosen.get(turnId);
      if (!current || (current.status !== "running" && row.status === "running")) {
        chosen.set(turnId, row);
      }
    }
    for (const [turnId, row] of chosen) {
      const run = this.runFromRow(row);
      if (run) runs.set(turnId, run);
    }
    return runs;
  }

  findPrunedRunCostsByBackendTurnIds(params: {
    backend: AppServerBackendKind;
    backendTurnIds: readonly string[];
  }): Map<string, { runId: string; automationId: string; totalCostMicros?: number }> {
    const runs = new Map<string, { runId: string; automationId: string; totalCostMicros?: number }>();
    if (params.backendTurnIds.length === 0) return runs;
    const rows = this.stateDb.raw.prepare(`
      SELECT run_id, automation_id, backend_turn_id, total_cost_micros
        FROM automation_pruned_run_costs
       WHERE backend = ?
         AND backend_turn_id IN (SELECT value FROM json_each(?))
       ORDER BY rowid
    `).all(params.backend, JSON.stringify(params.backendTurnIds)) as PrunedRunCostRow[];
    for (const row of rows) {
      runs.set(row.backend_turn_id, {
        runId: row.run_id,
        automationId: row.automation_id,
        totalCostMicros: row.total_cost_micros ?? undefined,
      });
    }
    return runs;
  }

  upsertRunArtifact(
    input: UpsertAutomationRunArtifactInput,
  ): AutomationRunArtifact | undefined {
    const runRow = this.getRunRow(input.runId);
    if (!runRow) return undefined;
    const existing = this.getRunArtifactRow(input.runId);
    const existingArtifact = existing ? this.artifactFromRow(existing) : undefined;
    const now = input.now ?? Date.now();
    const artifact: AutomationRunArtifact = {
      runId: input.runId,
      automationId: runRow.automation_id,
      status: input.status,
      finalText: input.finalText ?? existingArtifact?.finalText,
      errorMessage: input.errorMessage ?? existingArtifact?.errorMessage,
      outputDecision: input.outputDecision ?? existingArtifact?.outputDecision,
      actionResults: input.actionResults ?? existingArtifact?.actionResults ?? [],
      transcriptEvents:
        input.transcriptEvents ?? existingArtifact?.transcriptEvents ?? [],
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    };
    this.upsertArtifact(artifact, {
      backend: runRow.backend,
      threadId: runRow.thread_id,
    });
    return artifact;
  }

  appendRunTranscriptEvent(params: {
    runId: string;
    event: AutomationRunTranscriptEvent;
    now?: number;
  }): AutomationRunArtifact | undefined {
    return this.appendRunTranscriptEvents({
      runId: params.runId,
      events: [params.event],
      now: params.now,
    });
  }

  appendRunTranscriptEvents(params: {
    runId: string;
    events: AutomationRunTranscriptEvent[];
    now?: number;
  }): AutomationRunArtifact | undefined {
    const run = this.getRun(params.runId);
    if (!run) return undefined;
    const existing = this.getRunArtifact(params.runId);
    const transcriptEvents = mergeTranscriptEvents(
      existing?.transcriptEvents ?? [],
      params.events,
    );
    return this.upsertRunArtifact({
      runId: params.runId,
      status: run.status,
      finalText: existing?.finalText,
      errorMessage: existing?.errorMessage,
      outputDecision: existing?.outputDecision,
      transcriptEvents,
      now: params.now,
    });
  }

  getRunArtifact(runId: string): AutomationRunArtifact | undefined {
    const row = this.getRunArtifactRow(runId);
    return row ? this.artifactFromRow(row) : undefined;
  }

  listRunsForAutomation(automationId: string, limit = 50): AutomationRunSummary[] {
    const rows = this.stateDb.raw
      .prepare(
        "SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?",
      )
      .all(automationId, limit) as AutomationRunRow[];
    return rows
      .map((row) => this.runFromRow(row))
      .filter((run): run is AutomationRunSummary => Boolean(run));
  }

  listRunsForThread(params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
    limit?: number;
  }): AutomationRunSummary[] {
    const rows = this.stateDb.raw
      .prepare(
        "SELECT * FROM automation_runs WHERE backend = ? AND thread_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?",
      )
      .all(params.backend, params.threadId, params.limit ?? 50) as AutomationRunRow[];
    return rows
      .map((row) => this.runFromRow(row))
      .filter((run): run is AutomationRunSummary => Boolean(run));
  }

  /**
   * Adopts proven unstarted runs once and interrupts the rest, after checking
   * their owners. One transaction, and none when nothing needs reconciling.
   */
  reconcileStartup(input: StartupReconciliationInput = {}): StartupReconciliationResult {
    const now = input.now ?? Date.now();
    const unfinished = this.stateDb.raw
      .prepare(
        "SELECT * FROM automation_runs WHERE status IN ('pending', 'queued', 'running') ORDER BY created_at, rowid",
      )
      .all() as AutomationRunRow[];
    const deadOwnerRuns: Array<{ id: string; ownerKey: string | undefined }> = [];
    let liveOwnerRunCount = 0;
    // Liveness reads the profile's runtime markers, so decide it before the
    // write lock is taken, and once per owner.
    const aliveByOwner = new Map<string, boolean>();
    const isOwnerAlive = (owner: AutomationRunOwner): boolean => {
      const key = runOwnerKey(owner);
      let alive = aliveByOwner.get(key);
      if (alive === undefined) {
        alive = input.isOwnerAlive?.(owner) === true;
        aliveByOwner.set(key, alive);
      }
      return alive;
    };
    for (const row of unfinished) {
      const owner = readRunOwner(parseJson<AutomationRunPayload>(row.payload)?.owner);
      if (owner && isOwnerAlive(owner)) liveOwnerRunCount += 1;
      else deadOwnerRuns.push({ id: row.run_id, ownerKey: owner && runOwnerKey(owner) });
    }
    const dueNextRunAt: Array<[string, number | null]> = [];
    for (const [automationId, nextRunAt] of Object.entries(
      input.nextRunAtByAutomationId ?? {},
    )) {
      const current = this.getAutomation(automationId);
      if (!current) continue;
      // A stored time still ahead, and no later than the schedule's next
      // occurrence, is the schedule another launch or a live instance already
      // settled. One later than that was stored under a clock or time zone
      // that has since changed, and is corrected.
      if (
        current.nextRunAt !== undefined
        && current.nextRunAt > now
        && (nextRunAt === undefined || current.nextRunAt <= nextRunAt)
      ) continue;
      if (current.nextRunAt === nextRunAt) continue;
      dueNextRunAt.push([automationId, nextRunAt ?? null]);
    }
    const interruptedRuns: AutomationRunSummary[] = [];
    const resumedRuns: AutomationRunSummary[] = [];
    if (deadOwnerRuns.length === 0 && dueNextRunAt.length === 0) {
      return { interruptedRuns, resumedRuns, liveOwnerRunCount, rescheduledAutomationCount: 0 };
    }

    const transaction = this.stateDb.raw.transaction(() => {
      for (const candidate of deadOwnerRuns) {
        // Re-read under the write lock: the run may have reached an outcome,
        // or another launch may have reported it, since the scan.
        const row = this.getRunRow(candidate.id);
        const run = row ? this.runFromRow(row) : undefined;
        if (!row || !run || RUN_STATUS_TRANSITIONS[run.status].length === 0) continue;
        if ((run.owner && runOwnerKey(run.owner)) !== candidate.ownerKey) continue;
        if (
          input.resumeUnstartedRuns && this.options.runOwner && run.recoverOnRestart
          && run.resumedAt === undefined && (run.status === "pending" || run.status === "queued")
          && run.startedAt === undefined && run.backendTurnId === undefined
          && this.getAutomation(run.automationId)
        ) {
          const resumed: StoredAutomationRun = {
            ...run,
            status: "queued",
            queuedAt: run.queuedAt ?? now,
            owner: this.options.runOwner,
            resumedAt: now,
            recoverOnRestart: undefined,
          };
          this.upsertRun(resumed, {
            backend: row.backend,
            threadId: row.thread_id,
            queueEntryId: run.queueEntryId,
            createdAt: row.created_at,
            updatedAt: now,
          });
          resumedRuns.push(resumed);
          continue;
        }
        const interrupted: AutomationRunSummary = {
          ...run,
          status: "failed",
          failureReason: "interrupted",
          completedAt: now,
          errorMessage: AUTOMATION_RUN_INTERRUPTED_MESSAGE,
        };
        this.upsertRun(interrupted, {
          backend: row.backend,
          threadId: row.thread_id,
          queueEntryId: row.queue_entry_id ?? undefined,
          createdAt: row.created_at,
          updatedAt: now,
        });
        this.updateAutomationLastRun(run.automationId, {
          lastRunAt: now,
          lastRunStatus: "failed",
          now,
        });
        interruptedRuns.push(interrupted);
      }

      for (const [automationId, nextRunAt] of dueNextRunAt) {
        this.updateAutomation(automationId, { nextRunAt, now });
      }
    });
    transaction.immediate();
    return {
      interruptedRuns,
      resumedRuns,
      liveOwnerRunCount,
      rescheduledAutomationCount: dueNextRunAt.length,
    };
  }

  listUnreportedInterruptedRuns(): AutomationRunSummary[] {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT r.* FROM automation_runs r
         LEFT JOIN automation_run_artifacts a ON a.run_id = r.run_id
         WHERE r.status = 'failed'
           AND (a.run_id IS NULL OR a.status <> 'failed')
           AND CASE WHEN json_valid(r.payload)
             THEN json_extract(r.payload, '$.failureReason') END = 'interrupted'
         ORDER BY r.created_at, r.rowid`,
      )
      .all() as AutomationRunRow[];
    return rows
      .map((row) => this.runFromRow(row))
      .filter((run): run is AutomationRunSummary => Boolean(run));
  }

  buildThreadSummaries(): Record<string, AutomationThreadSummary> {
    const summaries: Record<string, AutomationThreadSummary> = {};
    for (const automation of this.listAutomations()) {
      const key = buildThreadIdentityKey(automation.backend, automation.threadId);
      const current = summaries[key] ?? {
        totalCount: 0,
        enabledCount: 0,
        pausedCount: 0,
        pendingRunCount: 0,
        coalescedWindowCount: 0,
        skippedSinceLastCompletedCount: 0,
        automations: [],
      };
      const runCounts = this.countRunsForAutomation(automation.id);
      const item: AutomationListItemSummary = {
        id: automation.id,
        backend: automation.backend,
        threadId: automation.threadId,
        name: automation.name,
        status: automation.status,
        triggers: automation.triggers,
        schedule: automation.schedule,
        scheduleSummary: automation.scheduleSummary,
        backlogPolicy: automation.backlogPolicy,
        nextRunAt: automation.nextRunAt,
        lastRunAt: automation.lastRunAt,
        lastRunStatus: automation.lastRunStatus,
        pendingRunCount: runCounts.pending,
        coalescedWindowCount: runCounts.coalescedWindows,
        updatedAt: automation.updatedAt,
      };
      current.totalCount += 1;
      current.enabledCount += automation.status === "enabled" ? 1 : 0;
      current.pausedCount += automation.status === "paused" ? 1 : 0;
      current.nextRunAt = minDefined(current.nextRunAt, automation.nextRunAt);
      current.lastRunAt = maxDefined(current.lastRunAt, automation.lastRunAt);
      current.pendingRunCount += runCounts.pending;
      current.coalescedWindowCount += runCounts.coalescedWindows;
      current.skippedSinceLastCompletedCount += runCounts.skippedSinceLastCompleted;
      current.automations.push(item);
      summaries[key] = current;
    }

    return summaries;
  }

  private updateRun(
    runId: string,
    input: {
      status: AutomationRunStatus;
      queuedAt?: number;
      startedAt?: number;
      completedAt?: number;
      backendThreadId?: string;
      backendTurnId?: string;
      queueEntryId?: string;
      errorMessage?: string;
      skipReason?: AutomationRunSkipReason;
      failureReason?: AutomationRunFailureReason;
      coalescedCount?: number;
      now?: number;
    },
  ): AutomationRunSummary | undefined {
    return this.stateDb.raw.transaction(() => {
      const row = this.getRunRow(runId);
      if (!row) return undefined;
      const current = this.runFromRow(row);
      if (!current) return undefined;
      const now = input.now ?? Date.now();
      const transitions = RUN_STATUS_TRANSITIONS[current.status];
      const acceptsLifecycle = transitions.includes(input.status)
        || (transitions.length > 0 && input.status === current.status);
      // Lifecycle events may beat submission acknowledgements. Stale updates
      // can fill missing identities, but cannot rewind status, timestamps or outcome.
      const nextRun: StoredAutomationRun = {
        ...current,
        status: acceptsLifecycle ? input.status : current.status,
        queuedAt: current.queuedAt ?? (acceptsLifecycle ? input.queuedAt : undefined),
        startedAt: current.startedAt ?? (acceptsLifecycle ? input.startedAt : undefined),
        completedAt: current.completedAt ?? (acceptsLifecycle ? input.completedAt : undefined),
        backendThreadId: current.backendThreadId ?? input.backendThreadId,
        backendTurnId: current.backendTurnId ?? input.backendTurnId,
        queueEntryId: !acceptsLifecycle && input.status === "queued"
          ? current.queueEntryId ?? input.queueEntryId
          : input.queueEntryId ?? current.queueEntryId,
        errorMessage: acceptsLifecycle
          ? input.errorMessage ?? current.errorMessage
          : current.errorMessage,
        skipReason: acceptsLifecycle
          ? input.skipReason ?? current.skipReason
          : current.skipReason,
        failureReason: acceptsLifecycle
          ? input.failureReason ?? current.failureReason
          : current.failureReason,
        coalescedCount: acceptsLifecycle
          ? input.coalescedCount ?? current.coalescedCount
          : current.coalescedCount,
      };
      if (
        (Object.keys(nextRun) as (keyof AutomationRunSummary)[])
          .every((key) => nextRun[key] === current[key])
      ) return current;
      this.upsertRun(nextRun, {
        backend: row.backend,
        threadId: row.thread_id,
        queueEntryId: nextRun.queueEntryId,
        createdAt: row.created_at,
        updatedAt: Math.max(row.updated_at, now),
      });
      return nextRun;
    }).immediate();
  }

  private updateAutomationLastRun(
    automationId: string,
    params: {
      lastRunAt: number;
      lastRunStatus: AutomationRunStatus;
      now: number;
    },
  ): void {
    const current = this.getAutomation(automationId, { includeDeleted: true });
    if (!current) return;
    this.upsertAutomationRecord({
      ...current,
      lastRunAt: params.lastRunAt,
      lastRunStatus: params.lastRunStatus,
      updatedAt: params.now,
    });
  }

  private upsertAutomationRecord(record: AutomationRecord): void {
    const payload: AutomationPayload = {
      taskPrompt: record.taskPrompt,
      gate: record.gate,
      triggers: record.triggers,
      schedule: record.schedule,
      scheduleSummary: record.scheduleSummary,
      executionProfile: record.executionProfile,
      priorRunLookback: record.priorRunLookback,
      outputActions: record.outputActions,
      inboundCoalesceWindowMs: record.inboundCoalesceWindowMs,
      maxRunsPerHour: record.maxRunsPerHour,
      ...(record.runTimeoutMs !== undefined ? { runTimeoutMs: record.runTimeoutMs } : {}),
      ...(record.dailyRunLimit !== undefined ? { dailyRunLimit: record.dailyRunLimit } : {}),
      ...(record.pausedReason !== undefined
        ? { pausedReason: record.pausedReason, pausedAt: record.pausedAt }
        : {}),
      lastRunStatus: record.lastRunStatus,
    };
    this.stateDb.raw
      .prepare(
        `INSERT INTO automations (
          automation_id,
          backend,
          thread_id,
          name,
          status,
          backlog_policy,
          next_run_at,
          last_run_at,
          created_at,
          updated_at,
          deleted_at,
          cost_since,
          payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(automation_id) DO UPDATE SET
          backend = excluded.backend,
          thread_id = excluded.thread_id,
          name = excluded.name,
          status = excluded.status,
          backlog_policy = excluded.backlog_policy,
          next_run_at = excluded.next_run_at,
          last_run_at = excluded.last_run_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at,
          payload = excluded.payload`,
      )
      .run(
        record.id,
        record.backend,
        record.threadId,
        record.name,
        record.status,
        record.backlogPolicy,
        record.nextRunAt ?? null,
        record.lastRunAt ?? null,
        record.createdAt,
        record.updatedAt,
        record.deletedAt ?? null,
        record.createdAt,
        JSON.stringify(payload),
      );
  }

  setRunUsage(params: {
    runId: string;
    usage: AutomationRunUsage;
    now?: number;
  }): AutomationRunSummary | undefined {
    const total = usdRunCostMicros(params.usage);
    return this.stateDb.raw.transaction(() => {
      const row = this.getRunRow(params.runId);
      if (!row) {
        if (total !== undefined) this.setPrunedRunCost(params.runId, total);
        return undefined;
      }
      const run = this.runFromRow(row);
      const payload = parseJson<AutomationRunPayload>(row.payload);
      if (!run || !payload) return undefined;

      let accounted = row.accounted_cost_micros;
      if (total !== undefined && total !== accounted) {
        // The coverage predicate excludes old runs even if a fresh pricing
        // publication replays their entire ledger after the migration.
        const updated = this.stateDb.raw.prepare(`
          UPDATE automations
             SET total_cost_micros = COALESCE(total_cost_micros, 0) + ?
           WHERE automation_id = ? AND cost_since <= ?
        `).run(total - (accounted ?? 0), row.automation_id, row.created_at);
        if (updated.changes > 0) accounted = total;
      }
      if (accounted !== row.accounted_cost_micros
        || JSON.stringify(payload.usage) !== JSON.stringify(params.usage)) {
        this.stateDb.raw.prepare(`
          UPDATE automation_runs
             SET payload = ?, updated_at = MAX(updated_at, ?), accounted_cost_micros = ?
           WHERE run_id = ?
        `).run(
          JSON.stringify({ ...payload, usage: params.usage }),
          params.now ?? Date.now(),
          accounted,
          params.runId,
        );
      }
      return { ...run, usage: params.usage };
    }).immediate();
  }

  private setPrunedRunCost(runId: string, total: number): void {
    const prior = this.stateDb.raw.prepare(`
      SELECT automation_id, total_cost_micros FROM automation_pruned_run_costs WHERE run_id = ?
    `).get(runId) as Pick<PrunedRunCostRow, "automation_id" | "total_cost_micros"> | undefined;
    if (!prior || prior.total_cost_micros === total) return;
    this.stateDb.raw.prepare(`
      UPDATE automation_pruned_run_costs SET total_cost_micros = ? WHERE run_id = ?
    `).run(total, runId);
    this.stateDb.raw.prepare(`
      UPDATE automations
         SET total_cost_micros = COALESCE(total_cost_micros, 0) + ?
       WHERE automation_id = ?
    `).run(total - (prior.total_cost_micros ?? 0), prior.automation_id);
  }

  private upsertRun(
    run: StoredAutomationRun,
    metadata: {
      backend: AppServerBackendKind;
      threadId: ThreadIdentifier;
      queueEntryId?: string;
      createdAt: number;
      updatedAt: number;
    },
  ): void {
    const payload: AutomationRunPayload = {
      scheduledWindows: run.scheduledWindows,
      backendThreadId: run.backendThreadId,
      errorMessage: run.errorMessage,
      skipReason: run.skipReason,
      failureReason: run.failureReason,
      owner: run.owner,
      recoverOnRestart: run.recoverOnRestart,
      resumedAt: run.resumedAt,
      coalescedCount: run.coalescedCount,
      source: run.source,
      usage: run.usage,
    };
    this.stateDb.raw
      .prepare(
        `INSERT INTO automation_runs (
          run_id,
          automation_id,
          backend,
          thread_id,
          status,
          trigger,
          scheduled_for,
          queued_at,
          started_at,
          completed_at,
          backend_turn_id,
          queue_entry_id,
          created_at,
          updated_at,
          source_event_key,
          payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          status = excluded.status,
          scheduled_for = excluded.scheduled_for,
          queued_at = excluded.queued_at,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          backend_turn_id = excluded.backend_turn_id,
          queue_entry_id = excluded.queue_entry_id,
          updated_at = excluded.updated_at,
          source_event_key = excluded.source_event_key,
          payload = excluded.payload`,
      )
      .run(
        run.id,
        run.automationId,
        metadata.backend,
        metadata.threadId,
        run.status,
        run.trigger,
        run.scheduledFor ?? null,
        run.queuedAt ?? null,
        run.startedAt ?? null,
        run.completedAt ?? null,
        run.backendTurnId ?? null,
        metadata.queueEntryId ?? null,
        metadata.createdAt,
        metadata.updatedAt,
        run.source?.sourceEventKey ?? null,
        JSON.stringify(payload),
      );
  }

  private upsertArtifact(
    artifact: AutomationRunArtifact,
    metadata: {
      backend: AppServerBackendKind;
      threadId: ThreadIdentifier;
    },
  ): void {
    const payload: AutomationRunArtifactPayload = {
      finalText: artifact.finalText,
      errorMessage: artifact.errorMessage,
      outputDecision: artifact.outputDecision,
      actionResults: artifact.actionResults,
      transcriptEvents: artifact.transcriptEvents,
    };
    this.stateDb.raw
      .prepare(
        `INSERT INTO automation_run_artifacts (
          run_id,
          automation_id,
          backend,
          thread_id,
          status,
          created_at,
          updated_at,
          payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          status = excluded.status,
          updated_at = excluded.updated_at,
          payload = excluded.payload`,
      )
      .run(
        artifact.runId,
        artifact.automationId,
        metadata.backend,
        metadata.threadId,
        artifact.status,
        artifact.createdAt,
        artifact.updatedAt,
        JSON.stringify(payload),
      );
  }

  private recordFromRow(row: AutomationRow): AutomationRecord | undefined {
    const payload = parseJson<AutomationPayload>(row.payload);
    if (!payload) {
      this.noteAutomationLoadIssue(row, "The automation's stored data is corrupt.");
      return undefined;
    }
    const triggers = normalizeAutomationTriggers({
      schedule: payload.schedule,
      triggers: payload.triggers,
    }, this.options.warn);
    if (Array.isArray(payload.triggers) && triggers.length === 0) {
      this.noteAutomationLoadIssue(
        row,
        "This automation was created by a newer version of PwrAgent.",
      );
      return undefined;
    }
    const schedule = scheduleFromTriggers(triggers);
    if (schedule && !isUnderstoodSchedule(schedule)) {
      // A schedule using a kind a newer build introduced cannot be run safely.
      // Inbound-only automations have no schedule and remain loadable.
      this.noteAutomationLoadIssue(
        row,
        "This automation was created by a newer version of PwrAgent.",
      );
      return undefined;
    }
    this.loadIssues.delete(row.automation_id);
    return {
      id: row.automation_id,
      backend: row.backend,
      threadId: row.thread_id,
      name: row.name,
      taskPrompt: payload.taskPrompt,
      gate: payload.gate,
      status: row.status,
      triggers,
      schedule,
      priorRunLookback: normalizeAutomationPriorRunLookback(payload.priorRunLookback),
      scheduleSummary:
        payload.scheduleSummary ??
        (schedule
          ? formatAutomationScheduleSummary(schedule)
          : formatAutomationTriggerSummary(triggers)),
      backlogPolicy: row.backlog_policy,
      executionProfile: payload.executionProfile,
      outputActions: normalizeAutomationOutputActions(payload.outputActions),
      maxRunsPerHour: resolveAutomationRunsPerHour(payload.maxRunsPerHour),
      runTimeoutMs: resolveAutomationRunTimeoutMs(payload.runTimeoutMs),
      dailyRunLimit: resolveAutomationDailyRunLimit(payload.dailyRunLimit),
      // A reason outlives its pause only if a build that predates it resumed
      // the automation; an enabled row ignores it.
      ...(row.status === "paused" && payload.pausedReason === "daily_run_limit"
        ? { pausedReason: payload.pausedReason, pausedAt: payload.pausedAt ?? row.updated_at }
        : {}),
      inboundCoalesceWindowMs: normalizeInboundCoalesceWindowMs(
        payload.inboundCoalesceWindowMs,
      ),
      nextRunAt: row.next_run_at ?? undefined,
      lastRunAt: row.last_run_at ?? undefined,
      lastRunStatus: payload.lastRunStatus,
      ...(row.cost_since !== null && row.total_cost_micros !== null
        ? { lifetimeCost: { since: row.cost_since, totalMicros: row.total_cost_micros } }
        : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at ?? undefined,
    };
  }

  private runFromRow(row: AutomationRunRow): StoredAutomationRun | undefined {
    const payload = parseJson<AutomationRunPayload>(row.payload);
    if (!payload) return undefined;
    return {
      id: row.run_id,
      automationId: row.automation_id,
      backend: row.backend,
      trigger: row.trigger,
      status: row.status,
      scheduledFor: row.scheduled_for ?? undefined,
      scheduledWindows: payload.scheduledWindows,
      source: payload.source,
      queuedAt: row.queued_at ?? undefined,
      queueEntryId: row.queue_entry_id ?? undefined,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      backendThreadId: payload.backendThreadId,
      backendTurnId: row.backend_turn_id ?? undefined,
      errorMessage: payload.errorMessage,
      skipReason: payload.skipReason,
      failureReason:
        payload.failureReason === "interrupted" || payload.failureReason === "timed_out"
          ? payload.failureReason
          : undefined,
      owner: readRunOwner(payload.owner),
      recoverOnRestart: payload.recoverOnRestart === true ? true : undefined,
      resumedAt: typeof payload.resumedAt === "number" ? payload.resumedAt : undefined,
      coalescedCount: payload.coalescedCount,
      usage: payload.usage,
    };
  }

  private artifactFromRow(
    row: AutomationRunArtifactRow,
  ): AutomationRunArtifact | undefined {
    const payload = parseJson<AutomationRunArtifactPayload>(row.payload);
    if (!payload) return undefined;
    return {
      runId: row.run_id,
      automationId: row.automation_id,
      status: row.status,
      finalText: payload.finalText,
      errorMessage: payload.errorMessage,
      outputDecision: payload.outputDecision,
      actionResults: payload.actionResults ?? [],
      transcriptEvents: payload.transcriptEvents ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getRunRow(runId: string): AutomationRunRow | undefined {
    return this.stateDb.raw
      .prepare("SELECT * FROM automation_runs WHERE run_id = ?")
      .get(runId) as AutomationRunRow | undefined;
  }

  private getRunArtifactRow(runId: string): AutomationRunArtifactRow | undefined {
    return this.stateDb.raw
      .prepare("SELECT * FROM automation_run_artifacts WHERE run_id = ?")
      .get(runId) as AutomationRunArtifactRow | undefined;
  }

  private countRunsForAutomation(automationId: string): {
    pending: number;
    coalescedWindows: number;
    skippedSinceLastCompleted: number;
  } {
    const runs = this.listRunsForAutomation(automationId, this.runHistoryLimit);
    const pendingRuns = runs.filter((run) =>
      run.status === "pending" || run.status === "queued",
    );
    const latestCompletedAt = runs.find((run) => run.status === "completed")
      ?.completedAt;
    return {
      pending: pendingRuns.length,
      coalescedWindows: pendingRuns.reduce(
        (total, run) => total + Math.max(0, run.scheduledWindows.length - 1),
        0,
      ),
      skippedSinceLastCompleted: runs.filter(
        (run) =>
          run.status === "skipped" &&
          (latestCompletedAt === undefined ||
            (run.completedAt ?? run.scheduledFor ?? 0) > latestCompletedAt),
      ).length,
    };
  }

  /**
   * Keep the newest runs up to the history limit. With a daily run limit,
   * runs the limit still counts are kept ahead of every other run: the limit
   * reads them back, and a burst of skipped triggers must not prune them
   * away. They number at most the limit, which stays below the history limit.
   */
  private pruneRuns(automation: AutomationRecord, now = Date.now()): void {
    const automationId = automation.id;
    const countedSince = automation.dailyRunLimit === undefined
      ? Number.MAX_SAFE_INTEGER
      : now - AUTOMATION_DAILY_RUN_LIMIT_WINDOW_MS;
    const count = this.stateDb.raw.prepare(
      "SELECT COUNT(*) AS count FROM automation_runs WHERE automation_id = ?",
    ).get(automationId) as { count: number };
    if (count.count <= this.runHistoryLimit) return;
    this.stateDb.raw.transaction(() => {
      const expired = this.stateDb.raw.prepare(`
        SELECT r.run_id, r.backend, r.thread_id AS owner_thread_id,
               r.backend_turn_id IS NOT NULL AND r.created_at >= a.cost_since AS keep_cost,
               CASE WHEN json_valid(r.payload)
                 THEN json_extract(r.payload, '$.backendThreadId') END AS execution_thread_id,
               a.name AS automation_name
          FROM automation_runs r
          JOIN automations a ON a.automation_id = r.automation_id
         WHERE r.automation_id = ?
           AND r.run_id IN (
             SELECT run_id FROM automation_runs
              WHERE automation_id = ?
              ORDER BY (status != 'skipped' AND created_at >= ?) DESC,
                       updated_at DESC, rowid DESC
              LIMIT -1 OFFSET ?
           )
      `).all(automationId, automationId, countedSince, this.runHistoryLimit) as Array<{
        run_id: string;
        keep_cost: 0 | 1 | null;
        backend: AppServerBackendKind;
        owner_thread_id: string;
        execution_thread_id: string | null;
        automation_name: string;
      }>;
      if (expired.length === 0) return;
      const runIds = JSON.stringify(expired.map((run) => run.run_id));
      const costRunIds = expired.filter((run) => run.keep_cost).map((run) => run.run_id);
      if (costRunIds.length > 0) {
        this.stateDb.raw.prepare(`
          INSERT INTO automation_pruned_run_costs (
            run_id, automation_id, backend, backend_turn_id, total_cost_micros
          )
          SELECT run_id, automation_id, backend, backend_turn_id, accounted_cost_micros
            FROM automation_runs WHERE run_id IN (SELECT value FROM json_each(?))
        `).run(JSON.stringify(costRunIds));
      }
      const currentTitle = this.stateDb.raw.prepare(
        "SELECT title FROM thread_search_documents WHERE identity_key = ?",
      );
      const historicalTitle = this.stateDb.raw.prepare(
        "SELECT title FROM thread_usage_titles WHERE identity_key = ?",
      );
      const hasUsage = this.stateDb.raw.prepare(`
        SELECT 1 FROM thread_usage_lines
         WHERE backend = ? AND thread_id = ? AND status != 'superseded'
         LIMIT 1
      `);
      const retainTitle = this.stateDb.raw.prepare(`
        INSERT INTO thread_usage_titles (identity_key, title)
        VALUES (?, ?)
        ON CONFLICT(identity_key) DO UPDATE SET title = excluded.title
      `);
      for (const run of expired) {
        if (!run.execution_thread_id) continue;
        // Only visible ledger rows need a durable title. This lookup uses
        // idx_thread_usage_lines_read_thread, avoiding a ledger scan per run.
        if (!hasUsage.get(run.backend, run.execution_thread_id)) continue;
        const ownerKey = buildLegacyEncodedThreadIdentityKey(
          run.backend, run.owner_thread_id,
        );
        const executionKey = buildLegacyEncodedThreadIdentityKey(
          run.backend, run.execution_thread_id,
        );
        const title = (currentTitle.get(ownerKey) as { title: string } | undefined)?.title
          ?? (historicalTitle.get(ownerKey) as { title: string } | undefined)?.title
          ?? run.automation_name;
        retainTitle.run(executionKey, title);
      }
      this.stateDb.raw.prepare(`
        DELETE FROM automation_runs
         WHERE automation_id = ?
           AND run_id IN (SELECT value FROM json_each(?))
      `).run(automationId, runIds);
    }).immediate();
  }

  private get runHistoryLimit(): number {
    return this.options.runHistoryLimit ?? DEFAULT_RUN_HISTORY_LIMIT;
  }
}

function usdRunCostMicros(usage: AutomationRunUsage): number | undefined {
  const total = usage.totalCostMicros;
  return typeof total === "number" && Number.isSafeInteger(total) && total >= 0
    && (usage.currency === undefined || usage.currency === "USD") ? total : undefined;
}

/** Stored JSON is untrusted: an owner that is not well formed is no owner. */
function runOwnerKey(owner: AutomationRunOwner): string {
  return `${owner.instanceId}\0${owner.processId}\0${owner.startedAt ?? ""}`;
}

function readRunOwner(value: unknown): AutomationRunOwner | undefined {
  if (!value || typeof value !== "object") return undefined;
  const owner = value as Partial<Record<keyof AutomationRunOwner, unknown>>;
  if (typeof owner.instanceId !== "string" || typeof owner.processId !== "number") {
    return undefined;
  }
  return {
    instanceId: owner.instanceId,
    processId: owner.processId,
    ...(typeof owner.startedAt === "number" ? { startedAt: owner.startedAt } : {}),
  };
}

function parseJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function normalizeAutomationTriggers(params: {
  schedule?: AutomationScheduleDefinition;
  triggers?: AutomationTriggerDefinition[];
}, warn: AutomationStoreOptions["warn"]): AutomationTriggerDefinition[] {
  const triggers = Array.isArray(params.triggers)
    ? params.triggers.filter(trigger => isSupportedAutomationTrigger(trigger, warn))
    : [];
  if (triggers.length > 0) {
    return triggers;
  }
  if (params.schedule) {
    return [
      {
        id: "schedule",
        kind: "schedule",
        schedule: params.schedule,
      },
    ];
  }
  return [];
}

function isSupportedAutomationTrigger(
  trigger: AutomationTriggerDefinition,
  warn: AutomationStoreOptions["warn"],
): trigger is AutomationTriggerDefinition {
  if (!trigger || typeof trigger !== "object") return false;
  if (trigger.kind === "schedule") {
    return isUnderstoodSchedule(trigger.schedule);
  }
  if (trigger.kind === "inbound_message") {
    if (
      !trigger.id ||
      !trigger.conversation?.channel ||
      !trigger.conversation.conversationId
    ) {
      return false;
    }
    // A malformed condition group is not persisted: the matcher could not
    // honor it, and storing it would leave an automation whose displayed
    // filter and actual behavior disagree. Dropping the trigger silently would
    // leave an automation that simply stops firing with nothing to explain it,
    // so say so — this is the only signal an operator gets.
    if (
      trigger.conditionGroup !== undefined &&
      !isSupportedAutomationInboundConditionGroup(trigger.conditionGroup)
    ) {
      warn?.(
        "dropping inbound trigger with an unparseable condition group",
        {
          triggerId: trigger.id,
          channel: trigger.conversation.channel,
          conditionCount: Array.isArray(trigger.conditionGroup?.conditions)
            ? trigger.conditionGroup.conditions.length
            : undefined,
          join: trigger.conditionGroup?.join,
        },
      );
      return false;
    }
    return true;
  }
  return false;
}

function scheduleFromTriggers(
  triggers: AutomationTriggerDefinition[],
): AutomationScheduleDefinition | undefined {
  return triggers.find((trigger) => trigger.kind === "schedule")?.schedule;
}

function formatAutomationTriggerSummary(
  triggers: AutomationTriggerDefinition[],
): string {
  const inbound = triggers.filter(
    (trigger): trigger is AutomationInboundMessageTriggerDefinition =>
      trigger.kind === "inbound_message",
  );
  const [only] = inbound;
  if (!only) return "not scheduled";
  if (inbound.length === 1) {
    return only.name ? `inbound: ${only.name}` : "inbound message";
  }
  // Several sources: name them, since "inbound message" alone no longer says
  // where the automation listens. The editor writes one filter to every
  // source, so a shared trigger name (the filter's wording) is still worth
  // stating; names that disagree are left out rather than listed N times.
  const sources = formatAutomationConversationList(
    inbound.map((trigger) => trigger.conversation),
  );
  const names = new Set(inbound.map((trigger) => trigger.name));
  const [sharedName] = names;
  return names.size === 1 && sharedName
    ? `inbound from ${sources}: ${sharedName}`
    : `inbound from ${sources}`;
}

function normalizeInboundCoalesceWindowMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_AUTOMATION_INBOUND_COALESCE_WINDOW_MS;
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_AUTOMATION_INBOUND_COALESCE_WINDOW_MS;
  }
  return Math.floor(value);
}

function normalizeAutomationOutputActions(
  actions: AutomationOutputActionDefinition[] | undefined,
): AutomationOutputActionDefinition[] {
  if (!Array.isArray(actions) || actions.length === 0) {
    return [{ id: "agent-context", kind: "agent_context" }];
  }
  return actions.filter(isSupportedAutomationOutputAction);
}

function isSupportedAutomationOutputAction(
  action: AutomationOutputActionDefinition,
): action is AutomationOutputActionDefinition {
  if (!action || typeof action !== "object" || !action.id) return false;
  if (action.kind === "agent_context") return true;
  if (action.kind === "source_message") {
    return (
      action.destination === "source_thread" ||
      action.destination === "source_channel"
    );
  }
  if (action.kind === "messaging_target") {
    return Boolean(action.target?.channel && action.target.conversationId);
  }
  return false;
}

function minDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}
