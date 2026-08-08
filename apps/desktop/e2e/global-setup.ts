// Pre-flight canary for the desktop E2E suite.
//
// A persistent macOS CI guest can reach a state where the suite cannot run at
// all. Every spec launches its own app, so when that happens each test burns
// its full 30s timeout and the job dies on the workflow's 20-minute cap
// partway through whichever spec sorts first — currently `a11y.spec.ts`,
// which makes those blocks look guilty when they are only first in line.
//
// Observed shape (2026-08-07, main), binary rather than degraded: a healthy
// runner ran 187 tests in ~5 minutes with zero teardown fallbacks; an
// affected one ran ZERO tests and burned the full cap, ALSO with zero
// fallbacks. The same commit passed on one runner and failed on the other
// within the same hour, so the trigger is the guest, not the branch.
//
// The trace from an affected run says precisely where it stops:
//
//     Launch electron            -> completed
//     Wait for event "window"    -> never returns
//
// Electron starts and is controllable; the window never arrives. That is why
// this canary must obtain a WINDOW, not merely a process — a launch-only
// check would pass on exactly the failure it exists to catch.
//
// It gets that window by calling `launchElectronApp`, the same harness every
// spec calls, rather than hand-rolling a launch. That is not just tidiness:
// the harness seeds `onboarding.completed` and
// `confirmQuitWithInProgressThreads: false` into the per-run home before
// boot. A hand-rolled draft of this file skipped that, booted the first-run
// setup wizard, and hung a healthy guest's global setup for a full hour —
// no `Running N tests`, zero tests, strictly worse than the failure it was
// meant to prevent. Delegating means the canary cannot drift from what the
// specs actually do.
//
// This does not diagnose the guest-level cause and deliberately does not
// guess at one. It makes the condition cheap and legible.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeCanaryFailure } from "./canary-report";
import {
  closeElectronApplication,
  DESKTOP_MAIN_ENTRY,
  launchElectronApp,
  withTimeout,
} from "./fixtures/electron-app";

const setupDir = path.dirname(fileURLToPath(import.meta.url));
const SMOKE_FIXTURE = path.resolve(
  setupDir,
  "fixtures/smoke/replay.fixture.json",
);

/**
 * Generous next to a healthy guest, where the whole walk is a few seconds,
 * and short enough that an affected one is reported long before the
 * workflow's step cap. Bounds the harness call as a whole: `firstWindow()`
 * carries its own timeout, but a guest can stall anywhere and an unbounded
 * pre-flight would recreate the job-length hang this file exists to prevent.
 */
const CANARY_TIMEOUT_MS = 60_000;

export default async function globalSetup(): Promise<void> {
  if (!existsSync(DESKTOP_MAIN_ENTRY)) {
    // `playwright test` invoked without a build. The specs report that far
    // more clearly than a canary can, so stay out of the way.
    return;
  }

  let settled = false;
  let launched: Awaited<ReturnType<typeof launchElectronApp>> | undefined;

  const launching = launchElectronApp({ fixturePath: SMOKE_FIXTURE });
  // A launch that lands AFTER we have given up still owns a real process. Left
  // alone it becomes an orphan on a persistent runner — the very thing that
  // makes the next job's guest suspect. `withTimeout` already swallows the
  // late rejection (an unhandled one can abort the Playwright process), so
  // this only has to deal with a late success.
  void launching.then(
    (late) => {
      if (settled) {
        void closeElectronApplication(late.electronApp).catch(() => undefined);
      }
    },
    () => undefined,
  );

  // Distinguish "gave up waiting" from "the harness told us what is
  // wrong". Only the former means a sick guest, and only the former
  // should send an operator off to recycle one. The harness rejects with
  // a real diagnosis for things like a missing onboarding seed, which
  // recycling would not fix.
  const timeoutMessage = `timed out after ${CANARY_TIMEOUT_MS}ms`;
  try {
    launched = await withTimeout(launching, CANARY_TIMEOUT_MS, timeoutMessage);
  } catch (error) {
    settled = true;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      describeCanaryFailure({
        timeoutMs: CANARY_TIMEOUT_MS,
        runnerName: process.env.RUNNER_NAME,
        detail,
        timedOut: detail === timeoutMessage,
      }),
    );
  } finally {
    settled = true;
    if (launched) {
      // Never a gate, and never awaited unbounded. This app's graceful close
      // routinely does not resolve — the shared helper bounds each step and
      // force-kills the process tree, which is what every spec's `finally`
      // does. Awaiting a bare `close()` here is what hung a guest for an hour.
      await closeElectronApplication(launched.electronApp).catch(
        () => undefined,
      );
    }
  }
}
