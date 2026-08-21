import type { MouseEvent, ReactNode } from "react";

/**
 * One mark and the number it counts: "two turns running here", "seven threads
 * to review", "one sub-agent working".
 *
 * The app says this same thing on five surfaces — the sidebar's Attention tab,
 * the Star Map's Attention chip, the directory header counts, the active
 * sub-agents strip and the running-automations strip — and they had drifted
 * into three different renderings visible at once: the tab drew mark-then-count
 * in mono, the directory headers drew count-then-mark, and the strips drew the
 * count inside a bordered pill with no mark at all. An operator reading a
 * window has to learn one shape, not three.
 *
 * The Attention tab is the shape they all take now: the mark first, because it
 * is what says WHICH number this is, then the digits. Mono and tabular so a
 * count changing from 9 to 10 does not shove the mark, and so a column of them
 * lines up.
 *
 * Tone carries where the work is, and only that:
 * - `active` — accent. Running on this machine; quitting interrupts it.
 * - `remote-active` — neutral. Running on another instance; quitting does not.
 * - `idle` — secondary. Nothing is running behind this number (threads waiting
 *   to be reviewed, a strip holding only failures).
 *
 * See `isThreadRemoteWorkHere` for the predicate that picks between the first
 * two, and `AttentionSignals.tsx` for the Attention-specific readouts built on
 * this.
 */
export type SignalCountTone = "active" | "remote-active" | "idle";

export function SignalCount(props: {
  count: number;
  /**
   * The mark. Callers pass it rather than deriving it from the tone because
   * "is anything running?" is not always "is the count zero?" — the strips
   * count failures too, and draw a dormant bar beside a non-zero number when
   * none of them are working.
   */
  indicator: ReactNode;
  tone: SignalCountTone;
  /**
   * Hides the pair from the accessibility tree. The Attention readouts do
   * this because their control's `aria-label` already spells every count
   * out; the directory counts do not, because their digits ARE the
   * announcement.
   */
  ariaHidden?: boolean;
  className?: string;
  /**
   * Extra `data-*` hooks, spread verbatim onto the wrapper. Keys are typed
   * to the `data-` prefix rather than left open: the spread lands after this
   * component's own attributes, so an open record could silently replace the
   * computed class or the zero state.
   */
  data?: Record<`data-${string}`, number | string | undefined>;
  /**
   * A count with no words has to be able to explain itself. The directory
   * rail hangs a `useViewportTooltip` off these; the Attention readouts
   * leave them unset because their control owns the hover card.
   */
  onMouseEnter?: (event: MouseEvent<HTMLSpanElement>) => void;
  onMouseLeave?: () => void;
}) {
  return (
    <span
      aria-hidden={props.ariaHidden ? "true" : undefined}
      className={`signal-count signal-count--${props.tone}${
        props.className ? ` ${props.className}` : ""
      }`}
      // A zero is drawn, never hidden — an idle surface has to read as
      // "nothing here", which a vanishing count cannot do. Kept as an
      // attribute rather than folded into the class: the grey also has to
      // reach the orange cookie, which paints itself from accent tokens
      // rather than `currentColor`, and an attribute selector is what the
      // cookie rule already keys off.
      data-zero={props.count === 0 ? "true" : undefined}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      {...props.data}
    >
      {props.indicator}
      <span className="signal-count__value">{props.count}</span>
    </span>
  );
}
