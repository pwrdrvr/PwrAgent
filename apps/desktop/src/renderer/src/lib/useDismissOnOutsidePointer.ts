import { useEffect, type RefObject } from "react";

/**
 * Closes a popup when a pointer goes down outside `ref`. `useMenuNavigation`
 * owns a menu's keyboard, not the pointer, so a menu that should close on an
 * outside click pairs the two.
 */
export function useDismissOnOutsidePointer(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onDismiss();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, ref, onDismiss]);
}
