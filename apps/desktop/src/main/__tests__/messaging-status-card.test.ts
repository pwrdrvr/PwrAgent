import { describe, expect, it } from "vitest";
import type { MessagingBindingRecord, NavigationSnapshot } from "@pwragnt/shared";
import {
  buildBindingStatusIntent,
  buildHandoffBranchPickerIntent,
  buildHandoffConfirmationIntent,
  buildHandoffOverviewIntent,
  handoffRequestFromValue,
  type MessagingWorkspaceHandoffContext,
} from "../messaging/core/messaging-status-card";
import { resolveMessagingThreadState } from "../messaging/core/messaging-thread-state";

describe("buildBindingStatusIntent", () => {
  it("renders binding, preference, project, and unavailable status fields", () => {
    const binding = {
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
    } satisfies MessagingBindingRecord;
    const navigation = buildNavigationSnapshot();
    const intent = buildBindingStatusIntent({
      id: "status-1",
      createdAt: 1000,
      binding,
      threadState: resolveMessagingThreadState({ binding, navigation }),
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
    expect(intent.text).toContain("Branch: unavailable");
    expect(intent.text).toContain("Model: gpt-5.3-codex");
    expect(intent.text).toContain("Reasoning: high");
    expect(intent.text).toContain("Fast mode: on");
    expect(intent.text).toContain("Permissions: Full Access");
    expect(intent.text).toContain("Context usage: unavailable");
  });

  it("targets an existing status surface for updates", () => {
    const binding = {
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
    } satisfies MessagingBindingRecord;
    const navigation = buildNavigationSnapshot();
    const intent = buildBindingStatusIntent({
      id: "status-2",
      createdAt: 1000,
      binding,
      threadState: resolveMessagingThreadState({ binding, navigation }),
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
    const binding = {
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
    } satisfies MessagingBindingRecord;
    const intent = buildBindingStatusIntent({
      id: "status-3",
      createdAt: 1000,
      binding,
      threadState: resolveMessagingThreadState({ binding, navigation }),
    });

    expect(intent.text).toContain("Permissions: Default Access");
    expect(intent.actions).toContainEqual(
      expect.objectContaining({
        id: "status:permissions",
        label: "Permissions: Default",
      }),
    );
  });

  it("renders live thread state ahead of stale binding display metadata", () => {
    const navigation = buildNavigationSnapshot();
    navigation.threads[0]!.title = "Renamed in Desktop";
    navigation.threads[0]!.gitBranch = "main";
    navigation.threads[0]!.observedGitBranch = "feature/work";
    const binding = {
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
      threadDisplay: {
        directoryPath: "/old/path",
        projectLabel: "Old Project",
        threadTitle: "Old cached title",
      },
      threadId: "thread-1",
      updatedAt: 1000,
    } satisfies MessagingBindingRecord;

    const intent = buildBindingStatusIntent({
      id: "status-4",
      createdAt: 1000,
      binding,
      threadState: resolveMessagingThreadState({ binding, navigation }),
    });

    expect(intent.text).toContain("Binding: Renamed in Desktop (codex)");
    expect(intent.text).not.toContain("Old cached title");
    expect(intent.text).not.toContain("Old Project");
    expect(intent.text).toContain("Branch: main (now feature/work)");
  });

  it("renders a stale binding without falling back to old display metadata", () => {
    const navigation = buildNavigationSnapshot();
    navigation.threads = [];
    const binding = {
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
      threadDisplay: {
        threadTitle: "Old cached title",
      },
      threadId: "thread-1",
      updatedAt: 1000,
    } satisfies MessagingBindingRecord;

    const intent = buildBindingStatusIntent({
      id: "status-5",
      createdAt: 1000,
      binding,
      threadState: resolveMessagingThreadState({ binding, navigation }),
    });

    expect(intent.text).toContain("Binding: thread-1 (codex)");
    expect(intent.text).toContain("Thread state: unavailable");
    expect(intent.text).not.toContain("Old cached title");
  });

  it("uses launchpad defaults after live state and binding preferences", () => {
    const navigation = buildNavigationSnapshot();
    navigation.launchpadDefaults = {
      backend: "codex",
      executionMode: "full-access",
      fastMode: true,
      model: "gpt-5.4",
      reasoningEffort: "medium",
    };
    const thread = navigation.threads[0]!;
    delete thread.executionMode;
    delete thread.fastMode;
    delete thread.model;
    delete thread.reasoningEffort;
    const binding = {
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
    } satisfies MessagingBindingRecord;

    const intent = buildBindingStatusIntent({
      id: "status-6",
      createdAt: 1000,
      binding,
      threadState: resolveMessagingThreadState({ binding, navigation }),
    });

    expect(intent.text).toContain("Model: gpt-5.4");
    expect(intent.text).toContain("Reasoning: medium");
    expect(intent.text).toContain("Fast mode: on");
    expect(intent.text).toContain("Permissions: Full Access");
  });

  it("adds the status handoff action when a handoff context is available", () => {
    const binding = buildBinding();
    const navigation = buildNavigationSnapshot();
    const intent = buildBindingStatusIntent({
      id: "status-7",
      createdAt: 1000,
      binding,
      handoff: buildHandoffContext(),
      threadState: resolveMessagingThreadState({ binding, navigation }),
    });

    expect(intent.actions).toContainEqual(
      expect.objectContaining({
        id: "status:handoff",
        label: "Handoff",
        value: expect.objectContaining({
          backend: "codex",
          direction: "local-to-worktree",
          repositoryPath: "/repo/pwragnt",
          sourceBranch: "feature/handoff",
          sourcePath: "/repo/pwragnt",
          threadId: "thread-1",
        }),
      }),
    );
  });

  it("builds handoff overview, branch picker, and confirmation intents", () => {
    const binding = buildBinding();
    const context = buildHandoffContext();
    const overview = buildHandoffOverviewIntent({
      id: "handoff-overview-1",
      binding,
      context,
      createdAt: 1000,
    });

    expect(overview).toMatchObject({
      kind: "single_select",
      prompt: expect.stringContaining("Workspace Handoff"),
      choices: expect.arrayContaining([
        expect.objectContaining({
          id: "handoff:local-to-worktree",
          label: "Handoff to New Worktree",
        }),
      ]),
    });

    const branchPicker = buildHandoffBranchPickerIntent({
      id: "handoff-branch-1",
      binding,
      context,
      createdAt: 1000,
    });
    expect(branchPicker.choices[0]).toMatchObject({
      id: "handoff:select-leave-branch",
      label: "1. main",
      value: expect.objectContaining({
        leaveLocalBranch: "main",
      }),
    });

    const confirmation = buildHandoffConfirmationIntent({
      id: "handoff-confirm-1",
      binding,
      context,
      createdAt: 1000,
      leaveLocalBranch: "main",
    });
    expect(confirmation).toMatchObject({
      kind: "confirmation",
      title: "Confirm Handoff",
      body: expect.stringContaining("Leave Local on: main"),
      actions: expect.arrayContaining([
        expect.objectContaining({
          id: "handoff:confirm",
          value: expect.objectContaining({
            leaveLocalBranch: "main",
          }),
        }),
      ]),
    });
  });

  it("parses a handoff request only from complete action values", () => {
    expect(
      handoffRequestFromValue({
        backend: "codex",
        direction: "local-to-worktree",
        repositoryPath: "/repo/pwragnt",
        sourceBranch: "feature/handoff",
        sourcePath: "/repo/pwragnt",
        threadId: "thread-1",
      }),
    ).toEqual({
      backend: "codex",
      direction: "local-to-worktree",
      repositoryPath: "/repo/pwragnt",
      sourceBranch: "feature/handoff",
      sourcePath: "/repo/pwragnt",
      threadId: "thread-1",
    });
    expect(handoffRequestFromValue({ direction: "local-to-worktree" })).toBeUndefined();
  });
});

function buildBinding(): MessagingBindingRecord {
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
  };
}

function buildHandoffContext(): MessagingWorkspaceHandoffContext {
  return {
    backend: "codex",
    branch: "feature/handoff",
    leaveLocalBranches: ["main", "develop"],
    projectLabel: "PwrAgnt",
    repositoryPath: "/repo/pwragnt",
    threadId: "thread-1",
    threadTitle: "Thread one",
    workingDirectoryPath: "/repo/pwragnt",
    workspaceKind: "local",
  };
}

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
