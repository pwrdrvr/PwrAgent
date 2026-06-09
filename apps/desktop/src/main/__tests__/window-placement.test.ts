import { afterEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => {
  const primaryDisplay = {
    id: 1,
    workArea: { x: 0, y: 0, width: 1440, height: 900 },
  };
  const externalDisplay = {
    id: 2,
    workArea: { x: 1440, y: -180, width: 2560, height: 1440 },
  };

  return {
    externalDisplay,
    fromId: vi.fn(),
    getCursorScreenPoint: vi.fn(),
    getDisplayMatching: vi.fn(),
    getDisplayNearestPoint: vi.fn(),
    getFocusedWindow: vi.fn(),
    primaryDisplay,
  };
});

vi.mock("electron", () => ({
  BrowserWindow: {
    fromId: electronMock.fromId,
    getFocusedWindow: electronMock.getFocusedWindow,
  },
  screen: {
    getCursorScreenPoint: electronMock.getCursorScreenPoint,
    getDisplayMatching: electronMock.getDisplayMatching,
    getDisplayNearestPoint: electronMock.getDisplayNearestPoint,
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("window placement", () => {
  it("centers windows on the focused window display", async () => {
    electronMock.getFocusedWindow.mockReturnValue({
      getBounds: () => ({ x: 1600, y: 0, width: 900, height: 700 }),
      isDestroyed: () => false,
    });
    electronMock.getDisplayMatching.mockReturnValue(electronMock.externalDisplay);

    const { centeredWindowPlacementOptions } = await import(
      "../window-placement"
    );

    expect(centeredWindowPlacementOptions(1000, 500)).toEqual({
      x: 2220,
      y: 290,
    });
  });

  it("falls back to the cursor display when there is no source window", async () => {
    electronMock.getFocusedWindow.mockReturnValue(null);
    electronMock.getCursorScreenPoint.mockReturnValue({ x: 1700, y: 100 });
    electronMock.getDisplayNearestPoint.mockReturnValue(
      electronMock.externalDisplay,
    );

    const { centeredWindowPlacementOptions } = await import(
      "../window-placement"
    );

    expect(centeredWindowPlacementOptions(1440, 960)).toEqual({
      x: 2000,
      y: 60,
    });
    expect(electronMock.getDisplayNearestPoint).toHaveBeenCalledWith({
      x: 1700,
      y: 100,
    });
  });

  it("can skip focused-window placement for first launch", async () => {
    electronMock.getFocusedWindow.mockReturnValue({
      getBounds: () => ({ x: 0, y: 0, width: 900, height: 700 }),
      isDestroyed: () => false,
    });
    electronMock.getCursorScreenPoint.mockReturnValue({ x: 1700, y: 100 });
    electronMock.getDisplayNearestPoint.mockReturnValue(
      electronMock.externalDisplay,
    );

    const { centeredWindowPlacementOptions } = await import(
      "../window-placement"
    );

    expect(
      centeredWindowPlacementOptions(1440, 960, {
        preferFocusedWindow: false,
      }),
    ).toEqual({
      x: 2000,
      y: 60,
    });
    expect(electronMock.getFocusedWindow).not.toHaveBeenCalled();
  });
});
