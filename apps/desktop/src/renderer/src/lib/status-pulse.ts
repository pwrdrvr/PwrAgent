/**
 * The gentle "still moving" pulse on a status dot: a running background
 * terminal, sub-agent, environment action or automation run, a PR whose
 * failed checks are still running, a dependency still waiting, a messaging
 * platform still connecting, a notice in progress.
 *
 * The dot's colour carries the state. The pulse only adds "and it is still
 * going", so it does not have to move all the time. Each dot rests at full
 * opacity and dims once — one 1600ms `ease-in-out` dip to 0.45 and back, the
 * former CSS loop's single iteration — every 4500ms.
 *
 * Still between pulses, on purpose. The former `status-blink` rule looped
 * forever, and Chromium's compositor wakes on every display refresh while any
 * animation runs, even when every animated element is offscreen and nothing
 * is drawn. These dots stay mounted for as long as a dev server, a CI run or
 * a dependency wait lasts, often in a scrolled-away sidebar row or rail card.
 * A finished animation costs nothing.
 *
 * One timer for the whole window, not one animation per dot, the pattern the
 * thinking scanner uses. When a pulse is due, every dot on screen starts a
 * finite Web Animation in the same task, so they share one start time and
 * move in the same frames. The timer is aligned to the wall clock with the
 * scanner's 4500ms period, so other windows, and scanners, wake in the same
 * frames too. There is no registry of mounted dots: each pulse reads the live
 * set from the DOM, so an unmounted dot cannot leak, and the timer stops once
 * no dot is left. The next mount restarts it.
 *
 * Reduced motion: no pulses. The resting pose is the still state, and a dip
 * already moving is cancelled back to it when the preference turns on.
 */
export const STATUS_PULSE_PERIOD_MS = 4500;
export const STATUS_PULSE_DURATION_MS = 1600;
/** Named for the rendering capture's animation allowlist. */
export const STATUS_PULSE_ANIMATION_ID = "status-blink";

/**
 * Every element that pulses. A site that renders one of these classes calls
 * `statusPulseRef` (or `ensureStatusPulse`), which `status-pulse.test.ts`
 * checks, so a new site cannot sit still while the timer happens to be off.
 */
export const STATUS_PULSE_SELECTOR = [
  ".status-dot--blink",
  ".rail-chip__dot--blink",
  ".pr-chip--checks-running .pr-chip__dot",
].join(", ");

// `ease-in-out` on each half, as the CSS keyframes' timing function was.
// Opacity only, so the dip runs on the compositor with no paint.
const PULSE_KEYFRAMES: Keyframe[] = [
  { offset: 0, opacity: 1, easing: "ease-in-out" },
  { offset: 0.5, opacity: 0.45, easing: "ease-in-out" },
  { offset: 1, opacity: 1 },
];

let pulseTimer: ReturnType<typeof setTimeout> | undefined;
let reducedMotion: MediaQueryList | null | undefined;

function readReducedMotion(): MediaQueryList | null {
  if (reducedMotion !== undefined) {
    return reducedMotion;
  }
  // jsdom ships no `matchMedia`; the preference check is an enhancement.
  reducedMotion = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
  reducedMotion?.addEventListener("change", () => {
    if (!reducedMotion?.matches || typeof document.getAnimations !== "function") {
      return;
    }
    for (const animation of document.getAnimations()) {
      if (animation.id === STATUS_PULSE_ANIMATION_ID) {
        animation.cancel();
      }
    }
  });
  return reducedMotion;
}

/** Starts the window's pulse timer if it is not already running. */
export function ensureStatusPulse(): void {
  if (pulseTimer !== undefined || typeof window === "undefined") {
    return;
  }
  readReducedMotion();
  pulseTimer = setTimeout(
    runPulse,
    STATUS_PULSE_PERIOD_MS - (Date.now() % STATUS_PULSE_PERIOD_MS),
  );
}

/**
 * Ref callback for a pulsing dot. Pass it only while the dot pulses
 * (`ref={blink ? statusPulseRef : undefined}`): React calls a ref again when it
 * changes, so a dot that starts pulsing after mount still starts the timer.
 */
export function statusPulseRef(element: Element | null): void {
  if (element) {
    ensureStatusPulse();
  }
}

function isOnScreen(element: HTMLElement): boolean {
  // Covers `display: none` and `visibility: hidden` ancestors, such as a
  // collapsed disclosure or a hidden pane.
  if (typeof element.checkVisibility === "function"
    && !element.checkVisibility({ visibilityProperty: true })) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0
    && rect.height > 0
    && rect.bottom > 0
    && rect.right > 0
    && rect.top < window.innerHeight
    && rect.left < window.innerWidth;
}

function runPulse(): void {
  pulseTimer = undefined;
  const dots = document.querySelectorAll<HTMLElement>(STATUS_PULSE_SELECTOR);
  if (dots.length === 0) {
    return;
  }

  // A hidden window, or an offscreen dot, would tick for frames that are never
  // drawn. The next pulse finds any dot that has come back into view.
  if (document.visibilityState === "visible" && !readReducedMotion()?.matches) {
    for (const dot of dots) {
      if (typeof dot.animate !== "function" || !isOnScreen(dot)) {
        continue;
      }
      dot.animate(PULSE_KEYFRAMES, {
        duration: STATUS_PULSE_DURATION_MS,
        id: STATUS_PULSE_ANIMATION_ID,
      });
    }
  }
  ensureStatusPulse();
}
