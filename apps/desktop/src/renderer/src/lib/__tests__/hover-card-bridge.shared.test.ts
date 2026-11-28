import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HoverCardBridge, type BridgedHoverCard } from "../hover-card-bridge";

const GRACE = 300;
const DELAY = 600;
const REST = 150;
const CARD_RECT = { left: 500, right: 700, top: 0, bottom: 1000 };

/** Manual timers with a clock, as `window` and `performance.now()` give. */
function clock() {
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
      now: () => now,
    },
    now: () => now,
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

/** One card for every thread row, showing for `rowA`. */
function sharedCard() {
  const time = clock();
  const bridge = new HoverCardBridge(GRACE, time.timers, REST);
  const rowA = { id: "row-a" } as unknown as Element;
  const rowB = { id: "row-b" } as unknown as Element;
  let showing: Element = rowA;
  let hidden = false;
  const card: BridgedHoverCard = {
    hide: () => { hidden = true; },
    getRect: () => CARD_RECT,
    showsFor: (trigger) => trigger === showing,
  };
  bridge.shown(card);
  const move = (x: number, y: number) => bridge.pointerMoved({ x, y }, time.now());
  return {
    bridge, time, card, rowA, rowB, move,
    hidden: () => hidden,
    showFor: (row: Element) => { showing = row; },
  };
}

describe("HoverCardBridge shared card", () => {
  // Rule: a card shared by many triggers treats another of its triggers as
  // a swap like any other card's: the full delay while the pointer heads for
  // the card, the swap rest otherwise. Its own trigger shows it at once.
  it("treats another trigger of the same card as a swap", () => {
    fc.assert(fc.property(fc.boolean(), fc.constantFrom("a", "b"), (aimed, row) => {
      const s = sharedCard();
      if (aimed) {
        s.move(100, 300);
        s.move(110, 300);
        s.move(120, 300);
      } else {
        s.move(100, 300);
        s.move(100, 310);
        s.move(100, 320);
      }
      const wait = s.bridge.enterTrigger(s.card, row === "a" ? s.rowA : s.rowB, DELAY);
      expect(wait).toBe(row === "a" ? 0 : aimed ? DELAY : REST);
      expect(s.hidden()).toBe(false);
    }));
  });

  // The shrunk counterexample on the pre-fix bridge: the card up for row A,
  // the pointer moving down the list onto row B.
  it("does not move the card to a row the pointer only reached", () => {
    const s = sharedCard();
    s.move(100, 300);
    s.move(100, 310);
    s.move(100, 320);
    expect(s.bridge.enterTrigger(s.card, s.rowB, DELAY)).toBe(REST);
  });

  // Rule: leaving the shown row starts the grace, and entering another of
  // the card's rows ends it: the pointer is still on the card's triggers, so
  // a sweep down the rows longer than the grace keeps the card for the row
  // it stops on.
  it("keeps the card while the pointer sweeps across its other rows", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: REST - 1 }), { minLength: 1, maxLength: 8 }), (dwells) => {
      const s = sharedCard();
      for (const dwell of dwells) {
        s.bridge.leaveTrigger(s.card);
        expect(s.bridge.enterTrigger(s.card, s.rowB, DELAY)).toBe(REST);
        s.time.advance(dwell);
      }
      s.time.advance(GRACE * 3);
      expect(s.hidden()).toBe(false);
      // Leaving the rows for anywhere else still closes it after the grace.
      s.bridge.leaveTrigger(s.card);
      s.time.advance(GRACE);
      expect(s.hidden()).toBe(true);
    }));
  });

  // Its shrunk counterexample on the pre-fix bridge's grace: one row, no dwell.
  it("keeps the card across one other row entered at once", () => {
    const s = sharedCard();
    s.bridge.leaveTrigger(s.card);
    s.bridge.enterTrigger(s.card, s.rowB, DELAY);
    s.time.advance(GRACE);
    expect(s.hidden()).toBe(false);
  });

  // Rule: the bridge knows at once when another card took over, so a
  // shared card's pending move can tell it is no longer the visible card.
  it("stops reporting a card as showing once another takes over", () => {
    const s = sharedCard();
    expect(s.bridge.isShowing(s.card)).toBe(true);
    s.bridge.takeOver({ hide: () => undefined });
    expect(s.bridge.isShowing(s.card)).toBe(false);
    expect(s.hidden()).toBe(true);
  });

  // Rule: a pointer that has rested since its last sample is not heading
  // for the card, however its last few samples pointed.
  it("stops counting a resting pointer as heading for the card", () => {
    fc.assert(fc.property(fc.integer({ min: 101, max: 2000 }), (rest) => {
      const s = sharedCard();
      s.move(100, 300);
      s.move(110, 300);
      s.move(120, 300);
      s.time.advance(rest);
      expect(s.bridge.enterTrigger(s.card, s.rowB, DELAY)).toBe(REST);
    }));
  });

  // Its shrunk counterexample on the pre-fix bridge: a rest just past the
  // staleness window.
  it("treats a pointer that rested 101 ms as not heading anywhere", () => {
    const s = sharedCard();
    s.move(100, 300);
    s.move(110, 300);
    s.move(120, 300);
    s.time.advance(101);
    expect(s.bridge.enterTrigger(s.card, s.rowB, DELAY)).toBe(REST);
  });
});
