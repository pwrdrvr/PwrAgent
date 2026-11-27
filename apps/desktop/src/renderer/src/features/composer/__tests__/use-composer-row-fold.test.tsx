import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerFoldTier } from "../composer-control-fold";
import { measureComposerRowFold, useComposerRowFold } from "../useComposerRowFold";

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

  it("refolds before paint when a control stops folding with its tier", async () => {
    // Plan folds with the Details controls while it is off and stays in the
    // row once on. Only its slot's tier changes, so nothing else in the row
    // mutates to prompt a measure.
    rowWidth = 210;
    const plan: Control = { key: "plan", width: 30, tier: "details" };
    const commits: number[] = [];
    const view = render(<Row commits={commits} controls={[PINNED, plan, RUN]} />);
    expect(commits.at(-1)).toBe(1);

    view.rerender(<Row commits={commits} controls={[PINNED, { ...plan, tier: undefined }, RUN]} />);
    await act(async () => {
      await Promise.resolve();
    });
    // Pinned 100 + Plan 30 + Run 100 overflows 210, so Run folds too.
    expect(commits.at(-1)).toBe(2);
  });

  describe("with the model picker open inside the row", () => {
    // The composer's model picker renders its list inline, under its pill,
    // and each row repeats the pill's label classes.
    function modelRow(openRows: number | undefined): HTMLElement {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `
        <div class="model-settings" data-width="150" style="flex-shrink: 1">
          <button class="model-settings__pill"><span class="model-settings__pill-model" data-label="90">GPT</span></button>
        </div>
        <span data-composer-fold="details" data-width="120"></span>
        <span data-width="90"></span>`;
      if (openRows !== undefined) {
        const panel = document.createElement("div");
        panel.className = "model-settings__panel";
        for (let index = 0; index < openRows; index += 1) {
          panel.insertAdjacentHTML("beforeend",
            `<button><span class="model-settings__pill-provider" data-label="60">P${index}</span></button>`);
        }
        row.querySelector(".model-settings")!.append(panel);
      }
      document.body.append(row);
      return row;
    }

    let labelReads = 0;
    beforeEach(() => {
      labelReads = 0;
      const labelWidth = function (this: Element) {
        const label = (this as HTMLElement).dataset?.label;
        if (label === undefined) return 0;
        labelReads += 1;
        return Number(label);
      };
      vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(labelWidth);
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("row") ? 120 : labelWidth.call(this);
      });
    });

    afterEach(() => {
      document.body.replaceChildren();
    });

    it("measures the row as if the list were closed", () => {
      // Counterexample: one open row in a 120px row collapsed the pill's
      // floor to 0px and changed the plan.
      const closed = modelRow(undefined);
      const closedPlan = measureComposerRowFold(closed);
      const closedFloor = closed.querySelector<HTMLElement>(".model-settings")!.style.getPropertyValue("--composer-row-floor");
      const open = modelRow(1);
      expect(measureComposerRowFold(open)).toEqual(closedPlan);
      expect(open.querySelector<HTMLElement>(".model-settings")!.style.getPropertyValue("--composer-row-floor"))
        .toBe(closedFloor);
    });

    it("reads only the pill's labels, however long the open list is", () => {
      // Each measure (one per keystroke in the picker's search) read every
      // list row's label, so the work grew with rows times keystrokes.
      measureComposerRowFold(modelRow(200));
      expect(labelReads).toBeLessThanOrEqual(3);
    });
  });
});
