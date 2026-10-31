import type { BackendRateLimitSummary, BackendModelOption } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRateLimitResetSendAt, getShortTermRateLimitResetAt } from "../rate-limit-schedule";

const now = Date.parse("2026-10-31T12:00:00Z");
const resetAt = now + 3 * 60 * 60_000;
const limit: BackendRateLimitSummary = { name: "Short-term allowance", resetAt, windowMinutes: 300 };

afterEach(() => vi.restoreAllMocks());

describe("getShortTermRateLimitResetAt", () => {
  it.each([
    { name: "5h limit" },
    { name: "5-hour limit", limitId: "five_hour" },
    { name: "12h limit" },
    { name: "12-hour limit" },
    { name: "Unlabelled", windowMinutes: 720 },
    { name: "Unlabelled", windowSeconds: 18_000 },
    { name: "Unlabelled", windowMinutes: 60 },
  ])("uses the reported reset for $name", (reading) => {
    expect(getShortTermRateLimitResetAt({ now, rateLimits: [{ ...reading, resetAt }] })).toBe(resetAt);
  });

  it.each([
    { resetAt: now }, { resetAt: now - 1 }, { resetAt: undefined },
    { resetAt: NaN }, { resetAt: Infinity },
    { windowMinutes: 10_080 }, { windowMinutes: 0 }, { windowMinutes: NaN },
    { windowMinutes: Infinity }, { windowMinutes: 721 },
    { expires: true }, { windowKey: "credits" as const }, { unlimited: true },
  ])("ignores invalid, elapsed, long-term and nonrenewing limits: %j", (reading) => {
    expect(getShortTermRateLimitResetAt({ now, rateLimits: [{ ...limit, ...reading }] })).toBeUndefined();
  });

  it("does not guess a reset without a known short-term window", () => {
    expect(getShortTermRateLimitResetAt({ now })).toBeUndefined();
    expect(getShortTermRateLimitResetAt({ now, rateLimits: [{ name: "Weekly limit", resetAt }] })).toBeUndefined();
    // A nearby weekly reset still is not a short-term allowance.
    expect(getShortTermRateLimitResetAt({ now, rateLimits: [{ name: "5h limit", resetAt, windowMinutes: 10_080 }] })).toBeUndefined();
  });

  it("prefers a selected model's limit, then the generic account limit", () => {
    const generic = { ...limit, name: "5-hour limit" };
    const opus = { ...limit, name: "Opus 5h limit", resetAt: resetAt + 60_000 };
    const sonnet = { ...limit, name: "Sonnet 5h limit", resetAt: resetAt - 60_000 };
    const rateLimits = [sonnet, opus, generic];
    const selectedModelOption: BackendModelOption = { id: "opus", label: "Opus" };
    expect(getShortTermRateLimitResetAt({ now, rateLimits, selectedModelOption })).toBe(opus.resetAt);
    expect(getShortTermRateLimitResetAt({ now, rateLimits })).toBe(generic.resetAt);
  });

  it("selects the next reset among eligible windows", () => {
    expect(getShortTermRateLimitResetAt({ now, rateLimits: [limit, { ...limit, resetAt: resetAt - 60_000 }] }))
      .toBe(resetAt - 60_000);
  });
});

describe("getRateLimitResetSendAt", () => {
  it.each([[0, 5 * 60_000], [0.4, 7 * 60_000], [0.999999, 10 * 60_000 - 1]])(
    "adds a five-minute buffer and bounded jitter (%s)", (random, delay) => {
      const sample = vi.spyOn(Math, "random").mockReturnValue(random);
      expect(getRateLimitResetSendAt(resetAt)).toBe(resetAt + delay);
      expect(sample).toHaveBeenCalledTimes(1);
    },
  );
});
