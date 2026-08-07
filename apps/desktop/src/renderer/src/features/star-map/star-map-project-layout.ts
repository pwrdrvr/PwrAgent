import { cardRingExtent } from "./star-map-orbit";

export type ProjectPlacement = {
  key: string;
  x: number;
  y: number;
  /** Outermost card-ring extent, for halo sizing and hit testing. */
  rx: number;
  ry: number;
};

export type ProjectLayout = {
  canvasHeight: number;
  canvasWidth: number;
  projects: ProjectPlacement[];
};

/** Breathing room between two projects' outermost cards. */
const PROJECT_GAP = 72;
const CANVAS_PADDING = 140;
/** Roughly landscape, matching the window rather than a square canvas. */
const TARGET_ASPECT = 1.45;

/**
 * Lay projects out as independent suns.
 *
 * Unlike the instance layouts there is no hub here — projects are peers,
 * so a hub-and-spoke placement does not apply. They pack into rows sized
 * by each project's own card-ring extent, which keeps a project with two
 * threads from claiming the same footprint as one with twenty.
 *
 * Row packing (rather than a fixed grid) is what lets the cell size follow
 * the content: a uniform grid would have to size every cell for the
 * busiest project and leave the quiet ones adrift in empty space.
 */
export function computeProjectLayout(params: {
  cardWidth: number;
  /** Visible card count per project key, in the order to place them. */
  projects: readonly { key: string; cardCount: number }[];
}): ProjectLayout {
  if (params.projects.length === 0) {
    return { canvasHeight: 0, canvasWidth: 0, projects: [] };
  }

  const cells = params.projects.map((project) => {
    const extent = cardRingExtent(project.cardCount, params.cardWidth);
    // `cardRingExtent` already reports the drawn cloud (cards included),
    // so the cell only adds the gap between neighbours.
    return {
      key: project.key,
      halfWidth: extent.rx + PROJECT_GAP / 2,
      halfHeight: extent.ry + PROJECT_GAP / 2,
    };
  });

  const totalArea = cells.reduce(
    (sum, cell) => sum + cell.halfWidth * 2 * (cell.halfHeight * 2),
    0,
  );
  const targetRowWidth = Math.max(
    cells[0].halfWidth * 2,
    Math.sqrt(totalArea * TARGET_ASPECT),
  );

  const rows: (typeof cells)[] = [];
  let row: typeof cells = [];
  let rowWidth = 0;
  for (const cell of cells) {
    const width = cell.halfWidth * 2;
    if (row.length > 0 && rowWidth + width > targetRowWidth) {
      rows.push(row);
      row = [];
      rowWidth = 0;
    }
    row.push(cell);
    rowWidth += width;
  }
  if (row.length > 0) rows.push(row);

  const rowHeights = rows.map((entries) =>
    entries.reduce((tallest, cell) => Math.max(tallest, cell.halfHeight * 2), 0),
  );
  const rowWidths = rows.map((entries) =>
    entries.reduce((sum, cell) => sum + cell.halfWidth * 2, 0),
  );
  const contentWidth = Math.max(...rowWidths);
  const contentHeight = rowHeights.reduce((sum, height) => sum + height, 0);

  const placements: ProjectPlacement[] = [];
  let y = CANVAS_PADDING;
  rows.forEach((entries, rowIndex) => {
    // Centre each row so the constellation reads as a cluster rather than
    // a left-aligned table.
    let x = CANVAS_PADDING + (contentWidth - rowWidths[rowIndex]) / 2;
    for (const cell of entries) {
      placements.push({
        key: cell.key,
        x: x + cell.halfWidth,
        y: y + rowHeights[rowIndex] / 2,
        // Reported extent covers the cards, not just the ring, so callers
        // hit-test and space against what is actually drawn.
        rx: cell.halfWidth - PROJECT_GAP / 2,
        ry: cell.halfHeight - PROJECT_GAP / 2,
      });
      x += cell.halfWidth * 2;
    }
    y += rowHeights[rowIndex];
  });

  return {
    canvasHeight: contentHeight + CANVAS_PADDING * 2,
    canvasWidth: contentWidth + CANVAS_PADDING * 2,
    projects: placements,
  };
}
