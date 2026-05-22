import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  AppServerListSkillsResponse,
  AppServerPendingRequestNotification,
  BackendSummary,
  CancelThreadExecutionModeQueueRequest,
  HandoffThreadWorkspaceRequest,
  ListBackendsResponse,
  MaterializeDirectoryLaunchpadRequest,
  MessagingToolUpdateMode,
  NavigationSnapshot,
  SetThreadExecutionModeRequest,
  SetThreadModelSettingsRequest,
  StartThreadRequest,
  StartTurnRequest,
  SteerTurnRequest,
  SubmitServerRequestRequest,
  UpdateDirectoryLaunchpadRequest,
} from "@pwragent/shared";
import type {
  MessagingCapabilityProfile,
  MessagingSurfaceAction,
  MessagingChannelKind,
  MessagingDeliveryScope,
  MessagingDeliveryResult,
  MessagingInboundCallbackEvent,
  MessagingInboundEvent,
  MessagingInboundTextEvent,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import {
  MessagingController,
  messagingDeliveryPriority,
  shouldConsumeDeliveryBudget,
  type MessagingControllerOptions,
} from "../messaging/core/messaging-controller";
import type { MessagingAdapter, MessagingBackendBridge } from "../messaging/core/messaging-adapter";
import { MessagingDeliveryBudget } from "../messaging/core/messaging-delivery-budget";
import { MessagingStore } from "../messaging/core/messaging-store";

const tempDirs: string[] = [];

vi.mock("../messaging/attachment-image-normalization", () => ({
  normalizeMessagingImageAttachment: vi.fn(async () => ({
    dataUrl: "data:image/png;base64,AQID",
    height: 1,
    mimeType: "image/png",
    width: 1,
  })),
}));

async function createStore(): Promise<MessagingStore> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-controller-"));
  tempDirs.push(tempDir);
  return new MessagingStore(path.join(tempDir, "messaging-state.json"));
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    tempDirs.splice(0).map(async (tempDir) => {
      await rm(tempDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 10,
      });
    }),
  );
});

