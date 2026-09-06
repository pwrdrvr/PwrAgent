import { useEffect, useState } from "react";
import {
  formatDurationMs,
  formatRunningDurationMs,
} from "../../../lib/format-duration";
import { useViewportTooltip } from "../../../lib/useViewportTooltip";
import { formatTimestamp } from "./context-rail-shared";

type RailCardTimingProps = {
  completedAt?: number;
  now: number;
  onStartClick?: () => void;
  running: boolean;
  startActionLabel?: string;
  startActionTitle?: string;
  startedAt: number;
};

/** Live clocks belong to the timing display, never to its containing panel. */
export function LiveRailCardTiming(props: Omit<RailCardTimingProps, "now">) {
  const now = useNowWhileActive(props.running);
  return <RailCardTiming {...props} now={now} />;
}

/**
 * Shared start + duration treatment for Pricing and Sub-agent rail cards.
 *
 * The compact line keeps the stable start time visible, replaces noisy
 * same-minute start/end pairs with an elapsed duration, and exposes the exact
 * end timestamp from the duration's tooltip after the run settles.
 */
export function RailCardTiming(props: RailCardTimingProps) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const startedTimestamp = formatTimestamp(props.startedAt, {
    includeSeconds: true,
  });
  const duration = formatRailCardDuration(props);
  const completedTimestamp =
    props.completedAt !== undefined
      ? formatTimestamp(props.completedAt, { includeSeconds: true })
      : undefined;
  const durationDescription = completedTimestamp
    ? `Ended ${completedTimestamp}`
    : duration
      ? `Running for ${duration}`
      : undefined;

  return (
    <p className="rail-card__times">
      <span className="rail-card__time-label">Started</span>{" "}
      {props.onStartClick ? (
        <button
          type="button"
          className="rail-card__time-button"
          title={props.startActionTitle}
          aria-label={props.startActionLabel}
          onClick={props.onStartClick}
        >
          {startedTimestamp}
        </button>
      ) : (
        startedTimestamp
      )}
      {duration ? (
        <>
          {" · "}
          <span
            className={`rail-card__duration${
              completedTimestamp ? " rail-card__duration--exact-end" : ""
            }`}
            tabIndex={completedTimestamp ? 0 : undefined}
            aria-label={`${duration}. ${durationDescription}`}
            onBlur={tooltip.hide}
            onFocus={(event) =>
              durationDescription &&
              tooltip.show(event.currentTarget, durationDescription)
            }
            onMouseEnter={(event) =>
              durationDescription &&
              tooltip.show(event.currentTarget, durationDescription)
            }
            onMouseLeave={tooltip.hide}
          >
            {duration}
          </span>
        </>
      ) : null}
      {tooltip.tooltipNode}
    </p>
  );
}

/** Ticks card durations only while at least one row on the panel is live. */
export function useNowWhileActive(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) {
      return;
    }
    setNow(Date.now());
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [enabled]);
  return now;
}

function formatRailCardDuration(props: RailCardTimingProps): string {
  if (props.running) {
    return formatRunningDurationMs(Math.max(0, props.now - props.startedAt));
  }
  if (props.completedAt === undefined || props.completedAt < props.startedAt) {
    return "";
  }
  if (props.completedAt === props.startedAt) {
    return "0s";
  }
  return formatDurationMs(props.completedAt - props.startedAt);
}
