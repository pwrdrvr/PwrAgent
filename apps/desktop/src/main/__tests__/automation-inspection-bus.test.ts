import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AutomationInspectionBus } from "../automations/automation-inspection-bus";
import { AutomationStore } from "../automations/automation-store";
import { StateDb } from "../state/state-db";

let tempDir: string;
let stateDb: StateDb;
let store: AutomationStore;
let bus: AutomationInspectionBus;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-automation-tools-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new AutomationStore(stateDb);
  bus = new AutomationInspectionBus(store);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("AutomationInspectionBus", () => {
  it("lists attached automations with latest run summaries", () => {
    const automation = createAutomation({ id: "automation:weather" });
    const run = store.createRun({
      id: "automation-run:weather-1",
      automationId: automation.id,
      trigger: "scheduled",
      status: "completed",
      scheduledFor: 1_000,
      now: 1_100,
    });
    expect(run).toBeDefined();
    store.upsertRunArtifact({
      runId: run!.id,
      status: "completed",
      finalText: "Rain is starting.",
      outputDecision: {
        kind: "post_card",
        summary: "Rain is starting.",
      },
      now: 1_200,
    });

    expect(
      bus.inspect({
        operation: "list_automations",
        context: { backend: "codex", threadId: "agent-thread" },
        args: {},
      }),
    ).toMatchObject({
      ok: true,
      data: {
        automations: [
          {
            id: automation.id,
            name: "Check weather",
            latestRun: {
              id: "automation-run:weather-1",
              outputSummary: "Rain is starting.",
            },
          },
        ],
      },
    });
  });

  it("summarizes recent runs for an Agent thread", () => {
    const automation = createAutomation({ id: "automation:weather" });
    store.createRun({
      id: "automation-run:weather-1",
      automationId: automation.id,
      trigger: "scheduled",
      status: "completed",
      scheduledFor: 1_000,
      now: 1_100,
    });

    const response = bus.inspect({
      operation: "summarize_automation_status",
      context: { backend: "codex", threadId: "agent-thread" },
      args: {},
    });

    expect(response).toMatchObject({
      ok: true,
      data: {
        summary: expect.stringContaining("1 automation attached"),
        recentRuns: [
          expect.objectContaining({
            automationName: "Check weather",
            status: "completed",
          }),
        ],
      },
    });
  });

  it("bounds artifact transcript events and text", () => {
    const automation = createAutomation({ id: "automation:weather" });
    const run = store.createRun({
      id: "automation-run:weather-1",
      automationId: automation.id,
      trigger: "manual",
      status: "completed",
      now: 1_000,
    });
    store.upsertRunArtifact({
      runId: run!.id,
      status: "completed",
      finalText: "x".repeat(20),
      outputDecision: {
        kind: "post_card",
        summary: "Long output",
        details: "y".repeat(20),
      },
      transcriptEvents: [
        { id: "event-1", at: 1, kind: "invocation", text: "one" },
        { id: "event-2", at: 2, kind: "assistant_final", text: "two" },
      ],
      now: 1_200,
    });

    expect(
      bus.inspect({
        operation: "get_automation_run_artifact",
        context: { backend: "codex", threadId: "agent-thread" },
        args: {
          runId: run!.id,
          eventLimit: 1,
          textLimitChars: 5,
        },
      }),
    ).toMatchObject({
      ok: true,
      data: {
        artifact: {
          finalText: "xxxxx",
          finalTextTruncated: true,
          detailsTextTruncated: true,
          transcriptEvents: [{ id: "event-1" }],
          transcriptEventsTruncated: true,
          card: {
            details: "yyyyy",
            summary: "Check weather: Long output",
          },
        },
      },
    });
  });

  it("rejects cross-thread automation and run inspection", () => {
    const automation = createAutomation({
      id: "automation:weather",
      threadId: "other-agent",
    });
    const run = store.createRun({
      id: "automation-run:weather-1",
      automationId: automation.id,
      trigger: "scheduled",
      status: "completed",
      now: 1_000,
    });

    expect(
      bus.inspect({
        operation: "list_automation_runs",
        context: { backend: "codex", threadId: "agent-thread" },
        args: {
          automationId: automation.id,
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(
      bus.inspect({
        operation: "get_automation_run",
        context: { backend: "codex", threadId: "agent-thread" },
        args: {
          runId: run!.id,
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
  });

  it("does not expose deleted automations through agent inspection", () => {
    const automation = createAutomation({ id: "automation:weather" });
    const run = store.createRun({
      id: "automation-run:weather-1",
      automationId: automation.id,
      trigger: "scheduled",
      status: "completed",
      now: 1_000,
    });
    expect(run).toBeDefined();
    store.deleteAutomation(automation.id);

    expect(
      bus.inspect({
        operation: "list_automations",
        context: { backend: "codex", threadId: "agent-thread" },
        args: {},
      }),
    ).toMatchObject({
      ok: true,
      data: {
        automations: [],
      },
    });
    expect(
      bus.inspect({
        operation: "get_automation_run",
        context: { backend: "codex", threadId: "agent-thread" },
        args: {
          runId: run!.id,
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
  });
});

function createAutomation(params: {
  id: string;
  threadId?: string;
}) {
  return store.createAutomation({
    id: params.id,
    backend: "codex",
    threadId: params.threadId ?? "agent-thread",
    name: "Check weather",
    taskPrompt: "Check the weather",
    schedule: {
      kind: "interval",
      every: 5,
      unit: "minutes",
    },
    status: "enabled",
    now: 1_000,
  });
}
