import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { IntegratedTerminalOutputEvent } from "../../../../shared/integrated-terminal";
import type { DesktopApi } from "../desktop-api";
import {
  routeIntegratedTerminalOutput,
  type IntegratedTerminalOutputRoute,
} from "../integrated-terminal-output-router";

/**
 * A chunk of terminal output crosses the bridge once and reaches exactly the
 * panes showing its session, plus panes that have not learned their session
 * yet. The window holds one bridge listener while any pane is routed, and
 * none after the last one leaves.
 */

const SESSIONS = ["a", "b", "c"] as const;
type Session = (typeof SESSIONS)[number];

type Op =
  | { kind: "subscribe"; session: Session | undefined; leaveOnReceive: boolean }
  | { kind: "rekey"; pane: number; session: Session }
  | { kind: "unsubscribe"; pane: number }
  | { kind: "emit"; session: Session };

const session = fc.constantFrom(...SESSIONS);
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("subscribe" as const),
    session: fc.option(session, { nil: undefined }),
    leaveOnReceive: fc.boolean(),
  }),
  fc.record({ kind: fc.constant("rekey" as const), pane: fc.nat(7), session }),
  fc.record({ kind: fc.constant("unsubscribe" as const), pane: fc.nat(7) }),
  fc.record({ kind: fc.constant("emit" as const), session }),
);

function fakeBridge() {
  const listeners = new Set<(event: IntegratedTerminalOutputEvent) => void>();
  let crossings = 0;
  const api = {
    onIntegratedTerminalOutput: (callback: (event: IntegratedTerminalOutputEvent) => void) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
  } as DesktopApi;
  return {
    api,
    listeners,
    /** What preload does for one IPC message: call every listener. */
    send(event: IntegratedTerminalOutputEvent) {
      for (const listener of [...listeners]) { crossings += 1; listener(event); }
    },
    crossings: () => crossings,
  };
}

type Pane = {
  route: IntegratedTerminalOutputRoute;
  session: Session | undefined;
  active: boolean;
  leaveOnReceive: boolean;
  received: number;
};

function replay(ops: Op[]) {
  const bridge = fakeBridge();
  const panes: Pane[] = [];
  let seq = 0;
  for (const [step, next] of ops.entries()) {
    if (next.kind === "subscribe") {
      const pane: Pane = { session: next.session, active: true, leaveOnReceive: next.leaveOnReceive, received: 0 } as Pane;
      pane.route = routeIntegratedTerminalOutput(bridge.api, next.session, () => {
        pane.received += 1;
        if (pane.leaveOnReceive) { pane.route.unsubscribe(); pane.active = false; }
      })!;
      panes.push(pane);
    } else if (next.kind === "rekey") {
      const pane = panes[next.pane % Math.max(1, panes.length)];
      if (!pane) continue;
      pane.route.setSessionId(next.session);
      if (pane.active) pane.session = next.session;
    } else if (next.kind === "unsubscribe") {
      const pane = panes[next.pane % Math.max(1, panes.length)];
      if (!pane) continue;
      pane.route.unsubscribe();
      pane.active = false;
    } else {
      const expected = panes.map((pane) =>
        pane.active && (pane.session === undefined || pane.session === next.session) ? 1 : 0);
      const before = panes.map((pane) => pane.received);
      const crossingsBefore = bridge.crossings();
      bridge.send({ sessionId: next.session, data: "x", seq: ++seq });
      expect({ step, delivered: panes.map((pane, i) => pane.received - before[i]!) })
        .toEqual({ step, delivered: expected });
      expect(bridge.crossings() - crossingsBefore).toBe(panes.some((pane, i) => pane.active || expected[i]) ? 1 : 0);
    }
    const anyActive = panes.some((pane) => pane.active);
    expect({ step, bridgeListeners: bridge.listeners.size }).toEqual({ step, bridgeListeners: anyActive ? 1 : 0 });
  }
}

describe("integrated terminal output router", () => {
  it("delivers each chunk once, to its session's panes, over one bridge listener", () => {
    fc.assert(fc.property(fc.array(op, { minLength: 1, maxLength: 30, size: "max" }), (ops) => replay(ops)));
  });

  it("re-keys a pane that learns its session from main", () => {
    replay([
      { kind: "subscribe", session: undefined, leaveOnReceive: false },
      { kind: "subscribe", session: "a", leaveOnReceive: false },
      { kind: "emit", session: "b" },
      { kind: "rekey", pane: 0, session: "b" },
      { kind: "emit", session: "a" },
      { kind: "emit", session: "b" },
    ]);
  });

  it("lets a pane leave during dispatch and drops the bridge listener with the last pane", () => {
    replay([
      { kind: "subscribe", session: "a", leaveOnReceive: true },
      { kind: "subscribe", session: "a", leaveOnReceive: false },
      { kind: "emit", session: "a" },
      { kind: "emit", session: "a" },
      { kind: "unsubscribe", pane: 1 },
      { kind: "subscribe", session: "c", leaveOnReceive: false },
      { kind: "emit", session: "c" },
    ]);
  });
});
