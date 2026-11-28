import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { threadSummaryIdentityKey } from "../../../lib/federated-thread-events";
import { appStyleRules } from "../../../styles/__tests__/css-style-rules";
import { FixtureDirectoriesList } from "../../../test/navigation-presentation-fixture";

/*
 * A project's Unpinned divider is an opaque band that sticks under the
 * project header while unpinned rows scroll past, and to the lane's bottom
 * edge while the project's pins scroll past. Whatever it covers is not on
 * screen, so a pin released over it must land on what the operator sees
 * there: the divider (no target), never a row hidden behind it.
 *
 * jsdom has no layout, so the lane's geometry is a model (rows stacked in
 * DOM order, the header and divider stuck by the CSS rules), and the
 * browser's hit test is a model too: the topmost box at the point, in paint
 * order, skipping boxes whose computed `pointer-events` is `none`. Those
 * computed values come from the real `app.css` rules, including the drag
 * guard that makes sidebar buttons transparent while a card is held. The
 * oracle is paint order alone: what is painted at the release point.
 */

const POINTER_ID = 41;
const WIDTH = 300;
const LANE_HEIGHT = 400;
const HEADER = 24;
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
function thread(index: number, title: string, pinnedRank?: string): NavigationThreadSummary {
  return {
    id: `thread-${index}`, source: "codex", title, titleSource: "explicit", threadStatus: "idle",
    createdAt: NOW - index * 60_000, updatedAt: NOW - index * 30_000, inbox: { inInbox: false },
    linkedDirectories: [{ id: `dir-${index}`, label: "alpha", path: directory.path, kind: "local" }],
    ...(pinnedRank ? { pinnedRank } : {}),
  } as NavigationThreadSummary;
}
const threads = [
  ...Array.from({ length: PINS }, (_, index) => index < KEPT
    ? thread(index, `Kept ${index}`, String(-(2 ** 40) + index * 1024))
    : thread(index, `Pin ${index}`, String((index + 1) * 1024))),
  ...Array.from({ length: UNPINNED }, (_, index) => thread(PINS + index, `Unpinned ${index}`)),
];
directory.threadKeys = threads.map((item) => threadSummaryIdentityKey(item));

type Box = { element: HTMLElement; top: number; bottom: number; left: number; right: number; z: number };

const onReorderThreadPins = vi.fn(async () => undefined);
const onSetThreadPin = vi.fn(async () => undefined);
const onNestThread = vi.fn();
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

/** The lane as it would lay out with the project's top at `projectTop`. */
function layout(): Box[] {
  const section = lane.querySelector<HTMLElement>(".directory-row")!;
  const header = section.querySelector<HTMLElement>(".directory-row__header")!;
  const list = section.querySelector<HTMLElement>(".directory-row__threads")!;
  const flow: Box[] = [];
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
      const keep = child.querySelector<HTMLElement>(".directory-row__keep-top-slot");
      if (keep && isShown(keep)) {
        at(keep, y + 2, KEEP_BOUNDARY - 8, 2, 7);
        y += KEEP_BOUNDARY + GAP;
      }
      const append = child.querySelector<HTMLElement>(".directory-row__pin-drop-slot");
      // `top: -24px; height: 32px` from the boundary's place in the flow.
      if (append) at(append, y - GAP - 24, 32, 6, 7);
      continue;
    }
    const band = child.querySelector<HTMLElement>(".directory-row__thread-divider");
    if (band) {
      divider = band;
      dividerNatural = y + DIVIDER_MARGIN;
      y = dividerNatural + DIVIDER + GAP;
      continue;
    }
    const row = child.matches(".thread-row-shell") ? child : child.querySelector<HTMLElement>(".thread-row-shell");
    if (!row) continue;
    at(row, y, ROW, 8, 0);
    y += ROW + GAP;
  }
  const listBottom = y - GAP;
  flowMetrics = { listTop, listBottom, dividerNatural };
  const sectionBottom = projectTop + listBottom;
  // The header sticks to the lane's top until its section runs out.
  const headerTop = Math.min(Math.max(projectTop, 0), sectionBottom - HEADER);
  const boxes: Box[] = [{ element: header, top: headerTop, bottom: headerTop + HEADER, left: 0, right: WIDTH, z: 6 }];
  if (divider) {
    // `position: sticky; top: <header height>; bottom: 0` inside
    // `.directory-row__threads`, which it never leaves.
    let top = projectTop + dividerNatural;
    top = Math.max(top, HEADER);
    top = Math.min(top, LANE_HEIGHT - DIVIDER);
    top = Math.min(Math.max(top, projectTop + listTop), projectTop + listBottom - DIVIDER);
    boxes.push({ element: divider, top, bottom: top + DIVIDER, left: 0, right: WIDTH, z: 5 });
  }
  // Paint order: higher z first, then later in the DOM.
  return [...boxes, ...flow.reverse()].sort((left, right) => right.z - left.z);
}

function boxOf(element: Element): Box | undefined {
  return layout().find((box) => box.element === element);
}

/** The topmost box at the point; the hit test skips `pointer-events: none`. */
function topmostAt(x: number, y: number, hitTest: boolean): HTMLElement {
  if (y < 0 || y > LANE_HEIGHT) return document.body;
  for (const box of layout()) {
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
    if (!isShown(box.element)) continue;
    if (hitTest && getComputedStyle(box.element).pointerEvents === "none") continue;
    // A row's own surface, as Chromium returns it under the pointer.
    return box.element.querySelector<HTMLElement>(":scope > .thread-row") ?? box.element;
  }
  return lane;
}

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
        onSetDirectoryThreadsCollapsed={async () => undefined}
      />
    </aside>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^alpha\b/ }));
  lane = document.querySelector<HTMLElement>(".sidebar-list--dense")!;
  expect(lane.querySelectorAll('.thread-row-shell[data-thread-pin-state="pinned"]')).toHaveLength(PINS);
  expect(lane.querySelector(".directory-row__thread-divider")).not.toBeNull();
}

