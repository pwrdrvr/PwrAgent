import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ThreadUsageLineRecord } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;
const PRICING_CATALOG_TIME = Date.UTC(2026, 3, 23);

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-usage-pricing-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SqliteOverlayStore thread usage pricing ledger", () => {
  it("upserts a priced usage line and cached summary idempotently", async () => {
    const line = buildUsageLine();

    await store.upsertThreadUsageLine({ line });
    await store.upsertThreadUsageLine({ line });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines).toHaveLength(1);
    expect(pricing.summaries).toEqual([
      expect.objectContaining({
        cachedInputTokens: 200,
        currency: "USD",
        inputTokens: 1_000,
        outputTokens: 300,
        pricedUsageLineCount: 1,
        threadId: "thread-1",
        totalCostMicros: 16_100,
        totalTokens: 1_300,
        uncachedInputTokens: 800,
        unpricedUsageLineCount: 0,
        usageLineCount: 1,
      }),
    ]);
  });

  it("stores running totals on usage lines without adding them to summaries", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        cachedInputTokens: 200,
        cumulativeCachedInputTokens: 10_200,
        cumulativeInputTokens: 11_000,
        cumulativeOutputTokens: 500,
        cumulativeReasoningOutputTokens: 100,
        cumulativeTotalCostMicros: 42_000,
        cumulativeTotalTokens: 11_600,
        cumulativeUncachedInputTokens: 800,
        inputTokens: 1_000,
        outputTokens: 50,
        reasoningOutputTokens: 10,
        totalCostMicros: 5_900,
        totalTokens: 1_060,
        uncachedInputTokens: 800,
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      cumulativeCachedInputTokens: 10_200,
      cumulativeInputTokens: 11_000,
      cumulativeOutputTokens: 500,
      cumulativeReasoningOutputTokens: 100,
      cumulativeTotalCostMicros: 42_000,
      cumulativeTotalTokens: 11_600,
      cumulativeUncachedInputTokens: 800,
      inputTokens: 1_000,
      totalCostMicros: 5_900,
      totalTokens: 1_060,
    });
    expect(pricing.summaries[0]).toMatchObject({
      cachedInputTokens: 200,
      inputTokens: 1_000,
      outputTokens: 50,
      reasoningOutputTokens: 10,
      totalCostMicros: 5_900,
      totalTokens: 1_060,
    });
  });

  it("round-trips observed context-replay tallies through the turn record", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        observedColdReplayCount: 2,
        observedColdReplayUncachedTokens: 322_900,
        observedHotReplayCachedTokens: 672_200,
        observedHotReplayCount: 4,
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    // The tally is stored on thread_usage_turns and re-attached to the displayed
    // line at read time.
    expect(pricing.lines[0]).toMatchObject({
      observedColdReplayCount: 2,
      observedColdReplayUncachedTokens: 322_900,
      observedHotReplayCachedTokens: 672_200,
      observedHotReplayCount: 4,
    });
    const turn = stateDb.raw
      .prepare(
        `SELECT observed_cold_replay_count,
                observed_cold_replay_uncached_tokens,
                observed_hot_replay_cached_tokens,
                observed_hot_replay_count
         FROM thread_usage_turns
         WHERE usage_turn_id = ?`,
      )
      .get(pricing.lines[0]?.usageTurnId) as {
        observed_cold_replay_count: number | null;
        observed_cold_replay_uncached_tokens: number | null;
        observed_hot_replay_cached_tokens: number | null;
        observed_hot_replay_count: number | null;
      };
    expect(turn).toEqual({
      observed_cold_replay_count: 2,
      observed_cold_replay_uncached_tokens: 322_900,
      observed_hot_replay_cached_tokens: 672_200,
      observed_hot_replay_count: 4,
    });
    // DEPRECATED dual-write (issue #947): the tally is also mirrored onto
    // thread_usage_lines so older locally-run builds keep displaying it. Remove
    // this assertion when the dual-write is dropped.
    const line = stateDb.raw
      .prepare(
        `SELECT observed_cold_replay_count,
                observed_cold_replay_uncached_tokens,
                observed_hot_replay_cached_tokens,
                observed_hot_replay_count
         FROM thread_usage_lines
         WHERE usage_line_id = ?`,
      )
      .get(pricing.lines[0]?.usageLineId) as {
        observed_cold_replay_count: number | null;
        observed_cold_replay_uncached_tokens: number | null;
        observed_hot_replay_cached_tokens: number | null;
        observed_hot_replay_count: number | null;
      };
    expect(line).toEqual({
      observed_cold_replay_count: 2,
      observed_cold_replay_uncached_tokens: 322_900,
      observed_hot_replay_cached_tokens: 672_200,
      observed_hot_replay_count: 4,
    });
    // Observation-derived tallies must not leak into the priced summary totals.
    expect(pricing.summaries[0]).not.toHaveProperty("observedColdReplayCount");
  });

  it("preserves a persisted observed tally when the same line re-upserts without one", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        observedColdReplayCount: 1,
        observedColdReplayUncachedTokens: 150_000,
        observedHotReplayCount: 3,
        observedHotReplayCachedTokens: 450_000,
        source: "live",
        status: "pending",
        usageLineId: "live:thread-1:turn-1",
      }),
    });

    // Same usageLineId re-upserts (e.g. accumulator reset after restart) with no
    // observed fields — the turn-record COALESCE must not erase the persisted
    // tally.
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        source: "live",
        status: "pending",
        usageLineId: "live:thread-1:turn-1",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      observedColdReplayCount: 1,
      observedColdReplayUncachedTokens: 150_000,
      observedHotReplayCount: 3,
      observedHotReplayCachedTokens: 450_000,
    });
  });

  it("round-trips a parent-scoped monitor line's observed tally through the turn record", async () => {
    const monitorLine: Partial<ThreadUsageLineRecord> = {
      parentThreadId: "thread-1",
      scope: "monitor",
      source: "monitor",
      sourceItemId: "review:turn-review-1",
      threadId: "monitor-thread-1",
      turnId: "turn-review-1",
      usageLineId:
        "codex:thread-1:review:turn-review-1:monitor-thread-1:turn-review-1:monitor",
    };
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        ...monitorLine,
        observedColdReplayCount: 1,
        observedColdReplayUncachedTokens: 152_000,
        observedHotReplayCount: 8,
        observedHotReplayCachedTokens: 4_207_616,
      }),
    });

    // The parent-thread read picks the monitor line up through the
    // parent_thread_id branch and must join the tally back from its
    // child-thread-scoped turn record.
    let pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      scope: "monitor",
      threadId: "monitor-thread-1",
      usageTurnId: "openai:codex:monitor-thread-1:turn-review-1",
      observedColdReplayCount: 1,
      observedColdReplayUncachedTokens: 152_000,
      observedHotReplayCount: 8,
      observedHotReplayCachedTokens: 4_207_616,
    });

    // A later tally-less re-upsert of the same monitor line (e.g. a duplicate
    // usage emission after restart) must not wipe the persisted counts.
    await store.upsertThreadUsageLine({ line: buildUsageLine(monitorLine) });
    pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      observedColdReplayCount: 1,
      observedColdReplayUncachedTokens: 152_000,
      observedHotReplayCount: 8,
      observedHotReplayCachedTokens: 4_207_616,
    });
  });

  it("keeps the observed tally on the turn record when hydration supersedes the live line", async () => {
    // Live turn we observed replays for.
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        completedAt: undefined,
        model: "gpt-5.5",
        observedColdReplayCount: 1,
        observedColdReplayUncachedTokens: 150_000,
        observedHotReplayCount: 4,
        observedHotReplayCachedTokens: 600_000,
        serviceTier: "standard",
        source: "live",
        status: "pending",
        usageLineId: "live:thread-1:turn-1",
      }),
    });

    // Transcript hydration for the same turn (no observed tally, different id,
    // distinct turn metadata) — this is what readThread persists on every thread
    // open. It now supersedes the live line normally.
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        completedAt: 55_000,
        model: "gpt-5.5-codex",
        serviceTier: "priority",
        source: "hydration",
        status: "finalized",
        usageLineId: "codex:thread-1:turn-1:total:item-9",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    // Exactly one line survives — the hydration line — and the observed tally,
    // stored on the turn record, is re-attached to it.
    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      usageLineId: "codex:thread-1:turn-1:total:item-9",
      source: "hydration",
      model: "gpt-5.5-codex",
      observedColdReplayCount: 1,
      observedColdReplayUncachedTokens: 150_000,
      observedHotReplayCount: 4,
      observedHotReplayCachedTokens: 600_000,
    });
    // No double-counting: hydration superseded the live line, not added to it.
    expect(pricing.summaries[0]?.usageLineCount).toBe(1);

    // Turn metadata now reflects the hydration line (COALESCE let it win), while
    // the observed tally is preserved.
    const turn = stateDb.raw
      .prepare(
        `SELECT model,
                service_tier,
                completed_at,
                observed_cold_replay_count,
                observed_hot_replay_count
         FROM thread_usage_turns
         WHERE usage_turn_id = ?`,
      )
      .get(pricing.lines[0]?.usageTurnId) as {
        model: string | null;
        service_tier: string | null;
        completed_at: number | null;
        observed_cold_replay_count: number | null;
        observed_hot_replay_count: number | null;
      };
    expect(turn).toEqual({
      model: "gpt-5.5-codex",
      service_tier: "priority",
      completed_at: 55_000,
      observed_cold_replay_count: 1,
      observed_hot_replay_count: 4,
    });
  });

  it("keeps the original usage line timestamp when live usage is updated", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        createdAt: PRICING_CATALOG_TIME,
        source: "live",
        status: "pending",
        totalCostMicros: 4_000,
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        createdAt: PRICING_CATALOG_TIME + 1_000,
        inputTokens: 1_400,
        source: "live",
        status: "pending",
        totalCostMicros: 16_100,
        totalTokens: 1_700,
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      createdAt: PRICING_CATALOG_TIME,
      inputTokens: 1_400,
      totalCostMicros: 16_100,
      totalTokens: 1_700,
    });
  });

  it("stores usage turn start time separately from usage line timestamp", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        completedAt: 20_000,
        createdAt: 20_100,
        source: "live",
        startedAt: 10_000,
        status: "pending",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    const turn = stateDb.raw
      .prepare(
        `SELECT started_at, completed_at, observed_at
         FROM thread_usage_turns
         WHERE usage_turn_id = ?`,
      )
      .get(pricing.lines[0]?.usageTurnId) as {
        completed_at: number | null;
        observed_at: number | null;
        started_at: number | null;
      };

    expect(pricing.lines[0]).toMatchObject({
      completedAt: 20_000,
      createdAt: 20_100,
    });
    expect(turn).toMatchObject({
      completed_at: 20_000,
      observed_at: 20_100,
      started_at: 10_000,
    });
  });

  it("returns usage line start time for completed turn durations", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        completedAt: 20_000,
        createdAt: 20_100,
        startedAt: 10_000,
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      completedAt: 20_000,
      createdAt: 20_100,
      startedAt: 10_000,
    });
  });

  it("does not erase known turn settings when usage updates omit them", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        createdAt: 1_000,
        fastMode: true,
        model: "gpt-5.5",
        serviceTier: "priority",
        settingsConfidence: "exact",
        settingsSource: "turn-context",
        source: "live",
        status: "pending",
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        createdAt: 2_000,
        fastMode: undefined,
        model: undefined,
        serviceTier: undefined,
        settingsConfidence: "unknown",
        settingsSource: "unknown",
        source: "live",
        status: "pending",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    const turn = stateDb.raw
      .prepare(
        `SELECT model, service_tier, fast_mode, settings_source, settings_confidence
         FROM thread_usage_turns
         WHERE usage_turn_id = ?`,
      )
      .get(pricing.lines[0]?.usageTurnId) as {
        fast_mode: number | null;
        model: string | null;
        service_tier: string | null;
        settings_confidence: string | null;
        settings_source: string | null;
      };

    expect(pricing.lines[0]).toMatchObject({
      fastMode: true,
      model: "gpt-5.5",
      serviceTier: "priority",
      settingsConfidence: "exact",
      settingsSource: "turn-context",
    });
    expect(turn).toEqual({
      fast_mode: 1,
      model: "gpt-5.5",
      service_tier: "priority",
      settings_confidence: "exact",
      settings_source: "turn-context",
    });
  });

  it("excludes superseded rows from active summaries while preserving diagnostics", async () => {
    await store.upsertThreadUsageLine({ line: buildUsageLine() });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        status: "superseded",
        totalCostMicros: 16_100,
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        outputTokens: 600,
        totalCostMicros: 25_100,
        totalTokens: 1_600,
        usageLineId: "line-1-hydrated",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines.map((line) => line.usageLineId)).toEqual([
      "line-1-hydrated",
    ]);
    expect(pricing.summaries[0]).toMatchObject({
      outputTokens: 600,
      totalCostMicros: 25_100,
      totalTokens: 1_600,
      usageLineCount: 1,
    });
  });

  it("rolls sub-agent usage into the parent thread once", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        parentThreadId: "thread-1",
        threadId: "monitor-thread-1",
        totalCostMicros: 16_100,
        usageLineId: "monitor-line-1",
      }),
    });

    const parentPricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    const monitorPricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "monitor-thread-1",
    });

    expect(parentPricing.lines).toHaveLength(1);
    expect(parentPricing.summaries[0]).toMatchObject({
      threadId: "thread-1",
      totalCostMicros: 16_100,
      usageLineCount: 1,
    });
    expect(monitorPricing.lines).toHaveLength(1);
    expect(monitorPricing.summaries).toEqual([]);
  });

  it("tracks unpriced token rows separately from priced cost totals", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        model: undefined,
        priceStatus: "unpriced",
        priceUnavailableReason: "missing-model",
        pricingCatalogId: undefined,
        pricingCatalogVersion: undefined,
        pricingRateId: undefined,
        totalCostMicros: 0,
        usageLineId: "line-unpriced",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      priceStatus: "unpriced",
      priceUnavailableReason: "missing-model",
    });
    expect(pricing.summaries[0]).toMatchObject({
      pricedUsageLineCount: 0,
      totalCostMicros: 0,
      unpricedUsageLineCount: 1,
      usageLineCount: 1,
    });
  });

  it("uses the usage timestamp when selecting effective pricing rates", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        createdAt: Date.UTC(2026, 0, 1),
        completedAt: Date.UTC(2026, 0, 1),
        usageLineId: "line-before-catalog",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      priceStatus: "unpriced",
      priceUnavailableReason: "missing-rate",
      totalCostMicros: 0,
    });
    expect(pricing.summaries[0]).toMatchObject({
      pricedUsageLineCount: 0,
      totalCostMicros: 0,
      unpricedUsageLineCount: 1,
    });
  });

  it("prices GPT-5.5 usage recorded on its April 23 release date", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        cachedInputTokens: 1_000,
        completedAt: Date.UTC(2026, 3, 23, 18, 0, 0),
        createdAt: Date.UTC(2026, 3, 23, 18, 0, 0),
        inputTokens: 4_000,
        outputTokens: 2_000,
        reasoningOutputTokens: 0,
        totalTokens: 6_000,
        uncachedInputTokens: 3_000,
        usageLineId: "line-april-23-gpt-5-5",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      priceStatus: "priced",
      pricingRateId: "openai:2026-06-16:gpt-5.5:standard",
      totalCostMicros: 75_500,
    });
    expect(pricing.lines[0]?.priceUnavailableReason).toBeUndefined();
    expect(pricing.summaries[0]).toMatchObject({
      pricedUsageLineCount: 1,
      totalCostMicros: 75_500,
      unpricedUsageLineCount: 0,
    });
  });

  it("prices GPT-5.5 usage recorded on June 15", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        cachedInputTokens: 38_272,
        completedAt: Date.UTC(2026, 5, 15, 18, 40, 23),
        createdAt: Date.UTC(2026, 5, 15, 18, 40, 23),
        inputTokens: 80_351,
        outputTokens: 58,
        reasoningOutputTokens: 0,
        totalTokens: 80_409,
        uncachedInputTokens: 42_079,
        usageLineId: "line-june-15-gpt-5-5",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      priceStatus: "priced",
      pricingRateId: "openai:2026-06-16:gpt-5.5:standard",
      totalCostMicros: 231_271,
    });
    expect(pricing.lines[0]?.priceUnavailableReason).toBeUndefined();
    expect(pricing.summaries[0]).toMatchObject({
      pricedUsageLineCount: 1,
      totalCostMicros: 231_271,
      unpricedUsageLineCount: 0,
    });
  });

  it("records one provider-scoped usage turn for multiple usage lines from the same turn", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        source: "live",
        totalCostMicros: 4_000,
        usageLineId: "line-1-live",
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        source: "hydration",
        totalCostMicros: 16_100,
        usageLineId: "line-1-hydrated",
      }),
    });

    const turns = stateDb.raw
      .prepare(
        `SELECT usage_turn_id, provider, backend, thread_id, turn_id, model
         FROM thread_usage_turns
         ORDER BY usage_turn_id`,
      )
      .all() as Array<{
        usage_turn_id: string;
        provider: string;
        backend: string;
        thread_id: string;
        turn_id: string | null;
        model: string | null;
      }>;

    expect(turns).toEqual([
      {
        backend: "codex",
        model: "gpt-5.5",
        provider: "openai",
        thread_id: "thread-1",
        turn_id: "turn-1",
        usage_turn_id: "openai:codex:thread-1:turn-1",
      },
    ]);
  });

  it("keeps pricing summaries separated by provider", async () => {
    await store.upsertThreadUsageLine({ line: buildUsageLine() });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        model: "grok-4.20-reasoning",
        outputCostMicros: 2_000,
        provider: "xai",
        pricingCatalogId: "xai-api",
        pricingCatalogVersion: "2026-06-16",
        pricingRateId: "xai:2026-06-16:grok-4.20-reasoning:standard",
        totalCostMicros: 3_000,
        usageLineId: "xai-line-1",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.summaries).toHaveLength(2);
    expect(pricing.summaries).toEqual([
      expect.objectContaining({
        provider: "openai",
        totalCostMicros: 16_100,
        usageLineCount: 1,
      }),
      expect.objectContaining({
        provider: "xai",
        totalCostMicros: 3_000,
        usageLineCount: 1,
      }),
    ]);
  });

  it("persists the fork origin marker and round-trips a fork-baseline line", async () => {
    await store.setThreadForkOrigin({
      backend: "codex",
      threadId: "thread-1",
      forkSourceThreadId: "thread-parent",
    });
    let overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.forkSourceThreadId).toBe("thread-parent");
    expect(overlay?.forkBaselineCaptured).toBeUndefined();

    await store.setThreadForkOrigin({
      backend: "codex",
      threadId: "thread-1",
      forkBaselineCaptured: true,
    });
    overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    // The fork source must survive a later capture-flag write.
    expect(overlay?.forkSourceThreadId).toBe("thread-parent");
    expect(overlay?.forkBaselineCaptured).toBe(true);

    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        usageLineId: "codex:thread-1:fork-baseline",
        scope: "fork-baseline",
        source: "backfill",
        sourceItemId: "fork-baseline",
        turnId: undefined,
        cachedInputTokens: 17_628_672,
        uncachedInputTokens: 1_172_721,
        inputTokens: 18_801_393,
        outputTokens: 46_199,
        reasoningOutputTokens: 9_979,
        totalTokens: 18_847_592,
        cachedInputCostMicros: 0,
        uncachedInputCostMicros: 0,
        outputCostMicros: 0,
        totalCostMicros: 0,
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    const forkLine = pricing.lines.find(
      (line) => line.scope === "fork-baseline",
    );
    expect(forkLine).toMatchObject({
      scope: "fork-baseline",
      cachedInputTokens: 17_628_672,
      uncachedInputTokens: 1_172_721,
      totalCostMicros: 0,
    });
  });

  it("round-trips the turnUsageAttributed flag through sqlite", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        turnId: "turn-attributed",
        turnUsageAttributed: true,
        usageLineId: "line-attributed",
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        turnId: "turn-unattributed",
        turnUsageAttributed: false,
        usageLineId: "line-unattributed",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    const byId = new Map(pricing.lines.map((line) => [line.usageLineId, line]));
    expect(byId.get("line-attributed")?.turnUsageAttributed).toBe(true);
    expect(byId.get("line-unattributed")?.turnUsageAttributed).toBe(false);
    // A line that never set the flag stays undefined, not coerced to a boolean.
    await store.upsertThreadUsageLine({
      line: buildUsageLine({ turnId: "turn-plain", usageLineId: "line-plain" }),
    });
    const after = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(
      after.lines.find((line) => line.usageLineId === "line-plain")
        ?.turnUsageAttributed,
    ).toBeUndefined();
  });

  it("backfills legacy live summary rows to turnUsageAttributed=false on migration", async () => {
    // Legacy whole-thread summary masquerading as a turn (no cumulative
    // breakdown, >= 1M tokens), plus controls that must stay untouched.
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        scope: "turn",
        source: "live",
        status: "pending",
        totalTokens: 2_000_000,
        turnId: "turn-legacy",
        usageLineId: "legacy-summary",
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        cumulativeTotalTokens: 2_000_000,
        scope: "turn",
        source: "live",
        status: "pending",
        totalTokens: 2_000_000,
        turnId: "turn-modern",
        usageLineId: "modern-turn",
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        scope: "turn",
        source: "live",
        status: "pending",
        totalTokens: 500_000,
        turnId: "turn-small",
        usageLineId: "small-live-turn",
      }),
    });

    // Force the user_version 26 migration to run against the seeded rows, then
    // reassign the module handle so afterEach closes the reopened db.
    const dbPath = path.join(tempDir, "state.db");
    stateDb.raw.pragma("user_version = 25");
    stateDb.close();
    stateDb = StateDb.open(dbPath);

    const flagById = new Map(
      (
        stateDb.raw
          .prepare(
            "SELECT usage_line_id, turn_usage_attributed FROM thread_usage_lines",
          )
          .all() as {
          turn_usage_attributed: number | null;
          usage_line_id: string;
        }[]
      ).map((row) => [row.usage_line_id, row.turn_usage_attributed]),
    );
    expect(flagById.get("legacy-summary")).toBe(0);
    expect(flagById.get("modern-turn")).toBeNull();
    expect(flagById.get("small-live-turn")).toBeNull();
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
    threadId: "thread-1",
    totalCostMicros: 16_100,
    totalTokens: 1_300,
    turnId: "turn-1",
    uncachedInputCostMicros: 4_000,
    uncachedInputTokens: 800,
    usageLineId: "line-1",
    ...overrides,
  };
}
