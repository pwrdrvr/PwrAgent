import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { effortStopAtPointer, steppedStopForKey } from "./model-settings-picker-model";

/** One stop on a stepped level bar. */
export type SteppedLevelStop = {
  /** Unique among the stops; also the `data-<dataAttribute>` value. */
  key: string;
  /** The tick label under the stop. */
  tick: string;
  /** Drawn but never chosen; `reason` says why on hover and focus. */
  disabled?: boolean;
  reason?: string;
};

/**
 * The stepped bar behind the model pill's Effort and the composer's Access
 * level: one `role="slider"` track of equal segments, filled up to the shown
 * stop, with tick labels under it. Click or drag (with pointer capture) and
 * the arrow keys, Page keys, Home and End choose a stop; a disabled stop is
 * drawn but skipped, and its tick is a focusable button that carries the
 * reason, so the reason is reachable from the keyboard too.
 */
export function SteppedLevelBar(props: {
  ariaLabel: string;
  /** The id of text that describes the chosen stop. */
  ariaDescribedBy?: string;
  stops: readonly SteppedLevelStop[];
  /** The chosen stop, or -1 when the value is not a stop. */
  value: number;
  /** Draw this stop as chosen instead, such as one awaiting confirmation. */
  shown?: number;
  valueText: string;
  disabled?: boolean;
  /** Lays out the bar in its host, such as `model-settings__effort-bar`. */
  className?: string;
  /** Names the per-stop data attribute, such as `effort` for `data-effort`. */
  dataAttribute: string;
  /** Fills the chosen segments with the accent's warning weight. */
  hot?: boolean;
  /** Whether stop `index` gets a tick label. Every stop by default. */
  labelled?: (index: number, shown: number) => boolean;
  onCommit: (index: number) => void;
  /** The stop under a drag, or undefined when the drag ends. */
  onPreviewChange?: (index: number | undefined) => void;
}) {
  const { stops, value, disabled } = props;
  const count = stops.length;
  const enabled = stops.map((stop) => !stop.disabled);
  const [preview, setPreviewState] = useState<number>();
  const [hover, setHover] = useState<number>();
  const dragging = useRef(false);
  const trackRef = useRef<HTMLDivElement>(null);
  // Where the bar stands: a stop shown in place of the value (one awaiting
  // confirmation) is where keys step from and what a press measures against,
  // so choosing the committed stop again reaches the host and backs out.
  const base = props.shown ?? value;
  const shown = preview ?? base;
  const setPreview = (next: number | undefined): void => {
    setPreviewState(next);
    props.onPreviewChange?.(next);
  };

  // The segment under the pointer when the event names one; while the track
  // holds pointer capture every event targets the track, so the position
  // along it decides.
  const stopAt = (event: ReactPointerEvent<HTMLElement>): number => {
    const segment = (event.target as HTMLElement).closest<HTMLElement>("[data-stepped-stop]");
    if (segment?.dataset.steppedStop !== undefined) {
      return Number(segment.dataset.steppedStop);
    }
    const rect = trackRef.current?.getBoundingClientRect();
    return effortStopAtPointer(event.clientX, rect?.left ?? 0, rect?.width ?? 0, count);
  };
  const usable = (stop: number | undefined): stop is number =>
    stop !== undefined && stop >= 0 && stop < count && enabled[stop] === true;
  const commit = (stop: number | undefined): void => {
    if (!usable(stop) || stop === base) return;
    props.onCommit(stop);
  };
  const columns = { gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` };

  return (
    <div className={["stepped-bar", props.className].filter(Boolean).join(" ")}>
      <div
        aria-describedby={props.ariaDescribedBy}
        aria-disabled={disabled || undefined}
        aria-label={props.ariaLabel}
        aria-valuemax={count - 1}
        aria-valuemin={0}
        aria-valuenow={value >= 0 ? value : undefined}
        aria-valuetext={props.valueText}
        className={[
          "stepped-bar__track",
          value < 0 && preview === undefined && props.shown === undefined ? "is-unset" : "",
          props.hot ? "is-hot" : "",
        ].filter(Boolean).join(" ")}
        ref={trackRef}
        role="slider"
        style={columns}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(event) => {
          if (disabled) return;
          const next = steppedStopForKey(event.key, base, enabled);
          if (next === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          commit(next);
        }}
        onLostPointerCapture={() => {
          dragging.current = false;
          setPreview(undefined);
        }}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus({ preventScroll: true });
          event.currentTarget.setPointerCapture?.(event.pointerId);
          const stop = stopAt(event);
          // A press on a disabled stop starts the drag where the value is.
          setPreview(usable(stop) ? stop : base >= 0 ? base : undefined);
          dragging.current = true;
        }}
        onPointerLeave={() => setHover(undefined)}
        onPointerMove={(event) => {
          if (disabled) return;
          const stop = stopAt(event);
          if (dragging.current) {
            // Passing over a disabled stop holds the last stop that can be
            // chosen, so the bar never shows a level it would not commit.
            if (usable(stop)) setPreview(stop);
          } else {
            setHover(usable(stop) ? stop : undefined);
          }
        }}
        onPointerUp={(event) => {
          if (!dragging.current) return;
          const stop = stopAt(event);
          const held = preview;
          dragging.current = false;
          setPreview(undefined);
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          commit(usable(stop) ? stop : held);
        }}
      >
        {stops.map((stop, index) => (
          <i
            className={[
              "stepped-bar__stop",
              index <= shown ? "is-on" : "",
              preview === undefined && hover !== undefined && index > shown && index <= hover
                ? "is-hover"
                : "",
              stop.disabled ? "is-disabled" : "",
              stop.disabled && stop.reason ? "tooltip-target" : "",
            ].filter(Boolean).join(" ")}
            data-stepped-stop={index}
            data-tooltip={stop.disabled ? stop.reason : undefined}
            key={stop.key}
            {...{ [`data-${props.dataAttribute}`]: stop.key }}
          />
        ))}
      </div>
      <div className="stepped-bar__ticks" style={columns}>
        {stops.map((stop, index) => {
          const text = props.labelled && !props.labelled(index, shown) ? "" : stop.tick;
          if (stop.disabled && stop.reason) {
            return (
              <button
                aria-description={stop.reason}
                aria-disabled="true"
                aria-label={`${stop.tick}, unavailable`}
                className="stepped-bar__tick stepped-bar__tick--disabled tooltip-target"
                data-tooltip={stop.reason}
                key={stop.key}
                type="button"
              >
                {text}
              </button>
            );
          }
          return (
            <span
              aria-hidden="true"
              className={[
                "stepped-bar__tick",
                index === shown ? "is-on" : "",
                stop.disabled ? "stepped-bar__tick--disabled" : "",
              ].filter(Boolean).join(" ")}
              key={stop.key}
            >
              {text}
            </span>
          );
        })}
      </div>
    </div>
  );
}
