import fc from "fast-check";
import { expect, it } from "vitest";
import { tooltipBridgeRect, type TooltipRect } from "../tooltip-placement";

// The rule: a pointer moving in a straight line from the trigger's edge that
// faces the card to the card's facing edge never leaves trigger ∪ bridge ∪
// card. Anything outside that union is something else under the pointer —
// in the sidebar, a project row whose card trigger closes the Attention card.
// Scenarios are built side by side, so which edges face is known from the
// generator rather than re-derived by the code under test.

type Side = "below" | "above" | "right" | "left";

const scenario = fc.record({
  side: fc.constantFrom<Side>("below", "above", "right", "left"),
  target: fc.record({ left: fc.integer({ min: 0, max: 400 }), top: fc.integer({ min: 0, max: 400 }),
    width: fc.integer({ min: 8, max: 200 }), height: fc.integer({ min: 8, max: 60 }) }),
  card: fc.record({ width: fc.integer({ min: 40, max: 320 }), height: fc.integer({ min: 40, max: 300 }),
    // Where along the other axis the card sits, as a fraction of the range
    // in which it still shares part of the trigger's span. Placement never
    // puts a card off a corner (`anchoredTooltipPosition` slides a beside
    // card only as far as the bounds force, and centres one above or below).
    shift: fc.double({ min: 0, max: 1, noNaN: true }) }),
  gap: fc.integer({ min: 1, max: 24 }),
  from: fc.double({ min: 0, max: 1, noNaN: true }),
  to: fc.double({ min: 0, max: 1, noNaN: true }),
});

type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

function layout(input: Scenario) {
  const t = input.target;
  const target: TooltipRect = { left: t.left, top: t.top, right: t.left + t.width, bottom: t.top + t.height };
  const { width, height, shift } = input.card;
  const overlapping = (start: number, size: number, span: number) =>
    start - (size - 1) + Math.floor(shift * (size + span - 2));
  const left = input.side === "right" ? target.right + input.gap
    : input.side === "left" ? target.left - input.gap - width : overlapping(target.left, width, t.width);
  const top = input.side === "below" ? target.bottom + input.gap
    : input.side === "above" ? target.top - input.gap - height : overlapping(target.top, height, t.height);
  const card: TooltipRect = { left, top, right: left + width, bottom: top + height };
  const along = (rect: TooltipRect, f: number, vertical: boolean) => vertical
    ? rect.top + f * (rect.bottom - rect.top) : rect.left + f * (rect.right - rect.left);
  const vertical = input.side === "right" || input.side === "left";
  const edge = (rect: TooltipRect, facing: Side, f: number) => ({
    x: facing === "right" ? rect.right : facing === "left" ? rect.left : along(rect, f, false),
    y: facing === "below" ? rect.bottom : facing === "above" ? rect.top : along(rect, f, true),
  });
  const opposite: Record<Side, Side> = { below: "above", above: "below", right: "left", left: "right" };
  return { target, card, start: edge(target, input.side, input.from),
    end: edge(card, opposite[input.side], input.to), vertical };
}

const within = (rect: TooltipRect, p: { x: number; y: number }) =>
  p.x >= rect.left - 1e-9 && p.x <= rect.right + 1e-9 && p.y >= rect.top - 1e-9 && p.y <= rect.bottom + 1e-9;

it("keeps a straight move from the trigger to its card on the card", () => {
  fc.assert(fc.property(scenario, (input) => {
    const { target, card, start, end } = layout(input);
    const bridge = tooltipBridgeRect(target, card);
    expect(bridge).toBeDefined();
    const absolute: TooltipRect = { left: card.left + bridge!.left, top: card.top + bridge!.top,
      right: card.left + bridge!.left + bridge!.width, bottom: card.top + bridge!.top + bridge!.height };
    for (let step = 0; step <= 40; step++) {
      const f = step / 40;
      const p = { x: start.x + (end.x - start.x) * f, y: start.y + (end.y - start.y) * f };
      expect(within(target, p) || within(absolute, p) || within(card, p), JSON.stringify({ p, target, card, absolute }))
        .toBe(true);
    }
  }), { numRuns: 500 });
});

it("lays no strip when the card already touches its trigger", () => {
  const target = { left: 10, top: 10, right: 60, bottom: 36 };
  expect(tooltipBridgeRect(target, { left: 10, top: 36, right: 274, bottom: 200 })).toBeUndefined();
  expect(tooltipBridgeRect(target, { left: 0, top: 20, right: 100, bottom: 120 })).toBeUndefined();
});

it("fills the Attention card's 10px gap under the tab", () => {
  // The tab at the sidebar's lens switch, the card below it as placed.
  expect(tooltipBridgeRect({ left: 22, top: 230, right: 176, bottom: 256 },
    { left: 22, top: 266, right: 286, bottom: 520 })).toEqual({ left: 0, top: -10, width: 264, height: 10 });
});
