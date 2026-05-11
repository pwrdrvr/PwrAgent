import { describe, expect, it } from "vitest";
import type { NavigationSnapshot } from "@pwragent/shared";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import {
  buildMonitorStatusIntent,
  MESSAGING_MONITOR_INTERVAL_MS,
} from "../messaging/core/messaging-monitor-card.js";

describe("buildMonitorStatusIntent", () => {
  it("renders a compact recent-thread summary with a Stop Monitor action", () => {
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
      actions: [
        expect.objectContaining({
          id: "monitor:stop",
          fallbackText: "monitor stop",
          style: "danger",
        }),
        expect.objectContaining({
          id: "monitor:refresh",
          fallbackText: "monitor refresh",
        }),
      ],
    });
    expect(intent.text).toContain("1. Fix messaging monitor (codex) - idle - updated 2m ago - PwrAgent");
    expect(intent.text).toContain("2. Review provider commands (grok) - queued permissions - updated just now - Messaging");
    expect(intent.text).toContain(`Interval: ${MESSAGING_MONITOR_INTERVAL_MS / 60_000} min`);
    expect(intent.text).not.toContain("undefined");
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
    expect(intent.text).toContain("No recent threads.");
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
