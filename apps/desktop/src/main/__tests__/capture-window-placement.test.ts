/**
 * The display-selection rule behind the screenshot captures.
 *
 * This is the logic whose absence caused the 2026-09-01 incident (all 21
 * committed docs-site PNGs overwritten at half resolution), and until it
 * was lifted out of the `electronApp.evaluate` callback it had no test:
 * Playwright serializes those bodies into the Electron main process, so
 * nothing inside one is reachable from Vitest. A comparator edit that
 * inverted the built-in preference would have typechecked and passed CI.
 *
 * The focus wait is here for the same reason. It decides whether a
 * capture goes ahead with the window drawn active, and the callback that
 * asks Electron for focus is just as unreachable.
 *
 * It lives here rather than beside the fixture for the same reason
 * `sub-agent-state-seeding.test.ts` does: `e2e/` is Playwright's
 * `testDir`, and its default `testMatch` claims `*.test.ts`, so a vitest
 * file under it gets collected as a spec and dies on the first
 * `describe`.
 */

import { describe, expect, it, vi } from "vitest";
import {
  CaptureWindowNotFocusedError,
  centeredIn,
  FOCUS_POLL_INTERVAL_MS,
  FOCUS_TIMEOUT_MS,
  MINIMUM_RETINA_SCALE_FACTOR,
  overflowsWorkArea,
  parseLsappinfoInfo,
  pickCaptureDisplay,
  waitForWindowFocus,
  type DisplaySummary,
} from "../../../e2e/fixtures/capture-window-placement";

function display(
  overrides: Partial<DisplaySummary> & { scaleFactor: number },
): DisplaySummary {
  return {
    internal: false,
    workArea: { x: 0, y: 0, width: 2560, height: 1400 },
    ...overrides,
  };
}

const CAPTURE_WINDOW = { width: 1440, height: 900 };

describe("pickCaptureDisplay", () => {
  it("prefers the built-in Retina panel over a 1x external", () => {
    // The setup the placement layer exists for: a laptop docked to a
    // non-Retina monitor, where only the built-in panel can produce a 2x
    // capture at all.
    const builtIn = display({
      internal: true,
      scaleFactor: 2,
      workArea: { x: 0, y: 25, width: 1496, height: 938 },
    });
    const external = display({
      scaleFactor: 1,
      workArea: { x: 1496, y: 0, width: 2560, height: 1440 },
    });

    expect(pickCaptureDisplay([external, builtIn], CAPTURE_WINDOW)).toBe(builtIn);
  });

  it("returns undefined when no display can produce a Retina capture", () => {
    const only1x = display({ scaleFactor: 1 });

    expect(pickCaptureDisplay([only1x], CAPTURE_WINDOW)).toBeUndefined();
    expect(pickCaptureDisplay([], CAPTURE_WINDOW)).toBeUndefined();
  });

  it("never picks a 1x display even when it is the built-in one", () => {
    // A 1x built-in panel cannot produce the asset, so the "built-in
    // first" preference must not outrank the Retina filter.
    const builtIn1x = display({ internal: true, scaleFactor: 1 });
    const external2x = display({ scaleFactor: 2 });

    expect(pickCaptureDisplay([builtIn1x, external2x], CAPTURE_WINDOW)).toBe(
      external2x,
    );
  });

  it("prefers a Retina display the window fits on over one it overflows", () => {
    // A 14"/16" MacBook Pro in its default scaled mode leaves a work area
    // shorter than the 900pt capture window. Pinning to that panel's
    // origin loses the centering and invites macOS frame constraining,
    // so an external Retina display that fits is the better target.
    const crampedBuiltIn = display({
      internal: true,
      scaleFactor: 2,
      workArea: { x: 0, y: 38, width: 1470, height: 882 },
    });
    const roomyExternal = display({
      scaleFactor: 2,
      workArea: { x: 1470, y: 0, width: 2560, height: 1415 },
    });

    expect(
      pickCaptureDisplay([crampedBuiltIn, roomyExternal], CAPTURE_WINDOW),
    ).toBe(roomyExternal);
  });

  it("falls back to the built-in panel when the window fits nowhere", () => {
    const builtIn = display({
      internal: true,
      scaleFactor: 2,
      workArea: { x: 0, y: 38, width: 1200, height: 800 },
    });
    const external = display({
      scaleFactor: 2,
      workArea: { x: 1200, y: 0, width: 1280, height: 820 },
    });

    expect(pickCaptureDisplay([builtIn, external], CAPTURE_WINDOW)).toBe(builtIn);
  });

  it("prefers the sharper display when neither is built-in", () => {
    const sharper = display({ scaleFactor: 3 });
    const softer = display({ scaleFactor: 2 });

    expect(pickCaptureDisplay([softer, sharper], CAPTURE_WINDOW)).toBe(sharper);
  });

  it("does not mutate the array it was given", () => {
    // `Array.prototype.sort` sorts in place, and the caller passes the
    // list straight out of `screen.getAllDisplays()`.
    const first = display({ scaleFactor: 2 });
    const second = display({ internal: true, scaleFactor: 2 });
    const displays = [first, second];

    pickCaptureDisplay(displays, CAPTURE_WINDOW);

    expect(displays).toEqual([first, second]);
  });

  it("treats the shared minimum as the Retina threshold", () => {
    expect(MINIMUM_RETINA_SCALE_FACTOR).toBe(2);
  });
});

