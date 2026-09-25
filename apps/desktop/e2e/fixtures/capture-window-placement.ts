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
 * let the Swift check stay a backstop. The displays are probed once, on
 * the first `bringToFront` of a run, and trusted after that. A capture
 * that still comes out below 2x is raised onto the probed display and
 * retried (see `captureWhileFocused`).
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
 * Thrown when the capture window cannot hold focus.
 *
 * `screencapture -l` photographs an inactive window as it looks: grey
 * traffic lights, dimmed chrome, and a smaller shadow, which also changes
 * the PNG's size. The capture still succeeds and the noise filter keeps
 * it, because those are different pixels, so the only safe outcome is to
 * stop before capturing and leave the committed PNG.
 */
export class CaptureWindowNotFocusedError extends Error {
  constructor(steadyMs: number, waitedMs: number) {
    super(
      `the capture window did not stay the active window for ${steadyMs}ms `
        + `within ${waitedMs}ms, so it would be captured with grey traffic `
        + "lights. Another app kept taking focus back: a full-screen app, a "
        + "system dialog, or input during the run. Clear it and rerun.",
    );
    this.name = "CaptureWindowNotFocusedError";
  }
}

export const CAPTURE_FOCUS_INTERVAL_MS = 100;
/**
 * How long the window must stay focused before a capture. The app that had
 * focus when the run started can take it back 0.8–2.3s after Electron
 * activates, sometimes more than once (observed from the Claude desktop
 * app). Holding for 2s lets most take-backs land before the capture;
 * `captureWhileFocused` retries the rest.
 */
export const CAPTURE_FOCUS_STEADY_CHECKS = 20;
export const CAPTURE_FOCUS_MAX_CHECKS = 80;

/**
 * Call `focus` until it has reported the window focused on `steadyChecks`
 * checks in a row, at most `maxChecks` times. `focus` both asks for focus
 * and reports whether it has it: macOS activates an app asynchronously,
 * so the first answer is usually no, and asking again wins focus back
 * from an app that took it. A lost check restarts the count.
 */
export async function waitForSteadyFocus(
  focus: () => Promise<boolean>,
  options: {
    steadyChecks?: number;
    maxChecks?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const steadyChecks = options.steadyChecks ?? CAPTURE_FOCUS_STEADY_CHECKS;
  const maxChecks = options.maxChecks ?? CAPTURE_FOCUS_MAX_CHECKS;
  const intervalMs = options.intervalMs ?? CAPTURE_FOCUS_INTERVAL_MS;
  const sleep = options.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let steady = 0;
  for (let check = 1; check <= maxChecks; check += 1) {
    steady = (await focus()) ? steady + 1 : 0;
    if (steady >= steadyChecks) return true;
    if (check < maxChecks) await sleep(intervalMs);
  }
  return false;
}

/**
 * `capture-window.swift`'s exit status when the window's app was not the
 * active app before or after the capture. It wrote nothing.
 */
export const CAPTURE_INACTIVE_EXIT_STATUS = 7;
/**
 * `capture-window.swift`'s exit status when the capture came out below
 * Retina scale, meaning the window sat on a 1x display. It wrote nothing.
 */
export const CAPTURE_LOW_RESOLUTION_EXIT_STATUS = 6;
export const CAPTURE_ATTEMPTS = 3;

function exitStatusOf(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { status?: unknown }).status
    : undefined;
}

/** Whether `execFileSync` threw because the capture script refused an inactive window. */
export function isInactiveCaptureRefusal(error: unknown): boolean {
  return exitStatusOf(error) === CAPTURE_INACTIVE_EXIT_STATUS;
}

/**
 * Whether raising the window again can fix the refusal `execFileSync`
 * threw. An inactive window can always be fixed that way. A sub-Retina
 * capture can be fixed only when the run has a Retina display, because
 * `bringToFront` moves the window back onto it. Without one, every retry
 * lands on the same 1x display.
 */
export function isRetriableCaptureRefusal(
  error: unknown,
  retinaAvailable: boolean,
): boolean {
  const status = exitStatusOf(error);
  return status === CAPTURE_INACTIVE_EXIT_STATUS
    || (retinaAvailable && status === CAPTURE_LOW_RESOLUTION_EXIT_STATUS);
}

/**
 * Run `capture`, which calls `capture-window.swift`. When the script
 * refuses because the window lost focus, or landed on a 1x display while a
 * Retina display is available, `raise` the window and capture again, up to
 * `attempts` times. A steady-focus wait alone is not enough: the app that
 * had focus when the run started can take it back more than once, seconds
 * apart. Any other failure is thrown at once.
 */
export async function captureWhileFocused(
  capture: () => void,
  raise: () => Promise<void>,
  attempts: number = CAPTURE_ATTEMPTS,
  retinaAvailable: () => boolean = probedRetinaDisplay,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      capture();
      return;
    } catch (error) {
      if (!isRetriableCaptureRefusal(error, retinaAvailable()) || attempt >= attempts) {
        throw error;
      }
      const cause = isInactiveCaptureRefusal(error)
        ? "the window lost focus"
        : "the capture came out below 2x";
      console.warn(
        `[capture] ${cause}; raising it and capturing again `
        + `(attempt ${attempt + 1} of ${attempts})`,
      );
      await raise();
    }
  }
}

