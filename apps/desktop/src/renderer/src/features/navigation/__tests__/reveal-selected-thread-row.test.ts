import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revealSelectedSidebarThreadRow, revealThreadRowAtNearestEdge } from "../reveal-selected-thread-row";

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
let scroll: ReturnType<typeof vi.fn>;
let scrollBy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
});

afterEach(() => {
  // End any centering a test started, so the next test starts clean.
  document.querySelector(".directory-groups")?.dispatchEvent(new Event("scrollend"));
  document.body.innerHTML = "";
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

function place(element: Element, top: number, height: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0, y: top, top, bottom: top + height, left: 0, right: 300, width: 300, height,
    toJSON: () => ({}),
  } as DOMRect);
}

// The lane scrolls from y=100 to y=500 in the window. The selected row's
// directory header is stuck to the top of it, 30px tall.
function mountSidebar(rowTop: number, rowHeight = 60, section = "directory-row"): void {
  document.body.innerHTML = `
    <aside class="sidebar">
      <div class="sidebar__scroll-region" style="overflow: hidden">
        <div class="directory-groups" style="overflow-y: auto">
          <section class="${section}">
            <div class="directory-row__header"></div>
            <div class="thread-row-shell"><div class="thread-row is-selected"></div></div>
          </section>
        </div>
      </div>
    </aside>`;
  place(document.querySelector(".directory-groups")!, 100, 400);
  place(document.querySelector(".directory-row__header")!, 100, 30);
  place(document.querySelector(".thread-row.is-selected")!, rowTop, rowHeight);
  // The lane scrolls. The region around it only clips, so scrolling it
  // would move nothing.
  const lane = document.querySelector<HTMLElement>(".directory-groups")!;
  scrollBy = vi.fn();
  lane.scrollBy = scrollBy as typeof lane.scrollBy;
  const region = document.querySelector<HTMLElement>(".sidebar__scroll-region")!;
  region.scrollBy = vi.fn(() => {
    throw new Error("The region clips the lane; it does not scroll.");
  }) as typeof region.scrollBy;
}

function selectedRow(): HTMLElement {
  return document.querySelector<HTMLElement>(".thread-row.is-selected")!;
}

function endScroll(): void {
  document.querySelector(".directory-groups")!.dispatchEvent(new Event("scrollend"));
}

