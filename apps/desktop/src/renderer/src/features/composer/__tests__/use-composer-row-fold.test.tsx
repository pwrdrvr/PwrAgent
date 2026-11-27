import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerFoldTier } from "../composer-control-fold";
import { useComposerRowFold } from "../useComposerRowFold";

/**
 * jsdom has no layout, so each control states its width in `data-width` and
 * the row is `ROW_WIDTH` px wide. Pinned 100 + details 100 fit; adding the
 * environment ▶ (100) does not, so the row folds the details tier.
 */
const ROW_WIDTH = 250;
let rowWidth = ROW_WIDTH;
let resized: (() => void) | undefined;

type Control = { key: string; width: number; tier?: ComposerFoldTier };

const PINNED: Control = { key: "model", width: 100 };
const DETAILS: Control = { key: "worktree", width: 100, tier: "details" };
const RUN: Control = { key: "run", width: 100, tier: "run" };

function Row(props: { controls: Control[]; commits: number[] }) {
  const fold = useComposerRowFold();
  // Every committed fold, which is what the browser can paint.
  useLayoutEffect(() => {
    props.commits.push(fold.foldedTierCount);
  });
  return (
    <div className="row" ref={fold.rowRef}>
      {props.controls.map((control) => (
        <span
          data-composer-fold={control.tier}
          data-width={control.width}
          key={control.key}
        />
      ))}
    </div>
  );
}

describe("useComposerRowFold", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("row") ? rowWidth : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const width = Number(this.dataset.width ?? 0);
      return { width, height: 20, top: 0, left: 0, right: width, bottom: 20, x: 0, y: 0, toJSON: () => ({}) };
    });
  });

  afterEach(() => {
    rowWidth = ROW_WIDTH;
    resized = undefined;
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("folds after a resize on the next frame, not inside the observer's callback", async () => {
    const commits: number[] = [];
    render(<Row commits={commits} controls={[PINNED, DETAILS]} />);
    expect(commits.at(-1)).toBe(0);

    // Folding inside the callback would resize the row's other items in the
    // same observation pass, which the browser reports as a loop error.
    rowWidth = 150;
    act(() => resized?.());
    expect(commits.at(-1)).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(16);
    });
    expect(commits.at(-1)).toBe(1);
  });

  it("folds a control that arrives late before the browser can paint the unfolded row", async () => {
    const commits: number[] = [];
    const view = render(<Row commits={commits} controls={[PINNED, DETAILS]} />);
    expect(commits.at(-1)).toBe(0);

    view.rerender(<Row commits={commits} controls={[PINNED, DETAILS, RUN]} />);
    // The mutation observer's microtask runs before the next paint; a fold
    // scheduled for a later frame would still read 0 here.
    await act(async () => {
      await Promise.resolve();
    });
    expect(commits.at(-1)).toBe(1);
  });
});
