/**
 * Geometry for the star map's floating chat cards.
 *
 * Cards are windows *over* the star field, not objects *in* it: they do not
 * pan or zoom with the canvas, so every number here is in viewport pixels
 * and never passes through the canvas transform.
 */

export type ChatCardRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export const CHAT_CARD_DEFAULT_WIDTH = 420;
export const CHAT_CARD_DEFAULT_HEIGHT = 520;
export const CHAT_CARD_MIN_WIDTH = 320;
export const CHAT_CARD_MIN_HEIGHT = 280;

/** Diagonal offset between successively opened cards. */
export const CHAT_CARD_CASCADE_STEP = 28;
/** Cascade restarts after this many steps so cards never march off-screen. */
export const CHAT_CARD_CASCADE_WRAP = 6;

/**
 * How much of a card must stay on screen. Dragging a card mostly off the
 * edge is legitimate (park it, read the map behind it), but the title bar
 * has to remain grabbable or the card is stranded.
 */
const CHAT_CARD_MIN_VISIBLE_X = 120;
const CHAT_CARD_TITLE_BAR_HEIGHT = 34;

/**
 * Where the next card opens. Cascades from the top-left of the available
 * area so a stack of cards stays individually grabbable, wrapping back to
 * the origin rather than walking off the bottom-right corner.
 */
export function cascadeChatCardRect(params: {
  openCardCount: number;
  viewport: { width: number; height: number };
  origin?: { left: number; top: number };
}): ChatCardRect {
  const step = params.openCardCount % CHAT_CARD_CASCADE_WRAP;
  const origin = params.origin ?? { left: 72, top: 96 };
  const width = Math.min(CHAT_CARD_DEFAULT_WIDTH, params.viewport.width);
  const height = Math.min(CHAT_CARD_DEFAULT_HEIGHT, params.viewport.height);
  return clampChatCardRect(
    {
      left: origin.left + step * CHAT_CARD_CASCADE_STEP,
      top: origin.top + step * CHAT_CARD_CASCADE_STEP,
      width,
      height,
    },
    params.viewport,
  );
}

/**
 * Keeps a card reachable: at least `CHAT_CARD_MIN_VISIBLE_X` of its width
 * and its whole title bar stay inside the viewport. Applied on drag, on
 * open, and on window resize.
 */
export function clampChatCardRect(
  rect: ChatCardRect,
  viewport: { width: number; height: number },
): ChatCardRect {
  const width = Math.max(
    CHAT_CARD_MIN_WIDTH,
    Math.min(rect.width, Math.max(CHAT_CARD_MIN_WIDTH, viewport.width)),
  );
  const height = Math.max(
    CHAT_CARD_MIN_HEIGHT,
    Math.min(rect.height, Math.max(CHAT_CARD_MIN_HEIGHT, viewport.height)),
  );
  const minLeft = CHAT_CARD_MIN_VISIBLE_X - width;
  const maxLeft = Math.max(minLeft, viewport.width - CHAT_CARD_MIN_VISIBLE_X);
  const maxTop = Math.max(0, viewport.height - CHAT_CARD_TITLE_BAR_HEIGHT);
  return {
    left: Math.min(Math.max(rect.left, minLeft), maxLeft),
    top: Math.min(Math.max(rect.top, 0), maxTop),
    width,
    height,
  };
}

/**
 * Resize from the bottom-right grip. The card's origin is pinned, so this
 * only has to honor the minimums and stop the card from growing past the
 * viewport edge it is anchored against.
 */
export function resizeChatCardRect(params: {
  rect: ChatCardRect;
  deltaX: number;
  deltaY: number;
  viewport: { width: number; height: number };
}): ChatCardRect {
  const maxWidth = Math.max(
    CHAT_CARD_MIN_WIDTH,
    params.viewport.width - params.rect.left,
  );
  const maxHeight = Math.max(
    CHAT_CARD_MIN_HEIGHT,
    params.viewport.height - params.rect.top,
  );
  return {
    ...params.rect,
    width: Math.min(
      maxWidth,
      Math.max(CHAT_CARD_MIN_WIDTH, params.rect.width + params.deltaX),
    ),
    height: Math.min(
      maxHeight,
      Math.max(CHAT_CARD_MIN_HEIGHT, params.rect.height + params.deltaY),
    ),
  };
}

