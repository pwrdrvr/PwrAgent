import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { DesktopAutoCompactionRule } from "@pwragent/shared/auto-compaction";
import {
  AUTO_COMPACTION_CONTINUATION_TEXT,
  AUTO_COMPACTION_ORIGIN,
  createRegistryAutoCompactionMonitor,
  readCodexContextFill,
  type AutoCompactionRegistry,
} from "../app-server/thread-auto-compaction-monitor";

const NEON_WINDOW = 1_048_576;

function fakeRegistry(options: {
  backend?: string;
  model?: string;
  canSteer?: boolean;
  canStart?: "yes" | "blocked" | "unsupported";
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
});