describe("MessagingController", () => {
  it("presents a channel-neutral thread picker for authorized /resume commands", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume"));

    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered[0]).toMatchObject({
      kind: "thread_picker",
      fallbackText: expect.stringContaining("Showing recent PwrAgent threads."),
    });
    expect(JSON.stringify(harness.delivered[0])).not.toMatch(/callback_data|custom_id/);
    await expect(harness.store.getPendingIntent(harness.delivered[0]!.id, { now: 1000 }))
      .resolves.toMatchObject({
        channel: {
          channel: "telegram",
        },
      });
  });

  it("returns from the nested new-thread picker back to the resume browser", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:mode:new",
      }),
    );

    const newPicker = harness.delivered.at(-1);
    expect(newPicker).toMatchObject({
      kind: "project_picker",
      prompt: expect.stringContaining("Choose a project for the new PwrAgent thread"),
      page: {
        actions: expect.arrayContaining([
          expect.objectContaining({
            id: "browse:mode:resume",
            label: "Resume",
          }),
          expect.objectContaining({ id: "browse:cancel" }),
        ]),
      },
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:mode:resume",
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "thread_picker",
      prompt: expect.stringContaining("Choose a thread to resume"),
      page: {
        actions: expect.arrayContaining([
          expect.objectContaining({ id: "browse:mode:new", label: "New" }),
        ]),
      },
    });
  });

  it("filters Full Access threads out of messaging resume when disabled", async () => {
    const navigation = buildNavigationSnapshot();
    navigation.threads = [
      {
        ...navigation.threads[0]!,
        executionMode: "full-access",
      },
      {
        id: "thread-2",
        title: "Default thread",
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
        executionMode: "default",
        updatedAt: 900,
      },
    ];
    navigation.directories[0] = {
      ...navigation.directories[0]!,
      threadKeys: ["codex:thread-1", "codex:thread-2"],
    };
    const harness = await createHarness({
      navigation,
      fullAccessControls: {
        allowEscalation: true,
        allowThreadResume: false,
        warningPolicy: "dismissable",
      },
    });

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume"));

    expect(harness.delivered[0]).toMatchObject({
      kind: "thread_picker",
      page: {
        items: [
          expect.objectContaining({
            id: "thread-2",
          }),
        ],
      },
    });
    expect(JSON.stringify(harness.delivered[0])).not.toContain("thread-1");
  });

  it("shows projects from /resume --projects and filters threads after a project click", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume --projects"));

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "project_picker",
      fallbackText: expect.stringContaining("Choose a project"),
      page: {
        items: [
          expect.objectContaining({
            label: "PwrAgent",
          }),
        ],
      },
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "thread_picker",
      fallbackText: expect.stringContaining("PwrAgent"),
      page: {
        items: [
          expect.objectContaining({
            id: "thread-1",
          }),
        ],
      },
    });
  });

  it("starts a new thread from /resume --new only after the first prompt arrives", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume --new"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );

    expect(harness.startThread).not.toHaveBeenCalled();
    expect(harness.materializeDirectoryLaunchpad).not.toHaveBeenCalled();
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/resume").channel),
    ).resolves.toBeUndefined();
    const readyIntent = harness.delivered.at(-1);
    expect(readyIntent).toMatchObject({
      kind: "confirmation",
      title: "Ready to start",
      body: expect.stringContaining("PwrAgent"),
      actions: expect.arrayContaining([
        expect.objectContaining({ id: "browse:new:workspace:local", label: "Local ✓" }),
        expect.objectContaining({ id: "browse:new:permissions" }),
        expect.objectContaining({ id: "browse:new:fast" }),
        expect.objectContaining({ id: "browse:new:streaming" }),
        expect.objectContaining({ id: "browse:new:model" }),
        expect.objectContaining({ id: "browse:new:reasoning" }),
      ]),
    });
    expect(readyIntent).toMatchObject({
      actions: expect.not.arrayContaining([
        expect.objectContaining({ id: "browse:new:workspace:worktree" }),
      ]),
    });
    expect(readyIntent).toMatchObject({
      body: expect.stringContaining("Streaming: off"),
    });
    expect(readyIntent).toMatchObject({
      browseSessionId: expect.stringMatching(/^browse:/),
    });

    await harness.controller.handleInboundEvent(buildTextEvent("Fix bug"));

    expect(harness.materializeDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: expect.stringMatching(/^messaging:browse:/),
      launchpad: expect.objectContaining({
        backend: "codex",
        directoryKey: "directory:pwragent",
        directoryLabel: "PwrAgent",
        directoryPath: "/repo/pwragent",
        executionMode: "default",
        fastMode: undefined,
        model: undefined,
        prompt: "",
        reasoningEffort: undefined,
        serviceTier: undefined,
        workMode: "local",
      }),
    });
    expect(harness.startThread).not.toHaveBeenCalled();
    expect(harness.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "new-thread-1",
        input: [
          {
            type: "text",
            text: "Fix bug",
          },
        ],
      }),
    );
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/resume").channel),
    ).resolves.toMatchObject({
      backend: "codex",
      threadId: "new-thread-1",
    });
    const binding = await harness.store.findActiveBindingForChannel(
      buildCommandEvent("/resume").channel,
    );
    expect(binding).not.toHaveProperty("threadDisplay");
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      delivery: expect.objectContaining({
        mode: "update",
      }),
      text: expect.stringContaining("Project: PwrAgent"),
    });
    expect(harness.delivered).not.toContainEqual(
      expect.objectContaining({
        kind: "confirmation",
        title: "Thread started",
      }),
    );
    expect(harness.delivered.at(-1)).toMatchObject({
      text: expect.stringContaining("Directory: /repo/pwragent"),
    });
  });

  it("updates the ready prompt into the first status card without exhausting the DM budget", async () => {
    let now = 0;
    const scope: MessagingDeliveryScope = {
      platform: "telegram",
      id: "telegram:dm:chat-1",
      kind: "dm",
      budget: { limit: 1, intervalMs: 1000, reserved: 0 },
    };
    const budgetEvents: Array<
      Parameters<NonNullable<MessagingControllerOptions["onDeliveryBudgetEvent"]>>[0]
    > = [];
    const harness = await createHarness({
      deliveryBudget: new MessagingDeliveryBudget({ now: () => now }),
      now: () => now,
      onDeliveryBudgetEvent: (event) => budgetEvents.push(event),
      resolveDeliveryScope: () => scope,
    });

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume --new"));
    now = 2000;
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );

    now = 4000;
    await harness.controller.handleInboundEvent(buildTextEvent("Fix bug"));

    expect(harness.delivered).not.toContainEqual(
      expect.objectContaining({
        kind: "confirmation",
        title: "Thread started",
      }),
    );
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      delivery: expect.objectContaining({ mode: "update" }),
    });
    expect(budgetEvents).toEqual([]);
  });

  it("starts a new messaging thread in a new worktree from the selected base branch", async () => {
    const harness = await createHarness({
      navigation: {
        ...buildNavigationSnapshot(),
        directories: [
          {
            ...buildNavigationSnapshot().directories[0]!,
            gitStatus: {
              currentBranch: "feature/current",
              defaultBranch: "main",
              branches: ["main", "release/v2", "feature/current"],
            },
          },
        ],
      },
    });

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume --new"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:new:workspace:worktree",
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      body: expect.stringContaining("Workspace: New Worktree"),
      actions: expect.arrayContaining([
        expect.objectContaining({
          id: "browse:new:base-branch",
          label: "Base: main",
        }),
      ]),
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:new:base-branch",
      }),
    );
    expect(harness.delivered.at(-1)).toMatchObject({
      title: "Pick base branch",
      actions: expect.arrayContaining([
        expect.objectContaining({
          id: "browse:new:set-base-branch",
          label: "2. release/v2",
          value: { branchName: "release/v2" },
        }),
      ]),
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:new:set-base-branch",
        value: { branchName: "release/v2" },
      }),
    );
    await harness.controller.handleInboundEvent(buildTextEvent("Fix bug in a worktree"));

    expect(harness.startThread).not.toHaveBeenCalled();
    expect(harness.materializeDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: expect.stringMatching(/^messaging:browse:/),
      launchpad: expect.objectContaining({
        backend: "codex",
        directoryKey: "directory:pwragent",
        directoryPath: "/repo/pwragent",
        executionMode: "default",
        workMode: "worktree",
        branchName: "release/v2",
      }),
    });
  });

  it("keeps non-git new-thread prompts local when a worktree action is requested", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume --new"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      body: expect.stringContaining("Workspace: Local"),
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      actions: expect.not.arrayContaining([
        expect.objectContaining({ id: "browse:new:base-branch" }),
      ]),
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      actions: expect.not.arrayContaining([
        expect.objectContaining({ id: "browse:new:workspace:worktree" }),
      ]),
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:new:workspace:worktree",
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      body: expect.stringContaining("Workspace: Local"),
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      body: expect.not.stringContaining("Base branch:"),
      actions: expect.not.arrayContaining([
        expect.objectContaining({ id: "browse:new:base-branch" }),
      ]),
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      actions: expect.not.arrayContaining([
        expect.objectContaining({ id: "browse:new:workspace:worktree" }),
      ]),
    });

    await harness.controller.handleInboundEvent(buildTextEvent("Fix bug locally"));

    expect(harness.materializeDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: expect.stringMatching(/^messaging:browse:/),
      launchpad: expect.objectContaining({
        directoryKey: "directory:pwragent",
        directoryPath: "/repo/pwragent",
        workMode: "local",
      }),
    });
  });

  it("paginates the new-thread base branch picker", async () => {
    const branches = Array.from({ length: 18 }, (_, index) => `branch-${index + 1}`);
    const harness = await createHarness({
      navigation: {
        ...buildNavigationSnapshot(),
        directories: [
          {
            ...buildNavigationSnapshot().directories[0]!,
            gitStatus: {
              currentBranch: "feature/current",
              defaultBranch: "main",
              branches,
            },
          },
        ],
      },
    });

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume --new"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "browse:new:workspace:worktree" }),
    );
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "browse:new:base-branch" }),
    );

    const firstPage = harness.delivered.at(-1);
    if (!firstPage || firstPage.kind !== "confirmation") {
      throw new Error("Expected new-thread base branch picker");
    }
    expect(firstPage.body).toContain("Page 1/3.");
    expect(
      firstPage.actions.filter((action) => action.id === "browse:new:set-base-branch"),
    ).toHaveLength(8);
    expect(firstPage.actions).toContainEqual(
      expect.objectContaining({
        id: "browse:new:branches:next",
        value: expect.objectContaining({ pageIndex: 1 }),
      }),
    );

    const nextPage = findAction(firstPage, "browse:new:branches:next");
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: nextPage.id,
        value: nextPage.value,
      }),
    );

    const secondPage = harness.delivered.at(-1);
    if (!secondPage || secondPage.kind !== "confirmation") {
      throw new Error("Expected second new-thread base branch picker page");
    }
    expect(secondPage.body).toContain("Page 2/3.");
    expect(secondPage.actions[0]).toMatchObject({
      id: "browse:new:set-base-branch",
      label: "9. branch-8",
    });
    expect(secondPage.actions).toContainEqual(
      expect.objectContaining({
        id: "browse:new:branches:previous",
        value: expect.objectContaining({ pageIndex: 0 }),
      }),
    );
  });

  it("uses the materialized worktree path in the optimistic status for messaging-started threads", async () => {
    const harness = await createHarness();
    harness.getNavigationSnapshot.mockResolvedValue(buildWorktreeLaunchpadNavigationSnapshot());

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume --new"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );
    await harness.controller.handleInboundEvent(buildTextEvent("Fix bug"));

    expect(harness.materializeDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: expect.stringMatching(/^messaging:browse:/),
      launchpad: expect.objectContaining({
        directoryKey: "directory:pwragent",
        directoryPath: "/repo/pwragent",
        workMode: "worktree",
      }),
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Directory: /repo/pwragent"),
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      text: expect.stringContaining("Worktree: /repo/pwragent/.worktrees/new-thread-1"),
    });
  });

  it("cancels a pending new-thread prompt without creating a thread", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume --new"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:cancel",
      }),
    );

    expect(harness.startThread).not.toHaveBeenCalled();
    expect(harness.materializeDirectoryLaunchpad).not.toHaveBeenCalled();
    expect(harness.startTurn).not.toHaveBeenCalled();
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/resume").channel),
    ).resolves.toBeUndefined();
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Resume cancelled",
    });

    harness.delivered.length = 0;
    await harness.controller.handleInboundEvent(buildTextEvent("@huntharo_bot"));

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "PwrAgent commands",
    });
    expect(harness.delivered.at(-1)).not.toMatchObject({
      title: "Choose an option",
    });
  });

  it("resolves pending new-thread Back through persisted callback handles", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume --new"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );
    const readyIntent = harness.delivered.at(-1);
    if (readyIntent?.kind !== "confirmation" || !readyIntent.browseSessionId) {
      throw new Error("Expected ready-to-start confirmation with a browse session id");
    }
    await harness.store.upsertCallbackHandle({
      id: "callback:ready-back",
      actionId: "browse:mode:new",
      allowedActorIds: ["user-1"],
      browseSessionId: readyIntent.browseSessionId,
      channel: buildCommandEvent("/resume").channel,
      createdAt: 1000,
      updatedAt: 1000,
      expiresAt: 2000,
      handle: "tg:ready-back",
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:mode:new",
        interactionId: "tg:ready-back",
      }),
    );

    expect(harness.startThread).not.toHaveBeenCalled();
    expect(harness.materializeDirectoryLaunchpad).not.toHaveBeenCalled();
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "project_picker",
      prompt: expect.stringContaining("Choose a project for the new PwrAgent thread"),
    });
  });

  it("pins the Workspaces Scratchpad first without listing duplicate workspace roots", async () => {
    const navigation = buildNavigationSnapshot();
    navigation.directories = [
      {
        ...navigation.directories[0]!,
        latestUpdatedAt: 9_000,
      },
      {
        key: "workspace:/Users/test/.pwragent/profiles/default/projects",
        kind: "workspace",
        label: "Workspaces",
        path: "/Users/test/.pwragent/profiles/default/projects",
        threadKeys: ["codex:profile-scratchpad-1", "codex:profile-scratchpad-2"],
        needsAttentionCount: 0,
        latestUpdatedAt: 8_500,
      },
      {
        key: "workspace:/Users/test/.pwragent/projects",
        kind: "workspace",
        label: "Workspaces",
        path: "/Users/test/.pwragent/projects",
        threadKeys: ["codex:scratchpad-thread"],
        needsAttentionCount: 0,
        latestUpdatedAt: 1_000,
      },
      {
        key: "directory:giphy-demo",
        kind: "directory",
        label: "giphy-demo",
        path: "/repo/giphy-demo",
        threadKeys: ["codex:giphy-thread"],
        needsAttentionCount: 0,
        latestUpdatedAt: 8_000,
      },
    ];
    const harness = await createHarness({ navigation });

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume --new"));

    const pickerIntent = harness.delivered.at(-1);
    if (pickerIntent?.kind !== "project_picker") {
      throw new Error("Expected project picker intent");
    }

    expect(
      pickerIntent.page.actions.filter((action) => action.id === "browse:select-project"),
    ).toEqual([
      expect.objectContaining({
        id: "browse:select-project",
        label: "1. Workspaces Scratchpad (3)",
        value: {
          directoryKey: "workspace:/Users/test/.pwragent/profiles/default/projects",
          label: "Workspaces Scratchpad",
          path: "/Users/test/.pwragent/profiles/default/projects",
        },
      }),
      expect.objectContaining({
        id: "browse:select-project",
        label: "2. PwrAgent (1)",
      }),
      expect.objectContaining({
        id: "browse:select-project",
        label: "3. giphy-demo (1)",
      }),
    ]);
  });

  it("debounces split first prompts before creating a messaging-started thread", async () => {
    const harness = await createHarness({ inputDebounceMs: 100 });

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume --new"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );

    await harness.controller.handleInboundEvent(buildTextEvent("First prompt chunk"));
    await harness.controller.handleInboundEvent(buildTextEvent("second prompt chunk"));
    expect(harness.startThread).not.toHaveBeenCalled();
    expect(harness.materializeDirectoryLaunchpad).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 125));

    await vi.waitFor(() => {
      expect(harness.startThread).not.toHaveBeenCalled();
      expect(harness.materializeDirectoryLaunchpad).toHaveBeenCalledTimes(1);
      expect(harness.startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "new-thread-1",
          input: [
            {
              type: "text",
              text: "First prompt chunk",
            },
            {
              type: "text",
              text: "second prompt chunk",
            },
          ],
        }),
      );
    });
  });

  it("surfaces debounced new-thread creation failures", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const harness = await createHarness({
      inputDebounceMs: 10,
      logger,
      materializeDirectoryLaunchpad: async () => {
        throw new Error("backend unavailable");
      },
    });

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume --new"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );
    await harness.controller.handleInboundEvent(buildTextEvent("Fix bug"));

    expect(harness.startThread).not.toHaveBeenCalled();
    expect(harness.materializeDirectoryLaunchpad).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(harness.startThread).not.toHaveBeenCalled();
    expect(harness.materializeDirectoryLaunchpad).toHaveBeenCalledTimes(1);
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Thread could not start",
      body: "backend unavailable",
      recoverable: true,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "messaging new-thread prompt failed",
      expect.objectContaining({
        error: "backend unavailable",
      }),
    );
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/resume").channel),
    ).resolves.toBeUndefined();
  });

  it("routes messages to the new thread after rebinding an already-bound conversation", async () => {
    const harness = await createHarness();
    await harness.store.upsertBinding({
      id: "binding:telegram:dm::chat-1:codex:old-thread",
      authorizedActorIds: ["user-1"],
      backend: "codex",
      channel: buildCommandEvent("/resume").channel,
      createdAt: 900,
      threadId: "old-thread",
      updatedAt: 900,
    });

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume --new"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );
    await harness.controller.handleInboundEvent(buildTextEvent("continue on the new thread"));

    expect(harness.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "new-thread-1",
        input: [
          {
            type: "text",
            text: "continue on the new thread",
          },
        ],
      }),
    );
    await expect(harness.store.getBinding("binding:telegram:dm::chat-1:codex:old-thread"))
      .resolves.toMatchObject({
        revokedAt: 1000,
      });
    expect(harness.recordMessagingBindingTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "old-thread",
        transition: expect.objectContaining({
          action: "unbound",
          bindingId: "binding:telegram:dm::chat-1:codex:old-thread",
          platform: "telegram",
          occurredAt: 1000,
        }),
      }),
    );
    expect(harness.recordMessagingBindingTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "new-thread-1",
        transition: expect.objectContaining({
          action: "bound",
          platform: "telegram",
          occurredAt: 1000,
        }),
      }),
    );
  });

  it("binds a callback-selected thread to the channel", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "bind:codex:thread-1",
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );

    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/resume").channel),
    ).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      authorizedActorIds: ["user-1"],
    });
    expect(harness.recordMessagingBindingTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        transition: expect.objectContaining({
          action: "bound",
          bindingId: "binding:telegram:dm::chat-1:codex:thread-1",
          conversationKind: "dm",
          platform: "telegram",
          occurredAt: 1000,
        }),
      }),
    );
    expect(harness.delivered.find((intent) => intent.kind === "confirmation")).toMatchObject({
      kind: "confirmation",
      title: "Thread bound",
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      delivery: {
        pin: true,
      },
      text: expect.stringContaining("Binding: Thread one"),
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      text: expect.stringContaining("Tool updates: Show Some"),
      actions: expect.arrayContaining([
        expect.objectContaining({
          id: "status:tool-updates",
          label: "Tools: Show Some",
          fallbackText: "tools",
        }),
        expect.objectContaining({
          id: "status:streaming",
          label: "Stream: Off",
          fallbackText: "stream",
        }),
      ]),
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      text: expect.stringContaining("Streaming: Off"),
    });
  });

  it("uses the provider conversation-input profile for shared-chat mention instructions", async () => {
    const mentionRequiredProfile: MessagingCapabilityProfile = {
      ...PERMISSIVE_CAPABILITY_PROFILE,
      conversationInput: {
        sharedConversationRequiresMention: true,
        sharedConversationMentionInstruction:
          "In this shared chat, @mention this bot for messages to reach the bound thread.",
        sharedConversationStatusLine:
          "Input: @mention this bot for messages to reach this bound thread.",
      },
    };
    const harness = await createHarness({ capabilityProfile: mentionRequiredProfile });
    const sharedChannel = {
      channel: "mattermost" as const,
      conversation: {
        id: "channel-1",
        kind: "channel" as const,
      },
    };

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "bind:codex:thread-1",
        channel: sharedChannel,
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );

    expect(harness.delivered.find((intent) => intent.kind === "confirmation")).toMatchObject({
      kind: "confirmation",
      title: "Thread bound",
      body: expect.stringContaining("@mention this bot"),
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("@mention this bot"),
    });
  });

  it("cycles per-binding streaming mode from the status card", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:streaming" }),
    );

    const bindingAfterEnable = await harness.store.findActiveBindingForChannel(
      buildCommandEvent("/resume").channel,
    );
    expect(bindingAfterEnable?.preferences?.streamingResponses).toBe("enabled");
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Streaming: On"),
      actions: expect.arrayContaining([
        expect.objectContaining({ label: "Stream: On" }),
      ]),
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:streaming" }),
    );

    const bindingAfterDisable = await harness.store.findActiveBindingForChannel(
      buildCommandEvent("/resume").channel,
    );
    expect(bindingAfterDisable?.preferences?.streamingResponses).toBe("disabled");
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Streaming: Off"),
      actions: expect.arrayContaining([
        expect.objectContaining({ label: "Stream: Off" }),
      ]),
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:streaming" }),
    );

    const bindingAfterReenable = await harness.store.findActiveBindingForChannel(
      buildCommandEvent("/resume").channel,
    );
    expect(bindingAfterReenable?.preferences?.streamingResponses).toBe("enabled");
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Streaming: On"),
      actions: expect.arrayContaining([
        expect.objectContaining({ label: "Stream: On" }),
      ]),
    });
  });

  it("shows and toggles the effective streaming default from the new-thread screen", async () => {
    const harness = await createHarness({ streamingResponsesDefault: true });

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume --new"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      body: expect.stringContaining("Streaming: on"),
      actions: expect.arrayContaining([
        expect.objectContaining({
          id: "browse:new:streaming",
          label: "Stream: on",
        }),
      ]),
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "browse:new:streaming" }),
    );
    await harness.controller.handleInboundEvent(buildTextEvent("Start with streams off"));

    const binding = await harness.store.findActiveBindingForChannel(
      buildCommandEvent("/resume").channel,
    );
    expect(binding?.preferences?.streamingResponses).toBe("disabled");
    expect(harness.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "new-thread-1",
      }),
    );
  });

  it("updates the resume picker and removes actions when selecting a thread", async () => {
    const harness = await createHarness();
    await harness.controller.handleInboundEvent(buildCommandEvent("/resume"));

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-thread",
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );

    const confirmation = [...harness.delivered]
      .reverse()
      .find((intent) => intent.kind === "confirmation");
    expect(confirmation).toMatchObject({
      kind: "confirmation",
      title: "Thread bound",
      actions: [],
      delivery: {
        mode: "update",
        replaceMarkup: true,
      },
      targetSurface: expect.objectContaining({
        id: expect.stringContaining("surface:resume:"),
      }),
    });
  });

  it("reposts the last assistant response after selecting a thread to resume", async () => {
    const now = Date.UTC(2026, 4, 15, 13, 30);
    const harness = await createHarness({
      now: () => now,
      readThreadLastAssistantReply: async function (
        this: MessagingBackendBridge,
      ) {
        if (typeof this.getNavigationSnapshot !== "function") {
          throw new Error("backend receiver was not preserved");
        }
        return {
          createdAt: now - 60 * 60_000,
          text: "Last completed answer.",
        };
      },
    });
    await harness.controller.handleInboundEvent(buildCommandEvent("/resume"));

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-thread",
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );

    expect(harness.readThreadLastAssistantReply).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "message",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: expect.stringMatching(
            /^Last Bot Reply \(1 hour ago, .+\)\n\nLast completed answer\.$/,
          ),
        },
      ],
    });
  });

  it("completes binding mutations without throwing when no onBindingChanged listener is configured", async () => {
    // The `onBindingChanged` option is declared optional on
    // `MessagingControllerOptions`. Production wiring always supplies
    // one (see `messaging-runtime.ts`), but the controller must
    // remain safe to construct without it — defensive coverage so a
    // future test or alternate consumer that forgets the callback
    // doesn't crash on the first bind/detach.
    const harness = await createHarness({ bindingChangedListener: false });
    await harness.controller.handleInboundEvent(buildCommandEvent("/resume"));
    await expect(
      harness.controller.handleInboundEvent(
        buildCallbackEvent({
          actionId: "browse:select-thread",
          value: { backend: "codex", threadId: "thread-1" },
        }),
      ),
    ).resolves.not.toThrow();
    // Bind landed despite no callback wired.
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/resume").channel),
    ).resolves.toMatchObject({ backend: "codex", threadId: "thread-1" });
    // Detach also completes — fan-out is best-effort, mutation isn't.
    await expect(
      harness.controller.handleInboundEvent(buildCommandEvent("/detach")),
    ).resolves.not.toThrow();
    // Active lookup now misses (the row is revoked, not deleted).
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/resume").channel),
    ).resolves.toBeUndefined();
  });

  it("fires onBindingChanged on every binding mutation path", async () => {
    // Regression: binding chips in the navigation snapshot only refresh
    // when the renderer refetches the snapshot. The renderer was only
    // refetching on backend events — so bind / detach / sync-name
    // didn't propagate until the next backend tick (issue #191). The
    // controller now fan-outs `onBindingChanged` on every mutation.
    const setConversationTitle = vi.fn(
      async (
        request: Parameters<NonNullable<MessagingAdapter["setConversationTitle"]>>[0],
      ) => ({
        channel: "telegram" as const,
        conversation: {
          ...request.channel.conversation,
          title: request.title,
        },
        outcome: "updated" as const,
        title: request.title,
        updatedAt: 1000,
      }),
    );
    const harness = await createHarness({ setConversationTitle });
    const navigation = buildNavigationSnapshot();
    navigation.threads[0]!.title = "Renamed in Desktop";
    harness.getNavigationSnapshot.mockResolvedValue(navigation);

    // 1. bind via /resume picker → callback path
    await harness.controller.handleInboundEvent(buildCommandEvent("/resume"));
    harness.onBindingChanged.mockClear();
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-thread",
        value: { backend: "codex", threadId: "thread-1" },
      }),
    );
    expect(harness.onBindingChanged).toHaveBeenCalled();

    // 2. /sync name updates the title and must also fire
    harness.onBindingChanged.mockClear();
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "status:sync-name",
        routingState: {
          opaque: { chatId: 777, messageThreadId: 9 },
        },
      }),
    );
    expect(harness.onBindingChanged).toHaveBeenCalled();

    // 3. /detach revokes the binding and must also fire
    harness.onBindingChanged.mockClear();
    await harness.controller.handleInboundEvent(buildCommandEvent("/detach"));
    expect(harness.onBindingChanged).toHaveBeenCalled();
    expect(harness.recordMessagingBindingTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        transition: expect.objectContaining({
          action: "unbound",
          platform: "telegram",
        }),
      }),
    );
  });

  it("routes text to the bound thread after a /resume → select-thread bind", async () => {
    // Regression: the resume browser stores a channel-scoped pending
    // intent. Before `bindChannelToThread` started retiring channel
    // intents on a successful bind, that picker intent survived the
    // bind, and the next text inbound matched it as ambiguous —
    // making the bot bounce "Choose an option" instead of routing the
    // text to the freshly-bound thread.
    const harness = await createHarness();
    // The test harness uses `receivedAt: 1000`; pin the lookup clock
    // inside the intent's TTL window so the picker intent is visible.
    const lookupNow = 1500;
    await harness.controller.handleInboundEvent(buildCommandEvent("/resume"));
    expect(
      await harness.store.findActivePendingIntentForChannel({
        actorId: "user-1",
        channel: buildTextEvent("ignored").channel,
        now: lookupNow,
      }),
    ).toBeTruthy();

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-thread",
        value: { backend: "codex", threadId: "thread-1" },
      }),
    );

    // After the bind, no channel-scoped pending intent should remain
    // — the picker intent must be retired so it can't intercept the
    // next text.
    expect(
      await harness.store.findActivePendingIntentForChannel({
        actorId: "user-1",
        channel: buildTextEvent("ignored").channel,
        now: lookupNow,
      }),
    ).toBeUndefined();

    harness.delivered.length = 0;
    harness.startTurn.mockClear();
    await harness.controller.handleInboundEvent(buildTextEvent("you there?"));

    // Text routes to the bound thread, not back to the picker.
    expect(harness.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        input: [{ type: "text", text: "you there?" }],
      }),
    );
    const confirmations = harness.delivered.filter(
      (intent) => intent.kind === "confirmation",
    );
    for (const confirmation of confirmations) {
      expect(confirmation).not.toMatchObject({ title: "Choose an option" });
      expect(confirmation).not.toMatchObject({ title: "Choose a thread" });
    }
  });

  it("updates the clicked resume picker when multiple pickers are active", async () => {
    const harness = await createHarness();
    await harness.controller.handleInboundEvent(buildCommandEvent("/resume"));
    const firstPicker = harness.delivered.at(-1);
    if (firstPicker?.kind !== "thread_picker" || !firstPicker.browseSessionId) {
      throw new Error("Expected first resume picker with a browse session id");
    }

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume"));
    const secondPicker = harness.delivered.at(-1);
    if (secondPicker?.kind !== "thread_picker") {
      throw new Error("Expected second resume picker");
    }

    await harness.store.upsertCallbackHandle({
      id: "callback:first-picker",
      actionId: "browse:select-thread",
      allowedActorIds: ["user-1"],
      browseSessionId: firstPicker.browseSessionId,
      channel: buildCommandEvent("/resume").channel,
      createdAt: 1000,
      updatedAt: 1000,
      expiresAt: 2000,
      handle: "tg:first-picker",
      value: {
        backend: "codex",
        threadId: "thread-1",
      },
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-thread",
        interactionId: "tg:first-picker",
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );

    const confirmation = [...harness.delivered]
      .reverse()
      .find((intent) => intent.kind === "confirmation");
    expect(confirmation).toMatchObject({
      kind: "confirmation",
      targetSurface: expect.objectContaining({
        id: `surface:${firstPicker.id}`,
      }),
    });
    expect(confirmation).not.toMatchObject({
      targetSurface: expect.objectContaining({
        id: `surface:${secondPicker.id}`,
      }),
    });
  });

  it("maps text fallback replies against pending picker actions", async () => {
    const harness = await createHarness();
    await harness.controller.handleInboundEvent(buildCommandEvent("/resume"));

    await harness.controller.handleInboundEvent(buildTextEvent("1"));

    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/resume").channel),
    ).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it("routes free-form text in a bound conversation to the bound thread", async () => {
    const harness = await createHarness();
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "bind:codex:thread-1",
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );

    await harness.controller.handleInboundEvent(buildTextEvent("please run the tests"));

    expect(harness.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        input: [
          {
            type: "text",
            text: "please run the tests",
          },
        ],
      }),
    );
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      status: "working",
    });
    expect(harness.delivered.find((intent) => intent.kind === "activity")).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "active",
    });
  });

  it("signals typing activity from backend turn lifecycle events", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    harness.delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "running",
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "active",
    });

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [],
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "idle",
    });
  });

  it("echoes binding routing state into typing activity intents", async () => {
    const harness = await createHarness();
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "bind:codex:thread-1",
        channel: {
          channel: "telegram",
          conversation: {
            id: "-1003711601984",
            kind: "channel",
            title: "PwrDrvr",
          },
        },
        routingState: {
          opaque: {
            chatId: -1003711601984,
            messageThreadId: 1,
          },
        },
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );
    harness.delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "running",
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "active",
      audit: {
        channel: {
          channel: "telegram",
          conversation: {
            id: "-1003711601984",
            kind: "channel",
          },
        },
      },
      targetSurface: {
        channel: "telegram",
        state: {
          opaque: {
            chatId: -1003711601984,
            messageThreadId: 1,
          },
        },
      },
    });
  });

  it("refreshes stale binding routing state before typing activity", async () => {
    const harness = await createHarness();
    const generalChannel = {
      channel: "telegram" as const,
      conversation: {
        id: "-1003711601984",
        kind: "channel" as const,
        title: "PwrDrvr",
      },
    };
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "bind:codex:thread-1",
        channel: generalChannel,
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );
    harness.delivered.length = 0;

    await harness.controller.handleInboundEvent(
      buildTextEvent("start work", {
        channel: generalChannel,
        routingState: {
          opaque: {
            chatId: -1003711601984,
            messageThreadId: 1,
          },
        },
      }),
    );

    expect(
      harness.delivered.find(
        (intent) => intent.kind === "activity" && intent.state === "active",
      ),
    ).toMatchObject({
      kind: "activity",
      activity: "typing",
      targetSurface: {
        channel: "telegram",
        state: {
          opaque: {
            chatId: -1003711601984,
            messageThreadId: 1,
          },
        },
      },
    });
  });

  it("drops typing activity during provider cool-off without spending write budget", async () => {
    let now = 1_000;
    const scope: MessagingDeliveryScope = {
      platform: "telegram",
      id: "telegram:group:chat-1",
      kind: "group",
      budget: { limit: 20, intervalMs: 60_000, reserved: 5 },
    };
    const deliveryBudget = new MessagingDeliveryBudget({ now: () => now });
    const budgetEvents: Parameters<
      NonNullable<MessagingControllerOptions["onDeliveryBudgetEvent"]>
    >[0][] = [];
    const harness = await createHarness({
      channel: "telegram",
      now: () => now,
      deliveryBudget,
      resolveDeliveryScope: (intent) =>
        intent.kind === "activity" || intent.kind === "status" ? scope : undefined,
      onDeliveryBudgetEvent: (event) => {
        budgetEvents.push(event);
      },
    });
    await bindThread(harness);
    deliveryBudget.recordRateLimit({
      scope,
      retryAfterMs: 5_000,
      observedAt: now,
    });
    harness.delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "running",
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered).toEqual([]);
    expect(budgetEvents.at(-1)).toMatchObject({
      intentKind: "activity",
      outcome: "dropped",
      reason: "cool-off",
      scope,
    });

    now = 8_001;
    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [],
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered).toEqual([]);
    expect(budgetEvents.at(-1)).toMatchObject({
      intentKind: "activity",
      outcome: "dropped",
      reason: "slow-mode",
      scope,
    });
  });

  it("skips duplicate status renders for backend lifecycle echoes", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    await harness.controller.handleInboundEvent(buildTextEvent("start work"));
    harness.delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "running",
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered).toEqual([]);

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "thread/status/changed",
        params: {
          threadId: "thread-1",
          status: {
            type: "idle",
          },
        },
      },
    } satisfies AgentEvent);
    expect(harness.delivered).toHaveLength(1);

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [],
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered).toHaveLength(1);
  });

  it("stops typing when the backend reports idle without a turn completion event", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    await harness.controller.handleInboundEvent(buildTextEvent("start work"));
    harness.delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "thread/status/changed",
        params: {
          threadId: "thread-1",
          status: {
            type: "idle",
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "idle",
    });
  });

  it("refreshes the status card when a bound thread is renamed", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    harness.delivered.length = 0;

    const renamedNavigation = buildNavigationSnapshot();
    renamedNavigation.threads[0]!.title = "Wood chuck joke";
    renamedNavigation.threads[0]!.titleSource = "explicit";
    harness.getNavigationSnapshot.mockResolvedValueOnce(renamedNavigation);

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "thread/name/updated",
        params: {
          threadId: "thread-1",
          threadName: "Wood chuck joke",
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered).toEqual([
      expect.objectContaining({
        kind: "status",
        text: expect.stringContaining("Binding: Wood chuck joke (codex)"),
      }),
    ]);
  });

  it("does not restart typing from a stale assistant delivery after idle", async () => {
    let now = 1000;
    let resolveAssistantDelivery!: () => void;
    const assistantDelivery = new Promise<void>((resolve) => {
      resolveAssistantDelivery = resolve;
    });
    const delivered: MessagingSurfaceIntent[] = [];
    const harness = await createHarness({
      now: () => now,
      deliver: async (intent) => {
        delivered.push(intent);
        if (intent.kind === "message" && intent.role === "assistant") {
          await assistantDelivery;
        }
        return {
          channel: "telegram",
          deliveredAt: now,
          outcome: intent.kind === "status" && intent.delivery?.pin ? "pinned" : "presented",
          surface: {
            channel: "telegram",
            id: `surface:${intent.id}`,
          },
        };
      },
    });
    await bindThread(harness);
    await harness.controller.handleInboundEvent(buildTextEvent("start work"));
    delivered.length = 0;

    const assistantEvent = harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "agentMessage",
            text: "Done.",
          },
        },
      },
    } satisfies AgentEvent);

    await vi.waitFor(() => {
      expect(delivered).toEqual([
        expect.objectContaining({
          kind: "message",
          role: "assistant",
        }),
      ]);
    });

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "thread/status/changed",
        params: {
          threadId: "thread-1",
          status: {
            type: "idle",
          },
        },
      },
    } satisfies AgentEvent);
    const idleActivityIndex = delivered.findIndex(
      (intent) => intent.kind === "activity" && intent.state === "idle",
    );
    expect(idleActivityIndex).toBeGreaterThanOrEqual(0);

    now += 11_000;
    resolveAssistantDelivery();
    await assistantEvent;

    expect(
      delivered
        .slice(idleActivityIndex + 1)
        .filter((intent) => intent.kind === "activity" && intent.state === "active"),
    ).toEqual([]);
  });

  it("recreates the pinned status surface for /status commands", async () => {
    const harness = await createHarness();
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "bind:codex:thread-1",
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );
    const binding = await harness.store.findActiveBindingForChannel(
      buildCommandEvent("/status").channel,
    );
    const deliveredBeforeStatus = harness.delivered.length;

    await harness.controller.handleInboundEvent(buildCommandEvent("/status"));

    expect(binding?.statusSurface).toBeDefined();
    const statusIntents = harness.delivered.slice(deliveredBeforeStatus);
    expect(statusIntents).toHaveLength(3);
    expect(statusIntents[0]).toMatchObject({
      kind: "status",
      actions: [],
      delivery: {
        mode: "update",
        replaceMarkup: true,
        fallback: "fail",
      },
      targetSurface: binding?.statusSurface,
      text: expect.stringContaining("Project: PwrAgent"),
    });
    expect(statusIntents[1]).toMatchObject({
      kind: "dismiss",
      delivery: {
        mode: "dismiss",
        unpin: true,
      },
      targetSurface: binding?.pinnedStatusSurface,
    });
    expect(statusIntents[2]).toMatchObject({
      kind: "status",
      delivery: {
        mode: "present",
        pin: true,
      },
      targetSurface: undefined,
      text: expect.stringContaining("Project: PwrAgent"),
    });
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/status").channel),
    ).resolves.toMatchObject({
      statusSurface: {
        id: `surface:${statusIntents[2]?.id}`,
      },
    });
  });

  it("detaches a bound conversation, clears status actions, and unpins the status surface", async () => {
    const harness = await createHarness();
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "bind:codex:thread-1",
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );
    const binding = await harness.store.findActiveBindingForChannel(
      buildCommandEvent("/detach").channel,
    );
    harness.delivered.splice(0);

    await harness.controller.handleInboundEvent(buildCommandEvent("/detach"));

    expect(harness.delivered).toHaveLength(3);
    expect(harness.delivered.at(-3)).toMatchObject({
      kind: "status",
      actions: [],
      delivery: {
        mode: "update",
        replaceMarkup: true,
        fallback: "fail",
      },
      targetSurface: binding?.statusSurface,
    });
    expect(harness.delivered.at(-2)).toMatchObject({
      kind: "dismiss",
      delivery: {
        unpin: true,
      },
      targetSurface: binding?.pinnedStatusSurface,
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Thread detached",
      body: "Messages in this conversation will no longer route to PwrAgent.",
    });
    expect(harness.delivered).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          title: "Monitor stopped",
        }),
      ]),
    );
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/detach").channel),
    ).resolves.toBeUndefined();
  });

  it("uses /detach to stop Monitor when no thread is bound", async () => {
    vi.useFakeTimers();
    const harness = await createHarness();
    try {
      await harness.controller.handleInboundEvent(buildCommandEvent("/monitor"));
      const monitorIntent = harness.delivered.at(-1);
      const monitorSurface = monitorIntent?.targetSurface
        ?? (monitorIntent
          ? { channel: "telegram" as const, id: `surface:${monitorIntent.id}` }
          : undefined);
      harness.delivered.splice(0);

      await harness.controller.handleInboundEvent(buildCommandEvent("/detach"));

      expect(harness.delivered).toHaveLength(2);
      expect(harness.delivered.at(-2)).toMatchObject({
        kind: "confirmation",
        title: "Monitor detached",
        actions: [],
        delivery: {
          mode: "update",
          replaceMarkup: true,
          fallback: "fail",
        },
        targetSurface: monitorSurface,
      });
      expect(harness.delivered.at(-1)).toMatchObject({
        kind: "confirmation",
        title: "Monitor detached",
        body: "Recent thread updates will no longer post to this conversation.",
      });
      await expect(
        harness.store.findActiveMonitorSubscriptionForChannel(
          buildCommandEvent("/detach").channel,
        ),
      ).resolves.toMatchObject({
        monitor: {
          enabled: false,
        },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.controller.dispose();
      vi.useRealTimers();
    }
  });

  it("uses one /detach confirmation when both thread and Monitor are attached", async () => {
    vi.useFakeTimers();
    const harness = await createHarness();
    try {
      await bindThread(harness);
      await harness.controller.handleInboundEvent(buildCommandEvent("/monitor"));
      const monitorIntent = harness.delivered.at(-1);
      const monitorSurface = monitorIntent?.targetSurface
        ?? (monitorIntent
          ? { channel: "telegram" as const, id: `surface:${monitorIntent.id}` }
          : undefined);
      harness.delivered.splice(0);

      await harness.controller.handleInboundEvent(buildCommandEvent("/detach"));

      expect(harness.delivered).toHaveLength(4);
      expect(harness.delivered.at(-4)).toMatchObject({
        kind: "confirmation",
        title: "Monitor detached",
        actions: [],
        delivery: {
          mode: "update",
          replaceMarkup: true,
          fallback: "fail",
        },
        targetSurface: monitorSurface,
      });
      expect(harness.delivered.at(-1)).toMatchObject({
        kind: "confirmation",
        title: "Thread and Monitor detached",
        body: "Messages in this conversation will no longer route to PwrAgent, and recent thread updates will no longer post here.",
      });
      expect(harness.delivered).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({
            title: "Monitor stopped",
          }),
        ]),
      );
      await expect(
        harness.store.findActiveBindingForChannel(buildCommandEvent("/detach").channel),
      ).resolves.toBeUndefined();
      await expect(
        harness.store.findActiveMonitorSubscriptionForChannel(
          buildCommandEvent("/detach").channel,
        ),
      ).resolves.toMatchObject({
        monitor: {
          enabled: false,
        },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.controller.dispose();
      vi.useRealTimers();
    }
  });

  it("shows the help menu for unbound text before routing text", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildTextEvent("hello"));

    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "PwrAgent commands",
    });
  });

  it("routes command callbacks from help buttons to command handlers", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "command:resume",
      }),
    );

    expect(harness.getNavigationSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "thread_picker",
    });
  });

  it("does not treat legacy /threads as a resume alias — falls through to the help surface", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/threads"));

    expect(harness.getNavigationSnapshot).not.toHaveBeenCalled();
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "PwrAgent commands",
    });
  });

  it("renders the help surface for an explicit /help command", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/help"));

    expect(harness.getNavigationSnapshot).not.toHaveBeenCalled();
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "PwrAgent commands",
    });
  });

  it("help surface body lists every canonical verb (catalog-derived)", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/help"));

    const last = harness.delivered.at(-1) as { body?: string } | undefined;
    expect(last?.body).toBeDefined();
    expect(last?.body).toContain("/resume");
    expect(last?.body).toContain("/new");
    expect(last?.body).toContain("/status");
    expect(last?.body).toContain("/detach");
    expect(last?.body).toContain("/monitor");
    expect(last?.body).toContain("/help");
    expect(last?.body).not.toContain("`");
    // Both tap and mention styles must be discoverable from the help
    // text — the whole reason we ship a catalog-derived body.
    expect(last?.body).toContain("Send a command or tap a button.");
    expect(last?.body).toContain("@bot new");
  });

  it("help surface renders one button per canonical verb with Resume styled primary", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/help"));

    const last = harness.delivered.at(-1) as
      | { actions?: Array<{ id?: string; label?: string; style?: string }> }
      | undefined;
    expect(last?.actions).toBeDefined();
    // One button per canonical verb. Catalog fits a
    // single page on every reasonable provider profile, so no nav
    // buttons are rendered.
    const ids = (last?.actions ?? []).map((a) => a.id);
    expect(ids).toEqual([
      "command:resume",
      "command:new",
      "command:status",
      "command:detach",
      "command:monitor",
      "command:help",
    ]);
    // Resume retains primary styling — matches the previous
    // single-button shape for users who tap rather than read.
    const resume = last?.actions?.find((a) => a.id === "command:resume");
    expect(resume?.style).toBe("primary");
    const newThread = last?.actions?.find((a) => a.id === "command:new");
    expect(newThread?.style).toBeUndefined();
  });

  it("help surface omits nav buttons when the catalog fits in one page", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/help"));

    const last = harness.delivered.at(-1) as
      | { actions?: Array<{ id?: string }> }
      | undefined;
    const navIds = (last?.actions ?? [])
      .map((a) => a.id ?? "")
      .filter((id) => id.startsWith("help:"));
    // The test capability profile grants well over the catalog count
    // plus the worst-case nav buttons — single page, no navigation
    // needed.
    expect(navIds).toEqual([]);
  });

  it("clicking the Resume button on the help surface dispatches the resume command", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "command:resume",
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "thread_picker",
    });
  });

  it("routes /new to the new-thread project picker", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/new"));

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "project_picker",
      fallbackText: expect.stringContaining("new PwrAgent thread"),
      prompt: expect.stringContaining("Choose a project"),
    });
  });

  it("reports zero create-capable backends before opening the new-thread picker", async () => {
    const harness = await createHarness({
      listBackends: async (): Promise<ListBackendsResponse> => ({
        fetchedAt: 1000,
        backends: [
          buildBackendSummary({
            available: false,
          }),
        ],
      }),
    });

    await harness.controller.handleInboundEvent(buildCommandEvent("/new"));

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "No backends available",
      recoverable: true,
    });
    expect(harness.delivered).not.toContainEqual(
      expect.objectContaining({ kind: "project_picker" }),
    );
  });

  it("lets a pending new-thread session switch providers before creation", async () => {
    const harness = await createHarness({
      listBackends: async (): Promise<ListBackendsResponse> => ({
        fetchedAt: 1000,
        backends: [
          buildBackendSummary({
            kind: "codex",
            label: "Codex",
            launchpadOptions: {
              models: [{ id: "gpt-5.3-codex", label: "GPT-5.3 Codex" }],
              reasoningEfforts: ["low", "medium", "high"],
              supportsFastMode: true,
            },
          }),
          buildBackendSummary({
            kind: "grok",
            label: "Grok",
            launchpadOptions: {
              models: [{ id: "grok-4.20-reasoning", label: "Grok 4.20 Reasoning" }],
              reasoningEfforts: ["low", "medium", "high"],
              supportsFastMode: false,
            },
          }),
        ],
      }),
    });

    await harness.controller.handleInboundEvent(buildCommandEvent("/new"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Ready to start",
      body: expect.stringContaining("Provider: Codex"),
      actions: expect.arrayContaining([
        expect.objectContaining({
          id: "browse:new:backend",
          label: "Provider: Codex",
        }),
      ]),
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "browse:new:backend" }),
    );
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Select provider",
      actions: expect.arrayContaining([
        expect.objectContaining({
          id: "browse:new:set-backend",
          label: "Codex ✓",
          value: { backend: "codex" },
        }),
        expect.objectContaining({
          id: "browse:new:set-backend",
          label: "Grok",
          value: { backend: "grok" },
        }),
      ]),
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:new:set-backend",
        value: { backend: "grok" },
      }),
    );

    const grokReadyIntent = harness.delivered.at(-1);
    expect(grokReadyIntent).toMatchObject({
      kind: "confirmation",
      title: "Ready to start",
      body: expect.stringContaining("Provider: Grok"),
      actions: expect.arrayContaining([
        expect.objectContaining({
          id: "browse:new:backend",
          label: "Provider: Grok",
        }),
      ]),
    });
    expect(grokReadyIntent).toMatchObject({
      actions: expect.not.arrayContaining([
        expect.objectContaining({ id: "browse:new:fast" }),
      ]),
    });
    expect(harness.updateDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "directory:pwragent",
      stickySettingsChanged: true,
      patch: expect.objectContaining({
        backend: "grok",
      }),
    });

    await harness.controller.handleInboundEvent(buildTextEvent("Fix bug with Grok"));

    expect(harness.materializeDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: expect.stringMatching(/^messaging:browse:/),
      launchpad: expect.objectContaining({
        backend: "grok",
        directoryKey: "directory:pwragent",
      }),
    });
    expect(harness.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "grok",
        threadId: "new-thread-1",
      }),
    );
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/new").channel),
    ).resolves.toMatchObject({
      backend: "grok",
      threadId: "new-thread-1",
    });
  });

  it("does not fall back to another provider when the selected backend becomes unavailable before creation", async () => {
    const codexBackend = buildBackendSummary({
      kind: "codex",
      label: "Codex",
    });
    const grokBackend = buildBackendSummary({
      kind: "grok",
      label: "Grok",
      launchpadOptions: {
        models: [{ id: "grok-4.20-reasoning", label: "Grok 4.20 Reasoning" }],
        reasoningEfforts: ["low", "medium", "high"],
        supportsFastMode: false,
      },
    });
    let availableBackends = [codexBackend, grokBackend];
    const harness = await createHarness({
      listBackends: async (): Promise<ListBackendsResponse> => ({
        fetchedAt: 1000,
        backends: availableBackends,
      }),
    });

    await harness.controller.handleInboundEvent(buildCommandEvent("/new"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:new:set-backend",
        value: { backend: "grok" },
      }),
    );
    availableBackends = [codexBackend];

    await harness.controller.handleInboundEvent(buildTextEvent("Fix bug with Grok"));

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Backend unavailable",
      body: expect.stringContaining("selected backend is no longer available"),
      recoverable: true,
    });
    expect(harness.materializeDirectoryLaunchpad).not.toHaveBeenCalled();
    expect(harness.startThread).not.toHaveBeenCalled();
    expect(harness.startTurn).not.toHaveBeenCalled();
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/new").channel),
    ).resolves.toBeUndefined();
  });

  it("updates sticky launchpad defaults when selecting a pending new-thread model", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/new"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "browse:new:model" }),
    );
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:new:set-model",
        value: {
          model: "gpt-5.3-codex",
        },
      }),
    );

    expect(harness.updateDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "directory:pwragent",
      stickySettingsChanged: true,
      patch: {
        model: "gpt-5.3-codex",
      },
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Ready to start",
      body: expect.stringContaining("Model: gpt-5.3-codex"),
    });
  });

  it("clicking the New button on the help surface dispatches the new command", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "command:new",
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "project_picker",
      fallbackText: expect.stringContaining("new PwrAgent thread"),
    });
  });

  it("clicking the Detach button on the help surface dispatches the detach command", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "command:detach",
      }),
    );

    // No active binding for this channel, so detach is a no-op
    // confirmation rather than a real revoke. The point is the
    // routing reaches `handleCommand("detach")`, not that the
    // detach itself succeeds.
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
    });
  });

  it("clicking the Monitor button on the help surface dispatches the monitor command", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "command:monitor",
      }),
    );

    expect(harness.getNavigationSnapshot).toHaveBeenCalledWith({
      backend: "all",
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Monitor: Recent threads"),
    });
  });

  it("clicking the help-page Cancel button replaces the surface with a dismissal", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "help:cancel",
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Help dismissed",
      actions: [],
      delivery: {
        mode: "update",
        replaceMarkup: true,
      },
    });
  });

  it("clicking help:page:next re-renders the help surface (passes value.pageIndex through)", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "help:page:next",
        value: { pageIndex: 1 },
      }),
    );

    // Today's catalog only paginates to a single page, so the
    // re-render clamps back to page 0 — but the surface is still
    // a help surface targeted at the existing post (update mode).
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "PwrAgent commands",
      delivery: {
        mode: "update",
        replaceMarkup: true,
      },
    });
  });

  it("starts Monitor in an unbound conversation", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/monitor"));

    expect(harness.getNavigationSnapshot).toHaveBeenCalledWith({
      backend: "all",
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Monitor: Recent threads"),
      actions: expect.arrayContaining([
        expect.objectContaining({ id: "monitor:stop" }),
      ]),
    });
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/monitor").channel),
    ).resolves.toBeUndefined();
    await expect(
      harness.store.findActiveMonitorSubscriptionForChannel(
        buildCommandEvent("/monitor").channel,
      ),
    ).resolves.toMatchObject({
      monitor: {
        enabled: true,
        intervalMs: 60_000,
        lastRenderedAt: 1000,
        pinnedThreadLimit: 5,
        recentThreadLimit: 5,
      },
      monitorSurface: {
        id: expect.stringContaining("surface:"),
      },
    });
  });

  it("preserves command routing state for the initial Monitor render", async () => {
    const harness = await createHarness();
    const event = {
      ...buildCommandEvent("/monitor"),
      channel: {
        channel: "discord",
        conversation: {
          id: "channel-1",
          kind: "channel",
          parentId: "guild-1",
        },
      },
      routingState: {
        opaque: {
          applicationId: "app-1",
          interactionToken: "interaction-token-1",
        },
      },
    } satisfies MessagingInboundEvent & { kind: "command" };

    await harness.controller.handleInboundEvent(event);

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      audit: expect.objectContaining({
        channel: event.channel,
      }),
      targetSurface: {
        channel: "discord",
        id: event.id,
        state: event.routingState,
      },
    });
  });

  it("starts Monitor for a bound conversation without changing the thread binding", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    const binding = await harness.store.findActiveBindingForChannel(
      buildCommandEvent("/monitor").channel,
    );
    harness.getNavigationSnapshot.mockClear();
    harness.readThreadStatus.mockResolvedValue("active");
    harness.delivered.splice(0);

    await harness.controller.handleInboundEvent(buildCommandEvent("/MONITOR"));

    expect(harness.getNavigationSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.readThreadStatus).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      status: "working",
      text: expect.stringContaining("Monitor: Recent threads"),
      actions: expect.arrayContaining([
        expect.objectContaining({
          id: "monitor:stop",
          fallbackText: "monitor stop",
        }),
      ]),
    });
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/monitor").channel),
    ).resolves.toEqual(binding);
    await expect(
      harness.store.findActiveMonitorSubscriptionForChannel(
        buildCommandEvent("/monitor").channel,
      ),
    ).resolves.toMatchObject({
      monitor: {
        enabled: true,
        intervalMs: 60_000,
        lastRenderedAt: 1000,
        pinnedThreadLimit: 5,
        recentThreadLimit: 5,
      },
      monitorSurface: {
        id: expect.stringContaining("surface:"),
      },
    });
  });

  it("configures Monitor pinned and recent counts from commands and buttons", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/monitor pins 10"));

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Pins: 10 | Recent: 5"),
    });
    await expect(
      harness.store.findActiveMonitorSubscriptionForChannel(
        buildCommandEvent("/monitor").channel,
      ),
    ).resolves.toMatchObject({
      monitor: {
        pinnedThreadLimit: 10,
        recentThreadLimit: 5,
      },
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "monitor:recent" }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Pins: 10 | Recent: 10"),
    });
    await expect(
      harness.store.findActiveMonitorSubscriptionForChannel(
        buildCommandEvent("/monitor").channel,
      ),
    ).resolves.toMatchObject({
      monitor: {
        pinnedThreadLimit: 10,
        recentThreadLimit: 10,
      },
    });

    await harness.controller.handleInboundEvent(buildCommandEvent("/monitor recent 0"));

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Pins: 10 | Recent: 0"),
    });
  });

  it("configures Monitor interval from commands and buttons", async () => {
    vi.useFakeTimers();
    const harness = await createHarness();
    try {
      await harness.controller.handleInboundEvent(buildCommandEvent("/monitor interval 30s"));

      expect(harness.delivered.at(-1)).toMatchObject({
        kind: "status",
        text: expect.stringContaining("Interval: 30 sec"),
      });
      await expect(
        harness.store.findActiveMonitorSubscriptionForChannel(
          buildCommandEvent("/monitor").channel,
        ),
      ).resolves.toMatchObject({
        monitor: {
          intervalMs: 30_000,
        },
      });
      expect(vi.getTimerCount()).toBe(1);

      await harness.controller.handleInboundEvent(
        buildCallbackEvent({ actionId: "monitor:interval" }),
      );

      expect(harness.delivered.at(-1)).toMatchObject({
        kind: "status",
        text: expect.stringContaining("Interval: 1 min"),
      });
      await expect(
        harness.store.findActiveMonitorSubscriptionForChannel(
          buildCommandEvent("/monitor").channel,
        ),
      ).resolves.toMatchObject({
        monitor: {
          intervalMs: 60_000,
        },
      });
      expect(vi.getTimerCount()).toBe(1);

      await harness.controller.handleInboundEvent(buildCommandEvent("/monitor every 5m"));

      expect(harness.delivered.at(-1)).toMatchObject({
        kind: "status",
        text: expect.stringContaining("Interval: 5 min"),
      });
    } finally {
      harness.controller.dispose();
      vi.useRealTimers();
    }
  });

  it("configures Monitor status detail lines and response snippets", async () => {
    const harness = await createHarness({
      readThreadLastAssistantMessage: async (request) =>
        `${request.threadId} latest assistant response for monitor display.`,
    });

    await harness.controller.handleInboundEvent(buildCommandEvent("/monitor status line"));

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Status: line | Snippet: off"),
    });
    expect(readDeliveredStatusText(harness.delivered.at(-1))).toContain(
      "1. Thread one (codex)\n  Status: idle - updated",
    );
    expect(harness.readThreadLastAssistantMessage).not.toHaveBeenCalled();

    await harness.controller.handleInboundEvent(buildCommandEvent("/monitor snippet on"));

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Status: line | Snippet: on"),
    });
    expect(readDeliveredStatusText(harness.delivered.at(-1))).toContain(
      "  Response: thread-1 latest assistant response for monitor display.",
    );
    expect(harness.readThreadLastAssistantMessage).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    await expect(
      harness.store.findActiveMonitorSubscriptionForChannel(
        buildCommandEvent("/monitor").channel,
      ),
    ).resolves.toMatchObject({
      monitor: {
        showLastResponseSnippet: true,
        showStatusLine: true,
      },
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "monitor:status" }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Status: inline | Snippet: on"),
    });
  });

  it("does not create duplicate Monitor timers for repeated starts", async () => {
    vi.useFakeTimers();
    const harness = await createHarness();
    try {
      await bindThread(harness);
      harness.getNavigationSnapshot.mockClear();

      await harness.controller.handleInboundEvent(buildCommandEvent("/monitor"));
      await harness.controller.handleInboundEvent(buildCommandEvent("/monitor"));

      expect(harness.getNavigationSnapshot).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      harness.controller.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps Monitor scheduled when the initial render fails", async () => {
    vi.useFakeTimers();
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const harness = await createHarness({ logger });
    try {
      await bindThread(harness);
      harness.getNavigationSnapshot.mockRejectedValueOnce(
        new Error("navigation unavailable"),
      );
      harness.delivered.splice(0);

      await harness.controller.handleInboundEvent(buildCommandEvent("/monitor"));

      expect(logger.debug).toHaveBeenCalledWith(
        "messaging channel monitor initial render failed",
        expect.objectContaining({
          error: "navigation unavailable",
          subscriptionId: expect.stringContaining("monitor:"),
        }),
      );
      expect(harness.delivered).toEqual([]);
      await expect(
        harness.store.findActiveMonitorSubscriptionForChannel(
          buildCommandEvent("/monitor").channel,
        ),
      ).resolves.toMatchObject({
        monitor: {
          enabled: true,
        },
      });
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(60_001);
      await vi.waitFor(() => {
        expect(harness.delivered.at(-1)).toMatchObject({
          kind: "status",
          text: expect.stringContaining("Monitor: Recent threads"),
        });
      });
    } finally {
      harness.controller.dispose();
      vi.useRealTimers();
    }
  });

  it("revokes the channel Monitor subscription after permanent delivery failure", async () => {
    vi.useFakeTimers();
    let failDelivery = false;
    const harness = await createHarness({
      deliver: async (intent) => {
        if (failDelivery) {
          return {
            channel: "telegram",
            deliveredAt: 1000,
            outcome: "failed",
            errorMessage: "Bad Request: chat not found",
          };
        }
        return {
          channel: "telegram",
          deliveredAt: 1000,
          outcome: "presented",
          surface: {
            channel: "telegram",
            id: `surface:${intent.id}`,
          },
        };
      },
    });
    try {
      await bindThread(harness);
      const binding = await harness.store.findActiveBindingForChannel(
        buildCommandEvent("/monitor").channel,
      );
      if (!binding) {
        throw new Error("binding missing");
      }

      failDelivery = true;
      await harness.controller.handleInboundEvent(buildCommandEvent("/monitor"));

      await expect(harness.store.getBinding(binding.id)).resolves.toMatchObject({
        id: binding.id,
      });
      await expect(
        harness.store.findActiveMonitorSubscriptionForChannel(
          buildCommandEvent("/monitor").channel,
        ),
      ).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.controller.dispose();
      vi.useRealTimers();
    }
  });

  it("stops Monitor without detaching the binding and cancels the next tick", async () => {
    vi.useFakeTimers();
    const harness = await createHarness();
    try {
      await bindThread(harness);
      await harness.controller.handleInboundEvent(buildCommandEvent("/monitor"));
      harness.getNavigationSnapshot.mockClear();
      harness.delivered.splice(0);

      await harness.controller.handleInboundEvent(buildCommandEvent("/monitor stop"));

      expect(harness.delivered.at(-1)).toMatchObject({
        kind: "confirmation",
        title: "Monitor stopped",
        delivery: {
          mode: "update",
        },
      });
      const binding = await harness.store.findActiveBindingForChannel(
        buildCommandEvent("/monitor").channel,
      );
      const subscription = await harness.store.findActiveMonitorSubscriptionForChannel(
        buildCommandEvent("/monitor").channel,
      );
      expect(subscription).toMatchObject({
        monitor: {
          enabled: false,
        },
      });
      expect(binding?.revokedAt).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.controller.dispose();
      vi.useRealTimers();
    }
  });

  it("rehydrates enabled Monitor bindings on controller startup", async () => {
    vi.useFakeTimers();
    const harness = await createHarness();
    try {
      await bindThread(harness);
      const binding = await harness.store.findActiveBindingForChannel(
        buildCommandEvent("/resume").channel,
      );
      if (!binding) {
        throw new Error("binding missing");
      }
      await harness.store.upsertBinding({
        ...binding,
        monitor: {
          enabled: true,
          intervalMs: 1,
          updatedAt: 1000,
        },
        updatedAt: 1000,
      });
      harness.getNavigationSnapshot.mockClear();

      await harness.controller.startMonitoringForEnabledBindings();

      expect(harness.listBackends).toHaveBeenCalled();
      expect(harness.getNavigationSnapshot).toHaveBeenCalledWith({
        backend: "all",
      });
      expect(harness.delivered.at(-1)).toMatchObject({
        kind: "status",
        text: expect.stringContaining("Monitor: Recent threads"),
      });
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      harness.controller.dispose();
      vi.useRealTimers();
    }
  });

  it("renders enabled channel Monitor subscriptions immediately on controller startup", async () => {
    vi.useFakeTimers();
    const harness = await createHarness({ channel: "telegram" });
    try {
      await harness.store.upsertMonitorSubscription({
        id: "monitor:telegram:dm::chat-1",
        channel: buildCommandEvent("/monitor").channel,
        authorizedActorIds: ["user-1"],
        createdAt: 1000,
        updatedAt: 1000,
        monitor: {
          enabled: true,
          intervalMs: 60_000,
          updatedAt: 1000,
        },
      });
      harness.getNavigationSnapshot.mockClear();

      await harness.controller.startMonitoringForEnabledBindings();

      expect(harness.getNavigationSnapshot).toHaveBeenCalledWith({
        backend: "all",
      });
      expect(harness.delivered.at(-1)).toMatchObject({
        kind: "status",
        text: expect.stringContaining("Monitor: Recent threads"),
      });
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      harness.controller.dispose();
      vi.useRealTimers();
    }
  });

  it("updates the browse surface and removes actions when cancelling resume", async () => {
    const harness = await createHarness();
    await harness.controller.handleInboundEvent(buildCommandEvent("/resume"));

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:cancel",
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Resume cancelled",
      actions: [],
      delivery: {
        mode: "update",
        replaceMarkup: true,
      },
      targetSurface: expect.objectContaining({
        id: expect.stringContaining("surface:"),
      }),
    });
  });

  it("rejects unauthorized actors without revealing thread data", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(
      buildCommandEvent("/resume", {
        platformUserId: "other-user",
        username: "Mutable Username",
      }),
    );

    expect(harness.getNavigationSnapshot).not.toHaveBeenCalled();
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Not authorized",
    });
  });

  it("does not forward inbound media into agent turns", async () => {
    const harness = await createHarness();
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "bind:codex:thread-1",
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );

    await harness.controller.handleInboundEvent({
      ...buildTextEvent(""),
      id: "event-media",
      kind: "media",
      media: {
        type: "file",
        name: "voice.m4a",
      },
      attachments: [
        {
          id: "voice-1",
          kind: "audio",
          name: "voice.m4a",
          disposition: "unsupported",
          reason: "audio attachments are not supported",
        },
      ],
      disposition: "unsupported",
    });

    expect(harness.startTurn).not.toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.arrayContaining([expect.objectContaining({ type: "file" })]),
      }),
    );
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Attachment not supported",
    });
  });

  it("routes supported inbound text attachments into bound thread turns", async () => {
    const harness = await createHarness({
      downloadAttachment: vi.fn(async ({ attachment }) => {
        const data = new TextEncoder().encode("first line\nsecond line");
        return {
          data,
          fileName: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: data.byteLength,
        };
      }),
    });
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "bind:codex:thread-1",
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );

    await harness.controller.handleInboundEvent({
      ...buildTextEvent("Please inspect this"),
      id: "event-media",
      kind: "media",
      text: "Please inspect this",
      attachments: [
        {
          id: "file-1",
          kind: "file",
          name: "streaming-logs.txt",
          disposition: "available",
          mimeType: "text/plain",
          sizeBytes: 22,
        },
      ],
      disposition: "available",
    });

    expect(harness.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          {
            type: "text",
            text: expect.stringContaining("Please inspect this\n\nAttached file: `streaming-logs.txt`"),
          },
        ],
      }),
    );
  });

  it("debounces split text messages into one agent turn", async () => {
    vi.useFakeTimers();
    const harness = await createHarness({ inputDebounceMs: 500 });
    await bindThread(harness);
    harness.delivered.length = 0;

    await harness.controller.handleInboundEvent(buildTextEvent("Please review this code block:"));
    await vi.advanceTimersByTimeAsync(250);
    await harness.controller.handleInboundEvent(buildTextEvent("```ts\nconst answer = 42;\n```"));

    expect(harness.startTurn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    expect(harness.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          {
            type: "text",
            text: "Please review this code block:",
          },
          {
            type: "text",
            text: "```ts\nconst answer = 42;\n```",
          },
        ],
      }),
    );
  });

  it("debounces text file attachments with adjacent text", async () => {
    vi.useFakeTimers();
    const harness = await createHarness({
      inputDebounceMs: 500,
      downloadAttachment: vi.fn(async ({ attachment }) => {
        const data = new TextEncoder().encode("alpha\nbeta");
        return {
          data,
          fileName: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: data.byteLength,
        };
      }),
    });
    await bindThread(harness);

    await harness.controller.handleInboundEvent({
      ...buildTextEvent("Here is the log"),
      id: "event-media",
      kind: "media",
      text: "Here is the log",
      attachments: [
        {
          id: "file-1",
          kind: "file",
          name: "debug.log",
          disposition: "available",
          mimeType: "text/plain",
          sizeBytes: 10,
        },
      ],
      disposition: "available",
    });
    await harness.controller.handleInboundEvent(buildTextEvent("Please summarize it"));

    expect(harness.startTurn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(harness.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          {
            type: "text",
            text: expect.stringContaining("Attached file: `debug.log`"),
          },
          {
            type: "text",
            text: "Please summarize it",
          },
        ],
      }),
    );
  });

  it("debounces image attachments with adjacent text", async () => {
    vi.useFakeTimers();
    const harness = await createHarness({
      inputDebounceMs: 500,
      downloadAttachment: vi.fn(async ({ attachment }) => ({
        data: new Uint8Array([137, 80, 78, 71]),
        fileName: attachment.name,
        mimeType: "image/png",
        sizeBytes: 4,
      })),
    });
    await bindThread(harness);

    await harness.controller.handleInboundEvent({
      ...buildTextEvent("Screenshot attached"),
      id: "event-image",
      kind: "media",
      text: "Screenshot attached",
      attachments: [
        {
          id: "image-1",
          kind: "image",
          name: "screen.png",
          disposition: "available",
          mimeType: "image/png",
          sizeBytes: 4,
        },
      ],
      disposition: "available",
    });
    await harness.controller.handleInboundEvent(buildTextEvent("Look at the sidebar"));

    await vi.advanceTimersByTimeAsync(500);

    expect(harness.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          {
            type: "text",
            text: "Screenshot attached",
          },
          {
            type: "image",
            url: "data:image/png;base64,AQID",
          },
          {
            type: "text",
            text: "Look at the sidebar",
          },
        ],
      }),
    );
  });

  it("queues follow-up text while a turn is active and starts it after completion", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(buildTextEvent("make me a dinner reservation"));
    await harness.controller.handleInboundEvent(buildTextEvent("Chinese sounds good"));

    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    const queuedNotice = harness.delivered
      .filter((intent) => intent.kind === "confirmation" && intent.title === "Message queued")
      .at(-1);
    expect(queuedNotice).toMatchObject({
      kind: "confirmation",
      body: expect.stringContaining("> Chinese sounds good"),
    });
    const queuedActions =
      queuedNotice && "actions" in queuedNotice && Array.isArray(queuedNotice.actions)
        ? queuedNotice.actions
        : [];
    expect(
      queuedActions.some((action) => action.id.startsWith("queued-turn:cancel:")),
    ).toBe(true);

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [],
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.startTurn).toHaveBeenCalledTimes(2);
    expect(harness.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: [
          {
            type: "text",
            text: "Chinese sounds good",
          },
        ],
      }),
    );
    expect(
      harness.delivered.find(
        (intent) =>
          intent.kind === "confirmation" &&
          intent.body === "Queued message sent as the next turn.",
      ),
    ).toMatchObject({
      kind: "confirmation",
      body: "Queued message sent as the next turn.",
      delivery: {
        mode: "update",
        replaceMarkup: true,
      },
    });
  });

  it("retains queued follow-up input when promotion fails", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(buildTextEvent("start the task"));
    await harness.controller.handleInboundEvent(buildTextEvent("also check the logs"));

    const queuedNotice = harness.delivered
      .filter((intent) => intent.kind === "confirmation" && intent.title === "Message queued")
      .at(-1);
    if (!queuedNotice || !("actions" in queuedNotice)) {
      throw new Error("Queued notice was not delivered");
    }
    const cancelAction = Array.isArray(queuedNotice.actions)
      ? queuedNotice.actions.find((action) =>
          action.id.startsWith("queued-turn:cancel:"),
        )
      : undefined;
    expect(cancelAction).toBeDefined();

    harness.startTurn.mockRejectedValueOnce(new Error("provider unavailable"));

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [],
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.startTurn).toHaveBeenCalledTimes(2);
    expect(harness.delivered).toContainEqual(
      expect.objectContaining({
        kind: "error",
        title: "Turn could not start",
        body: "provider unavailable",
      }),
    );
    expect(harness.delivered).not.toContainEqual(
      expect.objectContaining({
        kind: "confirmation",
        body: "Queued message sent as the next turn.",
      }),
    );

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: cancelAction!.id,
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      body: "Queued message cancelled.",
      delivery: {
        mode: "update",
        replaceMarkup: true,
      },
    });
  });

  it("queues input when backend admission rejects a concurrent turn start", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    harness.startTurn.mockRejectedValueOnce(
      new Error("thread already has an active turn in progress"),
    );

    await harness.controller.handleInboundEvent(buildTextEvent("second turn"));

    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Message queued",
      body: expect.stringContaining("> second turn"),
    });
  });

  it("clears a staged skill when backend concurrent-start rejection queues the prefixed request", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:skills" }),
    );
    const planChoice = findChoice(harness.delivered.at(-1), "skills:select");
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "skills:select",
        value: planChoice.value,
      }),
    );
    harness.startTurn.mockRejectedValueOnce(
      new Error("thread already has an active turn in progress"),
    );

    await harness.controller.handleInboundEvent(buildTextEvent("second turn"));

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.not.stringContaining("Pending skill: $ce:plan"),
    });
    const queuedNotice = harness.delivered
      .filter((intent) => intent.kind === "confirmation" && intent.title === "Message queued")
      .at(-1);
    expect(queuedNotice).toMatchObject({
      body: expect.stringContaining("> Use [$ce:plan](/skills/ce-plan/SKILL.md)"),
    });
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/status").channel),
    ).resolves.not.toHaveProperty("pendingSkillSelection");
  });

  it("does not restore a consumed skill when a queued turn starts later", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(buildTextEvent("first turn"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:skills" }),
    );
    const planChoice = findChoice(harness.delivered.at(-1), "skills:select");
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "skills:select",
        value: planChoice.value,
      }),
    );

    await harness.controller.handleInboundEvent(buildTextEvent("second turn"));

    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/status").channel),
    ).resolves.not.toHaveProperty("pendingSkillSelection");

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [],
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.startTurn).toHaveBeenCalledTimes(2);
    expect(harness.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: [
          {
            type: "text",
            text: "Use [$ce:plan](/skills/ce-plan/SKILL.md)",
          },
          {
            type: "text",
            text: "second turn",
          },
        ],
      }),
    );
    const latestStatus = harness.delivered
      .filter((intent) => intent.kind === "status")
      .at(-1);
    expect(latestStatus).toMatchObject({
      kind: "status",
      text: expect.not.stringContaining("Pending skill: $ce:plan"),
    });
  });

  it("clears starting state when navigation lookup fails before retrying", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    harness.getNavigationSnapshot.mockRejectedValueOnce(new Error("navigation unavailable"));

    await harness.controller.handleInboundEvent(buildTextEvent("first turn"));

    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Turn could not start",
      body: "navigation unavailable",
    });

    await harness.controller.handleInboundEvent(buildTextEvent("retry turn"));

    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    expect(harness.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: [
          {
            type: "text",
            text: "retry turn",
          },
        ],
      }),
    );
  });

  it("steers queued follow-ups into the active turn and removes queued actions", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(buildTextEvent("start the task"));
    await harness.controller.handleInboundEvent(buildTextEvent("also check the logs"));
    const queuedNotice = harness.delivered
      .filter((intent) => intent.kind === "confirmation" && intent.title === "Message queued")
      .at(-1);
    if (!queuedNotice || !("actions" in queuedNotice)) {
      throw new Error("Queued notice was not delivered");
    }
    const queuedActions = Array.isArray(queuedNotice.actions)
      ? queuedNotice.actions
      : [];
    const steerAction = queuedActions.find((action) =>
      action.id.startsWith("queued-turn:steer:"),
    );
    expect(steerAction?.disabled).toBe(false);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: steerAction!.id,
      }),
    );

    expect(harness.steerTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [
        {
          type: "text",
          text: "also check the logs",
        },
      ],
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      body: "Queued message was sent as a steering message.",
      actions: [],
      delivery: {
        mode: "update",
        replaceMarkup: true,
      },
    });

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [],
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.startTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps queued follow-ups available when backend steering is rejected", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(buildTextEvent("start the task"));
    await harness.controller.handleInboundEvent(buildTextEvent("also check the logs"));
    const queuedNotice = harness.delivered
      .filter((intent) => intent.kind === "confirmation" && intent.title === "Message queued")
      .at(-1);
    if (!queuedNotice || !("actions" in queuedNotice)) {
      throw new Error("Queued notice was not delivered");
    }
    const queuedActions = Array.isArray(queuedNotice.actions)
      ? queuedNotice.actions
      : [];
    const steerAction = queuedActions.find((action) =>
      action.id.startsWith("queued-turn:steer:"),
    );
    const cancelAction = queuedActions.find((action) =>
      action.id.startsWith("queued-turn:cancel:"),
    );
    expect(steerAction).toBeDefined();
    expect(cancelAction).toBeDefined();

    harness.steerTurn.mockRejectedValueOnce(new Error("no active turn to steer"));

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: steerAction!.id,
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Steer failed",
      body: expect.stringContaining("The message is still queued."),
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: cancelAction!.id,
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      body: "Queued message cancelled.",
      delivery: {
        mode: "update",
        replaceMarkup: true,
      },
    });
  });

  it("routes completed assistant output to active thread bindings", async () => {
    const harness = await createHarness();
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "bind:codex:thread-1",
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [
              {
                type: "text",
                text: "Done.\n\n```ts\nexpect(true).toBe(true)\n```",
              },
            ],
          },
        },
      },
    } satisfies AgentEvent);

    expect([...harness.delivered].reverse().find((intent) => intent.kind === "message"))
      .toMatchObject({
        kind: "message",
        role: "assistant",
        parts: [
          expect.objectContaining({
            markdown: "markdown",
          }),
        ],
      });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "idle",
    });
  });

  it("routes assistant item text without completing the active turn", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    await harness.controller.handleInboundEvent(buildTextEvent("who are you"));
    harness.delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "agentMessage",
            text: "I am Codex.",
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "message",
      role: "assistant",
      parts: [
        expect.objectContaining({
          text: "I am Codex.",
        }),
      ],
    });
    const binding = await harness.store.findActiveBindingForChannel(
      buildTextEvent("who are you").channel,
    );
    expect(binding).not.toHaveProperty("activeTurn");
  });

  it("coalesces assistant stream deltas and flushes the final turn text", async () => {
    let now = 1000;
    const harness = await createHarness({
      now: () => now,
    });
    await bindThread(harness);
    harness.delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "Hello",
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered).toEqual([
      expect.objectContaining({
        kind: "stream_update",
        markdown: "plain",
        text: "Hello",
        stream: expect.objectContaining({
          isFinal: false,
          itemId: "item-1",
          sequence: 1,
          turnId: "turn-1",
        }),
      }),
    ]);
    const firstStream = harness.delivered[0];
    if (firstStream?.kind !== "stream_update") {
      throw new Error("expected first stream update");
    }

    now += 500;
    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-2",
          delta: " world",
        },
      },
    } satisfies AgentEvent);
    expect(harness.delivered).toHaveLength(1);

    now += 600;
    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: ".",
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered.at(-1)).toMatchObject({
      delivery: {
        mode: "update",
        fallback: "fail",
      },
      kind: "stream_update",
      targetSurface: {
        id: `surface:${firstStream.id}`,
      },
      text: "Hello world.",
      stream: {
        isFinal: false,
        key: firstStream.stream.key,
        sequence: 3,
      },
    });

    now += 100;
    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [
              {
                type: "text",
                text: "Hello world.\n\nFinal answer.",
              },
            ],
          },
        },
      },
    } satisfies AgentEvent);

    const streamUpdates = harness.delivered.filter(
      (intent) => intent.kind === "stream_update",
    );
    const previousStream = streamUpdates.at(-2);
    if (!previousStream) {
      throw new Error("expected previous stream update");
    }
    expect(streamUpdates.at(-1)).toMatchObject({
      delivery: {
        mode: "update",
        fallback: "fail",
      },
      kind: "stream_update",
      markdown: "markdown",
      targetSurface: {
        id: `surface:${previousStream.id}`,
      },
      text: "Hello world.\n\nFinal answer.",
      stream: {
        isFinal: true,
        key: firstStream.stream.key,
        sequence: 4,
      },
    });
    expect(harness.delivered.filter((intent) => intent.kind === "message")).toEqual([]);
  });

  it("falls back with a final assistant message per binding", async () => {
    const delivered: MessagingSurfaceIntent[] = [];
    const harness = await createHarness({
      deliver: async (intent) => {
        delivered.push(intent);
        if (
          intent.kind === "stream_update" &&
          intent.stream.isFinal &&
          intent.bindingId === "binding-two"
        ) {
          return {
            channel: "telegram" as const,
            deliveredAt: 1000,
            outcome: "discarded" as const,
          };
        }
        return {
          channel: "telegram" as const,
          deliveredAt: 1000,
          outcome: intent.kind === "status" && intent.delivery?.pin
            ? "pinned" as const
            : "presented" as const,
          surface: {
            channel: "telegram" as const,
            id: `surface:${intent.id}`,
          },
        };
      },
    });
    await bindThread(harness);
    const firstBinding = await harness.store.findActiveBindingForChannel(
      buildCommandEvent("/resume").channel,
    );
    if (!firstBinding) {
      throw new Error("expected first binding");
    }
    await harness.store.upsertBinding({
      ...firstBinding,
      id: "binding-two",
      channel: {
        channel: "telegram",
        conversation: {
          id: "topic-2",
          kind: "topic",
          parentId: "supergroup-1",
        },
      },
      createdAt: 1000,
      updatedAt: 1000,
    });

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "Hello",
        },
      },
    } satisfies AgentEvent);
    delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [{ type: "text", text: "Hello final." }],
          },
        },
      },
    } satisfies AgentEvent);

    expect(
      delivered.filter(
        (intent) => intent.kind === "stream_update" && intent.stream.isFinal,
      ),
    ).toHaveLength(2);
    expect(delivered).toContainEqual(
      expect.objectContaining({
        bindingId: "binding-two",
        kind: "message",
        role: "assistant",
      }),
    );
  });

  it("rechecks budget admission after a provider rate-limit rejection", async () => {
    let now = 1000;
    let rejectNextStream = false;
    const scope: MessagingDeliveryScope = {
      platform: "telegram",
      id: "telegram:dm:chat-1",
      kind: "dm",
      budget: { limit: 10, intervalMs: 60_000, reserved: 1 },
    };
    const attempts: MessagingSurfaceIntent[] = [];
    const harness = await createHarness({
      now: () => now,
      deliveryBudget: new MessagingDeliveryBudget({ now: () => now }),
      deliver: async (intent) => {
        attempts.push(intent);
        if (rejectNextStream && intent.kind === "stream_update") {
          return {
            channel: "telegram" as const,
            deliveredAt: now,
            errorMessage: "Too Many Requests",
            outcome: "failed" as const,
            rateLimit: {
              scope,
              retryAfterMs: 5_000,
              observedAt: now,
              message: "Too Many Requests",
              retryable: true,
            },
          };
        }
        return {
          channel: "telegram" as const,
          deliveredAt: now,
          outcome: intent.kind === "status" && intent.delivery?.pin
            ? "pinned" as const
            : "presented" as const,
          surface: {
            channel: "telegram" as const,
            id: `surface:${intent.id}`,
          },
        };
      },
    });
    await bindThread(harness);
    const deliveriesBefore = Object.keys((await harness.store.readSnapshot()).deliveries).length;
    attempts.length = 0;
    rejectNextStream = true;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "Hello",
        },
      },
    } satisfies AgentEvent);

    expect(attempts).toEqual([
      expect.objectContaining({
        kind: "stream_update",
        text: "Hello",
      }),
    ]);
    expect(Object.keys((await harness.store.readSnapshot()).deliveries)).toHaveLength(
      deliveriesBefore,
    );
  });

  it("does not replay non-retryable provider rate-limit failures", async () => {
    let now = 1000;
    let rejectNextStream = false;
    const scope: MessagingDeliveryScope = {
      platform: "telegram",
      id: "telegram:dm:chat-1",
      kind: "dm",
      budget: { limit: 10, intervalMs: 60_000, reserved: 1 },
    };
    const attempts: MessagingSurfaceIntent[] = [];
    const harness = await createHarness({
      now: () => now,
      deliveryBudget: new MessagingDeliveryBudget({ now: () => now }),
      deliver: async (intent) => {
        attempts.push(intent);
        if (rejectNextStream && intent.kind === "stream_update") {
          return {
            channel: "telegram" as const,
            deliveredAt: now,
            errorMessage: "Too Many Requests after partial send",
            outcome: "failed" as const,
            rateLimit: {
              scope,
              retryAfterMs: 5_000,
              observedAt: now,
              message: "Too Many Requests after partial send",
              retryable: false,
            },
          };
        }
        return {
          channel: "telegram" as const,
          deliveredAt: now,
          outcome: intent.kind === "status" && intent.delivery?.pin
            ? "pinned" as const
            : "presented" as const,
          surface: {
            channel: "telegram" as const,
            id: `surface:${intent.id}`,
          },
        };
      },
    });
    await bindThread(harness);
    const deliveriesBefore = Object.keys((await harness.store.readSnapshot()).deliveries).length;
    attempts.length = 0;
    rejectNextStream = true;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "Hello",
        },
      },
    } satisfies AgentEvent);

    expect(attempts).toHaveLength(1);
    const deliveries = Object.values((await harness.store.readSnapshot()).deliveries);
    expect(deliveries).toHaveLength(deliveriesBefore + 1);
    expect(deliveries.at(-1)).toMatchObject({
      outcome: "failed",
      rateLimit: {
        retryable: false,
      },
    });
  });

  it("reports budget deferrals before holding final stream updates", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const scope: MessagingDeliveryScope = {
      platform: "telegram",
      id: "telegram:group:chat-1",
      kind: "group",
      budget: { limit: 1, intervalMs: 60_000, reserved: 0 },
    };
    const budgetEvents: Parameters<
      NonNullable<MessagingControllerOptions["onDeliveryBudgetEvent"]>
    >[0][] = [];
    const onDeliveryBudgetEvent = vi.fn(
      (event: Parameters<
        NonNullable<MessagingControllerOptions["onDeliveryBudgetEvent"]>
      >[0]) => {
        budgetEvents.push(event);
      },
    );
    const harness = await createHarness({
      channel: "telegram",
      now: () => now,
      deliveryBudget: new MessagingDeliveryBudget({ now: () => now }),
      resolveDeliveryScope: (intent) =>
        intent.kind === "stream_update" ? scope : undefined,
      onDeliveryBudgetEvent,
    });
    await bindThread(harness);
    harness.delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "Hello",
        },
      },
    } satisfies AgentEvent);

    const finalDelivery = harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [{ type: "text", text: "Hello final." }],
          },
        },
      },
    } satisfies AgentEvent);
    await vi.waitFor(() => {
      expect(onDeliveryBudgetEvent).toHaveBeenCalledTimes(1);
    });
    expect(budgetEvents).toEqual([
      expect.objectContaining({
        intentKind: "stream_update",
        outcome: "deferred",
        priority: "final_turn",
        reason: "budget-exhausted",
        retryAt: 61_000,
        scope,
      }),
    ]);
    expect(
      harness.delivered.filter(
        (intent) => intent.kind === "stream_update" && intent.stream.isFinal,
      ),
    ).toEqual([]);

    now = 61_001;
    await vi.advanceTimersByTimeAsync(60_001);
    await finalDelivery;

    expect(
      harness.delivered.find(
        (intent) => intent.kind === "stream_update" && intent.stream.isFinal,
      ),
    ).toMatchObject({
      kind: "stream_update",
      text: "Hello final.",
    });
  });

  it("treats actionless approval cleanup edits as routine budget traffic", () => {
    const approvalWithButtons = {
      id: "approval-1",
      kind: "approval",
      createdAt: 1_000,
      title: "Approve",
      body: "Run command?",
      decisions: [
        {
          id: "accept",
          label: "Approve",
          decision: "accept",
        },
      ],
    } satisfies MessagingSurfaceIntent;
    const approvalCleanup = {
      ...approvalWithButtons,
      id: "approval-2",
      decisions: [],
    } satisfies MessagingSurfaceIntent;

    expect(messagingDeliveryPriority(approvalWithButtons)).toBe(
      "critical_interactive",
    );
    expect(messagingDeliveryPriority(approvalCleanup)).toBe("routine_status");
  });

  it("treats resume reposts as routine budget traffic", () => {
    const resumeRepost = {
      id: "assistant-resume-repost-1",
      kind: "message",
      bindingId: "binding-1",
      createdAt: 1_000,
      role: "assistant",
      parts: [{ type: "text", text: "Last Bot Reply\n\nPrevious answer." }],
    } satisfies MessagingSurfaceIntent;

    const finalAssistant = {
      ...resumeRepost,
      id: "assistant-message-1",
    } satisfies MessagingSurfaceIntent;

    expect(messagingDeliveryPriority(resumeRepost)).toBe("routine_status");
    expect(messagingDeliveryPriority(finalAssistant)).toBe("final_turn");
  });

  it("does not charge typing activity against the message write budget", () => {
    const activity = {
      id: "activity-1",
      kind: "activity",
      activity: "typing",
      createdAt: 1_000,
      state: "active",
    } satisfies MessagingSurfaceIntent;
    const status = {
      id: "status-1",
      kind: "status",
      createdAt: 1_000,
      status: "working",
      text: "Working",
    } satisfies MessagingSurfaceIntent;

    expect(shouldConsumeDeliveryBudget(activity)).toBe(false);
    expect(shouldConsumeDeliveryBudget(status)).toBe(true);
  });

  it("serializes concurrent assistant stream deliveries onto one surface", async () => {
    let now = 1000;
    let releaseFirstDelivery: (() => void) | undefined;
    let resolveFirstDeliveryStarted: (() => void) | undefined;
    const firstStreamStarted = new Promise<void>((resolve) => {
      resolveFirstDeliveryStarted = resolve;
    });
    const delivered: MessagingSurfaceIntent[] = [];
    const harness = await createHarness({
      now: () => now,
      deliver: async (intent) => {
        delivered.push(intent);
        if (
          intent.kind === "stream_update" &&
          intent.stream.sequence === 1 &&
          !releaseFirstDelivery
        ) {
          resolveFirstDeliveryStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirstDelivery = resolve;
          });
        }
        return {
          channel: "telegram",
          deliveredAt: now,
          outcome: intent.kind === "stream_update" && intent.delivery?.mode === "update"
            ? "updated"
            : "presented",
          surface: {
            channel: "telegram",
            id: `surface:${intent.id}`,
          },
        };
      },
    });
    await bindThread(harness);
    delivered.length = 0;

    const first = harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "Hello",
        },
      },
    } satisfies AgentEvent);
    await firstStreamStarted;

    now += 100;
    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: " world",
        },
      },
    } satisfies AgentEvent);

    now += 100;
    const final = harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [
              {
                type: "text",
                text: "Hello world.",
              },
            ],
          },
        },
      },
    } satisfies AgentEvent);

    expect(delivered).toHaveLength(1);
    releaseFirstDelivery?.();
    await Promise.all([first, final]);

    const streamUpdates = delivered.filter(
      (intent) => intent.kind === "stream_update",
    );
    expect(streamUpdates).toHaveLength(2);
    expect(streamUpdates[1]).toMatchObject({
      delivery: {
        mode: "update",
        fallback: "fail",
      },
      targetSurface: {
        id: `surface:${streamUpdates[0]!.id}`,
      },
      text: "Hello world.",
      stream: {
        isFinal: true,
        sequence: 3,
      },
    });
    expect(delivered.filter((intent) => intent.kind === "message")).toEqual([]);
  });

  it("waits for a pending final stream edit before clearing typing on idle", async () => {
    let now = 1000;
    let releaseFinalStream!: () => void;
    let resolveFinalStreamStarted!: () => void;
    const finalStreamStarted = new Promise<void>((resolve) => {
      resolveFinalStreamStarted = resolve;
    });
    const finalStreamDelivery = new Promise<void>((resolve) => {
      releaseFinalStream = resolve;
    });
    const delivered: MessagingSurfaceIntent[] = [];
    const harness = await createHarness({
      now: () => now,
      deliver: async (intent) => {
        delivered.push(intent);
        if (intent.kind === "stream_update" && intent.stream.isFinal) {
          resolveFinalStreamStarted();
          await finalStreamDelivery;
        }
        return {
          channel: "telegram",
          deliveredAt: now,
          outcome: intent.kind === "stream_update" && intent.delivery?.mode === "update"
            ? "updated"
            : intent.kind === "status" && intent.delivery?.pin
              ? "pinned"
              : "presented",
          surface: {
            channel: "telegram",
            id: `surface:${intent.id}`,
          },
        };
      },
    });
    await bindThread(harness);
    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "running",
          },
        },
      },
    } satisfies AgentEvent);
    delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "Hello",
        },
      },
    } satisfies AgentEvent);

    now += 100;
    const final = harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "agentMessage",
            text: "Hello world.",
          },
        },
      },
    } satisfies AgentEvent);
    await finalStreamStarted;

    const idle = harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "thread/status/changed",
        params: {
          threadId: "thread-1",
          status: {
            type: "idle",
          },
        },
      },
    } satisfies AgentEvent);
    await Promise.resolve();

    expect(
      delivered.find((intent) => intent.kind === "activity" && intent.state === "idle"),
    ).toBeUndefined();

    releaseFinalStream();
    await Promise.all([final, idle]);

    const finalStreamIndex = delivered.findIndex(
      (intent) => intent.kind === "stream_update" && intent.stream.isFinal,
    );
    const idleActivityIndex = delivered.findIndex(
      (intent) => intent.kind === "activity" && intent.state === "idle",
    );
    expect(finalStreamIndex).toBeGreaterThanOrEqual(0);
    expect(idleActivityIndex).toBeGreaterThan(finalStreamIndex);
  });

  it("delivers the final assistant message when stream updates are discarded", async () => {
    const delivered: MessagingSurfaceIntent[] = [];
    const harness = await createHarness({
      deliver: async (intent) => {
        delivered.push(intent);
        return {
          channel: "telegram",
          deliveredAt: 1000,
          outcome: intent.kind === "stream_update" ? "discarded" : "presented",
          surface: {
            channel: "telegram",
            id: `surface:${intent.id}`,
          },
        };
      },
    });
    await bindThread(harness);
    delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "Hello",
        },
      },
    } satisfies AgentEvent);
    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [
              {
                type: "text",
                text: "Hello final.",
              },
            ],
          },
        },
      },
    } satisfies AgentEvent);

    expect(delivered.filter((intent) => intent.kind === "stream_update")).toEqual([
      expect.objectContaining({
        stream: expect.objectContaining({
          isFinal: false,
        }),
      }),
      expect.objectContaining({
        stream: expect.objectContaining({
          isFinal: true,
        }),
        text: "Hello final.",
      }),
    ]);
    expect(delivered.filter((intent) => intent.kind === "message")).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        parts: [
          expect.objectContaining({
            text: "Hello final.",
          }),
        ],
      }),
    ]);
  });

  it("keeps typing active after assistant item text until terminal completion", async () => {
    let now = 1000;
    const harness = await createHarness({
      now: () => now,
    });
    await bindThread(harness);
    await harness.controller.handleInboundEvent(buildTextEvent("start multi-step work"));
    harness.delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "agentMessage",
            text: "First update.",
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "assistant",
      }),
    ]);

    now += 11_000;
    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "item-2",
            type: "reasoning",
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "active",
    });

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [
              {
                type: "text",
                text: "First update.",
              },
            ],
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "idle",
    });
    expect(harness.delivered.filter((intent) => intent.kind === "message")).toHaveLength(1);
  });

  it("passes discrete work activity through so providers can renew typing leases", async () => {
    let now = 1000;
    const harness = await createHarness({
      now: () => now,
    });
    await bindThread(harness);
    await harness.controller.handleInboundEvent(buildTextEvent("start long work"));
    harness.delivered.length = 0;

    now += 9_000;
    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "reasoning-1",
            type: "reasoning",
          },
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered).toEqual([
      expect.objectContaining({
        kind: "activity",
        activity: "typing",
        state: "active",
      }),
    ]);
  });

  it("suppresses high-frequency typing refreshes without logging each skipped delta", async () => {
    let now = 1000;
    const logger = {
      debug: vi.fn<(message: string, data?: Record<string, unknown>) => void>(),
    };
    const harness = await createHarness({
      logger,
      now: () => now,
    });
    await bindThread(harness);
    await harness.controller.handleInboundEvent(buildTextEvent("run noisy command"));
    harness.delivered.length = 0;
    logger.debug.mockClear();

    now += 500;
    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-1",
          delta: "lots of output",
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered).toEqual([]);
    expect(logger.debug).not.toHaveBeenCalled();

    now += 10_000;
    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-1",
          delta: "still working",
        },
      },
    } satisfies AgentEvent);

    expect(harness.delivered).toEqual([
      expect.objectContaining({
        kind: "activity",
        activity: "typing",
        state: "active",
      }),
    ]);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("typing signaled"));
  });

  it("clears typing when status refresh observes an idle backend thread", async () => {
    let now = 1000;
    const logger = {
      debug: vi.fn<(message: string, data?: Record<string, unknown>) => void>(),
    };
    const harness = await createHarness({
      logger,
      now: () => now,
    });
    await bindThread(harness);
    await harness.controller.handleInboundEvent(buildTextEvent("start work"));
    harness.delivered.length = 0;
    logger.debug.mockClear();

    now += 1000;
    harness.readThreadStatus.mockResolvedValue("idle");

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:refresh" }),
    );

    expect(harness.delivered.at(-2)).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "idle",
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      status: "idle",
      text: expect.stringContaining("Turn: completed"),
    });
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining(
        "messaging turn state changed reason=status_refresh:thread_status_idle",
      ),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining(
        "messaging typing signaled state=idle reason=status_refresh:thread_status_idle",
      ),
    );
  });

  it("delivers quiet completed tool updates as generated system messages", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    await harness.controller.handleInboundEvent(buildTextEvent("start work"));
    harness.delivered.length = 0;

    await harness.controller.handleBackendEvent(
      buildToolCompletedEvent("tool-1", "/bin/zsh -lc 'npm view dive'"),
    );

    expect(harness.delivered).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "system",
        parts: [
          expect.objectContaining({
            text: "Tool update: npm view dive",
          }),
        ],
      }),
    ]);
  });

  it("batches noisy default tool updates and flushes them before turn completion activity", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    await harness.controller.handleInboundEvent(buildTextEvent("start work"));
    harness.delivered.length = 0;

    for (const index of [1, 2, 3, 4]) {
      await harness.controller.handleBackendEvent(
        buildToolCompletedEvent(`tool-${index}`, `pnpm test ${index}`),
      );
    }

    expect(harness.delivered.filter((intent) => intent.kind === "message"))
      .toHaveLength(3);

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [],
          },
        },
      },
    } satisfies AgentEvent);

    const batchIndex = harness.delivered.findIndex(
      (intent) =>
        intent.kind === "message" &&
        intent.role === "system" &&
        intent.parts.some(
          (part) => part.type === "text" && part.text.includes("Tool updates: ran 1 tool"),
        ),
    );
    const activityIndex = harness.delivered.findIndex(
      (intent) =>
        intent.kind === "activity" &&
        intent.activity === "typing" &&
        intent.state === "idle",
    );

    expect(batchIndex).toBeGreaterThanOrEqual(0);
    expect(activityIndex).toBeGreaterThan(batchIndex);
  });

  it("flushes queued tool updates before assistant final text", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    await harness.controller.handleInboundEvent(buildTextEvent("start work"));
    harness.delivered.length = 0;

    for (const index of [1, 2, 3, 4]) {
      await harness.controller.handleBackendEvent(
        buildToolCompletedEvent(`tool-${index}`, `pnpm test ${index}`),
      );
    }
    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [
              {
                type: "text",
                text: "Done.",
              },
            ],
          },
        },
      },
    } satisfies AgentEvent);

    const batchIndex = harness.delivered.findIndex(
      (intent) =>
        intent.kind === "message" &&
        intent.role === "system" &&
        intent.parts.some(
          (part) => part.type === "text" && part.text.includes("Tool updates: ran 1 tool"),
        ),
    );
    const assistantIndex = harness.delivered.findIndex(
      (intent) => intent.kind === "message" && intent.role === "assistant",
    );

    expect(batchIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeGreaterThan(batchIndex);
  });

  it("suppresses generated tool messages in Show None while preserving assistant delivery", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    const binding = await harness.store.findActiveBindingForChannel(buildTextEvent("").channel);
    await harness.store.upsertBinding({
      ...binding!,
      preferences: {
        toolUpdateMode: "show_none",
        updatedAt: 1000,
      },
      updatedAt: 1000,
    });
    await harness.controller.handleInboundEvent(buildTextEvent("start work"));
    harness.delivered.length = 0;

    await harness.controller.handleBackendEvent(
      buildToolCompletedEvent("tool-1", "pnpm test"),
    );
    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "assistant-1",
            type: "agentMessage",
            text: "Done.",
          },
        },
      },
    } satisfies AgentEvent);

    expect(
      harness.delivered.filter(
        (intent) => intent.kind === "message" && intent.role === "system",
      ),
    ).toEqual([]);
    expect(harness.delivered).toContainEqual(
      expect.objectContaining({
        kind: "message",
        role: "assistant",
      }),
    );
  });

  it("ignores turn completion events that do not include output text", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    harness.delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      },
    } as unknown as AgentEvent);

    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "idle",
    });
  });

  it("ignores malformed turn completion events without throwing", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    harness.delivered.length = 0;

    await expect(
      harness.controller.handleBackendEvent({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
          },
        },
      } as unknown as AgentEvent),
    ).resolves.toBeUndefined();

    expect(harness.delivered).toEqual([]);
  });

  it("revokes stale bindings when a delivery target no longer exists", async () => {
    const harness = await createHarness({
      deliver: async () => ({
        channel: "discord",
        deliveredAt: 1000,
        outcome: "failed",
        errorMessage: "DiscordAPIError[10003]: Unknown Channel",
      }),
    });
    await harness.store.upsertBinding({
      id: "binding:discord:channel::discord-channel:codex:thread-1",
      channel: {
        channel: "discord",
        conversation: {
          id: "discord-channel",
          kind: "channel",
        },
      },
      backend: "codex",
      threadId: "thread-1",
      authorizedActorIds: ["user-1"],
      createdAt: 1000,
      updatedAt: 1000,
    });

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
          },
        },
      },
    });

    await expect(
      harness.store.getBinding("binding:discord:channel::discord-channel:codex:thread-1"),
    ).resolves.toMatchObject({
      revokedAt: 1000,
    });
  });

  it("does not revoke a binding from a failure result for another channel", async () => {
    const harness = await createHarness({
      deliver: async () => ({
        channel: "discord",
        deliveredAt: 1000,
        outcome: "failed",
        errorMessage: "DiscordAPIError[10003]: Unknown Channel",
      }),
    });
    await bindThread(harness);

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
          },
        },
      },
    });

    await expect(
      harness.store.getBinding("binding:telegram:dm::chat-1:codex:thread-1"),
    ).resolves.not.toMatchObject({
      revokedAt: expect.any(Number),
    });
  });

  it("presents Plan questionnaires as semantic questionnaire intents", async () => {
    const harness = await createHarness();
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "bind:codex:thread-1",
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );

    await harness.controller.handleBackendPendingRequest("codex", {
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        requestId: "request-1",
        questions: [
          {
            id: "q1",
            header: "Mode",
            question: "How should I proceed?",
            isOther: true,
            isSecret: false,
            options: [
              {
                label: "Implement (Recommended)",
                description: "Start coding.",
              },
            ],
          },
        ],
      },
    } satisfies AppServerPendingRequestNotification);

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "questionnaire",
      requestContext: {
        requestId: "request-1",
      },
      questions: [
        expect.objectContaining({
          id: "q1",
          allowFreeform: true,
        }),
      ],
    });
  });

  it("stops typing while presenting a Plan questionnaire for an active turn", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    await harness.controller.handleInboundEvent(buildTextEvent("plan this"));
    harness.delivered.length = 0;

    await harness.controller.handleBackendPendingRequest("codex", {
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        requestId: "request-1",
        questions: [
          {
            id: "q1",
            header: "Mode",
            question: "How should I proceed?",
            isOther: false,
            isSecret: false,
            options: [
              {
                label: "Plan (Recommended)",
                description: "Stay in planning mode.",
              },
            ],
          },
        ],
      },
    } satisfies AppServerPendingRequestNotification);

    expect(harness.delivered.at(-3)).toMatchObject({
      kind: "questionnaire",
    });
    expect(harness.delivered.at(-2)).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "idle",
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      status: "waiting",
    });
  });

  it("submits approval callbacks through the backend bridge", async () => {
    const harness = await createHarness();
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "bind:codex:thread-1",
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );
    await harness.controller.handleBackendPendingRequest("codex", {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        requestId: "approval-1",
        prompt: "Run tests?",
        command: "/bin/zsh -lc 'pnpm test -- messaging-controller'",
      },
    });

    expect(harness.delivered.find((intent) => intent.kind === "approval")).toMatchObject({
      kind: "approval",
      body: expect.stringContaining("```shell\npnpm test -- messaging-controller\n```"),
    });

    await harness.controller.handleInboundEvent(buildTextEvent("yes for this session"));

    expect(harness.submitServerRequest).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: "approval-1",
      response: {
        decision: "accept_for_session",
      },
    });
    expect(
      harness.delivered.find(
        (intent) => intent.kind === "approval" && intent.decisions.length === 0,
      ),
    ).toMatchObject({
      kind: "approval",
      body: expect.stringContaining("Response Received: Approved for Session"),
      decisions: [],
    });
  });

  it("resumes typing after submitting an approval response for the waiting turn", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    await harness.controller.handleInboundEvent(buildTextEvent("run a command"));
    await harness.controller.handleBackendPendingRequest("codex", {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        requestId: "approval-1",
        prompt: "Run tests?",
        command: "pnpm test",
      },
    });
    harness.delivered.length = 0;

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "approval:accept" }),
    );

    expect(harness.delivered).toEqual([
      expect.objectContaining({
        kind: "approval",
        body: expect.stringContaining("Response Received: Approved"),
        decisions: [],
      }),
      expect.objectContaining({
        kind: "activity",
        activity: "typing",
        state: "active",
      }),
    ]);
  });

  it("clears approval buttons after approval button callbacks", async () => {
    const harness = await createHarness();
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "bind:codex:thread-1",
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );
    await harness.controller.handleBackendPendingRequest("codex", {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        requestId: "approval-1",
        prompt: "Run tests?",
        command: "/bin/zsh -lc 'pnpm test -- messaging-controller'",
      },
    });
    const approvalIntent = harness.delivered.find((intent) => intent.kind === "approval");

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "approval:accept" }),
    );

    expect(harness.submitServerRequest).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: "approval-1",
      response: {
        decision: "accept",
      },
    });
    expect(
      harness.delivered.find(
        (intent) => intent.kind === "approval" && intent.decisions.length === 0,
      ),
    ).toMatchObject({
      kind: "approval",
      body: expect.stringContaining("Response Received: Approved"),
      decisions: [],
      delivery: {
        mode: "update",
        replaceMarkup: true,
        fallback: "fail",
      },
      targetSurface: {
        id: `surface:${approvalIntent?.id}`,
      },
    });
  });

  it("clears approval buttons after the backend resolves the request elsewhere", async () => {
    const harness = await createHarness();
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "bind:codex:thread-1",
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );
    await harness.controller.handleBackendPendingRequest("codex", {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        requestId: "approval-1",
        prompt: "Run tests?",
        command: "/bin/zsh -lc 'pnpm test -- messaging-controller'",
      },
    });
    const approvalIntent = harness.delivered.find((intent) => intent.kind === "approval");

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "serverRequest/resolved",
        params: {
          threadId: "thread-1",
          requestId: "approval-1",
        },
      },
    });

    expect(harness.submitServerRequest).not.toHaveBeenCalled();
    expect(
      harness.delivered.find(
        (intent) => intent.kind === "approval" && intent.decisions.length === 0,
      ),
    ).toMatchObject({
      kind: "approval",
      body: expect.stringContaining("Response Received: Resolved"),
      decisions: [],
      delivery: {
        mode: "update",
        replaceMarkup: true,
        fallback: "fail",
      },
      targetSurface: {
        id: `surface:${approvalIntent?.id}`,
      },
    });
  });

  it("resumes typing when the backend resolves an approval for the waiting turn", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    await harness.controller.handleInboundEvent(buildTextEvent("run a command"));
    await harness.controller.handleBackendPendingRequest("codex", {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        requestId: "approval-1",
        prompt: "Run tests?",
        command: "pnpm test",
      },
    });
    const approvalIntent = harness.delivered.find((intent) => intent.kind === "approval");
    harness.delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "serverRequest/resolved",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "approval-1",
        },
      },
    });

    expect(harness.delivered).toEqual([
      expect.objectContaining({
        kind: "approval",
        body: expect.stringContaining("Response Received: Resolved"),
        decisions: [],
        targetSurface: expect.objectContaining({
          id: `surface:${approvalIntent?.id}`,
        }),
      }),
      expect.objectContaining({
        kind: "activity",
        activity: "typing",
        state: "active",
      }),
    ]);
  });

  it("reports expired approval callbacks with retry guidance", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "approval:accept" }),
    );

    expect(harness.submitServerRequest).not.toHaveBeenCalled();
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Approval expired",
      body: expect.stringContaining("Retry the command"),
    });
  });

  it("opens a model picker and stores the selected model", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(buildCallbackEvent({ actionId: "status:model" }));
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "single_select",
      prompt: "Select Model",
      choices: expect.arrayContaining([
        expect.objectContaining({
          id: "status:set-model",
          value: {
            model: "gpt-5.3-codex",
          },
        }),
      ]),
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "status:set-model",
        value: {
          model: "gpt-5.3-codex",
        },
      }),
    );

    expect(harness.setThreadModelSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        model: "gpt-5.3-codex",
      }),
    );
    expect(harness.updateDirectoryLaunchpad).not.toHaveBeenCalled();
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/status").channel),
    ).resolves.toMatchObject({
      preferences: {
        model: "gpt-5.3-codex",
      },
    });
  });

  it("opens a reasoning picker and stores the selected effort", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:reasoning" }),
    );
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "single_select",
      prompt: "Select Reasoning",
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "status:set-reasoning",
        value: {
          reasoningEffort: "high",
        },
      }),
    );

    expect(harness.setThreadModelSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        reasoningEffort: "high",
      }),
    );
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Reasoning: high"),
    });
  });

  it("opens, searches, selects, removes, and consumes skills from the status menu", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:skills" }),
    );

    expect(harness.listSkills).toHaveBeenCalledWith({
      backend: "codex",
      cwds: ["/repo/pwragent"],
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "single_select",
      prompt: "Skills",
      choices: expect.arrayContaining([
        expect.objectContaining({
          id: "skills:select",
          label: "1. $ce:plan",
        }),
        expect.objectContaining({ id: "skills:search" }),
      ]),
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "skills:search" }),
    );
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Search Skills",
    });

    await harness.controller.handleInboundEvent(buildTextEvent("work"));
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "single_select",
      prompt: expect.stringContaining("Skills matching \"work\""),
      choices: expect.arrayContaining([
        expect.objectContaining({
          id: "skills:select",
          label: "1. $ce:work",
        }),
      ]),
    });
    expect(harness.startTurn).not.toHaveBeenCalled();

    const workChoice = findChoice(harness.delivered.at(-1), "skills:select");
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "skills:select",
        value: workChoice.value,
      }),
    );
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Skill Selected",
      body: expect.stringContaining("Skill: $ce:work"),
      actions: expect.arrayContaining([
        expect.objectContaining({ id: "skills:remove" }),
      ]),
    });
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/status").channel),
    ).resolves.toMatchObject({
      pendingSkillSelection: {
        name: "ce:work",
      },
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "skills:remove" }),
    );
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/status").channel),
    ).resolves.not.toHaveProperty("pendingSkillSelection");

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "skills:select",
        value: workChoice.value,
      }),
    );
    await harness.controller.handleInboundEvent(buildCommandEvent("/status"));
    expect(harness.startTurn).not.toHaveBeenCalled();
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/status").channel),
    ).resolves.toMatchObject({
      pendingSkillSelection: {
        name: "ce:work",
      },
    });

    await harness.controller.handleInboundEvent(buildTextEvent("implement it"));

    expect(harness.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          {
            type: "text",
            text: "Use [$ce:work](/skills/ce-work/SKILL.md)",
          },
          {
            type: "text",
            text: "implement it",
          },
        ],
      }),
    );
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/status").channel),
    ).resolves.not.toHaveProperty("pendingSkillSelection");
  });

  it("presents the skills browser as a current chat message instead of editing the status card", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    const binding = await harness.store.findActiveBindingForChannel(
      buildCommandEvent("/status").channel,
    );
    if (!binding) throw new Error("Expected an active binding");
    await harness.store.upsertBinding({
      ...binding,
      statusSurface: {
        channel: "telegram",
        id: "status-surface",
        state: { opaque: { messageId: "status-message" } },
      },
      updatedAt: 1000,
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:skills" }),
    );

    const skillsBrowser = harness.delivered.at(-1);
    expect(skillsBrowser).toMatchObject({
      kind: "single_select",
      delivery: {
        mode: "present",
      },
    });
    expect(skillsBrowser).not.toHaveProperty("targetSurface");
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/status").channel),
    ).resolves.toMatchObject({
      statusSurface: {
        id: "status-surface",
      },
    });
  });

  it("updates the active skills message for button-driven navigation and typed search results", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:skills" }),
    );
    const initialSkillsSurface = harness.delivered.at(-1)?.id;
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "skills:search" }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      delivery: {
        mode: "update",
      },
      targetSurface: {
        id: `surface:${initialSkillsSurface}`,
      },
    });
    const searchPromptIntent = await harness.store.findActivePendingIntentForChannel({
      actorId: buildTextEvent("work").actor.platformUserId,
      channel: buildTextEvent("work").channel,
      now: 1000,
    });
    expect(searchPromptIntent?.surface).toBeDefined();

    await harness.controller.handleInboundEvent(buildTextEvent("work"));

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "single_select",
      delivery: {
        mode: "update",
      },
      prompt: expect.stringContaining('Skills matching "work"'),
      targetSurface: {
        id: searchPromptIntent?.surface?.id,
      },
    });
  });

  it("lists skills from every linked directory on the bound thread", async () => {
    const navigation = buildNavigationSnapshot();
    navigation.threads[0] = {
      ...navigation.threads[0]!,
      linkedDirectories: [
        {
          id: "directory:pwragent",
          kind: "local",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
        {
          id: "directory:secondary",
          kind: "local",
          label: "Secondary",
          path: "/repo/secondary",
        },
        {
          id: "directory:tools-worktree",
          kind: "worktree",
          label: "Tools",
          path: "/repo/tools",
          worktreePath: "/repo/tools/.worktrees/feature",
        },
      ],
    };
    const harness = await createHarness({ navigation });
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:skills" }),
    );

    expect(harness.listSkills).toHaveBeenCalledWith({
      backend: "codex",
      cwds: [
        "/repo/tools/.worktrees/feature",
        "/repo/tools",
        "/repo/pwragent",
        "/repo/secondary",
      ],
    });
  });

  it("reports skills as unavailable when the backend bridge cannot list them", async () => {
    const harness = await createHarness({ listSkills: false });
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:skills" }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Skills unavailable",
    });
  });

  it("honors Back and Cancel text fallbacks from the skills search prompt", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:skills" }),
    );
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "skills:search" }),
    );
    await harness.controller.handleInboundEvent(buildTextEvent("back"));

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "single_select",
      prompt: "Skills",
    });
    expect(harness.startTurn).not.toHaveBeenCalled();

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "skills:search" }),
    );
    await harness.controller.handleInboundEvent(buildTextEvent("cancel"));

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Skills dismissed",
      actions: [],
      delivery: {
        mode: "update",
        replaceMarkup: true,
      },
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it("dismisses the skills browser and clears the pending intent on Cancel", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:skills" }),
    );
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "skills:cancel" }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Skills dismissed",
      actions: [],
      delivery: {
        mode: "update",
        replaceMarkup: true,
      },
    });

    await harness.controller.handleInboundEvent(buildTextEvent("fix bug"));

    expect(harness.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          {
            type: "text",
            text: "fix bug",
          },
        ],
      }),
    );
  });

  it("dismisses older skills browser Cancel buttons that still send status refresh", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:skills" }),
    );
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:refresh" }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Skills dismissed",
      actions: [],
      delivery: {
        mode: "update",
        replaceMarkup: true,
      },
    });

    await harness.controller.handleInboundEvent(buildTextEvent("fix bug"));

    expect(harness.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          {
            type: "text",
            text: "fix bug",
          },
        ],
      }),
    );
  });

  it("does not let the removed-skill notice block the next short request", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:skills" }),
    );
    const workChoice = findChoice(harness.delivered.at(-1), "skills:select");
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "skills:select",
        value: workChoice.value,
      }),
    );
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "skills:remove" }),
    );
    await harness.controller.handleInboundEvent(buildTextEvent("fix bug"));

    expect(harness.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          {
            type: "text",
            text: "fix bug",
          },
        ],
      }),
    );
  });

  it("toggles fast mode and applies it to later free-form turns", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(buildCallbackEvent({ actionId: "status:fast" }));
    await harness.controller.handleInboundEvent(buildTextEvent("please run tests"));

    expect(harness.setThreadModelSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        fastMode: true,
      }),
    );
    expect(harness.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fastMode: true,
      }),
    );
  });

  it("toggles permissions mode through the backend bridge", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:permissions" }),
    );

    expect(harness.setThreadExecutionMode).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "full-access",
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Permissions: Full Access"),
    });

    await harness.controller.handleInboundEvent(buildTextEvent("run npm view dive"));

    expect(harness.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "full-access",
      }),
    );
  });

  it("blocks messaging Full Access escalation when the setting disallows it", async () => {
    const onFullAccessPolicyViolation = vi.fn();
    const harness = await createHarness({
      fullAccessControls: {
        allowEscalation: false,
        allowThreadResume: true,
        warningPolicy: "dismissable",
      },
      onFullAccessPolicyViolation,
    });
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:permissions" }),
    );

    expect(harness.setThreadExecutionMode).not.toHaveBeenCalled();
    expect(onFullAccessPolicyViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "user-1",
        backend: "codex",
        bindingId: expect.any(String),
        requestedAction: "messaging.full_access.escalate_thread",
        threadId: "thread-1",
      }),
    );
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Full Access blocked",
      body: expect.stringContaining("Escalating to Full Access"),
    });
  });

  it("requires a messaging risk acknowledgment before Full Access escalation", async () => {
    const dismissWarning = vi.fn(async () => undefined);
    const harness = await createHarness({
      fullAccessControls: {
        allowEscalation: true,
        allowThreadResume: true,
        warningPolicy: "dismissable",
        authorizedUsers: {
          telegram: [{ id: "user-1", displayName: "" }],
        },
        dismissWarning,
      },
    });
    await bindThread(harness);
    const binding = await harness.store.findActiveBindingForChannel(
      buildCommandEvent("/status").channel,
    );

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:permissions" }),
    );

    expect(harness.setThreadExecutionMode).not.toHaveBeenCalled();
    const warning = harness.delivered.at(-1);
    expect(warning).toMatchObject({
      kind: "confirmation",
      title: "Enable Full Access?",
      body: expect.stringContaining("data can be exfiltrated"),
      delivery: {
        mode: "update",
        replaceMarkup: true,
      },
      targetSurface: binding?.statusSurface,
      actions: expect.arrayContaining([
        expect.objectContaining({ id: "full-access-risk:accept", label: "Yes" }),
        expect.objectContaining({
          id: "full-access-risk:dismiss",
          label: "Yes - and stop warning me",
        }),
        expect.objectContaining({ id: "full-access-risk:cancel", label: "Cancel" }),
      ]),
    });
    const dismiss = findAction(warning, "full-access-risk:dismiss");

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "full-access-risk:dismiss",
        value: dismiss.value,
      }),
    );

    expect(dismissWarning).toHaveBeenCalledWith({
      actorId: "user-1",
      channel: "telegram",
    });
    expect(harness.setThreadExecutionMode).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "full-access",
    });
  });

  it("omits the dismiss action when Full Access warning dismissal cannot persist", async () => {
    const dismissWarning = vi.fn(async () => undefined);
    const harness = await createHarness({
      fullAccessControls: {
        allowEscalation: true,
        allowThreadResume: true,
        warningPolicy: "dismissable",
        authorizedUsers: {
          telegram: [{ id: "user-1", displayName: "" }],
        },
        dismissWarning,
        canDismissWarning: async () => false,
      },
    });
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:permissions" }),
    );

    const warning = harness.delivered.at(-1);
    expect(warning).toMatchObject({
      kind: "confirmation",
      title: "Enable Full Access?",
    });
    expect(warning && "actions" in warning ? warning.actions : []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "full-access-risk:dismiss" }),
      ]),
    );
  });

  it("rechecks escalation settings before honoring stale Full Access warning callbacks", async () => {
    const onFullAccessPolicyViolation = vi.fn();
    let allowEscalation = true;
    const harness = await createHarness({
      fullAccessControls: async () => ({
        allowEscalation,
        allowThreadResume: true,
        warningPolicy: "dismissable",
        authorizedUsers: {
          telegram: [{ id: "user-1", displayName: "" }],
        },
      }),
      onFullAccessPolicyViolation,
    });
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:permissions" }),
    );
    const warning = harness.delivered.at(-1);
    allowEscalation = false;

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "full-access-risk:accept",
        value: findAction(warning, "full-access-risk:accept").value,
      }),
    );

    expect(harness.setThreadExecutionMode).not.toHaveBeenCalled();
    expect(onFullAccessPolicyViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "user-1",
        requestedAction: "messaging.full_access.escalate_thread",
        threadId: "thread-1",
      }),
    );
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Full Access blocked",
      body: expect.stringContaining("Escalating to Full Access"),
    });
  });

  it("restores the status surface after accepting a Full Access warning", async () => {
    const harness = await createHarness({
      fullAccessControls: {
        allowEscalation: true,
        allowThreadResume: true,
        warningPolicy: "dismissable",
        authorizedUsers: {
          telegram: [{ id: "user-1", displayName: "" }],
        },
      },
    });
    await bindThread(harness);
    const binding = await harness.store.findActiveBindingForChannel(
      buildCommandEvent("/status").channel,
    );

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:permissions" }),
    );

    const warning = harness.delivered.at(-1);
    expect(warning).toMatchObject({
      kind: "confirmation",
      title: "Enable Full Access?",
      delivery: {
        mode: "update",
        replaceMarkup: true,
      },
      targetSurface: binding?.statusSurface,
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "full-access-risk:accept",
        value: findAction(warning, "full-access-risk:accept").value,
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      delivery: expect.objectContaining({
        mode: "update",
      }),
      targetSurface: binding?.statusSurface,
      text: expect.stringContaining("Permissions: Full Access"),
    });
  });

  it("restores the status surface after cancelling a Full Access warning", async () => {
    const harness = await createHarness({
      fullAccessControls: {
        allowEscalation: true,
        allowThreadResume: true,
        warningPolicy: "dismissable",
        authorizedUsers: {
          telegram: [{ id: "user-1", displayName: "" }],
        },
      },
    });
    await bindThread(harness);
    const binding = await harness.store.findActiveBindingForChannel(
      buildCommandEvent("/status").channel,
    );

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:permissions" }),
    );

    const warning = harness.delivered.at(-1);
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "full-access-risk:cancel",
        value: findAction(warning, "full-access-risk:cancel").value,
      }),
    );

    expect(harness.setThreadExecutionMode).not.toHaveBeenCalled();
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      delivery: expect.objectContaining({
        mode: "update",
      }),
      targetSurface: binding?.statusSurface,
      text: expect.stringContaining("Permissions: Default"),
    });
  });

  it("applies Full Access to a resumed Default Access thread after risk acknowledgment", async () => {
    const harness = await createHarness({
      fullAccessControls: {
        allowEscalation: true,
        allowThreadResume: true,
        warningPolicy: "dismissable",
        authorizedUsers: {
          telegram: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume --yolo"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-thread",
        value: {
          backend: "codex",
          threadId: "thread-1",
        },
      }),
    );

    expect(harness.setThreadExecutionMode).not.toHaveBeenCalled();
    const warning = harness.delivered.at(-1);
    expect(warning).toMatchObject({
      kind: "confirmation",
      title: "Enable Full Access?",
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "full-access-risk:accept",
        value: findAction(warning, "full-access-risk:accept").value,
      }),
    );

    expect(harness.setThreadExecutionMode).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "full-access",
    });
  });

  it("shows the new-thread Full Access warning on the existing picker surface", async () => {
    const harness = await createHarness({
      fullAccessControls: {
        allowEscalation: true,
        allowThreadResume: true,
        warningPolicy: "dismissable",
        authorizedUsers: {
          telegram: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await harness.controller.handleInboundEvent(buildCommandEvent("/resume --new"));
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    );
    const readyIntent = harness.delivered.at(-1);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "browse:new:permissions" }),
    );

    const warning = harness.delivered.at(-1);
    expect(warning).toMatchObject({
      kind: "confirmation",
      title: "Enable Full Access?",
      delivery: {
        mode: "update",
        replaceMarkup: true,
      },
      targetSurface: {
        id: `surface:${readyIntent?.id}`,
      },
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "full-access-risk:accept",
        value: findAction(warning, "full-access-risk:accept").value,
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Ready to start",
      body: expect.stringContaining("Permissions: Full"),
      delivery: expect.objectContaining({
        mode: "update",
      }),
      targetSurface: {
        id: `surface:${readyIntent?.id}`,
      },
    });
  });

  it("posts a permissions-queue audit message with a Cancel button on thread/executionMode/queued", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    harness.delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "thread/executionMode/queued",
        params: {
          threadId: "thread-1",
          queuedExecutionMode: "full-access",
          queuedAt: 1500,
        },
      },
    });

    const queuedIntent = harness.delivered.find(
      (intent) =>
        intent.kind === "confirmation" &&
        typeof intent.title === "string" &&
        intent.title.includes("Permissions queue"),
    );
    expect(queuedIntent).toBeDefined();
    expect(queuedIntent).toMatchObject({
      kind: "confirmation",
      body: expect.stringContaining("Default Access → Full Access"),
    });
    expect(queuedIntent).toMatchObject({
      body: expect.stringContaining("Will apply at end of current turn"),
    });
    const cancelAction = (queuedIntent as { actions?: MessagingSurfaceAction[] }).actions?.find(
      (action) => action.id.startsWith("permissions:queue:cancel:"),
    );
    expect(cancelAction).toBeDefined();
    expect(cancelAction).toMatchObject({ label: "Cancel" });
  });

  it("edits the queued audit message to 'Cancelled' on queueCleared with reason cancelled", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    // First post the queued message.
    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "thread/executionMode/queued",
        params: {
          threadId: "thread-1",
          queuedExecutionMode: "full-access",
          queuedAt: 1500,
        },
      },
    });

    harness.delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "thread/executionMode/queueCleared",
        params: {
          threadId: "thread-1",
          reason: "cancelled",
        },
      },
    });

    const cancelledIntent = harness.delivered.find(
      (intent) =>
        intent.kind === "confirmation" &&
        typeof intent.body === "string" &&
        intent.body.includes("Cancelled queued permissions change"),
    );
    expect(cancelledIntent).toBeDefined();
    expect(cancelledIntent).toMatchObject({
      kind: "confirmation",
      body: expect.stringContaining("Default Access → Full Access"),
      delivery: expect.objectContaining({
        mode: "update",
        fallback: "present_new",
      }),
      targetSurface: expect.objectContaining({
        channel: "telegram",
      }),
    });
    // Buttons must be removed on cancel.
    expect(
      (cancelledIntent as { actions?: MessagingSurfaceAction[] }).actions,
    ).toEqual([]);
  });

  it("edits the queued audit message to 'submitted' on queueCleared with reason applied", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "thread/executionMode/queued",
        params: {
          threadId: "thread-1",
          queuedExecutionMode: "full-access",
          queuedAt: 1500,
        },
      },
    });

    harness.delivered.length = 0;

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "thread/executionMode/queueCleared",
        params: {
          threadId: "thread-1",
          reason: "applied",
        },
      },
    });

    const appliedIntent = harness.delivered.find(
      (intent) =>
        intent.kind === "confirmation" &&
        typeof intent.body === "string" &&
        intent.body.includes("Permissions changed"),
    );
    expect(appliedIntent).toBeDefined();
    expect(appliedIntent).toMatchObject({
      kind: "confirmation",
      body: expect.stringContaining("Default Access → Full Access"),
    });
    expect(appliedIntent).toMatchObject({
      body: expect.stringContaining("(submitted)"),
      delivery: expect.objectContaining({
        mode: "update",
        fallback: "present_new",
      }),
    });
    expect(
      (appliedIntent as { actions?: MessagingSurfaceAction[] }).actions,
    ).toEqual([]);
  });

  it("falls back to a fresh message when the queued-audit edit fails", async () => {
    const editAttempts: MessagingSurfaceIntent[] = [];
    let deliveryCount = 0;
    const harness = await createHarness({
      deliver: async (intent) => {
        deliveryCount += 1;
        // Record edit attempts (mode === "update" + a target surface)
        // and report failure so the controller's logged-fallback path
        // exercises. The adapter is responsible for the actual
        // present_new fallback once it sees `delivery.fallback:
        // "present_new"`.
        if (intent.delivery?.mode === "update" && intent.targetSurface) {
          editAttempts.push(intent);
          return {
            channel: "telegram" as const,
            deliveredAt: 1000 + deliveryCount,
            outcome: "failed" as const,
            errorMessage: "edit not supported",
          };
        }
        return {
          channel: "telegram" as const,
          deliveredAt: 1000 + deliveryCount,
          outcome: "presented" as const,
          surface: {
            channel: "telegram" as const,
            id: `surface:${intent.id}`,
          },
        };
      },
    });
    await bindThread(harness);

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "thread/executionMode/queued",
        params: {
          threadId: "thread-1",
          queuedExecutionMode: "full-access",
          queuedAt: 1500,
        },
      },
    });

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "thread/executionMode/queueCleared",
        params: {
          threadId: "thread-1",
          reason: "cancelled",
        },
      },
    });

    // We attempted the edit (mode: update + targetSurface) and the
    // intent set `fallback: "present_new"` so the adapter would post a
    // fresh message in the conversation when the edit fails.
    expect(editAttempts.length).toBeGreaterThanOrEqual(1);
    expect(editAttempts[0]).toMatchObject({
      delivery: expect.objectContaining({
        mode: "update",
        fallback: "present_new",
      }),
    });
  });

  it("routes a permissions:queue:cancel callback to cancelThreadExecutionModeQueue when the queueId matches the active tracking entry", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    // Prime the tracking map so the cancel handler treats this as a
    // live queue. Otherwise the handler treats the click as stale
    // and posts an "expired" notice (the next test).
    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "thread/executionMode/queued",
        params: {
          threadId: "thread-1",
          queuedExecutionMode: "full-access",
          queuedAt: 1500,
        },
      },
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "permissions:queue:cancel:thread-1:1500",
      }),
    );

    expect(harness.cancelThreadExecutionModeQueue).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
  });

  it("posts a 'permissions change unavailable' notice when the cancel button references a queueId that no longer matches the active queue", async () => {
    // Regression: real-world bug where the user tapped a stale Cancel
    // button (for a queue that had already been applied) and got no
    // visible feedback — registry no-op'd silently. Mirrors the
    // queued-message Steer/Cancel pattern at handleQueuedTurnCallback.
    const harness = await createHarness();
    await bindThread(harness);

    // No tracking entry exists for thread-1; the cancel callback
    // arrives "out of band".
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "permissions:queue:cancel:thread-1:1500",
      }),
    );

    // The registry is NOT called — we don't fall through to the
    // idempotent no-op; we explicitly tell the user the queue is gone.
    expect(harness.cancelThreadExecutionModeQueue).not.toHaveBeenCalled();

    // An error intent should have been delivered to the channel,
    // recoverable, with the "no longer waiting" body so the user
    // knows the click landed somewhere visible.
    const errorIntents = harness.delivered.filter(
      (intent) =>
        intent.kind === "error" &&
        typeof intent.body === "string" &&
        intent.body.toLowerCase().includes("no longer waiting"),
    );
    expect(errorIntents.length).toBeGreaterThanOrEqual(1);
  });

  it("posts a 'permissions change unavailable' notice when the cancel button's queueId is from a different (replaced) queue", async () => {
    // The user queued Default→Full at queuedAt=1500, then replaced it
    // with another queued change at queuedAt=2000. The first audit
    // message's Cancel button (encoded with queueId 1500) is now
    // stale even though A queue still exists — the queueId mismatch
    // tells the handler the click was on the older lifecycle.
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "thread/executionMode/queued",
        params: {
          threadId: "thread-1",
          queuedExecutionMode: "full-access",
          queuedAt: 2000,
        },
      },
    });

    // Stale click with the OLD queuedAt=1500 actionId.
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "permissions:queue:cancel:thread-1:1500",
      }),
    );

    // Registry is NOT called — the current queue (queuedAt=2000) is
    // not the queue this button references.
    expect(harness.cancelThreadExecutionModeQueue).not.toHaveBeenCalled();
    const errorIntents = harness.delivered.filter(
      (intent) =>
        intent.kind === "error" &&
        typeof intent.body === "string" &&
        intent.body.toLowerCase().includes("no longer waiting"),
    );
    expect(errorIntents.length).toBeGreaterThanOrEqual(1);
  });

  it("renders status card with queued mode arrow when queuedExecutionMode is set", async () => {
    const harness = await createHarness();
    const navigation = buildNavigationSnapshot();
    navigation.threads[0]!.executionMode = "default";
    navigation.threads[0]!.queuedExecutionMode = "full-access";
    navigation.threads[0]!.queuedExecutionModeAt = 1500;
    harness.getNavigationSnapshot.mockResolvedValue(navigation);
    await bindThread(harness);

    await harness.controller.handleInboundEvent(buildCommandEvent("/status"));

    const statusIntent = harness.delivered.find(
      (intent) =>
        intent.kind === "status" &&
        typeof intent.text === "string" &&
        intent.text.includes("Permissions:"),
    );
    expect(statusIntent).toBeDefined();
    expect(statusIntent).toMatchObject({
      kind: "status",
      text: expect.stringContaining(
        "Permissions: Default Access → Full Access (queued)",
      ),
    });
    const permissionsAction = (statusIntent as {
      actions?: MessagingSurfaceAction[];
    }).actions?.find((action) => action.id === "status:permissions");
    expect(permissionsAction?.label).toBe(
      "Permissions: Default → Full Access (queued)",
    );
  });

  it("uses live thread permissions instead of stale binding preferences", async () => {
    const harness = await createHarness();
    const navigation = buildNavigationSnapshot();
    navigation.threads[0]!.executionMode = "default";
    harness.getNavigationSnapshot.mockResolvedValue(navigation);
    await bindThread(harness);
    const binding = await harness.store.findActiveBindingForChannel(buildTextEvent("").channel);
    expect(binding).toBeDefined();
    await harness.store.upsertBinding({
      ...binding!,
      preferences: {
        executionMode: "full-access",
        permissionsMode: "full-access",
        updatedAt: 900,
      },
      updatedAt: 900,
    });

    await harness.controller.handleInboundEvent(buildCommandEvent("/status"));

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Permissions: Default Access"),
    });

    await harness.controller.handleInboundEvent(buildTextEvent("run npm view dive"));

    expect(harness.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        executionMode: "default",
      }),
    );
  });

  it("uses the desktop tool update default until the binding overrides it", async () => {
    const harness = await createHarness({
      toolUpdateDefaultMode: "show_less",
    });
    await bindThread(harness);

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Tool updates: Show Less"),
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:tool-updates" }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Tool updates: Show Some"),
    });
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/status").channel),
    ).resolves.toMatchObject({
      preferences: {
        toolUpdateMode: "show_some",
      },
    });
  });

  it("cycles the tool update status action through all modes and wraps", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    harness.delivered.length = 0;

    for (const expected of [
      "Show More",
      "Show All",
      "Show None",
      "Show Less",
      "Show Some",
    ]) {
      await harness.controller.handleInboundEvent(
        buildCallbackEvent({ actionId: "status:tool-updates" }),
      );
      expect(harness.delivered.at(-1)).toMatchObject({
        kind: "status",
        text: expect.stringContaining(`Tool updates: ${expected}`),
      });
    }
  });

  it("stops an active turn through the backend bridge", async () => {
    const harness = await createHarness();
    await bindThread(harness);
    await harness.controller.handleInboundEvent(buildTextEvent("start work"));

    await harness.controller.handleInboundEvent(buildCallbackEvent({ actionId: "status:stop" }));

    expect(harness.interruptTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Turn: interrupted"),
    });
  });

  it("starts compaction through the backend bridge", async () => {
    const harness = await createHarness();
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:compact" }),
    );

    expect(harness.compactThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Turn: working"),
    });
  });

  it("runs a local-to-worktree handoff from the status menu", async () => {
    const harness = await createHarness();
    harness.getNavigationSnapshot.mockResolvedValue(buildLocalHandoffNavigationSnapshot());
    await bindThread(harness);
    harness.delivered.length = 0;

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:handoff" }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "single_select",
      prompt: expect.stringContaining("Workspace Handoff"),
      choices: expect.arrayContaining([
        expect.objectContaining({
          id: "handoff:move-branch",
          label: "Move Existing Branch",
        }),
      ]),
    });

    const toWorktree = findChoice(harness.delivered.at(-1), "handoff:move-branch");
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: toWorktree.id,
        value: toWorktree.value,
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "single_select",
      prompt: expect.stringContaining("Choose the branch"),
      choices: expect.arrayContaining([
        expect.objectContaining({
          id: "handoff:select-leave-branch",
          label: "1. Detached HEAD",
        }),
      ]),
    });

    const leaveDetached = findChoice(harness.delivered.at(-1), "handoff:select-leave-branch");
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: leaveDetached.id,
        value: leaveDetached.value,
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      body: expect.stringContaining("Leave Local on: Detached HEAD"),
    });

    const confirm = findAction(harness.delivered.at(-1), "handoff:confirm");
    harness.getNavigationSnapshot.mockResolvedValue(buildWorktreeHandoffNavigationSnapshot());
    harness.getNavigationSnapshot.mockResolvedValueOnce(
      buildLocalHandoffNavigationSnapshot(),
    );
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: confirm.id,
        value: confirm.value,
      }),
    );

    expect(harness.handoffThreadWorkspace).toHaveBeenCalledWith({
      backend: "codex",
      direction: "local-to-worktree",
      leaveLocalBranch: "HEAD",
      repositoryPath: "/repo/pwragent",
      sourceBranch: "feature/handoff",
      sourcePath: "/repo/pwragent",
      threadId: "thread-1",
    });
    expect(harness.delivered.at(-2)).toMatchObject({
      kind: "status",
      status: "completed",
      text: expect.stringContaining("/repo/pwragent/.worktrees/pwragent-feature-handoff"),
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining(
        "Worktree: /repo/pwragent/.worktrees/pwragent-feature-handoff",
      ),
    });
  });

  it("pages large local-to-worktree handoff branch lists from the status menu", async () => {
    const harness = await createHarness();
    const navigation = buildLocalHandoffNavigationSnapshot();
    navigation.directories[0]!.gitStatus = {
      currentBranch: "feature/handoff",
      handoffBranches: Array.from({ length: 18 }, (_, index) => `branch-${index + 1}`),
    };
    harness.getNavigationSnapshot.mockResolvedValue(navigation);
    await bindThread(harness);
    harness.delivered.length = 0;

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:handoff" }),
    );
    const toWorktree = findChoice(harness.delivered.at(-1), "handoff:move-branch");
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: toWorktree.id,
        value: toWorktree.value,
      }),
    );

    const firstPage = harness.delivered.at(-1);
    if (!firstPage || !("choices" in firstPage)) {
      throw new Error("Expected handoff branch picker");
    }
    expect(firstPage.prompt).toContain("Page 1/3.");
    expect(
      firstPage.choices.filter((choice) => choice.id === "handoff:select-leave-branch"),
    ).toHaveLength(8);
    expect(firstPage.choices).toContainEqual(
      expect.objectContaining({
        id: "handoff:branches:next",
        value: expect.objectContaining({ pageIndex: 1 }),
      }),
    );

    const nextPage = findChoice(firstPage, "handoff:branches:next");
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: nextPage.id,
        value: nextPage.value,
      }),
    );

    const secondPage = harness.delivered.at(-1);
    if (!secondPage || !("choices" in secondPage)) {
      throw new Error("Expected second handoff branch picker");
    }
    expect(secondPage.prompt).toContain("Page 2/3.");
    expect(secondPage.choices[0]).toMatchObject({
      id: "handoff:select-leave-branch",
      label: "9. branch-8",
    });
    expect(secondPage.choices).toContainEqual(
      expect.objectContaining({
        id: "handoff:branches:previous",
        value: expect.objectContaining({ pageIndex: 0 }),
      }),
    );
  });

  it("runs a detached-head worktree handoff without asking for a leave-local branch", async () => {
    const harness = await createHarness();
    harness.getNavigationSnapshot.mockResolvedValue(buildLocalHandoffNavigationSnapshot());
    await bindThread(harness);
    harness.delivered.length = 0;

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:handoff" }),
    );
    const createDetached = findChoice(harness.delivered.at(-1), "handoff:create-detached");
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: createDetached.id,
        value: createDetached.value,
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      body: expect.stringContaining("Confirm new detached-head worktree."),
    });

    const confirm = findAction(harness.delivered.at(-1), "handoff:confirm");
    harness.getNavigationSnapshot.mockResolvedValue(buildWorktreeHandoffNavigationSnapshot());
    harness.getNavigationSnapshot.mockResolvedValueOnce(
      buildLocalHandoffNavigationSnapshot(),
    );
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: confirm.id,
        value: confirm.value,
      }),
    );

    expect(harness.handoffThreadWorkspace).toHaveBeenCalledWith({
      backend: "codex",
      direction: "local-to-worktree",
      strategy: "detached-changes",
      repositoryPath: "/repo/pwragent",
      sourceBranch: "feature/handoff",
      sourcePath: "/repo/pwragent",
      threadId: "thread-1",
    });
  });

  it("offers move-branch handoff for a local checkout with no alternate branches", async () => {
    const harness = await createHarness();
    const navigation = buildLocalHandoffNavigationSnapshot();
    navigation.directories[0] = {
      ...navigation.directories[0]!,
      gitStatus: {
        currentBranch: "feature/handoff",
        branches: ["feature/handoff"],
        handoffBranches: [],
      },
    };
    harness.getNavigationSnapshot.mockResolvedValue(navigation);
    await bindThread(harness);
    harness.delivered.length = 0;

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:handoff" }),
    );

    const overview = harness.delivered.at(-1);
    if (!overview || !("choices" in overview)) {
      throw new Error("Expected handoff overview");
    }
    expect(overview.choices).toContainEqual(
      expect.objectContaining({
        id: "handoff:move-branch",
        fallbackText: "1",
      }),
    );
    expect(overview.choices).toContainEqual(
      expect.objectContaining({
        id: "handoff:create-detached",
        fallbackText: "2",
      }),
    );
  });

  it("runs a worktree-to-local handoff from the status menu", async () => {
    const harness = await createHarness();
    harness.getNavigationSnapshot.mockResolvedValue(buildWorktreeHandoffNavigationSnapshot());
    await bindThread(harness);
    harness.delivered.length = 0;

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:handoff" }),
    );

    const toLocal = findChoice(harness.delivered.at(-1), "handoff:worktree-to-local");
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: toLocal.id,
        value: toLocal.value,
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Confirm Handoff",
      body: expect.stringContaining("Confirm handoff to Local."),
    });

    const confirm = findAction(harness.delivered.at(-1), "handoff:confirm");
    harness.getNavigationSnapshot.mockResolvedValue(buildNavigationSnapshot());
    harness.getNavigationSnapshot.mockResolvedValueOnce(
      buildWorktreeHandoffNavigationSnapshot(),
    );
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: confirm.id,
        value: confirm.value,
      }),
    );

    expect(harness.handoffThreadWorkspace).toHaveBeenCalledWith({
      backend: "codex",
      direction: "worktree-to-local",
      repositoryPath: "/repo/pwragent",
      sourceBranch: "feature/handoff",
      sourcePath: "/repo/pwragent/.worktrees/pwragent-feature-handoff",
      threadId: "thread-1",
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Directory: /repo/pwragent"),
    });
    const finalStatus = harness.delivered.at(-1);
    if (!finalStatus || finalStatus.kind !== "status") {
      throw new Error("Expected final handoff delivery to be a status intent");
    }
    expect(finalStatus.text).not.toContain("Worktree:");
  });

  it("rejects stale handoff confirmations when workspace metadata changes", async () => {
    const harness = await createHarness();
    harness.getNavigationSnapshot.mockResolvedValue(buildLocalHandoffNavigationSnapshot());
    await bindThread(harness);
    harness.delivered.length = 0;

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:handoff" }),
    );
    const toWorktree = findChoice(harness.delivered.at(-1), "handoff:move-branch");
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: toWorktree.id,
        value: toWorktree.value,
      }),
    );
    const leaveMain = findChoice(harness.delivered.at(-1), "handoff:select-leave-branch");
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: leaveMain.id,
        value: leaveMain.value,
      }),
    );
    const confirm = findAction(harness.delivered.at(-1), "handoff:confirm");

    harness.getNavigationSnapshot.mockResolvedValue(buildNavigationSnapshot());
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: confirm.id,
        value: confirm.value,
      }),
    );

    expect(harness.handoffThreadWorkspace).not.toHaveBeenCalled();
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Handoff unavailable",
    });
  });

  it("rejects handoff confirmations while a turn is active", async () => {
    const harness = await createHarness();
    harness.getNavigationSnapshot.mockResolvedValue(buildLocalHandoffNavigationSnapshot());
    await bindThread(harness);
    harness.delivered.length = 0;

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:handoff" }),
    );
    const toWorktree = findChoice(harness.delivered.at(-1), "handoff:move-branch");
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: toWorktree.id,
        value: toWorktree.value,
      }),
    );
    const leaveMain = findChoice(harness.delivered.at(-1), "handoff:select-leave-branch");
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: leaveMain.id,
        value: leaveMain.value,
      }),
    );
    const confirm = findAction(harness.delivered.at(-1), "handoff:confirm");

    await harness.controller.handleBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "inProgress",
          },
        },
      },
    });
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: confirm.id,
        value: confirm.value,
      }),
    );

    expect(harness.handoffThreadWorkspace).not.toHaveBeenCalled();
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Handoff unavailable",
      body: expect.stringContaining(
        "Worktree/local migration is not available while a turn is in progress",
      ),
    });
  });

  it("reports handoff as unavailable when the backend bridge does not expose it", async () => {
    const harness = await createHarness({ handoff: false });
    harness.getNavigationSnapshot.mockResolvedValue(buildLocalHandoffNavigationSnapshot());
    await bindThread(harness);
    harness.delivered.length = 0;

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({ actionId: "status:handoff" }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Handoff unavailable",
      body: expect.stringContaining("does not expose"),
    });
  });

  it("syncs the platform conversation name from the bound thread title", async () => {
    const setConversationTitle = vi.fn(
      async (
        request: Parameters<NonNullable<MessagingAdapter["setConversationTitle"]>>[0],
      ) => ({
      channel: "telegram" as const,
      conversation: {
        ...request.channel.conversation,
        title: request.title,
      },
      outcome: "updated" as const,
      title: request.title,
      updatedAt: 1000,
    }));
    const harness = await createHarness({ setConversationTitle });
    const navigation = buildNavigationSnapshot();
    navigation.threads[0]!.title = "Renamed in Desktop";
    harness.getNavigationSnapshot.mockResolvedValue(navigation);
    await bindThread(harness);

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "status:sync-name",
        routingState: {
          opaque: {
            chatId: 777,
            messageThreadId: 9,
          },
        },
      }),
    );

    expect(setConversationTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "chat-1",
          }),
        }),
        routingState: {
          opaque: {
            chatId: 777,
            messageThreadId: 9,
          },
        },
        title: "Renamed in Desktop",
      }),
    );
    expect(harness.delivered.at(-2)).toMatchObject({
      kind: "confirmation",
      title: "Name synced",
      body: expect.stringContaining('Renamed in Desktop'),
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Binding: Renamed in Desktop"),
    });
  });
});

