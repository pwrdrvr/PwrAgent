import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { MessagingActiveTurnSummary, MessagingBindingRecord } from "@pwragent/messaging-interface";
import { MessagingTurns, transitionMessagingTurn, type MessagingTurnState } from "../messaging/core/messaging-turn-state";

const binding: MessagingBindingRecord = { id: "fixture-binding", backend: "codex", threadId: "fixture-thread", createdAt: 1, updatedAt: 1,
  authorizedActorIds: [], channel: { channel: "telegram", conversation: { id: "fixture-conversation", kind: "dm" } } };

describe("messaging turn state", () => {
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

  it("keeps owner identities and snapshot mutation isolated while retaining last terminal status", () => {
    const turns = new MessagingTurns();
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

});
