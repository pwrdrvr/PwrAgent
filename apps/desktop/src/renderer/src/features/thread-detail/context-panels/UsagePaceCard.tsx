import { memo, useId } from "react";
import type { BackendSummary } from "@pwragent/shared";
import { PopoutIcon } from "../../../icons";
import type { DesktopApi } from "../../../lib/desktop-api";
import { formatBackendLabel } from "../../../lib/backend-label";
import { formatBackendPlanType } from "../../../lib/backend-status-format";
import { limitLabel, sinceResetSeries, type LimitProjection, type LimitSeries } from "../../federation-activity/usage-limits";
import {
  describeLimitPace,
  usageCount,
  usageMoney,
  usagePercent,
  usageWhen,
} from "../../federation-activity/usage-activity-presentation";
import { useLocalUsagePace, usagePaceRefreshKey } from "../../federation-activity/useLocalUsagePace";

type UsagePaceCardProps = {
  desktopApi?: Pick<DesktopApi, "openUsageActivity" | "readUsageActivity">;
  backends?: BackendSummary[];
};

/** Chart box, in viewBox units; 100% sits `CAP` below the top edge. */
const WIDTH = 300;
const HEIGHT = 70;
const CAP = 6;

/**
 * The Pricing rail's way into Usage Activity: the account's longest limit,
 * charted from the window's start to its reset with the pace projected
 * forward. The whole card is the button. It reads only this instance, which
 * is exact for the limit (account-wide) and labeled for the spend (local).
 */
export const UsagePaceCard = memo(function UsagePaceCard({ desktopApi, backends }: UsagePaceCardProps) {
  const verdictId = useId();
  const pace = useLocalUsagePace(desktopApi?.readUsageActivity, usagePaceRefreshKey(backends));
  const open = desktopApi?.openUsageActivity;
  if (!open) return null;
  const series = sinceResetSeries(pace?.account);
  if (!pace || !series) {
    return (
      <button className="usage-pace-card" onClick={() => void open()} type="button">
        <span className="usage-pace-card__head">
          <span className="rail-summary-card__eyebrow">Usage Activity</span>
          <span className="usage-pace-card__go">Open <PopoutIcon size={10} aria-hidden="true" /></span>
        </span>
        <span className="usage-pace-card__sub">Limits, pace, and spend for every instance.</span>
      </button>
    );
  }

  const now = pace.readAt;
  const { latest } = series;
  const plan = pace.account?.planType ? ` ${formatBackendPlanType({ kind: "codex" }, pace.account.planType)}` : "";
  const exhausted = latest.usedPercent >= 100;
  const described = exhausted ? undefined : describeLimitPace(series, now, true);
  const tone = exhausted ? " is-out" : described?.short ? " is-short" : "";
  return (
    <button
      aria-describedby={verdictId}
      aria-label={`Open Usage Activity. ${limitLabel(series)} ${usagePercent(latest.usedPercent)}% used.`}
      className={`usage-pace-card${tone}`}
      onClick={() => void open()}
      type="button"
    >
      <span className="usage-pace-card__head">
        <span className="rail-summary-card__eyebrow">
          {limitLabel(series)} · {formatBackendLabel("codex", backends)}{plan}
        </span>
        <span className="usage-pace-card__go">Usage Activity <PopoutIcon size={10} aria-hidden="true" /></span>
      </span>
      <span className="usage-pace-card__figure">
        <strong>{usagePercent(latest.usedPercent)}<small>%</small></strong>
        <span>
          {latest.used !== undefined && latest.limit !== undefined
            ? `${usageCount(latest.used)} of ${usageCount(latest.limit)} used`
            : "used"}
        </span>
      </span>
      {pace.windowStart !== undefined && latest.resetAt !== undefined && latest.resetAt > pace.windowStart ? (
        <PaceSpark
          series={series}
          start={pace.windowStart}
          end={latest.resetAt}
          now={now}
          projection={described?.projection}
          short={described?.short ?? false}
        />
      ) : null}
      {/* The " " after the rate keeps it apart from the sentence in the
          card's accessible description; flex layout drops it on screen. */}
      <span className={`usage-pace usage-pace-card__verdict${tone}`} id={verdictId}>
        {exhausted
          ? `Limit reached. ${latest.resetAt !== undefined ? `Resets ${usageWhen(latest.resetAt, now, true)}.` : ""}`
          : described
            ? <><span>{described.rate}</span>{" "}{described.text}</>
            : latest.resetAt !== undefined ? `Resets ${usageWhen(latest.resetAt, now, true)}` : null}
      </span>
      {pace.costMicros !== undefined && pace.windowStart !== undefined ? (
        <span className="usage-pace-card__foot">
          <span>This machine <b>{usageMoney(pace.costMicros)}</b> API-eq.</span>
          <span>since {usageWhen(pace.windowStart, now, true)}</span>
        </span>
      ) : null}
    </button>
  );
});

