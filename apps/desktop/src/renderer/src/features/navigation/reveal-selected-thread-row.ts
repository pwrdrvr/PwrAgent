/**
 * Scrolls a thread row into the sidebar list. Two callers share it:
 *
 * - The thread title click and the jump palette center the selected row
 *   (`revealSelectedSidebarThreadRow`).
 * - ThreadRow's reveal effect brings the row to the nearest edge
 *   (`revealThreadRowAtNearestEdge`), including after a collapsed container
 *   opens and mounts it.
 *
 * Both run on one title click. The nearest-edge scroll used to stop the
 * smooth centering a frame or two in: an in-view row nudged 2-5px on every
 * click, and an off-screen row stopped at the edge, often under the sticky
 * directory header. So a row that is already in full view stays put, and
 * the nearest-edge scroll leaves a row alone while its centering runs.
 */
const SELECTED_ROW = ".sidebar .thread-row.is-selected";
const REGION = ".sidebar__scroll-region";
// Directory and Pinned group headers stick to the top of the list and
// cover the rows that scroll under them.
const STICKY_HEADER = ".directory-row__header";
// Chromium snaps scroll offsets to device pixels, so a row flush with an
// edge can measure a fraction past it.
const EDGE_TOLERANCE_PX = 1;
// `scrollend` ends the centering. This bounds it when no event comes, as
// when the list is already at the offset it was asked for.
const CENTERING_LIMIT_MS = 1000;

let centering: { row: HTMLElement; finish: () => void } | undefined;

export function revealSelectedSidebarThreadRow(options?: { instant?: boolean }): void {
  const row = document.querySelector<HTMLElement>(SELECTED_ROW);
  if (!row) {
    return;
  }
  const placement = measure(row);
  if (placement && isInFullView(placement)) {
    return;
  }
  const smooth = options?.instant !== true;
  row.scrollIntoView({
    behavior: smooth ? "smooth" : "auto",
    block: "center",
    inline: "nearest",
  });
  if (smooth && placement) {
    trackCentering(row, placement.scroller);
  }
}

export function revealThreadRowAtNearestEdge(row: HTMLElement): void {
  if (centering?.row === row) {
    return;
  }
  const placement = measure(row);
  if (!placement) {
    row.scrollIntoView({ block: "nearest" });
    return;
  }
  if (isInFullView(placement)) {
    return;
  }
  const { scroller, rowBox, stuckTop, view } = placement;
  const delta = rowBox.top < placement.visibleTop
    ? rowBox.top - stuckTop
    // A row taller than the list keeps its top in view.
    : Math.min(rowBox.bottom - view.bottom, rowBox.top - stuckTop);
  scroller.scrollBy({ top: delta, behavior: "auto" });
}

type Placement = {
  scroller: HTMLElement;
  view: DOMRect;
  rowBox: DOMRect;
  // The top of what the operator can see, below the header if it covers it.
  visibleTop: number;
  // Where the header's bottom sits once it is stuck to the top of the list.
  stuckTop: number;
};

function measure(row: HTMLElement): Placement | undefined {
  const scroller = scrollerOf(row);
  if (!scroller) {
    return undefined;
  }
  const view = scroller.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  // A hidden sidebar (⌘B) measures zero. Scroll as before, so the row is
  // placed when the sidebar comes back.
  if (view.height <= 0 || rowBox.height <= 0) {
    return undefined;
  }
  let visibleTop = view.top;
  let stuckTop = view.top;
  const header = row.closest(".directory-row, .pinned-group")
    ?.querySelector<HTMLElement>(`:scope > ${STICKY_HEADER}`);
  if (header && !header.contains(row)) {
    const headerBox = header.getBoundingClientRect();
    visibleTop = Math.max(visibleTop, headerBox.bottom);
    stuckTop = view.top + headerBox.height;
  }
  return { scroller, view, rowBox, visibleTop, stuckTop };
}

// The region clips the lens; the lane inside it (`.sidebar-list--dense`,
// `.directory-groups`) is what scrolls.
function scrollerOf(row: HTMLElement): HTMLElement | undefined {
  const region = row.closest<HTMLElement>(REGION);
  if (!region) {
    return undefined;
  }
  for (let element = row.parentElement; element; element = element.parentElement) {
    const { overflowY } = window.getComputedStyle(element);
    if (overflowY === "auto" || overflowY === "scroll") {
      return element;
    }
    if (element === region) {
      return undefined;
    }
  }
  return undefined;
}

function isInFullView({ rowBox, view, visibleTop }: Placement): boolean {
  const fitsInside =
    rowBox.top >= visibleTop - EDGE_TOLERANCE_PX
    && rowBox.bottom <= view.bottom + EDGE_TOLERANCE_PX;
  // A row taller than the list can never fit. When it already covers the
  // whole visible area, scrolling it would only nudge it.
  const coversView =
    rowBox.top <= visibleTop + EDGE_TOLERANCE_PX
    && rowBox.bottom >= view.bottom - EDGE_TOLERANCE_PX;
  return fitsInside || coversView;
}

function trackCentering(row: HTMLElement, scroller: HTMLElement): void {
  centering?.finish();
  const finish = (): void => {
    scroller.removeEventListener("scrollend", finish);
    window.clearTimeout(limit);
    if (centering?.row === row) {
      centering = undefined;
    }
  };
  const limit = window.setTimeout(finish, CENTERING_LIMIT_MS);
  scroller.addEventListener("scrollend", finish);
  centering = { row, finish };
}
