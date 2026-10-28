import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { ThreadRow } from "../ThreadRow";
import { revealSelectedSidebarThreadRow } from "../reveal-selected-thread-row";

const thread: NavigationThreadSummary = {
  id: "thread-reveal",
  title: "Reveal flow thread",
  titleSource: "explicit",
  summary: "Selected row below the fold",
  source: "codex",
  executionMode: "default",
  updatedAt: Date.now(),
  inbox: { inInbox: false },
  linkedDirectories: [],
};

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

function box(top: number, height: number): DOMRect {
  return {
    x: 0, y: top, top, bottom: top + height, left: 0, right: 300, width: 300, height,
    toJSON: () => ({}),
  } as DOMRect;
}

it("lets the title click's centering finish instead of stopping it at the list edge", () => {
  document.body.innerHTML = `
    <aside class="sidebar">
      <div class="sidebar__scroll-region">
        <section class="directory-row">
          <div class="directory-row__header"></div>
          <div class="row-host"></div>
        </section>
      </div>
    </aside>`;
  const region = document.querySelector<HTMLElement>(".sidebar__scroll-region")!;
  const scrollBy = vi.fn();
  region.scrollBy = scrollBy as typeof region.scrollBy;
  // The list shows y=100 to y=500 under a 30px sticky header. The selected
  // row sits above it, scrolled out of sight.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === region) return box(100, 400);
    if (this.classList.contains("directory-row__header")) return box(100, 30);
    if (this.classList.contains("thread-row") && this.classList.contains("is-selected")) return box(20, 60);
    return box(0, 0);
  });
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

  const props = {
    thread,
    selectedThreadKey: "codex:thread-reveal",
    onSelectThread: vi.fn(),
    onOpenContextMenu: vi.fn(),
    onRevealSelectedThreadComplete: vi.fn(),
  };
  const view = render(<ThreadRow {...props} />, { container: document.querySelector<HTMLElement>(".row-host")! });
  scroll.mockClear();
  scrollBy.mockClear();

  // The title click: App starts the centering, then bumps the request that
  // re-runs ThreadRow's reveal effect.
  revealSelectedSidebarThreadRow();
  view.rerender(<ThreadRow {...props} revealSelectedThreadRequest={1} />);
  act(() => frames.at(-1)!(0));

  expect(scroll).toHaveBeenCalledTimes(1);
  expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "center", inline: "nearest" });
  expect(scrollBy).not.toHaveBeenCalled();
  expect(props.onRevealSelectedThreadComplete).toHaveBeenCalledWith(1);
  region.dispatchEvent(new Event("scrollend"));
});
