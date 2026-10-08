import { useCallback, useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

/**
 * Tells a click that came from a real mouse or trackpad press apart from
 * every other activation.
 *
 * A click alone cannot say: Enter and Space on a focused button fire one, and
 * so does assistive technology that activates a control by synthesizing a
 * mouse click (JAWS and NVDA browse mode, switch control) — some of those even
 * report `detail >= 1`. What they do not send is a real `pointerdown`, so the
 * last one is recorded (capture phase, so a handler that stops propagation
 * cannot hide it) and a click counts as a mouse press only when that
 * `pointerdown` was `pointerType === "mouse"` and landed inside the element
 * the click is handled on. Touch and pen presses do not count.
 */
export function useMousePress(): (event: ReactMouseEvent<HTMLElement>) => boolean {
  const lastPointerDown = useRef<
    { pointerType: string; target: EventTarget | null } | undefined
  >(undefined);
  useEffect(() => {
    const record = (event: PointerEvent): void => {
      lastPointerDown.current = { pointerType: event.pointerType, target: event.target };
    };
    document.addEventListener("pointerdown", record, true);
    return () => document.removeEventListener("pointerdown", record, true);
  }, []);
  return useCallback((event: ReactMouseEvent<HTMLElement>): boolean => {
    const pointerDown = lastPointerDown.current;
    // Consumed here, so a later keyboard activation of the same row can never
    // reuse it.
    lastPointerDown.current = undefined;
    return event.detail > 0
      && pointerDown?.pointerType === "mouse"
      && pointerDown.target instanceof Node
      && event.currentTarget.contains(pointerDown.target);
  }, []);
}
