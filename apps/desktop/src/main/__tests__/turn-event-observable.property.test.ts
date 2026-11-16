import { setImmediate as settle } from "node:timers/promises";
import fc from "fast-check";
import { afterEach, expect, it } from "vitest";
import type { AgentEvent, AppServerBackendKind } from "@pwragent/shared";
import { registryModules } from "../app-server/backend-registry-wiring";
import type { StateDb } from "../state/state-db";
import { registryWithInMemoryStore } from "./helpers/registry-in-memory-fixture";

const databases: StateDb[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const backend = fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:fixture");
const terminal = fc.constantFrom("turn/completed", "turn/failed", "turn/cancelled");

function event(provider: AppServerBackendKind, threadId: string, turnId: string, method: string): AgentEvent {
  return { backend: provider, notification: { method, params: {
    threadId, turnId, turn: { id: turnId, status: method === "turn/started" ? "in_progress"
      : method === "turn/failed" ? "failed" : method === "turn/cancelled" ? "cancelled" : "completed",
    error: { message: "Contrived failure" }, output: [] },
  } } } as AgentEvent;
}

// Independent projection: accepted starts are visible at listener delivery;
// every corresponding terminal retires registration and mode before delivery.
// The oracle is a set of provider identities, never the implementation's reducer.
it("projects valid provider sessions and repeated terminals at the listener boundary", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.tuple(backend, terminal, fc.boolean()), {
    minLength: 1, maxLength: 6, size: "max",
  }), async (sessions) => {
    const registry = registryWithInMemoryStore(databases);
    const state = registryModules(registry).turnState;
    const ports = registry.constructionPorts();
    const expected = new Set<string>();
    const delivered: string[] = [];
    const projections: string[][] = [];
    const unsubscribe = registry.onEvent(value => {
      if (!value.notification.method.startsWith("turn/")) return;
      projections.push([...state.registeredTurnKeys()]);
      delivered.push(`${value.backend} ${value.notification.method}`);
    });
    try {
      for (const [i, [provider, method, repeat]] of sessions.entries()) {
        const threadId = `fixture-${i}`, turnId = `turn-${i}`;
        const key = `${provider}:${threadId}:${turnId}`;
        expected.add(key);
        await ports.emit(event(provider, threadId, turnId, "turn/started"));
        expect(projections.at(-1)).toEqual([...expected]);
        expected.delete(key);
        await ports.emit(event(provider, threadId, turnId, method));
        expect(projections.at(-1)).toEqual([...expected]);
        if (repeat) await ports.emit(event(provider, threadId, turnId, method));
        expect(projections.at(-1)).toEqual([...expected]);
        expect(state.executionKeys()).toEqual([]);
      }
      expect(delivered).toEqual(sessions.flatMap(([provider, method, repeat]) => [
        `${provider} turn/started`, `${provider} ${method}`, ...(repeat ? [`${provider} ${method}`] : []),
      ]));
      await settle();
    } finally { unsubscribe(); await registry.close(); }
  }), { numRuns: 15 });
});

it("keeps concurrent notifications independent across provider threads", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), backend, terminal, async (scheduler, provider, method) => {
    const registry = registryWithInMemoryStore(databases);
    const ports = registry.constructionPorts();
    const state = registryModules(registry).turnState;
    try {
      // Each thread's provider order is valid; the scheduler interleaves threads.
      const session = scheduler.scheduleFunction(async (threadId: string) => {
        await ports.emit(event(provider, threadId, threadId, "turn/started"));
        await ports.emit(event(provider, threadId, threadId, method));
      });
      const work = [session("left"), session("right")];
      await scheduler.waitAll();
      await Promise.all(work);
      await settle();
      expect(state.registeredTurnKeys()).toEqual([]);
      expect(state.executionKeys()).toEqual([]);
    } finally { await registry.close(); }
  }), { numRuns: 15 });
});
