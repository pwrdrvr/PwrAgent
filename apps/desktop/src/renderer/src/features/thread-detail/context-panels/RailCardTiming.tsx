import { useEffect, useState, type ReactNode } from "react";
import {
  formatDurationMs,
  formatRunningDurationMs,
} from "../../../lib/format-duration";
import { formatTimestamp } from "./context-rail-shared";

type RailCardTimingProps = {
  completedAt?: number;
  now: number;
  onStartClick?: () => void;
  running: boolean;
  startActionLabel?: string;
  startActionTitle?: string;
  startedAt: number;
  trailing?: ReactNode;
};

/**
 * Shared start + duration treatment for Pricing and Sub-agent rail cards.
 *
 * The compact line keeps the stable start time visible, replaces noisy
 * same-minute start/end pairs with an elapsed duration, and exposes the exact
 * end timestamp from the duration's tooltip after the run settles.
 */
export function RailCardTiming(props: RailCardTimingProps) {
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
            className="rail-card__duration"
            title={durationDescription}
            aria-label={`${duration}. ${durationDescription}`}
          >
            {duration}
          </span>
        </>
      ) : null}
      {props.trailing ? <>{" · "}{props.trailing}</> : null}
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
