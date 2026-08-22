import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { STAR_MAP_ESTIMATED_CARD_HEIGHT } from "../star-map-layout";
import { MIN_VISIBLE_FRACTION } from "../star-map-view-geometry";
import { StarMapScreen } from "../StarMapScreen";

/**
 * The map must never move under the operator.
 *
 * Panning is how you work a map bigger than the window: you put the corner
 * you care about on screen and then act on it. Archiving from that corner
 * changes what the lens lays out, which changes the canvas — and the canvas
 * was an input to the "centre the view" effect, so the act of tidying up
 * threw away where you were looking.
 *
 * Measured against the CONTENT, not against the transform. Both halves of
 * that matter. The transform is not the promise: orbit and projects
 * normalise the canvas around what they laid out, so a body's canvas
 * position moves when a cloud's extent changes and the transform has to
 * move by exactly as much for the map to hold still — an assertion that the
 * transform is byte-identical fails a map that behaved perfectly. And it is
 * not evidence either: a fixture whose bodies never move passes it with the
 * whole mechanism deleted. So each test below pins its own precondition
 * first, by asserting the body's CANVAS position really did move, and only
 * then that its SCREEN position did not.
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

/** A thread in a directory of its own, so it clouds separately. */
function threadIn(id: string, project: string): NavigationThreadSummary {
  return {
    ...thread(id),
    linkedDirectories: [
      {
        id: `${project}-dir`,
        label: project,
        path: `/repos/${project}`,
        kind: "local",
      },
    ],
  } as unknown as NavigationThreadSummary;
}

function threadsIn(project: string, count: number): NavigationThreadSummary[] {
  return Array.from({ length: count }, (unused, index) =>
    threadIn(`${project}-${index}`, project),
  );
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

/**
 * Where a cloud's label sits in viewport pixels: its own canvas position,
 * through the canvas transform. Composed from the two independent things
 * that place it, so a layout that moves the bodies and a view that moves
 * the canvas both show up here — which is the whole question when the
 * complaint is "the map jumped".
 */
function screenPositionOf(project: string): { x: number; y: number } {
  const label = screen.getByRole("button", {
    name: new RegExp(`Select the ${project} cards`),
  });
  const cloud = label.closest(".star-map__cloud") as HTMLElement | null;
  if (!cloud) throw new Error(`no cloud around the ${project} label`);
  return onScreen(cloud, label);
}

/**
 * Where a cloud sits on the untransformed canvas — the number the view has
 * to cancel. Read to pin a fixture's precondition: a content change that
 * leaves this alone asks nothing of the view, so a map that held still
 * proves nothing about whether it can.
 */
function canvasPositionOf(project: string): { x: number; y: number } {
  const label = screen.getByRole("button", {
    name: new RegExp(`Select the ${project} cards`),
  });
  const cloud = label.closest(".star-map__cloud") as HTMLElement | null;
  if (!cloud) throw new Error(`no cloud around the ${project} label`);
  return {
    x: Number.parseFloat(cloud.style.left),
    y: Number.parseFloat(cloud.style.top),
  };
}

/** Where a project body sits in viewport pixels, in the projects lens. */
function projectScreenPosition(project: string): { x: number; y: number } {
  return onScreen(projectBody(project));
}

/** The same body's untransformed canvas position — see `canvasPositionOf`. */
function projectCanvasPosition(project: string): { x: number; y: number } {
  const body = projectBody(project);
  return {
    x: Number.parseFloat(body.style.left),
    y: Number.parseFloat(body.style.top),
  };
}

function projectBody(project: string): HTMLElement {
  const body = screen
    .getByText(project)
    .closest(".star-map__project-cloud") as HTMLElement | null;
  if (!body) throw new Error(`no project cloud around ${project}`);
  return body;
}

function onScreen(...placed: HTMLElement[]): { x: number; y: number } {
  const view = readTransform();
  const canvasX = placed.reduce(
    (total, element) => total + Number.parseFloat(element.style.left),
    0,
  );
  const canvasY = placed.reduce(
    (total, element) => total + Number.parseFloat(element.style.top),
    0,
  );
  return {
    x: view.x + canvasX * view.scale,
    y: view.y + canvasY * view.scale,
  };
}

/** Let a gesture's animation frame run so it writes the live transform. */
async function flushFrame() {
  await act(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve(undefined));
    });
  });
}

