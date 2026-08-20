import {
  formatActiveThreadCount,
  formatLocalActiveThreadCount,
  formatRemoteActiveThreadCount,
} from "../navigation/ThreadRowStatus";
import { ThinkingScanner } from "../thread-detail/ThinkingScanner";
import {
  filterState,
  type StarMapAttentionCounts,
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
  /**
   * Present only on the Attention chip, which draws two indicators
   * instead of one number — a scanner for turns in progress and the
   * orange cookie for unread, exactly as the sidebar's Attention tab
   * does. Both are always drawn, greyed at zero rather than hidden: a
   * missing indicator makes an idle chip look broken, which is the same
   * rule the tab follows.
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
      className={`star-map__filter-chip star-map__filter-chip--${state}${
        props.dropped ? " is-dropped" : ""
      }`}
      // Out of flow is not out of reach: without this a dropped chip is
      // still in the tab order, focusable, and invisible.
      tabIndex={props.dropped ? -1 : undefined}
      aria-hidden={props.dropped ? true : undefined}
      // Tri-state, so `aria-pressed` cannot describe it: exclude is
      // neither pressed nor unpressed. The label carries the state
      // and what the next click does.
      aria-label={`${props.definition.label}: ${
        state === "neutral"
          ? "not filtered"
          : state === "include"
            ? "showing only these"
            : "hidden"
      } — click to ${next}${
        props.attention
          ? `. ${describeAttentionCounts(
              props.attention,
              props.showRemoteTurns ?? false,
            )}`
          : ""
      }`}
      onClick={props.onCycle}
    >
      {state === "exclude" ? (
        <span className="star-map__filter-mark" aria-hidden="true">
          −
        </span>
      ) : null}
      <span>{props.definition.label}</span>
      {props.attention ? (
        <StarMapAttentionIndicators
          counts={props.attention}
          showRemoteTurns={props.showRemoteTurns ?? false}
        />
      ) : (
        <span className="star-map__filter-count">{props.count}</span>
      )}
    </button>
  );
}

/**
 * The Attention chip's readouts, in the sidebar's vocabulary.
 *
 * Three signals, not two: turns here, turns elsewhere, and unread. The
 * local/remote split is the sidebar's and it is load-bearing — the accent
 * means "this holds the app open", and a peer's turn does not, so they
 * cannot share a colour even though both are "working".
 *
 * The remote readout is omitted entirely when the map fronts no peers,
 * the way the Attention tab omits it: a permanent 0 on a single-machine
 * setup is noise, and it would take width from the chips beside it.
 */
function StarMapAttentionIndicators(props: {
  counts: StarMapAttentionCounts;
  showRemoteTurns: boolean;
}) {
  return (
    <span aria-hidden="true" className="star-map__filter-signals">
      <span
        className="star-map__filter-signal star-map__filter-signal--active"
        data-zero={props.counts.activeLocal === 0 ? "true" : undefined}
      >
        <AttentionTurnScanner count={props.counts.activeLocal} />
        <span>{props.counts.activeLocal}</span>
      </span>
      {props.showRemoteTurns ? (
        <span
          className="star-map__filter-signal star-map__filter-signal--remote-active"
          data-zero={props.counts.activeRemote === 0 ? "true" : undefined}
        >
          <AttentionTurnScanner count={props.counts.activeRemote} />
          <span>{props.counts.activeRemote}</span>
        </span>
      ) : null}
      <span
        className="star-map__filter-signal star-map__filter-signal--review"
        data-zero={props.counts.unread === 0 ? "true" : undefined}
      >
        <span className="thread-row__status-cookie" />
        <span>{props.counts.unread}</span>
      </span>
    </span>
  );
}

/**
 * The sweeping bar next to a turn count, or its idle stand-in.
 *
 * At zero this is a static element, NOT a greyed-out `ThinkingScanner`.
 * `data-zero` lives on the parent, so React would keep the same scanner
 * element across the flip, its ref would never re-run, and the restarted
 * animation would never be re-pinned to the shared epoch — this chip would
 * drift against every other scanner on screen. Swapping the element type
 * guarantees a mount. Same reasoning, same stand-in element, as the
 * sidebar's `AttentionTurnScanner`; see ThinkingScanner.tsx and PR #1187.
 */
function AttentionTurnScanner(props: { count: number }) {
  return props.count === 0 ? (
    <span className="lens-switch__dormant-scanner" />
  ) : (
    <ThinkingScanner compact />
  );
}

/**
 * What the Attention chip's two indicators say out loud.
 *
 * The numbers are drawn as marks, so without this the chip announces its
 * filter state and nothing about what it is counting. Split phrasing only
 * when a peer actually has work — "0 on other instances" on every
 * single-machine setup is noise.
 */
function describeAttentionCounts(
  counts: StarMapAttentionCounts,
  showRemoteTurns = false,
): string {
  const active =
    showRemoteTurns
      ? [
          formatLocalActiveThreadCount(counts.activeLocal),
          formatRemoteActiveThreadCount(counts.activeRemote),
        ].join(", ")
      : formatActiveThreadCount(counts.activeLocal);
  return `${active}, ${counts.unread} unread`;
}
