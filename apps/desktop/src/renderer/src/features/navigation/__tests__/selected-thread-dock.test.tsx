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
    <div class="directory-groups" style="overflow-y: auto">
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
  // PwrAgent's header has scrolled away with its rows.
  place(region.querySelector("[data-header='pwragent']")!, rowTop - 200, 30);
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

function renderDock(
  region: HTMLDivElement,
  threadKey: string | undefined = "open",
  holders: { ancestorThreadKeys?: string[]; directoryKeys?: string[] } = {},
) {
  revealHidden = vi.fn<() => void>();
  const regionRef = createRef<HTMLDivElement>();
  regionRef.current = region;
  const host = document.createElement("div");
  region.append(host);
  return render(
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
    />,
    { container: host },
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

  it("docks at the top, under the stuck project header, when the row left upward", () => {
    renderDock(mountList(-300));
    expect(dock()?.dataset.edge).toBe("top");
    // The stuck header is 30px tall; the region starts at the lane's top.
    expect(dock()?.style.getPropertyValue("--selected-thread-dock-top")).toBe("30px");
  });

  it("docks at the bottom when the row is further down", () => {
    renderDock(mountList(900));
    expect(dock()?.dataset.edge).toBe("bottom");
    expect(dock()?.style.getPropertyValue("--selected-thread-dock-bottom")).toBe("0px");
  });

  it("names the thread and the project its row sits under", () => {
    renderDock(mountList(900));
    expect(dock()?.getAttribute("aria-label")).toBe(
      "Scroll to selected thread: Investigate the wake flake, in Project pwragent",
    );
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

    it("rests at the bottom and points nowhere while what holds it is in view", () => {
      // The parent's row is in view at y=300, collapsed over the thread.
      renderDock(mountList(900, { hidden: true }), "open", { ancestorThreadKeys: ["other"] });
      expect(dock()?.dataset.edge).toBe("bottom");
      expect(dock()?.querySelector(".selected-thread-dock__direction")).toBeNull();
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
