import { describe, expect, it } from "vitest";
import type {
  AppServerThreadSummary,
  AutomationThreadSummary,
} from "@pwragent/shared";

import {
  buildNavigationSnapshotHash,
  materializeNavigationThreads,
} from "../domain/navigation-state";

function buildThread(
  overrides: Partial<AppServerThreadSummary> = {},
): AppServerThreadSummary {
  return {
    id: "thread-1",
    title: "Automation Thread",
    titleSource: "explicit",
    source: "codex",
    linkedDirectories: [],
    updatedAt: 1_000,
    ...overrides,
  };
}

function buildAutomationSummary(
  overrides: Partial<AutomationThreadSummary> = {},
): AutomationThreadSummary {
  return {
    totalCount: 1,
    enabledCount: 1,
    pausedCount: 0,
    nextRunAt: 10_000,
    lastRunAt: 5_000,
    pendingRunCount: 0,
    coalescedWindowCount: 0,
    skippedSinceLastCompletedCount: 0,
    automations: [
      {
        id: "automation-1",
        backend: "codex",
        threadId: "thread-1",
        name: "Check email",
        status: "enabled",
        schedule: {
          kind: "interval",
          every: 5,
          unit: "minutes",
        },
        scheduleSummary: "every 5 minutes",
        backlogPolicy: "coalesce",
        nextRunAt: 10_000,
        lastRunAt: 5_000,
        lastRunStatus: "completed",
        updatedAt: 4_000,
      },
    ],
    ...overrides,
  };
}

describe("navigation automation summaries", () => {
  it("materializes compact automation summaries onto thread navigation rows", () => {
    const [thread] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {},
      automationsByThreadKey: {
        "codex:thread-1": buildAutomationSummary(),
      },
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [buildThread()],
    });

    expect(thread?.automationSummary).toEqual(
      expect.objectContaining({
        enabledCount: 1,
        nextRunAt: 10_000,
        automations: [
          expect.objectContaining({
            id: "automation-1",
            scheduleSummary: "every 5 minutes",
            backlogPolicy: "coalesce",
          }),
        ],
      }),
    );
  });

  it("includes automation summaries in the navigation snapshot hash", () => {
    const [threadWithoutAutomation] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {},
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [buildThread()],
    });
    const [threadWithAutomation] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {},
      automationsByThreadKey: {
        "codex:thread-1": buildAutomationSummary(),
      },
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [buildThread()],
    });

    expect(
      buildNavigationSnapshotHash({
        backend: "codex",
        threads: [threadWithoutAutomation!],
      }),
    ).not.toBe(
      buildNavigationSnapshotHash({
        backend: "codex",
        threads: [threadWithAutomation!],
      }),
    );
  });
});
