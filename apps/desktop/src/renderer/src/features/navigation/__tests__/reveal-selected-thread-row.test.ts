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
  document.querySelector(".sidebar__scroll-region")?.dispatchEvent(new Event("scrollend"));
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

// The list scrolls from y=100 to y=500 in the window. The selected row's
// directory header is stuck to the top of it, 30px tall.
function mountSidebar(rowTop: number, rowHeight = 60, section = "directory-row"): void {
  document.body.innerHTML = `
    <aside class="sidebar">
      <div class="sidebar__scroll-region">
        <section class="${section}">
          <div class="directory-row__header"></div>
          <div class="thread-row-shell"><div class="thread-row is-selected"></div></div>
        </section>
      </div>
    </aside>`;
  place(document.querySelector(".sidebar__scroll-region")!, 100, 400);
  place(document.querySelector(".directory-row__header")!, 100, 30);
  place(document.querySelector(".thread-row.is-selected")!, rowTop, rowHeight);
  const region = document.querySelector<HTMLElement>(".sidebar__scroll-region")!;
  scrollBy = vi.fn();
  region.scrollBy = scrollBy as typeof region.scrollBy;
}

function selectedRow(): HTMLElement {
  return document.querySelector<HTMLElement>(".thread-row.is-selected")!;
}

function endScroll(): void {
  document.querySelector(".sidebar__scroll-region")!.dispatchEvent(new Event("scrollend"));
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
    place(document.querySelector(".sidebar__scroll-region")!, 0, 0);

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
    place(document.querySelector(".sidebar__scroll-region")!, 0, 0);

    revealThreadRowAtNearestEdge(selectedRow());

    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  });
});
