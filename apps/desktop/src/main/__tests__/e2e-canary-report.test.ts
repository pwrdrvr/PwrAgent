import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeCanaryFailure } from "../../../e2e/canary-report";

const globalSetupSource = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../e2e/global-setup.ts",
  ),
  "utf8",
);

/**
 * Comments in that file legitimately DISCUSS the patterns these tests forbid
 * — "a hand-rolled `electron.launch(`" appears in the rationale. Matching raw
 * source would fail the build over a comment, so assert against code only.
 */
const globalSetupCode = globalSetupSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

// The canary only ever speaks on a guest nobody can reproduce on demand, so
// what it says — and how it obtains its window — are pinned here rather than
// trusted.
describe("desktop E2E pre-flight canary", () => {
  // The defect this guards against cost a full hour of a real guest's time.
  // A hand-rolled launch skipped the harness's home seeding, booted the
  // first-run setup wizard, and hung global setup forever. Delegating to
  // `launchElectronApp` is what keeps the canary's boot identical to a spec's.
  it("obtains its window through the shared harness, not a hand-rolled launch", () => {
    expect(globalSetupCode).toContain("launchElectronApp(");
    // A hand-rolled launch is what skipped the harness's profile seeding.
    expect(globalSetupCode).not.toMatch(/electron\.launch\(/);
  });

  // A launch-only check passes on the exact CI failure it exists to catch:
  // the trace shows `Launch electron` completing and `Wait for event "window"`
  // never returning. Going through the harness means a window is always
  // required, because the harness awaits `firstWindow()` itself.
  it("cannot pass on a process that never produces a window", () => {
    // `launchElectronApp` awaits `firstWindow()` itself, so delegating to it
    // is what makes a window mandatory — asserting the call is asserting the
    // invariant, not a proxy for it. The fixture path only proves the replay
    // driver is exercised too.
    expect(globalSetupCode).toMatch(/launchElectronApp\(\s*\{\s*fixturePath/);
    expect(globalSetupCode).toContain("fixtures/smoke/replay.fixture.json");
  });

  // Teardown must never gate: this app's graceful close routinely does not
  // resolve, so failing on it would fail every healthy run.
  it("tears down through the bounded shared fixture helper without gating", () => {
    expect(globalSetupCode).toMatch(
      /await\s+launched\.close\(\)\.catch\(/,
    );
  });

  // The review finding this guards: racing the launch by hand left the loser
  // unattended. A late rejection is an unhandled rejection (which can abort
  // the Playwright process), and a late SUCCESS is an orphaned Electron tree
  // on a persistent runner — the exact resource the CI cleanup task exists to
  // reap. `withTimeout` handles the first; the late-success close handles the
  // second.
  it("does not abandon a launch that lands after the timeout", () => {
    expect(globalSetupCode).toContain("withTimeout(");
    expect(globalSetupCode).not.toMatch(/Promise\.race\(/);
    // Anchored on the launch promise's own handler. A looser match on
    // `settled` near `late.close()` passes on the `finally`
    // block alone, so deleting the late-success close went undetected —
    // verified by mutation, which is the only reason this reads oddly.
    expect(globalSetupCode).toMatch(
      /launching\.then\([\s\S]{0,300}?late\.close\(\)\.catch\(/,
    );
  });

  it("names the runner and points away from blaming the branch", () => {
    const message = describeCanaryFailure({
      timeoutMs: 60_000,
      runnerName: "some-runner",
      detail: "timed out after 60000ms",
    });
    expect(message).toContain("60000ms");
    expect(message).toContain("some-runner");
    expect(message).toContain("property of the machine, not of the branch");
    expect(message).toContain("same runner");
    // The traced shape, so a reader is not left guessing what "cannot run"
    // meant on the affected runner.
    expect(message).toContain('Wait for event "window"');
    expect(message).toContain("a11y.spec.ts, which is innocent");
  });

  it("does not print undefined when run outside CI", () => {
    const message = describeCanaryFailure({ timeoutMs: 1, detail: "d" });
    expect(message).toContain("RUNNER_NAME unset");
    expect(message).not.toContain("undefined");
  });

  // A hang and a diagnosed rejection need opposite responses, and the
  // sick-guest narrative is actively misleading for the second: it sends an
  // operator to recycle a healthy guest while the real cause — a missing
  // onboarding seed, say — sits under "Underlying error:" twenty lines down.
  it("drops the sick-guest narrative when the harness rejected with a diagnosis", () => {
    const message = describeCanaryFailure({
      timeoutMs: 60_000,
      runnerName: "some-runner",
      detail: "PwrAgent first-run onboarding wizard is showing",
      timedOut: false,
    });

    expect(message).toContain("onboarding wizard is showing");
    expect(message).toContain("NOT the guest needing to be recycled");
    expect(message).toContain("some-runner");
    expect(message).not.toContain("property of the machine");
    expect(message).not.toContain("recycle the guest.");
    // Reporting the budget as though it elapsed misreads an instant failure.
    expect(message).not.toContain("60000ms");
  });

  it("keeps the timeout narrative when the canary gave up waiting", () => {
    const message = describeCanaryFailure({
      timeoutMs: 60_000,
      detail: "timed out after 60000ms",
      timedOut: true,
    });
    expect(message).toContain("timed out after 60000ms, before any test ran");
    expect(message).toContain("property of the machine");
  });

  // The two branches are only useful if the caller can tell them apart.
  it("classifies the canary rejection instead of assuming a timeout", () => {
    expect(globalSetupCode).toContain("timedOut:");
    expect(globalSetupCode).toMatch(/timedOut:\s*detail === timeoutMessage/);
  });
});
