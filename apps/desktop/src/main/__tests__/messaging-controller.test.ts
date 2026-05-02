import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  AppServerPendingRequestNotification,
  HandoffThreadWorkspaceRequest,
  ListBackendsResponse,
  MessagingSurfaceAction,
  MessagingDeliveryResult,
  MessagingInboundCallbackEvent,
  MessagingInboundEvent,
  MessagingInboundTextEvent,
  MessagingSurfaceIntent,
  MessagingToolUpdateMode,
  NavigationSnapshot,
  StartThreadRequest,
  StartTurnRequest,
  SubmitServerRequestRequest,
} from "@pwragnt/shared";
import {
  MessagingController,
  type MessagingControllerOptions,
} from "../messaging/core/messaging-controller";
import type { MessagingAdapter, MessagingBackendBridge } from "../messaging/core/messaging-adapter";
import { MessagingStore } from "../messaging/core/messaging-store";

const tempDirs: string[] = [];

async function createStore(): Promise<MessagingStore> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-controller-"));
  tempDirs.push(tempDir);
  return new MessagingStore(path.join(tempDir, "messaging-state.json"));
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (tempDir) => {
      await rm(tempDir, { recursive: true, force: true });
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
      fallbackText: expect.stringContaining("Showing recent PwrAgnt threads."),
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
            label: "PwrAgnt",
          }),
        ],
      },
    });

    await harness.controller.handleInboundEvent(
      buildCallbackEvent({
        actionId: "browse:select-project",
        value: {
          directoryKey: "directory:pwragnt",
          label: "PwrAgnt",
          path: "/repo/pwragnt",
        },
      }),
    );

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "thread_picker",
      fallbackText: expect.stringContaining("PwrAgnt"),
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
          directoryKey: "directory:pwragnt",
          label: "PwrAgnt",
          path: "/repo/pwragnt",
        },
      }),
    );

    expect(harness.startThread).toHaveBeenCalledWith({
      backend: "codex",
      cwd: "/repo/pwragnt",
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
      text: expect.stringContaining("Project: PwrAgnt"),
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
      text: expect.stringContaining("Project: PwrAgnt"),
    });
    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/status").channel),
    ).resolves.toMatchObject({
      statusSurface: {
        id: `surface:${statusIntents[2]?.id}`,
      },
    });
  });

  it("detaches a bound conversation and unpins the status surface", async () => {
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

    await harness.controller.handleInboundEvent(buildCommandEvent("/detach"));

    expect(harness.delivered.at(-2)).toMatchObject({
      kind: "dismiss",
      delivery: {
        unpin: true,
      },
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

  it("does not treat legacy /threads as a resume alias", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/threads"));

    expect(harness.getNavigationSnapshot).not.toHaveBeenCalled();
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "PwrAgnt",
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
      repositoryPath: "/repo/pwragnt",
      sourceBranch: "feature/handoff",
      sourcePath: "/repo/pwragnt",
      threadId: "thread-1",
    });
    expect(harness.delivered.at(-2)).toMatchObject({
      kind: "status",
      status: "completed",
      text: expect.stringContaining("/repo/pwragnt/.worktrees/pwragnt-feature-handoff"),
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining(
        "Worktree: /repo/pwragnt/.worktrees/pwragnt-feature-handoff",
      ),
    });
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
      repositoryPath: "/repo/pwragnt",
      sourceBranch: "feature/handoff",
      sourcePath: "/repo/pwragnt/.worktrees/pwragnt-feature-handoff",
      threadId: "thread-1",
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Directory: /repo/pwragnt"),
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
  logger?: MessagingControllerOptions["logger"];
  now?: () => number;
  setConversationTitle?: MessagingAdapter["setConversationTitle"];
  toolUpdateDefaultMode?: MessagingToolUpdateMode;
}): Promise<{
  controller: MessagingController;
  compactThread: ReturnType<typeof vi.fn>;
  delivered: MessagingSurfaceIntent[];
  getNavigationSnapshot: ReturnType<typeof vi.fn>;
  handoffThreadWorkspace: ReturnType<typeof vi.fn> | undefined;
  interruptTurn: ReturnType<typeof vi.fn>;
  listBackends: ReturnType<typeof vi.fn>;
  readThreadStatus: ReturnType<typeof vi.fn>;
  setThreadExecutionMode: ReturnType<typeof vi.fn>;
  setThreadModelSettings: ReturnType<typeof vi.fn>;
  startThread: ReturnType<typeof vi.fn>;
  startTurn: ReturnType<typeof vi.fn>;
  submitServerRequest: ReturnType<typeof vi.fn>;
  store: MessagingStore;
}> {
  const store = await createStore();
  const delivered: MessagingSurfaceIntent[] = [];
  const adapter: MessagingAdapter = {
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
  const compactThread = vi.fn(async (request) => ({
    ...request,
    turnId: "compact-turn-1",
    itemId: "compact-item-1",
  }));
  const interruptTurn = vi.fn(async (request) => request);
  const setThreadExecutionMode = vi.fn(async (request) => request);
  const setThreadModelSettings = vi.fn(async (request) => request);
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
          repositoryPath: request.repositoryPath ?? "/repo/pwragnt",
          targetPath: request.direction === "local-to-worktree"
            ? "/repo/pwragnt/.worktrees/pwragnt-feature-handoff"
            : "/repo/pwragnt",
          linkedDirectory: request.direction === "local-to-worktree"
            ? {
                id: "pwragnt-handoff:codex:thread-1",
                kind: "worktree" as const,
                label: "PwrAgnt",
                path: "/repo/pwragnt",
                worktreePath: "/repo/pwragnt/.worktrees/pwragnt-feature-handoff",
              }
            : {
                id: "directory:pwragnt",
                kind: "local" as const,
                label: "PwrAgnt",
                path: "/repo/pwragnt",
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
    getNavigationSnapshot,
    ...(handoffThreadWorkspace ? { handoffThreadWorkspace } : {}),
    interruptTurn,
    listBackends,
    readThreadStatus,
    setThreadExecutionMode,
    setThreadModelSettings,
    startThread,
    startTurn,
    submitServerRequest,
  };

  return {
    controller: new MessagingController({
      adapter,
      authorizedActorIds: ["user-1"],
      backend,
      logger: options?.logger,
      now: options?.now ?? (() => 1000),
      store,
      toolUpdateDefaultMode: options?.toolUpdateDefaultMode,
    }),
    compactThread,
    delivered,
    getNavigationSnapshot,
    handoffThreadWorkspace,
    interruptTurn,
    listBackends,
    readThreadStatus,
    setThreadExecutionMode,
    setThreadModelSettings,
    startThread,
    startTurn,
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
            id: "directory:pwragnt",
            kind: "local",
            label: "PwrAgnt",
            path: "/repo/pwragnt",
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
        key: "directory:pwragnt",
        kind: "directory",
        label: "PwrAgnt",
        path: "/repo/pwragnt",
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
        id: "pwragnt-handoff:codex:thread-1",
        kind: "worktree",
        label: "PwrAgnt",
        path: "/repo/pwragnt",
        worktreePath: "/repo/pwragnt/.worktrees/pwragnt-feature-handoff",
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
      id: params.actionId,
    },
    actionId: params.actionId,
    value: params.value,
  };
}
