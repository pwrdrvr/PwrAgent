import type { ElectronApplication, Page } from "@playwright/test";

export type WindowZoomSize = { width: number; height: number; zoom: number };

/**
 * Sizes the first window's content area and sets its zoom, then waits for
 * the renderer to see the CSS viewport they produce. Returns that viewport.
 */
export async function sizeWindowAtZoom(
  electronApp: ElectronApplication,
  window: Page,
  size: WindowZoomSize,
): Promise<{ width: number; height: number }> {
  await electronApp.evaluate(({ BrowserWindow }, next) => {
    const browserWindow = BrowserWindow.getAllWindows()[0];
    if (!browserWindow) throw new Error("Expected the PwrAgent window.");
    browserWindow.setMinimumSize(0, 0);
    browserWindow.setContentSize(next.width, next.height);
    browserWindow.webContents.setZoomFactor(next.zoom / 100);
  }, size);
  return settledViewport(window, { width: size.width * 100 / size.zoom, height: size.height * 100 / size.zoom });
}

/**
 * Waits for the resize and zoom to reach the renderer: the CSS viewport is
 * within a pixel of the expected size, rounded either way. A window manager
 * may adjust a requested size, and callers measure the real viewport, so
 * after 50 frames a viewport that holds still is accepted as it is.
 */
export async function settledViewport(
  window: Page,
  expected: { width: number; height: number },
): Promise<{ width: number; height: number }> {
  const read = () => window.evaluate(() => new Promise<{ width: number; height: number }>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve({ width: innerWidth, height: innerHeight })));
  }));
  let observed = await read();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (Math.abs(observed.width - expected.width) <= 1.5 && Math.abs(observed.height - expected.height) <= 1.5) {
      return observed;
    }
    observed = await read();
  }
  const steady = await read();
  if (steady.width === observed.width && steady.height === observed.height) return steady;
  throw new Error(`The viewport kept changing, last ${steady.width}x${steady.height}; expected about ${Math.round(expected.width)}x${Math.round(expected.height)}.`);
}
