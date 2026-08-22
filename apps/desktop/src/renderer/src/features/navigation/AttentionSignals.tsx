import { useEffect, useMemo, useRef, type ReactNode } from "react";
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
}) {
  return (
    <span aria-hidden="true" className="signal-count-stack">
      <SignalCount
        count={props.activeLocal}
        data={{ "data-attention-active-count": props.activeLocal }}
        indicator={<AttentionTurnScanner count={props.activeLocal} />}
        tone="active"
      />
      {props.activeRemote === undefined ? null : (
        <SignalCount
          count={props.activeRemote}
          data={{ "data-attention-remote-active-count": props.activeRemote }}
          indicator={<AttentionTurnScanner count={props.activeRemote} />}
          tone="remote-active"
        />
      )}
    </span>
  );
}

/** The orange cookie and its count: threads waiting to be looked at. */
export function AttentionReviewReadout(props: { count: number }) {
  return (
    <SignalCount
      ariaHidden
      count={props.count}
      data={{ "data-attention-review-count": props.count }}
      indicator={<span className="thread-row__status-cookie" />}
      tone="idle"
    />
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
  indicator: "turn" | "remote-turn" | "review";
  label: string;
  /** What quitting does to this row's work. Omitted when nothing is at stake. */
  note?: string;
}) {
  return (
    <div
      className="attention-card__row"
      data-zero={props.count === 0 ? "true" : undefined}
    >
      <span
        aria-hidden="true"
        className={`signal-count signal-count--${
          props.indicator === "review"
            ? "idle"
            : props.indicator === "remote-turn"
              ? "remote-active"
              : "active"
        }`}
        data-zero={props.count === 0 ? "true" : undefined}
      >
        {props.indicator === "review" ? (
          <span className="thread-row__status-cookie" />
        ) : (
          <AttentionTurnScanner count={props.count} />
        )}
      </span>
      <span className="attention-card__row-text">
        <span className="attention-card__row-label">{props.label}</span>
        {props.note ? (
          <span className="attention-card__row-note">{props.note}</span>
        ) : null}
      </span>
      <span className="attention-card__row-value">{props.count}</span>
    </div>
  );
}

export type AttentionCardCounts = {
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
};

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
  return (
    <>
      <div className="attention-card__eyebrow">{props.title}</div>
      <div className="attention-card__caption">{props.caption}</div>
      <div className="attention-card__section">
        <AttentionCardRow
          count={props.activeLocal}
          indicator="turn"
          // Only qualify the row once there is something to tell it apart
          // from.
          label={activeRemote === undefined ? "In progress" : "In progress here"}
          note={
            activeRemote === undefined ? undefined : "Quitting interrupts these"
          }
        />
        {activeRemote === undefined ? null : (
          <AttentionCardRow
            count={activeRemote}
            indicator="remote-turn"
            label="In progress elsewhere"
            note="Quitting leaves these running"
          />
        )}
        <AttentionCardRow
          count={props.review}
          indicator="review"
          label={props.reviewLabel}
        />
      </div>
      {props.footer ? (
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
): string {
  return [
    ...(counts.activeRemote === undefined
      ? [formatActiveThreadCount(counts.activeLocal)]
      : [
        formatLocalActiveThreadCount(counts.activeLocal),
        formatRemoteActiveThreadCount(counts.activeRemote),
      ]),
    formatReviewCount(counts.review),
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
  },
): {
  card: ReactNode;
  tooltip: ReturnType<typeof useViewportTooltip>;
} {
  const tooltip = useViewportTooltip({
    className: props.className ?? "attention-card",
  });
  const { activeLocal, activeRemote, review, title, caption, reviewLabel, footer } =
    props;
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
        title={title}
        caption={caption}
        reviewLabel={reviewLabel}
        footer={footer}
      />
    ),
    [activeLocal, activeRemote, review, title, caption, reviewLabel, footer],
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
