/**
 * The retry rule behind the native screenshot captures.
 *
 * `capture-window.swift` refuses a capture of a window that is not drawn
 * active (exit 7) or one that came out below 2x (exit 6). The rule here
 * decides which refusals another raise can fix, and how many times to
 * try. Getting it wrong either fails a run over one stray click or loops
 * on a refusal nothing will fix.
 *
 * It lives under `src/main/` for the reason given in
 * `capture-window-placement.test.ts`: `e2e/` is Playwright's `testDir`.
 */

import { describe, expect, it, vi } from "vitest";
import {
  captureAttemptsFromEnv,
  classifyCaptureExit,
  DEFAULT_CAPTURE_ATTEMPTS,
  EXIT_INACTIVE,
  EXIT_LOW_RESOLUTION,
  NativeCaptureError,
  RETRY_PAUSE_MS,
  retryCapture,
  type CaptureAttempt,
} from "../../../e2e/fixtures/native-capture";

const INACTIVE_STDERR =
  "refusing to write an inactive capture: before the capture, the frontmost "
  + "app is Terminal (pid 817), not the window's owner (pid 4242).\n";

describe("captureAttemptsFromEnv", () => {
  it("retries by default", () => {
    expect(captureAttemptsFromEnv(undefined)).toBe(DEFAULT_CAPTURE_ATTEMPTS);
    expect(captureAttemptsFromEnv("")).toBe(DEFAULT_CAPTURE_ATTEMPTS);
    expect(DEFAULT_CAPTURE_ATTEMPTS).toBeGreaterThan(1);
  });

  it("takes a positive integer, with 1 meaning no retry", () => {
    expect(captureAttemptsFromEnv("1")).toBe(1);
    expect(captureAttemptsFromEnv("5")).toBe(5);
  });

  it("rejects anything else instead of falling back", () => {
    for (const raw of ["0", "-1", "2.5", "three"]) {
      expect(() => captureAttemptsFromEnv(raw)).toThrow(
        /PWRAGENT_SCREENSHOT_CAPTURE_ATTEMPTS/,
      );
    }
  });
});

describe("classifyCaptureExit", () => {
  it("treats exit 0 as captured", () => {
    expect(classifyCaptureExit(0, "", true)).toEqual({ kind: "captured" });
  });

  it("retries an inactive-window refusal, with the script's reason", () => {
    expect(classifyCaptureExit(EXIT_INACTIVE, INACTIVE_STDERR, true)).toEqual({
      kind: "refused",
      reason: INACTIVE_STDERR.trim(),
    });
    // Retried even without a Retina display: focus has nothing to do with
    // scale.
    expect(classifyCaptureExit(EXIT_INACTIVE, INACTIVE_STDERR, false).kind).toBe(
      "refused",
    );
  });

  it("retries a 1x refusal only when the run found a Retina display", () => {
    // With a Retina display, raising the window again moves it back there.
    // Without one, every retry would land on the same 1x display.
    expect(classifyCaptureExit(EXIT_LOW_RESOLUTION, "low-res", true).kind).toBe(
      "refused",
    );
    expect(classifyCaptureExit(EXIT_LOW_RESOLUTION, "low-res", false)).toEqual({
      kind: "failed",
      reason: "low-res",
    });
  });

  it("does not retry other failures", () => {
    for (const status of [2, 3, 4, 5]) {
      expect(classifyCaptureExit(status, "boom", true).kind).toBe("failed");
    }
  });

  it("still gives a reason when the script printed nothing", () => {
    // `status` is null when the process was killed by a signal.
    expect(classifyCaptureExit(null, "", true)).toEqual({
      kind: "failed",
      reason: "capture-window.swift exited with status null",
    });
  });
});

function recorder(outcomes: CaptureAttempt[]) {
  const pauses: number[] = [];
  const logs: string[] = [];
  const attempt = vi.fn(async () => outcomes.shift()!);
  return {
    attempt,
    pauses,
    logs,
    pause: async (ms: number) => {
      pauses.push(ms);
    },
    log: (line: string) => {
      logs.push(line);
    },
  };
}

const refused: CaptureAttempt = { kind: "refused", reason: INACTIVE_STDERR.trim() };

describe("retryCapture", () => {
  it("captures on the first attempt without pausing or logging", async () => {
    const r = recorder([{ kind: "captured" }]);

    await retryCapture({ label: "shot.png", attempts: 3, ...r });

    expect(r.attempt).toHaveBeenCalledTimes(1);
    expect(r.pauses).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  it("retries a refusal after a pause, and says why", async () => {
    // A click in another window between the raise and the shot: refused
    // once, captured on the next attempt.
    const r = recorder([refused, { kind: "captured" }]);

    await retryCapture({ label: "shot.png", attempts: 3, ...r });

    expect(r.attempt).toHaveBeenCalledTimes(2);
    expect(r.attempt).toHaveBeenLastCalledWith(2);
    expect(r.pauses).toEqual([RETRY_PAUSE_MS]);
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toContain("shot.png refused");
    expect(r.logs[0]).toContain("the frontmost app is Terminal");
    expect(r.logs[0]).toContain("attempt 2 of 3");
  });

  it("throws the last refusal once every attempt is used", async () => {
    const r = recorder([refused, refused, refused]);

    const run = retryCapture({ label: "shot.png", attempts: 3, ...r });

    await expect(run).rejects.toBeInstanceOf(NativeCaptureError);
    await expect(run).rejects.toThrow(
      /shot\.png failed: refused on all 3 attempt\(s\)\. Last refusal: refusing to write an inactive capture/,
    );
    expect(r.attempt).toHaveBeenCalledTimes(3);
    expect(r.pauses).toEqual([RETRY_PAUSE_MS, RETRY_PAUSE_MS]);
  });

  it("does not retry when retrying is turned off", async () => {
    const r = recorder([refused]);

    await expect(
      retryCapture({ label: "shot.png", attempts: 1, ...r }),
    ).rejects.toThrow(/refused on all 1 attempt/);
    expect(r.pauses).toEqual([]);
  });

  it("throws a failure straight away", async () => {
    const r = recorder([{ kind: "failed", reason: "no on-screen window" }]);

    await expect(
      retryCapture({ label: "shot.png", attempts: 3, ...r }),
    ).rejects.toThrow("native capture of shot.png failed: no on-screen window");
    expect(r.attempt).toHaveBeenCalledTimes(1);
    expect(r.pauses).toEqual([]);
  });

  it("lets an unexpected error from an attempt escape unretried", async () => {
    const r = recorder([]);
    r.attempt.mockRejectedValueOnce(new Error("window closed"));

    await expect(
      retryCapture({ label: "shot.png", attempts: 3, ...r }),
    ).rejects.toThrow("window closed");
    expect(r.attempt).toHaveBeenCalledTimes(1);
  });
});
