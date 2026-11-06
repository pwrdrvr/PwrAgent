import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "retry-name-oracle",
    include: ["scripts/ci/fixtures/vitest-retry-name-oracle.fixture.mjs"],
  },
});
