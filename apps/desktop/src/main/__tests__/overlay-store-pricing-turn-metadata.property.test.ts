import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, openFreshStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const parent = { backend: "codex", threadId: "parent" } as const;
const createdAt = Date.UTC(2026, 3, 23);

function usageLine(usageLineId: string, fields: Partial<ThreadUsageLineRecord> = {}): ThreadUsageLineRecord {
  return {
    ...parent, usageLineId, turnId: "shared-turn", createdAt, provider: "openai",
    source: "hydration", scope: "turn", status: "finalized", priceStatus: "priced", currency: "USD",
    pricingBasis: "configured-provider",
    cachedInputCostMicros: 0, uncachedInputCostMicros: 100, outputCostMicros: 100, totalCostMicros: 200,
    inputTokens: 10, cachedInputTokens: 0, uncachedInputTokens: 10, outputTokens: 2,
    reasoningOutputTokens: 0, totalTokens: 12, ...fields,
  };
}

const metadataKeys = [
  "startedAt", "completedAt", "observedColdReplayCount", "observedColdReplayUncachedTokens",
  "observedHotReplayCachedTokens", "observedHotReplayCount", "finalContextTokens",
  "peakContextTokens", "modelContextWindow",
] as const;
type Metadata = Pick<ThreadUsageLineRecord, typeof metadataKeys[number]>;

function observedMetadata(row: object) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => metadataKeys.some((field) => field === key)));
}

function observeTurnReads(db: StateDb) {
  const reads: Array<{ rows: number; plan: string[] }> = [];
  const prepare = db.raw.prepare.bind(db.raw);
  const spy = vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (statement.reader && /\bFROM thread_usage_turns\b/.test(sql)) {
      const all = statement.all.bind(statement);
      statement.all = (...bindings: unknown[]) => {
        const rows = all(...bindings);
        const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{ detail: string }>;
        reads.push({ rows: rows.length, plan: plan.map(({ detail }) => detail) });
        return rows;
      };
    }
    return statement;
  });
  return { reads, restore: () => spy.mockRestore() };
}

function expectTurnReadBudget(reads: ReturnType<typeof observeTurnReads>["reads"], rows: number) {
  expect(reads).toHaveLength(1);
  const [read] = reads;
  // SQLite may scan the explicitly bound ID list. It must seek the turn ledger by primary key.
  expect(read!.plan.join("\n")).toMatch(/SEARCH thread_usage_turns USING INDEX .*\(usage_turn_id=\?\)/);
  expect(read!.plan.join("\n")).not.toMatch(/SCAN thread_usage_turns\b/);
  expect(read!.rows).toBe(rows);
}

