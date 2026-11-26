import { act, render } from "@testing-library/react";
import fc from "fast-check";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { FixtureDirectoriesList } from "../../../test/navigation-presentation-fixture";
import { ProjectIndex } from "../ProjectIndex";
import { SelectedThreadDock } from "../SelectedThreadDock";
import { buildLargeDirectoryFixture } from "./fixtures/directory-performance";

const noop = () => {};
const asyncNoop = async () => {};
const VIEW_TOP = 100;
const VIEW_HEIGHT = 360;
const PITCH = 480;
const ROW_TOP = 120;
const ROW_HEIGHT = 60;
const RESERVE = "has-selected-thread-dock-top";
const DOCK_QUERY_ROOTS = ".sidebar__scroll-region, .directory-list";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function box(top: number, height: number): DOMRect {
  return new DOMRect(0, top, 300, height);
}

function mountDock(
  directoryCount: number, selectedDirectory = 0, zoom = 1,
  { withResizeObserver = false, withProjectIndex = false } = {},
) {
  const fixture = buildLargeDirectoryFixture({
    directoryCount, unpinnedThreadsPerDirectory: 2, directoryThreadsCollapsed: false,
  });
  const { directories, threads } = fixture;
  let selected = threads[selectedDirectory * 3 + 1]!;
  let selectedKey = buildThreadIdentityKey(selected.source, selected.id);
  const directoryOrder = new Map(directories.map(({ key }, index) => [key, index]));
  const projects = directories.map(({ key, label }) => ({ key, label, containsSelection: false, active: false, review: false }));
  const disclosure = {
    expandedByKey: Object.fromEntries(directories.map(({ key }) => [key, true])),
    unpinnedExpandedByKey: {},
    setExpandedByKey: noop,
    setUnpinnedExpandedByKey: noop,
    previousSelectedItemKeyRef: { current: selectedKey },
    handledRevealRequestRef: { current: 0 },
  };
  let offset = 0;
  let arrivedChildren = 0;
  let laneReads = 0;
  const work = { row: 0, sticky: 0, selectors: 0, reserveLifts: 0 };
  const viewportBox = (top: number, height: number) => box(top * zoom, height * zoom);
  const originalRect = Element.prototype.getBoundingClientRect;
  const geometry = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.matches(".directory-list")) {
      laneReads++;
      return viewportBox(VIEW_TOP, VIEW_HEIGHT);
    }
    if (this.matches(".sidebar__scroll-region")) return viewportBox(VIEW_TOP, VIEW_HEIGHT);
    const directory = this.closest<HTMLElement>(".directory-row");
    const index = directoryOrder.get(directory?.dataset.directoryKey ?? "");
    if (index === undefined) return originalRect.call(this);
    const top = VIEW_TOP + index * PITCH - offset;
    const reserve = this.closest(".sidebar__scroll-region")?.classList.contains(RESERVE) ? 58 : 0;
    if (this === directory) return viewportBox(top + 2, PITCH - 2);
    if (this.matches(".directory-row__header")) {
      work.sticky++;
      return viewportBox(Math.min(Math.max(top + 2, VIEW_TOP + reserve), top + PITCH - 28), 28);
    }
    if (this.matches(".directory-row__thread-divider")) {
      work.sticky++;
      return viewportBox(Math.min(Math.max(top + 90, VIEW_TOP + 28 + reserve), top + PITCH - 26), 24);
    }
    if (this.matches(".directory-row__thread-divider-origin")) return viewportBox(top + 90, 0);
    if (this.matches(".thread-row") && this.parentElement?.getAttribute("data-thread-key") === selectedKey) {
      work.row++;
      return viewportBox(top + ROW_TOP + arrivedChildren * 36, ROW_HEIGHT);
    }
    return originalRect.call(this);
  });
  let laneStyleReads = 0;
  const nativeStyle = window.getComputedStyle;
  const style = vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    if (element.matches(".thread-row-shell, .sidebar-list--dense")) laneStyleReads++;
    return nativeStyle(element, pseudo);
  });
  const queryAll = Element.prototype.querySelectorAll;
  const selectors = vi.spyOn(Element.prototype, "querySelectorAll").mockImplementation(function (this: Element, query) {
    if (this.matches(DOCK_QUERY_ROOTS)) work.selectors++;
    return queryAll.call(this, query);
  });
  const queryOne = Element.prototype.querySelector;
  const singleSelectors = vi.spyOn(Element.prototype, "querySelector").mockImplementation(function (this: Element, query) {
    if (this.matches(DOCK_QUERY_ROOTS) && !query.startsWith(".selected-thread-dock")) work.selectors++;
    return queryOne.call(this, query);
  });
  const originalRemove = DOMTokenList.prototype.remove;
  const reserve = vi.spyOn(DOMTokenList.prototype, "remove").mockImplementation(function (this: DOMTokenList, ...tokens) {
    if (tokens.includes(RESERVE) && this.contains(RESERVE)) work.reserveLifts++;
    originalRemove.apply(this, tokens);
  });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });

  const observers = new Set<TestResizeObserver>();
  let nextObserver = 0;
  class TestResizeObserver implements ResizeObserver {
    readonly order = nextObserver++;
    private readonly observations = new Map<Element, { box: ResizeObserverBoxOptions; lastHeight?: number }>();
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element, options?: ResizeObserverOptions): void {
      const observedBox = options?.box ?? "content-box";
      if (this.observations.get(target)?.box === observedBox) return;
      this.observations.set(target, { box: observedBox });
      observers.add(this);
    }
    unobserve(target: Element): void {
      this.observations.delete(target);
      if (this.observations.size === 0) observers.delete(this);
    }
    disconnect(): void {
      this.observations.clear();
      observers.delete(this);
    }
    deliver(): void {
      const entries: ResizeObserverEntry[] = [];
      for (const [target, observation] of this.observations) {
        const height = target.matches(".directory-row__header") ? 28 : VIEW_HEIGHT;
        if (height === observation.lastHeight) continue;
        observation.lastHeight = height;
        const size = [{ inlineSize: 300, blockSize: height }];
        entries.push({ target, contentRect: box(0, height), borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size });
      }
      if (entries.length > 0) this.callback(entries, this);
    }
  }
  if (withResizeObserver) vi.stubGlobal("ResizeObserver", TestResizeObserver);

  function Fixture({ metadata, children = 0 }: { metadata: number; children?: number }) {
    const regionRef = useRef<HTMLDivElement>(null);
    const updated = threads.map((thread, index) => index === 0
      ? { ...thread, title: `Metadata ${metadata}` }
      : thread);
    const updatedDirectories = directories.map((directory, index) => index === directoryCount - 1
      ? { ...directory, gitStatus: { currentBranch: `branch-${metadata}` } }
      : directory);
    const parent = threads[0]!;
    const arrived = Array.from({ length: children }, (_, index) => ({
      ...parent, pinnedRank: undefined, id: `child-${index}`, title: `Child ${index}`,
      parentThreadId: parent.id, parentThreadBackend: parent.source,
    }));
    return (
      <>
        {withProjectIndex ? (
          <ProjectIndex
            projects={projects}
            scrollRegionRef={regionRef}
            scrollRegionId="fixture-region"
            spy
            width={null}
            onWidthChange={noop}
            onJump={noop}
          />
        ) : null}
        <div id="fixture-region" className="sidebar__scroll-region" ref={regionRef}>
          <FixtureDirectoriesList
            directories={updatedDirectories}
            directoryDisclosure={disclosure}
            threads={[...updated, ...arrived]}
            selectedItemKey={selectedKey}
            onOpenLaunchpad={asyncNoop}
            onOpenThreadContextMenu={noop}
            onSelectThread={noop}
          />
          <SelectedThreadDock
            regionRef={regionRef}
            thread={selected}
            threadKey={selectedKey}
            status={undefined}
            remoteWork={false}
            projectLabel={(key) => key}
            ancestorThreadKeys={[]}
            directoryKeys={[directories[selectedDirectory]!.key]}
            onRevealHiddenThread={noop}
          />
        </div>
      </>
    );
  }

  const view = render(<Fixture metadata={0} />);
  const region = view.container.querySelector<HTMLElement>(".sidebar__scroll-region")!;
  const lane = queryOne.call(region, ".directory-list") as HTMLElement;
  lane.style.overflowY = "auto";
  Object.defineProperty(lane, "currentCSSZoom", { value: zoom });
  Object.defineProperty(lane, "clientHeight", { value: VIEW_HEIGHT });
  const dividerStyle = document.createElement("style");
  dividerStyle.textContent = ".directory-row__thread-divider { --directory-row-header-height: 28px; }";
  document.head.append(dividerStyle);
  view.rerender(<Fixture metadata={0} />);
  expect(queryAll.call(lane, ".directory-row__thread-divider")).toHaveLength(directoryCount);
  function runFrameCallbacks() {
    const pending = [...frames.values()];
    frames.clear();
    act(() => pending.forEach((callback) => callback(0)));
  }
  function deliverLayout() {
    act(() => [...observers].sort((a, b) => a.order - b.order).forEach((observer) => observer.deliver()));
  }
  function flush() {
    runFrameCallbacks();
    deliverLayout();
  }
  async function settle() {
    await act(async () => {});
    flush();
  }
  function queueScroll(nextOffset: number) {
    offset = nextOffset;
    lane.scrollTop = nextOffset;
    lane.dispatchEvent(new Event("scroll"));
    lane.dispatchEvent(new Event("scroll"));
  }
  return {
    edge: () => region.querySelector<HTMLElement>(".selected-thread-dock")?.dataset.edge,
    currentProject: () => view.container.querySelector("[aria-current=location]")?.getAttribute("data-project-key"),
    projectKey: (index: number) => directories[index]!.key,
    selectDirectory(index: number) {
      selectedDirectory = index;
      selected = threads[index * 3 + 1]!;
      selectedKey = buildThreadIdentityKey(selected.source, selected.id);
      disclosure.previousSelectedItemKeyRef.current = selectedKey;
      view.rerender(<Fixture metadata={0} />);
    },
    move(nextOffset: number) {
      queueScroll(nextOffset);
      flush();
    },
    async fold(folded: boolean) {
      await act(async () => {
        lane.classList.toggle("is-folding-directories", folded);
      });
      flush();
    },
    update: (value: number) => view.rerender(<Fixture metadata={value} />),
    queueScroll,
    flush,
    runFrameCallbacks,
    deliverLayout,
    laneReads: () => laneReads,
    settle,
    styleReads: () => laneStyleReads,
    updatePage(children: number) {
      arrivedChildren = children;
      view.rerender(<Fixture metadata={0} children={children} />);
      expect(queryAll.call(lane, '.thread-row-shell[data-thread-key^="codex:child-"]')).toHaveLength(children);
    },
    reset() {
      laneReads = 0;
      Object.assign(work, { row: 0, sticky: 0, selectors: 0, reserveLifts: 0 });
    },
    work,
    cleanup() {
      queueScroll(offset);
      view.unmount();
      const pendingAfterUnmount = frames.size;
      request.mockRestore();
      cancel.mockRestore();
      geometry.mockRestore();
      selectors.mockRestore();
      singleSelectors.mockRestore();
      reserve.mockRestore();
      style.mockRestore();
      dividerStyle.remove();
      expect(observers.size).toBe(0);
      expect(pendingAfterUnmount).toBe(0);
    },
  };
}

