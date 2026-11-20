import type { DesktopContextMoonStyle } from "@pwragent/shared/contracts/settings";

/**
 * Geometry and naming for the composer's context-window moon.
 *
 * Settings → Appearance → Context moon picks one of two styles:
 *
 * - `wax`: the moon only waxes. Its lit area is the share of the window in
 *   use, lit from the right: a new moon at 0% and a full moon at 100%.
 * - `lunar-cycle`: one lunar month runs across the window. The moon waxes to
 *   full at 50%, then wanes, lit from the left, toward a new moon as the
 *   window runs out. Its lit area is the real moon's illuminated fraction,
 *   `(1 - cos θ) / 2` with `θ = 2π · used`.
 *
 * In both, a window at or past `CONTEXT_MOON_CRITICAL_PERCENT` is critical
 * and shows a full disc that the stylesheet paints as an eclipsed "blood
 * moon". Critical starts at 85% because providers compact before a window
 * fills, so a later mark would never show. It also ends the lunar cycle
 * early: its last moon before critical is a crescent about a quarter lit,
 * never the near-dark sliver that read as the empty moon at 0%.
 *
 * The shadow is drawn over the lit disc in a `-1 -1 2 2` view box (unit
 * radius, centered on the origin). It is the unlit half of the disc plus or
 * minus a half-ellipse terminator with x-radius `|1 - 2k|`, where `k` is the
 * lit fraction. Its area is `π(1 - k)`, so the lit share is exactly `k`.
 */
export const CONTEXT_MOON_CRITICAL_PERCENT = 85;

export type ContextWindowMoonPhaseKind =
  | "new"
  | "waxing"
  | "full"
  | "waning"
  | "critical";

export type ContextWindowMoonFace = {
  critical: boolean;
  /** Fraction of the disc that is lit, in [0, 1]. */
  litFraction: number;
  /** The limb the light comes from: right while waxing, left while waning. */
  litSide: "left" | "right";
  /** SVG path data for the shadow, in the unit-disc view box. */
  path: string;
  phaseKind: ContextWindowMoonPhaseKind;
  phaseLabel: string;
};

type PhaseBand = {
  below: number;
  kind: ContextWindowMoonPhaseKind;
  label: string;
};

// Wax to full has no "full moon" band: a full window is the critical moon.
const WAX_PHASES: readonly PhaseBand[] = [
  { below: 10, kind: "new", label: "new moon" },
  { below: 40, kind: "waxing", label: "waxing crescent" },
  { below: 60, kind: "waxing", label: "first quarter" },
  {
    below: CONTEXT_MOON_CRITICAL_PERCENT,
    kind: "waxing",
    label: "waxing gibbous",
  },
];

const LUNAR_CYCLE_PHASES: readonly PhaseBand[] = [
  { below: 10, kind: "new", label: "new moon" },
  { below: 22.5, kind: "waxing", label: "waxing crescent" },
  { below: 35, kind: "waxing", label: "first quarter" },
  { below: 47.5, kind: "waxing", label: "waxing gibbous" },
  { below: 60, kind: "full", label: "full moon" },
  { below: 72.5, kind: "waning", label: "waning gibbous" },
  { below: 80, kind: "waning", label: "third quarter" },
  {
    below: CONTEXT_MOON_CRITICAL_PERCENT,
    kind: "waning",
    label: "waning crescent",
  },
];

const CRITICAL_BAND: PhaseBand = {
  below: Number.POSITIVE_INFINITY,
  kind: "critical",
  label: "critical",
};

function clampPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) {
    return 0;
  }
  return Math.max(0, Math.min(100, usedPercent));
}

function phaseBand(
  usedPercent: number,
  style: DesktopContextMoonStyle,
): PhaseBand {
  const bands = style === "lunar-cycle" ? LUNAR_CYCLE_PHASES : WAX_PHASES;
  return bands.find((band) => usedPercent < band.below) ?? CRITICAL_BAND;
}

function shadowPath(litFraction: number, litSide: "left" | "right"): string {
  const rx = Number(Math.abs(1 - 2 * litFraction).toFixed(4));
  // From the top pole along the unlit limb to the bottom pole, then back up
  // along the terminator: through the lit half while the shadow covers more
  // than half the disc, through the unlit half once the lit side passes the
  // quarter. A limb on the left is sweep 0 from the top pole; the right limb
  // is its mirror, which flips both sweep flags.
  const terminatorCrossesLitHalf = litFraction < 0.5;
  const limbSweep = litSide === "right" ? 0 : 1;
  const terminatorSweep = terminatorCrossesLitHalf ? limbSweep : 1 - limbSweep;
  return `M0 -1A1 1 0 0 ${limbSweep} 0 1A${rx} 1 0 0 ${terminatorSweep} 0 -1Z`;
}

export function contextWindowMoonFace(
  usedPercent: number,
  style: DesktopContextMoonStyle,
): ContextWindowMoonFace {
  const used = clampPercent(usedPercent);
  const band = phaseBand(used, style);
  const critical = band.kind === "critical";

  let litFraction: number;
  let litSide: "left" | "right";
  if (critical) {
    litFraction = 1;
    litSide = "right";
  } else if (style === "lunar-cycle") {
    const cycle = used / 100;
    litFraction = (1 - Math.cos(2 * Math.PI * cycle)) / 2;
    litSide = cycle <= 0.5 ? "right" : "left";
  } else {
    litFraction = used / 100;
    litSide = "right";
  }

  return {
    critical,
    litFraction,
    litSide,
    path: shadowPath(litFraction, litSide),
    phaseKind: band.kind,
    phaseLabel: band.label,
  };
}
