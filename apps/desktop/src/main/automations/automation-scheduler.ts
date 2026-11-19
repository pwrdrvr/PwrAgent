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
import {
  computeNextAutomationRunAt,
  collectDueAutomationWindows,
} from "./automation-schedule.js";
import { getMainLogger } from "../log.js";
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
  /**
   * Ends runs whose owning process is proved dead and returns the
   * automations whose running run that freed. Only the process that ended a
   * run starts the next one in its lane, as with a turn that finishes.
   */
  releaseDeadOwnerRuns?: () => string[];
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

export class AutomationScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private dispatchPauseCount = 0;
  private readonly sessionStartedAt: number;
  private readonly coalesceWindows = new Map<string, InboundCoalesceWindow>();
  /**
   * A run can reach terminal state through both the captured assistant-final
   * fast path and the later backend lifecycle notification. Those handlers may
   * race while releasing the same automation lane. Claim the queued successor
   * before its async submission so one durable run never launches twice.
   */
  private readonly startingPendingRunIds = new Set<string>();

  constructor(private readonly options: AutomationSchedulerOptions) {
    this.sessionStartedAt = this.now();
  }

  start(): void {
    if (this.running) {
      this.scheduleNextTimer();
      return;
    }
    this.running = true;
    this.scheduleNextTimer();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    for (const open of this.coalesceWindows.values()) {
      this.clearTimer(open.timer);
    }
    this.coalesceWindows.clear();
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
    const run = this.options.store.createRun({
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
    const run = this.options.store.createRun({
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
    const createInboundRun = (recoverOnRestart: boolean) =>
      this.options.store.createRun({
        automationId: params.automation.id,
        trigger: "inbound_message",
        recoverOnRestart,
        scheduledWindows: [],
        source: params.source,
        now,
      });

    // drop_missed + busy lane records a visible skipped run but starts no
    // headless turn, so it must NOT count toward the rate.
    if (active && params.automation.backlogPolicy === "drop_missed") {
      this.recordInboundSkip(() => createInboundRun(false), {
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

    const run = createInboundRun(true);
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
    if (!automation || automation.status !== "enabled") return;
    const [primary, ...rest] = open.sources;
    if (!primary) return;
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
    automationSchedulerLog.info("inbound automation run throttled by rate limit", {
      automationId: automation.id,
      automationName: automation.name,
      maxRunsPerHour: resolveAutomationRunsPerHour(automation.maxRunsPerHour),
    });

    // Coalesce every drop in this wall-clock hour onto one deterministic marker,
    // found by primary key (no scan). A bounded count — not a per-message key
    // list — records the size of the drop. The provider adapters already ack and
    // dedupe inbound events, so a throttled message is not redelivered to the
    // scheduler and no per-drop idempotency is needed here.
    const markerId = throttleMarkerId(automation.id, now);
    const existing = this.options.store.getRun(markerId);
    const droppedCount = (existing?.coalescedCount ?? 0) + 1;
    if (existing) {
      this.options.store.coalesceRateLimitedRun({
        runId: markerId,
        coalescedCount: droppedCount,
        errorMessage: throttleSkipMessage(droppedCount),
        now,
      });
      return;
    }
    const created = this.options.store.createRun({
      id: markerId,
      automationId: automation.id,
      trigger: "inbound_message",
      source,
      now,
    });
    if (!created) return;
    this.options.store.markRunTerminal({
      runId: markerId,
      status: "skipped",
      skipReason: "rate_limited",
      errorMessage: throttleSkipMessage(droppedCount),
      completedAt: now,
      coalescedCount: droppedCount,
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
    const run = this.options.store.commitScheduledEvaluation({
      automationId: automation.id,
      dueAt: automation.nextRunAt,
      nextRunAt: schedule ? computeNextAutomationRunAt(schedule, now) : null,
      now,
    }, () => this.recordScheduledWindows(automation, windows, now));
    if (run) {
      await this.submitRun({ automation, runId: run.id, windows: run.scheduledWindows, now });
    }
  }

  /** Record the backlog decision inside the schedule advance transaction. */
  private recordScheduledWindows(
    automation: AutomationRecord,
    windows: AutomationRunWindow[],
    now: number,
  ): AutomationRunSummary | undefined {
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

    const run = store.createRun({
      automationId: automation.id,
      trigger: "scheduled",
      recoverOnRestart: true,
      scheduledWindows: dropMissed ? [first] : windows,
      now,
    });
    if (!run || !active) return run;
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
    if (!run) return undefined;

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

    try {
      const gateResult = await this.runGateIfNeeded({
        automation: params.automation,
        runId: params.runId,
        now: params.now,
      });
      if (gateResult?.status === "skip" || gateResult?.status === "failed") {
        return undefined;
      }
      // A gate can outlive the moment quit quiescing begins. Nothing awaits
      // between this check and provider submission, so another main-process
      // event cannot pause dispatch after this check and before submission.
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
      const priorRuns = this.collectPriorRunContext(params.automation, run.id, params.now);
      // Commit the running state before calling the provider. A missing
      // acknowledgement is ambiguous and must never cause a replay.
      const claimed = this.options.store.claimRunForDispatch(run.id, Math.max(params.now, this.now()));
      if (!claimed) {
        const current = this.options.store.getRun(run.id);
        if (current?.status !== "pending" && current?.status !== "queued") return undefined;
        return buildLaneQueuedResult({ run: current, position: 1 });
      }
      const result = await this.options.runner.submitRun({
        automation: params.automation,
        gateResult,
        priorRuns,
        run: claimed,
      });
      this.options.store.markRunStarted({
        runId: params.runId,
        backendThreadId: result.backendThreadId,
        backendTurnId: result.turnId,
        queueEntryId: result.queueEntryId,
        startedAt: params.now,
        now: params.now,
      });
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
    this.options.store.disarmRunRestartRecovery(params.runId, params.now);
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
    while (this.dispatchPauseCount === 0) {
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
      .filter((automation) => automation.status === "enabled")
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
