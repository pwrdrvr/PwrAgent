import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutomationStore } from "../automations/automation-store";
import { StateDb } from "../state/state-db";

let tempDir: string;
let stateDb: StateDb;
let store: AutomationStore;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-automations-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new AutomationStore(stateDb, { runHistoryLimit: 3 });
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("AutomationStore", () => {
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

  it("reconciles stale local runs on startup without creating catch-up rows", () => {
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
        status: "cancelled",
        completedAt: 20_000,
        errorMessage: "PwrAgent restarted before this local automation run completed.",
      }),
    ]);
    expect(store.getAutomation("automation-1")).toMatchObject({
      nextRunAt: 25_000,
    });
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