async function expectStableTop(
  fixture: ReturnType<typeof mountDock>,
  offset: number,
  metadata: number,
  expectedRowReads = 1,
) {
  fixture.move(offset);
  expect(fixture.edge()).toBe("top");
  fixture.reset();
  fixture.update(metadata);
  await fixture.settle();
  expect(fixture.edge()).toBe("top");
  expect(fixture.work).toEqual({ row: expectedRowReads, sticky: 0, selectors: 0, reserveLifts: 0 });
}

it.each([12, 24])("keeps work constant as unrelated metadata commits over %i directories", async (count) => {
  const fixture = mountDock(count);
  try {
    await expectStableTop(fixture, 700, 1);
  } finally {
    fixture.cleanup();
  }
});

it("keeps the same work budget for generated offscreen positions and metadata", async () => {
  const fixture = mountDock(4);
  try {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 180, max: 5000 }), fc.integer(), async (offset, metadata) => {
      // Start each sample from known metadata. A changed DOM needs one row
      // read, while repeating the same commit leaves the DOM untouched.
      fixture.update(0);
      await expectStableTop(fixture, offset, metadata, metadata === 0 ? 0 : 1);
      await expectStableTop(fixture, offset, metadata, 0);
    }), { numRuns: 5, examples: [[180, 0], [180, 6]] });
  } finally {
    fixture.cleanup();
  }
});

