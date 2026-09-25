/**
 * Native window capture for the screenshot specs, retried by default.
 *
 * Shared by `readme-screenshots.inspect.spec.ts` and
 * `docs-site-screenshots.inspect.spec.ts`. Each capture raises the window
 * with `bringToFront` and then runs `scripts/capture-window.swift`, which
 * refuses rather than write a capture that would be wrong:
 *
 * - exit 7: the window was not drawn active just before or just after the
 *   shot. That usually means someone working on the same machine clicked
 *   another window, which they can do at any point in a run without
 *   knowing a capture is in progress.
 * - exit 6: the shot came out below 2x, meaning the window was on a
 *   non-Retina display.
 *
 * Both are worth retrying, because raising the window again corrects
 * them: `bringToFront` takes activation back and places the window on the
 * Retina display that the run's probe found. A 1x refusal is retried only
 * when that probe found a Retina display. Otherwise another attempt would
 * land in the same place. Any other failure is thrown straight away.
 *
 * The retry rule is kept free of Electron and child processes so
 * `__tests__/native-capture.test.ts` can drive it.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication } from "@playwright/test";
import {
  bringToFront,
  CaptureWindowNotFocusedError,
  probedRetinaDisplay,
} from "./capture-window-placement";

const captureScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/capture-window.swift",
);

/** `capture-window.swift`: the capture came out below Retina scale. */
export const EXIT_LOW_RESOLUTION = 6;

/** `capture-window.swift`: the window was not drawn active. */
export const EXIT_INACTIVE = 7;

/** Attempts per capture unless `PWRAGENT_SCREENSHOT_CAPTURE_ATTEMPTS` says otherwise. */
export const DEFAULT_CAPTURE_ATTEMPTS = 3;

/**
 * Pause before a retry. A refusal usually means someone just clicked
 * another window. A short wait lets that click finish before focus is
 * taken back.
 */
export const RETRY_PAUSE_MS = 1_000;

/** What one capture attempt came to. */
export type CaptureAttempt =
  | { kind: "captured" }
  /** Refused for a reason another raise can fix. */
  | { kind: "refused"; reason: string }
  | { kind: "failed"; reason: string };

/**
 * Read `PWRAGENT_SCREENSHOT_CAPTURE_ATTEMPTS`. Unset means the default,
 * and `1` turns retrying off. Anything else that is not a positive
 * integer is an error, not a silent fallback. Someone who typed it meant
 * a number.
 */
export function captureAttemptsFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CAPTURE_ATTEMPTS;
  const attempts = Number(raw);
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(
      `PWRAGENT_SCREENSHOT_CAPTURE_ATTEMPTS must be a positive integer, got "${raw}"`,
    );
  }
  return attempts;
}

/**
 * Classify how `capture-window.swift` exited. `retinaAvailable` is
 * whether this run's display probe found a 2x display. Without one, a 1x
 * refusal cannot be fixed by raising the window again.
 */
export function classifyCaptureExit(
  status: number | null,
  stderr: string,
  retinaAvailable: boolean,
): CaptureAttempt {
  if (status === 0) return { kind: "captured" };
  const reason = stderr.trim() || `capture-window.swift exited with status ${status}`;
  if (status === EXIT_INACTIVE) return { kind: "refused", reason };
  if (status === EXIT_LOW_RESOLUTION && retinaAvailable) {
    return { kind: "refused", reason };
  }
  return { kind: "failed", reason };
}

/** Thrown when a capture fails, or is still refused after the last attempt. */
export class NativeCaptureError extends Error {
  constructor(label: string, detail: string) {
    super(`native capture of ${label} failed: ${detail}`);
    this.name = "NativeCaptureError";
  }
}

/**
 * Run `attempt` until it captures, retrying refusals up to `attempts`
 * times in total with a pause before each retry. A failure, or a refusal
 * on the last attempt, throws.
 */
export async function retryCapture(options: {
  label: string;
  attempts: number;
  attempt: (attemptNumber: number) => Promise<CaptureAttempt>;
  pause?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<void> {
  const {
    label,
    attempts,
    attempt,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = (line) => console.warn(line),
  } = options;
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    const outcome = await attempt(attemptNumber);
    if (outcome.kind === "captured") return;
    if (outcome.kind === "failed") {
      throw new NativeCaptureError(label, outcome.reason);
    }
    if (attemptNumber >= attempts) {
      throw new NativeCaptureError(
        label,
        `refused on all ${attempts} attempt(s). Last refusal: ${outcome.reason}`,
      );
    }
    log(
      `[capture] ${label} refused (${outcome.reason.split("\n")[0]}). `
      + `Raising the window again, attempt ${attemptNumber + 1} of ${attempts}.`,
    );
    await pause(RETRY_PAUSE_MS);
  }
}

/**
 * Raise the window and capture it to `outputPath` natively, retrying
 * refusals (see the module comment).
 *
 * `titleSubstring` picks an auxiliary window. The same substring goes to
 * `bringToFront` and to `capture-window.swift --title=`, so the raised
 * window and the photographed window are always the same one.
 */
export async function captureWindowPng(
  electronApp: ElectronApplication,
  outputPath: string,
  options: { titleSubstring?: string } = {},
): Promise<void> {
  const args = ["Electron", outputPath];
  if (options.titleSubstring) {
    args.push(`--title=${options.titleSubstring}`);
  }
  // The Swift script refuses a sub-Retina capture and tells the operator to
  // "Pass --allow-low-dpi" — which is only actionable if something here can
  // pass it. On a 1x-only machine (external-display-only desk, a VM, the
  // Tart lab guest) this is the difference between a documented override
  // and one that requires editing the spec.
  if (process.env.PWRAGENT_SCREENSHOT_ALLOW_LOW_DPI === "1") {
    args.push("--allow-low-dpi");
  }

  await retryCapture({
    label: path.basename(outputPath),
    attempts: captureAttemptsFromEnv(
      process.env.PWRAGENT_SCREENSHOT_CAPTURE_ATTEMPTS,
    ),
    attempt: async () => {
      // Raise right before every attempt, the first included. The spec's
      // own earlier `bringToFront` may be several assertions old by now,
      // and this call costs little when nothing has changed.
      try {
        await bringToFront(electronApp, options.titleSubstring);
      } catch (error) {
        if (error instanceof CaptureWindowNotFocusedError) {
          return { kind: "refused", reason: error.message };
        }
        throw error;
      }
      const result = spawnSync(captureScript, args, {
        encoding: "utf8",
        stdio: ["ignore", "inherit", "pipe"],
      });
      if (result.error) throw result.error;
      if (result.stderr) process.stderr.write(result.stderr);
      return classifyCaptureExit(
        result.status,
        result.stderr ?? "",
        probedRetinaDisplay(),
      );
    },
  });
}
