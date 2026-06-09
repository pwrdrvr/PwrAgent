import {
  BrowserWindow,
  screen,
  type BrowserWindowConstructorOptions,
  type Display,
  type Rectangle,
} from "electron";

type PlacementSource = {
  sourceBounds?: Rectangle;
  sourceWindowId?: number;
  preferFocusedWindow?: boolean;
};

export function centeredWindowPlacementOptions(
  width: number,
  height: number,
  source: PlacementSource = {},
): Pick<BrowserWindowConstructorOptions, "x" | "y"> {
  const display = resolvePlacementDisplay(source);
  const { x, y } = centeredWindowBoundsOnDisplay(width, height, display);
  return { x, y };
}

export function centeredWindowBoundsOnDisplay(
  width: number,
  height: number,
  display: Display,
): { x: number; y: number } {
  const wa = display.workArea;
  return {
    x: Math.round(wa.x + Math.max(0, wa.width - width) / 2),
    y: Math.round(wa.y + Math.max(0, wa.height - height) / 2),
  };
}

function resolvePlacementDisplay(source: PlacementSource): Display {
  if (source.sourceBounds !== undefined) {
    return screen.getDisplayMatching(source.sourceBounds);
  }

  const sourceWindow =
    source.sourceWindowId !== undefined
      ? BrowserWindow.fromId(source.sourceWindowId)
      : source.preferFocusedWindow === false
        ? undefined
        : BrowserWindow.getFocusedWindow();
  if (sourceWindow && !sourceWindow.isDestroyed()) {
    return screen.getDisplayMatching(sourceWindow.getBounds());
  }

  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}
