/**
 * Where the selected thread's dock sits.
 *
 * The open thread's row can scroll out of the sidebar list. A compact copy
 * of it then docks at the edge it left through, so the operator can always
 * see which thread is open and click back to it. This file is the rule;
 * `SelectedThreadDock.tsx` measures the list and draws the card.
 *
 * The rule is the one `position: sticky` follows, without its limit. A
 * sticky row stops at its own project's section, and the dock has to
 * outlast the project scrolling away.
 */

/** A vertical extent in window coordinates. */
export type DockExtent = { top: number; bottom: number };

export type DockEdge = "top" | "bottom";

export type DockPlacement = {
  edge: DockEdge;
  /** Which of the given rows the dock stands in for: the nearest one. */
  index: number;
};

/**
 * How much of a row must show before it speaks for itself. The dock is a
 * little taller than this, so what is left of a row at the moment the dock
 * appears is under the dock, and the row seems to stop at the edge.
 */
export const DOCK_COVER_PX = 40;

// Chromium snaps scroll offsets to device pixels, so a row flush with an
// edge can measure a fraction past it.
const EDGE_TOLERANCE_PX = 1;

function shownHeight(row: DockExtent, band: DockExtent): number {
  return Math.max(0, Math.min(row.bottom, band.bottom) - Math.max(row.top, band.top));
}

/**
 * `band` is the part of the list the operator can see: below any stuck
 * header, above the list's bottom edge. `rows` are every row of the selected
 * thread. A thread linked to several projects has one in each.
 */
export function selectedThreadDockPlacement(
  rows: readonly DockExtent[],
  band: DockExtent,
): DockPlacement | undefined {
  const bandHeight = band.bottom - band.top;
  if (bandHeight <= 0) {
    return undefined;
  }
  let nearest: (DockPlacement & { distance: number }) | undefined;
  for (const [index, row] of rows.entries()) {
    const height = row.bottom - row.top;
    if (height <= 0) {
      continue;
    }
    // A short row, or a short list, can never show the full cover.
    const needed = Math.min(DOCK_COVER_PX, height, bandHeight) - EDGE_TOLERANCE_PX;
    const shown = shownHeight(row, band);
    // The tolerance forgives a fraction at an edge, never a row wholly out.
    if (shown > 0 && shown >= needed) {
      return undefined;
    }
    const edge: DockEdge = row.top < band.top ? "top" : "bottom";
    const distance = edge === "top" ? band.top - row.top : row.bottom - band.bottom;
    if (!nearest || distance < nearest.distance) {
      nearest = { edge, index, distance };
    }
  }
  return nearest ? { edge: nearest.edge, index: nearest.index } : undefined;
}

// A project's header sits 2px under the one above it, so the next header
// is this close to the list's top at the moment the last one leaves.
const STUCK_SLACK_PX = 4;

/**
 * Where the band starts: under the project header stuck to the top of the
 * list, and under that project's divider when it is stuck there too. Both
 * lists are in document order.
 *
 * The header counts at its full height even while the next project's header
 * pushes it out. The dock then holds one position through the handoff, and
 * the incoming header slides under it, instead of the dock riding the
 * outgoing header up and jumping back down.
 */
export function stuckBandTop(
  listTop: number,
  headers: readonly DockExtent[],
  dividers: readonly DockExtent[],
): number {
  const header = headers.find((extent) =>
    extent.top <= listTop + STUCK_SLACK_PX && extent.bottom > listTop);
  const top = header ? listTop + (header.bottom - header.top) : listTop;
  const divider = dividers.find((extent) =>
    extent.top <= top + STUCK_SLACK_PX && extent.bottom > top);
  return divider ? divider.bottom : top;
}
