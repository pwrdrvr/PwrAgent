import { useEffect } from "react";

/**
 * X-ray's spy card. While X-ray is on (lib/xray-mode.ts), one thread row
 * lifts into a card over the list and shows every Mission Control chip: the
 * row under the pointer, or else the selected row. Lifting every row instead
 * pushed the selected thread down the list, often out of sight, which is the
 * opposite of what the operator held the key for.
 *
 * The lift is attributes on the row's shell, never React state, so a peek
 * re-renders nothing. `data-xray-target` takes the shell out of the density
 * rules (app.css); `--xray-shell-height` keeps the shell at its own height
 * so no other row moves; `--xray-lift` slides the card up just far enough to
 * clear the foot of the lane and the X-ray badge. The list never scrolls.
 */
export const XRAY_TARGET_ATTRIBUTE = "data-xray-target";
/**
 * Room the card leaves at the foot of the lane for the X-ray badge: the
 * badge's 12px offset, its 28px pill, and an 8px gap.
 */
export const XRAY_BADGE_CLEARANCE_PX = 48;

const REGION = ".sidebar__scroll-region";
const SHELL = ".thread-row-shell";

function rowOf(shell: HTMLElement): HTMLElement | null {
  return shell.querySelector<HTMLElement>(":scope > .thread-row");
}

/**
 * The row X-ray should lift. `pointed` is the element under the pointer when
 * an event supplies it; otherwise the hovered row stands in for it. A row
 * the pointer is not on lifts only if it is the selected one and is on
 * screen: X-ray never scrolls to find a thread. Nothing lifts during a row
 * drag: a card over its neighbours would hide the drop targets.
 */
export function resolveXrayTarget(pointed?: Element | null): HTMLElement | null {
  const region = document.querySelector(REGION);
  if (!region || region.querySelector(".is-pointer-dragging")) return null;
  const pointedShell = pointed === undefined
    ? Array.from(region.querySelectorAll<HTMLElement>(`${SHELL}:hover`)).at(-1)
    : pointed?.closest<HTMLElement>(SHELL);
  if (pointedShell && region.contains(pointedShell)) return pointedShell;
  const selected = region
    .querySelector(".thread-row.is-selected")
    ?.closest<HTMLElement>(SHELL);
  if (!selected) return null;
  const rect = selected.getBoundingClientRect();
  const bounds = region.getBoundingClientRect();
  return rect.bottom > bounds.top && rect.top < bounds.bottom ? selected : null;
}

/** Slides a lifted card up by whatever would cross the foot of the lane. */
function placeCard(shell: HTMLElement): void {
  const row = rowOf(shell);
  const region = shell.closest(REGION);
  shell.style.removeProperty("--xray-lift");
  if (!row || !region) return;
  const card = row.getBoundingClientRect();
  const bounds = region.getBoundingClientRect();
  const overflow = card.bottom - (bounds.bottom - XRAY_BADGE_CLEARANCE_PX);
  // Never past the top of the lane: a card taller than the lane keeps its title.
  const lift = Math.min(overflow, card.top - bounds.top);
  if (lift > 0) shell.style.setProperty("--xray-lift", `${lift}px`);
}

function liftCard(shell: HTMLElement): void {
  // Measured before the row leaves flow: this is the slot it keeps.
  shell.style.setProperty("--xray-shell-height", `${shell.getBoundingClientRect().height}px`);
  shell.setAttribute(XRAY_TARGET_ATTRIBUTE, "");
  placeCard(shell);
}

function dropCard(shell: HTMLElement): void {
  shell.removeAttribute(XRAY_TARGET_ATTRIBUTE);
  shell.style.removeProperty("--xray-shell-height");
  shell.style.removeProperty("--xray-lift");
}

/** Lifts one row while `active`; see the module comment. */
export function useXraySpyCard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let target: HTMLElement | null = null;
    let frame: number | null = null;
    // A chip that arrives or leaves changes the card's height.
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
        if (target?.isConnected) placeCard(target);
      });

    const settle = (next: HTMLElement | null): void => {
      if (target && !target.isConnected) target = null;
      if (next === target) return;
      if (target) {
        const row = rowOf(target);
        if (row) observer?.unobserve(row);
        dropCard(target);
      }
      target = next;
      if (target) {
        liftCard(target);
        const row = rowOf(target);
        if (row) observer?.observe(row);
      }
    };
    const settleLater = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const next = resolveXrayTarget();
        // The list scrolled under the card: it may cross the foot now.
        if (next && next === target) placeCard(next);
        else settle(next);
      });
    };
    const onPointerMove = (event: PointerEvent): void => {
      const pointed = event.target instanceof Element ? event.target : null;
      // Off the rows the answer is the selected row, which only a click, a
      // key or a scroll can change: skip the layout reads on every move.
      if (
        target?.isConnected
        && !pointed?.closest(SHELL)
        && rowOf(target)?.classList.contains("is-selected")
      ) {
        return;
      }
      settle(resolveXrayTarget(pointed));
    };
    // The pointer left the window: fall back to the selected row.
    const onPointerLeave = (): void => settle(resolveXrayTarget(null));

    settle(resolveXrayTarget());
    window.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    // Scrolling moves rows under the pointer; a click or a key can move the selection.
    window.addEventListener("scroll", settleLater, { capture: true, passive: true });
    window.addEventListener("click", settleLater, true);
    window.addEventListener("keyup", settleLater, true);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onPointerMove, true);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("scroll", settleLater, true);
      window.removeEventListener("click", settleLater, true);
      window.removeEventListener("keyup", settleLater, true);
      observer?.disconnect();
      if (target) dropCard(target);
    };
  }, [active]);
}
