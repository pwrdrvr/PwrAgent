import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { MessagingActiveTurnSummary, MessagingBindingRecord } from "@pwragent/messaging-interface";
import { MessagingTurns, transitionMessagingTurn, type MessagingDrainReceipt, type MessagingTurnState, type MessagingTurnStateContext } from "../messaging/core/messaging-turn-state";
import { messagingInboundHarness } from "./fixtures/messaging-inbound-harness";
import { messagingModules } from "./fixtures/messaging-controller-modules";

const binding: MessagingBindingRecord = { id: "fixture-binding", backend: "codex", threadId: "fixture-thread", createdAt: 1, updatedAt: 1,
  authorizedActorIds: [], channel: { channel: "telegram", conversation: { id: "fixture-conversation", kind: "dm" } } };

describe("messaging turn state", () => {
  it("models coalescing, dispatch ownership, deferred requests and shutdown with valid commands", () => {
    type Model = { phase: "idle" | "scheduled" | "running" | "settling"; closed: boolean; requested: boolean; receipt?: MessagingDrainReceipt };
    type Real = { state?: MessagingTurnState };
    const makeReceipt = (): MessagingDrainReceipt => {
      const timer = setTimeout(() => {}, 0);
      clearTimeout(timer);
      return { token: Symbol(), timer, settled: Promise.resolve(), settle: () => {} };
    };
    const operations = fc.constantFrom("schedule", "blocked", "manual", "request", "take", "fire", "settle", "stale", "dispose").map(operation => ({
      check: (model: Model) => operation === "stale" || operation === "dispose"
        || (operation === "fire" ? model.phase === "scheduled"
          : operation === "settle" ? model.phase === "running" || model.phase === "settling" : !model.closed),
      run: (model: Model, real: Real) => {
        let effects: string[];
        switch (operation) {
          case "schedule": case "blocked": case "manual": {
            const receipt = makeReceipt();
            const started = operation === "schedule" && model.phase === "idle";
            const result = transitionMessagingTurn(real.state, { type: "schedule", token: receipt.token,
              eligible: operation === "schedule", dispatching: operation === "blocked" });
            expect(result.effects.map(effect => effect.type)).toEqual(started ? ["arm"] : []);
            real.state = result.state;
            if (operation === "blocked") model.requested = true;
            if (started) {
              model.phase = "scheduled"; model.receipt = receipt;
              real.state = transitionMessagingTurn(real.state, { type: "armed", receipt }).state;
            }
            break;
          }
          case "request":
            real.state = transitionMessagingTurn(real.state, { type: "requestDrain" }).state;
            model.requested = true;
            break;
          case "take": {
            const result = transitionMessagingTurn(real.state, { type: "takeDrainRequest" });
            expect(result.effects.map(effect => effect.type)).toEqual(model.requested ? ["resume"] : []);
            real.state = result.state; model.requested = false;
            break;
          }
          case "fire": {
            const result = transitionMessagingTurn(real.state, { type: "fired", token: model.receipt!.token });
            expect(result.effects).toEqual([{ type: "dispatch", receipt: model.receipt }]);
            real.state = result.state; model.phase = "running";
            break;
          }
          case "settle":
            real.state = transitionMessagingTurn(real.state, { type: "settled", token: model.receipt!.token }).state;
            model.phase = "idle"; model.receipt = undefined;
            break;
          case "stale": {
            const before = real.state;
            const result = transitionMessagingTurn(before, { type: "settled", token: Symbol() });
            expect(result.effects).toEqual([]);
            if (before) expect(result.state).toBe(before);
            real.state = result.state;
            break;
          }
          case "dispose": {
            const result = transitionMessagingTurn(real.state, { type: "dispose" });
            effects = model.phase === "scheduled" ? ["cancel"] : [];
            expect(result.effects.map(effect => effect.type)).toEqual(effects);
            real.state = result.state; model.closed = true; model.requested = false;
            if (model.phase === "scheduled") model.phase = "settling";
            break;
          }
        }
        expect(real.state!.phase).toBe(model.closed ? "disposed" : "open");
        expect(real.state!.drain.phase).toBe(model.phase);
        expect(real.state!.drainRequested).toBe(model.requested);
      },
      toString: () => operation,
    }));
    fc.assert(fc.property(fc.commands([operations], { maxCommands: 40, size: "max" }), commands => {
      fc.modelRun(() => ({ model: { phase: "idle" as const, closed: false, requested: false }, real: {} }), commands);
    }));
  });

  it("projects provider lifecycle and idle evidence independently of acknowledgement order", () => {
    // Provider sequence is start -> optional wait -> terminal, with repeated
    // terminal evidence and a start acknowledgement at any boundary.
    fc.assert(fc.property(fc.array(fc.record({ waiting: fc.boolean(), terminal: fc.constantFrom("completed", "failed", "interrupted"),
      acknowledgeAt: fc.integer({ min: 0, max: 2 }) }), { minLength: 1, maxLength: 8, size: "max" }), turns => {
      let state: MessagingTurnState | undefined;
      for (const [index, turn] of turns.entries()) {
        const started: MessagingActiveTurnSummary = { turnId: `fixture-${index}`, status: "working", updatedAt: index * 10 };
        const observe = (summary: MessagingActiveTurnSummary, automation = false, idle = false) => {
          const result = transitionMessagingTurn(state, { type: "backend", lifecycle: summary, automation, idle, now: summary.updatedAt });
          state = result.state; return result;
        };
        if (turn.acknowledgeAt === 0) state = transitionMessagingTurn(state, { type: "accepted", turn: started }).state;
        observe(started);
        if (turn.waiting) state = transitionMessagingTurn(state, { type: "observed", turn: { ...started, status: "waiting" } }).state;
        if (turn.acknowledgeAt === 1) state = transitionMessagingTurn(state, { type: "accepted", turn: started }).state;
        const terminal: MessagingActiveTurnSummary = { ...started, status: turn.terminal, updatedAt: index * 10 + 2 };
        observe(terminal);
        if (turn.acknowledgeAt === 2) state = transitionMessagingTurn(state, { type: "accepted", turn: started }).state;
        expect(state?.activeTurn).toEqual(terminal);
        expect(observe({ ...terminal, updatedAt: terminal.updatedAt + 1 }).effects).toEqual([]);
        expect(state?.activeTurn).toEqual(terminal);
        // Automation lifecycle is routed elsewhere; it cannot replace this
        // binding's active user turn.
        expect(observe({ ...started, turnId: "fixture-automation" }, true).effects).toEqual([]);
        expect(state?.activeTurn).toEqual(terminal);
        const idle = transitionMessagingTurn(state, { type: "backend", automation: false, idle: true, now: 100 });
        expect(idle.state.activeTurn?.status).toBe("completed");
        state = idle.state;
      }
    }));
  });

  it("reads no collaborators in the constructor and reads replacement host ports when the timer fires", async () => {
    const reads: PropertyKey[] = [];
    expect(() => new MessagingTurns(new Proxy({} as MessagingTurnStateContext, { get: (_, key) => { reads.push(key); throw new Error(String(key)); } }))).not.toThrow();
    expect(reads).toEqual([]);
    const real = await messagingInboundHarness({ ownsQueue: false });
    const dispatches: string[] = [];
    const modules = messagingModules(real.controller);
    let host: ReturnType<MessagingTurnStateContext["host"]> = {
      turnAdmission: modules.admission,
      startNextQueuedTurn: async () => { dispatches.push("old"); },
    };
    const turns = new MessagingTurns({ host: () => host, logger: {} });
    try {
      await real.controller.handleInboundEvent(real.event("first"));
      await real.controller.handleInboundEvent(real.event("second"));
      turns.schedule(binding);
      host = { ...host, startNextQueuedTurn: async () => { dispatches.push("replacement"); } };
      await turns.whenDrainsSettled();
      expect(dispatches).toEqual(["replacement"]);
    } finally { turns.dispose(); await turns.whenDrainsSettled(); await real.close(); }
  });

  it("keeps owner identities and snapshot mutation isolated while retaining last terminal status", () => {
    const turns = new MessagingTurns({ host: () => { throw new Error("status observation needs no host"); }, logger: {} });
    const remote = { ...binding, federatedThread: { backend: "codex" as const, threadId: binding.threadId,
      target: { scope: "remote" as const, instanceId: "fixture-peer" } } };
    const localTurn: MessagingActiveTurnSummary = { turnId: "fixture-local", status: "working", updatedAt: 1 };
    const remoteTurn: MessagingActiveTurnSummary = { turnId: "fixture-remote", status: "failed", updatedAt: 2 };
    turns.observe(binding, localTurn); turns.observe(remote, remoteTurn);
    const snapshot = new Map(turns.snapshot()); snapshot.clear();
    expect(turns.get(binding)).toEqual(localTurn); expect(turns.get(remote)).toEqual(remoteTurn);
    turns.dispose();
    expect(turns.get(remote)).toEqual(remoteTurn);
  });

  it("uses the facade's live dispatch and logger ports and contains dispatch failures", async () => {
    const real = await messagingInboundHarness({ ownsQueue: false });
    const warning = vi.fn();
    try {
      await real.controller.handleInboundEvent(real.event("first"));
      await real.controller.handleInboundEvent(real.event("second"));
      const modules = messagingModules(real.controller);
      const turns = new MessagingTurns({ host: () => ({
        turnAdmission: modules.admission,
        startNextQueuedTurn: async () => { throw new Error("Fixture dispatch failure"); },
      }), get logger() { return { warn: warning }; } });
      turns.schedule(binding);
      await turns.whenDrainsSettled(); await setImmediate();
      expect(warning).toHaveBeenCalledExactlyOnceWith("messaging queued turn dispatch failed", { threadId: binding.threadId, error: "Fixture dispatch failure" });
      turns.dispose();
    } finally { await real.close(); }
  });
});
