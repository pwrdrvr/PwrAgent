import type {
  AutomationRunStatus,
  AutomationRunWindow,
} from "@pwragent/shared";
import {
  computeNextAutomationRunAt,
  collectDueAutomationWindows,
} from "./automation-schedule.js";
import type { AutomationRunner } from "./automation-runner.js";
import type { AutomationRecord, AutomationStore } from "./automation-store.js";

export type AutomationSchedulerOptions = {
  store: AutomationStore;
  runner: AutomationRunner;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

export class AutomationScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly sessionStartedAt: number;

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

  async handleTurnQueueUpdate(params: {
    automationRunId?: string;
    status: "queued" | "started" | "failed" | "cancelled" | "terminal";
    terminalStatus?: string;
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
        for (const window of windows) {
          const skipped = this.options.store.createRun({
            automationId: automation.id,
            trigger: "scheduled",
            status: "skipped",
            scheduledFor: window.scheduledFor,
            scheduledWindows: [window],
            now,
          });
          if (skipped) {
            this.options.store.markRunTerminal({
              runId: skipped.id,
              status: "skipped",
              completedAt: now,
              errorMessage:
                "The automation execution lane was busy when this schedule fired.",
              now,
            });
          }
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
      const result = await this.options.runner.submitRun({
        automation: params.automation,
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
          backendTurnId: result.turnId,
          startedAt: params.now,
          now: params.now,
        });
      }
      return result;
    } catch (error) {
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
