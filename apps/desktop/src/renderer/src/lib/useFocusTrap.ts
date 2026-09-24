import { useEffect, useRef, type RefObject } from "react";

/**
 * Everything tabbable, in DOM order. `tabindex="-1"` is filtered out below
 * on purpose: it means "focusable, but not a tab stop", which is what roving
 * items inside a dialog's own listbox or menu use.
 */
const TABBABLE =
  "a[href],area[href],button,input,select,textarea,summary,iframe,object,embed,"
  + "[contenteditable],[tabindex]";

/** A popup whose item can open a dialog, and whose trigger is the way back. */
const POPUP = '[role="menu"],[role="listbox"]';

/** A control that says it opened a popup that is showing now. */
const OPEN_POPUP_TRIGGER =
  '[aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"]';

/**
 * Chromium answers this directly. jsdom does not implement `checkVisibility`,
 * so the fallback reads the cascade instead, which jsdom does model. Using
 * `offsetParent` would make the trap match nothing under test while working
 * in the app, because jsdom does no layout and reports null for every node.
 *
 * `visibilityProperty` is not optional. `checkVisibility()` ignores
 * `visibility` by default, so a `visibility: hidden` button would answer true
 * in the app and sit in the trap's cycle, while the jsdom fallback correctly
 * excluded it. `opacity` is left out on purpose: a control faded to 0
 * mid-transition is still a real control.
 */
function visible(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === "function") {
    return el.checkVisibility({ visibilityProperty: true });
  }
  for (
    let node: HTMLElement | null = el;
    node !== null;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function isStop(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") {
    return false;
  }
  if (el.tabIndex < 0 || el.hidden) return false;
  return visible(el);
}

const SCROLLS = new Set(["auto", "scroll", "overlay"]);

/**
 * A scroller Chromium puts in the Tab order by itself so the arrow keys can
 * scroll it: one that overflows and holds nothing else to focus. Nothing in
 * the markup says so. It has no tabindex, and its `tabIndex` reads -1, so the
 * TABBABLE selector cannot see it.
 *
 * The trap has to, because it decides where the cycle ends. A trap blind to
 * these wraps straight past one that sits after a dialog's last control, and
 * the keyboard user can then never scroll it. The Markdown viewer's body
 * holding a long document is one; its old trap wrapped past it.
 *
 * The overflow test runs before `getComputedStyle` because it is the cheap
 * one. This walks every node in the dialog on each Tab, and a rendered
 * Markdown document can hold thousands. jsdom does no layout, so
 * `scrollHeight` is always 0 there and this never matches under test unless
 * the test supplies the geometry.
 */
function scrollsByKeyboard(el: HTMLElement): boolean {
  if (el.hasAttribute("tabindex")) return false; // judged as an ordinary stop
  const tall = el.scrollHeight > el.clientHeight;
  const wide = el.scrollWidth > el.clientWidth;
  if (!tall && !wide) return false;
  const style = getComputedStyle(el);
  return (tall && SCROLLS.has(style.overflowY))
    || (wide && SCROLLS.has(style.overflowX));
}

/**
 * The dialog's Tab stops, in document order.
 *
 * `scrollers: false` is for initial focus, which belongs on a control even
 * when a scroller comes first.
 */
function tabbable(
  root: HTMLElement | null,
  { scrollers = true }: { scrollers?: boolean } = {},
): HTMLElement[] {
  if (root === null) return [];
  if (!scrollers) {
    return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(isStop);
  }
  const all = [...root.querySelectorAll<HTMLElement>("*")];
  const stops = new Set(all.filter((el) => el.matches(TABBABLE) && isStop(el)));
  // Innermost first, as Chromium decides it: a scroller holding a stop, even
  // another scroller, is not a stop itself.
  const holders = [...stops];
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i]!;
    if (stops.has(el) || !scrollsByKeyboard(el) || !visible(el)) continue;
    if (holders.some((stop) => el.contains(stop))) continue;
    stops.add(el);
    holders.push(el);
  }
  return all.filter((el) => stops.has(el));
}

type Trap = { containerRef: RefObject<HTMLElement | null> };

/** Every trap currently open, in the order they opened. */
const openTraps: Trap[] = [];

function depth(el: HTMLElement): number {
  let n = 0;
  for (let node = el.parentElement; node !== null; node = node.parentElement) n++;
  return n;
}

/**
 * Which open trap answers this Tab. Only ever one.
 *
 * Every trap listens on `window`, and a trap that sees focus outside its own
 * container pulls it back in. With two open at once, each acting for itself,
 * they fought over every keypress. A Markdown link opened inside the Markdown
 * viewer portals a second viewer to `<body>`: the first viewer's trap saw
 * focus outside itself and dragged it to its own first control, the second's
 * saw the same and dragged it back, and Tab never left the second viewer's
 * first control.
 *
 * The trap holding focus wins, the deepest one when nested containers both
 * hold it. Only focus that is in none of them falls to the newest.
 */
function tabOwner(): Trap | undefined {
  const active = document.activeElement;
  let best: Trap | undefined;
  let bestDepth = -1;
  if (active !== null) {
    for (const trap of openTraps) {
      const root = trap.containerRef.current;
      if (root === null || !root.contains(active)) continue;
      const d = depth(root);
      // >= so a later-opened sibling at equal depth still wins.
      if (d >= bestDepth) {
        best = trap;
        bestDepth = d;
      }
    }
  }
  return best ?? openTraps[openTraps.length - 1];
}

/**
 * The trigger of the popup `el` sits in, if it is in one.
 *
 * A dialog opened from a menu item or a dropdown option captures that item as
 * its opener, and the popup removes the item as it closes, in the same commit
 * that mounts the dialog. The item is gone by the time the dialog closes, so
 * focus fell to `<body>`. The popup's trigger is where the operator was, and
 * it is what the ARIA menu and listbox patterns return focus to.
 */
