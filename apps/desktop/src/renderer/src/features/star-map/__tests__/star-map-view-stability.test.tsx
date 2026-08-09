import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { MIN_VISIBLE_FRACTION } from "../star-map-view-geometry";
import { StarMapScreen } from "../StarMapScreen";

/**
 * The map must never move under the operator.
 *
 * Panning is how you work a map bigger than the window: you put the corner
 * you care about on screen and then act on it. Archiving a card from that
 * corner changes a cloud's card count, which changes the canvas size — and
 * the canvas size used to be an input to the "centre the view" effect, so
 * the act of tidying up threw away where you were looking.
 */

function buildDesktopApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
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
    ...overrides,
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

/** Enough threads that dropping one changes the cloud's ring count. */
function threads(count: number): NavigationThreadSummary[] {
  return Array.from({ length: count }, (_, index) => thread(`t${index}`));
}

function seedLayout(layout: "lanes" | "orbit" | "projects") {
  window.localStorage.setItem(
    "pwragent.starMap.viewPreferences",
    JSON.stringify({ layout }),
  );
}

function canvas(): HTMLElement {
  const element = document
    .querySelector(".star-map__canvas");
  if (!element) throw new Error("canvas not found");
  return element as HTMLElement;
}

/** Drag the canvas by a fixed delta, the way an operator pans. */
function pan(dx: number, dy: number) {
  const viewport = document.querySelector(".star-map__viewport");
  if (!viewport) throw new Error("viewport not found");
  fireEvent.pointerDown(viewport, { button: 0, clientX: 500, clientY: 400 });
  fireEvent.pointerMove(window, { clientX: 500 + dx, clientY: 400 + dy });
  fireEvent.pointerUp(window, { clientX: 500 + dx, clientY: 400 + dy });
}

/**
 * jsdom measures every element as 0x0, so the screen keeps its unmeasured
 * default viewport. The bounds below are computed against it.
 */
const VIEWPORT = { width: 1280, height: 800 };

function parseTransform(raw: string): { x: number; y: number; scale: number } {
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(
    raw,
  );
  if (!match) throw new Error(`unparsable transform: ${raw}`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

function readTransform(): { x: number; y: number; scale: number } {
  return parseTransform(canvas().style.transform);
}

/** The canvas's untransformed size, as the screen sized the element. */
function canvasBox(): { width: number; height: number } {
  const style = canvas().style;
  return {
    width: Number.parseFloat(style.width),
    height: Number.parseFloat(style.height),
  };
}

/** How much of the canvas the operator can still see, on one axis. */
function visible(position: number, content: number, viewportExtent: number) {
  return Math.max(
    0,
    Math.min(viewportExtent, position + content) - Math.max(0, position),
  );
}

function renderMap(props: { threads: NavigationThreadSummary[] }) {
  return render(
    <StarMapScreen
      desktopApi={buildDesktopApi()}
      localThreads={props.threads}
      sessionKeys={{}}
      localInstanceLabel="Mac-Mini-M4"
      floating={false}
      onClose={() => undefined}
      onOpenLocalThread={() => undefined}
      onFocusLocalInstance={() => undefined}
    />,
  );
}

describe("star map view stability", () => {
  // Layout preference is global; leaking it reorders unrelated suites.
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
  });

  it("keeps the operator's pan when a card is archived away (orbit)", async () => {
    seedLayout("orbit");
    const { rerender } = renderMap({ threads: threads(9) });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Open this instance/ }),
      ).toBeTruthy();
    });

    pan(-320, -180);
    const panned = canvas().style.transform;
    expect(panned).toMatch(/translate/);

    // Archiving removes the thread and the owning cloud re-fetches. The
    // map must stay exactly where the operator put it.
    rerender(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={threads(8)}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Open thread: Thread t8/ }),
      ).toBeNull();
    });
    expect(canvas().style.transform).toBe(panned);
  });

  it("keeps the operator's zoom when the cloud resizes", async () => {
    seedLayout("orbit");
    const { rerender } = renderMap({ threads: threads(9) });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Open this instance/ }),
      ).toBeTruthy();
    });

    const viewport = document.querySelector(".star-map__viewport")!;
    fireEvent.wheel(viewport, { deltaY: -240, ctrlKey: true, clientX: 400, clientY: 300 });
    const zoomed = canvas().style.transform;
    expect(zoomed).toMatch(/scale\((?!1\))/);

    rerender(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={threads(5)}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Open thread: Thread t8/ }),
      ).toBeNull();
    });
    expect(canvas().style.transform).toBe(zoomed);
  });

  it("still centres when the operator switches layout", async () => {
    // The re-centre is worth keeping for a genuine mode switch — that is a
    // new map, and leaving the operator in a corner of it is worse.
    seedLayout("orbit");
    renderMap({ threads: threads(9) });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Open this instance/ }),
      ).toBeTruthy();
    });

    pan(-400, -260);
    const panned = canvas().style.transform;
    expect(panned).toMatch(/translate/);

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));

    await waitFor(() => {
      // A different lens re-centres rather than stranding the operator, so
      // the view must leave where the operator had parked it. Asserting
      // only that a transform exists would pass even with the reset gone,
      // because pan/zoom lenses always carry one.
      expect(canvas().style.transform).not.toBe(panned);
    });
  });

  it("lets the operator pan the projects lens at all", async () => {
    // The projects canvas is bigger than the window like orbit's, but every
    // pan/zoom gate tested `orbitMode`, so it could not be navigated.
    seedLayout("projects");
    renderMap({ threads: threads(9) });
    await waitFor(() => {
      expect(screen.getByText("PwrSnap")).toBeTruthy();
    });

    const before = canvas().style.transform;
    pan(-260, -140);
    expect(canvas().style.transform).not.toBe(before);
  });

  it("keeps the operator's pan when a card is archived away (projects)", async () => {
    seedLayout("projects");
    const { rerender } = renderMap({ threads: threads(9) });
    await waitFor(() => {
      expect(screen.getByText("PwrSnap")).toBeTruthy();
    });

    pan(-300, -200);
    const panned = canvas().style.transform;

    rerender(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={threads(4)}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Open thread: Thread t8/ }),
      ).toBeNull();
    });
    expect(canvas().style.transform).toBe(panned);
  });
});

