import { describe, expect, it } from "vitest";
import type {
  AppServerThreadSummary,
  AutomationThreadSummary,
  PrSummary,
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
        triggers: [
          {
            id: "schedule",
            kind: "schedule",
            schedule: {
              kind: "interval",
              every: 5,
              unit: "minutes",
            },
          },
        ],
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

describe("navigation execution mode authority", () => {
  it("uses authoritative ACP session mode over a stale overlay", () => {
    const [thread] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {
        "acp:grok:thread-1": {
          backend: "acp:grok",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
        },
      },
      previousKnownThreadKeys: ["acp:grok:thread-1"],
      threads: [
        buildThread({
          source: "acp:grok",
          executionMode: "full-access",
        }),
      ],
    });

    expect(thread?.executionMode).toBe("full-access");
  });

  it("continues to use the overlay as Codex execution mode authority", () => {
    const [thread] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
        },
      },
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [buildThread({ executionMode: "full-access" })],
    });

    expect(thread?.executionMode).toBe("default");
  });
});

describe("navigation fork metadata", () => {
  it("materializes fork origin metadata from thread overlays", () => {
    const [thread] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          forkSourceThreadId: "thread-parent",
        },
      },
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [buildThread({ createdAt: 2_000 })],
    });

    expect(thread?.forkSourceThreadId).toBe("thread-parent");
  });

  it("includes fork origin metadata in the navigation snapshot hash", () => {
    const [threadWithoutForkOrigin] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {},
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [buildThread({ createdAt: 2_000 })],
    });
    const [threadWithForkOrigin] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          forkSourceThreadId: "thread-parent",
        },
      },
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [buildThread({ createdAt: 2_000 })],
    });

    expect(
      buildNavigationSnapshotHash({
        backend: "codex",
        threads: [threadWithoutForkOrigin!],
      }),
    ).not.toBe(
      buildNavigationSnapshotHash({
        backend: "codex",
        threads: [threadWithForkOrigin!],
      }),
    );
  });
});

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

  it("includes PR titles in the navigation snapshot hash", () => {
    const prWithoutTitle: PrSummary = {
      provider: "github.com",
      number: 727,
      org: "OpenAI",
      repo: "codex",
      state: "passing",
      url: "https://github.com/OpenAI/codex/pull/727",
    };
    const prWithTitle: PrSummary = {
      ...prWithoutTitle,
      title: "Preserve PR titles",
    };
    const [threadWithoutTitle] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          prs: [prWithoutTitle],
        },
      },
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [buildThread()],
    });
    const [threadWithTitle] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          prs: [prWithTitle],
        },
      },
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [buildThread()],
    });

    expect(
      buildNavigationSnapshotHash({
        backend: "codex",
        threads: [threadWithoutTitle!],
      }),
    ).not.toBe(
      buildNavigationSnapshotHash({
        backend: "codex",
        threads: [threadWithTitle!],
      }),
    );
  });
});

describe("navigation Agent metadata", () => {
  it("materializes Agent metadata from thread overlays", () => {
    const [thread] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          agent: {
            name: "Inbox Triage",
            instructions: "Keep updates concise.",
            instructionLineCount: 1,
            instructionsTooLong: false,
            updatedAt: 1_000,
          },
        },
      },
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [buildThread()],
    });

    expect(thread?.agent).toEqual({
      name: "Inbox Triage",
      instructions: "Keep updates concise.",
      instructionLineCount: 1,
      instructionsTooLong: false,
      updatedAt: 1_000,
    });
  });

  it("includes Agent metadata in the navigation snapshot hash", () => {
    const [threadWithoutAgent] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {},
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [buildThread()],
    });
    const [threadWithAgent] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          agent: {
            name: "Inbox Triage",
            instructionLineCount: 0,
            instructionsTooLong: false,
            updatedAt: 1_000,
          },
        },
      },
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [buildThread()],
    });

    expect(
      buildNavigationSnapshotHash({
        backend: "codex",
        threads: [threadWithoutAgent!],
      }),
    ).not.toBe(
      buildNavigationSnapshotHash({
        backend: "codex",
        threads: [threadWithAgent!],
      }),
    );
  });
});

describe("navigation sub-agent metadata", () => {
  it("includes sub-agent display names in the navigation snapshot hash", () => {
    const baseSubAgent = {
      monitorId: "codex-native:thread-agent",
      task: "Check PR status",
      status: "running" as const,
      createdAt: 1_000,
      updatedAt: 1_000,
      monitorThreadId: "thread-agent",
      monitorTurnId: "turn-1",
    };
    const [threadWithoutName] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          subAgents: [baseSubAgent],
        },
      },
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [buildThread()],
    });
    const [threadWithName] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          subAgents: [{ ...baseSubAgent, agentName: "Huygens" }],
        },
      },
      previousKnownThreadKeys: ["codex:thread-1"],
      threads: [buildThread()],
    });

    expect(
      buildNavigationSnapshotHash({
        backend: "codex",
        threads: [threadWithoutName!],
      }),
    ).not.toBe(
      buildNavigationSnapshotHash({
        backend: "codex",
        threads: [threadWithName!],
      }),
    );
  });
});
