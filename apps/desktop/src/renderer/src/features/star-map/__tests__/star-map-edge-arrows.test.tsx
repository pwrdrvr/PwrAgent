import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  computeStarMapEdgeArrows,
  STAR_MAP_EDGE_INSET,
} from "../star-map-edge-arrows";
import {
  STAR_MAP_FLIGHT_SCALE,
  starMapViewFocusedOn,
} from "../star-map-flight";
import { StarMapScreen } from "../StarMapScreen";

/**
 * The edge arrows on the live screen: that a body panned out of the
 * window gets one, that it tracks the gesture frame by frame rather than
 * only the landing, and that clicking it flies the camera to the body.
 * The geometry itself — which side, where, which way — is
 * `star-map-edge-arrows.test.ts`; here it is only used to say where an
 * arrow SHOULD be for the transform the canvas is actually showing.
 */

/** The viewport the screen assumes until a real measurement arrives. */
const VIEWPORT = { width: 1280, height: 800 };

const LOCAL_LABEL = "Harold-MBP-M5-Max";
const PEER_LABEL = "Mac-Mini-M4";

function buildDesktopApi(): DesktopApi {
  return {
    readFederationHealth: vi.fn(async () => ({
      health: {
        enabled: true,
        role: "gateway" as const,
        status: "listening" as const,
        instanceId: "pwr_local",
        localCelestialIcon: "sun" as const,
        localLabel: LOCAL_LABEL,
        localProfileName: "default",
        peers: [
          {
            id: "pwr_mini",
            label: PEER_LABEL,
            profileName: "default",
            role: "client" as const,
            // Offline on purpose: a body on the map with no thread feed to
            // fetch, so the screen needs nothing beyond health.
            status: "disconnected" as const,
            capabilities: [],
          },
        ],
      },
    })) as unknown as DesktopApi["readFederationHealth"],
    onAgentEvent: vi.fn(() => () => undefined),
  } as unknown as DesktopApi;
}

function thread(id: string, directory: string): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    titleSource: "generated",
    linkedDirectories: [
      {
        id: `${id}-dir`,
        label: directory,
        path: `/repos/${directory}`,
        kind: "local",
      },
    ],
    source: "codex",
    inbox: { inInbox: true, reason: "updated-since-seen" },
    updatedAt: 100,
  } as unknown as NavigationThreadSummary;
}

function px(value: string | undefined): number {
  return Number.parseFloat(value ?? "0");
}

function canvas(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".star-map__canvas");
  if (!element) throw new Error("canvas not found");
  return element;
}

/** The view as the canvas transform currently shows it. */
function canvasView(): { x: number; y: number; scale: number } {
  const raw = canvas().style.transform;
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(raw);
  if (!match) throw new Error(`unparsable transform: ${raw}`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

function canvasSize(): { width: number; height: number } {
  return { width: px(canvas().style.width), height: px(canvas().style.height) };
}

/** Where the layout put an instance body, in canvas units. */
function bodyPoint(instanceId: string): { x: number; y: number } {
  const anchor = document
    .querySelector(`[data-instance-id="${instanceId}"]`)
    ?.closest<HTMLElement>(".star-map__anchor");
  if (!anchor) throw new Error(`no body for ${instanceId}`);
  return { x: px(anchor.style.left), y: px(anchor.style.top) };
}

function arrowButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(".star-map__edge-arrow")];
}

function arrowFor(label: string): HTMLButtonElement | null {
  return (
    arrowButtons().find(
      (button) => button.getAttribute("aria-label") === `Fly to ${label}`,
    ) ?? null
  );
}

function viewport(): Element {
  const element = document.querySelector(".star-map__viewport");
  if (!element) throw new Error("viewport not found");
  return element;
}

/** Drag the canvas by a fixed delta and let go, the way an operator pans. */
function pan(dx: number, dy: number) {
  fireEvent.pointerDown(viewport(), { button: 0, clientX: 500, clientY: 400 });
  fireEvent.pointerMove(window, { clientX: 500 + dx, clientY: 400 + dy });
  fireEvent.pointerUp(window, { clientX: 500 + dx, clientY: 400 + dy });
}

/** Let one animation frame run, so a gesture paints a frame. */
async function flushFrame() {
  await act(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve(undefined));
    });
  });
}