type Release = {
  /** Project top at pointer down, in px from the lane's top. */
  startTop: number;
  /** Which visible pin is held. */
  source: number;
  /** Where the divider sticks once the lane has scrolled under the card. */
  stuck: "top" | "bottom";
  /** How far through that stuck range, 0 (just stuck) to 1 (about to let go). */
  depth: number;
  /** Where over the divider, 0 (top edge) to 1 (bottom edge). */
  along: number;
};

const frame = () => act(async () => {
  await new Promise((resolve) => requestAnimationFrame(resolve));
});

/**
 * Holds a pin, scrolls the lane, releases over the stuck divider, and checks
 * the drop against what is painted there. Returns false when the case has no
 * visible pin to hold or no stuck divider to release over.
 */
async function releaseOverDivider(release: Release): Promise<boolean> {
  onReorderThreadPins.mockClear();
  onSetThreadPin.mockClear();
  onNestThread.mockClear();
  projectTop = release.startTop;
  const visiblePins = [...lane.querySelectorAll<HTMLElement>('.thread-row-shell[data-thread-pin-state="pinned"]')]
    .filter((row) => {
      const box = boxOf(row)!;
      const middle = (box.top + box.bottom) / 2;
      return topmostAt(WIDTH / 2, middle, false).closest(".thread-row-shell") === row;
    });
  if (visiblePins.length === 0) return false;
  const source = visiblePins[release.source % visiblePins.length]!;
  const sourceBox = boxOf(source)!;
  const start = { x: WIDTH / 2, y: (sourceBox.top + sourceBox.bottom) / 2 };
  fireEvent.pointerDown(source, { button: 0, clientX: start.x, clientY: start.y, pointerId: POINTER_ID });
  const move = (point: { x: number; y: number }) => fireEvent.pointerMove(window, {
    buttons: 1, clientX: point.x, clientY: point.y, pointerId: POINTER_ID,
  });
  move({ x: start.x, y: start.y + 8 });
  await frame();

  // The lane scrolls under the held card (the Keep at top slot is open now)
  // until the divider sticks: to the bottom edge while pins run past it, or
  // under the header while unpinned rows do.
  layout();
  const { listTop, listBottom, dividerNatural } = flowMetrics;
  const [justStuck, lettingGo] = release.stuck === "bottom"
    ? [LANE_HEIGHT - DIVIDER - dividerNatural - 1, LANE_HEIGHT - DIVIDER - listTop]
    : [HEADER - dividerNatural - 1, HEADER + DIVIDER - listBottom];
  projectTop = Math.round(justStuck + release.depth * (lettingGo - justStuck));
  fireEvent.scroll(lane);
  const divider = boxOf(lane.querySelector(".directory-row__thread-divider")!)!;
  const point = { x: WIDTH / 2, y: divider.top + 1 + release.along * (DIVIDER - 2) };
  const inLane = point.y > 0 && point.y < LANE_HEIGHT;
  move(point);
  await frame();
  const target = document.querySelector<HTMLElement>(
    ".is-drop-target-before, .is-drop-target-after, .is-drop-target-inside",
  );
  // Read while the card is held: releasing closes the Keep at top slot.
  const painted = topmostAt(point.x, point.y, false);
  await act(async () => {
    fireEvent.pointerUp(window, { button: 0, clientX: point.x, clientY: point.y, pointerId: POINTER_ID });
  });
  if (!inLane) return false;

  const dropped = onReorderThreadPins.mock.calls.length + onSetThreadPin.mock.calls.length
    + onNestThread.mock.calls.length > 0;
  // What the operator sees at the point is the target, or nothing is.
  if (target) expect(target.contains(painted), `${target.className} is hidden under ${painted.className}`).toBe(true);
  if (painted.closest(".directory-row__thread-divider")) {
    expect({ target: target?.className, dropped }).toEqual({ target: undefined, dropped: false });
  }
  return true;
}

const release = fc.record({
  startTop: fc.integer({ min: -200, max: 200 }),
  source: fc.nat({ max: PINS }),
  stuck: fc.constantFrom("top" as const, "bottom" as const),
  depth: fc.double({ min: 0, max: 1, noNaN: true }),
  along: fc.double({ min: 0, max: 1, noNaN: true }),
});

it("drops nothing when a pin is released over the divider stuck to the lane's bottom edge", async () => {
  mount();
  // Pins run past the divider on the bottom edge. A pin hidden behind it
  // took an insertion line nobody could see.
  expect(await releaseOverDivider({ startTop: 0, source: 1, stuck: "bottom", depth: 0.25, along: 0.75 })).toBe(true);
});

it("drops nothing when a pin is released over the divider stuck under the header", async () => {
  mount();
  // Unpinned rows run under the divider stuck below the header. Holding a
  // pin there offered "Make sub-thread" on the row hidden behind it.
  expect(await releaseOverDivider({ startTop: 0, source: 1, stuck: "top", depth: 0.5, along: 0.5 })).toBe(true);
});

it("never drops a pin on a row hidden behind a stuck divider", async () => {
  mount();
  await fc.assert(fc.asyncProperty(release, async (input) => {
    await releaseOverDivider(input);
  }), { numRuns: 5 });
});
