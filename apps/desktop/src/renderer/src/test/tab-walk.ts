import { act } from "@testing-library/react";

/**
 * Tab and Escape as the operator presses them, for jsdom.
 *
 * jsdom dispatches a keydown but never runs sequential focus navigation, so a
 * test that only dispatches Tab cannot tell a trapped dialog from one that
 * lets focus walk out: in both, focus stays where it was. `pressTab`
 * dispatches the keydown on the focused element and, when no handler
 * prevented it, moves focus to the next tab stop in document order, wrapping
 * at the ends of the document, as Chromium does. It knows nothing of
 * Chromium's scroller stops, which need layout. The headless-Chromium check
 * covers those.
 */

const TABBABLE =
  "a[href],area[href],button,input,select,textarea,summary,iframe,object,embed,"
  + "[contenteditable],[tabindex]";

let visibilityWalk: {
  values: Map<HTMLElement, boolean>;
  observer: MutationObserver;
} | undefined;

function isTabStop(el: HTMLElement, styles: Map<HTMLElement, CSSStyleDeclaration>): boolean {
  if (el.tabIndex < 0 || el.hidden) return false;
  if (el.hasAttribute("disabled") || el.closest("[inert]") !== null) return false;
  // Without author styles, focus alone cannot change display/visibility.
  // Inline and UA visibility changes have DOM attributes; invalidate those
  // synchronously, before choosing the next stop, even within one Tab walk.
  const walk = visibilityWalk;
  const cache = walk && document.styleSheets.length === 0
    && (document.adoptedStyleSheets?.length ?? 0) === 0 ? walk.values : undefined;
  if (walk?.observer.takeRecords().length) walk.values.clear();
  const cached = cache?.get(el);
  if (cached !== undefined) return cached;
  for (let node: HTMLElement | null = el; node !== null; node = node.parentElement) {
    let style = styles.get(node);
    if (!style) {
      style = getComputedStyle(node);
      styles.set(node, style);
    }
    if (style.display === "none" || style.visibility === "hidden") {
      cache?.set(el, false);
      return false;
    }
  }
  cache?.set(el, true);
  return true;
}

export function documentTabStops(): HTMLElement[] {
  const styles = new Map<HTMLElement, CSSStyleDeclaration>();
  return [...document.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => isTabStop(el, styles));
}

function keydown(key: string, shiftKey: boolean): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  const target = document.activeElement ?? document.body;
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

export function pressTab({ shift = false }: { shift?: boolean } = {}): KeyboardEvent {
  const event = keydown("Tab", shift);
  if (event.defaultPrevented) return event;
  // Cache only within this keypress, after key handlers have committed
  // visibility changes. The next stop does not need a whole-page selector scan.
  const styles = new Map<HTMLElement, CSSStyleDeclaration>();
  const root = document.body;
  const active = document.activeElement as HTMLElement | null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  walker.currentNode = active && root.contains(active) ? active : root;
  let wrapping = false;
  const accepts = (node: Node): node is HTMLElement => {
    const el = node as HTMLElement;
    // A negative-tabindex container gives an origin, but its ancestors are
    // not earlier stops when walking backwards from that origin.
    return !(shift && !wrapping && active && active.tabIndex < 0 && el.contains(active))
      && el.matches(TABBABLE) && isTabStop(el, styles);
  };
  const seek = (): HTMLElement | undefined => {
    for (let node = shift ? walker.previousNode() : walker.nextNode(); node;
      node = shift ? walker.previousNode() : walker.nextNode()) {
      if (accepts(node)) return node;
    }
    return undefined;
  };
  let next = seek();
  if (!next) {
    wrapping = true;
    if (shift) {
      let last: Element = root;
      while (last.lastElementChild) last = last.lastElementChild;
      walker.currentNode = last;
      next = accepts(last) ? last : seek();
    } else {
      walker.currentNode = root;
      next = accepts(root) ? root : seek();
    }
  }
  if (next === undefined) return event;
  act(() => {
    next.focus();
  });
  return event;
}

export function pressEscape(): KeyboardEvent {
  return keydown("Escape", false);
}

/**
 * Any other key, dispatched on the focused element. Unlike `pressTab`, it
 * moves nothing itself: for an arrow or Home in a menu, the handler under
 * test is the only thing that can move focus.
 */
export function pressKey(key: string): KeyboardEvent {
  return keydown(key, false);
}

/**
 * Presses Tab `count` times and returns every element focus visited, in
 * order. 60 is the walk the headless-Chromium check uses.
 */
export function walkTab(
  count = 60,
  { shift = false, stopAtCycle = false }: { shift?: boolean; stopAtCycle?: boolean } = {},
): Element[] {
  const visited: Element[] = [];
  const seen = stopAtCycle ? new Set([document.activeElement ?? document.body]) : undefined;
  const previous = visibilityWalk;
  const values = new Map<HTMLElement, boolean>();
  const observer = new MutationObserver(() => values.clear());
  observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["style", "hidden", "open", "type"],
  });
  visibilityWalk = { values, observer };
  try {
    for (let i = 0; i < count; i++) {
      pressTab({ shift });
      const active = document.activeElement ?? document.body;
      visited.push(active);
      if (seen?.has(active)) break;
      seen?.add(active);
    }
  } finally {
    observer.disconnect();
    visibilityWalk = previous;
  }
  return visited;
}

/**
 * Two buttons around everything a test renders: one first in `<body>`, one
 * appended last (after any portal that mounted before this call). A walk
 * that reaches either has left the dialog.
 */
export function addTabSentinels(): {
  before: HTMLButtonElement;
  after: HTMLButtonElement;
  remove: () => void;
} {
  const before = document.createElement("button");
  before.textContent = "Before the dialog";
  const after = document.createElement("button");
  after.textContent = "After the dialog";
  document.body.prepend(before);
  document.body.append(after);
  return {
    before,
    after,
    remove: () => {
      before.remove();
      after.remove();
    },
  };
}

function describeStop(el: Element): string {
  const label = el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "";
  return `${el.tagName.toLowerCase()} "${label.slice(0, 40)}"`;
}

/**
 * Walks a complete focus cycle in each direction, up to `count` Tabs, with
 * sentinels around the page, and names every stop outside `dialog` that focus
 * reached. Repeating an already visited cycle adds no coverage. A trapped
 * dialog answers `{ forward: [], backward: [] }`.
 */
export function tabEscapes(
  dialog: Element,
  count = 60,
): { forward: string[]; backward: string[] } {
  const sentinels = addTabSentinels();
  try {
    const outside = (visited: Element[]) =>
      visited.filter((el) => !dialog.contains(el)).map(describeStop);
    const forward = outside(walkTab(count, { stopAtCycle: true }));
    const backward = outside(walkTab(count, { shift: true, stopAtCycle: true }));
    return { forward, backward };
  } finally {
    sentinels.remove();
  }
}
