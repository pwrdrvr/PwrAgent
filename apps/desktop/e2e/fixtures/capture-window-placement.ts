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
 */

import type { ElectronApplication } from "@playwright/test";

/** Below this, `screencapture` is not producing a Retina asset. */
const MINIMUM_RETINA_SCALE_FACTOR = 2;

export type RetinaPlacement =
  | {
      moved: true;
      /** Whether the chosen display is the built-in panel. */
      internal: boolean;
      scaleFactor: number;
      /** True when the window is larger than the display's work area. */
      overflows: boolean;
    }
  | {
      moved: false;
      reason: "no-window" | "no-retina-display";
      /** `scaleFactor`s that were available, for the warning message. */
      available: number[];
    };

/**
 * Center the app window on the highest-backing-scale display available.
 *
 * Prefers the built-in panel when it is Retina — on a laptop docked to a
 * 1x external monitor (the common setup here) that is the display that
 * can actually produce a 2x capture.
 *
 * Never resizes: the committed PNGs depend on the window size each spec
 * sets, so a window larger than the target work area is positioned at the
 * work area's origin and reported via `overflows` rather than shrunk.
 */
export async function moveWindowToRetinaDisplay(
  electronApp: ElectronApplication,
  titleSubstring?: string,
): Promise<RetinaPlacement> {
  return await electronApp.evaluate(
    ({ BrowserWindow, screen }, options): RetinaPlacement => {
      const windows = BrowserWindow.getAllWindows();
      // Match `capture-window.swift --title=`: an auxiliary window such as
      // Messaging Activity is not windows[0], and placing the main window
      // does nothing for a capture aimed at a different one.
      const win = options.titleSubstring === undefined
        ? windows[0]
        : windows.find((candidate) =>
          candidate.getTitle().includes(options.titleSubstring as string),
        );
      if (!win) return { moved: false, reason: "no-window", available: [] };

      const displays = screen.getAllDisplays();
      const retina = displays.filter(
        (display) => display.scaleFactor >= options.minimumScaleFactor,
      );
      if (retina.length === 0) {
        return {
          moved: false,
          reason: "no-retina-display",
          available: displays.map((display) => display.scaleFactor),
        };
      }

      // Built-in panel first, then sharpest, then largest.
      const target = retina.sort((a, b) => {
        if (a.internal !== b.internal) return a.internal ? -1 : 1;
        if (a.scaleFactor !== b.scaleFactor) return b.scaleFactor - a.scaleFactor;
        return b.workArea.width * b.workArea.height
          - a.workArea.width * a.workArea.height;
      })[0];

      const { workArea } = target;
      const bounds = win.getBounds();
      const overflows =
        bounds.width > workArea.width || bounds.height > workArea.height;

      win.setBounds({
        x: Math.round(
          workArea.x + Math.max(0, (workArea.width - bounds.width) / 2),
        ),
        y: Math.round(
          workArea.y + Math.max(0, (workArea.height - bounds.height) / 2),
        ),
        width: bounds.width,
        height: bounds.height,
      });

      return {
        moved: true,
        internal: target.internal,
        scaleFactor: target.scaleFactor,
        overflows,
      };
    },
    { minimumScaleFactor: MINIMUM_RETINA_SCALE_FACTOR, titleSubstring },
  );
}

/** Warn once per process rather than on all ~21 captures in a run. */
let placementReported = false;

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
 * main window gets placed while a different one is photographed.
 */
export async function bringToFront(
  electronApp: ElectronApplication,
  titleSubstring?: string,
): Promise<void> {
  const placement = await moveWindowToRetinaDisplay(electronApp, titleSubstring);

  if (!placementReported) {
    placementReported = true;
    if (!placement.moved && placement.reason === "no-retina-display") {
      // Not fatal here — capture-window.swift refuses per capture with a
      // message naming the observed scale, and `--allow-low-dpi` exists
      // for anyone who deliberately wants a 1x asset.
      console.warn(
        "[capture] no Retina display attached (scale factors: "
        + `${placement.available.join(", ") || "none"}). Captures will be `
        + "below 2x and capture-window.swift will refuse them.",
      );
    } else if (placement.moved) {
      console.log(
        `[capture] window placed on ${placement.internal ? "built-in" : "external"} `
        + `${placement.scaleFactor}x display`,
      );
      if (placement.overflows) {
        console.warn(
          "[capture] window is larger than that display's work area; part of "
          + "it may be clipped. Captures are never resized to fit, because the "
          + "committed PNGs depend on the window size the spec sets.",
        );
      }
    }
  }

  await electronApp.evaluate(({ BrowserWindow }, needle) => {
    const windows = BrowserWindow.getAllWindows();
    const win = needle === undefined
      ? windows[0]
      : windows.find((candidate) => candidate.getTitle().includes(needle));
    if (!win) return;
    win.show();
    win.focus();
    win.moveTop();
  }, titleSubstring);
  // Give the compositor a tick to actually raise the window (and settle
  // the move) before screencapture inspects the on-screen window list.
  await new Promise((resolve) => setTimeout(resolve, 500));
}
