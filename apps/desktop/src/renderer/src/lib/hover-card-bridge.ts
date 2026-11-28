import { type AimPoint, POINTER_AIM_TRAIL, pointerAimsAtRect } from "./pointer-aim";
import type { TooltipRect } from "./tooltip-placement";
import { HOVER_TRANSITION_GRACE_MS } from "./useHoverTransitionGrace";

/**
 * How long the pointer must rest on another trigger, while a card is up and
 * the pointer is not heading for it, before that trigger's card takes over.
 * Shorter than a first hover delay, so a deliberate move down a column of
 * chips still swaps quickly; long enough that sliding across a chip does not.
 */
export const HOVER_CARD_SWAP_REST_MS = 150;

/**
 * Pointer samples further apart than this say nothing about where it is
 * heading: it rested in between, so the next move starts a new path.
 */
const POINTER_AIM_STALE_MS = 100;

/** A hover card the bridge can close. */
export type BridgedHoverCard = {
  hide: () => void;
  isPinned?: () => boolean;
  /**
   * Whether `trigger` lies inside what this card is about, such as a PR chip
   * on the thread row whose card is up. The pointer crosses those on its way
   * to the card, so entering one never swaps this card early; its own card
   * still opens after the usual hover delay.
   */
  holds?: (trigger: Element) => boolean;
  /**
   * Where the card is on screen, while it is up. Lets the bridge tell a
   * pointer heading for the card from one moving on: a trigger crossed on
   * the way (the safe triangle, `pointerAimsAtRect`) is not a destination.
   */
  getRect?: () => TooltipRect | undefined;
};

type Timers = {
  set: (callback: () => void, ms: number) => number;
  clear: (id: number) => void;
};

const windowTimers: Timers = {
  set: (callback, ms) => window.setTimeout(callback, ms),
  clear: (id) => window.clearTimeout(id),
};

type TimedPoint = AimPoint & { at: number };

/**
 * One owner for the sidebar's enterable cards, so a pointer can reach a card
 * across the chips and rows between it and its trigger.
 *
 * - At most one card is visible. A card that shows closes the other.
 * - Entering another trigger never closes the visible card by itself. That
 *   trigger's card waits: its full hover delay while the pointer heads for
 *   the visible card (it is only passing), or `HOVER_CARD_SWAP_REST_MS` of
 *   rest otherwise, so a deliberate sweep across chips still swaps quickly.
 * - Leaving a chip or its card keeps the card for `graceMs`: the bridge
 *   between them. Each move that still heads for the card renews it, and
 *   reaching the card holds it there.
 * - A pinned card holds its place until dismissed or another card is
 *   deliberately pinned.
 */
export class HoverCardBridge {
  private visible: BridgedHoverCard | undefined;
  private delayed: BridgedHoverCard | undefined;
  private graceTimer: number | undefined;
  private readonly trail: TimedPoint[] = [];

  constructor(
    private readonly graceMs: number = HOVER_TRANSITION_GRACE_MS,
    private readonly timers: Timers = windowTimers,
    private readonly swapRestMs: number = HOVER_CARD_SWAP_REST_MS,
  ) {}

  /**
   * The pointer entered `card`'s trigger. Returns how long to wait before
   * showing it: 0 when it is the visible card already, `hoverDelayMs` when no
   * card is up or the pointer is only passing on its way to the visible one,
   * and the shorter swap rest when the pointer has moved on from it. Never
   * closes the visible card itself: the card that shows does. `trigger` is
   * the element entered, which the visible card may hold.
   */
  enterTrigger(card: BridgedHoverCard, trigger: Element | undefined, hoverDelayMs: number): number {
    const current = this.visible;
    if (current === card) {
      this.cancelGrace();
      return 0;
    }
    if (!current || current.isPinned?.()) return hoverDelayMs;
    if (trigger && current.holds?.(trigger)) return hoverDelayMs;
    if (this.aimsAt(current)) return hoverDelayMs;
    return Math.min(this.swapRestMs, hoverDelayMs);
  }

  /**
   * The pointer moved (`at` is the event's timestamp). While the pointer is
   * between the visible card and its trigger, a move that still heads for
   * the card renews the grace, so a long way across the sidebar or a slow
   * hand does not lose it.
   */
  pointerMoved(point: AimPoint, at: number): void {
    this.trail.push({ x: point.x, y: point.y, at });
    if (this.trail.length > POINTER_AIM_TRAIL) this.trail.shift();
    const card = this.visible;
    if (card && this.graceTimer !== undefined && this.aimsAt(card)) this.leaveTrigger(card);
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
   * move back to its chip keeps it and a move onto another chip swaps once
   * the pointer rests there.
   */
  leaveCard(card: BridgedHoverCard): void {
    this.leaveTrigger(card);
  }

  /** Whether the pointer's latest move heads for `card` (the safe triangle). */
  private aimsAt(card: BridgedHoverCard): boolean {
    const from = this.trail[0];
    const to = this.trail[this.trail.length - 1];
    if (!from || !to || to.at - from.at > POINTER_AIM_STALE_MS) return false;
    const rect = card.getRect?.();
    return Boolean(rect && rect.right > rect.left && pointerAimsAtRect(from, to, rect));
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

/** An on-screen element's box, for `BridgedHoverCard.getRect`. */
export function elementRect(element: HTMLElement | null): TooltipRect | undefined {
  return element?.getBoundingClientRect();
}

/** The sidebar's enterable cards (PR chips, project headers) share one bridge. */
export const sidebarPrCardBridge = new HoverCardBridge();

// The bridge reads where the pointer is heading from these. Captured on the
// document so a move into a trigger is recorded before the trigger's own
// handlers ask the bridge about it.
if (typeof document !== "undefined") {
  const track = (event: MouseEvent): void => {
    sidebarPrCardBridge.pointerMoved({ x: event.clientX, y: event.clientY }, event.timeStamp);
  };
  document.addEventListener("mousemove", track, { capture: true, passive: true });
  document.addEventListener("mouseover", track, { capture: true, passive: true });
}
