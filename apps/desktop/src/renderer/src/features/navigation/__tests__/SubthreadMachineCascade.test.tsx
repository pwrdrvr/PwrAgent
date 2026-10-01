import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubthreadMachineCascade } from "../SubthreadMachineCascade";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FLYOUT_WIDTH = 260;
const FLYOUT_HEIGHT = 300;

/**
 * jsdom has no layout, so the row's box and the flyout's size are stubbed.
 * The window is jsdom's 1024 × 768.
 */
function renderAt(row: { left: number; top: number; width: number; height: number }) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const box = this.classList.contains("thread-context-menu__cascade")
      ? row
      : { left: 0, top: 0, width: 0, height: 0 };
    return {
      ...box,
      x: box.left,
      y: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      toJSON: () => box,
    } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute("role") === "menu" ? FLYOUT_WIDTH : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute("role") === "menu" ? FLYOUT_HEIGHT : 0;
  });
  render(
    <SubthreadMachineCascade
      label="Sub-thread in New Worktree"
      groupLabel="New worktree on"
      machines={[
        { label: "Harbor Mac", availability: "available", parent: true },
        { instanceId: "studio", label: "Studio Mac", availability: "available", parent: false },
      ]}
      onSelect={() => undefined}
      onSelectMachine={() => undefined}
    />,
  );
  const cascade = screen.getByRole("menuitem", { name: "Sub-thread in New Worktree" });
  fireEvent.mouseEnter(cascade.parentElement!);
  return screen.getByRole("menu", { name: "New worktree on" });
}

describe("SubthreadMachineCascade, placement", () => {
  it("opens to the row's right, top-aligned, when it fits", () => {
    const flyout = renderAt({ left: 100, top: 100, width: 200, height: 34 });
    expect(flyout).not.toHaveClass("thread-context-menu__flyout--start");
    expect(flyout.style.top).toBe("");
  });

  it("flips to the row's left at the window's right edge", () => {
    // 900 + 2 + 260 crosses 1024 - 8; 700 - 2 - 260 clears 8.
    const flyout = renderAt({ left: 700, top: 100, width: 200, height: 34 });
    expect(flyout).toHaveClass("thread-context-menu__flyout--start");
  });

  it("stays on the right when neither side fits", () => {
    const flyout = renderAt({ left: 100, top: 100, width: 800, height: 34 });
    expect(flyout).not.toHaveClass("thread-context-menu__flyout--start");
  });

  it("moves up by its overflow at the window's bottom edge", () => {
    // Top 594 + 300 runs 134px past 768 - 8.
    const flyout = renderAt({ left: 100, top: 600, width: 200, height: 34 });
    expect(flyout.style.top).toBe(`${-6 - 134}px`);
  });

  it("never moves above the window's top margin", () => {
    // Top 94 + 300 still overflows a short window, but only 86px are spare.
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(300);
    const flyout = renderAt({ left: 100, top: 100, width: 200, height: 34 });
    expect(flyout.style.top).toBe(`${-6 - 86}px`);
  });
});
