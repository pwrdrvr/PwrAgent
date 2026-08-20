import { describe, expect, it } from "vitest";
import {
  computeProjectLayout,
  EMPTY_PROJECT_LAYOUT,
} from "../star-map-project-layout";

/**
 * Projects-lens galaxy packing.
 *
 * The rule these pin is "a project sits as far out as the projects
 * already placed force it to, and no further". The layout this replaced
 * mapped mass onto an absolute radius over a fixed span, which decided a
 * project's distance from the core before anything had been placed.
 */

const CARD_WIDTH = 200;

function layoutOf(
  projects: readonly { key: string; cardCount: number; mass?: number }[],
) {
  return computeProjectLayout({ cardWidth: CARD_WIDTH, projects });
}

/** Distance of each project from the galactic core, by key. */
function radii(layout: ReturnType<typeof layoutOf>): Map<string, number> {
  return new Map(
    layout.projects.map((project) => [
      project.key,
      Math.hypot(project.x - layout.core.x, project.y - layout.core.y),
    ]),
  );
}

function overlappingPairs(layout: ReturnType<typeof layoutOf>): string[] {
  const pairs: string[] = [];
  for (let left = 0; left < layout.projects.length; left += 1) {
    for (let right = left + 1; right < layout.projects.length; right += 1) {
      const a = layout.projects[left];
      const b = layout.projects[right];
      if (
        Math.abs(a.x - b.x) < a.rx + b.rx
        && Math.abs(a.y - b.y) < a.ry + b.ry
      ) {
        pairs.push(`${a.key}/${b.key}`);
      }
    }
  }
  return pairs;
}

describe("computeProjectLayout", () => {
  it("seats the heaviest project on the core", () => {
    const layout = layoutOf([
      { cardCount: 12, key: "busy", mass: 30 },
      { cardCount: 2, key: "quiet", mass: 3 },
    ]);
    const distances = radii(layout);
    expect(distances.get("busy")).toBe(0);
    expect(distances.get("quiet")).toBeGreaterThan(0);
  });

  it("orders radially by mass whatever order the caller passes", () => {
    const heaviestFirst = radii(
      layoutOf([
        { cardCount: 12, key: "busy", mass: 30 },
        { cardCount: 4, key: "middling", mass: 9 },
        { cardCount: 2, key: "quiet", mass: 3 },
      ]),
    );
    const lightestFirst = radii(
      layoutOf([
        { cardCount: 2, key: "quiet", mass: 3 },
        { cardCount: 4, key: "middling", mass: 9 },
        { cardCount: 12, key: "busy", mass: 30 },
      ]),
    );
    // Same galaxy either way — the seat order is derived, not trusted.
    expect([...lightestFirst]).toEqual([...heaviestFirst]);
    expect(heaviestFirst.get("busy")).toBe(0);
    expect(heaviestFirst.get("quiet")).toBeGreaterThan(
      heaviestFirst.get("middling")!,
    );
  });

  /**
   * The case the old mass-to-radius mapping got worst. Three one-thread
   * projects have almost no spread in mass, so every one of them but the
   * heaviest normalised to the lightest end of the span and landed at the
   * rim, 1160px out, around an empty middle.
   */
  it("keeps a small fleet compact instead of flinging it to the rim", () => {
    const distances = radii(
      layoutOf([
        { cardCount: 1, key: "a", mass: 2 },
        { cardCount: 1, key: "b", mass: 2 },
        { cardCount: 2, key: "c", mass: 3 },
      ]),
    );
    for (const [key, radius] of distances) {
      expect({ key, radius: radius < 600 }).toEqual({ key, radius: true });
    }
  });

  it("never overlaps two projects' drawn extents", () => {
    // A spread wide enough that the light tail has to tuck between the
    // heavy clouds rather than queue behind them on its own arm.
    const projects = Array.from({ length: 24 }, (_, index) => ({
      cardCount: Math.max(1, 16 - index),
      key: `project-${index}`,
      mass: 40 - index,
    }));
    expect(overlappingPairs(layoutOf(projects))).toEqual([]);
  });

  it("spaces projects by the extent the caller supplies, not the ring", () => {
    const wide = computeProjectLayout({
      cardWidth: CARD_WIDTH,
      projects: [
        { cardCount: 1, extent: { rx: 900, ry: 400 }, key: "wide", mass: 9 },
        { cardCount: 1, key: "next", mass: 4 },
      ],
    });
    const narrow = layoutOf([
      { cardCount: 1, key: "wide", mass: 9 },
      { cardCount: 1, key: "next", mass: 4 },
    ]);
    expect(radii(wide).get("next")!).toBeGreaterThan(
      radii(narrow).get("next")!,
    );
  });

  it("is deterministic", () => {
    const projects = [
      { cardCount: 9, key: "one", mass: 14 },
      { cardCount: 3, key: "two", mass: 6 },
      { cardCount: 1, key: "three", mass: 2 },
    ];
    expect(layoutOf(projects)).toEqual(layoutOf(projects));
  });

  /**
   * Identity, not just shape. `anchorBody` in StarMapScreen memoises on
   * `projectLayout.core`, and the lenses that are not drawing projects
   * hold this same constant — a fresh literal per call would churn that
   * dependency on every render for a lens with no projects on screen.
   */
  it("returns the shared empty galaxy for an empty fleet", () => {
    expect(layoutOf([])).toBe(EMPTY_PROJECT_LAYOUT);
    expect(EMPTY_PROJECT_LAYOUT.projects).toEqual([]);
    expect(EMPTY_PROJECT_LAYOUT.arms).toEqual([]);
    expect(EMPTY_PROJECT_LAYOUT.canvasWidth).toBe(0);
  });
});
