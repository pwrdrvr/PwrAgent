import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
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
