import { useEffect } from "react";

export const NATIVE_DRAG_ACTIVE_ATTRIBUTE = "data-native-drag-active";

type NativeDragListener = (active: boolean) => void;

let active = false;
const listeners = new Set<NativeDragListener>();

function setNativeDragInteractionActive(next: boolean): void {
  if (active === next) return;
  active = next;
  if (typeof document !== "undefined") {
    document.documentElement.toggleAttribute(
      NATIVE_DRAG_ACTIVE_ATTRIBUTE,
      next,
    );
  }
  for (const listener of listeners) {
    listener(next);
  }
}

export function beginNativeDragInteraction(): void {
  setNativeDragInteractionActive(true);
}

export function endNativeDragInteraction(): void {
  setNativeDragInteractionActive(false);
}

export function isNativeDragInteractionActive(): boolean {
  return active;
}

export function subscribeNativeDragInteraction(
  listener: NativeDragListener,
): () => void {
  listeners.add(listener);
  listener(active);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * One window-level guard owns drag-time interaction state for the sidebar.
 * Native drag events keep traversing the DOM while the pointer moves over
 * nested buttons and chips; marking the document lets those descendants and
 * every portalled hover surface become inert until the gesture terminates.
 */
export function useNativeDragInteractionGuard(): void {
  useEffect(() => {
    const begin = (event: DragEvent): void => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      if (
        !event.target.closest(".thread-row-shell")
        && !event.target.closest(".directory-row__header")
      ) {
        return;
      }
      beginNativeDragInteraction();
    };
    const end = (): void => endNativeDragInteraction();
    const endOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") end();
    };

    window.addEventListener("dragstart", begin);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    window.addEventListener("blur", end);
    window.addEventListener("keydown", endOnEscape);
    return () => {
      window.removeEventListener("dragstart", begin);
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
      window.removeEventListener("blur", end);
      window.removeEventListener("keydown", endOnEscape);
      end();
    };
  }, []);
}
