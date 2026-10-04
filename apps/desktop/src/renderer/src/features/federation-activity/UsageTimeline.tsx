import { useId, useRef, useState, type KeyboardEvent } from "react";
import { usageBucketLabel, usageMoney, type UsageBucket, type UsageDimension } from "./usage-activity-presentation";
import type { LimitPoint, LimitReset } from "./usage-limits";
import { UsageSliceCard, type UsageChartMember, type UsageSliceSegment } from "./UsageSliceCard";

export type { UsageChartMember } from "./UsageSliceCard";

export type UsageChartLimit = { label: string; points: LimitPoint[]; resets: LimitReset[] };
/**
 * A stacked series: a thread, which can open in the main window, or a model,
 * provider, account or instance, which can filter the view.
 */
export type UsageChartSeries = UsageChartMember & { cost: string };

const DIMENSION_NAMES: Record<UsageDimension, string> = { thread: "Thread", model: "Model", provider: "Provider", account: "Account", instance: "Instance" };
/**
 * The current pace carried forward from the newest reading to the limit's
 * reset, or to 100% when it gets there first. The chart extends past now to
 * the reset to show it.
 */
export type UsageChartForecast = {
  start: { at: number; percent: number };
  end: { at: number; percent: number };
  resetAt: number;
  /** When the limit reaches 100% before the reset. */
  fullAt?: number;
};

const HOUR = 3_600_000;

/**
 * Axis labels on clock boundaries between `from` and `end`: midnights for a
 * window of days, every 1–12 hours otherwise, at most about seven.
 */
function clockTicks(from: number, end: number): Array<{ at: number; text: string }> {
  const span = end - from;
  const ticks: Array<{ at: number; text: string }> = [];
  const cursor = new Date(from);
  if (span > 36 * HOUR) {
    const every = Math.max(1, Math.ceil(span / (24 * HOUR) / 7));
    cursor.setHours(0, 0, 0, 0);
    for (cursor.setDate(cursor.getDate() + 1); cursor.getTime() < end; cursor.setDate(cursor.getDate() + every)) {
      ticks.push({ at: cursor.getTime(), text: cursor.toLocaleDateString(undefined, { month: "short", day: "numeric" }) });
    }
    return ticks;
  }
  const every = [1, 2, 3, 6, 12].find((hours) => span / (hours * HOUR) <= 7) ?? 12;
  cursor.setMinutes(0, 0, 0);
  cursor.setHours(Math.ceil((cursor.getHours() + (cursor.getTime() < from ? 1 : 0)) / every) * every);
  for (; cursor.getTime() < end; cursor.setHours(cursor.getHours() + every)) {
    ticks.push({ at: cursor.getTime(), text: cursor.getHours() === 0
      ? cursor.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : cursor.toLocaleTimeString(undefined, { hour: "numeric" }) });
  }
  return ticks;
}

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

