import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

const electronMock = vi.hoisted(() => ({
  fromId: vi.fn(),
  getCursorScreenPoint: vi.fn(),
  getDisplayMatching: vi.fn(),
  getDisplayNearestPoint: vi.fn(),
  getFocusedWindow: vi.fn(),
  getPrimaryDisplay: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromId: electronMock.fromId,
    getFocusedWindow: electronMock.getFocusedWindow,
  },
  screen: {
    getCursorScreenPoint: electronMock.getCursorScreenPoint,
    getDisplayMatching: electronMock.getDisplayMatching,
    getDisplayNearestPoint: electronMock.getDisplayNearestPoint,
    getPrimaryDisplay: electronMock.getPrimaryDisplay,
  },
}));

describe("window placement", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.fromId.mockReset();
    electronMock.getCursorScreenPoint.mockReset();
    electronMock.getDisplayMatching.mockReset();
    electronMock.getDisplayNearestPoint.mockReset();
    electronMock.getFocusedWindow.mockReset();
    electronMock.getPrimaryDisplay.mockReset();
  });

  it("centers a new window on the explicit source bounds display", async () => {
    const sourceBounds = { x: 2200, y: 100, width: 900, height: 700 };
    electronMock.getDisplayMatching.mockReturnValue({
      workArea: { x: 1920, y: 0, width: 1920, height: 1080 },
    });

    const { placementForSourceDisplay } = await import("../window-placement");

    expect(
      placementForSourceDisplay(920, 760, { sourceBounds }),
    ).toEqual({
      x: 2420,
      y: 160,
    });
    expect(electronMock.getDisplayMatching).toHaveBeenCalledWith(sourceBounds);
  });

  it("centers a new window on the source window display", async () => {
    const sourceWindow = {
      getBounds: vi.fn(() => ({ x: 3840, y: 0, width: 1200, height: 800 })),
      isDestroyed: vi.fn(() => false),
    };
    electronMock.fromId.mockReturnValue(sourceWindow);
    electronMock.getDisplayMatching.mockReturnValue({
      workArea: { x: 3840, y: 0, width: 1920, height: 1080 },
    });

    const { placementForSourceDisplay } = await import("../window-placement");

    expect(
      placementForSourceDisplay(1040, 760, { sourceWindowId: 41 }),
    ).toEqual({
      x: 4280,
      y: 160,
    });
    expect(electronMock.getDisplayMatching).toHaveBeenCalledWith({
      x: 3840,
      y: 0,
      width: 1200,
      height: 800,
    });
  });

  it("repositions an existing window onto the source display before focusing", async () => {
    const sourceWindow = {
      getBounds: vi.fn(() => ({ x: 2200, y: 100, width: 900, height: 700 })),
      isDestroyed: vi.fn(() => false),
    };
    const targetWindow = {
      getBounds: vi.fn(() => ({ x: 0, y: 0, width: 980, height: 720 })),
      setPosition: vi.fn(),
    };
    electronMock.getDisplayMatching.mockReturnValue({
      workArea: { x: 1920, y: 0, width: 1920, height: 1080 },
    });

    const { positionWindowForSourceDisplay } = await import("../window-placement");
    positionWindowForSourceDisplay(targetWindow as unknown as BrowserWindow, {
      sourceWindow: sourceWindow as unknown as BrowserWindow,
    });

    expect(targetWindow.setPosition).toHaveBeenCalledWith(2390, 180, false);
  });

  it("centers the main window on the cursor display at launch", async () => {
    const cursor = { x: 4000, y: 300 };
    electronMock.getCursorScreenPoint.mockReturnValue(cursor);
    electronMock.getDisplayNearestPoint.mockReturnValue({
      workArea: { x: 3840, y: 0, width: 1920, height: 1080 },
    });

    const { placementForCursorDisplay } = await import("../window-placement");

    expect(placementForCursorDisplay(1440, 960)).toEqual({
      x: 4080,
      y: 60,
    });
    expect(electronMock.getDisplayNearestPoint).toHaveBeenCalledWith(cursor);
  });
});