function PaceSpark({ series, start, end, now, projection, short }: {
  series: LimitSeries;
  start: number;
  end: number;
  now: number;
  projection?: LimitProjection;
  short: boolean;
}) {
  const span = end - start;
  const share = (at: number) => Math.min(1, Math.max(0, (at - start) / span));
  const x = (at: number) => (share(at) * WIDTH).toFixed(1);
  const y = (percent: number) => (CAP + (1 - Math.min(100, Math.max(0, percent)) / 100) * (HEIGHT - CAP)).toFixed(1);
  const top = (percent: number) => `${(Number(y(percent)) / HEIGHT) * 100}%`;
  const left = (at: number) => `${share(at) * 100}%`;
  // Usage is zero where the window began, before the first reading in it.
  const points = series.points.filter((point) => point.at >= start);
  if (!points.length || points[0].at > start) points.unshift({ at: start, usedPercent: 0 });
  const line = points.map((point, index) => `${index ? "L" : "M"}${x(point.at)},${y(point.usedPercent)}`).join(" ");
  const { latest } = series;
  const target = projection?.kind === "full"
    ? { at: Math.min(projection.at, end), percent: projection.at <= end ? 100 : latest.usedPercent }
    : projection?.kind === "atReset" ? { at: end, percent: projection.percent } : undefined;
  return (
    <span className="usage-pace-card__chart" aria-hidden="true">
      <span className="usage-pace-card__spark">
        <span className="usage-pace-card__future" style={{ left: left(now) }} />
        <span className="usage-pace-card__cap" />
        <span className="usage-pace-card__now" style={{ left: left(now) }} />
        <span className="usage-pace-card__reset" />
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none">
          <path className="usage-pace-card__area" d={`${line} L${x(latest.at)},${HEIGHT} L0,${HEIGHT} Z`} />
          <path className="usage-pace-card__line" d={line} />
          {target ? (
            <path
              className="usage-pace-card__projection"
              d={`M${x(latest.at)},${y(latest.usedPercent)} L${x(target.at)},${y(target.percent)}`}
            />
          ) : null}
        </svg>
        <span className="usage-pace-card__point" style={{ left: left(latest.at), top: top(latest.usedPercent) }} />
        {short && projection?.kind === "full" ? (
          <>
            <span className="usage-pace-card__hit" style={{ left: left(projection.at), top: top(100) }} />
            <span
              className={`usage-pace-card__hit-label${share(projection.at) < 0.4 ? " is-start" : ""}`}
              style={{ left: left(projection.at) }}
            >
              100% {usageWhen(projection.at, now, true)}
            </span>
          </>
        ) : null}
      </span>
      <span className="usage-pace-card__axis">
        <span>{usageWhen(start, now, true)}</span>
        {/* Too close to either end, "Now" would sit on that end's label. */}
        {share(now) > 0.2 && share(now) < 0.75 ? (
          <span className="usage-pace-card__axis-now" style={{ left: left(now) }}>Now</span>
        ) : null}
        <span>Resets {usageWhen(end, now, true)}</span>
      </span>
    </span>
  );
}
