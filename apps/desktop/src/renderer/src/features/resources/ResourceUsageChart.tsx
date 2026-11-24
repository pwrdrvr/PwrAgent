import { useState, type PointerEvent, type ReactElement } from "react";
import { formatAge } from "./resource-view-model";
import type { UsageBar, UsageChart } from "./resource-usage";

const BAR_PITCH = 5;
const BAR_WIDTH = 3.4;
const PLOT_HEIGHT = 56;
const HEAD_ROOM = 4;
/** Keeps a single unit visible against a large capacity. */
const MIN_SEGMENT = 1.5;
const SEGMENT_GAP = 0.8;

/**
 * Held and waiting units over the last 30 minutes, one stacked bar per
 * 30 seconds, against the resource's capacity. Pointing at a bar reads it
 * out below the chart; the readout otherwise shows the current bar. Ages
 * are measured from `chart.now`, on the same clock as the bars.
 */
export function ResourceUsageChart(props: { chart: UsageChart; unitLabel: string }): ReactElement {
  const { chart } = props;
  const [pointed, setPointed] = useState<number>();
  const count = chart.bars.length;
  const width = count * BAR_PITCH;
  const height = PLOT_HEIGHT + HEAD_ROOM;
  const scale = (units: number) => (units / chart.scaleMax) * PLOT_HEIGHT;
  const capacityY = height - scale(chart.capacity);
  const firstObserved = chart.bars.findIndex((bar) => bar.observed);
  const lastObserved = chart.bars.findLastIndex((bar) => bar.observed);
  const shown = chart.bars[pointed ?? count - 1];
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const index = Math.floor(((event.clientX - box.left) / box.width) * count);
    setPointed(Math.min(count - 1, Math.max(0, index)));
  };
  return (
    <figure aria-label={`Held and waiting ${props.unitLabel}s over the last 30 minutes`} className="resources-usage">
      <svg
        aria-hidden="true"
        className="resources-usage__plot"
        data-testid="resources-usage-plot"
        focusable="false"
        viewBox={`0 0 ${width} ${height}`}
        onPointerLeave={() => setPointed(undefined)}
        onPointerMove={onPointerMove}
      >
        {pointed === undefined ? null : (
          <rect className="resources-usage__pointer" height={height} width={BAR_PITCH} x={pointed * BAR_PITCH} y={0} />
        )}
        {firstObserved > 0 ? (
          <line
            className="resources-usage__unobserved"
            vectorEffect="non-scaling-stroke"
            x1={0}
            x2={firstObserved * BAR_PITCH}
            y1={height - 0.5}
            y2={height - 0.5}
          />
        ) : null}
        {lastObserved >= 0 && lastObserved < count - 1 ? (
          <line
            className="resources-usage__unobserved"
            vectorEffect="non-scaling-stroke"
            x1={(lastObserved + 1) * BAR_PITCH}
            x2={width}
            y1={height - 0.5}
            y2={height - 0.5}
          />
        ) : null}
        {chart.bars.map((bar, index) => (
          <UsageBarMark
            key={bar.startAt}
            bar={bar}
            dimmed={pointed !== undefined && pointed !== index}
            scale={scale}
            x={index * BAR_PITCH + (BAR_PITCH - BAR_WIDTH) / 2}
            y={height}
          />
        ))}
        <line
          className="resources-usage__capacity"
          vectorEffect="non-scaling-stroke"
          x1={0}
          x2={width}
          y1={capacityY}
          y2={capacityY}
        />
      </svg>
      <div aria-hidden="true" className="resources-usage__axis resources-mono">
        <span>30m ago</span>
        <span>now</span>
      </div>
      <figcaption className="resources-usage__readout" data-testid="resources-usage-readout">
        <span className="resources-usage__when resources-mono">
          {pointed === undefined || pointed === count - 1 ? "Now" : ago(shown.endAt, chart.now)}
        </span>
        {shown.observed ? (
          <>
            <span className="resources-usage__key">
              <span aria-hidden="true" className="resources-usage__swatch resources-usage__swatch--held" />
              {shown.held} held
            </span>
            <span className="resources-usage__key">
              <span aria-hidden="true" className="resources-usage__swatch resources-usage__swatch--waiting" />
              {shown.waiting} waiting
            </span>
            <span className="resources-usage__key">
              <span aria-hidden="true" className="resources-usage__swatch resources-usage__swatch--capacity" />
              capacity {chart.capacity}
            </span>
          </>
        ) : (
          <span className="resources-usage__key">Not recorded</span>
        )}
      </figcaption>
      {chart.observedSince === undefined ? null : (
        <p className="resources-note">
          Recording began {ago(chart.observedSince, chart.now)}, when PwrAgent started watching.
        </p>
      )}
    </figure>
  );
}

/** "just now" under a minute, else "4m ago". */
function ago(at: number, now: number): string {
  const age = formatAge(at, now);
  return age === "now" ? "just now" : `${age} ago`;
}

function UsageBarMark(props: {
  bar: UsageBar;
  dimmed: boolean;
  x: number;
  y: number;
  scale: (units: number) => number;
}): ReactElement | null {
  const { bar } = props;
  if (!bar.observed || bar.held + bar.waiting === 0) return null;
  const held = bar.held ? Math.max(MIN_SEGMENT, props.scale(bar.held)) : 0;
  const waiting = bar.waiting ? Math.max(MIN_SEGMENT, props.scale(bar.waiting)) : 0;
  const gap = held && waiting ? SEGMENT_GAP : 0;
  return (
    <g className={props.dimmed ? "resources-usage__bar is-dimmed" : "resources-usage__bar"}>
      {held ? (
        <rect className="resources-usage__held" height={held} rx={0.8} width={BAR_WIDTH} x={props.x} y={props.y - held} />
      ) : null}
      {waiting ? (
        <rect
          className="resources-usage__waiting"
          height={waiting}
          rx={0.8}
          width={BAR_WIDTH}
          x={props.x}
          y={props.y - held - gap - waiting}
        />
      ) : null}
    </g>
  );
}
