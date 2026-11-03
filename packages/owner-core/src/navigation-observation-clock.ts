/**
 * Orders what the owner learned about its threads: each index scan takes a
 * value when it begins, and each Attention boundary takes one when the store
 * observes it. A value greater than an index's was observed after that
 * index's listing began, so the listing cannot speak for it.
 */
let observation = 0;

/** Take the next value, for a scan that begins or a boundary just observed. */
export function nextNavigationObservation(): number {
  return ++observation;
}

/** The latest value taken; a read that begins now follows every one of them. */
export function currentNavigationObservation(): number {
  return observation;
}
