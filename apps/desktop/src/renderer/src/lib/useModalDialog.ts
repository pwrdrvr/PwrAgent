import { useRef, type RefObject } from "react";
import { useDismissableLayer } from "./useDismissableLayer";
import { useFocusTrap } from "./useFocusTrap";

/**
 * The keyboard contract of a modal dialog, in one call.
 *
 * Put the returned ref on the element that holds every control of the dialog
 * (usually the `role="dialog"` element with `aria-modal="true"`). Then:
 *
 * - Focus enters on open: at `initialFocus`, or the first control.
 * - Tab and Shift+Tab stay inside (WCAG 2.1 SC 2.4.3).
 * - Escape calls `onClose`, and only the topmost layer answers it.
 * - Focus returns to the opener on close: the control that had it when the
 *   dialog first rendered, or, once that is gone, `returnFocus` or the
 *   trigger of the menu that control was in.
 *
 * Escape means "the operator asked to leave". A dialog that must not close
 * right now (a save in flight) passes an `onClose` that refuses, as its
 * disabled Cancel button already does. The key is still claimed.
 *
 * `open` is for a dialog rendered inline by a component that stays mounted
 * while it is closed. A component that only mounts while open leaves it out.
 */
export function useModalDialog<T extends HTMLElement = HTMLDivElement>({
  open = true,
  onClose,
  initialFocus,
  returnFocus,
  ownTabOrder,
}: {
  open?: boolean;
  onClose: () => void;
  /**
   * Where focus lands on open. Defaults to the first control. `"dialog"`
   * focuses the dialog element itself, which then needs `tabIndex={-1}`: the
   * lightbox's frame, and prompts that should be read before anything in
   * them is pressed.
   */
  initialFocus?: RefObject<HTMLElement | null> | "dialog";
  /**
   * Where focus returns once the opener has left the document. Ahead of the
   * menu-trigger guess, for a menu whose trigger is not marked expanded.
   */
  returnFocus?: RefObject<HTMLElement | null>;
  /**
   * The dialog steps focus through its own controls on Tab, and only needs
   * the trap to own the key and fetch stray focus. See `useFocusTrap`.
   */
  ownTabOrder?: boolean;
}): RefObject<T | null> {
  const dialogRef = useRef<T>(null);
  useDismissableLayer({ open, onDismiss: onClose, surfaceRef: dialogRef });
  useFocusTrap({
    open,
    containerRef: dialogRef,
    ...(initialFocus === undefined
      ? {}
      : { initialFocusRef: initialFocus === "dialog" ? dialogRef : initialFocus }),
    ...(returnFocus === undefined ? {} : { returnFocusRef: returnFocus }),
    ...(ownTabOrder === undefined ? {} : { ownTabOrder }),
  });
  return dialogRef;
}
