import { HOVER_TRANSITION_GRACE_MS } from "./useHoverTransitionGrace";

/** A hover card the bridge can close. */
export type BridgedHoverCard = {
  hide: () => void;
  isPinned?: () => boolean;
  /**
   * Whether `trigger` lies inside what this card is about, such as a PR chip
   * on the thread row whose card is up. The pointer crosses those on its way
   * to the card, so entering one neither closes this card nor opens its own
   * at once; its own card still opens after the usual hover delay.
   */
  holds?: (trigger: Element) => boolean;
};

type Timers = {
  set: (callback: () => void, ms: number) => number;
  clear: (id: number) => void;
};

const windowTimers: Timers = {
  set: (callback, ms) => window.setTimeout(callback, ms),
  clear: (id) => window.clearTimeout(id),
};

/**
 * One owner for the sidebar's enterable PR cards, so a pointer can reach a
 * card without slowing a sweep across chips.
 *
 * - At most one card is visible.
 * - Leaving a chip or its card keeps the card for `graceMs`: the bridge
 *   between them. Reaching the card holds it there.
 * - Entering any chip while a card is visible closes that card at once and
 *   shows the new one without the hover delay. A pinned card holds its place
 *   until dismissed or another card is deliberately pinned.
 */
export class HoverCardBridge {
  private visible: BridgedHoverCard | undefined;
  private delayed: BridgedHoverCard | undefined;
  private graceTimer: number | undefined;

  constructor(
    private readonly graceMs: number = HOVER_TRANSITION_GRACE_MS,
    private readonly timers: Timers = windowTimers,
  ) {}

  /**
   * The pointer entered `card`'s chip. True when it should show at once:
   * a card was already visible, this one included. `trigger` is the chip,
   * which the visible card may hold (`BridgedHoverCard.holds`).
   */
  enterTrigger(card: BridgedHoverCard, trigger?: Element): boolean {
    const current = this.visible;
    if (!current || (current !== card && current.isPinned?.())) return false;
    if (current !== card && trigger && current.holds?.(trigger)) return false;
    this.cancelGrace();
    if (current !== card) {
      this.visible = undefined;
      current.hide();
    }
    return true;
  }

  /**
   * `card` waits out its hover delay. A card that shows meanwhile (a chip's,
   * on the way to it) is where the pointer rests: it cancels `card`.
   */
  delaying(card: BridgedHoverCard): void {
    this.delayed = card;
  }

  hasPinnedCard(): boolean {
    return this.visible?.isPinned?.() === true;
  }

  /** `card` became visible; any other closes. */
  shown(card: BridgedHoverCard): void {
    const current = this.visible;
    if (current === card) return;
    if (current?.isPinned?.() && !card.isPinned?.()) {
      card.hide();
      return;
    }
    this.cancelGrace();
    this.visible = card;
    current?.hide();
    const delayed = this.delayed;
    this.delayed = undefined;
    if (delayed && delayed !== card) delayed.hide();
  }

  /** `card` closed for its own reasons (blur, scroll, Escape). */
  hidden(card: BridgedHoverCard): void {
    if (this.visible !== card) return;
    this.cancelGrace();
    this.visible = undefined;
  }

  /** The pointer left `card`'s chip: bridge to the card for a moment. */
  leaveTrigger(card: BridgedHoverCard): void {
    if (this.visible !== card) return;
    this.cancelGrace();
    this.graceTimer = this.timers.set(() => {
      this.graceTimer = undefined;
      this.close(card);
    }, this.graceMs);
  }

  /** The pointer reached `card`: it stays until the pointer leaves it. */
  enterCard(card: BridgedHoverCard): void {
    if (this.visible === card) this.cancelGrace();
  }

  /**
   * The pointer left `card` itself. It gets the same bridge as a chip, so a
   * move back to its chip keeps it and a move onto another chip still swaps
   * at once.
   */
  leaveCard(card: BridgedHoverCard): void {
    this.leaveTrigger(card);
  }

  private close(card: BridgedHoverCard): void {
    if (this.visible !== card) return;
    this.cancelGrace();
    this.visible = undefined;
    card.hide();
  }

  private cancelGrace(): void {
    if (this.graceTimer === undefined) return;
    this.timers.clear(this.graceTimer);
    this.graceTimer = undefined;
  }
}

/**
 * The region a sidebar card opens beside. A name in the project index lane
 * opens past the lane, over the thread list beside it; past the whole sidebar
 * it would land over the transcript, a list's width from the name. Anything
 * else in the sidebar opens past the sidebar, clear of its rows.
 */
function hoverCardRegion(target: HTMLElement): Element | null {
  return target.closest(".project-index-pane") ?? target.closest(".sidebar");
}

/** The trigger's region, so a card opens past its edge rather than over its rows. */
export function sidebarAnchorRect(target: HTMLElement): DOMRect {
  return (hoverCardRegion(target) ?? target).getBoundingClientRect();
}

/**
 * Whether the card sits clear of the trigger's region, where the pointer can
 * reach it without crossing other rows. A card that fell back over the rows
 * (a narrow window) does not qualify, and neither does one with no laid-out box.
 */
export function cardIsBesideSidebar(card: HTMLElement | null, target: HTMLElement): boolean {
  const region = hoverCardRegion(target);
  if (!card || !region) return false;
  const box = card.getBoundingClientRect();
  const edges = region.getBoundingClientRect();
  return box.width > 0 && (box.left >= edges.right || box.right <= edges.left);
}

/** The sidebar's enterable cards (PR chips, project headers) share one bridge. */
export const sidebarPrCardBridge = new HoverCardBridge();
