import { limitLabel, type LimitAccount, type LimitSeries } from "./usage-limits";
import { formatBackendPlanType } from "../../lib/backend-status-format";
import { describeLimitPace, usageClock, usageCount, usageMoney, usagePercent as percent, usageWhen as when } from "./usage-activity-presentation";

function LimitMeter({ series, now }: { series: LimitSeries; now: number }) {
  const { latest } = series;
  const lastReset = series.resets.at(-1);
  const described = describeLimitPace(series, now);
  const pace = described
    ? <span className={`usage-pace${described.short ? " is-short" : ""}`}><span>{described.rate}</span>{" "}{described.text}</span>
    : null;
  return <div className="usage-limit">
    <span className="usage-eyebrow">{limitLabel(series)}</span>
    <div className="usage-limit__figure"><strong>{percent(latest.usedPercent)}<small>%</small></strong>
      <span>{latest.used !== undefined && latest.limit !== undefined
        ? `${usageCount(latest.used)} of ${usageCount(latest.limit)} used`
        : "used"}{latest.resetAt !== undefined ? ` · resets ${when(latest.resetAt, now)}` : ""}</span></div>
    <div className="usage-limit__meter" role="img" aria-label={`${limitLabel(series)} ${percent(latest.usedPercent)}% used`}>
      <i style={{ width: `${Math.min(100, Math.max(0, latest.usedPercent))}%` }} /></div>
    {pace}
    <div className="usage-limit__sub">
      {series.windowStart !== undefined ? <span>Window began <strong>{when(series.windowStart, now)}</strong></span> : null}
      {lastReset ? <span className={lastReset.kind === "unscheduled" ? "usage-limit__reset" : undefined}
        title={`Between ${new Date(lastReset.after).toLocaleString()} and ${new Date(lastReset.before).toLocaleString()}`}>
        {lastReset.kind === "unscheduled" ? "Unexpected reset" : "Reset"} seen {when(lastReset.at, now)}</span> : null}
    </div>
  </div>;
}

export function UsageLimitsBand({ accounts, accountLabel, focusKey, onFocus, cost, threads, turns, cacheShare, uncached, output, now }: {
  accounts: LimitAccount[];
  /** The account's name as the rest of the screen gives it. */
  accountLabel?: (account: LimitAccount) => string | undefined;
  focusKey?: string;
  onFocus: (key: string) => void;
  cost?: number;
  threads: number;
  turns: number;
  cacheShare: number;
  uncached: number;
  output: number;
  now: number;
}) {
  const newest = accounts[0];
  return <section className="usage-band" aria-label="Limits and cost">
    <div className="usage-band__accounts">
      {accounts.length === 0 ? <div className="usage-limit usage-limit--empty"><span className="usage-eyebrow">Account limits</span>
        <p>No limit readings from these instances yet. They appear after Codex reports account limits.</p></div> : null}
      {accounts.map((account) => <div key={account.key} className={`usage-account${account.key === focusKey && accounts.length > 1 ? " is-focused" : ""}`}>
        {accounts.length > 1 ? <button type="button" className="usage-account__name" aria-pressed={account.key === focusKey}
          onClick={() => onFocus(account.key)} title="Chart this account's limit">
          {accountLabel?.(account) ?? (account.planType ? `${formatBackendPlanType({ kind: "codex" }, account.planType)} account` : "Account")}<span>{account.owners.join(", ")}</span></button> : null}
        <div className="usage-account__limits">
          {account.series.map((series) => <LimitMeter key={series.key} series={series} now={now} />)}
          {account.credits ? <div className="usage-limit usage-limit--credits"><span className="usage-eyebrow">Credits</span>
            <strong>{account.credits.unlimited ? "Unlimited" : account.credits.hasCredits ? "Available" : account.credits.hasCredits === false ? "None" : "Unknown"}</strong></div> : null}
        </div>
      </div>)}
    </div>
    <div className="usage-band__cost">
      <span className="usage-eyebrow">API-equivalent · same window</span>
      <div className="usage-limit__figure"><strong>{cost === undefined ? "Unavailable" : usageMoney(cost)}</strong>
        <span>{threads} {threads === 1 ? "thread" : "threads"} · {turns} {turns === 1 ? "turn" : "turns"}</span></div>
      <div className="usage-limit__meter usage-limit__meter--cache" role="img" aria-label={`${Math.round(cacheShare * 100)}% of input cached`}>
        <i style={{ width: `${cacheShare * 100}%` }} /></div>
      <div className="usage-limit__sub"><span><strong>{Math.round(cacheShare * 100)}%</strong> of input cached</span>
        <span><strong>{usageCount(uncached)}</strong> uncached</span><span><strong>{usageCount(output)}</strong> output</span></div>
    </div>
    <p className="usage-band__note">{newest
      ? `Limits are the newest reading, from ${newest.observedBy} at ${usageClock(newest.observedAt)}. They include usage outside PwrAgent and are not split among threads. Dollars are list-price estimates for the turns contained in the window.`
      : "Dollars are list-price estimates for the turns contained in the window, not a subscription charge."}</p>
  </section>;
}
