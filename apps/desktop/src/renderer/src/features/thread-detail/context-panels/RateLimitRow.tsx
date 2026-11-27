import { describeRateLimitRow, type BackendRateLimitSummary } from "../../../lib/backend-status-format";
import type { LimitAccount } from "../../federation-activity/usage-limits";
import { limitRowPace } from "./limit-pace";

/**
 * One limit as a `dt`/`dd` pair: the figure, its reset, and a meter. The
 * meter also shows where the pace lands when a usage history exists.
 */
export function RateLimitRow({ limit, now, account, labelTooltip }: {
  limit: BackendRateLimitSummary;
  now: number;
  account?: LimitAccount;
  /** Shown on the label, e.g. the provider's own name for a generic row. */
  labelTooltip?: string;
}) {
  const row = describeRateLimitRow(limit, now);
  const pace = limitRowPace(limit, row.usedPercent, account, now);
  const described = pace?.described;
  const used = row.usedPercent === undefined ? undefined : Math.min(100, Math.max(0, row.usedPercent));
  const projected = pace?.projectedPercent;
  return (
    <div>
      <dt>
        {labelTooltip
          ? <span className="tooltip-target" data-tooltip={labelTooltip}>{row.label}</span>
          : row.label}
      </dt>
      <dd>
        {row.figure ? <b className="backend-status-list__figure">{row.figure}</b> : null}
        {row.figure && row.text ? " " : null}
        {row.text}
        {row.reset ? <span className="backend-status-list__reset"> · {row.reset}</span> : null}
        {used !== undefined ? (
          <span className="backend-status-list__meter" aria-hidden="true">
            <i style={{ width: `${used}%` }} />
            {projected !== undefined && projected > used ? (
              <s
                className={described?.short ? "is-short" : undefined}
                style={{ left: `${used}%`, width: `${projected - used}%` }}
              />
            ) : null}
          </span>
        ) : null}
        {described && pace.sentence ? (
          <span className={`usage-pace backend-status-list__pace${described.short ? " is-short" : ""}`}>
            <span>{described.rate}</span>
            {" "}
            {described.text}
          </span>
        ) : null}
      </dd>
    </div>
  );
}
