import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "desktop-main",
          globals: true,
          environment: "node",
          include: ["apps/desktop/src/main/__tests__/**/*.test.ts"]
        }
      },
      {
        test: {
          name: "desktop-renderer",
          globals: true,
          environment: "jsdom",
          include: ["apps/desktop/src/renderer/src/__tests__/**/*.test.tsx"]
        }
      }
    ]
  }
});
