import { describe, expect, it } from "vitest";
import { selectDiscoveryDueThreadKeys } from "../pr-status/pr-discovery";

const CADENCE = 5 * 60_000;

describe("selectDiscoveryDueThreadKeys", () => {
  it("treats a never-swept thread as due", () => {
    expect(
      selectDiscoveryDueThreadKeys({
        threadKeys: ["a", "b"],
        lastRefreshedAt: new Map(),
        now: 1_000_000,
        cadenceMs: CADENCE,
        maxPerTick: 10,
      }),
    ).toEqual(["a", "b"]);
  });

  it("holds a thread until its cadence elapses", () => {
    const now = 1_000_000;
    const lastRefreshedAt = new Map([["a", now - CADENCE + 1]]);
    expect(
      selectDiscoveryDueThreadKeys({
        threadKeys: ["a"],
        lastRefreshedAt,
        now,
        cadenceMs: CADENCE,
        maxPerTick: 10,
      }),
    ).toEqual([]);

    expect(
      selectDiscoveryDueThreadKeys({
        threadKeys: ["a"],
        lastRefreshedAt,
        now: now + 1,
        cadenceMs: CADENCE,
        maxPerTick: 10,
      }),
    ).toEqual(["a"]);
  });

  it("sweeps least-recently-refreshed first so the rotation covers everyone", () => {
    const now = 10_000_000;
    const lastRefreshedAt = new Map([
      ["fresh", now - CADENCE - 1],
      ["stalest", now - CADENCE - 100_000],
      ["middle", now - CADENCE - 50_000],
    ]);
    expect(
      selectDiscoveryDueThreadKeys({
        threadKeys: ["fresh", "stalest", "middle"],
        lastRefreshedAt,
        now,
        cadenceMs: CADENCE,
        maxPerTick: 10,
      }),
    ).toEqual(["stalest", "middle", "fresh"]);
  });

  it("caps the number swept per tick so discovery can't drain the budget", () => {
    const now = 10_000_000;
    const threadKeys = Array.from({ length: 30 }, (_, index) => `t${index}`);
    const due = selectDiscoveryDueThreadKeys({
      threadKeys,
      lastRefreshedAt: new Map(),
      now,
      cadenceMs: CADENCE,
      maxPerTick: 3,
    });
    expect(due).toHaveLength(3);
  });

  it("skips the focused threads — they already get a fast branch-lookup", () => {
    const due = selectDiscoveryDueThreadKeys({
      threadKeys: ["focused", "background"],
      lastRefreshedAt: new Map(),
      now: 1_000_000,
      cadenceMs: CADENCE,
      maxPerTick: 10,
      skipThreadKeys: new Set(["focused"]),
    });
    expect(due).toEqual(["background"]);
  });

  it("rotates: after sweeping the stalest, the next tick picks the next-stalest", () => {
    const now = 10_000_000;
    const lastRefreshedAt = new Map([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    const first = selectDiscoveryDueThreadKeys({
      threadKeys: ["a", "b", "c"],
      lastRefreshedAt,
      now,
      cadenceMs: CADENCE,
      maxPerTick: 1,
    });
    expect(first).toEqual(["a"]);

    // Simulate having swept "a" this tick.
    lastRefreshedAt.set("a", now);
    const second = selectDiscoveryDueThreadKeys({
      threadKeys: ["a", "b", "c"],
      lastRefreshedAt,
      now: now + 1,
      cadenceMs: CADENCE,
      maxPerTick: 1,
    });
    expect(second).toEqual(["b"]);
  });
});
