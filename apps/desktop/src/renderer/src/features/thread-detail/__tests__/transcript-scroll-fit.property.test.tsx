import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disclosureScrollCorrection,
  installDisclosureAnchor,
} from "../transcript-scroll-fit";

/**
 * Model of a scroller holding one disclosure control. The control's viewport
 * top is its offset in the content less `scrollTop`; toggling moves the
 * content above it by `shift` and changes the content height.
 */
function modelScroller(offset: number, scrollTop: number) {
  const state = { offset, scrollHeight: 10_000, scrollTop };
  const scroller = document.createElement("div");
  const control = document.createElement("button");
  control.setAttribute("aria-expanded", "true");
  scroller.append(control);
  document.body.append(scroller);
  Object.defineProperty(scroller, "scrollHeight", { get: () => state.scrollHeight });
  Object.defineProperty(scroller, "scrollTop", {
    get: () => state.scrollTop,
    set: (value: number) => {
      state.scrollTop = value;
    },
  });
  control.getBoundingClientRect = () =>
    ({ top: state.offset - state.scrollTop }) as DOMRect;
  return { control, scroller, state };
}

describe("disclosure scroll anchor", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("puts a clicked control back where it was, however the content above it moved", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        fc.integer({ min: -4_000, max: 4_000 }).filter((shift) => shift !== 0),
        (offset, scrollTop, shift) => {
          const frames: FrameRequestCallback[] = [];
          vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
          });
          const { control, scroller, state } = modelScroller(offset, scrollTop);
          const onLayoutChange = vi.fn();
          const uninstall = installDisclosureAnchor(scroller, onLayoutChange);

          const before = control.getBoundingClientRect().top;
          control.click();
          // The toggle commits between the click and the frame.
          state.offset += shift;
          state.scrollHeight += shift;
          frames.forEach((frame) => frame(0));

          expect(control.getBoundingClientRect().top).toBe(before);
          expect(onLayoutChange).toHaveBeenCalledTimes(1);
          uninstall();
          scroller.remove();
        },
      ),
    );
  });

  it("leaves the scroller and bottom-follow alone when the click changed no layout", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const { control, scroller, state } = modelScroller(400, 120);
    const onLayoutChange = vi.fn();
    installDisclosureAnchor(scroller, onLayoutChange);

    control.click();
    frames.forEach((frame) => frame(0));

    expect(state.scrollTop).toBe(120);
    expect(onLayoutChange).not.toHaveBeenCalled();
  });

  it("never blames a popup button for content that grew while it was clicked", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4_000 }), (growth) => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
          frames.push(callback);
          return frames.length;
        });
        const { control, scroller, state } = modelScroller(400, 120);
        control.setAttribute("aria-haspopup", "menu");
        const onLayoutChange = vi.fn();
        const uninstall = installDisclosureAnchor(scroller, onLayoutChange);

        control.click();
        // A streaming turn appends output in the same frame.
        state.scrollHeight += growth;
        frames.forEach((frame) => frame(0));

        expect(state.scrollTop).toBe(120);
        expect(onLayoutChange).not.toHaveBeenCalled();
        uninstall();
        scroller.remove();
      }),
    );
  });

  it("ignores sub-pixel drift", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -5_000, max: 5_000, noNaN: true }),
        fc.double({ min: -0.99, max: 0.99, noNaN: true }),
        (before, drift) => {
          expect(disclosureScrollCorrection(before, before + drift)).toBe(0);
        },
      ),
    );
  });
});