/**
 * Raises `key` to the top of the stack and returns the new order. Already
 * being on top is a no-op so a click on the focused card does not churn
 * React state on every mousedown.
 */
export function raiseChatCard(
  order: readonly string[],
  key: string,
): readonly string[] {
  if (order.length > 0 && order[order.length - 1] === key) return order;
  if (!order.includes(key)) return [...order, key];
  return [...order.filter((entry) => entry !== key), key];
}

/** Gap between a chat card and the thread card it belongs to. */
const CHAT_CARD_ANCHOR_GAP = 28;
/** How many times a card steps aside before it accepts an overlap. */
const CHAT_CARD_NUDGE_LIMIT = 8;

function rectsOverlap(a: ChatCardRect, b: ChatCardRect): boolean {
  return (
    a.left < b.left + b.width
    && b.left < a.left + a.width
    && a.top < b.top + b.height
    && b.top < a.top + a.height
  );
}

/**
 * Where a chat card opens: beside the card it belongs to.
 *
 * Chat cards live IN the map — they pan and zoom with the galaxy and hold
 * their place in it — so a card opens next to its thread rather than
 * cascading from a corner of the window. Opening beside the source is
 * most of what makes the pairing legible; the tether drawn between them
 * says the rest.
 *
 * Prefers the right of the anchor, falls back to its left when that would
 * leave the canvas, then steps diagonally clear of chat cards that are
 * already open.
 */
export function placeChatCardBesideAnchor(params: {
  /** The thread card, in canvas pixels. */
  anchor: { x: number; y: number; width: number; height: number };
  /** Chat cards already open, in canvas pixels. */
  occupied: readonly ChatCardRect[];
  /** Canvas extent, so a card cannot open somewhere unreachable. */
  bounds: { width: number; height: number };
  size?: { width: number; height: number };
}): ChatCardRect {
  const width = params.size?.width ?? CHAT_CARD_DEFAULT_WIDTH;
  const height = params.size?.height ?? CHAT_CARD_DEFAULT_HEIGHT;
  const rightOf = params.anchor.x + params.anchor.width + CHAT_CARD_ANCHOR_GAP;
  const leftOf = params.anchor.x - CHAT_CARD_ANCHOR_GAP - width;
  const left = rightOf + width <= params.bounds.width || leftOf < 0
    ? rightOf
    : leftOf;
  // Vertically centred on the anchor: the card reads as belonging to the
  // thread beside it rather than to whatever it happens to sit above.
  const top = params.anchor.y + params.anchor.height / 2 - height / 3;

  let candidate = clampChatCardRect({ left, top, width, height }, params.bounds);
  for (let nudge = 0; nudge < CHAT_CARD_NUDGE_LIMIT; nudge += 1) {
    const blocker = params.occupied.find((other) =>
      rectsOverlap(candidate, other),
    );
    if (!blocker) break;
    // Step clear of the whole blocker, not by a token offset: a cascade
    // step is a fraction of a card, so nudging by one leaves the new card
    // still on top of the old one.
    const below = blocker.top + blocker.height + CHAT_CARD_ANCHOR_GAP;
    candidate = clampChatCardRect(
      below + height <= params.bounds.height
        ? { left: candidate.left, top: below, width, height }
        : {
            left: blocker.left + blocker.width + CHAT_CARD_ANCHOR_GAP,
            top,
            width,
            height,
          },
      params.bounds,
    );
  }
  return candidate;
}

/**
 * Where a tether meets a chat card: the point on its border facing the
 * thread card, so the line stops at the edge instead of disappearing
 * under an opaque card.
 */
export function chatCardEdgeToward(
  rect: ChatCardRect,
  target: { x: number; y: number },
): { x: number; y: number } {
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const dx = target.x - centerX;
  const dy = target.y - centerY;
  if (dx === 0 && dy === 0) return { x: centerX, y: centerY };
  // Scale the direction until it lands on whichever border it crosses.
  const scaleX = dx === 0 ? Infinity : rect.width / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : rect.height / 2 / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: centerX + dx * scale, y: centerY + dy * scale };
}
