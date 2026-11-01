import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THINKING_SCAN_ANIMATION_ID,
  THINKING_SCAN_DURATION_MS,
  THINKING_SCAN_PERIOD_MS,
  ThinkingScanner,
} from "../ThinkingScanner";

const ON_SCREEN = { top: 10, left: 10, right: 72, bottom: 16, width: 62, height: 6 } as DOMRect;
const OFF_SCREEN = { top: 5000, left: 10, right: 72, bottom: 5006, width: 62, height: 6 } as DOMRect;

type AnimateCall = { beam: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions };

describe("ThinkingScanner", () => {
  let calls: AnimateCall[];

  beforeEach(() => {
    vi.useFakeTimers();
    // Mid-period, so the first scan is due at the next period boundary.
    vi.setSystemTime(THINKING_SCAN_PERIOD_MS * 1000 + 1200);
    calls = [];
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
        calls.push({ beam: this, keyframes, options });
        return {} as Animation;
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(ON_SCREEN);
    // The travel custom property comes from app.css, which jsdom does not load.
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({
      getPropertyValue: (name: string) => name === "--thinking-scanner-travel"
        ? (element.closest(".thinking-scanner--mini") ? "10px" : "44px")
        : "",
    }) as CSSStyleDeclaration);
  });

  afterEach(() => {
    cleanup();
    // Drain the scheduler: with no beam left, the next scan stops the timer.
    vi.advanceTimersByTime(THINKING_SCAN_PERIOD_MS);
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  });

  const renderFleet = () => render(
    <>
      <ThinkingScanner />
      <ThinkingScanner compact />
    </>,
  );

  it("holds still until the shared wall-clock boundary, then scans every beam in one batch", () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const requestAnimationFrameSpy = vi.spyOn(window, "requestAnimationFrame");
    renderFleet();

    // Two mounts, one timer: the scheduler is per window, not per beam.
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0][1]).toBe(THINKING_SCAN_PERIOD_MS - 1200);
    act(() => { vi.advanceTimersByTime(THINKING_SCAN_PERIOD_MS - 1201); });
    expect(calls).toHaveLength(0);

    act(() => { vi.advanceTimersByTime(1); });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.options).toEqual({ duration: THINKING_SCAN_DURATION_MS, id: THINKING_SCAN_ANIMATION_ID });
    }
    // Pixel keyframes per track width: centre → right edge → left edge → centre.
    expect(calls.map((call) => call.keyframes.map((frame) => frame.transform))).toEqual([
      ["translateX(22px)", "translateX(44px)", "translateX(0px)", "translateX(22px)"],
      ["translateX(5px)", "translateX(10px)", "translateX(0px)", "translateX(5px)"],
    ]);
    expect(calls[0].keyframes.map((frame) => frame.easing)).toEqual([
      "steps(14, end)", "steps(27, end)", "steps(14, end)", undefined,
    ]);

    // One timer per period after that, and never a frame callback.
    act(() => { vi.advanceTimersByTime(THINKING_SCAN_PERIOD_MS); });
    expect(calls).toHaveLength(4);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(3);
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
  });

  it("stops its timer once no scanner is mounted, and a mount restarts it", () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const view = renderFleet();
    view.unmount();
    act(() => { vi.advanceTimersByTime(THINKING_SCAN_PERIOD_MS * 3); });
    expect(calls).toHaveLength(0);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

    renderFleet();
    act(() => { vi.advanceTimersByTime(THINKING_SCAN_PERIOD_MS); });
    expect(calls).toHaveLength(2);
  });

  it("starts no scan for an offscreen beam or a hidden window", () => {
    renderFleet();
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(OFF_SCREEN);
    act(() => { vi.advanceTimersByTime(THINKING_SCAN_PERIOD_MS); });
    expect(calls).toHaveLength(0);

    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(ON_SCREEN);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => { vi.advanceTimersByTime(THINKING_SCAN_PERIOD_MS); });
    expect(calls).toHaveLength(0);

    // Still scheduled: the beam scans again once it can be seen.
    visibility.mockReturnValue("visible");
    act(() => { vi.advanceTimersByTime(THINKING_SCAN_PERIOD_MS); });
    expect(calls).toHaveLength(2);
  });
});

describe("ThinkingScanner under reduced motion", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
    Reflect.deleteProperty(document, "getAnimations");
  });

  it("starts no scan, and cancels a moving one when the preference turns on", async () => {
    vi.useFakeTimers();
    let onChange: () => void = () => {};
    const query = {
      matches: true,
      addEventListener: (_type: string, listener: () => void) => { onChange = listener; },
    };
    vi.stubGlobal("matchMedia", vi.fn(() => query));
    vi.resetModules();
    const fresh = await import("../ThinkingScanner");
    const animate = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(ON_SCREEN);

    render(<fresh.ThinkingScanner />);
    act(() => { vi.advanceTimersByTime(fresh.THINKING_SCAN_PERIOD_MS * 2); });
    expect(animate).not.toHaveBeenCalled();

    const scan = { id: fresh.THINKING_SCAN_ANIMATION_ID, cancel: vi.fn() };
    const other = { id: "", cancel: vi.fn() };
    Object.defineProperty(document, "getAnimations", { configurable: true, value: () => [scan, other] });
    onChange();
    expect(scan.cancel).toHaveBeenCalledTimes(1);
    expect(other.cancel).not.toHaveBeenCalled();
    cleanup();
    act(() => { vi.advanceTimersByTime(fresh.THINKING_SCAN_PERIOD_MS); });
  });
});
