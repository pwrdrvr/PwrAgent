import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "retry-name-oracle",
    globalSetup: ["scripts/ci/fixtures/vitest-retry-name-oracle.setup.mjs"],
    include: ["scripts/ci/fixtures/vitest-retry-name-oracle.fixture.mjs"],
  },
});
