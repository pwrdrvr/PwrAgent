import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "messaging",
          globals: true,
          environment: "node",
          include: ["packages/messaging/**/src/**/*.test.ts"]
        }
      },
      {
        test: {
          name: "agent-core",
          globals: true,
          environment: "node",
          include: ["packages/agent-core/src/__tests__/**/*.test.ts"]
        }
      },
      {
        test: {
          name: "shared",
          globals: true,
          environment: "node",
          include: ["packages/shared/src/**/__tests__/**/*.test.ts"]
        }
      },
      {
        test: {
          name: "desktop-main",
          globals: true,
          environment: "node",
          include: [
            "apps/desktop/src/main/__tests__/**/*.test.ts",
            "apps/desktop/src/shared/__tests__/**/*.test.ts"
          ]
        }
      },
      {
        test: {
          name: "desktop-renderer",
          globals: true,
          environment: "jsdom",
          include: ["apps/desktop/src/renderer/src/**/*.test.{ts,tsx}"]
        }
      }
    ]
  }
});