describe("revealSelectedSidebarThreadRow", () => {
  it("leaves a row that is already in full view where it is", () => {
    mountSidebar(360);

    revealSelectedSidebarThreadRow();
    revealSelectedSidebarThreadRow();

    expect(scroll).not.toHaveBeenCalled();
  });

  it("centers a row below the fold with a smooth scroll", () => {
    mountSidebar(470);

    revealSelectedSidebarThreadRow();

    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "center", inline: "nearest" });
  });

  it("centers a row hidden under its sticky directory header", () => {
    mountSidebar(110);

    revealSelectedSidebarThreadRow();

    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("leaves a row flush with an edge where it is, despite subpixel offsets", () => {
    mountSidebar(129.6, 370.8);

    revealSelectedSidebarThreadRow();

    expect(scroll).not.toHaveBeenCalled();
  });

  it("leaves a row taller than the list where it is when it covers the view", () => {
    mountSidebar(40, 600);

    revealSelectedSidebarThreadRow();

    expect(scroll).not.toHaveBeenCalled();
  });

  it("centers a row hidden under the Pinned group's sticky header", () => {
    mountSidebar(110, 60, "pinned-group");

    revealSelectedSidebarThreadRow();

    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("still scrolls while the sidebar is hidden and measures zero", () => {
    mountSidebar(0, 0);
    place(document.querySelector(".directory-groups")!, 0, 0);

    revealSelectedSidebarThreadRow({ instant: true });

    expect(scroll).toHaveBeenCalledWith({ behavior: "auto", block: "center", inline: "nearest" });
  });
});

describe("revealThreadRowAtNearestEdge", () => {
  it("leaves a row that is already in full view where it is", () => {
    mountSidebar(360);

    revealThreadRowAtNearestEdge(selectedRow());

    expect(scrollBy).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();
  });

  it("brings a row from above to just below the sticky header", () => {
    mountSidebar(20);

    revealThreadRowAtNearestEdge(selectedRow());

    // Row top 20 lands at 130: the list top plus the 30px header.
    expect(scrollBy).toHaveBeenCalledWith({ top: -110, behavior: "auto" });
  });

  it("brings a row from below to the bottom edge", () => {
    mountSidebar(470);

    revealThreadRowAtNearestEdge(selectedRow());

    expect(scrollBy).toHaveBeenCalledWith({ top: 30, behavior: "auto" });
  });

  it("keeps the top of a row taller than the list in view", () => {
    mountSidebar(450, 600);

    revealThreadRowAtNearestEdge(selectedRow());

    expect(scrollBy).toHaveBeenCalledWith({ top: 320, behavior: "auto" });
  });

  it("waits for a running centering to end before moving the row", () => {
    mountSidebar(600);
    revealSelectedSidebarThreadRow();

    revealThreadRowAtNearestEdge(selectedRow());
    expect(scrollBy).not.toHaveBeenCalled();

    endScroll();
    revealThreadRowAtNearestEdge(selectedRow());
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });

  it("does not wait on an instant reveal", () => {
    mountSidebar(600);
    revealSelectedSidebarThreadRow({ instant: true });

    revealThreadRowAtNearestEdge(selectedRow());

    expect(scrollBy).toHaveBeenCalledTimes(1);
  });

  it("falls back to scrollIntoView while the sidebar is hidden", () => {
    mountSidebar(0, 0);
    place(document.querySelector(".directory-groups")!, 0, 0);

    revealThreadRowAtNearestEdge(selectedRow());

    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  });
});

// A project's Directory threads divider sticks under its header, so the
// header and divider together cover the project's unpinned rows: 30px of
// header at y=100, then 24px of divider. Pinned rows come before the divider
// in the list, so it never covers them.
function mountDirectoryThreads(
  rowTop: number,
  options: { pinned?: boolean; dividerTop?: number } = {},
): void {
  const row = `<div class="thread-row-shell"><div class="thread-row is-selected"></div></div>`;
  const filler = `<div class="thread-row-shell"><div class="thread-row"></div></div>`;
  document.body.innerHTML = `
    <aside class="sidebar">
      <div class="sidebar__scroll-region" style="overflow: hidden">
        <div class="directory-groups" style="overflow-y: auto">
          <section class="directory-row">
            <div class="directory-row__header"></div>
            <div class="directory-row__details">
              <div class="sidebar-list directory-row__threads" role="list">
                ${options.pinned ? row : filler}
                <div class="directory-row__threads-slot" role="listitem">
                  <button class="recents-pinned-divider directory-row__thread-divider"></button>
                </div>
                ${options.pinned ? filler : row}
              </div>
            </div>
          </section>
        </div>
      </div>
    </aside>`;
  place(document.querySelector(".directory-groups")!, 100, 400);
  place(document.querySelector(".directory-row__header")!, 100, 30);
  place(document.querySelector(".directory-row__thread-divider")!, options.dividerTop ?? 130, 24);
  place(document.querySelector(".thread-row.is-selected")!, rowTop, 60);
  const lane = document.querySelector<HTMLElement>(".directory-groups")!;
  scrollBy = vi.fn();
  lane.scrollBy = scrollBy as typeof lane.scrollBy;
}

describe("the sticky Directory threads divider", () => {
  it("centers an unpinned row hidden under the stuck divider", () => {
    // Below the header's bottom (130), so the header alone does not cover
    // it, but its top 14px are under the divider.
    mountDirectoryThreads(140);

    revealSelectedSidebarThreadRow();

    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: "center" }));
  });

  it("brings an unpinned row from above to just below the stuck divider", () => {
    mountDirectoryThreads(50);

    revealThreadRowAtNearestEdge(selectedRow());

    // 50 - (100 + 30 header + 24 divider).
    expect(scrollBy).toHaveBeenCalledWith({ top: -104, behavior: "auto" });
  });

  it("leaves a pinned row above the divider to the header alone", () => {
    // The divider is further down, in its place below the pins.
    mountDirectoryThreads(140, { pinned: true, dividerTop: 300 });

    revealSelectedSidebarThreadRow();
    revealThreadRowAtNearestEdge(selectedRow());

    expect(scroll).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
