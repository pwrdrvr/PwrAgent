import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { observeTooltipAnchor } from "../observe-tooltip-anchor";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Chromium's layout unit. `borderBoxSize` is a whole number of these. */
const LAYOUT_UNIT = 1 / 64;

type Observers = {
  resize: (inlineSize: number, blockSize: number) => void;
  intersect: (rect: DOMRectReadOnly) => void;
};

function stubNativeObservers(target: Element): Observers {
  let resize: ResizeObserverCallback = () => {};
  let intersect: IntersectionObserverCallback = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe(): void {}
    disconnect(): void {}
  });
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe(): void {}
    disconnect(): void {}
  });
  return {
    resize: (inlineSize, blockSize) => resize([{
      target,
      borderBoxSize: [{ inlineSize, blockSize }],
    } as unknown as ResizeObserverEntry], {} as ResizeObserver),
    intersect: (boundingClientRect) => intersect([{
      target,
      boundingClientRect,
      intersectionRatio: 1,
    } as unknown as IntersectionObserverEntry], {} as IntersectionObserver),
  };
}

// Coordinates as `getBoundingClientRect` reports them on a 2x display: whole
// device pixels' worth of layout units, so steps of 1/128 CSS px.
const coordinate = (min: number, max: number) =>
  fc.integer({ min: min * 128, max: max * 128 }).map((value) => value / 128);

const anchor = fc.record({
  left: coordinate(0, 1000),
  top: coordinate(0, 700),
  width: coordinate(1, 400),
  height: coordinate(1, 60),
}).map(({ left, top, width, height }) => ({
  left, top, right: left + width, bottom: top + height,
}));

/**
 * The rule: while the intersection observer watches the anchor, its initial
 * notification compares the box with the baseline in the baseline's own
 * coordinates, so the resize observer's initial notification carries nothing
 * new and must not cost a geometry read. `borderBoxSize` is quantized to layout
 * units and `getBoundingClientRect` is not, so on a 2x display the same,
 * unchanged box can differ between the two by up to a layout unit.
 *
 * Every later resize notification is a real size change and must still be
 * checked, in exactly one frame.
 */
it("spends no geometry read on the initial native size and checks every later resize", () => {
  fc.assert(
    fc.property(
      anchor,
      fc.constantFrom(Math.floor, Math.round, Math.ceil),
      fc.integer({ min: 1, max: 5 }),
      (baseline, quantize, laterResizes) => {
        const target = document.createElement("button");
        document.body.append(target);
        const observers = stubNativeObservers(target);
        const frames: FrameRequestCallback[] = [];
        vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
          frames.push(callback);
          return frames.length;
        });
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
        const check = vi.fn();
        const stop = observeTooltipAnchor(target, baseline, () => null, check);
        try {
          const width = baseline.right - baseline.left;
          const height = baseline.bottom - baseline.top;
          observers.resize(
            quantize(width / LAYOUT_UNIT) * LAYOUT_UNIT,
            quantize(height / LAYOUT_UNIT) * LAYOUT_UNIT,
          );
          observers.intersect({ ...baseline, x: baseline.left, y: baseline.top, width, height,
            toJSON: () => baseline } as DOMRectReadOnly);
          expect(frames).toHaveLength(0);
          expect(check).toHaveBeenCalledTimes(1);
          expect(check.mock.calls[0]![0]).toBeDefined();

          for (let index = 1; index <= laterResizes; index += 1) {
            observers.resize(width + index * LAYOUT_UNIT, height);
            expect(frames).toHaveLength(index);
            frames[index - 1]!(0);
            expect(check).toHaveBeenCalledTimes(1 + index);
            expect(check.mock.calls[index]![0]).toBeUndefined();
          }
        } finally {
          stop();
          target.remove();
          vi.restoreAllMocks();
        }
      },
    ),
    { numRuns: 300 },
  );
});
