import { describe, expect, it } from "vitest";
import { clampFloatingPanelRect } from "../useFloatingPanelRect";

const limits = { minWidth: 300, minHeight: 240, topReserve: 44 };
const viewport = { width: 1000, height: 800 };

describe("clampFloatingPanelRect", () => {
  it("keeps a panel that fits where it is", () => {
    expect(clampFloatingPanelRect({ x: 100, y: 100, width: 400, height: 500 }, viewport, limits))
      .toEqual({ x: 100, y: 100, width: 400, height: 500 });
  });

  it("pulls a panel dragged past an edge back inside the window", () => {
    expect(clampFloatingPanelRect({ x: 900, y: 700, width: 400, height: 500 }, viewport, limits))
      .toEqual({ x: 600, y: 300, width: 400, height: 500 });
    expect(clampFloatingPanelRect({ x: -50, y: -50, width: 400, height: 500 }, viewport, limits))
      .toEqual({ x: 0, y: 44, width: 400, height: 500 });
  });

  // The title strip holds the macOS window controls inside the renderer, so
  // the panel's handle must never slide up under them.
  it("keeps the handle below the reserved top strip", () => {
    expect(clampFloatingPanelRect({ x: 0, y: 10, width: 400, height: 900 }, viewport, limits))
      .toEqual({ x: 0, y: 44, width: 400, height: 756 });
  });

  it("holds the minimum size and never outgrows the window", () => {
    expect(clampFloatingPanelRect({ x: 0, y: 100, width: 50, height: 50 }, viewport, limits))
      .toMatchObject({ width: 300, height: 240 });
    expect(clampFloatingPanelRect({ x: 0, y: 100, width: 5000, height: 5000 }, viewport, limits))
      .toMatchObject({ x: 0, y: 44, width: 1000, height: 756 });
  });
});
