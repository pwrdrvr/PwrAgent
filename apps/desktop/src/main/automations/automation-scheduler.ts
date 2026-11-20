import type {
  AutomationPriorRunContext,
  AutomationRunSourceBatchedEntry,
  AutomationGateRunResult,
  AutomationRunSkipReason,
  AutomationRunSourceMetadata,
  AutomationRunStatus,
  AutomationRunSummary,
  AutomationRunWindow,
} from "@pwragent/shared";
import {
  DEFAULT_AUTOMATION_INBOUND_COALESCE_WINDOW_MS,
  resolveAutomationRunsPerHour,
} from "@pwragent/shared";
import type { CreateAutomationRunInput } from "@pwragent/owner-core/automation-storage";
import {
  computeNextAutomationRunAt,
  collectDueAutomationWindows,
} from "./automation-schedule.js";
import { getMainLogger } from "../log.js";
import { RUNTIME_LEASE_RETRY_MS } from "../runtime-lease-retry.js";
import type { AutomationGateRunner } from "./automation-gate-runner.js";
import type {
  AutomationRunner,
  AutomationRunSubmissionResult,
} from "./automation-runner.js";
import type { AutomationRecord, AutomationStorage } from "@pwragent/owner-core/automation-storage";

const automationSchedulerLog = getMainLogger("pwragent:automation-scheduler");

export type AutomationSchedulerOptions = {
  store: AutomationStorage;
  runner: AutomationRunner;
  gateRunner?: AutomationGateRunner;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  admitResumedRun?: () => boolean;
  /**
   * Ends runs whose owning process is proved dead and returns the
   * automations whose running run that freed. Only the process that ended a
   * run starts the next one in its lane, as with a turn that finishes.
   */
  releaseDeadOwnerRuns?: () => string[];
  /**
   * A trigger found the automation at its daily run limit, and the scheduler
   * paused it. Called once per pause, after the skipped trigger is recorded.
   */
  onDailyLimitReached?: (params: {
    automation: AutomationRecord;
    limit: number;
    runsInWindow: number;
    skippedRunId: string;
  }) => Promise<void> | void;
  /**
   * A run passed its timeout and was failed as `timed_out`, and its turn was
   * asked to stop. Reports it the way any failed run is reported.
   */
  onRunTimedOut?: (run: AutomationRunSummary) => Promise<void> | void;
};

type DailyLimitNotice = Parameters<NonNullable<AutomationSchedulerOptions["onDailyLimitReached"]>>[0];

type RunAdmissionResult = {
  run?: AutomationRunSummary;
  dailyLimitNotice?: DailyLimitNotice;
};

type InboundCoalesceWindow = {
  timer: ReturnType<typeof setTimeout>;
  sources: AutomationRunSourceMetadata[];
  totalChars: number;
};

const MAX_COALESCED_EVENTS = 100;
const COALESCE_TOTAL_CHAR_BUDGET = 16_000;
const COALESCE_SUMMARY_CHARS = 500;
const HOUR_MS = 60 * 60 * 1000;
/**
 * A failed evaluation leaves its window due. Re-arming at that past time
 * would fire again at once, so the next attempt waits this long.
 */
export const AUTOMATION_EVALUATION_RETRY_MS = 60 * 1000;

// Throttled inbound drops coalesce onto one visible skipped run per automation
// per wall-clock hour. The run id is derived deterministically from the hour
// bucket so a burst is found with an O(1) primary-key lookup (no scan) and can
// never flood the run history: at most one marker per automation per hour.
const THROTTLE_MARKER_PREFIX = "automation-throttle:";

function throttleMarkerId(automationId: string, now: number): string {
  return `${THROTTLE_MARKER_PREFIX}${automationId}:${Math.floor(now / HOUR_MS)}`;
}

export function throttleSkipMessage(droppedCount: number): string {
  const noun = droppedCount === 1 ? "message" : "messages";
  return `The automation hit its hourly run limit; ${droppedCount} inbound ${noun} dropped this hour.`;
}

// Triggers that arrive while the daily run limit holds an automation paused
// coalesce onto one skipped run per pause, named by the pause's time, so a
// busy trigger cannot flood the run history while the operator is away.
const DAILY_LIMIT_MARKER_PREFIX = "automation-daily-limit:";
/**
 * A skip marker's count is rewritten at most this often. This covers the
 * daily-limit marker and the hourly throttle marker. The first skip onto a
 * marker is written at once; later ones wait in memory. A channel flooding an
 * automation then costs at most one commit a minute per marker (~47 MB/day at
 * the measured ~33 KB a commit) instead of one per message. A crash loses
 * only the count of the last minute's skips.
 */
export const SKIP_MARKER_FLUSH_MS = 60 * 1000;

function dailyLimitMarkerId(automationId: string, pausedAt: number): string {
  return `${DAILY_LIMIT_MARKER_PREFIX}${automationId}:${pausedAt}`;
}

export function dailyLimitSkipMessage(limit: number | undefined, skippedCount: number): string {
  const runs = limit === undefined ? "its daily run limit" : `its daily run limit of ${limit}`;
  const noun = skippedCount === 1 ? "trigger" : "triggers";
  return `The automation reached ${runs} in the last 24 hours and was paused; ${skippedCount} ${noun} skipped.`;
}

export function runTimeoutMessage(timeoutMs: number): string {
  const minutes = Math.round(timeoutMs / 60_000);
  const span = minutes % 60 === 0
    ? `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`
    : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  return `Timed out: the run passed its ${span} limit and was stopped.`;
}

/** A skip marker's count that has not been written yet. */
type PendingSkipCount = {
  count: number;
  skipReason: AutomationRunSkipReason;
  message: (count: number) => string;
  timer?: ReturnType<typeof setTimeout>;
};

