import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HeadlessAutomationRunner,
  type HeadlessAutomationLauncher,
} from "../automations/automation-runner";
import {
  AUTOMATION_EVALUATION_RETRY_MS,
  AutomationScheduler,
} from "../automations/automation-scheduler";
import { AutomationStore } from "../storage/automation-store";
import type { AutomationGateRunner } from "../automations/automation-gate-runner";
import { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

type HeadlessLaunch = Parameters<HeadlessAutomationLauncher["startAutomationHeadlessTurn"]>[0];

/**
 * Stands in for the registry behind the production runner. Each call is one
 * headless thread and turn started for a run.
 */
class FakeLauncher implements HeadlessAutomationLauncher {
  started: HeadlessLaunch[] = [];

  async startAutomationHeadlessTurn(params: HeadlessLaunch) {
    this.started.push(params);
    const ordinal = this.started.length;
    return {
      headlessThreadId: `headless-thread-${ordinal}`,
      queueEntryId: `headless:${params.automationRunId}`,
      threadId: params.agentThreadId,
      turnId: `turn-${ordinal}`,
    };
  }

  interrupted: Array<{ threadId: string; turnId: string }> = [];

  async interruptTurn(params: { threadId: string; turnId: string }) {
    this.interrupted.push({ threadId: params.threadId, turnId: params.turnId });
  }
}

let stateDb: StateDb;
let store: AutomationStore;
let launcher: FakeLauncher;
let now = 0;

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  store = new AutomationStore(stateDb);
  launcher = new FakeLauncher();
  now = 0;
});

afterEach(() => {
  stateDb.close();
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
    runner: new HeadlessAutomationRunner(launcher),
    now: () => now,
    setTimer: (() => 0) as unknown as typeof setTimeout,
    clearTimer: () => undefined,
  });
}

function buildSchedulerWithGate(gateRunner: AutomationGateRunner): AutomationScheduler {
  return new AutomationScheduler({
    store,
    runner: new HeadlessAutomationRunner(launcher),
    gateRunner,
    now: () => now,
    setTimer: (() => 0) as unknown as typeof setTimeout,
    clearTimer: () => undefined,
  });
}

