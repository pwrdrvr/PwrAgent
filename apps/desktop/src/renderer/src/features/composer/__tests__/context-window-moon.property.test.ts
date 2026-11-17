import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { contextWindowMoonShadow } from "../context-window-moon";

/*
 * The rule the context-window moon promises:
 *
 *   The lit share of the disc is the share of the context window in use.
 *   More usage never shows less moon.
 *
 * Before, the moon ran a whole lunar cycle: full at about half usage, then
 * waning again, so a window 28% full showed a half moon and 75% full showed
 * less moon than 50%.
 */

type Terminator = { rx: number; sweep: number };

// Reads the terminator arc back out of the rendered path, so the oracle
// checks the path the composer draws, not the helper's own bookkeeping.
function parseShadowPath(path: string): Terminator {
  const match = /^M0 -1A1 1 0 0 0 0 1A([0-9.]+) 1 0 0 ([01]) 0 -1Z$/.exec(path);
  if (!match) {
    throw new Error(`unexpected moon shadow path: ${path}`);
  }
  return { rx: Number(match[1]), sweep: Number(match[2]) };
}

// Oracle: a point of the unit disc is in shadow when it lies in the left half
// and outside the terminator ellipse, or (sweep 0) inside the ellipse, which
// then bulges into the right half.
function isShadowed(x: number, y: number, { rx, sweep }: Terminator): boolean {
  const insideEllipse = rx > 0 && (x * x) / (rx * rx) + y * y <= 1;
  if (sweep === 0) {
    return x <= 0 || insideEllipse;
  }
  return x <= 0 && !insideEllipse;
}

function litShare(path: string): number {
  const terminator = parseShadowPath(path);
  const steps = 400;
  let inDisc = 0;
  let lit = 0;
  for (let i = 0; i < steps; i += 1) {
    for (let j = 0; j < steps; j += 1) {
      const x = -1 + (2 * (i + 0.5)) / steps;
      const y = -1 + (2 * (j + 0.5)) / steps;
      if (x * x + y * y > 1) {
        continue;
      }
      inDisc += 1;
      if (!isShadowed(x, y, terminator)) {
        lit += 1;
      }
    }
  }
  return lit / inDisc;
}

describe("context window moon", () => {
  it("lights the share of the disc that matches context usage", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 100, noNaN: true }), (usedPercent) => {
        const { path } = contextWindowMoonShadow(usedPercent);
        expect(litShare(path)).toBeCloseTo(usedPercent / 100, 2);
      }),
      { numRuns: 60 },
    );
  });

  it("never shows less moon for more usage", () => {
    let previous = contextWindowMoonShadow(-50).litFraction;
    for (let usedPercent = -50; usedPercent <= 150; usedPercent += 0.25) {
      const { litFraction } = contextWindowMoonShadow(usedPercent);
      expect(litFraction).toBeGreaterThanOrEqual(previous);
      previous = litFraction;
    }
  });

  it("shows a minority lit at 28%, the reported case", () => {
    expect(litShare(contextWindowMoonShadow(28).path)).toBeCloseTo(0.28, 2);
  });
});
