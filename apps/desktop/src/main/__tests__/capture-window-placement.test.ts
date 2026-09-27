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
 * It lives here rather than beside the fixture for the same reason
 * `sub-agent-state-seeding.test.ts` does: `e2e/` is Playwright's
 * `testDir`, and its default `testMatch` claims `*.test.ts`, so a vitest
 * file under it gets collected as a spec and dies on the first
 * `describe`.
 */

import { describe, expect, it, vi } from "vitest";
import {
  CAPTURE_INACTIVE_EXIT_STATUS,
  CAPTURE_LOW_RESOLUTION_EXIT_STATUS,
  captureWhileFocused,
  centeredIn,
  isInactiveCaptureRefusal,
  isRetriableCaptureRefusal,
  MINIMUM_RETINA_SCALE_FACTOR,
  overflowsWorkArea,
  pickCaptureDisplay,
  probedRetinaDisplay,
  waitForSteadyFocus,
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

describe("waitForSteadyFocus", () => {
  // macOS activates an app asynchronously, and the app that had focus can
  // take it back about a second later. An inactive window is captured with
  // grey traffic lights, so focus has to hold, not just arrive.
  const answers = (...values: boolean[]) => {
    const focus = vi.fn();
    for (const value of values) focus.mockResolvedValueOnce(value);
    return focus.mockResolvedValue(values[values.length - 1]);
  };

  it("waits for focus to arrive and then hold", async () => {
    const focus = answers(false, false, true, true, true);
    const sleep = vi.fn(async () => {});

    await expect(
      waitForSteadyFocus(focus, { steadyChecks: 3, maxChecks: 10, intervalMs: 100, sleep }),
    ).resolves.toBe(true);
    expect(focus).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("starts the count again when focus is taken back", async () => {
    // Focus arrives, is taken back once, then holds.
    const focus = answers(true, true, false, true, true, true);
    const sleep = vi.fn(async () => {});

    await expect(
      waitForSteadyFocus(focus, { steadyChecks: 3, maxChecks: 10, sleep }),
    ).resolves.toBe(true);
    expect(focus).toHaveBeenCalledTimes(6);
  });

  it("gives up without a trailing wait when focus never holds", async () => {
    const focus = answers(true, false, true, false);
    const sleep = vi.fn(async () => {});

    await expect(
      waitForSteadyFocus(focus, { steadyChecks: 2, maxChecks: 4, sleep }),
    ).resolves.toBe(false);
    expect(focus).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});

describe("captureWhileFocused", () => {
  // What `execFileSync` throws when the script exits non-zero.
  const exited = (status: number) =>
    Object.assign(new Error(`Command failed with status ${status}`), { status });

  it("raises the window and captures again after an inactive refusal", async () => {
    const capture = vi.fn()
      .mockImplementationOnce(() => {
        throw exited(CAPTURE_INACTIVE_EXIT_STATUS);
      })
      .mockImplementationOnce(() => {});
    const raise = vi.fn(async () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await captureWhileFocused(capture, raise, 3);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(raise).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("throws any other failure at once, without raising", async () => {
    // Exit 3 is "no matching window"; raising cannot conjure one.
    const capture = vi.fn(() => {
      throw exited(3);
    });
    const raise = vi.fn(async () => {});

    await expect(
      captureWhileFocused(capture, raise, 3, () => true),
    ).rejects.toMatchObject({ status: 3 });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(raise).not.toHaveBeenCalled();
  });

  it("raises and retries a sub-Retina refusal when the run has a Retina display", async () => {
    // The window landed on the 1x display; the raise places it back on
    // the Retina display the run probed.
    const capture = vi.fn()
      .mockImplementationOnce(() => {
        throw exited(CAPTURE_LOW_RESOLUTION_EXIT_STATUS);
      })
      .mockImplementationOnce(() => {});
    const raise = vi.fn(async () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await captureWhileFocused(capture, raise, 3, () => true);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(raise).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("the capture was refused as below 2x"),
    );
    warn.mockRestore();
  });

  it("throws a sub-Retina refusal at once when the run has no Retina display", async () => {
    // Every retry would land on the same 1x display.
    const capture = vi.fn(() => {
      throw exited(CAPTURE_LOW_RESOLUTION_EXIT_STATUS);
    });
    const raise = vi.fn(async () => {});

    await expect(
      captureWhileFocused(capture, raise, 3, () => false),
    ).rejects.toMatchObject({ status: CAPTURE_LOW_RESOLUTION_EXIT_STATUS });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(raise).not.toHaveBeenCalled();
  });

  it("does not retry a sub-Retina refusal before any display probe", async () => {
    // The default reads this run's probe. With none yet, there is no known
    // Retina display to move the window onto.
    const capture = vi.fn(() => {
      throw exited(CAPTURE_LOW_RESOLUTION_EXIT_STATUS);
    });
    const raise = vi.fn(async () => {});

    await expect(captureWhileFocused(capture, raise, 3)).rejects.toMatchObject({
      status: CAPTURE_LOW_RESOLUTION_EXIT_STATUS,
    });
    expect(raise).not.toHaveBeenCalled();
  });

  it("gives up after the last attempt and throws the refusal", async () => {
    const capture = vi.fn(() => {
      throw exited(CAPTURE_INACTIVE_EXIT_STATUS);
    });
    const raise = vi.fn(async () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(captureWhileFocused(capture, raise, 3)).rejects.toMatchObject({
      status: CAPTURE_INACTIVE_EXIT_STATUS,
    });
    expect(capture).toHaveBeenCalledTimes(3);
    expect(raise).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("recognizes only the inactive-window exit status", () => {
    expect(isInactiveCaptureRefusal(exited(CAPTURE_INACTIVE_EXIT_STATUS))).toBe(true);
    expect(isInactiveCaptureRefusal(exited(6))).toBe(false);
    expect(isInactiveCaptureRefusal(new Error("spawn failed"))).toBe(false);
    expect(isInactiveCaptureRefusal(undefined)).toBe(false);
  });

  it("treats a sub-Retina refusal as retriable only with a Retina display", () => {
    const lowRes = exited(CAPTURE_LOW_RESOLUTION_EXIT_STATUS);
    const inactive = exited(CAPTURE_INACTIVE_EXIT_STATUS);

    expect(isRetriableCaptureRefusal(lowRes, true)).toBe(true);
    expect(isRetriableCaptureRefusal(lowRes, false)).toBe(false);
    expect(isRetriableCaptureRefusal(inactive, false)).toBe(true);
    expect(isRetriableCaptureRefusal(exited(3), true)).toBe(false);
    expect(isRetriableCaptureRefusal(undefined, true)).toBe(false);
  });

  it("sees no Retina display until a run has probed", () => {
    // Nothing in this file calls `bringToFront`, so nothing has probed.
    expect(probedRetinaDisplay()).toBe(false);
  });
});
