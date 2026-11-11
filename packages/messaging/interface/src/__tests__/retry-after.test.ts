import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MESSAGING_RETRY_AFTER_MAX_MS,
  parseRetryAfterMs,
  retryAfterMsFromHttpHeaders,
} from "../retry-after";

const NOW = 1_800_000_000_000;

describe("parseRetryAfterMs", () => {
  it("reads delta-seconds and HTTP-dates as the same wait, capped", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 * 3_600 }), (seconds) => {
        const expected = Math.min(seconds * 1000, MESSAGING_RETRY_AFTER_MAX_MS);
        expect(parseRetryAfterMs(String(seconds), NOW)).toBe(expected);
        expect(parseRetryAfterMs(` ${seconds} `, NOW)).toBe(expected);
        expect(
          parseRetryAfterMs(new Date(NOW + seconds * 1000).toUTCString(), NOW),
        ).toBe(expected);
      }),
    );
  });

  it("treats a past HTTP-date as no wait", () => {
    expect(parseRetryAfterMs(new Date(NOW - 60_000).toUTCString(), NOW)).toBe(0);
  });

  it("never returns a negative, unbounded, or non-finite wait", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (value) => {
        const parsed = parseRetryAfterMs(value, NOW);
        if (parsed === undefined) return;
        expect(Number.isFinite(parsed)).toBe(true);
        expect(parsed).toBeGreaterThanOrEqual(0);
        expect(parsed).toBeLessThanOrEqual(MESSAGING_RETRY_AFTER_MAX_MS);
      }),
    );
    expect(parseRetryAfterMs("-5", NOW)).toBeUndefined();
    expect(parseRetryAfterMs("soon", NOW)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined();
  });
});

describe("retryAfterMsFromHttpHeaders", () => {
  it("prefers Retry-After, then the fallback header, then the default", () => {
    const read = (values: Record<string, string>) => {
      const headers = new Headers(values);
      return retryAfterMsFromHttpHeaders({
        defaultMs: 5_000,
        fallbackSecondsHeaders: ["x-ratelimit-reset"],
        headers,
        nowMs: NOW,
      });
    };
    expect(read({ "Retry-After": "3", "X-RateLimit-Reset": "30" })).toBe(3_000);
    expect(read({ "Retry-After": "garbage", "X-RateLimit-Reset": "30" })).toBe(30_000);
    expect(read({})).toBe(5_000);
  });
});
