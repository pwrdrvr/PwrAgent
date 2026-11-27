import type { BackendRateLimitSummary } from "../../../lib/backend-status-format";
import {
  limitSeriesFor,
  limitUsageDropped,
  sinceResetSeries,
  type LimitAccount,
  type LimitSeries,
} from "../../federation-activity/usage-limits";
import { describeLimitPace } from "../../federation-activity/usage-activity-presentation";

export type LimitRowPace = {
  series: LimitSeries;
  described: NonNullable<ReturnType<typeof describeLimitPace>>;
  /** Where the pace lands at the reset, capped at 100: "full" is 100. */
  projectedPercent: number;
  /** Whether the row says it in words, not only as the meter's hatching. */
  sentence: boolean;
};

/**
 * The pace a limit row shows, if its recorded history still describes the
 * reading on screen. The panel's limit rows and the Pricing card's rows both
 * read it here so they cannot disagree.
 */
export function limitRowPace(
  limit: BackendRateLimitSummary,
  usedPercent: number | undefined,
  account: LimitAccount | undefined,
  now: number,
): LimitRowPace | undefined {
  const series = limitSeriesFor(account, limit);
  const candidate = series && series.latest.usedPercent < 100 && usedPercent !== undefined && usedPercent < 100
    && !limitUsageDropped(series.latest.usedPercent, usedPercent) && series.latest.resetAt === limit.resetAt
    && (limit.resetAt === undefined || limit.resetAt > now)
    ? describeLimitPace(series, now, true)
    : undefined;
  // A cached series behind a live jump can project an end-of-window level
  // below what the row already shows; hide it until the read catches up.
  if (!series || !candidate
    || (candidate.projection.kind === "atReset" && candidate.projection.percent < usedPercent!)) {
    return undefined;
  }
  return {
    series,
    described: candidate,
    projectedPercent: candidate.projection.kind === "full" ? 100 : Math.min(100, candidate.projection.percent),
    // Each Antigravity pool is a separate allowance. Elsewhere, keep
    // the sentence for the main window and any window about to run out.
    sentence: candidate.short || series === sinceResetSeries(account) || account?.provider === "google",
  };
}
