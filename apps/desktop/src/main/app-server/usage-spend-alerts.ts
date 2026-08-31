import type {
  DesktopSpendAlertPolicy,
  ThreadPricingSummary,
  ThreadSpendAlert,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import { estimateHistoricalThreadUsageGapLines } from "@pwragent/shared";

const USD_MICROS = 1_000_000;

export function spendThresholdMicros(thresholdUsd: number): number {
  return Math.round(thresholdUsd * USD_MICROS);
}

export function detectUsageSpendAlerts(params: {
  activeTurnIds?: readonly string[];
  backend: string;
  policy: DesktopSpendAlertPolicy;
  pricing: {
    lines: readonly ThreadUsageLineRecord[];
    summaries: readonly ThreadPricingSummary[];
  };
  threadId: string;
  threadSpendAlerted?: boolean;
  triggeredAlertIds: ReadonlySet<string>;
  now?: number;
}): ThreadSpendAlert[] {
  const alerts: ThreadSpendAlert[] = [];
  const now = params.now ?? Date.now();

  if (params.policy.activeTurnSpendEnabled) {
    const thresholdMicros = spendThresholdMicros(
      params.policy.activeTurnSpendThresholdUsd,
    );
    for (const activeTurnId of new Set(params.activeTurnIds ?? [])) {
      const alertId = [
        "spend-alert",
        "active-turn",
        params.backend,
        params.threadId,
        activeTurnId,
        thresholdMicros,
      ].join(":");
      const spendMicros = params.pricing.lines.reduce(
        (total, line) =>
          line.threadId === params.threadId
          && line.turnId === activeTurnId
          && line.scope === "turn"
          && line.turnUsageAttributed !== false
          && line.priceStatus === "priced"
          && line.currency.toUpperCase() === "USD"
            ? total + line.totalCostMicros
            : total,
        0,
      );
      if (
        spendMicros >= thresholdMicros
        && !params.triggeredAlertIds.has(alertId)
      ) {
        alerts.push({
          alertId,
          createdAt: now,
          currency: "USD",
          kind: "active-turn-spend",
          spendMicros,
          threadId: params.threadId,
          thresholdMicros,
          turnId: activeTurnId,
        });
      }
    }
  }

  if (params.policy.threadSpendEnabled) {
    const thresholdMicros = spendThresholdMicros(
      params.policy.threadSpendThresholdUsd,
    );
    const alertId = [
      "spend-alert",
      "thread",
      params.backend,
      params.threadId,
    ].join(":");
    const spendMicros = params.pricing.summaries.reduce(
      (total, summary) =>
        summary.currency.toUpperCase() === "USD"
          ? total + summary.totalCostMicros
          : total,
      0,
    ) + estimateHistoricalThreadUsageGapLines(params.pricing.lines).reduce(
      (total, line) =>
        line.priceStatus === "priced"
        && line.currency.toUpperCase() === "USD"
          ? total + line.totalCostMicros
          : total,
      0,
    );
    if (
      spendMicros >= thresholdMicros
      && !params.threadSpendAlerted
      && !params.triggeredAlertIds.has(alertId)
    ) {
      alerts.push({
        alertId,
        createdAt: now,
        currency: "USD",
        kind: "thread-spend",
        spendMicros,
        threadId: params.threadId,
        thresholdMicros,
      });
    }
  }

  return alerts;
}
