import {
  filterState,
  type StarMapFilterDefinition,
  type StarMapFilterSelection,
} from "./star-map-filters";

/**
 * One tri-state filter chip.
 *
 * Extracted because the chips now render on two surfaces — the inline
 * strip in the top band, and the "Filters" popover the band collapses
 * into when the window is too narrow for the strip. Both must offer the
 * same control with the same label, and an aria-label this fiddly is not
 * something to keep in sync by hand.
 */
export function StarMapFilterChip(props: {
  definition: StarMapFilterDefinition;
  selection: StarMapFilterSelection;
  count: number;
  onCycle: () => void;
}) {
  const state = filterState(props.selection, props.definition.key);
  const next =
    state === "neutral"
      ? "show only these"
      : state === "include"
        ? "hide these instead"
        : "stop filtering on this";

  return (
    <button
      type="button"
      className={`star-map__filter-chip star-map__filter-chip--${state}`}
      // Tri-state, so `aria-pressed` cannot describe it: exclude is
      // neither pressed nor unpressed. The label carries the state
      // and what the next click does.
      aria-label={`${props.definition.label}: ${
        state === "neutral"
          ? "not filtered"
          : state === "include"
            ? "showing only these"
            : "hidden"
      } — click to ${next}`}
      onClick={props.onCycle}
    >
      {state === "exclude" ? (
        <span className="star-map__filter-mark" aria-hidden="true">
          −
        </span>
      ) : null}
      <span>{props.definition.label}</span>
      <span className="star-map__filter-count">{props.count}</span>
    </button>
  );
}
