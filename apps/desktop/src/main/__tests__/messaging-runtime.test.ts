import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  NavigationSnapshot,
  StartTurnRequest,
} from "@pwragent/shared";
import {
  PERMISSIVE_CAPABILITY_PROFILE,
  type MessagingChannelKind,
  type MessagingDeliveryResult,
  type MessagingInboundEvent,
  type MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import type { MessagingBackendBridge } from "../messaging/core/messaging-adapter";
import type {
  DesktopMessagingAdapter,
  DesktopMessagingAdapterFactory,
  DesktopMessagingRuntime,
} from "../messaging/messaging-runtime";

const messagingLog = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => messagingLog),
}));

const tempDirs: string[] = [];

beforeEach(() => {
  messagingLog.error.mockReset();
  messagingLog.info.mockReset();
  messagingLog.warn.mockReset();
});

afterEach(async () => {
  const { resetAppStateForTests } = await import("../state/app-state");
  resetAppStateForTests();
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(
    tempDirs.splice(0).map(async (tempDir) => {
      await rm(tempDir, { recursive: true, force: true });
    }),
  );
});

describe("DesktopMessagingRuntime", () => {
  it("starts configured adapters and routes inbound events through channel controllers", async () => {
    const { runtime, adapter, bridge } = await createRuntimeHarness();

    await runtime.start();
    await adapter.listener?.(buildCommandEvent("/resume"));

    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(bridge.getNavigationSnapshot).toHaveBeenCalledWith({
      backend: "all",
    });
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "thread_picker",
    });
  });

  it("requests messaging startup eligibility logging only for the startup config load", async () => {
    await prepareRuntimeStore();
    const adapter = createAdapter("telegram");
    const configLoader = vi.fn(() => ({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram" as const,
        botToken: "telegram-token",
        authorizedActorIds: ["user-1"],
      },
    }));
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      config: configLoader,
    });

    await runtime.start();
    await adapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );
    await bridge.emitBackendEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "command-1",
            type: "commandExecution",
            command: "pnpm test",
            status: "completed",
          },
        },
      },
    });

    expect(configLoader).toHaveBeenNthCalledWith(1, {
      logStartupEligibility: true,
    });
    expect(configLoader).toHaveBeenNthCalledWith(2, undefined);
  });

  it("uses adapter-supplied authorization without provider-specific runtime config", async () => {
    await prepareRuntimeStore();
    const adapter = createAdapter("custom", {
      authorizedActorIds: ["driver-1"],
    });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      config: {},
    });

    await runtime.start();
    await adapter.listener?.({
      ...buildCommandEvent("/resume"),
      actor: {
        platformUserId: "driver-1",
      },
      channel: {
        channel: "custom",
        conversation: {
          id: "chat-1",
          kind: "dm",
        },
      },
    });

    expect(messagingLog.warn).not.toHaveBeenCalled();
    expect(bridge.getNavigationSnapshot).toHaveBeenCalledWith({
      backend: "all",
    });
  });

  it("logs inbound controller failures without rejecting the adapter listener", async () => {
    const { runtime, adapter, bridge } = await createRuntimeHarness();
    vi.mocked(bridge.getNavigationSnapshot).mockRejectedValueOnce(
      new Error("navigation failed"),
    );

    await runtime.start();
    await expect(adapter.listener?.(buildCommandEvent("/resume"))).resolves
      .toBeUndefined();

    expect(messagingLog.error).toHaveBeenCalledWith(
      "messaging controller failed to handle inbound event",
      expect.objectContaining({
        channel: "telegram",
        conversationId: "chat-1",
        error: expect.any(Error),
        eventId: "event-command",
        eventKind: "command",
      }),
    );
  });

  it("forwards backend turn completions to bound channel adapters", async () => {
    const { runtime, adapter, emitBackendEvent } = await createRuntimeHarness();

    await runtime.start();
    await adapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );

    await emitBackendEvent({
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
                text: "Done",
              },
            ],
          },
        },
      },
    });
    await Promise.resolve();

    expect([...adapter.delivered].reverse().find((intent) => intent.kind === "message"))
      .toMatchObject({
        kind: "message",
        role: "assistant",
      });
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "status",
    });
  });

  it("routes backend approval requests to bound channel adapters", async () => {
    const { runtime, adapter, emitBackendEvent } = await createRuntimeHarness();

    await runtime.start();
    await adapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );
    adapter.delivered.length = 0;

    await emitBackendEvent({
      backend: "codex",
      notification: {
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "approval-1",
          prompt: "Run tests?",
          command: "pnpm test -- messaging-runtime",
        },
      },
    });

    expect(adapter.delivered.find((intent) => intent.kind === "approval"))
      .toMatchObject({
        kind: "approval",
        requestContext: {
          backend: "codex",
          requestId: "approval-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      });
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "status",
      status: "waiting",
    });
  });

  it("does not route backend requests to adapters for bindings owned by another channel", async () => {
    await prepareRuntimeStore();
    const telegramAdapter = createAdapter("telegram");
    const discordAdapter = createAdapter("discord");
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const bridge = createBackendBridge();
    const runtime = new Runtime({
      adapterFactory: () => [telegramAdapter, discordAdapter],
      backendBridge: bridge,
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: ["user-1"],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: ["user-1"],
        },
      },
    });

    await runtime.start();
    await telegramAdapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );
    telegramAdapter.delivered.length = 0;
    discordAdapter.delivered.length = 0;

    await bridge.emitBackendEvent({
      backend: "codex",
      notification: {
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "approval-1",
          prompt: "Run tests?",
          command: "pnpm test -- messaging-runtime",
        },
      },
    });

    expect(telegramAdapter.delivered.find((intent) => intent.kind === "approval"))
      .toMatchObject({
        kind: "approval",
      });
    expect(discordAdapter.delivered).toEqual([]);
  });

  it("clears resolved approval buttons through the owning channel adapter only", async () => {
    await prepareRuntimeStore();
    const telegramAdapter = createAdapter("telegram");
    const discordAdapter = createAdapter("discord");
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const bridge = createBackendBridge();
    const runtime = new Runtime({
      adapterFactory: () => [telegramAdapter, discordAdapter],
      backendBridge: bridge,
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: ["user-1"],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: ["user-1"],
        },
      },
    });

    await runtime.start();
    await telegramAdapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );

    await bridge.emitBackendEvent({
      backend: "codex",
      notification: {
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "approval-1",
          prompt: "Run tests?",
          command: "pnpm test -- messaging-runtime",
        },
      },
    });
    telegramAdapter.delivered.length = 0;
    discordAdapter.delivered.length = 0;

    await bridge.emitBackendEvent({
      backend: "codex",
      notification: {
        method: "serverRequest/resolved",
        params: {
          threadId: "thread-1",
          requestId: "approval-1",
        },
      },
    });

    expect(
      telegramAdapter.delivered.find(
        (intent) => intent.kind === "approval" && intent.decisions.length === 0,
      ),
    ).toMatchObject({
      kind: "approval",
      decisions: [],
      delivery: {
        mode: "update",
        replaceMarkup: true,
      },
    });
    expect(discordAdapter.delivered).toEqual([]);
  });

  it("routes backend user-input requests to bound channel adapters", async () => {
    const { runtime, adapter, emitBackendEvent } = await createRuntimeHarness();

    await runtime.start();
    await adapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );
    adapter.delivered.length = 0;

    await emitBackendEvent({
      backend: "codex",
      notification: {
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "input-1",
          questions: [
            {
              id: "q1",
              header: "Mode",
              question: "How should I proceed?",
              isOther: true,
              isSecret: false,
              options: [
                {
                  label: "Implement",
                  description: "Start coding.",
                },
              ],
            },
          ],
        },
      },
    });

    expect(adapter.delivered.find((intent) => intent.kind === "questionnaire"))
      .toMatchObject({
        kind: "questionnaire",
        requestContext: {
          backend: "codex",
          requestId: "input-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      });
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "status",
      status: "waiting",
    });
  });

  it("logs rejected inbound actor ids before returning the authorization error", async () => {
    const { runtime, adapter } = await createRuntimeHarness();

    await runtime.start();
    const event = buildCommandEvent("/resume");
    event.actor = {
      displayName: "Other User",
      platformUserId: "user-2",
      username: "other",
    };
    await adapter.listener?.(event);

    expect(messagingLog.warn).toHaveBeenCalledWith(
      "messaging event rejected by authorization",
      expect.objectContaining({
        actorDisplayName: "Other User",
        actorId: "user-2",
        actorUsername: "other",
        authorizedActorCount: 1,
        channel: "telegram",
        conversationId: "chat-1",
        conversationKind: "dm",
        eventId: "event-command",
        eventKind: "command",
      }),
    );
    expect(adapter.delivered.at(-1)).toMatchObject({
      body: "This channel user is not authorized to control PwrAgent.",
      kind: "error",
      title: "Not authorized",
    });
  });

  it("keeps other adapters available when one adapter fails during startup", async () => {
    await prepareRuntimeStore();
    const failingAdapter = createAdapter("telegram", {
      start: vi.fn(async () => {
        throw new Error("telegram unavailable");
      }),
    });
    const workingAdapter = createAdapter("discord");
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const bridge = createBackendBridge();
    const runtime = new Runtime({
      adapterFactory: () => [failingAdapter, workingAdapter],
      backendBridge: bridge,
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: ["user-1"],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: ["user-1"],
        },
      },
    });

    await runtime.start();

    expect(workingAdapter.start).toHaveBeenCalledTimes(1);
    expect(messagingLog.error).toHaveBeenCalledWith(
      "telegram: failed to start adapter",
      expect.objectContaining({
        channel: "telegram",
      }),
    );
    expect(messagingLog.info).toHaveBeenCalledWith(
      "messaging runtime started",
      expect.objectContaining({
        started: ["discord"],
        failed: ["telegram"],
      }),
    );
  });

  it("isolates backend event delivery failures between adapters", async () => {
    await prepareRuntimeStore();
    const failingAdapter = createAdapter("telegram", {
      deliver: vi.fn(async (
        intent: MessagingSurfaceIntent,
      ): Promise<MessagingDeliveryResult> => {
        if (intent.kind === "message") {
          throw new Error("telegram delivery failed");
        }
        failingAdapter.delivered.push(intent);
        return {
          channel: "telegram",
          deliveredAt: 1000,
          outcome: "presented",
        };
      }),
    });
    const workingAdapter = createAdapter("discord");
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const bridge = createBackendBridge();
    const runtime = new Runtime({
      adapterFactory: () => [failingAdapter, workingAdapter],
      backendBridge: bridge,
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: ["user-1"],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: ["user-1"],
        },
      },
    });

    await runtime.start();
    await failingAdapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );
    await workingAdapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }, "discord"),
    );
    failingAdapter.delivered.length = 0;
    workingAdapter.delivered.length = 0;

    await bridge.emitBackendEvent({
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
                text: "Still delivered elsewhere",
              },
            ],
          },
        },
      },
    });

    expect(messagingLog.error).toHaveBeenCalledWith(
      "messaging controller failed to handle backend event",
      expect.objectContaining({
        backend: "codex",
        method: "turn/completed",
      }),
    );
    expect(workingAdapter.delivered.find((intent) => intent.kind === "message"))
      .toMatchObject({
        kind: "message",
      });
  });

  it("stops the started adapter instances without rebuilding the factory", async () => {
    await prepareRuntimeStore();
    const adapter = createAdapter("telegram");
    const factory = vi.fn<DesktopMessagingAdapterFactory>(() => [adapter]);
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: ["user-1"],
        },
      },
    });

    await runtime.start();
    await runtime.stop();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(adapter.stop).toHaveBeenCalledTimes(1);
  });
});

