import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSidebarResizing,
  setSidebarResizing,
  subscribeSidebarResizing,
} from "../sidebar-resize-signal";

// The signal is module-level singleton state; reset it after every test so the
// cases can't bleed into one another.
afterEach(() => {
  setSidebarResizing(false);
});

describe("sidebar-resize-signal", () => {
  it("starts inactive", () => {
    expect(isSidebarResizing()).toBe(false);
  });

  it("reflects the active flag through isSidebarResizing()", () => {
    setSidebarResizing(true);
    expect(isSidebarResizing()).toBe(true);
    setSidebarResizing(false);
    expect(isSidebarResizing()).toBe(false);
  });

  it("notifies subscribers on each transition with the new value", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSidebarResizing(listener);

    setSidebarResizing(true);
    setSidebarResizing(false);

    expect(listener.mock.calls).toEqual([[true], [false]]);
    unsubscribe();
  });

  it("does not notify when the value is unchanged", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSidebarResizing(listener);

    setSidebarResizing(true);
    setSidebarResizing(true); // duplicate — must be a no-op
    setSidebarResizing(false);
    setSidebarResizing(false); // duplicate — must be a no-op

    expect(listener.mock.calls).toEqual([[true], [false]]);
    unsubscribe();
  });

  it("notifies every subscriber", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubFirst = subscribeSidebarResizing(first);
    const unsubSecond = subscribeSidebarResizing(second);

    setSidebarResizing(true);

    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(true);
    unsubFirst();
    unsubSecond();
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSidebarResizing(listener);

    setSidebarResizing(true);
    unsubscribe();
    setSidebarResizing(false);

    expect(listener.mock.calls).toEqual([[true]]);
  });
});
