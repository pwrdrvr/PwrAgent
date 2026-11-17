import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_MOON_CRITICAL_PERCENT,
  contextWindowMoonFace,
} from "../context-window-moon";

/*
 * The rules the context-window moon promises, per Settings → Appearance →
 * Context moon:
 *
 *   wax          The lit share of the disc is the share of the window in
 *                use, lit from the right. More usage never shows less moon.
 *   lunar-cycle  One lunar month across the window: the lit share is
 *                (1 - cos 2πu) / 2, lit from the right up to full at 50% and
 *                from the left after it. A window at the critical mark shows
 *                a full disc.
 *
 * Before the setting, the moon ran the lunar cycle with no way to choose, so
 * a window 75% full showed less moon than one 50% full.
 */

type Point = { x: number; y: number };

// Oracle: rasterises the shadow path by the SVG arc rules, independently of
// how the code picks its flags. An arc on an ellipse centred on the origin
// runs from the start point's parametric angle to the end point's; sweep 1
// increases the angle and sweep 0 decreases it (SVG 1.1 F.6.5, y down). The
// shadow is the polygon those two arcs bound.
function shadowPolygon(path: string): Point[] {
  const match =
    /^M0 -1A1 1 0 0 ([01]) 0 1A([0-9.]+) 1 0 0 ([01]) 0 -1Z$/.exec(path);
  if (!match) {
    throw new Error(`unexpected moon shadow path: ${path}`);
  }
  const limbSweep = Number(match[1]);
  const terminatorRx = Number(match[2]);
  const terminatorSweep = Number(match[3]);
  // Parametric angles of the poles: (cos θ, sin θ) is (0, -1) at the top.
  const top = -Math.PI / 2;
  const bottom = Math.PI / 2;
  const points: Point[] = [];
  const arc = (rx: number, from: number, sweep: number) => {
    // From one pole to the other is half a turn either way.
    const delta = sweep === 1 ? Math.PI : -Math.PI;
    const steps = 720;
    for (let i = 0; i < steps; i += 1) {
      const angle = from + (delta * i) / steps;
      points.push({ x: rx * Math.cos(angle), y: Math.sin(angle) });
    }
  };
  arc(1, top, limbSweep);
  arc(terminatorRx, bottom, terminatorSweep);
  return points;
}

// Lit share of the unit disc and the x of the lit region's centroid, from
// the shadow polygon's area and centroid (shoelace).
function litGeometry(path: string): { share: number; centroidX: number } {
  const polygon = shadowPolygon(path);
  let twiceArea = 0;
  let cx = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    cx += (a.x + b.x) * cross;
  }
  const shadowArea = Math.abs(twiceArea) / 2;
  const shadowCentroidX = twiceArea === 0 ? 0 : cx / (3 * twiceArea);
  const litArea = Math.PI - shadowArea;
  return {
    share: litArea / Math.PI,
    // The disc's own centroid is the origin, so the lit centroid balances the
    // shadow's.
    centroidX: litArea <= 1e-9 ? 0 : (-shadowArea * shadowCentroidX) / litArea,
  };
}

const usage = fc.double({ min: 0, max: 100, noNaN: true });

describe("context window moon: wax", () => {
  it("lights the share of the disc that matches context usage", () => {
    fc.assert(
      fc.property(usage, (usedPercent) => {
        const { path } = contextWindowMoonFace(usedPercent, "wax");
        expect(litGeometry(path).share).toBeCloseTo(usedPercent / 100, 3);
      }),
    );
  });

  it("never shows less moon for more usage, in the drawn shadow", () => {
    let previous = litGeometry(contextWindowMoonFace(-50, "wax").path).share;
    for (let usedPercent = -50; usedPercent <= 150; usedPercent += 0.25) {
      const { share } = litGeometry(contextWindowMoonFace(usedPercent, "wax").path);
      expect(share).toBeGreaterThanOrEqual(previous - 1e-6);
      previous = share;
    }
  });

  it("is lit from the right and never names a waning phase", () => {
    fc.assert(
      fc.property(fc.double({ min: 1, max: 99, noNaN: true }), (usedPercent) => {
        const face = contextWindowMoonFace(usedPercent, "wax");
        expect(face.phaseKind).not.toBe("waning");
        expect(litGeometry(face.path).centroidX).toBeGreaterThan(0);
      }),
    );
  });

  it("shows a minority lit at 28%, the reported case", () => {
    const face = contextWindowMoonFace(28, "wax");
    expect(litGeometry(face.path).share).toBeCloseTo(0.28, 3);
    expect(face.phaseLabel).toBe("waxing crescent");
  });
});