function popupTrigger(el: HTMLElement): HTMLElement | null {
  const popup = el.closest<HTMLElement>(POPUP);
  if (popup === null) return null;
  if (popup.id) {
    // `aria-controls` is an id list, so match a token rather than the value.
    const controller = [
      ...document.querySelectorAll<HTMLElement>("[aria-controls]"),
    ].find((candidate) =>
      candidate.getAttribute("aria-controls")?.split(/\s+/).includes(popup.id),
    );
    if (controller !== undefined) return controller;
  }
  // The trigger usually shares a wrapper with the popup it opens. Look only
  // a few levels up: a wider search would find some unrelated open popup.
  let scope = popup.parentElement;
  for (let level = 0; scope !== null && level < 3; level++) {
    for (const candidate of scope.querySelectorAll<HTMLElement>(OPEN_POPUP_TRIGGER)) {
      if (!popup.contains(candidate)) return candidate;
    }
    scope = scope.parentElement;
  }
  return null;
}

/**
 * Keeps Tab inside an open modal and restores focus to whatever opened it.
 *
 * A modal that does not trap is a modal in name only. Tab walks out into the
 * page behind it, where a keyboard or screen-reader user then operates
 * controls they cannot see, with no way back (WCAG 2.1 SC 2.4.3).
 *
 * Escape belongs to `useDismissableLayer`. `useModalDialog` is the two
 * together, and a dialog should use that rather than this alone.
 */
export function useFocusTrap({
  open,
  containerRef,
  initialFocusRef,
  returnFocusRef,
  ownTabOrder = false,
}: {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  /** Where focus lands on open. Defaults to the first tabbable control. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Where focus returns on close once the opener has left the document,
   * ahead of `popupTrigger`'s guess. For a menu nothing marks as expanded:
   * the sidebar's context menu, which the ⋮ button or a right-click opens.
   * Read when the dialog opens.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /**
   * The dialog moves focus between its own controls on Tab. The jump palette
   * does: arrows steer its rows, and Tab visits only the active row's PR
   * chips. The trap still owns Tab against a trap beneath it and still pulls
   * stray focus back in, but leaves a Tab from inside to the dialog.
   */
  ownTabOrder?: boolean;
}): void {
  // The opener is captured during RENDER, not in the effect below.
  //
  // React applies `autoFocus` while committing, which is before passive
  // effects run. A dialog with an autoFocused field has already moved focus
  // inside itself by the time an effect could look, so the effect recorded
  // that field as the opener and restored nothing on close. Render runs
  // before commit, so this sees the real opener. The `typeof document` guard
  // keeps a server render (`renderToStaticMarkup`) from throwing.
  const openerRef = useRef<HTMLElement | null>(null);
  const fallbackRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== "undefined") {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
    fallbackRef.current = openerRef.current === null
      ? null
      : popupTrigger(openerRef.current);
  }
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const opener = openerRef.current;
    const fallback = fallbackRef.current;
    const returnTarget = returnFocusRef?.current ?? null;
    const container = containerRef.current;
    const target =
      initialFocusRef?.current
      ?? tabbable(container, { scrollers: false })[0];
    // A dialog with nothing tabbable still needs focus, or the first Tab
    // escapes it. Its container carries tabIndex={-1} for that case.
    (target ?? container)?.focus();
    return () => {
      // Only while the dialog still owns focus. A caller that deliberately
      // sent focus somewhere else on close keeps it. A dialog that unmounted
      // took its focused control with it, which leaves focus on <body>.
      const active = document.activeElement;
      const stillInside =
        active === null
        || active === document.body
        || container?.contains(active) === true;
      if (!stillInside) return;
      const back = [opener, returnTarget, fallback].find(
        (candidate) => candidate?.isConnected === true,
      );
      back?.focus();
    };
  }, [open, containerRef, initialFocusRef, returnFocusRef]);

  useEffect(() => {
    if (!open) return;
    const trap: Trap = { containerRef };
    openTraps.push(trap);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      if (tabOwner() !== trap) return;
      const root = containerRef.current;
      if (root === null) return;
      if (ownTabOrder && root.contains(document.activeElement)) return;
      const list = tabbable(root);
      if (list.length === 0) {
        // Nothing to cycle through: hold focus on the container itself.
        event.preventDefault();
        root.focus();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const active = document.activeElement;
      // Focus outside the dialog entirely (moved programmatically, or reset
      // to <body> by a click on something that cannot take focus) is pulled
      // back to the near edge.
      if (active === null || !root.contains(active)) {
        event.preventDefault();
        const edge = event.shiftKey ? last : first;
        if (active?.closest('[role="menu"]') != null) {
          // A menu portalled out of the dialog answers Tab itself: the ARIA
          // menu pattern closes it, and a menu can only do that while focus
          // is still inside it. This listener runs in the capture phase, so
          // pulling focus here first would leave the menu open over a dialog
          // it still owns the keys of. Wait until the event has been through
          // the menu's own listeners, and move focus only if closing the menu
          // did not already put it back inside.
          window.addEventListener(
            "keydown",
            (after) => {
              if (after === event && !root.contains(document.activeElement)) {
                edge.focus();
              }
            },
            { once: true },
          );
          return;
        }
        edge.focus();
        return;
      }
      // The container itself: ImageLightbox focuses its frame on open, and a
      // click on a dialog's blank area focuses a tabIndex={-1} container. It
      // is inside, but on no edge, so Shift+Tab used to walk backwards out of
      // the dialog.
      if (active === root) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      const at = openTraps.indexOf(trap);
      if (at !== -1) openTraps.splice(at, 1);
    };
  }, [open, containerRef, ownTabOrder]);
}
