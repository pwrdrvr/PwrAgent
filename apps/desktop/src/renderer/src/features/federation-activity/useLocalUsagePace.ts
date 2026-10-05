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

/** Account identity is independent of changing limit readings. */
export function usagePaceAccountKey(backends: readonly BackendSummary[] | undefined): string {
  const account = backends?.find((backend) => backend.kind === "codex")?.account;
  return JSON.stringify([account?.type, account?.email ?? account?.label]);
}

/**
 * The last account read survives thread and rail-tab remounts. A changed
 * limit reading refreshes it without hiding the chart during the throttle.
 */
let readSequence = 0;
let shared: { read: UsageReader; accountKey: string; key: string; sequence: number; pace: LocalUsagePace } | undefined;

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
 * of changes collapses into one refresh per `MIN_REREAD`. First readings are
 * immediate. An in-flight answer is retained only for the same account.
 */
export function useLocalUsagePace(read: UsageReader | undefined, refreshKey: string, accountKey = "local"): LocalUsagePace | undefined {
  const cached = read && shared?.read === read && shared.accountKey === accountKey && shared.pace.account ? shared : undefined;
  // Limit changes can defer a reread, but must not erase the same account's
  // chart when a different thread mounts the rail during that minute.
  const [state, setState] = useState(() => ({ read, accountKey, pace: cached?.pace }));
  const source = useRef({ read, accountKey });
  source.current = { read, accountKey };
  const lastRead = useRef({ read, accountKey, at: cached?.pace.readAt ?? 0 });
  const pending = useRef<{ read: UsageReader; accountKey: string; runId: number } | undefined>(undefined);
  const latestRun = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!read) return;
    const cached = shared?.read === read && shared.accountKey === accountKey && shared.pace.account ? shared : undefined;
    if (lastRead.current.read !== read || lastRead.current.accountKey !== accountKey) {
      lastRead.current = { read, accountKey, at: cached?.pace.readAt ?? 0 };
    }
    if (cached) setState({ read, accountKey, pace: cached.pace });
    if (cached?.key === refreshKey && Date.now() - cached.pace.readAt < MIN_REREAD) {
      // Another mount already read these limits.
      return;
    }
    const run = async () => {
      const now = Date.now();
      const runId = ++latestRun.current;
      const sequence = ++readSequence;
      pending.current = { read, accountKey, runId };
      const sameSource = () => source.current.read === read && source.current.accountKey === accountKey;
      const current = () => mounted.current && sameSource() && runId === latestRun.current;
      lastRead.current = { read, accountKey, at: now };
      try {
        // A weekly window fits in eight days; a longer limit is read again
        // over its own window, as the Usage Activity window does.
        let from = now - 8 * DAY;
        let data = await read({ from, to: now });
        const known = seriesStart(sinceResetSeries(accountOf(data)));
        if (known !== undefined && known < from) {
          from = Math.max(known, now - MAX_WINDOW);
          data = await read({ from, to: now });
        }
        const account = accountOf(data);
        const windowStart = seriesStart(sinceResetSeries(account));
        const summary = summarizeUsageActivity(
          data.rows.map((row) => ({ ...row, owner: "local", target: LOCAL })),
          Math.max(windowStart ?? from, from),
          now,
        );
        const next = { readAt: now, account, windowStart,
          costMicros: summary.groups.reduce((total, group) => total + group.cost, 0) };
        if (runId === latestRun.current && sameSource() && (!shared || sequence > shared.sequence)) {
          shared = { read, accountKey, key: refreshKey, sequence, pace: next };
        }
        if (current()) setState({ read, accountKey, pace: next });
      } catch {
        // The card falls back to its plain link; a failed read is not news.
        if (current()) setState((previous) => ({ read, accountKey,
          pace: previous.read === read && previous.accountKey === accountKey ? previous.pace ?? { readAt: Date.now() } : { readAt: Date.now() },
        }));
      } finally {
        if (pending.current?.runId === runId) pending.current = undefined;
      }
    };
    // With no usable chart, a first reading is immediate. Throttling only
    // delays refreshes of a chart we can already show for this account.
    const hasPendingRead = pending.current?.read === read && pending.current.accountKey === accountKey;
    const timer = window.setTimeout(() => void run(), cached || hasPendingRead
      ? Math.max(0, lastRead.current.at + MIN_REREAD - Date.now()) : 0);
    // A scheduled read is superseded; one already in flight is not.
    return () => window.clearTimeout(timer);
  }, [read, refreshKey, accountKey]);
  return state.read === read && state.accountKey === accountKey ? state.pace : cached?.pace;
}
