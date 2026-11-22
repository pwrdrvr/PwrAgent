import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { NavigationAttentionScope } from "@pwragent/shared/contracts/navigation";
import { SignalCount } from "../../components/SignalCount";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { ThinkingScanner } from "../thread-detail/ThinkingScanner";
import {
  formatActiveThreadCount,
  formatLocalActiveThreadCount,
  formatRemoteActiveThreadCount,
} from "./ThreadRowStatus";

/**
 * The Attention readouts, shared by every surface that reports them.
 *
 * The sidebar's Attention tab and the Star Map's Attention chip draw the SAME
 * numbers — turns here, turns elsewhere, threads to look at — and an operator
 * glancing between the two windows must not have to work out whether two
 * slightly different oranges, or two different stackings, mean two different
 * things. So the indicators, the zero state, the stacked turn column and the
 * hover card that explains them live here once, and both controls render
 * these rather than each keeping a copy that drifts (the map's copy HAD
 * drifted: its turns sat in a row instead of the tab's column, and its signal
 * row lost its layout rule to a CSS splice).
 *
 * Class names stay the tab's (`lens-switch__*`): they carry the colour and
 * zero tokens, and `.attention-card__row` already reused them outside the
 * switch for exactly this reason. See "Reuse existing chrome tokens" in
 * CLAUDE.md — sharing the class is the strongest form of copying the tokens.
 */

/**
 * The sweeping bar next to a turn count, or its idle stand-in.
 *
 * At zero this is a static element, NOT a greyed-out `ThinkingScanner`.
 * Killing the sweep with CSS on a mounted scanner is a desync trap: `data-zero`
 * lives on the parent span, so React would keep the same scanner element across
 * the flip, its ref would never re-run, and the restarted animation would never
 * be re-pinned to the shared epoch — leaving this readout drifting against
 * every other scanner on screen. Swapping the element type guarantees a mount,
 * so `syncThinkingScannerAnimation` runs and the beam comes back in phase. See
 * ThinkingScanner.tsx and PR #1187.
 *
 * The remote readout's beam is neutral rather than accent, but it is the same
 * untouched component tinted by its parent's tokens — a peer's turn is running
 * for real, so it sweeps for real, on the same epoch as the rest.
 */
function AttentionTurnScanner(props: { count: number }) {
  return props.count === 0 ? (
    <span className="signal-count__dormant-scanner" />
  ) : (
    <ThinkingScanner compact />
  );
}

/**
 * The turn readouts, stacked: the accent scanner counts turns on this
 * machine, the neutral one under it counts turns on other instances.
 *
 * One column so the second readout stacks under the first instead of widening
 * the control. The Attention tab already floors the lens switch's narrowest
 * track (see `.lens-switch`), and a third readout laid out across would take
 * that room from the four icon tabs; on the map the band has the same problem
 * with its chips. A single row is the common case and reads exactly as a bare
 * readout would — a one-item column is its own content box, so nothing moves.
 *
 * `activeRemote` undefined means the remote readout is not on — no federated
 * work has run recently — and the column reads exactly as it does on an
 * instance that has never federated. The caller owns that decision (the tab
 * lingers it for half a minute, the map ties it to fronting a peer) because
 * only the caller knows what "recently" means on its surface.
 */
export function AttentionTurnReadouts(props: {
  activeLocal: number;
  activeRemote?: number;
  unknownLocal?: boolean;
  unknownRemote?: boolean;
}) {
  return (
    <span aria-hidden="true" className="signal-count-stack">
      <SignalCount
        count={props.activeLocal}
        unknown={props.unknownLocal}
        data={{ "data-attention-active-count": props.unknownLocal ? undefined : props.activeLocal }}
        indicator={<AttentionTurnScanner count={props.unknownLocal ? 0 : props.activeLocal} />}
        tone="active"
      />
      {props.activeRemote === undefined ? null : (
        <SignalCount
          count={props.activeRemote}
          unknown={props.unknownRemote}
          data={{ "data-attention-remote-active-count": props.unknownRemote ? undefined : props.activeRemote }}
          indicator={<AttentionTurnScanner count={props.unknownRemote ? 0 : props.activeRemote} />}
          tone="remote-active"
        />
      )}
    </span>
  );
}

