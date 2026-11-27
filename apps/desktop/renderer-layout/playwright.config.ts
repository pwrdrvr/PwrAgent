import { defineConfig } from "@playwright/test";

const origin = "http://127.0.0.1:5591";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  outputDir: "../test-results/renderer-layout",
  workers: 1,
  projects: [{
    name: "chromium",
    use: {
      browserName: "chromium",
      headless: true,
      baseURL: origin,
      viewport: { width: 1600, height: 1600 },
      reducedMotion: "reduce",
    },
  }],
  webServer: {
    command: "pnpm exec vite --config vite.config.ts --host 127.0.0.1 --port 5591 --strictPort",
    url: origin,
  },
});