/**
 * The map must also never leave.
 *
 * A pan/zoom surface with no bounds can be dragged until every body is
 * outside the window, and an empty star field offers nothing to drag back
 * — before this, closing and reopening the map was the only way out. The
 * view being sticky (above) is what makes that state permanent, so the two
 * rules ship together: the operator owns the view, and the view stays
 * within reach of the content.
 */
describe("star map view bounds", () => {
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
  });

  async function openOrbit() {
    seedLayout("orbit");
    const rendered = renderMap({ threads: threads(9) });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Open this instance/ }),
      ).toBeTruthy();
    });
    return rendered;
  }

  /** Let the pan's animation frame run so it writes the live transform. */
  async function flushFrame() {
    await act(async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(() => resolve(undefined));
      });
    });
  }

  it("keeps a strip of canvas on screen when dragged off the top-left", async () => {
    await openOrbit();
    const box = canvasBox();

    pan(-40000, -40000);

    const after = readTransform();
    expect(visible(after.x, box.width, VIEWPORT.width)).toBeGreaterThanOrEqual(
      VIEWPORT.width * MIN_VISIBLE_FRACTION,
    );
    expect(
      visible(after.y, box.height, VIEWPORT.height),
    ).toBeGreaterThanOrEqual(VIEWPORT.height * MIN_VISIBLE_FRACTION);
  });

  it("keeps a strip of canvas on screen when dragged off the bottom-right", async () => {
    await openOrbit();
    const box = canvasBox();

    pan(40000, 40000);

    const after = readTransform();
    expect(after.x).toBe(VIEWPORT.width * (1 - MIN_VISIBLE_FRACTION));
    expect(visible(after.x, box.width, VIEWPORT.width)).toBeGreaterThanOrEqual(
      VIEWPORT.width * MIN_VISIBLE_FRACTION,
    );
    expect(
      visible(after.y, box.height, VIEWPORT.height),
    ).toBeGreaterThanOrEqual(VIEWPORT.height * MIN_VISIBLE_FRACTION);
  });

  it("bounds the trackpad two-finger pan as well as the drag", async () => {
    await openOrbit();
    const box = canvasBox();
    const viewport = document.querySelector(".star-map__viewport")!;

    // One flick is enough; a real trackpad emits a stream of these.
    fireEvent.wheel(viewport, { deltaX: 40000, deltaY: 40000 });

    const after = readTransform();
    expect(visible(after.x, box.width, VIEWPORT.width)).toBeGreaterThanOrEqual(
      VIEWPORT.width * MIN_VISIBLE_FRACTION,
    );
    expect(
      visible(after.y, box.height, VIEWPORT.height),
    ).toBeGreaterThanOrEqual(VIEWPORT.height * MIN_VISIBLE_FRACTION);
  });

  it("does not snap the canvas back when the drag is released", async () => {
    // The drag writes the transform onto the canvas itself on every frame,
    // bypassing React state. Clamping only the committed value would let
    // the map run off during the drag and jump back on pointerup.
    await openOrbit();
    const viewport = document.querySelector(".star-map__viewport")!;

    fireEvent.pointerDown(viewport, { button: 0, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(window, { clientX: -39500, clientY: -39600 });
    await flushFrame();
    const midDrag = canvas().style.transform;
    expect(midDrag).toMatch(/translate/);

    fireEvent.pointerUp(window, { clientX: -39500, clientY: -39600 });

    expect(canvas().style.transform).toBe(midDrag);
  });

  it("bounds the projects lens too", async () => {
    seedLayout("projects");
    renderMap({ threads: threads(9) });
    await waitFor(() => {
      expect(screen.getByText("PwrSnap")).toBeTruthy();
    });
    const box = canvasBox();

    pan(-40000, -40000);

    const after = readTransform();
    expect(visible(after.x, box.width, VIEWPORT.width)).toBeGreaterThanOrEqual(
      VIEWPORT.width * MIN_VISIBLE_FRACTION,
    );
    expect(
      visible(after.y, box.height, VIEWPORT.height),
    ).toBeGreaterThanOrEqual(VIEWPORT.height * MIN_VISIBLE_FRACTION);
  });

  it("re-centres the map on Reset view", async () => {
    await openOrbit();
    const centred = canvas().style.transform;

    pan(-900, -600);
    expect(canvas().style.transform).not.toBe(centred);

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));

    expect(canvas().style.transform).toBe(centred);
    const box = canvasBox();
    expect(readTransform()).toEqual({
      x: (VIEWPORT.width - box.width) / 2,
      y: (VIEWPORT.height - box.height) / 2,
      scale: 1,
    });
  });

  it("resets the zoom as well as the position", async () => {
    await openOrbit();
    const viewport = document.querySelector(".star-map__viewport")!;

    fireEvent.wheel(viewport, {
      deltaY: -240,
      ctrlKey: true,
      clientX: 400,
      clientY: 300,
    });
    expect(readTransform().scale).not.toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));

    expect(readTransform().scale).toBe(1);
  });

  it("hands the view back to the map on Reset view", async () => {
    // Resetting is also how the operator says "you place it again" — the
    // ownership flag has to clear, or auto-centring stays off for the life
    // of the mounted map.
    const { rerender } = await openOrbit();

    pan(-900, -600);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    const beforeResize = canvas().style.transform;

    rerender(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={threads(4)}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Open thread: Thread t8/ }),
      ).toBeNull();
    });
    // The smaller cloud re-centres, which it would not do if the map were
    // still treating the view as the operator's.
    expect(canvas().style.transform).not.toBe(beforeResize);
    const box = canvasBox();
    expect(readTransform()).toEqual({
      x: (VIEWPORT.width - box.width) / 2,
      y: (VIEWPORT.height - box.height) / 2,
      scale: 1,
    });
  });

  it("lets a shrinking canvas strand the view, recovered by Reset", async () => {
    // Pins the known gap rather than implying there isn't one. The bounds
    // are a function of canvas size, and the clamp deliberately does not
    // re-run on a content change — so a canvas that shrinks out from under
    // a legally-parked view can leave nothing on screen. Recovery is
    // manual. If a future change closes this properly, this test should
    // fail and be rewritten, not deleted.
    const { rerender } = await openOrbit();
    const wide = canvasBox();

    // Park hard against the left bound: the canvas's right edge is all
    // that remains on screen, so any shrink eats straight into it.
    pan(-40000, -40000);
    expect(
      visible(readTransform().x, wide.width, VIEWPORT.width),
    ).toBeGreaterThanOrEqual(VIEWPORT.width * MIN_VISIBLE_FRACTION);

    rerender(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={threads(1)}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Open thread: Thread t8/ }),
      ).toBeNull();
    });

    const narrow = canvasBox();
    // The shrink has to exceed the guaranteed strip for this to be the
    // gap rather than a rounding artefact.
    expect(narrow.width).toBeLessThan(
      wide.width - VIEWPORT.width * MIN_VISIBLE_FRACTION,
    );
    const stranded = readTransform();
    expect(visible(stranded.x, narrow.width, VIEWPORT.width)).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));

    const recovered = readTransform();
    expect(
      visible(recovered.x, narrow.width, VIEWPORT.width),
    ).toBeGreaterThanOrEqual(VIEWPORT.width * MIN_VISIBLE_FRACTION);
    expect(
      visible(recovered.y, narrow.height, VIEWPORT.height),
    ).toBeGreaterThanOrEqual(VIEWPORT.height * MIN_VISIBLE_FRACTION);
  });

  it("commits a flick released before any frame runs", async () => {
    // The live transform is written inside requestAnimationFrame, but the
    // committed value must not depend on a frame having fired — a quick
    // drag-and-release would otherwise throw the gesture away.
    await openOrbit();
    const before = canvas().style.transform;
    const viewport = document.querySelector(".star-map__viewport")!;

    fireEvent.pointerDown(viewport, { button: 0, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 250 });
    fireEvent.pointerUp(window, { clientX: 300, clientY: 250 });

    const after = readTransform();
    const start = parseTransform(before);
    expect(after.x).toBe(start.x - 200);
    expect(after.y).toBe(start.y - 150);
  });

  it("gives lanes a view of its own, opened at the top of the columns", async () => {
    // Lanes used to fit the window and truncate each column at the fold, so
    // it had no view and no reset. Columns now run as long as they need, so
    // the lens pans and zooms like the others — and it has to OPEN at the
    // top, since bodies sit on a fixed row and their cards grow downward.
    seedLayout("lanes");
    renderMap({ threads: threads(9) });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Open this instance/ }),
      ).toBeTruthy();
    });

    expect(readTransform().y).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "View" }));

    expect(screen.getByRole("button", { name: "Reset view" })).toBeTruthy();
  });
});
