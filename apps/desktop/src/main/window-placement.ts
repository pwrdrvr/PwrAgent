import {
  BrowserWindow,
  screen,
  type Rectangle,
} from "electron";

type WindowPosition = {
  x: number;
  y: number;
};

type WindowBounds = WindowPosition & {
  width: number;
  height: number;
};

export type WindowPlacementSource = {
  sourceBounds?: Rectangle | undefined;
  sourceWindow?: BrowserWindow | null | undefined;
  sourceWindowId?: number | undefined;
};

export function centerWindowOnDisplay(
  width: number,
  height: number,
  display: Electron.Display,
): WindowPosition {
  const { workArea } = display;
  return {
    x: Math.round(workArea.x + Math.max(0, workArea.width - width) / 2),
    y: Math.round(workArea.y + Math.max(0, workArea.height - height) / 2),
  };
}

export function placementForSourceDisplay(
  width: number,
  height: number,
  source: WindowPlacementSource = {},
): WindowPosition {
  return centerWindowOnDisplay(width, height, displayForPlacementSource(source));
}

export function placementForCursorDisplay(
  width: number,
  height: number,
): WindowPosition {
  return centerWindowOnDisplay(
    width,
    height,
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),
  );
}

export function boundsForCursorDisplay(
  width: number,
  height: number,
): WindowBounds {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const fittedWidth = Math.min(width, display.workArea.width);
  const fittedHeight = Math.min(height, display.workArea.height);
  return {
    ...centerWindowOnDisplay(fittedWidth, fittedHeight, display),
    width: fittedWidth,
    height: fittedHeight,
  };
}

export function positionWindowForSourceDisplay(
  window: BrowserWindow,
  source: WindowPlacementSource = {},
): void {
  const bounds = window.getBounds();
  const position = placementForSourceDisplay(bounds.width, bounds.height, source);
  window.setPosition(position.x, position.y, false);
}

export function displayForPlacementSource(
  source: WindowPlacementSource = {},
): Electron.Display {
  if (source.sourceBounds) {
    return screen.getDisplayMatching(source.sourceBounds);
  }

  const sourceWindow =
    source.sourceWindow && !source.sourceWindow.isDestroyed()
      ? source.sourceWindow
      : source.sourceWindowId !== undefined
        ? BrowserWindow.fromId(source.sourceWindowId)
        : BrowserWindow.getFocusedWindow();

  if (sourceWindow && !sourceWindow.isDestroyed()) {
    return screen.getDisplayMatching(sourceWindow.getBounds());
  }

  return screen.getPrimaryDisplay();
}
