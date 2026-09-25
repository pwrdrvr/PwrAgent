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
 * the first `bringToFront` of a run, and trusted after that.
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

import { execFileSync } from "node:child_process";
import type { ElectronApplication } from "@playwright/test";

/** Below this, `screencapture` is not producing a Retina asset. */
export const MINIMUM_RETINA_SCALE_FACTOR = 2;

/**
 * How long `bringToFront` keeps asking for focus before it gives up.
 *
 * Generous on purpose. The person running the capture is often working
 * on the same machine, and while they are busy in another app macOS can
 * refuse activation for seconds at a time, `steal: true` included. The
 * first pause in their input is enough.
 */
export const FOCUS_TIMEOUT_MS = 10_000;

/** Pause between focus checks while waiting for the window to become key. */
export const FOCUS_POLL_INTERVAL_MS = 100;

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
 * Call `check` until it reports the window is key, pausing between calls.
 *
 * `check` both observes and re-requests: it returns `true` once the
 * window is key, and otherwise asks for focus again so the next call has
 * something to observe. Activation is asynchronous — the app hears
 * `did-become-active` on a later tick than the request — so a single
 * check straight after the request is not evidence either way.
 *
 * Returns whether the window became key before `timeoutMs` elapsed. The
 * clock and the pause are injectable so the retry rule can be tested
 * without real time.
 */
export async function waitForWindowFocus(
  check: () => Promise<boolean>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const {
    timeoutMs = FOCUS_TIMEOUT_MS,
    intervalMs = FOCUS_POLL_INTERVAL_MS,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/** The app macOS reports as frontmost, as far as `lsappinfo` could say. */
export type FrontmostApp = { name?: string; pid?: number };

/**
 * Parse `lsappinfo info -only name -only pid <ASN>`, which prints one
 * `"key"=value` line per field:
 *
 *     "LSDisplayName"="Electron"
 *     "pid"=85077
 *
 * Returns `undefined` when neither field is present.
 */
export function parseLsappinfoInfo(output: string): FrontmostApp | undefined {
  const name = /"LSDisplayName"="([^"]*)"/.exec(output)?.[1];
  const pid = /"pid"=(\d+)/.exec(output)?.[1];
  if (name === undefined && pid === undefined) return undefined;
  return { name, pid: pid === undefined ? undefined : Number(pid) };
}

/**
 * Best-effort read of the frontmost app, for the not-focused diagnostic.
 * Only called on the failure path, so it never costs a passing capture.
 */
function readFrontmostApp(): FrontmostApp | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const asn = execFileSync("/usr/bin/lsappinfo", ["front"], {
      encoding: "utf8",
    }).trim();
    if (!asn) return undefined;
    return parseLsappinfoInfo(
      execFileSync(
        "/usr/bin/lsappinfo",
        ["info", "-only", "name", "-only", "pid", asn],
        { encoding: "utf8" },
      ),
    );
  } catch {
    return undefined;
  }
}

/**
 * Thrown when the window a capture targets cannot be made key.
 *
 * macOS draws any window that is not key in the active app differently —
 * grey traffic lights and a smaller shadow, which also changes the PNG's
 * pixel dimensions — and the noise filter keeps any PNG whose pixels
 * changed.
 * Capturing anyway would commit the inactive frame as a README or
 * docs-site image, so refusing is the only safe outcome.
 */
