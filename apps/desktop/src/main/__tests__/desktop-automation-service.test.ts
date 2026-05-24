import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { DesktopAutomationService } from "../automations/desktop-automation-service";
import { AutomationStore } from "../automations/automation-store";
import { StateDb } from "../state/state-db";

let tempDir: string;
let stateDb: StateDb;
let store: AutomationStore;
let publishedEvents: AgentEvent[];
let registryListeners: Array<(event: AgentEvent) => void | Promise<void>>;
let registry: DesktopBackendRegistry;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-automation-service-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new AutomationStore(stateDb);
  publishedEvents = [];
  registryListeners = [];
  registry = {
    canStartThreadTurnImmediately: vi.fn(() => true),
    cancelQueuedTurn: vi.fn(),
    submitTurn: vi.fn(async (entry) => ({
      status: "started" as const,
      entry: {
        ...entry,
        id: entry.id ?? "queue-1",
        createdAt: entry.createdAt ?? 1_000,
      },
      turnId: "turn-1",
    })),
    updateQueuedTurnInput: vi.fn(),
    readThread: vi.fn(async ({ threadId }: { threadId: string }) => ({
      backend: "codex",
      fetchedAt: 1_000,
      threadId,
      replay: {
        entries: [
          {
            id: "rollout-user",
            role: "user",
            text: "Automation prompt",
            type: "message",
          },
          {
            id: "rollout-assistant",
            role: "assistant",
            text: "Rollout result",
            type: "message",
          },
        ],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    })),
    startAutomationHeadlessTurn: vi.fn(async (params) => ({
      backend: params.backend,
      headlessThreadId: "headless-thread-1",
      queueEntryId: `headless:${params.automationRunId}`,
      threadId: params.agentThreadId,
      turnId: "turn-1",
    })),
    getThreadAgentMetadata: vi.fn(async () => ({
      name: "Automation Agent",
      instructionLineCount: 0,
      instructionsTooLong: false,
      updatedAt: 1_000,
    })),
    onEvent: vi.fn((listener) => {
      registryListeners.push(listener);
      return () => {
        registryListeners = registryListeners.filter((entry) => entry !== listener);
      };
    }),
    publishLocalEvent: vi.fn(async (event: AgentEvent) => {
      publishedEvents.push(event);
    }),
    setAutomationTurnContextProvider: vi.fn(),
  } as unknown as DesktopBackendRegistry;
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("DesktopAutomationService", () => {
  it("creates automations, lists them, and publishes thread automation updates", async () => {
    const service = new DesktopAutomationService({ registry, store });

    const created = await service.create({
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
    });

    expect(created.automation).toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      backlogPolicy: "coalesce",
      status: "enabled",
    });
    expect(service.list({ backend: "codex", threadId: "thread-1" }).automations)
      .toEqual([expect.objectContaining({ id: created.automation.id })]);
    expect(publishedEvents).toContainEqual({
      backend: "codex",
      notification: {
        method: "thread/automations/updated",
        params: { threadId: "thread-1" },
      },
    });
  });

  it("rejects new automations targeting ordinary work threads", async () => {
    registry.getThreadAgentMetadata = vi.fn(async () => undefined);
    const service = new DesktopAutomationService({ registry, store });

    await expect(
      service.create({
        backend: "codex",
        threadId: "thread-1",
        name: "Check email",
        taskPrompt: "Check mail",
        schedule: {
          kind: "interval",
          every: 5,
          unit: "minutes",
        },
      }),
    ).rejects.toThrow("Automations must be attached to an Agent thread.");
  });

  it("runs automations now through the headless automation runner", async () => {
    const service = new DesktopAutomationService({ registry, store });
    const created = await service.create({
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      schedule: {
        kind: "weekdays",
        timeOfDay: { hour: 9, minute: 0 },
      },
    });

    await expect(
      service.runNow({ automationId: created.automation.id }),
    ).resolves.toMatchObject({
      queueStatus: "started",
      turnId: "turn-1",
      run: expect.objectContaining({
        trigger: "manual",
        status: "running",
      }),
    });
    expect(registry.startAutomationHeadlessTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentThreadId: "thread-1",
        automationName: "Check email",
        automationRunId: expect.any(String),
        input: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("Check mail"),
            type: "text",
          }),
        ]),
      }),
    );
    expect(registry.submitTurn).not.toHaveBeenCalled();
  });

  it("records the submitted automation prompt when a run starts", async () => {
    const service = new DesktopAutomationService({ registry, store });
    service.start();
    const created = await service.create({
      backend: "codex",
      threadId: "thread-1",
      name: "Check weather",
      taskPrompt: "Check weather in Aberdeen, NJ 07747",
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
    });
    const runNow = await service.runNow({ automationId: created.automation.id });

    await Promise.all(
      registryListeners.map((listener) =>
        listener({
          backend: "codex",
          notification: {
            method: "thread/turnQueue/updated",
            params: {
              threadId: "thread-1",
              queueEntryId: runNow.queueEntryId ?? "headless:run-1",
              origin: "automation",
              status: "started",
              automationRunId: runNow.run.id,
              automationName: "Check weather",
              backendThreadId: "headless-thread-1",
              turnId: "turn-1",
            },
          },
        } as AgentEvent),
      ),
    );

    expect(store.getRunArtifact(runNow.run.id)).toMatchObject({
      transcriptEvents: expect.arrayContaining([
        expect.objectContaining({
          kind: "invocation",
          text: expect.stringContaining("Check weather in Aberdeen, NJ 07747"),
          metadata: expect.objectContaining({
            automationName: "Check weather",
            backendThreadId: "headless-thread-1",
            backendTurnId: "turn-1",
            scheduleSummary: "every 5 minutes",
          }),
        }),
      ]),
    });
  });

  it("lists an active run as the latest automation status", async () => {
    const service = new DesktopAutomationService({ registry, store });
    const created = await service.create({
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
    });

    const runNow = await service.runNow({ automationId: created.automation.id });

    expect(runNow.run.status).toBe("running");
    expect(service.list({ backend: "codex", threadId: "thread-1" }).automations)
      .toEqual([
        expect.objectContaining({
          id: created.automation.id,
          lastRunAt: runNow.run.startedAt,
          lastRunStatus: "running",
        }),
      ]);
  });

  it("schedules from now when update enables a paused automation", async () => {
    const service = new DesktopAutomationService({ registry, store });
    const created = await service.create({
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      enabled: false,
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
    });

    const updated = await service.update({
      automationId: created.automation.id,
      enabled: true,
    });

    expect(updated.automation.status).toBe("enabled");
    expect(updated.automation.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("reassigns an automation to another Agent thread", async () => {
    const service = new DesktopAutomationService({ registry, store });
    const created = await service.create({
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
    });
    publishedEvents = [];

    const updated = await service.update({
      automationId: created.automation.id,
      backend: "codex",
      threadId: "thread-2",
    });

    expect(updated.automation).toMatchObject({
      backend: "codex",
      threadId: "thread-2",
    });
    expect(registry.getThreadAgentMetadata).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-2",
    });
    expect(service.list({ backend: "codex", threadId: "thread-1" }).automations)
      .toEqual([]);
    expect(service.list({ backend: "codex", threadId: "thread-2" }).automations)
      .toEqual([expect.objectContaining({ id: created.automation.id })]);
    expect(publishedEvents).toEqual(
      expect.arrayContaining([
        {
          backend: "codex",
          notification: {
            method: "thread/automations/updated",
            params: { threadId: "thread-1" },
          },
        },
        {
          backend: "codex",
          notification: {
            method: "thread/automations/updated",
            params: { threadId: "thread-2" },
          },
        },
      ]),
    );
  });

  it("publishes run updates for queue lifecycle events by run id", async () => {
    const service = new DesktopAutomationService({ registry, store });
    service.start();
    const created = await service.create({
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      schedule: {
        kind: "weekdays",
        timeOfDay: { hour: 9, minute: 0 },
      },
    });
    const runNow = await service.runNow({ automationId: created.automation.id });
    publishedEvents = [];

    await Promise.all(
      registryListeners.map((listener) =>
        listener({
          backend: "codex",
          notification: {
            method: "item/completed",
            params: {
              threadId: "headless-thread-1",
              turnId: "turn-1",
              item: {
                id: "assistant-progress-1",
                text: "Checking the inbox now.",
                type: "agentMessage",
              },
            },
          },
        } as AgentEvent),
      ),
    );
    await Promise.all(
      registryListeners.map((listener) =>
        listener({
          backend: "codex",
          notification: {
            method: "thread/turnQueue/updated",
            params: {
              threadId: "thread-1",
              queueEntryId: runNow.queueEntryId ?? "queue-1",
              origin: "automation",
              status: "terminal",
              automationRunId: runNow.run.id,
              finalText: "Inbox summary is ready.",
              terminalStatus: "turn/completed",
              turnId: "turn-1",
            },
          },
        } as AgentEvent),
      ),
    );

    expect(publishedEvents).toContainEqual({
      backend: "codex",
      notification: {
        method: "automation/run/updated",
        params: expect.objectContaining({
          automationId: created.automation.id,
          runId: runNow.run.id,
          status: "completed",
          threadId: "thread-1",
        }),
      },
    });
    expect(store.getRunArtifact(runNow.run.id)).toMatchObject({
      runId: runNow.run.id,
      automationId: created.automation.id,
      status: "completed",
      finalText: "Inbox summary is ready.",
      transcriptEvents: expect.arrayContaining([
        expect.objectContaining({ kind: "invocation" }),
        expect.objectContaining({
          kind: "assistant_final",
          text: "Checking the inbox now.",
        }),
        expect.objectContaining({
          kind: "assistant_final",
          text: "Inbox summary is ready.",
        }),
        expect.objectContaining({ kind: "lifecycle" }),
      ]),
    });
    expect(
      service.listCards({
        backend: "codex",
        threadId: "thread-1",
      }).cards,
    ).toEqual([
      expect.objectContaining({
        automationId: created.automation.id,
        automationName: "Check email",
        runId: runNow.run.id,
        status: "completed",
        summary: "Check email: Inbox summary is ready.",
      }),
    ]);
    await expect(service.getRunArtifact({ runId: runNow.run.id })).resolves.toMatchObject({
      artifact: {
        runId: runNow.run.id,
        finalText: "Inbox summary is ready.",
        outputDecision: {
          kind: "parse_failed",
          summary: "Inbox summary is ready.",
        },
      },
      rollout: {
        threadId: "headless-thread-1",
        turnId: "turn-1",
      },
    });
    expect(registry.readThread).not.toHaveBeenCalled();
  });

  it("keeps quiet structured scheduled results out of timeline cards", async () => {
    const service = new DesktopAutomationService({ registry, store });
    service.start();
    const created = await service.create({
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      schedule: {
        kind: "weekdays",
        timeOfDay: { hour: 9, minute: 0 },
      },
    });
    const run = store.createRun({
      id: "run-quiet",
      automationId: created.automation.id,
      trigger: "scheduled",
      scheduledFor: 1_000,
      now: 1_000,
    });
    expect(run).toBeDefined();
    store.markRunStarted({
      runId: "run-quiet",
      backendTurnId: "turn-quiet",
      startedAt: 1_100,
      now: 1_100,
    });

    await Promise.all(
      registryListeners.map((listener) =>
        listener({
          backend: "codex",
          notification: {
            method: "thread/turnQueue/updated",
            params: {
              threadId: "thread-1",
              queueEntryId: "headless:run-quiet",
              origin: "automation",
              status: "terminal",
              automationRunId: "run-quiet",
              terminalStatus: "turn/completed",
              turnId: "turn-quiet",
              finalText: JSON.stringify({
                decision: "quiet",
                summary: "No important mail.",
              }),
            },
          },
        } as AgentEvent),
      ),
    );

    await expect(service.getRunArtifact({ runId: "run-quiet" })).resolves.toMatchObject({
      artifact: {
        outputDecision: {
          kind: "quiet",
          summary: "No important mail.",
        },
      },
    });
    expect(
      service.listCards({
        backend: "codex",
        threadId: "thread-1",
      }).cards,
    ).toEqual([]);
  });

  it("recovers automation completion from the backend terminal event when the headless queue event is missed", async () => {
    const service = new DesktopAutomationService({ registry, store });
    service.start();
    const created = await service.create({
      backend: "codex",
      threadId: "thread-1",
      name: "Check weather",
      taskPrompt: "Check weather",
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
    });
    const run = store.createRun({
      id: "run-weather",
      automationId: created.automation.id,
      trigger: "scheduled",
      scheduledFor: 1_000,
      now: 1_000,
    });
    expect(run).toBeDefined();
    store.markRunStarted({
      runId: "run-weather",
      backendTurnId: "turn-weather",
      startedAt: 1_100,
      now: 1_100,
    });
    const queuedRun = store.createRun({
      id: "run-weather-queued",
      automationId: created.automation.id,
      trigger: "scheduled",
      scheduledFor: 2_000,
      now: 2_000,
    });
    expect(queuedRun).toBeDefined();
    store.markRunQueued({
      runId: "run-weather-queued",
      queueEntryId: "automation-lane:run-weather-queued",
      queuedAt: 2_100,
      now: 2_100,
    });
    publishedEvents = [];

    await Promise.all(
      registryListeners.map((listener) =>
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "headless-thread-1",
              turnId: "turn-weather",
              turn: {
                id: "turn-weather",
                status: "completed",
                output: [{ type: "text", text: "No rain is expected soon." }],
              },
            },
          },
        } as AgentEvent),
      ),
    );

    expect(store.getRun("run-weather")).toMatchObject({
      status: "completed",
      backendTurnId: "turn-weather",
    });
    expect(store.getRun("run-weather-queued")).toMatchObject({
      backendThreadId: "headless-thread-1",
      status: "running",
      backendTurnId: "turn-1",
    });
    expect(registry.startAutomationHeadlessTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        automationName: "Check weather",
        automationRunId: "run-weather-queued",
      }),
    );
    expect(store.getRunArtifact("run-weather")).toMatchObject({
      finalText: "No rain is expected soon.",
      outputDecision: {
        kind: "parse_failed",
        summary: "No rain is expected soon.",
      },
    });
    expect(publishedEvents).toContainEqual({
      backend: "codex",
      notification: {
        method: "automation/run/updated",
        params: expect.objectContaining({
          automationId: created.automation.id,
          runId: "run-weather",
          status: "completed",
          threadId: "thread-1",
        }),
      },
    });
  });

  it("recovers automation completion from a structured assistant final when terminal correlation is missed", async () => {
    const service = new DesktopAutomationService({ registry, store });
    service.start();
    const created = await service.create({
      backend: "codex",
      threadId: "thread-1",
      name: "Check weather",
      taskPrompt: "Check weather",
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
    });
    const run = store.createRun({
      id: "run-weather",
      automationId: created.automation.id,
      trigger: "manual",
      now: 1_000,
    });
    expect(run).toBeDefined();
    store.markRunStarted({
      runId: "run-weather",
      backendThreadId: "headless-thread-1",
      backendTurnId: "turn-weather",
      startedAt: 1_100,
      now: 1_100,
    });
    publishedEvents = [];

    await Promise.all(
      registryListeners.map((listener) =>
        listener({
          backend: "codex",
          notification: {
            method: "item/completed",
            params: {
              threadId: "headless-thread-1",
              turnId: "turn-weather",
              item: {
                id: "assistant-final",
                text: JSON.stringify({
                  decision: "post_card",
                  summary: "Rain is expected today.",
                  details: "Forecast confidence is high this afternoon.",
                }),
                type: "agentMessage",
              },
            },
          },
        } as AgentEvent),
      ),
    );

    expect(store.getRun("run-weather")).toMatchObject({
      status: "completed",
      backendTurnId: "turn-weather",
    });
    expect(store.getRunArtifact("run-weather")).toMatchObject({
      finalText: expect.stringContaining("Rain is expected today."),
      outputDecision: {
        kind: "post_card",
        summary: "Rain is expected today.",
        details: "Forecast confidence is high this afternoon.",
      },
    });
    expect(
      service.listCards({
        backend: "codex",
        threadId: "thread-1",
      }).cards,
    ).toEqual([
      expect.objectContaining({
        automationId: created.automation.id,
        automationName: "Check weather",
        details: "Forecast confidence is high this afternoon.",
        runId: "run-weather",
        status: "completed",
        summary: "Check weather: Rain is expected today.",
      }),
    ]);
    expect(publishedEvents).toContainEqual({
      backend: "codex",
      notification: {
        method: "automation/run/updated",
        params: expect.objectContaining({
          automationId: created.automation.id,
          runId: "run-weather",
          status: "completed",
          threadId: "thread-1",
        }),
      },
    });
  });

  it("registers recent automation results as Agent turn context", async () => {
    const service = new DesktopAutomationService({ registry, store });
    service.start();
    const created = await service.create({
      backend: "codex",
      threadId: "thread-1",
      name: "Check weather",
      taskPrompt: "Check weather",
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
    });
    const run = store.createRun({
      id: "run-context",
      automationId: created.automation.id,
      trigger: "scheduled",
      scheduledFor: 1_000,
      now: 1_000,
    });
    expect(run).toBeDefined();
    store.markRunTerminal({
      runId: "run-context",
      status: "completed",
      completedAt: 2_000,
      now: 2_000,
    });
    store.upsertRunArtifact({
      runId: "run-context",
      status: "completed",
      outputDecision: {
        kind: "post_card",
        summary: "Rain is already underway.",
        details: "Hourly forecast shows rain through at least 5 AM.",
      },
    });

    const provider = vi.mocked(registry.setAutomationTurnContextProvider).mock
      .calls.at(-1)?.[0];
    expect(provider).toBeDefined();
    const context = await provider!({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(context).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Rain is already underway."),
      },
    ]);
    expect(context[0]?.type === "text" ? context[0].text : "").toContain(
      "Hourly forecast shows rain through at least 5 AM.",
    );
  });

  it("cancels every queued automation turn when deleting an automation", async () => {
    const service = new DesktopAutomationService({ registry, store });
    const created = await service.create({
      backend: "codex",
      threadId: "thread-1",
      name: "Check email",
      taskPrompt: "Check mail",
      schedule: {
        kind: "weekdays",
        timeOfDay: { hour: 9, minute: 0 },
      },
    });

    for (let index = 1; index <= 55; index += 1) {
      const run = store.createRun({
        id: `run-${index}`,
        automationId: created.automation.id,
        trigger: "manual",
        now: 1_000 + index,
      });
      expect(run).toBeDefined();
      store.markRunQueued({
        runId: `run-${index}`,
        queueEntryId: `queue-${index}`,
        queuedAt: 2_000 + index,
        now: 2_000 + index,
      });
    }

    await service.delete({ automationId: created.automation.id });

    expect(registry.cancelQueuedTurn).toHaveBeenCalledTimes(55);
    expect(
      (registry.cancelQueuedTurn as ReturnType<typeof vi.fn>).mock.calls.map(
        ([entryId]) => entryId,
      ),
    ).toEqual(Array.from({ length: 55 }, (_, index) => `queue-${55 - index}`));
  });
});
