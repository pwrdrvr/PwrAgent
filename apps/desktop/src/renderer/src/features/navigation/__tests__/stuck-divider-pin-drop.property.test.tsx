import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { threadSummaryIdentityKey } from "../../../lib/federated-thread-events";
import { appStyleRules } from "../../../styles/__tests__/css-style-rules";
import { FixtureDirectoriesList } from "../../../test/navigation-presentation-fixture";

/*
 * A sidebar drop lands on what the operator sees under the pointer, or on
 * nothing. A project's header and its Unpinned divider are opaque bands
 * that stick over the rows scrolling under them (the divider under the
 * header, or on the lane's bottom edge), and rows scrolled past the lane's
 * edge are clipped away. A held pin or sub-thread released where the lane's
 * rows are not visible must do nothing; and while a card is held, the drop
 * slots never draw over those bands.
 *
 * jsdom has no layout, so the lane's geometry is a model (rows stacked in
 * DOM order, the header and divider stuck by the CSS rules), and the
 * browser's hit test is a model too: the topmost box at the point, in paint
 * order, skipping boxes whose computed `pointer-events` is `none`. Paint
 * order and those computed values come from the real `app.css` rules,
 * including the drag guard that makes sidebar buttons transparent while a
 * card is held. The oracle is paint order alone.
 */

const POINTER_ID = 41;
const WIDTH = 300;
const LANE_HEIGHT = 400;
const HEADER = 24;
// `.directory-row__header`'s z-index: above the divider, which slides
// under it (theme-contract pins that order).
const HEADER_Z = 6;
const ROW = 56;
const GAP = 2;
const DIVIDER = 24;
const DIVIDER_MARGIN = 4;
// The Keep at top slot's boundary while a drag is live: a 34px box plus
// 2px above and 6px below.
const KEEP_BOUNDARY = 42;

const PINS = 8;
const KEPT = 2;
const UNPINNED = 5;
const CHILDREN = 3;

// The real rules for every box the hit test can stop on, outside at-rules.
const HIT_TEST_CSS = appStyleRules
  .filter((rule) => rule.atRules.length === 0 && rule.selectors.some((selector) =>
    /data-native-drag-active|directory-row__thread-divider|directory-row__pin-drop|directory-row__keep-top-slot/
      .test(selector)))
  .map((rule) => `${rule.selectors.join(", ")} { ${rule.body} }`)
  .join("\n");

const NOW = 1_795_700_000_000;
const directory = {
  key: "directory:/repo/alpha", kind: "directory", label: "alpha", path: "/repo/alpha",
  threadKeys: [] as string[], needsAttentionCount: 0, latestUpdatedAt: NOW,
};
function thread(index: number, title: string, extra: Partial<NavigationThreadSummary> = {}): NavigationThreadSummary {
  return {
    id: `thread-${index}`, source: "codex", title, titleSource: "explicit", threadStatus: "idle",
    createdAt: NOW - index * 60_000, updatedAt: NOW - index * 30_000, inbox: { inInbox: false },
    linkedDirectories: [{ id: `dir-${index}`, label: "alpha", path: directory.path, kind: "local" }],
    ...extra,
  } as NavigationThreadSummary;
}
const roots = [
  ...Array.from({ length: PINS }, (_, index) => index < KEPT
    ? thread(index, `Kept ${index}`, { pinnedRank: String(-(2 ** 40) + index * 1024) })
    : thread(index, `Pin ${index}`, { pinnedRank: String((index + 1) * 1024) })),
  ...Array.from({ length: UNPINNED }, (_, index) => thread(PINS + index, `Unpinned ${index}`)),
];
// Sub-threads under one pin and one unpinned root.
const threads = [
  ...roots,
  ...["thread-3", `thread-${PINS + 1}`].flatMap((parentId, parentIndex) => Array.from({ length: CHILDREN },
    (_, index) => thread(roots.length + parentIndex * CHILDREN + index, `${parentId} child ${index}`,
      { parentThreadId: parentId, parentThreadBackend: "codex" }))),
];
directory.threadKeys = threads.map((item) => threadSummaryIdentityKey(item));

