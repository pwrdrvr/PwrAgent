import { act, cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { SelectedThreadDock } from "../SelectedThreadDock";

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
});

afterEach(() => {
  cleanup();
  // End the centering a click started, so the next test starts clean.
  document.querySelector(".directory-groups")?.dispatchEvent(new Event("scrollend"));
  document.body.innerHTML = "";
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function place(element: Element, top: number, height: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0, y: top, top, bottom: top + height, left: 0, right: 300, width: 300, height,
    toJSON: () => ({}),
  } as DOMRect);
}

const THREAD = {
  id: "open",
  title: "Investigate the wake flake",
  updatedAt: Date.now(),
  linkedDirectories: [{ id: "d", kind: "local", label: "FromThread", path: "/repo" }],
} as unknown as NavigationThreadSummary;

/*
 * The region sits at y=100 and is 400px tall. The lane inside it is what
 * scrolls. It holds two projects: PwrGit, whose header is stuck to the top
 * (30px), and PwrAgent, which holds the open thread's row.
 */
function mountList(
  rowTop: number,
  options?: { duplicateTop?: number; hidden?: boolean },
): HTMLDivElement {
  const region = document.createElement("div");
  region.className = "sidebar__scroll-region";
  region.style.overflow = "hidden";
  region.innerHTML = `
    <div class="directory-groups sidebar-list--dense" style="overflow-y: auto">
      <section class="directory-row" data-directory-key="pwrgit">
        <div class="directory-row__header" data-header="pwrgit"></div>
        ${options?.duplicateTop === undefined ? "" : `
        <div class="thread-row-shell" data-thread-key="open" data-thread-directory-key="pwrgit">
          <div class="thread-row is-selected" data-row="duplicate"><button class="thread-row__open"></button></div>
        </div>`}
      </section>
      <section class="directory-row" data-directory-key="pwragent">
        <div class="directory-row__header" data-header="pwragent"></div>
        <div class="thread-row-shell" data-thread-key="other" data-thread-directory-key="pwragent">
          <div class="thread-row is-selected" data-row="batch"></div>
        </div>
        <div class="thread-row-shell" data-thread-key="open" data-thread-directory-key="pwragent">
          <div class="thread-row is-selected" data-row="open"><button class="thread-row__open"></button></div>
        </div>
      </section>
    </div>`;
  document.body.append(region);
  place(region, 100, 400);
  place(region.querySelector(".directory-groups")!, 100, 400);
  place(region.querySelector("[data-header='pwrgit']")!, 100, 30);
  // The next project's header follows the stuck project's in document order.
  place(region.querySelector("[data-header='pwragent']")!, 150, 30);
  place(region.querySelector("[data-row='batch']")!, 300, 60);
  place(region.querySelector("[data-row='open']")!, rowTop, 60);
  // The PwrAgent section: its header, then rows down to the open thread's.
  place(region.querySelector("[data-directory-key='pwragent']")!, rowTop - 200, 260);
  if (options?.hidden) {
    // The row is not in the list: its parent is collapsed, say.
    region.querySelector("[data-row='open']")!.parentElement!.remove();
  }
  if (options?.duplicateTop !== undefined) {
    place(region.querySelector("[data-row='duplicate']")!, options.duplicateTop, 60);
  }
  return region;
}

let revealHidden: ReturnType<typeof vi.fn<() => void>>;

type Holders = { ancestorThreadKeys?: string[]; directoryKeys?: string[] };

function closeProject(region: HTMLElement, key: string): void {
  region.querySelector(`[data-header='${key}']`)!.insertAdjacentHTML(
    "beforeend",
    `<button class="directory-row__summary" aria-expanded="false"></button>`,
  );
}

function renderDock(
  region: HTMLDivElement,
  threadKey: string | undefined = "open",
  holders: Holders = {},
) {
  revealHidden = vi.fn<() => void>();
  const host = document.createElement("div");
  region.append(host);
  return render(dockElement(region, threadKey, holders), { container: host });
}