async function createHarness(options?: {
  deliveryBudget?: MessagingDeliveryBudget;
  deliver?: (intent: MessagingSurfaceIntent) => Promise<MessagingDeliveryResult>;
  downloadAttachment?: MessagingAdapter["downloadAttachment"];
  handoff?: false;
  inputDebounceMs?: number;
  logger?: MessagingControllerOptions["logger"];
  listBackends?: NonNullable<MessagingBackendBridge["listBackends"]>;
  listSkills?: NonNullable<MessagingBackendBridge["listSkills"]> | false;
  navigation?: NavigationSnapshot;
  now?: () => number;
  channel?: MessagingChannelKind;
  capabilityProfile?: MessagingCapabilityProfile;
  fullAccessControls?: MessagingControllerOptions["fullAccessControls"];
  onFullAccessPolicyViolation?: MessagingControllerOptions["onFullAccessPolicyViolation"];
  onDeliveryBudgetEvent?: MessagingControllerOptions["onDeliveryBudgetEvent"];
  resolveDeliveryScope?: MessagingAdapter["resolveDeliveryScope"];
  materializeDirectoryLaunchpad?: NonNullable<
    MessagingBackendBridge["materializeDirectoryLaunchpad"]
  >;
  updateDirectoryLaunchpad?: NonNullable<
    MessagingBackendBridge["updateDirectoryLaunchpad"]
  >;
  streamingResponsesDefault?: boolean;
  /**
   * Set to `false` to construct the controller WITHOUT an
   * `onBindingChanged` callback. Used by tests that verify the
   * controller's nullish-callback guard — production callers always
   * supply one (see `messaging-runtime.ts`), but the option is
   * declared optional and the controller must not throw if it's
   * absent.
   */
  bindingChangedListener?: false;
  readThreadLastAssistantMessage?: NonNullable<
    MessagingBackendBridge["readThreadLastAssistantMessage"]
  >;
  readThreadLastAssistantReply?: NonNullable<
    MessagingBackendBridge["readThreadLastAssistantReply"]
  >;
  setConversationTitle?: MessagingAdapter["setConversationTitle"];
  startThread?: NonNullable<MessagingBackendBridge["startThread"]>;
  toolUpdateDefaultMode?: MessagingToolUpdateMode;
}): Promise<{
  controller: MessagingController;
  compactThread: ReturnType<typeof vi.fn>;
  cancelThreadExecutionModeQueue: ReturnType<typeof vi.fn>;
  delivered: MessagingSurfaceIntent[];
  getNavigationSnapshot: ReturnType<typeof vi.fn>;
  handoffThreadWorkspace: ReturnType<typeof vi.fn> | undefined;
  interruptTurn: ReturnType<typeof vi.fn>;
  listSkills: ReturnType<typeof vi.fn> | undefined;
  listBackends: ReturnType<typeof vi.fn>;
  materializeDirectoryLaunchpad: ReturnType<typeof vi.fn>;
  onBindingChanged: ReturnType<typeof vi.fn>;
  readThreadLastAssistantMessage: ReturnType<typeof vi.fn>;
  readThreadLastAssistantReply: ReturnType<typeof vi.fn>;
  readThreadStatus: ReturnType<typeof vi.fn>;
  recordMessagingBindingTransition: ReturnType<typeof vi.fn>;
  setThreadExecutionMode: ReturnType<typeof vi.fn>;
  setThreadModelSettings: ReturnType<typeof vi.fn>;
  startThread: ReturnType<typeof vi.fn>;
  startTurn: ReturnType<typeof vi.fn>;
  steerTurn: ReturnType<typeof vi.fn>;
  submitServerRequest: ReturnType<typeof vi.fn>;
  updateDirectoryLaunchpad: ReturnType<typeof vi.fn>;
  store: MessagingStore;
}> {
  const store = await createStore();
  const delivered: MessagingSurfaceIntent[] = [];
  const adapter: MessagingAdapter = {
    capabilityProfile: options?.capabilityProfile ?? PERMISSIVE_CAPABILITY_PROFILE,
    ...(options?.downloadAttachment
      ? { downloadAttachment: options.downloadAttachment }
      : {}),
    ...(options?.resolveDeliveryScope
      ? { resolveDeliveryScope: options.resolveDeliveryScope }
      : {}),
    deliver: vi.fn(
      options?.deliver ??
        (async (intent) => {
          delivered.push(intent);
          return {
            channel: "telegram" as const,
            deliveredAt: 1000,
            outcome: intent.kind === "status" && intent.delivery?.pin
              ? "pinned" as const
              : "presented" as const,
            surface: {
              channel: "telegram" as const,
              id: `surface:${intent.id}`,
            },
          };
        }),
    ),
    ...(options?.setConversationTitle
      ? { setConversationTitle: options.setConversationTitle }
      : {}),
  };
  const getNavigationSnapshot = vi.fn(
    async () => options?.navigation ?? buildNavigationSnapshot(),
  );
  const startThread = vi.fn(
    options?.startThread ??
      (async (request: StartThreadRequest) => ({
        backend: request.backend,
        threadId: "new-thread-1",
        executionMode: request.executionMode ?? "default",
      })),
  );
  const materializeDirectoryLaunchpad = vi.fn(
    options?.materializeDirectoryLaunchpad ??
      (async (
        request: MaterializeDirectoryLaunchpadRequest,
      ) => ({
        backend: request.launchpad?.backend ?? "codex",
        threadId: "new-thread-1",
        executionMode: request.launchpad?.executionMode ?? "default",
        ...(request.launchpad?.workMode === "worktree"
          ? {
              linkedDirectory: {
                id: request.launchpad.directoryKey,
                kind: "worktree" as const,
                label: request.launchpad.directoryLabel,
                path: request.launchpad.directoryPath ?? request.launchpad.directoryKey,
                worktreePath: "/repo/pwragent/.worktrees/new-thread-1",
              },
            }
          : {}),
        workMode: request.launchpad?.workMode ?? "local",
      })),
  );
  const startTurn = vi.fn(async (request: StartTurnRequest) => ({
    backend: request.backend,
    threadId: request.threadId,
    turnId: "turn-1",
  }));
  const steerTurn = vi.fn(async (request: SteerTurnRequest) => ({
    backend: request.backend,
    threadId: request.threadId,
    turnId: request.expectedTurnId,
  }));
  const compactThread = vi.fn(async (request) => ({
    ...request,
    turnId: "compact-turn-1",
    itemId: "compact-item-1",
  }));
  const interruptTurn = vi.fn(async (request) => request);
  const listSkills =
    options?.listSkills === false
      ? undefined
      : vi.fn(
          options?.listSkills ??
            (async (): Promise<Pick<AppServerListSkillsResponse, "data">> => ({
              data: [
                {
                  cwd: "/repo/pwragent",
                  skills: [
                    {
                      name: "ce:plan",
                      description: "Create implementation plans",
                      enabled: true,
                      path: "/skills/ce-plan/SKILL.md",
                    },
                    {
                      name: "ce:work",
                      description: "Execute implementation plans",
                      enabled: true,
                      path: "/skills/ce-work/SKILL.md",
                    },
                    {
                      name: "review-pr",
                      description: "Review pull requests",
                      enabled: true,
                      path: "/skills/review-pr/SKILL.md",
                    },
                  ],
                },
              ],
            })),
        );
  // Mirror the real BackendRegistry emit-after-mutation behavior: the
  // mutation methods also fan out a notification on the bus so the
  // controller's refreshStatusSurfacesForThread path runs end-to-end.
  let controllerRef: MessagingController | undefined;
  const setThreadExecutionMode = vi.fn(async (request: SetThreadExecutionModeRequest) => {
    if (controllerRef) {
      await controllerRef.handleBackendEvent({
        backend: request.backend,
        notification: {
          method: "thread/executionMode/updated",
          params: {
            threadId: request.threadId,
            executionMode: request.executionMode,
          },
        },
      });
    }
    return request;
  });
  const cancelThreadExecutionModeQueue = vi.fn(
    async (request: CancelThreadExecutionModeQueueRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      executionMode: "default" as const,
    }),
  );
  const setThreadModelSettings = vi.fn(async (request: SetThreadModelSettingsRequest) => {
    if (controllerRef) {
      await controllerRef.handleBackendEvent({
        backend: request.backend,
        notification: {
          method: "thread/modelSettings/updated",
          params: {
            threadId: request.threadId,
            ...(request.model !== undefined ? { model: request.model } : {}),
            ...(request.fastMode !== undefined ? { fastMode: request.fastMode } : {}),
            ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}),
            ...(request.serviceTier !== undefined ? { serviceTier: request.serviceTier } : {}),
          },
        },
      });
    }
    return request;
  });
  const handoffThreadWorkspace =
    options?.handoff === false
      ? undefined
      : vi.fn(async (request: HandoffThreadWorkspaceRequest) => ({
          backend: request.backend,
          threadId: request.threadId,
          direction: request.direction,
          workMode: request.direction === "local-to-worktree"
            ? "worktree" as const
            : "local" as const,
          branch: request.sourceBranch,
          repositoryPath: request.repositoryPath ?? "/repo/pwragent",
          targetPath: request.direction === "local-to-worktree"
            ? "/repo/pwragent/.worktrees/pwragent-feature-handoff"
            : "/repo/pwragent",
          linkedDirectory: request.direction === "local-to-worktree"
            ? {
                id: "pwragent-handoff:codex:thread-1",
                kind: "worktree" as const,
                label: "PwrAgent",
                path: "/repo/pwragent",
                worktreePath: "/repo/pwragent/.worktrees/pwragent-feature-handoff",
              }
            : {
                id: "directory:pwragent",
                kind: "local" as const,
                label: "PwrAgent",
                path: "/repo/pwragent",
              },
          warnings: [],
          completedAt: 1000,
        }));
  const listBackends = vi.fn(
    options?.listBackends ??
      (async (): Promise<ListBackendsResponse> => ({
        fetchedAt: 1000,
        backends: [buildBackendSummary()],
      })),
  );
  const updateDirectoryLaunchpad = vi.fn(
    options?.updateDirectoryLaunchpad ??
      (async (
        request: UpdateDirectoryLaunchpadRequest,
      ) => ({
        defaults: buildNavigationSnapshot().launchpadDefaults,
        launchpad: {
          directoryKey: request.directoryKey,
          directoryKind: "directory" as const,
          directoryLabel: "PwrAgent",
          directoryPath: "/repo/pwragent",
          backend: request.patch.backend ?? "codex",
          executionMode: request.patch.executionMode ?? "default",
          prompt: "",
          workMode: request.patch.workMode ?? "local",
          createdAt: 1000,
          updatedAt: 1000,
        },
      })),
  );
  const readThreadLastAssistantMessage = vi.fn(
    options?.readThreadLastAssistantMessage ?? (async () => undefined),
  );
  const readThreadLastAssistantReply = vi.fn(
    options?.readThreadLastAssistantReply ?? (async () => undefined),
  );
  const readThreadStatus = vi.fn(async () => undefined);
  const recordMessagingBindingTransition = vi.fn(async () => undefined);
  const submitServerRequest = vi.fn(async (request: SubmitServerRequestRequest) => ({
    backend: request.backend,
    threadId: request.threadId,
    turnId: request.turnId,
    requestId: request.requestId,
  }));
  const backend: MessagingBackendBridge = {
    compactThread,
    cancelThreadExecutionModeQueue,
    getNavigationSnapshot,
    ...(handoffThreadWorkspace ? { handoffThreadWorkspace } : {}),
    interruptTurn,
    ...(listSkills ? { listSkills } : {}),
    listBackends,
    materializeDirectoryLaunchpad,
    readThreadLastAssistantReply,
    readThreadLastAssistantMessage,
    readThreadStatus,
    recordMessagingBindingTransition,
    setThreadExecutionMode,
    setThreadModelSettings,
    startThread,
    startTurn,
    steerTurn,
    submitServerRequest,
    updateDirectoryLaunchpad,
  };

  const onBindingChanged = vi.fn();
  const controller = new MessagingController({
    adapter,
    authorizedActorIds: ["user-1"],
    backend,
    channel: options?.channel,
    deliveryBudget: options?.deliveryBudget,
    inputDebounceMs: options?.inputDebounceMs ?? 0,
    logger: options?.logger,
    now: options?.now ?? (() => 1000),
    fullAccessControls: options?.fullAccessControls ?? {
      allowEscalation: true,
      allowThreadResume: true,
      warningPolicy: "never",
    },
    onDeliveryBudgetEvent: options?.onDeliveryBudgetEvent,
    onFullAccessPolicyViolation: options?.onFullAccessPolicyViolation,
    // Pass the spy by default so tests can assert on fan-out. The
    // `bindingChangedListener: false` opt-out exists for tests that
    // verify the nullish-callback guard — production wiring always
    // supplies one.
    ...(options?.bindingChangedListener === false
      ? {}
      : { onBindingChanged }),
    store,
    streamingResponsesDefault: options?.streamingResponsesDefault,
    toolUpdateDefaultMode: options?.toolUpdateDefaultMode,
  });
  controllerRef = controller;

  return {
    controller,
    compactThread,
    cancelThreadExecutionModeQueue,
    delivered,
    getNavigationSnapshot,
    handoffThreadWorkspace,
    interruptTurn,
    listSkills,
    listBackends,
    materializeDirectoryLaunchpad,
    onBindingChanged,
    readThreadLastAssistantMessage,
    readThreadLastAssistantReply,
    readThreadStatus,
    recordMessagingBindingTransition,
    setThreadExecutionMode,
    setThreadModelSettings,
    startThread,
    startTurn,
    steerTurn,
    submitServerRequest,
    updateDirectoryLaunchpad,
    store,
  };
}