type Box = { element: HTMLElement; top: number; bottom: number; left: number; right: number; z: number };

const onReorderThreadPins = vi.fn(async () => undefined);
const onSetThreadPin = vi.fn(async () => undefined);
const onNestThread = vi.fn();
const onUpdateSubthreadOrder = vi.fn(async () => undefined);
let style: HTMLStyleElement;
let previousHitTest: PropertyDescriptor | undefined;
let lane: HTMLElement;
// Where the project's top sits in the lane, in px from the lane's top.
let projectTop = 0;
// The last layout's flow positions, relative to the project's top.
let flowMetrics = { listTop: 0, listBottom: 0, dividerNatural: 0 };

function isShown(element: Element): boolean {
  return getComputedStyle(element).display !== "none";
}

function zIndexOf(element: Element): number {
  return Number.parseInt(getComputedStyle(element).zIndex, 10) || 0;
}

/**
 * The lane as it would lay out with the project's top at `projectTop`:
 * painted boxes in paint order (topmost first), and the boxes of the
 * sub-thread trays, which paint nothing of their own.
 */
function layout(): { paint: Box[]; trays: Box[] } {
  const section = lane.querySelector<HTMLElement>(".directory-row")!;
  const header = section.querySelector<HTMLElement>(".directory-row__header")!;
  const list = section.querySelector<HTMLElement>(".directory-row__threads")!;
  const flow: Box[] = [];
  const trays: Box[] = [];
  const at = (element: HTMLElement, top: number, height: number, inset: number, z: number) =>
    flow.push({ element, top: projectTop + top, bottom: projectTop + top + height, left: inset, right: WIDTH - inset, z });
  const listTop = HEADER + GAP;
  let y = listTop;
  let divider: HTMLElement | undefined;
  let dividerNatural = 0;
  for (const child of list.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.matches(".directory-row__pin-drop-boundary")) {
      // A zero-height boundary whose margins cancel the list gap; the Keep
      // at top one grows to hold its slot while a drag is live.
      const z = zIndexOf(child);
      const keep = child.querySelector<HTMLElement>(".directory-row__keep-top-slot");
      if (keep && isShown(keep)) {
        at(keep, y + 2, KEEP_BOUNDARY - 8, 2, z);
        y += KEEP_BOUNDARY + GAP;
      }
      const append = child.querySelector<HTMLElement>(".directory-row__pin-drop-slot");
      // `top: -24px; height: 32px` from the boundary's place in the flow.
      if (append) at(append, y - GAP - 24, 32, 6, z);
      continue;
    }
    const band = child.querySelector<HTMLElement>(".directory-row__thread-divider");
    if (band) {
      divider = band;
      dividerNatural = y + DIVIDER_MARGIN;
      y = dividerNatural + DIVIDER + GAP;
      continue;
    }
    const rows = child.matches(".thread-row-shell")
      ? [child]
      : [...child.querySelectorAll<HTMLElement>(".thread-row-shell")];
    for (const row of rows) {
      at(row, y, ROW, row.dataset.nestedDepth ? 20 : 8, 0);
      y += ROW + GAP;
    }
    for (const tray of child.querySelectorAll<HTMLElement>("[data-subthread-tray]")) {
      const boxes = flow.filter((box) => tray.contains(box.element));
      if (boxes.length === 0) continue;
      trays.push({ element: tray, top: boxes[0]!.top, bottom: boxes[boxes.length - 1]!.bottom, left: 8, right: WIDTH - 8, z: 0 });
    }
  }
  const listBottom = y - GAP;
  flowMetrics = { listTop, listBottom, dividerNatural };
  const sectionBottom = projectTop + listBottom;
  // The header sticks to the lane's top until its section runs out.
  const headerTop = Math.min(Math.max(projectTop, 0), sectionBottom - HEADER);
  const bands: Box[] = [{ element: header, top: headerTop, bottom: headerTop + HEADER, left: 0, right: WIDTH, z: HEADER_Z }];
  if (divider) {
    // `position: sticky; top: <header height>; bottom: 0` inside
    // `.directory-row__threads`, which it never leaves.
    let top = projectTop + dividerNatural;
    top = Math.max(top, HEADER);
    top = Math.min(top, LANE_HEIGHT - DIVIDER);
    top = Math.min(Math.max(top, projectTop + listTop), projectTop + listBottom - DIVIDER);
    bands.push({ element: divider, top, bottom: top + DIVIDER, left: 0, right: WIDTH, z: zIndexOf(divider) });
  }
  // Paint order: higher z first, then later in the DOM.
  return { paint: [...bands, ...flow.reverse()].sort((left, right) => right.z - left.z), trays };
}

