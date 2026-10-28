/**
 * Scrolls the sidebar's selected thread row toward the middle of the list,
 * for the thread title click and the jump palette.
 *
 * A row that is already in full view stays where it is. Centering it anyway
 * moved the list on every title click: the smooth center scroll starts, then
 * ThreadRow's reveal effect runs its own `block: "nearest"` scroll, which
 * stops the animation a few pixels in. Each click nudged the list 2-5px.
 */
const SELECTED_ROW = ".sidebar .thread-row.is-selected";
const REGION = ".sidebar__scroll-region";
// Directory and Pinned group headers stick to the top of the list and
// cover the rows that scroll under them.
const STICKY_HEADER = ".directory-row__header";
// Chromium snaps scroll offsets to device pixels, so a row flush with an
// edge can measure a fraction past it.
const EDGE_TOLERANCE_PX = 1;

export function revealSelectedSidebarThreadRow(options?: { instant?: boolean }): void {
  const row = document.querySelector<HTMLElement>(SELECTED_ROW);
  if (!row || isRowInFullView(row)) {
    return;
  }
  row.scrollIntoView({
    behavior: options?.instant === true ? "auto" : "smooth",
    block: "center",
    inline: "nearest",
  });
}

function isRowInFullView(row: HTMLElement): boolean {
  const region = row.closest<HTMLElement>(REGION);
  if (!region) {
    return false;
  }
  const view = region.getBoundingClientRect();
  // A hidden sidebar (⌘B) measures zero. Scroll as before, so the row is
  // placed when the sidebar comes back.
  if (view.height <= 0) {
    return false;
  }
  const rowBox = row.getBoundingClientRect();
  if (rowBox.height <= 0) {
    return false;
  }
  let top = view.top;
  const header = row.closest(".directory-row, .pinned-group")
    ?.querySelector<HTMLElement>(`:scope > ${STICKY_HEADER}`);
  if (header && !header.contains(row)) {
    top = Math.max(top, header.getBoundingClientRect().bottom);
  }
  const bottom = view.bottom;
  const fitsInside =
    rowBox.top >= top - EDGE_TOLERANCE_PX
    && rowBox.bottom <= bottom + EDGE_TOLERANCE_PX;
  // A row taller than the list can never fit. When it already covers the
  // whole visible area, centering it would only nudge it.
  const coversView =
    rowBox.top <= top + EDGE_TOLERANCE_PX
    && rowBox.bottom >= bottom - EDGE_TOLERANCE_PX;
  return fitsInside || coversView;
}
