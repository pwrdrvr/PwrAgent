import type { CSSProperties } from "react";
import { usageMoney, type UsageBucket, type UsageBucketMember } from "./usage-activity-presentation";

/** A thread, model, provider or instance as the chart names it, with what clicking its name does. */
export type UsageChartMember = {
  title: string; onOpen?: () => void; onFilter?: () => void; filtered?: boolean;
  /** Tooltips for a filter whose reach is wider than the thread list. */
  filterTitle?: string; clearTitle?: string;
};
/** A segment of a bar: a series index, or the Other segment. */
export type UsageSliceSegment = number | "other";

const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;

/**
 * What is in one bar: its time, total and turns, then a row per segment in
 * stack order, top to bottom. Hovered, Other is one counted row; pinned, it
 * lists its members and each name opens its thread or toggles its filter.
 */
export function UsageSliceCard({ id, bucket, label, noun, pinned, hot, onHot, member, onUnpin, style }: {
  id: string;
  bucket: UsageBucket;
  label: string;
  /** The dimension in the singular: "thread", "model", … */
  noun: string;
  pinned: boolean;
  hot?: UsageSliceSegment;
  onHot: (segment: UsageSliceSegment | undefined) => void;
  member: (key: string) => UsageChartMember;
  onUnpin: () => void;
  style: CSSProperties;
}) {
  // The stack draws Other at the baseline and series 0 just above it, so the
  // highest series is the top segment.
  const charted = bucket.members.filter((item) => item.series !== undefined).sort((a, b) => b.series! - a.series!);
  const others = bucket.members.filter((item) => item.series === undefined);
  const detail = (item: UsageBucketMember, title: string) => item.threads > 1
    ? `${count(item.threads, "thread")} · ${count(item.rows, "turn")}`
    : [count(item.rows, "turn"), ...item.owners.filter((owner) => owner !== title)].join(" · ");
  const row = (item: UsageBucketMember) => {
    const segment = item.series ?? "other";
    const named = member(item.key);
    const action = pinned ? named.onOpen ?? named.onFilter : undefined;
    return <li key={item.key} className={`usage-slice-card__row${hot === segment ? " is-hot" : ""}`}
      onMouseEnter={() => onHot(segment)} onMouseLeave={() => onHot(undefined)}>
      <i className={`usage-series--${segment}`} aria-hidden="true" />
      <span className="usage-slice-card__name">
        {action
          ? <button type="button" className="usage-slice-card__action" onClick={action}
            aria-label={named.onOpen ? `Open ${named.title}` : undefined}
            aria-pressed={named.onOpen ? undefined : named.filtered ?? false}>{named.title}{named.onOpen ? " ↗" : null}</button>
          : <span className="usage-slice-card__title">{named.title}</span>}
        <small>{detail(item, named.title)}</small></span>
      <b>{usageMoney(item.cost)}</b>
    </li>;
  };
  return <div id={id} className={`usage-slice-card${pinned ? " is-pinned" : ""}`} style={style}
    role={pinned ? "group" : undefined} aria-label={pinned ? `${label} slice` : undefined}>
    <div className="usage-slice-card__head"><span>{label}</span><strong>{usageMoney(bucket.cost)}</strong></div>
    <p className="usage-slice-card__sub">{bucket.rows
      ? `${count(bucket.rows, "completed turn")} · ${count(bucket.members.length, noun)}`
      : "No completed turns"}</p>
    {bucket.members.length ? <ul className="usage-slice-card__rows">
      {charted.map(row)}
      {pinned ? others.map(row) : others.length ? <li className={`usage-slice-card__row is-other${hot === "other" ? " is-hot" : ""}`}
        onMouseEnter={() => onHot("other")} onMouseLeave={() => onHot(undefined)}>
        <i className="usage-series--other" aria-hidden="true" />
        <span className="usage-slice-card__name"><span className="usage-slice-card__title">{count(others.length, `other ${noun}`)}</span>
          <small>{count(others.reduce((total, item) => total + item.rows, 0), "turn")}</small></span>
        <b>{usageMoney(bucket.other)}</b>
      </li> : null}
    </ul> : null}
    <div className="usage-slice-card__foot">{pinned
      ? <><kbd>←</kbd><kbd>→</kbd><span>slices</span><span className="usage-slice-card__spacer" />
        <button type="button" className="usage-link" aria-label="Unpin slice" onClick={onUnpin}>Clear</button></>
      : <span>Click to pin and filter</span>}</div>
  </div>;
}
