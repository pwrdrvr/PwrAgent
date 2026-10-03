import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingScanner } from "../ThinkingScanner";

const originalGetAnimationsDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "getAnimations"
);

describe("ThinkingScanner", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (originalGetAnimationsDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "getAnimations",
        originalGetAnimationsDescriptor
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
    }
  });

  it("pins scanners to one document-timeline epoch with no runtime clock", () => {
    const animations = [
      { startTime: 975 },
      { startTime: 2275 },
    ];
    let animationIndex = 0;
    const getAnimations = vi.fn(() => [animations[animationIndex++]]);
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: getAnimations,
    });
    const requestAnimationFrameSpy = vi.spyOn(window, "requestAnimationFrame");
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");

    render(
      <>
        <ThinkingScanner />
        <ThinkingScanner compact />
      </>
    );

    const scanners = Array.from(document.querySelectorAll<HTMLElement>(".thinking-scanner"));
    expect(scanners).toHaveLength(2);
    expect(getAnimations).toHaveBeenCalledTimes(2);
    expect(animations.map((animation) => animation.startTime)).toEqual([0, 0]);
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it.each([false, true])("re-pins a restarted CSS animation (initial start dispatched: %s)", (initialStartDispatched) => {
    let animation: { startTime: number | null } = { startTime: 975 };
    const getAnimations = vi.fn(() => [animation]);
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: getAnimations,
    });
    const requestAnimationFrameSpy = vi.spyOn(window, "requestAnimationFrame");
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const { container } = render(<ThinkingScanner compact />);
    const beam = container.querySelector(".thinking-scanner__beam")!;
    expect(animation.startTime).toBe(0);

    // Chromium recreates CSS animations when React moves a keyed ancestor
    // with insertBefore. The component and its ref stay mounted.
    // jsdom has the prefixed style property but no AnimationEvent constructor,
    // so React registers the legacy event name there.
    const eventName = "AnimationEvent" in window ? "animationstart" : "webkitAnimationStart";
    const startAnimation = () => fireEvent(beam, Object.assign(new Event(eventName, { bubbles: true }), {
      animationName: "pwragent-thinking-scanner-sweep",
    }));
    if (initialStartDispatched) {
      startAnimation();
    }
    expect(getAnimations).toHaveBeenCalledTimes(1);

    // Cancellation clears the old animation's startTime before replacement.
    animation.startTime = null;
    animation = { startTime: 900 };
    startAnimation();

    expect(container.querySelector(".thinking-scanner__beam")).toBe(beam);
    expect(animation.startTime).toBe(0);
    expect(getAnimations).toHaveBeenCalledTimes(2);
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    // Infinite sweep iterations must stay entirely on the compositor.
    const iterationEventName = "AnimationEvent" in window ? "animationiteration" : "webkitAnimationIteration";
    for (let iteration = 0; iteration < 10; iteration++) {
      fireEvent(beam, new Event(iterationEventName, { bubbles: true }));
    }
    expect(getAnimations).toHaveBeenCalledTimes(2);
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
