import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadJump } from "../useThreadJump";

// The peek restore is deliberately deferred a frame (a jump's scroll-into-view
// has to land while the sidebar still has layout), so drive frames by hand.
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    frames.push(callback),
  );
});

function flushFrame(): void {
  const queued = frames.splice(0);
  act(() => {
    for (const callback of queued) {
      callback(0);
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

/**
 * Drives the hook the way App does: it owns `sidebarHidden` and hands the hook
 * a non-persisting setter, re-rendering with the new value.
 */
function renderThreadJump(initialSidebarHidden: boolean): {
  hook: ReturnType<typeof renderHook<ReturnType<typeof useThreadJump>, unknown>>;
  setSidebarHidden: ReturnType<typeof vi.fn>;
  sidebarHidden: () => boolean;
} {
  let sidebarHidden = initialSidebarHidden;
  const setSidebarHidden = vi.fn((next: boolean) => {
    sidebarHidden = next;
  });
  const hook = renderHook(() =>
    useThreadJump({ sidebarHidden, setSidebarHidden }),
  );
  return { hook, setSidebarHidden, sidebarHidden: () => sidebarHidden };
}

describe("useThreadJump", () => {
  it("opens without touching a sidebar that's already showing", () => {
    const { hook, setSidebarHidden } = renderThreadJump(false);

    act(() => hook.result.current.openJump());

    expect(hook.result.current.open).toBe(true);
    expect(setSidebarHidden).not.toHaveBeenCalled();
  });

  it("peeks a hidden sidebar open, then puts it back when the search closes", () => {
    // ⌘K over a hidden sidebar has to reveal it — the popup renders inside it.
    // But hiding the sidebar is a deliberate choice, so the reveal is temporary.
    const { hook, setSidebarHidden, sidebarHidden } = renderThreadJump(true);

    act(() => hook.result.current.openJump());
    expect(setSidebarHidden).toHaveBeenLastCalledWith(false);
    expect(sidebarHidden()).toBe(false);
    expect(hook.result.current.isPeeking()).toBe(true);

    act(() => hook.result.current.closeJump());
    flushFrame();

    expect(hook.result.current.open).toBe(false);
    expect(setSidebarHidden).toHaveBeenLastCalledWith(true);
    expect(sidebarHidden()).toBe(true);
  });

  it("holds the sidebar for a frame on close, so a jump's scroll can land first", () => {
    // Picking a thread closes the popup AND schedules the scroll that centers
    // the chosen row. `scrollIntoView` does nothing inside a `display: none`
    // subtree, so re-hiding in the same commit would eat the scroll and strand
    // the row off-screen the next time the sidebar came back.
    const { hook, setSidebarHidden, sidebarHidden } = renderThreadJump(true);
    act(() => hook.result.current.openJump());
    setSidebarHidden.mockClear();

    act(() => hook.result.current.closeJump());

    // Still laid out: this is the frame the reveal runs in.
    expect(setSidebarHidden).not.toHaveBeenCalled();
    expect(sidebarHidden()).toBe(false);

    flushFrame();

    expect(setSidebarHidden).toHaveBeenCalledWith(true);
  });

  it("reports the peek to callers before the popup's close clears it", () => {
    // App reads isPeeking() inside onJumpToThread to choose an instant scroll —
    // and the popup calls onJumpToThread BEFORE onClose, so the peek must still
    // be readable at that moment.
    const { hook } = renderThreadJump(true);
    act(() => hook.result.current.openJump());

    expect(hook.result.current.isPeeking()).toBe(true);

    act(() => hook.result.current.closeJump());
    flushFrame();

    expect(hook.result.current.isPeeking()).toBe(false);
  });

  it("leaves a visible sidebar alone when the search closes", () => {
    const { hook, setSidebarHidden } = renderThreadJump(false);

    act(() => hook.result.current.openJump());
    act(() => hook.result.current.closeJump());
    flushFrame();

    expect(hook.result.current.open).toBe(false);
    expect(setSidebarHidden).not.toHaveBeenCalled();
  });

  it("lets an explicit sidebar preference win over a peek in flight", () => {
    // If anything persists a sidebar preference while a peek is open, that's the
    // operator stating what they want and the peek must not revert it on close.
    // No path in today's UI reaches this (clicking a toggle chip dismisses the
    // popup first, and ⌘B is inert while the caret is in the popup's field) —
    // this pins the contract so a future one can't silently undo a saved
    // preference.
    const { hook, setSidebarHidden } = renderThreadJump(true);
    act(() => hook.result.current.openJump());
    setSidebarHidden.mockClear();

    act(() => hook.result.current.endPeek());
    act(() => hook.result.current.closeJump());
    flushFrame();

    expect(hook.result.current.open).toBe(false);
    expect(setSidebarHidden).not.toHaveBeenCalled();
  });

  it("toggles closed on a second ⌘K, restoring the peek", () => {
    const { hook, setSidebarHidden, sidebarHidden } = renderThreadJump(true);

    act(() => hook.result.current.toggleJump());
    expect(hook.result.current.open).toBe(true);

    act(() => hook.result.current.toggleJump());
    flushFrame();

    expect(hook.result.current.open).toBe(false);
    expect(setSidebarHidden).toHaveBeenLastCalledWith(true);
    expect(sidebarHidden()).toBe(true);
  });
});
