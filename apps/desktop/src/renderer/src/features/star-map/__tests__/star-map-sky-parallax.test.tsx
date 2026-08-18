import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { STAR_MAP_SKY_PARALLAX } from "../star-map-view-geometry";
import { StarMapScreen } from "../StarMapScreen";

/**
 * The sky is a parallax layer: it follows the map a fraction of the way,
 * so the map reads as sitting in front of the stars rather than painted on
 * them. These pin the wiring — that the screen actually moves the sky when
 * the operator moves the map, by the geometry's fraction, and through the
 * same live path the canvas uses.
 */

function buildDesktopApi(): DesktopApi {
  return {
    readFederationHealth: vi.fn(async () => ({
      health: {
        enabled: false,
        role: "client" as const,
        status: "disabled" as const,
        instanceId: "pwr_local",
        localCelestialIcon: "sun" as const,
        localLabel: "Harold-MBP-M5-Max",
        localProfileName: "default",
        peers: [],
      },
    })),
    onAgentEvent: vi.fn(() => () => undefined),
  } as unknown as DesktopApi;
}

function thread(id: string): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    titleSource: "generated",
    linkedDirectories: [
      { id: `${id}-dir`, label: "PwrSnap", path: "/repos/PwrSnap", kind: "local" },
    ],
    source: "codex",
    inbox: { inInbox: true, reason: "updated-since-seen" },
    updatedAt: 100,
  } as unknown as NavigationThreadSummary;
}

function canvas(): HTMLElement {
  const element = document.querySelector(".star-map__canvas");
  if (!element) throw new Error("canvas not found");
  return element as HTMLElement;
}

function sky(): HTMLElement {
  const element = document.querySelector(".star-map__sky");
  if (!element) throw new Error("sky not found");
  return element as HTMLElement;
}

function canvasPosition(): { x: number; y: number } {
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
    canvas().style.transform,
  );
  if (!match) throw new Error(`unparsable transform: ${canvas().style.transform}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

function skyOffset(): { x: number; y: number } {
  const style = sky().style;
  return {
    x: Number.parseFloat(style.getPropertyValue("--star-map-sky-x")),
    y: Number.parseFloat(style.getPropertyValue("--star-map-sky-y")),
  };
}

/**
 * jsdom measures every element as 0x0, so the screen keeps its unmeasured
 * default viewport — which is also the sky's tile.
 */
const VIEWPORT = { width: 1280, height: 800 };

/**
 * How far the sky moved on one axis, read through the tile wrap: the sky
 * shows the same field at offsets a whole tile apart, so a move that
 * crosses the origin comes back as `delta ± tile` and means the same thing.
 */
function skyTravel(before: number, after: number, tile: number): number {
  const delta = (after - before) % tile;
  if (delta > tile / 2) return delta - tile;
  if (delta <= -tile / 2) return delta + tile;
  return delta;
}

/** Drag the canvas by a fixed delta, the way an operator pans. */
function pan(dx: number, dy: number) {
  const viewport = document.querySelector(".star-map__viewport");
  if (!viewport) throw new Error("viewport not found");
  fireEvent.pointerDown(viewport, { button: 0, clientX: 500, clientY: 400 });
  fireEvent.pointerMove(window, { clientX: 500 + dx, clientY: 400 + dy });
  fireEvent.pointerUp(window, { clientX: 500 + dx, clientY: 400 + dy });
}

async function renderMap() {
  window.localStorage.setItem(
    "pwragent.starMap.viewPreferences",
    JSON.stringify({ layout: "orbit" }),
  );
  render(
    <StarMapScreen
      desktopApi={buildDesktopApi()}
      localThreads={Array.from({ length: 6 }, (_, index) => thread(`t${index}`))}
      sessionKeys={{}}
      localInstanceLabel="Mac-Mini-M4"
      onOpenLocalThread={() => undefined}
      onFocusLocalInstance={() => undefined}
    />,
  );
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: /Open this instance/ }),
    ).toBeTruthy();
  });
}

describe("star map sky parallax", () => {
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
  });

  it("tiles the star field so the sky can slide without exposing an edge", async () => {
    await renderMap();
    // One field, drawn four times: the tile is a def, and 2×2 uses cover
    // twice the viewport on each axis.
    expect(sky().querySelectorAll("defs .star-map__star").length).toBeGreaterThan(0);
    expect(sky().querySelectorAll("use").length).toBe(4);
    expect(sky().getAttribute("viewBox")).toBe("0 0 200 200");
  });

  it("moves the sky a fraction of the pan, in the same direction", async () => {
    await renderMap();
    const canvasBefore = canvasPosition();
    const skyBefore = skyOffset();

    pan(-320, -180);

    const canvasAfter = canvasPosition();
    const skyAfter = skyOffset();
    // Sanity: the pan itself landed.
    expect(canvasAfter.x).toBeLessThan(canvasBefore.x);
    expect(canvasAfter.y).toBeLessThan(canvasBefore.y);
    // The sky followed, but only by the parallax fraction.
    expect(skyTravel(skyBefore.x, skyAfter.x, VIEWPORT.width)).toBeCloseTo(
      (canvasAfter.x - canvasBefore.x) * STAR_MAP_SKY_PARALLAX,
      6,
    );
    expect(skyTravel(skyBefore.y, skyAfter.y, VIEWPORT.height)).toBeCloseTo(
      (canvasAfter.y - canvasBefore.y) * STAR_MAP_SKY_PARALLAX,
      6,
    );
  });

  it("keeps the sky's offset inside one tile at rest and after a pan", async () => {
    await renderMap();
    for (const move of [
      [0, 0],
      [-320, -180],
      [900, 500],
    ] as const) {
      if (move[0] || move[1]) pan(move[0], move[1]);
      const offset = skyOffset();
      expect(offset.x).toBeGreaterThan(-VIEWPORT.width);
      expect(offset.x).toBeLessThanOrEqual(0);
      expect(offset.y).toBeGreaterThan(-VIEWPORT.height);
      expect(offset.y).toBeLessThanOrEqual(0);
    }
  });

  it("writes the sky offset on the live drag frame, not only on release", async () => {
    await renderMap();
    const viewport = document.querySelector(".star-map__viewport")!;
    let frame: FrameRequestCallback | undefined;
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frame = callback;
        return 1;
      });
    try {
      const before = skyOffset();
      fireEvent.pointerDown(viewport, { button: 0, clientX: 500, clientY: 400 });
      fireEvent.pointerMove(window, { clientX: 300, clientY: 400 });
      expect(frame).toBeDefined();
      frame!(0);
      // Mid-drag, before any pointerup and any React commit, the sky has
      // already followed the canvas.
      expect(skyTravel(before.x, skyOffset().x, VIEWPORT.width)).toBeCloseTo(
        -200 * STAR_MAP_SKY_PARALLAX,
        6,
      );
      expect(skyTravel(before.y, skyOffset().y, VIEWPORT.height)).toBeCloseTo(0, 6);
      fireEvent.pointerUp(window, { clientX: 300, clientY: 400 });
    } finally {
      raf.mockRestore();
    }
  });
});