function boxOf(element: Element): Box | undefined {
  const { paint, trays } = layout();
  return [...paint, ...trays].find((box) => box.element === element);
}

/**
 * The topmost box at the point. The hit test skips `pointer-events: none`;
 * what is painted skips the append slot's clear box around its line.
 */
function topmostAt(x: number, y: number, hitTest: boolean): HTMLElement {
  // The lane clips its rows; outside it is the window's chrome.
  if (y < 0 || y > LANE_HEIGHT) return document.body;
  for (const box of layout().paint) {
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
    if (!isShown(box.element)) continue;
    if (hitTest && getComputedStyle(box.element).pointerEvents === "none") continue;
    if (!hitTest && box.element.matches(".directory-row__pin-drop-slot") && Math.abs(y - (box.top + 24)) > 1.5) continue;
    // A row's own surface, as Chromium returns it under the pointer.
    return box.element.querySelector<HTMLElement>(":scope > .thread-row") ?? box.element;
  }
  return lane;
}

const BANDS = ".directory-row__header, .directory-row__thread-divider";

beforeAll(() => {
  style = document.createElement("style");
  style.textContent = HIT_TEST_CSS;
  document.head.append(style);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const rect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this === lane) return new DOMRect(0, 0, WIDTH, LANE_HEIGHT);
    const box = lane?.contains(this) ? boxOf(this) : undefined;
    return box ? new DOMRect(box.left, box.top, box.right - box.left, box.bottom - box.top) : rect.call(this);
  });
  previousHitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: (x: number, y: number) => topmostAt(x, y, true),
  });
});

afterAll(() => {
  style.remove();
  if (previousHitTest) Object.defineProperty(document, "elementFromPoint", previousHitTest);
  else Reflect.deleteProperty(document, "elementFromPoint");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The project, expanded, in a sidebar (the drag guard is scoped to one). */
function mount(): void {
  render(
    <aside className="sidebar">
      <FixtureDirectoriesList
        directories={[directory] as never}
        threads={threads}
        onOpenLaunchpad={async () => undefined}
        onOpenThreadContextMenu={() => undefined}
        onSelectThread={() => undefined}
        onReorderThreadPins={onReorderThreadPins}
        onSetThreadPin={onSetThreadPin}
        onNestThread={onNestThread}
        onUpdateSubthreadOrder={onUpdateSubthreadOrder}
        onSetDirectoryThreadsCollapsed={async () => undefined}
      />
    </aside>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^alpha\b/ }));
  lane = document.querySelector<HTMLElement>(".sidebar-list--dense")!;
  expect(lane.querySelectorAll('.thread-row-shell[data-thread-pin-state="pinned"]')).toHaveLength(PINS);
  expect(lane.querySelectorAll(".thread-row-shell[data-nested-depth]")).toHaveLength(2 * CHILDREN);
  expect(lane.querySelector(".directory-row__thread-divider")).not.toBeNull();
}

