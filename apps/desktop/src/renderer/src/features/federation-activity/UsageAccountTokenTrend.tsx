import { useRef, useState, type KeyboardEvent } from "react";
import { formatBackendPlanType } from "../../lib/backend-status-format";
import { usageProviderLabel } from "./usage-activity-accounts";
import { usageClock, usageCount } from "./usage-activity-presentation";
import type { OwnedUsageRow } from "./usage-activity-summary";
import {
  buildAccountTokenTrendView,
  utcDateMs,
  type AccountTokenAccount,
  type AccountTokenTrendDay,
  type AccountTokenTrendRange,
} from "./usage-account-tokens";

const RANGES: Array<{ value: AccountTokenTrendRange; label: string }> = [
  { value: "14d", label: "14d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
];

function formatUtcDay(dateStr: string): string {
  return new Date(utcDateMs(dateStr)).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

function formatUtcDayLong(dateStr: string): string {
  return new Date(utcDateMs(dateStr)).toLocaleDateString(undefined, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function nameList(names: readonly string[]): string {
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

function unavailableMessage(account: AccountTokenAccount): string {
  const provider = usageProviderLabel(account.provider);
  if (account.status === "auth_required") {
    return `${provider} account-wide token history requires a ChatGPT/Codex account sign-in (unavailable for API-key or signed-out sessions).`;
  }
  if (account.status === "unsupported") {
    return `${provider} account-wide token history is not supported by this Codex version.`;
  }
  return `${provider} account-wide token history is currently unavailable.`;
}

function dayTicks(days: readonly AccountTokenTrendDay[]): Array<{ index: number; text: string; edge?: "start" | "end" }> {
  if (days.length === 0) return [];
  if (days.length === 1) return [{ index: 0, text: formatUtcDay(days[0].date), edge: "start" }];
  const maxTicks = Math.min(6, days.length);
  const ticks: Array<{ index: number; text: string; edge?: "start" | "end" }> = [];
  for (let slot = 0; slot < maxTicks; slot += 1) {
    const index = Math.round(slot * (days.length - 1) / (maxTicks - 1));
    if (ticks.some((tick) => tick.index === index)) continue;
    ticks.push({
      index,
      text: formatUtcDay(days[index].date),
      ...(index === 0 ? { edge: "start" } : index === days.length - 1 ? { edge: "end" } : {}),
    });
  }
  return ticks;
}

export function UsageAccountTokenTrend({
  accounts,
  focusKey,
  onFocus,
  accountLabel,
  measuredRows,
  now,
  legacyOwnerLabels = [],
}: {
  accounts: AccountTokenAccount[];
  focusKey?: string;
  onFocus: (key: string) => void;
  accountLabel?: (account: AccountTokenAccount) => string | undefined;
  measuredRows: readonly OwnedUsageRow[];
  now: number;
  /** Online instances that returned Usage Activity without `accountTokenUsage` (older peers). */
  legacyOwnerLabels?: readonly string[];
}) {
  const [range, setRange] = useState<AccountTokenTrendRange>("30d");
  const [hovered, setHovered] = useState<number>();
  const [selected, setSelected] = useState<number>();
  const bars = useRef<Array<HTMLButtonElement | null>>([]);

  if (accounts.length === 0) return null;

  const focused = accounts.find((account) => account.key === focusKey) ?? accounts[0];
  const provider = usageProviderLabel(focused.provider);
  const displayName = accountLabel?.(focused)
    ?? `${provider}${focused.planType ? ` ${formatBackendPlanType({ kind: "codex" }, focused.planType)}` : ""} account`;

  const view = focused.status === "available"
    ? buildAccountTokenTrendView({ account: focused, range, now, measuredRows })
    : undefined;
  const maxTokens = Math.max(1, view?.rangePeakTokens ?? 0);
  const activeIndex = hovered ?? (selected !== undefined && view && selected < view.days.length ? selected : undefined);
  const activeDay = activeIndex !== undefined ? view?.days[activeIndex] : undefined;
  const ticks = view ? dayTicks(view.days) : [];
  const summary = focused.summary;

  const onBarKey = (event: KeyboardEvent, index: number) => {
    if (!view || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const last = view.days.length - 1;
    const next = event.key === "ArrowRight" ? Math.min(last, index + 1)
      : event.key === "ArrowLeft" ? Math.max(0, index - 1)
      : event.key === "Home" ? 0 : last;
    if (next === index) return;
    setHovered(next);
    if (selected !== undefined) setSelected(next);
    bars.current[next]?.focus();
  };

  const tabStop = activeIndex ?? Math.max(0, (view?.days.length ?? 1) - 1);

  return <section className="usage-account-tokens" aria-label="Account daily token trend">
    <div className="usage-account-tokens__head">
      <span className="usage-eyebrow">Account daily tokens</span>
      <span className="usage-account-tokens__scope">
        {provider} · all clients{focused.owners.length > 1 ? ` · deduplicated across ${nameList(focused.owners)}` : ""}
      </span>
      <span className="usage-account-tokens__spacer" />
      {focused.status === "available" && focused.dailyUsageBuckets.length > 0
        ? <div className="usage-segmented usage-timeline__dimension" role="group" aria-label="Account token trend range">
            {RANGES.map((item) => <button type="button" key={item.value} aria-pressed={range === item.value}
              onClick={() => { setRange(item.value); setSelected(undefined); setHovered(undefined); }}>{item.label}</button>)}
          </div>
        : null}
    </div>

    {accounts.length > 1 ? <div className="usage-account-tokens__accounts" role="group" aria-label="Accounts with token history">
      {accounts.map((account) => {
        const label = accountLabel?.(account)
          ?? `${usageProviderLabel(account.provider)}${account.planType
            ? ` ${formatBackendPlanType({ kind: "codex" }, account.planType)}` : ""} account`;
        return <button type="button" key={account.key} className="usage-account__name"
          aria-pressed={account.key === focused.key}
          onClick={() => { onFocus(account.key); setSelected(undefined); setHovered(undefined); }}>
          {label}<span>{account.owners.join(", ")}</span>
        </button>;
      })}
    </div> : null}

    {focused.status !== "available" ? <p className="usage-account-tokens__status" role="status">
      <strong>{displayName}:</strong> {unavailableMessage(focused)}
    </p> : view && view.days.length === 0 ? <p className="usage-account-tokens__status" role="status">
      <strong>{displayName}:</strong> No daily token buckets reported by {provider} yet.
      {summary?.lifetimeTokens !== undefined ? ` Lifetime reported: ${usageCount(summary.lifetimeTokens)} tokens.` : ""}
    </p> : view ? <>
      <div className="usage-account-tokens__metrics">
        <span><strong>{usageCount(view.rangeTotalTokens)}</strong> tokens across {view.reportedDays} reported {view.reportedDays === 1 ? "day" : "days"}</span>
        <span>Peak day <strong>{usageCount(summary?.peakDailyTokens ?? view.rangePeakTokens)}</strong></span>
        {summary?.lifetimeTokens !== undefined ? <span>Lifetime <strong>{usageCount(summary.lifetimeTokens)}</strong></span> : null}
        {summary?.currentStreakDays !== undefined
          ? <span>Streak <strong>{summary.currentStreakDays}d</strong>{summary.longestStreakDays !== undefined && summary.longestStreakDays > summary.currentStreakDays ? ` (best ${summary.longestStreakDays}d)` : ""}</span>
          : null}
        {view.rangeMeasuredTokens > 0
          ? <span className="usage-account-tokens__subset">PwrAgent measured (included above) <strong>{usageCount(view.rangeMeasuredTokens)}</strong></span>
          : null}
      </div>

      <div className="usage-account-tokens__frame">
        <div className="usage-account-tokens__axis-y" aria-hidden="true">
          <span>{usageCount(maxTokens)}</span>
          <span>0</span>
        </div>
        <div className="usage-account-tokens__plot" role="group" aria-label={`${displayName} daily token bars`}>
          {view.days.map((day, index) => {
            const omitted = day.accountTokens === undefined;
            const heightPercent = omitted ? 0 : Math.max(day.accountTokens! > 0 ? 3 : 0, day.accountTokens! / maxTokens * 100);
            const label = omitted
              ? `${formatUtcDayLong(day.date)} (UTC): Not reported by ${provider} (omitted, not zero)`
              : `${formatUtcDayLong(day.date)} (UTC): ${usageCount(day.accountTokens!)} account tokens${day.measuredTokens ? `, including ${usageCount(day.measuredTokens)} measured in PwrAgent` : ""}`;
            return <button key={day.date} type="button"
              ref={(element) => { bars.current[index] = element; }}
              tabIndex={index === tabStop ? 0 : -1}
              aria-label={label}
              aria-pressed={selected === index}
              className={`usage-account-tokens__bar${omitted ? " is-omitted" : ""}${selected === index ? " is-selected" : ""}`}
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(undefined)}
              onFocus={() => setHovered(index)}
              onBlur={() => setHovered(undefined)}
              onKeyDown={(event) => onBarKey(event, index)}
              onClick={() => setSelected(selected === index ? undefined : index)}>
              {omitted
                ? <span className="usage-account-tokens__gap" aria-hidden="true" />
                : <span className="usage-account-tokens__fill" style={{ height: `${heightPercent}%` }} aria-hidden="true" />}
            </button>;
          })}
        </div>
      </div>

      <div className="usage-account-tokens__axis" aria-hidden="true">
        <div className="usage-account-tokens__ticks">
          {ticks.map((tick) => <span key={tick.index}
            className={tick.edge === "start" ? "is-start" : tick.edge === "end" ? "is-end" : undefined}
            style={{ left: `${view.days.length > 1 ? tick.index / (view.days.length - 1) * 100 : 0}%` }}>{tick.text}</span>)}
        </div>
      </div>

      <p className="usage-account-tokens__readout">
        {activeDay
          ? activeDay.accountTokens === undefined
            ? `${formatUtcDayLong(activeDay.date)} (UTC) · Omitted by ${provider} (no bucket reported, not zero)${activeDay.measuredTokens ? ` · ${usageCount(activeDay.measuredTokens)} measured in PwrAgent (${activeDay.measuredTurns} ${activeDay.measuredTurns === 1 ? "turn" : "turns"})` : ""}`
            : `${formatUtcDayLong(activeDay.date)} (UTC) · ${activeDay.accountTokens.toLocaleString()} account tokens (all clients)${activeDay.measuredTokens ? ` · ${usageCount(activeDay.measuredTokens)} measured in PwrAgent (${activeDay.measuredTurns} ${activeDay.measuredTurns === 1 ? "turn" : "turns"}, included in account total)` : ""}`
          : `Provider-reported ${provider} account totals (UTC days, read from ${focused.observedBy} at ${usageClock(focused.observedAt)}). Not a quota percentage and not added to PwrAgent's per-thread ledger below.`}
      </p>

      <p className="usage-account-tokens__note">
        {view.latestDate
          ? view.includesToday
            ? `Through today (${formatUtcDay(view.latestDate)} UTC).`
            : `Through ${formatUtcDay(view.latestDate)} (UTC) — today is not yet reported by ${provider}.`
          : null}
        {view.omittedDays > 0
          ? ` ${view.omittedDays} omitted ${view.omittedDays === 1 ? "day" : "days"} shown as gaps, not zero.`
          : null}
        {legacyOwnerLabels.length > 0
          ? ` ${nameList(legacyOwnerLabels)} did not report account-wide token history (older PwrAgent version).`
          : null}
      </p>
    </> : null}
  </section>;
}