describe("AutomationScheduler", () => {
  it.each(["started", "failed"] as const)(
    "preserves completion when a %s submission result arrives after lifecycle events",
    async (submissionStatus) => {
      const automation = createIntervalAutomation();
      let beforeReturnStatus: string | undefined;
      const scheduler = new AutomationScheduler({
        store,
        now: () => now,
        runner: {
          async submitRun({ run }) {
            await scheduler.handleTurnQueueUpdate({
              automationRunId: run.id,
              status: "started",
              turnId: "turn-1",
              now: 500,
            });
            await scheduler.handleTurnQueueUpdate({
              automationRunId: run.id,
              status: "terminal",
              terminalStatus: "turn/completed",
              now: 1_000,
            });
            beforeReturnStatus = store.getRun(run.id)?.status;
            if (submissionStatus === "failed") {
              throw new Error("Submission acknowledgement failed");
            }
            return {
              status: "started",
              queueEntryId: "queue-1",
              turnId: "turn-1",
              backendThreadId: "headless-1",
            };
          },
        },
      });

      const result = await scheduler.runNow(automation.id);

      expect(beforeReturnStatus).toBe("completed");
      expect(result?.status).toBe(submissionStatus === "failed" ? undefined : submissionStatus);
      const [run] = store.listRunsForAutomation(automation.id);
      expect(run).toMatchObject({
        status: "completed",
        startedAt: 500,
        completedAt: 1_000,
        backendTurnId: "turn-1",
      });
      expect(run?.errorMessage).toBeUndefined();
      if (submissionStatus !== "failed") expect(run?.queueEntryId).toBe("queue-1");
      if (submissionStatus === "started") expect(run?.backendThreadId).toBe("headless-1");
      expect(store.findActiveRunForAutomation(automation.id)).toBeUndefined();
      expect(store.getAutomation(automation.id)).toMatchObject({
        lastRunAt: 1_000,
        lastRunStatus: "completed",
      });
    },
  );

  it("replays a captured message as a manual run carrying the source", async () => {
    const automation = createIntervalAutomation({
      backend: "codex",
      threadId: "thread-1",
      name: "Search bots",
      taskPrompt: "Investigate.",
      triggers: [
        {
          id: "inbound-message",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C123" },
        },
      ],
    });
    const scheduler = buildScheduler();
    const source = {
      kind: "messaging" as const,
      sourceEventKey: "replay:m1:9000",
      receivedAt: 5_000,
      matchedTriggerId: "inbound-message",
      actor: { platformUserId: "B123", displayName: "Datadog", isBot: true },
      conversation: { channel: "slack" as const, conversationId: "C123" },
      message: { text: "ERROR rate spike" },
    };

    const result = await scheduler.replayInboundRun({ automation, source });
    expect(result?.status).toBe("started");
    const [run] = store.listRunsForAutomation(automation.id, 1);
    expect(run?.trigger).toBe("manual");
    expect(run?.source?.message?.text).toBe("ERROR rate spike");

    // A second replay of the same message must create another run — the
    // source-event dedupe polices unattended inbound traffic, not an operator
    // pressing the button twice on purpose. It queues rather than starts
    // because the first replay still holds the serial lane.
    const again = await scheduler.replayInboundRun({
      automation,
      source: { ...source, sourceEventKey: "replay:m1:9500" },
    });
    expect(again?.status).toBe("queued");
    expect(store.listRunsForAutomation(automation.id, 10)).toHaveLength(2);
  });

  it("reschedules timers when start is called after an automation is added", () => {
    const timerDelays: number[] = [];
    const scheduler = new AutomationScheduler({
      store,
      runner: new HeadlessAutomationRunner(launcher),
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

  it("starts due interval automations on a headless thread and advances next run", async () => {
    createIntervalAutomation();
    const scheduler = buildScheduler();
    now = 5 * 60 * 1000;

    await scheduler.evaluateDueAutomations();

    expect(launcher.started).toHaveLength(1);
    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({
        status: "running",
        backendTurnId: "turn-1",
        backendThreadId: "headless-thread-1",
        scheduledWindows: [{ scheduledFor: 5 * 60 * 1000 }],
      }),
    ]);
    expect(store.getAutomation("automation-1")).toMatchObject({
      nextRunAt: 10 * 60 * 1000,
    });
  });

  it("coalesces due windows into one catch-up run by default", async () => {
    createIntervalAutomation();
    const scheduler = buildScheduler();
    now = 15 * 60 * 1000;

    await scheduler.evaluateDueAutomations();

    expect(launcher.started).toHaveLength(1);
    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({
        status: "running",
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

    expect(launcher.started).toHaveLength(1);
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

    expect(launcher.started).toHaveLength(2);
    // The input is built when the run starts, so it names every merged window.
    expect(launcher.started[1]?.input).toEqual([
      expect.objectContaining({
        text: expect.stringMatching(
          /- 1970-01-01T00:10:00\.000Z[\s\S]*- 1970-01-01T00:15:00\.000Z/,
        ),
      }),
    ]);
    expect(store.listRunsForAutomation("automation-1")[0]).toMatchObject({
      status: "running",
      scheduledWindows: [
        { scheduledFor: 10 * 60 * 1000 },
        { scheduledFor: 15 * 60 * 1000 },
      ],
    });
  });

  it("starts drop_missed with only the first missed window when the lane is idle", async () => {
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

    expect(launcher.started).toHaveLength(1);
    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({
        status: "running",
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

    expect(launcher.started).toHaveLength(1);
    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({ status: "skipped", scheduledFor: 10 * 60 * 1000 }),
      expect.objectContaining({ status: "running", scheduledFor: 5 * 60 * 1000 }),
    ]);
  });

  it("records drop_missed skipped history beside a queued scheduled run", async () => {
    // A coalesce automation queues its scheduled window behind a manual run,
    // then switches to drop_missed. The next busy window's skipped marker
    // must not count as a second pending scheduled run.
    createIntervalAutomation();
    const scheduler = buildScheduler();
    await scheduler.runNow("automation-1");
    now = 5 * 60 * 1000;
    await scheduler.evaluateDueAutomations();
    store.updateAutomation("automation-1", { backlogPolicy: "drop_missed", now });

    now = 10 * 60 * 1000;
    await expect(scheduler.evaluateDueAutomations()).resolves.toBeUndefined();

    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({
        status: "skipped",
        scheduledFor: 10 * 60 * 1000,
        errorMessage: "The automation execution lane was busy when this schedule fired.",
      }),
      expect.objectContaining({ status: "queued", scheduledFor: 5 * 60 * 1000 }),
      expect.objectContaining({ status: "running", trigger: "manual" }),
    ]);
    expect(store.getAutomation("automation-1")).toMatchObject({
      lastRunStatus: "skipped",
      nextRunAt: 15 * 60 * 1000,
    });
  });

  it("waits before retrying a schedule evaluation that failed", async () => {
    createIntervalAutomation();
    const delays: number[] = [];
    const scheduler = new AutomationScheduler({
      store,
      runner: new HeadlessAutomationRunner(launcher),
      now: () => now,
      setTimer: ((_callback: () => void, delayMs: number) => {
        delays.push(delayMs);
        return 0;
      }) as unknown as typeof setTimeout,
      clearTimer: () => undefined,
    });
    scheduler.start();
    store.findActiveRunForAutomation = () => {
      throw new Error("database is locked");
    };
    now = 5 * 60 * 1000;

    await expect(scheduler.evaluateDueAutomations()).resolves.toBeUndefined();

    // The window stays due; re-arming at it would fire again at once.
    expect(store.getAutomation("automation-1")?.nextRunAt).toBe(5 * 60 * 1000);
    expect(delays.at(-1)).toBe(AUTOMATION_EVALUATION_RETRY_MS);
  });

  it("records one skipped summary when many drop_missed windows are due", async () => {
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

    now = 60 * 60 * 1000;
    await scheduler.evaluateDueAutomations();

    expect(launcher.started).toHaveLength(1);
    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({
        status: "skipped",
        scheduledFor: 10 * 60 * 1000,
        scheduledWindows: [{ scheduledFor: 10 * 60 * 1000 }],
        errorMessage:
          "Dropped 11 missed schedule windows because the automation execution lane was busy.",
      }),
      expect.objectContaining({ status: "running", scheduledFor: 5 * 60 * 1000 }),
    ]);
  });

  it("starts manual run-now without changing the recurring next run", async () => {
    createIntervalAutomation();
    const scheduler = buildScheduler();
    now = 2 * 60 * 1000;

    await scheduler.runNow("automation-1");

    expect(launcher.started).toHaveLength(1);
    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({
        trigger: "manual",
        status: "running",
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
    expect(launcher.started).toHaveLength(1);
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

    expect(launcher.started).toHaveLength(2);
    expect(store.listRunsForAutomation("automation-1")[0]).toMatchObject({
      trigger: "manual",
      status: "running",
    });
  });

  it("serializes inbound message runs behind the automation lane", async () => {
    const automation = store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Datadog alert triage",
      taskPrompt: "Investigate.",
      // Disable coalescing so each event creates a run immediately; this test
      // exercises the lane queue, not the coalescing window.
      inboundCoalesceWindowMs: 0,
      triggers: [
        {
          id: "datadog-error",
          kind: "inbound_message",
          conversation: {
            channel: "slack",
            conversationId: "C123",
          },
          textFilter: {
            mode: "contains",
            text: "ERROR",
          },
        },
      ],
      now: 0,
    });
    const scheduler = buildScheduler();

    now = 1_000;
    await scheduler.runFromInboundEvent({
      automation,
      source: {
        kind: "messaging",
        sourceEventKey: "slack:C123:1::B123",
        receivedAt: 1_000,
        matchedTriggerId: "datadog-error",
        actor: {
          platformUserId: "B123",
          isBot: true,
        },
        conversation: {
          channel: "slack",
          conversationId: "C123",
        },
        message: {
          text: "ERROR first",
        },
      },
      now,
    });
    const [activeRun] = store.listRunsForAutomation("automation-1");

    now = 2_000;
    const queued = await scheduler.runFromInboundEvent({
      automation,
      source: {
        kind: "messaging",
        sourceEventKey: "slack:C123:2::B123",
        receivedAt: 2_000,
        matchedTriggerId: "datadog-error",
        actor: {
          platformUserId: "B123",
          isBot: true,
        },
        conversation: {
          channel: "slack",
          conversationId: "C123",
        },
        message: {
          text: "ERROR second",
        },
      },
      now,
    });

    expect(queued?.status).toBe("queued");
    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({
        trigger: "inbound_message",
        status: "queued",
        source: expect.objectContaining({
          sourceEventKey: "slack:C123:2::B123",
        }),
      }),
      expect.objectContaining({
        trigger: "inbound_message",
        status: "running",
        source: expect.objectContaining({
          sourceEventKey: "slack:C123:1::B123",
        }),
      }),
    ]);

    now = 3_000;
    await scheduler.handleTurnQueueUpdate({
      automationRunId: activeRun?.id,
      status: "terminal",
      terminalStatus: "turn/completed",
      now,
    });

    expect(launcher.started).toHaveLength(2);
    expect(store.listRunsForAutomation("automation-1")[0]).toMatchObject({
      trigger: "inbound_message",
      status: "running",
      source: {
        sourceEventKey: "slack:C123:2::B123",
      },
    });
  });

  it("starts a queued run once when duplicate terminal signals release the lane", async () => {
    const automation = store.createAutomation({
      id: "automation-duplicate-terminal",
      backend: "codex",
      threadId: "thread-1",
      name: "Search Bots",
      taskPrompt: "Investigate.",
      inboundCoalesceWindowMs: 0,
      triggers: [
        {
          id: "inbound",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C123" },
        },
      ],
      now: 0,
    });
    const scheduler = buildScheduler();
    const source = (sourceEventKey: string) => ({
      kind: "messaging" as const,
      sourceEventKey,
      receivedAt: now,
      matchedTriggerId: "inbound",
      actor: { platformUserId: "B123", isBot: true },
      conversation: { channel: "slack" as const, conversationId: "C123" },
      message: { text: "ERROR" },
    });

    now = 1_000;
    await scheduler.runFromInboundEvent({
      automation,
      source: source("first"),
      now,
    });
    const activeRun = store.findActiveRunForAutomation(automation.id)!;

    now = 2_000;
    await scheduler.runFromInboundEvent({
      automation,
      source: source("queued"),
      now,
    });

    now = 3_000;
    await Promise.all([
      scheduler.handleTurnQueueUpdate({
        automationRunId: activeRun.id,
        status: "terminal",
        terminalStatus: "turn/completed",
        now,
      }),
      scheduler.handleTurnQueueUpdate({
        automationRunId: activeRun.id,
        status: "terminal",
        terminalStatus: "turn/completed",
        now,
      }),
    ]);

    expect(launcher.started).toHaveLength(2);
    expect(
      launcher.started.filter((launch) => launch.automationRunId !== activeRun.id),
    ).toHaveLength(1);
  });

  it("queues automation dispatch while quit confirmation is open and resumes it", async () => {
    const automation = store.createAutomation({
      id: "automation-quit-wait",
      backend: "codex",
      threadId: "thread-1",
      name: "Search Bots",
      taskPrompt: "Investigate.",
      inboundCoalesceWindowMs: 0,
      triggers: [
        {
          id: "inbound",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C123" },
        },
      ],
      now: 0,
    });
    const scheduler = buildScheduler();
    scheduler.start();
    const resume = scheduler.quiesceDispatch();

    now = 1_000;
    const result = await scheduler.runFromInboundEvent({
      automation,
      source: {
        kind: "messaging",
        sourceEventKey: "held-while-quitting",
        receivedAt: now,
        matchedTriggerId: "inbound",
        actor: { platformUserId: "B123", isBot: true },
        conversation: { channel: "slack", conversationId: "C123" },
        message: { text: "ERROR" },
      },
      now,
    });

    expect(result?.status).toBe("queued");
    expect(launcher.started).toHaveLength(0);
    expect(store.findActiveRunForAutomation(automation.id)).toMatchObject({
      status: "queued",
    });

    await resume();

    expect(launcher.started).toHaveLength(1);
    expect(store.findActiveRunForAutomation(automation.id)).toMatchObject({
      status: "running",
    });
  });

  it("queues a run when quit quiescing begins while its gate is in progress", async () => {
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
    let gateCalls = 0;
    let releaseFirstGate!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirstGate = resolve;
    });
    const scheduler = buildSchedulerWithGate({
      runGate: async (config) => {
        gateCalls += 1;
        if (gateCalls === 1) {
          await firstGate;
        }
        return {
          status: "proceed",
          command: config.command,
          durationMs: 5,
          output: "ready\n",
        };
      },
    });
    scheduler.start();
    now = 5 * 60 * 1000;

    const evaluating = scheduler.evaluateDueAutomations();
    await Promise.resolve();
    const resume = scheduler.quiesceDispatch();
    releaseFirstGate();
    await evaluating;

    expect(launcher.started).toHaveLength(0);
    expect(store.findActiveRunForAutomation("automation-1")).toMatchObject({
      status: "queued",
    });

    await resume();

    expect(gateCalls).toBe(2);
    expect(launcher.started).toHaveLength(1);
    expect(store.findActiveRunForAutomation("automation-1")).toMatchObject({
      status: "running",
    });
  });

  it("ignores a redelivered inbound event with the same source-event key", async () => {
    const automation = store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Datadog alert triage",
      taskPrompt: "Investigate.",
      triggers: [
        {
          id: "datadog-error",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C123" },
          textFilter: { mode: "contains", text: "ERROR" },
        },
      ],
      now: 0,
    });
    const scheduler = buildScheduler();

    const source = {
      kind: "messaging" as const,
      sourceEventKey: "slack:C123:1::B123",
      receivedAt: 1_000,
      matchedTriggerId: "datadog-error",
      actor: { platformUserId: "B123", isBot: true },
      conversation: { channel: "slack" as const, conversationId: "C123" },
      message: { text: "ERROR first" },
    };

    now = 1_000;
    const first = await scheduler.runFromInboundEvent({ automation, source, now });
    now = 1_500;
    const redelivered = await scheduler.runFromInboundEvent({
      automation,
      source,
      now,
    });

    expect(first).toBeDefined();
    expect(redelivered).toBeUndefined();
    expect(store.listRunsForAutomation("automation-1")).toHaveLength(1);
    expect(launcher.started).toHaveLength(1);
  });

  it("coalesces an inbound burst into a leading run plus one batched run", async () => {
    const automation = store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Burst triage",
      taskPrompt: "Investigate.",
      inboundCoalesceWindowMs: 60_000,
      triggers: [
        {
          id: "t",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C123" },
          textFilter: { mode: "contains", text: "ERROR" },
        },
      ],
      now: 0,
    });
    let windowCallback: (() => void) | undefined;
    const scheduler = new AutomationScheduler({
      store,
      runner: new HeadlessAutomationRunner(launcher),
      now: () => now,
      setTimer: ((callback: () => void) => {
        windowCallback = callback;
        return 1;
      }) as unknown as typeof setTimeout,
      clearTimer: () => undefined,
    });
    const src = (key: string, text: string) => ({
      kind: "messaging" as const,
      sourceEventKey: key,
      receivedAt: now,
      matchedTriggerId: "t",
      actor: { platformUserId: "B123", isBot: true },
      conversation: { channel: "slack" as const, conversationId: "C123" },
      message: { text },
    });

    now = 1_000;
    await scheduler.runFromInboundEvent({ automation, source: src("k1", "ERROR one"), now });
    // Leading edge fires immediately.
    expect(store.listRunsForAutomation("automation-1")).toHaveLength(1);
    expect(launcher.started).toHaveLength(1);

    // Two more within the window are buffered, not run.
    now = 1_100;
    await scheduler.runFromInboundEvent({ automation, source: src("k2", "ERROR two"), now });
    now = 1_200;
    await scheduler.runFromInboundEvent({ automation, source: src("k3", "ERROR three"), now });
    expect(store.listRunsForAutomation("automation-1")).toHaveLength(1);

    // Leading run completes so the lane is free.
    const leading = store.listRunsForAutomation("automation-1")[0];
    now = 2_000;
    await scheduler.handleTurnQueueUpdate({
      automationRunId: leading?.id,
      status: "terminal",
      terminalStatus: "turn/completed",
      now,
    });

    // Window elapses → one batched run carrying the buffered messages.
    now = 61_000;
    windowCallback?.();
    await new Promise((resolve) => setImmediate(resolve));

    const runs = store.listRunsForAutomation("automation-1");
    expect(runs).toHaveLength(2);
    expect(launcher.started).toHaveLength(2);
    const batched = runs[0];
    expect(batched?.source?.sourceEventKey).toBe("k2");
    expect(batched?.source?.batchedEvents).toEqual([
      expect.objectContaining({ sourceEventKey: "k3" }),
    ]);
  });

  it("keeps each batched follow-up's conversation when it came from another watched source", async () => {
    const automation = store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Alerts and metrics",
      taskPrompt: "Investigate.",
      inboundCoalesceWindowMs: 60_000,
      triggers: [
        {
          id: "t-alerts",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C-ALERTS", title: "f-alerts" },
        },
        {
          id: "t-metrics",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C-METRICS", title: "f-metrics" },
        },
      ],
      now: 0,
    });
    let windowCallback: (() => void) | undefined;
    const scheduler = new AutomationScheduler({
      store,
      runner: new HeadlessAutomationRunner(launcher),
      now: () => now,
      setTimer: ((callback: () => void) => {
        windowCallback = callback;
        return 1;
      }) as unknown as typeof setTimeout,
      clearTimer: () => undefined,
    });
    const src = (key: string, triggerId: string, conversationId: string, title: string) => ({
      kind: "messaging" as const,
      sourceEventKey: key,
      receivedAt: now,
      matchedTriggerId: triggerId,
      actor: { platformUserId: "B123", isBot: true },
      conversation: { channel: "slack" as const, conversationId, title },
      message: { text: key },
    });

    now = 1_000;
    await scheduler.runFromInboundEvent({
      automation,
      source: src("k1", "t-alerts", "C-ALERTS", "f-alerts"),
      now,
    });
    now = 1_100;
    await scheduler.runFromInboundEvent({
      automation,
      source: src("k2", "t-alerts", "C-ALERTS", "f-alerts"),
      now,
    });
    now = 1_200;
    await scheduler.runFromInboundEvent({
      automation,
      source: src("k3", "t-metrics", "C-METRICS", "f-metrics"),
      now,
    });
    now = 1_300;
    await scheduler.runFromInboundEvent({
      automation,
      source: src("k4", "t-alerts", "C-ALERTS", "f-alerts"),
      now,
    });

    const leading = store.listRunsForAutomation("automation-1")[0];
    now = 2_000;
    await scheduler.handleTurnQueueUpdate({
      automationRunId: leading?.id,
      status: "terminal",
      terminalStatus: "turn/completed",
      now,
    });
    now = 61_000;
    windowCallback?.();
    await new Promise((resolve) => setImmediate(resolve));

    const [batched] = store.listRunsForAutomation("automation-1");
    expect(batched?.source?.sourceEventKey).toBe("k2");
    // k3 was posted in f-metrics, not in f-alerts where the batch's primary
    // message was; k4 shares the primary's source, so it carries nothing extra.
    expect(batched?.source?.batchedEvents).toEqual([
      expect.objectContaining({
        sourceEventKey: "k3",
        conversation: expect.objectContaining({ conversationId: "C-METRICS" }),
      }),
      expect.not.objectContaining({ conversation: expect.anything() }),
    ]);
    expect(batched?.source?.batchedEvents?.[1]?.sourceEventKey).toBe("k4");
  });

  it("shares one hourly run cap across every watched conversation", async () => {
    // The cap is a backstop on the automation's total spend. Per-source
    // buckets would multiply the operator's configured cap by the number of
    // conversations watched.
    const automation = store.createAutomation({
      id: "automation-shared-cap",
      backend: "codex",
      threadId: "thread-1",
      name: "Alerts and metrics",
      taskPrompt: "Triage.",
      inboundCoalesceWindowMs: 0,
      maxRunsPerHour: 2,
      triggers: [
        {
          id: "t-alerts",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C-ALERTS" },
        },
        {
          id: "t-metrics",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C-METRICS" },
        },
      ],
      now: 0,
    });
    const scheduler = buildScheduler();
    const src = (key: string, triggerId: string, conversationId: string) => ({
      kind: "messaging" as const,
      sourceEventKey: key,
      receivedAt: now,
      matchedTriggerId: triggerId,
      actor: { platformUserId: "B123", isBot: true },
      conversation: { channel: "slack" as const, conversationId },
      message: { text: "ERROR" },
    });

    now = 1_000;
    await scheduler.runFromInboundEvent({
      automation,
      source: src("a1", "t-alerts", "C-ALERTS"),
      now,
    });
    await scheduler.runFromInboundEvent({
      automation,
      source: src("m1", "t-metrics", "C-METRICS"),
      now,
    });
    await scheduler.runFromInboundEvent({
      automation,
      source: src("m2", "t-metrics", "C-METRICS"),
      now,
    });

    const started = store
      .listRunsForAutomation("automation-shared-cap")
      .filter((run) => run.status !== "skipped");
    expect(started).toHaveLength(2);
  });

  it("caps inbound run starts at the per-hour rolling limit", async () => {
    const automation = store.createAutomation({
      id: "automation-rl",
      backend: "codex",
      threadId: "thread-1",
      name: "Rate limited",
      taskPrompt: "Triage.",
      inboundCoalesceWindowMs: 0,
      maxRunsPerHour: 5,
      triggers: [
        {
          id: "t",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C123" },
          textFilter: { mode: "contains", text: "ERROR" },
        },
      ],
      now: 0,
    });
    const scheduler = buildScheduler();
    const src = (key: string) => ({
      kind: "messaging" as const,
      sourceEventKey: key,
      receivedAt: now,
      matchedTriggerId: "t",
      actor: { platformUserId: "B123", isBot: true },
      conversation: { channel: "slack" as const, conversationId: "C123" },
      message: { text: "ERROR" },
    });

    // Count only runs that actually started; throttled drops record a separate
    // skipped marker (asserted in its own test below).
    const started = () =>
      store
        .listRunsForAutomation("automation-rl")
        .filter((run) => run.status !== "skipped");

    // 10 distinct messages at the same instant; the hourly cap is 5.
    now = 1_000;
    for (let i = 0; i < 10; i += 1) {
      await scheduler.runFromInboundEvent({ automation, source: src(`k${i}`), now });
    }
    expect(started()).toHaveLength(5);

    // Still capped 12 minutes later — all 5 runs are within the rolling hour,
    // so this is not a burstable/refilling bucket.
    now = 1_000 + 12 * 60 * 1000;
    await scheduler.runFromInboundEvent({ automation, source: src("k-12min"), now });
    expect(started()).toHaveLength(5);

    // Once the first runs age out of the rolling hour, a new run is allowed.
    now = 1_000 + 60 * 60 * 1000 + 1;
    await scheduler.runFromInboundEvent({ automation, source: src("k-aged"), now });
    expect(started()).toHaveLength(6);
  });

  it("records one coalesced skipped run for throttled inbound messages", async () => {
    const automation = store.createAutomation({
      id: "automation-rl",
      backend: "codex",
      threadId: "thread-1",
      name: "Rate limited",
      taskPrompt: "Triage.",
      inboundCoalesceWindowMs: 0,
      maxRunsPerHour: 1,
      triggers: [
        {
          id: "t",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C123" },
          textFilter: { mode: "contains", text: "ERROR" },
        },
      ],
      now: 0,
    });
    const scheduler = buildScheduler();
    const src = (key: string) => ({
      kind: "messaging" as const,
      sourceEventKey: key,
      receivedAt: now,
      matchedTriggerId: "t",
      actor: { platformUserId: "B123", isBot: true },
      conversation: { channel: "slack" as const, conversationId: "C123" },
      message: { text: "ERROR" },
    });

    // One run fits the cap; the next four are throttled.
    now = 1_000;
    for (let i = 0; i < 5; i += 1) {
      await scheduler.runFromInboundEvent({ automation, source: src(`k${i}`), now });
    }

    const runs = store.listRunsForAutomation("automation-rl");
    const skipped = runs.filter((run) => run.status === "skipped");
    // The four drops collapse onto a single throttle marker carrying the count.
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.skipReason).toBe("rate_limited");
    expect(skipped[0]?.coalescedCount).toBe(4);
    // Exactly one started run plus the single throttle marker.
    expect(runs).toHaveLength(2);
  });

  it("keeps coalescing throttle drops after a real run finishes", async () => {
    // The marker is keyed by the wall-clock hour, so an intervening finished run
    // never causes a second marker within the same hour.
    const automation = store.createAutomation({
      id: "automation-rl",
      backend: "codex",
      threadId: "thread-1",
      name: "Rate limited",
      taskPrompt: "Triage.",
      inboundCoalesceWindowMs: 0,
      maxRunsPerHour: 1,
      triggers: [
        {
          id: "t",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C123" },
          textFilter: { mode: "contains", text: "ERROR" },
        },
      ],
      now: 0,
    });
    const scheduler = buildScheduler();
    const src = (key: string) => ({
      kind: "messaging" as const,
      sourceEventKey: key,
      receivedAt: now,
      matchedTriggerId: "t",
      actor: { platformUserId: "B123", isBot: true },
      conversation: { channel: "slack" as const, conversationId: "C123" },
      message: { text: "ERROR" },
    });

    now = 1_000;
    await scheduler.runFromInboundEvent({ automation, source: src("real"), now });
    await scheduler.runFromInboundEvent({ automation, source: src("drop-1"), now });

    // The real run finishes, bumping its updated_at above the throttle marker.
    const [realRun] = store
      .listRunsForAutomation("automation-rl")
      .filter((run) => run.status !== "skipped");
    now = 2_000;
    store.markRunTerminal({
      runId: realRun.id,
      status: "completed",
      completedAt: now,
      now,
    });

    // A later drop must still coalesce onto the existing marker, not spawn a new
    // one just because the finished real run is now the newest row.
    now = 3_000;
    await scheduler.runFromInboundEvent({ automation, source: src("drop-2"), now });
    const skipped = store
      .listRunsForAutomation("automation-rl")
      .filter((run) => run.status === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.coalescedCount).toBe(2);
  });

  it("does not count idempotent redeliveries or duplicate-trigger matches toward the rate", async () => {
    const automation = store.createAutomation({
      id: "automation-rl2",
      backend: "codex",
      threadId: "thread-1",
      name: "Rate limited",
      taskPrompt: "Triage.",
      inboundCoalesceWindowMs: 0,
      maxRunsPerHour: 2,
      triggers: [
        {
          id: "t",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C123" },
          textFilter: { mode: "contains", text: "ERROR" },
        },
      ],
      now: 0,
    });
    const scheduler = buildScheduler();
    const src = (key: string) => ({
      kind: "messaging" as const,
      sourceEventKey: key,
      receivedAt: now,
      matchedTriggerId: "t",
      actor: { platformUserId: "B123", isBot: true },
      conversation: { channel: "slack" as const, conversationId: "C123" },
      message: { text: "ERROR" },
    });

    now = 1_000;
    // First message starts a run (1 of 2 used).
    await scheduler.runFromInboundEvent({ automation, source: src("k1"), now });
    // Three redeliveries of the same key are idempotent: no run, nothing counted.
    for (let i = 0; i < 3; i += 1) {
      await scheduler.runFromInboundEvent({ automation, source: src("k1"), now });
    }
    // A genuinely new message is still under the cap and starts/queues a run.
    await scheduler.runFromInboundEvent({ automation, source: src("k2"), now });

    // 2 real runs (k1, k2); the bucket was not drained by the redeliveries. If
    // tokens were spent before the idempotency check, k2 would have been
    // throttled and only 1 run would exist.
    expect(store.listRunsForAutomation("automation-rl2")).toHaveLength(2);
  });

  it("does not rate-limit inbound runs when the limit is unlimited", async () => {
    const automation = store.createAutomation({
      id: "automation-unlimited",
      backend: "codex",
      threadId: "thread-1",
      name: "Unlimited",
      taskPrompt: "Triage.",
      inboundCoalesceWindowMs: 0,
      maxRunsPerHour: null,
      triggers: [
        {
          id: "t",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C123" },
          textFilter: { mode: "contains", text: "ERROR" },
        },
      ],
      now: 0,
    });
    const scheduler = buildScheduler();
    const src = (key: string) => ({
      kind: "messaging" as const,
      sourceEventKey: key,
      receivedAt: now,
      matchedTriggerId: "t",
      actor: { platformUserId: "B123", isBot: true },
      conversation: { channel: "slack" as const, conversationId: "C123" },
      message: { text: "ERROR" },
    });

    now = 1_000;
    for (let i = 0; i < 30; i += 1) {
      await scheduler.runFromInboundEvent({ automation, source: src(`k${i}`), now });
    }
    expect(store.listRunsForAutomation("automation-unlimited")).toHaveLength(30);
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

    expect(launcher.started[0]?.input).toEqual([
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

    expect(launcher.started).toHaveLength(0);
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

    expect(launcher.started).toHaveLength(0);
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

  it.each([
    {
      terminalStatus: "turn/failed" as const,
      runStatus: "failed" as const,
    },
    {
      terminalStatus: "turn/cancelled" as const,
      runStatus: "cancelled" as const,
    },
  ])("maps terminal backend $terminalStatus notifications to $runStatus runs", async ({
    terminalStatus,
    runStatus,
  }) => {
    createIntervalAutomation();
    const scheduler = buildScheduler();
    now = 5 * 60 * 1000;
    await scheduler.evaluateDueAutomations();
    const [run] = store.listRunsForAutomation("automation-1");

    await scheduler.handleTurnQueueUpdate({
      automationRunId: run?.id,
      status: "terminal",
      terminalStatus,
      now: 6 * 60 * 1000,
    });

    expect(store.listRunsForAutomation("automation-1")[0]).toMatchObject({
      status: runStatus,
      errorMessage: terminalStatus,
    });
  });
});

/** Timers the scheduler armed, fired only when the test's clock passes them. */
class FakeClock {
  now = 0;
  private nextId = 1;
  readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimer = ((callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;

  clearTimer = (timer: ReturnType<typeof setTimeout>) => {
    this.timers.delete(timer as unknown as number);
  };

  async advance(ms: number): Promise<void> {
    this.now += ms;
    for (const [id, timer] of [...this.timers.entries()]) {
      if (timer.at > this.now) continue;
      this.timers.delete(id);
      timer.callback();
    }
    // Let the fired callbacks' promise chains settle.
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  }
}

describe("AutomationScheduler run timeout", () => {
  it("fails a run that passes its timeout, interrupts its turn and starts nothing more", async () => {
    const clock = new FakeClock();
    store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Hangs",
      taskPrompt: "Hang",
      schedule: { kind: "interval", every: 1, unit: "hours", anchorAt: 0 },
      runTimeoutMs: 15 * 60 * 1000,
      now: 0,
    });
    const timedOut: string[] = [];
    const scheduler = new AutomationScheduler({
      store,
      runner: new HeadlessAutomationRunner(launcher),
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onRunTimedOut: (run) => {
        timedOut.push(run.id);
      },
    });

    await scheduler.runNow("automation-1", clock.now);
    const [run] = store.listRunsForAutomation("automation-1");
    expect(run?.status).toBe("running");
    expect(clock.timers.size).toBe(1);

    await clock.advance(15 * 60 * 1000 - 1);
    expect(store.getRun(run!.id)?.status).toBe("running");
    expect(launcher.interrupted).toEqual([]);

    await clock.advance(1);
    expect(store.getRun(run!.id)).toMatchObject({
      status: "failed",
      failureReason: "timed_out",
      errorMessage: "Timed out: the run passed its 15 minutes limit and was stopped.",
    });
    expect(launcher.interrupted).toEqual([
      { threadId: "headless-thread-1", turnId: "turn-1" },
    ]);
    expect(timedOut).toEqual([run!.id]);
    expect(clock.timers.size).toBe(0);

    // The interrupted turn's own end arrives later. It cannot reopen the run
    // or start another turn.
    await scheduler.handleTurnQueueUpdate({
      automationRunId: run!.id,
      status: "terminal",
      terminalStatus: "turn/cancelled",
      now: clock.now,
    });
    expect(store.getRun(run!.id)?.failureReason).toBe("timed_out");
    expect(launcher.started).toHaveLength(1);
    expect(store.findActiveRunForAutomation("automation-1")).toBeUndefined();
  });

  it("clears the timeout of a run that finishes in time", async () => {
    const clock = new FakeClock();
    store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Quick",
      taskPrompt: "Quick",
      schedule: { kind: "interval", every: 1, unit: "hours", anchorAt: 0 },
      runTimeoutMs: 15 * 60 * 1000,
      now: 0,
    });
    const scheduler = new AutomationScheduler({
      store,
      runner: new HeadlessAutomationRunner(launcher),
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await scheduler.runNow("automation-1", clock.now);
    const [run] = store.listRunsForAutomation("automation-1");
    await clock.advance(60_000);
    await scheduler.handleTurnQueueUpdate({
      automationRunId: run!.id,
      status: "terminal",
      terminalStatus: "turn/completed",
      now: clock.now,
    });
    expect(clock.timers.size).toBe(0);
    await clock.advance(60 * 60 * 1000);
    expect(store.getRun(run!.id)?.status).toBe("completed");
    expect(launcher.interrupted).toEqual([]);
  });
});

describe("AutomationScheduler daily run limit", () => {
  it("pauses at the limit, raises one card and records later triggers as skipped", async () => {
    store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Busy trigger",
      taskPrompt: "Run",
      schedule: { kind: "interval", every: 1, unit: "hours", anchorAt: 0 },
      dailyRunLimit: 2,
      nextRunAt: 60 * 60 * 1000,
      now: 0,
    });
    const cards: Array<{ limit: number; runsInWindow: number }> = [];
    const scheduler = new AutomationScheduler({
      store,
      runner: new HeadlessAutomationRunner(launcher),
      now: () => now,
      setTimer: (() => 0) as unknown as typeof setTimeout,
      clearTimer: () => undefined,
      onDailyLimitReached: ({ limit, runsInWindow }) => {
        cards.push({ limit, runsInWindow });
      },
    });
    const finish = async () => {
      const active = store.findActiveRunForAutomation("automation-1");
      if (!active) return;
      await scheduler.handleTurnQueueUpdate({
        automationRunId: active.id,
        status: "terminal",
        terminalStatus: "turn/completed",
        now,
      });
    };

    await scheduler.runNow("automation-1", now);
    await finish();
    await scheduler.runNow("automation-1", now);
    await finish();
    expect(launcher.started).toHaveLength(2);

    // The third trigger is refused at admission.
    await scheduler.runNow("automation-1", now);
    expect(launcher.started).toHaveLength(2);
    expect(store.getAutomation("automation-1")).toMatchObject({
      status: "paused",
      pausedReason: "daily_run_limit",
    });
    expect(cards).toEqual([{ limit: 2, runsInWindow: 2 }]);

    // A schedule window while paused is skipped, not run, and adds no card.
    now = 60 * 60 * 1000;
    await scheduler.evaluateDueAutomations();
    expect(launcher.started).toHaveLength(2);
    expect(cards).toHaveLength(1);
    const skipped = store.listRunsForAutomation("automation-1")
      .filter((run) => run.status === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      skipReason: "daily_limit",
      coalescedCount: 2,
      errorMessage:
        "The automation reached its daily run limit of 2 in the last 24 hours and was paused; 2 triggers skipped.",
    });
    expect(store.getAutomation("automation-1")?.nextRunAt).toBe(2 * 60 * 60 * 1000);
  });
});

