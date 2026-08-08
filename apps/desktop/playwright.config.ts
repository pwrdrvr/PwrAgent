import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // One bounded Electron launch before the suite. A persistent CI guest can
  // reach a state where no Electron process can start; without this the run
  // spends its whole time budget timing out one test at a time and blames
  // whichever spec sorts first rather than the machine. See
  // e2e/global-setup.ts.
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
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
