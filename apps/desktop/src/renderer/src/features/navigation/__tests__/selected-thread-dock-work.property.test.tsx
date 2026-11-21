import { act, render } from "@testing-library/react";
import fc from "fast-check";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { FixtureDirectoriesList } from "../../../test/navigation-presentation-fixture";
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

afterEach(() => vi.restoreAllMocks());

function box(top: number, height: number): DOMRect {
  return new DOMRect(0, top, 300, height);
}

function mountDock(directoryCount: number, selectedDirectory = 0) {
  const fixture = buildLargeDirectoryFixture({
    directoryCount, unpinnedThreadsPerDirectory: 2, directoryThreadsCollapsed: false,
  });
  const { directories, threads } = fixture;
  const selected = threads[selectedDirectory * 3 + 1]!;
  const selectedKey = buildThreadIdentityKey(selected.source, selected.id);
  const directoryOrder = new Map(directories.map(({ key }, index) => [key, index]));
  const disclosure = {
    expandedByKey: Object.fromEntries(directories.map(({ key }) => [key, true])),
    unpinnedExpandedByKey: {},
    setExpandedByKey: noop,
    setUnpinnedExpandedByKey: noop,
    previousSelectedItemKeyRef: { current: selectedKey },
    handledRevealRequestRef: { current: 0 },
  };
  let offset = 0;
  const work = { row: 0, sticky: 0, selectors: 0, reserveLifts: 0 };
  const originalRect = Element.prototype.getBoundingClientRect;
  const geometry = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.matches(".sidebar__scroll-region, .directory-list")) return box(VIEW_TOP, VIEW_HEIGHT);
    const directory = this.closest<HTMLElement>(".directory-row");
    const index = directoryOrder.get(directory?.dataset.directoryKey ?? "");
    if (index === undefined) return originalRect.call(this);
    const top = VIEW_TOP + index * PITCH - offset;
    const reserve = this.closest(".sidebar__scroll-region")?.classList.contains(RESERVE) ? 58 : 0;
    if (this.matches(".directory-row__header")) {
      work.sticky++;
      return box(Math.min(Math.max(top + 2, VIEW_TOP + reserve), top + PITCH - 28), 28);
    }
    if (this.matches(".directory-row__thread-divider")) {
      work.sticky++;
      return box(Math.min(Math.max(top + 90, VIEW_TOP + 28 + reserve), top + PITCH - 26), 24);
    }
    if (this.matches(".thread-row") && this.parentElement?.getAttribute("data-thread-key") === selectedKey) {
      work.row++;
      return box(top + ROW_TOP, ROW_HEIGHT);
    }
    return originalRect.call(this);
  });
  const queryAll = Element.prototype.querySelectorAll;
  const selectors = vi.spyOn(Element.prototype, "querySelectorAll").mockImplementation(function (this: Element, query) {
    if (this.matches(".sidebar__scroll-region")) work.selectors++;
    if (this.matches(".directory-list") && (query === ".directory-row__header" || query === ".directory-row__thread-divider")) work.selectors++;
    return queryAll.call(this, query);
  });
  const queryOne = Element.prototype.querySelector;
  const singleSelectors = vi.spyOn(Element.prototype, "querySelector").mockImplementation(function (this: Element, query) {
    if (this.matches(".sidebar__scroll-region") && !query.startsWith(".selected-thread-dock")) work.selectors++;
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

  function Fixture({ metadata }: { metadata: number }) {
    const regionRef = useRef<HTMLDivElement>(null);
    const updated = threads.map((thread, index) => index === 0
      ? { ...thread, title: `Metadata ${metadata}` }
      : thread);
    const updatedDirectories = directories.map((directory, index) => index === directoryCount - 1
      ? { ...directory, gitStatus: { currentBranch: `branch-${metadata}` } }
      : directory);
    return (
      <div className="sidebar__scroll-region" ref={regionRef}>
        <FixtureDirectoriesList
          directories={updatedDirectories}
          directoryDisclosure={disclosure}
          threads={updated}
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
    );
  }

  const view = render(<Fixture metadata={0} />);
  const region = view.container.querySelector<HTMLElement>(".sidebar__scroll-region")!;
  const lane = queryOne.call(region, ".directory-list") as HTMLElement;
  lane.style.overflowY = "auto";
  view.rerender(<Fixture metadata={0} />);
  expect(lane.querySelectorAll(".directory-row__thread-divider")).toHaveLength(directoryCount);
  function flush() {
    const pending = [...frames.values()];
    frames.clear();
    act(() => pending.forEach((callback) => callback(0)));
  }
  function queueScroll(nextOffset: number) {
    offset = nextOffset;
    lane.scrollTop = nextOffset;
    lane.dispatchEvent(new Event("scroll"));
    lane.dispatchEvent(new Event("scroll"));
  }
  return {
    edge: () => region.querySelector<HTMLElement>(".selected-thread-dock")?.dataset.edge,
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
    reset: () => Object.assign(work, { row: 0, sticky: 0, selectors: 0, reserveLifts: 0 }),
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
      expect(pendingAfterUnmount).toBe(0);
    },
  };
}

function expectStableTop(
  fixture: ReturnType<typeof mountDock>,
  offset: number,
  metadata: number,
) {
  fixture.move(offset);
  expect(fixture.edge()).toBe("top");
  fixture.reset();
  fixture.update(metadata);
  expect(fixture.edge()).toBe("top");
  expect(fixture.work).toEqual({ row: 1, sticky: 0, selectors: 0, reserveLifts: 0 });
}

it.each([12, 24])("keeps work constant as unrelated metadata commits over %i directories", (count) => {
  const fixture = mountDock(count);
  try {
    expectStableTop(fixture, 700, 1);
  } finally {
    fixture.cleanup();
  }
});

it("keeps the same work budget for generated offscreen positions and metadata", () => {
  const fixture = mountDock(4);
  try {
    fc.assert(fc.property(fc.integer({ min: 180, max: 5000 }), fc.integer(), (offset, metadata) => {
      expectStableTop(fixture, offset, metadata);
    }), { numRuns: 25 });
  } finally {
    fixture.cleanup();
  }
});

it.each([12, 24])("matches the sticky band through scroll frames and metadata commits over %i directories", (count) => {
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
      expect(fixture.edge(), `after a commit at ${offset}`).toBe(expected);
      expect(fixture.work.row).toBe(1);
      expect(fixture.work.selectors).toBe(0);
      expect(fixture.work.sticky).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(count + 1)));
    }
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
