import { fireEvent, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { beginPointerReorderDrag } from "../pointer-reorder-drag";
import { useSubthreadReorderDrag } from "../useSubthreadReorderDrag";

/**
 * Project folder and sub-thread drags swallow the click their release
 * synthesizes, for 150ms after the drag ends. Their owners kept the session's
 * cancel only until the drag settled, so unmount could not reach that timer,
 * the same leak that once threw `window is not defined` into Vitest from a
 * pin drag after a test file's jsdom was torn down.
 */

function pointerDown(target: HTMLElement): ReactPointerEvent<HTMLDivElement> {
  return {
    button: 0,
    clientX: 50,
    clientY: 150,
    currentTarget: target,
    pointerId: 9,
  } as unknown as ReactPointerEvent<HTMLDivElement>;
}

function liftPointer(): void {
  fireEvent.pointerMove(window, {
    buttons: 1, clientX: 50, clientY: 100, pointerId: 9,
  });
}

function releasePointer(): void {
  fireEvent.pointerUp(window, {
    button: 0, clientX: 50, clientY: 100, pointerId: 9,
  });
}

function clickIsSuppressed(element: HTMLElement): boolean {
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  element.dispatchEvent(click);
  return click.defaultPrevented;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("pointer reorder drag disposer", () => {
  function startDrag() {
    const root = document.createElement("div");
    const source = document.createElement("div");
    root.append(source);
    document.body.append(root);
    const onDrop = vi.fn();
    const dispose = beginPointerReorderDrag({
      event: pointerDown(source),
      sourceElement: source,
      previewSource: source,
      clickSuppressionRoot: root,
      dropIndicator: { clear: () => undefined, show: () => undefined },
      resolveTarget: () => undefined,
      onDrop,
    });
    liftPointer();
    return { dispose, source };
  }

  it("still swallows the release click until it is disposed", () => {
    const { source } = startDrag();
    releasePointer();

    expect(clickIsSuppressed(source)).toBe(true);
    expect(clickIsSuppressed(source)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the release timer and listener of a finished drag", () => {
    const { dispose, source } = startDrag();
    releasePointer();
    expect(vi.getTimerCount()).toBe(1);

    dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(clickIsSuppressed(source)).toBe(false);
  });

  it("clears the timer that cancelling a live drag arms", () => {
    const { dispose, source } = startDrag();
    expect(source.classList.contains("is-pointer-dragging")).toBe(true);

    dispose();

    expect(source.classList.contains("is-pointer-dragging")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(clickIsSuppressed(source)).toBe(false);
  });
});

describe("sub-thread reorder drag", () => {
  const parent = { id: "parent" } as NavigationThreadSummary;
  const child = { id: "child" } as NavigationThreadSummary;

  it("clears a finished drag's click suppression when its owner unmounts", () => {
    const view = renderHook(() =>
      useSubthreadReorderDrag({
        threadByKey: new Map([["codex:parent", parent], ["codex:child", child]]),
        onUpdateSubthreadOrder: async () => undefined,
      }));
    const tray = document.createElement("div");
    tray.dataset.subthreadTray = "codex:parent";
    const row = document.createElement("div");
    tray.append(row);
    document.body.append(tray);

    view.result.current(pointerDown(row), {
      threadKey: "codex:child",
      pinned: false,
    });
    liftPointer();
    releasePointer();
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
    expect(clickIsSuppressed(row)).toBe(false);
  });
});
