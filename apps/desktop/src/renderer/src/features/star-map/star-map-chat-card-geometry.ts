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
