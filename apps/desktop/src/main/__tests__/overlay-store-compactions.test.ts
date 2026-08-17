import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadCompactionRecord } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;

function buildCompaction(
  overrides: Partial<ThreadCompactionRecord> = {},
): ThreadCompactionRecord {
  return {
    backend: "codex",
    compactionId: "codex:thread-1:item-1",
    itemId: "item-1",
    observedAt: 1000,
    threadId: "thread-1",
    turnId: "turn-1",
    updatedAt: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
});

describe("SqliteOverlayStore — compaction markers", () => {
  it("records a compaction and reads it back in observation order", async () => {
    expect(await store.recordThreadCompaction({
      compaction: buildCompaction({
        compactionId: "codex:thread-1:item-2",
        itemId: "item-2",
        observedAt: 2000,
      }),
    })).toBe(true);
    expect(await store.recordThreadCompaction({
      compaction: buildCompaction(),
    })).toBe(true);

    const compactions = await store.listThreadCompactions({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(compactions.map((entry) => entry.observedAt)).toEqual([1000, 2000]);
    expect(compactions[0]?.turnId).toBe("turn-1");
    expect(compactions[0]?.coldUsageLineId).toBeUndefined();
  });

  // A re-emitted notification must not read as a second compaction: the marker
  // exists to bound replay accounting, and a duplicate would halve the window
  // a preserved payload is credited for.
  it("ignores a duplicate marker for the same compaction id", async () => {
    await store.recordThreadCompaction({ compaction: buildCompaction() });

    expect(await store.recordThreadCompaction({
      compaction: buildCompaction({ observedAt: 9999, updatedAt: 9999 }),
    })).toBe(false);

    const compactions = await store.listThreadCompactions({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.observedAt).toBe(1000);
  });

  it("does not leak markers across threads or backends", async () => {
    await store.recordThreadCompaction({ compaction: buildCompaction() });
    await store.recordThreadCompaction({
      compaction: buildCompaction({
        compactionId: "codex:thread-2:item-1",
        threadId: "thread-2",
      }),
    });

    expect(await store.listThreadCompactions({
      backend: "codex",
      threadId: "thread-1",
    })).toHaveLength(1);
    expect(await store.listThreadCompactions({
      backend: "acp:claude",
      threadId: "thread-1",
    })).toHaveLength(0);
  });

  it("attributes a cold replay to the newest unattributed marker", async () => {
    await store.recordThreadCompaction({ compaction: buildCompaction() });
    await store.recordThreadCompaction({
      compaction: buildCompaction({
        compactionId: "codex:thread-1:item-2",
        itemId: "item-2",
        observedAt: 2000,
      }),
    });

    expect(await store.attributeThreadCompactionColdReplay({
      backend: "codex",
      costMicros: 680_000,
      observedAt: 2400,
      threadId: "thread-1",
      uncachedTokens: 135_236,
      usageLineId: "usage-1",
      updatedAt: 2500,
    })).toBe(true);

    const compactions = await store.listThreadCompactions({
      backend: "codex",
      threadId: "thread-1",
    });
    // The newest marker is the one the request re-read context for; the older
    // one keeps whatever it was already credited with.
    expect(compactions[1]?.coldUsageLineId).toBe("usage-1");
    expect(compactions[1]?.coldUncachedTokens).toBe(135_236);
    expect(compactions[1]?.coldCostMicros).toBe(680_000);
    expect(compactions[0]?.coldUsageLineId).toBeUndefined();
  });

  // Usage lines are re-emitted carrying the same cumulative tally. Without the
  // idempotency guard the second emission would walk backwards and credit the
  // earlier compaction with a cold replay that belongs to the later one.
  it("does not re-credit an older marker when the same usage line repeats", async () => {
    await store.recordThreadCompaction({ compaction: buildCompaction() });
    await store.recordThreadCompaction({
      compaction: buildCompaction({
        compactionId: "codex:thread-1:item-2",
        itemId: "item-2",
        observedAt: 2000,
      }),
    });
    const attribution = {
      backend: "codex",
      costMicros: 680_000,
      observedAt: 2400,
      threadId: "thread-1",
      uncachedTokens: 135_236,
      usageLineId: "usage-1",
      updatedAt: 2500,
    } as const;

    expect(await store.attributeThreadCompactionColdReplay(attribution)).toBe(true);
    expect(await store.attributeThreadCompactionColdReplay(attribution)).toBe(false);

    const compactions = await store.listThreadCompactions({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(compactions[0]?.coldUsageLineId).toBeUndefined();
    expect(compactions[1]?.coldUsageLineId).toBe("usage-1");
  });

  // A cold replay observed before any compaction is prompt-cache expiry or a
  // long gap, not a compaction cost — it must not claim a later marker.
  it("does not attribute a cold replay that precedes the compaction", async () => {
    await store.recordThreadCompaction({
      compaction: buildCompaction({ observedAt: 5000 }),
    });

    expect(await store.attributeThreadCompactionColdReplay({
      backend: "codex",
      costMicros: 100,
      observedAt: 4000,
      threadId: "thread-1",
      uncachedTokens: 100,
      usageLineId: "usage-early",
      updatedAt: 4100,
    })).toBe(false);
  });

  it("reports no attribution when every marker already has one", async () => {
    await store.recordThreadCompaction({ compaction: buildCompaction() });
    await store.attributeThreadCompactionColdReplay({
      backend: "codex",
      costMicros: 1,
      observedAt: 1400,
      threadId: "thread-1",
      uncachedTokens: 1,
      usageLineId: "usage-1",
      updatedAt: 1500,
    });

    expect(await store.attributeThreadCompactionColdReplay({
      backend: "codex",
      costMicros: 2,
      observedAt: 2400,
      threadId: "thread-1",
      uncachedTokens: 2,
      usageLineId: "usage-2",
      updatedAt: 2500,
    })).toBe(false);
  });
});
