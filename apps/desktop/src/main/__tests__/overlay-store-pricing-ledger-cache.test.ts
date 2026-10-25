import type { ThreadUsageLineRecord } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import {
  createTempStateDb,
  openInMemoryStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

// A turn end publishes a thread's whole pricing ledger, and the renderer then
// reads it again for the accounting display, the transcript, and an open
// context panel. The store reuses one read until the thread's ledger changes.
// These pin what counts as a change: any row of the thread's ledger tables
// written on this connection, raw SQL included, or any commit from another
// connection — and never a write to another thread.

const THREAD_ID = "thread-cached";
const PRICING_CATALOG_TIME = Date.UTC(2026, 3, 23);

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string | undefined;
let materialized: MockInstance;

function trackMaterializations(target: SqliteOverlayStore): MockInstance {
  return vi.spyOn(
    target as unknown as { materializeThreadPricing(params: unknown): unknown },
    "materializeThreadPricing",
  );
}

function read() {
  return store.readThreadPricing({ backend: "codex", threadId: THREAD_ID });
}

beforeEach(async () => {
  tempDir = undefined;
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
  await store.upsertThreadUsageLines({
    lines: [
      buildUsageLine({ usageLineId: "line-1", turnId: "turn-1" }),
      buildUsageLine({ usageLineId: "line-2", turnId: "turn-2", createdAt: PRICING_CATALOG_TIME + 1 }),
    ],
  });
  materialized = trackMaterializations(store);
});

afterEach(() => {
  vi.restoreAllMocks();
  stateDb.close();
  if (tempDir !== undefined) {
    removeTempStateDbDir(tempDir);
  }
});

describe("SqliteOverlayStore pricing ledger reuse", () => {
  it("reuses one read until the ledger changes, and hands each caller its own copy", async () => {
    const first = await read();
    const second = await read();
    expect(materialized).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);

    // Callers decorate the lines they receive; that must not reach the next.
    first.lines[0]!.modelLabel = "decorated";
    first.lines.push(buildUsageLine({ usageLineId: "pushed" }));
    first.summaries.length = 0;
    const third = await read();
    expect(materialized).toHaveBeenCalledTimes(1);
    expect(third).toEqual(second);
  });

  it("re-reads after each kind of write to the thread's ledger", async () => {
    await read();
    const reads = () => materialized.mock.calls.length;

    await store.upsertThreadUsageLines({
      lines: [buildUsageLine({ usageLineId: "line-3", turnId: "turn-3", createdAt: PRICING_CATALOG_TIME + 2 })],
    });
    expect((await read()).lines.map((line) => line.usageLineId)).toContain("line-3");
    expect(reads()).toBe(2);

    // A child thread's line belongs to its parent's ledger.
    await store.upsertThreadUsageLines({
      lines: [buildUsageLine({
        parentThreadId: THREAD_ID,
        scope: "monitor",
        threadId: "helper-thread",
        usageLineId: "child-line",
      })],
    });
    expect((await read()).lines.map((line) => line.usageLineId)).toContain("child-line");
    expect(reads()).toBe(3);

    // A turn's end time lives on its turn row.
    await store.upsertThreadUsageLines({
      lines: [buildUsageLine({
        source: "live",
        sourceItemId: "thread-token-usage",
        status: "pending",
        turnId: "turn-live",
        usageLineId: "live-line",
      })],
    });
    await read();
    expect(await store.completeThreadUsageTurn({
      backend: "codex",
      completedAt: PRICING_CATALOG_TIME + 60_000,
      threadId: THREAD_ID,
      turnId: "turn-live",
    })).toBe(true);
    const completed = (await read()).lines.find((line) => line.usageLineId === "live-line");
    expect(completed?.completedAt).toBe(PRICING_CATALOG_TIME + 60_000);
    expect(reads()).toBe(5);

    // Raw SQL is seen too: the counters come from triggers, not call sites.
    stateDb.raw
      .prepare("UPDATE thread_pricing_summaries SET input_tokens = input_tokens + 7 WHERE thread_id = ?")
      .run(THREAD_ID);
    const summary = (await read()).summaries[0];
    expect(reads()).toBe(6);
    expect(summary?.inputTokens).toBe(
      (await store.readThreadPricingSummaries([{ backend: "codex", threadId: THREAD_ID }]))[0]?.inputTokens,
    );
  });

  it("keeps the read across writes to other threads", async () => {
    await read();
    await store.upsertThreadUsageLines({
      lines: [buildUsageLine({ threadId: "thread-other", usageLineId: "other-line" })],
    });
    await read();
    expect(materialized).toHaveBeenCalledTimes(1);
  });

  it("re-reads after another connection commits", async () => {
    stateDb.close();
    const temp = createTempStateDb("pwragent-pricing-cache-");
    tempDir = temp.tempDir;
    stateDb = StateDb.open(temp.dbPath);
    store = new SqliteOverlayStore(stateDb);
    materialized = trackMaterializations(store);
    expect((await read()).lines).toEqual([]);

    const other = StateDb.open(temp.dbPath);
    try {
      await new SqliteOverlayStore(other).upsertThreadUsageLines({
        lines: [buildUsageLine({ usageLineId: "from-other-process" })],
      });
    } finally {
      other.close();
    }
    expect((await read()).lines.map((line) => line.usageLineId)).toEqual(["from-other-process"]);
    expect(materialized).toHaveBeenCalledTimes(2);
  });

  it("never keeps a read made inside a transaction that rolls back", async () => {
    await read();
    stateDb.raw.exec("BEGIN");
    try {
      await store.upsertThreadUsageLines({
        lines: [buildUsageLine({ usageLineId: "rolled-back", createdAt: PRICING_CATALOG_TIME + 5 })],
      });
      expect((await read()).lines.map((line) => line.usageLineId)).toContain("rolled-back");
    } finally {
      stateDb.raw.exec("ROLLBACK");
    }
    expect((await read()).lines.map((line) => line.usageLineId)).not.toContain("rolled-back");
  });
});

