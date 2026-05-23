import { randomUUID } from "node:crypto";
import type {
  AppServerBackendKind,
  AutomationBacklogPolicy,
  AutomationListItemSummary,
  AutomationRunStatus,
  AutomationRunSummary,
  AutomationRunTrigger,
  AutomationRunWindow,
  AutomationScheduleDefinition,
  AutomationStatus,
  AutomationThreadSummary,
  ThreadIdentifier,
} from "@pwragent/shared";
import {
  DEFAULT_AUTOMATION_BACKLOG_POLICY,
  buildThreadIdentityKey,
  formatAutomationScheduleSummary,
} from "@pwragent/shared";
import type { StateDb } from "../state/state-db.js";

const DEFAULT_RUN_HISTORY_LIMIT = 200;

export type AutomationRecord = {
  id: string;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  name: string;
  taskPrompt: string;
  status: AutomationStatus;
  schedule: AutomationScheduleDefinition;
  scheduleSummary: string;
  backlogPolicy: AutomationBacklogPolicy;
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
  schedule: AutomationScheduleDefinition;
  backlogPolicy?: AutomationBacklogPolicy;
  status?: AutomationStatus;
  nextRunAt?: number;
  now?: number;
};

export type UpdateAutomationInput = {
  name?: string;
  taskPrompt?: string;
  schedule?: AutomationScheduleDefinition;
  backlogPolicy?: AutomationBacklogPolicy;
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
  queuedAt?: number;
  queueEntryId?: string;
  now?: number;
};

export type StartupReconciliationInput = {
  now?: number;
  nextRunAtByAutomationId?: Record<string, number | undefined>;
};

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
  payload: string;
};

type AutomationPayload = {
  taskPrompt: string;
  schedule: AutomationScheduleDefinition;
  scheduleSummary: string;
  lastRunStatus?: AutomationRunStatus;
};

type AutomationRunPayload = {
  scheduledWindows: AutomationRunWindow[];
  errorMessage?: string;
};

export class AutomationStore {
  constructor(
    private readonly stateDb: StateDb,
    private readonly options: { runHistoryLimit?: number } = {},
  ) {}