describe("centeredIn", () => {
  it("centers the window and keeps its size", () => {
    const rect = centeredIn(
      { x: 0, y: 25, width: 1496, height: 938 },
      CAPTURE_WINDOW,
    );

    expect(rect).toEqual({ x: 28, y: 44, width: 1440, height: 900 });
  });

  it("offsets by the work area's origin on a secondary display", () => {
    const rect = centeredIn(
      { x: 1496, y: 0, width: 2560, height: 1440 },
      CAPTURE_WINDOW,
    );

    expect(rect).toEqual({ x: 2056, y: 270, width: 1440, height: 900 });
  });

  it("pins to the origin rather than shrinking a window that does not fit", () => {
    // The committed PNGs depend on the window size the spec sets, so an
    // oversized window is positioned, never resized.
    const rect = centeredIn(
      { x: 0, y: 38, width: 1200, height: 800 },
      CAPTURE_WINDOW,
    );

    expect(rect).toEqual({ x: 0, y: 38, width: 1440, height: 900 });
  });
});

describe("overflowsWorkArea", () => {
  it("is false for the documented happy path", () => {
    // 1440x900 on the 1496x938 work area of a 2x built-in panel.
    expect(
      overflowsWorkArea({ x: 0, y: 25, width: 1496, height: 938 }, CAPTURE_WINDOW),
    ).toBe(false);
  });

  it("detects an overflow in either axis alone", () => {
    expect(
      overflowsWorkArea({ x: 0, y: 0, width: 1400, height: 1000 }, CAPTURE_WINDOW),
    ).toBe(true);
    expect(
      overflowsWorkArea({ x: 0, y: 0, width: 1500, height: 880 }, CAPTURE_WINDOW),
    ).toBe(true);
  });
});

/**
 * A clock that only moves when the loop sleeps, so the retry rule runs
 * without real time and every pause it takes is recorded.
 */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

describe("waitForWindowFocus", () => {
  it("returns at once when the window is already key", async () => {
    const clock = fakeClock();
    const check = vi.fn(async () => true);

    await expect(waitForWindowFocus(check, clock)).resolves.toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("keeps checking until activation lands", async () => {
    // Activation is asynchronous: the check straight after the request
    // still sees the inactive state, so one negative answer must not end
    // the wait.
    const clock = fakeClock();
    const answers = [false, false, true];
    const check = vi.fn(async () => answers.shift()!);

    await expect(waitForWindowFocus(check, clock)).resolves.toBe(true);
    expect(check).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([
      FOCUS_POLL_INTERVAL_MS,
      FOCUS_POLL_INTERVAL_MS,
    ]);
  });

  it("gives up once the timeout elapses, after a check at the deadline", async () => {
    const clock = fakeClock();
    const check = vi.fn(async () => false);

    await expect(
      waitForWindowFocus(check, { ...clock, timeoutMs: 1_000, intervalMs: 250 }),
    ).resolves.toBe(false);
    // 0, 250, 500, 750, 1000.
    expect(check).toHaveBeenCalledTimes(5);
    expect(clock.now()).toBe(1_000);
  });

  it("waits the shared timeout by default", async () => {
    const clock = fakeClock();

    await expect(waitForWindowFocus(async () => false, clock)).resolves.toBe(
      false,
    );
    expect(clock.now()).toBe(FOCUS_TIMEOUT_MS);
  });

  it("does not retry a check that throws", async () => {
    // The check throws when the window has closed. That has to surface
    // as itself, not be retried into a misleading not-focused timeout.
    const clock = fakeClock();
    const check = vi.fn(async (): Promise<boolean> => {
      throw new Error("capture window 3 closed before it became key");
    });

    await expect(waitForWindowFocus(check, clock)).rejects.toThrow(
      /closed before it became key/,
    );
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe("parseLsappinfoInfo", () => {
  it("reads the display name and pid", () => {
    expect(
      parseLsappinfoInfo('"LSDisplayName"="Electron"\n"pid"=85077\n'),
    ).toEqual({ name: "Electron", pid: 85077 });
  });

  it("keeps whichever field is present", () => {
    expect(parseLsappinfoInfo('"LSDisplayName"="Visual Studio Code"\n')).toEqual(
      { name: "Visual Studio Code", pid: undefined },
    );
    expect(parseLsappinfoInfo('"pid"=412\n')).toEqual({
      name: undefined,
      pid: 412,
    });
  });

  it("returns undefined when lsappinfo printed neither field", () => {
    // `lsappinfo info` prints nothing for an ASN that has already exited.
    expect(parseLsappinfoInfo("")).toBeUndefined();
  });
});

describe("CaptureWindowNotFocusedError", () => {
  it("names the app holding focus next to this app's pid", () => {
    // Two "Electron" apps are indistinguishable by name — a second
    // capture run is the usual culprit — so the pids are what let the
    // operator tell which process to stop.
    const error = new CaptureWindowNotFocusedError({
      titleSubstring: "Messaging Activity",
      timeoutMs: FOCUS_TIMEOUT_MS,
      appPid: 1234,
      frontmost: { name: "Electron", pid: 85077 },
    });

    expect(error.name).toBe("CaptureWindowNotFocusedError");
    expect(error.message).toContain('title contains "Messaging Activity"');
    expect(error.message).toContain('"Electron" (pid 85077); this app is pid 1234');
  });

  it("still explains the failure when the frontmost app is unknown", () => {
    const error = new CaptureWindowNotFocusedError({
      titleSubstring: undefined,
      timeoutMs: FOCUS_TIMEOUT_MS,
      appPid: undefined,
      frontmost: undefined,
    });

    expect(error.message).toMatch(/^the capture window did not become key/);
    expect(error.message).toContain("could not be read.");
  });
});