export class CaptureWindowNotFocusedError extends Error {
  constructor(details: {
    titleSubstring: string | undefined;
    timeoutMs: number;
    appPid: number | undefined;
    frontmost: FrontmostApp | undefined;
  }) {
    const { titleSubstring, timeoutMs, appPid, frontmost } = details;
    const target = titleSubstring === undefined
      ? "the capture window"
      : `the window whose title contains "${titleSubstring}"`;
    const holder = frontmost
      ? `The frontmost app is "${frontmost.name ?? "unknown"}"`
        + (frontmost.pid === undefined ? "" : ` (pid ${frontmost.pid})`)
      : "The frontmost app could not be read";
    const self = appPid === undefined ? "" : `; this app is pid ${appPid}`;
    super(
      `${target} did not become key within ${timeoutMs} ms, so it would be `
      + "captured inactive (grey traffic lights, smaller shadow, different "
      + `PNG dimensions). ${holder}${self}. Another app is keeping focus — `
      + "most often a second capture run, or a window clicked during this "
      + "one.",
    );
    this.name = "CaptureWindowNotFocusedError";
  }
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
 * Probed once and then trusted. A capture sequence lasts minutes, and
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

function describeDisplays(displays: readonly DisplaySummary[]): string {
  return displays
    .map((display) =>
      `${display.internal ? "built-in" : "external"} ${display.scaleFactor}x `
      + `${display.workArea.width}x${display.workArea.height}`,
    )
    .join(", ") || "none";
}

function report(line: string, level: "log" | "warn"): void {
  if (lastReported === line) return;
  lastReported = line;
  if (level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * Move the app window onto a Retina display, bring it forward so
 * `screencapture`'s window-list lookup resolves it, and make it the key
 * window of the active app so it is drawn active.
 *
 * Without the raise, a recently-launched Electron window can stay behind
 * whatever the user/IDE had focused, and `screencapture -l` silently
 * captures a stale frame or an off-screen position.
 *
 * Asking for focus is not proof of it. Activation lands asynchronously,
 * and another app can take it between the request and the capture — a
 * click in the terminal or IDE running the spec is enough. A fixed wait
 * with no check photographed that window inactive: grey traffic lights
 * and the smaller inactive shadow, so the README's closed-by-default
 * capture came back at 2096x1576 px instead of 2184x1664 px, and the
 * noise filter keeps both, since they are different pixels. So this
 * activates with `app.focus({ steal: true })` — `win.focus()` alone
 * passes `activateIgnoringOtherApps:NO`, which AppKit documents as a
 * no-op while another app is active — then polls until the window
 * reports key, asking again each time it does not.
 *
 * Focus lost after this returns is caught at the capture itself.
 * `capture-window.swift` refuses a window that is not drawn active
 * (exit 7), and `captureWindowPng` then calls this again and retries.
 *
 * Placement, activation, and the focus check run before every capture
 * attempt, because focus can move at any point in a run. They are cheap
 * when nothing changed: the settle wait is skipped unless the window was
 * hidden, moved, or had to wait for focus. The displays are probed only
 * on the first call of the run; see `probedDisplays`.
 *
 * Pass `titleSubstring` when the capture targets an auxiliary window —
 * it must match what goes to `capture-window.swift --title=`, or the
 * main window gets placed while a different one is photographed. The
 * match here is case-insensitive, as it is on the Swift side.
 *
 * @throws {CaptureWindowNotFoundError} when no window matches.
 * @throws {CaptureWindowNotFocusedError} when the window does not become
 *   key within {@link FOCUS_TIMEOUT_MS}.
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
      visible: win.isVisible(),
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
    console.log(
      `[capture] displays, probed once for this run: ${describeDisplays(probedDisplays)}`,
    );
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
  const rect = target ? centeredIn(target.workArea, bounds) : null;
  const moves = rect !== null && (rect.x !== bounds.x || rect.y !== bounds.y);

  // Write. Place (when we have somewhere to place it), activate, and
  // raise, then read back where the window actually landed — `setBounds`
  // is fire-and-forget and macOS can constrain the frame, so the run's
  // only placement diagnostic should be an observation, not a claim.
  const placed = await electronApp.evaluate(
    ({ app, BrowserWindow, screen }, options) => {
      const win = BrowserWindow.fromId(options.id);
      if (!win) return null;
      if (options.rect) win.setBounds(options.rect);
      // Take activation from whichever app has it. Activate before
      // focusing, so `win.focus()` — not whichever window the app had
      // key last — decides which window ends up key. For an auxiliary
      // capture those differ.
      if (process.platform === "darwin") app.focus({ steal: true });
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
    { id: snapshot.id, rect },
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

  // Verify. Activation lands asynchronously, and another app can take it
  // back at any point, so ask again until the window reports key.
  // `isFocused()` is `-[NSWindow isKeyWindow]`, which is false for every
  // window of an inactive app — true here means the window is key *and*
  // the app is active, which is what paints the colored traffic lights.
  const id = snapshot.id;
  let checks = 0;
  const focused = await waitForWindowFocus(() => {
    checks += 1;
    return electronApp.evaluate(({ app, BrowserWindow }, windowId) => {
      const win = BrowserWindow.fromId(windowId);
      if (!win) {
        throw new Error(`capture window ${windowId} closed before it became key`);
      }
      if (win.isFocused()) return true;
      if (process.platform === "darwin") app.focus({ steal: true });
      win.focus();
      return false;
    }, id);
  });
  if (!focused) {
    const appPid = await electronApp
      .evaluate(() => process.pid)
      .catch(() => undefined);
    throw new CaptureWindowNotFocusedError({
      titleSubstring,
      timeoutMs: FOCUS_TIMEOUT_MS,
      appPid,
      frontmost: readFrontmostApp(),
    });
  }

  // Give the compositor a tick to actually raise the window (and settle
  // the move and the switch to the active frame) before screencapture
  // inspects the on-screen window list. Nothing to settle when the window
  // was already showing, stayed put, and was key on the first check —
  // the common case when a capture re-raises what the spec just raised.
  if (!snapshot.visible || moves || checks > 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