async function bindThread(
  harness: Awaited<ReturnType<typeof createHarness>>,
): Promise<void> {
  await harness.controller.handleInboundEvent(
    buildCallbackEvent({
      actionId: "bind:codex:thread-1",
      value: {
        backend: "codex",
        threadId: "thread-1",
      },
    }),
  );
}

function buildBackendSummary(overrides: Partial<BackendSummary> = {}): BackendSummary {
  const kind = overrides.kind ?? "codex";
  const base: BackendSummary = {
    kind,
    label: kind === "grok" ? "Grok" : "Codex",
    available: true,
    methods: [],
    capabilities: {
      listThreads: true,
      createThread: true,
      resumeThread: true,
      renameThread: true,
      readThread: true,
      startTurn: true,
      interruptTurn: true,
      steerTurn: false,
      transcriptPagination: false,
      toolUse: true,
      approvalRequests: true,
      multiDirectoryThreads: true,
    },
    executionModes: [
      {
        mode: "default",
        label: "Default",
        available: true,
        isDefault: true,
      },
      {
        mode: "full-access",
        label: "Full Access",
        available: true,
      },
    ],
    launchpadOptions: {
      models: [
        {
          id: kind === "grok" ? "grok-4.20-reasoning" : "gpt-5.3-codex",
          label: kind === "grok" ? "Grok 4.20 Reasoning" : "GPT-5.3 Codex",
        },
      ],
      reasoningEfforts: ["low", "medium", "high"],
      supportsFastMode: true,
    },
  };
  return {
    ...base,
    ...overrides,
    capabilities: {
      ...base.capabilities,
      ...overrides.capabilities,
    },
    executionModes: overrides.executionModes ?? base.executionModes,
    launchpadOptions: overrides.launchpadOptions ?? base.launchpadOptions,
  };
}

