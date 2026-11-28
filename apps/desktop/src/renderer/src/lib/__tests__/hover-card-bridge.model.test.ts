import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HoverCardBridge, type BridgedHoverCard } from "../hover-card-bridge";

/**
 * Model test for the sidebar's enterable cards. The system under test is the
 * bridge plus the glue `PrChip` runs around it; the model states the rules
 * plainly:
 *
 * - At most one card is visible; a card that shows closes the other.
 * - Entering a chip shows its card after the hover delay when no card is up.
 *   While another card is up, entering a chip never closes it: the chip's
 *   card waits the full hover delay if the pointer is heading for the
 *   visible card, else the shorter swap rest.
 * - Leaving a chip or its card keeps the card for the grace period, then
 *   closes it, unless the pointer reached the card (or chip) first. A move
 *   that heads for the card renews the grace.
 */

const GRACE = 300;
const DELAY = 250;
const REST = 150;
const CARDS = 3;
/** Where every card sits; the pointer starts left of it. */
const CARD_RECT = { left: 500, right: 700, top: 0, bottom: 1000 };

type Op =
  | { kind: "enterChip"; card: number }
  | { kind: "leaveChip"; card: number }
  | { kind: "enterCard"; card: number }
  | { kind: "leaveCard"; card: number }
  | { kind: "move"; aimed: boolean }
  | { kind: "advance"; ms: number };

const cardArb = fc.nat(CARDS - 1);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  cardArb.map((card) => ({ kind: "enterChip" as const, card })),
  cardArb.map((card) => ({ kind: "leaveChip" as const, card })),
  cardArb.map((card) => ({ kind: "enterCard" as const, card })),
  cardArb.map((card) => ({ kind: "leaveCard" as const, card })),
  fc.boolean().map((aimed) => ({ kind: "move" as const, aimed })),
  fc.integer({ min: 1, max: 400 }).map((ms) => ({ kind: "advance" as const, ms })),
);

/** Fake timers the bridge and the glue schedule on; ties fire in order set. */
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

/** The reference: which card is up, and the timers that will change that. */
type Model = {
  now: number;
  /** Order timers were set in, which breaks ties between them. */
  seq: number;
  visible: number | undefined;
  grace: { at: number; seq: number } | undefined;
  pending: Map<number, { at: number; seq: number }>;
  aimed: boolean;
};

function startGrace(model: Model): void {
  model.grace = { at: model.now + GRACE, seq: model.seq++ };
}

function stepModel(model: Model, op: Op): void {
  switch (op.kind) {
    case "enterChip":
      if (model.visible === op.card) {
        model.grace = undefined;
        return;
      }
      model.pending.set(op.card, {
        at: model.now + (model.visible === undefined || model.aimed ? DELAY : REST),
        seq: model.seq++,
      });
      return;
    case "leaveChip":
      model.pending.delete(op.card);
      if (model.visible === op.card) startGrace(model);
      return;
    case "enterCard":
      if (model.visible === op.card) model.grace = undefined;
      return;
    case "leaveCard":
      if (model.visible === op.card) startGrace(model);
      return;
    case "move":
      model.aimed = op.aimed;
      if (op.aimed && model.visible !== undefined && model.grace) startGrace(model);
      return;
    case "advance": {
      const until = model.now + op.ms;
      for (;;) {
        const due: Array<{ at: number; seq: number; card?: number }> = [...model.pending]
          .map(([card, timer]) => ({ ...timer, card }));
        if (model.grace) due.push(model.grace);
        const next = due
          .filter((timer) => timer.at <= until)
          .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
        if (!next) break;
        model.now = next.at;
        model.grace = undefined;
        if (next.card === undefined) {
          model.visible = undefined;
        } else {
          model.pending.delete(next.card);
          model.visible = next.card;
        }
      }
      model.now = until;
    }
  }
}

/** Three pointer samples heading for the cards, or down the chip column. */
function pointerPath(aimed: boolean): Array<{ x: number; y: number }> {
  return aimed
    ? [{ x: 100, y: 300 }, { x: 110, y: 300 }, { x: 120, y: 300 }]
    : [{ x: 100, y: 300 }, { x: 100, y: 310 }, { x: 100, y: 320 }];
}

describe("HoverCardBridge", () => {
  it("matches the model for any sequence of pointer moves", () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
      const clock = fakeTimers();
      const bridge = new HoverCardBridge(GRACE, clock.timers, REST);
      const visible = new Set<number>();
      const pending = new Map<number, number>();
      const cards: BridgedHoverCard[] = Array.from({ length: CARDS }, (_, index) => ({
        hide: () => {
          visible.delete(index);
          bridge.hidden(cards[index]!);
        },
        getRect: () => (visible.has(index) ? CARD_RECT : undefined),
      }));
      const show = (index: number) => {
        visible.add(index);
        bridge.shown(cards[index]!);
      };
      const cancel = (index: number) => {
        const timer = pending.get(index);
        if (timer === undefined) return;
        clock.timers.clear(timer);
        pending.delete(index);
      };
      const model: Model = {
        now: 0,
        seq: 0,
        visible: undefined,
        grace: undefined,
        pending: new Map(),
        aimed: false,
      };
      // Sample times: a second apart between moves, so a move's first two
      // samples read as a fresh start and only its last one is judged.
      let moves = 0;

      for (const op of ops) {
        // The glue PrChip runs around the bridge.
        switch (op.kind) {
          case "enterChip": {
            const wait = bridge.enterTrigger(cards[op.card]!, undefined, DELAY);
            if (wait === 0) {
              show(op.card);
            } else {
              // As the tooltip's own delay: a new one replaces the old.
              cancel(op.card);
              pending.set(op.card, clock.timers.set(() => {
                pending.delete(op.card);
                show(op.card);
              }, wait));
            }
            break;
          }
          case "leaveChip":
            cancel(op.card);
            if (visible.has(op.card)) bridge.leaveTrigger(cards[op.card]!);
            break;
          case "enterCard":
            if (visible.has(op.card)) bridge.enterCard(cards[op.card]!);
            break;
          case "leaveCard":
            if (visible.has(op.card)) bridge.leaveCard(cards[op.card]!);
            break;
          case "move": {
            const base = ++moves * 1000;
            pointerPath(op.aimed).forEach((point, index) => bridge.pointerMoved(point, base + index));
            break;
          }
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
