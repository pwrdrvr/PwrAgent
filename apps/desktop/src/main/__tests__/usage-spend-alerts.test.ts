import type {
  DesktopSpendAlertPolicy,
  ThreadPricingSummary,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import {
  detectUsageSpendAlerts,
  spendThresholdMicros,
} from "../app-server/usage-spend-alerts";

const POLICY: DesktopSpendAlertPolicy = {
  activeTurnSpendEnabled: true,
  activeTurnSpendThresholdUsd: 5,
  threadSpendEnabled: true,
  threadSpendThresholdUsd: 25,
};

describe("usage spend alerts", () => {
  it("converts dollar thresholds to integer micros", () => {
    expect(spendThresholdMicros(7.5)).toBe(7_500_000);
  });

  it("alerts independently for active-turn and total-thread spend", () => {
    const alerts = detectUsageSpendAlerts({
      activeTurnIds: ["turn-2"],
      backend: "codex",
      now: 1_800_000_000_000,
      policy: POLICY,
      pricing: {
        lines: [
          usageLine({ turnId: "turn-2", totalCostMicros: 5_250_000 }),
          usageLine({ turnId: "turn-1", totalCostMicros: 30_000_000 }),
        ],
        summaries: [pricingSummary(35_250_000)],
      },
      threadId: "thread-1",
      triggeredAlertIds: new Set(),
    });

    expect(alerts).toMatchObject([
      {
        kind: "active-turn-spend",
        spendMicros: 5_250_000,
        thresholdMicros: 5_000_000,
        turnId: "turn-2",
      },
      {
        kind: "thread-spend",
        spendMicros: 35_250_000,
        thresholdMicros: 25_000_000,
      },
    ]);
  });

  it("includes estimated historical usage gaps in total-thread spend", () => {
    const alerts = detectUsageSpendAlerts({
      backend: "codex",
      policy: {
        ...POLICY,
        activeTurnSpendEnabled: false,
        threadSpendThresholdUsd: 23,
      },
      pricing: {
        lines: [
          usageLine({
            createdAt: Date.UTC(2026, 7, 31),
            cumulativeCachedInputTokens: 0,
            cumulativeInputTokens: 2_000_000,
            cumulativeOutputTokens: 0,
            cumulativeTotalTokens: 2_000_000,
            cumulativeUncachedInputTokens: 2_000_000,
            inputTokens: 1_000_000,
            model: "gpt-5.6-sol",
            totalCostMicros: 20_000_000,
            totalTokens: 1_000_000,
            uncachedInputTokens: 1_000_000,
          }),
        ],
        summaries: [pricingSummary(20_000_000)],
      },
      threadId: "thread-1",
      triggeredAlertIds: new Set(),
    });

    expect(alerts).toMatchObject([
      {
        kind: "thread-spend",
        spendMicros: 24_000_000,
        thresholdMicros: 23_000_000,
      },
    ]);
  });

  it("prices historical usage gaps at the rate in effect when usage occurred", () => {
    const alerts = detectUsageSpendAlerts({
      backend: "codex",
      policy: {
        ...POLICY,
        activeTurnSpendEnabled: false,
        threadSpendThresholdUsd: 24.5,
      },
      pricing: {
        lines: [
          usageLine({
            createdAt: Date.UTC(2026, 7, 20, 23, 59, 59),
            cumulativeCachedInputTokens: 0,
            cumulativeInputTokens: 2_000_000,
            cumulativeOutputTokens: 0,
            cumulativeTotalTokens: 2_000_000,
            cumulativeUncachedInputTokens: 2_000_000,
            inputTokens: 1_000_000,
            model: "gpt-5.6-sol",
            totalCostMicros: 20_000_000,
            totalTokens: 1_000_000,
            uncachedInputTokens: 1_000_000,
          }),
        ],
        summaries: [pricingSummary(20_000_000)],
      },
      threadId: "thread-1",
      triggeredAlertIds: new Set(),
    });

    expect(alerts).toMatchObject([
      {
        kind: "thread-spend",
        spendMicros: 25_000_000,
        thresholdMicros: 24_500_000,
      },
    ]);
  });

  it("evaluates every active turn represented in one usage batch", () => {
    const alerts = detectUsageSpendAlerts({
      activeTurnIds: ["turn-1", "turn-2", "turn-1"],
      backend: "codex",
      policy: POLICY,
      pricing: {
        lines: [
          usageLine({ turnId: "turn-1", totalCostMicros: 6_000_000 }),
          usageLine({ turnId: "turn-2", totalCostMicros: 7_000_000 }),
        ],
        summaries: [pricingSummary(13_000_000)],
      },
      threadId: "thread-1",
      triggeredAlertIds: new Set(),
    });

    expect(alerts.map((alert) => alert.kind === "active-turn-spend"
      ? alert.turnId
      : alert.kind)).toEqual(["turn-1", "turn-2"]);
  });

  it("ignores disabled, unpriced, historical-summary, and non-USD rows", () => {
    const alerts = detectUsageSpendAlerts({
      activeTurnIds: ["turn-2"],
      backend: "codex",
      policy: {
        ...POLICY,
        threadSpendEnabled: false,
      },
      pricing: {
        lines: [
          usageLine({ priceStatus: "unpriced", totalCostMicros: 20_000_000 }),
          usageLine({
            currency: "EUR",
            totalCostMicros: 20_000_000,
          }),
          usageLine({
            totalCostMicros: 20_000_000,
            turnUsageAttributed: false,
          }),
        ],
        summaries: [pricingSummary(50_000_000)],
      },
      threadId: "thread-1",
      triggeredAlertIds: new Set(),
    });

    expect(alerts).toEqual([]);
  });

  it("does not repeat an alert already emitted for the same threshold", () => {
    const first = detectUsageSpendAlerts({
      backend: "codex",
      policy: POLICY,
      pricing: {
        lines: [],
        summaries: [pricingSummary(30_000_000)],
      },
      threadId: "thread-1",
      triggeredAlertIds: new Set(),
    });
    const triggeredAlertIds = new Set(first.map((alert) => alert.alertId));

    expect(detectUsageSpendAlerts({
      backend: "codex",
      policy: POLICY,
      pricing: {
        lines: [],
        summaries: [pricingSummary(40_000_000)],
      },
      threadId: "thread-1",
      triggeredAlertIds,
    })).toEqual([]);
  });

  it("suppresses the total-spend alert after the thread boundary is persisted", () => {
    expect(detectUsageSpendAlerts({
      backend: "codex",
      policy: POLICY,
      pricing: {
        lines: [],
        summaries: [pricingSummary(40_000_000)],
      },
      threadId: "thread-1",
      threadSpendAlerted: true,
      triggeredAlertIds: new Set(),
    })).toEqual([]);
  });
});

function usageLine(
  overrides: Partial<ThreadUsageLineRecord> = {},
): ThreadUsageLineRecord {
  return {
    backend: "codex",
    cachedInputCostMicros: 0,
    cachedInputTokens: 0,
    createdAt: 1_800_000_000_000,
    currency: "USD",
    inputTokens: 0,
    outputCostMicros: 0,
    outputTokens: 0,
    priceStatus: "priced",
    provider: "openai",
    reasoningOutputTokens: 0,
    scope: "turn",
    source: "live",
    status: "pending",
    threadId: "thread-1",
    totalCostMicros: 0,
    totalTokens: 0,
    turnId: "turn-2",
    turnUsageAttributed: true,
    uncachedInputCostMicros: 0,
    uncachedInputTokens: 0,
    usageLineId: "usage-turn-2",
    ...overrides,
  };
}

function pricingSummary(totalCostMicros: number): ThreadPricingSummary {
  return {
    backend: "codex",
    cachedInputTokens: 0,
    currency: "USD",
    inputTokens: 0,
    outputTokens: 0,
    pricedUsageLineCount: 1,
    provider: "openai",
    reasoningOutputTokens: 0,
    threadId: "thread-1",
    totalCostMicros,
    totalTokens: 0,
    uncachedInputTokens: 0,
    unpricedUsageLineCount: 0,
    updatedAt: 1_800_000_000_000,
    usageLineCount: 1,
  };
}
