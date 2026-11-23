import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutomationStore } from "../storage/automation-store";
import { StateDb } from "../state/state-db";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

let stateDb: StateDb;
let store: AutomationStore;

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  store = new AutomationStore(stateDb, { runHistoryLimit: 3 });
});

afterEach(() => {
  stateDb.close();
});

function createRun() {
  store.createAutomation({
    id: "automation-1",
    backend: "codex",
    threadId: "thread-1",
    name: "Check email",
    taskPrompt: "Check mail",
    schedule: { kind: "interval", every: 5, unit: "minutes" },
    now: 0,
  });
  store.createRun({ id: "run-1", automationId: "automation-1", trigger: "manual", now: 0 });
}

describe("AutomationStore", () => {
  it("rolls back the lifetime total if recording operation usage fails", () => {
    createRun();
    const usage = { totalCostMicros: 100 };
    store.setRunUsage({ runId: "run-1", usage });
    stateDb.raw.exec(`
      CREATE TRIGGER reject_run_usage BEFORE UPDATE ON automation_runs
      BEGIN SELECT RAISE(ABORT, 'run usage rejected'); END;
    `);
    expect(() => store.setRunUsage({ runId: "run-1", usage: { totalCostMicros: 20 } }))
      .toThrow("run usage rejected");
    expect(store.getRun("run-1")?.usage).toEqual(usage);
    expect(store.getAutomation("automation-1")?.lifetimeCost).toEqual({ since: 0, totalMicros: 100 });
  });

  it("starts coverage at migration and preserves it across reopen", () => {
    const { dbPath, tempDir } = createTempStateDb("pwragent-automation-cost-");
    let db = StateDb.open(dbPath);
    try {
      let migrated = new AutomationStore(db, { runHistoryLimit: 1 });
      const automation = migrated.createAutomation({
        backend: "codex", threadId: "thread-1", name: "Legacy automation", taskPrompt: "Check.",
        schedule: { kind: "interval", every: 5, unit: "minutes" }, now: 1,
      });
      const oldRun = migrated.createRun({ automationId: automation.id, trigger: "manual", now: 2 })!;
      migrated.markRunStarted({ runId: oldRun.id, backendTurnId: "old-turn", now: 3 });
      migrated.markRunTerminal({ runId: oldRun.id, status: "completed", now: 4 });
      migrated.setRunUsage({ runId: oldRun.id, usage: { totalCostMicros: 900 }, now: 4 });
      db.raw.exec(`
        DROP TABLE automation_pruned_run_costs;
        ALTER TABLE automation_runs DROP COLUMN accounted_cost_micros;
        ALTER TABLE automations DROP COLUMN total_cost_micros;
        ALTER TABLE automations DROP COLUMN cost_since;
        PRAGMA user_version = 86;
      `);
      db.close();
      const migrationStarted = Date.now();
      db = StateDb.open(dbPath);
      const migrationEnded = Date.now();
      migrated = new AutomationStore(db, { runHistoryLimit: 1 });
      expect(migrated.getRun(oldRun.id)?.usage?.totalCostMicros).toBe(900);
      migrated.setRunUsage({ runId: oldRun.id, usage: { totalCostMicros: 850 }, now: migrationEnded });
      expect(migrated.getAutomation(automation.id)?.lifetimeCost).toBeUndefined();

      const now = migrationEnded + 1;
      const covered = migrated.createRun({ automationId: automation.id, trigger: "manual", now })!;
      migrated.markRunStarted({ runId: covered.id, backendTurnId: "covered-turn", now });
      migrated.setRunUsage({ runId: covered.id, usage: { totalCostMicros: 123 }, now });
      const lifetime = migrated.getAutomation(automation.id)?.lifetimeCost;
      expect(lifetime?.totalMicros).toBe(123);
      expect(lifetime?.since).toBeGreaterThanOrEqual(migrationStarted);
      expect(lifetime?.since).toBeLessThanOrEqual(migrationEnded);
      expect(migrated.findPrunedRunCostsByBackendTurnIds({ backend: "codex", backendTurnIds: ["old-turn"] }).size).toBe(0);

      db.close();
      db = StateDb.open(dbPath);
      expect(new AutomationStore(db).getAutomation(automation.id)?.lifetimeCost).toEqual(lifetime);
    } finally {
      if (db.raw.open) db.close();
      removeTempStateDbDir(tempDir);
    }
  });

  it("starts coverage on re-upgrade for rows inserted by a downgraded writer", () => {
    const { dbPath, tempDir } = createTempStateDb("pwragent-automation-cost-downgrade-");
    let db = StateDb.open(dbPath);
    try {
      let reopened = new AutomationStore(db);
      reopened.createAutomation({
        id: "tracked", backend: "codex", threadId: "thread-1", name: "Previously tracked",
        taskPrompt: "Check.", schedule: { kind: "interval", every: 5, unit: "minutes" }, now: 1,
      });
      reopened.createRun({ id: "tracked-run", automationId: "tracked", trigger: "manual", now: 2 });
      reopened.setRunUsage({ runId: "tracked-run", usage: { totalCostMicros: 70 }, now: 2 });
      db.close();

      db = StateDb.open(dbPath);
      // The older build uses the same profile and omits the new cost columns
      // from INSERT. It leaves the upgraded schema version in place.
      db.raw.exec(`
        INSERT INTO automations (
          automation_id, backend, thread_id, name, status, backlog_policy, created_at, updated_at, payload
        )
        SELECT 'downgraded', backend, thread_id, 'Added during downgrade', status,
               backlog_policy, 3, 3, payload FROM automations WHERE automation_id = 'tracked'
      `);
      reopened = new AutomationStore(db);
      reopened.createRun({ id: "uncovered-run", automationId: "downgraded", trigger: "manual", now: 4 });
      reopened.setRunUsage({ runId: "uncovered-run", usage: { totalCostMicros: 300 }, now: 4 });
      db.close();

      const before = Date.now();
      db = StateDb.open(dbPath);
      const after = Date.now();
      reopened = new AutomationStore(db);
      reopened.setRunUsage({ runId: "uncovered-run", usage: { totalCostMicros: 320 } });
      expect(reopened.getAutomation("downgraded")?.lifetimeCost).toBeUndefined();
      reopened.createRun({ id: "covered-run", automationId: "downgraded", trigger: "manual", now: after + 1 });
      reopened.setRunUsage({ runId: "covered-run", usage: { totalCostMicros: 90 } });
      const coverage = reopened.getAutomation("downgraded")?.lifetimeCost;
      expect(coverage?.totalMicros).toBe(90);
      expect(coverage?.since).toBeGreaterThanOrEqual(before);
      expect(coverage?.since).toBeLessThanOrEqual(after);
      expect(reopened.getAutomation("tracked")?.lifetimeCost).toEqual({ since: 1, totalMicros: 70 });
      db.close();

      db = StateDb.open(dbPath);
      expect(new AutomationStore(db).getAutomation("downgraded")?.lifetimeCost).toEqual(coverage);
    } finally {
      if (db.raw.open) db.close();
      removeTempStateDbDir(tempDir);
    }
  });

  it("keeps a run running when its queued acknowledgement arrives late", () => {
    createRun();
    store.markRunStarted({ runId: "run-1", backendTurnId: "turn-1", now: 100 });

    expect(store.markRunQueued({ runId: "run-1", queueEntryId: "queue-1", now: 50 }))
      .toMatchObject({ status: "running", startedAt: 100, queueEntryId: "queue-1" });
    store.markRunStarted({
      runId: "run-1",
      backendThreadId: "headless-1",
      backendTurnId: "turn-1",
      now: 200,
    });

    expect(store.getRun("run-1")).toMatchObject({
      status: "running",
      startedAt: 100,
      backendThreadId: "headless-1",
      backendTurnId: "turn-1",
      queueEntryId: "queue-1",
    });
    expect(store.getRun("run-1")?.queuedAt).toBeUndefined();
  });

  it.each(["completed", "failed", "cancelled", "skipped"] as const)(
    "retains late identities without reopening a %s run",
    (status) => {
      createRun();
      store.markRunTerminal({ runId: "run-1", status, errorMessage: "Original outcome", now: 1_000 });
      const automation = store.getAutomation("automation-1");

      store.markRunStarted({
        runId: "run-1",
        backendThreadId: "headless-1",
        backendTurnId: "turn-1",
        now: 2_000,
      });
      store.markRunQueued({ runId: "run-1", queueEntryId: "queue-1", now: 3_000 });
      // Conflicting late identities must not replace the first known turn.
      store.markRunStarted({
        runId: "run-1",
        backendThreadId: "headless-other",
        backendTurnId: "turn-other",
        now: 4_000,
      });

      expect(store.getRun("run-1")).toMatchObject({
        status,
        completedAt: 1_000,
        errorMessage: "Original outcome",
        backendThreadId: "headless-1",
        backendTurnId: "turn-1",
        queueEntryId: "queue-1",
      });
      expect(store.getRun("run-1")?.startedAt).toBeUndefined();
      expect(store.getRun("run-1")?.queuedAt).toBeUndefined();
      expect(store.findActiveRunForAutomation("automation-1")).toBeUndefined();
      expect(store.getAutomation("automation-1")).toEqual(automation);
    },
  );

  it.each(["completed", "failed", "cancelled", "skipped"] as const)(
    "ignores duplicate and conflicting terminal outcomes after %s",
    (status) => {
      createRun();
      const first = store.markRunTerminal({
        runId: "run-1",
        status,
        errorMessage: "First outcome",
        now: 1_000,
      });
      expect(first?.status).toBe(status);
      store.createRun({ id: "run-2", automationId: "automation-1", trigger: "manual", now: 2_000 });
      store.markRunTerminal({ runId: "run-2", status: "completed", now: 3_000 });
      const automation = store.getAutomation("automation-1");

      for (const nextStatus of [status, "completed", "failed", "cancelled", "skipped"] as const) {
        expect(store.markRunTerminal({
          runId: "run-1",
          status: nextStatus,
          errorMessage: "Late outcome",
          skipReason: "rate_limited",
          coalescedCount: 10,
          now: 4_000,
        })).toEqual(first);
      }

      expect(store.getRun("run-1")).toEqual(first);
      expect(store.getAutomation("automation-1")).toEqual(automation);
    },
  );

  it("creates, updates, pauses, resumes, and soft-deletes automation records", () => {
    const created = store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check for important mail",
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
      nextRunAt: 10_000,
      now: 1_000,
    });

    expect(created).toMatchObject({
      id: "automation-1",
      backlogPolicy: "coalesce",
      scheduleSummary: "every 5 minutes",
      status: "enabled",
    });
    expect(store.getAutomation("automation-1")).toMatchObject({
      taskPrompt: "Check for important mail",
    });

    store.updateAutomation("automation-1", {
      threadId: "thread-2",
      name: "Review inbox",
      backlogPolicy: "drop_missed",
      now: 2_000,
    });
    expect(store.listAutomationsForThread({ backend: "codex", threadId: "thread-1" }))
      .toEqual([]);
    expect(store.listAutomationsForThread({ backend: "codex", threadId: "thread-2" }))
      .toEqual([
        expect.objectContaining({
          threadId: "thread-2",
          name: "Review inbox",
          backlogPolicy: "drop_missed",
          updatedAt: 2_000,
        }),
      ]);

    expect(store.pauseAutomation("automation-1", 3_000)).toMatchObject({
      status: "paused",
    });
    expect(store.resumeAutomation("automation-1", { nextRunAt: 20_000, now: 4_000 }))
      .toMatchObject({
        status: "enabled",
        nextRunAt: 20_000,
      });
    expect(store.deleteAutomation("automation-1", 5_000)).toMatchObject({
      status: "deleted",
      deletedAt: 5_000,
    });
    expect(store.getAutomation("automation-1")).toBeUndefined();
    expect(store.getAutomation("automation-1", { includeDeleted: true })).toMatchObject({
      status: "deleted",
    });
  });

  it("persists run history, terminal updates, and thread summaries", () => {
    store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
      nextRunAt: 10_000,
      now: 1_000,
    });
    const run = store.createRun({
      id: "run-1",
      automationId: "automation-1",
      trigger: "scheduled",
      scheduledFor: 10_000,
      now: 10_000,
    });

    expect(run).toMatchObject({
      id: "run-1",
      status: "pending",
      scheduledWindows: [{ scheduledFor: 10_000 }],
    });
    store.markRunQueued({
      runId: "run-1",
      queueEntryId: "queue-1",
      queuedAt: 10_100,
      now: 10_100,
    });
    store.markRunStarted({
      runId: "run-1",
      backendTurnId: "turn-1",
      startedAt: 10_200,
      now: 10_200,
    });
    store.markRunTerminal({
      runId: "run-1",
      status: "completed",
      completedAt: 12_000,
      now: 12_000,
    });

    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({
        id: "run-1",
        status: "completed",
        backendTurnId: "turn-1",
        completedAt: 12_000,
      }),
    ]);
    expect(store.getAutomation("automation-1")).toMatchObject({
      lastRunAt: 12_000,
      lastRunStatus: "completed",
    });
    expect(store.buildThreadSummaries()["codex:thread-1"]).toMatchObject({
      totalCount: 1,
      enabledCount: 1,
      nextRunAt: 10_000,
      lastRunAt: 12_000,
      pendingRunCount: 0,
    });
  });

  it("persists run artifacts and read-only transcript events", () => {
    store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
      now: 1_000,
    });
    store.createRun({
      id: "run-1",
      automationId: "automation-1",
      trigger: "manual",
      now: 2_000,
    });
    store.markRunStarted({
      runId: "run-1",
      backendTurnId: "turn-1",
      startedAt: 2_100,
      now: 2_100,
    });
    store.markRunTerminal({
      runId: "run-1",
      status: "completed",
      completedAt: 3_000,
      now: 3_000,
    });

    expect(
      store.upsertRunArtifact({
        runId: "run-1",
        status: "completed",
        finalText: "Nothing urgent.",
        transcriptEvents: [
          {
            id: "run-1:assistant-final",
            at: 3_000,
            kind: "assistant_final",
            text: "Nothing urgent.",
          },
        ],
        now: 3_000,
      }),
    ).toMatchObject({
      runId: "run-1",
      automationId: "automation-1",
      status: "completed",
      finalText: "Nothing urgent.",
      createdAt: 3_000,
      updatedAt: 3_000,
    });
    expect(store.getRunArtifact("run-1")).toEqual({
      runId: "run-1",
      automationId: "automation-1",
      status: "completed",
      finalText: "Nothing urgent.",
      errorMessage: undefined,
      outputDecision: undefined,
      actionResults: [],
      transcriptEvents: [
        {
          id: "run-1:assistant-final",
          at: 3_000,
          kind: "assistant_final",
          text: "Nothing urgent.",
        },
      ],
      createdAt: 3_000,
      updatedAt: 3_000,
    });
  });

  it("listEnabledInboundAutomations returns only enabled automations with inbound triggers", () => {
    store.createAutomation({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Scheduled",
      taskPrompt: "Check mail",
      schedule: { kind: "interval", every: 5, unit: "minutes" },
      now: 1_000,
    });
    const enabledInbound = store.createAutomation({
      id: "inbound-enabled",
      backend: "codex",
      threadId: "thread-1",
      name: "Enabled inbound",
      taskPrompt: "Triage.",
      triggers: [
        {
          id: "t",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C1" },
          textFilter: { mode: "contains", text: "ERROR" },
        },
      ],
      now: 1_000,
    });
    const pausedInbound = store.createAutomation({
      id: "inbound-paused",
      backend: "codex",
      threadId: "thread-1",
      name: "Paused inbound",
      taskPrompt: "Triage.",
      triggers: [
        {
          id: "t",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C2" },
          textFilter: { mode: "contains", text: "WARN" },
        },
      ],
      now: 1_000,
    });
    store.updateAutomation(pausedInbound.id, { status: "paused" });

    const ids = store.listEnabledInboundAutomations().map((a) => a.id);
    expect(ids).toEqual([enabledInbound.id]);
  });

  it("collapses duplicate assistant_final transcript events with the same text", () => {
    store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      schedule: { kind: "interval", every: 5, unit: "minutes" },
      now: 1_000,
    });
    store.createRun({
      id: "run-1",
      automationId: "automation-1",
      trigger: "manual",
      now: 2_000,
    });
    store.markRunTerminal({
      runId: "run-1",
      status: "completed",
      completedAt: 3_000,
      now: 3_000,
    });

    // The run-artifact builder records the final under one id.
    store.upsertRunArtifact({
      runId: "run-1",
      status: "completed",
      finalText: "Harold sent the message.",
      transcriptEvents: [
        {
          id: "run-1:assistant-final",
          at: 3_000,
          kind: "assistant_final",
          text: "Harold sent the message.",
        },
      ],
      now: 3_000,
    });
    // The streamed item/completed event records the same text under a different
    // id. Without dedup this would surface as two identical assistant rows.
    store.appendRunTranscriptEvent({
      runId: "run-1",
      event: {
        id: "run-1:assistant:item-9",
        at: 3_010,
        kind: "assistant_final",
        text: "Harold sent the message.",
      },
      now: 3_010,
    });

    const transcript = store.getRunArtifact("run-1")?.transcriptEvents ?? [];
    expect(
      transcript.filter((event) => event.kind === "assistant_final"),
    ).toHaveLength(1);
  });

  it("defaults legacy scheduled automations and persists inbound trigger metadata", () => {
    const legacy = store.createAutomation({
      id: "automation-legacy",
      backend: "codex",
      threadId: "thread-1",
      name: "Legacy schedule",
      taskPrompt: "Check mail",
      schedule: {
        kind: "interval",
        every: 15,
        unit: "minutes",
      },
      now: 1_000,
    });

    expect(legacy.triggers).toEqual([
      {
        id: "schedule",
        kind: "schedule",
        schedule: {
          kind: "interval",
          every: 15,
          unit: "minutes",
        },
      },
    ]);
    expect(legacy.outputActions).toEqual([
      { id: "agent-context", kind: "agent_context" },
    ]);

    const inbound = store.createAutomation({
      id: "automation-inbound",
      backend: "codex",
      threadId: "thread-1",
      name: "Datadog alert triage",
      taskPrompt: "Investigate this alert.",
      triggers: [
        {
          id: "datadog-error",
          kind: "inbound_message",
          name: "Datadog ERROR",
          conversation: {
            channel: "slack",
            conversationId: "C123",
            conversationKind: "channel",
            title: "alerts",
          },
          sender: {
            platformUserId: "B123",
            isBot: true,
          },
          textFilter: {
            mode: "contains",
            text: "ERROR",
            caseSensitive: false,
          },
        },
      ],
      executionProfile: {
        model: "gpt-5.4",
        reasoningEffort: "high",
        mcpAllowlist: ["datadog", "aws-readonly"],
      },
      outputActions: [
        { id: "agent-context", kind: "agent_context" },
        {
          id: "slack-thread",
          kind: "source_message",
          destination: "source_thread",
          broadcast: true,
        },
      ],
      now: 2_000,
    });

    expect(inbound.schedule).toBeUndefined();
    expect(inbound.scheduleSummary).toBe("inbound: Datadog ERROR");
    expect(store.getAutomation("automation-inbound")).toMatchObject({
      triggers: inbound.triggers,
      executionProfile: inbound.executionProfile,
      outputActions: inbound.outputActions,
    });
  });

  it("names every watched conversation in a multi-source trigger summary", () => {
    const source = (conversationId: string, title?: string) => ({
      id: `inbound-message:slack::${conversationId}`,
      kind: "inbound_message" as const,
      name: "text contains \"ERROR\"",
      conversation: {
        channel: "slack" as const,
        conversationId,
        conversationKind: "channel" as const,
        ...(title ? { title } : {}),
      },
    });

    const two = store.createAutomation({
      backend: "codex",
      threadId: "thread-1",
      name: "Two channels",
      taskPrompt: "Investigate.",
      triggers: [source("C1", "f-alerts"), source("C2", "f-metrics")],
    });
    expect(two.scheduleSummary).toBe(
      "inbound from f-alerts, f-metrics: text contains \"ERROR\"",
    );
    // Every source is persisted, not just the first.
    expect(store.getAutomation(two.id)?.triggers).toHaveLength(2);

    // Past the cap the rest are counted; an untitled source falls back to its
    // raw id rather than vanishing from the list.
    const five = store.createAutomation({
      backend: "codex",
      threadId: "thread-1",
      name: "Five channels",
      taskPrompt: "Investigate.",
      triggers: [
        source("C1", "f-alerts"),
        source("C2", "f-metrics"),
        source("C3"),
        source("C4", "f-deploys"),
        source("C5", "f-oncall"),
      ],
    });
    expect(five.scheduleSummary).toBe(
      "inbound from f-alerts, f-metrics, C3 +2 more: text contains \"ERROR\"",
    );

    // A single source keeps the summary it always had.
    const one = store.createAutomation({
      backend: "codex",
      threadId: "thread-1",
      name: "One channel",
      taskPrompt: "Investigate.",
      triggers: [source("C1", "f-alerts")],
    });
    expect(one.scheduleSummary).toBe("inbound: text contains \"ERROR\"");
  });

  it("persists inbound run source metadata and action results", () => {
    store.createAutomation({
      id: "automation-inbound",
      backend: "codex",
      threadId: "thread-1",
      name: "Datadog alert triage",
      taskPrompt: "Investigate this alert.",
      triggers: [
        {
          id: "datadog-error",
          kind: "inbound_message",
          conversation: {
            channel: "slack",
            conversationId: "C123",
          },
          textFilter: { mode: "contains", text: "ERROR" },
        },
      ],
      now: 1_000,
    });

    store.createRun({
      id: "run-inbound",
      automationId: "automation-inbound",
      trigger: "inbound_message",
      source: {
        kind: "messaging",
        eventId: "slack-event-1",
        sourceEventKey: "slack:C123:171.000:B123",
        receivedAt: 2_000,
        matchedTriggerId: "datadog-error",
        actor: {
          platformUserId: "B123",
          isBot: true,
        },
        conversation: {
          channel: "slack",
          conversationId: "C123",
          conversationKind: "channel",
        },
        message: {
          text: "ERROR api failed",
        },
        routingState: {
          opaque: {
            channelId: "C123",
            ts: "171.000",
          },
        },
      },
      now: 2_000,
    });

    expect(store.getRun("run-inbound")).toMatchObject({
      trigger: "inbound_message",
      source: {
        sourceEventKey: "slack:C123:171.000:B123",
        matchedTriggerId: "datadog-error",
        actor: {
          platformUserId: "B123",
          isBot: true,
        },
      },
    });

    store.upsertRunArtifact({
      runId: "run-inbound",
      status: "completed",
      finalText: "Investigated.",
      actionResults: [
        {
          actionId: "slack-thread",
          kind: "source_message",
          status: "completed",
          completedAt: 3_000,
        },
      ],
      now: 3_000,
    });

    expect(store.getRunArtifact("run-inbound")).toMatchObject({
      actionResults: [
        {
          actionId: "slack-thread",
          kind: "source_message",
          status: "completed",
          completedAt: 3_000,
        },
      ],
    });
  });

  it("coalesces later scheduled windows into the existing pending scheduled run", () => {
    store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
      now: 1_000,
    });
    store.createRun({
      id: "run-1",
      automationId: "automation-1",
      trigger: "scheduled",
      scheduledFor: 10_000,
      now: 10_000,
    });

    expect(
      store.coalescePendingScheduledRun({
        automationId: "automation-1",
        scheduledWindows: [{ scheduledFor: 15_000 }, { scheduledFor: 10_000 }],
        now: 15_000,
      }),
    ).toMatchObject({
      id: "run-1",
      scheduledWindows: [
        { scheduledFor: 10_000 },
        { scheduledFor: 15_000 },
      ],
    });
    expect(store.listRunsForAutomation("automation-1")).toHaveLength(1);
    expect(store.buildThreadSummaries()["codex:thread-1"]).toMatchObject({
      pendingRunCount: 1,
      coalescedWindowCount: 1,
    });
  });

  it("finds the active run for an automation execution lane", () => {
    store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
      now: 1_000,
    });
    const run = store.createRun({
      id: "run-1",
      automationId: "automation-1",
      trigger: "scheduled",
      scheduledFor: 10_000,
      now: 10_000,
    });
    expect(run).toBeDefined();

    expect(store.findActiveRunForAutomation("automation-1")).toMatchObject({
      id: "run-1",
      status: "pending",
    });

    store.markRunTerminal({
      runId: "run-1",
      status: "completed",
      completedAt: 12_000,
      now: 12_000,
    });

    expect(store.findActiveRunForAutomation("automation-1")).toBeUndefined();
  });

  it("finds each backend turn's run in one lookup with the per-turn rule", () => {
    for (const id of ["automation-a", "automation-b"]) {
      store.createAutomation({
        id,
        backend: "codex",
        threadId: `thread-${id}`,
        name: id,
        taskPrompt: "Check mail",
        schedule: { kind: "interval", every: 5, unit: "minutes" },
        now: 1_000,
      });
    }
    const startRun = (runId: string, automationId: string, backendTurnId: string, at: number) => {
      store.createRun({ id: runId, automationId, trigger: "scheduled", now: at });
      store.markRunStarted({ runId, backendTurnId, now: at });
    };
    // turn-a: an older running run beats a newer completed one.
    startRun("run-a-running", "automation-a", "turn-a", 2_000);
    startRun("run-a-completed", "automation-a", "turn-a", 3_000);
    store.markRunTerminal({ runId: "run-a-completed", status: "completed", now: 4_000 });
    // turn-b: with nothing running, the newest run wins.
    startRun("run-b-old", "automation-b", "turn-b", 5_000);
    store.markRunTerminal({ runId: "run-b-old", status: "completed", now: 5_500 });
    startRun("run-b-new", "automation-b", "turn-b", 6_000);
    store.markRunTerminal({ runId: "run-b-new", status: "failed", now: 6_500 });

    const turnIds = ["turn-a", "turn-b", "turn-none"];
    const runs = store.findRunsByBackendTurnIds({ backend: "codex", backendTurnIds: turnIds });

    expect(Object.fromEntries([...runs].map(([turnId, run]) => [turnId, run.id]))).toEqual({
      "turn-a": "run-a-running",
      "turn-b": "run-b-new",
    });
    for (const backendTurnId of turnIds) {
      const perTurn =
        store.findRunningRunByBackendTurnId({ backend: "codex", backendTurnId })
        ?? store.findRunByBackendTurnId({ backend: "codex", backendTurnId });
      expect(runs.get(backendTurnId)).toEqual(perTurn);
    }
    expect(store.findRunsByBackendTurnIds({ backend: "claude", backendTurnIds: turnIds }).size).toBe(0);
  });

  it("countRecentInboundRuns counts inbound runs in the window, excluding skipped", () => {
    // The shared store keeps only runHistoryLimit (3) runs, so keep to 3.
    store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Rate",
      taskPrompt: "Triage.",
      triggers: [
        {
          id: "t",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C1" },
          textFilter: { mode: "contains", text: "ERROR" },
        },
      ],
      now: 0,
    });
    const inbound = (id: string, createdAt: number) =>
      store.createRun({
        id,
        automationId: "automation-1",
        trigger: "inbound_message",
        now: createdAt,
      });
    inbound("r-old", 1_000);
    inbound("r-mid", 5_000);
    inbound("r-skip", 6_000);
    store.markRunTerminal({
      runId: "r-skip",
      status: "skipped",
      completedAt: 6_000,
      now: 6_000,
    });

    // From 4_000: only r-mid (r-old is before the window; r-skip is skipped and
    // never started).
    expect(
      store.countRecentInboundRuns({ automationId: "automation-1", sinceMs: 4_000 }),
    ).toBe(1);
    // From 0: r-old + r-mid count; the skipped run stays excluded.
    expect(
      store.countRecentInboundRuns({ automationId: "automation-1", sinceMs: 0 }),
    ).toBe(2);
  });

  it("round-trips skip metadata through the run payload", () => {
    store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Rate",
      taskPrompt: "Triage.",
      triggers: [
        {
          id: "t",
          kind: "inbound_message",
          conversation: { channel: "slack", conversationId: "C1" },
          textFilter: { mode: "contains", text: "ERROR" },
        },
      ],
      now: 0,
    });
    store.createRun({
      id: "r1",
      automationId: "automation-1",
      trigger: "inbound_message",
      now: 1_000,
    });
    store.markRunTerminal({
      runId: "r1",
      status: "skipped",
      skipReason: "rate_limited",
      errorMessage: "throttled",
      coalescedCount: 7,
      completedAt: 1_000,
      now: 1_000,
    });

    // skipReason + coalescedCount survive the JSON payload round-trip.
    const stored = store.getRun("r1");
    expect(stored?.skipReason).toBe("rate_limited");
    expect(stored?.coalescedCount).toBe(7);
  });

  // PWR-201: this asserted `cancelled`, which read as an operator cancel and
  // kept the loss off the Agent thread. A run with no recorded owner is dead.
  it("reports stale local runs as interrupted on startup without creating catch-up rows", () => {
    store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
      nextRunAt: 5_000,
      now: 1_000,
    });
    store.createRun({
      id: "run-1",
      automationId: "automation-1",
      trigger: "scheduled",
      scheduledFor: 5_000,
      status: "queued",
      queuedAt: 5_100,
      now: 5_100,
    });

    store.reconcileStartup({
      now: 20_000,
      nextRunAtByAutomationId: {
        "automation-1": 25_000,
      },
    });

    expect(store.listRunsForAutomation("automation-1")).toEqual([
      expect.objectContaining({
        id: "run-1",
        status: "failed",
        failureReason: "interrupted",
        completedAt: 20_000,
        errorMessage: "PwrAgent stopped before this automation run finished. The run was not resumed.",
      }),
    ]);
    expect(store.getAutomation("automation-1")).toMatchObject({
      lastRunStatus: "failed",
      nextRunAt: 25_000,
    });
  });

  it("keeps a next run that is still ahead, so a second launch cannot move a live schedule", () => {
    store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      schedule: { kind: "interval", every: 5, unit: "minutes" },
      nextRunAt: 30_000,
      now: 1_000,
    });

    expect(store.reconcileStartup({
      now: 20_000,
      nextRunAtByAutomationId: { "automation-1": 320_000 },
    })).toEqual({ interruptedRuns: [], resumedRuns: [], liveOwnerRunCount: 0, rescheduledAutomationCount: 0 });
    expect(store.getAutomation("automation-1")?.nextRunAt).toBe(30_000);
  });

  it("corrects a stored next run that is later than the schedule's next occurrence", () => {
    store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      schedule: { kind: "interval", every: 5, unit: "minutes" },
      // Stored while the clock was a day ahead.
      nextRunAt: 86_400_000,
      now: 1_000,
    });

    expect(store.reconcileStartup({
      now: 20_000,
      nextRunAtByAutomationId: { "automation-1": 320_000 },
    })).toMatchObject({ rescheduledAutomationCount: 1 });
    expect(store.getAutomation("automation-1")?.nextRunAt).toBe(320_000);
  });

  it("caps detailed run history per automation", () => {
    store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
      now: 1_000,
    });

    for (let index = 1; index <= 4; index += 1) {
      store.createRun({
        id: `run-${index}`,
        automationId: "automation-1",
        trigger: "scheduled",
        status: "skipped",
        scheduledFor: index * 1_000,
        now: index * 1_000,
      });
    }

    expect(store.listRunsForAutomation("automation-1", 10).map((run) => run.id))
      .toEqual(["run-4", "run-3", "run-2"]);
  });

  it("handles malformed persisted payloads as recoverable read omissions", () => {
    stateDb.raw
      .prepare(
        `INSERT INTO automations (
          automation_id,
          backend,
          thread_id,
          name,
          status,
          backlog_policy,
          created_at,
          updated_at,
          payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "automation-bad",
        "codex",
        "thread-1",
        "Broken",
        "enabled",
        "coalesce",
        1_000,
        1_000,
        "{not-json",
      );

    expect(store.getAutomation("automation-bad")).toBeUndefined();
    expect(store.listAutomations()).toEqual([]);
  });

  it("persists SQL-looking names and prompts through bound parameters", () => {
    const created = store.createAutomation({
      id: "automation-1",
      backend: "codex",
      threadId: "thread-1",
      name: "Robert'); DROP TABLE automations;--",
      taskPrompt: "Check \"mail\" where subject = 'urgent';",
      schedule: {
        kind: "weekdays",
        timeOfDay: {
          hour: 9,
          minute: 0,
        },
      },
      now: 1_000,
    });

    expect(created.name).toBe("Robert'); DROP TABLE automations;--");
    expect(store.getAutomation("automation-1")).toMatchObject({
      taskPrompt: "Check \"mail\" where subject = 'urgent';",
      scheduleSummary: "weekdays at 9 AM",
    });
    expect(
      stateDb.raw
        .prepare("SELECT COUNT(*) AS count FROM automations")
        .get(),
    ).toEqual({ count: 1 });
  });

  function insertRawAutomationRow(params: {
    id: string;
    name: string;
    status?: string;
    payload: string;
  }): void {
    stateDb.raw
      .prepare(
        `INSERT INTO automations (
          automation_id, backend, thread_id, name, status, backlog_policy,
          next_run_at, last_run_at, created_at, updated_at, deleted_at, payload
        ) VALUES (?, 'codex', 'thread-1', ?, ?, 'coalesce', NULL, NULL, 1000, 1000, NULL, ?)`,
      )
      .run(params.id, params.name, params.status ?? "enabled", params.payload);
  }

  it("skips automations it can't load without mutating or running them", () => {
    // A trigger-only automation written by a newer build: enabled, but its
    // payload has no schedule this version understands.
    insertRawAutomationRow({
      id: "automation-future",
      name: "Slack trigger",
      payload: JSON.stringify({
        taskPrompt: "do the thing",
        triggers: [{ kind: "inbound_message" }],
        scheduleSummary: "inbound",
      }),
    });
    // A corrupt payload.
    insertRawAutomationRow({
      id: "automation-corrupt",
      name: "Corrupt one",
      payload: "{not valid json",
    });
    // A normal, loadable automation alongside them.
    store.createAutomation({
      id: "automation-ok",
      backend: "codex",
      threadId: "thread-1",
      name: "Healthy",
      taskPrompt: "ok",
      schedule: { kind: "interval", every: 5, unit: "minutes" },
      now: 1_000,
    });

    // Only the healthy automation is returned; the unloadable ones are skipped.
    expect(store.listAutomations().map((automation) => automation.id)).toEqual([
      "automation-ok",
    ]);

    // The skipped rows are reported, not silently dropped.
    const issues = store.getAutomationLoadIssues();
    expect(issues.map((issue) => issue.id).sort()).toEqual([
      "automation-corrupt",
      "automation-future",
    ]);
    expect(issues.find((issue) => issue.id === "automation-future")?.name).toBe(
      "Slack trigger",
    );

    // The underlying rows are untouched — not paused, not deleted.
    const rows = stateDb.raw
      .prepare(
        "SELECT status FROM automations WHERE automation_id IN ('automation-future', 'automation-corrupt') ORDER BY automation_id",
      )
      .all() as Array<{ status: string }>;
    expect(rows).toEqual([{ status: "enabled" }, { status: "enabled" }]);
  });

  it("does not report skipped issues for soft-deleted unloadable rows", () => {
    insertRawAutomationRow({
      id: "automation-deleted",
      name: "Deleted future automation",
      status: "deleted",
      payload: JSON.stringify({ taskPrompt: "x", triggers: [] }),
    });
    expect(store.listAutomations()).toEqual([]);
    expect(store.getAutomationLoadIssues()).toEqual([]);
  });
});

describe("automation run usage", () => {
  it("persists distilled usage on the run payload and round-trips it", () => {
    {
      const automation = store.createAutomation({
        backend: "codex",
        threadId: "thread-1",
        name: "Usage",
        taskPrompt: "Check.",
        schedule: { kind: "interval", every: 5, unit: "minutes", anchorAt: 0 },
        now: 0,
      });
      const run = store.createRun({
        automationId: automation.id,
        trigger: "manual",
        scheduledWindows: [],
        now: 1_000,
      });
      expect(run).toBeDefined();

      const updated = store.setRunUsage({
        runId: run!.id,
        usage: {
          model: "gpt-5.6-sol",
          uncachedInputTokens: 6_356,
          cachedInputTokens: 581_888,
          outputTokens: 1_192,
          reasoningOutputTokens: 668,
          totalCostMicros: 380_000,
          currency: "USD",
        },
        now: 2_000,
      });
      expect(updated?.usage?.totalCostMicros).toBe(380_000);

      const [listed] = store.listRunsForAutomation(automation.id, 1);
      expect(listed?.usage).toEqual({
        model: "gpt-5.6-sol",
        uncachedInputTokens: 6_356,
        cachedInputTokens: 581_888,
        outputTokens: 1_192,
        reasoningOutputTokens: 668,
        totalCostMicros: 380_000,
        currency: "USD",
      });
    }
  });
});
