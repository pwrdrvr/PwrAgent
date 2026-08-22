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
/** How many times a card steps off an exact stack before giving up. */
const CHAT_CARD_NUDGE_LIMIT = 8;

/**
 * Where a chat card opens: beside the card it belongs to.
 *
 * Chat cards live IN the map — they pan and zoom with the galaxy and hold
 * their place in it — so a card opens next to its thread rather than
 * cascading from a corner of the window. Opening beside the source is
 * most of what makes the pairing legible; the tether drawn between them
 * says the rest.
 *
 * Prefers the right of the anchor and falls back to its left when that
 * would leave the canvas. It deliberately does NOT hunt for free space:
 * being next to its thread beats being tidy, and an overlap is the
 * operator's to resolve by dragging the card wherever they want it. The
 * only avoidance left is against a card opened at the very same spot,
 * which would hide the older one completely.
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
    const stacked = params.occupied.some(
      (other) =>
        Math.abs(other.left - candidate.left) < CHAT_CARD_CASCADE_STEP
        && Math.abs(other.top - candidate.top) < CHAT_CARD_CASCADE_STEP,
    );
    if (!stacked) break;
    candidate = clampChatCardRect(
      {
        left: candidate.left + CHAT_CARD_CASCADE_STEP,
        top: candidate.top + CHAT_CARD_CASCADE_STEP,
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

type Point = { x: number; y: number };

function quadraticPointAt(
  from: Point,
  control: Point,
  to: Point,
  t: number,
): Point {
  const u = 1 - t;
  return {
    x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * control.y + t * t * to.y,
  };
}

/**
 * Where a tether surfaces from under the thread card it belongs to.
 *
 * The tether is a quadratic arc from the chat card's edge to the thread
 * card's CENTRE, painted underneath the cards. Aiming at the centre keeps
 * the line pointing at the card however the pair is arranged; painting it
 * underneath hides the stretch that would otherwise cross the card's
 * text. What the eye then needs is a mark at the point where the line
 * comes out from under the card, so the pairing reads edge-to-edge.
 *
 * Walked along the arc from the centre outward rather than intersected
 * with the chord: the arc bows, so the straight-line exit would put the
 * dot beside the line instead of on it. `margin` inflates the rect so the
 * dot (radius plus the card's border) sits fully clear of the card instead
 * of half under it. Returns nothing when the arc never leaves the inflated
 * rect — the chat card sits on top of its own thread card, and a dot
 * under the chat would be invisible anyway.
 */
export function tetherExitPoint(args: {
  from: Point;
  control: Point;
  to: Point;
  rect: ChatCardRect;
  margin: number;
}): Point | undefined {
  const { from, control, to, rect, margin } = args;
  const left = rect.left - margin;
  const top = rect.top - margin;
  const right = rect.left + rect.width + margin;
  const bottom = rect.top + rect.height + margin;
  const inside = (point: Point): boolean =>
    point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
  if (!inside(to)) return to;
  const STEPS = 128;
  let insideT = 1;
  let firstOutsideT: number | undefined;
  for (let step = STEPS - 1; step >= 0; step -= 1) {
    const t = step / STEPS;
    if (inside(quadraticPointAt(from, control, to, t))) {
      insideT = t;
    } else {
      firstOutsideT = t;
      break;
    }
  }
  if (firstOutsideT === undefined) return undefined;
  // Bisect the crossing so the dot lands on the edge, not up to one step
  // past it.
  let outsideT: number = firstOutsideT;
  for (let i = 0; i < 16; i += 1) {
    const mid = (insideT + outsideT) / 2;
    if (inside(quadraticPointAt(from, control, to, mid))) {
      insideT = mid;
    } else {
      outsideT = mid;
    }
  }
  return quadraticPointAt(from, control, to, outsideT);
}

/** Gap between a chat card and a satellite docked to it. */
export const CHAT_CARD_DOCK_GAP = 12;
/** Panel width inside the docked context card; the rail's own minimum. */
export const CHAT_CARD_CONTEXT_WIDTH = 300;
/**
 * The rail's always-visible tab spine, to the right of its panel. The
 * card has to be panel + spine wide: the panel sizes itself from a CSS
 * var (`--context-rail-effective`) that nothing inside a card defines,
 * so its 380px fallback overflowed a panel-only card and left the
 * misfit as a blank strip on the card's left edge.
 */
export const CHAT_CARD_CONTEXT_SPINE_WIDTH = 48;
/** Default height of the docked terminal card. */
export const CHAT_CARD_TERMINAL_HEIGHT = 260;

/**
 * Where a chat card's context satellite docks: on the host's right edge,
 * top-aligned, matching its height — the same posture the rail has in the
 * full thread view, as its own card instead of a pane inside the host.
 */
export function dockContextRect(host: ChatCardRect): ChatCardRect {
  return {
    left: host.left + host.width + CHAT_CARD_DOCK_GAP,
    top: host.top,
    width: CHAT_CARD_CONTEXT_WIDTH + CHAT_CARD_CONTEXT_SPINE_WIDTH,
    height: host.height,
  };
}

/**
 * Where a chat card's terminal satellite docks: under the host, spanning
 * the whole group — host plus context card when that is open — so the
 * group reads as one object with a work surface along its bottom edge.
 */
export function dockTerminalRect(
  host: ChatCardRect,
  options?: { contextOpen?: boolean; height?: number },
): ChatCardRect {
  const width = options?.contextOpen
    ? host.width
      + CHAT_CARD_DOCK_GAP
      + CHAT_CARD_CONTEXT_WIDTH
      + CHAT_CARD_CONTEXT_SPINE_WIDTH
    : host.width;
  return {
    left: host.left,
    top: host.top + host.height + CHAT_CARD_DOCK_GAP,
    width,
    height: options?.height ?? CHAT_CARD_TERMINAL_HEIGHT,
  };
}

/** Compound bounds used when a chat group aligns or spaces against another
 * object. Satellites occupy real map space even though their positions derive
 * from the host, so snapping only the host would invite another card to land
 * underneath an open context rail or terminal. */
export function chatCardGroupRect(
  host: ChatCardRect,
  options?: {
    contextOpen?: boolean;
    terminalOpen?: boolean;
    terminalHeight?: number;
  },
): ChatCardRect {
  const context = options?.contextOpen ? dockContextRect(host) : undefined;
  const terminal = options?.terminalOpen
    ? dockTerminalRect(host, {
        contextOpen: options.contextOpen,
        height: options.terminalHeight,
      })
    : undefined;
  const right = Math.max(
    host.left + host.width,
    context ? context.left + context.width : Number.NEGATIVE_INFINITY,
    terminal ? terminal.left + terminal.width : Number.NEGATIVE_INFINITY,
  );
  const bottom = Math.max(
    host.top + host.height,
    context ? context.top + context.height : Number.NEGATIVE_INFINITY,
    terminal ? terminal.top + terminal.height : Number.NEGATIVE_INFINITY,
  );
  return {
    left: host.left,
    top: host.top,
    width: right - host.left,
    height: bottom - host.top,
  };
}
