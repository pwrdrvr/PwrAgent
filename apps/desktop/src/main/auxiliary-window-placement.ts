import {
  BrowserWindow,
  screen,
  type Display,
} from "electron";

type WindowPositionOptions = { x: number; y: number };

export function windowCenteredOnCursorDisplay(
  width: number,
  height: number,
): WindowPositionOptions {
  return centeredWindowBoundsOnDisplay(
    width,
    height,
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),
  );
}

export function auxiliaryWindowPlacementOptions(
  width: number,
  height: number,
): WindowPositionOptions {
  return centeredWindowBoundsOnDisplay(
    width,
    height,
    sourceDisplayForFocusedWindow(),
  );
}

export function positionAuxiliaryWindowOnSourceDisplay(
  window: BrowserWindow,
): void {
  const bounds = window.getBounds();
  const position = auxiliaryWindowPlacementOptions(bounds.width, bounds.height);
  window.setPosition(position.x, position.y, false);
}

function centeredWindowBoundsOnDisplay(
  width: number,
  height: number,
  display: Display,
): WindowPositionOptions {
  const workArea = display.workArea;
  return {
    x: Math.round(workArea.x + Math.max(0, workArea.width - width) / 2),
    y: Math.round(workArea.y + Math.max(0, workArea.height - height) / 2),
  };
}

function sourceDisplayForFocusedWindow(): Display {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow && !focusedWindow.isDestroyed()) {
    return screen.getDisplayMatching(focusedWindow.getBounds());
  }

  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}