/**
 * Run frames until a ⌘K flight lands.
 *
 * Frames rather than a `waitFor`: the flight is driven by
 * `requestAnimationFrame` and paints the canvas transform directly, so
 * there is no React update to wait on until it commits its landing. The
 * flight takes half a second of frames, and the cap is well past that so a
 * flight that never lands fails on the assertion rather than by hanging.
 */
async function settleFlight() {
  let unchanged = 0;
  for (let frames = 0; frames < 200 && unchanged < 4; frames += 1) {
    const before = canvas().style.transform;
    await flushFrame();
    unchanged = canvas().style.transform === before ? unchanged + 1 : 0;
  }
}

/**
 * ⌘K, search, and pick the result. Scoped to the dialog: a thread already
 * on the map also has a card button carrying its title.
 */
async function flyToThread(query: string) {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const palette = await screen.findByRole("dialog", { name: "Fly to thread" });
  fireEvent.change(screen.getByRole("textbox", { name: "Fly to thread" }), {
    target: { value: query },
  });
  fireEvent.click(
    await within(palette).findByRole("button", {
      name: new RegExp(`Thread ${query}`),
    }),
  );
}

/**
 * The middle of a card in viewport pixels.
 *
 * Cards are centred on their slot horizontally and hang from it
 * vertically, so the middle is half an (unmeasured, therefore estimated)
 * card below the slot — the same composition `star-map-jump` measures a
 * landing with.
 */
