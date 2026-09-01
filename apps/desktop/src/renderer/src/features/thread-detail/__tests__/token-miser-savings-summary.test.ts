import { describe, expect, it } from "vitest";
import type {
  ThreadTokenMiserAccounting,
  TokenMiserSubAgentAccounting,
} from "@pwragent/shared";
import {
  buildTokenMiserSavingsSummary,
  describeSameTrajectoryCostChange,
} from "../token-miser-savings-summary";

function gate(
  overrides: Partial<TokenMiserSubAgentAccounting> = {},
): TokenMiserSubAgentAccounting {
  return {
    currency: "USD",
    disposition: "summarized",
    decisionSource: "helper",
    originalModel: "gpt-5",
    baselineParentTokens: 10_000,
    baselineParentCostMicros: 20_000,
    gateModel: "gpt-5-mini",
    gateTotalTokens: 4_000,
    gateCostMicros: 2_000,
    revealedParentTokens: 900,
    revealedParentCostMicros: 1_800,
    savingsMicros: 16_200,
    ...overrides,
  };
}

const passedThroughGate = gate({
  disposition: "passed_through",
  decisionSource: "policy",
  baselineParentTokens: 2_500,
  baselineParentCostMicros: 5_000,
  cachedBaselineTokens: 500,
  cachedBaselineCostMicros: 1_000,
  gateCostMicros: 500,
  revealedParentTokens: 2_400,
  revealedParentCostMicros: 4_800,
  cachedRevealedTokens: 450,
  cachedRevealedCostMicros: 900,
  savingsMicros: -200,
});

const threadAccounting: ThreadTokenMiserAccounting = {
  interceptionCount: 5,
  passThroughCount: 2,
  helperDecisionCount: 4,
  originalCharacters: 400_000,
  baselineParentTokens: 100_000,
  replacementTokens: 6_000,
  retrievedTokens: 1_000,
  estimatedParentTokensSaved: 93_000,
  estimatedCachedReplayTokensSaved: 7_000,
  savings: {
    currency: "USD",
    pricedGateCount: 4,
    gateCount: 5,
    withoutGateCostMicros: 900_000,
    gateCostMicros: 40_000,
    revealedCostMicros: 60_000,
    savingsMicros: 800_000,
    directlyObservedReplayCount: 12,
    reconstructedReplayCount: 3,
  },
};

