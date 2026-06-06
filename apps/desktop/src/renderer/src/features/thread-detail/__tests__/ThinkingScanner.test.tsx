import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThinkingScanner } from "../ThinkingScanner";

describe("ThinkingScanner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("drives every scanner from one shared 30 FPS clock", () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");

    const { unmount } = render(
      <>
        <ThinkingScanner />
        <ThinkingScanner compact />
      </>
    );

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(Number(setTimeoutSpy.mock.calls[0]?.[1])).toBeCloseTo(1000 / 30);
    expect(
      document.documentElement.style.getPropertyValue("--thinking-scanner-progress")
    ).not.toBe("");

    vi.advanceTimersByTime(34);

    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(Number(setTimeoutSpy.mock.calls[1]?.[1])).toBeCloseTo(1000 / 30);

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });
});
