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

function isTabStop(el: HTMLElement): boolean {
  if (el.tabIndex < 0 || el.hidden) return false;
  if (el.hasAttribute("disabled") || el.closest("[inert]") !== null) return false;
  for (let node: HTMLElement | null = el; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

export function documentTabStops(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(TABBABLE)].filter(isTabStop);
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
  const stops = documentTabStops();
  if (stops.length === 0) return event;
  const active = document.activeElement as HTMLElement | null;
  const at = active === null ? -1 : stops.indexOf(active);
  let next: HTMLElement;
  if (at !== -1) {
    next = stops[(at + (shift ? -1 : 1) + stops.length) % stops.length]!;
  } else if (active === null || active === document.body) {
    next = shift ? stops.at(-1)! : stops[0]!;
  } else if (shift) {
    // Focus on something that is not a stop (a tabIndex={-1} container):
    // Chromium continues from its position in the document. Its descendants
    // follow it, and its ancestors do not precede it.
    next = stops
      .filter((stop) =>
        Boolean(active.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_PRECEDING)
        && !stop.contains(active))
      .at(-1) ?? stops.at(-1)!;
  } else {
    next = stops.find((stop) =>
      Boolean(active.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING))
      ?? stops[0]!;
  }
  act(() => {
    next.focus();
  });
  return event;
}

export function pressEscape(): KeyboardEvent {
  return keydown("Escape", false);
}

/**
 * Presses Tab `count` times and returns every element focus visited, in
 * order. 60 is the walk the headless-Chromium check uses.
 */
export function walkTab(
  count = 60,
  { shift = false }: { shift?: boolean } = {},
): Element[] {
  const visited: Element[] = [];
  for (let i = 0; i < count; i++) {
    pressTab({ shift });
    visited.push(document.activeElement ?? document.body);
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
 * Walks `count` Tabs forward from the current focus, then `count` back, with
 * sentinels around the page, and names every stop outside `dialog` that focus
 * reached. A trapped dialog answers `{ forward: [], backward: [] }`.
 */
export function tabEscapes(
  dialog: Element,
  count = 60,
): { forward: string[]; backward: string[] } {
  const sentinels = addTabSentinels();
  try {
    const outside = (visited: Element[]) =>
      visited.filter((el) => !dialog.contains(el)).map(describeStop);
    const forward = outside(walkTab(count));
    const backward = outside(walkTab(count, { shift: true }));
    return { forward, backward };
  } finally {
    sentinels.remove();
  }
}
