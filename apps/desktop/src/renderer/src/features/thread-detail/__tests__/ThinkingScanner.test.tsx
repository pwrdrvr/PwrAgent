import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingScanner } from "../ThinkingScanner";

describe("ThinkingScanner", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("syncs scanners with a local animation phase and no runtime clock", () => {
    vi.spyOn(performance, "now").mockReturnValue(2250);
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
    expect(
      scanners.map((scanner) => scanner.style.getPropertyValue("--thinking-scanner-delay"))
    ).toEqual(["-450ms", "-450ms"]);
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
