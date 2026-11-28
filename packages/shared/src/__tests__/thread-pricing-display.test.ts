import { describe, expect, it } from "vitest";
import type { ThreadSubAgentSummary } from "../contracts/navigation";
import type { ThreadTokenMiserInterceptionAccounting } from "../contracts/normalized-app-server";
import { buildTokenMiserSavingsSummary, emptyTokenMiserGateAccountingTotals,
  isTokenMiserAuxiliaryHelper } from "../token-miser-savings-summary";
import type { ThreadUsageLineRecord } from "../token-usage-pricing";
import { buildPricingRunningTotals, buildThreadPricingDisplay, buildThreadPricingSnapshotEstimate } from "../thread-pricing-display";

function line(
  usageLineId: string,
  createdAt: number,
  priced: { totalCostMicros: number } | undefined,
): ThreadUsageLineRecord {
  return {
    backend: "codex",
    cachedInputCostMicros: 0,
    cachedInputTokens: 0,
    createdAt,
    currency: "USD",
    inputTokens: 1_000,
    outputCostMicros: 0,
    outputTokens: 100,
    priceStatus: priced ? "priced" : "unpriced",
    provider: "openai",
    reasoningOutputTokens: 0,
    scope: "turn",
    source: "live",
    status: "finalized",
    threadId: "thread-1",
    totalCostMicros: priced?.totalCostMicros ?? 0,
    totalTokens: 1_100,
    uncachedInputCostMicros: 0,
    uncachedInputTokens: 1_000,
    updatedAt: createdAt,
    usageLineId,
  } as ThreadUsageLineRecord;
}

describe("buildPricingRunningTotals", () => {
  it("carries a repriced earlier row into every running total after it", () => {
    const before = [
      line("parent-1", 1_000, { totalCostMicros: 82_000 }),
      line("worker", 2_000, undefined),
      line("parent-2", 3_000, { totalCostMicros: 10_000 }),
    ];
    const unpriced = buildPricingRunningTotals(before).byLineId;
    expect(unpriced.get("worker")?.runningCostMicros).toBe(82_000);
    expect(unpriced.get("parent-2")?.runningCostMicros).toBe(92_000);

    // A worker line priced late, after its model was read from Codex.
    const after = before.map((entry) =>
      entry.usageLineId === "worker"
        ? { ...entry, priceStatus: "priced" as const, totalCostMicros: 5_000 }
        : entry,
    );
    const repriced = buildPricingRunningTotals(after).byLineId;
    expect(repriced.get("parent-1")?.runningCostMicros).toBe(82_000);
    expect(repriced.get("worker")?.runningCostMicros).toBe(87_000);
    expect(repriced.get("parent-2")?.runningCostMicros).toBe(97_000);
  });
});

describe("unobserved thread pricing", () => {
  const tokens = { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 20_000, reasoningOutputTokens: 10_000, totalTokens: 1_020_000 };

  it("preserves the provider estimate across model switches and unavailable USD estimates", () => {
    const provider = { pricingSource: "provider" as const, estimatedCostMicros: 123_456, tokens };
    for (const model of ["gpt-6.1-sol", "gpt-6-astra"]) {
      expect(buildThreadPricingSnapshotEstimate({ ...provider, model, localModel: true }).totalCostMicros).toBe(123_456);
    }
    expect(buildThreadPricingSnapshotEstimate({ ...provider, estimatedCostMicros: undefined, model: "gpt-6.1-sol" }).totalCostMicros).toBeUndefined();
    const display = buildThreadPricingDisplay({ pricing: { lines: [], summaries: [], snapshot: provider } });
    expect(display.rows).toEqual([]);
    expect(display.observedCostMicros).toBe(0);
    expect(display.fallbackEstimate?.totalCostMicros).toBe(123_456);
  });

  it("prices the entire snapshot at the current model's rates without adding ledger rows", () => {
    const pricing = { lines: [], summaries: [], snapshot: { model: "gpt-6.1-sol", tokens } };
    const display = buildThreadPricingDisplay({ pricing });
    // $0.40 uncached + $0.08 cached + $0.20 output. Reasoning is an output
    // subset and must not be charged a second time.
    expect(display.fallbackEstimate).toEqual({ model: "gpt-6.1-sol", tokens, totalCostMicros: 680_000 });
    expect(display.summary).toBeUndefined();
    expect(display.rows).toEqual([]);
    expect(display.observedCostMicros).toBe(0);
    expect(pricing.lines).toEqual([]);
  });

  it("does not add cumulative estimates on top of observed turn charges", () => {
    const display = buildThreadPricingDisplay({ pricing: {
      lines: [line("observed", 1_000, { totalCostMicros: 5_000 })], summaries: [],
      snapshot: { model: "gpt-6.1-sol", tokens },
    } });
    expect(display.fallbackEstimate).toBeUndefined();
    expect(display.observedCostMicros).toBe(5_000);
  });

  it("leaves normal helper pricing in place rather than showing a second headline estimate", () => {
    const display = buildThreadPricingDisplay({ pricing: {
      lines: [{ ...line("helper", 1_000, { totalCostMicros: 5_000 }), scope: "monitor", source: "monitor", sourceItemId: "helper" }],
      summaries: [], snapshot: { model: "gpt-6.1-sol", tokens },
    } });
    expect(display.fallbackEstimate).toBeUndefined();
    expect(display.summary?.totalCostMicros).toBe(5_000);
  });

  it("does not turn unavailable or inconsistent token breakdowns into a zero-dollar price", () => {
    for (const counts of [undefined, { inputTokens: 1_000, outputTokens: 100 }, { inputTokens: 100, cachedInputTokens: 200, outputTokens: 100 }]) {
      expect(buildThreadPricingSnapshotEstimate({ model: "gpt-6.1-sol", tokens: counts }).totalCostMicros).toBeUndefined();
    }
    expect(buildThreadPricingSnapshotEstimate({ model: "unknown-model", tokens }).totalCostMicros).toBeUndefined();
  });

  it("recalculates when the current model changes", () => {
    const at = Date.UTC(2026, 9, 3);
    const sol = buildThreadPricingSnapshotEstimate({ model: "gpt-6.1-sol", tokens }, at);
    const astra = buildThreadPricingSnapshotEstimate({ model: "gpt-6-astra", tokens }, at);
    expect(sol.totalCostMicros).toBeDefined();
    expect(astra.totalCostMicros).toBeDefined();
    expect(sol.totalCostMicros).not.toBe(astra.totalCostMicros);
  });

  it("applies the current speed's rates to the entire snapshot", () => {
    const estimate = buildThreadPricingSnapshotEstimate({ model: "gpt-6.1-sol", serviceTier: "priority", tokens }, Date.UTC(2026, 9, 3));
    expect(estimate.totalCostMicros).toBe(1_360_000);
  });

  it.each(["gpt-6.1-sol", "unknown-local-model"])("preserves the declared local zero-cost policy for %s", (model) => {
    for (const counts of [tokens, undefined]) {
      const estimate = buildThreadPricingSnapshotEstimate({ model, localModel: true, tokens: counts });
      expect(estimate.totalCostMicros).toBe(0);
      expect(estimate.tokens).toEqual(counts);
    }
  });
});

