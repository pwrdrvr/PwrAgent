import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  COALESCE_BASE_MS,
  COALESCE_INITIAL_MS,
  COALESCE_MAX_MS,
  coalesceBackoffMs,
} from "../messaging/core/messaging-coalesce-backoff";

// Rules, from the module comment: the gap before the next streaming edit
// starts at the initial window, never shrinks as more edits are released for
// the same message, never exceeds the cap, and doubles until it reaches it.

describe("coalesceBackoffMs properties", () => {
  it("never shrinks as the release count grows, and stays within its bounds", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (releaseCount, step) => {
          const gap = coalesceBackoffMs(releaseCount);
          const later = coalesceBackoffMs(releaseCount + step);
          expect(Number.isFinite(gap)).toBe(true);
          expect(gap).toBeGreaterThanOrEqual(COALESCE_INITIAL_MS);
          expect(gap).toBeLessThanOrEqual(COALESCE_MAX_MS);
          expect(later).toBeGreaterThanOrEqual(gap);
        },
      ),
    );
  });

  it("doubles each release after the first until the cap, then holds", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (releaseCount) => {
        const gap = coalesceBackoffMs(releaseCount);
        const next = coalesceBackoffMs(releaseCount + 1);
        expect(next).toBe(Math.min(gap * 2, COALESCE_MAX_MS));
        if (releaseCount === 1) {
          expect(gap).toBe(COALESCE_BASE_MS);
        }
      }),
    );
  });

  it("bounds the edits a long stream can release in any span of time", () => {
    // A message's edits are separated by the gaps above, so over `spanMs` a
    // stream releases at most the count whose cumulative gaps fit inside it.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 24 * 60 * 60_000 }), (spanMs) => {
        let elapsed = 0;
        let releases = 0;
        while (elapsed + coalesceBackoffMs(releases) <= spanMs) {
          elapsed += coalesceBackoffMs(releases);
          releases += 1;
        }
        // After the ramp, the cap limits a stream to one edit per cap window.
        expect(releases).toBeLessThanOrEqual(Math.floor(spanMs / COALESCE_MAX_MS) + 6);
      }),
    );
  });
});
