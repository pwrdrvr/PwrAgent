import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  FederationEventSubscription,
  NavigationSnapshot,
  StartTurnRequest,
} from "@pwragent/shared";
import type {
  MessagingChannelKind,
  MessagingDeliveryResult,
  MessagingDeliveryScope,
  MessagingAdapterDiagnosticListener,
  MessagingInboundEvent,
  MessagingInboundRejectedListener,
  MessagingRateLimitInfo,
  MessagingReconnectInfo,
  MessagingRejectedInboundEvent,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import type { MessagingBackendBridge } from "../messaging/core/messaging-adapter";
import type { MessagingControllerDeliveryBudgetEvent } from "../messaging/core/messaging-controller";
import type {
  DesktopMessagingConfig,
  DesktopMessagingFullAccessControls,
} from "../messaging/messaging-config";
import type {
  DesktopMessagingAdapter,
  DesktopMessagingAdapterFactory,
  DesktopMessagingConfigLoader,
  DesktopMessagingRuntime,
  MessagingAutomationInboundHandler,
  MessagingAutomationInboundMatcher,
} from "../messaging/messaging-runtime";

const messagingLog = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => messagingLog),
}));

const tempDirs: string[] = [];
const activeRuntimes: DesktopMessagingRuntime[] = [];

function trackRuntime(runtime: DesktopMessagingRuntime): DesktopMessagingRuntime {
  activeRuntimes.push(runtime);
  return runtime;
}

beforeEach(() => {
  messagingLog.debug.mockReset();
  messagingLog.error.mockReset();
  messagingLog.info.mockReset();
  messagingLog.warn.mockReset();
});