function projectMixedGateGroups(captures: number, groups: number) {
  const lines: ThreadUsageLineRecord[] = [];
  const subAgents: ThreadSubAgentSummary[] = [];
  const interceptions: ThreadTokenMiserInterceptionAccounting[] = [];
  let captureTurnReads = 0;
  let captureRowsChecked = 0;
  let gateTurnReads = 0;
  const record = (id: string, turnId: string, capture: boolean): ThreadTokenMiserInterceptionAccounting => ({
    objectId: id, toolUseId: id, toolName: "commandExecution", createdAt: 1,
    originalCharacters: 400, baselineParentTokens: 100, replacementTokens: 10,
    retrievedTokens: 0, estimatedParentTokensSaved: 90,
    get turnId() {
      if (capture) captureTurnReads++;
      else gateTurnReads++;
      return turnId;
    },
    get boundedCapture() {
      if (!capture) return undefined;
      captureRowsChecked++;
      return true as const;
    },
    ...(capture ? {} : { disposition: "passed_through", decisionSource: "policy" }),
  });
  for (let index = 0; index < groups; index++) {
    const turnId = "turn-" + index;
    const monitorId = "system:token-miser:gate-" + index;
    lines.push({ ...line(turnId, index + 1, { totalCostMicros: 5000 }), turnId });
    lines.push({ ...line(monitorId, index + 1, { totalCostMicros: 100 }), scope: "monitor", source: "monitor", sourceItemId: monitorId });
    subAgents.push({ monitorId, parentTurnId: turnId, task: "Fixture gate", status: "success", createdAt: 1, updatedAt: 1 });
    interceptions.push(record(monitorId, turnId, false));
  }
  for (let index = 0; index < captures; index++) interceptions.push(record("capture-" + index, "turn-0", true));
  const result = buildThreadPricingDisplay({
    pricing: { lines, summaries: [] }, subAgents, tokenMiserAccounting: {
      interceptions, interceptionCount: groups + captures, originalCharacters: 400 * interceptions.length,
      baselineParentTokens: 100 * interceptions.length, replacementTokens: 10 * interceptions.length, retrievedTokens: 0,
      estimatedParentTokensSaved: 90 * interceptions.length,
    },
  });
  return { groups: result.rows.map((row) => row.decisions?.map((decision) => decision.disposition) ?? []),
    captureTurnReads, captureRowsChecked, gateTurnReads };
}

it("indexes fallback Pricing gate decisions once and excludes capture records from every group", () => {
  expect(projectMixedGateGroups(2, 3)).toEqual({
    groups: [["passed_through"], ["passed_through"], ["passed_through"]], captureTurnReads: 0, captureRowsChecked: 2, gateTurnReads: 3,
  });
});

it("keeps captures in the token total and counts only reducer gates as decisions", () => {
  const accounting = { interceptionCount: 3, boundedCaptureCount: 2, estimatedParentTokensSaved: 240, passThroughCount: 0 };
  expect(buildTokenMiserSavingsSummary({ accounting })).toMatchObject({
    decisionCount: 1, boundedCaptureCount: 2, summarizedCount: 1, avoidedParentTokens: 240,
  });
  expect(buildTokenMiserSavingsSummary({ accounting: { ...accounting, interceptionCount: 2 } })).toMatchObject({
    decisionCount: 0, summarizedCount: 0, avoidedParentTokens: 240,
  });
});

it("does not fall back to priced gate cards when a capture charge is unknown", () => {
  const accounting = { interceptionCount: 1, estimatedParentTokensSaved: 240, suppressSavings: true as const };
  const gateTotals = { ...emptyTokenMiserGateAccountingTotals(), gateCount: 1, pricedCount: 1 };
  expect(buildTokenMiserSavingsSummary({ accounting, gateTotals })?.terms).toBeUndefined();
});

it("classifies billed capture Decisions and summarizers as auxiliary Token Miser work", () => {
  for (const id of ["system-token-miser-capture:1:attempt", "system:token-miser-capture:summary", "system:token-miser-focused:focus"]) {
    expect(isTokenMiserAuxiliaryHelper(id), id).toBe(true);
  }
  expect(isTokenMiserAuxiliaryHelper("ordinary-decision:1:attempt")).toBe(false);
});