describe("SqliteOverlayStore Token Miser gate pricing lines", () => {
  it("returns exactly the whole-ledger rows a gate lookup can match, in ledger order", async () => {
    await store.upsertThreadUsageLines({
      lines: [
        // The gate's own line, written under its helper thread.
        buildUsageLine({
          createdAt: PRICING_CATALOG_TIME + 10,
          parentThreadId: THREAD_ID,
          scope: "monitor",
          sourceItemId: "system:token-miser:gate-a",
          threadId: "helper-a",
          usageLineId: "gate-a-line",
        }),
        // A parent line matched by its usage turn rather than its turn.
        buildUsageLine({
          createdAt: PRICING_CATALOG_TIME + 11,
          turnId: "request-turn",
          usageLineId: "parent-by-usage-turn",
          usageTurnId: "gate-turn",
        }),
        buildUsageLine({
          createdAt: PRICING_CATALOG_TIME + 12,
          turnId: "gate-turn",
          usageLineId: "parent-by-turn",
        }),
        // Neither the gate's source item nor its turn.
        buildUsageLine({
          createdAt: PRICING_CATALOG_TIME + 13,
          parentThreadId: THREAD_ID,
          scope: "monitor",
          sourceItemId: "system:token-miser:gate-b",
          threadId: "helper-b",
          usageLineId: "gate-b-line",
        }),
      ],
    });
    const gateLines = await store.readTokenMiserGatePricingLines({
      backend: "codex",
      sourceItemIds: ["system:token-miser:gate-a"],
      threadId: THREAD_ID,
      turnIds: ["gate-turn"],
    });
    const ledger = (await read()).lines;
    const matchable = new Set(["gate-a-line", "parent-by-usage-turn", "parent-by-turn"]);
    expect(gateLines).toEqual(ledger.filter((line) => matchable.has(line.usageLineId)));
  });
});

function buildUsageLine(
  overrides: Partial<ThreadUsageLineRecord> = {},
): ThreadUsageLineRecord {
  return {
    backend: "codex",
    cachedInputCostMicros: 100,
    cachedInputTokens: 200,
    createdAt: PRICING_CATALOG_TIME,
    currency: "USD",
    fastMode: false,
    inputTokens: 1_000,
    model: "gpt-5.5",
    outputCostMicros: 12_000,
    outputTokens: 300,
    priceStatus: "priced",
    provider: "openai",
    pricingCatalogId: "openai-api",
    pricingCatalogVersion: "2026-06-16",
    pricingRateId: "openai:2026-06-16:gpt-5.5:standard",
    reasoningEffort: "high",
    reasoningOutputTokens: 100,
    scope: "turn",
    serviceTier: "standard",
    settingsConfidence: "exact",
    settingsSource: "turn-context",
    source: "hydration",
    sourceItemId: "item-1",
    status: "finalized",
    threadId: THREAD_ID,
    totalCostMicros: 16_100,
    totalTokens: 1_300,
    turnId: "turn-1",
    uncachedInputCostMicros: 4_000,
    uncachedInputTokens: 800,
    usageLineId: "line-1",
    ...overrides,
  };
}