type Release = {
  /** What is held: a root pin, or a sub-thread out of its tray. */
  holds: "pin" | "subthread";
  /** Project top at pointer down, in px from the lane's top. */
  startTop: number;
  /** Which visible row of that kind is held. */
  source: number;
  /**
   * Where the lane scrolls under the card: until the divider sticks to the
   * bottom edge or under the header, or `free`ly by `depth` × 900px.
   */
  scroll: "bottom" | "top" | "free";
  /** How far through that range, 0 to 1. */
  depth: number;
  /** Released over the divider, the header, or the chrome above the lane. */
  aim: "divider" | "header" | "aboveLane";
  /** Where within the aimed box, 0 (top) to 1 (bottom). */
  along: number;
};

const frame = () => act(async () => {
  await new Promise((resolve) => requestAnimationFrame(resolve));
});

/**
 * Holds a row, scrolls the lane, releases over a band or above the lane,
 * and checks the drop and the paint order against what is painted there.
 * Returns false when the case has nothing to hold or the aimed box is off
 * the lane.
 */
async function holdAndRelease(release: Release): Promise<boolean> {
  for (const handler of [onReorderThreadPins, onSetThreadPin, onNestThread, onUpdateSubthreadOrder]) handler.mockClear();
  projectTop = release.startTop;
  const sources = [...lane.querySelectorAll<HTMLElement>(release.holds === "pin"
    ? '.thread-row-shell[data-thread-pin-state="pinned"]'
    : ".thread-row-shell[data-nested-depth]")]
    .filter((row) => {
      const box = boxOf(row)!;
      return topmostAt(WIDTH / 2, (box.top + box.bottom) / 2, false).closest(".thread-row-shell") === row;
    });
  if (sources.length === 0) return false;
  const source = sources[release.source % sources.length]!;
  const sourceBox = boxOf(source)!;
  const start = { x: WIDTH / 2, y: (sourceBox.top + sourceBox.bottom) / 2 };
  fireEvent.pointerDown(source, { button: 0, clientX: start.x, clientY: start.y, pointerId: POINTER_ID });
  const move = (point: { x: number; y: number }) => fireEvent.pointerMove(window, {
    buttons: 1, clientX: point.x, clientY: point.y, pointerId: POINTER_ID,
  });
  move({ x: start.x, y: start.y + 8 });
  await frame();

  // The lane scrolls under the held card (a pin drag has opened the Keep
  // at top slot by now).
  layout();
  const { listTop, listBottom, dividerNatural } = flowMetrics;
  const [from, to] = release.scroll === "bottom"
    // From just stuck to the edge until the list's start reaches it.
    ? [LANE_HEIGHT - DIVIDER - dividerNatural - 1, LANE_HEIGHT - DIVIDER - listTop]
    : release.scroll === "top"
      // From just stuck under the header until the list runs out.
      ? [HEADER - dividerNatural - 1, HEADER + DIVIDER - listBottom]
      : [release.startTop, release.startTop - 900];
  projectTop = Math.round(from + release.depth * (to - from));
  fireEvent.scroll(lane);

  const aimed = release.aim === "aboveLane"
    ? { top: -40, bottom: -1 }
    : boxOf(lane.querySelector(release.aim === "divider" ? ".directory-row__thread-divider" : ".directory-row__header")!)!;
  const point = { x: WIDTH / 2, y: aimed.top + 1 + release.along * (aimed.bottom - aimed.top - 2) };
  move(point);
  await frame();
  const target = document.querySelector<HTMLElement>(
    ".is-drop-target-before, .is-drop-target-after, .is-drop-target-inside",
  );
  // Read while the card is held: releasing closes the Keep at top slot.
  const painted = topmostAt(point.x, point.y, false);
  const drawnOverBands = layout().paint
    .filter((box) => box.element.matches(BANDS) && box.bottom > 0 && box.top < LANE_HEIGHT)
    .flatMap((box) => [0.2, 0.5, 0.8].map((at) => {
      const y = Math.max(box.top, 0) + 0.5 * (Math.min(box.bottom, LANE_HEIGHT) - Math.max(box.top, 0));
      const top = topmostAt(at * WIDTH, y, false);
      return box.element.contains(top) ? undefined : `${top.className} over ${box.element.className}`;
    }))
    .filter(Boolean);
  await act(async () => {
    fireEvent.pointerUp(window, { button: 0, clientX: point.x, clientY: point.y, pointerId: POINTER_ID });
  });
  if (release.aim !== "aboveLane" && (point.y < 0 || point.y > LANE_HEIGHT)) return false;

  const dropped = [onReorderThreadPins, onSetThreadPin, onNestThread, onUpdateSubthreadOrder]
    .flatMap((handler) => handler.mock.calls).length;
  // The bands paint over every row and slot that scrolls under them.
  expect(drawnOverBands).toEqual([]);
  // Where the lane's rows are not what is painted, nothing takes the drop.
  if (painted === document.body || painted.closest(BANDS)) {
    expect({ painted: painted.className || painted.tagName, target: target?.className, dropped })
      .toEqual({ painted: painted.className || painted.tagName, target: undefined, dropped: 0 });
  }
  if (target) expect(target.contains(painted), `${target.className} is hidden under ${painted.className}`).toBe(true);
  return true;
}

