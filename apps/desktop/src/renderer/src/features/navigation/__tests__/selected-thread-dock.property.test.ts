import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DOCK_COVER_PX,
  selectedThreadDockPlacement,
  stuckBandBottom,
  stuckBandTop,
  type DockExtent,
} from "../selected-thread-dock";

/*
 * The rule the selected thread's dock promises:
 *
 *   The open thread is always on screen in the sidebar list. Either one of
 *   its rows shows enough to be read, or a dock stands in for the nearest
 *   one at the edge that row left through, and never both.
 *
 * Before the dock, a selected row scrolled out of the list like any other
 * and nothing in the sidebar said which thread was open.
 *
 * The oracle does not share the rule's arithmetic. It rasterises the list
 * one pixel row at a time and counts the pixels of each row inside the band.
 */
const band = fc.record({
  top: fc.integer({ min: 0, max: 200 }),
  height: fc.integer({ min: 1, max: 600 }),
}).map(({ top, height }) => ({ top, bottom: top + height }));

const row = fc.record({
  top: fc.integer({ min: -900, max: 1500 }),
  height: fc.integer({ min: 1, max: 200 }),
}).map(({ top, height }) => ({ top, bottom: top + height }));

function shownPixels(extent: DockExtent, view: DockExtent): number {
  let shown = 0;
  for (let y = extent.top; y < extent.bottom; y += 1) {
    if (y >= view.top && y < view.bottom) {
      shown += 1;
    }
  }
  return shown;
}

// Enough to read: the whole cover, or all there is of a short row or list.
function reads(extent: DockExtent, view: DockExtent): boolean {
  const most = Math.min(DOCK_COVER_PX, extent.bottom - extent.top, view.bottom - view.top);
  const shown = shownPixels(extent, view);
  return shown > 0 && shown >= most - 1;
}

describe("selectedThreadDockPlacement", () => {
  it("docks exactly when no row of the thread can be read", () => {
    fc.assert(fc.property(fc.array(row, { minLength: 1, maxLength: 4 }), band, (rows, view) => {
      const placement = selectedThreadDockPlacement(rows, view);
      expect(placement === undefined).toBe(rows.some((extent) => reads(extent, view)));
    }));
  });

  it("docks at the edge its row left through", () => {
    fc.assert(fc.property(fc.array(row, { minLength: 1, maxLength: 4 }), band, (rows, view) => {
      const placement = selectedThreadDockPlacement(rows, view);
      fc.pre(placement !== undefined);
      const docked = rows[placement.index];
      // Most of the row's hidden pixels lie past the edge the dock is on.
      let above = 0;
      let below = 0;
      for (let y = docked.top; y < docked.bottom; y += 1) {
        if (y < view.top) above += 1;
        if (y >= view.bottom) below += 1;
      }
      expect(placement.edge).toBe(above > 0 ? "top" : "bottom");
      expect(placement.edge === "top" ? above : below).toBeGreaterThan(0);
    }));
  });

  it("stands in for the row with the shortest way back", () => {
    fc.assert(fc.property(fc.array(row, { minLength: 2, maxLength: 4 }), band, (rows, view) => {
      const placement = selectedThreadDockPlacement(rows, view);
      fc.pre(placement !== undefined);
      // How far the list scrolls to put a row flush with the edge it is past.
      const wayBack = (extent: DockExtent): number =>
        extent.top < view.top ? view.top - extent.top : extent.bottom - view.bottom;
      const shortest = Math.min(...rows.map(wayBack));
      expect(wayBack(rows[placement.index])).toBe(shortest);
    }));
  });

  // A model of one scroll: the list moves up a pixel at a time under a still
  // band. The dock may go bottom -> none -> top and never back.
  it("moves from the bottom edge to none to the top edge as the list scrolls, in that order", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 200 }), band, (height, view) => {
      const order = ["bottom", "none", "top"];
      // From wholly below the band to wholly above it.
      const start = view.bottom + 10;
      const distance = view.bottom - view.top + height + 20;
      let reached = -1;
      for (let scrolled = 0; scrolled <= distance; scrolled += 1) {
        const extent = { top: start - scrolled, bottom: start - scrolled + height };
        const edge = selectedThreadDockPlacement([extent], view)?.edge ?? "none";
        const at = order.indexOf(edge);
        if (reached === -1) {
          expect(edge).toBe("bottom");
        }
        expect(at).toBeGreaterThanOrEqual(reached);
        reached = at;
      }
      expect(reached).toBe(2);
    }));
  });

  it("shows nothing for a list with no height, as when the sidebar is hidden", () => {
    fc.assert(fc.property(fc.array(row, { maxLength: 3 }), fc.integer(), (rows, top) => {
      expect(selectedThreadDockPlacement(rows, { top, bottom: top })).toBeUndefined();
    }));
  });
});

