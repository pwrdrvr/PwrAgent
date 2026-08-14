import path from "node:path";
import { defineConfig, type ReporterDescription } from "@playwright/test";
import {
  E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV,
} from "./src/main/e2e-shutdown-diagnostics";
import {
  E2E_SHUTDOWN_CIRCUIT_BREAKER_ENV,
  E2E_SHUTDOWN_CIRCUIT_STATE_FILE_ENV,
} from "./e2e/fixtures/electron-shutdown-policy";

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
const reporters: ReporterDescription[] = process.env.CI
  ? [
      ["html", { outputFolder: "playwright-report", open: "never" }],
      ["list"],
    ]
  : [["list"]];
if (electronShutdownCircuitEnabled) {
  reporters.push([
    "./e2e/fixtures/electron-shutdown-circuit-reporter.ts",
  ]);
}

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/shutdown-global-setup.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  outputDir: "./test-results",
  // The circuit reporter interrupts only for the synthetic circuit-open
  // error. Ordinary assertion failures retain normal retry/suite behavior.
  reporter: reporters,
  use: {
    screenshot: process.env.CI ? "only-on-failure" : "off",
    trace: "on-first-retry",
    video: process.env.CI ? "retain-on-failure" : "off"
  }
});