  createAutomation(input: CreateAutomationInput): AutomationRecord {
    const now = input.now ?? Date.now();
    const record: AutomationRecord = {
      id: input.id ?? `automation:${randomUUID()}`,
      backend: input.backend,
      threadId: input.threadId,
      name: input.name,
      taskPrompt: input.taskPrompt,
      status: input.status ?? "enabled",
      schedule: input.schedule,
      scheduleSummary: formatAutomationScheduleSummary(input.schedule),
      backlogPolicy: input.backlogPolicy ?? DEFAULT_AUTOMATION_BACKLOG_POLICY,
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
    const schedule = input.schedule ?? current.schedule;
    const nextRunAt =
      input.nextRunAt === null ? undefined : input.nextRunAt ?? current.nextRunAt;
    const record: AutomationRecord = {
      ...current,
      name: input.name ?? current.name,
      taskPrompt: input.taskPrompt ?? current.taskPrompt,
      status: input.status ?? current.status,
      schedule,
      scheduleSummary: formatAutomationScheduleSummary(schedule),
      backlogPolicy: input.backlogPolicy ?? current.backlogPolicy,
      nextRunAt,
      updatedAt: now,
    };

    this.upsertAutomationRecord(record);
    return record;
  }

  pauseAutomation(id: string, now = Date.now()): AutomationRecord | undefined {
    return this.updateAutomation(id, { status: "paused", now });
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
    const now = input.now ?? Date.now();
    const scheduledWindows = input.scheduledWindows ?? (
      input.scheduledFor === undefined ? [] : [{ scheduledFor: input.scheduledFor }]
    );
    const run: AutomationRunSummary = {
      id: input.id ?? `automation-run:${randomUUID()}`,
      automationId: automation.id,
      trigger: input.trigger,
      status: input.status ?? "pending",
      scheduledFor: input.scheduledFor ?? scheduledWindows[0]?.scheduledFor,
      scheduledWindows,
      queuedAt: input.queuedAt,
      queueEntryId: input.queueEntryId,
    };

    this.upsertRun(run, {
      backend: automation.backend,
      threadId: automation.threadId,
      queueEntryId: input.queueEntryId,
      createdAt: now,
      updatedAt: now,
    });
    this.pruneRuns(automation.id);
    return run;
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
    const nextRun: AutomationRunSummary = {
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
        "SELECT * FROM automation_runs WHERE automation_id = ? AND status IN ('pending', 'queued', 'running') ORDER BY updated_at DESC, rowid DESC LIMIT 1",
      )
      .get(automationId) as AutomationRunRow | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  findPendingRunForAutomation(automationId: string): AutomationRunSummary | undefined {
    const row = this.stateDb.raw
      .prepare(
        "SELECT * FROM automation_runs WHERE automation_id = ? AND status IN ('pending', 'queued') ORDER BY created_at ASC, rowid ASC LIMIT 1",
      )
      .get(automationId) as AutomationRunRow | undefined;
    return row ? this.runFromRow(row) : undefined;
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
    backendTurnId: string;
    startedAt?: number;
    now?: number;
  }): AutomationRunSummary | undefined {
    return this.updateRun(params.runId, {
      status: "running",
      backendTurnId: params.backendTurnId,
      startedAt: params.startedAt ?? params.now ?? Date.now(),
      now: params.now,
    });
  }

  markRunTerminal(params: {
    runId: string;
    status: Extract<AutomationRunStatus, "completed" | "failed" | "cancelled" | "skipped">;
    completedAt?: number;
    errorMessage?: string;
    now?: number;
  }): AutomationRunSummary | undefined {
    const completedAt = params.completedAt ?? params.now ?? Date.now();
    const run = this.updateRun(params.runId, {
      status: params.status,
      completedAt,
      errorMessage: params.errorMessage,
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

  getRun(runId: string): AutomationRunSummary | undefined {
    const row = this.getRunRow(runId);
    return row ? this.runFromRow(row) : undefined;
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

  reconcileStartup(input: StartupReconciliationInput = {}): void {
    const now = input.now ?? Date.now();
    const rows = this.stateDb.raw
      .prepare("SELECT * FROM automation_runs WHERE status IN ('pending', 'queued', 'running')")
      .all() as AutomationRunRow[];

    const transaction = this.stateDb.raw.transaction(() => {
      for (const row of rows) {
        const run = this.runFromRow(row);
        if (!run) continue;
        this.upsertRun(
          {
            ...run,
            status: "cancelled",
            completedAt: now,
            errorMessage: "PwrAgent restarted before this local automation run completed.",
          },
          {
            backend: row.backend,
            threadId: row.thread_id,
            queueEntryId: row.queue_entry_id ?? undefined,
            createdAt: row.created_at,
            updatedAt: now,
          },
        );
      }

      for (const [automationId, nextRunAt] of Object.entries(
        input.nextRunAtByAutomationId ?? {},
      )) {
        this.updateAutomation(automationId, {
          nextRunAt: nextRunAt ?? null,
          now,
        });
      }
    });
    transaction();
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
      status?: AutomationRunStatus;
      queuedAt?: number;
      startedAt?: number;
      completedAt?: number;
      backendTurnId?: string;
      queueEntryId?: string;
      errorMessage?: string;
      now?: number;
    },
  ): AutomationRunSummary | undefined {
    const row = this.getRunRow(runId);
    if (!row) return undefined;
    const current = this.runFromRow(row);
    if (!current) return undefined;
    const now = input.now ?? Date.now();
    const nextRun: AutomationRunSummary = {
      ...current,
      status: input.status ?? current.status,
      queuedAt: input.queuedAt ?? current.queuedAt,
      startedAt: input.startedAt ?? current.startedAt,
      completedAt: input.completedAt ?? current.completedAt,
      backendTurnId: input.backendTurnId ?? current.backendTurnId,
      errorMessage: input.errorMessage ?? current.errorMessage,
    };
    this.upsertRun(nextRun, {
      backend: row.backend,
      threadId: row.thread_id,
      queueEntryId: input.queueEntryId ?? row.queue_entry_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: now,
    });
    return nextRun;
  }

  private cancelPendingRunsForAutomation(params: {
    automationId: string;
    now: number;
    errorMessage: string;
  }): void {
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
      schedule: record.schedule,
      scheduleSummary: record.scheduleSummary,
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
          payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        JSON.stringify(payload),
      );
  }

  private upsertRun(
    run: AutomationRunSummary,
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
      errorMessage: run.errorMessage,
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
          payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          status = excluded.status,
          scheduled_for = excluded.scheduled_for,
          queued_at = excluded.queued_at,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          backend_turn_id = excluded.backend_turn_id,
          queue_entry_id = excluded.queue_entry_id,
          updated_at = excluded.updated_at,
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
        JSON.stringify(payload),
      );
  }

  private recordFromRow(row: AutomationRow): AutomationRecord | undefined {
    const payload = parseJson<AutomationPayload>(row.payload);
    if (!payload) return undefined;
    return {
      id: row.automation_id,
      backend: row.backend,
      threadId: row.thread_id,
      name: row.name,
      taskPrompt: payload.taskPrompt,
      status: row.status,
      schedule: payload.schedule,
      scheduleSummary: payload.scheduleSummary,
      backlogPolicy: row.backlog_policy,
      nextRunAt: row.next_run_at ?? undefined,
      lastRunAt: row.last_run_at ?? undefined,
      lastRunStatus: payload.lastRunStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at ?? undefined,
    };
  }

  private runFromRow(row: AutomationRunRow): AutomationRunSummary | undefined {
    const payload = parseJson<AutomationRunPayload>(row.payload);
    if (!payload) return undefined;
    return {
      id: row.run_id,
      automationId: row.automation_id,
      trigger: row.trigger,
      status: row.status,
      scheduledFor: row.scheduled_for ?? undefined,
      scheduledWindows: payload.scheduledWindows,
      queuedAt: row.queued_at ?? undefined,
      queueEntryId: row.queue_entry_id ?? undefined,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      backendTurnId: row.backend_turn_id ?? undefined,
      errorMessage: payload.errorMessage,
    };
  }

  private getRunRow(runId: string): AutomationRunRow | undefined {
    return this.stateDb.raw
      .prepare("SELECT * FROM automation_runs WHERE run_id = ?")
      .get(runId) as AutomationRunRow | undefined;
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

  private pruneRuns(automationId: string): void {
    this.stateDb.raw
      .prepare(
        `DELETE FROM automation_runs
         WHERE automation_id = ?
           AND run_id IN (
             SELECT run_id FROM automation_runs
             WHERE automation_id = ?
             ORDER BY updated_at DESC, rowid DESC
             LIMIT -1 OFFSET ?
           )`,
      )
      .run(automationId, automationId, this.runHistoryLimit);
  }

  private get runHistoryLimit(): number {
    return this.options.runHistoryLimit ?? DEFAULT_RUN_HISTORY_LIMIT;
  }
}

function parseJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
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