/*
 * The band starts under the stuck project header:
 *
 *   While the list is scrolled into its projects, the dock's top edge holds
 *   one position. A header handing over to the next one does not move it.
 *
 * The first cut followed the bottom of whatever touched the list's top. The
 * dock rode an outgoing header up, sat over the incoming one until it stuck,
 * then jumped a header's height back down, once per project scrolled past.
 *
 * The model lays projects out as the stylesheet does and places each header
 * the way `position: sticky; top: 0` does: at the list's top once its
 * natural place has scrolled past, and no lower than the end of its project.
 */
describe("stuckBandTop", () => {
  const HEADER = 24;
  const read = (extent: DockExtent): DockExtent => extent;
  // `.directory-row` pads 2px above its header.
  const PAD = 2;
  const project = fc.integer({ min: 0, max: 300 });

  it("holds one position through every project handoff", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 100 }),
      fc.array(project, { minLength: 1, maxLength: 5 }),
      (listTop, bodies) => {
        // Each project's natural top and bottom in list content.
        const sections: DockExtent[] = [];
        let cursor = 0;
        for (const body of bodies) {
          sections.push({ top: cursor, bottom: cursor + PAD + HEADER + body });
          cursor += PAD + HEADER + body;
        }
        for (let scrolled = PAD; scrolled < cursor - HEADER; scrolled += 1) {
          const headers = sections.map((section) => {
            const natural = listTop + section.top + PAD - scrolled;
            const lowest = listTop + section.bottom - scrolled - HEADER;
            const top = Math.min(Math.max(natural, listTop), lowest);
            return { top, bottom: top + HEADER };
          });
          expect(stuckBandTop(listTop, headers, [], read)).toBe(listTop + HEADER);
        }
      },
    ));
  });

  it("starts at the list's top when nothing is stuck there", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 5, max: 400 }),
      (listTop, below) => {
        const header = { top: listTop + below, bottom: listTop + below + HEADER };
        expect(stuckBandTop(listTop, [header], [], read)).toBe(listTop);
      },
    ));
  });

  it("starts under the project's divider when it is stuck under the header", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 12, max: 30 }),
      fc.boolean(),
      (listTop, dividerHeight, stuck) => {
        const header = { top: listTop, bottom: listTop + HEADER };
        // Stuck directly under the header, or further down among the rows.
        const dividerTop = stuck ? listTop + HEADER : listTop + HEADER + 60;
        const divider = { top: dividerTop, bottom: dividerTop + dividerHeight };
        // A divider scrolled out above the list is never the one stuck.
        const gone = { top: listTop - 80, bottom: listTop - 80 + dividerHeight };
        expect(stuckBandTop(listTop, [header], [gone, divider], read))
          .toBe(stuck ? listTop + HEADER + dividerHeight : listTop + HEADER);
      },
    ));
  });

  it("agrees with a linear scan of mixed-size projects using logarithmic probes", () => {
    const section = fc.record({
      header: fc.integer({ min: 24, max: 52 }),
      body: fc.integer({ min: 0, max: 400 }),
      hasDivider: fc.boolean(),
    });
    fc.assert(fc.property(
      fc.array(section, { minLength: 24, maxLength: 48 }),
      fc.integer({ min: 0, max: 20_000 }),
      (sections, offset) => {
        const listTop = 51.5;
        let cursor = listTop - offset;
        const headers: DockExtent[] = [];
        const dividers: DockExtent[] = [];
        for (const { header, body, hasDivider } of sections) {
          const start = cursor + PAD;
          const end = start + header + body + (hasDivider ? 30 : 0);
          const headerTop = Math.min(Math.max(start, listTop), end - header);
          headers.push({ top: headerTop, bottom: headerTop + header });
          if (hasDivider) {
            const top = Math.min(Math.max(start + header + 4, listTop + header), end - 26);
            dividers.push({ top, bottom: top + 24 });
          }
          cursor = end;
        }
        const overlaps = (edge: number) => (extent: DockExtent) =>
          extent.top <= edge + 4 && extent.bottom > edge;
        const firstHeader = headers.find(overlaps(listTop));
        const belowHeader = listTop + (firstHeader ? firstHeader.bottom - firstHeader.top : 0);
        const expected = dividers.find(overlaps(belowHeader))?.bottom ?? belowHeader;
        let probes = 0;
        const measured = stuckBandTop(listTop, headers, dividers, (extent) => {
          probes++;
          return extent;
        });
        expect(measured).toBe(expected);
        expect(probes).toBeLessThanOrEqual(
          Math.ceil(Math.log2(headers.length + 1)) + Math.ceil(Math.log2(dividers.length + 1)),
        );
      },
    ));
  });
});

