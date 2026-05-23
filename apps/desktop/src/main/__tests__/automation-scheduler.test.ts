import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadTurnQueueEntry } from "../app-server/thread-turn-queue";
import { ThreadQueueAutomationRunner } from "../automations/automation-runner";
import { AutomationScheduler } from "../automations/automation-scheduler";
import { AutomationStore } from "../automations/automation-store";
import type { AutomationGateRunner } from "../automations/automation-gate-runner";
import { StateDb } from "../state/state-db";

class FakeQueue {
  active = false;
  submitted: ThreadTurnQueueEntry[] = [];

  canStartImmediately(): boolean {
    return !this.active;
  }

  async submit(
    entry: Omit<ThreadTurnQueueEntry, "id" | "createdAt"> &
      Partial<Pick<ThreadTurnQueueEntry, "id" | "createdAt">>,
  ) {
    const queuedEntry: ThreadTurnQueueEntry = {
      ...entry,
      id: entry.id ?? `queue-${this.submitted.length + 1}`,
      createdAt: entry.createdAt ?? 1_000,
    };
    this.submitted.push(queuedEntry);
    if (this.active) {
      return {
        status: "queued" as const,
        entry: queuedEntry,
        position: this.submitted.length,
      };
    }
    return {
      status: "started" as const,
      entry: queuedEntry,
      turnId: `turn-${queuedEntry.id}`,
    };
  }

  updateQueuedInput(entryId: string, input: ThreadTurnQueueEntry["input"]): void {
    const entry = this.submitted.find((candidate) => candidate.id === entryId);
    if (entry) {
      entry.input = input;
    }
  }
}

let tempDir: string;
let stateDb: StateDb;
let store: AutomationStore;
let queue: FakeQueue;
let now = 0;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-automation-scheduler-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new AutomationStore(stateDb);
  queue = new FakeQueue();
  now = 0;
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function createIntervalAutomation(
  overrides: Parameters<AutomationStore["createAutomation"]>[0] = {
    backend: "codex",
    threadId: "thread-1",
    name: "Check email",
    taskPrompt: "Check mail",
    schedule: {
      kind: "interval",
      every: 5,
      unit: "minutes",
      anchorAt: 0,
    },
    nextRunAt: 5 * 60 * 1000,
  },
) {
  return store.createAutomation({
    id: "automation-1",
    now: 0,
    ...overrides,
  });
}

function buildScheduler(): AutomationScheduler {
  return new AutomationScheduler({
    store,
    runner: new ThreadQueueAutomationRunner(queue),
    now: () => now,
    setTimer: (() => 0) as unknown as typeof setTimeout,
    clearTimer: () => undefined,
  });
}

function buildSchedulerWithGate(gateRunner: AutomationGateRunner): AutomationScheduler {
  return new AutomationScheduler({
    store,
    runner: new ThreadQueueAutomationRunner(queue),
    gateRunner,
    now: () => now,
    setTimer: (() => 0) as unknown as typeof setTimeout,
    clearTimer: () => undefined,
  });
}