function cardCenterOnScreen(threadKey: string): { x: number; y: number } {
  const shell = document.querySelector<HTMLElement>(
    `[data-thread-key="${threadKey}"]`,
  );
  const cloud = shell?.closest<HTMLElement>(".star-map__cloud");
  if (!shell || !cloud) throw new Error(`no card for ${threadKey}`);
  const view = readTransform();
  const canvasX =
    Number.parseFloat(cloud.style.left) + Number.parseFloat(shell.style.left);
  const canvasY =
    Number.parseFloat(cloud.style.top)
    + Number.parseFloat(shell.style.top)
    + STAR_MAP_ESTIMATED_CARD_HEIGHT / 2;
  return {
    x: view.x + canvasX * view.scale,
    y: view.y + canvasY * view.scale,
  };
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

  /**
   * Archiving the LAST thread of a cloud, rather than one of many.
   *
   * Losing one card of several moves nothing at all now — cloud seats,
   * extents and centres are carried forward (see star-map-clusters), which
   * is why this fixture empties a whole cloud instead. That is also the
   * archive the operator notices: the cloud leaves, the instance's extent
   * closes up, and orbit re-bases the canvas around what is left.
   */
  it("keeps the operator's pan when archiving empties a cloud (orbit)", async () => {
    seedLayout("orbit");
    const kept = threadsIn("PwrSnap", 6);
    const { rerender } = renderMap({
      threads: [...kept, ...threadsIn("PwrAgent", 3)],
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Select the PwrAgent cards/ }),
      ).toBeTruthy();
    });

    pan(-320, -180);
    const laidOut = canvasPositionOf("PwrSnap");
    const onScreenBefore = screenPositionOf("PwrSnap");

    rerender(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={kept}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Select the PwrAgent cards/ }),
      ).toBeNull();
    });

    // Precondition: the canvas really did re-base under the surviving
    // cloud. Without this the assertion below holds for a map that cannot
    // compensate at all.
    expect(canvasPositionOf("PwrSnap").x).not.toBeCloseTo(laidOut.x, 3);
    // And the operator is still looking at the same thing.
    const onScreenAfter = screenPositionOf("PwrSnap");
    expect(onScreenAfter.x).toBeCloseTo(onScreenBefore.x, 6);
    expect(onScreenAfter.y).toBeCloseTo(onScreenBefore.y, 6);
  });

  /**
   * The same archive at 2x, which is where the units are decided.
   *
   * The anchor moves in canvas units and the view moves in viewport
   * pixels, so the step has to carry the scale. At 1:1 the two are the
   * same number and a missing factor is invisible; here it is the whole
   * difference between holding still and sliding by the shift again.
   */
  it("keeps the operator's zoom when archiving empties a cloud (orbit)", async () => {
    seedLayout("orbit");
    const kept = threadsIn("PwrSnap", 6);
    const { rerender } = renderMap({
      threads: [...kept, ...threadsIn("PwrAgent", 3)],
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Select the PwrAgent cards/ }),
      ).toBeTruthy();
    });

    const viewport = document.querySelector(".star-map__viewport")!;
    fireEvent.wheel(viewport, {
      deltaY: -240,
      ctrlKey: true,
      clientX: 400,
      clientY: 300,
    });
    const zoomed = readTransform().scale;
    expect(zoomed).toBeGreaterThan(1);
    const laidOut = canvasPositionOf("PwrSnap");
    const onScreenBefore = screenPositionOf("PwrSnap");

    rerender(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={kept}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Select the PwrAgent cards/ }),
      ).toBeNull();
    });

    expect(canvasPositionOf("PwrSnap").x).not.toBeCloseTo(laidOut.x, 3);
    // Nothing here may re-zoom: the step is a translation only.
    expect(readTransform().scale).toBe(zoomed);
    const onScreenAfter = screenPositionOf("PwrSnap");
    expect(onScreenAfter.x).toBeCloseTo(onScreenBefore.x, 6);
    expect(onScreenAfter.y).toBeCloseTo(onScreenBefore.y, 6);
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

  /**
   * Losing a whole project, for the same reason the orbit pair empties a
   * whole cloud: this lens seats one body per repo, so archiving some of a
   * repo's threads leaves every body exactly where it was. Taking the last
   * one closes an arm and re-bases the canvas around what is left.
   */
  it("keeps the operator's pan when archiving empties a project (projects)", async () => {
    seedLayout("projects");
    const kept = threadsIn("PwrSnap", 6);
    const { rerender } = renderMap({
      threads: [...kept, ...threadsIn("PwrAgent", 3)],
    });
    await waitFor(() => {
      // Possibly twice: the lighter project seats off-screen at the
      // opening view, so its edge arrow names it as well as its sun.
      expect(screen.getAllByText("PwrAgent").length).toBeGreaterThan(0);
    });

    pan(-300, -200);
    const laidOut = projectCanvasPosition("PwrSnap");
    const before = projectScreenPosition("PwrSnap");

    rerender(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={kept}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(screen.queryAllByText("PwrAgent")).toHaveLength(0);
    });

    // Precondition: the surviving body really did move on the canvas. Only
    // the y axis does here — the arms converge on a core that keeps its x
    // — so this is the axis that makes the pair below mean anything.
    expect(projectCanvasPosition("PwrSnap").y).not.toBeCloseTo(laidOut.y, 3);
    // Against the body rather than the raw transform: this lens re-seats
    // its projects from scratch and normalises the canvas around them, so
    // the transform has to change by exactly that shift for the map to
    // hold still. What the operator is owed is the pixels, not the number.
    const after = projectScreenPosition("PwrSnap");
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  /**
   * Unfolding a cloud it has the room for must move nothing at all. The
   * fold state used to drop the cloud's remembered centre and seats, which
   * made it an arrival again — re-seated from the base radius outward
   * along its own bearing, which is rarely where it was. The operator
   * asked for one more card and the cloud they were reading vanished.
   */
  it("unfolds a cloud that has the room without moving anything", async () => {
    seedLayout("orbit");
    renderMap({
      threads: [...threadsIn("PwrSnap", 9), ...threadsIn("PwrAgent", 3)],
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Show 1 more PwrSnap threads/ }),
      ).toBeTruthy();
    });

    pan(-320, -180);
    const unfolded = screenPositionOf("PwrSnap");
    const untouched = screenPositionOf("PwrAgent");

    fireEvent.click(
      screen.getByRole("button", { name: /Show 1 more PwrSnap threads/ }),
    );
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /^Open thread:/ }),
      ).toHaveLength(12);
    });

    expect(screenPositionOf("PwrSnap").x).toBeCloseTo(unfolded.x, 6);
    expect(screenPositionOf("PwrSnap").y).toBeCloseTo(unfolded.y, 6);
    expect(screenPositionOf("PwrAgent").x).toBeCloseTo(untouched.x, 6);
    expect(screenPositionOf("PwrAgent").y).toBeCloseTo(untouched.y, 6);
  });

  /**
   * Unfolding a cloud used to move the whole map out from under the
   * operator, twice over: the cloud itself was re-seated from scratch and
   * reappeared somewhere else, and the canvas — which is normalised so the
   * outermost cloud clears the padding — re-based its origin under a view
   * that had not moved, sliding every other body several hundred pixels
   * sideways. Clicking "+N more" is a request for two more cards, not for
   * a new map.
   */
  it("keeps the map still when the operator unfolds a cloud", async () => {
    seedLayout("orbit");
    renderMap({
      threads: [...threadsIn("PwrSnap", 14), ...threadsIn("PwrAgent", 3)],
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Show \d+ more PwrSnap threads/ }),
      ).toBeTruthy();
    });

    pan(-320, -180);
    const before = screenPositionOf("PwrAgent");

    fireEvent.click(
      screen.getByRole("button", { name: /Show \d+ more PwrSnap threads/ }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Show fewer PwrSnap threads/ }),
      ).toBeTruthy();
    });

    // The cloud the operator did not touch is still under the same pixels.
    const after = screenPositionOf("PwrAgent");
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  /**
   * Two pointers can be on the map at once — two fingers on a touchscreen
   * — and each press starts its own pan. They already fight over the
   * transform, which is old news; what they must not do is lose track of
   * where they were pressed. A single shared base meant the first finger
   * to lift took the other one's base with it, and the survivor started
   * measuring its travel from a view that already contained that travel:
   * the map bolted, faster every frame.
   */
  it("keeps a second pan measuring from its own press", async () => {
    seedLayout("orbit");
    renderMap({ threads: threads(9) });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Open this instance/ }),
      ).toBeTruthy();
    });

    const viewport = document.querySelector(".star-map__viewport")!;
    fireEvent.pointerDown(viewport, { button: 0, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 300 });
    await flushFrame();

    // A second finger lands and drags while the first is still down.
    fireEvent.pointerDown(viewport, { button: 0, clientX: 600, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: 560, clientY: 460 });
    await flushFrame();
    const held = readTransform();

    // The first finger lifts. The second is still down and has not moved,
    // so the frame it paints next has to land where it already was.
    fireEvent.pointerUp(window, { clientX: 400, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 560, clientY: 460 });
    await flushFrame();

    const after = readTransform();
    expect(after.x).toBeCloseTo(held.x, 6);
    expect(after.y).toBeCloseTo(held.y, 6);

    fireEvent.pointerUp(window, { clientX: 560, clientY: 460 });
  });

  /**
   * A relayout does not wait for the operator to let go of the map. The
   * drag measures its pointer travel from a base of its own and repaints
   * from it on the next frame, so holding the view still has to step that
   * base too — a base captured by value simply painted the jump back.
   */
  it("keeps the map still when a cloud arrives mid-drag", async () => {
    seedLayout("orbit");
    const held = [...threadsIn("PwrSnap", 6), ...threadsIn("PwrAgent", 3)];
    const { rerender } = renderMap({ threads: held });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Select the PwrAgent cards/ }),
      ).toBeTruthy();
    });

    const viewport = document.querySelector(".star-map__viewport")!;
    fireEvent.pointerDown(viewport, { button: 0, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 300 });
    await flushFrame();
    const before = screenPositionOf("PwrAgent");

    // A thread lands in a repo the map has never seen: a new cloud is
    // seated, the instance's extent grows and the canvas origin moves.
    rerender(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[...held, ...threadsIn("PwrDrvr", 4)]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Select the PwrDrvr cards/ }),
      ).toBeTruthy();
    });

    // Same pointer position, so anything that moved was the map, not the
    // drag. The frame after the relayout is the one that used to undo the
    // compensation.
    fireEvent.pointerMove(window, { clientX: 400, clientY: 300 });
    await flushFrame();
    const during = screenPositionOf("PwrAgent");
    expect(during.x).toBeCloseTo(before.x, 6);
    expect(during.y).toBeCloseTo(before.y, 6);

    fireEvent.pointerUp(window, { clientX: 400, clientY: 300 });
    const landed = screenPositionOf("PwrAgent");
    expect(landed.x).toBeCloseTo(before.x, 6);
    expect(landed.y).toBeCloseTo(before.y, 6);
  });

  /**
   * A ⌘K flight is the one writer that does not re-read the live view: it
   * interpolates between two views captured when it launched, so it paints
   * straight over anything that moved the view since. A relayout mid-flight
   * therefore hit it twice over — the step holding the map still was undone
   * on the very next frame, and the destination, which is "the middle of
   * the window on THIS card", still named where the card used to be. The
   * flight arrived next to the card the operator had asked for.
   *
   * Asserted at the landing rather than per frame, because the landing is
   * the promise ⌘K makes and it is the one moment the map is supposed to
   * be somewhere specific.
   */
  it("lands on the card it was asked for when a cloud arrives mid-flight", async () => {
    seedLayout("orbit");
    const held = [...threadsIn("PwrSnap", 6), ...threadsIn("PwrAgent", 3)];
    const { rerender } = renderMap({ threads: held });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Select the PwrAgent cards/ }),
      ).toBeTruthy();
    });

    await flyToThread("PwrAgent-2");
    // Two frames in, so the flight is genuinely in the air rather than
    // still sitting on its launch view.
    await flushFrame();
    await flushFrame();
    const laidOut = canvasPositionOf("PwrAgent");

    // A thread lands in a repo the map has never seen: a new cloud is
    // seated and the canvas origin moves under the flight.
    rerender(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[...held, ...threadsIn("PwrDrvr", 4)]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Select the PwrDrvr cards/ }),
      ).toBeTruthy();
    });
    // Precondition: the destination really did move while it was being
    // flown to.
    expect(canvasPositionOf("PwrAgent").x).not.toBeCloseTo(laidOut.x, 3);

    await settleFlight();

    const arrived = cardCenterOnScreen("codex:PwrAgent-2");
    expect(arrived.x).toBeCloseTo(VIEWPORT.width / 2, 6);
    expect(arrived.y).toBeCloseTo(VIEWPORT.height / 2, 6);
  });

  /**
   * The same re-base, on a flight that is also ZOOMING.
   *
   * A leg is two views, and they need not share a scale: a pick made from
   * further out lands at 1:1 whatever the operator was on, so the same
   * canvas shift is worth a different number of viewport pixels at the
   * destination than at the launch. Correcting both ends with one
   * pre-multiplied pixel step — the live view's, which mid-flight is
   * neither end's — under-corrects the landing by the ratio between them,
   * and the flight arrives beside the card again with every 1:1 test still
   * green, because at 1:1 the two scales are the same number.
   */
  it("lands on the card when the re-base arrives mid-zoom", async () => {
    seedLayout("orbit");
    const held = [...threadsIn("PwrSnap", 6), ...threadsIn("PwrAgent", 3)];
    const { rerender } = renderMap({ threads: held });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Select the PwrAgent cards/ }),
      ).toBeTruthy();
    });

    // Out to 0.5, so the flight has to climb back to 1:1 as it travels.
    // Still above STAR_MAP_OVERVIEW_ZOOM, so the cards are drawn and the
    // pick has a rect to fly to.
    fireEvent.wheel(document.querySelector(".star-map__viewport")!, {
      deltaY: 120,
      ctrlKey: true,
      clientX: 400,
      clientY: 300,
    });
    expect(readTransform().scale).toBe(0.5);

    await flyToThread("PwrAgent-2");
    await flushFrame();
    await flushFrame();
    // Precondition: the leg really does span two scales, which is the
    // whole subject here.
    expect(readTransform().scale).toBeLessThan(1);
    const laidOut = canvasPositionOf("PwrAgent");

    rerender(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[...held, ...threadsIn("PwrDrvr", 4)]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Select the PwrDrvr cards/ }),
      ).toBeTruthy();
    });
    expect(canvasPositionOf("PwrAgent").x).not.toBeCloseTo(laidOut.x, 3);

    await settleFlight();

    expect(readTransform().scale).toBe(1);
    const arrived = cardCenterOnScreen("codex:PwrAgent-2");
    expect(arrived.x).toBeCloseTo(VIEWPORT.width / 2, 6);
    expect(arrived.y).toBeCloseTo(VIEWPORT.height / 2, 6);
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

  async function openOrbit(count = 9) {
    seedLayout("orbit");
    const rendered = renderMap({ threads: threads(count) });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Open this instance/ }),
      ).toBeTruthy();
    });
    return rendered;
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
    //
    // The canvas is resized here by EXPANDING a cloud rather than by
    // taking threads away: cloud layout is incremental now, so losing a
    // card deliberately leaves every seat, extent and centre alone (see
    // star-map-clusters). Unfolding a cloud is an operator action, and
    // re-fitting that cloud is the point of it.
    await openOrbit(12);

    pan(-900, -600);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    const beforeResize = canvas().style.transform;

    fireEvent.click(
      screen.getByRole("button", { name: /Show 4 more PwrSnap threads/ }),
    );
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /^Open thread:/ }),
      ).toHaveLength(12);
    });

    // The re-fitted cloud re-centres, which it would not do if the map
    // were still treating the view as the operator's.
    expect(canvas().style.transform).not.toBe(beforeResize);
    const box = canvasBox();
    expect(readTransform()).toEqual({
      x: (VIEWPORT.width - box.width) / 2,
      y: (VIEWPORT.height - box.height) / 2,
      scale: 1,
    });
  });

  it("keeps a strip on screen when a folding cloud shrinks the canvas", async () => {
    // This used to strand the view outright, and said so. The bounds are a
    // function of canvas size and the clamp does not re-run on a content
    // change, so a canvas that shrank out from under a legally-parked view
    // left nothing on screen and only Reset brought it back.
    //
    // Holding the view against the map closed the common case: a shrink at
    // the left or top edge moves the canvas origin, the view follows it,
    // and that move goes through the clamp. What is left of the gap is a
    // shrink that leaves the origin exactly where it was — the canvas
    // losing width off its right edge alone — which still does not
    // re-clamp. Reset still recovers, and is asserted below.
    //
    // The shrink is driven by folding an expanded cloud back up. Archiving
    // no longer shrinks anything: cloud seats, extents and centres are
    // carried forward so losing a card moves nothing else, which closed
    // the far more common route into this gap.
    await openOrbit(12);
    fireEvent.click(
      screen.getByRole("button", { name: /Show 4 more PwrSnap threads/ }),
    );
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /^Open thread:/ }),
      ).toHaveLength(12);
    });
    const wide = canvasBox();

    // Park hard against the left bound: the canvas's right edge is all
    // that remains on screen, so any shrink eats straight into it.
    pan(-40000, -40000);
    expect(
      visible(readTransform().x, wide.width, VIEWPORT.width),
    ).toBeGreaterThanOrEqual(VIEWPORT.width * MIN_VISIBLE_FRACTION);

    fireEvent.click(
      screen.getByRole("button", { name: /Show fewer PwrSnap threads/ }),
    );
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /^Open thread:/ }),
      ).toHaveLength(8);
    });

    const narrow = canvasBox();
    // The shrink has to exceed the guaranteed strip for this to be the
    // gap rather than a rounding artefact.
    expect(narrow.width).toBeLessThan(
      wide.width - VIEWPORT.width * MIN_VISIBLE_FRACTION,
    );
    const folded = readTransform();
    expect(
      visible(folded.x, narrow.width, VIEWPORT.width),
    ).toBeGreaterThanOrEqual(VIEWPORT.width * MIN_VISIBLE_FRACTION);

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
