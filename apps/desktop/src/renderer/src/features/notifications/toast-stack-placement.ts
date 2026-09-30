import { useEffect, useState, type RefObject } from "react";

/**
 * Where the notice stack sits. It lives at the window's bottom-left, and a
 * notice that stays up (an error does not dismiss itself) can hide whatever
 * is under it, with no way for a keyboard user to uncover it but moving
 * focus onto the notice (WCAG 2.2 SC 2.4.11). So when keyboard navigation
 * lands on a control the stack hides entirely, it moves to the top edge.
 *
 * A notice that moves is a notice the operator reaches for and misses, so
 * everything short of that one case leaves it where it is:
 *
 * - A control it only partly covers is not obscured (2.4.11 asks that focus
 *   not be entirely hidden), and a sidebar row or the composer peeking out
 *   from under it is the common case, not the failure.
 * - A click, or a focus the app moves after one, never moves it. A text
 *   field matches `:focus-visible` on click, so the platform's flag alone
 *   cannot tell a click into the composer from a Tab onto it.
 * - Nothing but focus arriving moves it. Paging between notices of
 *   different heights, a notice arriving, and a window resize leave it put.
 * - It never slides out from under the pointer, or from under its own
 *   focused buttons.
 *
 * It stays on whichever edge it moved to until keyboard focus lands on a
 * control that edge hides, or the last notice closes. Nothing is dismissed
 * and no key is taken, which leaves Escape to the layers that own it.
 */
export type ToastStackPlacement = "bottom" | "top";

type Box = { left: number; top: number; right: number; bottom: number };

/** Sub-pixel layout can leave a fully covered control a hair uncovered. */
const HIDDEN_TOLERANCE_PX = 1;

function hides(cover: Box, target: Box): boolean {
  return (
    cover.left <= target.left + HIDDEN_TOLERANCE_PX
    && cover.right >= target.right - HIDDEN_TOLERANCE_PX
    && cover.top <= target.top + HIDDEN_TOLERANCE_PX
    && cover.bottom >= target.bottom - HIDDEN_TOLERANCE_PX
  );
}

/**
 * The edge the stack belongs on for this focused control: the other edge
 * when `current` hides it entirely and the other edge would not, and
 * `current` otherwise. The two positions share the stack's width and
 * height; only the vertical anchor differs.
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
  const at = (top: number): Box => ({
    left: stack.left,
    right: stack.right,
    top,
    bottom: top + stack.height,
  });
  const hiddenAtBottom = hides(at(bottomTop), focused);
  const hiddenAtTop = hides(at(topTop), focused);
  if (current === "bottom") return hiddenAtBottom && !hiddenAtTop ? "top" : "bottom";
  return hiddenAtTop && !hiddenAtBottom ? "bottom" : "top";
}

function isFocusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

function isHovered(element: Element): boolean {
  try {
    return element.matches(":hover");
  } catch {
    return false;
  }
}

function cssPixels(style: CSSStyleDeclaration, property: string): number {
  const value = Number.parseFloat(style.getPropertyValue(property));
  return Number.isFinite(value) ? value : 0;
}

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

/**
 * Tracks keyboard focus and answers where the stack goes. Focus counts as
 * keyboard focus when it matches `:focus-visible` and the last input was a
 * key, not a pointer press. It is measured once, a frame after it arrives,
 * and never again. An empty stack goes home, so the next notice opens where
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
    let keyboardInput = false;
    // Read as focus arrives, when the platform knows how it came; a frame
    // later, a keystroke or a click in between can say otherwise.
    let arrived: HTMLElement | null = null;

    const commit = (next: ToastStackPlacement) => {
      // Compared before dispatching: this runs on every keyboard focus change.
      if (next === current) return;
      current = next;
      setPlacement(next);
    };

    const update = () => {
      frame = undefined;
      const target = arrived;
      arrived = null;
      if (!target || document.activeElement !== target) return;
      if (stack.contains(target) || isHovered(stack)) return;
      const box = stack.getBoundingClientRect();
      if (box.height <= 0) {
        commit("bottom");
        return;
      }
      const style = getComputedStyle(stack);
      commit(placeToastStack({
        current,
        focused: target.getBoundingClientRect(),
        stack: { left: box.left, right: box.right, height: box.height },
        viewportHeight: window.innerHeight,
        edge: cssPixels(style, "--app-toast-stack-edge"),
        chromeBand: cssPixels(style, "--chrome-band-h"),
      }));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!MODIFIER_KEYS.has(event.key)) keyboardInput = true;
    };
    const onPointerDown = () => {
      keyboardInput = false;
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (
        !keyboardInput
        || !(target instanceof HTMLElement)
        || !isFocusVisible(target)
      ) {
        arrived = null;
        return;
      }
      arrived = target;
      // A frame later, so a control that Tab scrolled into view is measured
      // where it came to rest.
      if (frame === undefined) frame = window.requestAnimationFrame(update);
    };

    // Capture, so a handler that stops propagation cannot hide the input.
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    // The last notice leaving sends the stack home; nothing else a resize
    // reports moves it.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (stack.getBoundingClientRect().height <= 0) commit("bottom");
          });
    observer?.observe(stack);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
      observer?.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [stackRef]);

  return placement;
}