/** The orange cookie and its count: threads waiting to be looked at. */
export function AttentionReviewReadout(props: { count: number; unknown?: boolean }) {
  return (
    <SignalCount
      ariaHidden
      count={props.count}
      unknown={props.unknown}
      data={{ "data-attention-review-count": props.unknown ? undefined : props.count }}
      indicator={<span className="thread-row__status-cookie" />}
      tone="idle"
    />
  );
}

/** What each kind of Attention member is called, on the card and wherever a
 *  lens narrowed to it is named (the scope strip, the tab's name). */
export const ATTENTION_SCOPE_LABELS: Record<NavigationAttentionScope, string> = {
  active: "In progress",
  "active-local": "In progress here",
  "active-remote": "In progress elsewhere",
  review: "To review",
};

export type AttentionIndicatorKind = "turn" | "remote-turn" | "review";

/** The mark a scope's readout wears: accent scanner, neutral scanner, cookie. */
export function attentionScopeIndicator(scope: NavigationAttentionScope): AttentionIndicatorKind {
  return scope === "review" ? "review" : scope === "active-remote" ? "remote-turn" : "turn";
}

/**
 * One count's indicator outside the tab: the card's rows and the scope strip.
 * A turn indicator is a dormant track at zero, never a sweeping beam beside
 * a 0 (see `AttentionTurnScanner`).
 */
export function AttentionIndicator(props: { kind: AttentionIndicatorKind; count: number; unknown?: boolean }) {
  const zero = props.unknown || props.count === 0;
  return (
    <span
      aria-hidden="true"
      className={`signal-count signal-count--${
        props.kind === "review" ? "idle" : props.kind === "remote-turn" ? "remote-active" : "active"
      }`}
      data-zero={zero ? "true" : undefined}
    >
      {props.kind === "review" ? (
        <span className="thread-row__status-cookie" />
      ) : (
        <AttentionTurnScanner count={zero ? 0 : props.count} />
      )}
    </span>
  );
}

/**
 * One line of the Attention hover card: the control's own indicator, what it
 * counts, and the count. Repeating the indicator is what ties a row to the
 * readout the operator just hovered — a card of bare labels would make them
 * re-derive which number is which.
 */
function AttentionCardRow(props: {
  count: number;
  unknown?: boolean;
  indicator: AttentionIndicatorKind;
  label: string;
  /** What quitting does to this row's work. Omitted when nothing is at stake. */
  note?: string;
  /**
   * Narrows the surface to this row's kind. A row with nothing in it (or an
   * unknown count) stays a label: picking it could only show an empty list.
   */
  onPick?: () => void;
  /** This row's kind is the one the surface is narrowed to. */
  selected?: boolean;
}) {
  const zero = props.unknown || props.count === 0;
  const content = (
    <>
      <AttentionIndicator kind={props.indicator} count={props.count} unknown={props.unknown} />
      <span className="attention-card__row-text">
        <span className="attention-card__row-label">{props.label}</span>
        {props.note ? (
          <span className="attention-card__row-note">{props.note}</span>
        ) : null}
      </span>
      <span className="attention-card__row-value">{props.unknown ? "Unavailable" : props.count}</span>
    </>
  );
  if (props.onPick && !zero) {
    // Out of the Tab order like every enterable card's controls: the scope
    // strip's Show all and the tab itself are the keyboard's way back.
    return (
      <button
        type="button"
        tabIndex={-1}
        className={`attention-card__row attention-card__row--pick${props.selected ? " is-selected" : ""}`}
        aria-current={props.selected ? "true" : undefined}
        onMouseDown={keepFocusOnTrigger}
        onClick={props.onPick}
      >
        {content}
      </button>
    );
  }
  return (
    <div
      className={`attention-card__row${props.onPick ? " attention-card__row--pick" : ""}`}
      data-zero={zero ? "true" : undefined}
    >
      {content}
    </div>
  );
}

export type AttentionCardCounts = {
  unknownLocal?: boolean;
  unknownRemote?: boolean;
  unknownReview?: boolean;
  /** Turns on this machine (or all turns, where the split is off). */
  activeLocal: number;
  /**
   * Turns on other instances. `undefined` means the split is off and the
   * card names no machine — "In progress" is the whole truth on an
   * unfederated instance, and naming the machine would raise a question
   * the operator does not have.
   */
  activeRemote?: number;
  /** Threads waiting to be looked at — "to review" or "unread", per surface. */
  review: number;
};

