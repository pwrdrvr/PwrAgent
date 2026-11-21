import { act, fireEvent, render } from "@testing-library/react";
import fc from "fast-check";
import { createRef, Profiler } from "react";
import { describe, expect, it, vi } from "vitest";
import { ProjectIndex, type ProjectIndexEntry } from "../ProjectIndex";

type Row = { key: string; height: number };

function rowsOf(heights: readonly number[]): Row[] {
  return heights.map((height, index) => ({ key: `project-${index}`, height }));
}

function entriesOf(rows: Row[], selectedKey?: string): ProjectIndexEntry[] {
  return rows.map(({ key }) => ({
    key, label: key, active: false, review: false, containsSelection: key === selectedKey,
  }));
}

function mountIndex(projectRows: Row[], { gap = 8, height = 145, scrollTop = 0 } = {}) {
  const listTop = 52;
  let rows = projectRows;
  let boxes = new Map<string, { top: number; bottom: number }>();
  const layOut = (): void => {
    let top = gap;
    boxes = new Map(rows.map(({ key, height }, index) => {
      const bottom = top + height;
      const result = [key, { top, bottom }] as const;
      top = bottom + (index === 0 ? gap : 0); // Pin divider after the first project.
      return result;
    }));
  };
  layOut();

  const work = {
    queries: 0, listRects: 0, listHeights: 0, sectionRects: 0,
    resizePublications: 0, mutationPublications: 0, frames: 0, commits: 0,
  };
  const resetWork = (): void => {
    for (const key of Object.keys(work) as (keyof typeof work)[]) work[key] = 0;
  };
  let target = createRef<HTMLDivElement>();
  let regionVersion = 0;
  let projects = entriesOf(projectRows);
  const onJump = vi.fn();
  const onWidthChange = vi.fn();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    work.frames += 1;
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });

  const observers: TestResizeObserver[] = [];
  class TestResizeObserver implements ResizeObserver {
    readonly targets = new Set<Element>();
    constructor(private readonly receive: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(element: Element): void {
      this.targets.add(element);
    }
    unobserve(element: Element): void {
      this.targets.delete(element);
    }
    disconnect(): void {
      this.targets.clear();
    }
    publish(elements: Element[]): void {
      const entries = elements.filter((el) => this.targets.has(el)).map((el) => ({ target: el }) as ResizeObserverEntry);
      if (entries.length === 0) return;
      work.resizePublications += 1;
      this.receive(entries, this);
    }
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);

  const NativeMutationObserver = MutationObserver;
  vi.stubGlobal("MutationObserver", class extends NativeMutationObserver {
    constructor(callback: MutationCallback) {
      super((records, observer) => {
        work.mutationPublications += 1;
        callback(records, observer);
      });
    }
  });

  const elementRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("directory-list")) {
      work.listRects += 1;
      return new DOMRect(0, listTop, 400, height);
    }
    const key = this.dataset["directoryKey"];
    if (key !== undefined) {
      work.sectionRects += 1;
      const { top, bottom } = boxes.get(key)!;
      return height === 0 ? new DOMRect() : new DOMRect(0, listTop + top - scrollTop, 400, bottom - top);
    }
    return elementRect.call(this);
  });
  const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!.get!;
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    if (this.classList.contains("directory-list")) {
      work.listHeights += 1;
      return height;
    }
    return clientHeight.call(this) as number;
  });
  const selectAll = Element.prototype.querySelectorAll;
  vi.spyOn(Element.prototype, "querySelectorAll").mockImplementation(function (this: Element, selector: string) {
    if (this.classList.contains("directory-list")) work.queries += 1;
    return selectAll.call(this, selector);
  });

  let spy = true;
  let listVersion = 0;
  const tree = () => (
    <>
      <Profiler id="index" onRender={() => { work.commits += 1; }}>
        <ProjectIndex
          projects={projects}
          scrollRegionRef={target}
          scrollRegionId="fixture-region"
          spy={spy}
          width={null}
          onJump={onJump}
          onWidthChange={onWidthChange}
        />
      </Profiler>
      <div key={regionVersion} ref={target} id="fixture-region">
        <div key={listVersion} className="directory-list">
          <div className="directory-list__starting" />
          {rows.map(({ key }) => (
            <section key={key} className="directory-row" data-directory-key={key}>
              <header />
              <div data-nested-scroll="" />
            </section>
          )).flatMap((section, index) => index === 0
            ? [section, <div key="divider" className="directories-pinned-divider" />]
            : [section])}
          <div className="directory-list__jump-tail" />
        </div>
      </div>
    </>
  );
  const view = render(tree());
  const list = () => target.current!.querySelector<HTMLElement>(".directory-list")!;
  const section = (key: string) => list().querySelector<HTMLElement>(`[data-directory-key="${key}"]`)!;
  const paint = (): void => {
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  };
  const publishResize = (...elements: Element[]): void => {
    act(() => {
      for (const observer of observers) observer.publish(elements);
    });
  };
  const scroll = (offset: number, source: Element = list()): void => {
    scrollTop = offset;
    fireEvent.scroll(source);
  };
  const matchOracle = (): string[] => {
    // Full scan of fixture data. No selectors or layout reads on the feature's list.
    const expected = height === 0 ? [] : [...boxes].filter(([, box]) =>
      box.bottom > scrollTop + 1 && box.top < scrollTop + height).map(([key]) => key);
    const nav = view.container.querySelector("nav")!;
    expect(Array.from(nav.querySelectorAll<HTMLElement>(".is-current, .is-in-view"), (item) =>
      item.dataset["projectKey"]).sort()).toEqual([...expected].sort());
    expect(nav.querySelector("[aria-current=location]")?.getAttribute("data-project-key")).toBe(expected[0]);
    return expected;
  };

  return {
    work, resetWork, frames, observers, list, section, paint, publishResize, scroll, matchOracle,
    updateHeight(key: string, next: number) {
      rows = rows.map((row) => row.key === key ? { ...row, height: next } : row);
      layOut();
      publishResize(section(key));
    },
    resize(next: number) {
      height = next;
      publishResize(list(), target.current!);
    },
    replaceRows(next: Row[], replaceList = false) {
      rows = next;
      layOut();
      if (replaceList) listVersion += 1;
      view.rerender(tree());
    },
    replaceProjects(next: Row[], selectedKey?: string) {
      projects = entriesOf(next, selectedKey);
      rows = next;
      layOut();
      view.rerender(tree());
    },
    tabStops: () => Array.from(
      view.container.querySelectorAll<HTMLElement>('nav button[data-project-key][tabindex="0"]'),
      (item) => item.dataset["projectKey"],
    ),
    enableSpy(next: boolean) {
      spy = next;
      view.rerender(tree());
    },
    replaceRegion() {
      target = createRef<HTMLDivElement>();
      regionVersion += 1;
      view.rerender(tree());
    },
    unmount: view.unmount,
    dispose() {
      view.unmount();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    },
  };
}