describe("AutomationScheduler", () => {
  it("reschedules timers when start is called after an automation is added", () => {
    const timerDelays: number[] = [];
    const scheduler = new AutomationScheduler({
      store,
      runner: new ThreadQueueAutomationRunner(queue),
      now: () => now,
      setTimer: ((_callback: () => void, delayMs: number) => {
        timerDelays.push(delayMs);
        return timerDelays.length;
      }) as unknown as typeof setTimeout,
      clearTimer: () => undefined,
    });

    scheduler.start();
    expect(timerDelays).toEqual([]);

    createIntervalAutomation();
    scheduler.start();

    expect(timerDelays).toEqual([5 * 60 * 1000]);
  });

  it("starts due interval automations on idle threads and advances next run", async () => {
    createIntervalAutomation();
    const scheduler = buildScheduler();
    now = 5 * 60 * 1000;

    await scheduler.evaluateDueAutomations();

    expect(queue.submitted).toHaveLength(1);
    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({
        status: "running",
        backendTurnId: "turn-queue-1",
        scheduledWindows: [{ scheduledFor: 5 * 60 * 1000 }],
      }),
    ]);
    expect(store.getAutomation("automation-1")).toMatchObject({
      nextRunAt: 10 * 60 * 1000,
    });
  });

  it("coalesces due windows into one queued catch-up run by default", async () => {
    queue.active = true;
    createIntervalAutomation();
    const scheduler = buildScheduler();
    now = 15 * 60 * 1000;

    await scheduler.evaluateDueAutomations();

    expect(queue.submitted).toHaveLength(1);
    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({
        status: "queued",
        scheduledWindows: [
          { scheduledFor: 5 * 60 * 1000 },
          { scheduledFor: 10 * 60 * 1000 },
          { scheduledFor: 15 * 60 * 1000 },
        ],
      }),
    ]);
  });

  it("merges later due windows into an existing pending coalesced run", async () => {
    queue.active = true;
    createIntervalAutomation();
    const scheduler = buildScheduler();
    now = 10 * 60 * 1000;
    await scheduler.evaluateDueAutomations();

    now = 15 * 60 * 1000;
    await scheduler.evaluateDueAutomations();

    expect(queue.submitted).toHaveLength(1);
    expect(queue.submitted[0]?.input).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("- 1970-01-01T00:15:00.000Z"),
      }),
    ]);
    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({
        scheduledWindows: [
          { scheduledFor: 5 * 60 * 1000 },
          { scheduledFor: 10 * 60 * 1000 },
          { scheduledFor: 15 * 60 * 1000 },
        ],
      }),
    ]);
  });

  it("queues coalesced windows while a run is active and starts them after terminal", async () => {
    createIntervalAutomation();
    const scheduler = buildScheduler();
    now = 5 * 60 * 1000;
    await scheduler.evaluateDueAutomations();
    const [activeRun] = store.listRunsForAutomation("automation-1");

    now = 10 * 60 * 1000;
    await scheduler.evaluateDueAutomations();
    now = 15 * 60 * 1000;
    await scheduler.evaluateDueAutomations();

    expect(queue.submitted).toHaveLength(1);
    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({
        status: "queued",
        scheduledWindows: [
          { scheduledFor: 10 * 60 * 1000 },
          { scheduledFor: 15 * 60 * 1000 },
        ],
      }),
      expect.objectContaining({ status: "running", scheduledFor: 5 * 60 * 1000 }),
    ]);

    await scheduler.handleTurnQueueUpdate({
      automationRunId: activeRun?.id,
      status: "terminal",
      terminalStatus: "turn/completed",
      now: 16 * 60 * 1000,
    });

    expect(queue.submitted).toHaveLength(2);
    expect(store.listRunsForAutomation("automation-1")[0]).toMatchObject({
      status: "running",
      scheduledWindows: [
        { scheduledFor: 10 * 60 * 1000 },
        { scheduledFor: 15 * 60 * 1000 },
      ],
    });
  });

  it("queues drop_missed runs when only the assigned Agent thread is busy", async () => {
    queue.active = true;
    createIntervalAutomation({
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      backlogPolicy: "drop_missed",
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
        anchorAt: 0,
      },
      nextRunAt: 5 * 60 * 1000,
    });
    const scheduler = buildScheduler();
    now = 10 * 60 * 1000;

    await scheduler.evaluateDueAutomations();

    expect(queue.submitted).toHaveLength(1);
    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({
        status: "queued",
        scheduledWindows: [{ scheduledFor: 5 * 60 * 1000 }],
      }),
    ]);
  });

  it("records skipped history for drop_missed while the automation lane is busy", async () => {
    createIntervalAutomation({
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      backlogPolicy: "drop_missed",
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
        anchorAt: 0,
      },
      nextRunAt: 5 * 60 * 1000,
    });
    const scheduler = buildScheduler();
    now = 5 * 60 * 1000;
    await scheduler.evaluateDueAutomations();

    now = 10 * 60 * 1000;
    await scheduler.evaluateDueAutomations();

    expect(queue.submitted).toHaveLength(1);
    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({ status: "skipped", scheduledFor: 10 * 60 * 1000 }),
      expect.objectContaining({ status: "running", scheduledFor: 5 * 60 * 1000 }),
    ]);
  });

  it("queues manual run-now without changing the recurring next run", async () => {
    queue.active = true;
    createIntervalAutomation();
    const scheduler = buildScheduler();
    now = 2 * 60 * 1000;

    await scheduler.runNow("automation-1");

    expect(queue.submitted).toHaveLength(1);
    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({
        trigger: "manual",
        status: "queued",
        scheduledWindows: [],
      }),
    ]);
    expect(store.getAutomation("automation-1")).toMatchObject({
      nextRunAt: 5 * 60 * 1000,
    });
  });

  it("serializes manual run-now behind an active automation run", async () => {
    createIntervalAutomation();
    const scheduler = buildScheduler();
    now = 5 * 60 * 1000;
    await scheduler.evaluateDueAutomations();
    const [activeRun] = store.listRunsForAutomation("automation-1");

    now = 6 * 60 * 1000;
    const queued = await scheduler.runNow("automation-1");

    expect(queued?.status).toBe("queued");
    expect(queue.submitted).toHaveLength(1);
    expect(store.listRunsForAutomation("automation-1")[0]).toMatchObject({
      trigger: "manual",
      status: "queued",
    });

    await scheduler.handleTurnQueueUpdate({
      automationRunId: activeRun?.id,
      status: "terminal",
      terminalStatus: "turn/completed",
      now: 7 * 60 * 1000,
    });

    expect(queue.submitted).toHaveLength(2);
    expect(store.listRunsForAutomation("automation-1")[0]).toMatchObject({
      trigger: "manual",
      status: "running",
    });
  });

  it("includes successful gate output in the automation run prompt", async () => {
    createIntervalAutomation({
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      gate: { command: "echo ready" },
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
        anchorAt: 0,
      },
      nextRunAt: 5 * 60 * 1000,
    });
    const scheduler = buildSchedulerWithGate({
      runGate: async (config) => ({
        status: "proceed",
        command: config.command,
        durationMs: 5,
        output: "ready\n",
      }),
    });
    now = 5 * 60 * 1000;

    await scheduler.evaluateDueAutomations();

    expect(queue.submitted[0]?.input).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("Gate output:\nready"),
      }),
    ]);
  });

  it("records skipped gate runs without invoking the model", async () => {
    createIntervalAutomation({
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      gate: { command: "exit 10" },
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
        anchorAt: 0,
      },
      nextRunAt: 5 * 60 * 1000,
    });
    const scheduler = buildSchedulerWithGate({
      runGate: async (config) => ({
        status: "skip",
        command: config.command,
        durationMs: 5,
        exitCode: 10,
        output: "not needed\n",
      }),
    });
    now = 5 * 60 * 1000;

    await scheduler.evaluateDueAutomations();

    expect(queue.submitted).toHaveLength(0);
    const [run] = store.listRunsForAutomation("automation-1");
    expect(run).toMatchObject({
      status: "skipped",
      errorMessage: "Automation gate skipped this run.",
    });
    expect(store.getRunArtifact(run!.id)).toMatchObject({
      status: "skipped",
      outputDecision: {
        kind: "quiet",
        summary: "Automation gate skipped this run.",
      },
      transcriptEvents: [
        expect.objectContaining({
          kind: "gate",
          text: "not needed\n",
        }),
      ],
    });
  });

  it("records failed gate runs without invoking the model", async () => {
    createIntervalAutomation({
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      gate: { command: "exit 1" },
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
        anchorAt: 0,
      },
      nextRunAt: 5 * 60 * 1000,
    });
    const scheduler = buildSchedulerWithGate({
      runGate: async (config) => ({
        status: "failed",
        command: config.command,
        durationMs: 5,
        exitCode: 1,
        output: "boom\n",
        errorMessage: "Automation gate exited with 1.",
      }),
    });
    now = 5 * 60 * 1000;

    await scheduler.evaluateDueAutomations();

    expect(queue.submitted).toHaveLength(0);
    const [run] = store.listRunsForAutomation("automation-1");
    expect(run).toMatchObject({
      status: "failed",
      errorMessage: "Automation gate exited with 1.",
    });
    expect(store.getRunArtifact(run!.id)).toMatchObject({
      status: "failed",
      outputDecision: {
        kind: "post_card",
        summary: "Automation gate exited with 1.",
      },
    });
  });

  it("maps terminal backend failure notifications to failed runs", async () => {
    createIntervalAutomation();
    const scheduler = buildScheduler();
    now = 5 * 60 * 1000;
    await scheduler.evaluateDueAutomations();
    const [run] = store.listRunsForAutomation("automation-1");

    await scheduler.handleTurnQueueUpdate({
      automationRunId: run?.id,
      status: "terminal",
      terminalStatus: "turn/failed",
      now: 6 * 60 * 1000,
    });

    expect(store.listRunsForAutomation("automation-1")[0]).toMatchObject({
      status: "failed",
      errorMessage: "turn/failed",
    });
  });

  it("maps terminal backend cancellation notifications to cancelled runs", async () => {
    createIntervalAutomation();
    const scheduler = buildScheduler();
    now = 5 * 60 * 1000;
    await scheduler.evaluateDueAutomations();
    const [run] = store.listRunsForAutomation("automation-1");

    await scheduler.handleTurnQueueUpdate({
      automationRunId: run?.id,
      status: "terminal",
      terminalStatus: "turn/cancelled",
      now: 6 * 60 * 1000,
    });

    expect(store.listRunsForAutomation("automation-1")[0]).toMatchObject({
      status: "cancelled",
      errorMessage: "turn/cancelled",
    });
  });
});