async function createRuntimeHarness(): Promise<{
  DesktopMessagingRuntime: typeof DesktopMessagingRuntime;
  adapter: ReturnType<typeof createAdapter>;
  bridge: ReturnType<typeof createBackendBridge>;
  emitBackendEvent: (event: AgentEvent) => Promise<void>;
  runtime: DesktopMessagingRuntime;
}> {
  await prepareRuntimeStore();

  const adapter = createAdapter("telegram");
  const bridge = createBackendBridge();
  const { DesktopMessagingRuntime: Runtime } = await import(
    "../messaging/messaging-runtime"
  );
  const runtime = new Runtime({
    adapterFactory: () => [adapter],
    backendBridge: bridge,
    config: {
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: ["user-1"],
      },
    },
  });

  return {
    DesktopMessagingRuntime: Runtime,
    adapter,
    bridge,
    emitBackendEvent: bridge.emitBackendEvent,
    runtime,
  };
}

async function prepareRuntimeStore(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-runtime-"));
  tempDirs.push(tempDir);
  vi.stubEnv("PWRAGENT_HOME", tempDir);
  const { initializeAppState, resetAppStateForTests } = await import(
    "../state/app-state"
  );
  resetAppStateForTests();
  initializeAppState();
  const { resetDesktopMessagingStoreForTests } = await import(
    "../messaging/desktop-messaging-store"
  );
  resetDesktopMessagingStoreForTests();
}

