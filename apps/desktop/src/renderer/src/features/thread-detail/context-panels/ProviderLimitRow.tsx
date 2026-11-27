import { Fragment, type ReactNode } from "react";
import { describeRateLimitRow } from "../../../lib/backend-status-format";
import type { RateLimitScopeGroup, ScopedRateLimit } from "../../../lib/rate-limit-scopes";
import type { LimitAccount } from "../../federation-activity/usage-limits";
import { limitPaceOutcome } from "../../federation-activity/usage-activity-presentation";
import { limitRowPace, type LimitRowPace } from "./limit-pace";

/**
 * A provider's limits as their own block under its facts: a scope subheader
 * when the provider has more than one allowance, then one row per window.
 * Every row shares the block's two columns, so each bar starts at the window
 * column's edge and runs to the panel's, the same in every row.
 */
export function ProviderLimitScopes({ scopes, children }: {
  scopes: readonly RateLimitScopeGroup[];
  /** The rows to draw for one scope. */
  children: (scope: RateLimitScopeGroup) => ReactNode;
}) {
  return (
    <div className="provider-limits">
      {scopes.map((scope) => (
        <Fragment key={scope.scope ?? ""}>
          {scope.scope !== null ? <div className="provider-limits__scope">{scope.scope}</div> : null}
          {children(scope)}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * One limit, labelled by its window alone: the figure and reset on the row
 * line, the meter under them, and the pace line, rate first.
 */
export function ProviderLimitRow({ entry, now, account, terse = false, pace: givenPace, warn = false }: {
  entry: ScopedRateLimit;
  now: number;
  account?: LimitAccount;
  /** The peek's shorter pace line, without the rate. */
  terse?: boolean;
  /** The pace, when the caller already read it. */
  pace?: LimitRowPace | null;
  /** Warn even when the pace does not run out before the reset. */
  warn?: boolean;
}) {
  const { limit } = entry;
  const row = describeRateLimitRow(limit, now);
  const pace = givenPace === undefined ? limitRowPace(limit, row.usedPercent, account, now) : givenPace ?? undefined;
  const used = row.usedPercent === undefined ? undefined : Math.min(100, Math.max(0, row.usedPercent));
  const projected = pace?.projectedPercent;
  const short = warn || (pace?.described.short ?? false);
  // A window name the fields and the name could not shorten ("Cloud session
  // credits") takes the row line, so the window column stays narrow.
  const window = entry.window.label;
  const long = entry.window.minutes === undefined && window.length > 10;
  return (
    <div className={`provider-limits__row${long ? " is-long" : ""}`} data-window={window}>
      <span className="provider-limits__window">{window}</span>
      <span className={`provider-limits__stat${short ? " is-short" : ""}`}>
        {row.figure ? <b className="backend-status-list__figure">{row.figure}</b> : null}
        {row.figure && row.text ? " " : null}
        {row.text}
        {row.reset ? <span className="backend-status-list__reset"> · {row.reset}</span> : null}
      </span>
      {used !== undefined ? (
        <span className={`backend-status-list__meter provider-limits__bar${used >= 100 ? " is-full" : ""}`} aria-hidden="true">
          <i style={{ width: `${used}%` }} />
          {projected !== undefined && projected > used ? (
            <s
              className={short ? "is-short" : undefined}
              style={{ left: `${used}%`, width: `${projected - used}%` }}
            />
          ) : null}
        </span>
      ) : null}
      {pace && pace.sentence ? (
        <span className={`usage-pace provider-limits__pace${short ? " is-short" : ""}`}>
          {terse ? null : <><span>{pace.described.rate}</span>{" "}</>}
          {limitPaceOutcome(pace.described.projection, pace.series.latest, now, terse)}
        </span>
      ) : null}
    </div>
  );
}
