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
let registry: DesktopBackendRegistry;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-automation-service-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new AutomationStore(stateDb);
  publishedEvents = [];
  registry = {
    canStartThreadTurnImmediately: vi.fn(() => true),
    submitTurn: vi.fn(async (entry) => ({
      status: "started" as const,
      entry: {
        ...entry,
        id: entry.id ?? "queue-1",
        createdAt: entry.createdAt ?? 1_000,
      },
      turnId: "turn-1",
    })),
    onEvent: vi.fn(() => () => undefined),
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
});