it("preserves the displayed pricing model with a keyed read of only referenced turn metadata", async () => {
  await fc.assert(fc.asyncProperty(fc.nat({ max: 10_000 }), fc.boolean(), fc.boolean(), async (tokens, reverse, lineOwnsCompletion) => {
    const db = openInMemoryStateDb();
    try {
      const store = new SqliteOverlayStore(db);
      const liveMetadata = {
        startedAt: createdAt - 50,
        observedColdReplayCount: 1,
        observedColdReplayUncachedTokens: tokens + 10,
        observedHotReplayCachedTokens: tokens + 20,
        observedHotReplayCount: 2,
        peakContextTokens: tokens + 50,
      };
      await store.upsertThreadUsageLine({ line: usageLine("root-live", {
        ...liveMetadata, source: "live", status: "pending",
      }) });
      const completedAt = createdAt + 100;
      expect(await store.completeThreadUsageTurn({ ...parent, turnId: "shared-turn", completedAt })).toBe(true);
      expect((await store.readThreadPricing(parent)).lines.map(observedMetadata)).toEqual([{ ...liveMetadata, completedAt }]);

      const context = { finalContextTokens: tokens + 30, modelContextWindow: 200_000 };
      const providerMetadata = { startedAt: createdAt - 3, finalContextTokens: tokens + 5 };
      const childMetadata = { startedAt: createdAt - 9, completedAt: createdAt + 20 };
      const ownCompletion = lineOwnsCompletion ? { completedAt: createdAt + 70 } : {};
      const fixture: Array<[ThreadUsageLineRecord, Metadata]> = [
        [usageLine("root-hydrated", { ...context, ...ownCompletion, peakContextTokens: tokens + 30 }),
          { ...liveMetadata, ...context, completedAt, ...ownCompletion }],
        [usageLine("root-backfilled", { source: "backfill" }),
          { ...liveMetadata, ...context, completedAt, ...ownCompletion }],
        [usageLine("other-provider", { provider: "qwen", parentThreadId: "parent", ...providerMetadata }), providerMetadata],
        [usageLine("child-a", { threadId: "helper-a", parentThreadId: "parent", ...childMetadata }), childMetadata],
        [usageLine("child-b", { provider: "qwen", threadId: "helper-b", parentThreadId: "parent" }), childMetadata],
        [usageLine("dangling", { turnId: "legacy-turn", completedAt }), { completedAt }],
        [usageLine("wrong-backend-link", { turnId: "legacy-turn" }), {}],
        [usageLine("wrong-family-link", { turnId: "legacy-turn" }), {}],
      ];
      const unrelated = [
        usageLine("other-backend", { backend: "claude", startedAt: createdAt - 99 }),
        usageLine("other-family", { threadId: "helper-c", parentThreadId: "other", startedAt: createdAt - 98 }),
      ];
      const lines = [...fixture.map(([line]) => line), ...unrelated];
      await store.upsertThreadUsageLines({ lines: reverse ? lines.reverse() : lines });

      // A legacy line can outlive its metadata or carry an out-of-scope key.
      db.raw.prepare("DELETE FROM thread_usage_turns WHERE turn_id = ?").run("legacy-turn");
      const relink = db.raw.prepare(`UPDATE thread_usage_lines SET usage_turn_id = (
        SELECT usage_turn_id FROM thread_usage_lines WHERE usage_line_id = ?
      ) WHERE usage_line_id = ?`);
      relink.run("other-backend", "wrong-backend-link");
      relink.run("other-family", "wrong-family-link");
      // Within the selected family the stable key wins, even after provider attribution changes.
      relink.run("child-a", "child-b");

      const observation = observeTurnReads(db);
      try {
        const pricing = await store.readThreadPricing(parent);
        const expected = fixture
          .map(([line, metadata]) => ({ id: line.usageLineId, metadata }))
          .sort((left, right) => left.id < right.id ? 1 : -1);
        expect(pricing.lines.map((line) => ({ id: line.usageLineId, metadata: observedMetadata(line) }))).toEqual(expected);
        expect(pricing.summaries.map(({ provider, usageLineCount, totalCostMicros }) => ({ provider, usageLineCount, totalCostMicros })))
          .toEqual([{ provider: "openai", usageLineCount: 6, totalCostMicros: 1_200 },
            { provider: "qwen", usageLineCount: 2, totalCostMicros: 400 }]);
        for (const summary of pricing.summaries) expect(observedMetadata(summary)).toEqual({});
        expectTurnReadBudget(observation.reads, 3);
      } finally {
        observation.restore();
      }
    } finally {
      db.close();
    }
  }), { numRuns: 25 });
});

function seedUnreferencedTurns(db: StateDb, start: number, end: number) {
  db.raw.prepare(`WITH RECURSIVE inventory(id) AS (
    SELECT @start UNION ALL SELECT id + 1 FROM inventory WHERE id + 1 < @end
  ) INSERT INTO thread_usage_turns (
    usage_turn_id, provider, backend, thread_id, parent_thread_id, observed_at, updated_at
  ) SELECT 'inventory:' || id, 'openai', 'codex', 'unrelated:' || id,
    CASE WHEN id % 2 = 0 THEN 'unrelated-parent' END, @now, @now FROM inventory`)
    .run({ start, end, now: createdAt });
}

it("keeps turn read work bounded at N, 2N and 50,000 unrelated turns across a profile reopen", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("pwragent-pricing-turns-");
  let db = openFreshStateDb(temp.dbPath);
  try {
    await new SqliteOverlayStore(db).upsertThreadUsageLines({ lines: [
      usageLine("root", { startedAt: createdAt - 5 }),
      usageLine("child", { threadId: "helper", parentThreadId: "parent", startedAt: createdAt - 10 }),
    ] });
    db.raw.prepare(`INSERT INTO thread_usage_turns (
      usage_turn_id, provider, backend, thread_id, parent_thread_id, observed_at, updated_at
    ) VALUES ('unused-root-turn', 'openai', 'codex', 'parent', NULL, @now, @now),
      ('unused-child-turn', 'openai', 'codex', 'helper', 'parent', @now, @now)`).run({ now: createdAt });

    let previous = 0;
    for (const size of [1_000, 2_000, 50_000]) {
      seedUnreferencedTurns(db, previous, size);
      previous = size;
      if (size === 50_000) {
        db.close();
        db = StateDb.open(temp.dbPath);
      }
      // Force a cold production pricing read at every scale.
      const store = new SqliteOverlayStore(db);
      const observation = observeTurnReads(db);
      try {
        const { result: pricing, writes } = await measureSqliteWrites(() => store.readThreadPricing(parent));
        expect(pricing.lines.map((line) => [line.usageLineId, line.startedAt])).toEqual([
          ["root", createdAt - 5], ["child", createdAt - 10],
        ]);
        expect(writes.commits).toBe(0);
        expectTurnReadBudget(observation.reads, 2);
      } finally {
        observation.restore();
      }
    }
  } finally {
    db.close();
    removeTempStateDbDir(temp.tempDir);
    vi.unstubAllEnvs();
  }
});
