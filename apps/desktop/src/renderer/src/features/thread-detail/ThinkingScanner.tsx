import type { AnimationEvent } from "react";

type ThinkingScannerProps = {
  compact?: boolean;
};

// A canceled CSS animation loses its startTime. Keep its identity weakly so
// the initial animationstart event can skip a second style query after the
// ref has already pinned it, while a replacement animation still gets pinned.
const pinnedAnimations = new WeakMap<Element, Animation>();

function pinToSharedEpoch(element: Element): void {
  if (pinnedAnimations.get(element)?.startTime === 0) {
    return;
  }

  if (typeof element.getAnimations !== "function") {
    return;
  }

  for (const animation of element.getAnimations()) {
    // CSS animations normally start when their element's styles resolve. That
    // leaves scanners mounted during separate, busy renderer commits with
    // permanently different phases. Pin each animation to the document
    // timeline's origin instead: the compositor advances every scanner from
    // one shared epoch without a React tick or a root-level style mutation.
    if (animation.startTime !== 0) {
      animation.startTime = 0;
    }
    pinnedAnimations.set(element, animation);
  }
}

function syncThinkingScannerAnimation(element: HTMLDivElement | null): void {
  if (!element) {
    return;
  }

  pinToSharedEpoch(element);
}

function syncRestartedThinkingScannerAnimation(event: AnimationEvent<HTMLDivElement>): void {
  if (event.animationName === "pwragent-thinking-scanner-sweep") {
    // Moving a keyed row with insertBefore recreates its CSS animation in
    // Chromium without remounting React or calling the ref again. Hiding an
    // ancestor with display:none does the same. Repair that new animation on
    // its start event; iterations need no JS, timer, or React state update.
    pinToSharedEpoch(event.currentTarget);
  }
}

/**
 * Re-pins every beam on screen when `prefers-reduced-motion` changes.
 *
 * `app.css` drops the sweep entirely under the preference, and the browser
 * CANCELS the animation rather than pausing it. Turning the preference back
 * off therefore builds a NEW animation whose `startTime` is the moment of the
 * flip — measured at 1285 against a fresh mount's 0, which left two beams 19px
 * apart in the same 62px track. Every scanner already on screen would run on a
 * different epoch from every scanner mounted afterwards: the exact desync the
 * mount-time pin exists to prevent (PR #1187, and the warning on
 * `.signal-count__dormant-scanner` in `app.css`).
 *
 * The live set is read off the DOM rather than kept in a module-level registry
 * of mounted elements. The pin is a property of the whole set, not of any one
 * element, and a registry would have to track unmounts exactly or retain
 * detached nodes for the life of the window — a query on a preference flip is
 * both cheaper to be right about and impossible to leak. The animation is
 * already attached by the time the event fires, so no frame has to be waited
 * on; in the other direction there is nothing to pin and this is a no-op.
 *
 * Nothing here branches the RENDER on the preference — the markup is identical
 * either way, so no element is torn down and no scanner loses its pin.
 */
function watchReducedMotionForRepin(): void {
  // jsdom ships no `matchMedia`, and neither does a non-DOM import of this
  // module; the pin is a progressive enhancement in both cases.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return;
  }

  window
    .matchMedia("(prefers-reduced-motion: reduce)")
    .addEventListener("change", () => {
      for (const beam of document.querySelectorAll(".thinking-scanner__beam")) {
        pinToSharedEpoch(beam);
      }
    });
}

watchReducedMotionForRepin();

export function ThinkingScanner(props: ThinkingScannerProps = {}) {
  return (
    <div
      aria-hidden="true"
      className={`thinking-scanner${props.compact ? " thinking-scanner--mini" : ""}`}
    >
      <div
        className="thinking-scanner__beam"
        onAnimationStart={syncRestartedThinkingScannerAnimation}
        ref={syncThinkingScannerAnimation}
      />
    </div>
  );
}
