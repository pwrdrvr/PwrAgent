import { cleanup, render } from "@testing-library/react";
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
});
