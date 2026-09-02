/**
 * Window placement + raise for the native screenshot capture specs.
 *
 * Shared by `readme-screenshots.inspect.spec.ts` and
 * `docs-site-screenshots.inspect.spec.ts`, which both grab the real OS
 * window via `scripts/capture-window.swift`.
 *
 * Why placement matters: `screencapture -l` renders at the backing scale
 * of whichever display the window occupies, and offers no way to ask for
 * 2x. A capture taken while the window sits on a 1x external monitor is
 * silently half resolution. The noise filter does not catch that —
 * half-res pixels are different pixels, so it keeps them — and on
 * 2026-09-01 a run in that state overwrote all 21 committed docs-site
 * PNGs at exactly half size.
 *
 * `capture-window.swift` now refuses to overwrite a destination with a
 * sub-Retina capture, but refusing mid-run is a poor experience when the
 * fix is mechanical. So move the window onto a Retina display first and
 * let the Swift check stay a backstop.
 *
 * The display arithmetic is deliberately split out of the
 * `electronApp.evaluate` callbacks. Playwright serializes those bodies
 * and runs them in the Electron main process, so nothing they reference
 * is importable and nothing they contain is reachable from Vitest — the
 * selection rule that caused the incident above would otherwise have no
 * test at all. The callbacks now only read and write Electron state; the
 * choosing happens here, in plain data, under
 * `__tests__/capture-window-placement.test.ts`.
 */

import type { ElectronApplication } from "@playwright/test";

/** Below this, `screencapture` is not producing a Retina asset. */
export const MINIMUM_RETINA_SCALE_FACTOR = 2;

/** A rectangle in Electron's screen coordinates. */
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * The subset of Electron's `Display` the selection rule uses, reduced to
 * plain JSON so it can cross the `evaluate` boundary and be constructed
 * in a unit test.
 */
export type DisplaySummary = {
  /** Whether this is the machine's built-in panel. */
  internal: boolean;
  scaleFactor: number;
  workArea: Rect;
};

/**
 * Choose the display to capture on.
 *
 * Only Retina displays are eligible — a 1x display cannot produce the
 * asset we need at all, so a bigger or built-in 1x panel is never the
 * answer. Among those, prefer one the window actually fits on: a window
 * larger than the work area gets pinned to its origin, and macOS may
 * constrain the frame on top of that. Then prefer the built-in panel —
 * on the usual laptop-docked-to-a-1x-monitor setup it is the only
 * Retina display present — then the sharpest, then the largest.
 *
 * Returns `undefined` when no display can produce a Retina capture.
 */
export function pickCaptureDisplay(
  displays: readonly DisplaySummary[],
  windowSize: { width: number; height: number },
  minimumScaleFactor: number = MINIMUM_RETINA_SCALE_FACTOR,
): DisplaySummary | undefined {
  const eligible = displays.filter(
    (display) => display.scaleFactor >= minimumScaleFactor,
  );
  if (eligible.length === 0) return undefined;

  const fits = (display: DisplaySummary): boolean =>
    windowSize.width <= display.workArea.width
    && windowSize.height <= display.workArea.height;

  return [...eligible].sort((a, b) => {
    if (fits(a) !== fits(b)) return fits(a) ? -1 : 1;
    if (a.internal !== b.internal) return a.internal ? -1 : 1;
    if (a.scaleFactor !== b.scaleFactor) return b.scaleFactor - a.scaleFactor;
    return b.workArea.width * b.workArea.height
      - a.workArea.width * a.workArea.height;
  })[0];
}

/**
 * Center `size` inside `workArea`, clamped to the work area's origin.
 *
 * Never returns a different width/height than it was given: the
 * committed PNGs depend on the window size each spec sets, so a window
 * too large for the display is positioned rather than shrunk.
 */
export function centeredIn(
  workArea: Rect,
  size: { width: number; height: number },
): Rect {
  return {
    x: Math.round(workArea.x + Math.max(0, (workArea.width - size.width) / 2)),
    y: Math.round(workArea.y + Math.max(0, (workArea.height - size.height) / 2)),
    width: size.width,
    height: size.height,
  };
}

/** Whether `size` is too large for `workArea` in either axis. */
export function overflowsWorkArea(
  workArea: Rect,
  size: { width: number; height: number },
): boolean {
  return size.width > workArea.width || size.height > workArea.height;
}

/**
 * Thrown when the window a capture targets cannot be resolved.
 *
 * Silence is the wrong answer here: `capture-window.swift` matches the
 * OS window list independently, so a helper that quietly did nothing
 * would let the capture proceed against a window that was never placed
 * or raised — the exact failure this module exists to prevent, minus the
 * evidence.
 */
export class CaptureWindowNotFoundError extends Error {
  constructor(titleSubstring: string | undefined, titles: string[]) {
    super(
      titleSubstring === undefined
        ? "no Electron window to capture (BrowserWindow.getAllWindows() is empty)"
        : `no Electron window whose title contains "${titleSubstring}". `
          + `Open windows: ${titles.map((t) => `"${t}"`).join(", ") || "none"}. `
          + "This must match the substring passed to capture-window.swift "
          + "--title=, which matches case-insensitively.",
    );
    this.name = "CaptureWindowNotFoundError";
  }
}

/**
 * Report each distinct placement outcome once rather than on all ~21
 * captures of a run — but re-report when the outcome *changes*, since a
 * display can be connected or disconnected mid-run and a latch keyed on
 * "have we ever printed" would hide exactly that.
 */