/*
 * The bottom of the band: the Unpinned divider of the project crossing the
 * list's bottom edge sticks there while that project's pinned rows run past
 * it, and the rows behind it are as hidden as rows under a stuck header.
 *
 * The layout below resolves each divider the way Chromium resolves
 * `position: sticky; top: <header>; bottom: 0` inside its project's thread
 * list, and the oracle scans pixel rows up from the list's bottom edge for
 * the run a divider covers. Neither shares the binary search.
 */
describe("stuckBandBottom", () => {
  const PAD = 2;
  const DIVIDER = 24;
  const section = fc.record({
    header: fc.integer({ min: 24, max: 52 }),
    pinned: fc.integer({ min: 0, max: 600 }),
    unpinned: fc.integer({ min: 0, max: 600 }),
  });

  function layOut(
    sections: readonly { header: number; pinned: number; unpinned: number }[],
    listTop: number,
    listBottom: number,
    offset: number,
  ): DockExtent[] {
    const dividers: DockExtent[] = [];
    let cursor = listTop - offset;
    for (const { header, pinned, unpinned } of sections) {
      const listStart = cursor + PAD + header;
      // A project shows the divider only when it has pinned rows above it.
      const hasDivider = pinned > 0;
      const listEnd = listStart + pinned + (hasDivider ? 4 + DIVIDER : 0) + unpinned;
      if (hasDivider) {
        const natural = listStart + pinned + 4;
        let top = natural;
        // Bottom inset: shift up to the list's bottom, never above the list start.
        if (natural + DIVIDER > listBottom) top = Math.max(listBottom - DIVIDER, listStart);
        // Top inset wins: under the header, never past the list's end.
        top = Math.max(top, Math.min(listTop + header, listEnd - DIVIDER));
        dividers.push({ top, bottom: top + DIVIDER });
      }
      cursor = listEnd;
    }
    return dividers;
  }

  function coveredFrom(listBottom: number, dividers: readonly DockExtent[]): number {
    let edge = listBottom;
    while (dividers.some((divider) => divider.top <= edge - 1 && divider.bottom >= edge)) {
      edge -= 1;
    }
    return edge;
  }

  it("ends where a pixel scan finds the divider covering the bottom edge, in logarithmic probes", () => {
    fc.assert(fc.property(
      fc.array(section, { minLength: 1, maxLength: 40 }),
      fc.integer({ min: 0, max: 40 }),
      fc.integer({ min: 80, max: 900 }),
      fc.integer({ min: 0, max: 20_000 }),
      (sections, listTop, height, offset) => {
        const listBottom = listTop + height;
        const dividers = layOut(sections, listTop, listBottom, offset);
        let probes = 0;
        const measured = stuckBandBottom(listBottom, dividers, (extent) => {
          probes++;
          return extent;
        });
        expect(measured).toBe(coveredFrom(listBottom, dividers));
        expect(probes).toBeLessThanOrEqual(Math.ceil(Math.log2(dividers.length + 1)));
      },
    ));
  });

  it("holds the divider at the bottom edge for the whole time its pinned rows cross it", () => {
    fc.assert(fc.property(
      fc.integer({ min: 24, max: 52 }),
      fc.integer({ min: 200, max: 1200 }),
      fc.integer({ min: 0, max: 300 }),
      fc.integer({ min: 200, max: 600 }),
      (header, pinned, unpinned, height) => {
        const listTop = 0;
        const listBottom = height;
        const project = [{ header, pinned, unpinned }];
        const listStart = PAD + header;
        // From the first pinned row crossing the bottom edge until the
        // divider's own place comes into view.
        for (let offset = 0; offset < listStart + pinned; offset += 7) {
          const crossing = listStart - offset < listBottom - DIVIDER
            && listStart + pinned + 4 - offset + DIVIDER > listBottom;
          const dividers = layOut(project, listTop, listBottom, offset);
          if (crossing && listStart + pinned + 4 - offset > listTop + header) {
            expect(stuckBandBottom(listBottom, dividers, (extent) => extent))
              .toBe(listBottom - DIVIDER);
          }
        }
      },
    ), { numRuns: 60 });
  });

  it("ends at the list's bottom when no project with pinned rows crosses it", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 400 }),
      (listBottom, below) => {
        const above = { top: listBottom - 300, bottom: listBottom - 276 };
        const after = { top: listBottom + below, bottom: listBottom + below + DIVIDER };
        expect(stuckBandBottom(listBottom, [above, after], (extent) => extent)).toBe(listBottom);
      },
    ));
  });
});
