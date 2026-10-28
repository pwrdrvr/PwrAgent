import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revealSelectedSidebarThreadRow } from "../reveal-selected-thread-row";

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
let scroll: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
});

afterEach(() => {
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
function mountSidebar(rowTop: number, rowHeight = 60): void {
  document.body.innerHTML = `
    <aside class="sidebar">
      <div class="sidebar__scroll-region">
        <section class="directory-row">
          <div class="directory-row__header"></div>
          <div class="thread-row-shell"><div class="thread-row is-selected"></div></div>
        </section>
      </div>
    </aside>`;
  place(document.querySelector(".sidebar__scroll-region")!, 100, 400);
  place(document.querySelector(".directory-row__header")!, 100, 30);
  place(document.querySelector(".thread-row.is-selected")!, rowTop, rowHeight);
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

  it("still scrolls while the sidebar is hidden and measures zero", () => {
    mountSidebar(0, 0);
    place(document.querySelector(".sidebar__scroll-region")!, 0, 0);

    revealSelectedSidebarThreadRow({ instant: true });

    expect(scroll).toHaveBeenCalledWith({ behavior: "auto", block: "center", inline: "nearest" });
  });
});
