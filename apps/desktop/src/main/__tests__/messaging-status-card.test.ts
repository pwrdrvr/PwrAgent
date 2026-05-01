import { describe, expect, it } from "vitest";
import type { MessagingBindingRecord, NavigationSnapshot } from "@pwragnt/shared";
import { buildBindingStatusIntent } from "../messaging/core/messaging-status-card";

describe("buildBindingStatusIntent", () => {
  it("renders binding, preference, project, and unavailable status fields", () => {
    const intent = buildBindingStatusIntent({
      id: "status-1",
      createdAt: 1000,
      binding: {
        id: "binding-1",
        authorizedActorIds: ["user-1"],
        backend: "codex",
        channel: {
          channel: "telegram",
          conversation: {
            id: "chat-1",
            kind: "dm",
          },
        },
        createdAt: 1000,
        preferences: {
          fastMode: true,
          model: "gpt-5.3-codex",
          permissionsMode: "full-access",
          reasoningEffort: "high",
          updatedAt: 1000,
        },
        threadId: "thread-1",
        updatedAt: 1000,
      } satisfies MessagingBindingRecord,
      navigation: buildNavigationSnapshot(),
    });

    expect(intent).toMatchObject({
      kind: "status",
      delivery: {
        fallback: "present_new",
        pin: true,
        mode: "present",
      },
      status: "idle",
      actions: expect.arrayContaining([
        expect.objectContaining({ id: "status:model" }),
        expect.objectContaining({ id: "status:detach" }),
      ]),
    });
    expect(intent.text).toContain("Binding: Thread one (codex)");
    expect(intent.text).toContain("Project: PwrAgnt");
    expect(intent.text).toContain("Model: gpt-5.3-codex");
    expect(intent.text).toContain("Reasoning: high");
    expect(intent.text).toContain("Fast mode: on");
    expect(intent.text).toContain("Permissions: Full Access");
    expect(intent.text).toContain("Context usage: unavailable");
  });

  it("targets an existing status surface for updates", () => {
    const intent = buildBindingStatusIntent({
      id: "status-2",
      createdAt: 1000,
      binding: {
        id: "binding-1",
        authorizedActorIds: ["user-1"],
        backend: "codex",
        channel: {
          channel: "telegram",
          conversation: {
            id: "chat-1",
            kind: "dm",
          },
        },
        createdAt: 1000,
        statusSurface: {
          channel: "telegram",
          id: "42",
        },
        threadId: "thread-1",
        updatedAt: 1000,
      } satisfies MessagingBindingRecord,
      navigation: buildNavigationSnapshot(),
    });

    expect(intent.delivery?.mode).toBe("update");
    expect(intent.targetSurface).toMatchObject({
      channel: "telegram",
      id: "42",
    });
  });

  it("renders live thread permissions ahead of stale binding preferences", () => {
    const navigation = buildNavigationSnapshot();
    navigation.threads[0]!.executionMode = "default";
    const intent = buildBindingStatusIntent({
      id: "status-3",
      createdAt: 1000,
      binding: {
        id: "binding-1",
        authorizedActorIds: ["user-1"],
        backend: "codex",
        channel: {
          channel: "telegram",
          conversation: {
            id: "chat-1",
            kind: "dm",
          },
        },
        createdAt: 1000,
        preferences: {
          executionMode: "full-access",
          permissionsMode: "full-access",
          updatedAt: 900,
        },
        threadId: "thread-1",
        updatedAt: 1000,
      } satisfies MessagingBindingRecord,
      navigation,
    });

    expect(intent.text).toContain("Permissions: Default Access");
    expect(intent.actions).toContainEqual(
      expect.objectContaining({
        id: "status:permissions",
        label: "Permissions: Default",
      }),
    );
  });
});

function buildNavigationSnapshot(): NavigationSnapshot {
  return {
    backend: "all",
    directories: [],
    fetchedAt: 1000,
    inboxThreadKeys: [],
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
      fastMode: false,
    },
    threads: [
      {
        id: "thread-1",
        inbox: {
          inInbox: false,
        },
        linkedDirectories: [
          {
            id: "directory:pwragnt",
            kind: "local",
            label: "PwrAgnt",
            path: "/repo/pwragnt",
          },
        ],
        source: "codex",
        title: "Thread one",
        titleSource: "explicit",
      },
    ],
    unchanged: false,
  };
}
