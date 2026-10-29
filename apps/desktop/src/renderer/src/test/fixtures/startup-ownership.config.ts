import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    pool: "threads",
    environment: "jsdom",
    runner: "apps/desktop/src/renderer/src/test/act-warning-runner.ts",
    setupFiles: ["apps/desktop/src/renderer/src/test/setup.ts"],
    include: ["apps/desktop/src/renderer/src/test/fixtures/startup-ownership.fixture.tsx"],
  },
});
