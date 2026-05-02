import { describe, expect, it } from "vitest";
import type {
  MessagingBindingRecord,
  MessagingActiveTurnSummary,
  NavigationSnapshot,
} from "@pwragnt/shared";
import { resolveMessagingThreadState } from "../messaging/core/messaging-thread-state";

describe("resolveMessagingThreadState", () => {
  it("resolves current desktop thread facts from navigation state", () => {
    const binding = buildBinding();
    const navigation = buildNavigationSnapshot();
    const activeTurn = {
      turnId: "turn-1",
      status: "working",
      updatedAt: 1000,
    } satisfies MessagingActiveTurnSummary;

    const state = resolveMessagingThreadState({ activeTurn, binding, navigation });

    expect(state).toMatchObject({
      activeTurn,
      directoryPath: "/repo/pwragnt",
      executionMode: "full-access",
      fastMode: false,
      gitBranch: "main",
      missing: false,
      model: "gpt-5.5",
      observedGitBranch: "feature/live",
      projectLabel: "PwrAgnt",
      reasoningEffort: "high",
      threadKey: "codex:thread-1",
      title: "Live desktop title",
      workMode: "worktree",
      worktreePath: "/repo/pwragnt/.worktrees/live",
    });
  });

  it("returns a missing state without using stale binding display metadata", () => {
    const binding = buildBinding({
      threadDisplay: {
        directoryPath: "/old/path",
        projectLabel: "Old Project",
        threadTitle: "Old cached title",
        worktreePath: "/old/worktree",
      },
    });
    const navigation = buildNavigationSnapshot();
    navigation.threads = [];

    const state = resolveMessagingThreadState({ binding, navigation });

    expect(state).toEqual({
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
      missing: true,
      threadKey: "codex:thread-1",
    });
  });
});

function buildBinding(
  overrides: Partial<MessagingBindingRecord> = {},
): MessagingBindingRecord {
  return {
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
    threadId: "thread-1",
    updatedAt: 1000,
    ...overrides,
  };
}

function buildNavigationSnapshot(): NavigationSnapshot {
  return {
    backend: "all",
    directories: [
      {
        key: "directory:pwragnt",
        kind: "directory",
        label: "PwrAgnt",
        latestUpdatedAt: 1000,
        needsAttentionCount: 0,
        path: "/repo/pwragnt",
        threadKeys: ["codex:thread-1"],
      },
    ],
    fetchedAt: 1000,
    inboxThreadKeys: [],
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
    },
    threads: [
      {
        executionMode: "full-access",
        fastMode: false,
        gitBranch: "main",
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
          {
            id: "worktree:pwragnt-live",
            kind: "worktree",
            label: "PwrAgnt",
            path: "/repo/pwragnt",
            worktreePath: "/repo/pwragnt/.worktrees/live",
          },
        ],
        model: "gpt-5.5",
        observedGitBranch: "feature/live",
        reasoningEffort: "high",
        source: "codex",
        title: "Live desktop title",
        titleSource: "explicit",
      },
    ],
    unchanged: false,
  };
}