export class AutomationScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private dispatchPauseCount = 0;
  private readonly pausedDispatchWaiters = new Set<(proceed: boolean) => void>();
  private readonly leaseBlockedLanes = new Set<string>();
  private providerRetryTimer?: ReturnType<typeof setTimeout>;
  private readonly sessionStartedAt: number;
  private readonly coalesceWindows = new Map<string, InboundCoalesceWindow>();
  /**
   * A run can reach terminal state through both the captured assistant-final
   * fast path and the later backend lifecycle notification. Those handlers may
   * race while releasing the same automation lane. Claim the queued successor
   * before its async submission so one durable run never launches twice.
   */
  private readonly startingPendingRunIds = new Set<string>();
  /** Skip counts waiting for their marker's next write, by marker run id. */
  private readonly pendingSkipCounts = new Map<string, PendingSkipCount>();
  /** Timeout timers of runs this process started, by run id. */
  private readonly runTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: AutomationSchedulerOptions) {
    this.sessionStartedAt = this.now();
  }

  start(): void {
    this.stopped = false;
    if (this.running) {
      this.scheduleNextTimer();
      return;
    }
    this.running = true;
    this.scheduleNextTimer();
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    clearTimeout(this.providerRetryTimer);
    this.providerRetryTimer = undefined;
    this.leaseBlockedLanes.clear();
    this.releasePausedDispatchWaiters(false);
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    for (const open of this.coalesceWindows.values()) {
      this.clearTimer(open.timer);
    }
    this.coalesceWindows.clear();
    for (const timer of this.runTimeouts.values()) {
      this.clearTimer(timer);
    }
    this.runTimeouts.clear();
    for (const markerId of [...this.pendingSkipCounts.keys()]) {
      this.flushSkipCount(markerId, this.now());
    }
  }

  /**
   * Hold new launches while the operator decides whether to quit. Existing
   * turns continue, and triggers still become queued runs so staying open can
   * resume them without losing inbound work. Startup can recover a queued
   * run that has never begun execution.
   */
  quiesceDispatch(): () => Promise<void> {
    this.dispatchPauseCount += 1;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.dispatchPauseCount = Math.max(0, this.dispatchPauseCount - 1);
      if (this.dispatchPauseCount > 0) return;
      this.releasePausedDispatchWaiters(true);
      this.scheduleProviderRetry();
      this.scheduleNextTimer();
      await this.resumePendingRuns();
    };
  }

  async evaluateDueAutomations(): Promise<void> {
    const now = this.now();
    // The timer calls this without awaiting it: no failure may escape, stop
    // another automation, or leave the timer unarmed.
    let failed = false;
    const logFailure = (message: string, error: unknown, automationId?: string) => {
      failed = true;
      automationSchedulerLog.warn(message, {
        automationId,
        error: error instanceof Error ? error.message : String(error),
      });
    };
    try {
      try {
        // A run whose instance died would otherwise hold its lane until a
        // restart: nothing else reports that its turn ended.
        for (const automationId of this.options.releaseDeadOwnerRuns?.() ?? []) {
          await this.startNextPendingRun(automationId, now);
        }
      } catch (error) {
        logFailure("automation dead-owner release failed", error);
      }
      const dueAutomations = this.options.store.listEnabledDueAutomations(now);
      for (const automation of dueAutomations) {
        try {
          await this.evaluateAutomation(automation, now);
        } catch (error) {
          logFailure("automation schedule evaluation failed", error, automation.id);
        }
      }
      for (const automation of this.options.store.listDailyLimitPausedAutomations()) {
        if (automation.nextRunAt === undefined || automation.nextRunAt > now) continue;
        try {
          this.skipScheduleWhilePaused(automation, now);
        } catch (error) {
          logFailure("automation schedule evaluation failed", error, automation.id);
        }
      }
    } catch (error) {
      logFailure("automation schedule evaluation failed", error);
    } finally {
      this.scheduleNextTimer(failed ? AUTOMATION_EVALUATION_RETRY_MS : 0);
    }
  }

  async runNow(
    automationId: string,
    now = this.now(),
  ): Promise<AutomationRunSubmissionResult | undefined> {
    const automation = this.options.store.getAutomation(automationId);
    if (!automation) return undefined;
    const active = this.options.store.findActiveRunForAutomation(automationId);
    const run = await this.admitRun(automation, {
      automationId,
      trigger: "manual",
      recoverOnRestart: true,
      scheduledWindows: [],
      now,
    });
    if (!run) return undefined;
    if (active) {
      const queued = this.options.store.markRunQueued({
        runId: run.id,
        queueEntryId: buildLaneQueueEntryId(run.id),
        queuedAt: now,
        now,
      });
      return buildLaneQueuedResult({
        run: queued ?? run,
        position: 1,
      });
    }
    return await this.submitRun({ automation, runId: run.id, windows: [], now });
  }

  /**
   * Operator-initiated replay of a captured message. Deliberately a MANUAL
   * run that carries the message as its source: it bypasses the inbound rate
   * limit, coalescing, and source-event dedupe (all of which exist to police
   * unattended traffic, not an operator pressing a button), while the prompt
   * still receives the message exactly as an inbound run would.
   */
  async replayInboundRun(params: {
    automation: AutomationRecord;
    source: AutomationRunSourceMetadata;
    now?: number;
  }): Promise<AutomationRunSubmissionResult | undefined> {
    const now = params.now ?? this.now();
    const automation = params.automation;
    const active = this.options.store.findActiveRunForAutomation(automation.id);
    const run = await this.admitRun(automation, {
      automationId: automation.id,
      trigger: "manual",
      recoverOnRestart: true,
      scheduledWindows: [],
      source: params.source,
      now,
    });
    if (!run) return undefined;
    if (active) {
      const queued = this.options.store.markRunQueued({
        runId: run.id,
        queueEntryId: buildLaneQueueEntryId(run.id),
        queuedAt: now,
        now,
      });
      return buildLaneQueuedResult({ run: queued ?? run, position: 1 });
    }
    return await this.submitRun({ automation, runId: run.id, windows: [], now });
  }

  async runFromInboundEvent(params: {
    automation: AutomationRecord;
    source: AutomationRunSourceMetadata;
    now?: number;
  }): Promise<AutomationRunSubmissionResult | undefined> {
    const now = params.now ?? this.now();
    const windowMs =
      params.automation.inboundCoalesceWindowMs ??
      DEFAULT_AUTOMATION_INBOUND_COALESCE_WINDOW_MS;

    if (windowMs > 0) {
      const open = this.coalesceWindows.get(params.automation.id);
      if (open) {
        // A window is already collecting follow-ups: batch this message into it
        // (deduped, capped) and fire nothing now. The window timer flushes one
        // coalesced run when it elapses.
        if (
          !this.options.store.findRunBySourceEventKey({
            automationId: params.automation.id,
            sourceEventKey: params.source.sourceEventKey,
          })
        ) {
          appendCoalesceSource(open, params.source);
        }
        return undefined;
      }
      // Leading edge: open an empty window for any follow-ups, then fire this
      // first message immediately. dispatchInboundRun applies the rate limit.
      this.openCoalesceWindow(params.automation, windowMs);
    }

    return await this.dispatchInboundRun({
      automation: params.automation,
      source: params.source,
      now,
    });
  }

  private async dispatchInboundRun(params: {
    automation: AutomationRecord;
    source: AutomationRunSourceMetadata;
    now: number;
  }): Promise<AutomationRunSubmissionResult | undefined> {
    const { now } = params;
    // Idempotency: a provider can redeliver the same event (slow ack, retry),
    // and an automation with two triggers can match one message twice. If a run
    // already exists for this stable source-event key, skip — before consuming a
    // rate-limit token — rather than launch a duplicate or burn budget on a
    // no-op.
    const existing = this.options.store.findRunBySourceEventKey({
      automationId: params.automation.id,
      sourceEventKey: params.source.sourceEventKey,
    });
    if (existing) {
      return undefined;
    }
    const active = this.options.store.findActiveRunForAutomation(params.automation.id);
    const inboundRun: CreateAutomationRunInput = {
      automationId: params.automation.id,
      trigger: "inbound_message",
      scheduledWindows: [],
      source: params.source,
      now,
    };
    const createInboundRun = () => this.options.store.createRun(inboundRun);

    // drop_missed + busy lane records a visible skipped run but starts no
    // headless turn, so it must NOT count toward the rate.
    if (active && params.automation.backlogPolicy === "drop_missed") {
      this.recordInboundSkip(createInboundRun, {
        skipReason: "lane_busy",
        errorMessage:
          "The automation execution lane was busy when this inbound message arrived.",
        now,
      });
      return undefined;
    }

    // The run will start now (lane free) or queue (coalesce backlog) and start
    // later. Gate here, AFTER the idempotency and drop_missed checks, so only
    // runs that actually start count toward the hourly rate. Throttled messages
    // record a skipped run so the drop is visible in the run list; because it is
    // skipped it does not count toward the rate (see countRecentInboundRuns).
    if (!this.isInboundRunWithinRate(params.automation, now)) {
      this.noteThrottledInboundRun(params.automation, params.source, now);
      return undefined;
    }

    const run = await this.admitRun(params.automation, { ...inboundRun, recoverOnRestart: true });
    if (!run) return undefined;

    if (active) {
      const queued = this.options.store.markRunQueued({
        runId: run.id,
        queueEntryId: buildLaneQueueEntryId(run.id),
        queuedAt: now,
        now,
      });
      return buildLaneQueuedResult({
        run: queued ?? run,
        position: 1,
      });
    }

    return await this.submitRun({
      automation: params.automation,
      runId: run.id,
      windows: [],
      now,
    });
  }

  private openCoalesceWindow(automation: AutomationRecord, windowMs: number): void {
    const timer = this.setTimer(() => {
      void this.flushCoalesceWindow(automation.id);
    }, windowMs);
    timer.unref?.();
    this.coalesceWindows.set(automation.id, {
      timer,
      sources: [],
      totalChars: 0,
    });
  }

  private async flushCoalesceWindow(automationId: string): Promise<void> {
    const open = this.coalesceWindows.get(automationId);
    this.coalesceWindows.delete(automationId);
    if (!open || open.sources.length === 0) return;
    const automation = this.options.store.getAutomation(automationId);
    if (!automation) return;
    const [primary, ...rest] = open.sources;
    if (!primary) return;
    if (automation.pausedReason === "daily_run_limit") {
      // Batched while the daily run limit paused the automation: each message
      // is recorded as skipped, not dropped.
      for (const source of open.sources) {
        this.recordSkipWhilePaused(automation, { trigger: "inbound_message", source });
      }
      return;
    }
    if (automation.status !== "enabled") return;
    const source: AutomationRunSourceMetadata =
      rest.length > 0
        ? {
            ...primary,
            batchedEvents: rest.map((entry) => toBatchedEntry(entry, primary)),
          }
        : primary;
    // dispatchInboundRun applies the rate limit; an over-rate flush drops the
    // (already-merged) batch as a single throttled run.
    await this.dispatchInboundRun({ automation, source, now: this.now() });
  }

  /**
   * Whether starting an inbound run for this automation now stays within its
   * configured hourly cap. Counts inbound runs from the last hour in the run
   * history (excluding skipped runs, which never started a headless turn), so
   * the limit is a true rolling-hour cap that survives process restarts.
   * Unlimited automations always pass.
   */
  private isInboundRunWithinRate(
    automation: AutomationRecord,
    now: number,
  ): boolean {
    const ratePerHour = resolveAutomationRunsPerHour(automation.maxRunsPerHour);
    if (ratePerHour === null) {
      return true;
    }
    const recent = this.options.store.countRecentInboundRuns({
      automationId: automation.id,
      sinceMs: now - HOUR_MS,
    });
    return recent < ratePerHour;
  }

  private noteThrottledInboundRun(
    automation: AutomationRecord,
    source: AutomationRunSourceMetadata,
    now: number,
  ): void {
    // Coalesce every drop in this wall-clock hour onto one deterministic marker,
    // found by primary key (no scan). A bounded count — not a per-message key
    // list — records the size of the drop. The provider adapters already ack and
    // dedupe inbound events, so a throttled message is not redelivered to the
    // scheduler and no per-drop idempotency is needed here.
    const markerId = throttleMarkerId(automation.id, now);
    const existing = this.options.store.getRun(markerId);
    // The hour's first drop is logged at info; a flood's later drops at debug.
    const throttled = {
      automationId: automation.id,
      automationName: automation.name,
      maxRunsPerHour: resolveAutomationRunsPerHour(automation.maxRunsPerHour),
    };
    if (existing) {
      automationSchedulerLog.debug("inbound automation run throttled by rate limit", throttled);
      this.coalesceSkipOntoMarker(existing, {
        skipReason: "rate_limited",
        message: throttleSkipMessage,
        now,
      });
      return;
    }
    automationSchedulerLog.info("inbound automation run throttled by rate limit", throttled);
    // One commit: the marker is created already skipped.
    this.options.store.createRun({
      id: markerId,
      automationId: automation.id,
      trigger: "inbound_message",
      status: "skipped",
      skipReason: "rate_limited",
      source,
      completedAt: now,
      coalescedCount: 1,
      errorMessage: throttleSkipMessage(1),
      now,
    });
  }

  /**
   * Record a dropped inbound message as a visible `skipped` run (which never
   * started a headless turn, so it does not count toward the hourly rate). The
   * structured `skipReason` lets callers tell drop kinds apart without matching
   * display copy.
   */
  private recordInboundSkip(
    createInboundRun: () => AutomationRunSummary | undefined,
    opts: {
      skipReason: AutomationRunSkipReason;
      errorMessage: string;
      now: number;
    },
  ): void {
    const dropped = createInboundRun();
    if (!dropped) return;
    this.options.store.markRunTerminal({
      runId: dropped.id,
      status: "skipped",
      completedAt: opts.now,
      errorMessage: opts.errorMessage,
      skipReason: opts.skipReason,
      now: opts.now,
    });
  }

  async handleTurnQueueUpdate(params: {
    automationRunId?: string;
    status: "queued" | "started" | "failed" | "cancelled" | "terminal";
    terminalStatus?: string;
    backendThreadId?: string;
    turnId?: string;
    errorMessage?: string;
    now?: number;
  }): Promise<void> {
    if (!params.automationRunId) return;
    if (params.status === "queued") return;
    const now = params.now ?? this.now();
    const currentRun = this.options.store.getRun(params.automationRunId);
    if (params.status === "started" && params.turnId) {
      this.options.store.markRunStarted({
        runId: params.automationRunId,
        backendThreadId: params.backendThreadId,
        backendTurnId: params.turnId,
        startedAt: now,
        now,
      });
      return;
    }
    if (params.status === "failed" || params.status === "cancelled") {
      this.clearRunTimeout(params.automationRunId);
      // Already ended (a timeout, or the other of two terminal reports): the
      // process that ended it already started the lane's next run.
      if (currentRun && isTerminalRunStatus(currentRun.status)) return;
      this.options.store.markRunTerminal({
        runId: params.automationRunId,
        status: params.status === "failed" ? "failed" : "cancelled",
        errorMessage: params.errorMessage,
        completedAt: now,
        now,
      });
      await this.startNextPendingRun(currentRun?.automationId, now);
      return;
    }
    if (params.status === "terminal") {
      this.clearRunTimeout(params.automationRunId);
      if (currentRun && isTerminalRunStatus(currentRun.status)) return;
      const terminalStatus = classifyTerminalStatus(params.terminalStatus);
      this.options.store.markRunTerminal({
        runId: params.automationRunId,
        status: terminalStatus,
        errorMessage:
          terminalStatus === "completed" ? undefined : params.terminalStatus,
        completedAt: now,
        now,
      });
      await this.startNextPendingRun(currentRun?.automationId, now);
    }
  }

  private async evaluateAutomation(
    automation: AutomationRecord,
    now: number,
  ): Promise<void> {
    const schedule = automation.schedule;
    const windows = schedule ? collectDueAutomationWindows({
      schedule,
      firstDueAt: Math.max(automation.nextRunAt ?? now, this.sessionStartedAt),
      through: now,
    }) : [];
    const evaluation = this.options.store.commitScheduledEvaluation({
      automationId: automation.id,
      dueAt: automation.nextRunAt,
      nextRunAt: schedule ? computeNextAutomationRunAt(schedule, now) : null,
      now,
    }, () => this.recordScheduledWindows(automation, windows, now));
    if (evaluation?.dailyLimitNotice) {
      await this.options.onDailyLimitReached?.(evaluation.dailyLimitNotice);
    }
    const run = evaluation?.run;
    if (run) {
      await this.submitRun({ automation, runId: run.id, windows: run.scheduledWindows, now });
    }
  }

  /** Record the backlog decision inside the schedule advance transaction. */
  private recordScheduledWindows(
    automation: AutomationRecord,
    windows: AutomationRunWindow[],
    now: number,
  ): RunAdmissionResult | undefined {
    const first = windows[0];
    if (!first) return undefined;

    const store = this.options.store;
    const active = store.findActiveRunForAutomation(automation.id);
    const dropMissed = automation.backlogPolicy === "drop_missed";
    if (dropMissed && active) {
      store.createRun({
        automationId: automation.id,
        trigger: "scheduled",
        status: "skipped",
        scheduledWindows: [first],
        completedAt: now,
        errorMessage:
          windows.length === 1
            ? "The automation execution lane was busy when this schedule fired."
            : `Dropped ${windows.length} missed schedule windows because the automation execution lane was busy.`,
        now,
      });
      return undefined;
    }
    if (!dropMissed && store.findPendingScheduledRun(automation.id)) {
      // The run builds its input from the merged windows when it starts.
      store.coalescePendingScheduledRun({
        automationId: automation.id,
        scheduledWindows: windows,
        now,
      });
      return undefined;
    }

    const evaluation = this.recordRunAdmission(automation, {
      automationId: automation.id,
      trigger: "scheduled",
      recoverOnRestart: true,
      scheduledWindows: dropMissed ? [first] : windows,
      now,
    });
    const run = evaluation?.run;
    if (!run || !active) return evaluation;
    store.markRunQueued({
      runId: run.id,
      queueEntryId: buildLaneQueueEntryId(run.id),
      queuedAt: now,
      now,
    });
    return undefined;
  }

  private async submitRun(params: {
    automation: AutomationRecord;
    runId: string;
    windows: AutomationRunWindow[];
    now: number;
  }): Promise<AutomationRunSubmissionResult | undefined> {
    const run = this.options.store.getRun(params.runId);
    if (!run || this.stopped) return undefined;

    if (this.dispatchPauseCount > 0) {
      const queued = this.options.store.markRunQueued({
        runId: run.id,
        queueEntryId: run.queueEntryId ?? buildLaneQueueEntryId(run.id),
        queuedAt: params.now,
        now: params.now,
      });
      return buildLaneQueuedResult({
        run: queued ?? run,
        position: 1,
      });
    }

    // Admission can be denied during the previous provider owner's lease
    // grace period. Keep the run queued, with no execution claim or gate work.
    if (run.resumedAt !== undefined && !this.canDispatchResumedRun(run.automationId)) {
      return buildLaneQueuedResult({ run, position: 1 });
    }
    // The claim covers both the shell gate and the provider call. Either
    // can have side effects before acknowledging that work began.
    const claimed = this.options.store.claimRunForDispatch(run.id, Math.max(params.now, this.now()));
    if (!claimed) {
      const current = this.options.store.getRun(run.id);
      if (current?.status !== "pending" && current?.status !== "queued") return undefined;
      return buildLaneQueuedResult({ run: current, position: 1 });
    }
    try {
      const gateResult = await this.runGateIfNeeded({
        automation: params.automation,
        runId: params.runId,
        now: params.now,
      });
      if (gateResult?.status === "skip" || gateResult?.status === "failed") {
        return undefined;
      }
      // Hold the claimed lane across quit confirmation. If the operator
      // stays, continue with this gate result and never invoke the gate again.
      while (!this.stopped && this.dispatchPauseCount > 0) {
        const proceed = await new Promise<boolean>((resolve) => this.pausedDispatchWaiters.add(resolve));
        if (!proceed) return undefined;
      }
      if (this.stopped) return undefined;
      const priorRuns = this.collectPriorRunContext(params.automation, run.id, params.now);
      const result = await this.options.runner.submitRun({
        automation: params.automation,
        gateResult,
        priorRuns,
        run: claimed,
      });
      const started = this.options.store.markRunStarted({
        runId: params.runId,
        backendThreadId: result.backendThreadId,
        backendTurnId: result.turnId,
        queueEntryId: result.queueEntryId,
        startedAt: params.now,
        now: params.now,
      });
      // A turn can end before its submission is acknowledged; a run that is
      // already settled needs no timeout.
      if (started?.status === "running") {
        this.armRunTimeout(params.automation, params.runId);
      }
      const metadata = {
        automationId: params.automation.id,
        automationName: params.automation.name,
        backend: params.automation.backend,
        queueEntryId: result.queueEntryId,
        runId: params.runId,
        status: result.status,
        threadId: params.automation.threadId,
        turnId: result.turnId,
        windowCount: params.windows.length,
      };
      if (claimed.resumedAt === undefined) automationSchedulerLog.info("automation run submitted", metadata);
      else automationSchedulerLog.debug("resumed automation run submitted", metadata);
      return result;
    } catch (error) {
      automationSchedulerLog.warn("automation run submission failed", {
        automationId: params.automation.id,
        automationName: params.automation.name,
        backend: params.automation.backend,
        error: error instanceof Error ? error.message : String(error),
        runId: params.runId,
        threadId: params.automation.threadId,
        windowCount: params.windows.length,
      });
      const completedAt = Math.max(params.now, this.now());
      this.options.store.markRunTerminal({
        runId: params.runId,
        status: "failed",
        completedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
        now: completedAt,
      });
      return undefined;
    }
  }

  private releasePausedDispatchWaiters(proceed: boolean): void {
    for (const resolve of this.pausedDispatchWaiters) resolve(proceed);
    this.pausedDispatchWaiters.clear();
  }

  private canDispatchResumedRun(automationId: string): boolean {
    try {
      if (this.options.admitResumedRun?.() !== false) return true;
    } catch (error) {
      automationSchedulerLog.debug("automation provider admission unavailable", {
        automationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.leaseBlockedLanes.add(automationId);
    this.scheduleProviderRetry();
    return false;
  }

  private scheduleProviderRetry(): void {
    if (this.providerRetryTimer || this.stopped || this.dispatchPauseCount > 0 || this.leaseBlockedLanes.size === 0) return;
    this.providerRetryTimer = setTimeout(() => {
      this.providerRetryTimer = undefined;
      if (this.stopped || this.dispatchPauseCount > 0) return;
      const lanes = [...this.leaseBlockedLanes];
      this.leaseBlockedLanes.clear();
      for (const automationId of lanes) {
        void this.startNextQueuedRun(automationId).catch((error: unknown) => {
          automationSchedulerLog.warn("automation provider admission retry failed", {
            automationId,
            error: error instanceof Error ? error.message : String(error),
          });
          this.leaseBlockedLanes.add(automationId);
          this.scheduleProviderRetry();
        });
      }
    }, RUNTIME_LEASE_RETRY_MS);
    this.providerRetryTimer.unref?.();
  }

  /**
   * Assemble the prior-run history a new run may see, or undefined when the
   * automation has lookback off (`undefined` also suppresses the prompt
   * section entirely, so "no lookback" and "lookback found nothing" render
   * differently).
   *
   * Only completed runs qualify — a failed or skipped run has no outcome to
   * compare against, and including it would teach the prompt that "the
   * automation errored" is an event pattern.
   */
  private collectPriorRunContext(
    automation: AutomationRecord,
    currentRunId: string,
    now: number,
  ): AutomationPriorRunContext[] | undefined {
    const lookback = automation.priorRunLookback;
    if (!lookback) return undefined;
    const cutoff =
      lookback.maxAgeMs !== undefined ? now - lookback.maxAgeMs : undefined;
    const context: AutomationPriorRunContext[] = [];
    // Over-fetch (bounded) since non-completed runs are filtered out below.
    const candidates = this.options.store.listRunsForAutomation(
      automation.id,
      lookback.maxRuns * 3 + 5,
    );
    for (const run of candidates) {
      if (context.length >= lookback.maxRuns) break;
      if (run.id === currentRunId) continue;
      if (run.status !== "completed") continue;
      const completedAt = run.completedAt ?? run.startedAt;
      if (completedAt === undefined) continue;
      if (cutoff !== undefined && completedAt < cutoff) continue;
      const artifact = this.options.store.getRunArtifact?.(run.id);
      const decision = artifact?.outputDecision;
      context.push({
        completedAt,
        status: run.status,
        ...(decision?.summary
          ? { summary: decision.summary }
          : artifact?.finalText
            ? { summary: artifact.finalText }
            : {}),
        ...(decision?.details ? { details: decision.details } : {}),
      });
    }
    return context;
  }

  private async runGateIfNeeded(params: {
    automation: AutomationRecord;
    runId: string;
    now: number;
  }): Promise<AutomationGateRunResult | undefined> {
    if (!params.automation.gate || !this.options.gateRunner) return undefined;
    const gateResult = await this.options.gateRunner.runGate(params.automation.gate);
    if (gateResult.status === "proceed") {
      return gateResult;
    }
    const terminalStatus = gateResult.status === "skip" ? "skipped" : "failed";
    this.options.store.markRunTerminal({
      runId: params.runId,
      status: terminalStatus,
      completedAt: params.now,
      errorMessage:
        gateResult.status === "skip"
          ? "Automation gate skipped this run."
          : gateResult.errorMessage,
      now: params.now,
    });
    this.options.store.upsertRunArtifact({
      runId: params.runId,
      status: terminalStatus,
      errorMessage:
        gateResult.status === "failed" ? gateResult.errorMessage : undefined,
      outputDecision:
        gateResult.status === "skip"
          ? { kind: "quiet", summary: "Automation gate skipped this run." }
          : { kind: "post_card", summary: gateResult.errorMessage ?? "Gate failed." },
      transcriptEvents: [
        {
          id: `${params.runId}:gate`,
          at: params.now,
          kind: "gate",
          text: gateResult.output,
          metadata: {
            command: gateResult.command,
            cwd: gateResult.cwd,
            durationMs: gateResult.durationMs,
            exitCode: gateResult.exitCode,
            outputTruncated: gateResult.outputTruncated,
            status: gateResult.status,
          },
        },
      ],
      now: params.now,
    });
    return gateResult;
  }

  /**
   * Ask the store for a run. A refusal means the automation is at its daily
   * run limit: the trigger is recorded as skipped, the automation is paused,
   * and no run is returned.
   */
  private async admitRun(
    automation: AutomationRecord,
    input: CreateAutomationRunInput,
  ): Promise<AutomationRunSummary | undefined> {
    const evaluation = this.recordRunAdmission(automation, input);
    if (evaluation?.dailyLimitNotice) {
      await this.options.onDailyLimitReached?.(evaluation.dailyLimitNotice);
    }
    return evaluation?.run;
  }

  /** Record admission or a daily-limit pause before publishing its notice. */
  private recordRunAdmission(
    automation: AutomationRecord,
    input: CreateAutomationRunInput,
  ): RunAdmissionResult | undefined {
    const admission = this.options.store.admitRun(input);
    if (!admission) return undefined;
    if (admission.status === "admitted") return { run: admission.run };
    const now = input.now ?? this.now();
    automationSchedulerLog.info("automation run refused by its daily run limit", {
      automationId: automation.id,
      automationName: automation.name,
      dailyRunLimit: admission.limit,
      runsInWindow: admission.runsInWindow,
      trigger: input.trigger,
    });
    const pause = this.options.store.pauseAutomationForDailyLimit(automation.id, now);
    const current = pause?.automation ?? automation;
    const skipped = this.recordSkipWhilePaused(current, {
      trigger: input.trigger,
      source: input.source,
      scheduledWindows: input.scheduledWindows,
      now,
    });
    if (pause?.paused && skipped) {
      return {
        dailyLimitNotice: {
          automation: current,
          limit: admission.limit,
          runsInWindow: admission.runsInWindow,
          skippedRunId: skipped.id,
        },
      };
    }
    return undefined;
  }

  /**
   * Record a trigger that arrived while the daily run limit holds the
   * automation paused. Every such trigger of one pause shares one skipped run,
   * whose count grows.
   */
  recordSkipWhilePaused(
    automation: AutomationRecord,
    params: {
      trigger: CreateAutomationRunInput["trigger"];
      source?: AutomationRunSourceMetadata;
      scheduledWindows?: AutomationRunWindow[];
      now?: number;
    },
  ): AutomationRunSummary | undefined {
    const now = params.now ?? this.now();
    const markerId = dailyLimitMarkerId(automation.id, automation.pausedAt ?? now);
    const existing = this.options.store.getRun(markerId);
    if (existing) {
      const limit = automation.dailyRunLimit;
      return this.coalesceSkipOntoMarker(existing, {
        skipReason: "daily_limit",
        message: (count) => dailyLimitSkipMessage(limit, count),
        now,
      });
    }
    return this.options.store.createRun({
      id: markerId,
      automationId: automation.id,
      trigger: params.trigger,
      status: "skipped",
      skipReason: "daily_limit",
      source: params.source,
      scheduledWindows: params.scheduledWindows?.slice(0, 1) ?? [],
      completedAt: now,
      coalescedCount: 1,
      errorMessage: dailyLimitSkipMessage(automation.dailyRunLimit, 1),
      now,
    });
  }

  /**
   * Add one skip to a marker that already exists. The count is written at once
   * when the marker was last written at least SKIP_MARKER_FLUSH_MS ago;
   * otherwise it waits in memory for one timer that writes the whole window's
   * count.
   */
  private coalesceSkipOntoMarker(
    marker: AutomationRunSummary,
    params: {
      skipReason: AutomationRunSkipReason;
      message: (count: number) => string;
      now: number;
    },
  ): AutomationRunSummary {
    const { now } = params;
    const markerId = marker.id;
    const pending = this.pendingSkipCounts.get(markerId);
    const count = (pending?.count ?? marker.coalescedCount ?? 1) + 1;
    const writtenAt = marker.completedAt ?? now;
    const next: PendingSkipCount = {
      count,
      skipReason: params.skipReason,
      message: params.message,
      timer: pending?.timer,
    };
    this.pendingSkipCounts.set(markerId, next);
    if (Math.abs(now - writtenAt) >= SKIP_MARKER_FLUSH_MS) {
      return this.flushSkipCount(markerId, now) ?? marker;
    }
    if (!next.timer) {
      next.timer = this.setTimer(() => {
        this.flushSkipCount(markerId, this.now());
      }, Math.max(0, writtenAt + SKIP_MARKER_FLUSH_MS - now));
      next.timer.unref?.();
    }
    return marker;
  }

  private flushSkipCount(markerId: string, now: number): AutomationRunSummary | undefined {
    const pending = this.pendingSkipCounts.get(markerId);
    if (!pending) return undefined;
    this.pendingSkipCounts.delete(markerId);
    if (pending.timer) this.clearTimer(pending.timer);
    return this.options.store.coalesceRateLimitedRun({
      runId: markerId,
      coalescedCount: pending.count,
      errorMessage: pending.message(pending.count),
      skipReason: pending.skipReason,
      now,
    });
  }

  /** A paused automation's schedule still fires: each due window is a skip. */
  private skipScheduleWhilePaused(automation: AutomationRecord, now: number): void {
    if (!automation.schedule) {
      this.options.store.updateAutomation(automation.id, { nextRunAt: null, now });
      return;
    }
    const windows = collectDueAutomationWindows({
      schedule: automation.schedule,
      firstDueAt: Math.max(automation.nextRunAt ?? now, this.sessionStartedAt),
      through: now,
    });
    if (windows.length > 0) {
      this.recordSkipWhilePaused(automation, {
        trigger: "scheduled",
        scheduledWindows: windows,
        now,
      });
    }
    this.options.store.updateAutomation(automation.id, {
      nextRunAt: computeNextAutomationRunAt(automation.schedule, now),
      now,
    });
  }

  private armRunTimeout(automation: AutomationRecord, runId: string): void {
    const timeoutMs = automation.runTimeoutMs;
    if (timeoutMs === undefined) return;
    this.clearRunTimeout(runId);
    const timer = this.setTimer(() => {
      this.runTimeouts.delete(runId);
      void this.timeOutRun(runId, timeoutMs).catch((error: unknown) => {
        automationSchedulerLog.warn("automation run timeout failed", {
          automationId: automation.id,
          error: error instanceof Error ? error.message : String(error),
          runId,
        });
      });
    }, timeoutMs);
    timer.unref?.();
    this.runTimeouts.set(runId, timer);
  }

  private clearRunTimeout(runId: string): void {
    const timer = this.runTimeouts.get(runId);
    if (!timer) return;
    this.clearTimer(timer);
    this.runTimeouts.delete(runId);
  }

  /**
   * Fail a run that passed its timeout, then stop its turn. The run is failed
   * first, so the turn's own end, when it arrives, finds it settled and
   * cannot report it again or start a second successor.
   */
  private async timeOutRun(runId: string, timeoutMs: number): Promise<void> {
    const run = this.options.store.getRun(runId);
    if (run?.status !== "running") return;
    const now = this.now();
    const failed = this.options.store.markRunTerminal({
      runId,
      status: "failed",
      failureReason: "timed_out",
      errorMessage: runTimeoutMessage(timeoutMs),
      completedAt: now,
      now,
    });
    if (failed?.status !== "failed" || failed.failureReason !== "timed_out") return;
    const automation = this.options.store.getAutomation(run.automationId, {
      includeDeleted: true,
    });
    automationSchedulerLog.info("automation run timed out", {
      automationId: run.automationId,
      automationName: automation?.name,
      runId,
      timeoutMs,
      turnId: run.backendTurnId,
    });
    if (automation) {
      try {
        await this.options.runner.interruptRun?.({ automation, run: failed });
      } catch (error) {
        automationSchedulerLog.warn("automation run timeout could not stop its turn", {
          automationId: run.automationId,
          error: error instanceof Error ? error.message : String(error),
          runId,
        });
      }
    }
    await this.options.onRunTimedOut?.(failed);
    await this.startNextPendingRun(run.automationId, now);
  }

  /** Starts a lane's next run after this process ended its running run. */
  async startNextQueuedRun(automationId: string, adoptedRunIds?: ReadonlySet<string>): Promise<void> {
    await this.startNextPendingRun(automationId, this.now(), adoptedRunIds);
  }

  private async startNextPendingRun(
    automationId: string | undefined,
    now: number,
    adoptedRunIds?: ReadonlySet<string>,
  ): Promise<void> {
    if (!automationId) return;
    const automation = this.options.store.getAutomation(automationId);
    if (!automation) return;
    while (!this.stopped && this.dispatchPauseCount === 0) {
      if (this.options.store.findActiveRunForAutomation(automationId)?.status === "running") return;
      const pending = this.options.store.findPendingRunForAutomation(automationId);
      if (!pending || this.startingPendingRunIds.has(pending.id)) return;
      if (adoptedRunIds && !adoptedRunIds.has(pending.id)) return;
      this.startingPendingRunIds.add(pending.id);
      try {
        const result = await this.submitRun({
          automation,
          runId: pending.id,
          windows: pending.scheduledWindows,
          now,
        });
        // A rejected submission or gate can end this run without a provider
        // completion event to release the next queued run.
        if (result || this.options.store.findPendingRunForAutomation(automationId)?.id === pending.id) return;
      } finally {
        this.startingPendingRunIds.delete(pending.id);
      }
    }
  }

  private async resumePendingRuns(): Promise<void> {
    if (!this.running || this.dispatchPauseCount > 0) return;
    const now = this.now();
    for (const automation of this.options.store.listAutomations()) {
      await this.startNextPendingRun(automation.id, now);
    }
  }

  private scheduleNextTimer(minDelayMs = 0): void {
    if (!this.running) return;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const nextRunAt = this.options.store
      .listAutomations()
      .filter((automation) =>
        automation.status === "enabled"
        || automation.pausedReason === "daily_run_limit")
      .map((automation) => automation.nextRunAt)
      .filter((value): value is number => value !== undefined)
      .sort((left, right) => left - right)[0];
    if (nextRunAt === undefined) return;
    const delayMs = Math.max(minDelayMs, nextRunAt - this.now());
    this.timer = this.setTimer(() => {
      void this.evaluateDueAutomations();
    }, delayMs);
    this.timer.unref?.();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private setTimer(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    return this.options.setTimer?.(callback, delayMs) ?? setTimeout(callback, delayMs);
  }

  private clearTimer(timer: ReturnType<typeof setTimeout>): void {
    if (this.options.clearTimer) {
      this.options.clearTimer(timer);
      return;
    }
    clearTimeout(timer);
  }
}

function isTerminalRunStatus(status: AutomationRunStatus): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "skipped";
}

function classifyTerminalStatus(
  status: string | undefined,
): Extract<AutomationRunStatus, "completed" | "failed" | "cancelled"> {
  const normalized = status?.toLowerCase() ?? "";
  if (normalized.includes("fail") || normalized.includes("error")) {
    return "failed";
  }
  if (normalized.includes("cancel") || normalized.includes("interrupt")) {
    return "cancelled";
  }
  return "completed";
}

function buildLaneQueueEntryId(runId: string): string {
  return `automation-lane:${runId}`;
}

function appendCoalesceSource(
  window: InboundCoalesceWindow,
  source: AutomationRunSourceMetadata,
): void {
  if (window.sources.length >= MAX_COALESCED_EVENTS) return;
  if (
    window.sources.some((entry) => entry.sourceEventKey === source.sourceEventKey)
  ) {
    return;
  }
  // Once the batch nears its char budget, keep only a short summary of each
  // further message so a burst can't balloon the prompt/artifact.
  const bounded =
    window.totalChars >= COALESCE_TOTAL_CHAR_BUDGET * 0.8
      ? truncateSourceMessage(source, COALESCE_SUMMARY_CHARS)
      : source;
  window.sources.push(bounded);
  window.totalChars += bounded.message?.text?.length ?? 0;
}

function truncateSourceMessage(
  source: AutomationRunSourceMetadata,
  maxChars: number,
): AutomationRunSourceMetadata {
  const text = source.message?.text;
  if (!text || text.length <= maxChars) return source;
  return {
    ...source,
    message: { text: `${text.slice(0, maxChars)}…`, textTruncated: true },
  };
}

/**
 * A follow-up folded into the primary message's run. The window is per
 * automation, not per conversation, so with several watched conversations a
 * follow-up can come from a different one than the primary; it then keeps its
 * own conversation, or the prompt would present it as posted where the first
 * message was. Compared by the trigger that matched, not the raw conversation,
 * so a thread reply inside the same watched channel is not singled out.
 */
function toBatchedEntry(
  source: AutomationRunSourceMetadata,
  primary: AutomationRunSourceMetadata,
): AutomationRunSourceBatchedEntry {
  return {
    sourceEventKey: source.sourceEventKey,
    receivedAt: source.receivedAt,
    actor: source.actor,
    ...(source.message ? { message: source.message } : {}),
    ...(source.matchedTriggerId === primary.matchedTriggerId
      ? {}
      : { conversation: source.conversation }),
  };
}

function buildLaneQueuedResult(params: {
  position: number;
  run: {
    id: string;
  };
}): AutomationRunSubmissionResult {
  return {
    status: "queued",
    queueEntryId: buildLaneQueueEntryId(params.run.id),
    position: params.position,
  };
}
