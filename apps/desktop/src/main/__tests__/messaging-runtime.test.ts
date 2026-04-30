import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  MessagingDeliveryResult,
  MessagingInboundEvent,
  MessagingSurfaceIntent,
  NavigationSnapshot,
  StartTurnRequest,
} from "@pwragnt/shared";
import type { MessagingBackendBridge } from "@pwragnt/agent-core";
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
    await adapter.listener?.(buildCommandEvent("/threads"));

    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(bridge.getNavigationSnapshot).toHaveBeenCalledWith({
      backend: "all",
    });
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "thread_picker",
    });
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

  it("logs rejected inbound actor ids before returning the authorization error", async () => {
    const { runtime, adapter } = await createRuntimeHarness();

    await runtime.start();
    const event = buildCommandEvent("/threads");
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
      body: "This channel user is not authorized to control PwrAgnt.",
      kind: "error",
      title: "Not authorized",
    });
  });

  it("keeps other adapters available when one adapter fails during startup", async () => {
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
      "messaging adapter failed to start",
      expect.objectContaining({
        channel: "telegram",
      }),
    );
    expect(messagingLog.info).toHaveBeenCalledWith(
      "messaging runtime started",
      expect.objectContaining({
        adapters: ["discord"],
      }),
    );
  });

  it("stops the started adapter instances without rebuilding the factory", async () => {
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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-runtime-"));
  tempDirs.push(tempDir);
  vi.stubEnv("PWRAGNT_STATE_ROOT", tempDir);
  const { resetDesktopMessagingStoreForTests } = await import(
    "../messaging/desktop-messaging-store"
  );
  resetDesktopMessagingStoreForTests();

  const adapter = createAdapter("telegram");
  const bridge = createBackendBridge();
  const { DesktopMessagingRuntime: Runtime } = await import(
    "../messaging/messaging-runtime"
  );
  const runtime = new Runtime({
    adapterFactory: () => [adapter],
    backendBridge: bridge,
    config: {
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

function createAdapter(
  channel: "telegram" | "discord",
  overrides: Partial<DesktopMessagingAdapter> = {},
): DesktopMessagingAdapter & {
  delivered: MessagingSurfaceIntent[];
  listener?: (event: MessagingInboundEvent) => Promise<void>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const delivered: MessagingSurfaceIntent[] = [];
  const adapter = {
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
): Extract<MessagingInboundEvent, { kind: "callback" }> {
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
    interaction: {
      channel: "telegram",
      id: actionId,
    },
    actionId,
    value,
    receivedAt: 1000,
  };
}
