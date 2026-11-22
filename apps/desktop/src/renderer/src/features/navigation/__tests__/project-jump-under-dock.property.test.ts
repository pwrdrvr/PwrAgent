import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { jumpRelanding, jumpScrollPlan, spyProjects, type JumpLanding } from "../project-index";
import { selectedThreadDockPlacement } from "../selected-thread-dock";

/*
 * The rule a project-index jump promises:
 *
 *   A jump lands its project where the project's header sticks, so the
 *   header rests in its own place and covers none of the project's rows.
 *   While the selected thread's dock is at the top of the list, the headers
 *   stick under it, `reserve` px down. The jump can itself bring the dock
 *   (scrolling the open thread's row away) or send it off (scrolling the row
 *   back), and the landing follows without ever going back and forth.
 *
 * The jump once landed every project at the list's top edge. With the dock
 * up, the stuck header slid down by the reserve, over the project's first
 * card.
 *
 * The model is a list of project sections with one open-thread row in one
 * of them. The oracle for the dock is the dock's own placement rule, read
 * against the list as the dock reads it: band below the stuck header.
 */

type World = {
  viewport: number;
  header: number;
  sections: number[];
  /** Which section holds the open thread's row, where in it, how tall. */
  row: { section: number; offset: number; height: number } | undefined;
  reserve: number;
  start: number;
  target: number;
};

const world: fc.Arbitrary<World> = fc
  .record({
    viewport: fc.integer({ min: 160, max: 700 }),
    header: fc.integer({ min: 24, max: 40 }),
    sections: fc.array(fc.integer({ min: 0, max: 600 }), { minLength: 2, maxLength: 8 }),
    reserve: fc.integer({ min: 40, max: 80 }),
    rowPick: fc.option(
      fc.record({
        section: fc.nat(),
        offset: fc.nat(),
        height: fc.integer({ min: 24, max: 90 }),
      }),
      { nil: undefined },
    ),
    start: fc.nat(),
    target: fc.nat(),
  })
  .map(({ viewport, header, sections: bodies, reserve, rowPick, start, target }) => {
    const sections = bodies.map((body) => header + body);
    let row: World["row"];
    if (rowPick) {
      const section = rowPick.section % sections.length;
      const room = sections[section]! - header - rowPick.height;
      // A section too short for the row grows to hold it.
      if (room < 0) sections[section] = header + rowPick.height;
      row = {
        section,
        offset: header + (room > 0 ? rowPick.offset % (room + 1) : 0),
        height: rowPick.height,
      };
    }
    // A list that fits its viewport has nowhere to scroll a jump to; the
    // last project takes up the difference.
    const short = viewport - sections.reduce((sum, height) => sum + height, 0);
    if (short > 0) sections[sections.length - 1]! += short;
    const content = sections.reduce((sum, height) => sum + height, 0);
    return {
      viewport, header, sections, row, reserve,
      start: start % (Math.max(0, content - viewport) + 1),
      target: target % sections.length,
    };
  });

/** A list that scrolls, with the jump's tail below its content. */
class List {
  scrollTop: number;
  tail = 0;
  readonly tops: number[];
  readonly content: number;

  constructor(readonly w: World) {
    this.scrollTop = w.start;
    let top = 0;
    this.tops = w.sections.map((height) => {
      const at = top;
      top += height;
      return at;
    });
    this.content = top;
  }

  /** A section's box in viewport coordinates. */
  section(index: number): { top: number; bottom: number } {
    const top = this.tops[index]! - this.scrollTop;
    return { top, bottom: top + this.w.sections[index]! };
  }

  /** The dock's reserve: up when the open row has left through the top. */
  reserve(): number {
    const { row } = this.w;
    if (!row) return 0;
    // The dock reads the band without its own reserve: below the header
    // stuck at the list's top edge.
    const stuck = this.w.sections.some((_, index) => {
      const box = this.section(index);
      return box.top <= 0 && box.bottom > 0;
    });
    const top = this.tops[row.section]! + row.offset - this.scrollTop;
    const placement = selectedThreadDockPlacement(
      [{ top, bottom: top + row.height }],
      { top: stuck ? this.w.header : 0, bottom: this.w.viewport },
    );
    return placement?.edge === "top" ? this.w.reserve : 0;
  }

  land(target: number, reserve: number): void {
    const plan = jumpScrollPlan({
      scrollTop: this.scrollTop,
      blockTop: this.section(target).top,
      // As the DOM reports it: never less than the viewport.
      scrollHeight: Math.max(this.content + this.tail, this.w.viewport),
      clientHeight: this.w.viewport,
      tailHeight: this.tail,
      topInset: reserve,
    });
    this.tail = plan.tailHeight;
    // The tail makes the plan's offset reachable.
    expect(plan.scrollTop).toBeLessThanOrEqual(
      Math.max(0, this.content + this.tail - this.w.viewport),
    );
    this.scrollTop = plan.scrollTop;
  }
}

/** Jump, then answer every reserve change the way DirectoriesList does. */
function jump(w: World): { list: List; reserve: number; relands: number; settled: boolean } {
  const list = new List(w);
  let reserve = list.reserve();
  list.land(w.target, reserve);
  let landing: JumpLanding = { reserve, lowered: false };
  let relands = 0;
  for (let step = 0; step < 20; step += 1) {
    const next = list.reserve();
    if (next === reserve) return { list, reserve, relands, settled: true };
    reserve = next;
    const relanding = jumpRelanding(landing, reserve);
    if (relanding) {
      list.land(w.target, reserve);
      landing = relanding;
      relands += 1;
    }
  }
  return { list, reserve, relands, settled: false };
}

describe("a project-index jump under the selected thread's dock", () => {
  it("settles, with the project's header resting in its own place", () => {
    fc.assert(fc.property(world, (w) => {
      const { list, reserve, relands, settled } = jump(w);
      expect(settled).toBe(true);
      expect(relands).toBeLessThanOrEqual(3);
      const { top } = list.section(w.target);
      // The header sticks at `reserve`. A section starting above that line
      // has its header slid down over its own first rows.
      expect(top).toBeGreaterThanOrEqual(reserve);
      if (reserve > 0) {
        // Under the dock: flush against it, no strip of another project.
        expect(top).toBe(reserve);
      } else if (!w.row) {
        // No dock ever: flush with the list's top edge.
        expect(top).toBe(0);
      } else {
        // The dock left because the open row is in view; the strip above
        // the project, if any, is no taller than the dock was.
        expect(top).toBeLessThanOrEqual(w.reserve);
      }
    }), { numRuns: 2000 });
  });

  it("names a project landed where the headers stick as the index's current one", () => {
    fc.assert(fc.property(world, (w) => {
      const { list, reserve } = jump(w);
      if (list.section(w.target).top !== reserve) return;
      // The project above ends under the dock: its header has gone with it.
      const spy = spyProjects(w.sections.length, (index) => ({
        key: `p${index}`,
        ...list.section(index),
      }), w.viewport, reserve);
      expect(spy.current).toBe(`p${w.target}`);
    }), { numRuns: 1000 });
  });
});
