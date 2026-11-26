import { act, render } from "@testing-library/react";
import fc from "fast-check";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildThreadIdentityKey,
  type NavigationDirectorySummary,
  type NavigationQueryPage,
  type NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import { FixtureDirectoriesList } from "../../../test/navigation-presentation-fixture";
import { DirectoriesList } from "../DirectoriesList";
import { ProjectIndex, type ProjectIndexEntry } from "../ProjectIndex";
import { RecentsList } from "../RecentsList";
import { SelectedThreadDock } from "../SelectedThreadDock";
import { Sidebar } from "../Sidebar";
import { buildLargeDirectoryFixture } from "./fixtures/directory-performance";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";
import { createNavigationPageState } from "../../../lib/navigation-query-state";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";

const noop = () => {};
const asyncNoop = async () => {};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

class ControlledResizeObserver implements ResizeObserver {
  static instances: ControlledResizeObserver[] = [];
  readonly targets = new Set<Element>();
  observeCalls = 0;

  constructor(private readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
    this.observeCalls += 1;
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }

  deliver(
    entries: Array<{ target: Element; inlineSize: number; blockSize: number }>,
  ): void {
    const matched = entries
      .filter((item) => this.targets.has(item.target))
      .map((item) => {
        const size = [{ inlineSize: item.inlineSize, blockSize: item.blockSize }];
        return {
          target: item.target,
          contentRect: new DOMRect(0, 0, item.inlineSize, item.blockSize),
          borderBoxSize: size,
          contentBoxSize: size,
          devicePixelContentBoxSize: size,
        } as unknown as ResizeObserverEntry;
      });
    if (matched.length > 0) {
      this.callback(matched, this);
    }
  }
}

