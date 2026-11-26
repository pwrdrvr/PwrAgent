import { describe, expect, it } from "vitest";
import {
  buildComparisonReport,
  renderRunSummaryMarkdown,
} from "../../shared/report-format.mjs";

function makeSummaryReport({
  cohortName = "dev-1",
  blind = false,
  recallExact = 8,
  recallTotal = 10,
  novelConcrete = 3,
  novelTotal = 4,
  totalFindings = 12,
  concrete = 10,
  totalTokens = 120_000,
  costUsd = 0.42,
  replays = 14,
  elapsedSec = 85,
} = {}) {
  return {
    generatedAt: "2026-11-26T18:00:00.000Z",
    cohortName,
    blind,
    runMetadata: {
      revLabel: "main@abcdef123456",
      prompt: { shortHash: "deadbeef1234", words: 420 },
    },
    decisionScoring: {
      provider: "jev",
      model: "jev-latest",
      totalItems: 40,
      totalCostUsd: 0.012,
      unverifiedBaselineCount: 0,
    },
    aggregates: {
      all: {
        codex: {
          cases: 4,
          totalFindings,
          meanElapsedSec: elapsedSec,
          medianElapsedSec: elapsedSec - 5,
          structuredRate: "4/4",
          addressedRecall: {
            exact: recallExact,
            partial: 1,
            total: recallTotal,
            exactPct: Number(((100 * recallExact) / recallTotal).toFixed(1)),
            exactOrPartialPct: Number(((100 * (recallExact + 1)) / recallTotal).toFixed(1)),
          },
          declinedRepeated: { repeated: 1, total: 5 },
          precision: {
            concrete,
            unverifiedOrInvalid: totalFindings - concrete,
            total: totalFindings,
            concretePct: Number(((100 * concrete) / totalFindings).toFixed(1)),
          },
          novel: { total: novelTotal, concrete: novelConcrete },
          holistic: { signalToNoise: 4.2, actionability: 4.4, overallQuality: 4.3 },
          usage: {
            measuredCells: 4,
            totalCells: 4,
            pricedCells: 4,
            unpricedCells: 0,
            uncachedInputTokens: Math.round(totalTokens * 0.2),
            cachedInputTokens: Math.round(totalTokens * 0.7),
            cacheWriteInputTokens: 0,
            inputTokens: Math.round(totalTokens * 0.9),
            outputTokens: Math.round(totalTokens * 0.1),
            reasoningOutputTokens: Math.round(totalTokens * 0.05),
            totalTokens,
            meanTotalTokens: Math.round(totalTokens / 4),
            replayObservedCells: 4,
            coldReplayCount: 4,
            hotReplayCount: replays - 4,
            totalReplayCount: replays,
            meanReplayCount: replays / 4,
            maxPeakContextTokens: 45_000,
            totalCostMicros: Math.round(costUsd * 1_000_000),
            estimatedCostUsd: costUsd,
            meanCostUsd: costUsd / 4,
          },
        },
      },
    },
    cases: blind
      ? undefined
      : [{ caseId: "SECRET_CASE_ID_DO_NOT_LEAK", pr: 9999 }],
  };
}

describe("report formatting and multi-run comparison", () => {
  it("renders recall, new verified issues, unverified/invalid, replays, tokens, and list cost", () => {
    const md = renderRunSummaryMarkdown(makeSummaryReport());
    expect(md).toContain("Judge**: `jev` (jev-latest)");
    expect(md).toContain("8/10 (80.0%) / 90.0%");
    expect(md).toContain("| 3/4 |");
    expect(md).toContain("| 2/12 |");
    expect(md).toContain("14 (4/10)");
    expect(md).toContain("120.0k");
    expect(md).toContain("$0.420");
  });

  it("computes side-by-side deltas across baseline and candidate runs", () => {
    const baseline = makeSummaryReport({ recallExact: 7, novelConcrete: 2, totalFindings: 12, concrete: 9, costUsd: 0.5, replays: 16 });
    const candidate = makeSummaryReport({ recallExact: 9, novelConcrete: 4, totalFindings: 11, concrete: 10, costUsd: 0.35, replays: 12 });
    const comp = buildComparisonReport([
      { label: "v1.5.1", report: baseline },
      { label: "candidate", report: candidate },
    ]);

    expect(comp.blind).toBe(false);
    expect(comp.rows).toHaveLength(2);
    expect(comp.markdown).toContain("90.0% (+20.0pp)");
    expect(comp.markdown).toContain("4/4 (+2)");
    expect(comp.markdown).toContain("1/11 (-2)");
    expect(comp.markdown).toContain("12 (-4)");
    expect(comp.markdown).toContain("$0.350 (-$0.150)");
  });

  it("suppresses per-case details and marks comparison blind when any run is blind", () => {
    const blindReport = makeSummaryReport({ cohortName: "test-1", blind: true });
    // Even if a caller accidentally passed extra case properties, renderers must never print them.
    const md = renderRunSummaryMarkdown({ ...blindReport, cases: [{ caseId: "BLIND_SECRET_PR_1234" }] });
    expect(md).toContain("Blind holdout");
    expect(md).not.toContain("BLIND_SECRET_PR_1234");

    const comp = buildComparisonReport([
      { label: "main", report: makeSummaryReport({ cohortName: "test-1", blind: true }) },
      { label: "cand", report: makeSummaryReport({ cohortName: "test-1", blind: false }) },
    ]);
    expect(comp.blind).toBe(true);
    expect(comp.markdown).toContain("Blind holdout detected");
    expect(comp.markdown).not.toContain("SECRET_CASE_ID_DO_NOT_LEAK");
  });
});
