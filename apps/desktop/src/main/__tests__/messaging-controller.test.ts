import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  AppServerPendingRequestNotification,
  CancelThreadExecutionModeQueueRequest,
  HandoffThreadWorkspaceRequest,
  ListBackendsResponse,
  MessagingToolUpdateMode,
  NavigationSnapshot,
  SetThreadExecutionModeRequest,
  SetThreadModelSettingsRequest,
  StartThreadRequest,
  StartTurnRequest,
  SteerTurnRequest,
  SubmitServerRequestRequest,
} from "@pwragent/shared";
import type {
  MessagingSurfaceAction,
  MessagingDeliveryResult,
  MessagingInboundCallbackEvent,
  MessagingInboundEvent,
  MessagingInboundTextEvent,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import {
  MessagingController,
  type MessagingControllerOptions,
} from "../messaging/core/messaging-controller";
import type { MessagingAdapter, MessagingBackendBridge } from "../messaging/core/messaging-adapter";
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

  it("starts a new thread from /resume --new project selection", async () => {
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

    expect(harness.startThread).toHaveBeenCalledWith({
      backend: "codex",
      cwd: "/repo/pwragent",
      executionMode: "default",
      fastMode: undefined,
      model: undefined,
      reasoningEffort: undefined,
      serviceTier: undefined,
    });
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
      text: expect.stringContaining("Project: PwrAgent"),
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      text: expect.stringContaining("Directory: /repo/pwragent"),
    });
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
      ]),
    });
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

    expect(harness.delivered.at(-2)).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "active",
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Turn: working"),
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

    expect(harness.delivered.at(-2)).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "idle",
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Turn: completed"),
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
    expect(harness.delivered).toHaveLength(2);

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

    expect(harness.delivered).toHaveLength(2);
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

    expect(harness.delivered.at(-2)).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "idle",
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Turn: completed"),
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

    await harness.controller.handleInboundEvent(buildCommandEvent("/detach"));

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
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/detach").channel),
    ).resolves.toBeUndefined();
  });

  it("asks unbound conversations to choose a thread before routing text", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildTextEvent("hello"));

    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Choose a thread",
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
    expect(last?.body).toContain("`resume`");
    expect(last?.body).toContain("`status`");
    expect(last?.body).toContain("`detach`");
    expect(last?.body).toContain("`help`");
    // Both invocation styles must be discoverable from the help text
    // — the whole reason we ship a catalog-derived body.
    expect(last?.body).toContain("/<cmd>");
    expect(last?.body).toContain("@<bot>");
  });

  it("help surface renders one button per canonical verb with Resume styled primary", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/help"));

    const last = harness.delivered.at(-1) as
      | { actions?: Array<{ id?: string; label?: string; style?: string }> }
      | undefined;
    expect(last?.actions).toBeDefined();
    // One button per canonical verb (today: 4). Catalog fits a
    // single page on every reasonable provider profile, so no nav
    // buttons are rendered.
    const ids = (last?.actions ?? []).map((a) => a.id);
    expect(ids).toEqual([
      "command:resume",
      "command:status",
      "command:detach",
      "command:help",
    ]);
    // Resume retains primary styling — matches the previous
    // single-button shape for users who tap rather than read.
    const resume = last?.actions?.find((a) => a.id === "command:resume");
    expect(resume?.style).toBe("primary");
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
    // Today's catalog is 4 verbs and the test capability profile
    // grants well over 4 + 3 (nav) action slots — single page,
    // no navigation needed.
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
      kind: "status",
      text: expect.stringContaining("Turn: completed"),
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

    expect(harness.delivered.at(-2)).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "idle",
    });
    expect(harness.delivered.filter((intent) => intent.kind === "message")).toHaveLength(1);
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

  it("batches noisy default tool updates and flushes them before turn status", async () => {
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
    const statusIndex = harness.delivered.findIndex(
      (intent) => intent.kind === "status" && intent.status === "idle",
    );

    expect(batchIndex).toBeGreaterThanOrEqual(0);
    expect(statusIndex).toBeGreaterThan(batchIndex);
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

    expect(harness.delivered).toHaveLength(2);
    expect(harness.delivered.at(-2)).toMatchObject({
      kind: "activity",
      activity: "typing",
      state: "idle",
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Turn: completed"),
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
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: "Approval response sent.",
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
        decisions: [],
      }),
      expect.objectContaining({
        kind: "activity",
        activity: "typing",
        state: "active",
      }),
      expect.objectContaining({
        kind: "status",
        status: "working",
      }),
      expect.objectContaining({
        kind: "status",
        text: "Approval response sent.",
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
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: "Approval response sent.",
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
      expect.objectContaining({
        kind: "status",
        status: "working",
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
          id: "handoff:local-to-worktree",
          label: "Handoff to New Worktree",
        }),
      ]),
    });

    const toWorktree = findChoice(harness.delivered.at(-1), "handoff:local-to-worktree");
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
          label: "1. main",
        }),
      ]),
    });

    const leaveMain = findChoice(harness.delivered.at(-1), "handoff:select-leave-branch");
    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: leaveMain.id,
        value: leaveMain.value,
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      body: expect.stringContaining("Leave Local on: main"),
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
      leaveLocalBranch: "main",
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
    const toWorktree = findChoice(harness.delivered.at(-1), "handoff:local-to-worktree");
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
      label: "9. branch-9",
    });
    expect(secondPage.choices).toContainEqual(
      expect.objectContaining({
        id: "handoff:branches:previous",
        value: expect.objectContaining({ pageIndex: 0 }),
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
    const toWorktree = findChoice(harness.delivered.at(-1), "handoff:local-to-worktree");
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
    const toWorktree = findChoice(harness.delivered.at(-1), "handoff:local-to-worktree");
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
  deliver?: (intent: MessagingSurfaceIntent) => Promise<MessagingDeliveryResult>;
  downloadAttachment?: MessagingAdapter["downloadAttachment"];
  handoff?: false;
  inputDebounceMs?: number;
  logger?: MessagingControllerOptions["logger"];
  now?: () => number;
  /**
   * Set to `false` to construct the controller WITHOUT an
   * `onBindingChanged` callback. Used by tests that verify the
   * controller's nullish-callback guard — production callers always
   * supply one (see `messaging-runtime.ts`), but the option is
   * declared optional and the controller must not throw if it's
   * absent.
   */
  bindingChangedListener?: false;
  setConversationTitle?: MessagingAdapter["setConversationTitle"];
  toolUpdateDefaultMode?: MessagingToolUpdateMode;
}): Promise<{
  controller: MessagingController;
  compactThread: ReturnType<typeof vi.fn>;
  cancelThreadExecutionModeQueue: ReturnType<typeof vi.fn>;
  delivered: MessagingSurfaceIntent[];
  getNavigationSnapshot: ReturnType<typeof vi.fn>;
  handoffThreadWorkspace: ReturnType<typeof vi.fn> | undefined;
  interruptTurn: ReturnType<typeof vi.fn>;
  listBackends: ReturnType<typeof vi.fn>;
  onBindingChanged: ReturnType<typeof vi.fn>;
  readThreadStatus: ReturnType<typeof vi.fn>;
  setThreadExecutionMode: ReturnType<typeof vi.fn>;
  setThreadModelSettings: ReturnType<typeof vi.fn>;
  startThread: ReturnType<typeof vi.fn>;
  startTurn: ReturnType<typeof vi.fn>;
  steerTurn: ReturnType<typeof vi.fn>;
  submitServerRequest: ReturnType<typeof vi.fn>;
  store: MessagingStore;
}> {
  const store = await createStore();
  const delivered: MessagingSurfaceIntent[] = [];
  const adapter: MessagingAdapter = {
    capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
    ...(options?.downloadAttachment
      ? { downloadAttachment: options.downloadAttachment }
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
  const getNavigationSnapshot = vi.fn(async () => buildNavigationSnapshot());
  const startThread = vi.fn(async (request: StartThreadRequest) => ({
    backend: request.backend,
    threadId: "new-thread-1",
    executionMode: request.executionMode ?? "default",
  }));
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
  const listBackends = vi.fn(async (): Promise<ListBackendsResponse> => ({
    fetchedAt: 1000,
    backends: [buildBackendSummary()],
  }));
  const readThreadStatus = vi.fn(async () => undefined);
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
    listBackends,
    readThreadStatus,
    setThreadExecutionMode,
    setThreadModelSettings,
    startThread,
    startTurn,
    steerTurn,
    submitServerRequest,
  };

  const onBindingChanged = vi.fn();
  const controller = new MessagingController({
    adapter,
    authorizedActorIds: ["user-1"],
    backend,
    inputDebounceMs: options?.inputDebounceMs ?? 0,
    logger: options?.logger,
    now: options?.now ?? (() => 1000),
    // Pass the spy by default so tests can assert on fan-out. The
    // `bindingChangedListener: false` opt-out exists for tests that
    // verify the nullish-callback guard — production wiring always
    // supplies one.
    ...(options?.bindingChangedListener === false
      ? {}
      : { onBindingChanged }),
    store,
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
    listBackends,
    onBindingChanged,
    readThreadStatus,
    setThreadExecutionMode,
    setThreadModelSettings,
    startThread,
    startTurn,
    steerTurn,
    submitServerRequest,
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

function buildBackendSummary(): ListBackendsResponse["backends"][number] {
  return {
    kind: "codex",
    label: "Codex",
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
          id: "gpt-5.3-codex",
          label: "GPT-5.3 Codex",
        },
      ],
      reasoningEfforts: ["low", "medium", "high"],
      supportsFastMode: true,
    },
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

function buildTextEvent(text: string): MessagingInboundTextEvent {
  return {
    id: "event-text",
    kind: "text",
    actor: {
      platformUserId: "user-1",
    },
    channel: {
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    },
    receivedAt: 1000,
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
    channel: {
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
