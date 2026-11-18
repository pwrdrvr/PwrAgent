import { fireEvent, render } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { FixtureDirectoriesList as DirectoriesList } from "../../../test/navigation-presentation-fixture";
import { buildLargeDirectoryFixture } from "./fixtures/directory-performance";

function renderList() {
  const { directories, threads } = buildLargeDirectoryFixture({ pinnedThreadsPerDirectory: 1, unpinnedThreadsPerDirectory: 1 });
  return render(<DirectoriesList directories={directories} threads={threads}
    onOpenLaunchpad={async () => undefined}
    onOpenThreadContextMenu={() => undefined}
    onSelectThread={() => undefined}
  />);
}

it("batches active-tail geometry per frame and leaves anchor space while it is visible", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 40 }), fc.integer({ min: 1, max: 100 }), (scrolls, extra) => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    const view = renderList();
    const list = view.container.querySelector<HTMLDivElement>(".directory-list")!;
    const tail = list.querySelector<HTMLDivElement>(".directory-list__jump-tail")!;
    let bottom = 400;
    let top = bottom + extra;
    let hidden = false;
    const tailHeight = vi.spyOn(tail, "offsetHeight", "get").mockImplementation(() => hidden ? 0 : Number.parseInt(tail.style.height, 10) || 0);
    const listRect = vi.spyOn(list, "getBoundingClientRect").mockImplementation(() => ({ bottom }) as DOMRect);
    const tailRect = vi.spyOn(tail, "getBoundingClientRect").mockImplementation(() => ({ top }) as DOMRect);
    const burst = () => {
      for (let index = 0; index < scrolls; index++) fireEvent.scroll(list);
    };
    const paint = () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    };

    try {
      // Ordinary scrolls have no jump spacer and require no layout work.
      burst();
      expect(tailHeight).toHaveBeenCalledTimes(0);
      expect(frames.size).toBe(0);

      tail.style.height = `${extra}px`;
      burst();
      expect(frames.size).toBe(1);
      expect(listRect).toHaveBeenCalledTimes(0);
      // Delayed content or a viewport resize can bring the tail back into view
      // before the scroll frame. Preserve the now-visible scroll extent.
      bottom = top + extra;
      paint();
      expect(tail.style.height).toBe(`${extra}px`);
      expect(tailHeight).toHaveBeenCalledTimes(1);
      expect(listRect).toHaveBeenCalledTimes(1);
      expect(tailRect).toHaveBeenCalledTimes(1);

      burst();
      hidden = true;
      paint();
      expect(tail.style.height).toBe(`${extra}px`);
      expect(listRect).toHaveBeenCalledTimes(1);

      hidden = false;
      burst();
      top = bottom;
      paint();
      expect(tail.style.height).toBe("");
      expect(listRect).toHaveBeenCalledTimes(2);
      expect(tailRect).toHaveBeenCalledTimes(2);
      burst();
      expect(tailHeight).toHaveBeenCalledTimes(3);
      expect(frames.size).toBe(0);

      tail.style.height = `${extra}px`;
      burst();
      expect(frames.size).toBe(1);
      view.unmount();
      expect(frames.size).toBe(0);
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  }), { numRuns: 25 });
});
