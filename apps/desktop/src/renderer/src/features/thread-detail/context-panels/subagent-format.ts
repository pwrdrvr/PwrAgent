import type {
  TaskMonitorUsageSnapshot,
  ThreadSubAgentStatus,
} from "@pwragent/shared";
import {
  estimateOpenAiCodexCreditUsage,
  formatTokenUsageUsd,
} from "@pwragent/shared";
import type { RailChipTone } from "./RailStatusChip";

export type PricingDisplayOptions = {
  codexCredits: boolean;
  usd: boolean;
};

const DEFAULT_PRICING_DISPLAY_OPTIONS: PricingDisplayOptions = {
  codexCredits: false,
  usd: true,
};

/** Maps a sub-agent status onto a shared status-chip tone. */
export function subAgentTone(status: ThreadSubAgentStatus): RailChipTone {
  switch (status) {
    case "running":
      return "active";
    case "success":
      return "ok";
    case "blocked":
      return "warning";
    case "failed":
    case "failure":
      return "error";
    case "pending":
    case "cancelled":
      return "neutral";
  }
}

/** Human label for a sub-agent status. */
export function subAgentStatusLabel(status: ThreadSubAgentStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "blocked":
      return "Blocked";
    case "failed":
    case "failure":
      return "Failed";
    case "success":
      return "Completed";
    case "cancelled":
      return "Cancelled";
  }
}

/** Compact, locale-grouped token count (e.g. `303,488`). */
export function formatTokenCount(value: number): string {
  return value.toLocaleString();
}

export function formatSubAgentUsageSummary(params: {
  displayOptions?: PricingDisplayOptions;
  model?: string;
  usage: TaskMonitorUsageSnapshot;
}): string {
  const displayOptions = params.displayOptions ?? DEFAULT_PRICING_DISPLAY_OPTIONS;
  const tokenUsage = params.usage.tokenUsage;
  const inputTokens = Math.max(0, tokenUsage.inputTokens ?? 0);
  const cachedInputTokens = Math.min(
    inputTokens,
    Math.max(0, tokenUsage.cachedInputTokens ?? 0),
  );
  const uncachedInputTokens = Math.max(
    0,
    tokenUsage.uncachedInputTokens ?? inputTokens - cachedInputTokens,
  );
  const outputTokens = Math.max(0, tokenUsage.outputTokens ?? 0);
  const reasoningOutputTokens = Math.max(
    0,
    tokenUsage.reasoningOutputTokens ?? 0,
  );
  const estimates = formatSubAgentUsageEstimates({
    displayOptions,
    model: params.model ?? params.usage.model ?? params.usage.cost?.model,
    usage: params.usage,
  });

  return [
    `${formatTokenCount(uncachedInputTokens)} uncached in`,
    `${formatTokenCount(cachedInputTokens)} cached`,
    reasoningOutputTokens > 0
      ? `${formatTokenCount(outputTokens)} out (${formatTokenCount(
          reasoningOutputTokens,
        )} reasoning)`
      : `${formatTokenCount(outputTokens)} out`,
    estimates,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function formatSubAgentUsageEstimates(params: {
  displayOptions?: PricingDisplayOptions;
  model?: string;
  usage: TaskMonitorUsageSnapshot;
}): string | undefined {
  const displayOptions = params.displayOptions ?? DEFAULT_PRICING_DISPLAY_OPTIONS;
  const estimates: string[] = [];
  if (displayOptions.usd && params.usage.cost) {
    estimates.push(`${formatTokenUsageUsd(params.usage.cost.totalUsd)} list price`);
  }
  if (displayOptions.codexCredits) {
    const credits = estimateOpenAiCodexCreditUsage({
      cachedInputTokens: Math.max(
        0,
        params.usage.tokenUsage.cachedInputTokens ?? 0,
      ),
      fastMode: params.usage.fastMode,
      model: params.model ?? params.usage.model ?? params.usage.cost?.model,
      outputTokens: Math.max(0, params.usage.tokenUsage.outputTokens ?? 0),
      reasoningOutputTokens: Math.max(
        0,
        params.usage.tokenUsage.reasoningOutputTokens ?? 0,
      ),
      serviceTier: params.usage.serviceTier,
      uncachedInputTokens: Math.max(
        0,
        params.usage.tokenUsage.uncachedInputTokens ??
          Math.max(0, params.usage.tokenUsage.inputTokens ?? 0) -
            Math.max(0, params.usage.tokenUsage.cachedInputTokens ?? 0),
      ),
    });
    if (credits && credits.totalCreditMicros > 0) {
      estimates.push(formatCodexCredits(credits.totalCreditMicros));
    }
  }
  return estimates.length > 0 ? estimates.join(" · ") : undefined;
}

export function formatCodexCredits(valueMicros: number): string {
  if (valueMicros <= 0) {
    return "0 Codex Credits";
  }
  const value = valueMicros / 1_000_000;
  if (value < 0.05) {
    return "<0.1 Codex Credits";
  }
  if (value >= 10) {
    return `${new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 0,
    }).format(value)} Codex Credits`;
  }
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(value)} Codex Credits`;
}

/**
 * USD for a sub-agent run cost. Sub-cent runs need three decimals to be
 * meaningful (e.g. `$0.047`), but we trim the thousandths digit when it
 * rounds to zero so `$0.05` doesn't read as `$0.050` (and `$0` as `$0.00`).
 * At ten cents and up, plain two-decimal cents.
 */
export function formatUsd(value: number): string {
  if (value >= 0.1) {
    return `$${value.toFixed(2)}`;
  }
  const precise = value.toFixed(3);
  return `$${precise.endsWith("0") ? value.toFixed(2) : precise}`;
}