describe("renderer layout and memoization bounds", () => {
  it("skips redundant --directory-row-header-height writes on width-only resizes", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 220, max: 520 }), { minLength: 2, maxLength: 6 }),
        fc.integer({ min: 24, max: 44 }),
        (widths, blockHeight) => {
          ControlledResizeObserver.instances = [];
          vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
          const fixture = buildLargeDirectoryFixture({
            directoryCount: 4,
            unpinnedThreadsPerDirectory: 1,
            directoryThreadsCollapsed: false,
          });
          const disclosure = {
            expandedByKey: Object.fromEntries(fixture.directories.map((d) => [d.key, true])),
            unpinnedExpandedByKey: {},
            setExpandedByKey: noop,
            setUnpinnedExpandedByKey: noop,
            previousSelectedItemKeyRef: { current: undefined },
            handledRevealRequestRef: { current: 0 },
          };

          let headerWrites = 0;
          const origSetProperty = CSSStyleDeclaration.prototype.setProperty;
          const setPropSpy = vi
            .spyOn(CSSStyleDeclaration.prototype, "setProperty")
            .mockImplementation(function (this: CSSStyleDeclaration, prop, val, priority) {
              if (prop === "--directory-row-header-height") headerWrites += 1;
              return origSetProperty.call(this, prop, val, priority);
            });

          const view = render(
            <FixtureDirectoriesList
              directories={fixture.directories}
              directoryDisclosure={disclosure}
              threads={fixture.threads}
              selectedItemKey={undefined}
              onOpenLaunchpad={asyncNoop}
              onOpenThreadContextMenu={noop}
              onSelectThread={noop}
            />,
          );
          try {
            const headers = [...view.container.querySelectorAll<HTMLElement>(".directory-row__header")];
            expect(headers.length).toBe(4);
            // Initial delivery writes each header height once.
            act(() => {
              for (const obs of ControlledResizeObserver.instances) {
                obs.deliver(
                  headers.map((target) => ({ target, inlineSize: widths[0]!, blockSize: blockHeight })),
                );
              }
            });
            expect(headerWrites).toBe(4);

            // Subsequent width-only resizes with unchanged blockSize write 0 times.
            headerWrites = 0;
            for (const width of widths.slice(1)) {
              act(() => {
                for (const obs of ControlledResizeObserver.instances) {
                  obs.deliver(
                    headers.map((target) => ({ target, inlineSize: width, blockSize: blockHeight })),
                  );
                }
              });
            }
            expect(headerWrites).toBe(0);

            // An actual block height change writes once per changed header.
            act(() => {
              for (const obs of ControlledResizeObserver.instances) {
                obs.deliver(
                  headers.map((target) => ({
                    target,
                    inlineSize: widths[0]!,
                    blockSize: blockHeight + 6,
                  })),
                );
              }
            });
            expect(headerWrites).toBe(4);
          } finally {
            view.unmount();
            setPropSpy.mockRestore();
          }
        },
      ),
      { numRuns: 5, examples: [[[260, 320, 420], 28]] },
    );
  });

  it("reuses SelectedThreadDock observers across selection changes without offsetHeight reflows", () => {
    ControlledResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    const fixture = buildLargeDirectoryFixture({
      directoryCount: 4,
      unpinnedThreadsPerDirectory: 2,
      directoryThreadsCollapsed: false,
    });
    const threads = fixture.threads;
    const directories = fixture.directories;
    const disclosure = {
      expandedByKey: Object.fromEntries(directories.map((d) => [d.key, true])),
      unpinnedExpandedByKey: {},
      setExpandedByKey: noop,
      setUnpinnedExpandedByKey: noop,
      previousSelectedItemKeyRef: { current: undefined as string | undefined },
      handledRevealRequestRef: { current: 0 },
    };

    const origRect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.matches(".directory-list, .sidebar__scroll-region")) {
        return new DOMRect(0, 100, 320, 360);
      }
      if (this.matches(".thread-row")) {
        // Place every row above the viewport so top dock is active.
        return new DOMRect(0, -120, 300, 40);
      }
      return origRect.call(this);
    });

    let cardOffsetHeightReads = 0;
    const origOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")?.get;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("selected-thread-dock")) {
        cardOffsetHeightReads += 1;
        return 46;
      }
      return origOffsetHeight ? (origOffsetHeight.call(this) as number) : 0;
    });

    function Harness({ index }: { index: number }) {
      const regionRef = useRef<HTMLDivElement>(null);
      const selected = threads[index * 3 + 1]!;
      const selectedKey = buildThreadIdentityKey(selected.source, selected.id);
      return (
        <div className="sidebar__scroll-region" ref={regionRef}>
          <FixtureDirectoriesList
            directories={directories}
            directoryDisclosure={disclosure}
            threads={threads}
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
            directoryKeys={[directories[index]!.key]}
            onRevealHiddenThread={noop}
          />
        </div>
      );
    }

    const view = render(<Harness index={0} />);
    try {
      const dock = view.container.querySelector<HTMLElement>(".selected-thread-dock");
      expect(dock?.dataset.edge).toBe("top");
      // Deliver card's borderBoxSize via ResizeObserver.
      act(() => {
        for (const obs of ControlledResizeObserver.instances) {
          if (dock) obs.deliver([{ target: dock, inlineSize: 280, blockSize: 50 }]);
        }
      });
      const region = view.container.querySelector<HTMLElement>(".sidebar__scroll-region")!;
      expect(region.style.getPropertyValue("--selected-thread-dock-reserve")).toBe("62px");

      const observerCountBefore = ControlledResizeObserver.instances.length;
      const observeCallsBefore = ControlledResizeObserver.instances.reduce(
        (sum, obs) => sum + obs.observeCalls,
        0,
      );
      cardOffsetHeightReads = 0;

      // Switch selection across directories: observer is reused (no dispose/recreate).
      for (const idx of [1, 2, 3, 0]) {
        act(() => view.rerender(<Harness index={idx} />));
      }
      expect(ControlledResizeObserver.instances.length).toBe(observerCountBefore);
      expect(
        ControlledResizeObserver.instances.reduce((sum, obs) => sum + obs.observeCalls, 0),
      ).toBe(observeCallsBefore);
      expect(cardOffsetHeightReads).toBe(0);
    } finally {
      view.unmount();
    }
  });

  it("retains ProjectIndex bounds on initial ResizeObserver delivery and ignores height-only nav resizes", () => {
    ControlledResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    const projects: ProjectIndexEntry[] = Array.from({ length: 8 }, (_, i) => ({
      key: `dir-${i}`,
      label: `Project ${i}`,
      containsSelection: i === 0,
      active: false,
      review: false,
    }));

    let sectionRectReads = 0;
    let navStyleReads = 0;
    const origRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("directory-list")) return new DOMRect(0, 50, 320, 120);
      const key = this.dataset["directoryKey"];
      if (key) {
        sectionRectReads += 1;
        const idx = Number(key.replace("dir-", ""));
        return new DOMRect(0, 50 + idx * 100, 320, 100);
      }
      if (this.tagName === "NAV") return new DOMRect(0, 50, 120, 400);
      return origRect.call(this);
    });
    const origClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!.get!;
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
      if (this.classList.contains("directory-list")) return 120;
      return origClientHeight.call(this) as number;
    });
    const origComputed = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      if (el instanceof HTMLElement && el.tagName === "NAV") navStyleReads += 1;
      return origComputed(el, pseudo);
    });

    function Harness() {
      const regionRef = useRef<HTMLDivElement>(null);
      return (
        <div className="sidebar-body">
          <div className="sidebar-columns">
            <ProjectIndex
              projects={projects}
              scrollRegionRef={regionRef}
              scrollRegionId="idx-region"
              spy
              width={null}
              onJump={noop}
              onWidthChange={noop}
            />
            <div id="idx-region" className="sidebar__scroll-region" ref={regionRef}>
              <div className="directory-list">
                {projects.map((p) => (
                  <section key={p.key} className="directory-row" data-directory-key={p.key} />
                ))}
              </div>
            </div>
          </div>
        </div>
      );
    }

    const view = render(<Harness />);
    try {
      const list = view.container.querySelector<HTMLElement>(".directory-list")!;
      const sections = [...list.querySelectorAll<HTMLElement>("section.directory-row")];
      const nav = view.container.querySelector<HTMLElement>("nav")!;
      const sidebarBody = view.container.querySelector<HTMLElement>(".sidebar-body")!;

      // Initial ResizeObserver delivery with matching heights retains the
      // already-measured visible sections (dir-0, dir-1) instead of wiping
      // the whole cache from index 0 (only an unprobed binary-search gap
      // between dir-1 and dir-3 can trigger at most 1 follow-up read).
      sectionRectReads = 0;
      act(() => {
        for (const obs of ControlledResizeObserver.instances) {
          obs.deliver([
            { target: list, inlineSize: 320, blockSize: 120 },
            ...sections.map((target) => ({ target, inlineSize: 320, blockSize: 100 })),
            { target: nav, inlineSize: 120, blockSize: 400 },
            { target: sidebarBody, inlineSize: 440, blockSize: 400 },
          ]);
        }
      });
      expect(sectionRectReads).toBeLessThanOrEqual(1);

      // Subsequent width-only resizes trigger 0 section rect reads.
      sectionRectReads = 0;
      act(() => {
        for (const obs of ControlledResizeObserver.instances) {
          obs.deliver([
            { target: list, inlineSize: 360, blockSize: 120 },
            ...sections.map((target) => ({ target, inlineSize: 360, blockSize: 100 })),
          ]);
        }
      });
      expect(sectionRectReads).toBe(0);

      // Height-only resizes of nav and sidebar body trigger 0 getComputedStyle(nav) reads.
      navStyleReads = 0;
      for (const nextHeight of [360, 520, 440]) {
        act(() => {
          for (const obs of ControlledResizeObserver.instances) {
            obs.deliver([
              { target: nav, inlineSize: 120, blockSize: nextHeight },
              { target: sidebarBody, inlineSize: 440, blockSize: nextHeight },
            ]);
          }
        });
      }
      expect(navStyleReads).toBe(0);

      // Changing a section below the cached visible prefix triggers 0 section rect reads.
      sectionRectReads = 0;
      act(() => {
        for (const obs of ControlledResizeObserver.instances) {
          obs.deliver([{ target: sections[7]!, inlineSize: 320, blockSize: 180 }]);
        }
      });
      expect(sectionRectReads).toBe(0);
    } finally {
      view.unmount();
    }
  });

  it("avoids re-rendering DirectoriesList and RecentsList on unrelated Sidebar ticks", () => {
    const fixture = buildLargeDirectoryFixture({
      directoryCount: 3,
      unpinnedThreadsPerDirectory: 2,
      directoryThreadsCollapsed: false,
    });
    const directories: NavigationDirectorySummary[] = fixture.directories;
    const threads: NavigationThreadSummary[] = fixture.threads;
    const selectedItemKey = buildThreadIdentityKey(threads[0]!.source, threads[0]!.id);
    const backends: BackendSummary[] = [
      {
        backend: "codex",
        label: "Codex",
        available: true,
        status: "ready",
        capabilities: { streaming: true },
      } as unknown as BackendSummary,
    ];
    const disclosure = {
      expandedByKey: Object.fromEntries(directories.map((d) => [d.key, true])),
      unpinnedExpandedByKey: {},
      setExpandedByKey: noop,
      setUnpinnedExpandedByKey: noop,
      previousSelectedItemKeyRef: { current: selectedItemKey },
      handledRevealRequestRef: { current: 0 },
    };
    const selectedDirKeys = [directories[0]!.key];
    const makePage = (entries: NavigationThreadSummary[]): NavigationQueryPage => ({
      protocol: 2,
      revision: "r1",
      inventory: "owner",
      coverage: { state: "complete" },
      counts: { total: entries.length, active: 0, review: 0 },
      entries: entries.map((t) => ({
        row: {
          ...t,
          ref: { backend: t.source, threadId: t.id },
        },
        placement: { kind: "root" as const },
      })),
      directories,
    } as unknown as NavigationQueryPage);
    const resources = new Map<string, NavigationWindowResource>();
    const lensRequest = {
      protocol: 2 as const,
      inventory: "owner" as const,
      consumer: "main-sidebar" as const,
      query: { kind: "lens" as const, lens: "recents" as const, roots: "unpinned" as const },
      pageSize: 50,
    };
    resources.set("lens", {
      id: "lens",
      loading: false,
      restoredFromCache: false,
      state: { ...createNavigationPageState(lensRequest), page: makePage(threads) },
    });
    const pagedNav = {
      resources,
      presentationReady: true,
      directories: directories as unknown as NonNullable<Parameters<typeof Sidebar>[0]["pagedNavigation"]>["directories"],
      selectedDirectoryKeys: undefined,
      connected: true,
      invalidate: noop,
      refresh: asyncNoop,
      loadMore: asyncNoop,
      rebaseline: asyncNoop,
      restart: asyncNoop,
      setVisibleAnchor: noop,
    };

    let dirRenders = 0;
    let recentsRenders = 0;
    const dirMemo = DirectoriesList as unknown as { type: (...args: unknown[]) => unknown };
    const dirOrig = dirMemo.type;
    vi.spyOn(dirMemo, "type").mockImplementation(function (this: unknown, ...args: unknown[]) {
      dirRenders += 1;
      return dirOrig.apply(this, args);
    });
    const recentsMemo = RecentsList as unknown as { type: (...args: unknown[]) => unknown };
    const recentsOrig = recentsMemo.type;
    vi.spyOn(recentsMemo, "type").mockImplementation(function (this: unknown, ...args: unknown[]) {
      recentsRenders += 1;
      return recentsOrig.apply(this, args);
    });

    const renderSidebar = (browseMode: "directories" | "recents", settingsActive: boolean) => (
      <Sidebar
        backends={backends}
        browseMode={browseMode}
        directories={directories}
        directoryDisclosure={disclosure}
        loaded
        loading={false}
        pagedNavigation={pagedNav}
        pinnedThreadsOnTop
        projectIndexHidden={false}
        projectIndexWidth={null}
        selectedItemKey={selectedItemKey}
        selectedThreadDirectoryKeys={selectedDirKeys}
        settingsActive={settingsActive}
        threads={threads}
        onBrowseModeChange={noop}
        onCreateThread={asyncNoop}
        onOpenLaunchpad={asyncNoop}
        onProjectIndexHiddenChange={noop}
        onProjectIndexWidthChange={noop}
        onSelectThread={noop}
      />
    );

    const view = render(renderSidebar("directories", false));
    try {
      dirRenders = 0;
      act(() => view.rerender(renderSidebar("directories", true)));
      act(() => view.rerender(renderSidebar("directories", false)));
      expect(dirRenders).toBe(0);

      act(() => view.rerender(renderSidebar("recents", false)));
      recentsRenders = 0;
      act(() => view.rerender(renderSidebar("recents", true)));
      act(() => view.rerender(renderSidebar("recents", false)));
      expect(recentsRenders).toBe(0);
    } finally {
      view.unmount();
    }
  });
});
