import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadJump } from "../useThreadJump";

afterEach(() => {
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
  it("opens without touching the sidebar, hidden or not", () => {
    const shown = renderThreadJump(false);
    act(() => shown.hook.result.current.openJump());
    expect(shown.hook.result.current.open).toBe(true);
    expect(shown.setSidebarHidden).not.toHaveBeenCalled();

    const hidden = renderThreadJump(true);
    act(() => hidden.hook.result.current.openJump());
    expect(hidden.hook.result.current.open).toBe(true);
    expect(hidden.setSidebarHidden).not.toHaveBeenCalled();
    expect(hidden.sidebarHidden()).toBe(true);
  });

  it("closes without touching the sidebar", () => {
    const { hook, setSidebarHidden, sidebarHidden } = renderThreadJump(true);

    act(() => hook.result.current.openJump());
    act(() => hook.result.current.closeJump());

    expect(hook.result.current.open).toBe(false);
    expect(setSidebarHidden).not.toHaveBeenCalled();
    expect(sidebarHidden()).toBe(true);
  });

  it("peeks a hidden sidebar open for the selected row's landing scroll", () => {
    const { hook, setSidebarHidden, sidebarHidden } = renderThreadJump(true);

    let peeked = false;
    act(() => {
      peeked = hook.result.current.beginRevealPeek();
    });

    expect(peeked).toBe(true);
    expect(setSidebarHidden).toHaveBeenLastCalledWith(false);
    expect(sidebarHidden()).toBe(false);
  });

  it("restores a landing-scroll peek when the scroll completes", () => {
    const { hook, setSidebarHidden, sidebarHidden } = renderThreadJump(true);

    act(() => {
      hook.result.current.beginRevealPeek();
    });
    setSidebarHidden.mockClear();
    act(() => hook.result.current.completePeekRestore());

    expect(setSidebarHidden).toHaveBeenCalledWith(true);
    expect(sidebarHidden()).toBe(true);
  });

  it("starts no peek when the sidebar is already showing", () => {
    const { hook, setSidebarHidden } = renderThreadJump(false);

    let peeked = true;
    act(() => {
      peeked = hook.result.current.beginRevealPeek();
    });

    expect(peeked).toBe(false);
    act(() => hook.result.current.completePeekRestore());
    expect(setSidebarHidden).not.toHaveBeenCalled();
  });

  it("lets an explicit sidebar preference win over a peek in flight", () => {
    const { hook, setSidebarHidden } = renderThreadJump(true);
    act(() => {
      hook.result.current.beginRevealPeek();
    });
    setSidebarHidden.mockClear();

    act(() => hook.result.current.endPeek());
    act(() => hook.result.current.completePeekRestore());

    expect(setSidebarHidden).not.toHaveBeenCalled();
  });

  it("toggles closed on a second ⌘K", () => {
    const { hook } = renderThreadJump(true);

    act(() => hook.result.current.toggleJump());
    expect(hook.result.current.open).toBe(true);

    act(() => hook.result.current.toggleJump());
    expect(hook.result.current.open).toBe(false);
  });
});
