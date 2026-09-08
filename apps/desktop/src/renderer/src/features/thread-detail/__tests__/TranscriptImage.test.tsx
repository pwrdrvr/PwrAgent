import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TranscriptImage } from "../TranscriptImage";

afterEach(() => vi.unstubAllGlobals());

it("defers an image URL until it intersects the viewport and resets demand for a new source", () => {
  const callbacks: IntersectionObserverCallback[] = [];
  const disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
    observe = vi.fn();
    disconnect = disconnect;
  });
  const first = "pwragent-image://federation/owner/first";
  const second = "pwragent-image://federation/owner/second";
  const mounted = render(<TranscriptImage src={first} alt="Screenshot" loading="lazy" />);
  const image = mounted.getByRole("img");
  expect(image.getAttribute("src")).toBeNull();
  const report = (isIntersecting: boolean) => act(() => callbacks.at(-1)!([
    { isIntersecting } as IntersectionObserverEntry,
  ], {} as IntersectionObserver));
  report(false);
  expect(image.getAttribute("src")).toBeNull();
  report(true);
  expect(image.getAttribute("src")).toBe(first);
  mounted.rerender(<TranscriptImage src={second} alt="Screenshot" loading="lazy" />);
  expect(image.getAttribute("src")).toBeNull();
  report(true);
  expect(image.getAttribute("src")).toBe(second);
  mounted.unmount();
  expect(disconnect).toHaveBeenCalled();
});
