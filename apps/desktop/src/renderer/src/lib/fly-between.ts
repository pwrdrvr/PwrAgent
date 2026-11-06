const FLY_MS = 300;
const FLY_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * Moves the eye from one surface to another: an empty card flies from the
 * rect being left to the element arriving, and the arriving element fades in
 * under it. Scaling the real content instead would stretch its text on the
 * way. Reduced motion gets the fade alone. Ported from PwrGit's Bulk Sync
 * dialog-to-toast motion, so the two apps minimise the same way.
 */
export function flyBetween(from: DOMRect, target: HTMLElement): void {
  if (typeof target.animate !== "function") return;
  const reduce =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    || document.documentElement.dataset.motion === "calm";
  if (reduce) {
    target.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
    return;
  }
  const to = target.getBoundingClientRect();
  if (to.width === 0 || from.width === 0) return;
  const ghost = document.createElement("div");
  ghost.className = "fly-ghost";
  ghost.setAttribute("aria-hidden", "true");
  document.body.append(ghost);
  const frame = (rect: DOMRect) => ({
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    opacity: 1,
  });
  const flight = ghost.animate([frame(from), { ...frame(to), opacity: 0.4 }], {
    duration: FLY_MS,
    easing: FLY_EASING,
    fill: "forwards",
  });
  const land = (): void => ghost.remove();
  flight.onfinish = land;
  flight.oncancel = land;
  target.animate([{ opacity: 0 }, { opacity: 0 }, { opacity: 1 }], {
    duration: FLY_MS + 80,
    easing: "ease-out",
  });
}
