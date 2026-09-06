import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Windows CI runners are markedly slower at spawning child processes (git.exe,
// bash.exe), so git/worktree-heavy desktop tests can exceed the 5s default.
// Give Windows more headroom; POSIX keeps the standard timeout.
const TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 5_000;
const HOOK_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 10_000;

// desktop-main loads native runtime bindings (better-sqlite3,
// @napi-rs/canvas, and node-pty). A worker thread lets their native teardown
// share a process with other test files and Vitest itself; on macOS that can
// crash the entire test host after every assertion has passed. Forks preserve
// parallel test execution while giving each binding an OS-process ownership
// boundary. They are also required on Windows, where a worker thread's
// process.env is case-sensitive unlike the real Electron main process.
const DESKTOP_MAIN_POOL = "forks";

// Where the desktop suites resolve the PwrAgent root to. `resolvePwragentRoot`
// falls back to `~/.pwragent` — the operator's live application state — and
// only about a dozen main tests override it themselves, so every other test
// that reaches a root-relative path reads and writes the real thing. That is
// not hypothetical: `ensureManagedGrokRuntime` installed a ~353 MB Grok runtime
// into `~/.pwragent/agents/grok/` from a plain `pnpm test`.
//
// Nothing pre-creates this directory. A run where the suites behave leaves no
// trace at all; a run that writes leaves the evidence in the OS temp dir under
// an obvious name instead of in the operator's home. The pid keeps concurrent
// runs (several worktrees testing at once is normal here) off each other's
// state, and is stable for the whole run because the config is evaluated once
// in the vitest host process.
//
// A test that needs its own root still overrides this with `vi.stubEnv` or an
// explicit `env` argument, both of which win over the value seeded here.
const DISPOSABLE_PWRAGENT_HOME = path.join(
  os.tmpdir(),
  `pwragent-vitest-home-${process.pid}`,
);

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "messaging",
          // Vitest 4 defaults to forks, which execs a fresh Node process for
          // every test file. With hundreds of files and many concurrent
          // worktrees, that executable churn overwhelms macOS provenance
          // checks. Threads retain Vitest's default per-file isolation without
          // creating an OS process per file.
          pool: "threads",
          globals: true,
          testTimeout: TEST_TIMEOUT_MS,
          environment: "node",
          include: ["packages/messaging/**/src/**/*.test.ts"]
        }
      },
      {
        test: {
          name: "shared",
          pool: "threads",
          globals: true,
          testTimeout: TEST_TIMEOUT_MS,
          environment: "node",
          include: ["packages/shared/src/**/__tests__/**/*.test.ts"]
        }
      },
      {
        test: {
          name: "desktop-main",
          pool: DESKTOP_MAIN_POOL,
          globals: true,
          testTimeout: TEST_TIMEOUT_MS,
          hookTimeout: HOOK_TIMEOUT_MS,
          environment: "node",
          env: { PWRAGENT_HOME: DISPOSABLE_PWRAGENT_HOME },
          include: [
            "scripts/**/*.test.mjs",
            ".agents/skills/codex-rollout-forensics/tests/**/*.test.mjs",
            "apps/desktop/scripts/**/*.test.mjs",
            "apps/desktop/src/main/__tests__/**/*.test.ts",
            "apps/desktop/src/main/agent-tools/__tests__/**/*.test.ts",
            "apps/desktop/src/preload/__tests__/**/*.test.ts",
            "apps/desktop/src/shared/__tests__/**/*.test.ts"
          ],
          // Windows only in effect: warms the Job-object wrapper that owns
          // `git worktree remove` so its one-time PowerShell + helper-compile
          // cold start is not billed to whichever test reaches it first.
          globalSetup: ["apps/desktop/src/test-setup/windows-job-wrapper-prewarm.ts"],
          setupFiles: [
            // Inert unless PWRAGENT_DEV_SQLITE_WRITE_METRICS is set; see
            // `pnpm test:sqlite-writes`.
            "apps/desktop/src/main/state/sqlite-write-metrics-setup.ts",
            // Fails a test that probes an agent CLI installed on the machine
            // running the suite instead of its own fixtures.
            "apps/desktop/src/main/__tests__/setup/agent-cli-spawn-guard.ts",
            // Fails a test that makes a real outbound HTTP request — the step
            // that runs *before* the probe the guard above catches.
            "apps/desktop/src/test-setup/outbound-fetch-guard.ts",
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
          pool: "threads",
          globals: true,
          testTimeout: TEST_TIMEOUT_MS,
          environment: "jsdom",
          env: { PWRAGENT_HOME: DISPOSABLE_PWRAGENT_HOME },
          include: ["apps/desktop/src/renderer/src/**/*.test.{ts,tsx}"],
          // The renderer reaches the network through IPC, so it has no `fetch`
          // call site today — but `lint:boundaries` reads imports and cannot
          // see a `globalThis.fetch`, and jsdom inherits a live one from Node,
          // so the guard covers a violation nothing else here would catch.
          setupFiles: [
            "apps/desktop/src/test-setup/outbound-fetch-guard.ts",
            "apps/desktop/src/renderer/src/test/setup.ts",
          ]
        }
      }
    ]
  }
});
