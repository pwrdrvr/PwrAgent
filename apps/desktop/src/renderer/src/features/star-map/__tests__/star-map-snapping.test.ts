import { describe, expect, it } from "vitest";
import {
  marqueeRect,
  observedGaps,
  rectIntersects,
  resolveResizeSnap,
  resolveSnap,
  snapCandidates,
  type SnapRect,
  type SnapSpec,
  type SnapTarget,
} from "../star-map-snapping";

const CARD = { width: 200, height: 100 };

function card(x: number, y: number): SnapRect {
  return { x, y, ...CARD };
}

const THREAD_SPEC: SnapSpec = {
  targetTypes: ["thread-card"],
  proximity: 96,
  spacingGaps: [12],
};

function target(
  rect: SnapRect,
  type: SnapTarget["type"] = "thread-card",
): SnapTarget {
  return { type, rect };
}

function snap(
  moving: SnapRect,
  others: readonly SnapRect[],
  spec = THREAD_SPEC,
) {
  return resolveSnap({
    moving: target(moving),
    targets: others.map((rect) => target(rect)),
    spec,
    threshold: 8,
  });
}

describe("resolveSnap alignment", () => {
  it("does nothing when there is nothing to snap to", () => {
    expect(snap(card(0, 0), [])).toEqual({
      dx: 0,
      dy: 0,
      guides: [],
    });
  });

  it("latches a near-miss left edge", () => {
    // 5px off a shared left edge, inside the 8px tolerance.
    const result = snap(card(105, 150), [card(100, 0)]);
    expect(result.dx).toBe(-5);
  });

  it("leaves an edge alone once it is out of tolerance", () => {
    const result = snap(card(120, 150), [card(100, 0)]);
    expect(result.dx).toBe(0);
  });

  it("aligns centres, not just edges", () => {
    // Moving centre 203, other centre 200 → pull left by 3.
    const result = snap(card(103, 150), [card(100, 0)]);
    expect(result.dx).toBe(-3);
  });

  it("aligns a right edge to another card's left edge", () => {
    // Moving right edge 397 wants the neighbour's left edge at 400.
    const result = snap(card(197, 0), [card(400, 0)]);
    expect(result.dx).toBe(3);
  });

  it("prefers the smallest adjustment among competing neighbours", () => {
    const result = snap(card(106, 150), [card(100, 0), card(108, 160)]);
    expect(result.dx).toBe(2);
  });

  it("emits a guide spanning both cards so the snap is explainable", () => {
    const result = snap(card(105, 150), [card(100, 0)]);
    const guide = result.guides.find((entry) => entry.axis === "x");
    expect(guide?.at).toBe(100);
    // Spans from the topmost card's top to the bottom card's bottom.
    expect(guide?.start).toBe(0);
    expect(guide?.end).toBe(250);
  });

  it("snaps both axes independently", () => {
    const result = snap(card(104, 603), [card(100, 600)]);
    expect(result.dx).toBe(-4);
    expect(result.dy).toBe(-3);
  });
});

describe("resolveResizeSnap", () => {
  it("matches a neighbouring card width without moving the origin", () => {
    const result = resolveResizeSnap({
      moving: target({ x: 100, y: 150, width: 194, height: 100 }),
      targets: [target(card(300, 0))],
      spec: THREAD_SPEC,
      threshold: 8,
    });

    expect(result.dw).toBe(6);
    expect(result.guides.some((guide) => guide.axis === "x")).toBe(true);
  });

  it("aligns the resized bottom edge with a neighbour", () => {
    const result = resolveResizeSnap({
      moving: target({ x: 250, y: 0, width: 200, height: 96 }),
      targets: [target(card(0, 0))],
      spec: THREAD_SPEC,
      threshold: 8,
    });

    expect(result.dh).toBe(4);
    expect(result.guides.some((guide) => guide.axis === "y")).toBe(true);
  });
});

describe("snapCandidates", () => {
  it("keeps only allowed card types within the proximity radius", () => {
    const nearThread = target(card(250, 0));
    const nearChat = target(card(0, 150), "chat-card");
    const farThread = target(card(0, 300));

    expect(
      snapCandidates({
        moving: target(card(0, 0)),
        targets: [nearThread, nearChat, farThread],
        spec: THREAD_SPEC,
      }),
    ).toEqual([nearThread.rect]);
  });

  it("does not treat a matching edge across the map as nearby", () => {
    const result = snap(card(105, 1_000), [card(100, 0)]);
    expect(result).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("lets chat cards select chat cards without selecting nearby threads", () => {
    const result = resolveSnap({
      moving: target(card(105, 150), "chat-card"),
      targets: [
        target(card(100, 150)),
        target(card(108, 150), "chat-card"),
      ],
      spec: {
        ...THREAD_SPEC,
        targetTypes: ["chat-card"],
      },
      threshold: 8,
    });

    expect(result.dx).toBe(3);
  });
});

describe("observedGaps", () => {
  it("derives adjacent row gaps without spanning an intervening card", () => {
    expect(
      observedGaps({
        axis: "y",
        maxGap: 96,
        rects: [card(0, 0), card(0, 130), card(0, 250)],
      }),
    ).toEqual([20, 30]);
  });

  it("does not learn gaps beyond the proximity specification", () => {
    expect(
      observedGaps({
        axis: "y",
        maxGap: 96,
        rects: [card(0, 0), card(0, 300)],
      }),
    ).toEqual([]);
  });
});

describe("resolveSnap spacing", () => {
  it("matches a gap observed in the nearby arrangement", () => {
    const result = snap(card(0, 264), [card(0, 0), card(0, 130)]);
    expect(result.dy).toBe(-4);
    expect(result.spacing).toEqual({ axis: "y", gap: 30 });
  });

  it("offers the card-grid gap supplied by the caller", () => {
    const result = snap(card(0, 116), [card(0, 0)]);
    expect(result.dy).toBe(-4);
    expect(result.spacing).toEqual({ axis: "y", gap: 12 });
  });

  it("spaces above a neighbour as readily as below", () => {
    const result = snap(card(0, -117), [card(0, 0)]);
    expect(result.dy).toBe(5);
  });

  it("does not space against a card it is not stacked with", () => {
    const result = snap(card(900, 116), [card(0, 0)]);
    expect(result.dy).toBe(0);
    expect(result.spacing).toBeUndefined();
  });

  it("lets alignment win an axis over spacing", () => {
    // Tops are 3px apart AND a spacing candidate is nearby; the visible
    // edge match is the stronger cue, so it takes the axis.
    const result = snap(card(0, 3), [card(0, 0)]);
    expect(result.dy).toBe(-3);
    expect(result.spacing).toBeUndefined();
  });

  it("aligns one axis and spaces the other — the stacking case", () => {
    // Dragged slightly off a shared left edge and slightly off the
    // established 30px gap: X aligns, Y takes the spacing detent.
    const result = snap(card(4, 264), [card(0, 130)], {
      ...THREAD_SPEC,
      spacingGaps: [30],
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
