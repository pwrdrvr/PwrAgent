import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { AcpSessionMetadata } from "@pwragent/owner-core/acp-storage";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AcpBackendId } from "@pwragent/shared/contracts/normalized-app-server";
import type { DesktopAutoCompactionRule } from "@pwragent/shared/auto-compaction";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { ThreadCorrespondenceStore } from "../app-server/thread-correspondence-store";
import { buildTurnUserMessageOriginId } from "../app-server/thread-transcript-helpers";
import {
  AUTO_COMPACTION_CONTINUATION_TEXT,
  AUTO_COMPACTION_ORIGIN,
  createRegistryAutoCompactionMonitor,
  readCodexContextFill,
  type AutoCompactionRegistry,
} from "../app-server/thread-auto-compaction-monitor";
import {
  createAcpAvailableCommandsStoreMock,
  createKimiAcpRegistry,
  createOverlayStoreMock,
  toTestRepositoryPath,
} from "./helpers/backend-registry-fixture";

const NEON_WINDOW = 1_048_576;

function fakeRegistry(options: {
  backend?: string;
  model?: string;
  canSteer?: boolean;
  canStart?: "yes" | "blocked" | "unsupported";
  reportsFillOnNextTurn?: boolean;
} = {}) {
  let listener: ((event: AgentEvent) => void | Promise<void>) | undefined;
  let activeTurn: string | undefined;
  const published: AgentEvent[] = [];
  const registry = {
    onEvent: vi.fn((next: (event: AgentEvent) => void | Promise<void>) => {
      listener = next;
      return () => { listener = undefined; };
    }),
    getActiveTurnForThread: vi.fn(() => (activeTurn ? { turnId: activeTurn } : undefined)),
    autoCompactionSupport: vi.fn(() => ({
      canSteer: options.canSteer ?? true,
      canStart: options.canStart ?? "yes",
      ...(options.reportsFillOnNextTurn ? { reportsFillOnNextTurn: true } : {}),
    })),
    resolveAutoCompactionModel: vi.fn(async () => options.model ?? "gemini-4-neon-high"),
    startAutoCompaction: vi.fn(async () => ({ status: "started" as const, turnId: "turn-compact" })),
    steerTurn: vi.fn(async () => ({})),
    submitTurnIfIdle: vi.fn(async () => ({ status: "started" })),
    publishLocalEvent: vi.fn(async (event: AgentEvent) => { published.push(event); }),
  } satisfies AutoCompactionRegistry;
  const backend = (options.backend ?? "acp:antigravity") as AgentEvent["backend"];
  const emit = (notification: AgentEvent["notification"], extra: Partial<AgentEvent> = {}) => {
    void listener?.({ backend, notification, ...extra });
  };
  return {
    registry,
    published,
    backend,
    setActiveTurn: (turnId: string | undefined) => { activeTurn = turnId; },
    fill: (usedTokens: number, modelContextWindow = NEON_WINDOW) => emit({
      method: "thread/contextWindow/updated",
      params: { threadId: "thread-1", usedTokens, modelContextWindow },
    }),
    turnStarted: (turnId: string) => {
      activeTurn = turnId;
      emit({ method: "turn/started", params: { threadId: "thread-1", turnId, turn: { id: turnId } } });
    },
    turnCompleted: (turnId: string) => {
      activeTurn = undefined;
      emit({
        method: "turn/completed",
        params: { threadId: "thread-1", turnId, turn: { id: turnId, status: "completed" } },
      } as AgentEvent["notification"]);
    },
    turnCancelled: (turnId: string) => {
      activeTurn = undefined;
      emit({
        method: "turn/cancelled",
        params: { threadId: "thread-1", turnId, turn: { id: turnId, status: "cancelled" } },
      } as AgentEvent["notification"]);
    },
    emit,
  };
}

function start(world: ReturnType<typeof fakeRegistry>, saved: DesktopAutoCompactionRule[] = []) {
  const monitor = createRegistryAutoCompactionMonitor({
    registry: world.registry,
    resolveSavedRules: () => saved,
    log: { info: vi.fn(), warn: vi.fn() },
  });
  monitor.start();
  return monitor;
}