async function renderMap(
  layout: "orbit" | "projects" | "lanes",
  threads: NavigationThreadSummary[],
) {
  window.localStorage.setItem(
    "pwragent.starMap.viewPreferences",
    JSON.stringify({ layout }),
  );
  render(
    <StarMapScreen
      desktopApi={buildDesktopApi()}
      localThreads={threads}
      sessionKeys={{}}
      localInstanceLabel="fallback"
      onOpenLocalThread={() => undefined}
      onFocusLocalInstance={() => undefined}
    />,
  );
}

describe("star map edge arrows", () => {
  beforeEach(() => {
    // Flights travel over half a second of frames; under reduced motion
    // they land in one commit, which is the state the click assertion is
    // about. jsdom answers every media query with `false` otherwise.
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        onchange: null,
        dispatchEvent: () => false,
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
  });

  it("points at a body the operator has panned out of the window, from the side it left by", async () => {
    await renderMap("orbit", [thread("t1", "PwrSnap")]);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Open this instance/ })).toBeTruthy();
    });
    // The map opens on the local body, so it is in the window and has no arrow.
    expect(arrowFor(LOCAL_LABEL)).toBeNull();

    // Drag the map a long way left: the local body leaves through the
    // left side of the window.
    pan(-1000, 0);

    const arrow = arrowFor(LOCAL_LABEL);
    expect(arrow).not.toBeNull();
    expect(arrow!.className).toContain("star-map__edge-arrow--left");
    expect(arrow!.style.left).toBe(`${STAR_MAP_EDGE_INSET.left}px`);
    // Exactly where the geometry puts it for the transform on screen, not
    // somewhere that merely looks left.
    const [expected] = computeStarMapEdgeArrows({
      targets: [{ key: "local", ...bodyPoint("pwr_local") }],
      view: canvasView(),
      viewport: VIEWPORT,
    });
    expect(expected?.edge).toBe("left");
    expect(px(arrow!.style.top)).toBeCloseTo(expected!.y, 3);
    expect(arrow!.style.getPropertyValue("--star-map-edge-angle")).toBe(
      `${expected!.angle}deg`,
    );
    // And the group is what a screen reader lands on, named.
    expect(screen.getByRole("group", { name: "Off-screen bodies" })).toBeTruthy();
  });

  it("moves with every painted frame of a drag, not only the landing", async () => {
    await renderMap("orbit", [thread("t1", "PwrSnap")]);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Open this instance/ })).toBeTruthy();
    });
    pan(-1000, 0);
    const before = px(arrowFor(LOCAL_LABEL)!.style.top);

    // A second drag, held: the pointer moves and a frame paints, but the
    // pointer has NOT come up, so React state still holds the last landing.
    fireEvent.pointerDown(viewport(), { button: 0, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 400 + 150 });
    await flushFrame();

    const during = arrowFor(LOCAL_LABEL);
    expect(during).not.toBeNull();
    // The body is now further up-left of the window's middle, so the
    // arrow on the left rail has ridden up to meet the steeper ray.
    expect(px(during!.style.top)).not.toBeCloseTo(before, 3);
    const [expected] = computeStarMapEdgeArrows({
      targets: [{ key: "local", ...bodyPoint("pwr_local") }],
      view: canvasView(),
      viewport: VIEWPORT,
    });
    expect(px(during!.style.top)).toBeCloseTo(expected!.y, 3);

    fireEvent.pointerUp(window, { clientX: 500, clientY: 550 });
  });

  it("flies the camera to the body when clicked, and the arrow goes away", async () => {
    await renderMap("orbit", [thread("t1", "PwrSnap")]);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Open this instance/ })).toBeTruthy();
    });
    pan(-1000, 0);
    const arrow = arrowFor(LOCAL_LABEL);
    expect(arrow).not.toBeNull();

    const body = bodyPoint("pwr_local");
    const expected = starMapViewFocusedOn({
      rect: { x: body.x, y: body.y, width: 0, height: 0 },
      canvas: canvasSize(),
      viewport: VIEWPORT,
      scale: canvasView().scale,
    });
    fireEvent.click(arrow!);

    await waitFor(() => {
      const view = canvasView();
      expect(view.x).toBeCloseTo(expected.x, 3);
      expect(view.y).toBeCloseTo(expected.y, 3);
      expect(view.scale).toBeCloseTo(expected.scale, 6);
    });
    // The body is back in the window, so nothing points at it any more.
    expect(arrowFor(LOCAL_LABEL)).toBeNull();
  });

  it("arrives at the operator's own zoom rather than the palette's landing zoom", async () => {
    // The claim this file is named for, made falsifiable. At scale 1 the
    // operator's zoom and `starMapFlightScale`'s 1:1 landing are the same
    // number, so the assertion above passes either way — swapping the one
    // for the other in `flyToEdgeTarget` left all five tests green. Zoom
    // out first and the two diverge: the palette would pull the map back
    // to 1, and a body is legible at every zoom the map allows, so someone
    // looking at the whole fleet asked to be taken to a body, not zoomed
    // in on it.
    await renderMap("orbit", [thread("t1", "PwrSnap")]);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Open this instance/ })).toBeTruthy();
    });
    // One gentle pinch: half scale, well below STAR_MAP_FLIGHT_SCALE but
    // still leaving the pan clamp room to push a body off the window —
    // slammed to MIN_ZOOM the whole canvas fits and nothing can leave.
    fireEvent.wheel(viewport(), {
      ctrlKey: true,
      deltaY: 120,
      clientX: 640,
      clientY: 400,
    });
    const zoomedOut = canvasView().scale;
    expect(zoomedOut).toBeLessThan(STAR_MAP_FLIGHT_SCALE);
    // Push a body out of the window at that zoom.
    pan(-1000, -400);
    const arrow = arrowFor(LOCAL_LABEL);
    expect(arrow).not.toBeNull();

    fireEvent.click(arrow!);
    await waitFor(() => {
      expect(arrowFor(LOCAL_LABEL)).toBeNull();
    });
    // The zoom the operator set, untouched.
    expect(canvasView().scale).toBeCloseTo(zoomedOut, 6);
    expect(canvasView().scale).not.toBeCloseTo(STAR_MAP_FLIGHT_SCALE, 6);
  });

  it("keeps the map's keyboard after an arrow click, so Escape still unwinds", async () => {
    // The clicked button is culled the moment the flight lands — the test
    // above asserts exactly that — and Chromium focuses a button on
    // mousedown. Without an explicit hand-back, focus falls to
    // `document.body`, which is outside the layer, and the layer's Escape
    // handler is a React onKeyDown: the selection could no longer be
    // dropped from the keyboard until the operator clicked the sky.
    await renderMap("orbit", [thread("t1", "PwrSnap"), thread("t2", "PwrAgent")]);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Open this instance/ })).toBeTruthy();
    });
    // Sweep a selection so Escape has something to unwind. Shift-drag on
    // bare sky is the map's own marquee gesture.
    fireEvent.pointerDown(viewport(), {
      button: 0,
      shiftKey: true,
      clientX: -4000,
      clientY: -4000,
    });
    fireEvent.pointerMove(window, { clientX: 4000, clientY: 4000 });
    fireEvent.pointerUp(window, { clientX: 4000, clientY: 4000 });
    await screen.findByText(/card[s]? selected/);

    pan(-1000, 0);
    const arrow = arrowFor(LOCAL_LABEL);
    expect(arrow).not.toBeNull();
    // jsdom does not focus on click the way Chromium does; do it by hand
    // so the assertion is about the hand-back, not about jsdom.
    arrow!.focus();
    fireEvent.click(arrow!);

    await waitFor(() => {
      expect(arrowFor(LOCAL_LABEL)).toBeNull();
    });
    const layer = document.querySelector(".star-map");
    expect(document.activeElement).toBe(layer);
    expect(document.activeElement).not.toBe(document.body);

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByText(/card selected/)).toBeNull();
    });
  });

  it("still pans and zooms the map when the wheel is over an arrow pill", async () => {
    // The overlay is a sibling of the CANVAS, inside the viewport, because
    // the viewport owns the only non-passive wheel listener on the map.
    // Mounted beside the viewport instead, an arrow pill was a dead zone:
    // `pointer-events: auto` made it the wheel's target and the event
    // reached no listener, so the map froze under the cursor.
    await renderMap("orbit", [thread("t1", "PwrSnap")]);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Open this instance/ })).toBeTruthy();
    });
    pan(-1000, 0);
    const arrow = arrowFor(LOCAL_LABEL);
    expect(arrow).not.toBeNull();

    // Negative deltas move the map back toward where it came from: the
    // drag above parked it against the pan clamp, and a wheel further into
    // the clamp is legitimately a no-op.
    const beforePan = canvasView();
    fireEvent.wheel(arrow!, { deltaX: -40, deltaY: -30 });
    const afterPan = canvasView();
    expect(afterPan.x).not.toBeCloseTo(beforePan.x, 3);
    expect(afterPan.y).not.toBeCloseTo(beforePan.y, 3);

    const beforeZoom = canvasView().scale;
    fireEvent.wheel(arrow!, {
      ctrlKey: true,
      deltaY: -240,
      clientX: 100,
      clientY: 400,
    });
    expect(canvasView().scale).toBeGreaterThan(beforeZoom);
  });

  it("does not park the lanes lens above the top of its canvas", async () => {
    // Lanes hangs its columns from a fixed top edge and seats every body
    // on one row near it, so centring a body's y opens a band of empty sky
    // above the lane headers with the columns shoved down — the state
    // `topAnchored` exists to prevent, reachable from every single arrow
    // click in this lens and escapable only through "Reset view".
    await renderMap("lanes", [thread("t1", "PwrSnap"), thread("t2", "PwrAgent")]);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Open this instance/ })).toBeTruthy();
    });
    // Push the body row off the top of the window.
    pan(0, -400);
    const arrow = arrowFor(LOCAL_LABEL);
    expect(arrow).not.toBeNull();
    expect(arrow!.className).toContain("star-map__edge-arrow--top");

    fireEvent.click(arrow!);
    await waitFor(() => {
      expect(arrowFor(LOCAL_LABEL)).toBeNull();
    });
    // A positive y is the canvas origin sitting BELOW the window's, i.e.
    // sky above the headers. Every other view write in this lens produces
    // zero or less.
    expect(canvasView().y).toBeLessThanOrEqual(0);
  });

  it("names project suns in the Projects lens, with the sun's core standing in for an icon", async () => {
    await renderMap("projects", [
      thread("t1", "PwrSnap"),
      thread("t2", "PwrAgent"),
    ]);
    await waitFor(() => {
      expect(document.querySelector(".star-map-project")).not.toBeNull();
    });
    // Every project sits near the galactic core the map opens on; drag
    // the whole galaxy off to the right so the suns leave through the
    // right side of the window. The clamp bounds the pan, but it only ever
    // has to clear the window.
    pan(1500, 0);

    const projectArrows = arrowButtons().filter((button) =>
      /^Fly to (PwrSnap|PwrAgent)$/.test(button.getAttribute("aria-label") ?? ""),
    );
    expect(projectArrows.length).toBeGreaterThan(0);
    for (const button of projectArrows) {
      expect(button.className).toContain("star-map__edge-arrow--right");
      expect(button.querySelector(".star-map__edge-arrow-core")).not.toBeNull();
      expect(button.querySelector(".star-map__edge-arrow-icon")).toBeNull();
    }
    // Instances are not bodies in this lens, so nothing points at one.
    expect(arrowFor(LOCAL_LABEL)).toBeNull();
    expect(arrowFor(PEER_LABEL)).toBeNull();
  });

  it("keeps the overlay out of the tree while every body is in the window", async () => {
    await renderMap("orbit", [thread("t1", "PwrSnap")]);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Open this instance/ })).toBeTruthy();
    });
    // The peer may or may not fit at the opening zoom depending on the
    // ring layout; fly both into the window by zooming far out first.
    fireEvent.wheel(viewport(), { ctrlKey: true, deltaY: 600, clientX: 640, clientY: 400 });
    fireEvent.wheel(viewport(), { ctrlKey: true, deltaY: 600, clientX: 640, clientY: 400 });
    await waitFor(() => {
      expect(arrowButtons()).toHaveLength(0);
    });
    expect(screen.queryByRole("group", { name: "Off-screen bodies" })).toBeNull();
  });
});
