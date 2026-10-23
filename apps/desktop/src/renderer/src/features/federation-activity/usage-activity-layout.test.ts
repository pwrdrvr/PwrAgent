import { describe, expect, it } from "vitest";
import { sliceCardLeft } from "./usage-activity-layout";

const plot = { left: 100, width: 600 };

describe("slice card placement", () => {
  it("sits beside its bar on the side with more room", () => {
    expect(sliceCardLeft(plot, { left: 120, right: 160 }, 280)).toBe(68);
    expect(sliceCardLeft(plot, { left: 600, right: 640 }, 280)).toBe(212);
  });

  it("stays inside the plot when a bar leaves no room on either side", () => {
    // One slice spanning the plot: the card used to start 8px past its right edge.
    expect(sliceCardLeft(plot, { left: 100, right: 700 }, 280)).toBe(320);
    expect(sliceCardLeft(plot, { left: 280, right: 500 }, 280)).toBe(320);
    expect(sliceCardLeft(plot, { left: 380, right: 640 }, 280)).toBe(0);
    expect(sliceCardLeft({ left: 0, width: 200 }, { left: 0, right: 200 }, 280)).toBe(0);
  });
});
