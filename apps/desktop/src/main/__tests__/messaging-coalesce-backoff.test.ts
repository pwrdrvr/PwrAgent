import { describe, expect, it } from "vitest";
import {
  COALESCE_INITIAL_MS,
  COALESCE_MAX_MS,
  coalesceBackoffMs,
} from "../messaging/core/messaging-coalesce-backoff";

describe("coalesceBackoffMs", () => {
  it("holds the first block for the initial window", () => {
    expect(coalesceBackoffMs(0)).toBe(COALESCE_INITIAL_MS);
    // Defensive: negative counts collapse to the initial window.
    expect(coalesceBackoffMs(-1)).toBe(COALESCE_INITIAL_MS);
  });

  it("doubles each subsequent release and caps at the ceiling", () => {
    expect(coalesceBackoffMs(1)).toBe(1_000);
    expect(coalesceBackoffMs(2)).toBe(2_000);
    expect(coalesceBackoffMs(3)).toBe(4_000);
    expect(coalesceBackoffMs(4)).toBe(8_000);
    expect(coalesceBackoffMs(5)).toBe(16_000);
    expect(coalesceBackoffMs(5)).toBe(COALESCE_MAX_MS);
    // Beyond the cap the interval stays flat.
    expect(coalesceBackoffMs(6)).toBe(COALESCE_MAX_MS);
    expect(coalesceBackoffMs(20)).toBe(COALESCE_MAX_MS);
  });
});
