import type { TooltipRect } from "./tooltip-placement";

export type AimPoint = { x: number; y: number };

/**
 * How long a pointer heading for an open card may rest on another trigger
 * before that trigger takes the card. Pointer moves arrive every frame while
 * the pointer travels, so a pause this long means it stopped.
 */
export const POINTER_AIM_SETTLE_MS = 150;

/** Pointer samples kept for `pointerAimsAtRect`'s `from`: the oldest of them. */
export const POINTER_AIM_TRAIL = 3;

/**
 * Whether a pointer that moved from `from` to `to` is heading for `rect`
 * (the "safe triangle"): `to` lies strictly inside the triangle between
 * `from` and the edge of `rect` that faces it.
 *
 * Use it where an enterable card opens beside a list of triggers and the
 * way to the card crosses other triggers: while the pointer aims at the
 * card, a trigger it crosses is on the way, not a destination. A move along
 * the list, away from the card, or no move at all is not aiming, so
 * browsing the triggers is unaffected. False when `from` is inside `rect`.
 */
export function pointerAimsAtRect(from: AimPoint, to: AimPoint, rect: TooltipRect): boolean {
  let near: AimPoint;
  let far: AimPoint;
  if (from.x < rect.left) {
    near = { x: rect.left, y: rect.top };
    far = { x: rect.left, y: rect.bottom };
  } else if (from.x > rect.right) {
    near = { x: rect.right, y: rect.top };
    far = { x: rect.right, y: rect.bottom };
  } else if (from.y < rect.top) {
    near = { x: rect.left, y: rect.top };
    far = { x: rect.right, y: rect.top };
  } else if (from.y > rect.bottom) {
    near = { x: rect.left, y: rect.bottom };
    far = { x: rect.right, y: rect.bottom };
  } else {
    return false;
  }
  // `to` is on the same side of all three edges, and on none of them.
  const a = turn(from, near, to);
  const b = turn(near, far, to);
  const c = turn(far, from, to);
  return (a > 0 && b > 0 && c > 0) || (a < 0 && b < 0 && c < 0);
}

/** Twice the signed area of the triangle o, p, q: which side of o→p q is on. */
function turn(o: AimPoint, p: AimPoint, q: AimPoint): number {
  return (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
}
