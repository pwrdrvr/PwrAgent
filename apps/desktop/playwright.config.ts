import path from "node:path";
import { defineConfig } from "@playwright/test";
import {
  E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV,
} from "./src/main/e2e-shutdown-diagnostics";
import {
  E2E_SHUTDOWN_CIRCUIT_BREAKER_ENV,
  E2E_SHUTDOWN_CIRCUIT_STATE_FILE_ENV,
} from "./e2e/fixtures/electron-shutdown-policy";

// Every E2E run reports how much the app made sqlite write. This is the only
// harness that drives the real write path — the main-process unit suites mock
// the overlay store — so it is the one place a per-event write regression can
// be seen. Cost is a statSync per commit against a run that launches Electron,
// so it is on by default; set PWRAGENT_DEV_SQLITE_WRITE_METRICS=0 to skip it.
// Assigned at config module scope so every Playwright worker, and therefore
// every Electron child it launches, inherits the variables.
if (process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS !== "0") {
  process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS = "1";
  // Not under `outputDir`: Playwright clears that directory for a run, and
  // the app appends to this file while tests are executing.
  process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS_FILE ??= path.join(
    import.meta.dirname,
    ".local",
    "sqlite-write-metrics.jsonl",
  );
}

process.env[E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV] ??= path.join(
  import.meta.dirname,
  "test-results",
  "electron-shutdown-diagnostics.jsonl",
);
process.env[E2E_SHUTDOWN_CIRCUIT_STATE_FILE_ENV] ??= path.join(
  import.meta.dirname,
  "test-results",
  "electron-shutdown-circuit.json",
);

const electronShutdownCircuitEnabled =
  process.env[E2E_SHUTDOWN_CIRCUIT_BREAKER_ENV] === "1";

export default defineConfig({
  testDir: "./e2e",
  // One bounded Electron launch before the suite. A persistent CI guest can
  // reach a state where no Electron process can start; without this the run
  // spends its whole time budget timing out one test at a time and blames
  // whichever spec sorts first rather than the machine. See
  // e2e/global-setup.ts.
  globalSetup: "./e2e/global-setup.ts",
  // Prints the sqlite write-volume ranking into the run log.
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // Once the macOS-only fixture circuit opens, its synthetic failure exhausts
  // the normal retry and this stops the shard instead of enumerating every
  // remaining test against a guest already proven unhealthy.
  maxFailures: electronShutdownCircuitEnabled ? 1 : 0,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  outputDir: "./test-results",
  reporter: process.env.CI
    ? [
        ["html", { outputFolder: "playwright-report", open: "never" }],
        ["list"]
      ]
    : "list",
  use: {
    screenshot: process.env.CI ? "only-on-failure" : "off",
    trace: "on-first-retry",
    video: process.env.CI ? "retain-on-failure" : "off"
  }
});
