/**
 * The strip the selected thread's dock takes at the top of the list.
 *
 * While the dock is at the top, every header that sticks to the top of the
 * list sticks lower by this reserve (see `.has-selected-thread-dock-top` in
 * app.css). Anything that places a project at the top of the list has to
 * place it under the dock, at the reserve, or its own stuck header slides
 * down over the project's first rows. `SelectedThreadDock` sets the value;
 * a folder drag releases it before the first hit test.
 */

import { SIDEBAR_REGION } from "./reveal-selected-thread-row";

/** On the lane region while the dock is at the top. */
export const TOP_DOCK_CLASS = "has-selected-thread-dock-top";
/** On the lane region: the card plus its plate, in px. */
export const TOP_DOCK_RESERVE_PROPERTY = "--selected-thread-dock-reserve";
/**
 * Dispatched on the lane region, synchronously, whenever the reserve the
 * headers stick under changes: the dock arriving at the top, leaving it, or
 * its card changing height. A scroll can make the dock arrive or leave, so
 * whatever placed a project by the old reserve has to place it again.
 */
export const TOP_DOCK_RESERVE_CHANGE_EVENT = "selected-thread-dock-reserve-change";
/** Lets the Project Index finish an already scheduled dock sample before it reads the reserve after layout. */
export const TOP_DOCK_RESERVE_SAMPLE_EVENT = "selected-thread-dock-reserve-sample";

/** The lane region `element` sits in, or is. */
export function topDockRegionOf(element: Element): HTMLElement | null {
  return element.closest<HTMLElement>(SIDEBAR_REGION);
}

/** How far below the list's top edge the stuck headers start, in px. */
export function topDockReserve(element: Element): number {
  const region = topDockRegionOf(element);
  if (!region?.classList.contains(TOP_DOCK_CLASS)) {
    return 0;
  }
  const reserve = Number.parseFloat(region.style.getPropertyValue(TOP_DOCK_RESERVE_PROPERTY));
  return Number.isFinite(reserve) && reserve > 0 ? reserve : 0;
}

/** Release the sticky inset without reading layout. */
export function clearTopDockReserve(region: HTMLElement): void {
  if (topDockReserve(region) === 0) return;
  region.classList.remove(TOP_DOCK_CLASS);
  region.dispatchEvent(new Event(TOP_DOCK_RESERVE_CHANGE_EVENT));
}
