import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPOSER_FOLD_SETTLE_MS, type ComposerFoldTier } from "../composer-control-fold";
import { useComposerRowFold } from "../useComposerRowFold";

/**
 * jsdom has no layout, so each control states its width in `data-width` and
 * the row is `ROW_WIDTH` px wide. Pinned 100 + details 100 fit; adding the
 * environment ▶ (100) does not, so the row folds the details tier.
 */
const ROW_WIDTH = 250;
let rowWidth = ROW_WIDTH;

type Control = { key: string; width: number; tier?: ComposerFoldTier };

const PINNED: Control = { key: "model", width: 100 };
const DETAILS: Control = { key: "worktree", width: 100, tier: "details" };
const RUN: Control = { key: "run", width: 100, tier: "run" };

function Row(props: { scope: string; controls: Control[]; commits: number[] }) {
  const fold = useComposerRowFold(props.scope);
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

/** Lets the row settle: its observers' microtasks, then a painted frame. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    vi.advanceTimersByTime(16);
  });
}

describe("useComposerRowFold", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
    vi.stubGlobal("ResizeObserver", class {
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
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("folds a control that arrives late before the browser can paint the unfolded row", async () => {
    const commits: number[] = [];
    const view = render(<Row commits={commits} controls={[PINNED, DETAILS]} scope="thread:late" />);
    expect(commits.at(-1)).toBe(0);

    view.rerender(<Row commits={commits} controls={[PINNED, DETAILS, RUN]} scope="thread:late" />);
    // The mutation observer's microtask runs before the next paint; a fold
    // scheduled for a later frame would still read 0 here.
    await act(async () => {
      await Promise.resolve();
    });
    expect(commits.at(-1)).toBe(1);
  });

  it("reopens a thread at the fold it settled on, while its late controls load", async () => {
    const commits: number[] = [];
    const view = render(<Row commits={commits} controls={[PINNED, DETAILS, RUN]} scope="thread:a" />);
    await settle();
    expect(commits.at(-1)).toBe(1);

    view.rerender(<Row commits={commits} controls={[PINNED]} scope="thread:b" />);
    await settle();

    // Back on thread A, its environment ▶ has not loaded yet: the row alone
    // would fit unfolded, but it must not draw that and fold a moment later.
    commits.length = 0;
    view.rerender(<Row commits={commits} controls={[PINNED, DETAILS]} scope="thread:a" />);
    await settle();
    view.rerender(<Row commits={commits} controls={[PINNED, DETAILS, RUN]} scope="thread:a" />);
    await settle();
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every((count) => count === 1)).toBe(true);
  });

  it("unfolds after the settle window when the remembered controls never arrive", async () => {
    const commits: number[] = [];
    const view = render(<Row commits={commits} controls={[PINNED, DETAILS, RUN]} scope="thread:gone" />);
    await act(async () => {
      await Promise.resolve();
    });
    view.rerender(<Row commits={commits} controls={[PINNED]} scope="thread:other" />);
    view.rerender(<Row commits={commits} controls={[PINNED, DETAILS]} scope="thread:gone" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(commits.at(-1)).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(COMPOSER_FOLD_SETTLE_MS);
    });
    expect(commits.at(-1)).toBe(0);
  });

  it("does not hold a fold remembered at another width", async () => {
    const commits: number[] = [];
    const view = render(<Row commits={commits} controls={[PINNED, DETAILS, RUN]} scope="thread:resized" />);
    await settle();
    expect(commits.at(-1)).toBe(1);
    view.rerender(<Row commits={commits} controls={[PINNED]} scope="thread:elsewhere" />);
    await settle();

    // The pane widened while another thread was open: everything fits now.
    rowWidth = 400;
    view.rerender(<Row commits={commits} controls={[PINNED, DETAILS]} scope="thread:resized" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(commits.at(-1)).toBe(0);
    view.rerender(<Row commits={commits} controls={[PINNED, DETAILS, RUN]} scope="thread:resized" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(commits.at(-1)).toBe(0);
  });
});