/**
 * The `--pid=` argument that pins `capture-window.swift` to this app's
 * windows.
 *
 * The script's owner match is the name "Electron", which every unpackaged
 * Electron app on the machine shares. When another Electron dev app was
 * frontmost, a docs-site run captured its window and wrote it out as
 * `settings-messaging-line.png`. The inactive-window check passed as well,
 * because it checked the app that had been captured, which was active. The
 * PID comes from the main process, which owns the windows.
 */
export async function captureOwnerPidArg(
  electronApp: ElectronApplication,
): Promise<string> {
  const pid = await electronApp.evaluate(() => process.pid);
  return `--pid=${pid}`;
}

/**
 * Report each distinct placement outcome once rather than on all ~21
 * captures of a run — but re-report when the outcome *changes*. Windows
 * of different sizes can land differently, and a latch keyed on "have we
 * ever printed" would hide that.
 */
let lastReported: string | undefined;

/**
 * The displays as probed by the first `bringToFront` of this run.
 *
 * Probed once and then trusted. A capture run lasts minutes, and
 * re-deciding for each capture would let one mid-run display change send
 * later captures somewhere the earlier ones did not go. If a window lands
 * on a 1x display anyway, `capture-window.swift` refuses the capture, and
 * the retry places it again against this same probe.
 */
let probedDisplays: DisplaySummary[] | undefined;

/** Whether this run's display probe found a display that captures at 2x. */
export function probedRetinaDisplay(): boolean {
  return (probedDisplays ?? []).some(
    (display) => display.scaleFactor >= MINIMUM_RETINA_SCALE_FACTOR,
  );
}

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
 * Placement and the raise run before every capture, not just at launch:
 * focus can move mid-run, and both are cheap and idempotent. The displays
 * are probed only on the first call of the run; see `probedDisplays`.
 *
 * Pass `titleSubstring` when the capture targets an auxiliary window —
 * it must match what goes to `capture-window.swift --title=`, or the
 * main window gets placed while a different one is photographed. The
 * match here is case-insensitive, as it is on the Swift side.
 *
 * The raise has to make the app active and keep it active, not just order
 * the window front. A run started from another app captured the window
 * inactive, with grey traffic lights, on some runs and not others: that
 * app took focus back while the capture ran. So this waits until focus
 * holds, and `capture-window.swift` refuses a capture taken without it.
 *
 * @throws {CaptureWindowNotFoundError} when no window matches.
 * @throws {CaptureWindowNotFocusedError} when the window never becomes active.
 */
export async function bringToFront(
  electronApp: ElectronApplication,
  titleSubstring?: string,
): Promise<void> {
  // Read. Resolve the window once and return its id, so the write below
  // acts on the same window even if the window list changes in between.
  const snapshot = await electronApp.evaluate(({ BrowserWindow, screen }, options) => {
    const windows = BrowserWindow.getAllWindows();
    const needle = options.needle;
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
      displays: options.probe
        ? screen.getAllDisplays().map((display) => ({
          internal: display.internal,
          scaleFactor: display.scaleFactor,
          workArea: display.workArea,
        }))
        : null,
    };
  }, { needle: titleSubstring, probe: probedDisplays === undefined });

  if (snapshot.id === null) {
    throw new CaptureWindowNotFoundError(titleSubstring, snapshot.titles);
  }

  if (probedDisplays === undefined) {
    probedDisplays = snapshot.displays ?? [];
    const described = probedDisplays
      .map((display) =>
        `${display.internal ? "built-in" : "external"} ${display.scaleFactor}x `
        + `${display.workArea.width}x${display.workArea.height}`,
      )
      .join(", ");
    console.log(`[capture] displays, probed once for this run: ${described || "none"}`);
    if (!probedRetinaDisplay()) {
      // Not fatal here — capture-window.swift refuses per capture with a
      // message naming the observed scale, and `--allow-low-dpi` exists
      // for anyone who deliberately wants a 1x asset.
      console.warn(
        "[capture] no Retina display attached. Captures will be below 2x and "
        + "capture-window.swift will refuse them.",
      );
    }
  }

  // Choose. Pure, and the only part of this file a unit test can reach.
  const bounds = snapshot.bounds!;
  const target = pickCaptureDisplay(probedDisplays, bounds);

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

  // Activate, then wait out a take-back. `steal` makes Electron the active
  // app even while another app is; without it, `focus()` only reorders
  // windows within Electron.
  const focused = await waitForSteadyFocus(() =>
    electronApp.evaluate(({ app, BrowserWindow }, id) => {
      const win = BrowserWindow.fromId(id);
      if (!win) return false;
      if (win.isFocused()) return true;
      if (process.platform === "darwin") app.focus({ steal: true });
      win.focus();
      return win.isFocused();
    }, snapshot.id),
  );
  if (!focused) {
    throw new CaptureWindowNotFocusedError(
      CAPTURE_FOCUS_STEADY_CHECKS * CAPTURE_FOCUS_INTERVAL_MS,
      CAPTURE_FOCUS_MAX_CHECKS * CAPTURE_FOCUS_INTERVAL_MS,
    );
  }

  // Give the compositor a tick to actually raise the window (and settle
  // the move) before screencapture inspects the on-screen window list.
  await new Promise((resolve) => setTimeout(resolve, 500));
}
