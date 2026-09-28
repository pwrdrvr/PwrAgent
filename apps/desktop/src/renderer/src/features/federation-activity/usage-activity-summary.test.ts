import { describe, expect, it } from "vitest";
import { summarizeUsageActivity, type OwnedUsageRow } from "./usage-activity-summary";

import { usageFixture } from "./usage-activity-fixture";

describe("usage activity aggregation", () => {
  it("keeps reasoning/cache-write subsets and ignores cumulative counters and peer copies", () => {
    const original = usageFixture();
    const copy = { ...original, owner: "Peer", target: { scope: "remote" as const, instanceId: "peer" } };
    const result = summarizeUsageActivity([original, copy], 100, 300);
    expect(result.duplicates).toBe(1);
    expect(result.groups[0]).toMatchObject({ cost: 300, uncached: 300, cached: 700, cacheWrite: 50, output: 200, reasoning: 100 });
    expect(result.contained).toBe(1); // pending is not synonymous with unmeasured
  });

  it("does not assign a whole turn to a clipped window, or invent an end for a running turn", () => {
    expect(summarizeUsageActivity([usageFixture()], 150, 300)).toMatchObject({ contained: 0, boundary: 1 });
    expect(summarizeUsageActivity([usageFixture()], 100, 200)).toMatchObject({ contained: 0, boundary: 1 });
    expect(summarizeUsageActivity([usageFixture({ completedAt: undefined })], 100, 300)).toMatchObject({ contained: 0, boundary: 1 });
  });

  it("excludes historical, superseded and unattributed rows but includes monitor costs once", () => {
    const rows = ["total", "backfill", "fork-baseline", "latest-request"].map((scope) => usageFixture({
      scope: scope as OwnedUsageRow["line"]["scope"], usageLineId: scope,
    }));
    rows.push(usageFixture({ usageLineId: "unattributed", turnUsageAttributed: false }));
    rows.push(usageFixture({ usageLineId: "superseded", status: "superseded" }));
    rows.push(usageFixture({ usageLineId: "monitor", scope: "monitor", source: "monitor", turnUsageAttributed: undefined }));
    const result = summarizeUsageActivity(rows, 100, 300);
    expect(result).toMatchObject({ contained: 1, unattributed: 6 });
    expect(result.groups[0].cost).toBe(300);
  });

  it("uses the latest copy and keeps missing prices separate from token totals", () => {
    const old = usageFixture();
    const latest = { ...usageFixture({ priceStatus: "unpriced", outputTokens: 300 }), updatedAt: 250 };
    expect(summarizeUsageActivity([latest, old], 100, 300).groups[0]).toMatchObject({ cost: 0, unpriced: 1, output: 300 });
  });

  it("counts a helper recorded as both a monitor and its own live turn once", () => {
    const monitor = { ...usageFixture({ scope: "monitor", source: "monitor", usageLineId: "parent:monitor", turnUsageAttributed: undefined }), updatedAt: 300 };
    const live = usageFixture();
    const result = summarizeUsageActivity([monitor, live], 100, 400);
    expect(result).toMatchObject({ duplicates: 1, contained: 1 });
    expect(result.groups[0].cost).toBe(300);
    expect(result.groups[0].rows[0].line.scope).toBe("turn");
  });

  it("rolls helper threads up into the parent present in the window and keeps their signals apart", () => {
    const parent = usageFixture({ threadId: "parent", usageLineId: "p", turnId: "p1", observedColdReplayCount: 7, peakContextTokens: 940, modelContextWindow: 1000 });
    const helper = usageFixture({ threadId: "helper", parentThreadId: "parent", usageLineId: "h", turnId: "h1", totalCostMicros: 200, observedColdReplayCount: 50, fastMode: true });
    const grandchild = usageFixture({ threadId: "grandchild", parentThreadId: "helper", usageLineId: "g", turnId: "g1", totalCostMicros: 100 });
    const orphan = usageFixture({ threadId: "orphan", parentThreadId: "elsewhere", usageLineId: "o", turnId: "o1" });
    const result = summarizeUsageActivity([{ ...helper, title: "Helper" }, { ...parent, title: "Parent" }, grandchild, orphan], 100, 300);
    expect(result.groups.map((group) => [group.title, group.cost, group.helperThreads, group.helperCost])).toEqual([
      ["Parent", 600, 2, 300],
      ["Fixture thread", 300, 0, 0],
    ]);
    expect(result.groups[0]).toMatchObject({ coldReplays: 7, peakContextShare: 0.94, fastMode: true });
    expect(result.groups[0].rows[0].line.threadId).toBe("parent");
    expect(result.groups[1].coldReplays).toBeUndefined();
  });
});