describe("buildTokenMiserSavingsSummary", () => {
  it("quotes the thread-level terms the savings window shows", () => {
    /* The rail links to the window. Summing the two gate rows this view
       happens to hold would print a different total beside that link. */
    const summary = buildTokenMiserSavingsSummary({
      accounting: threadAccounting,
      gateAccountings: [gate(), passedThroughGate],
    });

    expect(summary?.terms).toEqual({
      withoutGateCostMicros: 900_000,
      gateCostMicros: 40_000,
      revealedCostMicros: 60_000,
      savingsMicros: 800_000,
    });
    expect(summary?.decisionCount).toBe(5);
    expect(summary?.pricedDecisionCount).toBe(4);
    expect(summary?.passThroughCount).toBe(2);
    expect(summary?.summarizedCount).toBe(3);
    expect(summary?.helperDecisionCount).toBe(4);
    /* Replays are the window's second figure, not part of this one. Adding
       them here would print a bigger number under the same words. */
    expect(summary?.avoidedParentTokens).toBe(93_000);
  });

  it("sums the gate rows when the thread accounting is not available", () => {
    /* The Pricing rail only receives thread-level accounting while the
       tool-accounting experiment is on, and this card ships to everyone. */
    const summary = buildTokenMiserSavingsSummary({
      gateAccountings: [gate(), passedThroughGate],
    });

    expect(summary?.terms).toEqual({
      withoutGateCostMicros: 26_000,
      gateCostMicros: 2_500,
      revealedCostMicros: 7_500,
      savingsMicros: 16_000,
    });
    expect(summary?.decisionCount).toBe(2);
    expect(summary?.pricedDecisionCount).toBe(2);
    expect(summary?.passThroughCount).toBe(1);
    expect(summary?.summarizedCount).toBe(1);
    expect(summary?.helperDecisionCount).toBe(1);
    expect(summary?.avoidedParentTokens).toBe(9_200);
  });

  it("returns nothing when the thread made no gate decisions", () => {
    expect(
      buildTokenMiserSavingsSummary({ gateAccountings: [] }),
    ).toBeUndefined();
  });

  it("reports decisions before any gate has priced", () => {
    const summary = buildTokenMiserSavingsSummary({
      accounting: {
        ...threadAccounting,
        savings: undefined,
      },
      gateAccountings: [undefined, undefined],
    });

    expect(summary?.decisionCount).toBe(5);
    expect(summary?.pricedDecisionCount).toBe(0);
    expect(summary?.terms).toBeUndefined();
    expect(summary?.avoidedParentTokens).toBe(93_000);
  });

  it("omits the decision mix rather than reporting zero of everything", () => {
    /* Nothing priced and no thread accounting: "0 passed through" would read
       as a fact about the thread instead of as data that has not arrived. */
    const summary = buildTokenMiserSavingsSummary({
      gateAccountings: [undefined, undefined],
    });

    expect(summary?.decisionCount).toBe(2);
    expect(summary?.pricedDecisionCount).toBe(0);
    expect(summary?.passThroughCount).toBeUndefined();
    expect(summary?.summarizedCount).toBeUndefined();
    expect(summary?.helperDecisionCount).toBeUndefined();
    expect(summary?.avoidedParentTokens).toBeUndefined();
    expect(summary?.terms).toBeUndefined();
  });

  it("counts an unpriced gate as a decision the terms do not cover", () => {
    const summary = buildTokenMiserSavingsSummary({
      gateAccountings: [gate(), undefined, undefined],
    });

    expect(summary?.decisionCount).toBe(3);
    expect(summary?.pricedDecisionCount).toBe(1);
    expect(summary?.terms?.savingsMicros).toBe(16_200);
    /* One gate priced, and it summarized. The two that have not priced yet
       are not summarized decisions — subtracting the pass-through count from
       every decision would have claimed all three were. */
    expect(summary?.summarizedCount).toBe(1);
    expect(summary?.passThroughCount).toBe(0);
  });

  it("omits the mix when the gates predate the disposition fields", () => {
    const summary = buildTokenMiserSavingsSummary({
      gateAccountings: [
        gate({ disposition: undefined, decisionSource: undefined }),
      ],
    });

    expect(summary?.decisionCount).toBe(1);
    expect(summary?.pricedDecisionCount).toBe(1);
    expect(summary?.passThroughCount).toBeUndefined();
    expect(summary?.summarizedCount).toBeUndefined();
    expect(summary?.helperDecisionCount).toBeUndefined();
  });

  it("counts only Luna's decisions as Luna evaluations", () => {
    /* Every gate here records who decided, and only one of the two was Luna.
       Counting "not policy" made a gate that recorded nothing look evaluated. */
    const summary = buildTokenMiserSavingsSummary({
      gateAccountings: [gate(), passedThroughGate],
    });

    expect(summary?.helperDecisionCount).toBe(1);
  });

  it("summarizes a thread that ran Code Mode and gated nothing", () => {
    /* Code Mode is Token Miser too. Keyed on reducer decisions alone, this
       thread got no card at all and no way to reach the savings window. */
    const summary = buildTokenMiserSavingsSummary({
      accounting: {
        ...threadAccounting,
        interceptionCount: 0,
        savings: undefined,
        codeMode: {
          callCount: 12,
          commandCellCount: 9,
          directCommandCellCount: 9,
          dispatchClusterCount: 3,
          multiInvocationClusterCount: 1,
          largestDispatchCluster: 4,
          nestedCommandInvocationCount: 14,
          patchCellCount: 1,
          otherCellCount: 2,
          pollingCellCount: 0,
          directCount: 9,
          summarizedCount: 0,
          passThroughCount: 0,
          retrievalCount: 0,
          capturedNestedInvocationCount: 14,
          observations: [],
        },
      },
      gateAccountings: [],
    });

    expect(summary?.decisionCount).toBe(0);
    expect(summary?.codeModeCallCount).toBe(12);
  });
});

describe("describeSameTrajectoryCostChange", () => {
  it("compares the observed bill to the unfiltered one", () => {
    /* Both widths come from here. The rail used to cut the short one out of
       the sentence, which found nothing to cut in the wording below. */
    expect(describeSameTrajectoryCostChange(512_000, 500_000)).toEqual({
      short: "49.4% less",
      sentence: "49.4% less than estimated unfiltered cost",
    });
  });

  it("says so when the gate cost more than it saved", () => {
    expect(describeSameTrajectoryCostChange(120_000, -20_000)).toEqual({
      short: "20.0% more",
      sentence: "20.0% more than estimated unfiltered cost",
    });
  });

  it("avoids a direction word when nothing changed", () => {
    expect(describeSameTrajectoryCostChange(100_000, 0)).toEqual({
      short: "0.0% change",
      sentence: "0.0% change from estimated unfiltered cost",
    });
  });

  it("says nothing without a priced thread to compare against", () => {
    expect(describeSameTrajectoryCostChange(0, 500_000)).toBeUndefined();
  });

  it("says nothing when the unfiltered cost is not positive", () => {
    expect(describeSameTrajectoryCostChange(10_000, -10_000)).toBeUndefined();
  });
});
