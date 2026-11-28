import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HoverCardBridge, type BridgedHoverCard } from "../hover-card-bridge";

const immediateTimers = {
  set: () => 1,
  clear: () => undefined,
};

describe("HoverCardBridge.holds", () => {
  // Rule: a trigger inside what the visible card is about (a chip on the
  // card's own row) waits its full hover delay; any other trigger the pointer
  // is not passing waits only the swap rest. Neither closes the card itself.
  it("gives a held trigger the full delay, and any other the swap rest", () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), (held, passTrigger) => {
      const bridge = new HoverCardBridge(300, immediateTimers, 150);
      const chip = { id: "chip" } as unknown as Element;
      let rowHidden = false;
      const row: BridgedHoverCard = {
        hide: () => { rowHidden = true; },
        holds: (trigger) => held && trigger === chip,
      };
      const prCard: BridgedHoverCard = { hide: () => undefined };
      bridge.shown(row);
      const wait = bridge.enterTrigger(prCard, passTrigger ? chip : undefined, 250);
      const keeps = held && passTrigger;
      expect(wait).toBe(keeps ? 250 : 150);
      expect(rowHidden).toBe(false);
    }));
  });
});

describe("HoverCardBridge.delaying", () => {
  // Rule: a card waiting out its hover delay is cancelled by any other card
  // that shows meanwhile, and never by itself showing.
  it("cancels the waiting card when another one shows", () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), (otherShows, otherFirst) => {
      const bridge = new HoverCardBridge(300, immediateTimers);
      let rowCancelled = false;
      const row: BridgedHoverCard = { hide: () => { rowCancelled = true; } };
      const chip: BridgedHoverCard = { hide: () => undefined };
      if (otherFirst) bridge.shown(chip);
      bridge.delaying(row);
      bridge.shown(otherShows ? chip : row);
      expect(rowCancelled).toBe(otherShows && !otherFirst);
    }));
  });
});
