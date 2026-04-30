import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  AppServerPendingRequestNotification,
  MessagingInboundCallbackEvent,
  MessagingInboundEvent,
  MessagingInboundTextEvent,
  MessagingSurfaceIntent,
  NavigationSnapshot,
  StartTurnRequest,
  SubmitServerRequestRequest,
} from "@pwragnt/shared";
import { MessagingController } from "../messaging/messaging-controller";
import type { MessagingAdapter, MessagingBackendBridge } from "../messaging/messaging-adapter";
import { MessagingStore } from "../messaging/messaging-store";

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
  it("presents a channel-neutral thread picker for authorized /threads commands", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(buildCommandEvent("/threads"));

    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered[0]).toMatchObject({
      kind: "thread_picker",
      fallbackText: "Reply with a number to bind, or Next for more threads.",
    });
    expect(JSON.stringify(harness.delivered[0])).not.toMatch(/callback_data|custom_id/);
    await expect(harness.store.getPendingIntent(harness.delivered[0]!.id, { now: 1000 }))
      .resolves.toMatchObject({
        channel: {
          channel: "telegram",
        },
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
      harness.store.findActiveBindingForChannel(buildCommandEvent("/threads").channel),
    ).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      authorizedActorIds: ["user-1"],
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Thread bound",
    });
  });

  it("maps text fallback replies against pending picker actions", async () => {
    const harness = await createHarness();
    await harness.controller.handleInboundEvent(buildCommandEvent("/threads"));

    await harness.controller.handleInboundEvent(buildTextEvent("1"));

    await expect(
      harness.store.findActiveBindingForChannel(buildCommandEvent("/threads").channel),
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

    expect(harness.startTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      input: [
        {
          type: "text",
          text: "please run the tests",
        },
      ],
    });
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "status",
      status: "working",
    });
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
        actionId: "command:threads",
      }),
    );

    expect(harness.getNavigationSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "thread_picker",
    });
  });

  it("rejects unauthorized actors without revealing thread data", async () => {
    const harness = await createHarness();

    await harness.controller.handleInboundEvent(
      buildCommandEvent("/threads", {
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
      disposition: "unsupported",
    });

    expect(harness.startTurn).not.toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.arrayContaining([expect.objectContaining({ type: "file" })]),
      }),
    );
    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Media is not supported yet",
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

    expect(harness.delivered.at(-1)).toMatchObject({
      kind: "message",
      role: "assistant",
      parts: [
        expect.objectContaining({
          markdown: "markdown",
        }),
      ],
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
      },
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
});

async function createHarness(): Promise<{
  controller: MessagingController;
  delivered: MessagingSurfaceIntent[];
  getNavigationSnapshot: ReturnType<typeof vi.fn>;
  startTurn: ReturnType<typeof vi.fn>;
  submitServerRequest: ReturnType<typeof vi.fn>;
  store: MessagingStore;
}> {
  const store = await createStore();
  const delivered: MessagingSurfaceIntent[] = [];
  const adapter: MessagingAdapter = {
    deliver: vi.fn(async (intent) => {
      delivered.push(intent);
      return {
        channel: "telegram" as const,
        deliveredAt: 1000,
        outcome: "presented" as const,
        surface: {
          channel: "telegram" as const,
          id: `surface:${intent.id}`,
        },
      };
    }),
  };
  const getNavigationSnapshot = vi.fn(async () => buildNavigationSnapshot());
  const startTurn = vi.fn(async (request: StartTurnRequest) => ({
    backend: request.backend,
    threadId: request.threadId,
    turnId: "turn-1",
  }));
  const submitServerRequest = vi.fn(async (request: SubmitServerRequestRequest) => ({
    backend: request.backend,
    threadId: request.threadId,
    turnId: request.turnId,
    requestId: request.requestId,
  }));
  const backend: MessagingBackendBridge = {
    getNavigationSnapshot,
    startTurn,
    submitServerRequest,
  };

  return {
    controller: new MessagingController({
      adapter,
      authorizedActorIds: ["user-1"],
      backend,
      now: () => 1000,
      store,
    }),
    delivered,
    getNavigationSnapshot,
    startTurn,
    submitServerRequest,
    store,
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
        linkedDirectories: [],
        inbox: {
          inInbox: false,
        },
      },
    ],
    inboxThreadKeys: [],
    directories: [],
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
    },
  };
}

function buildCommandEvent(
  rawText: string,
  actor: { platformUserId: string; username?: string } = { platformUserId: "user-1" },
): MessagingInboundEvent & { kind: "command" } {
  const command = rawText.replace(/^\//, "").split(/\s+/, 1)[0] ?? "";
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
    args: [],
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

function buildCallbackEvent(params: {
  actionId: string;
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
    interaction: {
      channel: "telegram",
      id: params.actionId,
    },
    actionId: params.actionId,
    value: params.value,
  };
}
