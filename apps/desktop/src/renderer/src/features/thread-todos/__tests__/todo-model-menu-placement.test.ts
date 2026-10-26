import { describe, expect, it } from "vitest";
import { placeTodoModelMenu } from "../todo-model-menu-placement";

const base = { trigger: { left: 200, top: 100, bottom: 122 }, menuHeight: 300, menuWidth: 340, viewportHeight: 800, viewportWidth: 1200 };

describe("to-do model menu placement", () => {
  it("opens below when the whole menu fits", () => {
    expect(placeTodoModelMenu(base)).toEqual({ left: 200, top: 128, maxHeight: 664 });
  });

  it("flips above a chip at the bottom of the viewport", () => {
    const result = placeTodoModelMenu({ ...base, trigger: { left: 200, top: 768, bottom: 790 } });
    expect(result).toEqual({ left: 200, top: 462, maxHeight: 754 });
  });

  it("re-measures placement when async recents make the menu taller", () => {
    const input = { ...base, trigger: { left: 200, top: 560, bottom: 582 } };
    expect(placeTodoModelMenu({ ...input, menuHeight: 150 }).top).toBe(588);
    expect(placeTodoModelMenu({ ...input, menuHeight: 300 }).top).toBe(254);
  });

  it.each([
    { top: -100, bottom: -78, height: 800 },
    { top: 850, bottom: 872, height: 800 },
    { top: 220, bottom: 242, height: 400 },
    { top: 40, bottom: 62, height: 100 },
  ])("clamps a tall menu for trigger $top/$bottom in a $height viewport", ({ top, bottom, height }) => {
    const result = placeTodoModelMenu({ ...base, trigger: { left: 1180, top, bottom }, menuHeight: 1000, viewportHeight: height });
    expect(result.top).toBeGreaterThanOrEqual(8);
    expect(result.maxHeight).toBeGreaterThanOrEqual(Math.min(120, height - 16));
    expect(result.top + Math.min(1000, result.maxHeight)).toBeLessThanOrEqual(height - 8);
    expect(result.left).toBe(852);
  });
});
