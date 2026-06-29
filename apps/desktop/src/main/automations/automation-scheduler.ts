import type {
  AutomationRunSourceBatchedEntry,
  AutomationGateRunResult,
  AutomationRunSourceMetadata,
  AutomationRunStatus,
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
import type { AutomationRunner } from "./automation-runner.js";
import type { AutomationRecord, AutomationStore } from "./automation-store.js";

const automationSchedulerLog = getMainLogger("pwragent:automation-scheduler");

export type AutomationSchedulerOptions = {
  store: AutomationStore;
  runner: AutomationRunner;
  gateRunner?: AutomationGateRunner;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

type InboundCoalesceWindow = {
  timer: ReturnType<typeof setTimeout>;
  sources: AutomationRunSourceMetadata[];
  totalChars: number;
};

/**
 * Per-automation token bucket gating inbound run STARTS. `tokens` refills
 * continuously toward the configured hourly rate; capacity equals the rate, so
 * an idle automation can burst up to one hour's allowance and then settles to
 * the steady rate.
 */
type RunStartTokenBucket = { tokens: number; lastRefillAt: number };

const MAX_COALESCED_EVENTS = 100;
const COALESCE_TOTAL_CHAR_BUDGET = 16_000;
const COALESCE_SUMMARY_CHARS = 500;
const HOUR_MS = 60 * 60 * 1000;

export class AutomationScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly sessionStartedAt: number;
  private readonly coalesceWindows = new Map<string, InboundCoalesceWindow>();
  private readonly runStartTokenBuckets = new Map<string, RunStartTokenBucket>();

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

  async evaluateDueAutomations(): Promise<void> {
    const now = this.now();
    const dueAutomations = this.options.store.listEnabledDueAutomations(now);
    for (const automation of dueAutomations) {
      await this.evaluateAutomation(automation, now);
    }
    this.scheduleNextTimer();
  }

  async runNow(
    automationId: string,
    now = this.now(),
  ): Promise<Awaited<ReturnType<AutomationRunner["submitRun"]>> | undefined> {
    const automation = this.options.store.getAutomation(automationId);
    if (!automation) return undefined;
    const active = this.options.store.findActiveRunForAutomation(automationId);
    const run = this.options.store.createRun({
      automationId,
      trigger: "manual",
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
        automation,
        run: queued ?? run,
        position: 1,
      });
    }
    return await this.submitRun({ automation, runId: run.id, windows: [], now });
  }

  async runFromInboundEvent(params: {
    automation: AutomationRecord;
    source: AutomationRunSourceMetadata;
    now?: number;
  }): Promise<Awaited<ReturnType<AutomationRunner["submitRun"]>> | undefined> {
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
      // first message immediately.
      this.openCoalesceWindow(params.automation, windowMs);
    }

    // Rate-gate the run start (leading edge, or — when coalescing is disabled —
    // the direct dispatch). If throttled and a window is open, fold the source
    // into it so it is preserved and flushes (also rate-gated) later; with no
    // window the over-rate message is dropped.
    if (!this.tryConsumeRunStartToken(params.automation, now)) {
      const open = this.coalesceWindows.get(params.automation.id);
      if (open) {
        appendCoalesceSource(open, params.source);
      }
      this.noteThrottledInboundRun(params.automation);
      return undefined;
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
  }): Promise<Awaited<ReturnType<AutomationRunner["submitRun"]>> | undefined> {
    const { now } = params;
    // Idempotency: a provider can redeliver the same event (slow ack, retry).
    // If a run already exists for this stable source-event key, skip rather than
    // launch a duplicate headless run and re-post its actions.
    const existing = this.options.store.findRunBySourceEventKey({
      automationId: params.automation.id,
      sourceEventKey: params.source.sourceEventKey,
    });
    if (existing) {
      return undefined;
    }
    const active = this.options.store.findActiveRunForAutomation(params.automation.id);
    const run = this.options.store.createRun({
      automationId: params.automation.id,
      trigger: "inbound_message",
      scheduledWindows: [],
      source: params.source,
      now,
    });
    if (!run) return undefined;

    if (active) {
      if (params.automation.backlogPolicy === "drop_missed") {
        this.options.store.markRunTerminal({
          runId: run.id,
          status: "skipped",
          completedAt: now,
          errorMessage:
            "The automation execution lane was busy when this inbound message arrived.",
          now,
        });
        return undefined;
      }
      const queued = this.options.store.markRunQueued({
        runId: run.id,
        queueEntryId: buildLaneQueueEntryId(run.id),
        queuedAt: now,
        now,
      });
      return buildLaneQueuedResult({
        automation: params.automation,
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
    if (!this.tryConsumeRunStartToken(automation, this.now())) {
      // Over rate: drop the coalesced batch. The messages were already merged,
      // so this drops a single run rather than one per message.
      this.noteThrottledInboundRun(automation);
      return;
    }
    const [primary, ...rest] = open.sources;
    if (!primary) return;
    const source: AutomationRunSourceMetadata =
      rest.length > 0
        ? { ...primary, batchedEvents: rest.map(toBatchedEntry) }
        : primary;
    await this.dispatchInboundRun({ automation, source, now: this.now() });
  }

  /**
   * Consume one token from the automation's inbound run-start bucket. Returns
   * false (and starts no run) when the bucket is empty. Unlimited automations
   * always succeed. The bucket is in-memory: a process restart resets it to
   * full, which is acceptable for a cost backstop (not a security boundary).
   */
  private tryConsumeRunStartToken(
    automation: AutomationRecord,
    now: number,
  ): boolean {
    const ratePerHour = resolveAutomationRunsPerHour(automation.maxRunsPerHour);
    if (ratePerHour === null) {
      return true;
    }
    const capacity = ratePerHour;
    const existing = this.runStartTokenBuckets.get(automation.id);
    const bucket: RunStartTokenBucket = existing ?? {
      tokens: capacity,
      lastRefillAt: now,
    };
    if (existing) {
      const elapsed = Math.max(0, now - existing.lastRefillAt);
      bucket.tokens = Math.min(
        capacity,
        existing.tokens + (elapsed / HOUR_MS) * ratePerHour,
      );
      bucket.lastRefillAt = now;
    }
    this.runStartTokenBuckets.set(automation.id, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  private noteThrottledInboundRun(automation: AutomationRecord): void {
    automationSchedulerLog.info("inbound automation run throttled by rate limit", {
      automationId: automation.id,
      automationName: automation.name,
      maxRunsPerHour: resolveAutomationRunsPerHour(automation.maxRunsPerHour),
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
    if (!automation.schedule) {
      this.options.store.updateAutomation(automation.id, {
        nextRunAt: null,
        now,
      });
      return;
    }
    const firstDueAt = Math.max(automation.nextRunAt ?? now, this.sessionStartedAt);
    const windows = collectDueAutomationWindows({
      schedule: automation.schedule,
      firstDueAt,
      through: now,
    });
    if (windows.length === 0) {
      this.options.store.updateAutomation(automation.id, {
        nextRunAt: computeNextAutomationRunAt(automation.schedule, now),
        now,
      });
      return;
    }

    if (automation.backlogPolicy === "drop_missed") {
      if (this.options.store.findActiveRunForAutomation(automation.id)) {
        const skipped = this.options.store.createRun({
          automationId: automation.id,
          trigger: "scheduled",
          status: "skipped",
          scheduledFor: windows[0]?.scheduledFor,
          scheduledWindows: windows.slice(0, 1),
          now,
        });
        if (skipped) {
          this.options.store.markRunTerminal({
            runId: skipped.id,
            status: "skipped",
            completedAt: now,
            errorMessage:
              windows.length === 1
                ? "The automation execution lane was busy when this schedule fired."
                : `Dropped ${windows.length} missed schedule windows because the automation execution lane was busy.`,
            now,
          });
        }
        this.options.store.updateAutomation(automation.id, {
          nextRunAt: computeNextAutomationRunAt(automation.schedule, now),
          now,
        });
        return;
      }
      await this.enqueueScheduledRun({ automation, windows: [windows[0]!], now });
    } else {
      const existing = this.options.store.findPendingScheduledRun(automation.id);
      if (existing) {
        const coalesced = this.options.store.coalescePendingScheduledRun({
          automationId: automation.id,
          scheduledWindows: windows,
          now,
        });
        if (coalesced?.queueEntryId) {
          this.options.runner.updateQueuedRunInput?.({
            automation,
            queueEntryId: coalesced.queueEntryId,
            run: coalesced,
          });
        }
      } else if (this.options.store.findActiveRunForAutomation(automation.id)) {
        const run = this.options.store.createRun({
          automationId: automation.id,
          trigger: "scheduled",
          scheduledFor: windows[0]?.scheduledFor,
          scheduledWindows: windows,
          now,
        });
        if (run) {
          this.options.store.markRunQueued({
            runId: run.id,
            queueEntryId: buildLaneQueueEntryId(run.id),
            queuedAt: now,
            now,
          });
        }
      } else {
        await this.enqueueScheduledRun({ automation, windows, now });
      }
    }

    this.options.store.updateAutomation(automation.id, {
      nextRunAt: computeNextAutomationRunAt(automation.schedule, now),
      now,
    });
  }

  private async enqueueScheduledRun(params: {
    automation: AutomationRecord;
    windows: AutomationRunWindow[];
    now: number;
  }): Promise<Awaited<ReturnType<AutomationRunner["submitRun"]>> | undefined> {
    const run = this.options.store.createRun({
      automationId: params.automation.id,
      trigger: "scheduled",
      scheduledFor: params.windows[0]?.scheduledFor,
      scheduledWindows: params.windows,
      now: params.now,
    });
    if (!run) return undefined;
    return await this.submitRun({
      automation: params.automation,
      runId: run.id,
      windows: params.windows,
      now: params.now,
    });
  }

  private async submitRun(params: {
    automation: AutomationRecord;
    runId: string;
    windows: AutomationRunWindow[];
    now: number;
  }): Promise<Awaited<ReturnType<AutomationRunner["submitRun"]>> | undefined> {
    const run = this.options.store.getRun(params.runId);
    if (!run) return undefined;

    try {
      const gateResult = await this.runGateIfNeeded({
        automation: params.automation,
        runId: params.runId,
        now: params.now,
      });
      if (gateResult?.status === "skip" || gateResult?.status === "failed") {
        return undefined;
      }
      const result = await this.options.runner.submitRun({
        automation: params.automation,
        gateResult,
        run,
      });
      if (result.status === "queued") {
        this.options.store.markRunQueued({
          runId: params.runId,
          queueEntryId: result.entry.id,
          queuedAt: params.now,
          now: params.now,
        });
      } else {
        this.options.store.markRunStarted({
          runId: params.runId,
          backendThreadId: result.backendThreadId,
          backendTurnId: result.turnId,
          startedAt: params.now,
          now: params.now,
        });
      }
      automationSchedulerLog.info("automation run submitted", {
        automationId: params.automation.id,
        automationName: params.automation.name,
        backend: params.automation.backend,
        queueEntryId: result.entry.id,
        runId: params.runId,
        status: result.status,
        threadId: params.automation.threadId,
        turnId: result.status === "started" ? result.turnId : undefined,
        windowCount: params.windows.length,
      });
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
      this.options.store.markRunTerminal({
        runId: params.runId,
        status: "failed",
        completedAt: params.now,
        errorMessage: error instanceof Error ? error.message : String(error),
        now: params.now,
      });
      return undefined;
    }
  }

  private async runGateIfNeeded(params: {
    automation: AutomationRecord;
    runId: string;
    now: number;
  }): Promise<AutomationGateRunResult | undefined> {
    if (!params.automation.gate) return undefined;
    const gateResult = await this.options.gateRunner?.runGate(params.automation.gate);
    if (!gateResult) {
      return undefined;
    }
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

  private async startNextPendingRun(
    automationId: string | undefined,
    now: number,
  ): Promise<void> {
    if (!automationId) return;
    const automation = this.options.store.getAutomation(automationId);
    if (!automation) return;
    const pending = this.options.store.findPendingRunForAutomation(automationId);
    if (!pending) return;
    await this.submitRun({
      automation,
      runId: pending.id,
      windows: pending.scheduledWindows,
      now,
    });
  }

  private scheduleNextTimer(): void {
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
    const delayMs = Math.max(0, nextRunAt - this.now());
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

function toBatchedEntry(
  source: AutomationRunSourceMetadata,
): AutomationRunSourceBatchedEntry {
  return {
    sourceEventKey: source.sourceEventKey,
    receivedAt: source.receivedAt,
    actor: source.actor,
    ...(source.message ? { message: source.message } : {}),
  };
}

function buildLaneQueuedResult(params: {
  automation: AutomationRecord;
  position: number;
  run: {
    id: string;
  };
}): Awaited<ReturnType<AutomationRunner["submitRun"]>> {
  return {
    status: "queued",
    entry: {
      id: buildLaneQueueEntryId(params.run.id),
      backend: params.automation.backend,
      threadId: params.automation.threadId,
      origin: "automation",
      automationRunId: params.run.id,
      automationName: params.automation.name,
      input: [],
      createdAt: Date.now(),
    },
    position: params.position,
  };
}
