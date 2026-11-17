import path from "node:path";
import fc from "fast-check";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { sizeWindowAtZoom, type WindowZoomSize } from "./fixtures/window-zoom";

/**
 * The full layout leaves the root no scroll offset to keep. Below 820 CSS px
 * the shell stacks and the body scrolls. An operator who scrolls there at
 * high zoom and then zooms back out must get the shell back at its place.
 * `body` is `overflow: hidden` again by then, so the wheel cannot undo an
 * offset that survives.
 *
 * On win32 and linux one did survive. `.app-shell` clears the painted title
 * strip with `margin-top`, and that margin collapsed through `#root` and
 * `body`, so the document overflowed the viewport by the strip's 40px. The
 * shell then stayed 40px up under the strip, with a band below it. In
 * headless Chromium the stylesheet before `#root { display: flow-root }`
 * fails this property for both platform values.
 *
 * The platform is an input rather than the host's. Only `data-platform`
 * selects the strip's offset rule, so every lane checks all three.
 */
const PLATFORMS = ["linux", "win32", "darwin"] as const;
const WIDE = { width: 1440, height: 900 };

test("leaves the app shell unscrolled after a scroll in the stacked high-zoom layout", async ({ browserName: _browserName }) => {
  test.setTimeout(120_000);
  const app = await launchElectronApp({
    fixturePath: path.resolve(import.meta.dirname, "fixtures/smoke/replay.fixture.json"),
    windowSize: WIDE,
  });
  const hostPlatform = await app.window.evaluate(() => document.documentElement.dataset.platform);
  const sizeWindow = (size: WindowZoomSize) => sizeWindowAtZoom(app.electronApp, app.window, size);
  // Cases whose stacked page fit the viewport, named in the failure when
  // too many of them leave the property without enough scrolled cases.
  const fitted: string[] = [];
  try {
    await expect(app.window.locator(".app-shell")).toBeVisible();
    await fc.assert(fc.asyncProperty(fc.record({
      platform: fc.constantFrom(...PLATFORMS),
      // 960 CSS px at 118% and above is narrower than the 820px breakpoint.
      narrow: fc.record({
        width: fc.integer({ min: 960, max: 1440 }),
        height: fc.integer({ min: 640, max: 900 }),
        zoom: fc.integer({ min: 180, max: 320 }),
      }),
      scrolled: fc.double({ min: 0.05, max: 1, noNaN: true }),
      wide: fc.record({ width: fc.integer({ min: 960, max: 1440 }), height: fc.integer({ min: 640, max: 900 }) }),
    }), async ({ platform, narrow, scrolled, wide }) => {
      await app.window.evaluate((value) => { document.documentElement.dataset.platform = value; }, platform);
      await sizeWindow(narrow);
      const stackedOffset = await app.window.evaluate((fraction) => {
        const root = document.scrollingElement;
        if (!root) throw new Error("The document has no scrolling element.");
        root.scrollTop = (root.scrollHeight - root.clientHeight) * fraction;
        return root.scrollTop;
      }, scrolled);
      // A stacked page that fits its viewport has no offset to keep, so the
      // case checks nothing. The smoke fixture's stacked page is short: on
      // the Windows runner of main run 44122380675 it fit a 533x355 CSS
      // viewport (180% of 960x640) and overflowed at 300%. fast-check counts
      // only cases that pass this, and `maxSkipsPerRun` fails the property
      // when too few of them scroll.
      if (stackedOffset === 0) fitted.push(`${platform} ${narrow.width}x${narrow.height} at ${narrow.zoom}%`);
      fc.pre(stackedOffset > 0);
      await sizeWindow({ ...wide, zoom: 100 });
      const offsets = await app.window.evaluate(() => {
        const shell = document.querySelector(".app-shell");
        if (!shell) throw new Error("The app shell is gone.");
        const scrolled: string[] = [];
        for (let node: Element | null = shell.parentElement; node; node = node.parentElement) {
          if (node.scrollTop !== 0 || node.scrollLeft !== 0) {
            scrolled.push(`${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""} at ${node.scrollLeft},${node.scrollTop}`);
          }
        }
        const root = document.scrollingElement;
        if (root && (root.scrollTop !== 0 || root.scrollLeft !== 0)) scrolled.push(`the viewport at ${root.scrollLeft},${root.scrollTop}`);
        return scrolled;
      });
      expect(offsets, `${platform}: ${narrow.width}x${narrow.height} at ${narrow.zoom}%, then ${wide.width}x${wide.height} at 100%`).toEqual([]);
    }), { numRuns: 8, maxSkipsPerRun: 4, examples: [
      [{ platform: "linux", narrow: { width: 960, height: 640, zoom: 300 }, scrolled: 1, wide: WIDE }],
      [{ platform: "win32", narrow: { width: 960, height: 640, zoom: 300 }, scrolled: 1, wide: WIDE }],
    ] });
  } catch (error) {
    if (fitted.length === 0) throw error;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n`
      + `Stacked pages that fit their viewport (${fitted.length}): ${fitted.join("; ")}`, { cause: error });
  } finally {
    await app.window.evaluate((value) => {
      if (value) document.documentElement.dataset.platform = value;
      else delete document.documentElement.dataset.platform;
    }, hostPlatform).catch(() => undefined);
    await app.close();
  }
});

