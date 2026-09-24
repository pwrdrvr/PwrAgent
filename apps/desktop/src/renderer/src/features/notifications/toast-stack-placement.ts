import { useEffect, useState, type RefObject } from "react";

/**
 * Where the notice stack sits. It lives at the window's bottom-left, and a
 * notice that stays up (an error does not dismiss itself) covered whatever
 * was under it: at the 960px minimum, the composer's Workspace mode button
 * and the last sidebar row's chips, with no way to uncover them but moving
 * focus onto the notice (WCAG 2.2 SC 2.4.11). So when keyboard focus lands
 * on a control the stack covers, it moves to the edge that covers less of
 * it. It stays there while focus moves on to controls neither edge covers,
 * so Tab along the composer does not bounce it, and goes home when the last
 * notice closes. Nothing is dismissed and no key is taken, which leaves
 * Escape to the layers that own it.
 */
export type ToastStackPlacement = "bottom" | "top";

type Box = { left: number; top: number; right: number; bottom: number };

function overlapArea(a: Box, b: Box): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * The edge where the stack covers less of the focused control, or `current`
 * when the two cover it equally. The two positions share the stack's width
 * and height; only the vertical anchor differs.
 */
export function placeToastStack(input: {
  current: ToastStackPlacement;
  focused: Box;
  stack: { left: number; right: number; height: number };
  viewportHeight: number;
  /** The stack's inset from the window edge (`--app-toast-stack-edge`). */
  edge: number;
  /** The window chrome band the top position stays under (`--chrome-band-h`). */
  chromeBand: number;
}): ToastStackPlacement {
  const { current, focused, stack, viewportHeight, edge, chromeBand } = input;
  const bottomTop = viewportHeight - edge - stack.height;
  const topTop = chromeBand + edge;
  const atBottom = overlapArea(focused, {
    left: stack.left,
    right: stack.right,
    top: bottomTop,
    bottom: bottomTop + stack.height,
  });
  const atTop = overlapArea(focused, {
    left: stack.left,
    right: stack.right,
    top: topTop,
    bottom: topTop + stack.height,
  });
  if (atBottom === atTop) return current;
  return atBottom > atTop ? "top" : "bottom";
}

function isFocusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

function cssPixels(style: CSSStyleDeclaration, property: string): number {
  const value = Number.parseFloat(style.getPropertyValue(property));
  return Number.isFinite(value) ? value : 0;
}

/**
 * Tracks keyboard focus and the stack's size, and answers where the stack
 * goes. Only `:focus-visible` focus moves it: a click already shows the
 * operator where they are, and a text field matches on click anyway, so
 * typing into a covered composer still clears it. Focus inside the stack
 * keeps it where it is, so a notice never moves out from under its own
 * buttons. An empty stack goes home, so the next notice opens where
 * notices always do.
 */
export function useToastStackPlacement(
  stackRef: RefObject<HTMLElement | null>,
): ToastStackPlacement {
  const [placement, setPlacement] = useState<ToastStackPlacement>("bottom");

  useEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    let current: ToastStackPlacement = "bottom";
    let frame: number | undefined;
    // Read as focus arrives, when the platform knows how it came; a frame
    // later, a keystroke or a click in between can say otherwise.
    let keyboardFocus: Element | null = null;

    const update = () => {
      frame = undefined;
      const active = document.activeElement;
      if (active instanceof Element && stack.contains(active)) return;
      const box = stack.getBoundingClientRect();
      let next = current;
      if (box.height <= 0) {
        next = "bottom";
      } else if (active instanceof HTMLElement && active === keyboardFocus) {
        const style = getComputedStyle(stack);
        next = placeToastStack({
          current,
          focused: active.getBoundingClientRect(),
          stack: { left: box.left, right: box.right, height: box.height },
          viewportHeight: window.innerHeight,
          edge: cssPixels(style, "--app-toast-stack-edge"),
          chromeBand: cssPixels(style, "--chrome-band-h"),
        });
      }
      // Compared before dispatching: this runs on every focus change.
      if (next === current) return;
      current = next;
      setPlacement(next);
    };
    // A frame later, so a control that Tab scrolled into view is measured
    // where it came to rest.
    const schedule = () => {
      if (frame === undefined) frame = window.requestAnimationFrame(update);
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      keyboardFocus =
        target instanceof Element && isFocusVisible(target) ? target : null;
      schedule();
    };

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", schedule);
    window.addEventListener("resize", schedule);
    // A notice arriving, leaving, or changing height moves both positions.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(stack);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [stackRef]);

  return placement;
}