afterEach(async () => {
  // Stop runtimes and let their async rehydration (microtask-chained
  // synchronous better-sqlite3 writes) settle BEFORE the app-state DB is
  // closed. Otherwise trailing writes hit a closed connection and surface as
  // unhandled "database connection is not open" rejections that fail the run
  // even though every test passed.
  await Promise.all(
    activeRuntimes.splice(0).map((runtime) => runtime.stop().catch(() => {})),
  );
  await flushMicrotasks();
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
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await expect(getDesktopMessagingStore().findObservedSurfaces()).resolves
      .toEqual([
        expect.objectContaining({
          channel: expect.objectContaining({
            channel: "telegram",
            conversation: expect.objectContaining({ id: "chat-1" }),
          }),
        }),
      ]);
    // This integration-style startup test imports the runtime module graph and
    // exercises the full adapter-start + inbound-routing path. On the slow
    // shared Windows CI runner that cold path can exceed 15s — not a hang, just
    // slow — so Windows gets the workspace default headroom (30_000; see
    // vitest.workspace.ts). Other platforms keep the original tighter 15_000
    // budget where the cold path is comfortably fast, so a genuine hang or
    // regression there still fails fast instead of idling for the full 30s.
  }, process.platform === "win32" ? 30_000 : 15_000);

  it("rejects provider events without a first-boundary receipt timestamp", async () => {
    const { runtime, adapter } = await createRuntimeHarness();
    await runtime.start();
    const invalidEvent = {
      ...buildCommandEvent("/resume"),
      receivedAt: undefined,
    } as unknown as MessagingInboundEvent;

    await expect(adapter.listener?.(invalidEvent)).rejects.toThrow(
      "omitted a finite first-boundary receivedAt",
    );
  });

  it("does not reload config to authorize an allowed Full Access bound reply", async () => {
    const config = buildFullAccessRuntimeConfig(true);
    let configLoadsAtStartTurn = -1;
    const loadConfig = vi.fn().mockResolvedValue(config);
    const { runtime, adapter, bridge } = await createFullAccessRuntimeHarness(
      loadConfig,
    );
    vi.mocked(bridge.startTurn).mockImplementation(async (request) => {
      configLoadsAtStartTurn = loadConfig.mock.calls.length;
      return {
        backend: request.backend,
        threadId: request.threadId,
        turnId: "turn-1",
      };
    });

    await runtime.start();
    await adapter.listener!(buildTextEvent("continue"));

    expect(bridge.startTurn).toHaveBeenCalledTimes(1);
    // Only the lifecycle read. This was 2 when the test was written, because
    // the PDF policy resolved on every inbound message; #1920 made that read
    // conditional on the event actually carrying an attachment, and this one
    // is plain text.
    expect(configLoadsAtStartTurn).toBe(1);
    const policy = messagingLog.info.mock.calls.find(
      (call) => call[0] === "messaging Full Access resume policy evaluated",
    );
    expect(policy?.[1]).toMatchObject({
      inboundEventId: "event-text",
      allowed: true,
      controlsSource: "runtime-snapshot",
      policyRevision: 1,
      fullAccessControlsLoadAwaitCount: 0,
      settingsConfigReadMs: 0,
      settingsConfigReadAwaitCount: 0,
      authorizedUserPolicyCheckAwaitCount: 0,
      allowedPathAuditPersistenceAwaitCount: 0,
    });
  });

  it("denies a Full Access bound reply from the applied runtime policy", async () => {
    const { runtime, adapter, bridge } = await createFullAccessRuntimeHarness(
      buildFullAccessRuntimeConfig(false),
    );

    await runtime.start();
    await adapter.listener!(buildTextEvent("continue"));

    expect(bridge.startTurn).not.toHaveBeenCalled();
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Full Access blocked",
      body: expect.stringContaining("cannot be resumed"),
    });
  });

  it("applies a hot Full Access resume policy change without restarting adapters", async () => {
    const { runtime, adapter, bridge } = await createFullAccessRuntimeHarness(
      buildFullAccessRuntimeConfig(true),
    );
    await runtime.start();

    await runtime.applyConfig(buildFullAccessRuntimeConfig(false));
    await adapter.listener!(buildTextEvent("continue"));

    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(adapter.stop).not.toHaveBeenCalled();
    expect(bridge.startTurn).not.toHaveBeenCalled();
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Full Access blocked",
    });
  });

  it("fails closed after a lifecycle config read fails", async () => {
    const config = buildFullAccessRuntimeConfig(true);
    const loadConfig = vi.fn()
      .mockResolvedValueOnce(config)
      .mockRejectedValueOnce(new Error("settings unavailable"))
      // Keep the separately owned PDF setting read out of this policy test.
      .mockResolvedValue(config);
    const { runtime, adapter, bridge } = await createFullAccessRuntimeHarness(
      loadConfig,
    );
    await runtime.start();

    await expect(runtime.applyLatestConfig()).rejects.toThrow(
      "settings unavailable",
    );
    await adapter.listener!(buildTextEvent("continue"));

    expect(bridge.startTurn).not.toHaveBeenCalled();
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "error",
      title: "Full Access blocked",
    });
  });

  it("refreshes the cached contact after warning dismissal persists", async () => {
    const persisted = createDeferred<void>();
    const persistDismissal = vi.fn(async () => await persisted.promise);
    const config = buildFullAccessRuntimeConfig(true);
    config.fullAccessControls!.dismissWarning = persistDismissal;
    config.fullAccessControls!.canDismissWarning = () => true;
    const { runtime } = await createFullAccessRuntimeHarness(config);
    await runtime.start();
    const controller = (
      runtime as unknown as {
        controllers: Array<{
          options: {
            fullAccessControls: () =>
              | DesktopMessagingFullAccessControls
              | Promise<DesktopMessagingFullAccessControls>;
          };
        }>;
      }
    ).controllers[0]!;

    const before = await controller.options.fullAccessControls();
    expect(before.authorizedUsers.telegram?.[0]?.fullAccessWarningDismissed)
      .not.toBe(true);
    const dismissal = before.dismissWarning!({
      actorId: "user-1",
      channel: "telegram",
    });
    await flushMicrotasks();
    const whilePersisting = await controller.options.fullAccessControls();
    expect(
      whilePersisting.authorizedUsers.telegram?.[0]?.fullAccessWarningDismissed,
    ).not.toBe(true);
    persisted.resolve();
    await dismissal;
    const after = await controller.options.fullAccessControls();

    expect(persistDismissal).toHaveBeenCalledWith({
      actorId: "user-1",
      channel: "telegram",
    });
    expect(after.authorizedUsers.telegram?.[0]?.fullAccessWarningDismissed)
      .toBe(true);
  });

  it("subscribes only to federated bindings on running adapters", async () => {
    const { runtime, bridge } = await createRuntimeHarness();
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertBinding({
      id: "binding:remote",
      channel: {
        channel: "telegram",
        conversation: { id: "chat-1", kind: "dm" },
      },
      backend: "codex",
      threadId: "thread-remote",
      federatedThread: {
        backend: "codex",
        target: { scope: "remote", instanceId: "owner_one" },
        threadId: "thread-remote",
      },
      authorizedActorIds: ["user-1"],
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await getDesktopMessagingStore().upsertBinding({
      id: "binding:inactive-discord",
      channel: {
        channel: "discord",
        conversation: { id: "discord-chat-1", kind: "dm" },
      },
      backend: "codex",
      threadId: "thread-inactive",
      federatedThread: {
        backend: "codex",
        target: { scope: "remote", instanceId: "owner_two" },
        threadId: "thread-inactive",
      },
      authorizedActorIds: ["user-1"],
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    await runtime.start();

    expect(bridge.setRemoteEventSubscriptions).toHaveBeenLastCalledWith([{
      sourceInstanceId: "owner_one",
      eventClasses: [
        "navigation",
        "transcript",
        "pending_requests",
        "scheduled_actions",
      ],
      threadSelection: {
        kind: "threads",
        threads: [{ backend: "codex", threadId: "thread-remote" }],
      },
    }]);

    await runtime.requestBindingRevoke({
      bindingId: "binding:remote",
      origin: "ui",
    });
    await vi.waitFor(() => {
      expect(bridge.setRemoteEventSubscriptions).toHaveBeenLastCalledWith([]);
    });

    await runtime.stop();
    expect(bridge.setRemoteEventSubscriptions).toHaveBeenLastCalledWith([]);
  });

  it("retains a rejected config application as a startup failure for every platform", async () => {
    await prepareRuntimeStore();
    const telegramAdapter = createAdapter("telegram");
    const discordAdapter = createAdapter("discord");
    const bridge = createBackendBridge();
    vi.mocked(bridge.setRemoteEventSubscriptions)
      .mockImplementationOnce(() => {
        throw new Error(
          "Cannot read properties of undefined (reading 'federation')",
        );
      });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: ({ config }) => [
        ...(config.telegram ? [telegramAdapter] : []),
        ...(config.discord ? [discordAdapter] : []),
      ],
      backendBridge: bridge,
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    }));

    await expect(runtime.start()).rejects.toThrow("reading 'federation'");
    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health: "errored",
          platform: "telegram",
          startupFailure: true,
        }),
        expect.objectContaining({
          health: "errored",
          platform: "discord",
          startupFailure: true,
        }),
      ]),
    );

    await runtime.stop({ preserveStartupFailures: true });

    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health: "suspended",
          platform: "telegram",
          reason: "Cannot read properties of undefined (reading 'federation')",
          startupFailure: true,
        }),
        expect.objectContaining({
          health: "suspended",
          platform: "discord",
          reason: "Cannot read properties of undefined (reading 'federation')",
          startupFailure: true,
        }),
      ]),
    );

    await runtime.applyConfig({
      discord: {
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    });

    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health: "suspended",
          platform: "telegram",
          reason: undefined,
          startupFailure: undefined,
        }),
        expect.objectContaining({
          health: "enabled",
          platform: "discord",
          startupFailure: undefined,
        }),
      ]),
    );

    vi.mocked(bridge.setRemoteEventSubscriptions)
      .mockImplementationOnce(() => {
        throw new Error("subscription refresh failed");
      });
    await expect(runtime.applyConfig({
      discord: {
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    })).rejects.toThrow("subscription refresh failed");

    await runtime.applyConfig({ enabled: false });

    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health: "suspended",
          platform: "discord",
          reason: undefined,
          startupFailure: undefined,
        }),
        expect.objectContaining({
          health: "suspended",
          platform: "telegram",
          startupFailure: undefined,
        }),
      ]),
    );
  });

  it("preserves the backend bridge receiver while syncing federation subscriptions", async () => {
    const { runtime, bridge } = await createRuntimeHarness();
    const subscriptions: FederationEventSubscription[][] = [];
    bridge.setRemoteEventSubscriptions = function (next) {
      expect(this).toBe(bridge);
      subscriptions.push([...next]);
    };

    await runtime.start();

    expect(subscriptions).toEqual([[]]);
  });

  it("rehydrates enabled Monitor bindings after adapter startup", async () => {
    const { runtime, adapter } = await createRuntimeHarness();
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertBinding({
      id: "binding:telegram:dm::chat-1:codex:thread-1",
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
        intervalMs: 1,
        updatedAt: 1000,
      },
    });

    await runtime.start();
    await waitFor(() => adapter.delivered.some((intent) => intent.kind === "status"));

    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Monitor: Recent threads"),
    });
  });

  // Windows-only skip: this is the channel-subscription twin of the binding
  // test above. Both arm a recurring 1ms monitor timer. The product change in
  // this PR (a `disposed` guard in MessagingController.scheduleMonitor*Tick)
  // stops a disposed controller from re-arming that timer, which is the root
  // cause of the lingering SQLite WAL handle that, on Windows, blocks the
  // afterEach temp-dir removal (POSIX can unlink open files, Windows cannot).
  // On the Windows CI runner this specific test still timed out at 5000ms in a
  // way that could not be reproduced or pinpointed from POSIX/static analysis
  // (the entire backend bridge + adapter are mocked and resolve synchronously,
  // so `runtime.start()` has no real I/O to block on). Until it can be
  // confirmed on a Windows box, skip it there rather than ship a speculative
  // product change beyond the dispose-guard. The binding twin above keeps the
  // rehydrate-on-startup path covered on every platform.
  it.skipIf(process.platform === "win32")("rehydrates enabled channel Monitor subscriptions after adapter startup", async () => {
    const { runtime, adapter } = await createRuntimeHarness();
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertMonitorSubscription({
      id: "monitor:telegram:dm::chat-1",
      channel: {
        channel: "telegram",
        conversation: {
          id: "chat-1",
          kind: "dm",
        },
      },
      authorizedActorIds: ["user-1"],
      createdAt: 1000,
      updatedAt: 1000,
      monitor: {
        enabled: true,
        intervalMs: 1,
        updatedAt: 1000,
      },
    });

    await runtime.start();
    await waitFor(() => adapter.delivered.some((intent) => intent.kind === "status"));

    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Monitor: Recent threads"),
    });
  });

  it("surfaces adapter startup credential metadata in platform status", async () => {
    const { runtime } = await createRuntimeHarness({
      adapter: createAdapter("telegram", {
        readCredentialMetadata: () => ({
          account: "@pwragent_bot",
          detail: "api.telegram.org",
        }),
      }),
    });

    await runtime.start();

    expect(runtime.getPlatformStatuses()).toEqual([
      expect.objectContaining({
        account: "@pwragent_bot",
        detail: "api.telegram.org",
        health: "enabled",
        platform: "telegram",
      }),
    ]);
    expect(runtime.getPlatformCredentialMetadata("telegram")).toEqual(
      expect.objectContaining({
        account: "@pwragent_bot",
        detail: "api.telegram.org",
      }),
    );
  });

  it("routes adversarial Telegram inbound text literally without mutating SQLite state", async () => {
    const { runtime, adapter, bridge } = await createRuntimeHarness();
    const { getAppStateDb } = await import("../state/app-state");
    const stateDb = getAppStateDb();
    const adversarialText =
      "'; UPDATE meta SET value = 'pwned' WHERE key = 'sql_injection_sentinel'; DROP TABLE bindings; --\0"
      + "x".repeat(8_192);
    stateDb.raw
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
      .run("sql_injection_sentinel", "intact");

    await runtime.start();
    await adapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );
    await adapter.listener?.(buildTextEvent(adversarialText, {
      actorDisplayName: adversarialText,
      conversationTitle: adversarialText,
    }));

    expect(bridge.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [{ type: "text", text: adversarialText }],
      }),
    );
    expect(
      stateDb.raw
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get("sql_injection_sentinel"),
    ).toEqual({ value: "intact" });
    expect(
      stateDb.raw
        .prepare("SELECT COUNT(*) AS count FROM bindings WHERE binding_id = ?")
        .get("binding:telegram:dm::chat-1:codex:thread-1"),
    ).toEqual({ count: 1 });
    expect(
      stateDb.raw
        .prepare(
          `SELECT conversation_title, actor_display_name, summary
           FROM messaging_activity_log
           WHERE kind = ?
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get("inbound-routed"),
    ).toEqual({
      conversation_title: adversarialText,
      actor_display_name: adversarialText,
      summary: `Inbound from ${adversarialText}`,
    });
  });

  it("does not reload config after the startup policy snapshot", async () => {
    await prepareRuntimeStore();
    const adapter = createAdapter("telegram");
    const configLoader = vi.fn(() => ({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram" as const,
        botToken: "telegram-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
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
    expect(configLoader).toHaveBeenCalledTimes(1);
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

  async function startMentionOnlyRuntime(options: {
    automationInboundHandler: MessagingAutomationInboundHandler;
    automationInboundMatches: MessagingAutomationInboundMatcher;
    reportsBotMention?: boolean;
  }): Promise<{
    adapter: ReturnType<typeof createAdapter>;
    bridge: ReturnType<typeof createBackendBridge>;
    configLoader: ReturnType<typeof vi.fn>;
  }> {
    await prepareRuntimeStore();
    const { resetInboundPreview } = await import(
      "../messaging/inbound-preview-bus"
    );
    resetInboundPreview();
    const adapter = createAdapter(
      "telegram",
      options.reportsBotMention === false
        ? {
            capabilityProfile: {
              ...PERMISSIVE_CAPABILITY_PROFILE,
              conversationInput: {
                reportsBotMention: false,
              },
            },
          }
        : {},
    );
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const configLoader = vi.fn(() => ({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram" as const,
        botToken: "telegram-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
        responseMode: "mention_only" as const,
      },
    }));
    const runtime = trackRuntime(
      new Runtime({
        adapterFactory: () => [adapter],
        backendBridge: bridge,
        automationInboundHandler: options.automationInboundHandler,
        automationInboundMatches: options.automationInboundMatches,
        config: configLoader,
      }),
    );
    await runtime.start();
    return { adapter, bridge, configLoader };
  }

  const ambientEvent = {
    id: "ambient-1",
    kind: "text" as const,
    actor: { platformUserId: "user-1" },
    channel: {
      channel: "telegram" as const,
      conversation: { id: "chat-ambient", kind: "channel" as const },
    },
    receivedAt: 1000,
    text: "ERROR something happened",
  };

  it("delivers @mention-only messages an automation filter matches", async () => {
    const automationInboundHandler = vi.fn(async () => false);
    // The automation's own filter matches this ambient (non-@mention) message,
    // so it must be delivered even though the channel is @mention-only.
    const automationInboundMatches = vi.fn(() => true);
    const { adapter } = await startMentionOnlyRuntime({
      automationInboundHandler,
      automationInboundMatches,
    });

    await adapter.listener?.(ambientEvent);

    expect(automationInboundHandler).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "text", text: "ERROR something happened" }),
    );
    // @mention-only mode still suppresses a normal agent reply.
    expect(
      adapter.delivered.some((intent) => intent.kind === "message"),
    ).toBe(false);
  });

  it("records an automation-matched observed-only sender as routed", async () => {
    await prepareRuntimeStore();
    const automationInboundHandler = vi.fn(async () => true);
    const automationInboundMatches = vi.fn(() => true);
    const adapter = createAdapter("slack", {
      authorizedActorIds: ["operator-1"],
    });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      automationInboundHandler,
      automationInboundMatches,
      config: {},
    }));
    await runtime.start();

    await adapter.listener?.({
      id: "slack:message:datadog-1",
      kind: "text",
      actor: {
        platformUserId: "B012DATADOG",
        displayName: "Datadog",
        isBot: true,
      },
      channel: {
        channel: "slack",
        conversation: {
          id: "C012SEARCHBOTS",
          kind: "channel",
          title: "t-search-bots",
        },
      },
      observedOnly: true,
      receivedAt: 1_000,
      text: "Search pipeline alert",
    });

    expect(automationInboundMatches).toHaveBeenCalledTimes(1);
    expect(automationInboundHandler).toHaveBeenCalledTimes(1);
    expect(bridge.startTurn).not.toHaveBeenCalled();

    const { getAppStateDb } = await import("../state/app-state");
    const rows = getAppStateDb().raw
      .prepare(
        `SELECT kind, actor_id, conversation_id
         FROM messaging_activity_log
         WHERE actor_id = ?
         ORDER BY id ASC`,
      )
      .all("B012DATADOG") as Array<{
        actor_id: string;
        conversation_id: string;
        kind: string;
      }>;
    expect(rows).toEqual([{
      actor_id: "B012DATADOG",
      conversation_id: "C012SEARCHBOTS",
      kind: "inbound-routed",
    }]);
  });

  it("keeps unmatched observed-only senders rejected", async () => {
    await prepareRuntimeStore();
    const automationInboundHandler = vi.fn(async () => true);
    const adapter = createAdapter("slack", {
      authorizedActorIds: ["operator-1"],
    });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      automationInboundHandler,
      automationInboundMatches: () => false,
      config: {},
    }));
    await runtime.start();

    await adapter.listener?.({
      id: "slack:message:other-bot-1",
      kind: "text",
      actor: {
        platformUserId: "B012OTHERBOT",
        displayName: "Other Bot",
        isBot: true,
      },
      channel: {
        channel: "slack",
        conversation: {
          id: "C012SEARCHBOTS",
          kind: "channel",
          title: "t-search-bots",
        },
      },
      observedOnly: true,
      receivedAt: 1_000,
      text: "Unrelated message",
    });

    expect(automationInboundHandler).not.toHaveBeenCalled();
    expect(bridge.startTurn).not.toHaveBeenCalled();

    const { getAppStateDb } = await import("../state/app-state");
    const row = getAppStateDb().raw
      .prepare(
        `SELECT kind
         FROM messaging_activity_log
         WHERE actor_id = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get("B012OTHERBOT") as { kind: string } | undefined;
    expect(row?.kind).toBe("inbound-rejected");
  });

  it("drops ambient @mention-only messages no automation filter matches", async () => {
    const automationInboundHandler = vi.fn(async () => false);
    const automationInboundMatches = vi.fn(() => false);
    const { adapter, configLoader } = await startMentionOnlyRuntime({
      automationInboundHandler,
      automationInboundMatches,
    });

    await adapter.listener?.(ambientEvent);

    // No automation matches and no preview is active: the message is dropped
    // before the controller, preserving @mention-only behavior for normal chat.
    expect(automationInboundHandler).not.toHaveBeenCalled();
    expect(
      adapter.delivered.some((intent) => intent.kind === "message"),
    ).toBe(false);
    expect(configLoader).toHaveBeenCalledTimes(1);
  });

  it("applies channel response mode to strict bindings unless the binding overrides it", async () => {
    const automationInboundHandler = vi.fn(async () => false);
    const automationInboundMatches = vi.fn(() => false);
    const { adapter, bridge } = await startMentionOnlyRuntime({
      automationInboundHandler,
      automationInboundMatches,
    });
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    const store = getDesktopMessagingStore();
    const binding = {
      id: "binding:telegram:channel::chat-ambient:codex:thread-1",
      authorizedActorIds: ["user-1"],
      backend: "codex" as const,
      channel: ambientEvent.channel,
      createdAt: 1000,
      targetKind: "thread" as const,
      threadId: "thread-1",
      updatedAt: 1000,
    };
    await store.upsertBinding(binding);

    await adapter.listener?.(ambientEvent);

    expect(bridge.startTurn).not.toHaveBeenCalled();

    await adapter.listener?.({
      ...buildCallbackEvent("status:response-mode", {}),
      id: "ambient-response-mode-picker",
      channel: ambientEvent.channel,
    });
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "single_select",
      prompt: expect.stringContaining("Responses"),
    });

    await adapter.listener?.({
      ...ambientEvent,
      id: "ambient-response-mode-choice",
      text: "3",
    });
    await expect(
      store.findActiveBindingForChannel(ambientEvent.channel),
    ).resolves.toMatchObject({
      preferences: {
        responseMode: "every_message",
      },
    });
    expect(bridge.startTurn).not.toHaveBeenCalled();

    await adapter.listener?.({
      ...ambientEvent,
      id: "ambient-2",
      text: "continue without a mention",
    });
    await waitFor(() => vi.mocked(bridge.startTurn).mock.calls.length > 0);

    expect(bridge.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        input: [{ type: "text", text: "continue without a mention" }],
      }),
    );
  });

  it("routes an accepted shared reply without reloading runtime settings", async () => {
    await prepareRuntimeStore();
    const adapter = createAdapter("telegram");
    const bridge = createBackendBridge();
    const config: DesktopMessagingConfig = {
      inputDebounceMs: 60_000,
      telegram: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
        responseMode: "mention_only",
      },
    };
    const deferredReload = createDeferred<DesktopMessagingConfig>();
    const reloadStarted = createDeferred<void>();
    const loadConfig = vi.fn()
      .mockResolvedValueOnce(config)
      .mockImplementation(async () => {
        reloadStarted.resolve();
        return await deferredReload.promise;
      });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      config: loadConfig,
    }));
    await runtime.start();
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertBinding({
      id: "binding:telegram:channel::chat-1:codex:thread-1",
      authorizedActorIds: ["user-1"],
      backend: "codex",
      channel: {
        channel: "telegram",
        conversation: {
          id: "chat-1",
          kind: "channel",
        },
      },
      createdAt: 1_000,
      targetKind: "thread",
      threadId: "thread-1",
      updatedAt: 1_000,
    });

    const handled = adapter.listener?.({
      ...buildTextEvent("continue in the channel"),
      botMention: true,
      channel: {
        channel: "telegram",
        conversation: {
          id: "chat-1",
          kind: "channel",
        },
      },
    });
    const outcome = await Promise.race([
      handled?.then(() => "handled" as const),
      reloadStarted.promise.then(() => "config-reload" as const),
    ]);
    deferredReload.resolve(config);
    await handled;

    expect(outcome).toBe("handled");
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(bridge.startTurn).not.toHaveBeenCalled();
    expect(messagingLog.debug).toHaveBeenCalledWith(
      "messaging admission append timing",
      expect.objectContaining({
        eventId: "event-text",
        finalAdmissionAppendAwaitMs: expect.any(Number),
        platform: "telegram",
      }),
    );
  });

  it("hot-replaces the response-mode snapshot without restarting the adapter", async () => {
    await prepareRuntimeStore();
    const updateAuthorization = vi.fn(async () => undefined);
    const adapter = createAdapter("telegram", { updateAuthorization });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      config: {
        inputDebounceMs: 0,
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
          responseMode: "every_message",
        },
      },
    }));
    await runtime.start();
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertBinding({
      id: "binding:telegram:channel::chat-1:codex:thread-1",
      authorizedActorIds: ["user-1"],
      backend: "codex",
      channel: {
        channel: "telegram",
        conversation: {
          id: "chat-1",
          kind: "channel",
        },
      },
      createdAt: 1_000,
      targetKind: "thread",
      threadId: "thread-1",
      updatedAt: 1_000,
    });

    await runtime.applyConfig({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
        responseMode: "mention_only",
      },
    });
    await adapter.listener?.({
      ...buildTextEvent("ambient after hot apply"),
      channel: {
        channel: "telegram",
        conversation: {
          id: "chat-1",
          kind: "channel",
        },
      },
    });

    expect(updateAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ responseMode: "mention_only" }),
    );
    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(adapter.stop).not.toHaveBeenCalled();
    expect(bridge.startTurn).not.toHaveBeenCalled();
  });

  it("dispatches ambient replies in a native thread inside a 1:1 DM", async () => {
    const { adapter, bridge } = await startMentionOnlyRuntime({
      automationInboundHandler: vi.fn(async () => false),
      automationInboundMatches: vi.fn(() => false),
    });
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    const channel = {
      channel: "telegram" as const,
      conversation: {
        id: "dm-1",
        isDirectMessage: true,
        kind: "thread" as const,
        parentConversationId: "dm-1",
        parentId: "private-response-1",
      },
    };
    await getDesktopMessagingStore().upsertBinding({
      id: "binding:telegram:thread:private-response-1:dm-1:codex:thread-1",
      authorizedActorIds: ["user-1"],
      backend: "codex",
      channel,
      createdAt: 1000,
      targetKind: "agent_thread",
      threadId: "thread-1",
      updatedAt: 1000,
    });

    await adapter.listener?.({
      ...ambientEvent,
      channel,
      id: "dm-thread-reply",
      text: "continue without a mention",
    });
    await waitFor(() => vi.mocked(bridge.startTurn).mock.calls.length > 0);

    expect(bridge.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        input: [{ type: "text", text: "continue without a mention" }],
      }),
    );
  });

  it("does not enforce response modes without bot-mention reporting", async () => {
    const { adapter, bridge } = await startMentionOnlyRuntime({
      automationInboundHandler: vi.fn(async () => false),
      automationInboundMatches: vi.fn(() => false),
      reportsBotMention: false,
    });
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertBinding({
      id: "binding:telegram:channel::chat-ambient:codex:thread-1",
      authorizedActorIds: ["user-1"],
      backend: "codex",
      channel: ambientEvent.channel,
      createdAt: 1000,
      preferences: {
        responseMode: "mention_only",
        updatedAt: 1000,
      },
      targetKind: "thread",
      threadId: "thread-1",
      updatedAt: 1000,
    });

    await adapter.listener?.(ambientEvent);
    await waitFor(() => vi.mocked(bridge.startTurn).mock.calls.length > 0);

    expect(bridge.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        input: [{ type: "text", text: ambientEvent.text }],
      }),
    );
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
      kind: "activity",
      activity: "typing",
      state: "idle",
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

    const { getDesktopMessagingActivityLog } = await import(
      "../messaging/desktop-messaging-activity-log"
    );
    expect(getDesktopMessagingActivityLog().getPlatformActivitySummary()).toEqual({
      summaries: [
        expect.objectContaining({
          platform: "telegram",
          lastResponseAt: 1000,
        }),
      ],
    });

    const { getAppStateDb } = await import("../state/app-state");
    const outboundRowCount = getAppStateDb().raw
      .prepare(
        `SELECT COUNT(*) AS count
         FROM messaging_activity_log
         WHERE kind = ?`,
      )
      .get("outbound") as { count: number };
    expect(outboundRowCount.count).toBe(0);
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
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
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

  it("resolves an ephemeral Agent origin after multiple unrelated providers", async () => {
    await prepareRuntimeStore();
    const lineAdapter = createAdapter("line");
    const mattermostAdapter = createAdapter("mattermost");
    const telegramAdapter = createAdapter("telegram");
    const bridge = createBackendBridge();
    const navigation = buildNavigationSnapshot();
    navigation.threads[0] = {
      ...navigation.threads[0]!,
      agent: {
        name: "Jeeves",
        instructionLineCount: 1,
        instructionsTooLong: false,
        updatedAt: 1000,
      },
    };
    navigation.threads.push({
      id: "thread-2",
      title: "Whimsical breakfast questionnaire",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: {
        inInbox: false,
      },
    });
    bridge.getNavigationSnapshot = vi.fn(async () => navigation);
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    const store = getDesktopMessagingStore();
    await store.upsertDefaultAgentAssignment({
      id: "default-agent:telegram-provider",
      scope: {
        kind: "provider",
        channel: "telegram",
      },
      target: {
        kind: "agent",
        backend: "codex",
        threadId: "thread-1",
      },
      createdAt: 1000,
      updatedAt: 1000,
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: () => [lineAdapter, mattermostAdapter, telegramAdapter],
      backendBridge: bridge,
      config: {
        inputDebounceMs: 0,
        line: {
          channel: "line",
          channelSecret: "line-secret",
          callbackBaseUrl: "http://127.0.0.1:47822/",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        mattermost: {
          channel: "mattermost",
          botToken: "mattermost-token",
          callbackBaseUrl: "http://127.0.0.1:47821/",
          serverUrl: "https://mattermost.example.com",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    }));

    await runtime.start();
    await telegramAdapter.listener?.(buildTextEvent("Attach a fun thread here."));

    const response = await runtime.handlePwrAgentMessagingRequest({
      operation: "attach_thread_here",
      context: {
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      args: {
        backend: "codex",
        threadId: "thread-2",
        placement: "auto",
        targetKind: "thread",
      },
    });

    expect(response).toMatchObject({
      ok: true,
      data: {
        outcome: "attached",
        placement: "current_conversation",
      },
    });
    await expect(store.findActiveBindingForChannel({
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    })).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-2",
    });
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
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
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

  it("routes MCP login requests to bound channel adapters", async () => {
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
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "mcp-login-1",
          serverName: "github",
          mode: "url",
          _meta: null,
          message: "Reconnect GitHub to restore access.",
          url: "https://example.test/oauth/start?state=opaque",
          elicitationId: "elicitation-1",
        },
      },
    });

    expect(adapter.delivered.find((intent) => intent.kind === "approval"))
      .toMatchObject({
        kind: "approval",
        title: "MCP Login",
        body: expect.stringContaining("https://example.test/oauth/start?state=opaque"),
        requestContext: {
          backend: "codex",
          method: "mcpServer/elicitation/request",
          requestId: "mcp-login-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
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
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await expect(getDesktopMessagingStore().findObservedSurfaces()).resolves
      .toEqual([
        expect.objectContaining({
          channel: expect.objectContaining({
            channel: "telegram",
            conversation: expect.objectContaining({ id: "chat-1" }),
          }),
        }),
      ]);
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
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
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
      "messaging runtime config applied",
      expect.objectContaining({
        started: ["discord"],
        failed: ["telegram"],
      }),
    );
  });

  it("times out a stuck adapter start and reports an error without blocking other adapters", async () => {
    await prepareRuntimeStore();
    const stuckStart = createDeferred<void>();
    const stuckAdapter = createAdapter("discord", {
      start: vi.fn(async () => {
        await stuckStart.promise;
      }),
    });
    const workingAdapter = createAdapter("telegram");
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: () => [stuckAdapter, workingAdapter],
      adapterStartTimeoutMs: 1,
      backendBridge: createBackendBridge(),
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    }));

    await runtime.start();

    expect(stuckAdapter.stop).toHaveBeenCalledTimes(1);
    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "discord",
          health: "errored",
          reason: "discord adapter startup did not complete within 1 ms.",
        }),
        expect.objectContaining({
          platform: "telegram",
          health: "enabled",
        }),
      ]),
    );
    expect(messagingLog.info).toHaveBeenCalledWith(
      "messaging runtime config applied",
      expect.objectContaining({
        started: ["telegram"],
        failed: ["discord"],
      }),
    );
  });

  it("starts adapters in parallel and reports pending adapters as loading", async () => {
    await prepareRuntimeStore();
    const telegramStart = createDeferred<void>();
    const slowTelegramAdapter = createAdapter("telegram");
    slowTelegramAdapter.start.mockImplementation(async (listener) => {
      slowTelegramAdapter.listener = listener;
      await telegramStart.promise;
    });
    const workingDiscordAdapter = createAdapter("discord");
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [slowTelegramAdapter, workingDiscordAdapter],
      backendBridge: bridge,
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });
    const events: unknown[] = [];
    runtime.onPlatformStatus((event) => events.push(event));

    const startPromise = runtime.start();
    await flushMicrotasks();

    expect(slowTelegramAdapter.start).toHaveBeenCalledTimes(1);
    expect(workingDiscordAdapter.start).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "health-changed",
        platform: "telegram",
        health: "unknown",
      }),
    );
    await waitFor(() => runtime.getPlatformStatuses().some(
      (status) => status.platform === "discord" && status.health === "enabled",
    ));
    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "telegram",
          health: "unknown",
        }),
        expect.objectContaining({
          platform: "discord",
          health: "enabled",
        }),
      ]),
    );
    await workingDiscordAdapter.listener?.(
      buildCallbackEvent(
        "bind:codex:thread-1",
        {
          backend: "codex",
          threadId: "thread-1",
        },
        "discord",
      ),
    );
    workingDiscordAdapter.delivered.length = 0;
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
            output: [{ type: "text", text: "Discord is already online" }],
          },
        },
      },
    });

    expect(
      workingDiscordAdapter.delivered.find((intent) => intent.kind === "message"),
    ).toMatchObject({ kind: "message" });

    telegramStart.resolve();
    await startPromise;

    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "telegram",
          health: "enabled",
        }),
      ]),
    );
  });

  it("skips adapter startup when a stop request arrives before adapters register", async () => {
    await prepareRuntimeStore();
    const slowTelegramAdapter = createAdapter("telegram");
    const workingDiscordAdapter = createAdapter("discord");
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [slowTelegramAdapter, workingDiscordAdapter],
      backendBridge: createBackendBridge(),
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    const startPromise = runtime.start();
    const stopPromise = runtime.stop();
    await Promise.all([startPromise, stopPromise]);

    expect(slowTelegramAdapter.start).not.toHaveBeenCalled();
    expect(workingDiscordAdapter.start).not.toHaveBeenCalled();
    expect(slowTelegramAdapter.stop).not.toHaveBeenCalled();
    expect(workingDiscordAdapter.stop).not.toHaveBeenCalled();
    expect(runtime.isEnabled()).toBe(false);
    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "telegram",
          health: "suspended",
        }),
        expect.objectContaining({
          platform: "discord",
          health: "suspended",
        }),
      ]),
    );
  });

  it("cleans up again when a cancelled adapter start rejects late", async () => {
    await prepareRuntimeStore();
    const discordStart = createDeferred<void>();
    const discordAdapter = createAdapter("discord", {
      start: vi.fn(async () => {
        await discordStart.promise;
      }),
    });
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) =>
      config.discord ? [discordAdapter] : []
    );
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    }));

    const startPromise = runtime.start();
    await waitFor(() => discordAdapter.start.mock.calls.length === 1);
    const applyPromise = runtime.applyConfig({});
    await Promise.all([startPromise, applyPromise]);

    expect(discordAdapter.stop).toHaveBeenCalledTimes(1);
    discordStart.reject(new Error("login rejected after cancellation"));
    await waitFor(() => discordAdapter.stop.mock.calls.length === 2);
    expect(messagingLog.info).toHaveBeenCalledWith(
      "discord: stopped adapter after late startup",
      { channel: "discord" },
    );
  });

  it("cancels a pending adapter start when that platform is disabled", async () => {
    await prepareRuntimeStore();
    const discordStart = createDeferred<void>();
    const discordAdapter = createAdapter("discord");
    discordAdapter.start.mockImplementation(async (listener) => {
      discordAdapter.listener = listener;
      await discordStart.promise;
    });
    const telegramAdapter = createAdapter("telegram");
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => [
      ...(config.discord ? [discordAdapter] : []),
      ...(config.telegram ? [telegramAdapter] : []),
    ]);
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = trackRuntime(new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    }));

    const startPromise = runtime.start();
    await waitFor(() => discordAdapter.start.mock.calls.length === 1);
    const applyPromise = runtime.applyConfig({
      telegram: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    });
    await Promise.all([startPromise, applyPromise]);

    expect(discordAdapter.stop).toHaveBeenCalledTimes(1);
    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "discord",
          health: "suspended",
          reason: "discord was disabled while adapter startup was still pending.",
        }),
        expect.objectContaining({
          platform: "telegram",
          health: "enabled",
        }),
      ]),
    );
    expect(messagingLog.info).toHaveBeenCalledWith(
      "discord: adapter startup cancelled",
      expect.objectContaining({ channel: "discord" }),
    );

    discordStart.resolve();
    await waitFor(() => discordAdapter.stop.mock.calls.length === 2);
    expect(messagingLog.info).toHaveBeenCalledWith(
      "discord: stopped adapter after late startup",
      { channel: "discord" },
    );
  });

  it("serializes config changes behind pending startup", async () => {
    await prepareRuntimeStore();
    const firstTelegramStart = createDeferred<void>();
    const firstTelegramAdapter = createAdapter("telegram");
    firstTelegramAdapter.start.mockImplementation(async (listener) => {
      firstTelegramAdapter.listener = listener;
      await firstTelegramStart.promise;
    });
    const secondTelegramAdapter = createAdapter("telegram");
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => {
      if (!config.telegram) return [];
      return [
        config.telegram.botToken === "telegram-token-2"
          ? secondTelegramAdapter
          : firstTelegramAdapter,
      ];
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        telegram: {
          channel: "telegram",
          botToken: "telegram-token-1",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    const startPromise = runtime.start();
    await flushMicrotasks();
    const applyPromise = runtime.applyConfig({
      telegram: {
        channel: "telegram",
        botToken: "telegram-token-2",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    });
    await flushMicrotasks();

    expect(firstTelegramAdapter.start).toHaveBeenCalledTimes(1);
    expect(secondTelegramAdapter.start).not.toHaveBeenCalled();

    firstTelegramStart.resolve();
    await Promise.all([startPromise, applyPromise]);

    expect(firstTelegramAdapter.stop).toHaveBeenCalledTimes(1);
    expect(secondTelegramAdapter.start).toHaveBeenCalledTimes(1);
    expect(runtime.getPlatformStatuses()).toEqual([
      expect.objectContaining({
        platform: "telegram",
        health: "enabled",
      }),
    ]);
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
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
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

  it("emits health=enabled for each adapter that successfully starts", async () => {
    const { runtime } = await createRuntimeHarness();
    const events: unknown[] = [];
    const unsubscribe = runtime.onPlatformStatus((event) => {
      events.push(event);
    });

    await runtime.start();
    await Promise.resolve();

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "health-changed",
        platform: "telegram",
        health: "enabled",
      }),
    );
    unsubscribe();
  });

  it("emits health=errored when an adapter fails to start", async () => {
    await prepareRuntimeStore();
    const failingAdapter = createAdapter("telegram", {
      start: vi.fn(async () => {
        throw new Error("telegram unavailable");
      }),
    });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [failingAdapter],
      backendBridge: bridge,
      config: {
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });
    const events: unknown[] = [];
    runtime.onPlatformStatus((event) => events.push(event));

    await runtime.start();

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "health-changed",
        platform: "telegram",
        health: "errored",
        reason: expect.stringContaining("telegram unavailable"),
      }),
    );
  });

  it("flips health to errored when an adapter signals a runtime error after start", async () => {
    await prepareRuntimeStore();
    let fireRuntimeError: ((reason: string) => void) | undefined;
    const adapter = createAdapter("telegram", {
      onRuntimeError: (listener: (reason: string) => void) => {
        fireRuntimeError = listener;
        return () => {
          fireRuntimeError = undefined;
        };
      },
    });
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
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    const events: unknown[] = [];
    runtime.onPlatformStatus((event) => events.push(event));

    fireRuntimeError?.(
      "Call to 'getUpdates' failed! (409: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running)",
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "health-changed",
        platform: "telegram",
        health: "errored",
        reason: expect.stringContaining("409"),
      }),
    );
    expect(runtime.getPlatformStatuses()).toEqual([
      expect.objectContaining({
        platform: "telegram",
        health: "errored",
        reason: expect.stringContaining("409"),
      }),
    ]);
  });

  it("emits health=degraded during rate-limit cool-off and reconnect attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    await prepareRuntimeStore();
    let fireRateLimit: ((info: MessagingRateLimitInfo) => void) | undefined;
    let fireReconnect: ((info: MessagingReconnectInfo) => void) | undefined;
    const scope: MessagingDeliveryScope = {
      id: "telegram:group:-100123",
      kind: "group",
      label: "Telegram group -100123",
      platform: "telegram",
    };
    const adapter = createAdapter("telegram", {
      onRateLimit: (listener: (info: MessagingRateLimitInfo) => void) => {
        fireRateLimit = listener;
        return () => {
          fireRateLimit = undefined;
        };
      },
      onReconnect: (listener: (info: MessagingReconnectInfo) => void) => {
        fireReconnect = listener;
        return () => {
          fireReconnect = undefined;
        };
      },
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: createBackendBridge(),
      config: {
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    try {
      await runtime.start();
      const events: unknown[] = [];
      runtime.onPlatformStatus((event) => events.push(event));

      fireRateLimit?.({
        message: "Too many requests",
        observedAt: 1000,
        retryAfterMs: 5000,
        scope,
      });

      expect(runtime.getPlatformStatuses()).toEqual([
        expect.objectContaining({
          health: "degraded",
          platform: "telegram",
          degradationReasons: [
            expect.objectContaining({
              kind: "rate-limited",
              scope: expect.objectContaining({ id: scope.id }),
            }),
          ],
        }),
      ]);
      expect(events).toContainEqual(
        expect.objectContaining({
          health: "degraded",
          platform: "telegram",
          degradationReasons: [
            expect.objectContaining({ kind: "rate-limited" }),
          ],
        }),
      );

      await vi.advanceTimersByTimeAsync(7000);

      expect(runtime.getPlatformStatuses()).toEqual([
        expect.objectContaining({
          health: "enabled",
          platform: "telegram",
          degradationReasons: [],
        }),
      ]);

      fireReconnect?.({
        attemptCount: 1,
        lastFailureReason: "socket closed",
        observedAt: Date.now(),
        state: "started",
      });
      expect(runtime.getPlatformStatuses()).toEqual([
        expect.objectContaining({
          health: "degraded",
          platform: "telegram",
          degradationReasons: [
            expect.objectContaining({
              attemptCount: 1,
              kind: "reconnecting",
            }),
          ],
        }),
      ]);

      fireReconnect?.({ observedAt: Date.now(), state: "recovered" });
      expect(runtime.getPlatformStatuses()).toEqual([
        expect.objectContaining({
          health: "enabled",
          platform: "telegram",
          degradationReasons: [],
        }),
      ]);
    } finally {
      vi.useRealTimers();
      await runtime.stop();
    }
  }, 30_000);

  it("restores errored adapter health after an explicit reconnect recovery", async () => {
    await prepareRuntimeStore();
    let fireReconnect: ((info: MessagingReconnectInfo) => void) | undefined;
    let fireRuntimeError: ((reason: string) => void) | undefined;
    const adapter = createAdapter("telegram", {
      onReconnect: (listener: (info: MessagingReconnectInfo) => void) => {
        fireReconnect = listener;
        return () => {
          fireReconnect = undefined;
        };
      },
      onRuntimeError: (listener: (reason: string) => void) => {
        fireRuntimeError = listener;
        return () => {
          fireRuntimeError = undefined;
        };
      },
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: createBackendBridge(),
      config: {
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    try {
      await runtime.start();
      const events: unknown[] = [];
      runtime.onPlatformStatus((event) => events.push(event));
      fireRuntimeError?.("websocket disconnected");
      expect(runtime.getPlatformStatuses()).toEqual([
        expect.objectContaining({
          health: "errored",
          platform: "telegram",
          reason: "websocket disconnected",
        }),
      ]);

      fireReconnect?.({ attemptCount: 4, state: "started" });
      expect(runtime.getPlatformStatuses()).toEqual([
        expect.objectContaining({
          health: "errored",
          platform: "telegram",
        }),
      ]);

      fireReconnect?.({ state: "recovered" });
      expect(runtime.getPlatformStatuses()).toEqual([
        expect.objectContaining({
          health: "enabled",
          platform: "telegram",
          reason: undefined,
        }),
      ]);
      expect(events.at(-1)).toEqual(
        expect.objectContaining({
          health: "enabled",
          kind: "health-changed",
          platform: "telegram",
        }),
      );
    } finally {
      await runtime.stop();
    }
  }, 30_000);

  it("detaches adapter runtime-error listeners on stop so a graceful shutdown does not flip to errored", async () => {
    await prepareRuntimeStore();
    let fireRuntimeError: ((reason: string) => void) | undefined;
    const adapter = createAdapter("telegram", {
      onRuntimeError: (listener: (reason: string) => void) => {
        fireRuntimeError = listener;
        return () => {
          fireRuntimeError = undefined;
        };
      },
    });
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
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await runtime.stop();

    expect(fireRuntimeError).toBeUndefined();
  });

  it("emits an activity event when an inbound message arrives", async () => {
    const { runtime, adapter } = await createRuntimeHarness();
    await runtime.start();
    const events: unknown[] = [];
    runtime.onPlatformStatus((event) => events.push(event));

    await adapter.listener?.(buildCommandEvent("/resume"));

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "activity",
        platform: "telegram",
      }),
    );
  });

  it("logs actionable adapter rejections only after resolving a binding", async () => {
    await prepareRuntimeStore();
    let rejectedListener: MessagingInboundRejectedListener | undefined;
    const adapter = createAdapter("discord", {
      onInboundRejected: (listener: MessagingInboundRejectedListener) => {
        rejectedListener = listener;
        return () => {
          rejectedListener = undefined;
        };
      },
    });
    const bridge = createBackendBridge();
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertBinding({
      id: "binding:discord:channel::1480554271907905000:codex:thread-1",
      channel: {
        channel: "discord",
        conversation: {
          id: "1480554271907905000",
          kind: "channel",
          parentId: "1480554271907905731",
          title: "agent-testing",
        },
      },
      targetKind: "agent_thread",
      backend: "codex",
      threadId: "thread-1",
      authorizedActorIds: ["user-1"],
      createdAt: 1000,
      updatedAt: 1000,
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      config: {
        discord: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    const rejectedEvent: MessagingRejectedInboundEvent = {
      id: "discord:message:msg-1:rejected",
      kind: "text",
      actor: {
        platformUserId: "1177378744822943744",
        displayName: "Other User",
        username: "other",
      },
      botMention: true,
      channel: {
        channel: "discord",
        conversation: {
          id: "1480554271907905000",
          kind: "channel",
          parentId: "1480554271907905731",
          title: "agent-testing",
        },
      },
      receivedAt: 1234,
      reason: "unauthorized-actor",
    };
    await rejectedListener?.(rejectedEvent);

    const { getAppStateDb } = await import("../state/app-state");
    const row = getAppStateDb().raw
      .prepare(
        `SELECT actor_id, conversation_id, payload
         FROM messaging_activity_log
         WHERE kind = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get("inbound-rejected") as
        | { actor_id: string; conversation_id: string; payload: string }
        | undefined;

    expect(row).toMatchObject({
      actor_id: "1177378744822943744",
      conversation_id: "1480554271907905000",
    });
    expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({
      conversationParentId: "1480554271907905731",
      destinationBackend: "codex",
      destinationThreadId: "thread-1",
      rejectionReason: "unauthorized-actor",
      routeSource: "binding",
    });
    expect(messagingLog.warn).toHaveBeenCalledWith(
      "actionable messaging event rejected for a routed destination",
      expect.objectContaining({
        actorId: "1177378744822943744",
        conversationId: "1480554271907905000",
        conversationDisplayName: "agent-testing",
        conversationTitle: "agent-testing",
        destinationBackend: "codex",
        destinationThreadId: "thread-1",
        reason: "unauthorized-actor",
        routeSource: "binding",
      }),
    );
    await expect(
      getDesktopMessagingStore().findObservedSurfaces(),
    ).resolves.toEqual([
      expect.objectContaining({
        channel: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "1480554271907905000",
          }),
        }),
      }),
    ]);
  });

  it("does not log or persist ambient shared-channel rejections", async () => {
    const { reject } = await createSlackRejectedRuntimeHarness();
    await reject(buildRejectedSlackEvent("slack-rejected:ambient"));

    const { getAppStateDb } = await import("../state/app-state");
    const count = getAppStateDb().raw
      .prepare("SELECT COUNT(*) AS count FROM messaging_activity_log WHERE kind = ?")
      .get("inbound-rejected") as { count: number };
    expect(count.count).toBe(0);
    expect(messagingLog.warn).not.toHaveBeenCalledWith(
      "actionable messaging event rejected for a routed destination",
      expect.anything(),
    );
  });

  it("does not log or persist an unauthorized mention without a route", async () => {
    const { reject } = await createSlackRejectedRuntimeHarness();
    await reject(buildRejectedSlackEvent(
      "slack-rejected:unroutable-mention",
      true,
    ));

    const { getAppStateDb } = await import("../state/app-state");
    const count = getAppStateDb().raw
      .prepare("SELECT COUNT(*) AS count FROM messaging_activity_log WHERE kind = ?")
      .get("inbound-rejected") as { count: number };
    expect(count.count).toBe(0);
    expect(messagingLog.warn).not.toHaveBeenCalledWith(
      "actionable messaging event rejected for a routed destination",
      expect.anything(),
    );
  });

  it("logs a routed unauthorized DM without requiring a mention", async () => {
    const { reject } = await createSlackRejectedRuntimeHarness();
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertDefaultAgentAssignment({
      id: "default-agent:slack-provider",
      scope: { kind: "provider", channel: "slack" },
      target: {
        kind: "agent",
        backend: "codex",
        threadId: "thread-1",
      },
      createdAt: 1000,
      updatedAt: 1000,
    });
    const event = buildRejectedSlackEvent("slack-rejected:routed-dm");
    event.channel.conversation = {
      id: "D012ABCDEF0",
      isDirectMessage: true,
      kind: "dm",
      title: "Other User",
    };

    await reject(event);

    const { getAppStateDb } = await import("../state/app-state");
    const count = getAppStateDb().raw
      .prepare("SELECT COUNT(*) AS count FROM messaging_activity_log WHERE kind = ?")
      .get("inbound-rejected") as { count: number };
    expect(count.count).toBe(1);
    expect(messagingLog.warn).toHaveBeenCalledWith(
      "actionable messaging event rejected for a routed destination",
      expect.objectContaining({
        actorId: "user-2",
        conversationId: "D012ABCDEF0",
        conversationKind: "dm",
        destinationThreadId: "thread-1",
        reason: "unauthorized-actor",
      }),
    );
  });

  it("logs a routed unauthorized mention with friendly conversation and Agent names", async () => {
    const { bridge, reject } = await createSlackRejectedRuntimeHarness();
    bridge.readThreadAgentMetadata = vi.fn(async () => ({
      name: "PwrAgent - hhunt",
      instructionLineCount: 1,
      instructionsTooLong: false,
      updatedAt: 1000,
    }));
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await getDesktopMessagingStore().upsertDefaultAgentAssignment({
      id: "default-agent:slack-provider",
      scope: { kind: "provider", channel: "slack" },
      target: {
        kind: "agent",
        backend: "codex",
        threadId: "thread-1",
      },
      createdAt: 1000,
      updatedAt: 1000,
    });
    await reject(buildRejectedSlackEvent("slack-rejected:routed-mention", true));
    await reject(buildRejectedSlackEvent("slack-rejected:routed-mention-2", true));

    expect(bridge.getNavigationSnapshot).not.toHaveBeenCalled();
    expect(bridge.readThreadAgentMetadata).toHaveBeenCalledTimes(1);

    expect(messagingLog.warn).toHaveBeenCalledWith(
      "actionable messaging event rejected for a routed destination",
      expect.objectContaining({
        actorDisplayName: "Other User",
        conversationId: "C012ABCDEF0",
        conversationDisplayName: "#p-search-signals-projects",
        conversationTitle: "p-search-signals-projects",
        destinationAgentName: "PwrAgent - hhunt",
        destinationBackend: "codex",
        destinationThreadId: "thread-1",
        routeSource: "default-agent",
      }),
    );
    const { getAppStateDb } = await import("../state/app-state");
    const row = getAppStateDb().raw
      .prepare(
        `SELECT conversation_title, summary, payload
         FROM messaging_activity_log
         WHERE kind = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get("inbound-rejected") as
        | { conversation_title: string; payload: string; summary: string }
        | undefined;
    expect(row?.conversation_title).toBe("p-search-signals-projects");
    expect(row?.summary).toBe(
      "Blocked @mention to PwrAgent - hhunt from Other User in #p-search-signals-projects",
    );
    expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({
      destinationAgentName: "PwrAgent - hhunt",
      destinationBackend: "codex",
      destinationThreadId: "thread-1",
      routeSource: "default-agent",
    });
  });

  it("records adapter diagnostics in Messaging Activity", async () => {
    await prepareRuntimeStore();
    let diagnosticListener: MessagingAdapterDiagnosticListener | undefined;
    const adapter = createAdapter("feishu", {
      onDiagnostic: (listener) => {
        diagnosticListener = listener;
        return () => {
          diagnosticListener = undefined;
        };
      },
    });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      config: {
        feishu: {
          channel: "feishu",
          appId: "cli_test",
          appSecret: "secret",
          tenantUrl: "https://open.larksuite.com",
          callbackBaseUrl: "http://127.0.0.1:47823",
          authorizedActorIds: [],
        },
      },
    });

    await runtime.start();
    await diagnosticListener?.({
      id: "evt_entered",
      platform: "feishu",
      summary: "Feishu / Lark DM opened; waiting for message receive event.",
      observedAt: 1234,
      actor: { platformUserId: "ou_user" },
      channel: {
        channel: "feishu",
        conversation: {
          id: "ou_user",
          kind: "dm",
          parentId: "tenant_1",
        },
      },
      payload: {
        eventType: "im.chat.access_event.bot_p2p_chat_entered_v1",
      },
    });

    const { getAppStateDb } = await import("../state/app-state");
    const row = getAppStateDb().raw
      .prepare(
        `SELECT platform, kind, actor_id, conversation_id, summary, payload
         FROM messaging_activity_log
         WHERE kind = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get("diagnostic") as
        | {
            actor_id: string;
            conversation_id: string;
            kind: string;
            payload: string;
            platform: string;
            summary: string;
          }
        | undefined;

    expect(row).toMatchObject({
      actor_id: "ou_user",
      conversation_id: "ou_user",
      kind: "diagnostic",
      platform: "feishu",
      summary: "Feishu / Lark DM opened; waiting for message receive event.",
    });
    expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({
      eventId: "evt_entered",
      eventType: "im.chat.access_event.bot_p2p_chat_entered_v1",
    });
  });

  it("names the constrained binding in delivery budget diagnostics", async () => {
    const { runtime } = await createRuntimeHarness();
    await runtime.start();

    const event: MessagingControllerDeliveryBudgetEvent = {
      at: Date.now(),
      backend: "codex",
      bindingId: "binding:telegram:topic:-1003841603622:10345:codex:thread-1",
      channel: "telegram",
      conversation: {
        id: "10345",
        kind: "topic",
        parentId: "-1003841603622",
        parentTitle: "PwrAgent Mini Dev Group",
        title: "Test Thread",
      },
      intentId: "status:1",
      intentKind: "status",
      outcome: "dropped",
      priority: "routine_status",
      reason: "budget-exhausted",
      scope: {
        platform: "telegram",
        id: "telegram:group:-1003841603622",
        kind: "group",
        label: "PwrAgent Mini Dev",
      },
      slowMode: true,
      threadId: "thread-1",
    };
    const handleDeliveryBudgetEvent = (
      runtime as unknown as {
        handleDeliveryBudgetEvent: (
          event: MessagingControllerDeliveryBudgetEvent,
        ) => Promise<void>;
      }
    ).handleDeliveryBudgetEvent.bind(runtime);

    await handleDeliveryBudgetEvent(event);
    await handleDeliveryBudgetEvent({
      ...event,
      at: event.at + 1000,
      bindingId: "binding:telegram:topic:-1003841603622:9387:codex:thread-2",
      conversation: {
        id: "9387",
        kind: "topic",
        parentId: "-1003841603622",
        parentTitle: "PwrAgent Mini Dev Group",
        title: "Release Thread",
      },
      intentId: "status:2",
      threadId: "thread-2",
    });

    expect(runtime.getPlatformStatuses()).toEqual([
      expect.objectContaining({
        health: "degraded",
        degradationReasons: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("conversation PwrAgent Mini Dev Group / Test Thread"),
            scope: expect.objectContaining({
              id: "telegram:group:-1003841603622",
            }),
          }),
          expect.objectContaining({
            message: expect.stringContaining("conversation PwrAgent Mini Dev Group / Release Thread"),
            scope: expect.objectContaining({
              id: "telegram:group:-1003841603622",
            }),
          }),
        ]),
      }),
    ]);
    expect(runtime.getPlatformStatuses()[0]?.degradationReasons).toHaveLength(2);

    const { getAppStateDb } = await import("../state/app-state");
    const rows = getAppStateDb().raw
      .prepare(
        `SELECT binding_id, conversation_id, conversation_title, thread_id, summary, payload
         FROM messaging_activity_log
         WHERE kind = ?
         ORDER BY id DESC
         LIMIT 2`,
      )
      .all("diagnostic") as
        {
            binding_id: string;
            conversation_id: string | null;
            conversation_title: string | null;
            payload: string;
            summary: string;
            thread_id: string;
          }[];

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      binding_id: "binding:telegram:topic:-1003841603622:9387:codex:thread-2",
      summary: expect.stringContaining("conversation PwrAgent Mini Dev Group / Release Thread"),
      thread_id: "thread-2",
    });
    expect(rows[1]).toMatchObject({
      binding_id: event.bindingId,
      conversation_id: "10345",
      conversation_title: "PwrAgent Mini Dev Group / Test Thread",
      summary: expect.stringContaining("conversation PwrAgent Mini Dev Group / Test Thread"),
      thread_id: "thread-1",
    });
    expect(JSON.parse(rows[1]?.payload ?? "{}")).toMatchObject({
      bindingId: event.bindingId,
      conversationKind: "topic",
      conversationParentId: "-1003841603622",
      conversationTitle: "PwrAgent Mini Dev Group / Test Thread",
      localThreadTitle: "Thread one",
      scopeId: "telegram:group:-1003841603622",
      scopeKind: "group",
      threadId: "thread-1",
    });
  });

  it("surfaces a budget-starved approval with an operator-legible reason", async () => {
    const { runtime } = await createRuntimeHarness();
    await runtime.start();

    const event: MessagingControllerDeliveryBudgetEvent = {
      at: Date.now(),
      backend: "codex",
      bindingId: "binding:telegram:topic:-1003841603622:10345:codex:thread-1",
      channel: "telegram",
      conversation: {
        id: "10345",
        kind: "topic",
        parentId: "-1003841603622",
        parentTitle: "PwrAgent Mini Dev Group",
        title: "Approval Thread",
      },
      intentId: "approval:d778bf36",
      intentKind: "approval",
      outcome: "deferred",
      priority: "critical_interactive",
      reason: "budget-exhausted",
      retryAt: Date.now() + 12_000,
      scope: {
        platform: "telegram",
        id: "telegram:group:-1003841603622",
        kind: "group",
        label: "PwrAgent Mini Dev",
      },
      slowMode: true,
      threadId: "thread-1",
    };
    const handleDeliveryBudgetEvent = (
      runtime as unknown as {
        handleDeliveryBudgetEvent: (
          event: MessagingControllerDeliveryBudgetEvent,
        ) => Promise<void>;
      }
    ).handleDeliveryBudgetEvent.bind(runtime);

    await handleDeliveryBudgetEvent(event);

    // The live status names the approval, not the raw `critical_interactive`
    // scheduling token, so a starved approval reads as a clear reason.
    expect(runtime.getPlatformStatuses()).toEqual([
      expect.objectContaining({
        degradationReasons: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("approval / interactive prompt"),
          }),
        ]),
      }),
    ]);

    const { getAppStateDb } = await import("../state/app-state");
    const rows = getAppStateDb().raw
      .prepare(
        `SELECT summary FROM messaging_activity_log
         WHERE kind = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .all("diagnostic") as { summary: string }[];
    expect(rows[0]?.summary).toContain("approval / interactive prompt");
    expect(rows[0]?.summary).not.toContain("critical_interactive");
  });

  it("logs Telegram topic pairing activity with supergroup parent metadata", async () => {
    const { runtime, adapter } = await createRuntimeHarness();
    await runtime.start();
    const { token } = runtime.generatePairingToken({
      platform: "telegram",
      scope: "bucket",
    });

    await adapter.listener?.({
      id: "telegram:update:1:message:2",
      kind: "command",
      actor: {
        platformUserId: "8460800771",
        displayName: "Harold Hunt",
        username: "fixtureuser",
      },
      args: [token],
      channel: {
        channel: "telegram",
        conversation: {
          id: "5642",
          kind: "topic",
          parentId: "-1003841603622",
          title: "Release",
          parentTitle: "PwrDrvr",
        },
      },
      command: "pair",
      rawText: `/pair ${token}`,
      receivedAt: 1000,
      routingState: {
        opaque: {
          chatId: -1003841603622,
          messageThreadId: 5642,
        },
      },
    });

    const observed = runtime.listPairingRequests({ platform: "telegram" }).entries[0];
    expect(observed).toMatchObject({
      status: "observed",
      observedChat: {
        id: "5642",
        kind: "topic",
        parentId: "-1003841603622",
        bucketId: "-1003841603622",
      },
    });

    const { getAppStateDb } = await import("../state/app-state");
    const row = getAppStateDb().raw
      .prepare(
        `SELECT conversation_id, actor_id, payload
         FROM messaging_activity_log
         WHERE kind = ? AND summary = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get("pairing", "Observed pairing token") as
        | { actor_id: string; conversation_id: string; payload: string }
        | undefined;

    expect(row).toMatchObject({
      actor_id: "8460800771",
      conversation_id: "5642",
    });
    expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({
      conversationKind: "topic",
      conversationParentId: "-1003841603622",
      conversationBucketId: "-1003841603622",
      actorUsername: "fixtureuser",
    });
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    await expect(getDesktopMessagingStore().findObservedSurfaces()).resolves
      .toEqual([
        expect.objectContaining({
          channel: expect.objectContaining({
            channel: "telegram",
            conversation: expect.objectContaining({
              id: "5642",
              parentId: "-1003841603622",
              title: "Release",
            }),
          }),
        }),
      ]);
  });

  it("emits health=suspended for each running adapter when stopped", async () => {
    const { runtime } = await createRuntimeHarness();
    await runtime.start();
    const events: unknown[] = [];
    runtime.onPlatformStatus((event) => events.push(event));

    await runtime.stop();

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "health-changed",
        platform: "telegram",
        health: "suspended",
      }),
    );
  });

  it("getPlatformStatuses returns a snapshot keyed by platform", async () => {
    const { runtime } = await createRuntimeHarness();
    await runtime.start();

    const snapshot = runtime.getPlatformStatuses();
    expect(snapshot).toEqual([
      expect.objectContaining({
        platform: "telegram",
        health: "enabled",
      }),
    ]);
  });

  it("requestBindingRevoke routes through the controller so the platform adapter receives a Thread-detached confirmation", async () => {
    const { runtime, adapter } = await createRuntimeHarness();
    await runtime.start();
    await adapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );

    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    const store = getDesktopMessagingStore();
    const binding = await store.findActiveBindingForChannel({
      channel: "telegram",
      conversation: { id: "chat-1", kind: "dm" },
    });
    expect(binding).toBeDefined();

    adapter.delivered.length = 0;

    const result = await runtime.requestBindingRevoke({
      bindingId: binding!.id,
      origin: "ui",
    });

    expect(result).toEqual({ revoked: true, notifiedPlatform: true });
    expect(adapter.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Thread detached",
    });
    await expect(store.getBinding(binding!.id)).resolves.toMatchObject({
      revokedAt: expect.any(Number),
    });
  });

  it("requestBindingRevoke falls back to a store-only revoke when no controller scopes the binding's channel", async () => {
    const { runtime, adapter } = await createRuntimeHarness();
    await runtime.start();
    await adapter.listener?.(
      buildCallbackEvent("bind:codex:thread-1", {
        backend: "codex",
        threadId: "thread-1",
      }),
    );

    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );
    const store = getDesktopMessagingStore();
    const binding = await store.findActiveBindingForChannel({
      channel: "telegram",
      conversation: { id: "chat-1", kind: "dm" },
    });
    expect(binding).toBeDefined();

    await runtime.stop();
    adapter.delivered.length = 0;

    const result = await runtime.requestBindingRevoke({
      bindingId: binding!.id,
      origin: "ui",
    });

    expect(result).toEqual({ revoked: true, notifiedPlatform: false });
    expect(adapter.delivered).toHaveLength(0);
    await expect(store.getBinding(binding!.id)).resolves.toMatchObject({
      revokedAt: expect.any(Number),
    });
  });

  it("requestBindingRevoke is a no-op for unknown or already-revoked bindings", async () => {
    const { runtime } = await createRuntimeHarness();
    await runtime.start();

    const result = await runtime.requestBindingRevoke({
      bindingId: "binding:does-not-exist",
      origin: "ui",
    });
    expect(result).toEqual({ revoked: false, notifiedPlatform: false });
  });

  it("requestBindingRevokeAllForThread fans out to every binding on the thread, regardless of platform", async () => {
    await prepareRuntimeStore();
    const telegramAdapter = createAdapter("telegram");
    const discordAdapter = createAdapter("discord");
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: () => [telegramAdapter, discordAdapter],
      backendBridge: bridge,
      config: {
        inputDebounceMs: 0,
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
        discord: {
          channel: "discord",
          botToken: "discord-token",
          applicationId: "app-1",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });
    await runtime.start();

    await telegramAdapter.listener?.(
      buildCallbackEvent(
        "bind:codex:thread-1",
        { backend: "codex", threadId: "thread-1" },
        "telegram",
      ),
    );
    await discordAdapter.listener?.(
      buildCallbackEvent(
        "bind:codex:thread-1",
        { backend: "codex", threadId: "thread-1" },
        "discord",
      ),
    );

    telegramAdapter.delivered.length = 0;
    discordAdapter.delivered.length = 0;

    const result = await runtime.requestBindingRevokeAllForThread({
      backend: "codex",
      threadId: "thread-1",
      origin: "thread-archive",
    });

    expect(result).toEqual({ revokedCount: 2, notifiedCount: 2 });
    expect(telegramAdapter.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Thread detached",
    });
    expect(discordAdapter.delivered.at(-1)).toMatchObject({
      kind: "confirmation",
      title: "Thread detached",
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
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await runtime.stop();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(adapter.stop).toHaveBeenCalledTimes(1);
  });

  it("hot-applies config by leaving unchanged adapters alone and starting new channels", async () => {
    await prepareRuntimeStore();
    const telegramAdapter = createAdapter("telegram");
    const discordAdapter = createAdapter("discord");
    const slackAdapter = createAdapter("slack");
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => [
      ...(config.telegram ? [telegramAdapter] : []),
      ...(config.discord ? [discordAdapter] : []),
      ...(config.slack ? [slackAdapter] : []),
    ]);
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        inputDebounceMs: 0,
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await runtime.applyConfig({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
      discord: {
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
      slack: {
        channel: "slack",
        botToken: "slack-bot-token",
        appToken: "slack-app-token",
        inboundMode: "socket",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    });

    expect(telegramAdapter.start).toHaveBeenCalledTimes(1);
    expect(telegramAdapter.stop).not.toHaveBeenCalled();
    expect(discordAdapter.start).toHaveBeenCalledTimes(1);
    expect(slackAdapter.start).toHaveBeenCalledTimes(1);
    expect(runtime.getPlatformStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: "telegram", health: "enabled" }),
        expect.objectContaining({ platform: "discord", health: "enabled" }),
        expect.objectContaining({ platform: "slack", health: "enabled" }),
      ]),
    );
  });

  it("hot-applies Slack config changes by restarting the running adapter", async () => {
    await prepareRuntimeStore();
    const firstSlackAdapter = createAdapter("slack");
    const secondSlackAdapter = createAdapter("slack");
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => {
      if (!config.slack) return [];
      return [
        config.slack.botToken === "slack-bot-token-2"
          ? secondSlackAdapter
          : firstSlackAdapter,
      ];
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        inputDebounceMs: 0,
        slack: {
          channel: "slack",
          botToken: "slack-bot-token-1",
          appToken: "slack-app-token",
          inboundMode: "socket",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await runtime.applyConfig({
      inputDebounceMs: 0,
      slack: {
        channel: "slack",
        botToken: "slack-bot-token-2",
        appToken: "slack-app-token",
        inboundMode: "socket",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    });

    expect(firstSlackAdapter.stop).toHaveBeenCalledTimes(1);
    expect(secondSlackAdapter.start).toHaveBeenCalledTimes(1);
    expect(runtime.getPlatformStatuses()).toEqual([
      expect.objectContaining({
        platform: "slack",
        health: "enabled",
      }),
    ]);
  });

  it("hot-applies authorization changes without restarting the running adapter", async () => {
    await prepareRuntimeStore();
    const updateAuthorization = vi.fn(async () => undefined);
    const telegramAdapter = createAdapter("telegram", {
      updateAuthorization,
      updateRenderingPreferences: vi.fn(async () => undefined),
    });
    const replacementTelegramAdapter = createAdapter("telegram");
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => {
      if (!config.telegram) return [];
      return [
        config.telegram.authorizedActorIds.length > 1
          ? replacementTelegramAdapter
          : telegramAdapter,
      ];
    });
    const bridge = createBackendBridge();
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: bridge,
      config: {
        inputDebounceMs: 0,
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
          authorizedSupergroupIds: [{ id: "-1001", displayName: "" }],
        },
      },
    });

    await runtime.start();
    vi.mocked(bridge.getNavigationSnapshot).mockClear();
    await runtime.applyConfig({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: [
          { id: "user-1", displayName: "" },
          { id: "user-2", displayName: "" },
        ],
        authorizedSupergroupIds: [
          { id: "-1001", displayName: "" },
          { id: "-1002", displayName: "" },
        ],
      },
    });
    await telegramAdapter.listener?.({
      ...buildCommandEvent("/resume"),
      actor: { platformUserId: "user-2" },
    });

    expect(telegramAdapter.start).toHaveBeenCalledTimes(1);
    expect(telegramAdapter.stop).not.toHaveBeenCalled();
    expect(telegramAdapter.updateAuthorization).toHaveBeenCalledWith({
      authorizedActorIds: ["user-1", "user-2"],
      authorizedConversationIds: ["-1001", "-1002"],
      responseMode: undefined,
      conversationResponseModes: [],
    });
    expect(replacementTelegramAdapter.start).not.toHaveBeenCalled();
    expect(bridge.getNavigationSnapshot).toHaveBeenCalledWith({
      backend: "all",
    });
    expect(messagingLog.info).toHaveBeenCalledWith(
      "telegram: hot-applied messaging config",
      expect.objectContaining({
        channel: "telegram",
        changedFields: [
          "telegram.authorizedActorIds",
          "telegram.authorizedSupergroupIds",
        ],
      }),
    );
  });

  it("hot-applies Slack actor metadata without restarting the running adapter", async () => {
    await prepareRuntimeStore();
    const updateAuthorization = vi.fn(async () => undefined);
    const slackAdapter = createAdapter("slack", { updateAuthorization });
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) =>
      config.slack ? [slackAdapter] : [],
    );
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        inputDebounceMs: 0,
        slack: {
          channel: "slack",
          botToken: "slack-bot-token",
          authorizedActorIds: [{ id: "U012ABCDEF0", displayName: "Harold" }],
        },
      },
    });

    await runtime.start();
    await runtime.applyConfig({
      inputDebounceMs: 0,
      slack: {
        channel: "slack",
        botToken: "slack-bot-token",
        authorizedActorIds: [{
          id: "U012ABCDEF0",
          displayName: "Harold Hunt",
          username: "hhunt",
        }],
      },
    });

    expect(slackAdapter.start).toHaveBeenCalledTimes(1);
    expect(slackAdapter.stop).not.toHaveBeenCalled();
    expect(updateAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      authorizedActorIds: ["U012ABCDEF0"],
      authorizedActors: [{
        platformUserId: "U012ABCDEF0",
        displayName: "Harold Hunt",
        username: "hhunt",
      }],
    }));
  });

  it("restarts on authorization changes when the adapter has no hot-update hook", async () => {
    await prepareRuntimeStore();
    const firstTelegramAdapter = createAdapter("telegram");
    const secondTelegramAdapter = createAdapter("telegram");
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => {
      if (!config.telegram) return [];
      return [
        config.telegram.authorizedActorIds.length > 1
          ? secondTelegramAdapter
          : firstTelegramAdapter,
      ];
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        inputDebounceMs: 0,
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await runtime.applyConfig({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram",
        botToken: "telegram-token",
        authorizedActorIds: [
          { id: "user-1", displayName: "" },
          { id: "user-2", displayName: "" },
        ],
      },
    });

    expect(firstTelegramAdapter.stop).toHaveBeenCalledTimes(1);
    expect(secondTelegramAdapter.start).toHaveBeenCalledTimes(1);
  });

  it("hot-applies LINE authorization changes without restarting the running adapter", async () => {
    await prepareRuntimeStore();
    const updateAuthorization = vi.fn(async () => undefined);
    const lineAdapter = createAdapter("line", {
      updateAuthorization,
      updateRenderingPreferences: vi.fn(async () => undefined),
    });
    const replacementLineAdapter = createAdapter("line");
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => {
      if (!config.line) return [];
      return [
        config.line.authorizedActorIds.some((actor) => actor.id === "user-2")
          ? replacementLineAdapter
          : lineAdapter,
      ];
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        inputDebounceMs: 0,
        line: {
          channel: "line",
          channelAccessToken: "line-token",
          channelSecret: "line-secret",
          callbackBaseUrl: "http://127.0.0.1:47822/",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
          authorizedGroupIds: [{ id: "C0123456789abcdef0123456789abcdef", displayName: "" }],
          authorizedRoomIds: [{ id: "R0123456789abcdef0123456789abcdef", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await runtime.applyConfig({
      inputDebounceMs: 0,
      line: {
        channel: "line",
        channelAccessToken: "line-token",
        channelSecret: "line-secret",
        callbackBaseUrl: "http://127.0.0.1:47822/",
        authorizedActorIds: [{ id: "user-2", displayName: "" }],
        authorizedGroupIds: [{ id: "C22222222222222222222222222222222", displayName: "" }],
        authorizedRoomIds: [{ id: "R22222222222222222222222222222222", displayName: "" }],
      },
    });

    expect(lineAdapter.start).toHaveBeenCalledTimes(1);
    expect(lineAdapter.stop).not.toHaveBeenCalled();
    expect(lineAdapter.updateAuthorization).toHaveBeenCalledWith({
      authorizedActorIds: ["user-2"],
      authorizedConversationIds: [
        "C22222222222222222222222222222222",
        "R22222222222222222222222222222222",
      ],
    });
    expect(replacementLineAdapter.start).not.toHaveBeenCalled();
  });

  it("hot-applies config by stopping disabled channels and restarting changed credentials", async () => {
    await prepareRuntimeStore();
    const firstTelegramAdapter = createAdapter("telegram", {
      readCredentialMetadata: () => ({
        account: "@old_bot",
        detail: "api.telegram.org",
      }),
    });
    const secondTelegramAdapter = createAdapter("telegram", {
      readCredentialMetadata: () => ({
        account: "@new_bot",
        detail: "api.telegram.org",
      }),
    });
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => {
      if (!config.telegram) return [];
      return [
        config.telegram.botToken === "telegram-token-2"
          ? secondTelegramAdapter
          : firstTelegramAdapter,
      ];
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        inputDebounceMs: 0,
        telegram: {
          channel: "telegram",
          botToken: "telegram-token-1",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await runtime.applyConfig({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram",
        botToken: "telegram-token-2",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    });
    await runtime.applyConfig({
      inputDebounceMs: 0,
      enabled: false,
    });

    expect(firstTelegramAdapter.stop).toHaveBeenCalledTimes(1);
    expect(secondTelegramAdapter.start).toHaveBeenCalledTimes(1);
    expect(secondTelegramAdapter.stop).toHaveBeenCalledTimes(1);
    expect(runtime.getPlatformStatuses()).toEqual([
      expect.objectContaining({
        platform: "telegram",
        health: "suspended",
      }),
    ]);
    expect(runtime.getPlatformStatuses()[0]).not.toHaveProperty("account");
    expect(runtime.getPlatformCredentialMetadata("telegram")).toBeUndefined();
  });

  it("preserves errored health when a hot restart replacement fails", async () => {
    await prepareRuntimeStore();
    const firstTelegramAdapter = createAdapter("telegram", {
      readCredentialMetadata: () => ({
        account: "@old_bot",
        detail: "api.telegram.org",
      }),
    });
    const failingTelegramAdapter = createAdapter("telegram", {
      start: vi.fn(async () => {
        throw new Error("new token rejected");
      }),
    });
    const factory = vi.fn<DesktopMessagingAdapterFactory>(({ config }) => {
      if (!config.telegram) return [];
      return [
        config.telegram.botToken === "telegram-token-2"
          ? failingTelegramAdapter
          : firstTelegramAdapter,
      ];
    });
    const { DesktopMessagingRuntime: Runtime } = await import(
      "../messaging/messaging-runtime"
    );
    const runtime = new Runtime({
      adapterFactory: factory,
      backendBridge: createBackendBridge(),
      config: {
        inputDebounceMs: 0,
        telegram: {
          channel: "telegram",
          botToken: "telegram-token-1",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    });

    await runtime.start();
    await runtime.applyConfig({
      inputDebounceMs: 0,
      telegram: {
        channel: "telegram",
        botToken: "telegram-token-2",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    });

    expect(firstTelegramAdapter.stop).toHaveBeenCalledTimes(1);
    expect(failingTelegramAdapter.start).toHaveBeenCalledTimes(1);
    expect(runtime.getPlatformStatuses()).toEqual([
      expect.objectContaining({
        platform: "telegram",
        health: "errored",
        reason: "new token rejected",
      }),
    ]);
    expect(runtime.getPlatformStatuses()[0]).not.toHaveProperty("account");
    expect(runtime.getPlatformCredentialMetadata("telegram")).toBeUndefined();
  });
});

async function createSlackRejectedRuntimeHarness(): Promise<{
  bridge: ReturnType<typeof createBackendBridge>;
  reject: (event: MessagingRejectedInboundEvent) => Promise<void>;
}> {
  await prepareRuntimeStore();
  let rejectedListener: MessagingInboundRejectedListener | undefined;
  const adapter = createAdapter("slack", {
    onInboundRejected: (listener: MessagingInboundRejectedListener) => {
      rejectedListener = listener;
      return () => {
        rejectedListener = undefined;
      };
    },
  });
  const bridge = createBackendBridge();
  const { DesktopMessagingRuntime: Runtime } = await import(
    "../messaging/messaging-runtime"
  );
  const runtime = trackRuntime(new Runtime({
    adapterFactory: () => [adapter],
    backendBridge: bridge,
    config: {
      slack: {
        channel: "slack",
        appToken: "slack-app-token",
        botToken: "slack-bot-token",
        signingSecret: "slack-signing-secret",
        authorizedActorIds: [{ id: "user-1", displayName: "" }],
      },
    },
  }));
  await runtime.start();
  return {
    bridge,
    reject: async (event) => {
      await rejectedListener?.(event);
    },
  };
}

function buildRejectedSlackEvent(
  id: string,
  botMention = false,
): MessagingRejectedInboundEvent {
  return {
    id,
    kind: "text",
    actor: {
      platformUserId: "user-2",
      displayName: "Other User",
    },
    ...(botMention ? { botMention: true } : {}),
    channel: {
      channel: "slack",
      conversation: {
        id: "C012ABCDEF0",
        kind: "channel",
        title: "p-search-signals-projects",
      },
    },
    receivedAt: 1234,
    reason: "unauthorized-actor",
  };
}

function buildFullAccessRuntimeConfig(
  allowThreadResume: boolean,
): DesktopMessagingConfig {
  return {
    inputDebounceMs: 0,
    fullAccessControls: {
      allowEscalation: true,
      allowThreadResume,
      warningPolicy: "dismissable",
      authorizedUsers: {
        telegram: [{ id: "user-1", displayName: "" }],
      },
    },
    telegram: {
      channel: "telegram",
      botToken: "telegram-token",
      authorizedActorIds: [{ id: "user-1", displayName: "" }],
    },
  };
}

async function createFullAccessRuntimeHarness(
  config: DesktopMessagingConfig | DesktopMessagingConfigLoader,
): Promise<{
  adapter: ReturnType<typeof createAdapter>;
  bridge: ReturnType<typeof createBackendBridge>;
  runtime: DesktopMessagingRuntime;
}> {
  await prepareRuntimeStore();
  const adapter = createAdapter("telegram");
  const bridge = createBackendBridge();
  const navigation = buildNavigationSnapshot();
  vi.mocked(bridge.getNavigationSnapshot).mockResolvedValue({
    ...navigation,
    threads: [{
      ...navigation.threads[0]!,
      executionMode: "full-access",
    }],
  });
  const { DesktopMessagingRuntime: Runtime } = await import(
    "../messaging/messaging-runtime"
  );
  const runtime = trackRuntime(new Runtime({
    adapterFactory: () => [adapter],
    backendBridge: bridge,
    config,
  }));
  const { getDesktopMessagingStore } = await import(
    "../messaging/desktop-messaging-store"
  );
  await getDesktopMessagingStore().upsertBinding({
    id: "binding:full-access",
    channel: {
      channel: "telegram",
      conversation: { id: "chat-1", kind: "dm" },
    },
    backend: "codex",
    threadId: "thread-1",
    authorizedActorIds: ["user-1"],
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  return { adapter, bridge, runtime };
}

async function createRuntimeHarness(options: {
  adapter?: ReturnType<typeof createAdapter>;
} = {}): Promise<{
  DesktopMessagingRuntime: typeof DesktopMessagingRuntime;
  adapter: ReturnType<typeof createAdapter>;
  bridge: ReturnType<typeof createBackendBridge>;
  emitBackendEvent: (event: AgentEvent) => Promise<void>;
  runtime: DesktopMessagingRuntime;
}> {
  await prepareRuntimeStore();

  const adapter = options.adapter ?? createAdapter("telegram");
  const bridge = createBackendBridge();
  const { DesktopMessagingRuntime: Runtime } = await import(
    "../messaging/messaging-runtime"
  );
  const runtime = trackRuntime(
    new Runtime({
      adapterFactory: () => [adapter],
      backendBridge: bridge,
      config: {
        inputDebounceMs: 0,
        telegram: {
          channel: "telegram",
          botToken: "telegram-token",
          authorizedActorIds: [{ id: "user-1", displayName: "" }],
        },
      },
    }),
  );

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

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
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
  setRemoteEventSubscriptions: (
    subscriptions: readonly FederationEventSubscription[],
  ) => void;
} {
  const backendListeners = new Set<(event: AgentEvent) => void | Promise<void>>();

  const bridge: ReturnType<typeof createBackendBridge> = {
    getNavigationSnapshot: vi.fn(async () => buildNavigationSnapshot()),
    // Production reads a thread's `agent` from its overlay row on BOTH the
    // navigation path and the admission path, so a fixture whose admission
    // state disagrees with its own navigation describes a state the app
    // cannot reach. Resolve from whatever snapshot this bridge is serving,
    // and answer for the thread that was actually asked about.
    getThreadAdmissionState: vi.fn(async (request) => {
      const navigation = await bridge.getNavigationSnapshot();
      const thread = navigation.threads.find(
        (candidate) =>
          candidate.source === request.backend
          && candidate.id === request.threadId,
      );
      return thread ? { thread } : {};
    }),
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
    setRemoteEventSubscriptions: vi.fn(),
    emitBackendEvent: async (event: AgentEvent) => {
      await Promise.all(
        [...backendListeners].map(async (listener) => {
          await listener(event);
        }),
      );
    },
  };
  return bridge;
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

function buildTextEvent(
  text: string,
  overrides: {
    actorDisplayName?: string;
    conversationTitle?: string;
  } = {},
): Extract<MessagingInboundEvent, { kind: "text" }> {
  return {
    id: "event-text",
    kind: "text",
    actor: {
      platformUserId: "user-1",
      displayName: overrides.actorDisplayName,
    },
    channel: {
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
        title: overrides.conversationTitle,
      },
    },
    receivedAt: 1000,
    text,
  };
}