it.each([12, 24])("matches the sticky band through scroll frames and metadata commits over %i directories", async (count) => {
  const fixture = mountDock(count, 1);
  try {
    // Project 2's row starts at y=700. At offset 569 it still shows
    // 39px below the stuck divider at y=152, and at 570 it shows 38px.
    const cases = [
      [0, "bottom"], [350, undefined], [569, undefined], [570, "top"],
      [571, "top"], [565, undefined], [920, "top"],
    ] as const;
    for (const [offset, expected] of cases) {
      fixture.move(offset);
      expect(fixture.edge(), `after scrolling to ${offset}`).toBe(expected);
      fixture.reset();
      fixture.update(offset + 1);
      await fixture.settle();
      expect(fixture.edge(), `after a commit at ${offset}`).toBe(expected);
      expect(fixture.work.row).toBe(1);
      expect(fixture.work.selectors).toBe(0);
      expect(fixture.work.sticky).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(count + 1)));
    }
  } finally {
    fixture.cleanup();
  }
});

it("keeps the top reserve in place while the same dock covers the selected row", () => {
  const fixture = mountDock(12, 1);
  const checkScroll = (offsets: number[]) => {
    fixture.move(570);
    expect(fixture.edge()).toBe("top");
    fixture.reset();
    for (const offset of offsets) {
      fixture.move(offset);
      expect(fixture.edge()).toBe("top");
    }
    expect(fixture.work.reserveLifts).toBe(0);
  };
  try {
    checkScroll([571]); // A one-pixel scroll used to lift and reapply the reserve.
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 570, max: 610 }), { minLength: 1, maxLength: 8 }),
      checkScroll,
    ), { numRuns: 5 });
  } finally {
    fixture.cleanup();
  }
});

