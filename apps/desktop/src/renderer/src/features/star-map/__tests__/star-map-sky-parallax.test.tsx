import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { starMapSkyOffset } from "../star-map-view-geometry";
import { StarMapScreen } from "../StarMapScreen";

/**
 * The sky is a parallax layer: it follows the map a fraction of the way,
 * so the map reads as sitting in front of the stars rather than painted on
 * them. These pin the wiring — that the screen writes the sky offset the
 * geometry prescribes for wherever the canvas is, through the same live
 * path the canvas uses. The fraction, the wrap, and the zoom-invariance are
 * the geometry's own tests.
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

/** The view as the canvas transform currently shows it. */
function canvasView(): { x: number; y: number; scale: number } {
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(
    canvas().style.transform,
  );
  if (!match) throw new Error(`unparsable transform: ${canvas().style.transform}`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
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

/** The sky sits exactly where the geometry says it should for the canvas. */
function expectSkyFollowsCanvas() {
  const expected = starMapSkyOffset({ view: canvasView(), viewport: VIEWPORT });
  const actual = skyOffset();
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
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

  it("places the sky for the opening view and moves it with a pan", async () => {
    await renderMap();
    // Placed on open, before the operator touches anything.
    expectSkyFollowsCanvas();
    const before = canvasView();
    const skyBefore = skyOffset();

    pan(-320, -180);

    // Sanity: the pan itself landed, and the sky did not sit still.
    const after = canvasView();
    expect(after.x).toBeLessThan(before.x);
    expect(after.y).toBeLessThan(before.y);
    expect(skyOffset()).not.toEqual(skyBefore);
    expectSkyFollowsCanvas();

    // A pan back the other way, across the wrap the opening view sits near.
    pan(900, 500);
    expectSkyFollowsCanvas();
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
      const before = canvasView();
      fireEvent.pointerDown(viewport, { button: 0, clientX: 500, clientY: 400 });
      fireEvent.pointerMove(window, { clientX: 300, clientY: 400 });
      expect(frame).toBeDefined();
      frame!(0);
      // Mid-drag, before any pointerup and any React commit, the canvas has
      // moved by hand — and the sky has already followed it.
      expect(canvasView().x).toBeCloseTo(before.x - 200, 6);
      expectSkyFollowsCanvas();
      fireEvent.pointerUp(window, { clientX: 300, clientY: 400 });
    } finally {
      raf.mockRestore();
    }
  });
});
