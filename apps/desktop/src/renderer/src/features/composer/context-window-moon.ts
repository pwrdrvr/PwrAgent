/**
 * Geometry for the composer's context-window moon.
 *
 * The moon only waxes: its lit area is the share of the context window in
 * use, lit from the right. An empty window is a new moon and a full window
 * is a full moon. The shadow is drawn over the lit disc in a `-1 -1 2 2`
 * view box (unit radius, centered on the origin).
 *
 * The shadow is the left half of the disc plus or minus a half-ellipse
 * terminator with x-radius `|1 - 2k|`, where `k` is the lit fraction. Its
 * area is `π(1 - k)`, so the lit share of the disc is exactly `k`.
 */
export type ContextWindowMoonShadow = {
  /** Fraction of the disc that is lit, in [0, 1]. */
  litFraction: number;
  /** SVG path data for the shadow, in the unit-disc view box. */
  path: string;
  /** Horizontal radius of the terminator ellipse, in [0, 1]. */
  terminatorRadius: number;
  /** True while less than half is lit: the terminator bulges into the right half. */
  terminatorBulgesRight: boolean;
};

export function contextWindowMoonLitFraction(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) {
    return 0;
  }
  return Math.max(0, Math.min(1, usedPercent / 100));
}

export function contextWindowMoonShadow(usedPercent: number): ContextWindowMoonShadow {
  const litFraction = contextWindowMoonLitFraction(usedPercent);
  const terminatorRadius = Math.abs(1 - 2 * litFraction);
  const terminatorBulgesRight = litFraction < 0.5;
  // Left limb from the top pole to the bottom pole, then the terminator back
  // up: through the right half while the shadow covers more than half,
  // through the left half once the lit side passes the first quarter.
  const sweep = terminatorBulgesRight ? 0 : 1;
  const rx = Number(terminatorRadius.toFixed(4));
  const path = `M0 -1A1 1 0 0 0 0 1A${rx} 1 0 0 ${sweep} 0 -1Z`;
  return { litFraction, path, terminatorRadius: rx, terminatorBulgesRight };
}