describe("ThreadAutoCompactionMonitor", () => {
  it("steers /compact into a running Gemini 4 Neon turn past 409,600 tokens, once, then continues the work", async () => {
    const world = fakeRegistry();
    const monitor = start(world);
    world.turnStarted("turn-1");
    world.fill(300_000);
    world.fill(412_000);
    world.fill(415_000);
    await monitor.idle();

    expect(world.registry.steerTurn).toHaveBeenCalledTimes(1);
    expect(world.registry.steerTurn).toHaveBeenCalledWith(expect.objectContaining({
      backend: "acp:antigravity",
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "/compact" }],
    }), AUTO_COMPACTION_ORIGIN);
    expect(world.registry.startAutoCompaction).not.toHaveBeenCalled();
    expect(monitor.stateFor(world.backend, "thread-1")?.phase).toBe("compacting");

    world.fill(61_000);
    await monitor.idle();
    expect(monitor.stateFor(world.backend, "thread-1")?.phase).toBe("resume");
    world.turnCompleted("turn-1");
    await monitor.idle();
    expect(world.registry.submitTurnIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      input: [{ type: "text", text: AUTO_COMPACTION_CONTINUATION_TEXT }],
      messageOrigin: AUTO_COMPACTION_ORIGIN,
    }));
    expect(monitor.stateFor(world.backend, "thread-1")?.phase).toBe("armed");
    expect(world.published.map((event) => (event.notification.params as { phase: string }).phase))
      .toEqual(["armed", "steering", "compacting", "resume", "armed"]);
    monitor.dispose();
  });

  it("keeps an open steer when the rules change, so its answer is not dropped and no second /compact goes out", async () => {
    const world = fakeRegistry();
    let answerSteer: (() => void) | undefined;
    world.registry.steerTurn.mockImplementationOnce(() => new Promise((resolve) => {
      answerSteer = () => resolve({});
    }));
    let saved: DesktopAutoCompactionRule[] = [];
    const monitor = createRegistryAutoCompactionMonitor({
      registry: world.registry,
      resolveSavedRules: () => saved,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    monitor.start();
    world.turnStarted("turn-1");
    world.fill(412_000);
    await vi.waitFor(() => expect(answerSteer).toBeDefined());
    expect(monitor.stateFor(world.backend, "thread-1")?.phase).toBe("steering");

    // Another thread's fill picks up a rule saved meanwhile.
    saved = [{ provider: "codex", model: "gpt-5", enabled: true }];
    world.emit({
      method: "thread/contextWindow/updated",
      params: { threadId: "thread-2", usedTokens: 100_000, modelContextWindow: NEON_WINDOW },
    });
    await vi.waitFor(() => expect(monitor.stateFor(world.backend, "thread-2")?.lastFill).toBe(100_000));

    answerSteer?.();
    await monitor.idle();
    expect(monitor.stateFor(world.backend, "thread-1")?.phase).toBe("compacting");
    world.fill(415_000);
    await monitor.idle();
    expect(world.registry.steerTurn).toHaveBeenCalledTimes(1);
    monitor.dispose();
  });

  it("starts one compaction between turns when the provider cannot steer", async () => {
    const world = fakeRegistry({ canSteer: false });
    const monitor = start(world);
    world.turnStarted("turn-1");
    world.fill(450_000);
    await monitor.idle();
    expect(world.registry.steerTurn).not.toHaveBeenCalled();
    expect(monitor.stateFor(world.backend, "thread-1")?.phase).toBe("due");
    world.turnCompleted("turn-1");
    world.fill(450_000);
    await monitor.idle();
    expect(world.registry.startAutoCompaction).toHaveBeenCalledTimes(1);
    expect(world.registry.startAutoCompaction).toHaveBeenCalledWith({
      backend: "acp:antigravity",
      threadId: "thread-1",
      messageOrigin: AUTO_COMPACTION_ORIGIN,
    });
    monitor.dispose();
  });

  it("waits, without counting a refusal, while the thread is busy", async () => {
    const world = fakeRegistry({ canSteer: false });
    world.registry.startAutoCompaction.mockResolvedValueOnce({ status: "busy" } as never);
    const monitor = start(world);
    world.fill(450_000);
    await monitor.idle();
    expect(monitor.stateFor(world.backend, "thread-1")).toMatchObject({ phase: "due" });
    expect(monitor.stateFor(world.backend, "thread-1")?.refusals).toBeUndefined();
    world.turnStarted("turn-2");
    world.turnCompleted("turn-2");
    await monitor.idle();
    expect(world.registry.startAutoCompaction).toHaveBeenCalledTimes(2);
    monitor.dispose();
  });

  it("leaves models no rule covers alone, and honors a saved rule that turns the Gemini default off", async () => {
    const claude = fakeRegistry({ model: "claude-sonnet-5-5" });
    const first = start(claude);
    claude.fill(900_000);
    await first.idle();
    expect(claude.registry.startAutoCompaction).not.toHaveBeenCalled();
    expect(claude.published).toEqual([]);
    first.dispose();

    const off = fakeRegistry();
    const second = start(off, [{ provider: "*", model: "gemini-*", enabled: false }]);
    off.fill(900_000);
    await second.idle();
    expect(off.registry.startAutoCompaction).not.toHaveBeenCalled();
    second.dispose();
  });

  it("ignores events a federation peer relays", async () => {
    const world = fakeRegistry();
    const monitor = start(world);
    world.emit(
      { method: "thread/contextWindow/updated", params: { threadId: "thread-1", usedTokens: 900_000, modelContextWindow: NEON_WINDOW } },
      { federationTarget: { scope: "remote", instanceId: "peer" } as AgentEvent["federationTarget"] },
    );
    await monitor.idle();
    expect(world.registry.startAutoCompaction).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("reads Codex context fill from the last request against the model window", () => {
    expect(readCodexContextFill({
      total: { totalTokens: 900_000 },
      last: { totalTokens: 120_000 },
      modelContextWindow: 272_000,
    })).toEqual({ usedTokens: 120_000, reportedContextWindow: 272_000 });
    expect(readCodexContextFill({ last: { totalTokens: 1 } })).toBeUndefined();
  });

  it("continues immediately on Antigravity after steered /compact emits a higher summarization fill, then re-arms on the continuation turn", async () => {
    const world = fakeRegistry({ reportsFillOnNextTurn: true });
    const monitor = start(world);
    world.turnStarted("turn-1");
    world.fill(412_000);
    await monitor.idle();

    expect(world.registry.steerTurn).toHaveBeenCalledTimes(1);
    expect(monitor.stateFor(world.backend, "thread-1")?.phase).toBe("compacting");

    // Antigravity emits the summarization call's higher usage_update right before turn/completed.
    world.fill(425_000);
    world.turnCompleted("turn-1");
    await monitor.idle();

    expect(world.registry.startAutoCompaction).not.toHaveBeenCalled();
    expect(world.registry.submitTurnIfIdle).toHaveBeenCalledTimes(1);
    expect(world.registry.submitTurnIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      input: [{ type: "text", text: AUTO_COMPACTION_CONTINUATION_TEXT }],
      messageOrigin: AUTO_COMPACTION_ORIGIN,
    }));
    expect(monitor.stateFor(world.backend, "thread-1")?.phase).toBe("verifying");

    // The continuation turn's first usage_update reports the actual compacted fill.
    world.turnStarted("turn-2");
    world.fill(21_436);
    await monitor.idle();
    expect(monitor.stateFor(world.backend, "thread-1")?.phase).toBe("armed");
    expect(world.published.map((event) => (event.notification.params as { phase: string }).phase))
      .toEqual(["steering", "compacting", "verifying", "armed"]);
    monitor.dispose();
  });

  it("clears compacting immediately without a continuation or delayed idle retry when a steered Antigravity /compact turn is cancelled", async () => {
    vi.useFakeTimers();
    try {
      const world = fakeRegistry({ reportsFillOnNextTurn: true });
      const monitor = start(world);
      world.turnStarted("turn-1");
      world.fill(412_000);
      await monitor.idle();
      world.turnCancelled("turn-1");
      await monitor.idle();

      expect(world.registry.submitTurnIfIdle).not.toHaveBeenCalled();
      expect(monitor.stateFor(world.backend, "thread-1")?.phase).toBe("armed");

      // Advancing past the 15s settle timeout must not start an unrequested idle /compact.
      await vi.advanceTimersByTimeAsync(20_000);
      await monitor.idle();
      expect(world.registry.startAutoCompaction).not.toHaveBeenCalled();
      expect(world.registry.submitTurnIfIdle).not.toHaveBeenCalled();
      expect(monitor.stateFor(world.backend, "thread-1")?.phase).toBe("armed");
      monitor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ACP registry cache fallback and shared /compact dispatch", () => {
  const ANTIGRAVITY: AcpBackendId = "acp:antigravity";
  const SESSION_ID = "antigravity-auto-compact-1";
  const CWD = "/Users/test/repo";
  const registries: DesktopBackendRegistry[] = [];

  afterEach(async () => {
    await Promise.all(registries.splice(0).map((registry) => registry.close()));
  });

  function acpSession(overrides: Partial<AcpSessionMetadata> = {}): AcpSessionMetadata {
    return {
      backendId: ANTIGRAVITY,
      sessionId: SESSION_ID,
      title: "Antigravity thread",
      cwd: CWD,
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
      ...overrides,
    };
  }

  it("uses the repo command cache for autoCompactionSupport and dispatches alias-matched ACP /compact through the shared compact path", async () => {
    const startPrompt = vi.fn(() => ({ sessionId: SESSION_ID, turnId: "compact-turn-cache" }));
    const startSession = vi.fn();
    const correspondenceDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-auto-compact-stack-"));
    onTestFinished(() => rmSync(correspondenceDir, { recursive: true, force: true }));
    const correspondenceStore = new ThreadCorrespondenceStore(correspondenceDir);
    correspondenceStore.record({
      id: "stack:auto-op-1:layer",
      source: { backend: ANTIGRAVITY, threadId: SESSION_ID },
      destination: { backend: ANTIGRAVITY, threadId: SESSION_ID, title: "Antigravity thread" },
      input: [],
      createdAt: 1000,
      state: "started",
      stackNotice: {
        opId: "auto-op-1",
        kind: "restack",
        branch: "layer",
        stack: "stack",
        by: { threadId: "lead", actor: "agent" },
        from: "old",
        to: "new",
        changedFiles: ["src/foo.ts"],
        staleReads: ["src/foo.ts"],
        undo: "refs/pwragent/undo/auto-op-1",
      },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        [`${ANTIGRAVITY}:${SESSION_ID}`]: {
          backend: ANTIGRAVITY,
          threadId: SESSION_ID,
          executionMode: "default",
          model: "gemini-4-neon-high",
          extraLinkedDirectories: [],
        },
      },
    });
    const availableCommandsStore = createAcpAvailableCommandsStoreMock([
      {
        backendId: ANTIGRAVITY,
        repositoryPath: toTestRepositoryPath(CWD),
        observedAt: 1000,
        commands: [
          {
            name: "summarize",
            aliases: ["compact"],
            backend: ANTIGRAVITY,
            scope: "session",
            source: "provider",
          },
        ],
      },
    ]);
    const fixture = createKimiAcpRegistry({
      acpBackendId: ANTIGRAVITY,
      sessionId: SESSION_ID,
      sessions: [acpSession({ availableCommands: [] })],
      acpAvailableCommandsStore: availableCommandsStore,
      correspondenceStore,
      overlayStore,
      startPrompt,
      startSession,
    });
    registries.push(fixture.registry);

    await expect(
      fixture.registry.autoCompactionSupport({ backend: ANTIGRAVITY, threadId: SESSION_ID }),
    ).resolves.toEqual({ canSteer: false, canStart: "yes", reportsFillOnNextTurn: true });
    expect(startSession).not.toHaveBeenCalled();

    const monitor = createRegistryAutoCompactionMonitor({
      registry: fixture.registry,
      resolveSavedRules: () => [],
      log: { info: () => {}, warn: () => {} },
    });
    monitor.start();
    try {
      await fixture.registry.publishLocalEvent({
        backend: ANTIGRAVITY,
        notification: {
          method: "thread/contextWindow/updated",
          params: { threadId: SESSION_ID, usedTokens: 450_000, modelContextWindow: NEON_WINDOW },
        },
      });
      await monitor.idle();

      expect(startSession).not.toHaveBeenCalled();
      expect(startPrompt).toHaveBeenCalledTimes(1);
      expect(startPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: SESSION_ID,
          prompt: "/summarize",
          isCompactCommand: true,
        }),
      );
      expect(
        correspondenceStore.pendingStackNotices({ backend: ANTIGRAVITY, threadId: SESSION_ID }),
      ).toHaveLength(1);
      const messageOriginId = buildTurnUserMessageOriginId("compact-turn-cache");
      expect(
        await overlayStore.readThreadMessageOrigins?.({
          backend: ANTIGRAVITY,
          threadId: SESSION_ID,
          messageIds: [messageOriginId],
        }),
      ).toEqual({
        [messageOriginId]: AUTO_COMPACTION_ORIGIN,
      });
    } finally {
      monitor.dispose();
    }
  });

  it("reports unsupported when an unadvertised ACP session's repo cache lacks compact", async () => {
    const startPrompt = vi.fn(() => ({ sessionId: SESSION_ID, turnId: "unused" }));
    const startSession = vi.fn();
    const availableCommandsStore = createAcpAvailableCommandsStoreMock([
      {
        backendId: ANTIGRAVITY,
        repositoryPath: toTestRepositoryPath(CWD),
        observedAt: 1000,
        commands: [
          {
            name: "plan",
            backend: ANTIGRAVITY,
            scope: "session",
            source: "provider",
          },
        ],
      },
    ]);
    const fixture = createKimiAcpRegistry({
      acpBackendId: ANTIGRAVITY,
      sessionId: SESSION_ID,
      sessions: [acpSession({ availableCommands: [] })],
      acpAvailableCommandsStore: availableCommandsStore,
      overlayStore: createOverlayStoreMock({
        overlays: {
          [`${ANTIGRAVITY}:${SESSION_ID}`]: {
            backend: ANTIGRAVITY,
            threadId: SESSION_ID,
            executionMode: "default",
            model: "gemini-4-neon-high",
            extraLinkedDirectories: [],
          },
        },
      }),
      startPrompt,
      startSession,
    });
    registries.push(fixture.registry);

    await expect(
      fixture.registry.autoCompactionSupport({ backend: ANTIGRAVITY, threadId: SESSION_ID }),
    ).resolves.toEqual({ canSteer: false, canStart: "unsupported" });
    expect(startSession).not.toHaveBeenCalled();

    const monitor = createRegistryAutoCompactionMonitor({
      registry: fixture.registry,
      resolveSavedRules: () => [],
      log: { info: () => {}, warn: () => {} },
    });
    monitor.start();
    try {
      await fixture.registry.publishLocalEvent({
        backend: ANTIGRAVITY,
        notification: {
          method: "thread/contextWindow/updated",
          params: { threadId: SESSION_ID, usedTokens: 450_000, modelContextWindow: NEON_WINDOW },
        },
      });
      await monitor.idle();

      expect(monitor.stateFor(ANTIGRAVITY, SESSION_ID)).toMatchObject({
        phase: "held",
        heldReason: "unsupported",
      });
      expect(startPrompt).not.toHaveBeenCalled();
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      monitor.dispose();
    }
  });

  it("stays blocked without probing when neither live commands nor repo cache exist, then dispatches once cached", async () => {
    const startPrompt = vi.fn(() => ({ sessionId: SESSION_ID, turnId: "compact-turn-later" }));
    const startSession = vi.fn();
    const availableCommandsStore = createAcpAvailableCommandsStoreMock([]);
    const fixture = createKimiAcpRegistry({
      acpBackendId: ANTIGRAVITY,
      sessionId: SESSION_ID,
      sessions: [acpSession({ availableCommands: [] })],
      acpAvailableCommandsStore: availableCommandsStore,
      overlayStore: createOverlayStoreMock({
        overlays: {
          [`${ANTIGRAVITY}:${SESSION_ID}`]: {
            backend: ANTIGRAVITY,
            threadId: SESSION_ID,
            executionMode: "default",
            model: "gemini-4-neon-high",
            extraLinkedDirectories: [],
          },
        },
      }),
      startPrompt,
      startSession,
    });
    registries.push(fixture.registry);

    await expect(
      fixture.registry.autoCompactionSupport({ backend: ANTIGRAVITY, threadId: SESSION_ID }),
    ).resolves.toEqual({ canSteer: false, canStart: "blocked" });
    expect(startSession).not.toHaveBeenCalled();

    const monitor = createRegistryAutoCompactionMonitor({
      registry: fixture.registry,
      resolveSavedRules: () => [],
      log: { info: () => {}, warn: () => {} },
    });
    monitor.start();
    try {
      await fixture.registry.publishLocalEvent({
        backend: ANTIGRAVITY,
        notification: {
          method: "thread/contextWindow/updated",
          params: { threadId: SESSION_ID, usedTokens: 450_000, modelContextWindow: NEON_WINDOW },
        },
      });
      await monitor.idle();
      expect(monitor.stateFor(ANTIGRAVITY, SESSION_ID)?.phase).toBe("due");
      expect(startPrompt).not.toHaveBeenCalled();
      expect(startSession).not.toHaveBeenCalled();

      availableCommandsStore.upsert({
        backendId: ANTIGRAVITY,
        repositoryPath: toTestRepositoryPath(CWD),
        observedAt: 2000,
        commands: [
          {
            name: "compact",
            backend: ANTIGRAVITY,
            scope: "session",
            source: "provider",
          },
        ],
      });

      await fixture.registry.publishLocalEvent({
        backend: ANTIGRAVITY,
        notification: {
          method: "thread/contextWindow/updated",
          params: { threadId: SESSION_ID, usedTokens: 455_000, modelContextWindow: NEON_WINDOW },
        },
      });
      await monitor.idle();

      expect(startPrompt).toHaveBeenCalledTimes(1);
      expect(startPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: SESSION_ID,
          prompt: "/compact",
          isCompactCommand: true,
        }),
      );
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      monitor.dispose();
    }
  });

  it("answers busy for ACP startAutoCompaction when a turn is running, a queued turn is waiting, or the thread is archived", async () => {
    const startPrompt = vi.fn(() => ({ sessionId: SESSION_ID, turnId: "active-turn-1" }));
    const fixture = createKimiAcpRegistry({
      acpBackendId: ANTIGRAVITY,
      sessionId: SESSION_ID,
      sessions: [
        acpSession({
          availableCommands: [
            { name: "compact", backend: ANTIGRAVITY, scope: "session", source: "provider" },
          ],
        }),
      ],
      startPrompt,
    });
    registries.push(fixture.registry);

    // Waiting entry in the thread turn queue (thread is idle, no active turn).
    await fixture.registry.submitHeldTurn({
      queueEntryId: "held-entry-1",
      backend: ANTIGRAVITY,
      threadId: SESSION_ID,
      input: [{ type: "text", text: "Waiting user prompt" }],
      holdReason: "locked",
    });
    await expect(
      fixture.registry.startAutoCompaction({
        backend: ANTIGRAVITY,
        threadId: SESSION_ID,
        messageOrigin: AUTO_COMPACTION_ORIGIN,
      }),
    ).resolves.toEqual({ status: "busy" });
    expect(startPrompt).not.toHaveBeenCalled();

    fixture.registry.cancelQueuedTurn("held-entry-1");

    // Running turn on the ACP thread.
    await fixture.registry.submitTurn({
      backend: ANTIGRAVITY,
      threadId: SESSION_ID,
      input: [{ type: "text", text: "In-flight user prompt" }],
    });
    expect(startPrompt).toHaveBeenCalledTimes(1);
    await expect(
      fixture.registry.startAutoCompaction({
        backend: ANTIGRAVITY,
        threadId: SESSION_ID,
        messageOrigin: AUTO_COMPACTION_ORIGIN,
      }),
    ).resolves.toEqual({ status: "busy" });
    expect(startPrompt).toHaveBeenCalledTimes(1);

    // Archived ACP thread answers busy without waking checkout or dispatching.
    const archivedPrompt = vi.fn(() => ({ sessionId: SESSION_ID, turnId: "unused" }));
    const archivedFixture = createKimiAcpRegistry({
      acpBackendId: ANTIGRAVITY,
      sessionId: SESSION_ID,
      sessions: [
        acpSession({
          availableCommands: [
            { name: "compact", backend: ANTIGRAVITY, scope: "session", source: "provider" },
          ],
        }),
      ],
      overlayStore: createOverlayStoreMock({
        overlays: {
          [`${ANTIGRAVITY}:${SESSION_ID}`]: {
            backend: ANTIGRAVITY,
            threadId: SESSION_ID,
            executionMode: "default",
            extraLinkedDirectories: [],
            archiveRetentionStartedAt: 1_700_000_000_000,
          },
        },
      }),
      startPrompt: archivedPrompt,
    });
    registries.push(archivedFixture.registry);

    await expect(
      archivedFixture.registry.startAutoCompaction({
        backend: ANTIGRAVITY,
        threadId: SESSION_ID,
        messageOrigin: AUTO_COMPACTION_ORIGIN,
      }),
    ).resolves.toEqual({ status: "busy" });
    expect(archivedPrompt).not.toHaveBeenCalled();
  });

  it("steers the resolved alias-matched ACP compact command mid-turn instead of hardcoded /compact", async () => {
    const startPrompt = vi.fn(() => ({ sessionId: SESSION_ID, turnId: "active-turn-1" }));
    const steerSession = vi.fn(async () => ({ delivery: "currentTurn" as const }));
    const availableCommandsStore = createAcpAvailableCommandsStoreMock([
      {
        backendId: ANTIGRAVITY,
        repositoryPath: toTestRepositoryPath(CWD),
        observedAt: 1000,
        commands: [
          {
            name: "summarize",
            aliases: ["compact"],
            backend: ANTIGRAVITY,
            scope: "session",
            source: "provider",
          },
        ],
      },
    ]);
    const fixture = createKimiAcpRegistry({
      acpBackendId: ANTIGRAVITY,
      sessionId: SESSION_ID,
      sessions: [acpSession({ availableCommands: [], status: "active" })],
      acpAvailableCommandsStore: availableCommandsStore,
      overlayStore: createOverlayStoreMock({
        overlays: {
          [`${ANTIGRAVITY}:${SESSION_ID}`]: {
            backend: ANTIGRAVITY,
            threadId: SESSION_ID,
            executionMode: "default",
            model: "gemini-4-neon-high",
            extraLinkedDirectories: [],
          },
        },
      }),
      startPrompt,
      steerSession,
      supportsTurnSteering: true,
    });
    registries.push(fixture.registry);

    await fixture.registry.submitTurn({
      backend: ANTIGRAVITY,
      threadId: SESSION_ID,
      input: [{ type: "text", text: "Start long work" }],
    });
    const emitEvent = (event: AgentEvent) =>
      (fixture.registry as unknown as {
        emit(next: AgentEvent): Promise<void>;
      }).emit(event);
    const pendingTurn = fixture.registry.getActiveTurnForThread({
      backend: ANTIGRAVITY,
      threadId: SESSION_ID,
    });
    if (pendingTurn) {
      await emitEvent({
        backend: ANTIGRAVITY,
        notification: {
          method: "turn/completed",
          params: {
            threadId: SESSION_ID,
            turnId: pendingTurn.turnId,
            turn: { id: pendingTurn.turnId, status: "completed", output: [] },
          },
        },
      });
    }
    await emitEvent({
      backend: ANTIGRAVITY,
      notification: {
        method: "turn/started",
        params: {
          threadId: SESSION_ID,
          turnId: "active-turn-1",
          turn: { id: "active-turn-1", status: "in_progress" },
        },
      },
    });

    const monitor = createRegistryAutoCompactionMonitor({
      registry: fixture.registry,
      resolveSavedRules: () => [],
      log: { info: () => {}, warn: () => {} },
    });
    monitor.start();
    try {
      await fixture.registry.publishLocalEvent({
        backend: ANTIGRAVITY,
        notification: {
          method: "thread/contextWindow/updated",
          params: { threadId: SESSION_ID, usedTokens: 450_000, modelContextWindow: NEON_WINDOW },
        },
      });
      await monitor.idle();

      expect(steerSession).toHaveBeenCalledTimes(1);
      expect(steerSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: SESSION_ID,
          text: "/summarize",
        }),
      );
      expect(monitor.stateFor(ANTIGRAVITY, SESSION_ID)).toMatchObject({
        phase: "compacting",
        via: "steer",
      });
    } finally {
      monitor.dispose();
    }
  });

  it("queues a concurrent submitTurn behind an in-flight ACP startAutoCompaction instead of racing it", async () => {
    let releaseCompact!: () => void;
    const compactStarted = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    let compactInFlight!: () => void;
    const reachedStartPrompt = new Promise<void>((resolve) => {
      compactInFlight = resolve;
    });
    const startPrompt = vi.fn(async (params: { prompt?: string }) => {
      if (params.prompt === "/compact") {
        compactInFlight();
        await compactStarted;
        return { sessionId: SESSION_ID, turnId: "compact-turn-race" };
      }
      return { sessionId: SESSION_ID, turnId: "user-turn-after-compact" };
    });
    const fixture = createKimiAcpRegistry({
      acpBackendId: ANTIGRAVITY,
      sessionId: SESSION_ID,
      sessions: [
        acpSession({
          availableCommands: [
            { name: "compact", backend: ANTIGRAVITY, scope: "session", source: "provider" },
          ],
        }),
      ],
      startPrompt: startPrompt as never,
    });
    registries.push(fixture.registry);

    const compactPromise = fixture.registry.startAutoCompaction({
      backend: ANTIGRAVITY,
      threadId: SESSION_ID,
      messageOrigin: AUTO_COMPACTION_ORIGIN,
    });
    await reachedStartPrompt;

    const concurrentSubmit = await fixture.registry.submitTurn({
      backend: ANTIGRAVITY,
      threadId: SESSION_ID,
      input: [{ type: "text", text: "Follow-up while compacting" }],
    });
    expect(concurrentSubmit).toMatchObject({ status: "queued" });

    releaseCompact();
    await expect(compactPromise).resolves.toEqual({
      status: "started",
      turnId: "compact-turn-race",
    });
  });

  it("skips async autoCompactionSupport I/O on fills below threshold or when no rule matches", async () => {
    const availableCommandsStore = createAcpAvailableCommandsStoreMock([]);
    const acpWorktreeRepositoryResolver = vi.fn(async () => undefined);
    const fixture = createKimiAcpRegistry({
      acpBackendId: ANTIGRAVITY,
      sessionId: SESSION_ID,
      sessions: [acpSession({ availableCommands: [] })],
      acpAvailableCommandsStore: availableCommandsStore,
      acpWorktreeRepositoryResolver,
      overlayStore: createOverlayStoreMock({
        overlays: {
          [`${ANTIGRAVITY}:${SESSION_ID}`]: {
            backend: ANTIGRAVITY,
            threadId: SESSION_ID,
            executionMode: "default",
            model: "gemini-4-neon-high",
            extraLinkedDirectories: [],
          },
        },
      }),
    });
    registries.push(fixture.registry);

    const monitor = createRegistryAutoCompactionMonitor({
      registry: fixture.registry,
      resolveSavedRules: () => [],
      log: { info: () => {}, warn: () => {} },
    });
    monitor.start();
    try {
      await fixture.registry.publishLocalEvent({
        backend: ANTIGRAVITY,
        notification: {
          method: "thread/contextWindow/updated",
          params: { threadId: SESSION_ID, usedTokens: 100_000, modelContextWindow: NEON_WINDOW },
        },
      });
      await fixture.registry.publishLocalEvent({
        backend: ANTIGRAVITY,
        notification: {
          method: "turn/completed",
          params: {
            threadId: SESSION_ID,
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed", output: [] },
          },
        },
      });
      await monitor.idle();

      expect(availableCommandsStore.get).not.toHaveBeenCalled();
      expect(acpWorktreeRepositoryResolver).not.toHaveBeenCalled();
    } finally {
      monitor.dispose();
    }
  });

  it("does not misclassify accepted compactions or strand in-flight phases when support() rejects", async () => {
    const world = fakeRegistry({ canSteer: false });
    world.registry.autoCompactionSupport
      .mockResolvedValueOnce({ canSteer: false, canStart: "yes" } as never)
      .mockRejectedValue(new Error("store closed"));
    const monitor = start(world);
    world.fill(450_000);
    await monitor.idle();
    expect(monitor.stateFor(world.backend, "thread-1")).toMatchObject({
      phase: "compacting",
      via: "start",
      turnId: "turn-compact",
    });
    expect(monitor.stateFor(world.backend, "thread-1")?.refusals).toBeUndefined();
    monitor.dispose();

    const refusedWorld = fakeRegistry({ canSteer: false });
    refusedWorld.registry.autoCompactionSupport
      .mockResolvedValueOnce({ canSteer: false, canStart: "yes" } as never)
      .mockRejectedValue(new Error("store closed"));
    refusedWorld.registry.startAutoCompaction.mockRejectedValueOnce(new Error("provider refused"));
    const refusedMonitor = start(refusedWorld);
    refusedWorld.fill(450_000);
    await refusedMonitor.idle();
    expect(refusedMonitor.stateFor(refusedWorld.backend, "thread-1")).toMatchObject({
      phase: "due",
      refusals: 1,
    });
    refusedMonitor.dispose();
  });
});
