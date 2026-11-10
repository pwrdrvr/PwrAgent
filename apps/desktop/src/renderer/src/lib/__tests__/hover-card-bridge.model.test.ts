import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HoverCardBridge, type BridgedHoverCard } from "../hover-card-bridge";

/**
 * Model test for the sidebar's enterable PR cards. The system under test is
 * the bridge plus the glue `PrChip` runs around it; the model states the
 * rules plainly:
 *
 * - At most one card is visible.
 * - Entering a chip while any card is visible shows that chip's card at once
 *   and closes the other. Otherwise the card waits for the hover delay.
 * - Leaving a chip keeps its card for the grace period, then closes it,
 *   unless the pointer reached the card first.
 * - A card the pointer is on stays until the pointer leaves it.
 */

const GRACE = 300;
const CARDS = 3;

type Op =
  | { kind: "enterChip"; card: number }
  | { kind: "delayFires"; card: number }
  | { kind: "leaveChip"; card: number }
  | { kind: "enterCard"; card: number }
  | { kind: "leaveCard"; card: number }
  | { kind: "advance"; ms: number };

const cardArb = fc.nat(CARDS - 1);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  cardArb.map((card) => ({ kind: "enterChip" as const, card })),
  cardArb.map((card) => ({ kind: "delayFires" as const, card })),
  cardArb.map((card) => ({ kind: "leaveChip" as const, card })),
  cardArb.map((card) => ({ kind: "enterCard" as const, card })),
  cardArb.map((card) => ({ kind: "leaveCard" as const, card })),
  fc.integer({ min: 1, max: 400 }).map((ms) => ({ kind: "advance" as const, ms })),
);

/** Fake timers the bridge schedules its grace on. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    timers: {
      set: (run: () => void, ms: number) => {
        const id = nextId++;
        pending.set(id, { at: now + ms, run });
        return id;
      },
      clear: (id: number) => {
        pending.delete(id);
      },
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = until;
    },
  };
}

/** The reference: which card is up, and when a bridged one expires. */
type Model = {
  visible: number | undefined;
  pending: Set<number>;
  pointerOnChip: number | undefined;
  pointerOnCard: boolean;
  /** Time left on the bridge, while the pointer is between chip and card. */
  graceLeft: number | undefined;
};

function stepModel(model: Model, op: Op): void {
  switch (op.kind) {
    case "enterChip":
      model.pointerOnChip = op.card;
      model.pointerOnCard = false;
      if (model.visible !== undefined) {
        model.visible = op.card;
        model.graceLeft = undefined;
        model.pending.clear();
      } else {
        model.pending.add(op.card);
      }
      return;
    case "delayFires":
      if (!model.pending.has(op.card)) return;
      model.pending.delete(op.card);
      model.visible = op.card;
      model.graceLeft = undefined;
      return;
    case "leaveChip":
      if (model.pointerOnChip === op.card) model.pointerOnChip = undefined;
      model.pending.delete(op.card);
      if (model.visible === op.card) model.graceLeft = GRACE;
      return;
    case "enterCard":
      if (model.visible !== op.card) return;
      model.pointerOnCard = true;
      model.graceLeft = undefined;
      return;
    case "leaveCard":
      if (model.visible !== op.card) return;
      model.pointerOnCard = false;
      model.visible = undefined;
      model.graceLeft = undefined;
      return;
    case "advance":
      if (model.graceLeft === undefined) return;
      model.graceLeft -= op.ms;
      if (model.graceLeft <= 0) {
        model.visible = undefined;
        model.graceLeft = undefined;
      }
  }
}

describe("HoverCardBridge", () => {
  it("matches the model for any sequence of pointer moves", () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
      const clock = fakeTimers();
      const bridge = new HoverCardBridge(GRACE, clock.timers);
      const visible = new Set<number>();
      const pending = new Set<number>();
      const cards: BridgedHoverCard[] = Array.from({ length: CARDS }, (_, index) => ({
        hide: () => {
          visible.delete(index);
          bridge.hidden(cards[index]!);
        },
      }));
      const show = (index: number) => {
        visible.add(index);
        bridge.shown(cards[index]!);
      };
      const model: Model = {
        visible: undefined,
        pending: new Set(),
        pointerOnChip: undefined,
        pointerOnCard: false,
        graceLeft: undefined,
      };

      for (const op of ops) {
        // The glue PrChip runs around the bridge.
        switch (op.kind) {
          case "enterChip":
            if (bridge.enterTrigger(cards[op.card]!)) {
              pending.clear();
              show(op.card);
            } else {
              pending.add(op.card);
            }
            break;
          case "delayFires":
            if (pending.delete(op.card)) show(op.card);
            break;
          case "leaveChip":
            pending.delete(op.card);
            if (visible.has(op.card)) bridge.leaveTrigger(cards[op.card]!);
            break;
          case "enterCard":
            if (visible.has(op.card)) bridge.enterCard(cards[op.card]!);
            break;
          case "leaveCard":
            if (visible.has(op.card)) bridge.leaveCard(cards[op.card]!);
            break;
          case "advance":
            clock.advance(op.ms);
        }
        stepModel(model, op);

        expect(visible.size).toBeLessThanOrEqual(1);
        expect([...visible][0]).toBe(model.visible);
      }
    }), { numRuns: 300 });
  });
});
