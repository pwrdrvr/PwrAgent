import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildUsageActivityOverview,
  cycleTriStateFilter,
  estimateRowCacheSavingsMicros,
  lineTokenPartition,
  matchesTriStateFilter,
  removeTriStateFilterKey,
  type TriStateFilter,
} from "../usage-activity-overview";
import { summarizeUsageActivity, type OwnedUsageRow } from "../usage-activity-summary";
import { usageFixture } from "../usage-activity-fixture";

const START = Date.UTC(2026, 10, 18, 0, 0, 0);
const DAY_MS = 86_400_000;

const turnArb = fc.record({
  provider: fc.constantFrom("openai", "anthropic", "google", "xai"),
  model: fc.constantFrom("gpt-5.4", "claude-opus-4-6", "gemini-2.5-pro", "grok-4"),
  dayOffset: fc.integer({ min: 0, max: 6 }),
  minuteOffset: fc.integer({ min: 10, max: 23 * 60 }),
  plainInput: fc.integer({ min: 0, max: 500_000 }),
  cacheWrite: fc.integer({ min: 0, max: 200_000 }),
  cachedInput: fc.integer({ min: 0, max: 2_000_000 }),
  output: fc.integer({ min: 0, max: 100_000 }),
  priced: fc.boolean(),
  relayedByPeer: fc.boolean(),
  threadBucket: fc.integer({ min: 0, max: 5 }),
});

