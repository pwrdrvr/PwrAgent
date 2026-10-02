import { useEffect, useRef, useState } from "react";
import type { BackendSummary, FederationTarget, ReadUsageActivityRequest, ReadUsageActivityResponse } from "@pwragent/shared";
import { buildLimitAccounts, seriesStart, sinceResetSeries, type LimitAccount } from "./usage-limits";
import { summarizeUsageActivity } from "./usage-activity-summary";

const DAY = 86_400_000;
/** The longest window the Usage Activity window reads, and so the rail too. */
const MAX_WINDOW = 31 * DAY;
/** A rate-limit update arrives with every few turns; reread at most this often. */
const MIN_REREAD = 60_000;
const LOCAL: FederationTarget = { scope: "local" };

export type LocalUsagePace = {
  /** When the read finished: "now" for every pace and projection drawn from it. */
  readAt: number;
  /** The account's limits; absent until this instance has recorded a reading. */
  account?: LimitAccount;
  /** Start of the window the rail follows: the account's longest limit. */
  windowStart?: number;
  /** This instance's API-equivalent spend for turns contained in that window. */
  costMicros?: number;
};

type UsageReader = (request: ReadUsageActivityRequest) => Promise<ReadUsageActivityResponse>;

/**
 * Changes when Codex reports new account limits, which is when a turn has
 * added a reading worth rereading for. Whole percents, so a stream of
 * fractional updates is one change.
 */
export function usagePaceRefreshKey(backends: readonly BackendSummary[] | undefined): string {
  const codex = backends?.find((backend) => backend.kind === "codex");
  return JSON.stringify((codex?.rateLimits ?? []).map((limit) => [
    limit.windowKey ?? limit.name,
    typeof limit.usedPercent === "number" ? Math.round(limit.usedPercent) : null,
    limit.resetAt ?? null,
  ]));
}

const accountOf = (data: ReadUsageActivityResponse) => buildLimitAccounts([{
  owner: "local", current: data.limitObservation, history: data.limitHistory,
}])[0];

/**
 * This instance's account limits and spend since the limit window began, read
 * the way the Usage Activity window reads its local source. Limits are
 * account-wide, so the percent and pace match the federated window; the spend
 * is this instance's alone.
 *
 * Reads on mount and whenever `refreshKey` changes, never on a timer. A burst
 * of changes collapses into one read per `MIN_REREAD`.
 */
export function useLocalUsagePace(read: UsageReader | undefined, refreshKey: string): LocalUsagePace | undefined {
  const [pace, setPace] = useState<LocalUsagePace>();
  const lastReadAt = useRef(0);
  useEffect(() => {
    if (!read) return;
    let cancelled = false;
    const run = async () => {
      const now = Date.now();
      lastReadAt.current = now;
      // A weekly window fits in eight days; a longer limit is read again over
      // its own window, as the Usage Activity window does.
      let from = now - 8 * DAY;
      let data = await read({ from, to: now });
      const known = seriesStart(sinceResetSeries(accountOf(data)));
      if (known !== undefined && known < from) {
        from = Math.max(known, now - MAX_WINDOW);
        data = await read({ from, to: now });
      }
      if (cancelled) return;
      const account = accountOf(data);
      const windowStart = seriesStart(sinceResetSeries(account));
      const summary = summarizeUsageActivity(
        data.rows.map((row) => ({ ...row, owner: "local", target: LOCAL })),
        Math.max(windowStart ?? from, from),
        now,
      );
      setPace({ readAt: now, account, windowStart,
        costMicros: summary.groups.reduce((total, group) => total + group.cost, 0) });
    };
    const wait = Math.max(0, lastReadAt.current + MIN_REREAD - Date.now());
    const timer = window.setTimeout(() => {
      run().catch(() => {
        // The card falls back to its plain link; a failed read is not news.
        if (!cancelled) setPace((current) => current ?? { readAt: Date.now() });
      });
    }, wait);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [read, refreshKey]);
  return pace;
}