describe("Project Index scroll work", () => {
  it.each([128, 256])("bounds geometry work across unchanged-layout scroll frames with %i sections", (count) => {
    const fixture = mountIndex(rowsOf(Array<number>(count).fill(100)), { gap: 0, height: 70 });
    try {
      fixture.publishResize(fixture.list());
      fixture.paint();
      fixture.resetWork();
      // Coalesce three events per frame, including events at the same offset.
      // The final four frames move within the same project and need no UI publication.
      for (const offset of [99, 100, 199, 200, 299, 300, 301, 302, 303, 304]) {
        fixture.scroll(offset - 1);
        fixture.scroll(offset);
        fixture.scroll(offset);
        expect(fixture.frames.size).toBe(1);
        fixture.paint();
        fixture.matchOracle();
      }
      expect(fixture.work, JSON.stringify(fixture.work)).toMatchObject({
        queries: 0, listRects: 10, listHeights: 10, resizePublications: 0, mutationPublications: 0,
        frames: 10, commits: 3,
      });
      expect(fixture.work.sectionRects, `section rect reads with ${count} rows across 10 frames`)
        .toBeLessThanOrEqual(10 * (Math.ceil(Math.log2(count + 1)) + 3));
    } finally {
      fixture.dispose();
    }
  });

  it("matches a full-scan oracle within the work budget at fractional boundaries", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 20, max: 230 }).map((height) => height / 2), { minLength: 12, maxLength: 32 }),
      fc.integer({ min: 5, max: 260 }),
      fc.nat(),
      (heights, viewport, index) => {
        const rows = rowsOf(heights);
        const gap = 9.5;
        const before = index % rows.length;
        const bottom = heights.slice(0, before + 1).reduce((sum, height) => sum + height, gap * (before > 0 ? 2 : 1));
        const fixture = mountIndex(rows, { gap, height: viewport });
        try {
          for (const offset of [gap - viewport, 0, bottom - 1.5, bottom - 1, bottom - 0.5, bottom + 0.5]) {
            fixture.resetWork();
            fixture.scroll(Math.max(0, offset));
            fixture.paint();
            const visible = fixture.matchOracle();
            expect(fixture.work.sectionRects).toBeLessThanOrEqual(
              Math.ceil(Math.log2(rows.length + 1)) + visible.length + 1,
            );
            expect(fixture.work.queries).toBe(0);
          }
        } finally {
          fixture.dispose();
        }
      },
    ), { numRuns: 25 });
  });

  it("updates when a section grows or collapses above or below the viewport and on resize", () => {
    const rows = rowsOf([100, 100, 100, 100, 100]);
    const fixture = mountIndex(rows, { gap: 0, height: 80 });
    try {
      fixture.scroll(210, fixture.section(rows[0]!.key).lastElementChild!);
      fixture.paint();
      expect(fixture.matchOracle()).toEqual(["project-2"]);
      fixture.resetWork();
      fixture.updateHeight("project-0", 160);
      expect(fixture.frames.size).toBe(1);
      fixture.paint();
      expect(fixture.matchOracle()).toEqual(["project-1", "project-2"]);
      fixture.updateHeight("project-4", 220);
      fixture.paint();
      expect(fixture.matchOracle()).toEqual(["project-1", "project-2"]);
      expect(fixture.work).toMatchObject({ resizePublications: 2, mutationPublications: 0, frames: 2, commits: 1 });
      fixture.updateHeight("project-0", 100);
      fixture.resize(0);
      fixture.paint();
      expect(fixture.matchOracle()).toEqual([]);
      fixture.resize(190);
      fixture.paint();
      expect(fixture.matchOracle()).toEqual(["project-2", "project-3"]);
      fixture.resize(191);
      fixture.paint();
      expect(fixture.matchOracle()).toEqual(["project-2", "project-3", "project-4"]);
    } finally {
      fixture.dispose();
    }
  });

  it.each([128, 256])("reads live bounds after nested insertion without looking up %i direct children", async (count) => {
    const fixture = mountIndex(rowsOf(Array<number>(count).fill(100)), { gap: 0, height: 80 });
    try {
      fixture.scroll(210);
      fixture.paint();
      expect(fixture.matchOracle()).toEqual(["project-2"]);
      const children = vi.spyOn(fixture.list(), "children", "get");
      fixture.resetWork();
      // A tray can add rows and invalidate the browser's live child collection
      // even though the list's direct children and their order stay the same.
      await act(async () => {
        fixture.section("project-0").lastElementChild!.append(document.createElement("div"));
        fixture.updateHeight("project-0", 160);
      });
      fixture.paint();
      expect(fixture.matchOracle()).toEqual(["project-1", "project-2"]);
      expect(fixture.work).toMatchObject({ queries: 0, mutationPublications: 0, resizePublications: 1, frames: 1 });
      expect(children).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
  });

  it.each([undefined, "project-3"])("keeps one project Tab stop after removal with selection %s", async (selectedKey) => {
    const rows = rowsOf([100, 100, 100, 100]);
    const fixture = mountIndex(rows, { gap: 0, height: 80 });
    try {
      fixture.scroll(110);
      fixture.paint();
      expect(fixture.tabStops()).toEqual(["project-1"]);
      // The refresh commits immediately. Tab still needs a valid stop while
      // the spy waits for its frame to measure the new directory order.
      await act(async () => fixture.replaceProjects([rows[0]!, rows[2]!, rows[3]!], selectedKey));
      expect(fixture.tabStops()).toEqual([selectedKey ?? "project-0"]);
      fixture.paint();
      expect(fixture.matchOracle()).toEqual(["project-2"]);
      expect(fixture.tabStops()).toEqual(["project-2"]);
    } finally {
      fixture.dispose();
    }
  });

  it("follows DOM reorder, removal, insertion and list replacement with unchanged index entries", async () => {
    const rows = rowsOf([100, 100, 100, 100]);
    const fixture = mountIndex(rows, { gap: 0, height: 80 });
    try {
      fixture.scroll(110);
      fixture.paint();
      expect(fixture.matchOracle()).toEqual(["project-1"]);
      const removed = fixture.section("project-1");
      fixture.resetWork();
      await act(async () => fixture.replaceRows([rows[2]!, rows[0]!, rows[3]!]));
      expect(fixture.work).toMatchObject({ mutationPublications: 1, frames: 1 });
      fixture.paint();
      expect(fixture.matchOracle()).toEqual(["project-0"]);
      expect(fixture.observers.some(({ targets }) => targets.has(removed))).toBe(false);
      await act(async () => fixture.replaceRows([rows[3]!, rows[1]!, rows[2]!, rows[0]!]));
      fixture.paint();
      expect(fixture.matchOracle()).toEqual(["project-1"]);
      const list = fixture.list();
      fixture.scroll(210, list);
      await act(async () => fixture.replaceRows([rows[0]!, rows[1]!, rows[3]!, rows[2]!], true));
      fixture.paint();
      expect(fixture.matchOracle()).toEqual(["project-3"]);
      expect(fixture.observers.some(({ targets }) => targets.has(list))).toBe(false);
      fixture.updateHeight("project-0", 150);
      fixture.paint();
      expect(fixture.matchOracle()).toEqual(["project-1", "project-3"]);
    } finally {
      fixture.dispose();
    }
  });

  it("cancels pending work on disable, target change and unmount", () => {
    const fixture = mountIndex(rowsOf([100, 100, 100, 100]), { gap: 0, height: 80 });
    try {
      fixture.scroll(100);
      expect(fixture.frames.size).toBe(1);
      fixture.enableSpy(false);
      expect(fixture.frames.size).toBe(0);
      fixture.resetWork();
      fixture.scroll(200);
      fixture.publishResize(fixture.list());
      fixture.paint();
      expect(fixture.work).toEqual({
        queries: 0, listRects: 0, listHeights: 0, sectionRects: 0,
        resizePublications: 0, mutationPublications: 0, frames: 0, commits: 0,
      });
      fixture.enableSpy(true);
      fixture.paint();
      expect(fixture.matchOracle()).toEqual(["project-2"]);
      fixture.scroll(300);
      expect(fixture.frames.size).toBe(1);
      const oldList = fixture.list();
      fixture.replaceRegion();
      expect(fixture.frames.size).toBe(0);
      expect(fixture.observers.some(({ targets }) => targets.has(oldList))).toBe(false);
      fixture.scroll(300, oldList);
      expect(fixture.frames.size).toBe(0);
      expect(fixture.matchOracle()).toEqual(["project-3"]);
      fixture.scroll(200);
      expect(fixture.frames.size).toBe(1);
      fixture.unmount();
      expect(fixture.frames.size).toBe(0);
      expect(fixture.observers.every(({ targets }) => targets.size === 0)).toBe(true);
    } finally {
      fixture.dispose();
    }
  });
});