function dockElement(region: HTMLDivElement, threadKey: string | undefined, holders: Holders) {
  const regionRef = createRef<HTMLDivElement>();
  regionRef.current = region;
  return (
    <SelectedThreadDock
      regionRef={regionRef}
      thread={threadKey ? THREAD : undefined}
      threadKey={threadKey}
      status="unread"
      remoteWork={false}
      projectLabel={(directoryKey) => (directoryKey ? `Project ${directoryKey}` : undefined)}
      ancestorThreadKeys={holders.ancestorThreadKeys ?? []}
      directoryKeys={holders.directoryKeys ?? []}
      onRevealHiddenThread={revealHidden}
    />
  );
}

function dock(): HTMLElement | null {
  return screen.queryByTestId("selected-thread-dock");
}

describe("SelectedThreadDock", () => {
  it("shows nothing while the open thread's row is in view", () => {
    renderDock(mountList(250));
    expect(dock()).toBeNull();
  });

  it("docks at the list's top edge, above the stuck project header, when the row left upward", () => {
    const region = mountList(-300);
    renderDock(region);
    expect(dock()?.dataset.edge).toBe("top");
    // At the list's own edge, whatever is stuck there: a header or divider
    // arriving or leaving under it cannot move it.
    expect(dock()?.style.getPropertyValue("--selected-thread-dock-top")).toBe("0px");
    // The stuck headers move down by the card plus its plate.
    expect(region.style.getPropertyValue("--selected-thread-dock-reserve")).toBe("58px");
    expect(region.classList.contains("has-selected-thread-dock-top")).toBe(true);
    expect(region.querySelector(".selected-thread-dock-band")).not.toBeNull();
  });

  it("gives the headers their place back when it leaves the top", () => {
    const region = mountList(-300);
    const view = renderDock(region);
    place(region.querySelector("[data-row='open']")!, 900, 60);
    view.rerender(dockElement(region, "open", {}));
    expect(dock()?.dataset.edge).toBe("bottom");
    expect(region.classList.contains("has-selected-thread-dock-top")).toBe(false);
    expect(region.querySelector(".selected-thread-dock-band")).toBeNull();
    view.unmount();
    expect(region.classList.contains("has-selected-thread-dock-top")).toBe(false);
    expect(region.style.getPropertyValue("--selected-thread-dock-reserve")).toBe("");
  });

  // A project-index jump lands its project under the dock, and the jump can
  // itself bring the dock or send it off. The list re-lands on this event.
  it("announces each change in what the headers stick under, and only those", () => {
    const region = mountList(250);
    const changes: string[] = [];
    region.addEventListener("selected-thread-dock-reserve-change", () => {
      changes.push(region.classList.contains("has-selected-thread-dock-top")
        ? region.style.getPropertyValue("--selected-thread-dock-reserve")
        : "none");
    });
    const view = renderDock(region);
    expect(changes).toEqual([]);
    // The row leaves through the top: the dock arrives there.
    place(region.querySelector("[data-row='open']")!, -300, 60);
    view.rerender(dockElement(region, "open", {}));
    view.rerender(dockElement(region, "open", {}));
    expect(changes).toEqual(["58px"]);
    // Off the bottom instead: the headers have their place back.
    place(region.querySelector("[data-row='open']")!, 900, 60);
    view.rerender(dockElement(region, "open", {}));
    expect(changes).toEqual(["58px", "none"]);
    place(region.querySelector("[data-row='open']")!, -300, 60);
    view.rerender(dockElement(region, "open", {}));
    expect(changes).toEqual(["58px", "none", "58px"]);
    // Gone with the selection.
    view.unmount();
    expect(changes).toEqual(["58px", "none", "58px", "none"]);
  });

  it("keeps the reserve equal to the dock's outer height plus its plate when padding changes", () => {
    const observed = new Map<Element, ResizeObserverBoxOptions>();
    let resize!: () => void;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe(element: Element, options?: ResizeObserverOptions) {
        observed.set(element, options?.box ?? "content-box");
      }
      unobserve(element: Element) {
        observed.delete(element);
      }
      disconnect() {
        observed.clear();
      }
    });
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
    const region = mountList(-300);
    renderDock(region);
    const card = dock()!;
    let height = 46;
    Object.defineProperty(card, "offsetHeight", { get: () => height });
    // The content box stays the same. Chromium delivers a resize only to
    // observers of the outer box when the padding or border changes.
    for (height of [74, 60, 46]) {
      if (observed.get(card) === "border-box") resize();
      act(() => frames.splice(0).forEach((frame) => frame(0)));
      act(() => resize());
      expect(region.style.getPropertyValue("--selected-thread-dock-reserve")).toBe(`${height + 12}px`);
    }
  });

  // Showing the top dock moves the stuck header down, which covers more of
  // the row. The rule reads the list as it lies without the dock, so the
  // dock shows exactly when the row is lost under the header's own place:
  // it neither alternates with the header nor outstays the row's return.
  it("shows exactly when the row is lost under the header's own place, from either state", () => {
    const shown = (rowTop: number): number => Math.max(0, rowTop + 60 - Math.max(rowTop, 130));
    for (const start of [60, 250]) {
      for (const rowTop of [60, 99, 100, 108, 109, 110, 129, 130, 260]) {
        const region = mountList(start);
        const header = region.querySelector<HTMLElement>("[data-header='pwrgit']")!;
        // The header sticks to the list's top, as far down as the reserve says.
        vi.spyOn(header, "getBoundingClientRect").mockImplementation(() => {
          const top = 100 + (region.classList.contains("has-selected-thread-dock-top") ? 58 : 0);
          return { x: 0, y: top, top, bottom: top + 30, left: 0, right: 300, width: 300, height: 30, toJSON: () => ({}) } as DOMRect;
        });
        // Docked at the top (60) or not docked (250), then the row moves.
        const view = renderDock(region);
        place(region.querySelector("[data-row='open']")!, rowTop, 60);
        const seen: (string | undefined)[] = [];
        for (let pass = 0; pass < 4; pass += 1) {
          view.rerender(dockElement(region, "open", {}));
          seen.push(dock()?.dataset.edge);
        }
        const expected = shown(rowTop) >= 39 ? undefined : "top";
        expect(seen, `from ${start}, row at ${rowTop}`).toEqual([expected, expected, expected, expected]);
        expect(region.classList.contains("has-selected-thread-dock-top")).toBe(expected === "top");
        view.unmount();
        region.remove();
      }
    }
  });

  it("docks at the bottom when the row is further down", () => {
    renderDock(mountList(900));
    expect(dock()?.dataset.edge).toBe("bottom");
    expect(dock()?.style.getPropertyValue("--selected-thread-dock-bottom")).toBe("0px");
  });

  it("names the thread and the project its row sits under", () => {
    renderDock(mountList(900));
    // Its text is its name. An `aria-label` that left the time or project out
    // failed axe's label-content-name-mismatch in the a11y E2E.
    expect(dock()?.hasAttribute("aria-label")).toBe(false);
    expect(dock()?.querySelector(".thread-row__title")?.textContent).toBe("Investigate the wake flake");
    expect(dock()?.querySelector(".selected-thread-dock__project")?.textContent).toBe("Project pwragent");
  });

  it("ignores another selected row: a batch selection is not the open thread", () => {
    // The batch-selected row is in view at y=300; the open thread's is not.
    renderDock(mountList(900));
    expect(dock()).not.toBeNull();
  });

  it("stays away while any row of a thread in two projects is in view", () => {
    renderDock(mountList(900, { duplicateTop: 200 }));
    expect(dock()).toBeNull();
  });

  it("stands in for the nearer row of a thread in two projects", () => {
    // 120px above the band's top against 400px below its bottom.
    renderDock(mountList(840, { duplicateTop: 10 }));
    expect(dock()?.dataset.edge).toBe("top");
    expect(dock()?.querySelector(".selected-thread-dock__project")?.textContent).toBe("Project pwrgit");
  });

  it("follows the list as it scrolls", () => {
    const region = mountList(250);
    renderDock(region);
    expect(dock()).toBeNull();
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
    place(region.querySelector("[data-row='open']")!, -300, 60);
    // Scroll events do not bubble: the lane scrolls, the region listens.
    region.querySelector(".directory-groups")!.dispatchEvent(new Event("scroll"));
    act(() => frames.splice(0).forEach((frame) => frame(0)));
    expect(dock()?.dataset.edge).toBe("top");
  });

  it("centers its row and hands it focus on click", () => {
    const region = mountList(900);
    renderDock(region);
    const row = region.querySelector<HTMLElement>("[data-row='open']")!;
    act(() => dock()!.click());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(row);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center", inline: "nearest" });
    expect(document.activeElement).toBe(row.querySelector(".thread-row__open"));
  });

  it("does not ask for a reveal when it has a row to scroll to", () => {
    renderDock(mountList(900));
    act(() => dock()!.click());
    expect(revealHidden).not.toHaveBeenCalled();
  });

  describe("for a thread with no row in the list", () => {
    it("stands in for its nearest parent's row, at the edge that row is past", () => {
      // The parent's row ("other") sits at y=300 by default; move it out above.
      const region = mountList(900, { hidden: true });
      place(region.querySelector("[data-row='batch']")!, -400, 60);
      renderDock(region, "open", { ancestorThreadKeys: ["missing", "other"], directoryKeys: ["pwragent"] });
      expect(dock()?.dataset.edge).toBe("top");
      expect(dock()?.querySelector(".selected-thread-dock__direction")).not.toBeNull();
      expect(dock()?.querySelector(".selected-thread-dock__project")?.textContent).toBe("Project pwragent");
    });

    it("stays away while the parent that holds it is in view", () => {
      // The parent's row is in view at y=300, collapsed over the thread.
      renderDock(mountList(900, { hidden: true }), "open", { ancestorThreadKeys: ["other"] });
      expect(dock()).toBeNull();
    });

    it("stays away while its closed project is in view, even stuck to the top", () => {
      // A closed project is one header tall. Stuck at the list's top, the
      // header must not count as covering its own section: the dock once
      // sat at the top over the next projects' headers.
      const region = mountList(900, { hidden: true });
      place(region.querySelector("[data-header='pwrgit']")!, -200, 30);
      place(region.querySelector("[data-header='pwragent']")!, 100, 30);
      place(region.querySelector("[data-directory-key='pwragent']")!, 100, 30);
      closeProject(region, "pwragent");
      renderDock(region, "open", { directoryKeys: ["pwragent"] });
      expect(dock()).toBeNull();
    });

    it("docks without an arrow while its open project is in view with no row for it", () => {
      // The row is past the loaded page, or under a collapsed Directory
      // threads divider. An open project's header is not drawn selected.
      const region = mountList(900, { hidden: true });
      place(region.querySelector("[data-directory-key='pwragent']")!, 200, 260);
      renderDock(region, "open", { directoryKeys: ["pwragent"] });
      expect(dock()?.dataset.edge).toBe("bottom");
      expect(dock()?.querySelector(".selected-thread-dock__direction")).toBeNull();
    });

    it("stays away while any closed project of a thread in two is in view", () => {
      // PwrAgent, listed first, is far below. PwrGit is closed at the top.
      const region = mountList(900, { hidden: true });
      place(region.querySelector("[data-directory-key='pwrgit']")!, 100, 30);
      closeProject(region, "pwrgit");
      renderDock(region, "open", { directoryKeys: ["pwragent", "pwrgit"] });
      expect(dock()).toBeNull();
    });

    it.each([false, true])("focuses a visible row after a keyboard reveal (offscreen alias: %s)", (alias) => {
      const region = mountList(900, { hidden: true });
      const view = renderDock(region, "open", { directoryKeys: ["pwragent"] });
      dock()!.focus();
      act(() => dock()!.click());
      if (alias) {
        region.querySelector("[data-directory-key='pwrgit']")!.insertAdjacentHTML(
          "beforeend",
          `<div class="thread-row-shell" data-thread-key="open">
            <div class="thread-row" data-row="alias"><button class="thread-row__open"></button></div>
          </div>`,
        );
        place(region.querySelector("[data-row='alias']")!, -150, 60);
      }
      region.querySelector("[data-directory-key='pwragent']")!.insertAdjacentHTML(
        "beforeend",
        `<div class="thread-row-shell" data-thread-key="open" data-thread-directory-key="pwragent">
          <div class="thread-row is-selected" data-row="open"><button class="thread-row__open"></button></div>
        </div>`,
      );
      place(region.querySelector("[data-row='open']")!, 300, 60);
      view.rerender(dockElement(region, "open", { directoryKeys: ["pwragent"] }));
      expect(dock()).toBeNull();
      expect(document.activeElement).toBe(region.querySelector("[data-row='open'] .thread-row__open"));
    });

    it("ignores a row kept mounted at no height", () => {
      const region = mountList(900);
      place(region.querySelector("[data-row='open']")!, 300, 0);
      renderDock(region);
      expect(dock()?.querySelector(".selected-thread-dock__direction")).toBeNull();
    });

    it("sits above the stuck header of the project being read when its own has scrolled past", () => {
      const region = mountList(900, { hidden: true });
      place(region.querySelector("[data-header='pwragent']")!, -300, 30);
      place(region.querySelector("[data-directory-key='pwragent']")!, -300, 30);
      renderDock(region, "open", { directoryKeys: ["pwragent"] });
      expect(dock()?.dataset.edge).toBe("top");
      // Above PwrGit's header, which is stuck at the top.
      expect(dock()?.style.getPropertyValue("--selected-thread-dock-top")).toBe("0px");
    });

    it("stands in for its project when no parent has a row", () => {
      // The PwrAgent section spans y=700..960, below the list's bottom at 500.
      renderDock(mountList(900, { hidden: true }), "open", { directoryKeys: ["pwragent"] });
      expect(dock()?.dataset.edge).toBe("bottom");
      expect(dock()?.querySelector(".selected-thread-dock__direction")).not.toBeNull();
      expect(dock()?.querySelector(".selected-thread-dock__project")?.textContent).toBe("Project pwragent");
    });

    it("still docks when the lens lists nothing that holds it", () => {
      renderDock(mountList(900, { hidden: true }));
      expect(dock()?.dataset.edge).toBe("bottom");
      expect(dock()?.querySelector(".selected-thread-dock__direction")).toBeNull();
    });

    it("asks for the thread to be revealed on click", () => {
      renderDock(mountList(900, { hidden: true }), "open", { directoryKeys: ["pwragent"] });
      act(() => dock()!.click());
      expect(revealHidden).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it("shows nothing while the sidebar is hidden", () => {
      const region = mountList(900, { hidden: true });
      place(region.querySelector(".directory-groups")!, 0, 0);
      renderDock(region);
      expect(dock()).toBeNull();
    });
  });

  it("gets out of the way of a drag", () => {
    const region = mountList(900);
    region.querySelector("[data-row='batch']")!.classList.add("is-pointer-dragging");
    renderDock(region);
    expect(dock()).toBeNull();
  });

  it("shows nothing with no thread open", () => {
    renderDock(mountList(900), "");
    expect(dock()).toBeNull();
  });
});
