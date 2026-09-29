import { useState } from "react";
import { usageClock, usageMoney, type UsageBucket } from "./usage-activity-presentation";
import type { LimitPoint, LimitReset } from "./usage-limits";

export type UsageChartLimit = { label: string; points: LimitPoint[]; resets: LimitReset[] };

/**
 * Split observed readings at resets so the line never draws a fall that was
 * really a restart, and keep only what lies inside the window.
 */
function limitSegments(limit: UsageChartLimit, from: number, to: number) {
  const segments: LimitPoint[][] = [[]];
  for (const point of limit.points) {
    if (limit.resets.some((reset) => reset.before === point.at)) segments.push([]);
    if (point.at >= from && point.at <= to) segments.at(-1)!.push(point);
  }
  return segments.filter((segment) => segment.length > 0);
}

export function UsageTimeline({ buckets, series, limit, selected, onSelect }: {
  buckets: UsageBucket[];
  /** Titles of the stacked threads, in series order. */
  series: string[];
  limit?: UsageChartLimit;
  selected?: number;
  onSelect: (index: number | undefined) => void;
}) {
  const [hovered, setHovered] = useState<number>();
  const from = buckets[0].from;
  const to = buckets.at(-1)!.to;
  const max = Math.max(1, ...buckets.map((bucket) => bucket.cost));
  const active = buckets[hovered ?? selected ?? -1];
  const label = (at: number) => to - from > 86_400_000
    ? new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : usageClock(at);
  const segments = limit ? limitSegments(limit, from, to) : [];
  const peak = Math.max(0, ...segments.flat().map((point) => point.usedPercent));
  const scale = Math.min(100, Math.max(10, Math.ceil(peak / 10) * 10));
  const x = (at: number) => (at - from) / (to - from) * 100;
  const y = (value: number) => 100 - value / scale * 100;
  const resets = limit?.resets.filter((reset) => reset.at >= from && reset.at <= to) ?? [];
  return <figure className="usage-timeline">
    <figcaption className="usage-timeline__head">
      <span className="usage-eyebrow">Spend by thread</span>
      <span>API-equivalent, each turn placed at its completion</span>
      <span className="usage-timeline__spacer" />
      {segments.length ? <span className="usage-timeline__key"><i className="usage-timeline__key-line" />{limit!.label} used, observed</span> : null}
    </figcaption>
    <div className="usage-timeline__frame">
      <div className="usage-timeline__axis-y" aria-hidden="true"><span>{usageMoney(max)}</span><span>{usageMoney(0)}</span></div>
      <div className="usage-timeline__plot">
        <div className="usage-timeline__bars" role="group" aria-label="Filter threads by completion time">
          {buckets.map((bucket, index) => <button key={index} type="button" aria-pressed={selected === index}
            aria-label={`${new Date(bucket.from).toLocaleString()} to ${new Date(bucket.to).toLocaleString()}: ${usageMoney(bucket.cost)}, ${bucket.rows} completed turns`}
            className={`usage-timeline__bar${selected === index ? " is-selected" : ""}`}
            onMouseEnter={() => setHovered(index)} onMouseLeave={() => setHovered(undefined)}
            onFocus={() => setHovered(index)} onBlur={() => setHovered(undefined)}
            onClick={() => onSelect(selected === index ? undefined : index)}>
            <span className="usage-timeline__stack" style={{ height: `${bucket.cost / max * 100}%` }}>
              {bucket.other > 0 ? <i className="usage-series--other" style={{ flexGrow: bucket.other }} /> : null}
              {bucket.series.map((cost, seriesIndex) => cost > 0
                ? <i key={seriesIndex} className={`usage-series--${seriesIndex}`} style={{ flexGrow: cost }} /> : null)}
            </span>
          </button>)}
        </div>
        {segments.length ? <svg className="usage-timeline__line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {segments.map((segment, index) => <polyline key={index} vectorEffect="non-scaling-stroke"
            points={segment.map((point) => `${x(point.at).toFixed(2)},${y(point.usedPercent).toFixed(2)}`).join(" ")} />)}
        </svg> : null}
        {resets.map((reset) => <span key={reset.at} className={`usage-timeline__reset${reset.kind === "unscheduled" ? " is-unscheduled" : ""}`}
          style={{ left: `${x(reset.at)}%` }} title={`${reset.kind === "unscheduled" ? "Unexpected reset, first seen" : "Scheduled reset"} ${new Date(reset.at).toLocaleString()}`}>
          <span>Reset</span></span>)}
      </div>
      <div className="usage-timeline__axis-y usage-timeline__axis-y--right" aria-hidden="true">
        {segments.length ? <><span>{scale}%</span><span>0%</span></> : null}</div>
    </div>
    <div className="usage-timeline__axis"><span>{label(from)}</span><span>{label(buckets[12].from)}</span><span>{label(to)}</span></div>
    <div className="usage-timeline__legend">
      {series.map((title, index) => <span key={index} className="usage-timeline__legend-item"><i className={`usage-series--${index}`} />{title}</span>)}
      {buckets.some((bucket) => bucket.other > 0) ? <span className="usage-timeline__legend-item"><i className="usage-series--other" />Other threads</span> : null}
    </div>
    <p className="usage-timeline__readout">{active
      ? `${usageMoney(active.cost)} · ${active.rows} completed turns · ${usageClock(active.from)}–${usageClock(active.to)}`
      : "Select a bar to list the threads that completed turns in it"}</p>
  </figure>;
}
