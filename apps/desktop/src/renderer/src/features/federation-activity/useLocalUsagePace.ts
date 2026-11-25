import { useEffect, useRef, useState } from "react";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import {
  usageLimitProviderForBackend,
  type ReadUsageActivityRequest,
  type ReadUsageActivityResponse,
} from "@pwragent/shared/contracts/usage-activity";
import { formatUsedPercent } from "../../lib/backend-status-format";
import { buildLimitAccounts, limitProvider, limitSeriesFor, seriesStart, sinceResetSeries, type LimitAccount } from "./usage-limits";
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
  /** Each provider's current account limits on the instance. */
  accounts: ReadonlyMap<string, LimitAccount>;
  /** Start of the Codex window the Pricing card follows. */
  windowStart?: number;
  /** The read instance's API-equivalent spend for turns contained in that window. */
  costMicros?: number;
};

type UsageReader = (request: ReadUsageActivityRequest) => Promise<ReadUsageActivityResponse>;

/**
 * Changes when a provider reports new account limits. Quantize to the
 * precision the meter prints so small changes don't cause extra reads.
 */
export function usagePaceRefreshKey(backends: readonly BackendSummary[] | undefined): string {
  return JSON.stringify((backends ?? []).map((backend) => [
    backend.kind,
    (backend.rateLimits ?? []).map((limit) => [
      limit.windowKey, limit.limitId, limit.name,
      typeof limit.usedPercent === "number" ? formatUsedPercent(limit.usedPercent) : null,
      limit.resetAt, limit.windowMinutes,
    ]),
  ]));
}

/** Account identity is independent of changing limit readings. */
export function usagePaceAccountKey(backends: readonly BackendSummary[] | undefined): string {
  return JSON.stringify((backends ?? []).filter(({ kind }) => usageLimitProviderForBackend(kind)).map(({ kind, account }) =>
    [kind, account?.type, account?.accountId ?? account?.email ?? account?.label, account?.planType]));
}

/**
 * The last account read survives thread and rail-tab remounts. A changed
 * limit reading refreshes it without hiding the chart during the throttle.
 */
let readSequence = 0;
let shared: { read: UsageReader; accountKey: string; key: string; sequence: number; pace: LocalUsagePace } | undefined;

function accountsOf(data: ReadUsageActivityResponse): ReadonlyMap<string, LimitAccount> {
  const currentReadings = data.limitObservations ?? (data.limitObservation ? [data.limitObservation] : []);
  const history = [...data.limitHistory ?? [], ...data.providerLimitHistory ?? []];
  return new Map(currentReadings.map((current) => {
    const provider = limitProvider(current);
    // A current observation establishes the account. History may survive an
    // account or plan change and may include buckets the provider no longer reports.
    const [account] = buildLimitAccounts([{
      owner: "local",
      target: LOCAL,
      current,
      history: history.filter((observation) =>
        limitProvider(observation) === provider
        && observation.accountKey === current.accountKey
        && observation.observedAt <= current.observedAt),
    }]);
    return [provider, {
      ...account,
      planType: current.planType,
      series: account.series.filter((series) =>
        current.limits.some((limit) => limitSeriesFor(account, limit) === series)),
    }];
  }));
}

/**
 * One instance's account limits and spend since the limit window began, read
 * the way the Usage Activity window reads its local source. `read` picks the
 * instance: this one, or a remote thread's owner. Limits are account-wide, so
 * the percent and pace match the federated window; the spend is that
 * instance's alone.
 *
 * Reads on mount and whenever `refreshKey` changes, never on a timer. A burst
 * of changes collapses into one refresh per `MIN_REREAD`. First readings are
 * immediate. An in-flight answer is retained only for the same account.
 */
export function useLocalUsagePace(read: UsageReader | undefined, refreshKey: string, accountKey = "local"): LocalUsagePace | undefined {
  const cached = read && shared?.read === read && shared.accountKey === accountKey && shared.pace.accounts.size ? shared : undefined;
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
    const cached = shared?.read === read && shared.accountKey === accountKey && shared.pace.accounts.size ? shared : undefined;
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
        let accounts = accountsOf(data);
        const known = seriesStart(sinceResetSeries(accounts.get("openai")));
        if (known !== undefined && known < from) {
          from = Math.max(known, now - MAX_WINDOW);
          data = await read({ from, to: now });
          accounts = accountsOf(data);
        }
        const windowStart = seriesStart(sinceResetSeries(accounts.get("openai")));
        const summary = summarizeUsageActivity(
          data.rows.map((row) => ({ ...row, owner: "local", target: LOCAL })),
          Math.max(windowStart ?? from, from),
          now,
        );
        const next = { readAt: now, accounts, windowStart,
          costMicros: summary.groups.reduce((total, group) => total + group.cost, 0) };
        if (runId === latestRun.current && sameSource() && (!shared || sequence > shared.sequence)) {
          shared = { read, accountKey, key: refreshKey, sequence, pace: next };
        }
        if (current()) setState({ read, accountKey, pace: next });
      } catch {
        // The card falls back to its plain link; a failed read is not news.
        if (current()) setState((previous) => ({ read, accountKey,
          pace: previous.read === read && previous.accountKey === accountKey ? previous.pace : undefined,
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
