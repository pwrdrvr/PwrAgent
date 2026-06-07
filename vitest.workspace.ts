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
          ],
          // Inline @pwrdrvr/codex-discovery so vitest transforms it. Without
          // this, the kit's bundled `import { spawn } from "child_process"`
          // is loaded raw by Node and bypasses the tests'
          // `vi.mock("child_process")` (Codex login + status now run through
          // the package, not in-tree code).
          server: { deps: { inline: ["@pwrdrvr/codex-discovery"] } }
        }
      },
      {
        test: {
          name: "desktop-renderer",
          globals: true,
          environment: "jsdom",
          include: ["apps/desktop/src/renderer/src/**/*.test.{ts,tsx}"],
          setupFiles: ["apps/desktop/src/renderer/src/test/setup.ts"]
        }
      }
    ]
  }
});
