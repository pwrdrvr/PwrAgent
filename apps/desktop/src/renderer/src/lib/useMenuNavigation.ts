import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useDismissableLayer } from "./useDismissableLayer";

const ITEM =
  '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';

/**
 * The items the keyboard can land on, in document order. A native
 * `disabled` button cannot take focus at all, so it is skipped rather than
 * stopped on.
 */
function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (menu === null) return [];
  return [...menu.querySelectorAll<HTMLElement>(ITEM)].filter(
    (item) =>
      !item.hasAttribute("disabled")
      && item.getAttribute("aria-disabled") !== "true",
  );
}

/**
 * The keyboard contract of a popup menu, in one call. Put `menuRef` on the
 * `role="menu"` element. Then:
 *
 * - Focus moves to the first item on open, so the arrows have somewhere to
 *   start. A pointer-opened menu shows no ring, since Chromium carries
 *   `:focus-visible` from the element focus left, and a click does not set it.
 * - ArrowDown and ArrowUp step through the items and wrap. Home and End jump
 *   to either end.
 * - Escape closes the menu and returns focus to `triggerRef`. The menu is
 *   registered with `useDismissableLayer`, so a menu opened over a dialog
 *   takes the Escape and the dialog stays. Do not register it again.
 * - Tab closes the menu, and focus continues from the trigger.
 * - An item that closes the menu without sending focus anywhere returns it
 *   to the trigger.
 *
 * Before this existed, the sidebar's menus said `role="menu"` and did none
 * of it. Opening one left focus on the ⋮ button, and the menu renders
 * elsewhere in the DOM, so Tab from the button never reached the items.
 * Each menu closed from its own Escape listener, which never claimed the
 * key, so the thread find bar closed with it.
 *
 * `open` means the menu can take focus now. A menu that measures itself at
 * `visibility: hidden` before it is placed passes `open` only once it is
 * placed, because Chromium will not focus a hidden element.
 *
 * Give the menu `tabIndex={-1}` if every item in it can be disabled at once.
 * Focus then lands on the menu itself, where Escape and Tab still work.
 */
export function useMenuNavigation({
  open,
  menuRef,
  triggerRef,
  onClose,
}: {
  open: boolean;
  menuRef: RefObject<HTMLElement | null>;
  /**
   * The control that opened the menu, or whatever held focus when a
   * right-click opened it. Focus returns here when the menu closes.
   */
  triggerRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}): void {
  // Held in a ref so an inline callback does not rebuild the key listener
  // on every render.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  useDismissableLayer({
    open,
    onDismiss: onClose,
    surfaceRef: menuRef,
    ...(triggerRef === undefined ? {} : { triggerRef }),
  });

  // Whether the menu held focus as it closed. This is read during the render
  // that closes it, for the same reason `useFocusTrap` reads its opener
  // during render: by the time an effect runs, the menu and its focused item
  // have left the document, and focus sits on <body> either way. A click
  // outside the menu leaves focus on <body> too, and that must not pull
  // focus back to the trigger.
  const heldFocusRef = useRef(false);
  const wasOpenRef = useRef(open);
  if (wasOpenRef.current && !open && typeof document !== "undefined") {
    const menu = menuRef.current;
    const active = document.activeElement;
    heldFocusRef.current = menu !== null && active !== null && menu.contains(active);
  }
  wasOpenRef.current = open;

  useEffect(() => {
    if (!open) return;
    // The trigger that opened this menu, not whatever the ref names by the
    // time it closes.
    const trigger = triggerRef?.current;
    const menu = menuRef.current;
    const first = menuItems(menu)[0];
    (first ?? menu)?.focus();
    return () => {
      const heldFocus = heldFocusRef.current;
      heldFocusRef.current = false;
      if (!heldFocus) return;
      // Only when nothing else took focus. An item that opens a dialog hands
      // focus to the dialog, and the dialog returns it here when it closes.
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      if (trigger?.isConnected === true) trigger.focus();
    };
  }, [open, menuRef, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      const menu = menuRef.current;
      const active = document.activeElement;
      if (menu === null || active === null || !menu.contains(active)) return;

      if (event.key === "Tab") {
        // The menu is not next to its trigger in the DOM, so Tab from an
        // item would carry on from wherever the menu happens to render.
        // Focusing the trigger first, and leaving the default action alone,
        // makes Tab and Shift+Tab move on from the trigger instead. The close
        // would put focus back on the trigger too, but only once React has
        // committed it; this does not depend on when that happens.
        //
        // `defaultPrevented` is not checked. A focus trap under the menu
        // prevents Tab in its capture listener and waits for the menu to
        // close before deciding where focus goes.
        const trigger = triggerRef?.current;
        if (trigger?.isConnected === true) trigger.focus();
        onCloseRef.current();
        return;
      }

      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      const items = menuItems(menu);
      if (items.length === 0) return;
      // -1 when focus is on the menu itself rather than an item.
      const at = items.indexOf(active as HTMLElement);
      let next: HTMLElement | undefined;
      switch (event.key) {
        case "ArrowDown":
          next = items[(at + 1) % items.length];
          break;
        case "ArrowUp":
          next = at <= 0 ? items[items.length - 1] : items[at - 1];
          break;
        case "Home":
          next = items[0];
          break;
        case "End":
          next = items[items.length - 1];
          break;
        default:
          return;
      }
      // Claimed, so the arrow does not also scroll the list behind the menu.
      event.preventDefault();
      next?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, menuRef, triggerRef]);
}