function createAdapter(
  channel: MessagingChannelKind,
  overrides: Partial<DesktopMessagingAdapter> = {},
): DesktopMessagingAdapter & {
  delivered: MessagingSurfaceIntent[];
  listener?: (event: MessagingInboundEvent) => Promise<void>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const delivered: MessagingSurfaceIntent[] = [];
  const adapter = {
    authorizedActorIds: ["user-1"],
    capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
    channel,
    delivered,
    deliver: vi.fn(async (intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult> => {
      delivered.push(intent);
      return {
        channel,
        deliveredAt: 1000,
        outcome: "presented",
        surface: {
          channel,
          id: `${channel}:${intent.id}`,
        },
      };
    }),
    start: vi.fn(async (listener: (event: MessagingInboundEvent) => Promise<void>) => {
      adapter.listener = listener;
    }),
    stop: vi.fn(async () => {}),
  } as DesktopMessagingAdapter & {
    delivered: MessagingSurfaceIntent[];
    listener?: (event: MessagingInboundEvent) => Promise<void>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
  Object.assign(adapter, overrides);

  return adapter;
}

function createBackendBridge(): MessagingBackendBridge & {
  emitBackendEvent: (event: AgentEvent) => Promise<void>;
  onEvent: (listener: (event: AgentEvent) => void | Promise<void>) => () => void;
} {
  const backendListeners = new Set<(event: AgentEvent) => void | Promise<void>>();

  return {
    getNavigationSnapshot: vi.fn(async () => buildNavigationSnapshot()),
    startTurn: vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-1",
    })),
    onEvent: vi.fn((listener: (event: AgentEvent) => void | Promise<void>) => {
      backendListeners.add(listener);
      return () => {
        backendListeners.delete(listener);
      };
    }),
    emitBackendEvent: async (event: AgentEvent) => {
      await Promise.all(
        [...backendListeners].map(async (listener) => {
          await listener(event);
        }),
      );
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

function buildCommandEvent(rawText: string): MessagingInboundEvent & { kind: "command" } {
  const command = rawText.replace(/^\//, "").split(/\s+/, 1)[0] ?? "";
  return {
    id: "event-command",
    kind: "command",
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
    command,
    args: [],
    rawText,
    receivedAt: 1000,
  };
}

function buildCallbackEvent(
  actionId: string,
  value: NonNullable<Extract<MessagingInboundEvent, { kind: "callback" }>["value"]>,
  channel: MessagingChannelKind = "telegram",
): Extract<MessagingInboundEvent, { kind: "callback" }> {
  return {
    id: "event-callback",
    kind: "callback",
    actor: {
      platformUserId: "user-1",
    },
    channel: {
      channel,
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    },
    interaction: {
      channel,
      id: actionId,
    },
    actionId,
    value,
    receivedAt: 1000,
  };
}