it.each([0.85, 1.1])("keeps the sticky threshold in viewport coordinates at CSS zoom %s", (zoom) => {
  const fixture = mountDock(12, 1, zoom);
  try {
    // The divider ends at y=152 in CSS pixels. The selected row ends at
    // y=760 before scrolling. The row must show at least 39 viewport pixels.
    const firstDockedOffset = Math.floor(608 - 39 / zoom) + 1;
    fixture.move(firstDockedOffset);
    expect(fixture.edge()).toBe("top");
    fixture.move(firstDockedOffset - 1);
    expect(fixture.edge()).toBeUndefined();
  } finally {
    fixture.cleanup();
  }
});

it("releases and restores the dock when a folder drag folds and unfolds the lane", async () => {
  const fixture = mountDock(4);
  try {
    fixture.move(700);
    expect(fixture.edge()).toBe("top");
    await fixture.fold(true);
    expect(fixture.edge()).toBeUndefined();
    await fixture.fold(false);
    expect(fixture.edge()).toBe("top");
  } finally {
    fixture.cleanup();
  }
});

it("performs no geometry reads on commits that leave the sidebar DOM unchanged", async () => {
  const fixture = mountDock(24);
  try {
    fixture.move(700);
    expect(fixture.edge()).toBe("top");
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (commits) => {
      fixture.reset();
      for (let index = 0; index < commits; index += 1) {
        fixture.update(0);
        await fixture.settle();
      }
      expect(fixture.work).toEqual({ row: 0, sticky: 0, selectors: 0, reserveLifts: 0 });
    }), { numRuns: 5, examples: [[1], [6]] });
  } finally {
    fixture.cleanup();
  }
});

