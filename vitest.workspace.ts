import { defineConfig } from "vitest/config";

// Windows CI runners are markedly slower at spawning child processes (git.exe,
// bash.exe), so git/worktree-heavy desktop tests can exceed the 5s default.
// Give Windows more headroom; POSIX keeps the standard timeout.
const TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 5_000;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "messaging",
          globals: true,
          testTimeout: TEST_TIMEOUT_MS,
          environment: "node",
          include: ["packages/messaging/**/src/**/*.test.ts"]
        }
      },
      {
        test: {
          name: "agent-core",
          globals: true,
          testTimeout: TEST_TIMEOUT_MS,
          environment: "node",
          include: ["packages/agent-core/src/__tests__/**/*.test.ts"]
        }
      },
      {
        test: {
          name: "shared",
          globals: true,
          testTimeout: TEST_TIMEOUT_MS,
          environment: "node",
          include: ["packages/shared/src/**/__tests__/**/*.test.ts"]
        }
      },
      {
        test: {
          name: "desktop-main",
          globals: true,
          testTimeout: TEST_TIMEOUT_MS,
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
          testTimeout: TEST_TIMEOUT_MS,
          environment: "jsdom",
          include: ["apps/desktop/src/renderer/src/**/*.test.{ts,tsx}"],
          setupFiles: ["apps/desktop/src/renderer/src/test/setup.ts"]
        }
      }
    ]
  }
});
