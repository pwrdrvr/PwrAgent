import { useState } from "react";
import { usageClock, usageMoney, type usageCompletionBuckets } from "./usage-activity-presentation";

export function UsageTimeline({ buckets, selected, onSelect }: {
  buckets: ReturnType<typeof usageCompletionBuckets>;
  selected?: number;
  onSelect: (index: number | undefined) => void;
}) {
  const [hovered, setHovered] = useState<number>();
  const max = Math.max(1, ...buckets.map((bucket) => bucket.cost));
  const active = buckets[hovered ?? selected ?? -1];
  const label = (at: number) => buckets.at(-1)!.to - buckets[0].from > 86_400_000
    ? new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : usageClock(at);
  return <figure className="usage-timeline">
    <figcaption><span className="usage-eyebrow">Turn completions</span><span>Whole-turn cost at completion</span></figcaption>
    <div className="usage-timeline__plot" role="group" aria-label="Filter threads by completion time">
      {buckets.map((bucket, index) => <button key={index} type="button" aria-pressed={selected === index}
        aria-label={`${new Date(bucket.from).toLocaleString()} to ${new Date(bucket.to).toLocaleString()}: ${usageMoney(bucket.cost)}, ${bucket.rows} completed intervals`}
        className={`usage-timeline__bar${selected === index ? " is-selected" : ""}`}
        onMouseEnter={() => setHovered(index)} onMouseLeave={() => setHovered(undefined)}
        onFocus={() => setHovered(index)} onBlur={() => setHovered(undefined)}
        onClick={() => onSelect(selected === index ? undefined : index)}>
        <span style={{ height: `${bucket.cost / max * 100}%` }} />
      </button>)}
    </div>
    <div className="usage-timeline__axis"><span>{label(buckets[0].from)}</span><span>{label(buckets[12].from)}</span><span>{label(buckets.at(-1)!.to)}</span></div>
    <p className="usage-timeline__readout">{active
      ? `${usageMoney(active.cost)} · ${active.rows} completed intervals · ${usageClock(active.from)}–${usageClock(active.to)}`
      : "Select an interval to inspect its threads"}</p>
  </figure>;
}
