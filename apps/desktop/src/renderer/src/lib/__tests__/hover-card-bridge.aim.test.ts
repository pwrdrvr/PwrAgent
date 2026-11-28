import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HoverCardBridge, type BridgedHoverCard } from "../hover-card-bridge";

const GRACE = 300;
const DELAY = 250;
const REST = 150;

/** Fake timers: `advance` runs what falls due, in order. */
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

/**
 * A sidebar like the operator's: a PR chip at the left whose card opens
 * past the sidebar's edge, and other triggers (a stack tag, the ✕, other
 * thread rows) between the chip and the card.
 */
function sidebar() {
  const clock = fakeTimers();
  const bridge = new HoverCardBridge(GRACE, clock.timers, REST);
  const visible = new Set<string>();
  const timers = new Map<string, number>();
  const rects = {
    pr: { left: 820, right: 1360, top: 200, bottom: 1270 },
    other: { left: 820, right: 1360, top: 400, bottom: 900 },
  };
  const cards = new Map<string, BridgedHoverCard>();
  const card = (name: string): BridgedHoverCard => {
    let found = cards.get(name);
    if (!found) {
      found = {
        hide: () => {
          visible.delete(name);
          bridge.hidden(found!);
        },
        getRect: () => (visible.has(name) ? (name === "pr" ? rects.pr : rects.other) : undefined),
      };
      cards.set(name, found);
    }
    return found;
  };
  const show = (name: string) => {
    visible.add(name);
    bridge.shown(card(name));
  };
  // The glue every trigger runs: wait as long as the bridge says.
  const enter = (name: string) => {
    const wait = bridge.enterTrigger(card(name), undefined, DELAY);
    if (wait === 0) {
      show(name);
      return;
    }
    timers.set(name, clock.timers.set(() => {
      timers.delete(name);
      show(name);
    }, wait));
  };
  const leave = (name: string) => {
    const timer = timers.get(name);
    if (timer !== undefined) clock.timers.clear(timer);
    timers.delete(name);
    if (visible.has(name)) bridge.leaveTrigger(card(name));
  };
  const move = (x: number, y: number) => bridge.pointerMoved({ x, y }, clock.now());
  return { bridge, clock, visible, card, show, enter, leave, move };
}

describe("HoverCardBridge aim", () => {
  // Rule: a pointer heading from a chip to its open card keeps that card,
  // whatever triggers it crosses on the way and however long the way takes,
  // as long as it keeps heading there and stays on each trigger for less
  // than a hover delay.
  it("keeps the card across every trigger the pointer crosses on its way", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        // Pixels to the next trigger, and the trigger's width.
        gap: fc.integer({ min: 4, max: 80 }),
        width: fc.integer({ min: 8, max: 60 }),
      }), { minLength: 1, maxLength: 5 }),
      fc.integer({ min: 2, max: 12 }),
      fc.integer({ min: 8, max: 17 }),
      fc.integer({ min: -1, max: 1 }),
      (triggers, pxPerFrame, frameMs, slope) => {
        // Time on a trigger is under the hover delay: crossing, not resting.
        fc.pre(triggers.every(({ width }) => (Math.ceil(width / pxPerFrame) + 1) * frameMs < DELAY));
        // Every trigger lies between the chip and the card's edge.
        fc.pre(triggers.reduce((x, { gap, width }) => x + gap + width + 2 * pxPerFrame, 330) < 820);
        const s = sidebar();
        let x = 330;
        let y = 462;
        s.move(x - 2, y);
        s.move(x - 1, y);
        s.show("pr");
        s.leave("pr");
        const step = (until: number) => {
          while (x < until) {
            x += pxPerFrame;
            y += slope;
            s.clock.advance(frameMs);
            s.move(x, y);
          }
        };
        triggers.forEach((trigger, index) => {
          step(x + trigger.gap);
          s.enter(`trigger-${index}`);
          step(x + trigger.width);
          s.leave(`trigger-${index}`);
        });
        step(820);
        expect([...s.visible]).toEqual(["pr"]);
        s.bridge.enterCard(s.card("pr"));
        s.clock.advance(10_000);
        expect([...s.visible]).toEqual(["pr"]);
      },
    ), { numRuns: 200 });
  });

  // Rule: a pointer that moved on from the open card (down the chip column)
  // swaps to the chip it rests on, but only once it has rested there.
  it("swaps to another chip only after the pointer rests on it", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: REST - 1 }), (dwell) => {
      const s = sidebar();
      s.show("pr");
      s.leave("pr");
      s.move(330, 470);
      s.move(330, 480);
      s.move(330, 490);
      s.enter("next-chip");
      s.clock.advance(dwell);
      // A pass across the chip, shorter than the rest, leaves the card alone.
      expect([...s.visible]).toEqual(["pr"]);
      s.clock.advance(REST - dwell);
      expect([...s.visible]).toEqual(["next-chip"]);
    }));
  });

  // Rule: a sample after a pause says nothing about where the pointer is
  // heading, so the stale trail never earns a crossed trigger the full delay.
  it("ignores a trail the pointer rested on", () => {
    const s = sidebar();
    s.move(300, 462);
    s.move(310, 462);
    s.show("pr");
    s.clock.advance(500);
    s.move(310, 480);
    expect(s.bridge.enterTrigger(s.card("next-chip"), undefined, DELAY)).toBe(REST);
  });
});
