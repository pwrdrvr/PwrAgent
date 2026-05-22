import { describe, expect, it } from "vitest";
import type { NavigationSnapshot } from "@pwragent/shared";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import {
  buildMonitorStatusIntent,
  MESSAGING_MONITOR_INTERVAL_MS,
} from "../messaging/core/messaging-monitor-card.js";

describe("buildMonitorStatusIntent", () => {
  it("renders pinned threads above non-pinned recents with configuration actions", () => {
    const intent = buildMonitorStatusIntent({
      binding: buildBinding(),
      createdAt: 121_000,
      id: "monitor-1",
      navigation: buildNavigationSnapshot(),
    });

    expect(intent).toMatchObject({
      kind: "status",
      status: "idle",
      bindingId: "binding-1",
      delivery: {
        mode: "present",
        fallback: "present_new",
      },
      text: expect.stringContaining("Monitor: Recent threads"),
      actions: expect.arrayContaining([
        expect.objectContaining({
          id: "monitor:stop",
          fallbackText: "monitor stop",
          style: "danger",
        }),
        expect.objectContaining({
          id: "monitor:refresh",
          fallbackText: "monitor refresh",
        }),
        expect.objectContaining({
          id: "monitor:pins",
          fallbackText: "monitor pins 10",
          label: "Pins: 5",
        }),
        expect.objectContaining({
          id: "monitor:recent",
          fallbackText: "monitor recent 10",
          label: "Recent: 5",
        }),
        expect.objectContaining({
          id: "monitor:interval",
          fallbackText: "monitor interval 5m",
          label: "Interval: 1m",
        }),
        expect.objectContaining({
          id: "monitor:status",
          fallbackText: "monitor status line",
          label: "Status: Inline",
        }),
        expect.objectContaining({
          id: "monitor:snippet",
          fallbackText: "monitor snippet on",
          label: "Snippet: Off",
        }),
      ]),
    });
    expect(intent.actions).not.toContainEqual(
      expect.objectContaining({ id: "monitor:topics" }),
    );
    expect(intent.text).toContain("Pins: 5 | Recent: 5");
    expect(intent.text).toContain("Status: inline | Snippet: off");
    expect(intent.text).toContain("Pins\nP1. Pinned release watch (codex) - idle - updated just now - PwrAgent");
    expect(intent.text).toContain("Recent\n1. Fix messaging monitor (codex) - idle - updated 2m ago - PwrAgent");
    expect(intent.text).toContain("2. Review provider commands (grok) - queued permissions - updated just now - Messaging");
    expect(intent.text).toContain(`Interval: ${MESSAGING_MONITOR_INTERVAL_MS / 60_000} min`);
    expect(intent.text).not.toContain("undefined");
  });

  it("adds topic controls when the monitor surface supports Telegram topics", () => {
    const intent = buildMonitorStatusIntent({
      binding: buildBinding(),
      createdAt: 121_000,
      id: "monitor-1",
      navigation: buildNavigationSnapshot(),
      topicControls: true,
    });

    expect(intent.actions).toContainEqual(
      expect.objectContaining({
        id: "monitor:topics",
        fallbackText: "monitor topics",
        label: "Topics",
      }),
    );
  });

  it("updates the existing monitor surface when one is stored", () => {
    const intent = buildMonitorStatusIntent({
      binding: buildBinding({
        monitorSurface: {
          channel: "telegram",
          id: "surface-1",
        },
      }),
      createdAt: 121_000,
      id: "monitor-1",
      navigation: buildNavigationSnapshot(),
    });

    expect(intent.delivery).toMatchObject({
      mode: "update",
      fallback: "present_new",
    });
    expect(intent.targetSurface).toEqual({
      channel: "telegram",
      id: "surface-1",
    });
  });

  it("presents a fresh monitor snapshot when the provider cannot edit messages", () => {
    const intent = buildMonitorStatusIntent({
      binding: buildBinding({
        monitorSurface: {
          channel: "line",
          id: "surface-1",
        },
      }),
      capabilityProfile: {
        ...PERMISSIVE_CAPABILITY_PROFILE,
        text: {
          ...PERMISSIVE_CAPABILITY_PROFILE.text,
          supportsMessageEdit: false,
        },
      },
      createdAt: 121_000,
      id: "monitor-1",
      navigation: buildNavigationSnapshot(),
    });

    expect(intent.delivery).toMatchObject({
      mode: "present",
      fallback: "present_new",
    });
    expect(intent.targetSurface).toBeUndefined();
  });

  it("marks the monitor as working when any shown recent thread has active work", () => {
    const intent = buildMonitorStatusIntent({
      activeTurnsByThreadKey: new Map([
        [
          "codex:thread-1",
          {
            status: "working",
            turnId: "turn-1",
            updatedAt: 121_000,
          },
        ],
      ]),
      binding: buildBinding(),
      createdAt: 121_000,
      id: "monitor-1",
      navigation: buildNavigationSnapshot(),
    });

    expect(intent.status).toBe("working");
    expect(intent.text).toContain("Fix messaging monitor (codex) - working");
  });

  it("renders an empty recent-thread state without throwing", () => {
    const snapshot = buildNavigationSnapshot();
    snapshot.threads = [];

    const intent = buildMonitorStatusIntent({
      binding: buildBinding(),
      createdAt: 121_000,
      id: "monitor-1",
      navigation: snapshot,
    });

    expect(intent.status).toBe("idle");
    expect(intent.text).toContain("No matching recent threads.");
  });

  it("can hide pins or expand recents independently", () => {
    const intent = buildMonitorStatusIntent({
      binding: buildBinding({
        monitor: {
          enabled: true,
          intervalMs: MESSAGING_MONITOR_INTERVAL_MS,
          pinnedThreadLimit: 0,
          recentThreadLimit: 10,
          updatedAt: 1000,
        },
      }),
      createdAt: 121_000,
      id: "monitor-1",
      navigation: buildNavigationSnapshot(),
    });

    expect(intent.text).toContain("Pins: 0 | Recent: 10");
    expect(intent.text).not.toContain("Pinned release watch");
    expect(intent.text).toContain("Recent\n1. Fix messaging monitor");
    expect(intent.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "monitor:pins",
          fallbackText: "monitor pins 5",
          label: "Pins: 0",
        }),
        expect.objectContaining({
          id: "monitor:recent",
          fallbackText: "monitor recent 0",
          label: "Recent: 10",
        }),
      ]),
    );
  });

  it("can render short monitor intervals", () => {
    const intent = buildMonitorStatusIntent({
      binding: buildBinding({
        monitor: {
          enabled: true,
          intervalMs: 30_000,
          updatedAt: 1000,
        },
      }),
      createdAt: 121_000,
      id: "monitor-1",
      navigation: buildNavigationSnapshot(),
    });

    expect(intent.text).toContain("Interval: 30 sec");
    expect(intent.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "monitor:interval",
          fallbackText: "monitor interval 1m",
          label: "Interval: 30s",
        }),
      ]),
    );
  });

  it("can render status and last response snippets on indented detail lines", () => {
    const intent = buildMonitorStatusIntent({
      activeTurnsByThreadKey: new Map([
        [
          "codex:thread-1",
          {
            status: "waiting",
            turnId: "turn-1",
            updatedAt: 121_000,
          },
        ],
      ]),
      binding: buildBinding({
        monitor: {
          enabled: true,
          intervalMs: MESSAGING_MONITOR_INTERVAL_MS,
          showLastResponseSnippet: true,
          showStatusLine: true,
          updatedAt: 1000,
        },
      }),
      createdAt: 121_000,
      id: "monitor-1",
      navigation: buildNavigationSnapshot(),
      snippetsByThreadKey: new Map([
        [
          "codex:thread-1",
          "I checked the monitor command path and found that the latest rendering pass can use the existing transcript replay data.",
        ],
      ]),
    });

    expect(intent.text).toContain("Status: line | Snippet: on");
    expect(intent.text).toContain(
      "1. Fix messaging monitor (codex)\n  Status: awaiting approval - updated 2m ago - PwrAgent\n  Response: I checked the monitor command path",
    );
    expect(intent.text).not.toContain(
      "Fix messaging monitor (codex) - awaiting approval",
    );
    expect(intent.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "monitor:status",
          fallbackText: "monitor status inline",
          label: "Status: Line",
        }),
        expect.objectContaining({
          id: "monitor:snippet",
          fallbackText: "monitor snippet off",
          label: "Snippet: On",
        }),
      ]),
    );
  });
});

