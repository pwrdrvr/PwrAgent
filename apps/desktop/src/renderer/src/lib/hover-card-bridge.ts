import { HOVER_TRANSITION_GRACE_MS } from "./useHoverTransitionGrace";

/** A hover card the bridge can close. */
export type BridgedHoverCard = { hide: () => void };

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
 * - Leaving a chip keeps its card for `graceMs`, the bridge to the card.
 *   Reaching the card holds it until the pointer leaves the card.
 * - Entering any chip while a card is visible closes that card at once and
 *   shows the new one without the hover delay.
 */
export class HoverCardBridge {
  private visible: BridgedHoverCard | undefined;
  private graceTimer: number | undefined;

  constructor(
    private readonly graceMs: number = HOVER_TRANSITION_GRACE_MS,
    private readonly timers: Timers = windowTimers,
  ) {}

  /**
   * The pointer entered `card`'s chip. True when it should show at once:
   * a card was already visible, this one included.
   */
  enterTrigger(card: BridgedHoverCard): boolean {
    const current = this.visible;
    if (!current) return false;
    this.cancelGrace();
    if (current !== card) {
      this.visible = undefined;
      current.hide();
    }
    return true;
  }

  /** `card` became visible; any other closes. */
  shown(card: BridgedHoverCard): void {
    const current = this.visible;
    if (current === card) return;
    this.cancelGrace();
    this.visible = card;
    current?.hide();
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

  /** The pointer left `card` itself. */
  leaveCard(card: BridgedHoverCard): void {
    this.close(card);
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

/** The sidebar's PR chips share one bridge. */
export const sidebarPrCardBridge = new HoverCardBridge();
