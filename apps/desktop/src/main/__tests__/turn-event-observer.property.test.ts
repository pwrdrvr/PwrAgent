import { readFileSync } from "node:fs";
import { setImmediate as settle } from "node:timers/promises";
import fc from "fast-check";
import { afterEach, expect, it } from "vitest";
import type { AgentEvent } from "@pwragent/shared";
import { TurnEventObservers, type TurnEventObserver } from "../app-server/turn-event-observer";
import { registryModules } from "../app-server/backend-registry-wiring";
import type { StateDb } from "../state/state-db";
import { registryWithInMemoryStore } from "./helpers/registry-in-memory-fixture";

const databases: StateDb[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const notification = (method: string, threadId = "fixture"): AgentEvent => ({
  backend: "codex", notification: { method, params: { threadId } },
} as AgentEvent);

it("registers the complete fixed domain order and retires the hub", async () => {
  const registry = registryWithInMemoryStore(databases);
  try {
    expect(registryModules(registry).turnEventObservers.observers.map(observer => observer.name)).toEqual([
      "review-forwarding", "message-context", "review-output", "monitor-activity", "directory-lifecycle",
      "thread-state", "turn-started", "usage-terminal-barrier", "mcp-terminal", "terminal-requests",
      "forge-terminal", "usage-terminal", "terminal-resources", "review-terminal", "terminal-activity",
      "review-boundary", "workspace-boundary", "terminal-modes", "runtime-terminal", "terminal-queue",
      "turn-failure", "monitor-terminal", "turn-status", "workspace-status", "status-queue",
      "request-resolution", "runtime-settled", "usage-accounting", "monitor-accounting",
      "turn-notifications", "usage-finish", "review-metadata", "turn-listeners",
    ]);
    const registrySource = readFileSync(new URL("../app-server/backend-registry.ts", import.meta.url), "utf8");
    expect(registrySource).not.toContain("emitAfterLiveThreadUsageRegistration");
  } finally { await registry.close(); }
});

it("executes only applicable handlers in order and propagates consumed deliveries", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("turn/started", "turn/completed", "turn/failed", "turn/cancelled", "thread/status/changed", "item/updated"),
    fc.array(fc.constantFrom("all", "start", "terminal", "status"), { minLength: 1, maxLength: 16, size: "max" }),
    fc.nat(16), fc.boolean(),
    async (method, stages, stopAt, throws) => {
      const log: number[] = [], failure = new Error("Contrived observer failure");
      const applicable = (kind: string) => kind === "all" || kind === "start" && method === "turn/started"
        || kind === "terminal" && ["turn/completed", "turn/failed", "turn/cancelled"].includes(method)
        || kind === "status" && method === "thread/status/changed";
      const expected = stages.flatMap((kind, i) => applicable(kind) ? [i] : []);
      const stopped = expected.indexOf(stopAt);
      if (stopped >= 0) expected.splice(stopped + 1);
      const observers: TurnEventObserver[] = stages.map((kind, index) => ({
        name: `fixture-${index}`,
        [kind === "all" ? "onEvent" : kind === "start" ? "onTurnStarted" : kind === "terminal" ? "onTurnTerminal" : "onStatusChanged"]: async () => {
          log.push(index);
          if (index === stopAt) { if (throws) throw failure; return false; }
        },
      }));
      const work = new TurnEventObservers(observers).run(notification(method), undefined, undefined);
      if (stopped >= 0 && throws) await expect(work).rejects.toBe(failure);
      else await work;
      expect(log).toEqual(expected);
    },
  ));
});

it("awaits each delivery's effects while allowing another delivery to finish", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), async scheduler => {
    const log: string[] = [];
    let entered!: () => void;
    const ingress = new Promise<void>(resolve => { entered = resolve; });
    const pipeline = new TurnEventObservers([
      { name: "gate", onEvent: async delivery => {
        const threadId = "threadId" in delivery.event.notification.params ? delivery.event.notification.params.threadId : undefined;
        if (threadId === "first") {
          entered();
          await scheduler.schedule(Promise.resolve(), "first bookkeeping");
        }
        delivery.lifecycleTurnId = typeof threadId === "string" ? threadId : undefined;
      } },
      { name: "observe", onEvent: delivery => { log.push(delivery.lifecycleTurnId!); } },
    ]);
    const first = pipeline.run(notification("turn/started", "first"), undefined, undefined);
    await ingress;
    await pipeline.run(notification("turn/completed", "second"), undefined, undefined);
    expect(log).toEqual(["second"]);
    await scheduler.waitAll();
    await first;
    await settle();
    expect(log).toEqual(["second", "first"]);
  }));
});