let lastReported: string | undefined;

function report(line: string, level: "log" | "warn"): void {
  if (lastReported === line) return;
  lastReported = line;
  if (level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * Move the app window onto a Retina display and bring it forward so
 * `screencapture`'s window-list lookup resolves it.
 *
 * Without the raise, a recently-launched Electron window can stay behind
 * whatever the user/IDE had focused, and `screencapture -l` silently
 * captures a stale frame or an off-screen position.
 *
 * Both steps run before every capture, not just at launch: a display can
 * be connected or disconnected mid-run, and the operation is cheap and
 * idempotent.
 *
 * Pass `titleSubstring` when the capture targets an auxiliary window —
 * it must match what goes to `capture-window.swift --title=`, or the
 * main window gets placed while a different one is photographed. The
 * match here is case-insensitive, as it is on the Swift side.
 *
 * @throws {CaptureWindowNotFoundError} when no window matches.
 */
export async function bringToFront(
  electronApp: ElectronApplication,
  titleSubstring?: string,
): Promise<void> {
  // Read. Resolve the window once and return its id, so the write below
  // acts on the same window even if the window list changes in between.
  const snapshot = await electronApp.evaluate(({ BrowserWindow, screen }, needle) => {
    const windows = BrowserWindow.getAllWindows();
    const win = needle === undefined
      ? windows[0]
      : windows.find((candidate) =>
        candidate.getTitle().toLowerCase().includes(needle.toLowerCase()),
      );
    if (!win) {
      return { id: null, titles: windows.map((w) => w.getTitle()) };
    }
    return {
      id: win.id,
      titles: [] as string[],
      bounds: win.getBounds(),
      displays: screen.getAllDisplays().map((display) => ({
        internal: display.internal,
        scaleFactor: display.scaleFactor,
        workArea: display.workArea,
      })),
    };
  }, titleSubstring);

  if (snapshot.id === null) {
    throw new CaptureWindowNotFoundError(titleSubstring, snapshot.titles);
  }

  // Choose. Pure, and the only part of this file a unit test can reach.
  const bounds = snapshot.bounds!;
  const displays = snapshot.displays!;
  const target = pickCaptureDisplay(displays, bounds);

  if (!target) {
    // Not fatal here — capture-window.swift refuses per capture with a
    // message naming the observed scale, and `--allow-low-dpi` exists
    // for anyone who deliberately wants a 1x asset.
    report(
      "[capture] no Retina display attached (scale factors: "
      + `${displays.map((d) => d.scaleFactor).join(", ") || "none"}). Captures `
      + "will be below 2x and capture-window.swift will refuse them.",
      "warn",
    );
  }

  // Write. Place (when we have somewhere to place it) and raise, then
  // read back where the window actually landed — `setBounds` is
  // fire-and-forget and macOS can constrain the frame, so the run's only
  // placement diagnostic should be an observation, not a claim.
  const placed = await electronApp.evaluate(
    ({ BrowserWindow, screen }, options) => {
      const win = BrowserWindow.fromId(options.id);
      if (!win) return null;
      if (options.rect) win.setBounds(options.rect);
      win.show();
      win.focus();
      win.moveTop();
      // Park the pointer outside the content area.
      //
      // Moving the window slides it out from under the OS cursor, which
      // does not move with it — so whatever now sits at the cursor's
      // screen position picks up `:hover`. That is how a Settings
      // capture ended up with two nav items highlighted: the spec
      // clicked "Profiles" while the window was at x=2056, placement
      // moved it to x=28, and the stationary cursor landed on
      // "General", whose `:hover` rule paints the same box as
      // `.is-active`. Which element gets hit depends on how far the
      // window happened to move, so it is nondeterministic — the same
      // failure mode as the update toast this pipeline already
      // suppresses. No capture drives hover deliberately.
      win.webContents.sendInputEvent({ type: "mouseMove", x: -10, y: -10 });
      const observed = win.getBounds();
      const display = screen.getDisplayMatching(observed);
      return {
        bounds: observed,
        internal: display.internal,
        scaleFactor: display.scaleFactor,
      };
    },
    {
      id: snapshot.id,
      rect: target ? centeredIn(target.workArea, bounds) : null,
    },
  );

  if (placed) {
    report(
      `[capture] window on ${placed.internal ? "built-in" : "external"} `
      + `${placed.scaleFactor}x display at ${placed.bounds.width}x`
      + `${placed.bounds.height}`,
      placed.scaleFactor >= MINIMUM_RETINA_SCALE_FACTOR ? "log" : "warn",
    );
    if (target && overflowsWorkArea(target.workArea, bounds)) {
      // The capture itself is not clipped — `screencapture -l` composites
      // the window from the window server, so rows past the screen edge
      // still come through (verified against an off-screen probe). What
      // is lost is the centering, and macOS may constrain the frame,
      // which would change the committed PNG's dimensions.
      report(
        `[capture] window (${bounds.width}x${bounds.height}) is larger than `
        + `the ${target.workArea.width}x${target.workArea.height} work area; `
        + "it is pinned to the work-area origin rather than centered. The "
        + "capture is still complete, but macOS may constrain the frame.",
        "warn",
      );
    }
  }

  // Give the compositor a tick to actually raise the window (and settle
  // the move) before screencapture inspects the on-screen window list.
  await new Promise((resolve) => setTimeout(resolve, 500));
}
