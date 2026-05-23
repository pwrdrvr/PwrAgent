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

  it("runs automations now through the shared turn queue", async () => {
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
    expect(registry.submitTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "automation",
        automationRunId: expect.any(String),
      }),
    );
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
            method: "thread/turnQueue/updated",
            params: {
              threadId: "thread-1",
              queueEntryId: runNow.queueEntryId ?? "queue-1",
              origin: "automation",
              status: "terminal",
              automationRunId: runNow.run.id,
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
        params: {
          automationId: created.automation.id,
          runId: runNow.run.id,
          status: "completed",
          threadId: "thread-1",
        },
      },
    });
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