const fraction = fc.integer({ min: 0, max: 1000 }).map((value) => value / 1000);
const release: fc.Arbitrary<Release> = fc.record({
  holds: fc.constantFrom("pin" as const, "subthread" as const),
  startTop: fc.integer({ min: -400, max: 200 }),
  source: fc.nat({ max: PINS }),
  scroll: fc.constantFrom("bottom" as const, "top" as const, "free" as const),
  depth: fraction,
  aim: fc.constantFrom("divider" as const, "header" as const, "aboveLane" as const),
  along: fraction,
});

// Each case was a counterexample; each comment names what it caught.
it.each<[string, Release]>([
  // Pins run past the divider on the bottom edge: the release reordered
  // against a pin hidden behind it, its insertion line under the band.
  ["a pin over the divider stuck to the lane's bottom edge",
    { holds: "pin", startTop: 0, source: 1, scroll: "bottom", depth: 0.25, aim: "divider", along: 0.75 }],
  // Unpinned rows run under the divider stuck below the header: "Make
  // sub-thread" on the row hidden behind it.
  ["a pin over the divider stuck under the header",
    { holds: "pin", startTop: 0, source: 1, scroll: "top", depth: 0.5, aim: "divider", along: 0.5 }],
  // The Keep at top slot scrolled up past the lane's edge still answered
  // its box: "Keep at top" from the lens bar above the lane.
  ["a pin above the lane, over a Keep at top slot scrolled out of view",
    { holds: "pin", startTop: 0, source: 2, scroll: "free", depth: 0.178, aim: "aboveLane", along: 0.9 }],
  // The Keep at top slot (z 7) drew over the stuck project header, and a
  // release there kept the pin at top.
  ["a pin over the header, with the Keep at top slot scrolled under it",
    { holds: "pin", startTop: 0, source: 2, scroll: "free", depth: 0.167, aim: "header", along: 0.5 }],
  // Sub-thread gaps come from row boxes: the tray scrolled up past the
  // lane's edge still took a reorder from the chrome above it.
  ["a sub-thread above the lane, over its tray scrolled out of view",
    { holds: "subthread", startTop: -100, source: 0, scroll: "free", depth: 0.3, aim: "aboveLane", along: 0.5 }],
  // A pinned parent's tray running under the divider on the bottom edge
  // took a reorder against its hidden rows.
  ["a sub-thread over the divider stuck to the bottom edge, its tray behind it",
    { holds: "subthread", startTop: -120, source: 0, scroll: "bottom", depth: 0.4, aim: "divider", along: 0.5 }],
])("drops nothing for %s", async (_name, input) => {
  mount();
  expect(await holdAndRelease(input)).toBe(true);
});

it("never drops on, or draws over, what a band or the lane's edge hides", async () => {
  mount();
  // A mounted tree, so CI keeps five runs. Raise numRuns locally to search
  // (300 runs were clean on the fix).
  await fc.assert(fc.asyncProperty(release, async (input) => {
    await holdAndRelease(input);
  }), { numRuns: 5 });
});