function buildNavigationSnapshot(): NavigationSnapshot {
  return {
    backend: "all",
    fetchedAt: 1000,
    unchanged: false,
    threads: [
      {
        id: "thread-1",
        title: "Thread one",
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
        updatedAt: 1000,
      },
    ],
    inboxThreadKeys: [],
    directories: [
      {
        key: "directory:pwragent",
        kind: "directory",
        label: "PwrAgent",
        path: "/repo/pwragent",
        threadKeys: ["codex:thread-1"],
        needsAttentionCount: 0,
        latestUpdatedAt: 1000,
      },
    ],
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
    },
  };
}

function buildWorktreeLaunchpadNavigationSnapshot(): NavigationSnapshot {
  const snapshot = buildNavigationSnapshot();
  snapshot.directories[0] = {
    ...snapshot.directories[0]!,
    gitStatus: {
      currentBranch: "feature/current",
      defaultBranch: "main",
      branches: ["main", "feature/current"],
    },
    launchpad: {
      directoryKey: "directory:pwragent",
      directoryKind: "directory",
      directoryLabel: "PwrAgent",
      directoryPath: "/repo/pwragent",
      backend: "codex",
      executionMode: "default",
      prompt: "",
      workMode: "worktree",
      createdAt: 1000,
      updatedAt: 1000,
    },
  };
  return snapshot;
}

