import { describeRateLimitRow, type BackendRateLimitSummary } from "../../../lib/backend-status-format";
import { limitSeriesFor, sinceResetSeries } from "../../federation-activity/usage-limits";
import { describeLimitPace } from "../../federation-activity/usage-activity-presentation";
import type { LocalUsagePace } from "../../federation-activity/useLocalUsagePace";

/**
 * One limit as a `dt`/`dd` pair: the figure, its reset, and a meter. The
 * meter also shows where the pace lands when a usage history exists.
 */
export function RateLimitRow({ limit, now, pace, labelTooltip }: {
  limit: BackendRateLimitSummary;
  now: number;
  pace?: LocalUsagePace;
  /** Shown on the label, e.g. the provider's own name for a generic row. */
  labelTooltip?: string;
}) {
  const row = describeRateLimitRow(limit, now);
  const series = limitSeriesFor(pace?.account, limit);
  const described = series && pace && series.latest.usedPercent < 100
    ? describeLimitPace(series, pace.readAt, true)
    : undefined;
  // The meter always shows where the pace lands. The sentence is for the
  // window the Pricing card follows, and for any window about to run out.
  const sentence = described && (described.short || series === sinceResetSeries(pace?.account));
  const used = row.usedPercent === undefined ? undefined : Math.min(100, Math.max(0, row.usedPercent));
  const projected = described
    ? described.projection.kind === "full" ? 100 : Math.min(100, described.projection.percent)
    : undefined;
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
        {described && sentence ? (
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
