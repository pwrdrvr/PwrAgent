import { useEffect, useRef, type RefObject } from "react";

const TABBABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable=\"true\"]",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(", ");

/** The Tab stops inside `container`, in document order. */
export function tabbableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR),
  ).filter((element) =>
    element.tabIndex >= 0 && !element.closest("[inert], [hidden]"));
}

/**
 * Hand focus back to `target` when a surface that held it has gone. Only
 * when focus fell to <body> with the surface: a close that moved focus on
 * purpose (a dialog opening from a menu item, a thread taking the composer)
 * keeps it.
 */
export function restoreFocusIfDropped(
  target: HTMLElement | null | undefined,
  surface?: HTMLElement | null,
): void {
  const active = document.activeElement;
  const dropped =
    active === null
    || active === document.body
    || (surface?.contains(active) ?? false);
  if (!dropped || !target || !target.isConnected || target.closest("[inert]")) {
    return;
  }
  target.focus({ preventScroll: true });
}

type DialogFocusOptions = {
  /** Escape closes the dialog; containing Tab would otherwise be a trap. */
  onEscape: () => void;
  /** Where focus lands on open. Defaults to the first Tab stop. */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * Where focus returns on close when nothing outside the dialog held it at
   * open. Focus is on <body> then because the opener unmounted on the way
   * (a menu item), so such a dialog names the control behind it here.
   */
  returnFocus?: () => HTMLElement | null | undefined;
};

/**
 * Modal focus: move focus into the dialog on open, keep Tab and Shift+Tab
 * cycling inside it so focus cannot walk out behind the backdrop, close on
 * Escape, and return focus to the opener on close.
 */
export function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  active: boolean,
  options: DialogFocusOptions,
): void {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    if (!active) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const opened = document.activeElement;
    const returnTarget =
      opened instanceof HTMLElement
      && opened !== document.body
      && !dialog.contains(opened)
        ? opened
        : optionsRef.current.returnFocus?.();
    if (!dialog.contains(document.activeElement)) {
      const initial =
        optionsRef.current.initialFocus?.current ?? tabbableElements(dialog)[0];
      initial?.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        optionsRef.current.onEscape();
        return;
      }
      if (event.key !== "Tab") return;
      const items = tabbableElements(dialog);
      const first = items[0];
      const last = items[items.length - 1];
      const focused = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
      } else if (!dialog.contains(focused)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && focused === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && focused === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      restoreFocusIfDropped(returnTarget, dialog);
    };
  }, [active, dialogRef]);
}
