import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StrictMode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeElementVisibility } from "../observe-element-visibility";
import { pendingSpinnerRef } from "../pending-spinner";

class Observer {
  static instances: Observer[] = [];
  targets = new Set<Element>();
  constructor(private callback: IntersectionObserverCallback) {
    Observer.instances.push(this);
  }
  observe = (element: Element) => { this.targets.add(element); };
  unobserve = (element: Element) => { this.targets.delete(element); };
  disconnect = vi.fn(() => this.targets.clear());
  deliver(element: Element, isIntersecting: boolean) {
    this.callback([{ target: element, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

beforeEach(() => {
  Observer.instances = [];
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pending spinner visibility", () => {
  it("shares the PR chip observer, pauses clipped rings and follows document visibility", () => {
    const chip = document.createElement("span");
    const stopChip = observeElementVisibility(chip, vi.fn());
    try {
      const view = render(<><span ref={pendingSpinnerRef} /><span ref={pendingSpinnerRef} /></>);
      const rings = [...view.container.querySelectorAll("span")];
      expect(Observer.instances).toHaveLength(1);
      const observer = Observer.instances[0]!;
      expect(observer.targets.size).toBe(3);
      expect(rings.map((ring) => ring.dataset.spinnerVisible)).toEqual(["false", "false"]);
      observer.deliver(rings[0]!, true);
      observer.deliver(rings[1]!, false);
      expect(rings.map((ring) => ring.dataset.spinnerVisible)).toEqual(["true", "false"]);
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(rings.map((ring) => ring.dataset.spinnerVisible)).toEqual(["false", "false"]);
      vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(rings.map((ring) => ring.dataset.spinnerVisible)).toEqual(["true", "false"]);
      observer.deliver(rings[0]!, false);
      observer.deliver(rings[1]!, true);
      expect(rings.map((ring) => ring.dataset.spinnerVisible)).toEqual(["false", "true"]);
      view.unmount();
      expect([...observer.targets]).toEqual([chip]);
    } finally {
      stopChip();
    }
    expect(Observer.instances[0]!.disconnect).toHaveBeenCalledOnce();
  });

  it("releases Strict Mode refs and restarts after the last ring unmounts", () => {
    const show = (busy: boolean) => <StrictMode>{busy ? <span ref={pendingSpinnerRef} /> : null}</StrictMode>;
    const view = render(show(true));
    expect(Observer.instances.filter((observer) => observer.targets.size)).toHaveLength(1);
    const firstRing = view.container.querySelector("span")!;
    view.rerender(show(false));
    expect(Observer.instances.every((observer) => observer.targets.size === 0)).toBe(true);
    view.rerender(show(true));
    const observer = Observer.instances.at(-1)!;
    const nextRing = view.container.querySelector("span")!;
    observer.deliver(firstRing, true);
    expect(nextRing.dataset.spinnerVisible).toBe("false");
    observer.deliver(nextRing, true);
    expect(nextRing.dataset.spinnerVisible).toBe("true");
    view.unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps the progress signal available without IntersectionObserver", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const view = render(<span ref={pendingSpinnerRef} />);
    expect(view.container.querySelector("span")!.dataset.spinnerVisible).toBe("true");
  });

  it("wires every spinner mount to the shared visibility ref", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../features");
    const files = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".tsx") && !file.split(path.sep).includes("__tests__"));
    let mounts = 0;
    for (const file of files) {
      const source = readFileSync(path.join(root, file), "utf8");
      for (const match of source.matchAll(/<span\b[^>]*\bclassName="pending-spinner\b[^>]*>/g)) {
        expect(match[0], file).toContain("ref={pendingSpinnerRef}");
        mounts++;
      }
    }
    expect(mounts).toBeGreaterThan(0);
  });
});
