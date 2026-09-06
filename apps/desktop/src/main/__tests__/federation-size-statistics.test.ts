import { describe, expect, it } from "vitest";
import { FederationSizeStatistics } from "../federation/federation-size-statistics";

describe("Federation lifetime payload size statistics", () => {
  it("distinguishes no observations from zero-byte observations", () => {
    const stats = new FederationSizeStatistics();
    expect(stats.snapshot()).toEqual({ count: 0 });
    stats.record(0);
    expect(stats.snapshot()).toEqual({ count: 1, averageBytes: 0, p50Bytes: 0, minBytes: 0, maxBytes: 0 });
  });

  it("preserves exact count/average/extrema while exposing a large-response outlier", () => {
    const stats = new FederationSizeStatistics();
    for (const size of [1_000, 1_000, 1_000, 1_000, 50_000_000]) stats.record(size);
    const snapshot = stats.snapshot();
    expect(snapshot).toMatchObject({ count: 5, averageBytes: 10_000_800, minBytes: 1_000, maxBytes: 50_000_000 });
    expect(snapshot.p50Bytes).toBeGreaterThanOrEqual(989);
    expect(snapshot.p50Bytes).toBeLessThanOrEqual(1011);
  });

  it("estimates the nearest-rank median within 1.1% across the safe integer range", () => {
    for (let octave = 0; octave < 53; octave += 1) {
      for (const fraction of [1, 1.1, 1.5, 1.99]) {
        const value = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(2 ** octave * fraction));
        const stats = new FederationSizeStatistics();
        for (const size of [0, value, Number.MAX_SAFE_INTEGER]) stats.record(size);
        expect(Math.abs(stats.snapshot().p50Bytes! - value) / value).toBeLessThan(0.011);
      }
    }
    const even = new FederationSizeStatistics();
    for (const size of [100, 200, 300, 400]) even.record(size);
    expect(even.snapshot().p50Bytes!).toBeGreaterThan(197.8);
    expect(even.snapshot().p50Bytes!).toBeLessThan(202.2);
  });

  it("keeps fixed numeric storage rather than a growing sample list", () => {
    const stats = new FederationSizeStatistics();
    for (let size = 1; size <= 100_000; size += 1) stats.record(size);
    const histogram = (stats as unknown as { histogram: Float64Array }).histogram;
    expect(histogram.length).toBe(1698);
    expect(histogram.byteLength).toBe(13_584);
    expect(stats.snapshot()).toMatchObject({ count: 100_000, minBytes: 1, maxBytes: 100_000, averageBytes: 50_000.5 });
  });

  it("ignores invalid lengths and returns detached snapshots", () => {
    const stats = new FederationSizeStatistics();
    for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) stats.record(value);
    expect(stats.snapshot()).toEqual({ count: 0 });
    stats.record(1024);
    stats.snapshot().maxBytes = 99;
    expect(stats.snapshot().maxBytes).toBe(1024);
    expect(stats.snapshot().p50Bytes).toBe(1024);
  });
});
