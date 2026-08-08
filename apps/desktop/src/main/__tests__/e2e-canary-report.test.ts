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

// The canary only ever speaks on a guest nobody can reproduce on demand, so
// what it says — and how it obtains its window — are pinned here rather than
// trusted.
describe("desktop E2E pre-flight canary", () => {
  // The defect this guards against cost a full hour of a real guest's time.
  // A hand-rolled launch skipped the harness's home seeding, booted the
  // first-run setup wizard, and hung global setup forever. Delegating to
  // `launchElectronApp` is what keeps the canary's boot identical to a spec's.
  it("obtains its window through the shared harness, not a hand-rolled launch", () => {
    expect(globalSetupSource).toContain("launchElectronApp");
    expect(globalSetupSource).not.toMatch(/electron\.launch\(/);
  });

  // A launch-only check passes on the exact CI failure it exists to catch:
  // the trace shows `Launch electron` completing and `Wait for event "window"`
  // never returning. Going through the harness means a window is always
  // required, because the harness awaits `firstWindow()` itself.
  it("cannot pass on a process that never produces a window", () => {
    expect(globalSetupSource).toContain("fixtures/smoke/replay.fixture.json");
  });

  // Teardown must never gate: this app's graceful close routinely does not
  // resolve, so failing on it would fail every healthy run.
  it("tears down through the bounded force-killing helper without gating", () => {
    expect(globalSetupSource).toContain("closeElectronApplication");
    expect(globalSetupSource).toMatch(
      /closeElectronApplication\([\s\S]{0,80}?\)\s*\.catch\(/,
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
});