describe("usage activity overview properties and oracles", () => {
  it("conserves tokens and cost across providers, models, days, trend buckets, and token types without double-counting relayed turns", () => {
    fc.assert(fc.property(
      fc.array(turnArb, { minLength: 1, maxLength: 35, size: "max" }),
      fc.constantFrom("tokens" as const, "cost" as const),
      (turns, metric) => {
        const from = START;
        const to = START + 7 * DAY_MS;
        const singleCopyRows: OwnedUsageRow[] = [];
        const federatedRows: OwnedUsageRow[] = [];

        turns.forEach((turn, index) => {
          const completedAt = START + turn.dayOffset * DAY_MS + turn.minuteOffset * 60_000;
          const uncached = turn.plainInput + turn.cacheWrite;
          // Synthetic realistic pricing: uncached $3/M, cached $0.30/M, output $15/M.
          const uncachedCostMicros = turn.priced ? Math.round(turn.plainInput * 3) : 0;
          const cacheWriteCostMicros = turn.priced ? Math.round(turn.cacheWrite * 3.75) : 0;
          const cachedCostMicros = turn.priced ? Math.round(turn.cachedInput * 0.3) : 0;
          const outputCostMicros = turn.priced ? Math.round(turn.output * 15) : 0;
          const totalCostMicros = uncachedCostMicros + cacheWriteCostMicros + cachedCostMicros + outputCostMicros;

          const base = usageFixture({
            usageLineId: `line-${index}`,
            threadId: `${turn.provider}-thread-${turn.threadBucket}`,
            turnId: `turn-${index}`,
            provider: turn.provider,
            model: turn.model,
            modelLabel: turn.model,
            createdAt: completedAt - 30_000,
            startedAt: completedAt - 30_000,
            completedAt,
            inputTokens: uncached + turn.cachedInput,
            uncachedInputTokens: uncached,
            cacheWriteInputTokens: turn.cacheWrite,
            cachedInputTokens: turn.cachedInput,
            outputTokens: turn.output,
            totalTokens: uncached + turn.cachedInput + turn.output,
            priceStatus: turn.priced ? "priced" : "unpriced",
            currency: "USD",
            uncachedInputCostMicros: uncachedCostMicros,
            cacheWriteInputCostMicros: cacheWriteCostMicros,
            cachedInputCostMicros: cachedCostMicros,
            outputCostMicros,
            totalCostMicros,
          });
          const localRow: OwnedUsageRow = { ...base, owner: "M5 Max", target: { scope: "local" } };
          singleCopyRows.push(localRow);
          federatedRows.push(localRow);
          if (turn.relayedByPeer) {
            federatedRows.push({
              ...base,
              owner: "M2 Max",
              target: { scope: "remote", instanceId: "m2-max" },
            });
          }
        });

        const oracleSummary = summarizeUsageActivity(singleCopyRows, from, to);
        const fedSummary = summarizeUsageActivity(federatedRows, from, to);

        const oracleOverview = buildUsageActivityOverview({ groups: oracleSummary.groups, from, to, metric });
        const fedOverview = buildUsageActivityOverview({ groups: fedSummary.groups, from, to, metric });

        // Federated duplicate relays MUST produce the exact same totals as the single-copy oracle.
        expect(fedOverview.totals).toEqual(oracleOverview.totals);
        expect(fedOverview.providers).toEqual(oracleOverview.providers);
        expect(fedOverview.models).toEqual(oracleOverview.models);
        expect(fedOverview.days).toEqual(oracleOverview.days);
        expect(fedOverview.trend).toEqual(oracleOverview.trend);

        const { totals, providers, models, days, trend } = fedOverview;

        // Exact 4-part token partition (cacheWrite is a subset of uncached, never double-counted).
        expect(
          totals.plainInputTokens
          + totals.cacheWriteInputTokens
          + totals.cachedInputTokens
          + totals.outputTokens,
        ).toBe(totals.processedTokens);
        expect(totals.plainInputTokens + totals.cacheWriteInputTokens).toBe(totals.uncachedInputTokens);
        expect(totals.cacheSavingsMicros).toBeGreaterThanOrEqual(0);

        // Provider breakdown sums exactly to totals.
        expect(providers.reduce((sum, row) => sum + row.tokens, 0)).toBe(totals.processedTokens);
        expect(providers.reduce((sum, row) => sum + row.costMicros, 0)).toBe(totals.costMicros);
        if (totals.processedTokens > 0) {
          expect(providers.reduce((sum, row) => sum + row.tokenShare, 0)).toBeCloseTo(1, 9);
        }
        if (totals.costMicros > 0) {
          expect(providers.reduce((sum, row) => sum + row.costShare, 0)).toBeCloseTo(1, 9);
        }

        // Model breakdown sums exactly to totals.
        expect(models.reduce((sum, row) => sum + row.tokens, 0)).toBe(totals.processedTokens);
        expect(models.reduce((sum, row) => sum + row.costMicros, 0)).toBe(totals.costMicros);

        // Day breakdown sums exactly to totals.
        expect(days.reduce((sum, row) => sum + row.tokens, 0)).toBe(totals.processedTokens);
        expect(days.reduce((sum, row) => sum + row.costMicros, 0)).toBe(totals.costMicros);

        // Trend buckets sum exactly to totals across all buckets and across per-provider series.
        expect(trend.reduce((sum, point) => sum + point.totalTokens, 0)).toBe(totals.processedTokens);
        expect(trend.reduce((sum, point) => sum + point.totalCostMicros, 0)).toBe(totals.costMicros);
        for (const point of trend) {
          const providerTokenSum = Object.values(point.byProvider).reduce((sum, entry) => sum + entry.tokens, 0);
          const providerCostSum = Object.values(point.byProvider).reduce((sum, entry) => sum + entry.costMicros, 0);
          expect(providerTokenSum).toBe(point.totalTokens);
          expect(providerCostSum).toBe(point.totalCostMicros);
        }

        // Stacked area bands partition [0, total] contiguously at every bucket.
        const { stackedBands, stackedPeak } = fedOverview;
        if (stackedBands.length > 0) {
          for (let i = 0; i < trend.length; i += 1) {
            expect(stackedBands[0].lower[i]).toBe(0);
            for (let b = 0; b < stackedBands.length; b += 1) {
              if (b > 0) expect(stackedBands[b].lower[i]).toBe(stackedBands[b - 1].upper[i]);
              expect(stackedBands[b].upper[i]).toBe(stackedBands[b].lower[i] + stackedBands[b].values[i]);
              expect(stackedBands[b].values[i]).toBeGreaterThanOrEqual(0);
            }
            const expectedTotal = metric === "tokens" ? trend[i].totalTokens : trend[i].totalCostMicros;
            expect(stackedBands.at(-1)!.upper[i]).toBe(expectedTotal);
          }
          expect(stackedPeak).toBe(Math.max(...stackedBands.at(-1)!.upper));
        }
      },
    ));
  });

  it("supports tri-state multi-select provider and model filters (include, exclude, clear) with exact conservation", () => {
    fc.assert(fc.property(
      fc.array(turnArb, { minLength: 2, maxLength: 24, size: "max" }),
      fc.array(fc.constantFrom("OpenAI", "Anthropic", "Google", "xAI"), { minLength: 1, maxLength: 8 }),
      (turns, clickSequence) => {
        const from = START;
        const to = START + 7 * DAY_MS;
        const rows: OwnedUsageRow[] = turns.map((turn, index) => {
          const completedAt = START + turn.dayOffset * DAY_MS + turn.minuteOffset * 60_000;
          const uncached = turn.plainInput + turn.cacheWrite;
          return {
            ...usageFixture({
              usageLineId: `p-${index}`,
              threadId: `${turn.provider}-t-${turn.threadBucket}`,
              turnId: `p-turn-${index}`,
              provider: turn.provider,
              model: turn.model,
              modelLabel: turn.model,
              createdAt: completedAt - 10_000,
              startedAt: completedAt - 10_000,
              completedAt,
              uncachedInputTokens: uncached,
              cacheWriteInputTokens: turn.cacheWrite,
              cachedInputTokens: turn.cachedInput,
              outputTokens: turn.output,
              totalTokens: uncached + turn.cachedInput + turn.output,
              totalCostMicros: turn.priced ? 100_000 : 0,
              priceStatus: turn.priced ? "priced" : "unpriced",
            }),
            owner: "M5 Max",
            target: { scope: "local" },
          };
        });

        // 3 clicks on any key always return the exact prior filter state.
        let providerFilters: TriStateFilter = {};
        for (const key of clickSequence) {
          const before = providerFilters;
          const afterThree = cycleTriStateFilter(cycleTriStateFilter(cycleTriStateFilter(before, key), key), key);
          expect(afterThree).toEqual(before);
          providerFilters = cycleTriStateFilter(providerFilters, key);
        }

        // Removing any key leaves it unfiltered without mutating other keys.
        const firstKey = clickSequence[0];
        const removed = removeTriStateFilterKey(providerFilters, firstKey);
        expect(firstKey in removed).toBe(false);

        const summary = summarizeUsageActivity(rows, from, to);
        const all = buildUsageActivityOverview({ groups: summary.groups, from, to, metric: "tokens" });
        const filtered = buildUsageActivityOverview({
          groups: summary.groups,
          from,
          to,
          metric: "tokens",
          providerFilters,
        });

        // Full provider switcher always remains intact while filtered.
        expect(filtered.providers).toEqual(all.providers);

        // Totals equal the exact sum of every provider passing `matchesTriStateFilter`.
        const matchingProviders = all.providers.filter((entry) => matchesTriStateFilter(providerFilters, entry.label));
        const expectedTokens = matchingProviders.reduce((sum, entry) => sum + entry.tokens, 0);
        const expectedCost = matchingProviders.reduce((sum, entry) => sum + entry.costMicros, 0);
        expect(filtered.totals.processedTokens).toBe(expectedTokens);
        expect(filtered.totals.costMicros).toBe(expectedCost);
        expect(filtered.models.every((row) => matchesTriStateFilter(providerFilters, row.providerLabel))).toBe(true);

        // Model filter narrows totals to exactly the clicked Breakdown row while
        // keeping the provider-scoped model list intact. One model name under
        // two providers is two rows, so it must not pull in its twin.
        if (filtered.models.length > 0) {
          const pickedModel = filtered.models[0];
          const includedModel = buildUsageActivityOverview({
            groups: summary.groups,
            from,
            to,
            metric: "tokens",
            providerFilters,
            modelFilters: { [pickedModel.filterKey]: "include" },
          });
          expect(includedModel.models).toEqual(filtered.models);
          const expectedModelTokens = pickedModel.tokens;
          expect(includedModel.totals.processedTokens).toBe(expectedModelTokens);

          const excludedModel = buildUsageActivityOverview({
            groups: summary.groups,
            from,
            to,
            metric: "tokens",
            providerFilters,
            modelFilters: { [pickedModel.filterKey]: "exclude" },
          });
          expect(excludedModel.totals.processedTokens).toBe(filtered.totals.processedTokens - expectedModelTokens);
        }
      },
    ));
  });

  it("keeps each provider's color and chart band when the Tokens | Cost toggle changes the ranking", () => {
    fc.assert(fc.property(
      fc.array(fc.tuple(turnArb, fc.integer({ min: 0, max: 5_000_000 })), { minLength: 1, maxLength: 30 }),
      (turns) => {
        const from = START;
        const to = START + 7 * DAY_MS;
        const rows: OwnedUsageRow[] = turns.map(([turn, costMicros], index) => {
          const completedAt = START + turn.dayOffset * DAY_MS + turn.minuteOffset * 60_000;
          const uncached = turn.plainInput + turn.cacheWrite;
          return {
            ...usageFixture({
              usageLineId: `c-${index}`, threadId: `${turn.provider}-t-${turn.threadBucket}`, turnId: `c-turn-${index}`,
              provider: turn.provider, model: turn.model, modelLabel: turn.model,
              createdAt: completedAt - 10_000, startedAt: completedAt - 10_000, completedAt,
              uncachedInputTokens: uncached, cacheWriteInputTokens: turn.cacheWrite,
              cachedInputTokens: turn.cachedInput, outputTokens: turn.output,
              totalTokens: uncached + turn.cachedInput + turn.output, totalCostMicros: costMicros,
            }),
            owner: "M5 Max",
            target: { scope: "local" },
          };
        });
        const summary = summarizeUsageActivity(rows, from, to);
        const colors = (metric: "tokens" | "cost") => {
          const overview = buildUsageActivityOverview({ groups: summary.groups, from, to, metric });
          return {
            providers: Object.fromEntries(overview.providers.map((row) => [row.provider, row.seriesIndex])),
            models: Object.fromEntries(overview.models.map((row) => [`${row.provider}:${row.model}`, row.seriesIndex])),
            bands: Object.fromEntries(overview.stackedBands.map((band) => [band.key, band.seriesIndex])),
          };
        };
        expect(colors("cost")).toEqual(colors("tokens"));
      },
    ));
  });

  it("clamps oversized cacheWriteInputTokens defensively and returns zero savings for unpriced or uncached rows", () => {
    const line = usageFixture({
      uncachedInputTokens: 100,
      cacheWriteInputTokens: 250,
      cachedInputTokens: 500,
      outputTokens: 50,
      reasoningOutputTokens: 0,
      priceStatus: "unpriced",
    }).line;
    const part = lineTokenPartition(line);
    expect(part).toEqual({
      processed: 650,
      uncached: 100,
      plainInput: 0,
      cached: 500,
      cacheWrite: 100,
      output: 50,
      reasoning: 0,
    });
    expect(estimateRowCacheSavingsMicros(line)).toBe(0);
  });
});
