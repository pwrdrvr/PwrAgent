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
 * primary mouse press is recorded (capture phase, so a handler that stops
 * propagation cannot hide it) and a click counts only when that press landed
 * inside the element the click is handled on. Unmatched presses expire when
 * the interaction ends. Touch and pen presses do not count.
 */
export function useMousePress(): (event: ReactMouseEvent<HTMLElement>) => boolean {
  const lastPointerDown = useRef<
    { target: EventTarget | null } | undefined
  >(undefined);
  useEffect(() => {
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const clear = (): void => {
      clearTimeout(expiry);
      expiry = undefined;
      lastPointerDown.current = undefined;
    };
    const record = (event: PointerEvent): void => {
      clear();
      if (event.pointerType === "mouse" && event.button === 0) {
        lastPointerDown.current = { target: event.target };
      }
    };
    const expire = (): void => {
      // The native click follows pointerup in the same turn. Let that click
      // consume the record, then clear it even if no selection handler ran.
      clearTimeout(expiry);
      expiry = setTimeout(clear, 0);
    };
    document.addEventListener("pointerdown", record, true);
    document.addEventListener("pointerup", expire, true);
    document.addEventListener("click", expire, true);
    document.addEventListener("pointercancel", clear, true);
    document.addEventListener("contextmenu", clear, true);
    document.addEventListener("dragstart", clear, true);
    document.addEventListener("keydown", clear, true);
    window.addEventListener("blur", clear);
    return () => {
      clear();
      document.removeEventListener("pointerdown", record, true);
      document.removeEventListener("pointerup", expire, true);
      document.removeEventListener("click", expire, true);
      document.removeEventListener("pointercancel", clear, true);
      document.removeEventListener("contextmenu", clear, true);
      document.removeEventListener("dragstart", clear, true);
      document.removeEventListener("keydown", clear, true);
      window.removeEventListener("blur", clear);
    };
  }, []);
  return useCallback((event: ReactMouseEvent<HTMLElement>): boolean => {
    const pointerDown = lastPointerDown.current;
    // Consumed here, so a later keyboard activation of the same row can never
    // reuse it.
    lastPointerDown.current = undefined;
    return event.detail > 0
      && event.button === 0
      && pointerDown?.target instanceof Node
      && event.currentTarget.contains(pointerDown.target);
  }, []);
}