export type AttentionCardOptions = {
  /** What the control is called: the eyebrow and the first accessible term. */
  title: string;
  /** One line under the eyebrow saying what the control reports. */
  caption: string;
  /** The third row's label — the tab says "To review", the map "Unread". */
  reviewLabel: string;
  /**
   * An optional closing line. The map's chip uses it to say what a click
   * does now that the chip shows no word — without it a sighted operator
   * has only the chip's fill to learn it is a filter.
   */
  footer?: string;
  /**
   * Makes each counted row a way to narrow the surface to that kind of
   * thread, and the footer a way back to all of them. The sidebar's tab
   * passes it; the map's chip does not, and its card stays a readout.
   */
  scopes?: {
    selected?: NavigationAttentionScope;
    onSelect: (scope: NavigationAttentionScope | undefined) => void;
  };
};

/**
 * A press on one of the card's controls leaves focus where it was. Chromium
 * focuses a button on mousedown, and the card closes once a row is picked,
 * so focus moved into it would be dropped on <body> along with the card.
 */
function keepFocusOnTrigger(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

/**
 * The scope a turn row narrows to. "In progress" without the split is every
 * turn; with it, the first row is this machine's alone.
 */
function turnRowScope(split: boolean): NavigationAttentionScope {
  return split ? "active-local" : "active";
}

/**
 * The hover card's content. A card, not a text tooltip: every other lens tab
 * or chip explains itself in one line; this one reports two or three counts,
 * each with its own indicator and — once a peer is running work — a
 * consequence. Run through `.viewport-tooltip` that became four stacked
 * sentences with em-dashes doing the structural work. See "Structured hover
 * cards" in AGENTS.md.
 */
function AttentionCard(props: AttentionCardCounts & AttentionCardOptions) {
  const activeRemote = props.activeRemote;
  const scopes = props.scopes;
  const split = activeRemote !== undefined;
  const localScope = turnRowScope(split);
  const pick = (scope: NavigationAttentionScope) => scopes ? () => scopes.onSelect(scope) : undefined;
  // "Here" and "everything" are one list once no peer work is running, so a
  // lens narrowed to either marks the one turn row the card still has.
  const isSelected = (scope: NavigationAttentionScope) => scopes?.selected === scope
    || (scope === "active" && scopes?.selected === "active-local");
  return (
    <>
      <div className="attention-card__eyebrow">{props.title}</div>
      <div className="attention-card__caption">{props.caption}</div>
      <div className={`attention-card__section${scopes ? " attention-card__section--pick" : ""}`}>
        <AttentionCardRow
          count={props.activeLocal}
          unknown={props.unknownLocal}
          onPick={pick(localScope)}
          selected={isSelected(localScope)}
          indicator="turn"
          // Only qualify the row once there is something to tell it apart
          // from.
          label={ATTENTION_SCOPE_LABELS[localScope]}
          note={
            activeRemote === undefined ? undefined : "Quitting interrupts these"
          }
        />
        {activeRemote === undefined ? null : (
          <AttentionCardRow
            count={activeRemote}
            unknown={props.unknownRemote}
            onPick={pick("active-remote")}
            selected={isSelected("active-remote")}
            indicator="remote-turn"
            label={ATTENTION_SCOPE_LABELS["active-remote"]}
            note="Quitting leaves these running"
          />
        )}
        <AttentionCardRow
          count={props.review}
          unknown={props.unknownReview}
          onPick={pick("review")}
          selected={isSelected("review")}
          indicator="review"
          label={props.reviewLabel}
        />
      </div>
      {props.footer && scopes ? (
        <div className="attention-card__footer attention-card__footer--pick">
          <button
            type="button"
            tabIndex={-1}
            className="attention-card__show-all"
            onMouseDown={keepFocusOnTrigger}
            onClick={() => scopes.onSelect(undefined)}
          >
            {props.footer}
          </button>
        </div>
      ) : props.footer ? (
        <div className="attention-card__footer">{props.footer}</div>
      ) : null}
    </>
  );
}

/**
 * The counts spelled out for an accessible name: "1 active thread on this
 * machine, 2 active threads on other instances, 3 threads to review". The
 * machine is named only when the split is on, for the same reason the card
 * only names it then.
 */
export function describeAttentionCounts(
  counts: AttentionCardCounts,
  formatReviewCount: (count: number) => string,
  unknownReviewLabel = "Review count unavailable",
): string {
  return [
    ...(counts.activeRemote === undefined
      ? [counts.unknownLocal ? "Active thread count unavailable" : formatActiveThreadCount(counts.activeLocal)]
      : [
        counts.unknownLocal ? "Active thread count on this machine unavailable" : formatLocalActiveThreadCount(counts.activeLocal),
        counts.unknownRemote ? "Active thread count on other instances unavailable" : formatRemoteActiveThreadCount(counts.activeRemote),
      ]),
    counts.unknownReview ? unknownReviewLabel : formatReviewCount(counts.review),
  ].join(", ");
}

/**
 * The Attention hover card, wired to a trigger.
 *
 * Returns the tooltip handle (show/hide/node/id) and the card element to hand
 * `show`. Creating the element is not rendering it: it stays an inert object
 * until `show` hands it to the portal on hover or focus.
 *
 * Turns start and end while the pointer rests on the trigger, so fresh
 * numbers are pushed into an already-open card rather than freezing it at
 * hover-time values — the same thing `PrChip` does for a live PR status.
 * Freezing is not cosmetic here: the card would keep claiming there is no
 * peer work after a peer starts a turn, on the one surface that exists to
 * answer "can I quit now?".
 *
 * The push is keyed on the card's DATA, not its identity per render: the
 * element is memoized on its counts and labels, so a new element means the
 * numbers moved, and only then is an open card updated — feeding a fresh
 * element in on every render would set state on every render that very
 * update caused.
 */
export function useAttentionHoverCard(
  props: AttentionCardCounts & AttentionCardOptions & {
    /**
     * The portal element's class. `attention-card` at the sidebar's layer;
     * a surface inside a window that opens its own stacking context appends
     * that window's escape class to lift the card above it — the Star Map's
     * chip passes `attention-card star-map-card__tooltip`, the same escape
     * its thread-card tooltips use.
     */
    className?: string;
    /** An enterable card: see `useViewportTooltip`'s `interactive`. */
    interactive?: Parameters<typeof useViewportTooltip>[0]["interactive"];
  },
): {
  card: ReactNode;
  tooltip: ReturnType<typeof useViewportTooltip>;
} {
  const tooltip = useViewportTooltip({
    className: props.className ?? "attention-card",
    interactive: props.interactive,
  });
  const { activeLocal, activeRemote, review, unknownLocal, unknownRemote, unknownReview, title, caption, reviewLabel, footer } =
    props;
  const selectedScope = props.scopes?.selected;
  // Held by ref so a host that passes a fresh callback each render does not
  // rebuild the card (and push it into an open portal) on every render.
  const onSelectScopeRef = useRef(props.scopes?.onSelect);
  onSelectScopeRef.current = props.scopes?.onSelect;
  const pickable = props.scopes !== undefined;
  // Built only when its data moves, not on every render of a host that
  // re-renders per streamed item (the tab) or per pan frame (the map chip):
  // the element is inert until hover, and the memo key below is also what
  // decides whether an open card is pushed fresh content.
  const card = useMemo(
    () => (
      <AttentionCard
        activeLocal={activeLocal}
        activeRemote={activeRemote}
        review={review}
        unknownLocal={unknownLocal}
        unknownRemote={unknownRemote}
        unknownReview={unknownReview}
        title={title}
        caption={caption}
        reviewLabel={reviewLabel}
        footer={footer}
        scopes={pickable ? {
          selected: selectedScope,
          onSelect: (scope) => onSelectScopeRef.current?.(scope),
        } : undefined}
      />
    ),
    [activeLocal, activeRemote, review, unknownLocal, unknownRemote, unknownReview, title, caption, reviewLabel, footer,
      pickable, selectedScope],
  );
  const pushedCardRef = useRef<ReactNode>(undefined);
  const tooltipVisible = tooltip.visible;
  const updateTooltip = tooltip.update;
  useEffect(() => {
    const moved = pushedCardRef.current !== card;
    pushedCardRef.current = card;
    if (!moved || !tooltipVisible) {
      return;
    }
    updateTooltip(card);
  }, [card, tooltipVisible, updateTooltip]);
  return { card, tooltip };
}