function buildLocalHandoffNavigationSnapshot(): NavigationSnapshot {
  const snapshot = buildNavigationSnapshot();
  snapshot.threads[0] = {
    ...snapshot.threads[0]!,
    gitBranch: "feature/handoff",
  };
  snapshot.directories[0] = {
    ...snapshot.directories[0]!,
    gitStatus: {
      currentBranch: "feature/handoff",
      handoffBranches: ["main", "develop"],
    },
  };
  return snapshot;
}

function buildWorktreeHandoffNavigationSnapshot(): NavigationSnapshot {
  const snapshot = buildNavigationSnapshot();
  snapshot.threads[0] = {
    ...snapshot.threads[0]!,
    gitBranch: "feature/handoff",
    linkedDirectories: [
      {
        id: "pwragent-handoff:codex:thread-1",
        kind: "worktree",
        label: "PwrAgent",
        path: "/repo/pwragent",
        worktreePath: "/repo/pwragent/.worktrees/pwragent-feature-handoff",
      },
    ],
  };
  return snapshot;
}

function findChoice(
  intent: MessagingSurfaceIntent | undefined,
  actionId: string,
): MessagingSurfaceAction {
  if (!intent || !("choices" in intent)) {
    throw new Error(`Intent does not contain choices for ${actionId}`);
  }
  const action = intent.choices.find((choice) => choice.id === actionId);
  if (!action) {
    throw new Error(`Choice ${actionId} not found`);
  }
  return action;
}