export function UsageTimeline({ buckets, series, member, limit, forecast, selected, onSelect, dimension, dimensions, onDimension }: {
  buckets: UsageBucket[];
  /** The stacked threads, in series order. */
  series: UsageChartSeries[];
  /** Names a bucket member by its key, charted or Other, for the slice card. */
  member: (key: string) => UsageChartMember;
  limit?: UsageChartLimit;
  forecast?: UsageChartForecast;
  selected?: number;
  onSelect: (index: number | undefined) => void;
  dimension: UsageDimension;
  dimensions: UsageDimension[];
  onDimension: (dimension: UsageDimension) => void;
}) {
  const [hovered, setHovered] = useState<number>();
  // The segment under the pointer, in the bar or in the card.
  const [hot, setHot] = useState<{ index: number; segment: UsageSliceSegment }>();
  // The bars are one Tab stop; the arrows move between them.
  const [cursor, setCursor] = useState<number>();
  const bars = useRef<Array<HTMLButtonElement | null>>([]);
  const cardId = useId();
  const from = buckets[0].from;
  const to = buckets.at(-1)!.to;
  const max = Math.max(1, ...buckets.map((bucket) => bucket.cost));
  const active = buckets[hovered ?? selected ?? -1];
  const moment = (at: number) => new Date(at).toLocaleString(undefined,
    new Date(at).toDateString() === new Date(to).toDateString() ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric" });
  const segments = limit ? limitSegments(limit, from, to) : [];
  const ahead = forecast && forecast.resetAt > to ? forecast : undefined;
  // The future takes at most 40% of the width, so the bars stay wide enough
  // to select; an outcome past that edge is labelled there instead.
  const end = ahead ? Math.min(ahead.resetAt, to + (to - from) * 2 / 3) : to;
  const clipped = ahead !== undefined && ahead.end.at > end;
  const landing = ahead && clipped
    ? { at: end, percent: ahead.start.percent + (ahead.end.percent - ahead.start.percent) * (end - ahead.start.at) / (ahead.end.at - ahead.start.at) }
    : ahead?.end;
  const peak = Math.max(0, ...segments.flat().map((point) => point.usedPercent), landing?.percent ?? 0);
  const scale = Math.min(100, Math.max(10, Math.ceil(peak / 10) * 10));
  const x = (at: number) => (at - from) / (end - from) * 100;
  const y = (value: number) => 100 - value / scale * 100;
  const resets = limit?.resets.filter((reset) => reset.at >= from && reset.at <= to) ?? [];
  // Clock ticks, clear of Now and the reset so their labels never collide.
  const near = (a: number, b: number) => Math.abs(x(a) - x(b)) < 7;
  const ticks = [
    ...clockTicks(from, end).filter((tick) => !near(tick.at, from) && !(ahead && (near(tick.at, to) || near(tick.at, end))) && !near(tick.at, end))
      .map((tick) => ({ ...tick, edge: false })),
    ...ahead ? [{ at: to, text: "Now", edge: false }] : [],
    ...ahead && end === ahead.resetAt ? [{ at: end, text: `Resets ${moment(end)}`, edge: true }] : [],
  ];
  // A pinned slice keeps its card. Otherwise the card follows the pointer or
  // keyboard focus onto any bar with turns in it.
  const shown = selected ?? (hovered !== undefined && buckets[hovered]?.rows ? hovered : undefined);
  const shownBucket = shown === undefined ? undefined : buckets[shown];
  const hotSegment = hot && hot.index === shown ? hot.segment : undefined;
  const filled = buckets.flatMap((bucket, index) => bucket.rows ? [index] : []);
  // A refresh can redraw the window with fewer bars than an index held.
  const inRange = (index: number | undefined) => index !== undefined && index < buckets.length ? index : undefined;
  const stop = inRange(selected) ?? inRange(cursor) ?? filled.at(-1) ?? buckets.length - 1;
  const focusBar = (index: number) => bars.current[index]?.focus();
  // Unpinning removes the card and the chip, so focus that was on either
  // returns to the bar.
  const unpin = (refocus: boolean) => {
    const pinned = selected;
    onSelect(undefined);
    // A card row that unmounts under the pointer never reports leaving it.
    setHot(undefined);
    if (refocus && pinned !== undefined) focusBar(pinned);
  };
  const onBarKey = (event: KeyboardEvent, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    // Empty slices hold nothing to read, so the arrows pass over them.
    const next = event.key === "ArrowRight" ? filled.find((item) => item > index)
      : event.key === "ArrowLeft" ? [...filled].reverse().find((item) => item < index)
      : event.key === "Home" ? filled[0] : filled.at(-1);
    if (next === undefined || next === index) return;
    if (selected !== undefined) onSelect(next);
    focusBar(next);
  };
  const onChartKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || selected === undefined || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    unpin(event.target instanceof Element && event.target.closest(".usage-slice-card, .usage-chip") !== null);
  };
  // The card sits beside its bar, on whichever side has more room. A bar's
  // edge is its span's share of the bars' width less their gaps, plus the
  // gaps before it, so the card lines up with the bar flex actually drew.
  const share = ahead ? x(to) / 100 : 1;
  const edge = (index: number, at: number) => {
    const before = (at - from) / (to - from);
    return `${(share * before * 100).toFixed(3)}% + ${(index - (buckets.length - 1) * before).toFixed(3)} * var(--usage-bar-gap)`;
  };
  const cardStyle = shown === undefined || !shownBucket ? {}
    : share * ((shownBucket.from + shownBucket.to) / 2 - from) / (to - from) <= 0.5
      ? { left: `calc(${edge(shown, shownBucket.to)} + 8px)` }
      : { right: `calc(100% - (${edge(shown, shownBucket.from)}) + 8px)` };
  return <figure className="usage-timeline" onKeyDown={onChartKey}>
    <figcaption className="usage-timeline__head">
      <span className="usage-eyebrow">Spend by</span>
      <span className="usage-segmented usage-timeline__dimension" role="group" aria-label="Spend by">
        {dimensions.map((item) => <button type="button" key={item} aria-pressed={dimension === item}
          onClick={() => onDimension(item)}>{DIMENSION_NAMES[item]}</button>)}</span>
      <span>API-equivalent, each turn placed at its completion</span>
      <span className="usage-timeline__spacer" />
      {selected !== undefined && buckets[selected] ? <button type="button" className="usage-chip" aria-label={`Unpin ${usageBucketLabel(buckets[selected], to)}`}
        onClick={() => unpin(true)}>{usageBucketLabel(buckets[selected], to)}<span aria-hidden="true">×</span></button> : null}
      {segments.length ? <span className="usage-timeline__key"><i className="usage-timeline__key-line" />{limit!.label} used, observed</span> : null}
      {ahead ? <span className="usage-timeline__key"><i className={`usage-timeline__key-line is-forecast${ahead.fullAt ? " is-short" : ""}`} />At this pace</span> : null}
    </figcaption>
    <div className="usage-timeline__frame">
      <div className="usage-timeline__axis-y" aria-hidden="true"><span>{usageMoney(max)}</span><span>{usageMoney(0)}</span></div>
      <div className="usage-timeline__plot">
        <div className={`usage-timeline__bars${selected === undefined && shown !== undefined ? " is-dimmed" : ""}`}
          role="group" aria-label="Filter threads by completion time"
          style={ahead ? { width: `${x(to)}%` } : undefined}>
          {buckets.map((bucket, index) => <button key={index} type="button" aria-pressed={selected === index}
            ref={(element) => { bars.current[index] = element; }} tabIndex={index === stop ? 0 : -1}
            aria-label={`${usageBucketLabel(bucket, to)}: ${usageMoney(bucket.cost)}, ${bucket.rows} completed turns`}
            aria-describedby={shown === index ? cardId : undefined}
            className={`usage-timeline__bar${selected === index ? " is-selected" : ""}${shown === index ? " is-shown" : ""}`}
            style={{ flexGrow: bucket.to - bucket.from }}
            onMouseEnter={() => setHovered(index)} onMouseLeave={() => { setHovered(undefined); setHot(undefined); }}
            onFocus={() => { setHovered(index); setCursor(index); }} onBlur={() => setHovered(undefined)}
            onKeyDown={(event) => onBarKey(event, index)}
            onClick={() => onSelect(selected === index ? undefined : index)}>
            <span className="usage-timeline__stack" style={{ height: `${bucket.cost / max * 100}%` }}>
              {bucket.other > 0 ? <i className={`usage-series--other${shown === index && hotSegment === "other" ? " is-hot" : ""}`}
                style={{ flexGrow: bucket.other }} onMouseEnter={() => setHot({ index, segment: "other" })} onMouseLeave={() => setHot(undefined)} /> : null}
              {bucket.series.map((cost, seriesIndex) => cost > 0
                ? <i key={seriesIndex} className={`usage-series--${seriesIndex}${shown === index && hotSegment === seriesIndex ? " is-hot" : ""}`}
                  style={{ flexGrow: cost }} onMouseEnter={() => setHot({ index, segment: seriesIndex })} onMouseLeave={() => setHot(undefined)} /> : null)}
            </span>
          </button>)}
        </div>
        {shownBucket ? <UsageSliceCard id={cardId} bucket={shownBucket} label={usageBucketLabel(shownBucket, to)}
          noun={DIMENSION_NAMES[dimension].toLocaleLowerCase()} pinned={selected !== undefined} hot={hotSegment}
          onHot={(segment) => setHot(segment === undefined ? undefined : { index: shown!, segment })}
          member={member} onUnpin={() => unpin(true)} style={cardStyle} /> : null}
        {ahead ? <div className="usage-timeline__future" style={{ left: `${x(to)}%` }} aria-hidden="true" /> : null}
        {segments.length || ahead ? <svg className="usage-timeline__line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {segments.map((segment, index) => <polyline key={index} vectorEffect="non-scaling-stroke"
            points={segment.map((point) => `${x(point.at).toFixed(2)},${y(point.usedPercent).toFixed(2)}`).join(" ")} />)}
          {ahead ? <polyline className={`is-forecast${ahead.fullAt ? " is-short" : ""}`} vectorEffect="non-scaling-stroke"
            points={[ahead.start, landing!].map((point) => `${x(point.at).toFixed(2)},${y(point.percent).toFixed(2)}`).join(" ")} /> : null}
        </svg> : null}
        {ahead?.fullAt && !clipped ? <span className="usage-timeline__full" style={{ left: `${x(ahead.fullAt)}%` }}>
          <span>100% {moment(ahead.fullAt)}</span></span> : null}
        {ahead && clipped ? <span className={`usage-timeline__outcome${ahead.fullAt ? " is-short" : ""}`}>
          {ahead.fullAt ? `100% ${moment(ahead.fullAt)} →` : `${Math.round(ahead.end.percent)}% at the ${moment(ahead.resetAt)} reset →`}</span> : null}
        {resets.map((reset) => <span key={reset.at} className={`usage-timeline__reset${reset.kind === "unscheduled" ? " is-unscheduled" : ""}`}
          style={{ left: `${x(reset.at)}%` }} title={`${reset.kind === "unscheduled" ? "Unexpected reset, first seen" : "Scheduled reset"} ${new Date(reset.at).toLocaleString()}`}>
          <span>Reset</span></span>)}
      </div>
      <div className="usage-timeline__axis-y usage-timeline__axis-y--right" aria-hidden="true">
        {segments.length ? <><span>{scale}%</span><span>0%</span></> : null}</div>
    </div>
    <div className="usage-timeline__axis"><div className="usage-timeline__ticks">
      {ticks.map((tick) => <span key={tick.at} className={tick.edge ? "is-end" : undefined} style={{ left: `${x(tick.at)}%` }}>{tick.text}</span>)}</div></div>
    <div className="usage-timeline__legend" data-hot={hotSegment}>
      {series.map((item, index) => item.onFilter
        ? <button type="button" key={index} className="usage-timeline__legend-item tooltip-target" aria-pressed={item.filtered ?? false}
          data-tooltip={item.filtered ? item.clearTitle ?? "Show every thread" : item.filterTitle ?? `Show only ${item.title}`} onClick={item.onFilter}>
          <i className={`usage-series--${index}`} /><span>{item.title}</span> · {item.cost}</button>
        : item.onOpen
        ? <button type="button" key={index} className="usage-timeline__legend-item tooltip-target" data-tooltip={`Open ${item.title}`}
          aria-label={`Open ${item.title}`} onClick={item.onOpen}><i className={`usage-series--${index}`} /><span>{item.title}</span> · {item.cost}</button>
        : <span key={index} className="usage-timeline__legend-item tooltip-target" data-tooltip={item.title}><i className={`usage-series--${index}`} /><span>{item.title}</span> · {item.cost}</span>)}
      {buckets.some((bucket) => bucket.other > 0) ? <span className="usage-timeline__legend-item"><i className="usage-series--other" />Other {dimension === "thread" ? "threads" : dimension === "model" ? "models" : dimension === "provider" ? "providers" : dimension === "account" ? "accounts" : "instances"}</span> : null}
    </div>
    <p className="usage-timeline__readout">{active
      ? `${usageBucketLabel(active, to)} · ${usageMoney(active.cost)} · ${active.rows} completed ${active.rows === 1 ? "turn" : "turns"}`
      : "Select a bar to list the threads that completed turns in it"}</p>
  </figure>;
}
