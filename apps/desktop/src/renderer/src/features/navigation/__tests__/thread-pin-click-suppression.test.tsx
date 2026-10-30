import { fireEvent, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadPinOrdering, type ThreadPinScope } from "../useThreadPinOrdering";

/**
 * A pin drag swallows the click its release synthesizes, for 150ms after the
 * drag ends. That timer once outlived the sidebar: a test file's jsdom was
 * torn down first, and the timer threw `window is not defined` into Vitest,
 * which failed a Windows lane on which every test had passed.
 */

const SCOPE: ThreadPinScope = {
  key: "directory:/repo",
  admitsRoot: () => true,
  pinnedKeys: () => [],
};

function renderPinOrdering() {
  return renderHook(() =>
    useThreadPinOrdering({
      threads: [],
      dropIndicator: { clear: () => undefined, show: () => undefined },
      onReorderThreadPins: async () => undefined,
    }));
}

function mountRow(): HTMLDivElement {
  const scopeElement = document.createElement("div");
  scopeElement.dataset.threadPinScope = SCOPE.key;
  const row = document.createElement("div");
  scopeElement.append(row);
  document.body.append(scopeElement);
  return row;
}

// An unpinned row in a scope with no append slot: the drag activates and
// arms the suppression, then lands nowhere, so no layout is needed.
function startDrag(
  view: ReturnType<typeof renderPinOrdering>,
  row: HTMLDivElement,
): void {
  view.result.current.beginPointerDrag(
    {
      button: 0,
      clientX: 50,
      clientY: 150,
      currentTarget: row,
      pointerId: 7,
    } as unknown as ReactPointerEvent<HTMLDivElement>,
    SCOPE,
    "codex:thread-1",
    false,
  );
  fireEvent.pointerMove(window, {
    buttons: 1, clientX: 50, clientY: 100, pointerId: 7,
  });
}

function clickIsSuppressed(row: HTMLDivElement): boolean {
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  row.dispatchEvent(click);
  return click.defaultPrevented;
}

describe("pin drag click suppression", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("clears the release timer and listener when the owner unmounts", () => {
    const view = renderPinOrdering();
    const row = mountRow();
    startDrag(view, row);
    fireEvent.pointerUp(window, {
      button: 0, clientX: 50, clientY: 100, pointerId: 7,
    });
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
    expect(clickIsSuppressed(row)).toBe(false);
  });

  it("clears the timer a drag cancelled by the unmount arms", () => {
    const view = renderPinOrdering();
    const row = mountRow();
    startDrag(view, row);
    expect(row.classList.contains("is-pointer-dragging")).toBe(true);

    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
    expect(clickIsSuppressed(row)).toBe(false);
  });

  it("drops the last drop's click suppression when the next drag starts", () => {
    const view = renderPinOrdering();
    const row = mountRow();
    startDrag(view, row);
    fireEvent.pointerUp(window, {
      button: 0, clientX: 50, clientY: 100, pointerId: 7,
    });
    expect(vi.getTimerCount()).toBe(1);

    view.result.current.beginPointerDrag(
      {
        button: 0,
        clientX: 50,
        clientY: 150,
        currentTarget: row,
        pointerId: 8,
      } as unknown as ReactPointerEvent<HTMLDivElement>,
      SCOPE,
      "codex:thread-1",
      false,
    );

    expect(vi.getTimerCount()).toBe(0);
    expect(clickIsSuppressed(row)).toBe(false);
    view.unmount();
  });

  it("still swallows the release click while mounted", () => {
    const view = renderPinOrdering();
    const row = mountRow();
    startDrag(view, row);
    fireEvent.pointerUp(window, {
      button: 0, clientX: 50, clientY: 100, pointerId: 7,
    });

    expect(clickIsSuppressed(row)).toBe(true);
    expect(clickIsSuppressed(row)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    view.unmount();
  });
});