it("coalesces child-page commits and a queued scroll while measuring the final row position", () => {
  const fixture = mountDock(4);
  try {
    fc.assert(fc.property(fc.integer({ min: 195, max: 245 }), fc.integer({ min: 2, max: 8 }), (offset, children) => {
      fixture.updatePage(0);
      fixture.move(700);
      expect(fixture.edge()).toBe("top");
      fixture.reset();
      const styleReads = fixture.styleReads();
      fixture.queueScroll(offset);
      for (let arrived = 1; arrived <= children; arrived++) fixture.updatePage(arrived);
      expect(fixture.work.row).toBe(0);
      fixture.flush();
      // The child page is above the selected row. The last commit shifts it
      // by the full page height, and the stuck header and divider end at 152.
      const rowTop = VIEW_TOP + ROW_TOP + children * 36 - offset;
      const shown = rowTop + ROW_HEIGHT - Math.max(152, rowTop);
      expect(fixture.edge()).toBe(shown >= 39 ? undefined : "top");
      expect(fixture.work.row).toBe(1);
      expect(fixture.styleReads()).toBe(styleReads);
    }), { numRuns: 5, examples: [[210, 4], [210, 2]] });
  } finally {
    fixture.cleanup();
  }
});

it("samples final scroll and page geometry after layout in the same rendering update", () => {
  const fixture = mountDock(4, 0, 1, { withResizeObserver: true });
  try {
    fc.assert(fc.property(fc.integer({ min: 195, max: 245 }), fc.integer({ min: 0, max: 5 }), (offset, children) => {
      fixture.updatePage(0);
      fixture.move(700);
      expect(fixture.edge()).toBe("top");
      fixture.reset();

      fixture.queueScroll(offset);
      fixture.runFrameCallbacks();
      expect(fixture.laneReads()).toBe(0);
      expect(fixture.work.row).toBe(0);
      expect(fixture.edge()).toBe("top");

      // A later animation callback can commit a child page before Chromium
      // runs layout. It is the new row position that will be painted.
      fixture.updatePage(children);
      fixture.deliverLayout();
      const rowTop = VIEW_TOP + ROW_TOP + children * 36 - offset;
      const shown = rowTop + ROW_HEIGHT - Math.max(152, rowTop);
      expect(fixture.edge()).toBe(shown >= 39 ? undefined : "top");
      expect(fixture.work.row).toBe(1);
    }), { numRuns: 5, examples: [[218, 0], [218, 4]] });
  } finally {
    fixture.cleanup();
  }
});

it("samples the project under the new sticky line when the index observer runs first", () => {
  const fixture = mountDock(4, 1, 1, { withResizeObserver: true, withProjectIndex: true });
  try {
    fc.assert(fc.property(fc.integer({ min: PITCH - 55, max: PITCH - 15 }), (offset) => {
      fixture.move(0);
      // The selection change rebuilds the dock observer after the index observer.
      fixture.selectDirectory(0);
      expect(fixture.edge()).toBeUndefined();
      fixture.reset();
      fixture.move(offset);
      expect(fixture.edge()).toBe("top");
      expect(fixture.currentProject()).toBe(fixture.projectKey(1));
      expect(fixture.work.row).toBe(1);

      fixture.move(1000);
      fixture.selectDirectory(1);
      expect(fixture.edge()).toBe("top");
      fixture.reset();
      fixture.move(offset);
      expect(fixture.edge()).toBeUndefined();
      expect(fixture.currentProject()).toBe(fixture.projectKey(0));
      expect(fixture.work.row).toBe(1);
    }), { numRuns: 5, examples: [[PITCH - 55], [PITCH - 15]] });
  } finally {
    fixture.cleanup();
  }
});

it("samples successive pure scrolls whose observed box sizes stay fixed", () => {
  const fixture = mountDock(4, 0, 1, { withResizeObserver: true });
  try {
    fixture.move(0);
    fc.assert(fc.property(fc.integer({ min: 700, max: 1000 }), (offscreen) => {
      for (const [offset, edge] of [[offscreen, "top"], [0, undefined], [offscreen + 1, "top"], [1, undefined]] as const) {
        fixture.reset();
        fixture.move(offset);
        expect(fixture.edge()).toBe(edge);
        expect(fixture.work.row).toBe(1);
      }
    }), { numRuns: 5, examples: [[700], [1000]] });
  } finally {
    fixture.cleanup();
  }
});
