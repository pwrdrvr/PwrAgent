import { useEffect, useRef, useState } from "react";
import { StarMapFilterChip } from "./StarMapFilterChip";
import {
  STAR_MAP_FILTERS,
  type StarMapFilterKey,
  type StarMapFilterSelection,
} from "./star-map-filters";

/**
 * The filter strip, collapsed into one chip.
 *
 * Seven chips carrying live counts are about 1020px wide with two-digit
 * counts and 1084px with three — wider than the band has to give on any
 * window below roughly 1120px, and the map window goes down to 800px. The
 * strip used to wrap to a second row there, which put chips over the star
 * field and doubled the height of the band for no gain. This is the same
 * set of controls behind one door instead.
 *
 * CSS owns the swap (`@media` on the band, beside `.star-map__filters`),
 * not this component: both surfaces render at every width and the one
 * that fits is displayed, so there is no measurement to get wrong and no
 * flip-flop between the two.
 */
export function StarMapFilterMenu(props: {
  selection: StarMapFilterSelection;
  counts: Record<StarMapFilterKey, number>;
  onCycle: (key: StarMapFilterKey) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeCount = Object.keys(props.selection).length;

  // Same dismissal model as the View popover beside it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && !containerRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className="star-map__filter-menu" ref={containerRef}>
      <button
        type="button"
        className={`star-map__filter-chip${activeCount > 0 ? " is-on" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        // The count is the only thing that says the map is filtered while
        // the chips are behind the door, so it has to be in the name and
        // not just painted on the badge.
        aria-label={
          activeCount === 0
            ? "Thread filters"
            : `Thread filters: ${activeCount} active`
        }
        onClick={() => setOpen((current) => !current)}
      >
        <span>Filters</span>
        {activeCount > 0 ? (
          <span className="star-map__filter-count">{activeCount}</span>
        ) : null}
      </button>
      {open ? (
        <div
          className="star-map__filter-panel"
          role="dialog"
          aria-label="Thread filters"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {STAR_MAP_FILTERS.map((definition) => (
            <StarMapFilterChip
              key={definition.key}
              definition={definition}
              selection={props.selection}
              count={props.counts[definition.key]}
              onCycle={() => props.onCycle(definition.key)}
            />
          ))}
          {activeCount > 0 ? (
            <button
              type="button"
              className="star-map__filter-clear"
              onClick={() => {
                props.onClear();
                setOpen(false);
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
