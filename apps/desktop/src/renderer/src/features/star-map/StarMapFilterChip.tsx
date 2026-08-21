import {
  AttentionReviewReadout,
  AttentionTurnReadouts,
  describeAttentionCounts,
  useAttentionHoverCard,
} from "../navigation/AttentionSignals";
import {
  filterState,
  type StarMapAttentionCounts,
  type StarMapFilterDefinition,
  type StarMapFilterSelection,
  type StarMapFilterState,
} from "./star-map-filters";

type StarMapFilterChipProps = {
  definition: StarMapFilterDefinition;
  selection: StarMapFilterSelection;
  count: number;
  /**
   * Present only on the Attention chip, which draws the sidebar's
   * Attention readouts instead of a label and a number — the stacked
   * turn scanners and the orange cookie, each with its count, exactly as
   * the sidebar's Attention tab does. All are always drawn, greyed at zero
   * rather than hidden: a missing indicator makes an idle chip look
   * broken, which is the same rule the tab follows.
   */
  attention?: StarMapAttentionCounts;
  /** Whether this map fronts any peer at all; see the indicators below. */
  showRemoteTurns?: boolean;
  onCycle: () => void;
  /**
   * Dropped from the strip because the band ran out of room for it. The
   * chip stays in the DOM and keeps its natural width: the fit is decided
   * by measuring these chips, so removing them would remove the input
   * that decides whether they come back, and the strip would oscillate.
   * CSS takes it out of flow and out of the accessibility tree.
   */
  dropped?: boolean;
};

/**
 * One tri-state filter chip.
 *
 * Extracted because the chips now render on two surfaces — the inline
 * strip in the top band, and the "Filters" popover the band collapses
 * into when the window is too narrow for the strip. Both must offer the
 * same control with the same label, and an aria-label this fiddly is not
 * something to keep in sync by hand.
 */
export function StarMapFilterChip(props: StarMapFilterChipProps) {
  if (props.attention) {
    return (
      <StarMapAttentionFilterChip {...props} attention={props.attention} />
    );
  }
  const chrome = chipChrome(props);
  return (
    <button
      type="button"
      className={chrome.className}
      tabIndex={chrome.tabIndex}
      aria-hidden={chrome.ariaHidden}
      aria-label={chrome.ariaLabel}
      onClick={props.onCycle}
    >
      <ExcludeMark state={chrome.state} />
      <span>{props.definition.label}</span>
      <span className="star-map__filter-count">{props.count}</span>
    </button>
  );
}

/**
 * The Attention chip: the sidebar's Attention tab, on the map.
 *
 * No visible word. Like the lens tab, the chip IS its readouts — the
 * stacked turn scanners and the cookie say "in progress" and "unread"
 * better than a label beside them could, and the label was width the band
 * needs for the chips beside it. The name lives in the `aria-label` and in
 * the hover card's eyebrow, the same place the lens tabs keep theirs.
 *
 * The hover card is the tab's card, shared component and shared class, with
 * the map's own caption and third-row label: the tab's third readout counts
 * "to review" (anything in the inbox) and the chip's counts unread, and the
 * card must say what its number actually is. A closing line says what a
 * click does, because with the word gone the chip's fill is the only other
 * hint that it filters.
 */
function StarMapAttentionFilterChip(
  props: StarMapFilterChipProps & { attention: StarMapAttentionCounts },
) {
  const chrome = chipChrome(props);
  // The remote readout is omitted entirely when the map fronts no peers,
  // the way the Attention tab omits it: a permanent 0 on a single-machine
  // setup is noise, and it would take width from the chips beside it.
  const counts = {
    activeLocal: props.attention.activeLocal,
    activeRemote: props.showRemoteTurns ? props.attention.activeRemote : undefined,
    review: props.attention.unread,
  };
  const { card, tooltip } = useAttentionHoverCard({
    ...counts,
    title: props.definition.label,
    caption: "Threads in progress or unread",
    reviewLabel: "Unread",
    formatReviewCount: formatUnreadThreadCount,
    footer: `Click to ${chrome.next}`,
    // Inside `.star-map-window`, which opens its own stacking context: the
    // portal needs the explicit layer the map's other tooltips carry.
    className: "attention-card attention-card--star-map",
  });

  return (
    <>
      <button
        type="button"
        className={`${chrome.className} star-map__filter-chip--attention`}
        tabIndex={chrome.tabIndex}
        aria-hidden={chrome.ariaHidden}
        // The numbers are drawn as marks, so without this the chip
        // announces its filter state and nothing about what it counts.
        aria-label={`${chrome.ariaLabel}. ${describeAttentionCounts(
          counts,
          formatUnreadThreadCount,
        )}`}
        // The card's consequence lines exist nowhere else — without this
        // they are sighted-only, since the portal sits outside this
        // button's subtree. Gated on `visible`: naming an absent element is
        // a dangling reference.
        aria-describedby={tooltip.visible ? tooltip.tooltipId : undefined}
        onBlur={tooltip.hide}
        onClick={() => {
          tooltip.hide();
          props.onCycle();
        }}
        onFocus={(event) => tooltip.show(event.currentTarget, card)}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, card)}
        onMouseLeave={tooltip.hide}
      >
        <ExcludeMark state={chrome.state} />
        {/* The tab's own layout: turns stacked in one column, the cookie
            beside it. One wrapper gives the pair the tab's inner gap
            without restating it on the chip, whose gap is the strip's. */}
        <span aria-hidden="true" className="star-map__filter-signals">
          <AttentionTurnReadouts
            activeLocal={counts.activeLocal}
            activeRemote={counts.activeRemote}
          />
          <AttentionReviewReadout count={counts.review} />
        </span>
      </button>
      {tooltip.tooltipNode}
    </>
  );
}

/**
 * Everything the two chip variants share: the tri-state class, the
 * out-of-flow attributes of a dropped chip, and the accessible name that
 * carries the state and what the next click does. Tri-state, so
 * `aria-pressed` cannot describe it: exclude is neither pressed nor
 * unpressed.
 */
function chipChrome(props: StarMapFilterChipProps) {
  const state = filterState(props.selection, props.definition.key);
  const next =
    state === "neutral"
      ? "show only these"
      : state === "include"
        ? "hide these instead"
        : "stop filtering on this";
  return {
    state,
    next,
    className: `star-map__filter-chip star-map__filter-chip--${state}${
      props.dropped ? " is-dropped" : ""
    }`,
    // Out of flow is not out of reach: without this a dropped chip is
    // still in the tab order, focusable, and invisible.
    tabIndex: props.dropped ? -1 : undefined,
    ariaHidden: props.dropped ? true : undefined,
    ariaLabel: `${props.definition.label}: ${
      state === "neutral"
        ? "not filtered"
        : state === "include"
          ? "showing only these"
          : "hidden"
    } — click to ${next}`,
  };
}

function ExcludeMark(props: { state: StarMapFilterState }) {
  return props.state === "exclude" ? (
    <span className="star-map__filter-mark" aria-hidden="true">
      −
    </span>
  ) : null;
}

/** "3 unread" — the chip's third count, as the old label read it out. */
function formatUnreadThreadCount(count: number): string {
  return `${count} unread`;
}
