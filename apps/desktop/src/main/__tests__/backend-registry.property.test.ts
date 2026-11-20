import { setImmediate as settle } from "node:timers/promises";
import type { AgentEvent } from "@pwragent/shared";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { registryModules } from "../app-server/backend-registry-wiring";
import type { StateDb } from "../state/state-db";
import { registryWithInMemoryStore } from "./helpers/registry-in-memory-fixture";

type TerminalMethod = "turn/completed" | "turn/failed" | "turn/cancelled";

async function checkTerminalDrain(method: TerminalMethod, unregisteredAtSnapshot: boolean) {
  const databases: StateDb[] = [];
  const registry = registryWithInMemoryStore(databases);
  const { emit } = registry.constructionPorts();
  const { turnState } = registryModules(registry);
  const branchEntered = Promise.withResolvers<void>();
  const releaseBranch = Promise.withResolvers<void>();
  const listenerEntered = Promise.withResolvers<void>();
  const releaseListener = Promise.withResolvers<void>();
  const stages = registry as unknown as { adoptThreadBranchChangeFromActiveTurn(): Promise<void> };
  vi.spyOn(stages, "adoptThreadBranchChangeFromActiveTurn").mockImplementation(() => {
    branchEntered.resolve();
    return releaseBranch.promise;
  });
  const order: string[] = [];
  registry.onEvent(async (event) => {
    if (event.notification.method !== method) return;
    listenerEntered.resolve();
    await releaseListener.promise;
    order.push("listener finished");
  });
  const backend = "acp:grok";
  const params = { threadId: "fixture-thread", turnId: "fixture-turn" };
  const turn = { id: params.turnId };
  const notifications: Record<TerminalMethod, AgentEvent["notification"]> = {
    "turn/completed": {
      method: "turn/completed",
      params: { ...params, turn: { ...turn, status: "completed", output: [] } },
    },
    "turn/failed": {
      method: "turn/failed",
      params: { ...params, turn: { ...turn, status: "failed", error: { message: "Fixture failure" } } },
    },
    "turn/cancelled": {
      method: "turn/cancelled",
      params: { ...params, turn: { ...turn, status: "cancelled" } },
    },
  };
  let terminal: Promise<void> | undefined;
  let stop: Promise<void> | undefined;
  try {
    await emit({ backend, notification: {
      method: "turn/started",
      params: { ...params, turn: { ...turn, status: "inProgress" } },
    } });
    terminal = emit({ backend, notification: notifications[method] });
    // This stage runs after unregistering and before listener fan-out.
    const unregistered = Promise.race([branchEntered.promise, terminal]);
    if (unregisteredAtSnapshot) await unregistered;
    expect(turnState.hasRegisteredTurn({ backend, ...params })).toBe(!unregisteredAtSnapshot);

    stop = registry.stopRunningTurnsForShutdown().then(() => { order.push("shutdown returned"); });
    await unregistered;
    expect(turnState.hasRegisteredTurn({ backend, ...params })).toBe(false);
    await settle();
    expect([...order]).toEqual([]);

    releaseBranch.resolve();
    await Promise.race([listenerEntered.promise, terminal]);
    await settle();
    expect([...order]).toEqual([]);

    releaseListener.resolve();
    await stop;
    expect(order).toEqual(["listener finished", "shutdown returned"]);
  } finally {
    releaseBranch.resolve();
    releaseListener.resolve();
    try {
      await Promise.all([terminal, stop]);
    } finally {
      await registry.close();
      for (const db of databases) db.close();
    }
  }
}

it("drains a terminal that entered before shutdown and unregisters during shutdown", async () => {
  await checkTerminalDrain("turn/completed", false);
});

it("drains a terminal that already unregistered its turn at the shutdown snapshot", async () => {
  await checkTerminalDrain("turn/completed", true);
});

// An emit pending at the shutdown snapshot must finish listener delivery
// before the phase returns, regardless of whether its turn has unregistered.
it("drains each in-flight terminal at the shutdown snapshot", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom<TerminalMethod>("turn/completed", "turn/failed", "turn/cancelled"),
    fc.boolean(),
    checkTerminalDrain,
  ), { numRuns: 15 });
});