describe("AutomationScheduler limits review regressions", () => {
  it("arms no timeout for a run whose turn ended before its submission returned", async () => {
    const clock = new FakeClock();
    store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Fast",
      taskPrompt: "Fast",
      schedule: { kind: "interval", every: 1, unit: "hours", anchorAt: 0 },
      runTimeoutMs: 15 * 60 * 1000,
      now: 0,
    });
    const scheduler: AutomationScheduler = new AutomationScheduler({
      store,
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      runner: {
        async submitRun({ run }) {
          await scheduler.handleTurnQueueUpdate({
            automationRunId: run.id,
            status: "terminal",
            terminalStatus: "turn/completed",
            now: clock.now,
          });
          return { status: "started", queueEntryId: "queue-1", turnId: "turn-1" };
        },
      },
    });
    await scheduler.runNow("automation-1", clock.now);
    expect(store.listRunsForAutomation("automation-1")[0]?.status).toBe("completed");
    expect(clock.timers.size).toBe(0);
  });

  it("records messages batched in a window as skipped when the daily limit paused the automation", async () => {
    const clock = new FakeClock();
    store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Inbound",
      taskPrompt: "Answer",
      schedule: { kind: "interval", every: 1, unit: "hours", anchorAt: 0 },
      inboundCoalesceWindowMs: 30_000,
      maxRunsPerHour: null,
      dailyRunLimit: 5,
      now: 0,
    });
    const scheduler = new AutomationScheduler({
      store,
      runner: new HeadlessAutomationRunner(launcher),
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const source = (key: string) => ({
      kind: "messaging",
      sourceEventKey: key,
      receivedAt: clock.now,
      matchedTriggerId: "trigger-1",
      actor: { id: "user-1" },
      conversation: { channel: "slack", conversationId: "C1" },
    }) as unknown as Parameters<AutomationScheduler["runFromInboundEvent"]>[0]["source"];
    const inbound = async (key: string) => {
      const automation = store.getAutomation("automation-1")!;
      await scheduler.runFromInboundEvent({ automation, source: source(key), now: clock.now });
    };

    await inbound("event-1");
    await inbound("event-2");
    await inbound("event-3");
    expect(launcher.started).toHaveLength(1);
    // Another trigger reaches the limit while the window is open.
    store.pauseAutomationForDailyLimit("automation-1", clock.now);

    await clock.advance(30_000);
    expect(launcher.started).toHaveLength(1);
    const skipped = store.listRunsForAutomation("automation-1")
      .filter((run) => run.skipReason === "daily_limit");
    expect(skipped).toHaveLength(1);
    // The first message is written at once; the second waits for the flush.
    scheduler.stop();
    expect(store.getRun(skipped[0]!.id)?.coalescedCount).toBe(2);
  });
});