function buildBinding(
  overrides: Partial<MessagingBindingRecord> = {},
): MessagingBindingRecord {
  return {
    id: "binding-1",
    channel: {
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    },
    backend: "codex",
    threadId: "thread-1",
    authorizedActorIds: ["user-1"],
    createdAt: 1000,
    updatedAt: 1000,
    monitor: {
      enabled: true,
      intervalMs: MESSAGING_MONITOR_INTERVAL_MS,
      updatedAt: 1000,
    },
    ...overrides,
  };
}

function buildNavigationSnapshot(): NavigationSnapshot {
  return {
    backend: "all",
    fetchedAt: 121_000,
    unchanged: false,
    threads: [
      {
        id: "thread-pinned",
        title: "Pinned release watch",
        titleSource: "explicit",
        source: "codex",
        pinnedRank: "1024",
        linkedDirectories: [
          {
            id: "directory:pwragent",
            kind: "local",
            label: "PwrAgent",
            path: "/repo/pwragent",
          },
        ],
        inbox: {
          inInbox: false,
        },
        updatedAt: 120_000,
      },
      {
        id: "thread-1",
        title: "Fix messaging monitor",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [
          {
            id: "directory:pwragent",
            kind: "local",
            label: "PwrAgent",
            path: "/repo/pwragent",
          },
        ],
        inbox: {
          inInbox: false,
        },
        updatedAt: 1_000,
      },
      {
        id: "thread-2",
        title: "Review provider commands",
        titleSource: "explicit",
        source: "grok",
        linkedDirectories: [],
        inbox: {
          inInbox: false,
        },
        queuedExecutionMode: "full-access",
        updatedAt: 120_500,
      },
    ],
    inboxThreadKeys: [],
    directories: [
      {
        key: "directory:pwragent",
        kind: "directory",
        label: "PwrAgent",
        latestUpdatedAt: 1_000,
        needsAttentionCount: 0,
        path: "/repo/pwragent",
        threadKeys: ["codex:thread-1"],
      },
      {
        key: "directory:messaging",
        kind: "directory",
        label: "Messaging",
        latestUpdatedAt: 120_500,
        needsAttentionCount: 0,
        path: "/repo/pwragent/packages/messaging",
        threadKeys: ["grok:thread-2"],
      },
    ],
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
    },
  };
}