describe("context window moon: lunar cycle", () => {
  it("lights the real moon's illuminated fraction across one month", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: CONTEXT_MOON_CRITICAL_PERCENT, noNaN: true })
          .filter((usedPercent) => usedPercent < CONTEXT_MOON_CRITICAL_PERCENT),
        (usedPercent) => {
          const { path } = contextWindowMoonFace(usedPercent, "lunar-cycle");
          const expected = (1 - Math.cos((2 * Math.PI * usedPercent) / 100)) / 2;
          expect(litGeometry(path).share).toBeCloseTo(expected, 3);
        },
      ),
    );
  });

  it("is lit from the right while waxing and from the left while waning", () => {
    fc.assert(
      fc.property(fc.double({ min: 2, max: 95, noNaN: true }), (usedPercent) => {
        fc.pre(Math.abs(usedPercent - 50) > 1);
        const face = contextWindowMoonFace(usedPercent, "lunar-cycle");
        const { centroidX } = litGeometry(face.path);
        if (usedPercent < 50) {
          expect(centroidX).toBeGreaterThan(0);
          expect(face.phaseKind).not.toBe("waning");
        } else {
          expect(centroidX).toBeLessThan(0);
        }
      }),
    );
  });

  it("mirrors the waxing half in the waning half", () => {
    fc.assert(
      fc.property(fc.double({ min: 3, max: 50, noNaN: true }), (usedPercent) => {
        const waxing = litGeometry(
          contextWindowMoonFace(usedPercent, "lunar-cycle").path,
        );
        const waning = litGeometry(
          contextWindowMoonFace(100 - usedPercent, "lunar-cycle").path,
        );
        expect(waning.share).toBeCloseTo(waxing.share, 3);
        expect(waning.centroidX).toBeCloseTo(-waxing.centroidX, 3);
      }),
    );
  });

  it("names the old phases: full at half, waning after it", () => {
    expect(contextWindowMoonFace(50, "lunar-cycle").phaseLabel).toBe("full moon");
    expect(contextWindowMoonFace(75, "lunar-cycle").phaseLabel).toBe("third quarter");
    expect(contextWindowMoonFace(90, "lunar-cycle").phaseLabel).toBe("waning crescent");
  });
});

describe("context window moon: both styles", () => {
  it("is critical exactly from the critical mark, and shows a full disc there", () => {
    fc.assert(
      fc.property(
        usage,
        fc.constantFrom("wax" as const, "lunar-cycle" as const),
        (usedPercent, style) => {
          const face = contextWindowMoonFace(usedPercent, style);
          expect(face.critical).toBe(usedPercent >= CONTEXT_MOON_CRITICAL_PERCENT);
          expect(face.phaseKind === "critical").toBe(face.critical);
          if (face.critical) {
            expect(litGeometry(face.path).share).toBeGreaterThan(0.97);
          }
        },
      ),
    );
  });

  it("names each band from its lower edge", () => {
    const labels = (style: "wax" | "lunar-cycle", edges: number[]) =>
      edges.map((usedPercent) => contextWindowMoonFace(usedPercent, style).phaseLabel);
    expect(labels("wax", [0, 9.99, 10, 39.99, 40, 59.99, 60, 89.99, 90, 97.49, 97.5, 100])).toEqual([
      "new moon",
      "new moon",
      "waxing crescent",
      "waxing crescent",
      "first quarter",
      "first quarter",
      "waxing gibbous",
      "waxing gibbous",
      "full moon",
      "full moon",
      "critical",
      "critical",
    ]);
    expect(labels("lunar-cycle", [9.99, 10, 22.5, 35, 47.5, 60, 72.5, 85, 97.49, 97.5])).toEqual([
      "new moon",
      "waxing crescent",
      "first quarter",
      "waxing gibbous",
      "full moon",
      "waning gibbous",
      "third quarter",
      "waning crescent",
      "waning crescent",
      "critical",
    ]);
  });

  it("is a new moon below 10% and treats bad input as empty", () => {
    for (const style of ["wax", "lunar-cycle"] as const) {
      expect(contextWindowMoonFace(9.99, style).phaseKind).toBe("new");
      expect(contextWindowMoonFace(10, style).phaseKind).toBe("waxing");
      expect(contextWindowMoonFace(Number.NaN, style).litFraction).toBe(0);
      expect(contextWindowMoonFace(-20, style).litFraction).toBe(0);
    }
  });
});