function findAction(
  intent: MessagingSurfaceIntent | undefined,
  actionId: string,
): MessagingSurfaceAction {
  if (!intent || !("actions" in intent) || !Array.isArray(intent.actions)) {
    throw new Error(`Intent does not contain actions for ${actionId}`);
  }
  const action = intent.actions.find((candidate) => candidate.id === actionId);
  if (!action) {
    throw new Error(`Action ${actionId} not found`);
  }
  return action;
}

function readDeliveredStatusText(intent: MessagingSurfaceIntent | undefined): string {
  if (!intent || intent.kind !== "status") {
    throw new Error("expected status intent");
  }
  return intent.text;
}

function buildCommandEvent(
  rawText: string,
  actor: { platformUserId: string; username?: string } = { platformUserId: "user-1" },
): MessagingInboundEvent & { kind: "command" } {
  const parts = rawText.replace(/^\//, "").split(/\s+/).filter(Boolean);
  const command = parts[0] ?? "";
  return {
    id: "event-command",
    kind: "command",
    actor,
    channel: {
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    },
    command,
    args: parts.slice(1),
    rawText,
    receivedAt: 1000,
  };
}

function buildTextEvent(
  text: string,
  params: {
    channel?: MessagingInboundTextEvent["channel"];
    routingState?: MessagingInboundTextEvent["routingState"];
  } = {},
): MessagingInboundTextEvent {
  return {
    id: "event-text",
    kind: "text",
    actor: {
      platformUserId: "user-1",
    },
    channel: params.channel ?? {
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    },
    receivedAt: 1000,
    routingState: params.routingState,
    text,
  };
}

function buildToolCompletedEvent(id: string, command: string): AgentEvent {
  return {
    backend: "codex",
    notification: {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id,
          type: "commandExecution",
          command,
          status: "completed",
        },
      },
    },
  } satisfies AgentEvent;
}

function buildCallbackEvent(params: {
  actionId: string;
  channel?: MessagingInboundCallbackEvent["channel"];
  interactionId?: string;
  routingState?: MessagingInboundCallbackEvent["routingState"];
  value?: MessagingInboundCallbackEvent["value"];
}): MessagingInboundCallbackEvent {
  return {
    id: "event-callback",
    kind: "callback",
    actor: {
      platformUserId: "user-1",
    },
    channel: params.channel ?? {
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    },
    receivedAt: 1000,
    routingState: params.routingState,
    interaction: {
      channel: "telegram",
      id: params.interactionId ?? params.actionId,
    },
    actionId: params.actionId,
    value: params.value,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}
