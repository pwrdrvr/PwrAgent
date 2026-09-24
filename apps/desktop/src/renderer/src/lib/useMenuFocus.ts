import { useEffect, useRef, type RefObject } from "react";
import { restoreFocusIfDropped } from "./useDialogFocus";

function menuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>(
      "[role=\"menuitem\"], [role=\"menuitemcheckbox\"], [role=\"menuitemradio\"]",
    ),
  ).filter((item) => !item.hasAttribute("disabled"));
}

/**
 * Focus for a `role="menu"` popup: the first item takes focus once the menu
 * is on screen, ArrowUp/ArrowDown/Home/End move between items, and Escape or
 * Tab hands focus back to the control that opened it. Tab does not cancel
 * its own default, so it then moves on from that control, as a menu button's
 * does. `visible` must wait for the menu's placement pass: an item under
 * `visibility: hidden` cannot take focus.
 *
 * Returns the opener, so a dialog opened from an item can return there
 * after the menu has gone.
 */
export function useMenuFocus(
  menuRef: RefObject<HTMLElement | null>,
  visible: boolean,
  onClose: () => void,
): RefObject<HTMLElement | null> {
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!visible) return;
    const menu = menuRef.current;
    if (!menu) return;

    const opened = document.activeElement;
    openerRef.current =
      opened instanceof HTMLElement
      && opened !== document.body
      && !menu.contains(opened)
        ? opened
        : null;
    if (!menu.contains(document.activeElement)) {
      menuItems(menu)[0]?.focus({ preventScroll: true });
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!menu.contains(document.activeElement)) return;
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") event.preventDefault();
        openerRef.current?.focus({ preventScroll: true });
        onCloseRef.current();
        return;
      }
      const items = menuItems(menu);
      if (items.length === 0) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      let next: HTMLElement | undefined;
      if (event.key === "ArrowDown") {
        next = items[(index + 1) % items.length];
      } else if (event.key === "ArrowUp") {
        next = items[index <= 0 ? items.length - 1 : index - 1];
      } else if (event.key === "Home") {
        next = items[0];
      } else if (event.key === "End") {
        next = items[items.length - 1];
      }
      if (!next) return;
      event.preventDefault();
      next.focus({ preventScroll: true });
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      restoreFocusIfDropped(openerRef.current, menu);
    };
  }, [menuRef, visible]);

  return openerRef;
}
