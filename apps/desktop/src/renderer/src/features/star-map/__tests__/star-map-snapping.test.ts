import { describe, expect, it } from "vitest";
import {
  marqueeRect,
  observedGaps,
  rectIntersects,
  resolveSnap,
  type SnapRect,
} from "../star-map-snapping";

const CARD = { width: 200, height: 100 };

function card(x: number, y: number): SnapRect {
  return { x, y, ...CARD };
}

const SNAP = { defaultGap: 12, threshold: 8 };

describe("resolveSnap alignment", () => {
  it("does nothing when there is nothing to snap to", () => {
    expect(resolveSnap({ ...SNAP, moving: card(0, 0), others: [] })).toEqual({
      dx: 0,
      dy: 0,
      guides: [],
    });
  });

  it("latches a near-miss left edge", () => {
    // 5px off a shared left edge, inside the 8px tolerance.
    const result = resolveSnap({
      ...SNAP,
      moving: card(105, 400),
      others: [card(100, 0)],
    });
    expect(result.dx).toBe(-5);
  });

  it("leaves an edge alone once it is out of tolerance", () => {
    const result = resolveSnap({
      ...SNAP,
      moving: card(120, 400),
      others: [card(100, 0)],
    });
    expect(result.dx).toBe(0);
  });

  it("aligns centres, not just edges", () => {
    // Moving centre 203, other centre 200 → pull left by 3.
    const result = resolveSnap({
      ...SNAP,
      moving: card(103, 400),
      others: [card(100, 0)],
    });
    expect(result.dx).toBe(-3);
  });

  it("aligns a right edge to another card's left edge", () => {
    // Moving right edge 397 wants the neighbour's left edge at 400.
    const result = resolveSnap({
      ...SNAP,
      moving: card(197, 0),
      others: [card(400, 0)],
    });
    expect(result.dx).toBe(3);
  });

  it("prefers the smallest adjustment among competing neighbours", () => {
    const result = resolveSnap({
      ...SNAP,
      moving: card(106, 400),
      others: [card(100, 0), card(108, 900)],
    });
    expect(result.dx).toBe(2);
  });

  it("emits a guide spanning both cards so the snap is explainable", () => {
    const result = resolveSnap({
      ...SNAP,
      moving: card(105, 400),
      others: [card(100, 0)],
    });
    const guide = result.guides.find((entry) => entry.axis === "x");
    expect(guide?.at).toBe(100);
    // Spans from the topmost card's top to the bottom card's bottom.
    expect(guide?.start).toBe(0);
    expect(guide?.end).toBe(500);
  });

  it("snaps both axes independently", () => {
    const result = resolveSnap({
      ...SNAP,
      moving: card(104, 603),
      others: [card(100, 600)],
    });
    expect(result.dx).toBe(-4);
    expect(result.dy).toBe(-3);
  });
});

describe("observedGaps", () => {
  it("reports the gap between two stacked cards", () => {
    expect(observedGaps([card(0, 0), card(0, 130)], "y")).toEqual([30]);
  });

  it("ignores cards that do not overlap across the axis", () => {
    // Side by side, so there is no vertical stack to measure.
    expect(observedGaps([card(0, 0), card(500, 130)], "y")).toEqual([]);
  });

  it("ignores touching cards rather than reporting a zero interval", () => {
    expect(observedGaps([card(0, 0), card(0, 100)], "y")).toEqual([]);
  });

  it("collects every distinct gap in the arrangement", () => {
    const gaps = observedGaps(
      [card(0, 0), card(0, 130), card(0, 250)],
      "y",
    );
    // 30 between the first pair, 20 between the second, 150 end to end.
    expect(gaps).toEqual([20, 30, 150]);
  });
});

describe("resolveSnap spacing", () => {
  it("matches a spacing the arrangement already uses", () => {
    // Two cards 30px apart; a third dragged near that interval takes it.
    const others = [card(0, 0), card(0, 130)];
    const result = resolveSnap({
      ...SNAP,
      moving: card(0, 264),
      others,
    });
    expect(result.dy).toBe(-4);
    expect(result.spacing).toEqual({ axis: "y", gap: 30 });
  });

  it("offers the default gap when the arrangement has none of its own", () => {
    const result = resolveSnap({
      ...SNAP,
      moving: card(0, 116),
      others: [card(0, 0)],
    });
    expect(result.dy).toBe(-4);
    expect(result.spacing).toEqual({ axis: "y", gap: 12 });
  });

  it("spaces above a neighbour as readily as below", () => {
    const result = resolveSnap({
      ...SNAP,
      moving: card(0, -117),
      others: [card(0, 0)],
    });
    expect(result.dy).toBe(5);
  });

  it("does not space against a card it is not stacked with", () => {
    const result = resolveSnap({
      ...SNAP,
      moving: card(900, 116),
      others: [card(0, 0)],
    });
    expect(result.dy).toBe(0);
    expect(result.spacing).toBeUndefined();
  });

  it("lets alignment win an axis over spacing", () => {
    // Tops are 3px apart AND a spacing candidate is nearby; the visible
    // edge match is the stronger cue, so it takes the axis.
    const result = resolveSnap({
      ...SNAP,
      moving: card(0, 3),
      others: [card(0, 0)],
    });
    expect(result.dy).toBe(-3);
    expect(result.spacing).toBeUndefined();
  });

  it("aligns one axis and spaces the other — the stacking case", () => {
    // Dragged slightly off a shared left edge and slightly off the
    // established 30px gap: X aligns, Y takes the spacing detent.
    const result = resolveSnap({
      ...SNAP,
      moving: card(4, 264),
      others: [card(0, 0), card(0, 130)],
    });
    expect(result.dx).toBe(-4);
    expect(result.dy).toBe(-4);
    expect(result.spacing).toEqual({ axis: "y", gap: 30 });
  });
});

describe("marquee geometry", () => {
  it("normalises a drag in any direction", () => {
    expect(marqueeRect({ x: 100, y: 80 }, { x: 20, y: 10 })).toEqual({
      x: 20,
      y: 10,
      width: 80,
      height: 70,
    });
  });

  it("selects a card the marquee touches", () => {
    expect(rectIntersects(card(0, 0), marqueeRect({ x: 190, y: 90 }, { x: 300, y: 200 }))).toBe(
      true,
    );
  });

  it("leaves a card the marquee only approaches", () => {
    expect(
      rectIntersects(card(0, 0), marqueeRect({ x: 201, y: 101 }, { x: 300, y: 200 })),
    ).toBe(false);
  });

  it("treats a zero-size marquee as selecting nothing", () => {
    expect(
      rectIntersects(card(0, 0), marqueeRect({ x: 50, y: 50 }, { x: 50, y: 50 })),
    ).toBe(false);
  });
});
